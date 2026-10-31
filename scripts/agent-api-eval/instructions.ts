import { agentApiBootstrapInstructions } from "../../packages/shared/src/agent-api-bootstrap.js";
import { apiHelp } from "../../packages/server/src/core-api/contracts.js";

export type Variant = "minimal" | "help" | "inline";
export function bootstrap(
  variant: Variant,
  windows = process.platform === "win32",
  management = false,
  peerAccess = false,
) {
  const actual = agentApiBootstrapInstructions(windows, management, peerAccess);
  if (variant === "minimal")
    return `${actual.split("\n").slice(0, 3).join("\n")}\nUse the same connection for GET /v0/schema to discover operations.`;
  return variant === "inline" ? `${actual}\n\n${apiHelp()}` : actual;
}
