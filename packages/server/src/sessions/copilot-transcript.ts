import { lstat, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export const COPILOT_SESSION_DIRECTORY =
  /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

interface CopilotEvent {
  type: string;
  id: string;
  timestamp?: string;
  data: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseCopilotEvent(line: string): CopilotEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return;
  }
  const record = asRecord(value);
  const data = asRecord(record?.data);
  if (
    !data ||
    typeof record?.type !== "string" ||
    typeof record.id !== "string"
  )
    return;
  return {
    type: record.type,
    id: record.id,
    timestamp:
      typeof record.timestamp === "string" ? record.timestamp : undefined,
    data,
  };
}

export async function locateCopilotTranscript(root: string, id: string) {
  if (!COPILOT_SESSION_DIRECTORY.test(id)) return;
  const directory = join(root, id);
  const path = join(directory, "events.jsonl");
  const parent = await lstat(directory).catch(() => undefined);
  if (!parent?.isDirectory()) return;
  const stats = await lstat(path).catch(() => undefined);
  if (!stats?.isFile()) return;
  return { path, stats };
}

export async function readCopilotTranscriptHead(path: string, id: string) {
  const file = await open(path, "r").catch(() => undefined);
  if (!file) return;
  try {
    const buffer = Buffer.alloc(32 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    // The last record may be mid-write or cut by the read budget.
    lines.pop();
    const first = parseCopilotEvent(lines.shift() ?? "");
    const cwd = asRecord(first?.data.context)?.cwd;
    if (
      first?.type !== "session.start" ||
      first.data.sessionId !== id ||
      typeof cwd !== "string" ||
      !isAbsolute(cwd) ||
      cwd.includes("\0")
    )
      return;
    const startTime = Date.parse(
      String(first.data.startTime ?? first.timestamp ?? ""),
    );
    let title: string | undefined;
    for (const line of lines) {
      const event = parseCopilotEvent(line);
      if (
        event?.type === "user.message" &&
        typeof event.data.content === "string"
      ) {
        title = event.data.content.trim().replace(/\s+/g, " ").slice(0, 120);
        if (title) break;
      }
    }
    return {
      cwd,
      title,
      createdAtMs: Number.isFinite(startTime) ? startTime : undefined,
      model:
        typeof first.data.selectedModel === "string"
          ? first.data.selectedModel
          : undefined,
    };
  } catch {
    return;
  } finally {
    await file.close();
  }
}
