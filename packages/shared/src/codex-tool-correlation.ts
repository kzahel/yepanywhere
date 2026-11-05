/**
 * Ephemeral correlation metadata for Codex tool messages whose live
 * app-server event and durable rollout item use different provider identities.
 *
 * This metadata travels with YA's in-memory/API message representation only.
 * The rollout remains the sole durable transcript source of truth.
 */

export const CODEX_TOOL_CORRELATION_FIELD = "_codexToolCorrelation";

/**
 * Decode one literal POSIX shell wrapper from a Codex commandExecution item.
 * Extra arguments, operators and outer-shell expansion remain unknown. This
 * compares presentation identities; it is not proof of launch or authority.
 */
export function unwrapCodexCommandExecutionShell(
  command: string,
): string | null {
  if (command.includes("\0")) return null;
  const words: string[] = [];
  let word = "",
    started = false;
  let quote: "'" | '"' | undefined;
  const finish = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === "\\") {
        const next = command[++index];
        if (next === undefined) return null;
        if (next !== "\n") {
          // In double quotes POSIX only removes these particular escapes.
          word +=
            next === "$" ||
            next.charCodeAt(0) === 96 ||
            next === '"' ||
            next === "\\"
              ? next
              : "\\" + next;
        }
      } else {
        if (char === "$" || char.charCodeAt(0) === 96) return null;
        word += char;
      }
      continue;
    }
    if (char === " " || char === "\t") {
      finish();
      if (words.length > 3) return null;
    } else if (char === "'" || char === '"') {
      started = true;
      quote = char;
    } else if (char === "\\") {
      const next = command[++index];
      if (next === undefined) return null;
      if (next !== "\n") {
        word += next;
        started = true;
      }
    } else {
      if (
        char === "\n" ||
        char === "\r" ||
        char.charCodeAt(0) === 96 ||
        ";&|()<>$#*?[]{}~!".includes(char)
      )
        return null;
      word += char;
      started = true;
    }
  }
  if (quote) return null;
  finish();
  const executable = words[0],
    flag = words[1];
  if (!executable || words.length !== 3 || (flag !== "-c" && flag !== "-lc"))
    return null;
  const name = executable.split("/").at(-1);
  if (
    !["sh", "bash", "dash", "zsh"].includes(name ?? "") ||
    (!executable.startsWith("/") && executable !== name)
  )
    return null;
  return words[2] ?? null;
}

export type CodexToolCorrelationOrigin =
  | "command_execution"
  | "custom_tool_call"
  | "function_call"
  | "image_view"
  | "plan_update";

export interface CodexToolCorrelationMetadata {
  origin: CodexToolCorrelationOrigin;
  turnId: string;
  itemId: string;
  /** Live command start time, retained when completion replaces its start. */
  startedAt?: string;
  /** Added client-side after an exact live-to-durable match. */
  durableCallId?: string;
  /** Added client-side to the durable-shaped copy after an exact match. */
  liveItemId?: string;
}

export function createCodexToolCorrelation(
  origin: CodexToolCorrelationOrigin,
  turnId: string,
  itemId: string,
  startedAt?: string,
): CodexToolCorrelationMetadata {
  return { origin, turnId, itemId, ...(startedAt ? { startedAt } : {}) };
}

export function getCodexToolCorrelation(
  value: unknown,
): CodexToolCorrelationMetadata | null {
  if (!value || typeof value !== "object") return null;
  const metadata = (value as Record<string, unknown>)[
    CODEX_TOOL_CORRELATION_FIELD
  ];
  if (!metadata || typeof metadata !== "object") return null;

  const record = metadata as Record<string, unknown>;
  const origin = record.origin;
  if (
    origin !== "command_execution" &&
    origin !== "custom_tool_call" &&
    origin !== "function_call" &&
    origin !== "image_view" &&
    origin !== "plan_update"
  ) {
    return null;
  }
  if (typeof record.turnId !== "string" || typeof record.itemId !== "string") {
    return null;
  }

  return {
    origin,
    turnId: record.turnId,
    itemId: record.itemId,
    ...(typeof record.startedAt === "string"
      ? { startedAt: record.startedAt }
      : {}),
    ...(typeof record.durableCallId === "string"
      ? { durableCallId: record.durableCallId }
      : {}),
    ...(typeof record.liveItemId === "string"
      ? { liveItemId: record.liveItemId }
      : {}),
  };
}

/** Read Codex's rollout-recoverable turn id without depending on raw schemas. */
export function getCodexResponseItemTurnId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const metadata = (payload as Record<string, unknown>)
    .internal_chat_message_metadata_passthrough;
  if (!metadata || typeof metadata !== "object") return null;
  const turnId = (metadata as Record<string, unknown>).turn_id;
  return typeof turnId === "string" ? turnId : null;
}
