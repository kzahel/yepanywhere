/**
 * Recognize which provider harness a host process is running, from executable
 * position alone.
 *
 * This is tactical 093's third adapter kind — the native process classifier —
 * held apart from `HostAgentProcessService` so that plan's process
 * reconciliation can reuse recognition without depending on the host process
 * inventory, its `ps` ownership, or its caching. Nothing here retains raw
 * command text; the caller reduces argv to a `ProviderName` while parsing its
 * one snapshot and keeps only that.
 */
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  parseNativeSessionId,
  type NativeSessionId,
  type ProviderName,
} from "@yep-anywhere/shared";

const BUNDLED_TOOL_NAMES = new Set(["ugrep", "rg", "ripgrep"]);
// ps reports start times to the second; Claude records milliseconds.
const PID_RECORD_START_TOLERANCE_MS = 2_000;
const NATIVE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

/** A provider's own exact record of which session a process runs. */
export interface NativeProcessSession {
  nativeSessionId: NativeSessionId;
  /** Server-only: actual configured native project-store namespace. */
  projectsRoot?: string;
  /** Server-only: the provider's project directory, never sent to clients. */
  projectPath: string;
}

/**
 * Read the session a recognized root runs from the provider's pid record.
 * Claude Code writes `<config>/sessions/<pid>.json` with the session id, cwd
 * and start time for each live process; the start time must match the
 * observed process, so a reused PID cannot inherit a dead process's session.
 * Providers without such a record return undefined.
 */
export async function readNativeProcessSession(
  provider: ProviderName,
  pid: number,
  startedAtMs: number,
): Promise<NativeProcessSession | undefined> {
  if (provider !== "claude") return undefined;
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(
      await readFile(join(configDir, "sessions", `${pid}.json`), "utf8"),
    );
  } catch {
    return undefined;
  }
  const { sessionId, cwd, startedAt } = record;
  if (
    record.pid !== pid ||
    typeof sessionId !== "string" ||
    !NATIVE_SESSION_ID.test(sessionId) ||
    typeof cwd !== "string" ||
    typeof startedAt !== "number" ||
    Math.abs(startedAt - startedAtMs) > PID_RECORD_START_TOLERANCE_MS
  ) {
    return undefined;
  }
  const projectsRoot = await realpath(join(configDir, "projects")).catch(
    () => undefined,
  );
  return {
    nativeSessionId: parseNativeSessionId(sessionId),
    projectPath: cwd,
    ...(projectsRoot ? { projectsRoot } : {}),
  };
}

function basename(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

function providerForExecutableName(value: string): ProviderName | undefined {
  const name = basename(value).replace(/\.exe$/i, "");
  switch (name) {
    case "claude":
      return "claude";
    case "codex":
      return "codex";
    case "gemini":
    case "gemini-cli":
      return "gemini";
    case "grok":
      return "grok";
    case "opencode":
      return "opencode";
    case "pi":
      return "pi";
    default:
      return undefined;
  }
}

function isGenericRuntime(value: string): boolean {
  const name = basename(value).replace(/\.exe$/i, "");
  return (
    name === "node" ||
    name === "nodejs" ||
    name === "bun" ||
    name === "deno" ||
    /^python(?:\d+(?:\.\d+)*)?$/.test(name)
  );
}

/**
 * Classify only executable-position tokens. Later command arguments may be
 * prompts or paths and must not make an unrelated process look like an agent.
 */
export function classifyProviderProcess(
  commandName: string,
  executableTokens: readonly string[],
): ProviderName | undefined {
  const direct = providerForExecutableName(commandName);
  if (direct) {
    // Claude Code runs its bundled search tools by re-executing its own
    // binary under their names, so the kernel's command name says "claude"
    // while the invoked name says what the process is.
    const invokedAs = basename(executableTokens[0] ?? commandName);
    return BUNDLED_TOOL_NAMES.has(invokedAs) ? undefined : direct;
  }

  const runtime = executableTokens[0] ?? commandName;
  if (!isGenericRuntime(runtime)) return undefined;

  for (const token of executableTokens.slice(1, 4)) {
    const byName = providerForExecutableName(token);
    if (byName) return byName;

    const normalized = token.replaceAll("\\", "/").toLowerCase();
    if (
      normalized.includes("/@anthropic-ai/claude-code/") ||
      normalized.includes("/node_modules/claude-code/")
    ) {
      return "claude";
    }
    if (
      normalized.includes("/@openai/codex/") ||
      normalized.includes("/node_modules/@openai/codex-")
    ) {
      return "codex";
    }
    if (
      normalized.includes("/@google/gemini-cli/") ||
      normalized.includes("/node_modules/@google/gemini-cli/")
    ) {
      return "gemini";
    }
  }

  return undefined;
}
