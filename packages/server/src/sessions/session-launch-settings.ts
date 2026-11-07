import {
  type PermissionMode,
  type ProviderName,
  type SessionSandboxLevel,
  type ThinkingOption,
  buildEffectiveAgentContext,
} from "@yep-anywhere/shared";
import type {
  SessionMetadata,
  SessionMetadataService,
} from "../metadata/index.js";
import { getSessionSandboxSettingsError } from "../session-sandbox.js";
import type { ModelSettings } from "../supervisor/Supervisor.js";
import {
  type SuccessorLaunchSettings,
  inheritSuccessorLaunchSettings,
} from "../supervisor/sessionLaunchInheritance.js";
import {
  type CompactModelSettingsDeps,
  resolveCompactModelSettings,
} from "./session-compact-thresholds.js";
import { persistedSandboxNetworkFirewall } from "./session-sandbox-inheritance.js";

/**
 * The executor a launch may name, from a request or a session's saved
 * metadata. SSH executors were removed, so a named one is an error and every
 * launch runs locally.
 */
export function parseOptionalExecutor(rawExecutor: unknown): {
  executor: string | undefined;
  error?: string;
} {
  if (rawExecutor === undefined || rawExecutor === null) {
    return { executor: undefined };
  }
  if (typeof rawExecutor !== "string") {
    return { executor: undefined, error: "executor must be a string" };
  }

  return rawExecutor.trim()
    ? { executor: undefined, error: "SSH executors have been removed" }
    : { executor: undefined };
}

/**
 * Launch choices one resume request makes for an existing session. An unset
 * field falls back to what the session saved, so a resume with no client body
 * (a `/clearloop` iteration, a body-less route call) keeps the session's
 * standing settings.
 */
export interface ResumeLaunchRequest {
  /** YA model id the request names; absent recovers the saved one. */
  model?: string;
  serviceTier?: ModelSettings["serviceTier"];
  thinking?: ModelSettings["thinking"];
  effort?: ModelSettings["effort"];
  /** SSH host alias the request names; absent recovers the saved one. */
  executor?: string;
  permissions?: ModelSettings["permissions"];
  recapMode?: ModelSettings["recapMode"];
  recapAfterSeconds?: number;
  promptSuggestionMode?: ModelSettings["promptSuggestionMode"];
  helperSideModel?: string;
  resumeMode: NonNullable<ModelSettings["resumeMode"]>;
  resumeSessionAt?: string;
}

/**
 * Launch choices a successor request (restart handoff or fork, stale-session
 * handoff) makes. An unset field inherits from the source session.
 */
export interface SuccessorLaunchRequest {
  model?: string;
  thinking?: ThinkingOption;
  /** null asks for the provider default; undefined inherits the source's. */
  serviceTier?: string | null;
  permissionMode?: PermissionMode;
  permissions?: ModelSettings["permissions"];
  recapMode?: ModelSettings["recapMode"];
  recapAfterSeconds?: number;
  promptSuggestionMode?: ModelSettings["promptSuggestionMode"];
  helperSideModel?: string;
}

/** A successor session's launch: what it inherited and its settings. */
export interface SuccessorLaunch extends SuccessorLaunchSettings {
  settings: ModelSettings;
}

/** What the launch-settings closures read from their host's services. */
export interface SessionLaunchSettingsDeps extends CompactModelSettingsDeps {
  sessionMetadataService?: SessionMetadataService;
}

/**
 * The launch-settings closures a host shares across everything that
 * launches or resumes a session: today the sessions routes and `/clearloop`.
 * Stateless; they read `deps` at call time.
 */
export function createSessionLaunchSettings(deps: SessionLaunchSettingsDeps) {
  const getGlobalInstructions = (): string | undefined =>
    buildEffectiveAgentContext({
      globalInstructions:
        deps.serverSettingsService?.getSetting("globalInstructions"),
      hints: deps.serverSettingsService?.getSetting("agentContextHints"),
    });

  /**
   * The one assembly of an existing session's resume launch: the request's
   * choices over the session's saved model, executor, helper preferences and
   * settled sandbox. The resume route and `/clearloop` iterations both use it.
   */
  const buildResumeLaunch = (input: {
    sessionId: string;
    providerName: ProviderName;
    workingProjectPath: string;
    /** Model the replaced process reported, a compact-window lookup key. */
    previousResolvedModel?: string;
    request: ResumeLaunchRequest;
  }): { projectPath: string; settings: ModelSettings } | { error: string } => {
    const { sessionId, providerName, request } = input;
    const saved = deps.sessionMetadataService;
    const metadata = saved?.getMetadata?.(sessionId);
    const requestedModel = request.model ?? saved?.getRequestedModel(sessionId);
    const model =
      requestedModel && requestedModel !== "default"
        ? requestedModel
        : undefined;
    let executor = request.executor;
    if (!executor) {
      const savedExecutor = parseOptionalExecutor(
        saved?.getExecutor(sessionId),
      );
      if (savedExecutor.error) return { error: savedExecutor.error };
      executor = savedExecutor.executor;
    }
    const recapMode = request.recapMode ?? metadata?.recapMode;
    const sandboxLevel = metadata?.sandboxLevel ?? "none";
    const sandboxError = getSessionSandboxSettingsError(
      sandboxLevel,
      recapMode,
    );
    if (sandboxError) return { error: sandboxError };
    return {
      projectPath:
        sandboxLevel === "project-write"
          ? (metadata?.sandboxProjectPath ?? input.workingProjectPath)
          : input.workingProjectPath,
      settings: {
        model,
        requestedModel,
        serviceTier: request.serviceTier,
        thinking: request.thinking,
        effort: request.effort,
        providerName,
        executor,
        sandboxLevel,
        sandboxNetworkFirewall: persistedSandboxNetworkFirewall(metadata),
        sandboxStateKey: metadata?.sandboxStateKey,
        globalInstructions: getGlobalInstructions(),
        permissions: request.permissions,
        recapMode,
        recapAfterSeconds:
          request.recapAfterSeconds ?? saved?.getRecapAfterSeconds?.(sessionId),
        promptSuggestionMode:
          request.promptSuggestionMode ??
          saved?.getPromptSuggestionMode?.(sessionId),
        helperSideModel: request.helperSideModel,
        resumeMode: request.resumeMode,
        resumeSessionAt: request.resumeSessionAt,
        ...resolveCompactModelSettings(deps, {
          provider: providerName,
          yaModelId: requestedModel,
          modelCandidates: [requestedModel, model, input.previousResolvedModel],
        }),
      },
    };
  };

  /**
   * The one assembly of a successor session's launch, a new session that
   * continues a source: restart handoff, restart fork and the stale-session
   * handoff. The request's choices win; model, thinking, effort and service
   * tier otherwise come from the source only when the successor keeps its
   * provider, while the permission mode, recap delay and prompt-suggestion
   * preference carry across providers. The recap mode is the request's only.
   * The caller adds what only it has, such as a fork's own sandbox state.
   */
  const buildSuccessorLaunch = (input: {
    sessionId: string;
    sourceMetadata: SessionMetadata | undefined;
    sourceProvider: ProviderName;
    providerName: ProviderName;
    /**
     * Models the source ran, newest first: compact-window fallbacks when
     * the successor's own model has no known window and keeps the source's
     * provider.
     */
    sourceModels: (string | undefined)[];
    executor: string | undefined;
    sandboxLevel: SessionSandboxLevel;
    sandboxNetworkFirewall: boolean;
    /**
     * Selects a limited user's sandbox instructions. Only the stale-session
     * handoff names one: limited users cannot restart.
     */
    instructionUsername?: string;
    request: SuccessorLaunchRequest;
  }): SuccessorLaunch => {
    const { sourceMetadata: source, providerName, request } = input;
    const sameProvider = providerName === input.sourceProvider;
    const inherited = inheritSuccessorLaunchSettings(
      source?.effectiveLaunchSettings,
      {
        sameProvider,
        legacyRequestedModel: () =>
          deps.sessionMetadataService?.getRequestedModel(input.sessionId),
      },
      {
        requestedModel: request.model,
        thinking: request.thinking,
        serviceTier: request.serviceTier,
        permissionMode: request.permissionMode,
      },
    );
    const requestedModel = inherited.requestedModel ?? undefined;
    const model =
      requestedModel && requestedModel !== "default"
        ? requestedModel
        : undefined;
    const settings: ModelSettings = {
      model,
      requestedModel,
      serviceTier: inherited.serviceTier,
      thinking: inherited.thinking,
      effort: inherited.effort,
      providerName,
      executor: input.executor,
      sandboxLevel: input.sandboxLevel,
      sandboxNetworkFirewall: input.sandboxNetworkFirewall,
      instructionUsername: input.instructionUsername,
      globalInstructions: getGlobalInstructions(),
      permissions: request.permissions,
      recapMode: request.recapMode,
      recapAfterSeconds: request.recapAfterSeconds ?? source?.recapAfterSeconds,
      promptSuggestionMode:
        request.promptSuggestionMode ?? source?.promptSuggestionMode,
      helperSideModel: request.helperSideModel,
      ...resolveCompactModelSettings(deps, {
        provider: providerName,
        yaModelId: requestedModel,
        modelCandidates:
          // The source's models name another provider's windows.
          sameProvider ? [model, ...input.sourceModels] : [model],
      }),
    };
    return { ...inherited, settings };
  };

  return { getGlobalInstructions, buildResumeLaunch, buildSuccessorLaunch };
}
