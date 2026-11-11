import {
  type CodexEventMsgEntry,
  type CodexMessagePayload,
  type CodexResponseItemEntry,
  type CodexSessionEntry,
  MCP_APP_CONTEXT_CLOSE,
  MCP_APP_CONTEXT_OPEN,
} from "@yep-anywhere/shared";
import { stripAgentApiBootstrapPrefix } from "@yep-anywhere/shared/agent-api-bootstrap";

/**
 * Codex uses response-message role=user for both accepted human input and
 * provider-injected model context. Accepted input is persisted immediately
 * before its user-turn event; context responses have no such witness.
 * See topics/codex-user-turn-provenance.md.
 */
export type CodexUserResponseKind =
  | "user-authored"
  | "visible-provider-context"
  | "hidden-provider-context"
  | "legacy-unknown";

export type CodexUserResponseEntry = CodexResponseItemEntry & {
  payload: CodexMessagePayload & { role: "user" };
};

type CodexLegacyUserMessageEventEntry = CodexEventMsgEntry & {
  payload: Extract<CodexEventMsgEntry["payload"], { type: "user_message" }>;
};

interface CodexCompletedUserMessageItem {
  type: "UserMessage";
  id: string;
  client_id?: string | null;
  content: unknown[];
}

type CodexCompletedUserMessageEventEntry = CodexEventMsgEntry & {
  payload: Extract<
    CodexEventMsgEntry["payload"],
    { type: "item_completed" }
  > & {
    item: CodexCompletedUserMessageItem;
  };
};

export type CodexUserMessageEventEntry =
  | CodexLegacyUserMessageEventEntry
  | CodexCompletedUserMessageEventEntry;

export interface CodexUserTurnProvenance {
  readonly hasUserMessageEvents: boolean;
  readonly responseKinds: ReadonlyMap<
    CodexUserResponseEntry,
    CodexUserResponseKind
  >;
  readonly pairedEventByResponse: ReadonlyMap<
    CodexUserResponseEntry,
    CodexUserMessageEventEntry
  >;
  readonly pairedUserEvents: ReadonlySet<CodexUserMessageEventEntry>;
}

export interface CodexFirstUserTurn {
  text: string;
  response?: CodexUserResponseEntry;
  event?: CodexUserMessageEventEntry;
  source: "paired" | "event-only" | "legacy-response";
}

const MARKED_CONTEXT_FRAGMENTS: ReadonlyArray<
  readonly [open: string, close: string]
> = [
  ["# AGENTS.md instructions", "</INSTRUCTIONS>"],
  ["<environment_context>", "</environment_context>"],
  ["<recommended_plugins>", "</recommended_plugins>"],
  ["<skill>", "</skill>"],
  ["<user_shell_command>", "</user_shell_command>"],
  ["<turn_aborted>", "</turn_aborted>"],
  ["<subagent_notification>", "</subagent_notification>"],
  ["<goal_context>", "</goal_context>"],
  [MCP_APP_CONTEXT_OPEN, MCP_APP_CONTEXT_CLOSE],
];

const CODEX_STARTUP_INSTRUCTIONS_RE =
  /^(?:<recommended_plugins>[\s\S]*?<\/recommended_plugins>\s*)?# AGENTS\.md instructions for /u;

export function isCodexUserResponseEntry(
  entry: CodexSessionEntry | undefined,
): entry is CodexUserResponseEntry {
  return (
    entry?.type === "response_item" &&
    entry.payload.type === "message" &&
    entry.payload.role === "user"
  );
}

export function isCodexUserMessageEventEntry(
  entry: CodexSessionEntry | undefined,
): entry is CodexUserMessageEventEntry {
  if (entry?.type !== "event_msg") return false;
  if (entry.payload.type === "user_message") return true;
  if (entry.payload.type !== "item_completed") return false;

  const item = entry.payload.item;
  return (
    !!item &&
    typeof item === "object" &&
    (item as { type?: unknown }).type === "UserMessage" &&
    typeof (item as { id?: unknown }).id === "string" &&
    Array.isArray((item as { content?: unknown }).content)
  );
}

export function codexUserMessageEventText(
  entry: CodexUserMessageEventEntry,
): string {
  if (entry.payload.type === "user_message") {
    return stripAgentApiBootstrapPrefix(entry.payload.message).trim();
  }

  return stripAgentApiBootstrapPrefix(
    entry.payload.item.content
      .map((block) => {
        if (!block || typeof block !== "object") return "";
        const text = (block as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .join("\n"),
  ).trim();
}

export function codexUserMessageEventClientId(
  entry: CodexUserMessageEventEntry,
): string | undefined {
  const clientId =
    entry.payload.type === "user_message"
      ? entry.payload.client_id
      : entry.payload.item.client_id;
  return typeof clientId === "string" && clientId ? clientId : undefined;
}

export function codexUserMessageEventItemId(
  entry: CodexUserMessageEventEntry,
): string | undefined {
  return entry.payload.type === "item_completed"
    ? entry.payload.item.id
    : undefined;
}

export function codexUserResponseText(
  payload: CodexMessagePayload,
  separator = "\n",
): string {
  return stripAgentApiBootstrapPrefix(
    payload.content
      .map((block) =>
        "text" in block && typeof block.text === "string" ? block.text : "",
      )
      .join(separator),
  ).trim();
}

export function isCodexStartupInstructionText(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    CODEX_STARTUP_INSTRUCTIONS_RE.test(trimmed) &&
    trimmed.includes("<INSTRUCTIONS>")
  );
}

function matchesMarkedText(text: string, open: string, close: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.slice(0, open.length).toLowerCase() === open.toLowerCase() &&
    trimmed.slice(-close.length).toLowerCase() === close.toLowerCase()
  );
}

function matchesExternalContext(text: string): boolean {
  const trimmed = text.trim();
  const match = /^<external_([a-zA-Z0-9_-]+)>/u.exec(trimmed);
  return !!match?.[1] && trimmed.endsWith(`</external_${match[1]}>`);
}

function matchesInternalModelContext(text: string): boolean {
  const trimmed = text.trim();
  return (
    /^<codex_internal_context source="[a-z][a-z0-9_]*">/u.test(trimmed) &&
    trimmed.endsWith("</codex_internal_context>")
  );
}

function isLegacyContextWarning(text: string): boolean {
  const trimmed = text.trim();
  return (
    (trimmed.startsWith("Warning: apply_patch was requested via ") &&
      trimmed.endsWith("Use the apply_patch tool instead of exec_command.")) ||
    trimmed.startsWith(
      "Warning: The maximum number of unified exec processes you can keep open is",
    ) ||
    trimmed.startsWith(
      "Warning: Your account was flagged for potentially high-risk cyber activity",
    )
  );
}

function isContextualTextBlock(text: string): boolean {
  if (
    MARKED_CONTEXT_FRAGMENTS.some(([open, close]) =>
      matchesMarkedText(text, open, close),
    )
  ) {
    return true;
  }

  if (
    isCodexStartupInstructionText(text) ||
    matchesExternalContext(text) ||
    matchesInternalModelContext(text) ||
    isLegacyContextWarning(text)
  ) {
    return true;
  }

  // Preserve compatibility with early/incomplete environment fixtures and
  // startup rows that predate paired closing-tag validation. A paired real
  // user turn always wins over this fallback.
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<environment_context>") ||
    trimmed.startsWith("# AGENTS.md instructions")
  );
}

export function isCodexContextualUserResponse(
  payload: CodexMessagePayload,
): boolean {
  const textBlocks = payload.content.filter(
    (block): block is typeof block & { text: string } =>
      "text" in block && typeof block.text === "string",
  );
  if (textBlocks.some((block) => isContextualTextBlock(block.text))) {
    return true;
  }

  // Older Codex versions sometimes flattened adjacent startup fragments into
  // one input_text block. Keep that compatibility path out of the primary
  // event-pair classifier.
  return isCodexStartupInstructionText(codexUserResponseText(payload, ""));
}

export function isCodexVisibleProviderUserResponse(
  payload: CodexMessagePayload,
): boolean {
  const textBlocks = payload.content.filter(
    (block): block is typeof block & { text: string } =>
      "text" in block && typeof block.text === "string",
  );
  return (
    textBlocks.length > 0 &&
    textBlocks.every((block) =>
      matchesMarkedText(block.text, "<hook_prompt", "</hook_prompt>"),
    )
  );
}

export function classifyCodexUserResponse(
  entry: CodexUserResponseEntry,
  nextEntry: CodexSessionEntry | undefined,
  hasUserMessageEvents: boolean,
): CodexUserResponseKind {
  if (isCodexUserMessageEventEntry(nextEntry)) {
    return "user-authored";
  }
  if (isCodexVisibleProviderUserResponse(entry.payload)) {
    return "visible-provider-context";
  }
  if (hasUserMessageEvents || isCodexContextualUserResponse(entry.payload)) {
    return "hidden-provider-context";
  }
  return "legacy-unknown";
}

export function buildCodexUserTurnProvenance(
  entries: readonly CodexSessionEntry[],
): CodexUserTurnProvenance {
  const hasUserMessageEvents = entries.some((entry) =>
    isCodexUserMessageEventEntry(entry),
  );
  const responseKinds = new Map<
    CodexUserResponseEntry,
    CodexUserResponseKind
  >();
  const pairedEventByResponse = new Map<
    CodexUserResponseEntry,
    CodexUserMessageEventEntry
  >();
  const pairedUserEvents = new Set<CodexUserMessageEventEntry>();

  entries.forEach((entry, index) => {
    if (!isCodexUserResponseEntry(entry)) {
      return;
    }

    const nextEntry = entries[index + 1];
    const kind = classifyCodexUserResponse(
      entry,
      nextEntry,
      hasUserMessageEvents,
    );
    responseKinds.set(entry, kind);
    if (kind === "user-authored" && isCodexUserMessageEventEntry(nextEntry)) {
      pairedEventByResponse.set(entry, nextEntry);
      pairedUserEvents.add(nextEntry);
    }
  });

  return {
    hasUserMessageEvents,
    responseKinds,
    pairedEventByResponse,
    pairedUserEvents,
  };
}

export function findFirstCodexUserTurn(
  entries: readonly CodexSessionEntry[],
  provenance = buildCodexUserTurnProvenance(entries),
): CodexFirstUserTurn | null {
  for (const entry of entries) {
    if (isCodexUserResponseEntry(entry)) {
      const kind = provenance.responseKinds.get(entry);
      if (kind === "user-authored") {
        const event = provenance.pairedEventByResponse.get(entry);
        if (!event) continue;
        const text =
          codexUserMessageEventText(event) ||
          codexUserResponseText(entry.payload);
        if (text) {
          return { text, response: entry, event, source: "paired" };
        }
      } else if (kind === "legacy-unknown") {
        const text = codexUserResponseText(entry.payload);
        if (text) {
          return { text, response: entry, source: "legacy-response" };
        }
      }
      continue;
    }

    if (
      isCodexUserMessageEventEntry(entry) &&
      !provenance.pairedUserEvents.has(entry)
    ) {
      const text = codexUserMessageEventText(entry);
      if (text) {
        return { text, event: entry, source: "event-only" };
      }
    }
  }

  return null;
}

export function countCodexUserTurns(
  entries: readonly CodexSessionEntry[],
  provenance = buildCodexUserTurnProvenance(entries),
): number {
  let count = 0;
  for (const entry of entries) {
    if (isCodexUserResponseEntry(entry)) {
      const kind = provenance.responseKinds.get(entry);
      if (kind === "user-authored" || kind === "legacy-unknown") {
        count += 1;
      }
    } else if (
      isCodexUserMessageEventEntry(entry) &&
      !provenance.pairedUserEvents.has(entry)
    ) {
      count += 1;
    }
  }
  return count;
}
