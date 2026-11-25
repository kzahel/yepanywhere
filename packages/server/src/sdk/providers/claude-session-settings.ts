import type { Options, Settings } from "@anthropic-ai/claude-agent-sdk";
import type { SessionSandboxRuntime } from "../../session-sandbox.js";
import type { RouterLaunch } from "../../services/AgentAuthRouter.js";
import { claudeRouterEnvironment } from "./router-transport.js";

/**
 * Settings and tool limits for every confined Claude query, including resumes
 * and helper forks. A sandboxed query also loses connectors and MCP servers.
 */
export function claudeSessionToolOptions(
  settings: Settings | undefined,
  disallowedTools: string[] | undefined,
  sandbox: SessionSandboxRuntime | undefined,
): Pick<
  Options,
  "settings" | "disallowedTools" | "strictMcpConfig" | "mcpServers"
> {
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
): Settings {
  return {
    ...settings,
    apiKeyHelper: "",
    ...(routerLaunch.claudeAiConnectors
      ? {}
      : { disableClaudeAiConnectors: true }),
    env: claudeRouterEnvironment(routerLaunch, customHeaders),
  };
}
