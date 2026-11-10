import { isUserTurn as isPaginationUserTurn } from "./pagination.js";
import { open, stat } from "node:fs/promises";
import type {
  ClaudeSessionEntry,
  SessionRewindRecord,
} from "@yep-anywhere/shared";
import {
  getMessageContent,
  getLogicalParentUuid,
  detectScopedNestedHarnessLaunch,
} from "@yep-anywhere/shared";
import { isRealUserTurn } from "@yep-anywhere/shared/transcript/messageProjection";
import type { Message } from "../supervisor/types.js";
import {
  createTaskListAugmenter,
  type TaskListAugmenter,
} from "../augments/task-list-augments.js";
import { collectVisibleClaudeEntries } from "./claude-messages.js";
import { convertClaudeMessage } from "./claude-message-conversion.js";
import { buildDag } from "./dag.js";
import {
  addEntryToState,
  createParseState,
  cloneParseState,
  type ClaudeSummaryParseState,
  type CompactClaudeSummaryNode,
} from "./claude-summary.js";
import {
  condenseClaudeSummary,
  projectedClaudeSummary,
} from "./claude-index-summary.js";
import {
  isTranscriptPrefix,
  TranscriptAppendMismatchError,
  type TranscriptAppendFence,
  type TranscriptLineInfo,
} from "./transcript-ingestion.js";

export class ClaudeProjectionChangedError extends Error {}

const SOURCE = Symbol("claudeIndexedSource");
interface RecordRef {
  offset: number;
  length: number;
  raw: ClaudeSessionEntry;
  realTurn: boolean;
  paginationTurn: boolean;
}
type IndexedRow = ClaudeSessionEntry & { [SOURCE]?: RecordRef };
interface VisibleRef {
  raw: ClaudeSessionEntry;
  record?: RecordRef;
  position: number;
  turnPrefix: number;
  turn?: number;
  projected?: Message;
  projectionCharge?: number;
}
function id(row: ClaudeSessionEntry): string | undefined {
  return (row as { uuid?: string }).uuid;
}
function timestamp(row: ClaudeSessionEntry): string {
  return (row as { timestamp?: string }).timestamp ?? "";
}
function compact(row: ClaudeSessionEntry) {
  return (
    row.type === "system" &&
    (row as { subtype?: string }).subtype === "compact_boundary"
  );
}
function blocks(row: ClaudeSessionEntry): Record<string, unknown>[] {
  const content = getMessageContent(row);
  return Array.isArray(content)
    ? content.filter(
        (b): b is Record<string, unknown> => !!b && typeof b === "object",
      )
    : [];
}
/** Metadata/source offsets own history; decoded payload is retained only for the served window. */
export class ClaudeSourceIndex {
  rows: ClaudeSessionEntry[] = [];
  summaryState = createParseState();
  private provisional?: {
    raw: ClaudeSessionEntry;
    offset: number;
    info: TranscriptLineInfo;
  };
  estimatedBytes = 0;
  private projectionBytes = 0;
  private pendingTaskRefs = new Map<string, VisibleRef>();
  get retainedBytes() {
    return (
      this.estimatedBytes +
      this.projectionBytes +
      this.rewindBytes +
      (this.provisional?.info.byteLength ?? 0)
    );
  }
  private visible: VisibleRef[] = [];
  private boundaries: number[] = [];
  private groupStarts = new Map<string, VisibleRef>();
  private byId = new Map<string, VisibleRef>();
  private results = new Set<string>();
  private orphans = new Set<string>();
  private toolOwners = new Map<string, string>();
  private taskIds = new Set<string>();
  private activeIds = new Set<string>();
  private tip?: string;
  private tipTimestamp = "";
  private witnesses: CompactClaudeSummaryNode[] = [];
  private branchCount = 0;
  private turnCount = 0;
  private paginationTurns = 0;
  private rewindKey = "";
  private rewindBytes = 0;
  private dirty = true;
  private requiresCompleteProjection = false;
  private version = 0;
  private sourceGeneration = 0;
  private summaryProjection?: {
    generation: number;
    state: ClaudeSummaryParseState;
  };
  get generation() {
    return this.sourceGeneration;
  }
  private rewindRecords: readonly SessionRewindRecord[] = [];
  private tasks: TaskListAugmenter = createTaskListAugmenter();
  private decoded = new Map<
    RecordRef,
    { raw: ClaudeSessionEntry; message: Message }
  >();
  decodedBytes = 0;
  private deliveredQueues: Array<{ time: number; ref: VisibleRef }> = [];
  private pendingQueues: Array<{ record: RecordRef; position?: number }> = [];

  capture(
    raw: ClaudeSessionEntry,
    offset: number,
    info: TranscriptLineInfo,
  ): ClaudeSessionEntry {
    const record: RecordRef = {
      offset,
      length: info.byteLength,
      raw: raw,
      realTurn: isRealUserTurn(convertClaudeMessage(raw, 0, new Set())),
      paginationTurn: isPaginationUserTurn(
        convertClaudeMessage(raw, 0, new Set()),
      ),
    };
    const shape = raw as unknown as Record<string, unknown>;
    if (
      (shape.uuid != null && typeof shape.uuid !== "string") ||
      (shape.parentUuid != null && typeof shape.parentUuid !== "string") ||
      (shape.timestamp != null && typeof shape.timestamp !== "string")
    )
      this.requiresCompleteProjection = true;
    const reduced = this.skeleton(raw);
    record.raw = reduced;
    Object.defineProperty(reduced, SOURCE, { value: record, enumerable: true });
    if (info.committed) {
      this.provisional = undefined;
      this.commit(record, raw);
    } else this.provisional = { raw, offset, info };
    return reduced;
  }

  private skeleton(raw: ClaudeSessionEntry): ClaudeSessionEntry {
    const r = raw as unknown as Record<string, unknown>;
    const originalContent = getMessageContent(raw);
    const content = (Array.isArray(originalContent) ? originalContent : []).map(
      (value) => {
        if (!value || typeof value !== "object") return "";
        const b = value as Record<string, unknown>;
        if (b.type === "tool_use") {
          const task = b.name === "TaskCreate" || b.name === "TaskUpdate";
          if (task && typeof b.id === "string") {
            if (this.results.has(b.id)) this.requiresCompleteProjection = true;
            this.taskIds.add(b.id);
          }
          const input = b.input as Record<string, unknown> | undefined;
          const command = input?.command;
          const harness =
            b.name === "Bash" &&
            typeof command === "string" &&
            command.length <= 65536 &&
            input?.run_in_background !== true &&
            detectScopedNestedHarnessLaunch(command);
          return task
            ? structuredClone(b)
            : {
                type: b.type,
                id: b.id,
                name: b.name,
                ...(harness
                  ? {
                      input: {
                        command,
                        run_in_background: input?.run_in_background,
                      },
                    }
                  : {}),
              };
        }
        if (b.type === "tool_result")
          return this.taskIds.has(String(b.tool_use_id))
            ? structuredClone(b)
            : {
                type: b.type,
                tool_use_id: b.tool_use_id,
                is_error: b.is_error,
              };
        return { type: b.type };
      },
    );
    return {
      type: raw.type,
      ...Object.fromEntries(
        [
          "uuid",
          "parentUuid",
          "timestamp",
          "subtype",
          "logicalParentUuid",
          "isCompactSummary",
          "isMeta",
          "operation",
          "sessionId",
          "isSidechain",
          "isSynthetic",
          "isReplay",
          "parent_tool_use_id",
        ]
          .filter((k) => k in r)
          .map((k) => [k, r[k]]),
      ),
      ...(getLogicalParentUuid(raw)
        ? { logicalParentUuid: getLogicalParentUuid(raw) }
        : {}),
      ...(content.some((item) => {
        const b = item as Record<string, unknown>;
        return (
          b.type === "tool_result" && this.taskIds.has(String(b.tool_use_id))
        );
      })
        ? {
            toolUseResult: structuredClone(r.toolUseResult),
            tool_use_result: structuredClone(r.tool_use_result),
          }
        : {}),
      ...(raw.type === "queue-operation"
        ? {
            content:
              typeof r.content === "string"
                ? r.content.trim()
                  ? "queued"
                  : ""
                : Array.isArray(r.content) && r.content.length
                  ? ["queued"]
                  : [],
          }
        : {}),
      ...(raw.type === "user" || raw.type === "assistant"
        ? { message: { role: raw.type, content } }
        : {}),
    } as ClaudeSessionEntry;
  }
  private commit(record: RecordRef, raw: ClaudeSessionEntry) {
    this.version++;
    this.sourceGeneration++;
    const uuid = id(raw);
    const wasKnown = uuid
      ? this.summaryState.nodeMap.has(uuid) ||
        this.summaryState.progressUuids.has(uuid)
      : false;
    const hadTitle = this.summaryState.firstUserTitleCaptured;
    addEntryToState(this.summaryState, raw, this.rows.length);
    if (!hadTitle && this.summaryState.firstUserTitleCaptured) {
      const title = this.summaryState.firstUserTitleContent;
      if (title) {
        this.estimatedBytes += Buffer.byteLength(title);
        this.summaryState.firstUserTitleContent = Buffer.from(title).toString();
      }
    }
    const summaryNode = uuid ? this.summaryState.nodeMap.get(uuid) : undefined;
    if (summaryNode)
      for (const key of ["assistantExcerpt", "awaySummaryExcerpt"] as const) {
        const value = summaryNode[key];
        if (value) summaryNode[key] = Buffer.from(value).toString();
      }
    this.rows.push(record.raw);
    this.estimatedBytes +=
      Buffer.byteLength(JSON.stringify(record.raw)) +
      (uuid
        ? Buffer.byteLength(
            JSON.stringify(this.summaryState.nodeMap.get(uuid) ?? {}),
          )
        : 0) +
      384;
    for (const b of blocks(raw))
      if (b.type === "tool_use" && typeof b.id === "string" && uuid)
        this.toolOwners.set(b.id, uuid);
    for (const b of blocks(raw))
      if (b.type === "tool_result" && typeof b.tool_use_id === "string")
        this.results.add(b.tool_use_id);
    if (this.dirty) return;
    if (this.rewindKey !== "[]") {
      this.dirty = true;
      return;
    }
    if (raw.type === "progress") return;
    if (
      blocks(raw).some(
        (b) =>
          b.type === "tool_result" &&
          this.toolOwners.has(String(b.tool_use_id)) &&
          !this.activeIds.has(this.toolOwners.get(String(b.tool_use_id))!),
      )
    ) {
      this.dirty = true;
      return;
    }
    if (!uuid) {
      if (raw.type === "queue-operation") this.queue(record, raw);
      return;
    }
    const parent =
      (raw as { parentUuid?: string | null }).parentUuid ??
      getLogicalParentUuid(raw);
    if (wasKnown || parent !== this.tip || timestamp(raw) < this.tipTimestamp) {
      this.dirty = true;
      return;
    }
    this.tip = uuid;
    this.tipTimestamp = timestamp(raw);
    this.activeIds.add(uuid);
    const node = this.summaryState.nodeMap.get(uuid)!;
    this.witnesses = condenseClaudeSummary([...this.witnesses, node]);
    if (raw.type === "user" || raw.type === "assistant") this.branchCount++;
    for (const b of blocks(raw)) {
      if (
        b.type === "tool_use" &&
        typeof b.id === "string" &&
        !this.results.has(b.id)
      )
        this.orphans.add(b.id);
      if (b.type === "tool_result" && typeof b.tool_use_id === "string")
        this.orphans.delete(b.tool_use_id);
    }
    this.appendVisible(record.raw);
  }
  private appendVisible(raw: ClaudeSessionEntry) {
    const record = (raw as IndexedRow)[SOURCE];
    const ref: VisibleRef = {
      raw,
      record,
      position: this.visible.length,
      turnPrefix: this.turnCount,
    };
    if (record?.realTurn) ref.turn = ++this.turnCount;
    ref.turnPrefix = this.turnCount;
    if (
      record?.paginationTurn &&
      typeof (raw as { rewoundGroupId?: unknown }).rewoundGroupId !== "string"
    )
      this.paginationTurns++;
    this.visible.push(ref);
    if (
      typeof (raw as { queueDeliveredAt?: unknown }).queueDeliveredAt ===
      "string"
    )
      this.deliveredQueues.push({
        time: Date.parse(
          (raw as unknown as { queueDeliveredAt: string }).queueDeliveredAt,
        ),
        ref,
      });
    const group = (raw as { rewoundGroupId?: string }).rewoundGroupId;
    if (group && !this.groupStarts.has(group)) this.groupStarts.set(group, ref);
    this.remember(ref);
    const normalized = structuredClone(
      convertClaudeMessage(raw, ref.position, new Set()),
    );
    ref.projected = normalized;
    const affected = blocks(raw)
      .filter((b) => b.type === "tool_result")
      .map((b) => this.pendingTaskRefs.get(String(b.tool_use_id)))
      .filter((r): r is VisibleRef => !!r);
    this.tasks.processMessage(normalized as Record<string, unknown>);
    const charge = (r: VisibleRef) => {
      const next = Buffer.byteLength(JSON.stringify(r.projected));
      this.projectionBytes += next - (r.projectionCharge ?? 0);
      r.projectionCharge = next;
    };
    charge(ref);
    for (const r of affected) charge(r);
    for (const b of blocks(raw)) {
      if (
        b.type === "tool_use" &&
        (b.name === "TaskCreate" || b.name === "TaskUpdate")
      )
        this.pendingTaskRefs.set(String(b.id), ref);
      if (b.type === "tool_result")
        this.pendingTaskRefs.delete(String(b.tool_use_id));
    }
  }
  private remember(ref: VisibleRef) {
    const uuid = id(ref.raw);
    if (uuid) this.byId.set(uuid, ref);
    else if (ref.raw.type === "queue-operation")
      this.byId.set(
        `queue-operation-${ref.position}-${timestamp(ref.raw)}`,
        ref,
      );
    if (compact(ref.raw)) this.boundaries.push(ref.position);
  }
  private queue(record: RecordRef, raw: ClaudeSessionEntry) {
    if (raw.type !== "queue-operation") return;
    if (raw.operation === "enqueue") {
      const content = (record.raw as { content?: unknown }).content;
      if (
        (typeof content === "string" && content.trim()) ||
        (Array.isArray(content) && content.length)
      )
        this.pendingQueues.push({ record, position: this.visible.length });
    } else if (
      (raw.operation === "remove" || raw.operation === "dequeue") &&
      this.pendingQueues.length
    ) {
      const pending = this.pendingQueues.shift()!;
      if (raw.operation === "dequeue") return;
      const position = pending.position;
      if (position === undefined || this.visible.length - position > 256) {
        this.dirty = true;
        return;
      }
      const queued = {
        ...pending.record.raw,
        queueDeliveredAt: timestamp(raw),
      } as unknown as ClaudeSessionEntry;
      const ref: VisibleRef = {
        raw: queued,
        record: pending.record,
        position,
        turnPrefix:
          (this.visible[position - 1]?.turnPrefix ?? 0) +
          (pending.record.realTurn ? 1 : 0),
        projected: convertClaudeMessage(queued, position, new Set()),
      };
      if (pending.record.paginationTurn) this.paginationTurns++;
      if (pending.record.realTurn) {
        ref.turn = ref.turnPrefix;
        this.turnCount++;
      }
      for (let i = position; i < this.visible.length; i++) {
        const old = this.visible[i]!;
        if (old.raw.type === "queue-operation")
          this.byId.delete(
            `queue-operation-${old.position}-${timestamp(old.raw)}`,
          );
        old.position++;
        if (pending.record.realTurn) {
          old.turnPrefix++;
          if (old.turn !== undefined) old.turn++;
        }
        if (old.raw.type === "queue-operation")
          this.byId.set(
            `queue-operation-${old.position}-${timestamp(old.raw)}`,
            old,
          );
      }
      this.visible.splice(position, 0, ref);
      this.remember(ref);
      let lo = 0,
        hi = this.boundaries.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (this.boundaries[mid]! < position) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < this.boundaries.length; i++) this.boundaries[i]!++;
      for (const queued of this.pendingQueues)
        if (queued.position !== undefined && queued.position >= position)
          queued.position++;
      const time = Date.parse(timestamp(raw));
      if (Number.isFinite(time)) {
        let at = this.deliveredQueues.length;
        while (at > 0 && this.deliveredQueues[at - 1]!.time > time) at--;
        this.deliveredQueues.splice(at, 0, { time, ref });
      }
      this.projectionBytes += Buffer.byteLength(JSON.stringify(ref.projected));
    }
  }
  prepare(records: readonly SessionRewindRecord[] = this.rewindRecords) {
    const key = JSON.stringify(records);
    if (!this.dirty && this.rewindKey === key) return;
    this.rewindKey = key;
    this.rewindBytes = Buffer.byteLength(key) * 2 + records.length * 256;
    this.rewindRecords = records;
    this.version++;
    const dag = buildDag(this.rows);
    this.tip = dag.tip?.uuid;
    this.tipTimestamp = dag.tip ? timestamp(dag.tip.raw) : "";
    this.activeIds = dag.activeBranchUuids;
    const branch = dag.activeBranch
      .map((n) => this.summaryState.nodeMap.get(n.uuid))
      .filter((n): n is CompactClaudeSummaryNode => !!n);
    this.branchCount = branch.filter(
      (n) => n.type === "user" || n.type === "assistant",
    ).length;
    this.witnesses = condenseClaudeSummary(branch);
    this.deliveredQueues = [];
    this.visible = [];
    this.boundaries = [];
    this.byId.clear();
    this.groupStarts.clear();
    this.turnCount = 0;
    this.paginationTurns = 0;
    this.tasks = createTaskListAugmenter();
    this.projectionBytes = 0;
    this.pendingTaskRefs.clear();
    const projected = collectVisibleClaudeEntries(this.rows, {
      rewindRecords: records,
    });
    this.orphans = projected.orphanedToolUses;
    for (const raw of projected.entries) this.appendVisible(raw);
    this.decoded.clear();
    this.decodedBytes = 0;
    this.pendingQueues = [];
    for (const row of this.rows) {
      if (row.type !== "queue-operation") continue;
      const record = (row as IndexedRow)[SOURCE]!;
      if (row.operation === "enqueue") {
        const c = (row as { content?: unknown }).content;
        if (
          (typeof c === "string" && c.trim()) ||
          (Array.isArray(c) && c.length)
        )
          this.pendingQueues.push({ record });
      } else if (row.operation === "remove" || row.operation === "dequeue")
        this.pendingQueues.shift();
    }
    this.deliveredQueues = this.deliveredQueues
      .filter((q) => Number.isFinite(q.time))
      .sort((a, b) => a.time - b.time);
    this.dirty = false;
  }
  clearProvisional() {
    this.provisional = undefined;
  }
  view(): ClaudeSourceIndex {
    if (!this.provisional) {
      this.prepare();
      return this;
    }
    const copy = new ClaudeSourceIndex();
    copy.rows = this.rows.slice();
    copy.summaryState = cloneParseState(this.summaryState);
    copy.taskIds = new Set(this.taskIds);
    copy.results = new Set(this.results);
    copy.toolOwners = new Map(this.toolOwners);
    copy.estimatedBytes = this.estimatedBytes;
    copy.requiresCompleteProjection = this.requiresCompleteProjection;
    copy.capture(this.provisional.raw, this.provisional.offset, {
      ...this.provisional.info,
      committed: true,
    });
    copy.prepare();
    return copy;
  }
  summary(): ClaudeSummaryParseState {
    if (this.summaryProjection?.generation === this.sourceGeneration)
      return this.summaryProjection.state;
    const state = projectedClaudeSummary(
      this.summaryState,
      this.witnesses,
      this.branchCount,
    );
    this.summaryProjection = { generation: this.sourceGeneration, state };
    return state;
  }

  /** Select by the globally projected order, never by physical last-marker alone. */
  async window(
    filePath: string,
    request: {
      compactions: number;
      generation: number;
      afterMessageId?: string;
      beforeMessageId?: string;
      rewindRecords?: readonly SessionRewindRecord[];
      maxBytes?: number;
      fence?: TranscriptAppendFence;
    },
  ) {
    const {
      compactions: count,
      generation,
      afterMessageId: after,
      beforeMessageId: before,
      rewindRecords: records = [],
      maxBytes = 192 * 1024 ** 2,
      fence,
    } = request;
    if (generation !== this.sourceGeneration)
      throw new ClaudeProjectionChangedError(
        "Claude source generation changed before window selection",
      );
    if (this.requiresCompleteProjection) return null;
    this.prepare(records);
    const version = this.version;
    const end = before
      ? (this.byId.get(before)?.position ?? 0)
      : this.visible.length;
    let boundaryEnd = this.boundaries.length;
    if (before) {
      let lo = 0,
        hi = boundaryEnd;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (this.boundaries[mid]! < end) lo = mid + 1;
        else hi = mid;
      }
      boundaryEnd = lo;
    }
    let start =
      boundaryEnd >= count ? this.boundaries[boundaryEnd - count]! : 0;
    let omitted = boundaryEnd >= count;
    if (!after) {
      let group = (
        this.visible[start]?.raw as { rewoundGroupId?: string } | undefined
      )?.rewoundGroupId;
      const seen = new Set<string>();
      while (group && !seen.has(group)) {
        seen.add(group);
        const first = this.groupStarts.get(group);
        if (!first) break;
        start = Math.min(start, first.position);
        group = (first.raw as { rewoundParentGroupId?: string })
          .rewoundParentGroupId;
      }
    }
    if (after) {
      const anchor = this.byId.get(after);
      if (anchor) {
        start = anchor.position;
        omitted = start > 0;
      } else {
        start = 0;
        omitted = false;
      }
    }
    const totals = {
      messages: this.visible.length,
      compactions: boundaryEnd,
      userTurns: this.paginationTurns,
    };
    let selected = this.visible.slice(start, end);
    if (after) {
      const anchor = this.byId.get(after);
      if (anchor) {
        const at = Date.parse(timestamp(anchor.raw));
        let lo = 0,
          hi = this.deliveredQueues.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (this.deliveredQueues[mid]!.time <= at) lo = mid + 1;
          else hi = mid;
        }
        const late = Number.isFinite(at)
          ? this.deliveredQueues
              .slice(lo)
              .filter((q) => q.ref.position < anchor.position)
              .map((q) => q.ref)
              .sort((a, b) => a.position - b.position)
          : [];
        selected = [...late, ...selected];
      }
    }
    if (
      this.retainedBytes +
        selected.reduce((n, r) => n + (r.record?.length ?? 0), 0) >
      maxBytes
    )
      return null;
    const handle = await open(filePath, "r").catch((error) => {
      if (fence && (error as NodeJS.ErrnoException).code === "ENOENT")
        throw new TranscriptAppendMismatchError(
          "Claude source disappeared before hydration",
          { cause: error },
        );
      throw error;
    });
    const read = async (_path: string, offset: number, length: number) => {
      const bytes = Buffer.allocUnsafe(length);
      let filled = 0;
      while (filled < length) {
        const result = await handle.read(
          bytes,
          filled,
          length - filled,
          offset + filled,
        );
        if (!result.bytesRead) break;
        filled += result.bytesRead;
      }
      return bytes.subarray(0, filled);
    };
    const valid = async () =>
      !fence || isTranscriptPrefix(read, filePath, fence, await stat(filePath));
    const messages: Message[] = [],
      entries: ClaudeSessionEntry[] = [];
    const keep = new Set(
      selected.map((ref) => ref.record).filter((r): r is RecordRef => !!r),
    );
    for (const key of this.decoded.keys())
      if (!keep.has(key)) {
        this.decodedBytes -= key.length;
        this.decoded.delete(key);
      }
    try {
      if (!(await valid()))
        throw new TranscriptAppendMismatchError(
          "Claude source changed before hydration",
        );
      for (const ref of selected) {
        let raw = ref.raw;
        let message: Message;
        if (ref.record) {
          keep.add(ref.record);
          const known = this.decoded.get(ref.record);
          if (known) {
            message = known.message;
            raw = known.raw;
          } else {
            const bytes = await read(
              filePath,
              ref.record.offset,
              ref.record.length,
            );
            if (bytes.length !== ref.record.length)
              throw new Error("Claude source changed during indexed hydration");
            raw = JSON.parse(
              bytes.toString("utf8").trim(),
            ) as ClaudeSessionEntry;
            message = convertClaudeMessage(raw, ref.position, new Set());
            if (!this.decoded.has(ref.record))
              this.decodedBytes += ref.record.length;
            this.decoded.set(ref.record, { raw, message });
          }
        } else message = convertClaudeMessage(raw, ref.position, new Set());
        const overlay = ref.raw as unknown as Record<string, unknown>;
        const orphaned = blocks(ref.raw)
          .filter(
            (b) => b.type === "tool_use" && this.orphans.has(String(b.id)),
          )
          .map((b) => String(b.id));
        message = structuredClone(message);
        delete message.orphanedToolUseIds;
        if (orphaned.length) message.orphanedToolUseIds = orphaned;
        if (ref.turn !== undefined) message.turnIndex = ref.turn;
        for (const key of [
          "queueDeliveredAt",
          "rewoundGroupId",
          "rewoundParentGroupId",
        ])
          if (key in overlay)
            (message as Record<string, unknown>)[key] = overlay[key];
        // Queue IDs depend on their position in the complete visible sequence.
        if (ref.raw.type === "queue-operation")
          message.id = `queue-operation-${ref.position}-${timestamp(ref.raw)}`;
        if (ref.projected) {
          const targetBlocks = blocks(message as unknown as ClaudeSessionEntry);
          const originalBlocks = blocks(
            ref.projected as unknown as ClaudeSessionEntry,
          );
          for (let i = 0; i < originalBlocks.length; i++) {
            const source = originalBlocks[i]!,
              target = targetBlocks[i];
            if (!target) continue;
            if (source._taskSnapshot)
              target._taskSnapshot = structuredClone(source._taskSnapshot);
            if (
              source.type === "tool_use" &&
              source.input &&
              typeof source.input === "object" &&
              (source.input as Record<string, unknown>)._taskSnapshot &&
              target.input &&
              typeof target.input === "object"
            ) {
              target.input = {
                ...(target.input as object),
                _taskSnapshot: structuredClone(
                  (source.input as Record<string, unknown>)._taskSnapshot,
                ),
              };
            }
          }
          for (const field of ["toolUseResult", "tool_use_result"]) {
            const source = (ref.projected as Record<string, unknown>)[field];
            if (
              source &&
              typeof source === "object" &&
              (source as Record<string, unknown>)._taskSnapshot
            )
              (message as Record<string, unknown>)[field] =
                structuredClone(source);
          }
        }
        messages.push(message);
        entries.push(raw);
      }
      if (!(await valid()))
        throw new TranscriptAppendMismatchError(
          "Claude source changed during hydration",
        );
      if (this.version !== version)
        throw new ClaudeProjectionChangedError(
          "Claude projection changed during hydration",
        );
    } catch (error) {
      if (fence && !(await valid().catch(() => false)))
        throw new TranscriptAppendMismatchError(
          "Claude source changed during hydration",
          { cause: error },
        );
      throw error;
    } finally {
      await handle.close();
    }
    for (const key of this.decoded.keys())
      if (!keep.has(key)) {
        this.decodedBytes -= key.length;
        this.decoded.delete(key);
      }
    return {
      messages,
      entries,
      omitted,
      startByte: selected[0]?.record?.offset ?? 0,
      end,
      compactBoundaries: boundaryEnd,
      totals,
    };
  }
}
