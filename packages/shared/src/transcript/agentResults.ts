import type { ContentBlock } from "./message.js";

/**
 * Parse Agent tool result from text content blocks (SDK 0.2.76+).
 *
 * New SDK embeds agentId and usage stats in text rather than a structured
 * tool_use_result. Example text block:
 *   "agentId: abc123 (for resuming...)\n<usage>total_tokens: 1234\ntool_uses: 5\nduration_ms: 6789</usage>"
 *
 * Returns a TaskResult-shaped object for the renderer, or undefined if not parseable.
 */
export function parseAgentResultFromText(
  block: ContentBlock,
): Record<string, unknown> | undefined {
  // Content may be a string or array of content blocks
  const texts: string[] = [];
  if (typeof block.content === "string") {
    texts.push(block.content);
  } else if (Array.isArray(block.content)) {
    for (const cb of block.content as Array<{ type?: string; text?: string }>) {
      if (cb.type === "text" && cb.text) texts.push(cb.text);
    }
  }

  const fullText = texts.join("\n");
  if (!fullText) return undefined;

  const displayContent = extractAgentDisplayContent(block);

  // Extract agentId
  const agentIdMatch = fullText.match(/^agentId:\s*(\S+)/m);
  if (!agentIdMatch) return undefined;

  const result: Record<string, unknown> = {
    agentId: agentIdMatch[1],
    status: "completed",
  };
  if (displayContent && displayContent.length > 0) {
    result.content = displayContent;
  }

  // Extract usage stats from <usage> block
  const usageMatch = fullText.match(/<usage>([\s\S]*?)<\/usage>/);
  if (usageMatch?.[1]) {
    const usage = usageMatch[1];
    const tokens = usage.match(/total_tokens:\s*(\d+)/);
    const tools = usage.match(/tool_uses:\s*(\d+)/);
    const duration = usage.match(/duration_ms:\s*(\d+)/);
    if (tokens?.[1]) result.totalTokens = Number(tokens[1]);
    if (tools?.[1]) result.totalToolUseCount = Number(tools[1]);
    if (duration?.[1]) result.totalDurationMs = Number(duration[1]);
  }

  return result;
}

function stripAgentMetadata(text: string): string {
  return text
    .replace(/^agentId:\s*\S+.*$/gm, "")
    .replace(/<usage>[\s\S]*?<\/usage>/g, "")
    .trim();
}

function extractAgentDisplayContent(
  block: ContentBlock,
): ContentBlock[] | undefined {
  if (typeof block.content === "string") {
    const text = stripAgentMetadata(block.content);
    return text ? [{ type: "text", text }] : undefined;
  }

  if (!Array.isArray(block.content)) {
    return undefined;
  }

  const displayBlocks: ContentBlock[] = [];
  for (const contentBlock of block.content) {
    if (!contentBlock || typeof contentBlock !== "object") {
      continue;
    }

    if (contentBlock.type === "text" && typeof contentBlock.text === "string") {
      const text = stripAgentMetadata(contentBlock.text);
      if (!text) {
        continue;
      }
      displayBlocks.push({ ...contentBlock, text });
      continue;
    }

    displayBlocks.push(contentBlock as ContentBlock);
  }

  return displayBlocks.length > 0 ? displayBlocks : undefined;
}
