import {
  claudeHistoryRow,
  type ClaudeHistoryRows,
} from "./claude-history-rows.js";
import { isAbsolute } from "node:path";
import {
  detectScopedNestedHarnessLaunch,
  type NativeSessionRef,
} from "@yep-anywhere/shared";

export interface HistoricalHarnessHint {
  id: string;
  targetId: string;
  directory: string;
  sourceTimestamp: string;
  harvestedAt: string;
  ready?: boolean;
}
export interface HarnessHistoryVersion {
  id: string;
  size: number;
  mtime: number;
  ctime?: number;
}
export interface HarnessHistoryState {
  entry: number;
  block: number;
  pending: Map<string, HistoricalHarnessHint>;
  partial?: boolean;
  needsCommit?: boolean;
  retryAfter?: number;
}
export const emptyHarnessHistory = (): HarnessHistoryState => ({
  entry: 0,
  block: 0,
  pending: new Map(),
});
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
const validId = (id: unknown): id is string =>
  typeof id === "string" &&
  id.length > 0 &&
  id.length <= 1024 &&
  ![...id].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

/**
 * Fold only rows already acquired by the authorized transcript reader. Each
 * turn inspects at most 256 records/blocks and 256K command characters. The
 * returned state is staged: the owner commits it only after generation-fenced
 * handoff to its durable evidence queue. No raw row, command or output is kept.
 */
export function collectHarnessHistory(
  entries: ClaudeHistoryRows,
  previous: HarnessHistoryState,
  nativeId: string,
  admittedAt: string,
  limit: number,
  committedEntries = Math.max(0, entries.length - 1),
  deferred: ReadonlySet<string> = new Set(),
): { state: HarnessHistoryState; hints: HistoricalHarnessHint[] } {
  const state = { ...previous, pending: new Map(previous.pending) },
    hints: HistoricalHarnessHint[] = [...state.pending.values()]
      .filter((h) => h.ready && !deferred.has(h.id))
      .slice(0, limit);
  const birth = Date.parse(admittedAt);
  if (!Number.isFinite(birth)) return { state, hints };
  let budget = 256,
    bytes = 256 * 1024;
  // Reader evidence excludes provisional unterminated rows. Older callers
  // without that private fence conservatively omit their last row.
  while (state.entry < committedEntries && budget > 0 && hints.length < limit) {
    const row = object(claudeHistoryRow(entries, state.entry)),
      message = object(row?.message),
      content = message?.content;
    if (
      !row ||
      (row.type !== "assistant" && row.type !== "user") ||
      row.sessionId !== nativeId ||
      row.isSidechain === true ||
      row.isSynthetic === true ||
      row.isReplay === true ||
      row.parent_tool_use_id ||
      !Array.isArray(content) ||
      typeof row.timestamp !== "string" ||
      !Number.isFinite(Date.parse(row.timestamp)) ||
      Date.parse(row.timestamp) < birth
    ) {
      state.entry++;
      state.block = 0;
      budget--;
      continue;
    }
    if (state.block >= content.length) {
      state.entry++;
      state.block = 0;
      budget--;
      continue;
    }
    const block = object(content[state.block]);
    if (
      row.type === "assistant" &&
      block?.type === "tool_use" &&
      block.name === "Bash" &&
      validId(block.id)
    ) {
      const input = object(block.input),
        command = input?.command;
      if (
        typeof command === "string" &&
        command.length <= 65536 &&
        input?.run_in_background !== true
      ) {
        if (command.length > bytes) break;
        bytes -= command.length;
        const launch = detectScopedNestedHarnessLaunch(command);
        if (
          launch?.sessionId &&
          launch.workingDirectory &&
          isAbsolute(launch.workingDirectory) &&
          launch.workingDirectory.length <= 4096 &&
          launch.sessionId !== nativeId
        ) {
          const hint = {
            id: block.id,
            targetId: launch.sessionId,
            directory: launch.workingDirectory,
            sourceTimestamp: new Date(Date.parse(row.timestamp)).toISOString(),
            harvestedAt: new Date().toISOString(),
          };
          const pending = new Map(state.pending);
          pending.set(block.id, hint);
          if (
            pending.size <= 32 &&
            JSON.stringify([...pending.values()]).length <= 48 * 1024
          )
            state.pending = pending;
          else state.partial = true;
        }
      }
    } else if (
      row.type === "user" &&
      block?.type === "tool_result" &&
      validId(block.tool_use_id)
    ) {
      const hint = state.pending.get(block.tool_use_id);
      if (hint) {
        if (block.is_error === true) state.pending.delete(block.tool_use_id);
        else {
          const ready = { ...hint, ready: true };
          state.pending.set(block.tool_use_id, ready);
          if (!deferred.has(ready.id)) hints.push(ready);
        }
      }
    }
    state.block++;
    budget--;
  }
  return { state, hints };
}

/** Private extraction cursor, never a wire response or a transcript copy. */
export function encodeHarnessHistory(
  state: HarnessHistoryState,
  rows: ClaudeHistoryRows,
  native: NativeSessionRef,
  version?: HarnessHistoryVersion,
): string {
  let index = state.block ? state.entry : state.entry - 1;
  const last = index;
  while (
    index >= 0 &&
    last - index < 256 &&
    !validId(object(claudeHistoryRow(rows, index))?.uuid)
  )
    index--;
  const uuid = object(claudeHistoryRow(rows, index))?.uuid;
  let origin: { index: number; uuid: string } | null = null;
  for (let i = 0; i < Math.min(rows.length, 256); i++) {
    const id = object(claudeHistoryRow(rows, i))?.uuid;
    if (validId(id)) {
      origin = { index: i, uuid: id };
      break;
    }
  }
  return JSON.stringify({
    origin,
    v: 1,
    native,
    version,
    entry: state.entry,
    block: state.block,
    partial: state.partial === true,
    retryAfter: state.retryAfter,
    pending: [...state.pending.values()],
    anchor: validId(uuid) ? { index, uuid } : null,
  });
}
function decodeHarnessHistory(
  cursor: string | undefined,
  rows: ClaudeHistoryRows,
  native: NativeSessionRef,
  committed: number,
  version?: HarnessHistoryVersion,
): HarnessHistoryState {
  if (!cursor) return emptyHarnessHistory();
  if (cursor.length > 65536) throw Error("Invalid historical harness cursor");
  const p = object(JSON.parse(cursor)),
    scope = object(p?.native),
    anchor = object(p?.anchor);
  if (
    p?.v !== 1 ||
    !Number.isSafeInteger(p.entry) ||
    (p.entry as number) < 0 ||
    !Number.isSafeInteger(p.block) ||
    (p.block as number) < 0 ||
    !Array.isArray(p.pending) ||
    p.pending.length > 32 ||
    typeof p.partial !== "boolean"
  )
    throw Error("Invalid historical harness cursor");
  const oldVersion = object(p.version);
  if (
    version &&
    (!oldVersion ||
      oldVersion.id !== version.id ||
      typeof oldVersion.size !== "number" ||
      !Number.isSafeInteger(oldVersion.size) ||
      oldVersion.size < 0 ||
      version.size < oldVersion.size ||
      ((oldVersion.mtime !== version.mtime ||
        oldVersion.ctime !== version.ctime) &&
        version.size === oldVersion.size))
  )
    return emptyHarnessHistory();
  if (
    scope?.family !== native.family ||
    scope.storageScope !== native.storageScope ||
    scope.id !== native.id ||
    (p.entry as number) > committed ||
    ((p.block as number) > 0 && (p.entry as number) >= committed)
  )
    return emptyHarnessHistory();
  if ((p.entry as number) > 0 || (p.block as number) > 0) {
    const expected =
      (p.block as number) > 0 ? (p.entry as number) : (p.entry as number) - 1;
    if (
      !anchor ||
      typeof anchor.index !== "number" ||
      !Number.isSafeInteger(anchor.index) ||
      anchor.index < 0 ||
      anchor.index > expected ||
      expected - anchor.index >= 256 ||
      !validId(anchor.uuid) ||
      object(claudeHistoryRow(rows, anchor.index))?.uuid !== anchor.uuid
    )
      return emptyHarnessHistory();
  }
  const pending = new Map<string, HistoricalHarnessHint>();
  let expired = false;
  for (const raw of p.pending) {
    const h = object(raw);
    if (
      !h ||
      !validId(h.id) ||
      typeof h.targetId !== "string" ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(h.targetId) ||
      typeof h.directory !== "string" ||
      !isAbsolute(h.directory) ||
      h.directory.length > 4096 ||
      typeof h.sourceTimestamp !== "string" ||
      h.sourceTimestamp.length > 32 ||
      !Number.isFinite(Date.parse(h.sourceTimestamp)) ||
      (h.ready !== undefined && typeof h.ready !== "boolean") ||
      pending.has(h.id) ||
      typeof h.harvestedAt !== "string" ||
      h.harvestedAt.length > 32 ||
      !Number.isFinite(Date.parse(h.harvestedAt))
    )
      throw Error("Invalid historical harness cursor");
    if (
      Date.now() - Date.parse(h.harvestedAt as string) >=
      24 * 60 * 60 * 1000
    ) {
      expired = true;
      continue;
    }
    pending.set(h.id, {
      id: h.id,
      targetId: h.targetId,
      directory: h.directory,
      sourceTimestamp: h.sourceTimestamp,
      harvestedAt: h.harvestedAt as string,
      ...(h.ready === true ? { ready: true } : {}),
    });
  }
  if (JSON.stringify([...pending.values()]).length > 48 * 1024)
    throw Error("Invalid historical harness cursor");
  return {
    entry: p.entry as number,
    block: p.block as number,
    partial: p.partial || expired,
    needsCommit: expired,
    retryAfter:
      typeof p.retryAfter === "number" && Number.isFinite(p.retryAfter)
        ? p.retryAfter
        : undefined,
    pending,
  };
}

export function restoreHarnessHistory(
  ...args: Parameters<typeof decodeHarnessHistory>
): HarnessHistoryState {
  try {
    return decodeHarnessHistory(...args);
  } catch {
    return { ...emptyHarnessHistory(), needsCommit: true };
  } // Derived cursor only; accepted facts are independent.
}

/** An earlier completed read must not rewind a later snapshot of the same file. */
export function isOlderHarnessHistory(
  cursor: string | undefined,
  rows: ClaudeHistoryRows,
  native: NativeSessionRef,
  version: HarnessHistoryVersion | undefined,
): boolean {
  if (!cursor || !version || cursor.length > 65536) return false;
  try {
    const p = object(JSON.parse(cursor)),
      old = object(p?.version),
      scope = object(p?.native),
      origin = object(p?.origin);
    return (
      !!p &&
      p.v === 1 &&
      scope?.family === native.family &&
      scope.storageScope === native.storageScope &&
      scope.id === native.id &&
      old?.id === version.id &&
      typeof old.size === "number" &&
      version.size < old.size &&
      typeof old.mtime === "number" &&
      version.mtime <= old.mtime &&
      (version.ctime === undefined ||
        (typeof old.ctime === "number" && version.ctime <= old.ctime)) &&
      !!origin &&
      typeof origin.index === "number" &&
      Number.isSafeInteger(origin.index) &&
      origin.index >= 0 &&
      origin.index < 256 &&
      validId(origin.uuid) &&
      object(claudeHistoryRow(rows, origin.index))?.uuid === origin.uuid
    );
  } catch {
    return false;
  }
}
