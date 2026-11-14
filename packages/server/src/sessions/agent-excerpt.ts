/**
 * Recent-activity excerpt helpers for the session hover card: derive the "last
 * regular agent turn" line shown beneath the meta row. Shared so every path
 * (the Claude summary/fast-scan and the provider-independent normalized-message
 * path) produces identical output. See topics/session-hovercard-recent-activity.md.
 */
import {
  isIdeMetadata,
  isSyntheticNoResponseTurn,
  stripIdeMetadata,
} from "@yep-anywhere/shared";
import type { Message } from "../supervisor/types.js";

// The excerpt keeps the last nonblank lines of the latest visible turn (where
// an agent's conclusion/question lands) and caps length, so the session index
// stays small. The cap clips the end, never the beginning: a leading ellipsis
// plus the client's own visual clamp makes the preview look like a random
// middle slice.
const AGENT_EXCERPT_MAX_LINES = 3;
const AGENT_EXCERPT_MAX_CHARS = 500;
const RECAP_HINT_SUFFIX = /\s*\(disable recaps in \/config\)\s*$/u;

/**
 * Conservative markdown de-noise for one line: drop a leading list/heading/
 * quote marker and strip bold/backtick clutter that reads as noise in a
 * tooltip. Single `*`/`_` are left alone to avoid mangling prose and
 * identifiers — full markdown rendering is deliberately out of scope here.
 */
function stripLightMarkdown(line: string): string {
  return line
    .replace(/^\s{0,3}(?:[-*+]\s+|#{1,6}\s+|\d+\.\s+|>\s?)/, "")
    .replace(/\*\*/g, "")
    .replace(/`+/g, "");
}

/**
 * Reduce raw agent-turn text to the hover-card excerpt: strip IDE metadata,
 * lightly strip markdown, collapse blank lines, keep the last few lines, and
 * cap length by clipping the end. Returns "" when there is no displayable prose.
 */
export function formatAgentExcerpt(raw: string): string {
  const lines = stripIdeMetadata(raw)
    .split("\n")
    .map((line) => stripLightMarkdown(line).trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return "";
  let excerpt = lines.slice(-AGENT_EXCERPT_MAX_LINES).join("\n").trim();
  if (excerpt.length > AGENT_EXCERPT_MAX_CHARS) {
    excerpt = `${excerpt.slice(0, AGENT_EXCERPT_MAX_CHARS).trimEnd()}…`;
  }
  return excerpt;
}

export function formatAgentRecapExcerpt(raw: string): string {
  return formatAgentExcerpt(raw.replace(RECAP_HINT_SUFFIX, ""));
}

/**
 * Pull the prose text and the first tool name from an assistant message's
 * content (string or block array), skipping IDE metadata. Works on both raw
 * Claude entries and the normalized cross-provider `Message` content, which
 * share the `{ type: "text", text }` / `{ type: "tool_use", name }` block shape.
 */
export function assistantContentParts(content: unknown): {
  text: string;
  toolName?: string;
} {
  if (content == null) return { text: "" };
  if (typeof content === "string") return { text: content };
  if (!Array.isArray(content)) return { text: "" };
  const blocks = content as Array<{
    type?: string;
    text?: string;
    name?: string;
  }>;
  const text = blocks
    .filter(
      (b): b is { type: "text"; text: string } =>
        b?.type === "text" &&
        typeof b.text === "string" &&
        !isIdeMetadata(b.text),
    )
    .map((b) => b.text)
    .join("\n");
  const tool = blocks.find(
    (b) => b?.type === "tool_use" && typeof b.name === "string",
  );
  return { text, toolName: tool?.name };
}

function textContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const typed = block as { type?: string; text?: string };
      return typed?.type === "text" && typeof typed.text === "string"
        ? typed.text
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function systemAwaySummaryExcerpt(entry: unknown): string | undefined {
  const typed = entry as
    | {
        type?: unknown;
        subtype?: unknown;
        content?: unknown;
        message?: { role?: unknown; subtype?: unknown; content?: unknown };
      }
    | null
    | undefined;
  if (!typed || typeof typed !== "object") return undefined;
  const isAwaySummary =
    (typed.type === "system" && typed.subtype === "away_summary") ||
    (typed.message?.role === "system" &&
      typed.message?.subtype === "away_summary");
  if (!isAwaySummary) return undefined;
  const excerpt = formatAgentRecapExcerpt(
    textContent(typed.content ?? typed.message?.content),
  );
  return excerpt || undefined;
}

/**
 * Provider-independent recent-activity excerpt from normalized messages (the
 * uniform `Message[]` every provider's reader produces via `normalizeSession`).
 * Scans backward for the latest provider recap or assistant message carrying
 * visible prose; falls back to an earlier text block, then to a "⚙ <tool>"
 * label when the latest turns are tool-only. Mirrors the Claude fast path so
 * output is identical across providers.
 */
export function extractLastAgentExcerpt(
  messages: Message[],
): string | undefined {
  const { prose, trailingTool } = scanAgentExcerpt(messages);
  return prose ?? toolExcerpt(trailingTool);
}

export function toolExcerpt(toolName: string | undefined): string | undefined {
  return toolName ? `⚙ ${toolName}` : undefined;
}

/**
 * The two halves of the excerpt rule, kept apart for bounded readers: `prose`
 * is final wherever it is found, while `trailingTool` only becomes the answer
 * once the scan has covered the whole history and found no prose.
 */
export function scanAgentExcerpt(messages: Message[]): {
  prose?: string;
  trailingTool?: string;
} {
  let trailingTool: string | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const awaySummary = systemAwaySummaryExcerpt(m);
    if (awaySummary) return { prose: awaySummary };
    const isAssistant =
      m?.type === "assistant" || m?.message?.role === "assistant";
    if (!isAssistant) continue;
    // No model produced this text, so quoting it would attribute a reply to
    // the agent that it never gave.
    if (isSyntheticNoResponseTurn(m)) continue;
    const { text, toolName } = assistantContentParts(m.message?.content);
    const excerpt = formatAgentExcerpt(text);
    if (excerpt) return { prose: excerpt };
    if (!trailingTool && toolName) trailingTool = toolName;
  }
  return trailingTool ? { trailingTool } : {};
}
