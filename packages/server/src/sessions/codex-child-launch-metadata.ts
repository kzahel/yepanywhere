import type { CodexSessionEntry } from "@yep-anywhere/shared";

export interface CodexProviderChild {
  id: string;
  toolUseId: string;
  nickname?: string;
}

/** Current native start items enrich anchors; they never establish parentage. */
export function parseCodexStartedChild(
  entry: CodexSessionEntry,
): CodexProviderChild | undefined {
  if (entry.type !== "event_msg" || !isRecord(entry.payload)) return;
  const payload = entry.payload;
  const activity =
    payload.type === "item_completed" &&
    isRecord(payload.item) &&
    payload.item.type === "SubAgentActivity"
      ? payload.item
      : payload.type === "sub_agent_activity"
        ? payload
        : null;
  if (activity?.kind !== "started") return;
  const toolUseId =
    stringField(activity, "id") ?? stringField(activity, "event_id");
  const id = stringField(activity, "agent_thread_id");
  return toolUseId && id ? { id, toolUseId } : undefined;
}

// Only recognize an unambiguous native envelope/payload prefix. Unknown field
// ordering or a long/escaped key falls back to the full parser, never a miss.
const OUTPUT_CALL_PREFIX =
  /^\s*\{(?:\s*"(?:timestamp|type|ordinal)"\s*:\s*(?:"(?:[^"\\]|\\.)*"|-?\d+)\s*,)*\s*"payload"\s*:\s*\{\s*"type"\s*:\s*"function_call_output"\s*,\s*"call_id"\s*:\s*("(?:[^"\\]|\\.)*")/;
export function codexOutputMayMatch(
  line: string,
  calls: ReadonlySet<string> | ReadonlyMap<string, unknown>,
): boolean {
  const match = OUTPUT_CALL_PREFIX.exec(line.slice(0, 4096));
  if (!match) return true;
  try {
    return calls.has(JSON.parse(match[1]!));
  } catch {
    return true;
  }
}

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
