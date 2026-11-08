import {
  ALL_PERMISSION_MODES,
  ALL_PROVIDERS,
  type PermissionMode,
  type ProjectQueueTarget,
  type ProviderName,
  type ShowThinking,
  type ThinkingOption,
} from "@yep-anywhere/shared";

/**
 * Validation of a Project Queue item's target (topics/project-queue.md),
 * including the router selection a new-session item carries to dispatch
 * (plan 183).
 */

export class ProjectQueueValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectQueueValidationError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function optionalString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ProjectQueueValidationError(`${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalProvider(value: unknown): ProviderName | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !ALL_PROVIDERS.includes(value as ProviderName)
  ) {
    throw new ProjectQueueValidationError("target.provider is invalid");
  }
  return value as ProviderName;
}

export function optionalPermissionMode(
  value: unknown,
): PermissionMode | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !ALL_PERMISSION_MODES.includes(value as PermissionMode)
  ) {
    throw new ProjectQueueValidationError("mode is invalid");
  }
  return value as PermissionMode;
}

function optionalThinking(value: unknown): ThinkingOption | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new ProjectQueueValidationError("target.thinking is invalid");
  }
  return value.trim() as ThinkingOption;
}

function optionalShowThinking(value: unknown): ShowThinking | undefined {
  if (value === undefined) return undefined;
  if (value !== "default" && value !== "on" && value !== "off") {
    throw new ProjectQueueValidationError("target.showThinking is invalid");
  }
  return value;
}

function optionalSandboxLevel(
  value: unknown,
): "none" | "project-write" | undefined {
  if (value === undefined) return undefined;
  if (value !== "none" && value !== "project-write") {
    throw new ProjectQueueValidationError("target.sandboxLevel is invalid");
  }
  return value;
}

function optionalSandboxNetworkFirewall(
  value: unknown,
  sandboxLevel: "none" | "project-write" | undefined,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new ProjectQueueValidationError(
      "target.sandboxNetworkFirewall is invalid",
    );
  }
  if (value && sandboxLevel !== "project-write") {
    throw new ProjectQueueValidationError(
      "target.sandboxNetworkFirewall requires project-write sandboxing",
    );
  }
  return sandboxLevel === "project-write" ? value : undefined;
}

const ROUTER_TARGET_FIELDS = [
  "routerPoolId",
  "routerAccountId",
  "routerPolicy",
  "routerClaudeAiConnectors",
] as const;

/**
 * Router selection for a new-session target, with the shape rules Supervisor
 * applies at launch (topics/agent-auth-router.md). Checked here as well so a
 * malformed selection is refused at enqueue instead of pausing at dispatch.
 */
function optionalRouterSelection(
  raw: Record<string, unknown>,
  provider: ProviderName | undefined,
): Pick<
  Extract<ProjectQueueTarget, { type: "new-session" }>,
  (typeof ROUTER_TARGET_FIELDS)[number]
> {
  const routerPoolId = optionalString(raw.routerPoolId, "target.routerPoolId");
  if (routerPoolId !== undefined && !/^[a-f0-9-]{36}$/.test(routerPoolId)) {
    throw new ProjectQueueValidationError("target.routerPoolId is invalid");
  }
  const routerAccountId = optionalString(
    raw.routerAccountId,
    "target.routerAccountId",
  );
  if (
    routerAccountId !== undefined &&
    !/^[A-Za-z0-9_-]{1,128}$/.test(routerAccountId)
  ) {
    throw new ProjectQueueValidationError("target.routerAccountId is invalid");
  }
  const routerPolicy = optionalString(raw.routerPolicy, "target.routerPolicy");
  if (
    routerPolicy !== undefined &&
    (!routerPoolId || !/^[a-z0-9-]{1,40}$/.test(routerPolicy))
  ) {
    throw new ProjectQueueValidationError("target.routerPolicy is invalid");
  }
  const connectors = raw.routerClaudeAiConnectors;
  if (
    connectors !== undefined &&
    (typeof connectors !== "boolean" ||
      !(routerPoolId || routerAccountId) ||
      (provider !== undefined && provider !== "claude"))
  ) {
    throw new ProjectQueueValidationError(
      "target.routerClaudeAiConnectors is invalid",
    );
  }
  return {
    ...(routerPoolId ? { routerPoolId } : {}),
    ...(routerAccountId ? { routerAccountId } : {}),
    ...(routerPolicy ? { routerPolicy } : {}),
    ...(connectors === undefined
      ? {}
      : { routerClaudeAiConnectors: connectors as boolean }),
  };
}

export function normalizeTarget(raw: unknown): ProjectQueueTarget {
  if (!isRecord(raw)) {
    throw new ProjectQueueValidationError("target must be an object");
  }

  const common = {
    provider: optionalProvider(raw.provider),
    mode: optionalPermissionMode(raw.mode),
    model: optionalString(raw.model, "target.model"),
    serviceTier: optionalString(raw.serviceTier, "target.serviceTier"),
    executor: optionalString(raw.executor, "target.executor"),
    thinking: optionalThinking(raw.thinking),
    showThinking: optionalShowThinking(raw.showThinking),
  };

  if (raw.type === "existing-session") {
    const sessionId = optionalString(raw.sessionId, "target.sessionId");
    if (!sessionId) {
      throw new ProjectQueueValidationError("target.sessionId is required");
    }
    if (ROUTER_TARGET_FIELDS.some((field) => raw[field] !== undefined)) {
      throw new ProjectQueueValidationError(
        "Router selection applies only to new sessions; an existing session keeps its pin",
      );
    }
    return {
      type: "existing-session",
      sessionId,
      ...common,
    };
  }

  if (raw.type === "new-session") {
    const sandboxLevel = optionalSandboxLevel(raw.sandboxLevel);
    const router = optionalRouterSelection(raw, common.provider);
    if (
      (router.routerPoolId || router.routerAccountId) &&
      (common.executor || sandboxLevel === "project-write")
    ) {
      throw new ProjectQueueValidationError(
        "Router sessions require a local unsandboxed owner launch",
      );
    }
    return {
      type: "new-session",
      title: optionalString(raw.title, "target.title"),
      sandboxLevel,
      sandboxNetworkFirewall: optionalSandboxNetworkFirewall(
        raw.sandboxNetworkFirewall,
        sandboxLevel,
      ),
      ...common,
      ...router,
    };
  }

  throw new ProjectQueueValidationError("target.type is invalid");
}
