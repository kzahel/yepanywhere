import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Options, Settings } from "@anthropic-ai/claude-agent-sdk";
import type { SessionSandboxRuntime } from "../../session-sandbox.js";
import type { RouterLaunch } from "../../services/AgentAuthRouter.js";
import type { BootInstructionsLaunch } from "../../sessions/session-boot-instructions.js";
import { claudeRouterEnvironment } from "./router-transport.js";
import type { StartSessionOptions } from "./types.js";

/** The launch fields Claude's session prompt and settings read. */
export type ClaudeBootLaunch = Pick<
  StartSessionOptions,
  "model" | "globalInstructions" | "bootInstructions" | "sessionSandbox"
>;

/**
 * Claude setting sources for a launch. Leaving out `user` drops the
 * operator's `CLAUDE.md`, skills and settings together; the settings come
 * back through {@link claudeBootUserSettings}.
 */
export function claudeSettingSources(
  boot: BootInstructionsLaunch | undefined,
): ("user" | "project" | "local")[] {
  return boot ? ["project", "local"] : ["user", "project", "local"];
}

/** User settings keys that would reintroduce instructions or run code at turn boundaries. */
const CLAUDE_BOOT_DROPPED_SETTINGS = ["hooks", "outputStyle", "statusLine"];

/**
 * The operator's user settings for a session with boot instructions, passed
 * back explicitly because the `user` source is left out. Absent or invalid
 * settings carry nothing.
 */
export function claudeBootUserSettings(
  configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
): Settings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const carried: Record<string, unknown> = { ...parsed };
  for (const key of CLAUDE_BOOT_DROPPED_SETTINGS) delete carried[key];
  return carried as Settings;
}

/**
 * A launch's flag-layer settings over the operator's carried user settings.
 * They join at the flag layer, so they take precedence over project and local
 * settings, unlike the `user` source they replace.
 */
function withBootUserSettings(
  settings: Settings | undefined,
  boot: BootInstructionsLaunch | undefined,
): Settings | undefined {
  return boot ? { ...claudeBootUserSettings(), ...settings } : settings;
}

/**
 * Settings and tool limits for every confined Claude query, including resumes
 * and helper forks. A sandboxed query also loses connectors and MCP servers.
 */
export function claudeSessionToolOptions(
  flagSettings: Settings | undefined,
  disallowedTools: string[] | undefined,
  sandbox: SessionSandboxRuntime | undefined,
  boot?: BootInstructionsLaunch,
): Pick<
  Options,
  "settings" | "disallowedTools" | "strictMcpConfig" | "mcpServers"
> {
  const settings = withBootUserSettings(flagSettings, boot);
  if (!sandbox) {
    return { settings, ...(disallowedTools ? { disallowedTools } : {}) };
  }
  return {
    settings: {
      ...settings,
      disableClaudeAiConnectors: true,
      allowedMcpServers: [],
      deniedMcpServers: [{ serverUrl: "*" }],
    },
    strictMcpConfig: true,
    mcpServers: {},
    disallowedTools: [...(disallowedTools ?? []), "mcp__*"],
  };
}

/** Flag-layer settings for a routed Claude session: the router's key and transport. */
export function claudeRouterSettings(
  settings: Settings | undefined,
  routerLaunch: RouterLaunch,
  customHeaders: string | undefined,
  boot?: BootInstructionsLaunch,
): Settings {
  return {
    ...withBootUserSettings(settings, boot),
    apiKeyHelper: "",
    ...(routerLaunch.claudeAiConnectors
      ? {}
      : { disableClaudeAiConnectors: true }),
    env: claudeRouterEnvironment(routerLaunch, customHeaders),
  };
}
