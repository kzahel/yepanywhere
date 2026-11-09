import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import {
  commonVocabularyWords,
  hasInteriorCapital,
  observeVocabularyCase,
  projectVocabularyCase,
  speechVocabularyOccurrences,
  type VocabularyCaseForms,
  vocabularyDistinctiveScore,
  vocabularyFrequency,
  VOCABULARY_FLUSH_COUNTS,
} from "@yep-anywhere/shared";
import { parseByteSize } from "../../lib/byteSize.js";
import { createCoalescingSaver } from "../../lib/coalescingSaver.js";
import { statFilesystem } from "../../lib/filesystemKind.js";
import { createLruMap, refreshLruMap } from "../../lib/lruCollections.js";
import { getLogger } from "../../logging/logger.js";
import { BlockedBloom, BloomFile, bloomLoadForRate } from "./blocked-bloom.js";
import { DistinctiveTop } from "./distinctive-top.js";
import { legacySpeechVocabularyDirectories } from "./legacy-vocabulary-directories.js";
import {
  VocabularyDatabase,
  type VocabularyTable,
} from "./vocabulary-database.js";

export { VOCABULARY_FLUSH_COUNTS };

export interface VocabularySettings {
  generation: number;
  enabled: boolean;
  biasing: boolean;
  hours: number;
  /**
   * How much more a term from the active session is worth than the same term
   * scored globally. Applied once, where the word is offered to the session
   * heap; the merge replaces rather than adds, so this is the whole factor.
   */
  sessionMultiplier: number;
  /**
   * Share of the selected keyterms held for the active session, 0 to 1. Long
   * history accumulates mass that a fresh session cannot outscore, so a
   * reservation is the only way its terms survive the cut. Zero keeps the
   * unreserved behavior, where score alone decides.
   */
  sessionShare: number;
}

/**
 * A settings write. The two ranking knobs are optional so a caller that does
 * not know about them leaves them alone rather than erasing them, which is the
 * same reason the route treats an absent field as unchanged.
 */
export type VocabularySettingsUpdate = Omit<
  VocabularySettings,
  "generation" | "sessionMultiplier" | "sessionShare"
> &
  Partial<Pick<VocabularySettings, "sessionMultiplier" | "sessionShare">>;

export interface VocabularyMessage {
  source: "user" | "assistant";
  timestamp: number;
  text: string;
}

type Counts = { user: number; assistant: number };

/**
 * Ceiling on the share of selected terms that are capitalized spellings of
 * common words. Case is not meaning-carrying, and a spoken acronym is usually
 * transcribed correctly anyway, so these must not crowd out real jargon.
 */
const ESCAPE_SHARE = 0.2;

/**
 * Default weight of an active-session term against the same term scored
 * globally, and the default share of the selection held for the session.
 * Five preserves the behavior this setting replaced; zero reservation does the
 * same for the budget, leaving score alone to decide until an owner says
 * otherwise.
 */
const DEFAULT_SESSION_MULTIPLIER = 5;
const DEFAULT_SESSION_SHARE = 0;

/**
 * All three live in the data directory. That directory is local disk whenever
 * this feature can run at all: learning is gated on discovery SQLite being
 * ready, and startup refuses to open that database on a network filesystem
 * (topics/required-sqlite.md). The earlier separate reservation existed to
 * escape a data directory that might be a share, which is now prevented rather
 * than worked around.
 */
const STATE_FILE = "speech-vocabulary-state.json";
const DATABASE_FILE = "speech-vocabulary.sqlite";
const SEEN_FILE = "speech-seen.bloom";

/**
 * Bytes the filter may take without filling the disk it shares with the rest
 * of the data directory. Matches the reservation's old headroom rule, which is
 * the part of it worth keeping now that the placement search is gone.
 */
const DISK_HEADROOM_BYTES = 1024 * 1024 * 1024;

function affordable(dir: string, requested: number): number {
  try {
    const free = statFilesystem(dir).freeBytes;
    return Math.min(requested, Math.max(0, free - DISK_HEADROOM_BYTES));
  } catch {
    // An uninspectable directory is not a reason to shrink the filter; the
    // write itself will report a real problem.
    return requested;
  }
}

/** Files the earlier whole-table-rewrite layout left in the data directory. */
const LEGACY_WORDS_FILE = "speech-words.json";
const LEGACY_CASE_FILE = "speech-word-case.json";
const LEGACY_SEEN_FILE = "speech-seen.hash";

/**
 * Room reserved for the fingerprint filter. At eight bits per key this holds
 * well over a hundred million distinct messages, which is years of heavy use;
 * `YEP_SPEECH_VOCABULARY_BYTES` moves it for a machine that wants less.
 */
const DEFAULT_SEEN_BYTES = 256 * 1024 * 1024;
const MINIMUM_SEEN_BYTES = 1024 * 1024;

/**
 * False-positive rate at which the filter is compacted to a recent window. A
 * false positive drops one message from the counts, so this is a quality knob
 * rather than a correctness one; a tenth of a percent is far below the rate at
 * which the filter is called full, which is the point. Compaction keeps every
 * learned count, so it should happen long before the saturation path, which
 * discards them.
 */
const SEEN_TARGET_RATE = 0.001;

/**
 * Shortest interval between two writes of the table. Learning observes text as
 * fast as agents produce it, and every observation would otherwise become a
 * commit. Waiting also shrinks the work rather than merely delaying it: a word
 * seen fifty times inside one interval is still one row written once. What a
 * crash costs is at most this much learning, which a rescan recovers, because
 * the session checkpoints are written in the same batch as the counts they
 * cover. `YEP_SPEECH_VOCABULARY_WRITE_SECONDS` moves it.
 */
const DEFAULT_WRITE_INTERVAL_MS = 10 * 60_000;

function parseWriteIntervalMs(
  env: NodeJS.ProcessEnv,
  defaultValue: number,
): number {
  const raw = env.YEP_SPEECH_VOCABULARY_WRITE_SECONDS;
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed < 0 ? defaultValue : parsed * 1000;
}

export function vocabularyFingerprint(
  sessionKey: string,
  message: VocabularyMessage,
): Uint8Array {
  return createHash("sha256")
    .update(
      JSON.stringify([
        sessionKey,
        message.source,
        message.timestamp,
        message.text,
      ]),
    )
    .digest();
}

function addDelta(
  target: Map<string, Counts>,
  word: string,
  source: "user" | "assistant",
  n: number,
): void {
  const current = target.get(word) ?? { user: 0, assistant: 0 };
  current[source] += n;
  if (current.user === 0 && current.assistant === 0) target.delete(word);
  else target.set(word, current);
}

interface PersistedState {
  generation: number;
  enabled: boolean;
  biasing: boolean;
  hours: number;
  resetAfter: number;
  sessionMultiplier: number;
  sessionShare: number;
  /**
   * Content at or before this time is counted, and the filter no longer holds
   * its fingerprints. Set when the filter is compacted to a recent window:
   * without it, a rebuilt filter would let every older message a rescan
   * re-reads count a second time.
   */
  seenFrom: number;
}

export interface VocabularyStoreOptions {
  /** Overrides the fingerprint filter's size. */
  seenBytes?: number;
  /** Overrides the shortest interval between two writes of the table. */
  writeIntervalMs?: number;
  /** Substitutes the table, so a test can record exactly what is written. */
  openTable?: (path: string) => VocabularyTable | undefined;
  env?: NodeJS.ProcessEnv;
}

/** Sessions whose in-memory session term boost is retained. */
const SESSION_TOP_LIMIT = 256;

export class VocabularyStore {
  private wordsRevision = 0;
  private ignored: ReadonlySet<string> = new Set();
  private baseline: ReadonlyMap<string, number> | undefined;
  private baselineFloor: number | undefined;
  private readonly wordCounts = new Map<string, Counts>();
  /** Only words written with a capital somewhere; the rest project to the key. */
  private readonly caseForms = new Map<string, VocabularyCaseForms>();
  private readonly top = new DistinctiveTop(500);
  /**
   * Per-session terms observed since process start, least recently used
   * first and bounded to `SESSION_TOP_LIMIT` sessions. Like a restart, an
   * evicted session simply loses its in-memory session boost.
   */
  private readonly sessionTops = createLruMap<string, DistinctiveTop>();
  private readonly pendingWords = new Map<string, Counts>();
  private readonly sessions = new Map<
    string,
    { version: string; cutoff: number }
  >();
  private pendingCheckpoints: {
    key: string;
    version: string;
    cutoff: number;
  }[] = [];
  private pendingTokens = 0;
  /** Rows whose stored value no longer matches memory. */
  private dirtyWords = new Set<string>();
  private dirtyForms = new Set<string>();
  private dirtyCheckpoints = new Set<string>();
  private state: PersistedState = {
    generation: 0,
    enabled: false,
    biasing: false,
    hours: 24,
    resetAfter: 0,
    sessionMultiplier: DEFAULT_SESSION_MULTIPLIER,
    sessionShare: DEFAULT_SESSION_SHARE,
    seenFrom: 0,
  };
  private loaded = false;
  private writeTimer: ReturnType<typeof setTimeout> | undefined;
  private lastWriteAt = Date.now();
  private readonly writeIntervalMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly seenBytes: number;
  private seen: BlockedBloom | undefined;
  /** Load at which `SEEN_TARGET_RATE` is reached; solved once per filter shape. */
  private overloadAt: number | undefined;
  private seenFile: BloomFile | undefined;
  private database: VocabularyTable | undefined;
  private readonly openDatabase: (path: string) => VocabularyTable | undefined;
  private readonly saver = createCoalescingSaver(() => this.persist());

  get revision(): number {
    return this.wordsRevision;
  }

  get pendingCount(): number {
    return this.pendingTokens;
  }

  /** Nothing new to merge or record: a flush would rewrite the same answer. */
  get idle(): boolean {
    return this.pendingWords.size === 0 && this.pendingCheckpoints.length === 0;
  }

  /**
   * The filter is past its design load, so its false-positive rate is rising.
   * Recovering means emptying it and relearning the retained window.
   */
  get seenSaturated(): boolean {
    return this.seen?.saturated ?? false;
  }

  /**
   * The filter's false-positive rate has reached `SEEN_TARGET_RATE`. This is
   * the compaction trigger and it fires far below `seenSaturated`: rebuilding
   * from a recent window keeps every learned count, while the saturation path
   * discards them all, so the cheap answer must get the first chance.
   */
  get seenOverloaded(): boolean {
    const filter = this.seen;
    if (!filter) return false;
    this.overloadAt ??= bloomLoadForRate(
      filter.bytes,
      filter.hashes,
      SEEN_TARGET_RATE,
    );
    return filter.count >= this.overloadAt;
  }

  /** Content at or before this time counts as already seen without the filter. */
  get seenFrom(): number {
    return this.state.seenFrom;
  }

  /** An empty filter of the same shape, to be filled with a recent window. */
  beginSeenCompaction(): BlockedBloom {
    return new BlockedBloom(this.seenBytes);
  }

  /**
   * Adopt a rebuilt filter and raise the floor to the window it covers. Order
   * matters: the floor is what stops the messages this filter deliberately
   * forgot from counting twice, so it is recorded in the same step, and the
   * file is replaced by rename so a crash cannot leave a filter that knows
   * less than the floor claims.
   */
  async commitSeenCompaction(
    replacement: BlockedBloom,
    from: number,
  ): Promise<void> {
    this.state.seenFrom = from;
    this.writeState();
    this.seen = replacement;
    this.overloadAt = undefined;
    await this.seenFile?.replace(replacement);
  }

  /**
   * The fingerprint filter, allocated on first use. A server whose owner never
   * turned learning on pays nothing for the reservation.
   */
  private get filter(): BlockedBloom {
    this.seen ??= new BlockedBloom(this.seenBytes);
    return this.seen;
  }

  constructor(
    private readonly dataDir: string,
    options: VocabularyStoreOptions = {},
  ) {
    const env = options.env ?? process.env;
    this.env = env;
    this.openDatabase = options.openTable ?? VocabularyDatabase.open;
    const requested =
      options.seenBytes ??
      parseByteSize(env.YEP_SPEECH_VOCABULARY_BYTES, DEFAULT_SEEN_BYTES);
    // An explicit size is taken as given; a size the disk cut down still gets
    // a floor, since a filter of a few kilobytes would dedupe nothing.
    this.seenBytes =
      options.seenBytes ??
      Math.max(MINIMUM_SEEN_BYTES, affordable(dataDir, requested));
    this.writeIntervalMs =
      options.writeIntervalMs ??
      parseWriteIntervalMs(env, DEFAULT_WRITE_INTERVAL_MS);
    this.loadState();
    this.openTable();
  }

  private get statePath(): string {
    return join(this.dataDir, STATE_FILE);
  }

  private get databasePath(): string {
    return join(this.dataDir, DATABASE_FILE);
  }

  private get seenPath(): string {
    return join(this.dataDir, SEEN_FILE);
  }

  /**
   * Settings are the only thing read before the feature is used, and the only
   * thing here that a rescan cannot rebuild, so they stay small, JSON, and in
   * the data directory. An unreadable file reverts to defaults rather than
   * failing construction: the alternative is a server that will not start
   * because an optional feature's preferences were half-written.
   */
  private loadState(): void {
    let raw: Partial<PersistedState> & {
      sessions?: Record<string, { version: string; cutoff: number }>;
    };
    try {
      raw = JSON.parse(readFileSync(this.statePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        getLogger().warn(
          { component: "speech", err: error },
          "Speech vocabulary settings unreadable; using defaults",
        );
      return;
    }
    this.state = {
      generation: Number(raw.generation ?? 0),
      enabled: raw.enabled === true,
      biasing: raw.biasing === true,
      hours: Number(raw.hours ?? 24),
      resetAfter: Number(raw.resetAfter ?? 0),
      sessionMultiplier: Number(
        raw.sessionMultiplier ?? DEFAULT_SESSION_MULTIPLIER,
      ),
      sessionShare: Number(raw.sessionShare ?? DEFAULT_SESSION_SHARE),
      seenFrom: Number(raw.seenFrom ?? 0),
    };
    // Checkpoints used to share this file. Keep them until the table adopts
    // them, so an upgrade does not rescan every session.
    for (const [key, session] of Object.entries(raw.sessions ?? {})) {
      this.sessions.set(key, session);
      this.dirtyCheckpoints.add(key);
    }
  }

  private writeState(): void {
    const temporary = `${this.statePath}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state));
    renameSync(temporary, this.statePath);
  }

  setIgnoredWords(words: ReadonlySet<string>): void {
    this.ignored = words;
  }

  setReference(baseline: ReadonlyMap<string, number>): void {
    // Every scan run offers the same cached reference. Rebuilding the ranking
    // for an unchanged one is pure waste on a server that rescans often.
    if (this.baseline === baseline) return;
    this.baseline = baseline;
    this.ignored = commonVocabularyWords(baseline);
    let floor = Number.POSITIVE_INFINITY;
    for (const frequency of baseline.values())
      if (frequency < floor) floor = frequency;
    this.baselineFloor = Number.isFinite(floor) ? floor : undefined;
    this.rebuildTop();
  }

  addWordCounts(word: string, user: number, assistant: number): void {
    if (user) addDelta(this.wordCounts, word, "user", user);
    if (assistant) addDelta(this.wordCounts, word, "assistant", assistant);
    this.userTotal += user;
    this.assistantTotal += assistant;
    this.dirtyWords.add(word);
    this.considerWord(word);
  }

  private userTotal = 0;
  private assistantTotal = 0;

  private tokenTotal(): number {
    return this.userTotal + this.assistantTotal;
  }

  private frequency(word: string): number | undefined {
    if (!this.baseline) return undefined;
    // A capitalized spelling of a common word is its own term, but treating it
    // as never-seen English would let every shouted word outrank real jargon.
    // Charge it the rarest listed frequency instead of nothing.
    if (word !== word.toLowerCase()) return this.baselineFloor;
    return vocabularyFrequency(this.baseline, word);
  }

  private rebuildTop(): void {
    this.top.rebuild(
      this.mergedWords(),
      this.tokenTotal(),
      (word) => this.frequency(word),
      this.ignored,
    );
  }

  private mergedWords(): Map<string, Counts> {
    const merged = new Map(this.wordCounts);
    for (const [word, delta] of this.pendingWords) {
      addDelta(merged, word, "user", delta.user);
      addDelta(merged, word, "assistant", delta.assistant);
    }
    return merged;
  }

  private countsOf(word: string): Counts {
    const base = this.wordCounts.get(word);
    const pending = this.pendingWords.get(word);
    return {
      user: (base?.user ?? 0) + (pending?.user ?? 0),
      assistant: (base?.assistant ?? 0) + (pending?.assistant ?? 0),
    };
  }

  private considerWord(word: string): number {
    const counts = this.countsOf(word);
    const score = vocabularyDistinctiveScore(
      counts.user + counts.assistant,
      this.tokenTotal(),
      this.frequency(word),
    );
    this.top.consider(word, score);
    return score;
  }

  /**
   * Read the learned table into memory. Counts answer exploration and ranking
   * from memory from that point on, so nothing on those paths waits for disk.
   * Synchronous because a server that has the table must be able to report
   * totals before any scan runs.
   */
  private openTable(): void {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      this.adoptReservedFiles();
      this.database = this.openDatabase(this.databasePath);
    } catch (error) {
      // Losing the table costs relearning, not correctness. Refusing to run
      // would take recognition biasing down with it.
      getLogger().warn(
        { component: "speech", err: error, path: this.databasePath },
        "Speech vocabulary table unavailable; learning stays in memory",
      );
      return;
    }
    if (!this.database) return;
    for (const row of this.database.words()) {
      this.wordCounts.set(row.word, {
        user: row.user,
        assistant: row.assistant,
      });
      this.userTotal += row.user;
      this.assistantTotal += row.assistant;
    }
    for (const [word, forms] of this.database.forms())
      this.caseForms.set(word, forms);
    for (const row of this.database.checkpoints())
      if (!this.sessions.has(row.key))
        this.sessions.set(row.key, {
          version: row.version,
          cutoff: row.cutoff,
        });
    if (this.wordCounts.size === 0) this.adoptLegacyFiles();
  }

  /**
   * Move the table and filter out of the directory earlier versions reserved
   * for them outside the data directory. Both are recreated from nothing if
   * this fails, so a copy that cannot complete is logged and dropped rather
   * than made fatal; the cost is relearning, and the table is the small one.
   */
  private adoptReservedFiles(): void {
    for (const candidate of legacySpeechVocabularyDirectories(
      this.dataDir,
      this.env,
    )) {
      const from = join(candidate, DATABASE_FILE);
      if (!existsSync(from) || existsSync(this.databasePath)) continue;
      try {
        // Same filesystem renames; a reserved directory elsewhere copies.
        renameSync(from, this.databasePath);
      } catch {
        try {
          copyFileSync(from, this.databasePath);
          rmSync(from, { force: true });
        } catch (error) {
          getLogger().warn(
            { component: "speech", err: error, path: from },
            "Speech vocabulary table could not be moved into the data directory",
          );
          return;
        }
      }
      // The write-ahead log and shared-memory file belong to the old path and
      // are rebuilt on open; carrying them across would be wrong, not merely
      // unnecessary, because their content is relative to a database this
      // process is about to reopen elsewhere.
      for (const suffix of ["-wal", "-shm"])
        rmSync(`${from}${suffix}`, { force: true });
      // The filter is a quarter gigabyte and only saves relearning what the
      // table's own checkpoints already prevent rescanning, so it is renamed
      // when that is free and abandoned when it would mean copying that much
      // on the startup path.
      const filter = join(candidate, SEEN_FILE);
      let movedFilter = false;
      try {
        if (existsSync(filter) && !existsSync(this.seenPath)) {
          renameSync(filter, this.seenPath);
          movedFilter = true;
        }
      } catch {
        rmSync(filter, { force: true });
      }
      getLogger().info(
        { component: "speech", from: candidate, to: this.dataDir, movedFilter },
        "Moved the speech vocabulary table into the data directory",
      );
      return;
    }
  }

  /**
   * Attach the fingerprint filter. Deferred until a scan needs it, because the
   * filter is large and a server whose owner never turned learning on should
   * not pay for it.
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    this.seenFile = new BloomFile(this.seenPath, this.filter);
    await this.seenFile.load();
    getLogger().info(
      {
        component: "speech",
        dataDir: this.dataDir,
        seenBytes: this.seenBytes,
        seenCount: this.filter.count,
        words: this.wordCounts.size,
      },
      "Speech vocabulary table ready",
    );
    this.rebuildTop();
    await yieldToLoop();
  }

  /**
   * Adopt the previous layout's whole-file snapshots once, then delete them.
   * They were rewritten in full on every flush, which is what moving to a table
   * on local disk fixes; their contents are still the user's learned words.
   */
  private adoptLegacyFiles(): void {
    const counts = readJsonFile<Record<string, [number, number]>>(
      join(this.dataDir, LEGACY_WORDS_FILE),
    );
    for (const [word, pair] of Object.entries(counts ?? {})) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      this.addWordCounts(word, Number(pair[0]), Number(pair[1]));
    }
    const forms = readJsonFile<Record<string, VocabularyCaseForms>>(
      join(this.dataDir, LEGACY_CASE_FILE),
    );
    for (const [word, entry] of Object.entries(forms ?? {}))
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        this.caseForms.set(word, entry);
        this.dirtyForms.add(word);
      }
    // Deleting the old files has to wait for the adopted rows to land, and
    // landing has to mean the write succeeded: these files are the only other
    // copy of these counts, and writer quiescence says nothing about whether
    // the commit went through. A failure keeps them for the next start, which
    // adopts them again because the table is still empty.
    void this.landed().then(
      () => {
        for (const name of [
          LEGACY_WORDS_FILE,
          LEGACY_CASE_FILE,
          LEGACY_SEEN_FILE,
        ]) {
          try {
            unlinkSync(join(this.dataDir, name));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT")
              getLogger().warn(
                { component: "speech", err: error, file: name },
                "Speech vocabulary could not remove an adopted legacy file",
              );
          }
        }
      },
      (error: unknown) => {
        getLogger().warn(
          { component: "speech", err: error },
          "Speech vocabulary kept its legacy files; adopting them did not land",
        );
      },
    );
  }

  settings(): VocabularySettings {
    return {
      generation: this.state.generation,
      enabled: this.state.enabled,
      biasing: this.state.biasing,
      hours: this.state.hours,
      sessionMultiplier: this.state.sessionMultiplier,
      sessionShare: this.state.sessionShare,
    };
  }

  configure(settings: VocabularySettingsUpdate): void {
    this.state.enabled = settings.enabled;
    this.state.biasing = settings.biasing;
    this.state.hours = settings.hours;
    if (Number.isFinite(settings.sessionMultiplier))
      this.state.sessionMultiplier = settings.sessionMultiplier as number;
    if (Number.isFinite(settings.sessionShare))
      this.state.sessionShare = settings.sessionShare as number;
    this.writeState();
  }

  totals() {
    const merged = this.mergedWords();
    let user = 0;
    let assistant = 0;
    for (const counts of merged.values()) {
      user += counts.user;
      assistant += counts.assistant;
    }
    return { words: merged.size, user, assistant };
  }

  words(minimum = 1) {
    return this.wordsAbove(minimum);
  }

  wordsAbove(minimum = 1) {
    return [...this.mergedWords()]
      .map(([word, counts]) => ({ word, ...counts }))
      .filter((row) => row.user + row.assistant >= minimum)
      .sort(
        (a, b) =>
          b.user + b.assistant - (a.user + a.assistant) ||
          a.word.localeCompare(b.word),
      )
      .slice(0, 2000);
  }

  hasScanned(
    sessionKey: string,
    sourceVersion: string,
    cutoff: number,
  ): boolean {
    const row = this.sessions.get(sessionKey);
    return row?.version === sourceVersion && row.cutoff <= cutoff;
  }

  accepts(generation: number): boolean {
    return this.state.enabled && this.state.generation === generation;
  }

  automaticCutoff(cutoff: number): number {
    return Math.max(cutoff, this.state.resetAfter + 1);
  }

  observe(
    sessionKey: string,
    message: VocabularyMessage,
    generation: number,
  ): number {
    if (!this.accepts(generation)) return 0;
    // Below the floor the filter has no opinion, because compaction dropped
    // those fingerprints on purpose. The floor is the answer instead.
    if (message.timestamp < this.state.seenFrom) return 0;
    const fingerprint = vocabularyFingerprint(sessionKey, message);
    if (!this.filter.add(fingerprint)) return 0;
    const counts = new Map<string, number>();
    for (const { word, surface, forced } of speechVocabularyOccurrences(
      message.text,
    )) {
      this.recordCase(word, surface, forced);
      // A common English word written with an interior capital is a different
      // term — YA, HEAD, OK — and earns its own key past the common-word block.
      let key: string | undefined = word;
      if (this.ignored.has(word))
        key = hasInteriorCapital(surface) ? surface : undefined;
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let added = 0;
    for (const [word, n] of counts) {
      added += n;
      addDelta(this.pendingWords, word, message.source, n);
      if (message.source === "user") this.userTotal += n;
      else this.assistantTotal += n;
      const score = this.considerWord(word);
      this.sessionTop(sessionKey).consider(
        word,
        score * this.state.sessionMultiplier,
      );
    }
    this.pendingTokens += added;
    return added;
  }

  private recordCase(word: string, surface: string, forced: boolean): void {
    const forms = this.caseForms.get(word);
    if (forms) {
      observeVocabularyCase(forms, surface, forced);
      this.dirtyForms.add(word);
      return;
    }
    if (surface === word) return;
    // First capital for a word already counted in lowercase: credit the earlier
    // occurrences to the lowercase spelling rather than let one capital win.
    const seeded: VocabularyCaseForms = {};
    const counts = this.countsOf(word);
    const lowercase = counts.user + counts.assistant;
    if (lowercase > 0) seeded[word] = [lowercase, 0];
    observeVocabularyCase(seeded, surface, forced);
    this.caseForms.set(word, seeded);
    this.dirtyForms.add(word);
  }

  checkpoint(sessionKey: string, version: string, cutoff: number): void {
    this.pendingCheckpoints.push({ key: sessionKey, version, cutoff });
  }

  discardPending(): void {
    for (const delta of this.pendingWords.values()) {
      this.userTotal -= delta.user;
      this.assistantTotal -= delta.assistant;
    }
    this.pendingWords.clear();
    this.pendingCheckpoints = [];
    this.pendingTokens = 0;
  }

  /**
   * Commit what the scan observed to memory and hand the changed rows to the
   * writer. This does not wait for disk: the scan is producing text on the same
   * loop the server serves from, and the table it writes is regenerable.
   */
  async flush(): Promise<void> {
    if (this.idle && this.clean) return;
    for (const [word, delta] of this.pendingWords) {
      addDelta(this.wordCounts, word, "user", delta.user);
      addDelta(this.wordCounts, word, "assistant", delta.assistant);
      this.dirtyWords.add(word);
    }
    this.pendingWords.clear();
    this.pendingTokens = 0;
    for (const checkpoint of this.pendingCheckpoints) {
      this.sessions.set(checkpoint.key, {
        version: checkpoint.version,
        cutoff: checkpoint.cutoff,
      });
      this.dirtyCheckpoints.add(checkpoint.key);
    }
    this.pendingCheckpoints = [];
    this.save();
    this.rebuildTop();
    this.wordsRevision++;
    await yieldToLoop();
  }

  /** Nothing in memory differs from what the table and the filter hold. */
  private get clean(): boolean {
    return (
      this.dirtyWords.size === 0 &&
      this.dirtyForms.size === 0 &&
      this.dirtyCheckpoints.size === 0 &&
      (this.seen?.pendingWrites ?? 0) === 0
    );
  }

  /**
   * Mark the table for writing, no sooner than the minimum interval since the
   * last write. Scans arrive as fast as the catalog republishes, and the table
   * is regenerable, so paying a commit for each one buys nothing: a crash
   * costs at most one interval of learning, and a rescan recovers even that.
   */
  private save(): void {
    if (this.clean || this.writeTimer) return;
    const due = this.lastWriteAt + this.writeIntervalMs - Date.now();
    if (due <= 0) {
      this.write();
      return;
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      if (!this.clean) this.write();
    }, due);
    // A pending write must never be the reason the process stays alive.
    this.writeTimer.unref();
  }

  private write(): void {
    this.lastWriteAt = Date.now();
    void this.saver.save().catch(warnWriteFailed);
  }

  /** Writer body. Runs one at a time, coalescing whatever arrived meanwhile. */
  private async persist(): Promise<void> {
    const words = [...this.dirtyWords];
    const forms = new Map<string, VocabularyCaseForms>();
    for (const word of this.dirtyForms) {
      const entry = this.caseForms.get(word);
      if (entry) forms.set(word, entry);
    }
    const checkpoints = [...this.dirtyCheckpoints];
    this.dirtyWords = new Set();
    this.dirtyForms = new Set();
    this.dirtyCheckpoints = new Set();
    try {
      // Counts before fingerprints: a crash between them re-observes messages
      // the filter forgot, which the session checkpoint already covers. The
      // reverse order would drop counted text with no way to notice.
      await this.database?.commit({
        words: words.map((word) => ({
          word,
          user: this.wordCounts.get(word)?.user ?? 0,
          assistant: this.wordCounts.get(word)?.assistant ?? 0,
        })),
        forms,
        checkpoints: checkpoints.flatMap((key) => {
          const row = this.sessions.get(key);
          return row ? [{ key, version: row.version, cutoff: row.cutoff }] : [];
        }),
      });
      await this.seenFile?.persist();
    } catch (error) {
      for (const word of words) this.dirtyWords.add(word);
      for (const word of forms.keys()) this.dirtyForms.add(word);
      for (const key of checkpoints) this.dirtyCheckpoints.add(key);
      throw error;
    }
  }

  /**
   * Write anything still waiting for its interval and resolve only once it
   * landed, rethrowing what the writer threw. A caller that is about to discard
   * the only other copy of what the write carried needs this rather than
   * `settled()`, which reports quiescence.
   */
  private async landed(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
    // Nothing of ours is waiting, but a write that is already running still has
    // to finish before anything here counts as landed.
    if (this.clean) return this.saver.idle();
    this.lastWriteAt = Date.now();
    await this.saver.flush();
  }

  /**
   * Write anything still waiting for its interval, then wait for the writer to
   * go quiet. Shutdown, reset, and tests; never the scan.
   */
  async settled(): Promise<void> {
    await this.landed().catch(warnWriteFailed);
  }

  async reset(): Promise<void> {
    this.discardPending();
    this.wordCounts.clear();
    this.caseForms.clear();
    this.top.clear();
    this.sessionTops.clear();
    this.userTotal = 0;
    this.assistantTotal = 0;
    this.sessions.clear();
    this.dirtyWords = new Set();
    this.dirtyForms = new Set();
    this.dirtyCheckpoints = new Set();
    this.state.generation++;
    this.state.resetAfter = Date.now();
    // Stop and Clear discards learned state, and the floor is learned state:
    // it records how far counting already reached. Left standing it would tell
    // the relearn below that everything older was already counted, and a
    // cleared store would silently refuse to learn it. The clearing belongs to
    // the stop, not to the filter — a mode that dropped the filter entirely
    // would still keep a floor, and stopping would still have to clear it.
    this.state.seenFrom = 0;
    this.writeState();
    await this.saver.idle();
    this.database?.clear();
    // Discard the filter itself rather than empty it. Reset can arrive before
    // any scan attached the file, and a surviving file would tell the relearn
    // that every message it re-reads has already been counted.
    this.loaded = false;
    await this.seenFile?.close();
    this.seenFile = undefined;
    this.seen = undefined;
    await rm(this.seenPath, { force: true });
    this.wordsRevision++;
  }

  /**
   * Empty the fingerprint filter and everything derived from it, keeping the
   * settings and the reset generation. The caller follows with a retrospective
   * scan, which relearns the retained window into a filter that is no longer
   * over its design load.
   */
  async relearn(): Promise<void> {
    const previous = this.state.resetAfter;
    await this.reset();
    // A reset blocks automatic scans from reaching older history; this one is
    // making room, not discarding history, so the window stays as it was.
    this.state.resetAfter = previous;
    this.writeState();
  }

  /**
   * A capitalized spelling of a common English word stands only while writing
   * still prefers it: "YA" survives, an occasional shouted "NOT" does not.
   */
  private spelled(word: string): boolean {
    const key = word.toLowerCase();
    return (
      key === word ||
      projectVocabularyCase(key, this.caseForms.get(key)) === word
    );
  }

  private sessionTop(sessionKey: string): DistinctiveTop {
    let top = this.sessionTops.get(sessionKey);
    if (top) {
      refreshLruMap(this.sessionTops, sessionKey, top);
    } else {
      top = new DistinctiveTop(100);
      this.sessionTops.set(sessionKey, top);
      for (const key of this.sessionTops.keys()) {
        if (this.sessionTops.size <= SESSION_TOP_LIMIT) break;
        this.sessionTops.delete(key);
      }
    }
    return top;
  }

  keyterms(
    baseline: ReadonlyMap<string, number>,
    limit = 100,
    maxLength = 50,
    sessionTerms: ReadonlySet<string> = new Set(),
    sessionKey?: string,
  ): string[] {
    if (!this.state.biasing) return [];
    const total = this.tokenTotal();
    const ranked = new Map(this.top.entries());
    const fromSession = new Set<string>();
    const session = sessionKey ? this.sessionTops.get(sessionKey) : undefined;
    if (session && sessionKey)
      refreshLruMap(this.sessionTops, sessionKey, session);
    if (session)
      for (const [word, score] of session.entries()) {
        ranked.set(word, score);
        fromSession.add(word);
      }
    for (const term of sessionTerms) {
      if (this.ignored.has(term) || term.length > maxLength) continue;
      const counts = this.countsOf(term);
      const count = counts.user + counts.assistant;
      if (count <= 0) continue;
      ranked.set(
        term,
        vocabularyDistinctiveScore(
          count,
          total,
          vocabularyFrequency(baseline, term),
        ) * this.state.sessionMultiplier,
      );
      fromSession.add(term);
    }
    const candidates = [...ranked]
      .filter(
        ([word, score]) =>
          score > 0 &&
          word.length <= maxLength &&
          !this.ignored.has(word) &&
          this.spelled(word),
      )
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const selected: string[] = [];
    const taken = new Set<string>();
    let escapes = Math.ceil(limit * ESCAPE_SHARE);
    const take = (word: string): void => {
      if (selected.length >= limit) return;
      const capitalized = word !== word.toLowerCase();
      if (capitalized && escapes <= 0) return;
      const surface = projectVocabularyCase(word, this.caseForms.get(word));
      if (taken.has(surface)) return;
      if (capitalized) escapes--;
      taken.add(surface);
      selected.push(surface);
    };
    // The session share is a floor, not a ceiling: it guarantees this many
    // slots to the active session before score alone decides the rest, and
    // session terms that outrank everything still take more than their share.
    // A multiplier cannot do this job on its own, because global counts grow
    // with history without bound while a fresh session's stay small, so any
    // fixed factor is eventually too small. Holding slots is independent of
    // that arithmetic.
    const reserved = Math.min(
      limit,
      Math.ceil(limit * Math.min(1, Math.max(0, this.state.sessionShare))),
    );
    if (reserved > 0)
      for (const [word] of candidates) {
        if (selected.length >= reserved) break;
        if (fromSession.has(word)) take(word);
      }
    for (const [word] of candidates) take(word);
    return selected;
  }

  async close(): Promise<void> {
    await this.saver.idle();
    await this.seenFile?.close();
    this.seenFile = undefined;
    this.database?.close();
    this.database = undefined;
  }
}

/** A failed write leaves its rows dirty, so the next one carries them again. */
function warnWriteFailed(error: unknown): void {
  getLogger().warn(
    { component: "speech", err: error },
    "Speech vocabulary table write failed; retrying on the next flush",
  );
}

function readJsonFile<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    // Absent or unreadable: there is nothing to adopt, and a rescan rebuilds
    // whatever the file held.
    return undefined;
  }
}
