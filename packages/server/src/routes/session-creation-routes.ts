import { sessionCreationReceipt } from "../sessions/session-creation-acceptance.js";
import { readLimitedJsonObject } from "./limited-json-body.js";
import { RETIRED_COMPUTER_CONTROL_ERROR } from "../machine-control/legacy-retirement.js";
import { isUrlProjectId } from "@yep-anywhere/shared";
import { mkdir } from "node:fs/promises";
import type { Context, Hono } from "hono";
import {
  DETACHED_PROJECT_PATH,
  limitedDetachedProjectPath,
} from "../projects/paths.js";
import type { ProjectScanner } from "../projects/scanner.js";
import type { createSessionCreationRequests } from "./session-creation-requests.js";
import {
  type StartSessionBody,
  hasSessionMessageContent,
  permissionModeError,
} from "./session-launch-request.js";
import { parseSessionSandboxLevel } from "./session-sandbox-settings.js";
import type { UserMessage } from "../sdk/types.js";
import { getSessionSandboxSettingsError } from "../session-sandbox.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import {
  buildUserMessageMetadata,
  normalizeOptionalServiceTier,
  parseHelperSettings,
} from "./session-request-helpers.js";
import {
  type CompactModelSettingsDeps,
  resolveCompactModelSettings,
} from "../sessions/session-compact-thresholds.js";
import { parseOptionalExecutor } from "../sessions/session-launch-settings.js";
import { buildThinkingOptions } from "./session-thinking-options.js";
import {
  actingUsername,
  applyLimitedLaunchPolicy,
} from "../auth/limitedLaunchPolicy.js";
import type { UserUsageService } from "../auth/UserUsageService.js";

/** What the session-creation routes read from the sessions route deps. */
export interface SessionCreationRouteDeps extends CompactModelSettingsDeps {
  supervisor: Supervisor;
  scanner: ProjectScanner;
  userUsageService?: UserUsageService;
}

/** The sessions route factory's closures the session-creation routes call. */
export interface SessionCreationRouteClosures {
  creationAcceptance: ReturnType<
    typeof createSessionCreationRequests
  >["creationAcceptance"];
  getGlobalInstructions: () => string | undefined;
}

/**
 * `POST /projects/:projectId/session-creations` and `POST /session-creations`,
 * the durable two-phase session creation for a project and for a detached
 * session. Registered at the routes' old position in the sessions route
 * factory so route order is unchanged.
 */
export function registerSessionCreationRoutes(
  routes: Hono,
  deps: SessionCreationRouteDeps,
  closures: SessionCreationRouteClosures,
) {
  const { creationAcceptance, getGlobalInstructions } = closures;

  const ensureDetachedProjectPath = async (
    executor?: string,
    username?: string,
  ): Promise<string> => {
    const projectPath = username
      ? limitedDetachedProjectPath(username)
      : DETACHED_PROJECT_PATH;
    await mkdir(projectPath, { recursive: true, mode: 0o700 });
    if (executor) throw new Error("SSH executors have been removed");
    return projectPath;
  };

  // POST /api/projects/:projectId/session-creations — accept initial input.
  const startProjectSession = async (c: Context) => {
    const projectId = c.req.param("projectId") ?? "";

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    let body: StartSessionBody;
    try {
      body = (await readLimitedJsonObject(
        c.req.raw,
        256 * 1024,
      )) as unknown as StartSessionBody;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const acceptance = creationAcceptance(c, body, projectId);
    if (acceptance instanceof Response) return acceptance;
    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project)
      return c.json({ error: "Project not found or path does not exist" }, 404);

    if (
      body.machineControl !== undefined &&
      typeof body.machineControl !== "boolean"
    )
      return c.json({ error: "machineControl must be a boolean" }, 400);
    if (body.computerControl)
      return c.json({ error: RETIRED_COMPUTER_CONTROL_ERROR }, 400);

    const modeError = permissionModeError(body.mode);
    if (modeError) {
      return c.json({ error: modeError }, 400);
    }

    if (!hasSessionMessageContent(body) && body.intent !== "prepare") {
      return c.json({ error: "Message is required" }, 400);
    }
    const { executor, error: executorError } = parseOptionalExecutor(
      body.executor,
    );
    if (executorError) {
      return c.json({ error: executorError }, 400);
    }
    // A limited user's session is sandboxed and obeys their lock, decided
    // here rather than in the form (topics/limited-users.md § Delivery v1).
    const limitedLaunch = applyLimitedLaunchPolicy(c, body);
    if (limitedLaunch.kind === "error") {
      return c.json({ error: limitedLaunch.error }, 403);
    }
    const sandboxSelection = parseSessionSandboxLevel(
      body.sandboxLevel,
      body.sandboxNetworkFirewall,
    );
    if ("error" in sandboxSelection) {
      return c.json({ error: sandboxSelection.error }, 400);
    }
    const helperSettings = parseHelperSettings(body);
    if (helperSettings.error) {
      return c.json({ error: helperSettings.error }, 400);
    }
    const sandboxSettingsError = getSessionSandboxSettingsError(
      sandboxSelection.sandboxLevel,
      helperSettings.recapMode,
    );
    if (sandboxSettingsError) {
      return c.json({ error: sandboxSettingsError }, 400);
    }
    if (body.workstreamId !== undefined) {
      return c.json({ error: "Managed checkout lanes have been removed" }, 410);
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

    const { thinking, effort } = buildThinkingOptions(body);

    // Convert model option (undefined or "default" means use CLI default)
    const model =
      body.model && body.model !== "default" ? body.model : undefined;
    const serviceTier = normalizeOptionalServiceTier(body.serviceTier);

    // Debug: log what we received
    console.log("[startSession] Request body:", {
      provider: body.provider,
      executor,
      model: body.model,
      serviceTier,
    });

    const replay = acceptance.replay();
    if (replay) return replay;
    const operation = deps.supervisor.startSession(
      project.path,
      userMessage,
      body.mode,
      {
        model,
        requestedModel: body.model,
        serviceTier,
        thinking,
        effort,
        providerName: body.provider,
        routerAccountId: body.routerAccountId,
        routerPoolId: body.routerPoolId,
        routerPolicy: body.routerPolicy,
        routerClaudeAiConnectors: body.routerClaudeAiConnectors,
        computerControl: body.computerControl,
        machineControl: body.machineControl,
        executor,
        sandboxLevel: sandboxSelection.sandboxLevel,
        sandboxNetworkFirewall: sandboxSelection.sandboxNetworkFirewall,
        instructionUsername: actingUsername(c),
        globalInstructions: getGlobalInstructions(),
        permissions: body.permissions,
        recapMode: helperSettings.recapMode,
        recapAfterSeconds: helperSettings.recapAfterSeconds,
        promptSuggestionMode: helperSettings.promptSuggestionMode,
        helperSideModel: helperSettings.helperSideModel,
        ...resolveCompactModelSettings(deps, {
          provider: body.provider ?? project.provider,
          yaModelId: body.model,
          modelCandidates: [body.model, model],
        }),
      },
      {
        projectId: project.id,
        creation: acceptance.creation,
      },
    );

    void operation.then(acceptance.finished, acceptance.failed);
    const saved = await acceptance.promise.catch(acceptance.refused);
    if (saved instanceof Response) return saved;
    void deps.userUsageService?.recordSession(actingUsername(c));
    if (body.intent !== "prepare")
      void deps.userUsageService?.recordTurn(
        actingUsername(c),
        userMessage.text,
      );
    return c.json(sessionCreationReceipt(saved), 202);
  };
  routes.post("/projects/:projectId/session-creations", startProjectSession);

  // POST /api/session-creations — accept a detached session.
  const startDetachedSession = async (c: Context) => {
    let body: StartSessionBody;
    try {
      body = (await readLimitedJsonObject(
        c.req.raw,
        256 * 1024,
      )) as unknown as StartSessionBody;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const acceptance = creationAcceptance(c, body, "detached");
    if (acceptance instanceof Response) return acceptance;

    if (
      body.machineControl !== undefined &&
      typeof body.machineControl !== "boolean"
    )
      return c.json({ error: "machineControl must be a boolean" }, 400);
    if (body.computerControl)
      return c.json({ error: RETIRED_COMPUTER_CONTROL_ERROR }, 400);

    const limitedLaunch = applyLimitedLaunchPolicy(c, body);
    if (limitedLaunch.kind === "error")
      return c.json({ error: limitedLaunch.error }, 403);

    const modeError = permissionModeError(body.mode);
    if (modeError) {
      return c.json({ error: modeError }, 400);
    }

    if (!hasSessionMessageContent(body) && body.intent !== "prepare") {
      return c.json({ error: "Message is required" }, 400);
    }
    const { executor, error: executorError } = parseOptionalExecutor(
      body.executor,
    );
    if (executorError) {
      return c.json({ error: executorError }, 400);
    }
    const sandboxSelection = parseSessionSandboxLevel(
      body.sandboxLevel,
      body.sandboxNetworkFirewall,
    );
    if ("error" in sandboxSelection) {
      return c.json({ error: sandboxSelection.error }, 400);
    }
    const helperSettings = parseHelperSettings(body);
    if (helperSettings.error) {
      return c.json({ error: helperSettings.error }, 400);
    }
    const sandboxSettingsError = getSessionSandboxSettingsError(
      sandboxSelection.sandboxLevel,
      helperSettings.recapMode,
    );
    if (sandboxSettingsError) {
      return c.json({ error: sandboxSettingsError }, 400);
    }

    const projectPath = await ensureDetachedProjectPath(
      executor,
      actingUsername(c),
    );
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

    const { thinking, effort } = buildThinkingOptions(body);
    const model =
      body.model && body.model !== "default" ? body.model : undefined;
    const serviceTier = normalizeOptionalServiceTier(body.serviceTier);

    const replay = acceptance.replay();
    if (replay) return replay;
    const operation = deps.supervisor.startSession(
      projectPath,
      userMessage,
      body.mode,
      {
        model,
        requestedModel: body.model,
        serviceTier,
        thinking,
        effort,
        providerName: body.provider,
        routerAccountId: body.routerAccountId,
        routerPoolId: body.routerPoolId,
        routerPolicy: body.routerPolicy,
        routerClaudeAiConnectors: body.routerClaudeAiConnectors,
        computerControl: body.computerControl,
        machineControl: body.machineControl,
        executor,
        sandboxLevel: sandboxSelection.sandboxLevel,
        sandboxNetworkFirewall: sandboxSelection.sandboxNetworkFirewall,
        globalInstructions: getGlobalInstructions(),
        instructionUsername: actingUsername(c),
        permissions: body.permissions,
        recapMode: helperSettings.recapMode,
        recapAfterSeconds: helperSettings.recapAfterSeconds,
        promptSuggestionMode: helperSettings.promptSuggestionMode,
        helperSideModel: helperSettings.helperSideModel,
      },
      {
        creation: acceptance.creation,
      },
    );

    void operation.then(acceptance.finished, acceptance.failed);
    const saved = await acceptance.promise.catch(acceptance.refused);
    if (saved instanceof Response) return saved;
    void deps.userUsageService?.recordSession(actingUsername(c));
    if (body.intent !== "prepare")
      void deps.userUsageService?.recordTurn(
        actingUsername(c),
        userMessage.text,
      );
    return c.json(sessionCreationReceipt(saved), 202);
  };
  routes.post("/session-creations", startDetachedSession);
}
