/**
 * Server settings API routes
 */

import {
  parseSteeringModeSettings,
  NEW_SESSION_BOOTSTRAP,
  CODEX_REASONING_SUMMARIES,
  limitedUserInstructionsError,
  type LimitedUserInstructions,
  CODEX_PLAN_TOOL_MODES,
  CODEX_CYBER_ACCESS_PROGRAMS,
  DEFAULT_CLEARLOOP_INACTIVITY_SECONDS,
  MAX_CLEARLOOP_INACTIVITY_SECONDS,
  MIN_CLEARLOOP_INACTIVITY_SECONDS,
  clampClearloopInactivitySeconds,
  DEFAULT_PROJECT_QUEUE_QUIET_SECONDS,
  DEFAULT_PROMPT_CACHE_KEEPALIVE_INACTIVITY_MINUTES,
  MAX_PROJECT_QUEUE_QUIET_SECONDS,
  MAX_SUBAGENT_MAX_DEPTH,
  MIN_SUBAGENT_MAX_DEPTH,
  PROMPT_CACHE_KEEPALIVE_MODES,
  clampProjectQueueQuietSeconds,
  isIdleReapHours,
  isHostAwakeBatteryFloorPercent,
  isHostAwakeMode,
  isCodexReasoningSummary,
  isCodexPlanToolMode,
  isCodexCyberAccessProgram,
  isSubagentMaxDepth,
  isProjectQueueReadinessCommand,
  isLoopbackGatewayUrl,
  isValidGatewayServiceId,
  type GatewayService,
  parseGatewayServices,
  normalizeGatewayServiceUrl,
  normalizeYaClientBaseUrl,
  normalizeYaClientBaseUrlFromShareViewerUrl,
  normalizeIdleReapHours,
  parseClaudeAdditionalModelSelections,
  parseClaudeSteerBackgroundBashSettings,
  parseLongContextEffortWarningSettings,
  parseInstructionRestorationSettings,
  parseSpeechVoiceBackends,
} from "@yep-anywhere/shared";
import { Hono, type Context } from "hono";
import {
  isAllowedHost,
  isAllowedOrigin,
  wouldAllowHost,
  wouldAllowOrigin,
} from "../middleware/allowed-hosts.js";
import {
  allowedHostsChangeImpact,
  refuseUnconfirmedImpact,
} from "../network/connection-impact.js";
import { getRequestConnectionPath } from "../network/connection-path.js";
import {
  parseRendezSettings,
  type RendezWatchStatus,
} from "../services/RendezWatchService.js";
import { InstructionPackets } from "../sdk/providers/instruction-packets.js";
import { PRINCIPAL_VARIABLE, type Principal } from "../auth/principal.js";
import {
  type FileAccessSettings,
  getFileAccessInfo,
} from "../middleware/file-access.js";
import type { SessionMetadataService } from "../metadata/index.js";
import type { ProjectStoragePolicy } from "../projects/projectStoragePolicy.js";
import { defaultGatewayServiceExportPaths } from "../sdk/providers/gatewayServiceExport.js";
import { detectEndpointEffort } from "../services/GatewayEffortProbe.js";
import type { PublicShareService } from "../services/PublicShareService.js";
import type { HostAwakeService } from "../services/host-awake/HostAwakeService.js";
import type {
  CodexUpdatePolicy,
  ServerSettings,
  ServerSettingsService,
} from "../services/ServerSettingsService.js";
import {
  CODEX_UPDATE_POLICIES,
  CommittedSettingsSaveError,
  DEFAULT_SERVER_SETTINGS,
  MAX_SOURCE_REVIEW_RESPONSE_TURNS,
  MIN_SOURCE_REVIEW_RESPONSE_TURNS,
} from "../services/ServerSettingsService.js";

import {
  mergeClientDefaults,
  normalizeClaudeGatewayUrl,
  parseAgentContextHints,
  parseCacheMissBilling,
  parseClaudeAutoCompactPercentOverride,
  parseClaudeGatewayStartCommand,
  parseClientDefaults,
  parseFileAccess,
  parseHostIdentity,
  parseHostAliasList,
  parseNewSessionDefaults,
  parsePromptCacheKeepalive,
  parseSpeechAudioRetention,
} from "./settings-parsers.js";

export interface SettingsRoutesDeps {
  serverSettingsService: ServerSettingsService;
  newSessionBootstrap?: (context: Context) => Response | Promise<Response>;
  /** Shared resolver and transition owner for project-scoped YA storage. */
  projectStoragePolicy?: ProjectStoragePolicy;
  /** Server-stored per-session cache-billing evidence log. */
  sessionMetadataService?: SessionMetadataService;
  /** Callback to apply allowedHosts changes at runtime */
  onAllowedHostsChanged?: (value: string | undefined) => void;
  /** Callback to apply fileAccess changes at runtime */
  onFileAccessChanged?: (value: FileAccessSettings | undefined) => void;
  /** Callback to apply remote session persistence changes at runtime */
  onRemoteSessionPersistenceChanged?: (
    enabled: boolean,
  ) => Promise<void> | void;
  /** Callback to apply Claude Gateway transport settings at runtime. */
  onClaudeGatewaySettingsChanged?: (settings: {
    services: readonly GatewayService[];
    /** Whether the services are also published for the provider CLIs. */
    exportToProviderClis?: boolean;
    /** Whether endpoints are asked which thinking efforts they accept. */
    effortDetection?: boolean;
    defaultServiceId?: string;
    disableAgent: boolean;
    disablePlanMode: boolean;
  }) => Promise<void> | void;
  /** Callback to apply Ollama URL changes at runtime */
  onOllamaUrlChanged?: (url: string | undefined) => void;
  onProjectQueueReadinessChanged?: () => void;
  /** Callback to apply Ollama system prompt changes at runtime */
  onOllamaSystemPromptChanged?: (prompt: string | undefined) => void;
  /** Callback to apply Ollama full system prompt toggle at runtime */
  onOllamaUseFullSystemPromptChanged?: (enabled: boolean) => void;
  /** Callback to apply Grok Build XAI_API_KEY opt-in at runtime */
  onGrokBuildUseXaiApiKeyChanged?: (enabled: boolean) => void;
  /** Current effective idle-reap grace, including legacy env fallback. */
  getIdleReapHours?: () => number;
  /** Callback to apply idle-reap grace changes to existing processes. */
  onIdleReapHoursChanged?: (hours: number) => void;
  /** Public share storage, used to revoke existing shares when disabled */
  publicShareService?: PublicShareService;
  /** Process-global host-awake policy and status owner. */
  hostAwakeService?: HostAwakeService;
  /** Which projects' .rendez observers are running. */
  getRendezStatus?: () => RendezWatchStatus;
}

/**
 * The settings fields a limited user's client reads to render the app and
 * default their own work. Everything else — secrets such as the webhook token,
 * host inventory such as remote executors, gateway and Ollama endpoints and
 * start commands, file-access prefixes, the readiness command, and global
 * instructions — stays with the superuser. An allowlist, so a field added
 * later is withheld until someone lists it.
 * Contract: topics/limited-users.md § Delivery v1 — Authorization.
 */
const LIMITED_USER_SETTINGS_FIELDS = [
  "clientDefaults",
  "newSessionDefaults",
  "serviceWorkerEnabled",
  "limitedUsersEnabled",
  "publicSharesEnabled",
  "sourceReviewSubmissionsEnabled",
  "hostProcessObservabilityEnabled",
  "hostIdentity",
  "longContextEffortWarning",
  "deferredJoinWindowSeconds",
  "composeAnchorsEnabled",
  "turnTimestamps",
  "projectQueueQuietSeconds",
  "clearloopInactivitySeconds",
] as const satisfies readonly (keyof ServerSettings)[];

/** The settings document as a limited user may read it. */
export function projectSettingsForLimitedUser(
  settings: ServerSettings,
): Partial<ServerSettings> {
  const projected: Record<string, unknown> = {};
  for (const field of LIMITED_USER_SETTINGS_FIELDS) {
    if (settings[field] !== undefined) projected[field] = settings[field];
  }
  return projected as Partial<ServerSettings>;
}

export function createSettingsRoutes(deps: SettingsRoutesDeps) {
  const app = new Hono<{
    Variables: Record<typeof PRINCIPAL_VARIABLE, Principal>;
  }>();
  let settingsUpdateTail: Promise<void> = Promise.resolve();
  const serializeSettingsUpdate = <T>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    const result = settingsUpdateTail.then(operation);
    settingsUpdateTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const {
    serverSettingsService,
    projectStoragePolicy,
    sessionMetadataService,
    onAllowedHostsChanged,
    onFileAccessChanged,
    onRemoteSessionPersistenceChanged,
    onClaudeGatewaySettingsChanged,
    onOllamaUrlChanged,
    onOllamaSystemPromptChanged,
    onOllamaUseFullSystemPromptChanged,
    onGrokBuildUseXaiApiKeyChanged,
    getIdleReapHours,
    onIdleReapHoursChanged,
    publicShareService,
    hostAwakeService,
  } = deps;

  /**
   * GET /api/settings
   * Get all server settings; a limited user gets only their projection.
   */
  app.get("/", (c) => {
    if (
      deps.newSessionBootstrap &&
      c.req.query("bootstrap") === NEW_SESSION_BOOTSTRAP &&
      c.req.header("Accept")?.includes("text/event-stream")
    )
      return deps.newSessionBootstrap(c);
    const settings = serverSettingsService.getSettings();
    const principal = c.get(PRINCIPAL_VARIABLE) as Principal | undefined;
    if (principal && principal.kind !== "superuser") {
      return c.json({ settings: projectSettingsForLimitedUser(settings) });
    }
    return c.json({
      settings: {
        ...settings,
        ...(getIdleReapHours ? { idleReapHours: getIdleReapHours() } : {}),
        // Where the provider-CLI export writes, so the client can state the
        // exact command that reaches each service. Server-derived like
        // idleReapHours above: reported, never accepted back.
        gatewayServiceExportPaths: defaultGatewayServiceExportPaths(),
      },
    });
  });

  /**
   * GET /api/settings/rendez/status
   * Projects whose .rendez observer is running; empty when none is.
   */
  app.get("/rendez/status", (c) => {
    const principal = c.get(PRINCIPAL_VARIABLE);
    if (principal && principal.kind !== "superuser")
      return c.json({ error: "Administrator access required" }, 403);
    return c.json(deps.getRendezStatus?.() ?? { watching: [] });
  });

  app.post("/instruction-restoration/preview", async (c) => {
    const principal = c.get(PRINCIPAL_VARIABLE);
    if (principal && principal.kind !== "superuser")
      return c.json({ error: "Administrator access required" }, 403);
    const settings = parseInstructionRestorationSettings(
      await c.req.json().catch(() => null),
    );
    if (!settings?.pathPrefix)
      return c.json(
        { error: "Invalid instruction path prefix or pattern" },
        400,
      );
    try {
      return c.json(
        await new InstructionPackets(
          settings.pathPrefix,
          settings.pattern,
          process.cwd(),
        ).preview(),
      );
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
  });

  app.get("/host-awake/status", async (c) => {
    if (!hostAwakeService) {
      return c.json({ error: "Host-awake status is unavailable" }, 404);
    }
    const status = await hostAwakeService.getStatus({
      forceRefresh: c.req.query("refresh") === "1",
    });
    return c.json({ status });
  });

  /**
   * GET /api/settings/cache-miss-billing/events
   * Read the server-stored prompt-cache billing evidence log.
   */
  app.get("/cache-miss-billing/events", (c) => {
    const rawLimit = Number(c.req.query("limit") ?? 200);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), 500)
        : 200;
    const includeExpectedExpiry = c.req.query("includeExpectedExpiry") === "1";
    return c.json({
      events:
        sessionMetadataService?.getCacheMissBillingEvents(limit, {
          includeExpectedExpiry,
        }) ?? [],
    });
  });

  /**
   * GET /api/settings/file-access
   * Read-only info for the File access settings UI: whether an env var pins
   * the allow-set, plus the resolved temp/uploads/home prefixes for hints.
   */
  app.get("/file-access", (c) => {
    return c.json(getFileAccessInfo());
  });

  /**
   * PUT /api/settings
   * Update server settings
   */
  app.put("/", (c) =>
    serializeSettingsUpdate(async () => {
      const body = await c.req.json<Partial<ServerSettings>>();

      const updates: Partial<ServerSettings> = {};

      if ("rendez" in body) {
        try {
          updates.rendez = parseRendezSettings(body.rendez);
        } catch (error) {
          return c.json(
            { error: error instanceof Error ? error.message : String(error) },
            400,
          );
        }
      }

      if ("projectDirectoryStorage" in body) {
        if (
          body.projectDirectoryStorage !== "app-data" &&
          body.projectDirectoryStorage !== "project"
        ) {
          return c.json(
            { error: "projectDirectoryStorage must be app-data or project" },
            400,
          );
        }
        updates.projectDirectoryStorage = body.projectDirectoryStorage;
      }
      if ("toolResultMediaPreservation" in body) {
        if (
          body.toolResultMediaPreservation !== "on-demand" &&
          body.toolResultMediaPreservation !== "preserve"
        ) {
          return c.json(
            {
              error:
                "toolResultMediaPreservation must be on-demand or preserve",
            },
            400,
          );
        }
        updates.toolResultMediaPreservation = body.toolResultMediaPreservation;
      }

      // Handle boolean settings
      if (typeof body.serviceWorkerEnabled === "boolean") {
        updates.serviceWorkerEnabled = body.serviceWorkerEnabled;
      }
      if (typeof body.persistRemoteSessionsToDisk === "boolean") {
        updates.persistRemoteSessionsToDisk = body.persistRemoteSessionsToDisk;
      }
      if (typeof body.clientLogCollectionRequested === "boolean") {
        updates.clientLogCollectionRequested =
          body.clientLogCollectionRequested;
      }
      if (typeof body.approvalAuditLogEnabled === "boolean") {
        updates.approvalAuditLogEnabled = body.approvalAuditLogEnabled;
      }
      if (typeof body.agentServerAccessEnabled === "boolean") {
        updates.agentServerAccessEnabled = body.agentServerAccessEnabled;
      }
      if (typeof body.agentApiEnabled === "boolean")
        updates.agentApiEnabled = body.agentApiEnabled;
      if (typeof body.agentApiManagementEnabled === "boolean")
        updates.agentApiManagementEnabled = body.agentApiManagementEnabled;
      if (typeof body.publicSharesEnabled === "boolean") {
        updates.publicSharesEnabled = body.publicSharesEnabled;
      }
      if (typeof body.limitedUsersEnabled === "boolean") {
        updates.limitedUsersEnabled = body.limitedUsersEnabled;
      }
      if ("liveWorktreeMonitoringEnabled" in body) {
        if (typeof body.liveWorktreeMonitoringEnabled !== "boolean") {
          return c.json(
            { error: "liveWorktreeMonitoringEnabled must be a boolean" },
            400,
          );
        }
        updates.liveWorktreeMonitoringEnabled =
          body.liveWorktreeMonitoringEnabled;
      }
      if ("sourceReviewSubmissionsEnabled" in body) {
        if (typeof body.sourceReviewSubmissionsEnabled !== "boolean") {
          return c.json(
            { error: "sourceReviewSubmissionsEnabled must be a boolean" },
            400,
          );
        }
        updates.sourceReviewSubmissionsEnabled =
          body.sourceReviewSubmissionsEnabled;
      }
      if ("sourceReviewResponseTurns" in body) {
        if (
          typeof body.sourceReviewResponseTurns !== "number" ||
          !Number.isInteger(body.sourceReviewResponseTurns) ||
          body.sourceReviewResponseTurns < MIN_SOURCE_REVIEW_RESPONSE_TURNS ||
          body.sourceReviewResponseTurns > MAX_SOURCE_REVIEW_RESPONSE_TURNS
        ) {
          return c.json(
            {
              error: `sourceReviewResponseTurns must be an integer from ${MIN_SOURCE_REVIEW_RESPONSE_TURNS} through ${MAX_SOURCE_REVIEW_RESPONSE_TURNS}`,
            },
            400,
          );
        }
        updates.sourceReviewResponseTurns = body.sourceReviewResponseTurns;
      }
      if ("hostProcessObservabilityEnabled" in body) {
        if (typeof body.hostProcessObservabilityEnabled !== "boolean") {
          return c.json(
            { error: "hostProcessObservabilityEnabled must be a boolean" },
            400,
          );
        }
        updates.hostProcessObservabilityEnabled =
          body.hostProcessObservabilityEnabled;
      }
      if ("subagentMaxDepth" in body) {
        if (!isSubagentMaxDepth(body.subagentMaxDepth)) {
          return c.json(
            {
              error: `subagentMaxDepth must be null or an integer from ${MIN_SUBAGENT_MAX_DEPTH} through ${MAX_SUBAGENT_MAX_DEPTH}`,
            },
            400,
          );
        }
        updates.subagentMaxDepth = body.subagentMaxDepth;
      }
      if (typeof body.composeAnchorsEnabled === "boolean") {
        updates.composeAnchorsEnabled = body.composeAnchorsEnabled;
      }
      if ("turnTimestamps" in body) {
        if (
          body.turnTimestamps !== "off" &&
          body.turnTimestamps !== "before" &&
          body.turnTimestamps !== "after"
        ) {
          return c.json(
            { error: "turnTimestamps must be one of: off, before, after" },
            400,
          );
        }
        updates.turnTimestamps = body.turnTimestamps;
      }
      if ("hostAwakeMode" in body) {
        if (!isHostAwakeMode(body.hostAwakeMode)) {
          return c.json(
            {
              error:
                "hostAwakeMode must be one of: off, idle, idle-and-closed-lid-on-external-power",
            },
            400,
          );
        }
        updates.hostAwakeMode = body.hostAwakeMode;
      }
      if ("hostAwakeBatteryFloorPercent" in body) {
        if (
          !isHostAwakeBatteryFloorPercent(body.hostAwakeBatteryFloorPercent)
        ) {
          return c.json(
            {
              error:
                "hostAwakeBatteryFloorPercent must be a whole number from 1 through 100",
            },
            400,
          );
        }
        updates.hostAwakeBatteryFloorPercent =
          body.hostAwakeBatteryFloorPercent;
      }
      if ("deferredJoinWindowSeconds" in body) {
        if (
          body.deferredJoinWindowSeconds === undefined ||
          body.deferredJoinWindowSeconds === null
        ) {
          updates.deferredJoinWindowSeconds = undefined;
        } else if (
          typeof body.deferredJoinWindowSeconds === "number" &&
          Number.isFinite(body.deferredJoinWindowSeconds) &&
          body.deferredJoinWindowSeconds >= 0
        ) {
          updates.deferredJoinWindowSeconds = body.deferredJoinWindowSeconds;
        } else {
          return c.json(
            {
              error:
                "deferredJoinWindowSeconds must be a non-negative number of seconds (0 = never join)",
            },
            400,
          );
        }
      }
      if ("projectQueueReadinessCheck" in body) {
        if (body.projectQueueReadinessCheck === null) {
          updates.projectQueueReadinessCheck = null;
        } else if (
          isProjectQueueReadinessCommand(body.projectQueueReadinessCheck)
        ) {
          updates.projectQueueReadinessCheck = {
            executable: body.projectQueueReadinessCheck.executable,
            args: [...body.projectQueueReadinessCheck.args],
          };
        } else {
          return c.json(
            {
              error:
                "projectQueueReadinessCheck must be null or an executable with string args (up to 128 args and 16 KiB total)",
            },
            400,
          );
        }
      }
      if ("projectQueueQuietSeconds" in body) {
        if (
          body.projectQueueQuietSeconds === undefined ||
          body.projectQueueQuietSeconds === null
        ) {
          updates.projectQueueQuietSeconds =
            DEFAULT_PROJECT_QUEUE_QUIET_SECONDS;
        } else if (
          typeof body.projectQueueQuietSeconds === "number" &&
          Number.isFinite(body.projectQueueQuietSeconds) &&
          body.projectQueueQuietSeconds >= 0 &&
          body.projectQueueQuietSeconds <= MAX_PROJECT_QUEUE_QUIET_SECONDS
        ) {
          updates.projectQueueQuietSeconds =
            clampProjectQueueQuietSeconds(body.projectQueueQuietSeconds) ??
            DEFAULT_PROJECT_QUEUE_QUIET_SECONDS;
        } else {
          return c.json(
            {
              error: `projectQueueQuietSeconds must be a number of seconds from 0 to ${MAX_PROJECT_QUEUE_QUIET_SECONDS}`,
            },
            400,
          );
        }
      }

      if ("clearloopInactivitySeconds" in body) {
        if (
          body.clearloopInactivitySeconds === undefined ||
          body.clearloopInactivitySeconds === null
        ) {
          updates.clearloopInactivitySeconds =
            DEFAULT_CLEARLOOP_INACTIVITY_SECONDS;
        } else if (
          typeof body.clearloopInactivitySeconds === "number" &&
          Number.isFinite(body.clearloopInactivitySeconds) &&
          body.clearloopInactivitySeconds >= MIN_CLEARLOOP_INACTIVITY_SECONDS &&
          body.clearloopInactivitySeconds <= MAX_CLEARLOOP_INACTIVITY_SECONDS
        ) {
          updates.clearloopInactivitySeconds =
            clampClearloopInactivitySeconds(body.clearloopInactivitySeconds) ??
            DEFAULT_CLEARLOOP_INACTIVITY_SECONDS;
        } else {
          return c.json(
            {
              error: `clearloopInactivitySeconds must be a number of seconds from ${MIN_CLEARLOOP_INACTIVITY_SECONDS} to ${MAX_CLEARLOOP_INACTIVITY_SECONDS}`,
            },
            400,
          );
        }
      }

      if ("yaClientBaseUrl" in body) {
        if (
          body.yaClientBaseUrl === undefined ||
          body.yaClientBaseUrl === null ||
          body.yaClientBaseUrl === ""
        ) {
          updates.yaClientBaseUrl = undefined;
          updates.publicShareViewerBaseUrl = undefined;
        } else if (typeof body.yaClientBaseUrl === "string") {
          try {
            updates.yaClientBaseUrl = normalizeYaClientBaseUrl(
              body.yaClientBaseUrl,
            );
            updates.publicShareViewerBaseUrl = undefined;
          } catch (error) {
            return c.json(
              {
                error:
                  error instanceof Error ? error.message : "Invalid YA URL",
              },
              400,
            );
          }
        } else {
          return c.json({ error: "yaClientBaseUrl must be a string URL" }, 400);
        }
      } else if ("publicShareViewerBaseUrl" in body) {
        if (
          body.publicShareViewerBaseUrl === undefined ||
          body.publicShareViewerBaseUrl === null ||
          body.publicShareViewerBaseUrl === ""
        ) {
          updates.yaClientBaseUrl = undefined;
          updates.publicShareViewerBaseUrl = undefined;
        } else if (typeof body.publicShareViewerBaseUrl === "string") {
          try {
            updates.yaClientBaseUrl =
              normalizeYaClientBaseUrlFromShareViewerUrl(
                body.publicShareViewerBaseUrl,
              );
            updates.publicShareViewerBaseUrl = undefined;
          } catch (error) {
            return c.json(
              {
                error:
                  error instanceof Error
                    ? error.message
                    : "Invalid public share viewer URL",
              },
              400,
            );
          }
        } else {
          return c.json(
            { error: "publicShareViewerBaseUrl must be a string URL" },
            400,
          );
        }
      }

      if ("hostIdentity" in body) {
        const parsedHostIdentity = parseHostIdentity(body.hostIdentity);
        if (parsedHostIdentity === null) {
          return c.json(
            { error: "hostIdentity.icon must contain exactly one marker" },
            400,
          );
        }
        updates.hostIdentity = parsedHostIdentity;
      }

      // Handle chromeOsHosts array
      if (Array.isArray(body.chromeOsHosts)) {
        const { hosts, invalidHost } = parseHostAliasList(body.chromeOsHosts);
        if (invalidHost) {
          return c.json(
            { error: `Invalid ChromeOS host alias: ${invalidHost}` },
            400,
          );
        }
        updates.chromeOsHosts = hosts;
      }

      // Handle allowedHosts string ("*", comma-separated hostnames, or undefined to clear)
      if ("allowedHosts" in body) {
        if (
          body.allowedHosts === undefined ||
          body.allowedHosts === null ||
          body.allowedHosts === ""
        ) {
          updates.allowedHosts = undefined;
        } else if (typeof body.allowedHosts === "string") {
          updates.allowedHosts = body.allowedHosts;
        }
        const refusal = refuseUnconfirmedImpact(
          c,
          allowedHostsChangeImpact(
            getRequestConnectionPath(c),
            c.req.header("origin"),
            { host: isAllowedHost, origin: isAllowedOrigin },
            {
              host: (host) => wouldAllowHost(host, updates.allowedHosts),
              origin: (origin) =>
                wouldAllowOrigin(origin, updates.allowedHosts),
            },
          ),
        );
        if (refusal) return refusal;
      }

      // Handle fileAccess object (checkbox model; undefined/null/"" = secure defaults)
      if ("fileAccess" in body) {
        const parsed = parseFileAccess(body.fileAccess);
        if (parsed === null) {
          return c.json({ error: "Invalid fileAccess setting" }, 400);
        }
        updates.fileAccess = parsed;
      }

      if ("limitedUserInstructions" in body) {
        const error = limitedUserInstructionsError(
          body.limitedUserInstructions,
        );
        if (error) return c.json({ error }, 400);
        updates.limitedUserInstructions =
          body.limitedUserInstructions as LimitedUserInstructions;
      }

      // Handle globalInstructions string (free-form text, or undefined/null/"" to clear)
      if ("globalInstructions" in body) {
        if (
          body.globalInstructions === undefined ||
          body.globalInstructions === null ||
          body.globalInstructions === ""
        ) {
          updates.globalInstructions = undefined;
        } else if (typeof body.globalInstructions === "string") {
          updates.globalInstructions = body.globalInstructions.slice(0, 10000);
        }
      }

      if ("agentContextHints" in body) {
        const parsedHints = parseAgentContextHints(
          body.agentContextHints,
          serverSettingsService.getSetting("agentContextHints"),
        );
        if (parsedHints === null) {
          return c.json({ error: "Invalid agentContextHints setting" }, 400);
        }
        updates.agentContextHints = parsedHints;
      }

      if ("wakeTurnsEnabled" in body) {
        if (typeof body.wakeTurnsEnabled !== "boolean") {
          return c.json({ error: "wakeTurnsEnabled must be a boolean" }, 400);
        }
        updates.wakeTurnsEnabled = body.wakeTurnsEnabled;
      }

      if ("claudeGatewayUrl" in body) {
        if (
          body.claudeGatewayUrl === undefined ||
          body.claudeGatewayUrl === null ||
          body.claudeGatewayUrl === ""
        ) {
          updates.claudeGatewayUrl = undefined;
        } else {
          const url = normalizeClaudeGatewayUrl(body.claudeGatewayUrl);
          if (!url) {
            return c.json(
              {
                error:
                  "claudeGatewayUrl must be an http(s) URL without credentials, query parameters, or a fragment",
              },
              400,
            );
          }
          updates.claudeGatewayUrl = url;
        }
      }
      if ("claudeGatewayStartCommand" in body) {
        const startCommand = parseClaudeGatewayStartCommand(
          body.claudeGatewayStartCommand,
        );
        if (startCommand === null) {
          return c.json(
            {
              error:
                "claudeGatewayStartCommand must be a shell command of at most 10000 characters without NUL bytes",
            },
            400,
          );
        }
        updates.claudeGatewayStartCommand = startCommand;
      }
      if ("gatewayServices" in body) {
        const services = parseGatewayServices(body.gatewayServices ?? []);
        if (!services) {
          return c.json(
            {
              error:
                "gatewayServices must be a list of services with a slug id, an http(s) URL, and valid optional command, window, and toggle fields",
            },
            400,
          );
        }
        const loopbackViolation = services.find(
          (service) =>
            service.serviceCommand && !isLoopbackGatewayUrl(service.url),
        );
        if (loopbackViolation) {
          return c.json(
            {
              error: `gatewayServices entry "${loopbackViolation.id}" has a service command but a non-loopback URL; YA only starts and stops services on localhost`,
            },
            400,
          );
        }
        updates.gatewayServices = services;
      }
      if ("defaultGatewayServiceId" in body) {
        if (
          body.defaultGatewayServiceId === undefined ||
          body.defaultGatewayServiceId === null ||
          body.defaultGatewayServiceId === ""
        ) {
          updates.defaultGatewayServiceId = undefined;
        } else if (
          typeof body.defaultGatewayServiceId !== "string" ||
          !isValidGatewayServiceId(body.defaultGatewayServiceId)
        ) {
          return c.json(
            { error: "defaultGatewayServiceId must be a service id" },
            400,
          );
        } else {
          updates.defaultGatewayServiceId = body.defaultGatewayServiceId;
        }
      }
      if ("gatewayServiceExportEnabled" in body) {
        if (typeof body.gatewayServiceExportEnabled !== "boolean") {
          return c.json(
            { error: "gatewayServiceExportEnabled must be a boolean" },
            400,
          );
        }
        updates.gatewayServiceExportEnabled = body.gatewayServiceExportEnabled;
      }
      if ("gatewayServiceEffortDetection" in body) {
        if (typeof body.gatewayServiceEffortDetection !== "boolean") {
          return c.json(
            { error: "gatewayServiceEffortDetection must be a boolean" },
            400,
          );
        }
        updates.gatewayServiceEffortDetection =
          body.gatewayServiceEffortDetection;
      }
      if ("claudeGatewayDisableAgent" in body) {
        if (typeof body.claudeGatewayDisableAgent !== "boolean") {
          return c.json(
            { error: "claudeGatewayDisableAgent must be a boolean" },
            400,
          );
        }
        updates.claudeGatewayDisableAgent = body.claudeGatewayDisableAgent;
      }
      if ("claudeGatewayDisablePlanMode" in body) {
        if (typeof body.claudeGatewayDisablePlanMode !== "boolean") {
          return c.json(
            { error: "claudeGatewayDisablePlanMode must be a boolean" },
            400,
          );
        }
        updates.claudeGatewayDisablePlanMode =
          body.claudeGatewayDisablePlanMode;
      }

      // Handle ollamaUrl string (URL, or undefined/null/"" to clear)
      if ("ollamaUrl" in body) {
        if (
          body.ollamaUrl === undefined ||
          body.ollamaUrl === null ||
          body.ollamaUrl === ""
        ) {
          updates.ollamaUrl = undefined;
        } else if (typeof body.ollamaUrl === "string") {
          updates.ollamaUrl = body.ollamaUrl;
        }
      }

      // Handle ollamaSystemPrompt string (free-form text, or undefined/null/"" to clear)
      if ("ollamaSystemPrompt" in body) {
        if (
          body.ollamaSystemPrompt === undefined ||
          body.ollamaSystemPrompt === null ||
          body.ollamaSystemPrompt === ""
        ) {
          updates.ollamaSystemPrompt = undefined;
        } else if (typeof body.ollamaSystemPrompt === "string") {
          updates.ollamaSystemPrompt = body.ollamaSystemPrompt.slice(0, 10000);
        }
      }

      // Handle ollamaUseFullSystemPrompt boolean
      if (typeof body.ollamaUseFullSystemPrompt === "boolean") {
        updates.ollamaUseFullSystemPrompt = body.ollamaUseFullSystemPrompt;
      }

      if (typeof body.grokBuildUseXaiApiKey === "boolean") {
        updates.grokBuildUseXaiApiKey = body.grokBuildUseXaiApiKey;
      }

      if ("claudeAdditionalModels" in body) {
        const parsedSelections = parseClaudeAdditionalModelSelections(
          body.claudeAdditionalModels,
        );
        if (parsedSelections === null) {
          return c.json(
            { error: "Invalid claudeAdditionalModels setting" },
            400,
          );
        }
        updates.claudeAdditionalModels = parsedSelections;
      }

      if ("claudeAutoCompactPercentOverride" in body) {
        const parsedOverride = parseClaudeAutoCompactPercentOverride(
          body.claudeAutoCompactPercentOverride,
        );
        if (parsedOverride === null) {
          return c.json(
            {
              error:
                "claudeAutoCompactPercentOverride must be an integer from 1 to 100, or 0/null to clear",
            },
            400,
          );
        }
        updates.claudeAutoCompactPercentOverride = parsedOverride;
      }

      if ("claudeSteerBackgroundBash" in body) {
        const parsedBackgroundPolicy = parseClaudeSteerBackgroundBashSettings(
          body.claudeSteerBackgroundBash,
        );
        if (parsedBackgroundPolicy === null) {
          return c.json(
            {
              error:
                "claudeSteerBackgroundBash must contain valid allowRegex and denyRegex strings",
            },
            400,
          );
        }
        updates.claudeSteerBackgroundBash = parsedBackgroundPolicy;
      }

      // Handle deviceBridgeEnabled boolean
      if (typeof body.deviceBridgeEnabled === "boolean") {
        updates.deviceBridgeEnabled = body.deviceBridgeEnabled;
      }

      if ("newSessionDefaults" in body) {
        const parsedDefaults = parseNewSessionDefaults(body.newSessionDefaults);
        if (parsedDefaults === null) {
          return c.json({ error: "Invalid newSessionDefaults setting" }, 400);
        }
        updates.newSessionDefaults = parsedDefaults;
      }

      if ("clientDefaults" in body) {
        const parsedDefaults = parseClientDefaults(body.clientDefaults);
        if (parsedDefaults === null) {
          return c.json({ error: "Invalid clientDefaults setting" }, 400);
        }
        updates.clientDefaults = mergeClientDefaults(
          serverSettingsService.getSetting("clientDefaults"),
          parsedDefaults,
        );
      }

      if ("speechAudioRetention" in body) {
        const parsedRetention = parseSpeechAudioRetention(
          body.speechAudioRetention,
        );
        if (parsedRetention === null) {
          return c.json({ error: "Invalid speechAudioRetention setting" }, 400);
        }
        updates.speechAudioRetention = parsedRetention;
      }

      if ("speechVoiceBackends" in body) {
        const parsedBackends = parseSpeechVoiceBackends(
          body.speechVoiceBackends,
        );
        if (parsedBackends === null) {
          return c.json(
            {
              error:
                "speechVoiceBackends must be an array of local STT backend ids (ya-whisper, ya-parakeet, ya-nemo, ya-granite, ya-qwen)",
            },
            400,
          );
        }
        updates.speechVoiceBackends = parsedBackends;
      }

      if ("instructionRestoration" in body) {
        const parsed = parseInstructionRestorationSettings(
          body.instructionRestoration,
        );
        if (!parsed)
          return c.json(
            {
              error:
                "instructionRestoration requires known providers, an absolute prefix, a relative .md glob, and delayTurns from 0 to 10",
            },
            400,
          );
        updates.instructionRestoration = parsed;
      }

      if ("longContextEffortWarning" in body) {
        const parsedWarning = parseLongContextEffortWarningSettings(
          body.longContextEffortWarning,
        );
        if (parsedWarning === null) {
          return c.json(
            {
              error:
                "longContextEffortWarning must use known provider checkboxes and a non-negative integer thresholdTokens",
            },
            400,
          );
        }
        updates.longContextEffortWarning = parsedWarning;
      }

      if ("promptCacheKeepalive" in body) {
        const parsedKeepalive = parsePromptCacheKeepalive(
          body.promptCacheKeepalive,
        );
        if (parsedKeepalive === null) {
          return c.json(
            {
              error: `promptCacheKeepalive must configure provider modes (${PROMPT_CACHE_KEEPALIVE_MODES.join(
                ", ",
              )}) and integer inactivityMinutes between 1 and 1440 (default ${DEFAULT_PROMPT_CACHE_KEEPALIVE_INACTIVITY_MINUTES})`,
            },
            400,
          );
        }
        updates.promptCacheKeepalive = parsedKeepalive;
      }

      if ("cacheMissBilling" in body) {
        const parsedCacheMissBilling = parseCacheMissBilling(
          body.cacheMissBilling,
        );
        if (parsedCacheMissBilling === null) {
          return c.json(
            {
              error:
                "cacheMissBilling must use booleans for enabled/showToasts, freshWindowMinutes and providerFreshWindowMinutes 1-1440, recentActivityMinutes and ignoreAfterMinutes 0-1440, and minimumWastedTokens 1-5000000",
            },
            400,
          );
        }
        updates.cacheMissBilling = parsedCacheMissBilling;
      }

      if (typeof body.lifecycleWebhooksEnabled === "boolean") {
        updates.lifecycleWebhooksEnabled = body.lifecycleWebhooksEnabled;
      }
      if (typeof body.lifecycleWebhookDryRun === "boolean") {
        updates.lifecycleWebhookDryRun = body.lifecycleWebhookDryRun;
      }
      if ("lifecycleWebhookUrl" in body) {
        if (
          body.lifecycleWebhookUrl === undefined ||
          body.lifecycleWebhookUrl === null ||
          body.lifecycleWebhookUrl === ""
        ) {
          updates.lifecycleWebhookUrl = undefined;
        } else if (typeof body.lifecycleWebhookUrl === "string") {
          updates.lifecycleWebhookUrl = body.lifecycleWebhookUrl.slice(0, 2000);
        }
      }
      if ("lifecycleWebhookToken" in body) {
        if (
          body.lifecycleWebhookToken === undefined ||
          body.lifecycleWebhookToken === null ||
          body.lifecycleWebhookToken === ""
        ) {
          updates.lifecycleWebhookToken = undefined;
        } else if (typeof body.lifecycleWebhookToken === "string") {
          updates.lifecycleWebhookToken = body.lifecycleWebhookToken.slice(
            0,
            5000,
          );
        }
      }

      if ("codexReasoningSummary" in body) {
        if (!isCodexReasoningSummary(body.codexReasoningSummary)) {
          return c.json(
            {
              error: `codexReasoningSummary must be one of: ${CODEX_REASONING_SUMMARIES.join(", ")}`,
            },
            400,
          );
        }
        updates.codexReasoningSummary = body.codexReasoningSummary;
      }

      if ("codexPlanToolMode" in body) {
        if (
          body.codexPlanToolMode === undefined ||
          body.codexPlanToolMode === null
        ) {
          updates.codexPlanToolMode = undefined;
        } else if (isCodexPlanToolMode(body.codexPlanToolMode)) {
          updates.codexPlanToolMode = body.codexPlanToolMode;
        } else {
          return c.json(
            {
              error: `codexPlanToolMode must be one of: ${CODEX_PLAN_TOOL_MODES.join(", ")}, or null`,
            },
            400,
          );
        }
      }

      if ("steeringModes" in body) {
        const parsed = parseSteeringModeSettings(body.steeringModes);
        if (!parsed)
          return c.json(
            { error: "steeringModes must map codex to gentle or immediate" },
            400,
          );
        updates.steeringModes = parsed;
      }

      if ("codexCyberAccessProgram" in body) {
        if (
          body.codexCyberAccessProgram === undefined ||
          body.codexCyberAccessProgram === null
        ) {
          updates.codexCyberAccessProgram = undefined;
        } else if (isCodexCyberAccessProgram(body.codexCyberAccessProgram)) {
          updates.codexCyberAccessProgram = body.codexCyberAccessProgram;
        } else {
          return c.json(
            {
              error: `codexCyberAccessProgram must be one of: ${CODEX_CYBER_ACCESS_PROGRAMS.join(", ")}, or null`,
            },
            400,
          );
        }
      }

      if ("codexUpdatePolicy" in body) {
        if (
          body.codexUpdatePolicy === undefined ||
          body.codexUpdatePolicy === null
        ) {
          updates.codexUpdatePolicy = DEFAULT_SERVER_SETTINGS.codexUpdatePolicy;
        } else if (
          typeof body.codexUpdatePolicy === "string" &&
          CODEX_UPDATE_POLICIES.includes(
            body.codexUpdatePolicy as CodexUpdatePolicy,
          )
        ) {
          updates.codexUpdatePolicy =
            body.codexUpdatePolicy as CodexUpdatePolicy;
        } else {
          return c.json(
            { error: "codexUpdatePolicy must be one of: auto, notify, off" },
            400,
          );
        }
      }

      if ("codexRequiredUpdateDismissed" in body) {
        const dismissed = body.codexRequiredUpdateDismissed;
        if (dismissed === undefined || dismissed === null) {
          updates.codexRequiredUpdateDismissed = undefined;
        } else if (
          typeof dismissed === "string" &&
          /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(dismissed)
        ) {
          updates.codexRequiredUpdateDismissed = dismissed;
        } else {
          return c.json(
            { error: "codexRequiredUpdateDismissed must be a version or null" },
            400,
          );
        }
      }

      if ("codexReloadSafeSessions" in body) {
        if (typeof body.codexReloadSafeSessions !== "boolean") {
          return c.json(
            { error: "codexReloadSafeSessions must be a boolean" },
            400,
          );
        }
        updates.codexReloadSafeSessions = body.codexReloadSafeSessions;
      }

      if ("mcpAppViews" in body) {
        if (typeof body.mcpAppViews !== "boolean") {
          return c.json({ error: "mcpAppViews must be a boolean" }, 400);
        }
        updates.mcpAppViews = body.mcpAppViews;
      }

      if ("idleReapHours" in body) {
        if (!isIdleReapHours(body.idleReapHours)) {
          return c.json(
            {
              error: "idleReapHours must be a finite number no greater than 72",
            },
            400,
          );
        }
        updates.idleReapHours = normalizeIdleReapHours(body.idleReapHours);
      }

      if (Object.keys(updates).length === 0) {
        return c.json({ error: "At least one valid setting is required" }, 400);
      }

      const currentSettings = serverSettingsService.getSettings();
      const nextHostAwakeMode =
        updates.hostAwakeMode ?? currentSettings.hostAwakeMode;
      const hasHostAwakeUpdate =
        "hostAwakeMode" in updates || "hostAwakeBatteryFloorPercent" in updates;
      if (hasHostAwakeUpdate && !hostAwakeService) {
        return c.json({ error: "Host-awake control is unavailable" }, 503);
      }
      if (
        hostAwakeService &&
        updates.hostAwakeMode &&
        updates.hostAwakeMode !== "off" &&
        updates.hostAwakeMode !== currentSettings.hostAwakeMode
      ) {
        const check = await hostAwakeService.checkSupport(
          updates.hostAwakeMode,
        );
        if (!check.ok) {
          return c.json(
            {
              error:
                check.status.reason ??
                "The requested host-awake mode is unavailable",
              status: check.status,
            },
            409,
          );
        }
      }

      let durabilityError: CommittedSettingsSaveError | undefined;
      const persistSettings = async () => {
        try {
          return await serverSettingsService.updateSettings(updates);
        } catch (error) {
          if (!(error instanceof CommittedSettingsSaveError)) throw error;
          // The replacement happened. Complete storage transitions and runtime
          // callbacks before reporting the durability failure to the client.
          durabilityError = error;
          return error.settings;
        }
      };
      const settings =
        updates.projectDirectoryStorage !== undefined && projectStoragePolicy
          ? await projectStoragePolicy.transitionMode(
              updates.projectDirectoryStorage,
              persistSettings,
            )
          : await persistSettings();
      if (updates.publicSharesEnabled === false && publicShareService) {
        await publicShareService.disableAndRevoke();
      }
      if (updates.publicSharesEnabled === true && publicShareService) {
        await publicShareService.enable();
      }

      const hostAwakeStatus =
        hasHostAwakeUpdate && hostAwakeService
          ? await hostAwakeService.apply(
              nextHostAwakeMode,
              settings.hostAwakeBatteryFloorPercent,
            )
          : undefined;

      // Apply allowedHosts change to middleware at runtime
      if ("projectQueueReadinessCheck" in updates) {
        deps.onProjectQueueReadinessChanged?.();
      }
      if ("allowedHosts" in updates && onAllowedHostsChanged) {
        onAllowedHostsChanged(settings.allowedHosts);
      }
      if ("fileAccess" in updates && onFileAccessChanged) {
        onFileAccessChanged(settings.fileAccess);
      }
      if (
        "persistRemoteSessionsToDisk" in updates &&
        onRemoteSessionPersistenceChanged
      ) {
        await onRemoteSessionPersistenceChanged(
          settings.persistRemoteSessionsToDisk,
        );
      }
      if ("ollamaUrl" in updates && onOllamaUrlChanged) {
        onOllamaUrlChanged(settings.ollamaUrl);
      }
      if (
        ("claudeGatewayUrl" in updates ||
          "claudeGatewayStartCommand" in updates ||
          "claudeGatewayDisableAgent" in updates ||
          "claudeGatewayDisablePlanMode" in updates ||
          "gatewayServices" in updates ||
          "defaultGatewayServiceId" in updates ||
          "gatewayServiceExportEnabled" in updates ||
          "gatewayServiceEffortDetection" in updates) &&
        onClaudeGatewaySettingsChanged
      ) {
        // Persisted settings are already reconciled, so the list and the
        // legacy keys agree by the time the runtime sees them.
        await onClaudeGatewaySettingsChanged({
          exportToProviderClis: settings.gatewayServiceExportEnabled ?? false,
          effortDetection: settings.gatewayServiceEffortDetection ?? true,
          services: settings.gatewayServices ?? [],
          ...(settings.defaultGatewayServiceId
            ? { defaultServiceId: settings.defaultGatewayServiceId }
            : {}),
          disableAgent: settings.claudeGatewayDisableAgent,
          disablePlanMode: settings.claudeGatewayDisablePlanMode,
        });
      }
      if ("ollamaSystemPrompt" in updates && onOllamaSystemPromptChanged) {
        onOllamaSystemPromptChanged(settings.ollamaSystemPrompt);
      }
      if (
        "ollamaUseFullSystemPrompt" in updates &&
        onOllamaUseFullSystemPromptChanged
      ) {
        onOllamaUseFullSystemPromptChanged(
          settings.ollamaUseFullSystemPrompt ?? false,
        );
      }
      if (
        "grokBuildUseXaiApiKey" in updates &&
        onGrokBuildUseXaiApiKeyChanged
      ) {
        onGrokBuildUseXaiApiKeyChanged(settings.grokBuildUseXaiApiKey ?? false);
      }
      if (typeof updates.idleReapHours === "number" && onIdleReapHoursChanged) {
        onIdleReapHoursChanged(updates.idleReapHours);
      }

      if (durabilityError) throw durabilityError;

      return c.json({
        settings: {
          ...settings,
          ...(getIdleReapHours ? { idleReapHours: getIdleReapHours() } : {}),
        },
        ...(hostAwakeStatus ? { hostAwakeStatus } : {}),
      });
    }),
  );

  /**
   * POST /api/settings/gateway-services/effort
   * Ask one model-serving endpoint which thinking efforts it accepts.
   *
   * The URL must be loopback or already configured. Unlike the model discovery
   * above this sends a chat request, so it stays pointed at endpoints the
   * server already talks to rather than at anywhere a client names.
   */
  app.post("/gateway-services/effort", async (c) => {
    const body = await c.req.json<{ url?: unknown }>();
    // Normalized before the comparison below, because a stored service URL is
    // normalized too: the same endpoint typed with a trailing slash or a
    // default port is the configured one.
    const url =
      typeof body.url === "string"
        ? normalizeGatewayServiceUrl(body.url)
        : null;
    if (!url) {
      return c.json({ error: "url must be an http(s) URL" }, 400);
    }
    const configured = (
      serverSettingsService.getSettings().gatewayServices ?? []
    ).some((service) => service.url === url);
    if (!configured && !isLoopbackGatewayUrl(url)) {
      return c.json(
        {
          error:
            "url must be one of the configured model services, or a localhost address",
        },
        400,
      );
    }

    const detection = await detectEndpointEffort(url);
    if (!detection.ok) {
      return c.json({ detected: false, reason: detection.reason });
    }
    return c.json({
      detected: true,
      modelId: detection.modelId,
      levels: detection.probe.levels,
      noThinking: detection.probe.noThinking,
      defaultLevel: detection.probe.defaultLevel,
    });
  });

  return app;
}
