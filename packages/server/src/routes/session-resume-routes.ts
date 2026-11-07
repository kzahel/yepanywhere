import {
  type PermissionRules,
  type ProviderName,
  isThinkingOption,
  isUrlProjectId,
} from "@yep-anywhere/shared";
import type { Hono } from "hono";
import { getLogger } from "../logging/logger.js";
import type { SessionMetadataService } from "../metadata/index.js";
import type { ProjectScanner } from "../projects/scanner.js";
import {
  type CreateSessionBody,
  type StartSessionBody,
  hasSessionMessageContent,
  parseOptionalJsonObjectBody,
  permissionModeError,
} from "./session-launch-request.js";
import { refusedLaunchResponse } from "./session-launch-refusal.js";
import {
  type LaunchResult,
  settleLaunch,
} from "../sessions/session-launch-outcome.js";
import {
  type createSessionLaunchSettings,
  parseOptionalExecutor,
} from "../sessions/session-launch-settings.js";
import { persistedSandboxNetworkFirewall } from "../sessions/session-sandbox-inheritance.js";
import { parseSessionSandboxLevel } from "./session-sandbox-settings.js";
import type { UserMessage } from "../sdk/types.js";
import { getSessionSandboxSettingsError } from "../session-sandbox.js";
import type { ProjectQueueScheduler } from "../services/ProjectQueueScheduler.js";
import { getProvider } from "../sdk/providers/index.js";
import type { Process } from "../supervisor/Process.js";
import type {
  ModelSettings,
  SessionReactivationOverrides,
  Supervisor,
} from "../supervisor/Supervisor.js";
import {
  ResumeCompactionError,
  RetryableSessionLaunchError,
  SessionConfigurationConflictError,
  SessionMessageRejectedError,
} from "../supervisor/Supervisor.js";
import {
  buildUserMessageMetadata,
  normalizeOptionalServiceTier,
  parseHelperSettings,
  parseOptionalResumeMode,
} from "./session-request-helpers.js";
import {
  type CompactModelSettingsDeps,
  resolveCompactModelSettings,
} from "../sessions/session-compact-thresholds.js";
import {
  type ClaudeResumeApiErrorBlocker,
  getClaudeResumeBlockerFromReader,
} from "./session-claude-resume-guard.js";
import {
  type SessionProviderResolutionDeps,
  isClaudeSdkProviderName,
  providerResolutionDeps,
} from "./session-provider-resolution.js";
import { buildThinkingOptions } from "./session-thinking-options.js";
import {
  actingUsername,
  applyLimitedResumePolicy,
} from "../auth/limitedLaunchPolicy.js";
import type { UserUsageService } from "../auth/UserUsageService.js";
import { resolveExistingSessionIdentity } from "./session-existing-identity.js";
import type { SessionReaderFactory } from "../sessions/types.js";

const REACTIVATE_SHOW_THINKING_OPTIONS: ReadonlySet<unknown> = new Set([
  "default",
  "on",
  "off",
]);

function isPermissionRules(value: unknown): value is PermissionRules {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const rules = value as Record<string, unknown>;
  return ["allow", "deny"].every((field) => {
    const patterns = rules[field];
    return (
      patterns === undefined ||
      (Array.isArray(patterns) &&
        patterns.every((pattern) => typeof pattern === "string"))
    );
  });
}

function parseOptionalReactivateSessionBody(
  rawBody: string,
): { body: CreateSessionBody } | { error: string } {
  const parsed = parseOptionalJsonObjectBody(rawBody);
  if ("error" in parsed) return parsed;
  const body = parsed.body;

  if (Object.hasOwn(body, "model") && typeof body.model !== "string") {
    return { error: "model must be a string" };
  }
  if (
    Object.hasOwn(body, "provider") &&
    (typeof body.provider !== "string" ||
      !getProvider(body.provider as ProviderName))
  ) {
    return { error: "Invalid provider" };
  }
  if (
    Object.hasOwn(body, "serviceTier") &&
    body.serviceTier !== undefined &&
    body.serviceTier !== null &&
    body.serviceTier !== "" &&
    normalizeOptionalServiceTier(body.serviceTier) === undefined
  ) {
    return { error: "serviceTier must be a valid tier name" };
  }
  if (Object.hasOwn(body, "thinking") && !isThinkingOption(body.thinking)) {
    return { error: "Invalid thinking option" };
  }
  if (
    Object.hasOwn(body, "showThinking") &&
    !REACTIVATE_SHOW_THINKING_OPTIONS.has(body.showThinking)
  ) {
    return { error: "Invalid showThinking option" };
  }
  if (
    Object.hasOwn(body, "permissions") &&
    body.permissions !== undefined &&
    body.permissions !== null &&
    !isPermissionRules(body.permissions)
  ) {
    return { error: "permissions must contain string allow/deny arrays" };
  }

  return { body: body as unknown as CreateSessionBody };
}

/** What the resume and reactivate routes read from the sessions route deps. */
export interface SessionResumeRouteDeps
  extends SessionProviderResolutionDeps,
    CompactModelSettingsDeps {
  supervisor: Supervisor;
  scanner: ProjectScanner;
  readerFactory: SessionReaderFactory;
  sessionMetadataService?: SessionMetadataService;
  projectQueueScheduler?: Pick<
    ProjectQueueScheduler,
    "reserveUserSessionStart"
  >;
  userUsageService?: UserUsageService;
}

/** The sessions route factory's closures the resume routes call. */
export interface SessionResumeRouteClosures {
  buildResumeLaunch: ReturnType<
    typeof createSessionLaunchSettings
  >["buildResumeLaunch"];
  getGlobalInstructions: () => string | undefined;
}

/**
 * `POST .../sessions/:sessionId/resume`, and `POST .../reactivate` with the
 * project-queue admission middleware in front of it. Registered at the
 * routes' old position in the sessions route factory so route and
 * middleware order are unchanged.
 */
export function registerSessionResumeRoutes(
  routes: Hono,
  deps: SessionResumeRouteDeps,
  closures: SessionResumeRouteClosures,
) {
  const { buildResumeLaunch, getGlobalInstructions } = closures;

  // POST /api/projects/:projectId/sessions/:sessionId/resume - Resume session
  routes.post("/projects/:projectId/sessions/:sessionId/resume", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const requestProject = await deps.scanner.getOrCreateProject(projectId);
    if (!requestProject) {
      return c.json({ error: "Project not found or path does not exist" }, 404);
    }

    let body: StartSessionBody;
    try {
      body = await c.req.json<StartSessionBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (
      body.routerAccountId !== undefined ||
      body.routerPoolId !== undefined ||
      body.routerPolicy !== undefined ||
      body.routerClaudeAiConnectors !== undefined
    ) {
      return c.json(
        {
          error:
            "Router account selection is only supported when creating a session; resumed sessions retain their pin",
        },
        400,
      );
    }

    const modeError = permissionModeError(body.mode);
    if (modeError) {
      return c.json({ error: modeError }, 400);
    }

    if (!hasSessionMessageContent(body)) {
      return c.json({ error: "Message is required" }, 400);
    }
    const parsedBodyExecutor = parseOptionalExecutor(body.executor);
    if (parsedBodyExecutor.error) {
      return c.json({ error: parsedBodyExecutor.error }, 400);
    }
    const helperSettings = parseHelperSettings(body);
    if (helperSettings.error) {
      return c.json({ error: helperSettings.error }, 400);
    }
    const parsedResumeMode = parseOptionalResumeMode(body.resumeMode);
    if (parsedResumeMode.error) {
      return c.json({ error: parsedResumeMode.error }, 400);
    }
    const resumeMode = parsedResumeMode.resumeMode ?? "full";
    const persistedMetadata =
      deps.sessionMetadataService?.getMetadata?.(sessionId);
    const metadataProvider = deps.sessionMetadataService?.getProvider(
      sessionId,
    ) as ProviderName | undefined;
    const identity = await resolveExistingSessionIdentity({
      sessionId,
      requestProjectId: projectId,
      preferredProvider: body.provider,
      requestFallbackProvider: requestProject.provider,
      metadata: persistedMetadata,
      scanner: deps.scanner,
      providerDeps: providerResolutionDeps(deps),
    });
    if (!identity) {
      return c.json({ error: "Session not found" }, 404);
    }
    const settledSandboxLevel = persistedMetadata?.sandboxLevel ?? "none";
    const settledSandboxNetworkFirewall =
      persistedSandboxNetworkFirewall(persistedMetadata);
    if (
      body.sandboxLevel !== undefined ||
      body.sandboxNetworkFirewall !== undefined
    ) {
      const requestedSandbox = parseSessionSandboxLevel(
        body.sandboxLevel,
        body.sandboxNetworkFirewall,
        settledSandboxLevel,
        settledSandboxNetworkFirewall,
      );
      if ("error" in requestedSandbox) {
        return c.json({ error: requestedSandbox.error }, 400);
      }
      if (
        requestedSandbox.sandboxLevel !== settledSandboxLevel ||
        requestedSandbox.sandboxNetworkFirewall !==
          settledSandboxNetworkFirewall
      ) {
        return c.json(
          {
            error:
              "The session sandbox boundary is settled at creation and cannot change on resume",
          },
          409,
        );
      }
    }

    const serverTimestamp = Date.now();
    const userMessage: UserMessage = {
      text: body.message,
      images: body.images,
      documents: body.documents,
      attachments: body.attachments,
      mode: body.mode,
      tempId: body.tempId,
      metadata: buildUserMessageMetadata(
        body,
        serverTimestamp,
        "direct",
        actingUsername(c),
      ),
    };

    const providerName = body.provider ?? metadataProvider ?? identity.provider;
    const previousProcess = deps.supervisor.getProcessForSession?.(sessionId);
    const resumeDiagnostics = {
      requestedMode: resumeMode,
      provider: providerName,
      previousProcess: previousProcess
        ? {
            processId: previousProcess.id,
            state: previousProcess.state.type,
            provider: previousProcess.provider,
            supportsDynamicCommands: previousProcess.supportsDynamicCommands,
          }
        : null,
    };

    let resumeSessionAt: string | undefined;
    // A recorded same-session rewind is applied by the supervisor at process
    // launch, whichever path starts the process (topics/session-rewind.md);
    // it wins over the API-error truncation below, whose blocker check is
    // skipped here because the dropped tail is already accounted for.
    const pendingRewind =
      deps.sessionMetadataService?.getPendingRewind?.(sessionId);
    if (!pendingRewind && isClaudeSdkProviderName(providerName)) {
      let blocker: ClaudeResumeApiErrorBlocker | null = null;
      try {
        blocker = await getClaudeResumeBlockerFromReader(
          deps.readerFactory(
            { ...identity.transcriptProject, provider: identity.provider },
            identity.native,
          ),
          identity.native?.id ?? sessionId,
          identity.transcriptProjectId,
        );
      } catch (error) {
        getLogger().warn(
          {
            event: "claude_resume_api_error_check_failed",
            sessionId,
            projectId,
            providerName,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to check Claude session for resume-blocking API error",
        );
      }

      if (blocker?.resumeAtMessageId) {
        // Recoverable: resume up to the last good assistant message,
        // dropping the API-error tail, instead of forcing a handoff.
        resumeSessionAt = blocker.resumeAtMessageId;
        getLogger().info(
          {
            event: "claude_resume_truncated_after_api_error",
            sessionId,
            projectId,
            providerName,
            messageId: blocker.messageId,
            apiErrorStatus: blocker.apiErrorStatus,
            resumeSessionAt,
          },
          "Resuming Claude session before SDK API-error tail",
        );
      } else if (blocker) {
        getLogger().warn(
          {
            event: "claude_resume_blocked_after_api_error",
            sessionId,
            projectId,
            providerName,
            messageId: blocker.messageId,
            apiErrorStatus: blocker.apiErrorStatus,
          },
          "Blocked Claude provider resume after SDK API-error message",
        );
        return c.json(
          {
            error: blocker.error,
            recovery: blocker.recovery,
            resume: {
              ...resumeDiagnostics,
              blockedReason: "claude-api-error-tail",
            },
          },
          409,
        );
      }
    }

    const launch = buildResumeLaunch({
      sessionId,
      providerName,
      workingProjectPath: identity.workingProject.path,
      previousResolvedModel: previousProcess?.resolvedModel,
      request: {
        model: body.model,
        serviceTier: normalizeOptionalServiceTier(body.serviceTier),
        ...buildThinkingOptions(body),
        executor: parsedBodyExecutor.executor,
        permissions: body.permissions,
        recapMode: helperSettings.recapMode,
        recapAfterSeconds: helperSettings.recapAfterSeconds,
        promptSuggestionMode: helperSettings.promptSuggestionMode,
        helperSideModel: helperSettings.helperSideModel,
        resumeMode,
        resumeSessionAt,
      },
    });
    if ("error" in launch) {
      return c.json({ error: launch.error }, 400);
    }
    const { settings: resumeSettings, projectPath: resumeProjectPath } = launch;
    // A limited user resumes only a sandboxed session, on this host, inside
    // their lock (topics/limited-users.md § Delivery v1).
    const limitedResume = applyLimitedResumePolicy(c, resumeSettings, body);
    if (limitedResume.kind === "error") {
      return c.json({ error: limitedResume.error }, 403);
    }

    let launched: LaunchResult;
    try {
      launched = await deps.supervisor.resumeSession(
        sessionId,
        resumeProjectPath,
        userMessage,
        body.mode,
        resumeSettings,
        { requireProviderSessionId: true },
      );
    } catch (error) {
      if (error instanceof ResumeCompactionError) {
        getLogger().warn(
          {
            event: "resume_compaction_failed",
            sessionId,
            projectId,
            providerName,
            attempt: error.attempt,
          },
          "Compact-first resume failed",
        );
        return c.json(
          {
            error: error.message,
            recovery: error.recovery,
            resume: {
              ...resumeDiagnostics,
              compaction: error.attempt,
            },
          },
          409,
        );
      }
      if (error instanceof SessionMessageRejectedError) {
        return c.json({ error: error.message, reason: error.message }, 409);
      }
      if (error instanceof RetryableSessionLaunchError) {
        getLogger().warn(
          {
            event: "provider_resume_attachment_failed",
            sessionId,
            projectId,
            providerName,
            error: error.message,
          },
          "Provider resume failed before native session attachment",
        );
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }

    const outcome = settleLaunch(launched, { whenQueued: "wait" });
    if (outcome.kind === "refused") return refusedLaunchResponse(c, outcome);
    void deps.userUsageService?.recordTurn(actingUsername(c), userMessage.text);
    if (outcome.kind === "queued") {
      return c.json(
        {
          ...outcome.queued,
          serverTimestamp: Date.now(),
          resume: { ...resumeDiagnostics, outcome: "queued" },
        },
        202,
      );
    }
    const result = outcome.process;

    return c.json({
      processId: result.id,
      permissionMode: result.permissionMode,
      appliedPermissionMode: result.appliedPermissionMode,
      modeVersion: result.modeVersion,
      recapAfterSeconds: result.recapAfterSeconds,
      sandboxEnforcement: result.sandboxEnforcement,
      serverTimestamp,
      resume: {
        ...resumeDiagnostics,
        outcome: "started",
        compaction:
          resumeMode === "compact-first" ? { status: "completed" } : undefined,
      },
    });
  });

  // POST /api/projects/:projectId/sessions/:sessionId/reactivate
  // Spawn or reconcile a live harness process without delivering a turn. Every
  // request is validated and serialized, including when the session is already
  // owned or another activation is still in flight.
  routes.use(
    "/projects/:projectId/sessions/:sessionId/reactivate",
    async (c, next) => {
      const projectId = c.req.param("projectId");
      if (!isUrlProjectId(projectId) || !deps.projectQueueScheduler) {
        await next();
        return;
      }

      const release = deps.projectQueueScheduler.reserveUserSessionStart(
        projectId,
        c.req.param("sessionId"),
      );
      try {
        await next();
      } finally {
        release();
      }
    },
  );
  routes.post(
    "/projects/:projectId/sessions/:sessionId/reactivate",
    async (c) => {
      const projectId = c.req.param("projectId");
      const sessionId = c.req.param("sessionId");

      if (!isUrlProjectId(projectId)) {
        return c.json({ error: "Invalid project ID format" }, 400);
      }

      const parsedBody = parseOptionalReactivateSessionBody(await c.req.text());
      if ("error" in parsedBody) {
        return c.json({ error: parsedBody.error }, 400);
      }
      const body = parsedBody.body;
      const modeError = permissionModeError(body.mode);
      if (modeError) {
        return c.json({ error: modeError }, 400);
      }
      const parsedBodyExecutor = parseOptionalExecutor(body.executor);
      if (parsedBodyExecutor.error) {
        return c.json({ error: parsedBodyExecutor.error }, 400);
      }
      const helperSettings = parseHelperSettings(body);
      if (helperSettings.error) {
        return c.json({ error: helperSettings.error }, 400);
      }
      const requestProject = await deps.scanner.getOrCreateProject(projectId);
      if (!requestProject) {
        return c.json(
          { error: "Project not found or path does not exist" },
          404,
        );
      }

      const metadata = deps.sessionMetadataService?.getMetadata?.(sessionId);
      const parsedSandbox = parseSessionSandboxLevel(
        body.sandboxLevel,
        body.sandboxNetworkFirewall,
        metadata?.sandboxLevel ?? "none",
        persistedSandboxNetworkFirewall(metadata),
      );
      if ("error" in parsedSandbox) {
        return c.json({ error: parsedSandbox.error }, 400);
      }
      const hasProvider = Object.hasOwn(body, "provider");
      const hasExecutor = Object.hasOwn(body, "executor");
      const hasModel = Object.hasOwn(body, "model");
      const hasServiceTier = Object.hasOwn(body, "serviceTier");
      const hasThinking = Object.hasOwn(body, "thinking");
      const hasSandbox =
        Object.hasOwn(body, "sandboxLevel") ||
        Object.hasOwn(body, "sandboxNetworkFirewall");
      const hasPermissions = Object.hasOwn(body, "permissions");
      const hasRecapMode = Object.hasOwn(body, "recapMode");
      const hasRecapAfterSeconds = Object.hasOwn(body, "recapAfterSeconds");
      const hasPromptSuggestionMode = Object.hasOwn(
        body,
        "promptSuggestionMode",
      );
      const hasHelperSideModel = Object.hasOwn(body, "helperSideModel");

      const existingProcess = deps.supervisor.getProcessForSession?.(sessionId);
      const identity = existingProcess
        ? null
        : await resolveExistingSessionIdentity({
            sessionId,
            requestProjectId: projectId,
            preferredProvider: hasProvider
              ? body.provider
              : (metadata?.provider as ProviderName | undefined),
            metadata,
            scanner: deps.scanner,
            providerDeps: providerResolutionDeps(deps),
          });
      if (!existingProcess && !identity) {
        return c.json({ error: "Session not found" }, 404);
      }
      let providerName = hasProvider
        ? body.provider
        : (metadata?.provider as ProviderName | undefined);
      if (!providerName) {
        providerName = existingProcess?.provider ?? identity?.provider;
      }
      if (!providerName) {
        return c.json({ error: "Session provider not found" }, 404);
      }
      const executor = hasExecutor
        ? parsedBodyExecutor.executor
        : metadata?.executor;
      const requestedModel = hasModel ? body.model : metadata?.requestedModel;
      const model =
        requestedModel && requestedModel !== "default"
          ? requestedModel
          : undefined;
      const serviceTier = normalizeOptionalServiceTier(body.serviceTier);
      const thinkingOptions = hasThinking
        ? buildThinkingOptions(body)
        : undefined;
      const sandboxLevel = hasSandbox
        ? parsedSandbox.sandboxLevel
        : metadata?.sandboxLevel;
      const sandboxNetworkFirewall = hasSandbox
        ? parsedSandbox.sandboxNetworkFirewall
        : metadata?.sandboxLevel === "project-write" &&
          metadata.sandboxNetworkFirewall !== false;
      const recapMode = hasRecapMode
        ? helperSettings.recapMode
        : metadata?.recapMode;
      const recapAfterSeconds = hasRecapAfterSeconds
        ? helperSettings.recapAfterSeconds
        : metadata?.recapAfterSeconds;
      const promptSuggestionMode = hasPromptSuggestionMode
        ? helperSettings.promptSuggestionMode
        : metadata?.promptSuggestionMode;
      const sandboxSettingsError = getSessionSandboxSettingsError(
        sandboxLevel,
        recapMode,
      );
      if (sandboxSettingsError) {
        return c.json({ error: sandboxSettingsError }, 400);
      }

      const coldSettings: ModelSettings = {
        model,
        requestedModel,
        ...(hasServiceTier ? { serviceTier } : {}),
        ...thinkingOptions,
        providerName,
        executor,
        ...(hasPermissions
          ? { permissions: body.permissions ?? undefined }
          : {}),
        ...(hasSandbox || sandboxLevel === "project-write"
          ? {
              sandboxLevel,
              sandboxNetworkFirewall,
              sandboxStateKey: metadata?.sandboxStateKey,
            }
          : {}),
        globalInstructions: getGlobalInstructions(),
        recapAfterSeconds,
        recapMode,
        promptSuggestionMode,
        ...(hasHelperSideModel
          ? { helperSideModel: helperSettings.helperSideModel }
          : {}),
        ...resolveCompactModelSettings(deps, {
          provider: providerName,
          yaModelId: requestedModel,
          modelCandidates: [requestedModel, model],
        }),
      };
      const overrideModelSettings: ModelSettings = {
        ...(hasModel ? { model, requestedModel: body.model } : {}),
        ...(hasServiceTier ? { serviceTier } : {}),
        ...thinkingOptions,
        ...(hasProvider ? { providerName: body.provider } : {}),
        ...(hasExecutor ? { executor: parsedBodyExecutor.executor } : {}),
        ...(hasPermissions
          ? { permissions: body.permissions ?? undefined }
          : {}),
        ...(hasSandbox
          ? {
              sandboxLevel: parsedSandbox.sandboxLevel,
              sandboxNetworkFirewall: parsedSandbox.sandboxNetworkFirewall,
              sandboxStateKey: metadata?.sandboxStateKey,
            }
          : {}),
        ...(hasRecapMode ? { recapMode: helperSettings.recapMode } : {}),
        ...(hasRecapAfterSeconds
          ? { recapAfterSeconds: helperSettings.recapAfterSeconds }
          : {}),
        ...(hasPromptSuggestionMode
          ? { promptSuggestionMode: helperSettings.promptSuggestionMode }
          : {}),
        ...(hasHelperSideModel
          ? { helperSideModel: helperSettings.helperSideModel }
          : {}),
      };
      // A limited user reactivates only a sandboxed session, on this host,
      // inside their lock (topics/limited-users.md § Delivery v1). The cold
      // settings already carry every override the body named, so checking
      // them covers both; an override the lock then replaced follows it.
      const limitedReactivate = applyLimitedResumePolicy(c, coldSettings, body);
      if (limitedReactivate.kind === "error") {
        return c.json({ error: limitedReactivate.error }, 403);
      }
      if (limitedReactivate.kind === "applied") {
        for (const field of [
          "model",
          "requestedModel",
          "thinking",
          "effort",
        ] as const) {
          if (Object.hasOwn(overrideModelSettings, field)) {
            (overrideModelSettings as Record<string, unknown>)[field] =
              coldSettings[field];
          }
        }
      }
      const requestedOverrides: SessionReactivationOverrides = {
        ...(Object.hasOwn(body, "mode") && body.mode !== undefined
          ? { permissionMode: body.mode }
          : {}),
        ...(Object.keys(overrideModelSettings).length > 0
          ? { modelSettings: overrideModelSettings }
          : {}),
      };
      const reactivationProjectPath =
        sandboxLevel === "project-write"
          ? (metadata?.sandboxProjectPath ??
            existingProcess?.projectPath ??
            identity?.workingProject.path ??
            requestProject.path)
          : (existingProcess?.projectPath ??
            identity?.workingProject.path ??
            requestProject.path);
      const reservationProjectId =
        existingProcess?.projectId ?? identity?.workingProjectId ?? projectId;
      const release =
        reservationProjectId === projectId
          ? undefined
          : deps.projectQueueScheduler?.reserveUserSessionStart(
              reservationProjectId,
              sessionId,
            );

      let process: Process;
      try {
        process = await deps.supervisor.reactivateSession(
          reactivationProjectPath,
          sessionId,
          body.mode,
          coldSettings,
          { requestedOverrides },
        );
      } catch (error) {
        return c.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "Failed to reactivate session",
          },
          error instanceof SessionConfigurationConflictError ? 409 : 503,
        );
      } finally {
        release?.();
      }

      return c.json({
        processId: process.id,
        permissionMode: process.permissionMode,
        appliedPermissionMode: process.appliedPermissionMode,
        modeVersion: process.modeVersion,
        recapAfterSeconds: process.recapAfterSeconds,
        sandboxEnforcement: process.sandboxEnforcement,
        serverTimestamp: Date.now(),
      });
    },
  );
}
