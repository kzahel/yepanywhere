import type { Message } from "../supervisor/types.js";
import type { AntigravityLogWindowRequest } from "./antigravity-log-window.js";
import {
  extractCreatedSubagentId,
  formatSpawnAgentResult,
} from "./antigravity-subagent-links.js";
import type { GetSessionOptions } from "./types.js";

/**
 * How the Antigravity reader turns a detail request into a log window: the
 * route's compact-tail options select a page, anything else is the
 * deliberate complete read.
 */
export function antigravityLogRequest(
  afterMessageId: string | undefined,
  options: GetSessionOptions | undefined,
): AntigravityLogWindowRequest {
  const compactions = options?.tailCompactions;
  if (!compactions || compactions < 1) return { kind: "complete" };
  if (afterMessageId)
    return { kind: "after", messageId: afterMessageId, compactions };
  if (options.beforeMessageId)
    return {
      kind: "before",
      messageId: options.beforeMessageId,
      compactions,
    };
  return { kind: "latest", compactions };
}

/** Whether messages hold a `spawn_agent` call, which needs the lineage read. */
export function antigravityLogSpawnCalls(
  messages: readonly Message[],
): boolean {
  return messages.some(
    (message) =>
      Array.isArray(message.message?.content) &&
      message.message.content.some(
        (block) => block.type === "tool_use" && block.name === "spawn_agent",
      ),
  );
}

/**
 * Rewrites each `invoke_subagent` result in place to the `{agent_id}` form the
 * cold renderer expands and opens, when the child it names is one of
 * `children`: the conversation's direct children, verified against the
 * summaries index's lineage. Calls and results pair by step in the log, so no
 * correlation by arguments is needed; a failed call keeps its own text.
 */
export function linkAntigravityLogChildren(
  messages: readonly Message[],
  children: ReadonlySet<string>,
): void {
  const roles = new Map<string, string | undefined>();
  for (const message of messages)
    if (Array.isArray(message.message?.content))
      for (const block of message.message.content)
        if (block.type === "tool_use" && block.name === "spawn_agent") {
          const input = block.input as { description?: unknown } | undefined;
          roles.set(
            String(block.id),
            typeof input?.description === "string"
              ? input.description
              : undefined,
          );
        }
  if (!roles.size) return;
  for (const message of messages)
    if (Array.isArray(message.message?.content))
      for (const block of message.message.content) {
        if (
          block.type !== "tool_result" ||
          block.is_error ||
          !roles.has(String(block.tool_use_id))
        )
          continue;
        const child = extractCreatedSubagentId(block.content);
        if (child && children.has(child))
          block.content = formatSpawnAgentResult(
            child,
            roles.get(String(block.tool_use_id)),
          );
      }
}
