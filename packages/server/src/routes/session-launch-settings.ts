import {
  type ProviderName,
  buildEffectiveAgentContext,
} from "@yep-anywhere/shared";
import type { SessionMetadataService } from "../metadata/index.js";
import { getSessionSandboxSettingsError } from "../session-sandbox.js";
import type { ModelSettings } from "../supervisor/Supervisor.js";
import {
  type CompactModelSettingsDeps,
  resolveCompactModelSettings,
} from "./session-compact-thresholds.js";
import { parseOptionalExecutor } from "./session-request-helpers.js";
import { persistedSandboxNetworkFirewall } from "./session-sandbox-settings.js";

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

/** What the launch-settings closures read from the sessions route deps. */
export interface SessionLaunchSettingsDeps extends CompactModelSettingsDeps {
  sessionMetadataService?: SessionMetadataService;
}

/**
 * The launch-settings closures the sessions route factory shares across the
 * routes that launch or resume a session and `/clearloop`. Stateless; they
 * read `deps` at call time.
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

  return { getGlobalInstructions, buildResumeLaunch };
}
