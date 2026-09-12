import type { RenderItem, ToolCallItem } from "./items.js";
import {
  extractDetachedCellId,
  getCommandResultMeta,
  parseShellToolOutput,
} from "./shellToolOutput.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function extractCommandFromInput(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  if (typeof input.command === "string" && input.command.trim().length > 0) {
    return input.command;
  }
  if (typeof input.cmd === "string" && input.cmd.trim().length > 0) {
    return input.cmd;
  }
  return undefined;
}

function coerceSessionId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

function extractSessionIdFromWriteStdinInput(
  input: unknown,
): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  return coerceSessionId(input.session_id ?? input.sessionId);
}

function extractSessionIdFromToolResult(
  item: ToolCallItem,
): string | undefined {
  const structured = item.toolResult?.structured;
  if (isRecord(structured)) {
    const fromStructured = coerceSessionId(
      structured.session_id ?? structured.sessionId,
    );
    if (fromStructured) {
      return fromStructured;
    }
  }

  const raw = item.toolResult?.content ?? "";
  const text = typeof raw === "string" ? raw : "";
  // Accept provider envelopes and the SESSION_ID=N convention code-mode
  // scripts print precisely so the session can be reconnected later.
  const match = text.match(
    /(?:^|\n)\s*(?:Process\s+running\s+with\s+session\s+ID|session[_\s]?id|session)\s*[:=]?\s*(\d+)\b/i,
  );
  if (!match?.[1]) {
    return undefined;
  }
  return match[1];
}

function extractCellIdFromWriteStdinInput(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  return coerceSessionId(input.cell_id ?? input.cellId);
}

/** A code-mode script that outlives its yield window detaches into a cell
 * ("Script running with cell ID N"); a later `wait` call polls that cell. */
function extractCellIdFromToolResult(item: ToolCallItem): string | undefined {
  const raw = item.toolResult?.content ?? "";
  return extractDetachedCellId(typeof raw === "string" ? raw : "");
}

function withLinkedCommand(input: unknown, command: string): unknown {
  if (!isRecord(input)) {
    return input;
  }
  if (typeof input.linked_command === "string" && input.linked_command.trim()) {
    return input;
  }
  return { ...input, linked_command: command };
}

function withLinkedFilePath(input: unknown, filePath: string): unknown {
  if (!isRecord(input)) {
    return input;
  }
  if (
    typeof input.linked_file_path === "string" &&
    input.linked_file_path.trim()
  ) {
    return input;
  }
  return { ...input, linked_file_path: filePath };
}

function withLinkedToolName(input: unknown, toolName: string): unknown {
  if (!isRecord(input)) {
    return input;
  }
  if (
    typeof input.linked_tool_name === "string" &&
    input.linked_tool_name.trim()
  ) {
    return input;
  }
  return { ...input, linked_tool_name: toolName };
}

function isCommandSessionToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized === "bash" ||
    normalized === "exec_command" ||
    normalized === "shell_command"
  );
}

function isFileSessionToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized === "read" || normalized === "write" || normalized === "edit"
  );
}

function extractFilePathFromToolInput(input: unknown): string | undefined {
  if (!isRecord(input) || typeof input.file_path !== "string") {
    return undefined;
  }
  const filePath = input.file_path.trim();
  return filePath.length > 0 ? filePath : undefined;
}

const BACKGROUND_LAUNCH_ID_RE =
  /(?:Command|Process)\s+running\s+(?:in\s+background\s+with\s+ID|with\s+session\s+ID)\s*:?\s*([\w-]+)/i;
const PROCESS_EXITED_RE = /(?:^|\n)\s*Process exited with code \d+/i;
const BACKGROUND_ENDED_STATUS_RE =
  /^(completed|failed|killed|stopped|success|error|done)/i;

function getRecordField(value: unknown, field: string): unknown {
  return isRecord(value) ? value[field] : undefined;
}

/** Polls that report a launched task's outcome, across provider spellings. */
function isTaskPollToolName(toolName: string): boolean {
  return (
    toolName === "taskoutput" ||
    toolName === "task_output" ||
    toolName === "get_command_or_subagent_output"
  );
}

/** Calls that terminate a launched task, across provider spellings. */
function isKillToolName(toolName: string): boolean {
  return (
    toolName === "killshell" ||
    toolName === "kill_shell" ||
    toolName === "kill_command_or_subagent"
  );
}

/** A polled task in any of these states has stopped running. */
function isTaskEndedStatus(status: unknown): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

function toolResultContent(item: ToolCallItem): string {
  const raw = item.toolResult?.content;
  return typeof raw === "string" ? raw : "";
}

/**
 * Mark completed Bash calls whose command was backgrounded so the row can
 * keep a present-tense header ("Running") until completion evidence appears
 * later in the transcript: a task-notification for the call, a
 * BashOutput/TaskOutput poll reporting completion, a KillShell, or a Codex
 * unified-exec/wait poll whose chunk carries an exit code.
 */
export function annotateBackgroundCommands(items: RenderItem[]): RenderItem[] {
  const endedKeys = new Set<string>();
  const addEnded = (...keys: Array<string | false | undefined>) => {
    for (const key of keys) {
      if (key) endedKeys.add(key);
    }
  };

  for (const item of items) {
    if (item.type === "task_notification") {
      if (item.status && BACKGROUND_ENDED_STATUS_RE.test(item.status)) {
        addEnded(item.taskId, item.toolUseId && `tool:${item.toolUseId}`);
      }
      continue;
    }
    if (item.type !== "tool_call") {
      continue;
    }
    const toolName = item.toolName.toLowerCase();
    const input = item.toolInput;
    const structured = item.toolResult?.structured;

    if (toolName === "bashoutput" || toolName === "bash_output") {
      const id = coerceSessionId(
        getRecordField(structured, "shellId") ??
          getRecordField(input, "bash_id"),
      );
      const status = getRecordField(structured, "status");
      const exited = typeof getRecordField(structured, "exitCode") === "number";
      if (id && (exited || status === "completed" || status === "failed")) {
        addEnded(id);
      }
    } else if (isTaskPollToolName(toolName)) {
      // One poll can cover several tasks (Grok waits on a whole set), so end
      // every task the result reports, not just the first.
      const tasks = getRecordField(structured, "tasks");
      const reported = Array.isArray(tasks)
        ? tasks
        : [getRecordField(structured, "task")];
      for (const task of reported) {
        if (!isTaskEndedStatus(getRecordField(task, "status"))) continue;
        addEnded(
          coerceSessionId(
            getRecordField(task, "task_id") ?? getRecordField(input, "task_id"),
          ),
        );
      }
    } else if (isKillToolName(toolName)) {
      addEnded(
        coerceSessionId(
          getRecordField(structured, "shell_id") ??
            getRecordField(structured, "task_id") ??
            getRecordField(input, "shell_id") ??
            getRecordField(input, "task_id"),
        ),
      );
    } else if (
      toolName === "writestdin" ||
      toolName === "write_stdin" ||
      toolName === "wait"
    ) {
      const finished =
        typeof getRecordField(structured, "exit_code") === "number" ||
        PROCESS_EXITED_RE.test(toolResultContent(item));
      if (finished) {
        const sessionId = extractSessionIdFromWriteStdinInput(input);
        const cellId = extractCellIdFromWriteStdinInput(input);
        addEnded(
          sessionId && `session:${sessionId}`,
          cellId && `cell:${cellId}`,
        );
      }
    }
  }

  return items.map((item) => {
    if (
      item.type !== "tool_call" ||
      item.status !== "complete" ||
      !isCommandSessionToolName(item.toolName)
    ) {
      return item;
    }

    const content = toolResultContent(item);
    const keys: string[] = [`tool:${item.id}`];
    let backgrounded =
      getRecordField(item.toolInput, "run_in_background") === true;

    const structuredTaskId = coerceSessionId(
      getRecordField(item.toolResult?.structured, "backgroundTaskId"),
    );
    if (structuredTaskId) {
      backgrounded = true;
      keys.push(structuredTaskId, `session:${structuredTaskId}`);
    }
    const launchMatch = content.match(BACKGROUND_LAUNCH_ID_RE);
    if (launchMatch?.[1]) {
      backgrounded = true;
      keys.push(launchMatch[1]);
      if (/session\s+ID/i.test(launchMatch[0])) {
        keys.push(`session:${launchMatch[1]}`);
      }
    }
    const detachedCell = extractDetachedCellId(content);
    if (detachedCell) {
      backgrounded = true;
      keys.push(`cell:${detachedCell}`);
    }

    if (!backgrounded) {
      return item;
    }
    const ended = keys.some((key) => endedKeys.has(key));
    const toolInput = isRecord(item.toolInput) ? item.toolInput : {};
    return {
      ...item,
      toolInput: {
        ...toolInput,
        _backgroundTaskStatus: ended ? "completed" : "running",
      },
    };
  });
}

export function enrichWriteStdinWithCommand(items: RenderItem[]): RenderItem[] {
  const sessionToMetadata = new Map<
    string,
    { command?: string; filePath?: string; toolName?: string }
  >();
  const cellToMetadata = new Map<
    string,
    { command?: string; filePath?: string; toolName?: string }
  >();

  return items.map((item) => {
    if (item.type !== "tool_call") {
      return item;
    }

    if (
      isCommandSessionToolName(item.toolName) ||
      isFileSessionToolName(item.toolName)
    ) {
      const sessionId = extractSessionIdFromToolResult(item);
      const cellId = extractCellIdFromToolResult(item);
      if (!sessionId && !cellId) {
        return item;
      }

      const command = isCommandSessionToolName(item.toolName)
        ? extractCommandFromInput(item.toolInput)
        : undefined;
      const filePath = isFileSessionToolName(item.toolName)
        ? extractFilePathFromToolInput(item.toolInput)
        : undefined;

      for (const [id, metadataById] of [
        [sessionId, sessionToMetadata],
        [cellId, cellToMetadata],
      ] as const) {
        if (!id) continue;
        const existing = metadataById.get(id) ?? {};
        metadataById.set(id, {
          command: command ?? existing.command,
          filePath: filePath ?? existing.filePath,
          toolName: item.toolName ?? existing.toolName,
        });
      }
      return item;
    }

    const toolName = item.toolName.toLowerCase();
    if (
      toolName !== "writestdin" &&
      toolName !== "write_stdin" &&
      toolName !== "wait"
    ) {
      return item;
    }

    const sessionId = extractSessionIdFromWriteStdinInput(item.toolInput);
    const cellId = extractCellIdFromWriteStdinInput(item.toolInput);
    const metadata =
      (sessionId ? sessionToMetadata.get(sessionId) : undefined) ??
      (cellId ? cellToMetadata.get(cellId) : undefined);

    // A poll can itself detach into a new cell; carry the origin metadata
    // forward so a later wait on that cell still links to the command.
    const detachedCellId = extractCellIdFromToolResult(item);
    if (detachedCellId && metadata) {
      const existing = cellToMetadata.get(detachedCellId) ?? {};
      cellToMetadata.set(detachedCellId, {
        command: metadata.command ?? existing.command,
        filePath: metadata.filePath ?? existing.filePath,
        toolName: metadata.toolName ?? existing.toolName,
      });
    }

    // A wait's collected script output may reveal the shell session the
    // script started (e.g. a printed SESSION_ID=N line); bridge the origin
    // metadata to that session so later polls of it link to the command.
    const declaredSessionId = extractSessionIdFromToolResult(item);
    if (declaredSessionId && metadata) {
      const existing = sessionToMetadata.get(declaredSessionId) ?? {};
      sessionToMetadata.set(declaredSessionId, {
        command: metadata.command ?? existing.command,
        filePath: metadata.filePath ?? existing.filePath,
        toolName: metadata.toolName ?? existing.toolName,
      });
    }

    if (!metadata) {
      return item;
    }

    let toolInput = item.toolInput;
    if (metadata.command) {
      toolInput = withLinkedCommand(toolInput, metadata.command);
    }
    if (metadata.filePath) {
      toolInput = withLinkedFilePath(toolInput, metadata.filePath);
    }
    if (metadata.toolName) {
      toolInput = withLinkedToolName(toolInput, metadata.toolName);
    }

    if (toolInput === item.toolInput) {
      return item;
    }

    return {
      ...item,
      toolInput,
    };
  });
}

function isShellPollToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized === "writestdin" ||
    normalized === "write_stdin" ||
    normalized === "wait"
  );
}

/**
 * One logical shell poll can span several transcript records: the poll's
 * script detaches into a cell ("Script running with cell ID N") and a later
 * `wait` on that cell collects the actual result — possibly detaching again
 * before it does. Rendering each record separately reads as a puzzling
 * "still running → cell N" row followed by an unlabeled result row, so fold
 * the chain into the originating poll: it keeps its input and linkage and
 * takes the final wait's result. A wait that never resolves in the loaded
 * transcript leaves the poll honestly "still running".
 *
 * Single scan plus a prebuilt cell-id index: cell ids restart within a
 * rollout, so a consumer takes the first unconsumed wait AFTER its own
 * position, never an earlier reuse.
 */
export function coalesceDetachedPollContinuations(
  items: RenderItem[],
): RenderItem[] {
  const waitIndicesByCell = new Map<string, number[]>();
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (item?.type !== "tool_call" || !isShellPollToolName(item.toolName)) {
      continue;
    }
    const cellId = extractCellIdFromWriteStdinInput(item.toolInput);
    if (!cellId) continue;
    const list = waitIndicesByCell.get(cellId);
    if (list) {
      list.push(index);
    } else {
      waitIndicesByCell.set(cellId, [index]);
    }
  }
  if (waitIndicesByCell.size === 0) {
    return items;
  }

  const consumed = new Set<number>();
  const takeNextWaitOnCell = (cellId: string, after: number): number => {
    const list = waitIndicesByCell.get(cellId);
    if (!list) return -1;
    for (const index of list) {
      if (index > after && !consumed.has(index)) return index;
    }
    return -1;
  };

  const result: RenderItem[] = [];
  for (let i = 0; i < items.length; i++) {
    if (consumed.has(i)) continue;
    let item = items[i];
    if (item === undefined) continue;

    if (item.type === "tool_call" && isShellPollToolName(item.toolName)) {
      let cellId = extractCellIdFromToolResult(item);
      let after = i;
      while (cellId) {
        const waitIndex = takeNextWaitOnCell(cellId, after);
        if (waitIndex < 0) break;
        const wait = items[waitIndex];
        if (wait?.type !== "tool_call") break;
        consumed.add(waitIndex);
        after = waitIndex;
        item = {
          ...item,
          status: wait.status,
          toolResult: wait.toolResult,
        };
        cellId =
          wait.toolResult !== undefined
            ? extractCellIdFromToolResult(wait)
            : undefined;
      }
    }
    result.push(item);
  }
  return result;
}

/**
 * Drop completed shell polls that carry no information a reader could act
 * on: a pure poll (no stdin chars) that produced no output, no error, no
 * exit code, and — after linkage enrichment — no associated command, file,
 * or origin tool. Such rows read as a bare "Shell — No output" with no
 * discoverable context. Pending polls stay visible as live activity, and a
 * poll with any linked context keeps its row.
 */
export function hideContextFreeEmptyShellPolls(
  items: RenderItem[],
): RenderItem[] {
  return items.filter((item) => {
    if (item.type !== "tool_call" || item.status !== "complete") {
      return true;
    }
    const toolName = item.toolName.toLowerCase();
    if (
      toolName !== "writestdin" &&
      toolName !== "write_stdin" &&
      toolName !== "wait"
    ) {
      return true;
    }
    if (item.toolResult?.isError) {
      return true;
    }

    const input = isRecord(item.toolInput) ? item.toolInput : {};
    const chars = typeof input.chars === "string" ? input.chars : "";
    const hasContext =
      chars.length > 0 ||
      [
        input.linked_command,
        input.linked_file_path,
        input.linked_tool_name,
      ].some((value) => typeof value === "string" && value.trim().length > 0);
    if (hasContext) {
      return true;
    }

    const content = item.toolResult?.content ?? "";
    const parsed = parseShellToolOutput(content);
    const exitCode =
      getCommandResultMeta(item.toolResult?.structured).exitCode ??
      parsed.exitCode;
    return parsed.output.trim().length > 0 || exitCode !== undefined;
  });
}
