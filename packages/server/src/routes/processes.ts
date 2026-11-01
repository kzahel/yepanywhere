import {
  HELPER_SIDE_MODEL_CHEAPEST,
  HELPER_SIDE_MODEL_SAME_AS_MAIN,
  RECAP_MODES,
  clampRecapAfterSeconds,
  type RecapMode,
  type ShowThinking,
  type ThinkingOption,
  type UrlProjectId,
  getSessionDisplayTitle,
  isYaSessionId,
  isUrlProjectId,
  parseNativeSessionId,
  thinkingOptionToConfig,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { SessionIndexService } from "../indexes/index.js";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { ProjectScanner } from "../projects/scanner.js";
import { getProvider } from "../sdk/providers/index.js";
import type { ResumeExemptionResult } from "../sessions/resume-exemption.js";
import {
  projectProviderChildren,
  resolveProviderChildSessions,
} from "../sessions/provider-child-sessions.js";
import type {
  ISessionReader,
  SessionReaderFactory,
} from "../sessions/types.js";
import { boundSessionSource } from "../sessions/provider-resolution.js";
import { getSessionSandboxSettingsError } from "../session-sandbox.js";
import {
  SessionConfigurationConflictError,
  type Supervisor,
} from "../supervisor/Supervisor.js";
import type { ProcessInfo, Project } from "../supervisor/types.js";
import { normalizeOptionalServiceTier } from "./session-request-helpers.js";
import type { AgentAuthRouter } from "../services/AgentAuthRouter.js";
import type { ClearloopBadgeResolver } from "../services/ClearloopService.js";

export interface ProcessesDeps {
  supervisor: Supervisor;
  scanner: ProjectScanner;
  readerFactory: SessionReaderFactory;
  processSessionSourceFactory?: (
    process: ProcessInfo,
    project: Project,
  ) => { reader: ISessionReader; sessionDir: string };
  sessionIndexService?: SessionIndexService;
  sessionMetadataService?: SessionMetadataService;
  agentAuthRouter?: Pick<AgentAuthRouter, "supportsServiceTierSelection">;
  getClearloopBadge?: ClearloopBadgeResolver;
  /**
   * Exempt an explicitly killed session from YA-owned auto-resume. Invoked
   * only when the abort request opts in via `blockResume` and only after the
   * provider process shutdown has been verified.
   */
  blockSessionResume?: (args: {
    sessionId: string;
  }) => Promise<ResumeExemptionResult>;
}

type SessionTitleDeps = Pick<
  ProcessesDeps,
  "sessionIndexService" | "sessionMetadataService"
>;

/**
 * A session's display title (custom title, then transcript title), or
 * undefined when it would only be "Untitled".
 */
async function sessionDisplayTitle(
  deps: SessionTitleDeps,
  sessionDir: string,
  projectId: UrlProjectId,
  sessionId: string,
  nativeSessionId: string,
  reader: ISessionReader,
  summaryTitle: string | null | undefined,
): Promise<string | undefined> {
  let title = summaryTitle ?? null;
  if (!title && deps.sessionIndexService) {
    title = await deps.sessionIndexService.getSessionTitle(
      sessionDir,
      projectId,
      nativeSessionId,
      reader,
    );
  }
  const displayTitle = getSessionDisplayTitle({
    customTitle:
      deps.sessionMetadataService?.getMetadata(sessionId)?.customTitle,
    title,
  });
  return displayTitle === "Untitled" ? undefined : displayTitle;
}

/**
 * Enrich process info with session title, model, and context usage.
 * Uses cache when available. Checks custom title from metadata service first.
 */
async function enrichProcessInfo(
  process: ProcessInfo,
  deps: ProcessesDeps,
): Promise<ProcessInfo> {
  const enriched = { ...process };
  try {
    const metadata = deps.sessionMetadataService?.getMetadata(
      process.sessionId,
    );
    const identity = isYaSessionId(process.sessionId)
      ? deps.sessionMetadataService?.identities?.resolveYa(process.sessionId)
      : undefined;
    enriched.provider =
      identity?.provider ?? metadata?.provider ?? process.provider;
    enriched.requestedModel =
      process.requestedModel ?? metadata?.requestedModel;
    const title = getSessionDisplayTitle({
      customTitle: metadata?.customTitle,
      title: null,
    });
    if (title !== "Untitled") enriched.sessionTitle = title;
    const clearloop = deps.getClearloopBadge?.(process.sessionId);
    if (clearloop !== undefined) enriched.clearloop = clearloop;
    // Public facts remain useful before binding. Unbound never opens a native
    // reader under a same-string provisional id.
    if (identity && !identity.native) return enriched;
    const projectId = identity?.projectId ?? process.projectId;
    const project =
      (await deps.scanner.getProject(projectId)) ??
      (isUrlProjectId(projectId)
        ? await deps.scanner.getOrCreateProject?.(projectId)
        : undefined);
    if (!project) return enriched;
    const bound = boundSessionSource(
      project,
      process.sessionId,
      {
        identities: deps.sessionMetadataService?.identities,
        readerFactory: deps.readerFactory,
      },
      identity ? { kind: "stored", identity } : { kind: "legacy" },
    );
    if (bound === null) return enriched;
    const legacy = bound
      ? undefined
      : deps.processSessionSourceFactory?.(process, project);
    const reader =
      bound?.source.reader ?? legacy?.reader ?? deps.readerFactory(project);
    const sessionDir =
      bound?.source.sessionDir ?? legacy?.sessionDir ?? project.sessionDir;
    const nativeProjectId = bound?.projectId ?? project.id;
    // Explicit retained legacy process entry after excluding stored identity.
    const nativeSessionId =
      bound?.nativeSessionId ?? parseNativeSessionId(process.sessionId);
    const summary =
      (deps.sessionIndexService
        ? await deps.sessionIndexService.getSessionSummaryWithCache(
            sessionDir,
            nativeProjectId,
            nativeSessionId,
            reader,
          )
        : null) ??
      (await reader.getSessionSummary(nativeSessionId, nativeProjectId));
    const displayTitle = await sessionDisplayTitle(
      deps,
      sessionDir,
      nativeProjectId,
      process.sessionId,
      nativeSessionId,
      reader,
      summary?.title,
    );
    if (displayTitle) enriched.sessionTitle = displayTitle;
    if (summary?.model) enriched.model = summary.model;
    enriched.requestedModel ??= getProvider(
      enriched.provider,
    )?.yaModelIdForReported?.(enriched.model);
    if (summary?.contextUsage) enriched.contextUsage = summary.contextUsage;
    const providerChildren = await resolveProviderChildSessions(
      reader,
      nativeSessionId,
      "accepted-or-cheap",
    );
    if (providerChildren?.length)
      enriched.providerChildren = projectProviderChildren(
        providerChildren,
        process.sessionId,
      );
  } catch {
    // Retain public metadata even when the native source is unavailable.
  }
  return enriched;
}

export function createProcessesRoutes(deps: ProcessesDeps): Hono {
  const routes = new Hono();

  // GET /api/processes - List all active processes
  // Query params:
  //   - includeTerminated: if "true", also includes recently terminated processes
  routes.get("/", async (c) => {
    const includeTerminated = c.req.query("includeTerminated") === "true";
    const processes = deps.supervisor.getProcessInfoList();

    // Enrich all processes with session titles and model info
    const enrichedProcesses = await Promise.all(
      processes.map((p) => enrichProcessInfo(p, deps)),
    );

    if (includeTerminated) {
      const terminatedProcesses =
        deps.supervisor.getRecentlyTerminatedProcesses();
      // Also enrich terminated processes
      const enrichedTerminated = await Promise.all(
        terminatedProcesses.map((p) => enrichProcessInfo(p, deps)),
      );
      return c.json({
        processes: enrichedProcesses,
        terminatedProcesses: enrichedTerminated,
      });
    }

    return c.json({ processes: enrichedProcesses });
  });

  // POST /api/processes/:processId/abort - Kill a process
  // Optional JSON body: { blockResume?: boolean }. When true (the explicit
  // Kill gesture), the session is also exempted from auto-resume after the
  // shutdown is verified — see ProcessesDeps.blockSessionResume.
  routes.post("/:processId/abort", async (c) => {
    const processId = c.req.param("processId");
    const body = await c.req
      .json<{ blockResume?: unknown }>()
      .catch(() => ({}) as { blockResume?: unknown });
    const blockResume = body.blockResume === true;

    try {
      await deps.supervisor.pauseRecapsUntilUserTurn(processId);
      const result =
        await deps.supervisor.abortProcessWithVerification(processId);
      if (!result) {
        return c.json({ error: "Process not found" }, 404);
      }

      let resumeExemption: ResumeExemptionResult | undefined;
      if (blockResume && deps.blockSessionResume) {
        try {
          resumeExemption = await deps.blockSessionResume({
            sessionId: result.sessionId,
          });
        } catch (error) {
          resumeExemption = {
            heartbeatDisabled: false,
            autoResumeDisabled: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      return c.json({
        aborted: true,
        ...result,
        ...(resumeExemption ? { resumeExemption } : {}),
      });
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Failed to verify provider process shutdown",
          processId,
          verifiedStopped: false,
        },
        500,
      );
    }
  });

  // POST /api/processes/:processId/interrupt - Interrupt current turn gracefully
  // Unlike abort, this stops the current turn but keeps the process alive.
  routes.post("/:processId/interrupt", async (c) => {
    const processId = c.req.param("processId");

    const result = await deps.supervisor.interruptProcess(processId);
    if (!result.success && !result.supported) {
      // Process not found or doesn't support interrupt
      if (
        !deps.supervisor.getProcessInfoList().some((p) => p.id === processId)
      ) {
        return c.json({ error: "Process not found" }, 404);
      }
      // Process exists but doesn't support interrupt
      return c.json({ error: "Interrupt not supported for this process" }, 400);
    }

    return c.json({
      interrupted: result.success,
      supported: result.supported,
      aborted: result.hardAborted === true,
    });
  });

  // POST /api/processes/:processId/recap - Summarize recent activity.
  routes.post("/:processId/recap", async (c) => {
    const processId = c.req.param("processId");
    let sinceMs: number | null = null;
    try {
      const body = await c.req.json<{ hiddenSinceMs?: unknown }>();
      if (
        typeof body.hiddenSinceMs === "number" &&
        Number.isFinite(body.hiddenSinceMs)
      ) {
        sinceMs = body.hiddenSinceMs;
      }
    } catch {
      // Empty body is accepted for backward compatibility.
    }

    const result = await deps.supervisor.requestRecap(processId, { sinceMs });
    if (!result.supported && result.reason === "process not found") {
      return c.json({ error: "Process not found" }, 404);
    }

    return c.json(result);
  });

  routes.post("/:processId/recap-config", async (c) => {
    const processId = c.req.param("processId");
    const process = deps.supervisor.getProcess(processId);
    if (!process) {
      return c.json({ error: "Process not found" }, 404);
    }

    let body: {
      recapMode?: unknown;
      recapAfterSeconds?: unknown;
      helperSideModel?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const updates: {
      recapMode?: RecapMode;
      recapAfterSeconds?: number;
      helperSideModel?: string;
    } = {};
    if ("recapMode" in body) {
      if (
        typeof body.recapMode !== "string" ||
        !RECAP_MODES.includes(body.recapMode as RecapMode)
      ) {
        return c.json(
          { error: `recapMode must be one of: ${RECAP_MODES.join(", ")}` },
          400,
        );
      }
      updates.recapMode = body.recapMode as RecapMode;
    }
    if ("recapAfterSeconds" in body) {
      if (
        body.recapAfterSeconds !== undefined &&
        body.recapAfterSeconds !== null &&
        body.recapAfterSeconds !== "" &&
        (typeof body.recapAfterSeconds !== "number" ||
          !Number.isFinite(body.recapAfterSeconds))
      ) {
        return c.json(
          { error: "recapAfterSeconds must be a finite number" },
          400,
        );
      }
      if (
        typeof body.recapAfterSeconds === "number" &&
        Number.isFinite(body.recapAfterSeconds)
      ) {
        updates.recapAfterSeconds = clampRecapAfterSeconds(
          body.recapAfterSeconds,
        );
      }
    }
    if ("helperSideModel" in body) {
      if (
        body.helperSideModel !== undefined &&
        body.helperSideModel !== null &&
        typeof body.helperSideModel !== "string"
      ) {
        return c.json({ error: "helperSideModel must be a string" }, 400);
      }
      const trimmed =
        typeof body.helperSideModel === "string"
          ? body.helperSideModel.trim()
          : "";
      updates.helperSideModel =
        trimmed === HELPER_SIDE_MODEL_SAME_AS_MAIN
          ? HELPER_SIDE_MODEL_SAME_AS_MAIN
          : trimmed === HELPER_SIDE_MODEL_CHEAPEST
            ? HELPER_SIDE_MODEL_CHEAPEST
            : trimmed || HELPER_SIDE_MODEL_CHEAPEST;
    }
    const sandboxSettingsError = getSessionSandboxSettingsError(
      process.sandboxEnforcement?.effective,
      updates.recapMode,
    );
    if (sandboxSettingsError) {
      return c.json({ error: sandboxSettingsError }, 400);
    }

    const updatedProcess = deps.supervisor.configureProcessRecaps(
      processId,
      updates,
    );
    if (!updatedProcess) {
      return c.json({ error: "Process not found" }, 404);
    }
    // Persist recap config so a process-dead session keeps it: recapMode is
    // required to later revive a cold fork-mode session for an away recap.
    if (
      deps.sessionMetadataService &&
      (updates.recapAfterSeconds !== undefined ||
        updates.recapMode !== undefined)
    ) {
      await deps.sessionMetadataService.updateMetadata(
        updatedProcess.sessionId,
        {
          ...(updates.recapAfterSeconds !== undefined && {
            recapAfterSeconds: updatedProcess.recapAfterSeconds,
          }),
          ...(updates.recapMode !== undefined && {
            recapMode: updatedProcess.recapMode,
          }),
        },
      );
    }
    return c.json({
      success: true,
      processId,
      recapMode: updatedProcess.recapMode,
      recapAfterSeconds: updatedProcess.recapAfterSeconds,
      helperSideModel: updatedProcess.helperSideModel,
    });
  });

  // GET /api/processes/:processId/models - Get available models from SDK
  // Returns the list of models available for this session (dynamically from SDK).
  routes.get("/:processId/models", async (c) => {
    const processId = c.req.param("processId");

    const process = deps.supervisor.getProcess(processId);
    if (!process) {
      return c.json({ error: "Process not found" }, 404);
    }

    const routed = Boolean(
      deps.sessionMetadataService?.getMetadata(process.sessionId)
        ?.routerBinding,
    );
    const [models, serviceTierSelection] = await Promise.all([
      process.supportedModels(),
      routed
        ? (deps.agentAuthRouter?.supportsServiceTierSelection() ?? false)
        : undefined,
    ]);
    if (models !== null) {
      return c.json({ models, serviceTierSelection });
    }

    const provider = getProvider(process.provider);
    if (!provider) {
      return c.json(
        { error: "Dynamic model listing not supported for this process" },
        400,
      );
    }

    return c.json({
      models: await provider.getAvailableModels(),
      serviceTierSelection,
    });
  });

  // GET /api/processes/:processId/commands - Get available slash commands from SDK
  // Returns the list of slash commands (skills) available for this session.
  routes.get("/:processId/commands", async (c) => {
    const processId = c.req.param("processId");

    const process = deps.supervisor.getProcess(processId);
    if (!process) {
      return c.json({ error: "Process not found" }, 404);
    }

    const commands = await process.supportedCommands();
    if (commands === null) {
      // Process doesn't support dynamic command listing
      return c.json(
        { error: "Dynamic command listing not supported for this process" },
        400,
      );
    }

    return c.json({ commands });
  });

  // POST /api/processes/:processId/config - Reconfigure an active process
  // Body: { model?: string, thinking?: ThinkingOption, serviceTier?: string | null }
  // A null, empty, or "default" serviceTier selects the standard tier.
  routes.post("/:processId/config", async (c) => {
    const processId = c.req.param("processId");

    const process = deps.supervisor.getProcess(processId);
    if (!process) {
      return c.json({ error: "Process not found" }, 404);
    }

    const body = await c.req.json<{
      model?: string;
      thinking?: ThinkingOption;
      showThinking?: ShowThinking;
      serviceTier?: string | null;
    }>();
    const updates: {
      model?: string;
      requestedModel?: string;
      serviceTier?: string;
      thinking?: ReturnType<typeof thinkingOptionToConfig>["thinking"];
      effort?: ReturnType<typeof thinkingOptionToConfig>["effort"];
    } = {};

    if ("model" in body) {
      updates.model =
        body.model && body.model !== "default" ? body.model : undefined;
      updates.requestedModel = body.model;
    }
    if ("thinking" in body) {
      if (body.thinking === undefined) {
        updates.thinking = undefined;
        updates.effort = undefined;
      } else {
        const { thinking, effort } = thinkingOptionToConfig(
          body.thinking,
          body.showThinking,
        );
        updates.thinking = thinking;
        updates.effort = effort;
      }
    }
    if ("serviceTier" in body) {
      const raw = body.serviceTier;
      if (
        raw === null ||
        raw === undefined ||
        raw === "" ||
        raw === "default"
      ) {
        updates.serviceTier = undefined;
      } else {
        const serviceTier = normalizeOptionalServiceTier(raw);
        if (!serviceTier) {
          return c.json({ error: "Invalid serviceTier" }, 400);
        }
        updates.serviceTier = serviceTier;
      }
    }

    let updatedProcess: Awaited<ReturnType<Supervisor["reconfigureProcess"]>>;
    try {
      updatedProcess = await deps.supervisor.reconfigureProcess(
        processId,
        updates,
      );
    } catch (error) {
      if (error instanceof SessionConfigurationConflictError) {
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }

    if (!updatedProcess) {
      return c.json({ error: "Process reconfiguration failed" }, 400);
    }

    return c.json({
      success: true,
      processId: updatedProcess.id,
      model: updatedProcess.resolvedModel ?? body.model,
      thinking: updatedProcess.thinking,
      effort: updatedProcess.effort,
      serviceTier: updatedProcess.serviceTier ?? null,
    });
  });

  // Backward-compatible alias used by the existing model switch UI.
  routes.post("/:processId/model", async (c) => {
    const processId = c.req.param("processId");
    const body = await c.req.json<{ model?: string }>();
    const process = deps.supervisor.getProcess(processId);
    if (!process) {
      return c.json({ error: "Process not found" }, 404);
    }
    let updatedProcess: Awaited<ReturnType<Supervisor["reconfigureProcess"]>>;
    try {
      updatedProcess = await deps.supervisor.reconfigureProcess(processId, {
        model: body.model && body.model !== "default" ? body.model : undefined,
        requestedModel: body.model,
      });
    } catch (error) {
      if (error instanceof SessionConfigurationConflictError) {
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }
    if (!updatedProcess) {
      return c.json({ error: "Model switching failed" }, 400);
    }
    return c.json({
      success: true,
      processId: updatedProcess.id,
      model: updatedProcess.resolvedModel ?? body.model,
    });
  });

  return routes;
}
