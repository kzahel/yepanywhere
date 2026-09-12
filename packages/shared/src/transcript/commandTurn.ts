const COMMAND_NAME_RE = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_MESSAGE_RE = /<command-message>[\s\S]*?<\/command-message>/g;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;
const COMMAND_NAME_TAG_RE = /<command-name>[\s\S]*?<\/command-name>/g;
const COMMAND_ARGS_TAG_RE = /<command-args>[\s\S]*?<\/command-args>/g;
const LOCAL_COMMAND_CAVEAT_RE =
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g;
const LOCAL_COMMAND_CAVEAT_ONLY_RE =
  /^(?:\s*<local-command-caveat>[\s\S]*?<\/local-command-caveat>\s*)+$/;
const LOCAL_COMMAND_STDOUT_RE =
  /^\s*<local-command-stdout>([\s\S]*?)<\/local-command-stdout>\s*$/;
const ANSI_ESCAPE_RE = new RegExp(
  `${String.fromCharCode(27)}\\[[\\d;:? ]*[ -/]*[@-~]`,
  "g",
);

export interface CommandTurn {
  /** The slash command, e.g. "/harsh-review". */
  command: string;
  /** Trailing arguments, or "" when the command took none. */
  args: string;
}

/**
 * A slash-command user turn arrives wrapped by Claude Code as
 * `<command-name>/foo</command-name><command-message>…</command-message>
 * <command-args>…</command-args>`. Extract the command and any args so a
 * display surface can render the command itself instead of the raw tags;
 * returns null for an ordinary prose turn (render that verbatim).
 */
export function parseCommandTurn(text: string): CommandTurn | null {
  const command = text.match(COMMAND_NAME_RE)?.[1]?.trim();
  if (!command) return null;
  const unparsed = text
    .replace(LOCAL_COMMAND_CAVEAT_RE, "")
    .replace(COMMAND_NAME_TAG_RE, "")
    .replace(COMMAND_MESSAGE_RE, "")
    .replace(COMMAND_ARGS_TAG_RE, "")
    .trim();
  if (unparsed) return null;
  const args = text.match(COMMAND_ARGS_RE)?.[1]?.trim() ?? "";
  return { command, args };
}

export function formatCommandTurn(commandTurn: CommandTurn): string {
  return commandTurn.args
    ? `${commandTurn.command} ${commandTurn.args}`
    : commandTurn.command;
}

export function isLocalCommandCaveatOnly(text: string): boolean {
  return LOCAL_COMMAND_CAVEAT_ONLY_RE.test(text);
}

export function parseLocalCommandStdout(text: string): string | null {
  const match = text.match(LOCAL_COMMAND_STDOUT_RE);
  return match?.[1]?.replace(ANSI_ESCAPE_RE, "").trim() ?? null;
}

export function isCompactionLocalCommandOutput(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  return normalized === "compacted" || normalized.startsWith("compacted (");
}
