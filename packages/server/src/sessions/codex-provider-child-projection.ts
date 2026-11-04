import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  parseCodexSessionEntry,
  truncateSessionTitle,
} from "@yep-anywhere/shared";
import {
  SourceVersionedSingleFlight,
  type SourceVersionedSingleFlightStats,
  type SourceVersionedWorkResult,
} from "../lib/sourceVersionedSingleFlight.js";
import { iterateJsonlLines, stripBom } from "../utils/jsonl.js";

const MAX_RETAINED_BYTES = 8 * 1024 * 1024;

export interface CodexProviderChildLaunch {
  toolUseId: string;
  title?: string;
  agentType?: string;
}

export interface CodexProviderChild {
  id: string;
  toolUseId: string;
  nickname?: string;
}

export interface CodexProviderChildProjectionBuild {
  fullRebuild: boolean;
  startOffset: number;
  sourceBytesRead: number;
  linesInspected: number;
  parsedEntries: number;
}

export interface CodexProviderChildProjection {
  filePath: string;
  fileIdentity: string;
  readThroughBytes: number;
  pendingLine: Buffer;
  launches: Map<string, CodexProviderChildLaunch>;
  children: Map<string, CodexProviderChild>;
  parentUpdatedAt: string;
  lastBuild: CodexProviderChildProjectionBuild;
  retainedBytes: number;
}

type CodexFileStats = Awaited<ReturnType<typeof stat>>;

class CodexProviderChildProjectionCollector {
  private readonly launches = new Map<string, CodexProviderChildLaunch>();
  private readonly children = new Map<string, CodexProviderChild>();

  constructor(previous?: CodexProviderChildProjection) {
    if (!previous) return;
    for (const [callId, launch] of previous.launches) {
      this.launches.set(callId, { ...launch });
    }
    for (const [callId, child] of previous.children) {
      this.children.set(callId, { ...child });
    }
  }

  addLine(line: string): boolean {
    if (!this.acceptsLine(line)) return false;
    const entry = parseCodexSessionEntry(line);
    if (entry?.type === "event_msg" && isRecord(entry.payload)) {
      const payload = entry.payload;
      const activity =
        payload.type === "item_completed" &&
        isRecord(payload.item) &&
        payload.item.type === "SubAgentActivity"
          ? payload.item
          : payload.type === "sub_agent_activity"
            ? payload
            : null;
      if (activity?.kind !== "started") return true;
      const callId =
        stringField(activity, "id") ?? stringField(activity, "event_id");
      const childId = stringField(activity, "agent_thread_id");
      // v2 tool output deliberately exposes only task_name. The provider's
      // persisted start item carries the native id and original spawn call id.
      // Interactions/completions and unrelated activity are not new children.
      if (callId && childId && this.launches.has(callId))
        this.children.set(callId, { id: childId, toolUseId: callId });
      return true;
    }
    if (entry?.type !== "response_item" || !isRecord(entry.payload))
      return false;

    const payload = entry.payload;
    if (payload.type === "function_call" && payload.name === "spawn_agent") {
      const args = parseJsonRecord(payload.arguments);
      const prompt =
        stringField(args, "prompt") ?? stringField(args, "message");
      const agentType =
        stringField(args, "role") ?? stringField(args, "agent_type");
      this.launches.set(payload.call_id, {
        toolUseId: payload.call_id,
        ...(prompt && { title: truncateSessionTitle(prompt) }),
        ...(agentType && { agentType }),
      });
      return true;
    }

    if (payload.type !== "function_call_output" || !payload.call_id)
      return true;
    const launch = this.launches.get(payload.call_id);
    if (!launch) return true;
    const child = parseCodexSpawnAgentDetails(payload.output);
    if (!child) return true;
    this.children.set(payload.call_id, {
      id: child.agentId,
      toolUseId: payload.call_id,
      ...(child.nickname && { nickname: child.nickname }),
    });
    return true;
  }

  snapshot(): {
    launches: Map<string, CodexProviderChildLaunch>;
    children: Map<string, CodexProviderChild>;
  } {
    return {
      launches: new Map(
        [...this.launches].map(([callId, launch]) => [callId, { ...launch }]),
      ),
      children: new Map(
        [...this.children].map(([callId, child]) => [callId, { ...child }]),
      ),
    };
  }

  private acceptsLine(line: string): boolean {
    if (line.includes('"spawn_agent"')) return true;
    if (this.launches.size === 0) return false;
    if (
      line.includes('"SubAgentActivity"') ||
      line.includes('"sub_agent_activity"')
    )
      return true;
    if (!line.includes('"function_call_output"')) return false;
    for (const callId of this.launches.keys()) {
      if (line.includes(callId)) return true;
    }
    return false;
  }
}

function fileIdentity(stats: CodexFileStats): string {
  return `${Number(stats.dev)}\0${Number(stats.ino)}`;
}

function sourceVersion(filePath: string, stats: CodexFileStats): string {
  return [
    filePath,
    Number(stats.dev),
    Number(stats.ino),
    Number(stats.size),
    Number(stats.mtimeMs),
    Number(stats.ctimeMs),
  ].join("\0");
}

function estimateBytes(projection: CodexProviderChildProjection): number {
  let bytes = 256 + projection.pendingLine.byteLength;
  for (const launch of projection.launches.values()) {
    bytes +=
      128 +
      Buffer.byteLength(launch.toolUseId) +
      Buffer.byteLength(launch.title ?? "") +
      Buffer.byteLength(launch.agentType ?? "");
  }
  for (const child of projection.children.values()) {
    bytes +=
      128 +
      Buffer.byteLength(child.id) +
      Buffer.byteLength(child.toolUseId) +
      Buffer.byteLength(child.nickname ?? "");
  }
  return bytes;
}

async function readPlainRange(options: {
  filePath: string;
  startOffset: number;
  endOffset: number;
  collector: CodexProviderChildProjectionCollector;
  previousPendingLine: Buffer;
}): Promise<{
  pendingLine: Buffer;
  sourceBytesRead: number;
  linesInspected: number;
  parsedEntries: number;
}> {
  const lineParts: Buffer[] = options.previousPendingLine.length
    ? [options.previousPendingLine]
    : [];
  let sourceBytesRead = 0;
  let linesInspected = 0;
  let parsedEntries = 0;
  const inspectLine = (buffer: Buffer): void => {
    linesInspected += 1;
    const line = stripBom(buffer.toString("utf-8")).trim();
    if (line && options.collector.addLine(line)) parsedEntries += 1;
  };

  if (options.startOffset < options.endOffset) {
    const stream = createReadStream(options.filePath, {
      start: options.startOffset,
      end: options.endOffset - 1,
    });
    try {
      for await (const rawChunk of stream) {
        const chunk = Buffer.isBuffer(rawChunk)
          ? rawChunk
          : Buffer.from(rawChunk);
        sourceBytesRead += chunk.byteLength;
        let cursor = 0;
        let newline = chunk.indexOf(0x0a, cursor);
        while (newline !== -1) {
          const tail = chunk.subarray(cursor, newline);
          const lineBuffer =
            lineParts.length > 0 ? Buffer.concat([...lineParts, tail]) : tail;
          lineParts.length = 0;
          inspectLine(lineBuffer);
          cursor = newline + 1;
          newline = chunk.indexOf(0x0a, cursor);
        }
        if (cursor < chunk.length) lineParts.push(chunk.subarray(cursor));
      }
    } finally {
      stream.destroy();
    }
  }

  const pendingLine =
    lineParts.length > 0 ? Buffer.concat(lineParts) : Buffer.alloc(0);
  if (pendingLine.length > 0) inspectLine(pendingLine);
  return { pendingLine, sourceBytesRead, linesInspected, parsedEntries };
}

async function buildProjection(options: {
  filePath: string;
  parentUpdatedAt: string;
  stats: CodexFileStats;
  previous?: CodexProviderChildProjection;
}): Promise<CodexProviderChildProjection> {
  const identity = fileIdentity(options.stats);
  const previous = options.previous;
  const incrementalPrevious =
    previous &&
    !options.filePath.endsWith(".jsonl.zst") &&
    previous.filePath === options.filePath &&
    previous.fileIdentity === identity &&
    previous.readThroughBytes < options.stats.size
      ? previous
      : undefined;
  const startOffset = incrementalPrevious?.readThroughBytes ?? 0;
  const collector = new CodexProviderChildProjectionCollector(
    incrementalPrevious,
  );
  let pendingLine: Buffer = Buffer.alloc(0);
  let sourceBytesRead = 0;
  let linesInspected = 0;
  let parsedEntries = 0;

  if (options.filePath.endsWith(".jsonl.zst")) {
    for await (const line of iterateJsonlLines(options.filePath)) {
      linesInspected += 1;
      const trimmed = stripBom(line).trim();
      if (trimmed && collector.addLine(trimmed)) parsedEntries += 1;
    }
    sourceBytesRead = Number(options.stats.size);
  } else {
    const read = await readPlainRange({
      filePath: options.filePath,
      startOffset,
      endOffset: Number(options.stats.size),
      collector,
      previousPendingLine: incrementalPrevious?.pendingLine ?? Buffer.alloc(0),
    });
    pendingLine = read.pendingLine;
    sourceBytesRead = read.sourceBytesRead;
    linesInspected = read.linesInspected;
    parsedEntries = read.parsedEntries;
  }

  const snapshot = collector.snapshot();
  const projection: CodexProviderChildProjection = {
    filePath: options.filePath,
    fileIdentity: identity,
    readThroughBytes: Number(options.stats.size),
    pendingLine,
    launches: snapshot.launches,
    children: snapshot.children,
    parentUpdatedAt: options.parentUpdatedAt,
    lastBuild: {
      fullRebuild: !incrementalPrevious,
      startOffset,
      sourceBytesRead,
      linesInspected,
      parsedEntries,
    },
    retainedBytes: 0,
  };
  projection.retainedBytes = estimateBytes(projection);
  return projection;
}

class CodexProviderChildProjectionCache {
  private readonly owner = new SourceVersionedSingleFlight<
    string,
    CodexProviderChildProjection
  >({ maxRetainedBytes: MAX_RETAINED_BYTES, estimateBytes });

  run(options: {
    key: string;
    filePath: string;
    parentUpdatedAt: string;
    stats: CodexFileStats;
  }): Promise<SourceVersionedWorkResult<CodexProviderChildProjection>> {
    const version = sourceVersion(options.filePath, options.stats);
    return this.owner.run({
      key: options.key,
      sourceVersion: version,
      compute: async (previous) =>
        buildProjection({
          filePath: options.filePath,
          parentUpdatedAt: options.parentUpdatedAt,
          stats: options.stats,
          previous: previous?.value,
        }),
      isCurrent: async (candidate) => {
        try {
          return (
            sourceVersion(options.filePath, await stat(options.filePath)) ===
            candidate
          );
        } catch {
          return false;
        }
      },
    });
  }

  getAccepted(key: string): CodexProviderChildProjection | undefined {
    return this.owner.getAccepted(key)?.value;
  }

  invalidate(key: string): void {
    this.owner.invalidate(key);
  }

  getStats(): SourceVersionedSingleFlightStats {
    return this.owner.getStats();
  }
}

export const codexProviderChildProjections =
  new CodexProviderChildProjectionCache();

function parseCodexSpawnAgentDetails(
  output: unknown,
): { agentId: string; nickname?: string } | null {
  const text = codexToolOutputText(output);
  if (!text) return null;
  const parsed = parseJsonRecord(text);
  const agentId =
    stringField(parsed, "agent_id") ?? stringField(parsed, "agentId");
  if (agentId) {
    const nickname = stringField(parsed, "nickname");
    return { agentId, ...(nickname && { nickname }) };
  }
  const fallbackAgentId =
    text.match(/"agent_id"\s*:\s*"([^"]+)"/)?.[1] ??
    text.match(/"agentId"\s*:\s*"([^"]+)"/)?.[1] ??
    null;
  return fallbackAgentId ? { agentId: fallbackAgentId } : null;
}

export function parseCodexSpawnAgentOutput(output: unknown): string | null {
  return parseCodexSpawnAgentDetails(output)?.agentId ?? null;
}

function codexToolOutputText(output: unknown): string {
  if (typeof output === "string") return output.trim();
  if (!Array.isArray(output)) return "";
  return output
    .map((item) =>
      isRecord(item) && typeof item.text === "string" ? item.text : "",
    )
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stringField(
  record: Record<string, unknown> | null | undefined,
  field: string,
): string | undefined {
  const value = record?.[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
