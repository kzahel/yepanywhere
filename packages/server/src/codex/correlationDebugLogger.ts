import * as fs from "node:fs";
import * as path from "node:path";
import type { Writable } from "node:stream";
import { loadConfig } from "../config.js";
import { createRotatingFileStream } from "../logging/rotating-file-stream.js";
import type { SDKMessage } from "../sdk/types.js";
import type { Message } from "../supervisor/types.js";

type CodexDebugChannel = "sdk" | "jsonl";
type CodexDebugAuthority = "transient" | "durable";

export interface CodexCorrelationDebugRecord {
  sessionId: string;
  channel: CodexDebugChannel;
  authority: CodexDebugAuthority;
  transportId?: string;
  timestamp?: string;
  entryType?: string;
  payloadType?: string;
  eventKind?: string;
  turnId?: string;
  itemId?: string;
  callId?: string;
  phase?: string;
  sourceEvent?: string;
  status?: string;
  toolName?: string;
  messageType?: string;
  messageRole?: string;
  messageSubtype?: string;
  contentFingerprint?: string | null;
  contentPreview?: string | null;
}

let writeStream: Writable | null = null;
let enabled = false;

function disableLogger(stream: Writable): void {
  if (writeStream !== stream) return;
  enabled = false;
  writeStream = null;
  stream.destroy();
}

export function initCodexCorrelationDebugLogger(): void {
  enabled = process.env.CODEX_CORRELATION_DEBUG === "true";
  if (!enabled) return;

  const config = loadConfig();
  const logPath = path.join(config.logDir, "codex-correlation-debug.jsonl");

  try {
    fs.mkdirSync(config.logDir, { recursive: true });
    const stream = createRotatingFileStream(logPath);
    stream.on("error", () => {
      disableLogger(stream);
    });
    writeStream = stream;
  } catch {
    enabled = false;
    writeStream = null;
    return;
  }

  logRaw({
    _meta: "logger_started",
    logger: "codex_correlation_debug",
    timestamp: new Date().toISOString(),
    pid: process.pid,
    path: logPath,
  });
}

export function closeCodexCorrelationDebugLogger(): void {
  const stream = writeStream;
  enabled = false;
  writeStream = null;
  if (stream) {
    stream.end();
  }
}

export function isCodexCorrelationDebugEnabled(): boolean {
  return enabled;
}

export function logCodexCorrelationDebug(
  record: CodexCorrelationDebugRecord,
): void {
  if (!enabled || !writeStream) return;

  logRaw({
    _meta: "codex_correlation",
    _ts: Date.now(),
    ...record,
  });
}

export function summarizeCodexNormalizedMessage(
  message: Message | SDKMessage,
): {
  transportId?: string;
  timestamp?: string;
  toolName?: string;
  messageType?: string;
  messageRole?: string;
  messageSubtype?: string;
  contentFingerprint?: string | null;
  contentPreview?: string | null;
} {
  const record = message as Record<string, unknown>;
  const nestedMessage =
    record.message && typeof record.message === "object"
      ? (record.message as Record<string, unknown>)
      : null;

  const content = nestedMessage?.content ?? record.content;
  const toolName = extractToolName(record, content);

  return {
    transportId:
      typeof record.uuid === "string"
        ? record.uuid
        : typeof record.id === "string"
          ? record.id
          : undefined,
    timestamp:
      typeof record.timestamp === "string" ? record.timestamp : undefined,
    ...(toolName ? { toolName } : {}),
    messageType: typeof record.type === "string" ? record.type : undefined,
    messageRole:
      typeof nestedMessage?.role === "string" ? nestedMessage.role : undefined,
    messageSubtype:
      typeof record.subtype === "string" ? record.subtype : undefined,
    contentFingerprint: summarizeContentFingerprint(content, record),
    contentPreview: summarizeContentPreview(content, record),
  };
}

function extractToolName(
  record: Record<string, unknown>,
  content: unknown,
): string | undefined {
  if (typeof record.codexToolName === "string" && record.codexToolName) {
    return record.codexToolName;
  }
  if (typeof record.tool_name === "string" && record.tool_name) {
    return record.tool_name;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typedBlock = block as Record<string, unknown>;
    if (
      typedBlock.type === "tool_use" &&
      typeof typedBlock.name === "string" &&
      typedBlock.name
    ) {
      return typedBlock.name;
    }
  }

  return undefined;
}

function summarizeContentFingerprint(
  content: unknown,
  record: Record<string, unknown>,
): string | null {
  if (typeof content === "string") {
    return `text:${content}`;
  }

  if (Array.isArray(content)) {
    const parts = content
      .map((block) => normalizeContentBlock(block))
      .filter((part) => part.length > 0);
    return parts.length > 0 ? parts.join("|") : null;
  }

  if (typeof record.error === "string") {
    return `error:${record.error}`;
  }

  if (Array.isArray(record.items)) {
    return `items:${stableStringify(record.items)}`;
  }

  return null;
}

function summarizeContentPreview(
  content: unknown,
  record: Record<string, unknown>,
): string | null {
  if (typeof content === "string") {
    return truncate(content);
  }

  if (Array.isArray(content)) {
    const preview = content
      .map((block) => previewContentBlock(block))
      .filter((part) => part.length > 0)
      .join(" | ");
    return preview ? truncate(preview) : null;
  }

  if (typeof record.content === "string") {
    return truncate(record.content);
  }

  if (typeof record.error === "string") {
    return truncate(record.error);
  }

  if (Array.isArray(record.items)) {
    return truncate(stableStringify(record.items));
  }

  return null;
}

function normalizeContentBlock(block: unknown): string {
  if (typeof block === "string") {
    return `text:${block}`;
  }

  if (!block || typeof block !== "object") {
    return "";
  }

  const typedBlock = block as Record<string, unknown>;
  const type =
    typeof typedBlock.type === "string" ? typedBlock.type : "unknown";

  switch (type) {
    case "text":
    case "output_text":
      return `text:${typeof typedBlock.text === "string" ? typedBlock.text : ""}`;
    case "thinking":
      return `thinking:${typeof typedBlock.thinking === "string" ? typedBlock.thinking : ""}`;
    case "tool_use":
      return `tool_use:${typeof typedBlock.id === "string" ? typedBlock.id : ""}:${typeof typedBlock.name === "string" ? typedBlock.name : ""}:${stableStringify(typedBlock.input)}`;
    case "tool_result":
      return `tool_result:${typeof typedBlock.tool_use_id === "string" ? typedBlock.tool_use_id : ""}:${typedBlock.is_error === true ? "1" : "0"}:${typeof typedBlock.content === "string" ? typedBlock.content : stableStringify(typedBlock.content)}`;
    case "input_image":
    case "image":
      return `${type}:${typeof typedBlock.file_path === "string" ? typedBlock.file_path : ""}:${typeof typedBlock.image_url === "string" ? typedBlock.image_url : ""}`;
    default:
      return `${type}:${stableStringify(typedBlock)}`;
  }
}

function previewContentBlock(block: unknown): string {
  if (typeof block === "string") {
    return block;
  }

  if (!block || typeof block !== "object") {
    return "";
  }

  const typedBlock = block as Record<string, unknown>;
  const type =
    typeof typedBlock.type === "string" ? typedBlock.type : "unknown";

  switch (type) {
    case "text":
    case "output_text":
      return typeof typedBlock.text === "string" ? typedBlock.text : "";
    case "thinking":
      return typeof typedBlock.thinking === "string"
        ? `[thinking] ${typedBlock.thinking}`
        : "[thinking]";
    case "tool_use":
      return `[tool_use:${typeof typedBlock.name === "string" ? typedBlock.name : "unknown"}]`;
    case "tool_result":
      return `[tool_result:${typeof typedBlock.tool_use_id === "string" ? typedBlock.tool_use_id : "unknown"}] ${typeof typedBlock.content === "string" ? typedBlock.content : ""}`;
    default:
      return `[${type}]`;
  }
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    return `{${entries.map(([k, v]) => `${k}:${stableStringify(v)}`).join(",")}}`;
  }
  return String(value);
}

function truncate(value: string, maxLength = 160): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength - 3)}...`;
}

function logRaw(obj: unknown): void {
  if (!enabled || !writeStream) return;
  let line: string;
  try {
    line = `${JSON.stringify(obj)}\n`;
  } catch {
    return;
  }
  const stream = writeStream;
  try {
    stream.write(line);
  } catch {
    disableLogger(stream);
  }
}
