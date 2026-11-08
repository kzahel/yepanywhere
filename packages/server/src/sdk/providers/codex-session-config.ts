import {
  type CodexPlanToolMode,
  type CodexReasoningSummary,
  type EffectiveSessionLaunchSettings,
  type EffortLevel,
  type ModelInfo,
  nativeModelEffort,
  routerModelSupportsThinking,
  type SubagentMaxDepth,
} from "@yep-anywhere/shared";
import type { SessionSandboxRuntime } from "../../session-sandbox.js";
import type {
  ThreadForkParams,
  ThreadResumeParams,
  ThreadStartParams,
  TurnStartParams,
  UserInput,
} from "./codex-protocol/index.js";
import type { CyberAccessProgram } from "./codex-protocol/generated/v2/CyberAccessProgram.js";
import type { SandboxPolicy as CodexSandboxPolicy } from "./codex-protocol/generated/v2/SandboxPolicy.js";
import { CODEX_DESKTOP_BROWSER_SKILL_NAME } from "./codex-skill-inputs.js";
import {
  buildThreadPermissionParams,
  buildTurnPermissionParams,
  type CodexThreadPolicy,
  limitedUserThreadInstructions,
} from "./codex-thread-params.js";
import type { ProviderForkOptions, StartSessionOptions } from "./types.js";

/**
 * The server settings that Codex thread and turn parameters depend on. The
 * provider builds one whose methods read its configured getters at call
 * time, so a setter applied after construction still takes effect.
 */
export interface CodexConfigSource {
  reasoningSummary(): CodexReasoningSummary;
  planToolMode(): CodexPlanToolMode;
  subagentMaxDepth(): SubagentMaxDepth;
  /** The provider's cached model list, or undefined before the first read. */
  cachedModels(): readonly ModelInfo[] | undefined;
}

const CODEX_THINKING_OFF_MIN_REASONING_EFFORT_PREFIXES = [
  "gpt-5.3-codex-spark",
] as const;

export type CodexThreadResumeParamsForRequest = ThreadResumeParams;

type CodexThreadForkParamsForRequest = ThreadForkParams;

export function mapEffortToReasoningEffort(
  configSource: CodexConfigSource,
  effort?: import("@yep-anywhere/shared").EffortLevel,
  thinking?: import("@yep-anywhere/shared").ThinkingConfig,
  model?: StartSessionOptions["model"],
  accountModels?: readonly ModelInfo[],
): NonNullable<TurnStartParams["effort"]> | undefined {
  if (
    accountModels &&
    effort &&
    !routerModelSupportsThinking(
      accountModels.find((m) => m.id === model),
      `on:${effort}`,
    )
  )
    throw new Error("Thinking level unavailable for the pinned account");
  if (thinking?.type === "disabled") {
    const supported = (accountModels ?? configSource.cachedModels())?.find(
      (candidate) => candidate.id === model,
    )?.supportedReasoningEfforts;
    if (
      supported?.length &&
      !supported.some((item) => item.reasoningEffort === "none")
    ) {
      const minimum = [
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
      ].find((level) =>
        supported.some((item) => item.reasoningEffort === level),
      );
      if (minimum) return minimum;
    }
    const normalizedModel = model?.trim().toLowerCase();
    const hasSparkModelPrefix =
      CODEX_THINKING_OFF_MIN_REASONING_EFFORT_PREFIXES.some((prefix) =>
        normalizedModel?.startsWith(prefix),
      );
    if (hasSparkModelPrefix) {
      return "low";
    }
    return "none";
  }
  if (!effort) {
    return undefined;
  }
  switch (effort) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    case "max": {
      const selectedModel = (
        accountModels ?? configSource.cachedModels()
      )?.find(
        (candidate) =>
          candidate.id === model || (!model && candidate.isDefault),
      );
      return selectedModel ? nativeModelEffort("max", selectedModel) : "xhigh";
    }
  }
}

export function createThreadStartParams(
  configSource: CodexConfigSource,
  options: StartSessionOptions,
  policy: CodexThreadPolicy,
): ThreadStartParams {
  return {
    model: options.model ?? null,
    ...(options.routerLaunch ? { modelProvider: "aar" } : {}),
    ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
    cwd: options.cwd,
    ...buildThreadPermissionParams(policy),
    config: buildThreadConfigOverrides(configSource, options),
    ...limitedUserThreadInstructions(options.sessionSandbox),
    experimentalRawEvents: false,
    ...(options.sessionSandbox?.instructions?.startFromDefault === false
      ? { baseInstructions: "" }
      : {}),
  };
}

export function createThreadResumeParams(
  configSource: CodexConfigSource,
  options: StartSessionOptions,
  sessionId: string,
  policy: CodexThreadPolicy,
  experimentalApiEnabled = false,
  includeTurns = false,
): CodexThreadResumeParamsForRequest {
  const params: CodexThreadResumeParamsForRequest = {
    threadId: options.resumeSessionId ?? sessionId,
    ...(options.nativeResumeSource
      ? { path: options.nativeResumeSource.filePath }
      : {}),
    model: options.model ?? null,
    ...(options.routerLaunch ? { modelProvider: "aar" } : {}),
    ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
    cwd: options.cwd,
    ...buildThreadPermissionParams(policy),
    config: buildThreadConfigOverrides(configSource, options),
    ...limitedUserThreadInstructions(options.sessionSandbox),
  };
  if (experimentalApiEnabled && !includeTurns) {
    params.excludeTurns = true;
  }
  return params;
}

export function createThreadForkParams(
  configSource: CodexConfigSource,
  options: {
    nativeSessionId: ProviderForkOptions["nativeSessionId"];
    nativeSource?: ProviderForkOptions["nativeSource"];
    cwd: string;
    lastTurnId?: string;
    sessionSandbox?: SessionSandboxRuntime;
    launchSettings?: Omit<
      EffectiveSessionLaunchSettings,
      "schemaVersion" | "revision"
    >;
  },
  policy: CodexThreadPolicy,
  experimentalApiEnabled = false,
): CodexThreadForkParamsForRequest {
  const settings = options.launchSettings;
  const model =
    settings?.requestedModel && settings.requestedModel !== "default"
      ? settings.requestedModel
      : undefined;
  const params: CodexThreadForkParamsForRequest = {
    ...(model ? { model } : {}),
    ...(settings ? { serviceTier: settings.serviceTier } : {}),
    threadId: options.nativeSessionId,
    ...(options.nativeSource ? { path: options.nativeSource.filePath } : {}),
    ...(options.lastTurnId ? { lastTurnId: options.lastTurnId } : {}),
    cwd: options.cwd,
    ...buildThreadPermissionParams(policy),
    config: buildThreadConfigOverrides(configSource, {
      model,
      thinking: settings?.thinking ?? undefined,
      effort: settings?.effort ?? undefined,
    }),
    ...limitedUserThreadInstructions(options.sessionSandbox),
  };
  if (experimentalApiEnabled) {
    params.excludeTurns = true;
  }
  return params;
}

export function buildThreadConfigOverrides(
  configSource: CodexConfigSource,
  options: Pick<
    StartSessionOptions,
    | "compactAtContextTokenLimit"
    | "effort"
    | "thinking"
    | "model"
    | "routerLaunch"
    | "agentApiEnvironment"
  >,
): NonNullable<ThreadStartParams["config"]> {
  // The OpenAI browser plugin controls a desktop-owned browser backend that
  // YA's Codex app-server host does not provide. Suppress the unavailable
  // skill at thread scope so Codex follows YA's Playwright fallback instead
  // of advertising a browser that fails during backend discovery.
  const config: NonNullable<ThreadStartParams["config"]> = {
    model_reasoning_summary: configSource.reasoningSummary(),
    skills: {
      config: [
        {
          name: CODEX_DESKTOP_BROWSER_SKILL_NAME,
          enabled: false,
        },
      ],
    },
  };
  if (options.agentApiEnvironment) {
    // A policy-admitted Authorization value must not enter Codex shell
    // snapshot files. This affects only the explicit YA API opt-in.
    config.features = { shell_snapshot: false, shell_snapshot_v2: false };
  }
  const planToolMode = configSource.planToolMode();
  if (planToolMode !== "provider-default") {
    config.tools = {
      update_plan: {
        enabled: planToolMode === "enabled",
      },
    };
  }
  const subagentMaxDepth = configSource.subagentMaxDepth();
  if (subagentMaxDepth !== null) {
    config.agents = { max_depth: subagentMaxDepth };
  }
  const reasoningEffort = mapEffortToReasoningEffort(
    configSource,
    options.effort,
    options.thinking,
    options.model,
    options.routerLaunch?.models,
  );
  if (reasoningEffort) {
    config.model_reasoning_effort = reasoningEffort;
  }
  if (
    options.compactAtContextTokenLimit !== undefined &&
    Number.isFinite(options.compactAtContextTokenLimit) &&
    options.compactAtContextTokenLimit > 0
  ) {
    config.model_auto_compact_token_limit = Math.round(
      options.compactAtContextTokenLimit,
    );
    // The YA setting is explicitly a percentage of the full active context.
    // Pin the scope so a user's Codex config cannot reinterpret it as growth
    // after the carried compaction prefix.
    config.model_auto_compact_token_limit_scope = "total";
  }
  return config;
}

export function createTurnStartParams(
  configSource: CodexConfigSource,
  threadId: string,
  input: UserInput[],
  options: StartSessionOptions,
  turnPolicy: CodexThreadPolicy | null = null,
  workspaceWriteSandboxPolicy: CodexSandboxPolicy | null = null,
  modelOverride: string | null = options.model ?? null,
  effortOverride: EffortLevel | null | undefined = options.effort,
  clientUserMessageId?: string,
  cyberAccessProgram: CyberAccessProgram | null = null,
  serviceTier: string | null | undefined = options.serviceTier,
): TurnStartParams {
  return {
    threadId,
    ...(clientUserMessageId ? { clientUserMessageId } : {}),
    model: modelOverride,
    ...(serviceTier || serviceTier === null ? { serviceTier } : {}),
    input,
    effort:
      effortOverride === null
        ? null
        : mapEffortToReasoningEffort(
            configSource,
            effortOverride,
            options.thinking,
            modelOverride ?? undefined,
            options.routerLaunch?.models,
          ),
    ...buildTurnPermissionParams(turnPolicy, workspaceWriteSandboxPolicy),
    ...(cyberAccessProgram ? { cyberAccessProgram } : {}),
  };
}
