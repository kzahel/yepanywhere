import type { ContentBlock, Message } from "../supervisor/types.js";

export const TASK_SNAPSHOT_FIELD = "_taskSnapshot";

export type TaskListStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export interface TaskListSnapshotItem {
  id: string;
  subject: string;
  status: TaskListStatus;
  description?: string;
  activeForm?: string;
  createdToolUseId?: string;
  updatedToolUseId?: string;
  missingCreate?: boolean;
}

export interface TaskListSnapshot {
  version: 1;
  tasks: TaskListSnapshotItem[];
  currentTaskId?: string;
  sourceToolUseId: string;
  unresolvedTaskIds?: string[];
}

interface PendingTaskCreate {
  kind: "create";
  toolUseId: string;
  input: Record<string, unknown>;
  subject?: string;
  description?: string;
  activeForm?: string;
}

interface PendingTaskUpdate {
  kind: "update";
  toolUseId: string;
  input: Record<string, unknown>;
  taskId?: string;
  status?: TaskListStatus;
}

type PendingTaskEvent = PendingTaskCreate | PendingTaskUpdate;

interface TaskState {
  id: string;
  subject: string;
  status: TaskListStatus;
  order: number;
  description?: string;
  activeForm?: string;
  createdToolUseId?: string;
  updatedToolUseId?: string;
  missingCreate?: boolean;
}

interface SnapshotHolder {
  toolUseId: string;
  deleteSnapshot(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringField(
  value: Record<string, unknown>,
  ...fields: string[]
): string | undefined {
  for (const field of fields) {
    const raw = value[field];
    if (typeof raw !== "string") {
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

function normalizeTaskId(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const trimmed = String(value).trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/^task\s*/i, "").replace(/^#/, "");
}

function normalizeTaskStatus(value: unknown): TaskListStatus | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  switch (normalized) {
    case "todo":
    case "open":
    case "pending":
      return "pending";
    case "active":
    case "running":
    case "started":
    case "in_progress":
      return "in_progress";
    case "complete":
    case "completed":
    case "done":
      return "completed";
    case "fail":
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
    case "stopped":
      return "cancelled";
    default:
      return "unknown";
  }
}

function contentBlocks(message: Record<string, unknown>): ContentBlock[] {
  const nested = message.message;
  const nestedContent = isRecord(nested) ? nested.content : undefined;
  const content = nestedContent ?? message.content;
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

function messageRole(message: Record<string, unknown>): string | undefined {
  const nested = message.message;
  const nestedRole = isRecord(nested) ? nested.role : undefined;
  return (
    (typeof nestedRole === "string" ? nestedRole : undefined) ??
    (typeof message.role === "string" ? message.role : undefined) ??
    (typeof message.type === "string" ? message.type : undefined)
  );
}

function parseStructuredContent(content: unknown): unknown {
  if (typeof content !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

function resultPayload(
  message: Record<string, unknown>,
  block: ContentBlock,
): unknown {
  return (
    message.toolUseResult ??
    message.tool_use_result ??
    parseStructuredContent(block.content) ??
    block.content
  );
}

function nestedStatusChangeTo(result: unknown): unknown {
  if (!isRecord(result) || !isRecord(result.statusChange)) {
    return undefined;
  }
  return result.statusChange.to;
}

function resultTaskId(result: unknown): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }
  return (
    normalizeTaskId(result.taskId) ??
    normalizeTaskId(result.task_id) ??
    normalizeTaskId(result.id)
  );
}

function parseCreatedTaskId(
  result: unknown,
  content: unknown,
): string | undefined {
  const structuredId = resultTaskId(result);
  if (structuredId) {
    return structuredId;
  }

  const text =
    typeof result === "string"
      ? result
      : typeof content === "string"
        ? content
        : undefined;
  if (!text) {
    return undefined;
  }

  const match = text.match(/\bTask\s+#?([A-Za-z0-9_-]+)\s+created\b/i);
  return normalizeTaskId(match?.[1]);
}

function parseSubjectFromCreateResult(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = value.match(/\bcreated successfully:\s*(.+)$/i);
  const subject = match?.[1]?.trim();
  return subject && subject.length > 0 ? subject : undefined;
}

function makeSnapshot(
  tasks: Map<string, TaskState>,
  sourceToolUseId: string,
  currentTaskId?: string,
): TaskListSnapshot {
  const items = Array.from(tasks.values())
    .sort((left, right) => left.order - right.order)
    .map((task) => ({
      id: task.id,
      subject: task.subject,
      status: task.status,
      ...(task.description ? { description: task.description } : {}),
      ...(task.activeForm ? { activeForm: task.activeForm } : {}),
      ...(task.createdToolUseId
        ? { createdToolUseId: task.createdToolUseId }
        : {}),
      ...(task.updatedToolUseId
        ? { updatedToolUseId: task.updatedToolUseId }
        : {}),
      ...(task.missingCreate ? { missingCreate: true } : {}),
    }));
  const unresolvedTaskIds = items
    .filter((task) => task.missingCreate)
    .map((task) => task.id);

  return {
    version: 1,
    tasks: items,
    sourceToolUseId,
    ...(currentTaskId ? { currentTaskId } : {}),
    ...(unresolvedTaskIds.length > 0 ? { unresolvedTaskIds } : {}),
  };
}

function attachSnapshotToInput(
  input: Record<string, unknown>,
  snapshot: TaskListSnapshot,
): void {
  input[TASK_SNAPSHOT_FIELD] = snapshot;
}

function attachSnapshotToResult(
  message: Record<string, unknown>,
  block: ContentBlock,
  snapshot: TaskListSnapshot,
): void {
  block[TASK_SNAPSHOT_FIELD] = snapshot;

  const camel = message.toolUseResult;
  if (isRecord(camel)) {
    camel[TASK_SNAPSHOT_FIELD] = snapshot;
  } else if (camel !== undefined) {
    message.toolUseResult = {
      content: camel,
      [TASK_SNAPSHOT_FIELD]: snapshot,
    };
  } else {
    message.toolUseResult = {
      ...(typeof block.content === "string" ? { content: block.content } : {}),
      [TASK_SNAPSHOT_FIELD]: snapshot,
    };
  }

  const snake = message.tool_use_result;
  if (isRecord(snake)) {
    snake[TASK_SNAPSHOT_FIELD] = snapshot;
  }
}

function deleteSnapshot(record: Record<string, unknown>): void {
  delete record[TASK_SNAPSHOT_FIELD];
}

function collectSnapshotHolders(messages: Message[]): SnapshotHolder[] {
  const holders: SnapshotHolder[] = [];
  for (const message of messages) {
    const record = message as Record<string, unknown>;
    for (const block of contentBlocks(record)) {
      if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        isRecord(block.input) &&
        block.input[TASK_SNAPSHOT_FIELD]
      ) {
        holders.push({
          toolUseId: block.id,
          deleteSnapshot: () =>
            deleteSnapshot(block.input as Record<string, unknown>),
        });
      }

      if (
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string" &&
        block[TASK_SNAPSHOT_FIELD]
      ) {
        holders.push({
          toolUseId: block.tool_use_id,
          deleteSnapshot: () =>
            deleteSnapshot(block as Record<string, unknown>),
        });
      }
    }

    const structured = record.toolUseResult ?? record.tool_use_result;
    if (isRecord(structured) && structured[TASK_SNAPSHOT_FIELD]) {
      const toolUseId = contentBlocks(record).find(
        (block) => block.type === "tool_result" && block.tool_use_id,
      )?.tool_use_id;
      if (typeof toolUseId === "string") {
        holders.push({
          toolUseId,
          deleteSnapshot: () => deleteSnapshot(structured),
        });
      }
    }
  }
  return holders;
}

export interface TaskListCheckpoint {
  version: 1;
  tasks: Array<[string, TaskState]>;
  pending: Array<[string, PendingTaskEvent]>;
  nextOrder: number;
}
export interface TaskListAugmenter {
  checkpoint(): TaskListCheckpoint;
  processMessage(message: Record<string, unknown>): void;
}

export function createTaskListAugmenter(
  checkpoint?: TaskListCheckpoint,
  pendingInput?: (
    id: string,
    input: Record<string, unknown>,
  ) => Record<string, unknown>,
): TaskListAugmenter {
  const processedMessages = new WeakSet<Record<string, unknown>>();
  const restored = checkpoint && structuredClone(checkpoint);
  const pendingEvents = new Map<string, PendingTaskEvent>(
    restored?.pending.map(([id, event]) => [
      id,
      { ...event, input: pendingInput?.(id, event.input) ?? event.input },
    ]),
  );
  const tasks = new Map<string, TaskState>(restored?.tasks);
  let nextOrder = restored?.nextOrder ?? 0;

  function upsertPlaceholder(taskId: string): TaskState {
    const existing = tasks.get(taskId);
    if (existing) {
      return existing;
    }

    const task: TaskState = {
      id: taskId,
      subject: `Task #${taskId}`,
      status: "unknown",
      order: nextOrder,
      missingCreate: true,
    };
    nextOrder += 1;
    tasks.set(taskId, task);
    return task;
  }

  function handleToolUse(block: ContentBlock): void {
    if (!block.id || !block.name || !isRecord(block.input)) {
      return;
    }

    if (block.name === "TaskCreate") {
      pendingEvents.set(block.id, {
        kind: "create",
        toolUseId: block.id,
        input: block.input,
        subject: stringField(block.input, "subject", "title", "content"),
        description: stringField(block.input, "description"),
        activeForm: stringField(block.input, "activeForm", "active_form"),
      });
      return;
    }

    if (block.name === "TaskUpdate") {
      pendingEvents.set(block.id, {
        kind: "update",
        toolUseId: block.id,
        input: block.input,
        taskId: normalizeTaskId(
          block.input.taskId ?? block.input.task_id ?? block.input.id,
        ),
        status: normalizeTaskStatus(block.input.status),
      });
    }
  }

  function handleTaskCreate(
    event: PendingTaskCreate,
    message: Record<string, unknown>,
    block: ContentBlock,
  ): void {
    const payload = resultPayload(message, block);
    const taskId = parseCreatedTaskId(payload, block.content);
    if (!taskId) {
      return;
    }

    const fallbackSubject =
      parseSubjectFromCreateResult(block.content) ??
      (typeof payload === "string"
        ? parseSubjectFromCreateResult(payload)
        : undefined);
    const existing = tasks.get(taskId);
    tasks.set(taskId, {
      id: taskId,
      subject: event.subject ?? fallbackSubject ?? `Task #${taskId}`,
      status: "pending",
      order: existing?.order ?? nextOrder,
      description: event.description,
      activeForm: event.activeForm,
      createdToolUseId: event.toolUseId,
    });
    if (!existing) {
      nextOrder += 1;
    }

    const snapshot = makeSnapshot(tasks, event.toolUseId, taskId);
    attachSnapshotToInput(event.input, snapshot);
    attachSnapshotToResult(message, block, snapshot);
  }

  function handleTaskUpdate(
    event: PendingTaskUpdate,
    message: Record<string, unknown>,
    block: ContentBlock,
  ): void {
    const payload = resultPayload(message, block);
    if (isRecord(payload) && payload.success === false) {
      return;
    }

    const taskId = event.taskId ?? resultTaskId(payload);
    if (!taskId) {
      return;
    }

    const status =
      event.status ??
      normalizeTaskStatus(nestedStatusChangeTo(payload)) ??
      normalizeTaskStatus(isRecord(payload) ? payload.status : undefined) ??
      "unknown";
    const task = upsertPlaceholder(taskId);
    task.status = status;
    task.updatedToolUseId = event.toolUseId;

    const snapshot = makeSnapshot(tasks, event.toolUseId, taskId);
    attachSnapshotToInput(event.input, snapshot);
    attachSnapshotToResult(message, block, snapshot);
  }

  function handleToolResult(
    message: Record<string, unknown>,
    block: ContentBlock,
  ): void {
    const toolUseId = block.tool_use_id;
    if (!toolUseId) {
      return;
    }
    const event = pendingEvents.get(toolUseId);
    if (!event) {
      return;
    }

    if (event.kind === "create") {
      handleTaskCreate(event, message, block);
    } else {
      handleTaskUpdate(event, message, block);
    }
    pendingEvents.delete(toolUseId);
  }

  return {
    checkpoint() {
      return structuredClone({
        version: 1 as const,
        tasks: [...tasks],
        pending: [...pendingEvents],
        nextOrder,
      });
    },
    processMessage(message) {
      if (processedMessages.has(message)) {
        return;
      }
      processedMessages.add(message);

      const role = messageRole(message);
      for (const block of contentBlocks(message)) {
        if (role === "assistant" && block.type === "tool_use") {
          handleToolUse(block);
          continue;
        }
        if (role === "user" && block.type === "tool_result") {
          handleToolResult(message, block);
        }
      }
    },
  };
}

export function augmentTaskListSnapshots(messages: Message[]): void {
  const augmenter = createTaskListAugmenter();
  for (const message of messages) {
    augmenter.processMessage(message as Record<string, unknown>);
  }
}

/**
 * Build task snapshots without mutating cache-shared normalized messages.
 *
 * Task state still folds over the complete transcript, but only messages that
 * can receive a task snapshot are cloned. The response window is detached as
 * a whole later, after pagination has selected it.
 */
export function projectTaskListSnapshots(messages: Message[]): Message[] {
  const taskToolUseIds = new Set<string>();
  for (const message of messages) {
    for (const block of contentBlocks(message as Record<string, unknown>)) {
      if (
        block.type === "tool_use" &&
        (block.name === "TaskCreate" || block.name === "TaskUpdate") &&
        typeof block.id === "string"
      ) {
        taskToolUseIds.add(block.id);
      }
    }
  }
  if (taskToolUseIds.size === 0) return messages;

  const projected = messages.map((message) => {
    const touchesTask = contentBlocks(message as Record<string, unknown>).some(
      (block) =>
        (block.type === "tool_use" &&
          typeof block.id === "string" &&
          taskToolUseIds.has(block.id)) ||
        (block.type === "tool_result" &&
          typeof block.tool_use_id === "string" &&
          taskToolUseIds.has(block.tool_use_id)),
    );
    return touchesTask ? structuredClone(message) : message;
  });
  augmentTaskListSnapshots(projected);
  return projected;
}

export function pruneTaskListSnapshotsToLatest(messages: Message[]): void {
  const holders = collectSnapshotHolders(messages);
  const latestToolUseId = holders.at(-1)?.toolUseId;
  if (!latestToolUseId) {
    return;
  }

  for (const holder of holders) {
    if (holder.toolUseId !== latestToolUseId) {
      holder.deleteSnapshot();
    }
  }
}
