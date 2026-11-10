import { basename, dirname, join } from "node:path";
import {
  findCodexRolloutRepresentation,
  getCodexRolloutId,
  plainCodexRolloutPath,
} from "../utils/codexRolloutFiles.js";
import {
  CodexSessionMap,
  codexSharedScanCache,
  isNewerCodexSessionFile,
  type CodexSessionFile,
  type CodexSharedScanCacheEntry,
} from "./codex-shared-scan-cache.js";

type RootScans = Map<string, CodexSharedScanCacheEntry>;
type PathSource = "active" | "archived";
export interface CodexRootRead {
  readonly authority: number;
  readonly sequence: number;
}
interface RolloutLocator {
  filePath: string;
  sequence: number;
  source: PathSource;
}

/** Weak metadata on the existing root owner, not a second root registry. */
const indexes = new WeakMap<RootScans, CodexRootFileIndex>();

export function codexRootFileIndex(sessionsDir: string): CodexRootFileIndex {
  let scans = codexSharedScanCache.get(sessionsDir);
  if (!scans) {
    scans = new Map();
    codexSharedScanCache.set(sessionsDir, scans);
  }
  let index = indexes.get(scans);
  if (!index) {
    index = new CodexRootFileIndex(sessionsDir, scans);
    indexes.set(scans, index);
  }
  return index;
}

export class CodexRootFileIndex {
  /** One winning compact locator per observed session in this native store. */
  private sessions = new Map<string, CodexSessionFile>();
  /** One locator per known active/archived rollout; no project copies/misses. */
  private readonly paths = new Map<string, RolloutLocator>();
  /** Weak keys do not retain expired active-window enumeration scopes. */
  private readonly versions = new WeakMap<CodexSessionMap, number>();
  /** Fresh positive proof belongs to a file, not to the entire root. */
  private readonly proofs = new WeakMap<CodexSessionFile, number>();
  /** Validated competing files, deduplicated until authoritative replacement. */
  private readonly candidates = new Map<string, CodexSessionFile>();
  /** At most one finite path read per active/archive source and authority. */
  private readonly pathReads = new Map<
    PathSource,
    { authority: number; promise: Promise<void> }
  >();
  private authority = 0;
  private sequence = 0;

  constructor(
    private readonly sessionsDir: string,
    private readonly scans: RootScans,
  ) {}

  isCurrent(): boolean {
    return codexSharedScanCache.get(this.sessionsDir) === this.scans;
  }

  readVersion(): CodexRootRead {
    return {
      authority: this.authority,
      sequence: ++this.sequence,
    };
  }

  accepts(read: CodexRootRead): boolean {
    return this.isCurrent() && read.authority === this.authority;
  }

  getSession(id: string): CodexSessionFile | undefined {
    return this.sessions.get(id);
  }

  /** Merge a current enumeration once per version; paths have separate proof. */
  observe(sessions: CodexSessionMap, read: CodexRootRead, fresh = false): void {
    if (!this.accepts(read)) return;
    const version = this.versions.get(sessions);
    if (version === sessions.version) return;
    const changed =
      (version === undefined ? undefined : sessions.changesSince(version)) ??
      sessions.values();
    this.versions.set(sessions, sessions.version);
    for (const session of changed)
      this.mergeSession(session, fresh ? read.sequence : 0);
  }

  /** Exact points update compatible scopes without certifying enumeration. */
  observePoints(
    sessions: readonly CodexSessionFile[],
    read: CodexRootRead,
  ): boolean {
    if (!this.accepts(read)) return false;
    for (const session of sessions) {
      const sequence = ++this.sequence;
      const newer = this.mergeSession(session, sequence);
      this.putPath(session.filePath, sequence, "active", newer);
      for (const entry of this.scans.values()) {
        if (
          entry.activeAfterMs !== undefined &&
          session.mtime < entry.activeAfterMs
        )
          continue;
        const known = entry.sessions.get(session.id);
        if (!known || isNewerCodexSessionFile(session, known))
          entry.sessions.set(session.id, session);
      }
    }
    return true;
  }

  /** Complete unfiltered evidence replaces old facts, preserving newer proof. */
  completeEnumeration(sessions: CodexSessionMap, read: CodexRootRead): void {
    if (!this.accepts(read)) return;
    for (const facts of [this.sessions, this.candidates])
      for (const session of facts.values()) {
        const scanned = sessions.get(session.id);
        if (
          (this.proofs.get(session) ?? 0) > read.sequence &&
          (!scanned || isNewerCodexSessionFile(session, scanned))
        )
          sessions.set(session.id, session);
      }
    for (const [id, session] of this.sessions) {
      if (sessions.has(id)) continue;
      const rolloutId = getCodexRolloutId(session.filePath);
      if (rolloutId && this.paths.get(rolloutId)?.filePath === session.filePath)
        this.paths.delete(rolloutId);
    }
    // This can select an older survivor after a newer file disappeared.
    this.sessions = new Map(sessions);
    this.candidates.clear();
    this.rememberPaths(
      [...sessions.values()].map((s) => s.filePath),
      read,
    );
    for (const session of sessions.values())
      this.proofs.set(
        session,
        Math.max(this.proofs.get(session) ?? 0, read.sequence),
      );
    this.versions.set(sessions, sessions.version);
    this.authority += 1;
    // Other scopes began under older absence/precedence evidence. Remove
    // them, including pending scans; their callers retry against this owner.
    for (const [key, entry] of this.scans)
      if (entry.sessions !== sessions) this.scans.delete(key);
    this.pathReads.clear();
  }

  rememberPaths(
    paths: readonly string[],
    read: CodexRootRead,
    source: PathSource = "active",
  ): void {
    if (!this.accepts(read)) return;
    for (const path of paths) this.putPath(path, read.sequence, source, true);
  }

  private mergeSession(session: CodexSessionFile, sequence: number): boolean {
    const current = this.sessions.get(session.id);
    if (current && !isNewerCodexSessionFile(session, current)) {
      if (current.filePath === session.filePath)
        this.proofs.set(
          current,
          Math.max(this.proofs.get(current) ?? 0, sequence),
        );
      else this.rememberCandidate(session, sequence);
      return false;
    }
    if (current) this.rememberCandidate(current, this.proofs.get(current) ?? 0);
    this.sessions.set(session.id, session);
    this.proofs.set(session, Math.max(this.proofs.get(session) ?? 0, sequence));
    return true;
  }

  private rememberCandidate(session: CodexSessionFile, sequence: number): void {
    if (sequence <= 0) return;
    const candidate = this.candidates.get(session.filePath);
    if (!candidate || (this.proofs.get(candidate) ?? 0) < sequence) {
      this.candidates.set(session.filePath, session);
      this.proofs.set(session, sequence);
    }
  }

  private putPath(
    filePath: string,
    sequence: number,
    source: PathSource,
    overwrite: boolean,
  ): void {
    const id = getCodexRolloutId(filePath);
    if (!id) return;
    const current = this.paths.get(id);
    if (current) {
      if (!overwrite) return;
      if (source === "archived" && current.source === "active") return;
      if (source === current.source && current.sequence > sequence) return;
    }
    this.paths.set(id, { filePath, sequence, source });
  }

  async findRolloutPath(
    id: string,
    enumerate: (directory: string) => Promise<string[]>,
  ): Promise<string | null> {
    const read = this.readVersion();
    const cached = this.paths.get(id);
    if (cached) {
      const path = await findCodexRolloutRepresentation(
        plainCodexRolloutPath(cached.filePath),
      );
      if (!this.accepts(read)) return null;
      if (path) {
        this.putPath(path, read.sequence, cached.source, true);
        return this.paths.get(id)?.filePath ?? null;
      }
      if (this.paths.get(id) === cached) this.paths.delete(id);
    }
    await this.readPaths("active", this.sessionsDir, enumerate);
    if (!this.accepts(read)) return null;
    const active = this.paths.get(id);
    if (active) return active.filePath;
    if (basename(this.sessionsDir) !== "sessions") return null;
    await this.readPaths(
      "archived",
      join(dirname(this.sessionsDir), "archived_sessions"),
      enumerate,
    );
    return this.accepts(read) ? (this.paths.get(id)?.filePath ?? null) : null;
  }

  private readPaths(
    source: PathSource,
    directory: string,
    enumerate: (directory: string) => Promise<string[]>,
  ): Promise<void> {
    const existing = this.pathReads.get(source);
    if (existing?.authority === this.authority) return existing.promise;
    const read = this.readVersion();
    const promise = enumerate(directory)
      .then((paths) => this.rememberPaths(paths, read, source))
      .finally(() => {
        if (this.pathReads.get(source)?.promise === promise)
          this.pathReads.delete(source);
      });
    this.pathReads.set(source, { authority: read.authority, promise });
    return promise;
  }
}
