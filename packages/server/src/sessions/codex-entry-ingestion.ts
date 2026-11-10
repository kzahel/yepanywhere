import { isCompressedCodexRolloutPath } from "../utils/codexRolloutFiles.js";
import type { CodexSessionEntry } from "@yep-anywhere/shared";
import type { Stats } from "node:fs";
import type { CodexParsedEntrySnapshot } from "./codex-rollout-window.js";
import {
  TranscriptAppendMismatchError,
  type TranscriptAppendFence,
} from "./transcript-ingestion.js";

/** Decoded source state belongs to the existing bounded reader cache. */
export interface CodexEntrySourceState {
  entries: CodexSessionEntry[];
  sourceBytes: number;
  partialLine: Buffer;
  committedEntries: number;
  appendFence?: TranscriptAppendFence;
  nextLeafOrdinal?: number;
  leafStartOrdinal?: number;
}
export function codexEntrySourceState(
  parsed: CodexParsedEntrySnapshot & { nextLeafOrdinal?: number },
): CodexEntrySourceState {
  return {
    entries: parsed.entries,
    sourceBytes: parsed.sourceBytes,
    partialLine: parsed.partialLine,
    committedEntries: parsed.committedEntries ?? parsed.entries.length,
    appendFence: parsed.appendFence,
    nextLeafOrdinal: parsed.nextLeafOrdinal,
    leafStartOrdinal: parsed.leafStartOrdinal,
  };
}
export interface CodexEntrySourceVersion {
  filePath: string;
  startByte: number;
  mtimeMs: number;
  ctimeMs: number;
  size: number;
}
/** The reader owns this decoded state; budget release marks held snapshots uncached. */
export interface CodexEntryState
  extends CodexEntrySourceState,
    CodexEntrySourceVersion {
  normalizationSource: object;
  uncached?: boolean;
}
export function isCodexEntrySnapshot(
  cached: (CodexEntrySourceState & CodexEntrySourceVersion) | undefined,
  path: string,
  start: number,
  stats: Stats,
): boolean {
  return (
    !!cached &&
    cached.filePath === path &&
    cached.startByte === start &&
    cached.size === stats.size &&
    cached.mtimeMs === stats.mtimeMs &&
    cached.ctimeMs === stats.ctimeMs &&
    (!cached.appendFence ||
      (cached.appendFence.dev === stats.dev &&
        cached.appendFence.ino === stats.ino))
  );
}
export function canAppendCodexSource(
  path: string,
  cached: CodexEntrySourceState & CodexEntrySourceVersion,
  stats: Stats,
  startByte: number,
) {
  return (
    cached.filePath === path &&
    cached.startByte === startByte &&
    !isCompressedCodexRolloutPath(path) &&
    !!cached.appendFence &&
    cached.appendFence.dev === stats.dev &&
    cached.appendFence.ino === stats.ino &&
    stats.size > cached.size
  );
}
export function recoverCodexAppendMismatch<T extends object>(
  error: unknown,
  cache: Map<string, T>,
  budget: { release(key: object): void },
  id: string,
  expected: T | undefined,
): null {
  if (!(error instanceof TranscriptAppendMismatchError)) throw error;
  if (expected && cache.get(id) === expected) {
    budget.release(expected);
    cache.delete(id);
  }
  return null;
}
function committedCodexEntries(
  parsed: CodexParsedEntrySnapshot,
): CodexSessionEntry[] {
  return parsed.entries.slice(
    0,
    parsed.committedEntries ?? parsed.entries.length,
  );
}
/** Replace a provisional row before committing its replay; old normalized snapshots
 * remain separate, and their sequence check forces a rebuild when that row changed.
 */
export function appendCodexEntrySource(
  cached: CodexEntrySourceState,
  parsed: CodexParsedEntrySnapshot,
  nextLeafOrdinal: number | undefined,
) {
  const projected =
    cached.leafStartOrdinal === undefined
      ? parsed
      : projectCodexLeafEntries(parsed, cached.leafStartOrdinal);
  cached.entries.length = cached.committedEntries;
  cached.committedEntries +=
    projected.committedEntries ?? projected.entries.length;
  cached.entries.push(...projected.entries);
  cached.sourceBytes += parsed.sourceBytes;
  cached.partialLine = parsed.partialLine;
  cached.appendFence = parsed.appendFence;
  cached.nextLeafOrdinal = nextLeafOrdinal;
}

export function validateCodexSourceOrdinals(
  parsed: CodexParsedEntrySnapshot,
  filePath: string,
  validate: (
    entries: readonly CodexSessionEntry[],
    filePath: string,
    next?: number,
  ) => number | undefined,
  next?: number,
) {
  // Visible provisional rows must be valid, but must not advance the committed cursor.
  const visibleNext = validate(parsed.entries, filePath, next);
  return parsed.committedEntries === undefined ||
    parsed.committedEntries === parsed.entries.length
    ? visibleNext
    : validate(
        committedCodexEntries(parsed),
        filePath,
        next ?? Number((parsed.entries[0] as { ordinal?: unknown })?.ordinal),
      );
}

export function nextCodexLeafOrdinal(
  cached: CodexEntrySourceState,
  parsed: CodexParsedEntrySnapshot,
  filePath: string,
  validate: Parameters<typeof validateCodexSourceOrdinals>[2],
) {
  return cached.nextLeafOrdinal === undefined
    ? undefined
    : validateCodexSourceOrdinals(
        parsed,
        filePath,
        validate,
        cached.nextLeafOrdinal,
      );
}

/** Apply the leaf filter to visible rows and commitment with exactly the same rule. */
export function projectCodexLeafEntries(
  parsed: CodexParsedEntrySnapshot,
  startOrdinal: number,
) {
  const entries: CodexSessionEntry[] = [];
  let committedEntries = 0;
  for (let index = 0; index < parsed.entries.length; index++) {
    const entry = parsed.entries[index]!;
    if (
      entry.type === "session_meta" ||
      Number((entry as { ordinal?: unknown }).ordinal) < startOrdinal
    )
      continue;
    entries.push(entry);
    if (index < (parsed.committedEntries ?? parsed.entries.length))
      committedEntries++;
  }
  return { entries, committedEntries };
}
