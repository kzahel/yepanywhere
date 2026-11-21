/**
 * Normalize Gemini CLI tool calls to YA's canonical tool renderer contract.
 *
 * The Gemini CLI names tools `read_file`, `replace` (its edit), `write_file`,
 * `glob`, `search_file_content`, `run_shell_command`, … YA's rich tool renderers
 * key on canonical names (`Read`, `Edit`, `Write`, …) and Claude-style field
 * names. This module maps both so Gemini tool calls reach the rich renderers
 * (and Edit gets the diff augment) instead of the raw-JSON fallback.
 *
 * Historical Gemini transcripts use this mapping during normalization.
 * Tools without a mapping (write_todos, delegate_to_agent, save_memory)
 * keep their original name and input untouched: an unmapped tool stays explicit
 * (raw fallback) rather than being forced into a misleading alias whose field
 * shape the renderer would misread.
 */

export interface NormalizedGeminiTool {
  /** Canonical YA renderer tool name (e.g. "Edit"), or the original name. */
  name: string;
  /** Input with field names mapped to the YA renderer's expectations. */
  input: Record<string, unknown>;
}

/** Gemini CLI tool name -> YA canonical renderer name. */
const GEMINI_TOOL_NAME_MAP: Record<string, string> = {
  read_file: "Read",
  replace: "Edit",
  write_file: "Write",
  glob: "Glob",
  search_file_content: "Grep",
  run_shell_command: "Bash",
};

/**
 * Per-tool input field renames (Gemini field -> YA/Claude field). Most Gemini
 * file tools already use Claude-style fields (`file_path`, `content`, `command`,
 * `pattern`); only `replace` needs renaming.
 */
const GEMINI_TOOL_FIELD_RENAMES: Record<string, Record<string, string>> = {
  replace: { old_content: "old_string", new_content: "new_string" },
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function renameFields(
  input: Record<string, unknown>,
  renames: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[renames[key] ?? key] = value;
  }
  return out;
}

/**
 * Map a Gemini CLI tool name + raw parameters to YA's canonical name + input.
 */
export function normalizeGeminiTool(
  toolName: string | undefined,
  rawInput: unknown,
): NormalizedGeminiTool {
  const original = toolName ?? "unknown";
  const name = GEMINI_TOOL_NAME_MAP[original] ?? original;
  const input = asRecord(rawInput);
  const renames = GEMINI_TOOL_FIELD_RENAMES[original];
  return { name, input: renames ? renameFields(input, renames) : input };
}
