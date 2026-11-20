import type {
  ProviderName,
  StartSessionOptions,
} from "../sdk/providers/types.js";

/** Reachability qualification, separate from user opt-in and principal authority. */
export function agentApiEligible(
  provider: ProviderName,
  options: StartSessionOptions,
): boolean {
  if (
    options.executor ||
    options.sessionSandbox ||
    options.sessionSandboxOptions?.level === "project-write"
  )
    return false;
  if (provider === "codex" || provider === "antigravity")
    return options.permissionMode === "bypassPermissions";
  return (
    provider === "claude" ||
    provider === "claude-gateway" ||
    provider === "claude-ollama"
  );
}
