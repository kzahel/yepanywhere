import type { ToolDisplayAction } from "@yep-anywhere/shared";
import {
  type ToolResultMediaCandidate,
  sanitizeInlineImageData,
  sanitizeInlineImageText,
} from "../media/inlineImageData.js";
import {
  createCodexCodeModeGroupInput,
  extractCodexCodeModeCalls,
  extractCodexCodeModeTextOutput,
} from "./codeModeExec.js";
import {
  analyzeCodexCommand,
  type CodexReadShellInfo,
  stripOuterQuotes,
  toToolDisplayActions,
  unwrapCodexShellLauncherCommand,
} from "./displayActions.js";
import { parseCodexWebRunOutput } from "./webRun.js";

export type { CodexReadShellInfo } from "./displayActions.js";

export const CODEX_TOOL_NAME_ALIASES: Record<string, string> = {
  shell_command: "Bash",
  exec_command: "Bash",
  write_stdin: "WriteStdin",
  // A detached code-mode script cell is polled with `wait`; it shares the
  // shell-session presentation ("waiting for output") with stdin polls.
  wait: "WriteStdin",
  update_plan: "UpdatePlan",
  apply_patch: "Edit",
  view_image: "ViewImage",
  web_search_call: "WebSearch",
  search_query: "WebSearch",
  // Code-mode flattening of the namespaced `web.run` browsing tool.
  web__run: "Web",
};

export interface CodexWriteShellInfo {
  filePath: string;
  content: string;
}

export interface CodexToolCallContext {
  toolName: string;
  input: unknown;
  /** Present only for a code-mode call with a known owning turn. */
  codeModeTurnId?: string;
  /** Null means multiple native executions made the association ambiguous. */
  commandExecution?: {
    itemId: string;
    exitCode?: number;
    status: string;
  } | null;
  readShellInfo?: CodexReadShellInfo;
  writeShellInfo?: CodexWriteShellInfo;
  patchApplyResult?: {
    stderr?: string;
    stdout?: string;
    success: boolean;
  };
}

export interface NormalizedCodexToolInvocation {
  toolName: string;
  input: unknown;
  displayActions?: ToolDisplayAction[];
  readShellInfo?: CodexReadShellInfo;
  writeShellInfo?: CodexWriteShellInfo;
}

export interface NormalizedCodexToolOutput {
  content: string;
  structured?: unknown;
  isError: boolean;
  mediaCandidates?: ToolResultMediaCandidate[];
}

interface NormalizedCodexToolOutputWithExitCode
  extends NormalizedCodexToolOutput {
  exitCode?: number;
}

export function parseCodexToolArguments(argumentsText?: string): unknown {
  if (!argumentsText) {
    return {};
  }
  try {
    return JSON.parse(argumentsText);
  } catch {
    return { raw: argumentsText };
  }
}

export function canonicalizeCodexToolName(name: string): string {
  return (
    CODEX_TOOL_NAME_ALIASES[name] ??
    CODEX_TOOL_NAME_ALIASES[name.toLowerCase()] ??
    name
  );
}

export function normalizeCodexToolInvocation(
  toolName: string,
  input: unknown,
): NormalizedCodexToolInvocation {
  if (toolName !== "Bash") {
    return { toolName, input };
  }

  let normalizedInput: unknown = input;
  if (typeof input === "string" && input.trim()) {
    normalizedInput = { command: input };
  } else if (isRecord(input)) {
    const normalized = { ...input };
    if (
      typeof normalized.command !== "string" &&
      typeof normalized.cmd === "string"
    ) {
      normalized.command = normalized.cmd;
    }
    normalizedInput = normalized;
  }

  const command = extractBashCommand(normalizedInput);
  if (!command) {
    return { toolName: "Bash", input: normalizedInput };
  }
  const normalizedCommand = unwrapCodexShellLauncherCommand(command);
  const workingDirectory = isRecord(normalizedInput)
    ? (getStringField(normalizedInput, "workdir") ??
      getStringField(normalizedInput, "cwd"))
    : undefined;
  const commandAnalysis = analyzeCodexCommand(command, workingDirectory);
  const displayActions = commandAnalysis
    ? toToolDisplayActions(commandAnalysis.actions)
    : undefined;
  if (commandAnalysis?.actions.length === 1) {
    const action = commandAnalysis.actions[0];
    if (action?.kind === "read") {
      const readShellInfo: CodexReadShellInfo = {
        filePath: action.filePath,
        ...(action.startLine !== undefined
          ? { startLine: action.startLine }
          : {}),
        ...(action.endLine !== undefined ? { endLine: action.endLine } : {}),
        stripLineNumbers: action.stripLineNumbers,
      };
      return {
        toolName: "Read",
        input: createReadToolInput(readShellInfo),
        displayActions,
        readShellInfo,
      };
    }
    if (action?.kind === "search") {
      return {
        toolName: "Grep",
        input: {
          pattern: action.query,
          output_mode: "content",
          ...(action.path ? { path: action.path } : {}),
        },
        displayActions,
      };
    }
  }

  const writeShellInfo = parseHeredocWriteShellCommand(normalizedCommand);
  if (writeShellInfo) {
    return {
      toolName: "Write",
      input: createWriteToolInput(writeShellInfo),
      writeShellInfo,
    };
  }

  return {
    toolName: "Bash",
    input: normalizedInput,
    ...(displayActions ? { displayActions } : {}),
  };
}

export function normalizeCodexCustomToolInvocation(
  rawToolName: string,
  rawInput: unknown,
): NormalizedCodexToolInvocation {
  const codeModeCalls =
    rawToolName === "exec" ? extractCodexCodeModeCalls(rawInput) : [];
  if (codeModeCalls.length === 1) {
    const nestedCall = codeModeCalls[0];
    if (nestedCall) {
      return normalizeCodexToolInvocation(
        canonicalizeCodexToolName(nestedCall.toolName),
        nestedCall.input,
      );
    }
  }
  if (codeModeCalls.length > 1 && typeof rawInput === "string") {
    const normalizedCalls = codeModeCalls.map((call) =>
      normalizeCodexToolInvocation(
        canonicalizeCodexToolName(call.toolName),
        call.input,
      ),
    );
    const displayActions = normalizedCalls.every(
      (call) => call.displayActions && call.displayActions.length > 0,
    )
      ? normalizedCalls.flatMap((call) => call.displayActions ?? [])
      : undefined;
    return {
      toolName: "Exec",
      input: createCodexCodeModeGroupInput(rawInput, codeModeCalls),
      ...(displayActions ? { displayActions } : {}),
    };
  }

  const canonicalToolName = canonicalizeCodexToolName(rawToolName);
  const normalizedInput =
    canonicalToolName === "Edit" && typeof rawInput === "string"
      ? { _rawPatch: rawInput }
      : rawInput;
  return normalizeCodexToolInvocation(canonicalToolName, normalizedInput);
}

export function normalizeCodexToolOutputWithContext(
  output: unknown,
  context?: CodexToolCallContext,
): NormalizedCodexToolOutput {
  const normalized = normalizeCodexToolOutput(output);
  let content = normalized.content;
  let structured = normalized.structured;
  let isError = normalized.isError;
  const exitCode = normalized.exitCode ?? extractExitCodeFromText(content);
  const sessionId = extractSessionIdFromText(content);
  const backgroundTaskId = extractCodexBackgroundTaskId(content);
  const interrupted = isCodexInterruptedToolOutput(content);

  if (
    context?.toolName === "UpdatePlan" &&
    !isError &&
    extractCodexShellOutputContent(content).trim() === "{}"
  ) {
    // Code-mode update_plan returns only an empty nested-tool result. The
    // checklist itself lives in the recovered tool input, so normalize the
    // empty provider acknowledgement to the canonical renderer contract.
    content = "Plan updated";
    structured = { message: content };
  } else if (context?.toolName === "Grep") {
    const grepContent = extractCodexShellOutputContent(content);
    const grepResult = normalizeRipgrepOutput(
      grepContent,
      getGrepPattern(context.input),
    );
    const isNoMatchesResult = exitCode === 1 && grepResult.numFiles === 0;

    if (!isError || isNoMatchesResult) {
      isError = false;
      structured = sessionId
        ? { ...grepResult, session_id: sessionId }
        : grepResult;
      content = grepContent;
    }
  } else if (context?.toolName === "Read" && context.readShellInfo) {
    if (!isError) {
      const readContent = extractCodexShellOutputContent(content);
      const readResult = normalizeReadOutput(
        readContent,
        context.readShellInfo,
      );
      structured = sessionId
        ? { ...readResult, session_id: sessionId }
        : readResult;
      content = readContent;
    }
  } else if (context?.toolName === "Write" && context.writeShellInfo) {
    if (!isError) {
      const writeResult = normalizeWriteOutput(context.writeShellInfo);
      structured = sessionId
        ? { ...writeResult, session_id: sessionId }
        : writeResult;
    }
  } else if (context?.toolName === "Bash") {
    let bashContent = extractCodexShellOutputContent(content);
    let bashExitCode = exitCode;
    const chunk = parseCodexUnifiedExecChunkOutput(bashContent);
    if (chunk) {
      bashContent = chunk.output;
      if (chunk.exitCode !== undefined) {
        bashExitCode = chunk.exitCode;
        isError = chunk.exitCode !== 0;
      }
    }
    // A uniquely matched native execution is stronger evidence than the
    // outer script's success or anything the script happened to print.
    if (context.commandExecution) {
      bashExitCode = context.commandExecution.exitCode;
      isError =
        context.commandExecution.status === "failed" ||
        (bashExitCode !== undefined && bashExitCode !== 0);
    }
    structured = createBashToolResult(
      interrupted ? "" : bashContent,
      backgroundTaskId,
      interrupted,
      // Carry a recoverable exit code so reloaded (function_call_output-only)
      // Bash results match the live-stream structured result. Equivalence is a
      // contract — see topics/stream-persisted-render-parity.md.
      bashExitCode,
      // Command runtime, from the chunk record or the shell envelope (spec:
      // topics/provider-output-contract.md § Command execution metadata).
      chunk?.durationSeconds ?? extractWallTimeSecondsFromText(content),
    );
  } else if (context?.toolName === "WriteStdin") {
    const chunk = parseCodexUnifiedExecChunkOutput(content);
    if (chunk) {
      content = chunk.output;
      // Raw chunk fields pass through; normalized command metadata and a
      // stdout alias ride alongside so renderers need no chunk knowledge.
      structured = {
        ...chunk.record,
        stdout: chunk.output,
        ...(chunk.exitCode !== undefined ? { exitCode: chunk.exitCode } : {}),
        ...(chunk.durationSeconds !== undefined
          ? { durationSeconds: chunk.durationSeconds }
          : {}),
      };
      if (chunk.exitCode !== undefined) {
        isError = chunk.exitCode !== 0;
      }
    }
  } else if (context?.toolName === "Web") {
    const webRun = parseCodexWebRunOutput(content);
    if (webRun) {
      structured = webRun.result;
      content = webRun.contentText;
      // The envelope's "Script completed" confirms the browse ran; page text
      // that merely contains "Error:" must not mark the call failed.
      isError = false;
    }
  } else if (context?.toolName === "Edit" && context.patchApplyResult) {
    const patchOutput = context.patchApplyResult.success
      ? context.patchApplyResult.stdout
      : context.patchApplyResult.stderr || context.patchApplyResult.stdout;
    if (patchOutput) content = patchOutput;
    isError = !context.patchApplyResult.success;
  }

  return {
    content,
    structured,
    isError,
    ...(normalized.mediaCandidates
      ? { mediaCandidates: normalized.mediaCandidates }
      : {}),
  };
}

export function normalizeCodexCommandExecutionOutput(
  execution: {
    aggregatedOutput: string;
    exitCode?: number;
    status?: string;
  },
  context?: CodexToolCallContext,
): NormalizedCodexToolOutput {
  const baseOutput = execution.aggregatedOutput;
  const hasExitCode = execution.exitCode !== undefined;
  let content =
    execution.status === "declined"
      ? "Command execution was declined."
      : baseOutput || "(no output)";

  const isDeclined = execution.status === "declined";
  let isError = !isDeclined && hasExitCode && execution.exitCode !== 0;
  if (!isDeclined && execution.status) {
    const normalizedStatus = execution.status.toLowerCase();
    if (normalizedStatus === "failed" || normalizedStatus === "error") {
      isError = true;
    }
  }

  // Preserve legacy command output formatting for non-zero exits.
  if (
    !isDeclined &&
    execution.exitCode !== undefined &&
    execution.exitCode !== 0 &&
    baseOutput
  ) {
    content = `Exit code: ${execution.exitCode}\n${baseOutput}`;
  }

  let structured: unknown;
  if (context?.toolName === "Grep") {
    const grepResult = normalizeRipgrepOutput(
      baseOutput,
      getGrepPattern(context.input),
    );
    const isNoMatchesResult =
      execution.exitCode === 1 && grepResult.numFiles === 0;
    if (!isError || isNoMatchesResult) {
      isError = false;
      structured = grepResult;
      content = baseOutput;
    }
  } else if (
    context?.toolName === "Read" &&
    context.readShellInfo &&
    !isError &&
    execution.status !== "declined"
  ) {
    structured = normalizeReadOutput(baseOutput, context.readShellInfo);
    content = baseOutput;
  } else if (
    context?.toolName === "Write" &&
    context.writeShellInfo &&
    !isError &&
    execution.status !== "declined"
  ) {
    structured = normalizeWriteOutput(context.writeShellInfo);
  } else if (context?.toolName === "Bash" && execution.status !== "declined") {
    structured = createBashToolResult(
      baseOutput,
      undefined,
      false,
      execution.exitCode,
    );
  }

  return { content, structured, isError };
}

function extractBashCommand(input: unknown): string {
  if (!isRecord(input)) return "";
  if (typeof input.command === "string" && input.command.trim()) {
    return input.command.trim();
  }
  if (typeof input.cmd === "string" && input.cmd.trim()) {
    return input.cmd.trim();
  }
  return "";
}

function parseHeredocWriteShellCommand(
  command: string,
): CodexWriteShellInfo | null {
  const normalized = command.replace(/\r\n/g, "\n").trimEnd();
  const lines = normalized.split("\n");
  if (lines.length < 2) {
    return null;
  }

  const header = lines[0]?.trim() ?? "";
  const match =
    /^cat\s+>\s*(?<path>'[^']+'|"[^"]+"|[^\s]+)\s+<<(?<stripTabs>-?)(?<quote>['"]?)(?<marker>[A-Za-z_][A-Za-z0-9_]*)\k<quote>\s*$/.exec(
      header,
    );
  if (!match?.groups) {
    return null;
  }

  const marker = match.groups.marker;
  if (!marker) {
    return null;
  }

  const stripTabs = match.groups.stripTabs === "-";
  const filePath = stripOuterQuotes(match.groups.path ?? "");
  if (!filePath || filePath.startsWith("-")) {
    return null;
  }

  const terminatorLineIndex = lines.findIndex((line, index) => {
    if (index === 0) {
      return false;
    }
    const candidate = stripTabs ? line.replace(/^\t+/, "") : line;
    return candidate.trim() === marker;
  });
  if (terminatorLineIndex < 1) {
    return null;
  }

  const trailingLines = lines.slice(terminatorLineIndex + 1);
  if (trailingLines.some((line) => line.trim().length > 0)) {
    return null;
  }

  const bodyLines = lines.slice(1, terminatorLineIndex);
  let content = bodyLines.join("\n");
  if (bodyLines.length > 0) {
    content += "\n";
  }

  return {
    filePath,
    content,
  };
}

function createReadToolInput(
  readInfo: CodexReadShellInfo,
): Record<string, unknown> {
  const input: Record<string, unknown> = { file_path: readInfo.filePath };

  if (readInfo.startLine !== undefined) {
    input.offset = readInfo.startLine;
  }
  if (
    readInfo.startLine !== undefined &&
    readInfo.endLine !== undefined &&
    readInfo.endLine >= readInfo.startLine
  ) {
    input.limit = readInfo.endLine - readInfo.startLine + 1;
  }

  return input;
}

function createWriteToolInput(
  writeInfo: CodexWriteShellInfo,
): Record<string, unknown> {
  return {
    file_path: writeInfo.filePath,
    content: writeInfo.content,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getStringField(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function getGrepPattern(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const pattern = input.pattern;
  return typeof pattern === "string" ? pattern : undefined;
}

function parseNumericExitCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value, 10);
  }
  return undefined;
}

function extractExitCodeFromRecord(
  record: Record<string, unknown>,
): number | undefined {
  const direct = parseNumericExitCode(record.exit_code ?? record.exitCode);
  if (direct !== undefined) {
    return direct;
  }

  const metadata = record.metadata;
  if (isRecord(metadata)) {
    const nested = parseNumericExitCode(
      metadata.exit_code ?? metadata.exitCode,
    );
    if (nested !== undefined) {
      return nested;
    }
  }

  return undefined;
}

function hasFailedStatus(record: Record<string, unknown>): boolean {
  const status = record.status;
  if (typeof status !== "string") {
    return false;
  }
  const normalized = status.toLowerCase();
  return normalized === "failed" || normalized === "error";
}

function extractExitCodeFromText(output: string): number | undefined {
  const match = output.match(
    /(?:^|\n)\s*(?:Error:\s*)?(?:Exit code:?|Process exited with code)\s*(-?\d+)\b/i,
  );
  if (!match?.[1]) {
    return undefined;
  }
  return Number.parseInt(match[1], 10);
}

export function extractCodexBackgroundTaskId(
  output: unknown,
): string | undefined {
  if (typeof output !== "string") {
    return undefined;
  }
  const match = output.match(
    /(?:^|\n)\s*(?:Process\s+running\s+with\s+session\s+ID|session(?:\s+id)?)\s*:?\s*(\d+)\b/i,
  );
  if (!match?.[1]) {
    return undefined;
  }
  return match[1];
}

export function isCodexBackgroundProcessOutput(output: unknown): boolean {
  if (typeof output !== "string") {
    return false;
  }
  return (
    extractCodexBackgroundTaskId(output) !== undefined &&
    extractExitCodeFromText(output) === undefined
  );
}

export function isCodexInterruptedToolOutput(output: unknown): boolean {
  return (
    typeof output === "string" &&
    /(?:^|\n)\s*(?:aborted by user|interrupted by user)(?:\s|$)/i.test(output)
  );
}

function extractSessionIdFromText(output: string): number | undefined {
  const taskId = extractCodexBackgroundTaskId(output);
  if (!taskId) {
    return undefined;
  }
  return Number.parseInt(taskId, 10);
}

function extractTextOnlyFunctionCallOutput(
  output: unknown,
): string | undefined {
  if (!Array.isArray(output) || output.length === 0) {
    return undefined;
  }

  let content = "";
  for (const item of output) {
    if (
      !isRecord(item) ||
      item.type !== "input_text" ||
      typeof item.text !== "string"
    ) {
      return undefined;
    }
    content += item.text;
  }
  return content;
}

function normalizeCodexToolOutput(
  output: unknown,
): NormalizedCodexToolOutputWithExitCode {
  const functionCallText = extractTextOnlyFunctionCallOutput(output);
  if (functionCallText !== undefined) {
    const sanitized = sanitizeInlineImageData(output);
    return {
      content:
        extractTextOnlyFunctionCallOutput(sanitized.value) ?? functionCallText,
      structured: sanitized.value,
      isError: false,
      ...(sanitized.candidates.length > 0
        ? { mediaCandidates: sanitized.candidates }
        : {}),
    };
  }

  const codeModeText = extractCodexCodeModeTextOutput(output);
  if (codeModeText !== undefined) {
    return normalizeCodexToolOutput(codeModeText);
  }

  if (typeof output === "string") {
    let structured: unknown;
    let isError = false;
    let content = output;
    let exitCode: number | undefined;
    let mediaCandidates: ToolResultMediaCandidate[] = [];

    try {
      structured = JSON.parse(output);
      if (typeof structured === "string") {
        const sanitized = sanitizeInlineImageData(structured);
        mediaCandidates = sanitized.candidates;
        content =
          typeof sanitized.value === "string" ? sanitized.value : structured;
        structured = sanitized.value;
        exitCode = extractExitCodeFromText(content);
        if (exitCode !== undefined) {
          isError = exitCode !== 0;
        }
      } else if (isRecord(structured)) {
        const sanitized = sanitizeInlineImageData(structured);
        mediaCandidates = sanitized.candidates;
        const record = isRecord(sanitized.value) ? sanitized.value : structured;
        if (sanitized.changed) {
          structured = record;
          content = JSON.stringify(record, null, 2);
        }
        exitCode = extractExitCodeFromRecord(record);
        isError =
          record.is_error === true ||
          (exitCode !== undefined && exitCode !== 0) ||
          hasFailedStatus(record);
      } else if (Array.isArray(structured)) {
        const sanitized = sanitizeInlineImageData(structured);
        mediaCandidates = sanitized.candidates;
        structured = sanitized.value;
        const textContent = extractTextOnlyFunctionCallOutput(structured);
        if (textContent !== undefined) {
          content = textContent;
        } else if (sanitized.changed) {
          content = JSON.stringify(structured, null, 2);
        }
      }
    } catch {
      structured = undefined;
      const sanitized = sanitizeInlineImageText(output);
      mediaCandidates = sanitized.candidates;
      content = sanitized.value;
      exitCode = extractExitCodeFromText(content);
      if (exitCode !== undefined) {
        isError = exitCode !== 0;
      } else {
        isError = /(?:^|\n)\s*(error|fatal|failed):/i.test(content);
      }
    }

    return {
      content,
      structured,
      isError,
      exitCode,
      ...(mediaCandidates.length > 0 ? { mediaCandidates } : {}),
    };
  }

  if (output === null || output === undefined) {
    return { content: "", isError: false };
  }

  if (typeof output === "number" || typeof output === "boolean") {
    return {
      content: String(output),
      structured: output,
      isError: false,
    };
  }

  if (Array.isArray(output) || isRecord(output)) {
    const sanitized = sanitizeInlineImageData(output);
    const structured = sanitized.value;
    const exitCode = isRecord(structured)
      ? extractExitCodeFromRecord(structured)
      : undefined;
    const isError =
      isRecord(structured) &&
      (structured.is_error === true ||
        (exitCode ?? 0) !== 0 ||
        hasFailedStatus(structured));
    const textContent = extractTextOnlyFunctionCallOutput(structured);
    return {
      content: textContent ?? JSON.stringify(structured, null, 2),
      structured,
      isError,
      exitCode,
      ...(sanitized.candidates.length > 0
        ? { mediaCandidates: sanitized.candidates }
        : {}),
    };
  }

  return { content: String(output), isError: false };
}

interface CodexUnifiedExecChunk {
  durationSeconds?: number;
  exitCode?: number;
  output: string;
  record: Record<string, unknown>;
}

const UNIFIED_EXEC_CHUNK_MARKERS = [
  "chunk_id",
  "session_id",
  "wall_time_seconds",
  "original_token_count",
] as const;

/**
 * Recognize a unified-exec result record printed as a tool output — the
 * shape `tools.exec_command`/`wait` return for detached shell sessions:
 * `{"chunk_id":…,"wall_time_seconds":…,"exit_code":…,"output":"…"}`.
 * The embedded `output` is the command's real text; showing the raw JSON
 * hides it. Anything not exactly one such object fails closed.
 */
function parseCodexUnifiedExecChunkOutput(
  content: string,
): CodexUnifiedExecChunk | undefined {
  const body = extractCodexShellOutputContent(content).trim();
  if (!body.startsWith("{") || !body.endsWith("}")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.output !== "string") return undefined;
  if (!UNIFIED_EXEC_CHUNK_MARKERS.some((marker) => marker in parsed)) {
    return undefined;
  }
  const exitCode = parsed.exit_code;
  const durationSeconds = parsed.wall_time_seconds;
  return {
    ...(typeof exitCode === "number" && Number.isFinite(exitCode)
      ? { exitCode }
      : {}),
    ...(typeof durationSeconds === "number" && Number.isFinite(durationSeconds)
      ? { durationSeconds }
      : {}),
    output: parsed.output,
    record: parsed,
  };
}

/** Command runtime from the shell envelope: "Wall time[:] 30.0 seconds". */
function extractWallTimeSecondsFromText(content: string): number | undefined {
  const match = content.match(
    /(?:^|\n)\s*Wall time:?\s+([\d.]+)\s*seconds?\b/i,
  );
  if (!match?.[1]) {
    return undefined;
  }
  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractCodexShellOutputContent(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  const inlineMarker = "Output:\n";
  if (normalized.startsWith(inlineMarker)) {
    return normalized.slice(inlineMarker.length);
  }

  const marker = "\nOutput:\n";
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex < 0) {
    return normalized;
  }

  const rawOutput = normalized.slice(markerIndex + marker.length);
  return rawOutput.startsWith("\n") ? rawOutput.slice(1) : rawOutput;
}

function createBashToolResult(
  output: string,
  backgroundTaskId?: string,
  interrupted = false,
  exitCode?: number,
  durationSeconds?: number,
): {
  stdout: string;
  stderr: string;
  interrupted: boolean;
  isImage: false;
  backgroundTaskId?: string;
  exitCode?: number;
  durationSeconds?: number;
} {
  return {
    stdout: interrupted ? "" : output,
    stderr: "",
    interrupted,
    isImage: false,
    ...(backgroundTaskId ? { backgroundTaskId } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
  };
}

interface NormalizedGrepMatchRange {
  start: number;
  end: number;
}

interface NormalizedGrepMatch {
  columnNumber?: number;
  filePath: string;
  lineNumber: number;
  ranges?: NormalizedGrepMatchRange[];
  text: string;
}

function normalizeRipgrepOutput(
  output: string,
  pattern?: string,
): {
  mode: "files_with_matches" | "content";
  filenames: string[];
  numFiles: number;
  content?: string;
  matches?: NormalizedGrepMatch[];
  numLines?: number;
} {
  const normalized = output.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  if (!normalized.trim()) {
    return {
      mode: "files_with_matches",
      filenames: [],
      numFiles: 0,
    };
  }

  const lines = normalized.split("\n");
  const hasLineBasedMatches = lines.some(
    (line) => /^.+:\d+(?::|-)/.test(line) || /^\d+(?::|-)/.test(line),
  );

  if (hasLineBasedMatches) {
    const matches = lines
      .map((line) => parseRipgrepMatchLine(line, pattern))
      .filter((match): match is NormalizedGrepMatch => !!match);
    const filenames = Array.from(
      new Set(
        (matches.length > 0
          ? matches.map((match) => match.filePath)
          : lines
              .map(extractFilenameFromRipgrepLine)
              .filter((file): file is string => !!file)
        ).filter(Boolean),
      ),
    );

    const numFiles = filenames.length > 0 ? filenames.length : 1;
    return {
      mode: "content",
      filenames,
      numFiles,
      content: normalized,
      matches,
      numLines: lines.length,
    };
  }

  const filenames = Array.from(
    new Set(lines.map((line) => line.trim()).filter((line) => line.length > 0)),
  );
  return {
    mode: "files_with_matches",
    filenames,
    numFiles: filenames.length,
  };
}

function extractFilenameFromRipgrepLine(line: string): string | null {
  const match = line.match(/^(.+?):\d+(?::|-)/);
  if (match?.[1]) {
    return match[1];
  }
  return null;
}

function parseRipgrepMatchLine(
  line: string,
  pattern?: string,
): NormalizedGrepMatch | null {
  const match = /^(.+?):(\d+)(?::(\d+))?:(.*)$/.exec(line);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  const text = match[4] ?? "";
  const columnNumber = match[3] ? Number(match[3]) : undefined;
  return {
    filePath: match[1],
    lineNumber: Number(match[2]),
    columnNumber,
    text,
    ranges:
      columnNumber !== undefined
        ? undefined
        : getLiteralMatchRanges(text, pattern),
  };
}

function getLiteralMatchRanges(
  text: string,
  pattern: string | undefined,
): NormalizedGrepMatchRange[] | undefined {
  if (!pattern) {
    return undefined;
  }
  const ranges: NormalizedGrepMatchRange[] = [];
  let start = 0;
  while (ranges.length < 50) {
    const index = text.indexOf(pattern, start);
    if (index < 0) {
      break;
    }
    ranges.push({ start: index, end: index + pattern.length });
    start = index + Math.max(1, pattern.length);
  }
  return ranges.length > 0 ? ranges : undefined;
}

function normalizeReadOutput(
  output: string,
  readInfo: CodexReadShellInfo,
): {
  type: "text";
  file: {
    filePath: string;
    content: string;
    numLines: number;
    startLine: number;
    totalLines: number;
  };
} {
  const normalized = output.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  let startLine = readInfo.startLine ?? 1;

  const contentLines = readInfo.stripLineNumbers
    ? lines.map((line, index) => {
        const match = line.match(/^\s*(\d+)\s+(.*)$/);
        if (match?.[1]) {
          if (index === 0) {
            startLine = Number.parseInt(match[1], 10);
          }
          return match[2] ?? "";
        }
        return line;
      })
    : lines;

  const content = contentLines.join("\n");
  const numLines = countContentLines(content);
  const computedEndLine =
    numLines > 0 ? startLine + numLines - 1 : (readInfo.endLine ?? startLine);
  const totalLines = Math.max(
    readInfo.endLine ?? computedEndLine,
    computedEndLine,
  );

  return {
    type: "text",
    file: {
      filePath: readInfo.filePath,
      content,
      numLines,
      startLine,
      totalLines,
    },
  };
}

function normalizeWriteOutput(writeInfo: CodexWriteShellInfo): {
  type: "text";
  file: {
    filePath: string;
    content: string;
    numLines: number;
    startLine: number;
    totalLines: number;
  };
} {
  const numLines = countContentLines(writeInfo.content);
  return {
    type: "text",
    file: {
      filePath: writeInfo.filePath,
      content: writeInfo.content,
      numLines,
      startLine: 1,
      totalLines: numLines,
    },
  };
}

function countContentLines(content: string): number {
  if (!content) {
    return 0;
  }

  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.length;
}
