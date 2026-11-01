import { HELPER_SIDE_MODEL_CHEAPEST } from "@yep-anywhere/shared";
import type {
  RawResponseItemCompletedNotification,
  ThreadItem as CodexThreadItem,
  ThreadResumeParams,
} from "./codex-protocol/index.js";
import {
  asCodexAgentMessageDeltaNotification,
  asCodexItemCompletedNotification,
  asCodexRawResponseItemCompletedNotification,
} from "./codex-notification-guards.js";
import type { SummaryGenerationRequest } from "./types.js";

export const CODEX_RECAP_TIMEOUT_MS = 20_000;
export const CODEX_SUMMARY_TIMEOUT_MS = 60_000;

const CODEX_RECAP_MAX_TOTAL_CHARS = 6000;
const CODEX_RECAP_CHEAPEST_MODEL_PREFERENCES = [
  "gpt-5.4-mini",
  "gpt-5.1-codex-mini",
] as const;

export interface CodexSummaryNotification {
  method: string;
  params?: unknown;
}

export interface CodexSummaryNormalizedItem {
  id: string;
  type: string;
  text?: string;
}

export type CodexSummaryItemNormalizer = (
  item: CodexThreadItem | Record<string, unknown>,
) => CodexSummaryNormalizedItem | null;

export function createCodexRecapPrompt(recentAssistantText: string[]): string {
  const trimmed = recentAssistantText
    .map((text) => text.trim())
    .filter((text) => text.length > 0);
  if (trimmed.length === 0) {
    throw new Error("No recent assistant text to summarize");
  }

  let total = 0;
  const tail: string[] = [];
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const entry = trimmed[i] ?? "";
    if (total + entry.length > CODEX_RECAP_MAX_TOTAL_CHARS) {
      break;
    }
    tail.unshift(entry);
    total += entry.length;
  }
  if (tail.length === 0) {
    const last = trimmed[trimmed.length - 1] ?? "";
    tail.push(last.slice(-CODEX_RECAP_MAX_TOTAL_CHARS));
  }

  const transcript = tail
    .map((text, index) => `--- Assistant turn ${index + 1} ---\n${text}`)
    .join("\n\n");
  return [
    "The user stepped away and is coming back. Recap in under 40 words,",
    "1-2 plain sentences, no markdown. Lead with the overall thrust of what",
    "the assistant did or is doing; mention any pending next action.",
    "Do not greet, do not ask a question, do not add a sign-off.",
    "",
    "Recent assistant output:",
    transcript,
  ].join("\n");
}

export function createCodexForkSummaryPrompt(
  request: Extract<SummaryGenerationRequest, { strategy: "fork" }>,
): string {
  return request.purpose === "session-retitle"
    ? createCodexSessionRetitlePrompt(request)
    : request.purpose === "recap"
      ? createCodexForkedRecapPrompt()
      : createCodexForkAfterSummaryPrompt(request);
}

export function createCodexForkSummaryThreadResumeParams(
  request: Extract<SummaryGenerationRequest, { strategy: "fork" }>,
  experimentalApiEnabled = false,
): ThreadResumeParams {
  const params: ThreadResumeParams = {
    threadId: request.generatorSessionId,
    ...(request.nativeSource ? { path: request.nativeSource.filePath } : {}),
    model: request.model ?? null,
    cwd: request.cwd,
    approvalPolicy: "untrusted",
    sandbox: "read-only",
    config: null,
    developerInstructions: [
      request.sessionSandbox?.instructions?.text,
      getCodexForkSummaryDeveloperInstructions(request.purpose),
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
  if (experimentalApiEnabled) {
    params.excludeTurns = true;
  }
  return params;
}

export function createCodexForkAfterSummaryPrompt(
  request: Extract<SummaryGenerationRequest, { purpose: "fork-after-summary" }>,
): string {
  const instructions = request.instructions?.trim();
  const boundaryContext = request.afterTurnContext?.trim();
  return [
    "The first non-empty line must be a concise title of at most 120 characters, with no trailing period.",
    "Write it as: Title: <title>",
    "Then leave one blank line before the handoff summary.",
    "",
    "Summarize the useful state after the retained fork boundary for a peer-agent handoff.",
    `The target fork retains the conversation through completed-turn message id ${request.afterTurnMessageId}.`,
    boundaryContext
      ? `The retained boundary is the completed turn ending with this excerpt:\n${boundaryContext}`
      : undefined,
    "The target fork already includes the original request and the assistant/tool work through that selected completed turn.",
    "Do not repeat setup, instruction loading, initial repository orientation, or investigation already present in that retained prefix.",
    "Preserve decisions, constraints, current state, changed files, verification evidence, open risks, and the next useful action.",
    "Do not continue the task. Write text that can be submitted as the next user turn in the target fork.",
    instructions ? "" : undefined,
    instructions ? "Additional user instructions:" : undefined,
    instructions || undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n");
}

export function createCodexForkedRecapPrompt(): string {
  return [
    "The user stepped away and is coming back.",
    "Recap the current session state in under 40 words, 1-2 plain sentences, no markdown.",
    "Lead with what the assistant did or is doing; mention any pending next action.",
    "Do not greet, do not ask a question, do not add a sign-off.",
  ].join("\n");
}

export function createCodexSessionRetitlePrompt(
  request: Extract<SummaryGenerationRequest, { purpose: "session-retitle" }>,
): string {
  const lengthTarget = request.lengthTarget ?? 80;
  const currentTitle = request.currentTitle?.trim();
  return [
    "What is a good new title for this session?",
    "",
    `Target length: under ${lengthTarget} characters.`,
    currentTitle ? `Current title: ${currentTitle}` : undefined,
    "Prefer a concrete task/result phrase over a generic chat title.",
    "Return only the title. Do not quote it. Do not add a trailing period.",
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n");
}

export function selectCodexRecapHelperModel(
  requestedModel: string | undefined,
  models: ReadonlyArray<{ id: string }>,
): string | null {
  if (!requestedModel || requestedModel !== HELPER_SIDE_MODEL_CHEAPEST) {
    return requestedModel ?? null;
  }

  for (const preferred of CODEX_RECAP_CHEAPEST_MODEL_PREFERENCES) {
    if (models.some((model) => model.id === preferred)) {
      return preferred;
    }
  }
  return (
    models.find((model) => model.id.toLowerCase().includes("mini"))?.id ?? null
  );
}

export async function resolveCodexRecapHelperModel(
  requestedModel: string | undefined,
  getAvailableModels: () => Promise<ReadonlyArray<{ id: string }>>,
): Promise<string | null> {
  if (!requestedModel || requestedModel !== HELPER_SIDE_MODEL_CHEAPEST) {
    return requestedModel ?? null;
  }
  return selectCodexRecapHelperModel(
    requestedModel,
    await getAvailableModels(),
  );
}

export function cleanCodexRecapText(text: string): string {
  return text.replace(/\s*\(disable recaps in \/config\)\s*$/u, "").trim();
}

export function cleanCodexSummaryText(text: string): string {
  return text.trim();
}

export function joinCodexSummaryText(
  textByItemId: ReadonlyMap<string, string>,
): string {
  return [...textByItemId.values()].join("\n");
}

export function captureCodexSummaryTextFromTurnItems(
  items: CodexThreadItem[],
  textByItemId: Map<string, string>,
  normalizeThreadItem: CodexSummaryItemNormalizer,
): void {
  for (const item of items) {
    const normalized = normalizeThreadItem(item);
    if (normalized?.type === "agent_message" && normalized.text?.trim()) {
      textByItemId.set(normalized.id, normalized.text);
    }
  }
}

export function captureCodexSummaryTextFromNotification(
  notification: CodexSummaryNotification,
  textByItemId: Map<string, string>,
  normalizeThreadItem: CodexSummaryItemNormalizer,
): void {
  if (notification.method === "item/agentMessage/delta") {
    const params = asCodexAgentMessageDeltaNotification(notification.params);
    if (!params?.delta) return;
    textByItemId.set(
      params.itemId,
      `${textByItemId.get(params.itemId) ?? ""}${params.delta}`,
    );
    return;
  }

  if (notification.method === "item/completed") {
    const params = asCodexItemCompletedNotification(notification.params);
    if (!params || textByItemId.has(params.item.id)) return;
    const normalized = normalizeThreadItem(params.item);
    if (normalized?.type === "agent_message" && normalized.text?.trim()) {
      textByItemId.set(normalized.id, normalized.text);
    }
    return;
  }

  if (notification.method !== "rawResponseItem/completed") {
    return;
  }
  const params = asCodexRawResponseItemCompletedNotification(
    notification.params,
  );
  const text = extractCodexRawResponseMessageText(params?.item);
  if (params && text) {
    textByItemId.set(createCodexRawResponseTextKey(params, textByItemId), text);
  }
}

export function extractCodexRawResponseMessageText(
  item: unknown,
): string | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  if (record.type !== "message" || record.role !== "assistant") {
    return null;
  }
  if (!Array.isArray(record.content)) {
    return null;
  }
  const parts = record.content
    .map((contentItem) => {
      if (!contentItem || typeof contentItem !== "object") return "";
      const contentRecord = contentItem as Record<string, unknown>;
      return contentRecord.type === "output_text" &&
        typeof contentRecord.text === "string"
        ? contentRecord.text
        : "";
    })
    .filter((text) => text.length > 0);
  return parts.length > 0 ? parts.join("\n") : null;
}

function getCodexForkSummaryDeveloperInstructions(
  purpose: Extract<SummaryGenerationRequest, { strategy: "fork" }>["purpose"],
): string {
  return purpose === "session-retitle"
    ? "You are a title helper. Reply with the session title only, no preamble. Do not call tools."
    : purpose === "recap"
      ? "You are a recap helper. Reply with the recap text only, no preamble. Do not call tools."
      : "You are a handoff summary helper. Reply with the summary text only, no preamble. Do not call tools.";
}

function createCodexRawResponseTextKey(
  params: RawResponseItemCompletedNotification,
  textByItemId: ReadonlyMap<string, string>,
): string {
  return `raw-${params.turnId}-${textByItemId.size}`;
}
