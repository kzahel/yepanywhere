import { setImmediate as yieldToLoop } from "node:timers/promises";
import {
  VOCABULARY_FLUSH_COUNTS,
  type SpeechVocabularyStatus,
} from "@yep-anywhere/shared";
import { getLogger } from "../../logging/logger.js";
import type { Message } from "../../supervisor/types.js";
import {
  vocabularyFingerprint,
  type VocabularyStore,
  type VocabularySettingsUpdate,
  type VocabularyMessage,
} from "./VocabularyStore.js";

export interface VocabularySession {
  key: string;
  version: string;
  updatedAt: number;
  messages: () => AsyncIterable<readonly Message[]>;
}

/** A catalog generation, as the session source reports and resumes from. */
export interface VocabularyCatalogMark {
  catalogEpoch: string;
  catalogGeneration: number;
}

/**
 * Lets an automatic scan read only the sessions changed since the last
 * completed one (plan 189 step 4): the source reads after `since` and
 * reports the generation it read in `reached`.
 */
export interface VocabularyCatalogScan {
  since?: VocabularyCatalogMark;
  reached?: VocabularyCatalogMark;
}

const MESSAGE_BURST = 16;

/** Shortest interval between two relearns of a full fingerprint filter. */
const RELEARN_COOLDOWN_MS = 24 * 3600_000;
/** Shortest interval between two compactions, for a window that cannot fit. */
const COMPACT_COOLDOWN_MS = 3600_000;

/**
 * How far back a compacted filter still remembers individual messages.
 * Deliberately hours rather than minutes: provider timestamps are not assumed
 * to come from a monotonic, daylight-saving-immune clock, so the window has to
 * absorb a wall-clock step. A daylight-saving shift is the worst named case at
 * an hour, and two leaves an hour of margin.
 */
const DEFAULT_EPSILON_HOURS = 2;

function parseEpsilonMs(env: NodeJS.ProcessEnv): number {
  const raw = env.YEP_SPEECH_VOCABULARY_EPSILON_HOURS;
  const parsed = raw ? Number.parseFloat(raw) : Number.NaN;
  const hours =
    Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EPSILON_HOURS;
  return hours * 3600_000;
}

/**
 * The text a message contributes, or nothing when it contributes none. Shared
 * with compaction so a rebuilt filter fingerprints exactly what the counting
 * path fingerprinted; two copies of this would silently stop agreeing.
 */
export function vocabularyMessage(
  message: Message,
): VocabularyMessage | undefined {
  const timestamp = Date.parse(message.timestamp ?? "");
  if (!Number.isFinite(timestamp)) return undefined;
  if (message.type !== "user" && message.type !== "assistant") return undefined;
  if (message.isMeta || message.isCompactSummary) return undefined;
  const content = message.message?.content ?? message.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter(
              (block) =>
                block?.type === "text" && typeof block.text === "string",
            )
            .map((block) => block.text)
            .join("\n")
        : "";
  return { source: message.type, timestamp, text } satisfies VocabularyMessage;
}

export class VocabularyLearning {
  private work?: Promise<void>;
  private epoch = 0;
  private closed = false;
  private requested = false;
  private retrospective = false;
  private relearnAfter = 0;
  private compactAfter = 0;
  /**
   * Where the last completed automatic scan left the catalog, under the
   * settings generation and cutoff it scanned with. A later scan with the same
   * generation and a cutoff no earlier skips sessions that have not changed:
   * each was checkpointed or skipped then, and would be again.
   */
  private scannedThrough?: {
    mark: VocabularyCatalogMark;
    generation: number;
    cutoff: number;
  };
  private readonly epsilonMs: number;
  private readonly flushAfter: number;
  private readonly reference?: () => Promise<ReadonlyMap<string, number>>;
  private progress = {
    state: "idle" as "idle" | "scanning" | "error",
    sessions: 0,
    messages: 0,
    error: undefined as string | undefined,
  };

  constructor(
    readonly store: VocabularyStore,
    private readonly sessions: (
      cutoff: number,
      scan?: VocabularyCatalogScan,
    ) => AsyncIterable<VocabularySession>,
    options: {
      reference?: () => Promise<ReadonlyMap<string, number>>;
      flushAfter?: number;
      env?: NodeJS.ProcessEnv;
    } = {},
  ) {
    this.reference = options.reference;
    this.flushAfter = options.flushAfter ?? VOCABULARY_FLUSH_COUNTS;
    this.epsilonMs = parseEpsilonMs(options.env ?? process.env);
  }

  status(includeWords = false): SpeechVocabularyStatus {
    return {
      ...this.store.settings(),
      totals: this.store.totals(),
      ...(includeWords ? { words: this.store.words() } : {}),
      scan: { ...this.progress },
      integration: "grok-via-ya" as const,
    };
  }

  configure(settings: VocabularySettingsUpdate): void {
    const wasEnabled = this.store.settings().enabled;
    this.store.configure(settings);
    if (!settings.enabled) {
      this.epoch++;
      this.requested = false;
      this.store.discardPending();
    } else if (!wasEnabled) this.scan();
  }

  scan(retrospective = true): void {
    if (this.closed || !this.store.settings().enabled) return;
    this.requested = true;
    this.retrospective ||= retrospective;
    if (this.work) return;
    this.work = this.run().finally(() => {
      this.work = undefined;
      if (this.requested) this.scan(false);
    });
  }

  private async run(): Promise<void> {
    this.requested = false;
    const epoch = this.epoch;
    const { generation, hours } = this.store.settings();
    const requestedCutoff = Date.now() - hours * 3600_000;
    const cutoff = this.retrospective
      ? requestedCutoff
      : this.store.automaticCutoff(requestedCutoff);
    const previous = this.scannedThrough;
    const scan: VocabularyCatalogScan = {
      since:
        !this.retrospective &&
        previous?.generation === generation &&
        previous.cutoff <= cutoff
          ? previous.mark
          : undefined,
    };
    this.retrospective = false;
    const active = () =>
      !this.closed && epoch === this.epoch && this.store.accepts(generation);
    this.progress = {
      state: "scanning",
      sessions: 0,
      messages: 0,
      error: undefined,
    };
    try {
      await this.store.load();
      if (this.reference) this.store.setReference(await this.reference());
      if (!active()) return;
      let burst = 0;
      for await (const session of this.sessions(cutoff, scan)) {
        if (!active()) break;
        if (
          session.updatedAt < cutoff ||
          this.store.hasScanned(session.key, session.version, cutoff)
        )
          continue;
        for await (const page of session.messages()) {
          if (!active()) break;
          for (const message of page) {
            if (!active()) break;
            const observed = vocabularyMessage(message);
            if (!observed || observed.timestamp < cutoff) continue;
            this.store.observe(session.key, observed, generation);
            this.progress.messages++;
            burst++;
            if (this.store.pendingCount >= this.flushAfter)
              await this.store.flush();
            if (burst >= MESSAGE_BURST) {
              burst = 0;
              await yieldToLoop();
            }
          }
        }
        if (!active()) break;
        this.store.checkpoint(session.key, session.version, cutoff);
        this.progress.sessions++;
        await yieldToLoop();
      }
      // A scan runs whenever the catalog republishes, which live sessions do
      // every few seconds. One that observed nothing new must cost nothing:
      // no rewritten rows, no rebuilt ranking, no new revision.
      if (this.store.settings().enabled && active()) {
        if (!this.store.idle) await this.store.flush();
        if (scan.reached)
          this.scannedThrough = { mark: scan.reached, generation, cutoff };
      } else this.store.discardPending();
      if (active()) this.progress.state = "idle";
      // Compaction first: it keeps every learned count, and it triggers far
      // below the load at which the filter is called full.
      if (
        this.store.seenOverloaded &&
        active() &&
        Date.now() >= this.compactAfter
      )
        await this.compact(active);
      if (
        this.store.seenSaturated &&
        active() &&
        Date.now() >= this.relearnAfter
      )
        await this.makeRoom();
    } catch (error) {
      this.store.discardPending();
      if (!active()) return;
      this.requested = false;
      this.progress.state = "error";
      this.progress.error =
        error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Rebuild the filter over the last epsilon of history and raise the floor to
   * match, so it holds recent fingerprints instead of every one ever seen. The
   * counts are untouched: this is the answer that makes the full clear below a
   * last resort rather than the only move.
   *
   * The rebuild runs in the same small yielding steps as a scan and fills a
   * second filter, so the live one keeps answering throughout; the swap is one
   * rename. A message that arrives during the rebuild can be missed by it, and
   * is then protected only by its session's scan checkpoint until that session
   * changes — acceptable for an event this rare, and the reason the floor is
   * set to where the rebuild started rather than where it finished.
   */
  private async compact(active: () => boolean): Promise<void> {
    this.compactAfter = Date.now() + COMPACT_COOLDOWN_MS;
    const from = Date.now() - this.epsilonMs;
    const replacement = this.store.beginSeenCompaction();
    let messages = 0;
    let burst = 0;
    for await (const session of this.sessions(from)) {
      if (!active()) return;
      for await (const page of session.messages()) {
        if (!active()) return;
        for (const message of page) {
          const observed = vocabularyMessage(message);
          if (!observed || observed.timestamp < from) continue;
          replacement.add(vocabularyFingerprint(session.key, observed));
          messages++;
          if (++burst >= MESSAGE_BURST) {
            burst = 0;
            await yieldToLoop();
          }
        }
      }
      await yieldToLoop();
    }
    if (!active()) return;
    await this.store.commitSeenCompaction(replacement, from);
    getLogger().info(
      { component: "speech", messages, from: new Date(from).toISOString() },
      "Compacted the speech vocabulary fingerprint filter to its recent window",
    );
  }

  /**
   * The fingerprint filter is full, so it can no longer tell new text from old
   * reliably. Empty it and everything counted through it, then relearn the
   * retained window from provider history — the counts outside that window are
   * not recoverable by rescanning anyway.
   *
   * The cooldown matters: a retained window whose messages cannot fit the
   * reservation fills the filter again as soon as it is relearned. Backing off
   * leaves recognition working against a filter that dedupes approximately,
   * which is the mild failure; rescanning in a loop is not.
   */
  private async makeRoom(): Promise<void> {
    this.relearnAfter = Date.now() + RELEARN_COOLDOWN_MS;
    getLogger().warn(
      { component: "speech" },
      "Speech vocabulary fingerprint filter is full; relearning the retained window",
    );
    await this.store.relearn();
    this.scan(true);
  }

  async reset(): Promise<void> {
    this.epoch++;
    this.scannedThrough = undefined;
    this.requested = false;
    this.retrospective = false;
    await this.store.reset();
    this.progress = {
      state: "idle",
      sessions: 0,
      messages: 0,
      error: undefined,
    };
  }

  async settled(): Promise<void> {
    while (this.work) await this.work;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.epoch++;
    this.requested = false;
    await this.settled();
    if (this.store.settings().enabled && !this.store.idle)
      await this.store.flush();
    else this.store.discardPending();
    await this.store.close();
  }
}
