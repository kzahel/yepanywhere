import type {
  ClaudeSessionEntry,
  CodexEventMsgEntry,
  CodexFunctionCallOutputPayload,
  CodexFunctionCallPayload,
  CodexMessagePayload,
  CodexReasoningPayload,
  CodexResponseItemEntry,
  CodexSessionEntry,
  GeminiAssistantMessage,
  GeminiSessionMessage,
  GeminiUserMessage,
  OpenCodeSessionEntry,
  OpenCodeStoredPart,
  UnifiedSession,
} from "@yep-anywhere/shared";
import { getMessageContent, isConversationEntry } from "@yep-anywhere/shared";
import type { ContentBlock, Message, Session } from "../supervisor/types.js";
import {
  buildDag,
  collectAllToolResultIds,
  findOrphanedToolUses,
} from "./dag.js";
import type { LoadedSession } from "./types.js";

interface CodexPendingCall {
  name: string;
  arguments: string;
  timestamp: string;
}

/**
 * Normalize a UnifiedSession into the generic Session format expected by the frontend.
 */
export function normalizeSession(loaded: LoadedSession): Session {
  const { summary, data } = loaded;

  switch (data.provider) {
    case "claude": {
      // Claude sessions are stored as raw messages in the session file.
      // We need to build the DAG to find the active branch.
      const rawMessages = data.session.messages;

      // Build DAG and get active branch (filters out dead branches)
      const { activeBranch } = buildDag(rawMessages);

      // Collect all tool_result IDs from the entire session (not just active branch)
      // This handles parallel tool calls where results may be on sibling branches
      const allToolResultIds = collectAllToolResultIds(rawMessages);

      // Find tool_uses on active branch that have no matching tool_result anywhere
      const orphanedToolUses = findOrphanedToolUses(
        activeBranch,
        allToolResultIds,
      );

      // Convert to Message objects (only active branch)
      const messages: Message[] = activeBranch.map((node, index) =>
        convertClaudeMessage(node.raw, index, orphanedToolUses),
      );

      return {
        ...summary,
        messages,
      };
    }
    case "codex":
    case "codex-oss":
      return {
        ...summary,
        messages: convertCodexEntries(data.session.entries),
      };
    case "gemini":
      return {
        ...summary,
        messages: convertGeminiMessages(data.session.messages),
      };
    case "opencode":
      return {
        ...summary,
        messages: convertOpenCodeEntries(data.session.messages),
      };
  }
}

// --- Claude Conversion Logic ---

function convertClaudeMessage(
  raw: ClaudeSessionEntry,
  _index: number,
  orphanedToolUses: Set<string>,
): Message {
  // Normalize content blocks - pass through all fields
  let content: string | ContentBlock[] | undefined;
  const rawContent = getMessageContent(raw);
  if (typeof rawContent === "string") {
    content = rawContent;
  } else if (Array.isArray(rawContent)) {
    // Pass through all fields from each content block
    // Filter out string items (which can appear in user message content)
    content = rawContent
      .filter((block) => typeof block !== "string")
      .map((block) => ({ ...(block as object) })) as ContentBlock[];
  }

  // Build message by spreading all raw fields, then override with normalized values
  // Use type assertion since we're converting to a looser Message type
  const rawAny = raw as Record<string, unknown>;
  const message: Message = {
    ...rawAny,
    // Include normalized content if message had content
    ...(isConversationEntry(raw) && {
      message: {
        ...(raw.message as Record<string, unknown>),
        ...(content !== undefined && { content }),
      },
    }),
    // Ensure type is set
    type: raw.type,
  };

  // Identify orphaned tool_use IDs in this message's content
  if (Array.isArray(content)) {
    const orphanedIds = content
      .filter(
        (b): b is ContentBlock & { id: string } =>
          b.type === "tool_use" &&
          typeof b.id === "string" &&
          orphanedToolUses.has(b.id),
      )
      .map((b) => b.id);

    if (orphanedIds.length > 0) {
      message.orphanedToolUseIds = orphanedIds;
    }
  }

  return message;
}

// --- Codex Conversion Logic ---

function convertCodexEntries(entries: CodexSessionEntry[]): Message[] {
  const messages: Message[] = [];
  let messageIndex = 0;
  const hasResponseItemUser = hasCodexResponseItemUserMessages(entries);

  // Track function calls for pairing with outputs
  const pendingCalls = new Map<string, CodexPendingCall>();

  for (const entry of entries) {
    if (entry.type === "response_item") {
      const msg = convertCodexResponseItem(entry, messageIndex++, pendingCalls);
      if (msg) {
        messages.push(msg);
      }
    } else if (entry.type === "event_msg") {
      // Only process user_message events - agent_message events are
      // duplicates of the response_item data (streaming tokens)
      if (entry.payload.type === "user_message" && !hasResponseItemUser) {
        const msg = convertCodexEventMsg(entry, messageIndex++);
        if (msg) {
          messages.push(msg);
        }
      }
    }
  }

  return messages;
}

function hasCodexResponseItemUserMessages(
  entries: CodexSessionEntry[],
): boolean {
  return entries.some(
    (entry) =>
      entry.type === "response_item" &&
      entry.payload.type === "message" &&
      entry.payload.role === "user",
  );
}

function convertCodexResponseItem(
  entry: CodexResponseItemEntry,
  index: number,
  pendingCalls: Map<string, CodexPendingCall>,
): Message | null {
  const payload = entry.payload;
  const uuid = `codex-${index}-${entry.timestamp}`;

  switch (payload.type) {
    case "message":
      return convertCodexMessagePayload(payload, uuid, entry.timestamp);

    case "reasoning":
      return convertCodexReasoningPayload(payload, uuid, entry.timestamp);

    case "function_call":
      pendingCalls.set(payload.call_id, {
        name: payload.name,
        arguments: payload.arguments,
        timestamp: entry.timestamp,
      });
      return convertCodexFunctionCallPayload(payload, uuid, entry.timestamp);

    case "function_call_output":
      return convertCodexFunctionCallOutputPayload(
        payload,
        uuid,
        entry.timestamp,
      );

    case "ghost_snapshot":
      return null;

    default:
      return null;
  }
}

function convertCodexMessagePayload(
  payload: CodexMessagePayload,
  uuid: string,
  timestamp: string,
): Message {
  const fullText = payload.content.map((c) => c.text).join("");

  if (!fullText.trim()) {
    return {
      uuid,
      type: payload.role,
      message: {
        role: payload.role,
        content: [],
      },
      timestamp,
    };
  }

  const content: ContentBlock[] = [
    {
      type: "text",
      text: fullText,
    },
  ];

  return {
    uuid,
    type: payload.role,
    message: {
      role: payload.role,
      content,
    },
    timestamp,
  };
}

function convertCodexReasoningPayload(
  payload: CodexReasoningPayload,
  uuid: string,
  timestamp: string,
): Message {
  const summaryText = payload.summary
    ?.map((s) => s.text)
    .join("\n")
    .trim();

  const content: ContentBlock[] = [];

  if (summaryText) {
    content.push({
      type: "thinking",
      thinking: summaryText,
    });
  }

  if (payload.encrypted_content) {
    content.push({
      type: "text",
      text: "[Encrypted reasoning content]",
    });
  }

  return {
    uuid,
    type: "assistant",
    message: {
      role: "assistant",
      content,
    },
    timestamp,
  };
}

function convertCodexFunctionCallPayload(
  payload: CodexFunctionCallPayload,
  uuid: string,
  timestamp: string,
): Message {
  let input: unknown;
  try {
    input = JSON.parse(payload.arguments);
  } catch {
    input = { raw: payload.arguments };
  }

  const content: ContentBlock[] = [
    {
      type: "tool_use",
      id: payload.call_id,
      name: payload.name,
      input,
    },
  ];

  return {
    uuid,
    type: "assistant",
    message: {
      role: "assistant",
      content,
    },
    timestamp,
  };
}

function convertCodexFunctionCallOutputPayload(
  payload: CodexFunctionCallOutputPayload,
  uuid: string,
  timestamp: string,
): Message {
  return {
    uuid,
    type: "tool_result",
    toolUseResult: {
      tool_use_id: payload.call_id,
      content: payload.output,
    },
    timestamp,
  };
}

function convertCodexEventMsg(
  entry: CodexEventMsgEntry,
  index: number,
): Message | null {
  const payload = entry.payload;
  const uuid = `codex-event-${index}-${entry.timestamp}`;

  switch (payload.type) {
    case "user_message":
      return {
        uuid,
        type: "user",
        message: {
          role: "user",
          content: payload.message,
        },
        timestamp: entry.timestamp,
      };

    case "agent_message":
      return {
        uuid,
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: payload.message }],
        },
        timestamp: entry.timestamp,
      };

    case "agent_reasoning":
      return {
        uuid,
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: payload.text }],
        },
        timestamp: entry.timestamp,
      };

    default:
      return null;
  }
}

// --- Gemini Conversion Logic ---

function convertGeminiMessages(
  sessionMessages: GeminiSessionMessage[],
): Message[] {
  const messages: Message[] = [];
  for (const msg of sessionMessages) {
    if (msg.type === "user") {
      const userMsg = msg as GeminiUserMessage;
      messages.push({
        uuid: userMsg.id,
        type: "user",
        message: {
          role: "user",
          content: userMsg.content,
        },
        timestamp: userMsg.timestamp,
      });
    } else if (msg.type === "gemini") {
      const assistantMsg = msg as GeminiAssistantMessage;
      const content: ContentBlock[] = [];

      if (assistantMsg.thoughts) {
        for (const thought of assistantMsg.thoughts) {
          content.push({
            type: "thinking",
            thinking: `${thought.subject}: ${thought.description}`,
          });
        }
      }

      if (assistantMsg.content) {
        content.push({
          type: "text",
          text: assistantMsg.content,
        });
      }

      if (assistantMsg.toolCalls) {
        for (const toolCall of assistantMsg.toolCalls) {
          content.push({
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.args,
          });
        }
      }

      messages.push({
        uuid: assistantMsg.id,
        type: "assistant",
        message: {
          role: "assistant",
          content,
        },
        timestamp: assistantMsg.timestamp,
      });

      if (assistantMsg.toolCalls) {
        for (const toolCall of assistantMsg.toolCalls) {
          if (toolCall.result && toolCall.result.length > 0) {
            for (const result of toolCall.result) {
              messages.push({
                uuid: `${assistantMsg.id}-result-${result.functionResponse.id}`,
                type: "tool_result",
                toolUseResult: {
                  tool_use_id: result.functionResponse.id,
                  content: result.functionResponse.response.output,
                },
                timestamp: toolCall.timestamp ?? assistantMsg.timestamp,
              });
            }
          }
        }
      }
    }
  }
  return messages;
}

// --- OpenCode Conversion Logic ---

function convertOpenCodeEntries(entries: OpenCodeSessionEntry[]): Message[] {
  const messages: Message[] = [];

  for (const entry of entries) {
    const { message, parts } = entry;
    const uuid = message.id;
    const timestamp = message.time?.created
      ? new Date(message.time.created).toISOString()
      : undefined;

    const content = convertOpenCodeParts(parts);

    messages.push({
      uuid,
      type: message.role,
      message: {
        role: message.role,
        content,
        model: message.modelID,
        usage: message.tokens
          ? {
              input_tokens: message.tokens.input,
              output_tokens: message.tokens.output,
              cache_read_input_tokens: message.tokens.cache?.read,
            }
          : undefined,
      },
      timestamp,
      // Include OpenCode-specific fields
      ...(message.parentID && { parentId: message.parentID }),
      ...(message.mode && { mode: message.mode }),
      ...(message.agent && { agent: message.agent }),
      ...(message.finish && { finish: message.finish }),
    });
  }

  return messages;
}

function convertOpenCodeParts(parts: OpenCodeStoredPart[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  for (const part of parts) {
    switch (part.type) {
      case "text":
        if (part.text) {
          blocks.push({
            type: "text",
            text: part.text,
          });
        }
        break;

      case "tool":
        if (part.tool && part.callID) {
          // Tool use block
          blocks.push({
            type: "tool_use",
            id: part.callID,
            name: part.tool,
            input: part.state?.input ?? {},
          });

          // If tool has completed, add tool result block
          if (part.state?.status === "completed") {
            const resultContent = part.state.error
              ? part.state.error
              : typeof part.state.output === "string"
                ? part.state.output
                : JSON.stringify(part.state.output ?? "");

            blocks.push({
              type: "tool_result",
              tool_use_id: part.callID,
              content: resultContent,
              is_error: !!part.state.error,
            });
          }
        }
        break;

      // Skip step-start and step-finish (metadata, not content)
      case "step-start":
      case "step-finish":
        break;

      default:
        // Unknown part type - skip
        break;
    }
  }

  return blocks;
}
