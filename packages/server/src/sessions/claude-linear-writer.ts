import {
  getLogicalParentUuid,
  getMessageContent,
  type ClaudeSessionEntry,
} from "@yep-anywhere/shared";
import { createTaskListAugmenter } from "../augments/task-list-augments.js";
import { convertClaudeMessage } from "./claude-message-conversion.js";
import { condenseClaudeSummary } from "./claude-index-summary.js";
import {
  ClaudeSourceIndex,
  type ClaudeDurableState,
  type ClaudeStoredRecord,
  type ClaudeToolFact,
  type ClaudeTaskCheckpoint,
  type ClaudeRecordRef,
  type ClaudeVisibleRef,
} from "./claude-source-index.js";
import type { TranscriptLineInfo } from "./transcript-ingestion.js";

export interface ClaudeAppendRow {
  raw: ClaudeSessionEntry;
  offset: number;
  info: TranscriptLineInfo;
}
export interface ClaudeQueuedFact {
  record: ClaudeRecordRef;
  position?: number;
}
export interface ClaudeWriterFacts {
  node(uuid: string): { active: boolean } | undefined;
  tool(id: string): ClaudeToolFact | undefined;
  tasks(): ClaudeTaskCheckpoint | undefined;
  byOffset(offset: number): ClaudeVisibleRef | undefined;
  at(position: number): ClaudeVisibleRef | undefined;
  suffix(position: number): ClaudeVisibleRef[];
  firstQueue(afterOffset: number): ClaudeQueuedFact | undefined;
}
export interface ClaudeLinearUpdate {
  state: ClaudeDurableState;
  records: ClaudeStoredRecord[];
  visible: ClaudeVisibleRef[];
  nodes: Map<string, boolean>;
  tools: Map<string, ClaudeToolFact>;
  orphans: Map<string, boolean>;
  tasks?: ClaudeTaskCheckpoint;
  queued: ClaudeQueuedFact[];
  dequeued: number[];
  replaceFrom?: number;
}
function blocks(raw: ClaudeSessionEntry) {
  const c = getMessageContent(raw);
  return Array.isArray(c)
    ? c.filter(
        (b): b is Record<string, unknown> => !!b && typeof b === "object",
      )
    : [];
}
const uuid = (raw: ClaudeSessionEntry) => (raw as { uuid?: string }).uuid;
const stamp = (raw: ClaudeSessionEntry) =>
  (raw as { timestamp?: string }).timestamp ?? "";
/** Read affected point facts, stage a pure delta, reuse the original decoder/reducers. */
export function extendClaudeLinear(
  state: ClaudeDurableState,
  sourceCount: number,
  rows: ClaudeAppendRow[],
  facts: ClaudeWriterFacts,
): ClaudeLinearUpdate | null {
  if (!state.continuation || state.requiresCompleteProjection) return null;
  // Closed recent rewinds cannot claim newly appended physical rows. Old open
  // timestamp-bounded records still go through the complete metadata selector.
  if (state.rewindRecords.length && !state.continuation.rewindsClosed)
    return null;
  const next = {
      ...state,
      metrics: { ...state.metrics },
      continuation: { ...state.continuation },
    },
    continuation = next.continuation;
  const nodes = new Map<string, boolean>(),
    tools = new Map<string, ClaudeToolFact>(),
    orphans = new Map<string, boolean>();
  const node = (id: string) =>
    nodes.has(id) ? { active: nodes.get(id)! } : facts.node(id);
  const tool = (id: string) => tools.get(id) ?? facts.tool(id);
  const taskIds = new Set<string>(),
    results = new Set<string>();
  const incomingResults = new Set<string>();
  for (const { raw } of rows)
    for (const b of blocks(raw)) {
      if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
        incomingResults.add(b.tool_use_id);
        if (tool(b.tool_use_id)?.task) taskIds.add(b.tool_use_id);
      }
      if (
        b.type === "tool_use" &&
        typeof b.id === "string" &&
        tool(b.id)?.hasResult
      )
        results.add(b.id);
    }
  const decoder = ClaudeSourceIndex.appendDecoder(next, taskIds, results);
  const visible = new Map<number, ClaudeVisibleRef>(),
    records: ClaudeStoredRecord[] = [];
  const queued: ClaudeQueuedFact[] = [],
    dequeued: number[] = [];
  let queueCursor = -1,
    replaceFrom: number | undefined;
  let tasks: ReturnType<typeof createTaskListAugmenter> | undefined,
    taskRefs: Map<string, number> | undefined;
  let unsupportedTask = false;
  const pendingHolders = new Map<number, ClaudeVisibleRef>();
  const taskReducer = () => {
    if (tasks) return tasks;
    const checkpoint = facts.tasks();
    if (!checkpoint) return undefined;
    taskRefs = new Map(checkpoint.refs);
    tasks = createTaskListAugmenter(checkpoint.state, (id, input) => {
      if (!incomingResults.has(id)) return input;
      const offset = taskRefs!.get(id);
      const ref =
        offset === undefined
          ? undefined
          : (pendingHolders.get(offset) ??
            [...visible.values()].find((r) => r.record?.offset === offset) ??
            facts.byOffset(offset));
      const block =
        ref?.projected &&
        blocks(ref.projected as unknown as ClaudeSessionEntry).find(
          (b) => b.type === "tool_use" && b.id === id,
        );
      if (!ref || !block?.input || typeof block.input !== "object") {
        unsupportedTask = true;
        return input;
      }
      pendingHolders.set(offset!, ref);
      visible.set(ref.position, ref);
      return block.input as Record<string, unknown>;
    });
    return tasks;
  };
  let nodeCount = next.metrics.nodeCount;
  for (const candidate of rows) {
    const raw = candidate.raw,
      id = uuid(raw),
      bs = blocks(raw);
    if (!candidate.info.committed) return null;
    const known = id ? node(id) : undefined;
    if (
      !id &&
      raw.type !== "progress" &&
      bs.some((b) => b.type === "tool_use" || b.type === "tool_result")
    )
      return null;
    if (
      raw.type !== "progress" &&
      id &&
      (known ||
        ((raw as { parentUuid?: string | null }).parentUuid ??
          getLogicalParentUuid(raw)) !== continuation.tip ||
        stamp(raw) < continuation.tipTimestamp)
    )
      return null;
    for (const b of bs)
      if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
        const owner = tool(b.tool_use_id)?.owner;
        if (owner && !node(owner)?.active) return null;
      }
    decoder.capture(raw, candidate.offset, candidate.info);
    const stored = decoder.sourceRecords(decoder.rows.length - 1).next().value!;
    stored.ordinal = sourceCount + records.length;
    if (stored.node) stored.node.lineIndex = stored.ordinal;
    records.push(stored);
    if (decoder.durableUnsupported()) return null;
    if (id) {
      if (raw.type !== "progress") {
        nodes.set(id, true);
        nodeCount++;
      } else nodes.set(id, known?.active ?? false);
    }
    for (const b of bs) {
      if (b.type === "tool_use" && typeof b.id === "string" && id) {
        const old = tool(b.id);
        tools.set(b.id, {
          tool: b.id,
          owner: id,
          hasResult: old?.hasResult ?? false,
          task:
            !!old?.task || b.name === "TaskCreate" || b.name === "TaskUpdate",
        });
      }
      if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
        const old = tool(b.tool_use_id);
        tools.set(b.tool_use_id, {
          ...old,
          tool: b.tool_use_id,
          hasResult: true,
          task: old?.task ?? false,
        });
      }
    }
    if (raw.type === "progress") continue;
    if (!id) {
      if (raw.type !== "queue-operation") continue;
      if (raw.operation === "enqueue") {
        const c = (stored.record.raw as { content?: unknown }).content;
        if (
          (typeof c === "string" && c.trim()) ||
          (Array.isArray(c) && c.length)
        )
          queued.push({ record: stored.record, position: next.visibleCount });
        continue;
      }
      if (raw.operation !== "remove" && raw.operation !== "dequeue") continue;
      const persistent = facts.firstQueue(queueCursor),
        pending =
          persistent ?? queued.find((q) => !dequeued.includes(q.record.offset));
      if (!pending) continue;
      queueCursor = pending.record.offset;
      dequeued.push(pending.record.offset);
      if (raw.operation === "dequeue") continue;
      if (
        pending.position === undefined ||
        next.visibleCount - pending.position > 256
      )
        return null;
      const position = pending.position;
      const suffix = facts.suffix(position);
      // Point rows changed earlier in this append supersede their saved form.
      const shifted = new Map(
        suffix.map((r) => [r.position, visible.get(r.position) ?? r]),
      );
      for (const [p, r] of visible) if (p >= position) shifted.set(p, r);
      const previous = visible.get(position - 1) ?? facts.at(position - 1);
      for (const ref of [...shifted.values()].sort(
        (a, b) => b.position - a.position,
      )) {
        visible.delete(ref.position);
        ref.position++;
        if (pending.record.realTurn) {
          ref.turnPrefix++;
          if (ref.turn !== undefined) ref.turn++;
        }
        visible.set(ref.position, ref);
      }
      const delivered = {
        ...pending.record.raw,
        queueDeliveredAt: stamp(raw),
      } as unknown as ClaudeSessionEntry;
      const ref: ClaudeVisibleRef = {
        raw: delivered,
        record: pending.record,
        position,
        turnPrefix:
          (previous?.turnPrefix ?? 0) + (pending.record.realTurn ? 1 : 0),
        projected: convertClaudeMessage(delivered, position, new Set()),
      };
      if (pending.record.realTurn) {
        ref.turn = ref.turnPrefix;
        continuation.realTurns++;
      }
      if (pending.record.paginationTurn) next.userTurns++;
      visible.set(position, ref);
      next.visibleCount++;
      replaceFrom = Math.min(replaceFrom ?? position, position);
      for (const pending of queued)
        if (pending.position !== undefined && pending.position >= position)
          pending.position++;
      // More than one already-persisted pending delivery may require shifting its
      // saved insertion position. Rebuild rather than infer that position.
      if (
        (persistent && facts.firstQueue(queueCursor)) ||
        queued.some((q) => !dequeued.includes(q.record.offset))
      )
        return null;
      continue;
    }
    continuation.tip = id;
    continuation.tipTimestamp = stamp(raw);
    if (stored.node)
      next.witnesses = condenseClaudeSummary([...next.witnesses, stored.node]);
    if (raw.type === "user" || raw.type === "assistant") next.branchCount++;
    for (const b of bs) {
      if (b.type === "tool_use" && typeof b.id === "string")
        orphans.set(b.id, !tool(b.id)?.hasResult);
      if (b.type === "tool_result" && typeof b.tool_use_id === "string")
        orphans.set(b.tool_use_id, false);
    }
    const position = next.visibleCount++;
    const ref: ClaudeVisibleRef = {
      raw: stored.record.raw,
      record: stored.record,
      position,
      turnPrefix: continuation.realTurns,
    };
    if (stored.record.realTurn) ref.turn = ++continuation.realTurns;
    ref.turnPrefix = continuation.realTurns;
    if (stored.record.paginationTurn) next.userTurns++;
    if (
      raw.type === "system" &&
      (raw as { subtype?: string }).subtype === "compact_boundary"
    )
      next.compactionCount++;
    ref.projected = structuredClone(
      convertClaudeMessage(stored.record.raw, position, new Set()),
    );
    const touchesTask = bs.some(
      (b) =>
        (b.type === "tool_use" &&
          (b.name === "TaskCreate" || b.name === "TaskUpdate")) ||
        (b.type === "tool_result" && tool(String(b.tool_use_id))?.task),
    );
    if (touchesTask) {
      const reducer = taskReducer();
      if (!reducer || unsupportedTask) return null;
      reducer.processMessage(ref.projected as Record<string, unknown>);
      for (const b of bs) {
        if (
          b.type === "tool_use" &&
          (b.name === "TaskCreate" || b.name === "TaskUpdate") &&
          typeof b.id === "string"
        )
          taskRefs!.set(b.id, stored.record.offset);
        if (b.type === "tool_result" && typeof b.tool_use_id === "string")
          taskRefs!.delete(b.tool_use_id);
      }
    }
    visible.set(position, ref);
    for (const holder of pendingHolders.values())
      visible.set(holder.position, holder);
  }
  const parsed = decoder.summaryState;
  next.firstTimestamp = parsed.firstTimestamp;
  next.firstUserTitleCaptured = parsed.firstUserTitleCaptured;
  next.firstUserTitleContent = parsed.firstUserTitleContent;
  next.metrics = { ...parsed.metrics, nodeCount };
  next.estimatedBytes += decoder.estimatedBytes;
  return {
    state: next,
    records,
    visible: [...visible.values()].sort((a, b) => a.position - b.position),
    nodes,
    tools,
    orphans,
    ...(tasks
      ? { tasks: { state: tasks.checkpoint(), refs: [...taskRefs!] } }
      : {}),
    queued: queued.filter((q) => !dequeued.includes(q.record.offset)),
    dequeued,
    replaceFrom,
  };
}
