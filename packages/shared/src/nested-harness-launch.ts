/**
 * Nested harness launches: one agent session starting a second harness process
 * from a shell tool call, rather than through the provider's own subagent
 * feature. No sidechain entry exists for that work, so the only durable record
 * of who started it is the launching command text.
 *
 * Contract: topics/nested-harness-launch.md
 */

/** Harness CLIs whose launch arguments YA reads. */
export type NestedHarnessName = "claude";

export interface NestedHarnessLaunch {
  harness: NestedHarnessName;
  /**
   * Session the launched process continues, when the command names one.
   * Absent for a fresh launch, whose new id the harness reports only in its
   * own task output file.
   */
  sessionId?: string;
  /** Directory an earlier `cd` in the same command moved to, when it does. */
  workingDirectory?: string;
}

const HARNESS_NAMES: readonly NestedHarnessName[] = ["claude"];
const HARNESS_NAME_SET = new Set<string>(HARNESS_NAMES);
/** Flags whose UUID value names the session the launched process will write. */
const SESSION_FLAGS = new Set(["--resume", "-r", "--session-id"]);
/** Flags that make the launch a one-shot run rather than an interactive TUI. */
const NON_INTERACTIVE_FLAGS = new Set(["-p", "--print"]);
/** Command prefixes that pass their remaining words through unchanged. */
const TRANSPARENT_PREFIXES = new Set(["env", "nohup", "setsid", "exec"]);
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface HeredocBody {
  delimiter: string;
  stripTabs: boolean;
}

function baseName(word: string): string {
  const slash = word.lastIndexOf("/");
  return slash === -1 ? word : word.slice(slash + 1);
}

/**
 * The heredoc a redirection word opens, or undefined when it is not one.
 * `<<<` is a here-string, which has no body to skip.
 */
function readHeredocOperator(word: string): HeredocBody | undefined {
  if (!word.startsWith("<<") || word.startsWith("<<<")) return undefined;
  const rest = word.slice(2);
  const stripTabs = rest.startsWith("-");
  return { delimiter: stripTabs ? rest.slice(1) : rest, stripTabs };
}

/** Index just past the heredoc body starting at `from`. */
function skipHeredocBody(
  text: string,
  from: number,
  body: HeredocBody,
): number {
  let index = from;
  while (index < text.length) {
    const newline = text.indexOf("\n", index);
    const end = newline === -1 ? text.length : newline;
    let line = text.slice(index, end);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (body.stripTabs) line = line.replace(/^\t+/, "");
    index = newline === -1 ? text.length : newline + 1;
    if (line === body.delimiter) break;
  }
  return index;
}

/**
 * The command's simple commands, each as its argument words with quoting
 * removed. Splitting stops at the ordinary separators and skips heredoc
 * bodies, so command text quoted inside a commit message or a written file
 * cannot be read as an invocation. Words inside a quoted `sh -c` argument stay
 * one word and are deliberately not descended into.
 */
function splitSimpleCommands(
  command: string,
): Array<{ words: string[]; after: string }> {
  const commands: Array<{ words: string[]; after: string }> = [];
  const heredocs: HeredocBody[] = [];
  let words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  let awaitingHeredocDelimiter: { stripTabs: boolean } | undefined;

  const endWord = (): void => {
    if (!started) return;
    const finished = word;
    word = "";
    started = false;
    if (awaitingHeredocDelimiter) {
      heredocs.push({
        delimiter: finished,
        stripTabs: awaitingHeredocDelimiter.stripTabs,
      });
      awaitingHeredocDelimiter = undefined;
      return;
    }
    const heredoc = readHeredocOperator(finished);
    if (heredoc) {
      if (heredoc.delimiter) heredocs.push(heredoc);
      else awaitingHeredocDelimiter = { stripTabs: heredoc.stripTabs };
      return;
    }
    words.push(finished);
  };

  const endCommand = (after = ""): void => {
    endWord();
    if (words.length) commands.push({ words, after });
    words = [];
  };

  let index = 0;
  while (index < command.length) {
    const char = command[index] as string;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else {
        word += char;
        started = true;
      }
      index += 1;
      continue;
    }
    if (quote === '"') {
      if (char === "\\" && index + 1 < command.length) {
        word += command[index + 1];
        started = true;
        index += 2;
        continue;
      }
      if (char === '"') quote = undefined;
      else {
        word += char;
        started = true;
      }
      index += 1;
      continue;
    }
    if (char === "\\") {
      // A line continuation joins the next line onto the current word.
      if (command[index + 1] !== "\n") {
        word += command[index + 1] ?? "";
        started = true;
      }
      index += 2;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      index += 1;
      continue;
    }
    if (char === "#" && !started) {
      // Only an unquoted word-start # begins a shell comment.
      while (index < command.length && command[index] !== "\n") index++;
      continue;
    }
    if (char === "\n") {
      endCommand("\n");
      index += 1;
      while (heredocs.length) {
        index = skipHeredocBody(
          command,
          index,
          heredocs.shift() as HeredocBody,
        );
      }
      continue;
    }
    // `2>&1` and `>&2` duplicate a descriptor; their `&` is not a separator.
    if (char === "&" && (word.endsWith(">") || word.endsWith("<"))) {
      word += char;
      index += 1;
      continue;
    }
    if (
      char === ";" ||
      char === "&" ||
      char === "|" ||
      char === "(" ||
      char === ")" ||
      char === "`"
    ) {
      const double =
        (char === "&" || char === "|") && command[index + 1] === char;
      endCommand(double ? char + char : char);
      index += double ? 2 : 1;
      continue;
    }
    if (char === " " || char === "\t" || char === "\r") {
      endWord();
      index += 1;
      continue;
    }
    word += char;
    started = true;
    index += 1;
  }
  endCommand();
  return commands;
}

function stripTransparentPrefix(words: string[]): string[] {
  let index = 0;
  while (index < words.length) {
    const word = words[index] as string;
    if (ASSIGNMENT_RE.test(word) || TRANSPARENT_PREFIXES.has(baseName(word))) {
      index += 1;
      continue;
    }
    break;
  }
  return words.slice(index);
}

function readHarnessArguments(
  harness: NestedHarnessName,
  args: string[],
): NestedHarnessLaunch | undefined {
  let sessionId: string | undefined;
  let nonInteractive = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = equals > 0 ? arg.slice(0, equals) : arg;
    const attached = equals > 0 ? arg.slice(equals + 1) : undefined;
    if (SESSION_FLAGS.has(flag)) {
      const value = attached ?? args[index + 1];
      if (value && UUID_RE.test(value)) {
        sessionId = value.toLowerCase();
        if (attached === undefined) index += 1;
      }
      continue;
    }
    if (NON_INTERACTIVE_FLAGS.has(flag)) nonInteractive = true;
  }
  if (!sessionId && !nonInteractive) return undefined;
  return sessionId ? { harness, sessionId } : { harness };
}

/**
 * The nested harness session a shell command starts, or undefined when the
 * command is something else. `claude --version` and a mention of `claude` in
 * an argument are both something else: the harness has to be the command word,
 * and it has to either name a session or run non-interactively.
 */
export function detectNestedHarnessLaunch(
  command: string,
): NestedHarnessLaunch | undefined {
  if (!HARNESS_NAMES.some((harness) => command.includes(harness))) {
    return undefined;
  }
  let workingDirectory: string | undefined;
  for (const simpleCommand of splitSimpleCommands(command)) {
    const args = stripTransparentPrefix(simpleCommand.words);
    const name = args[0];
    if (!name) continue;
    if (name === "cd") {
      const target = args[1];
      if (target && !target.startsWith("-")) workingDirectory = target;
      continue;
    }
    if (!HARNESS_NAME_SET.has(baseName(name))) continue;
    const launch = readHarnessArguments(
      baseName(name) as NestedHarnessName,
      args.slice(1),
    );
    if (!launch) continue;
    return workingDirectory ? { ...launch, workingDirectory } : launch;
  }
  return undefined;
}

/**
 * Conservative storage-scoped subset for durable acquisition. The ordinary
 * presentation detector above deliberately recognizes more command shapes.
 * Only an explicit successful `cd` followed by one named invocation can select
 * the inherited store; branching, pipelines, overrides and forks are unknown.
 * This is command evidence, never authenticated creation or proof of success.
 */
export function detectScopedNestedHarnessLaunch(
  command: string,
): NestedHarnessLaunch | undefined {
  return detectScopedLaunch(command, false);
}

/** Explicit native profile selection, separate from the inherited-store subset. */
export interface ExplicitScopedNestedHarnessLaunch extends NestedHarnessLaunch {
  configDirectory: string;
}
export function detectExplicitScopedNestedHarnessLaunch(
  command: string,
): ExplicitScopedNestedHarnessLaunch | undefined {
  const launch = detectScopedLaunch(command, true);
  return launch?.configDirectory
    ? { ...launch, configDirectory: launch.configDirectory }
    : undefined;
}

function literalAbsolutePosixPath(value: string | undefined): value is string {
  return (
    !!value &&
    value.startsWith("/") &&
    value.length <= 4096 &&
    ![...value].some(
      (c) =>
        c.charCodeAt(0) < 32 ||
        c.charCodeAt(0) === 127 ||
        "*?[]{}~".includes(c),
    ) &&
    !value.includes("//") &&
    (value === "/" || !value.endsWith("/")) &&
    !value.split("/").some((part) => part === "." || part === "..")
  );
}

function detectScopedLaunch(
  command: string,
  explicitProfile: boolean,
): (NestedHarnessLaunch & { configDirectory?: string }) | undefined {
  if (
    command.length > 65536 ||
    !command.includes("claude") ||
    /[$`]/.test(command)
  )
    return undefined;
  const commands = splitSimpleCommands(command);
  if (commands[0]?.words.join(" ") === "unset CLAUDECODE") {
    if (![";", "&&", "\n"].includes(commands[0].after)) return undefined;
    commands.shift();
  }
  if (commands.length !== 2) return undefined;
  const [directory, invocation] = commands;
  if (
    directory!.after !== "&&" ||
    directory!.words.length !== 2 ||
    directory!.words[0] !== "cd"
  )
    return undefined;
  const cwd = directory!.words[1]!;
  if (/[$`]/.test(cwd) || !["", "\n"].includes(invocation!.after))
    return undefined;
  const args = stripTransparentPrefix(invocation!.words);
  const prefix = invocation!.words.slice(
    0,
    invocation!.words.length - args.length,
  );
  let configDirectory: string | undefined;
  if (explicitProfile) {
    // The system env executable applies this binding after shell startup and
    // executes an absolute CLI directly. No wrapper shell or other assignment.
    if (
      prefix[0] !== "/usr/bin/env" ||
      !literalAbsolutePosixPath(args[0]) ||
      !literalAbsolutePosixPath(cwd)
    )
      return undefined;
    let cleared = false;
    for (const word of prefix.slice(1)) {
      if (
        word.startsWith("CLAUDE_CONFIG_DIR=") &&
        configDirectory === undefined
      )
        configDirectory = word.slice("CLAUDE_CONFIG_DIR=".length);
      else if (word === "CLAUDECODE=" && !cleared) cleared = true;
      else return undefined;
    }
    if (!literalAbsolutePosixPath(configDirectory)) return undefined;
  } else if (
    prefix.some((word) => ASSIGNMENT_RE.test(word) && word !== "CLAUDECODE=")
  )
    return undefined;
  let names = 0;
  for (const arg of args.slice(1)) {
    if (arg.startsWith("-") && !arg.startsWith("--") && arg.length > 2)
      return undefined;
    const flag = arg.split("=", 1)[0]!;
    if (SESSION_FLAGS.has(flag)) names++;
    if (
      [
        "--help",
        "-h",
        "--version",
        "-v",
        "--no-session-persistence",
        "--fork-session",
        "--continue",
        "-c",
        "--worktree",
        "-w",
        "--settings",
        "--setting-sources",
        "--cwd",
        "--",
      ].includes(flag)
    )
      return undefined;
  }
  if (names !== 1) return undefined;
  const launch = detectNestedHarnessLaunch(command);
  return launch?.sessionId
    ? { ...launch, ...(configDirectory ? { configDirectory } : {}) }
    : undefined;
}
