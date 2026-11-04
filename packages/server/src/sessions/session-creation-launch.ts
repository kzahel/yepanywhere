import {
  RECAP_MODES,
  PROMPT_SUGGESTION_MODES,
  SESSION_SANDBOX_LEVELS,
} from "@yep-anywhere/shared";
import type { ModelSettings } from "../supervisor/SessionActivationCoordinator.js";

/** Submitted launch choices; credentials and current authorization stay live. */
export type CreationLaunchSnapshot = Pick<
  ModelSettings,
  | "model"
  | "clientName"
  | "routerAccountId"
  | "routerPoolId"
  | "routerPolicy"
  | "routerClaudeAiConnectors"
  | "machineControl"
  | "globalInstructions"
  | "permissions"
  | "recapMode"
  | "recapAfterSeconds"
  | "promptSuggestionMode"
  | "helperSideModel"
  | "compactAtContextPercent"
  | "compactAtContextWindow"
  | "forceYaOrchestratedCompaction"
  | "claudeAutoCompactPercentOverride"
  | "sandboxLevel"
  | "sandboxNetworkFirewall"
  | "sandboxStateKey"
> & {
  schemaVersion: 1;
  runtimeOwner?: "local" | "host";
  requiresDesktopControlOrigin?: boolean;
};

/** Rebuild an allowlist rather than serializing runtime/provider option objects. */
export function snapshotCreationLaunch(
  input: ModelSettings & {
    schemaVersion?: number;
    runtimeOwner?: "local" | "host";
    requiresDesktopControlOrigin?: boolean;
  },
): CreationLaunchSnapshot {
  if (
    !input ||
    (input.schemaVersion !== undefined && input.schemaVersion !== 1)
  )
    throw new Error("Invalid saved launch options");
  if (
    input.executor !== undefined ||
    input.remoteEnv !== undefined ||
    input.computerControl
  )
    throw new Error("Retired execution options cannot create a session");
  if (
    input.resumeMode !== undefined ||
    input.resumeSessionAt !== undefined ||
    input.resumeDropsTurn !== undefined
  )
    throw new Error("New session creation cannot contain resume options");
  const result: CreationLaunchSnapshot = { schemaVersion: 1 };
  if (input.runtimeOwner !== undefined) {
    if (input.runtimeOwner !== "local" && input.runtimeOwner !== "host")
      throw new Error("Invalid saved runtime owner");
    result.runtimeOwner = input.runtimeOwner;
  }
  for (const key of [
    "model",
    "clientName",
    "routerAccountId",
    "routerPoolId",
    "routerPolicy",
    "helperSideModel",
    "globalInstructions",
    "sandboxStateKey",
  ] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "string")
      throw new Error("Invalid saved launch text option");
    if (
      key === "sandboxStateKey" &&
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)
    )
      throw new Error("Invalid saved sandbox state key");
    result[key] = value;
  }
  for (const key of [
    "machineControl",
    "routerClaudeAiConnectors",
    "requiresDesktopControlOrigin",
    "forceYaOrchestratedCompaction",
    "sandboxNetworkFirewall",
  ] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean")
      throw new Error("Invalid saved launch boolean option");
    result[key] = value;
  }
  for (const key of [
    "recapAfterSeconds",
    "compactAtContextPercent",
    "compactAtContextWindow",
    "claudeAutoCompactPercentOverride",
  ] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      throw new Error("Invalid saved launch numeric option");
    result[key] = value;
  }
  if (input.recapMode !== undefined) {
    if (!RECAP_MODES.includes(input.recapMode))
      throw new Error("Invalid saved recap mode");
    result.recapMode = input.recapMode;
  }
  if (input.promptSuggestionMode !== undefined) {
    if (!PROMPT_SUGGESTION_MODES.includes(input.promptSuggestionMode))
      throw new Error("Invalid saved suggestion mode");
    result.promptSuggestionMode = input.promptSuggestionMode;
  }
  if (input.sandboxLevel !== undefined) {
    if (!SESSION_SANDBOX_LEVELS.includes(input.sandboxLevel))
      throw new Error("Invalid saved sandbox level");
    result.sandboxLevel = input.sandboxLevel;
  }
  if (input.permissions !== undefined) {
    const rules = input.permissions;
    if (!rules || typeof rules !== "object" || Array.isArray(rules))
      throw new Error("Invalid saved permission rules");
    result.permissions = {};
    for (const key of ["allow", "deny"] as const) {
      if (rules[key] === undefined) continue;
      if (
        !Array.isArray(rules[key]) ||
        !rules[key].every((value) => typeof value === "string")
      )
        throw new Error("Invalid saved permission patterns");
      result.permissions[key] = [...rules[key]];
    }
  }
  return result;
}
