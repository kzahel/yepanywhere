import type { AgentContent, AgentContentMap } from "../hooks/useSession";
import type { Message } from "../types";

/**
 * Check if a message is from a subagent (Task tool).
 * Subagent messages have isSubagent: true set by the server.
 */
export function isSubagentMessage(msg: {
  isSubagent?: boolean;
  session_id?: string;
}): boolean {
  return msg.isSubagent === true && typeof msg.session_id === "string";
}

/**
 * Extract the agentId from a subagent message.
 * The agentId is the session_id of the subagent.
 */
export function extractAgentId(msg: { session_id?: string }): string | null {
  return typeof msg.session_id === "string" ? msg.session_id : null;
}

/**
 * Add a message to the agent content map.
 * Returns a new map with the message added (immutable update).
 * Deduplicates by message ID.
 */
export function addMessageToAgentContent(
  agentContent: AgentContentMap,
  agentId: string,
  message: Message,
): AgentContentMap {
  const existing = agentContent[agentId] ?? {
    messages: [],
    status: "running" as const,
  };

  // Dedupe by message ID
  if (existing.messages.some((m) => m.id === message.id)) {
    return agentContent;
  }

  return {
    ...agentContent,
    [agentId]: {
      ...existing,
      messages: [...existing.messages, message],
      status: "running",
    },
  };
}

/**
 * Group messages by agentId.
 * Useful for organizing subagent messages from a flat list.
 */
export function groupMessagesByAgentId(
  messages: Array<Message & { session_id?: string }>,
): AgentContentMap {
  const result: AgentContentMap = {};

  for (const msg of messages) {
    const agentId = extractAgentId(msg);
    if (!agentId) continue;

    if (!result[agentId]) {
      result[agentId] = { messages: [], status: "running" };
    }
    result[agentId].messages.push(msg);
  }

  return result;
}

/**
 * Update the status of an agent based on tool_result.
 * Call this when a Task tool_result is received to mark the agent as completed/failed.
 */
export function updateAgentStatus(
  agentContent: AgentContentMap,
  agentId: string,
  status: AgentContent["status"],
): AgentContentMap {
  const existing = agentContent[agentId];
  if (!existing) return agentContent;

  return {
    ...agentContent,
    [agentId]: {
      ...existing,
      status,
    },
  };
}
