/**
 * Server settings API routes
 */

import {
  CODEX_REASONING_SUMMARIES,
  CODEX_PLAN_TOOL_MODES,
  CODEX_CYBER_ACCESS_PROGRAMS,
  MAX_HEARTBEAT_TURN_TEXT_LENGTH,
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
  normalizeYaClientBaseUrl,
  normalizeYaClientBaseUrlFromShareViewerUrl,
  normalizeIdleReapHours,
  parseClaudeAdditionalModelSelections,
  parseClaudeSteerBackgroundBashSettings,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import {
  type FileAccessSettings,
  getFileAccessInfo,
} from "../middleware/file-access.js";
import type { SessionMetadataService } from "../metadata/index.js";
import type { ProjectStoragePolicy } from "../projects/projectStoragePolicy.js";
import { testSSHConnection } from "../sdk/remote-spawn.js";
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
  isValidSshHostAlias,
  normalizeSshHostAlias,
} from "../utils/sshHostAlias.js";

import {
  discoverOpenAiCompatibleModels,
  mergeClientDefaults,
  normalizeClaudeGatewayUrl,
  normalizeOpenAiCompatibleBaseUrl,
  parseAgentContextHints,
  parseCacheMissBilling,
  parseClaudeAutoCompactPercentOverride,
  parseClaudeGatewayStartCommand,
  parseClientDefaults,
  parseFileAccess,
  parseHelperTargets,
  parseHostIdentity,
  parseHostAliasList,
  parseNewSessionDefaults,
  parsePromptCacheKeepalive,
  parseSpeechAudioRetention,
} from "./settings-parsers.js";

export interface SettingsRoutesDeps {
  serverSettingsService: ServerSettingsService;
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
    url?: string;
    startCommand?: string;
    disableAgent: boolean;
    disablePlanMode: boolean;
  }) => Promise<void> | void;
  /** Callback to apply Ollama URL changes at runtime */
  onOllamaUrlChanged?: (url: string | undefined) => void;
  /** Callback to re-plan heartbeat deadlines when the global quiet period moves. */
  onHeartbeatSettingsChanged?: () => void;
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
}

export function createSettingsRoutes(deps: SettingsRoutesDeps): Hono {
  const app = new Hono();
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
    onHeartbeatSettingsChanged,
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
   * Get all server settings
   */
  app.get("/", (c) => {
    const settings = serverSettingsService.getSettings();
    return c.json({
      settings: {
        ...settings,
        ...(getIdleReapHours ? { idleReapHours: getIdleReapHours() } : {}),
      },
    });
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
      if (typeof body.publicSharesEnabled === "boolean") {
        updates.publicSharesEnabled = body.publicSharesEnabled;
      }
      if (typeof body.workstreamsEnabled === "boolean") {
        updates.workstreamsEnabled = body.workstreamsEnabled;
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

      // Handle remoteExecutors array
      if (Array.isArray(body.remoteExecutors)) {
        const { hosts, invalidHost } = parseHostAliasList(body.remoteExecutors);
        if (invalidHost) {
          return c.json(
            { error: `Invalid remote executor host alias: ${invalidHost}` },
            400,
          );
        }
        updates.remoteExecutors = hosts;
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
      }

      // Handle fileAccess object (checkbox model; undefined/null/"" = secure defaults)
      if ("fileAccess" in body) {
        const parsed = parseFileAccess(body.fileAccess);
        if (parsed === null) {
          return c.json({ error: "Invalid fileAccess setting" }, 400);
        }
        updates.fileAccess = parsed;
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

      if ("heartbeatTurnsAfterMinutes" in body) {
        if (
          body.heartbeatTurnsAfterMinutes === undefined ||
          body.heartbeatTurnsAfterMinutes === null
        ) {
          updates.heartbeatTurnsAfterMinutes =
            DEFAULT_SERVER_SETTINGS.heartbeatTurnsAfterMinutes;
        } else if (
          typeof body.heartbeatTurnsAfterMinutes === "number" &&
          Number.isInteger(body.heartbeatTurnsAfterMinutes) &&
          body.heartbeatTurnsAfterMinutes >= 1 &&
          body.heartbeatTurnsAfterMinutes <= 1440
        ) {
          updates.heartbeatTurnsAfterMinutes = body.heartbeatTurnsAfterMinutes;
        } else {
          return c.json(
            {
              error:
                "heartbeatTurnsAfterMinutes must be an integer between 1 and 1440",
            },
            400,
          );
        }
      }

      if ("heartbeatTurnText" in body) {
        if (
          body.heartbeatTurnText === undefined ||
          body.heartbeatTurnText === null ||
          body.heartbeatTurnText === ""
        ) {
          updates.heartbeatTurnText = DEFAULT_SERVER_SETTINGS.heartbeatTurnText;
        } else if (typeof body.heartbeatTurnText === "string") {
          updates.heartbeatTurnText = body.heartbeatTurnText.slice(
            0,
            MAX_HEARTBEAT_TURN_TEXT_LENGTH,
          );
        }
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

      if ("helperTargets" in body) {
        const parsedTargets = parseHelperTargets(body.helperTargets);
        if (parsedTargets === null) {
          return c.json({ error: "Invalid helperTargets setting" }, 400);
        }
        updates.helperTargets = parsedTargets;
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

      if ("codexReloadSafeSessions" in body) {
        if (typeof body.codexReloadSafeSessions !== "boolean") {
          return c.json(
            { error: "codexReloadSafeSessions must be a boolean" },
            400,
          );
        }
        updates.codexReloadSafeSessions = body.codexReloadSafeSessions;
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
        "heartbeatTurnsAfterMinutes" in updates &&
        onHeartbeatSettingsChanged
      ) {
        // A shorter global quiet period can make an already-quiet session due
        // right now, which a scheduled deadline would otherwise not learn.
        onHeartbeatSettingsChanged();
      }
      if (
        ("claudeGatewayUrl" in updates ||
          "claudeGatewayStartCommand" in updates ||
          "claudeGatewayDisableAgent" in updates ||
          "claudeGatewayDisablePlanMode" in updates) &&
        onClaudeGatewaySettingsChanged
      ) {
        await onClaudeGatewaySettingsChanged({
          url: settings.claudeGatewayUrl,
          startCommand: settings.claudeGatewayStartCommand,
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
   * GET /api/settings/remote-executors
   * Get list of configured remote executors
   */
  app.get("/remote-executors", (c) => {
    const settings = serverSettingsService.getSettings();
    return c.json({ executors: settings.remoteExecutors ?? [] });
  });

  /**
   * POST /api/settings/helper-targets/models
   * Discover model ids exposed by an OpenAI-compatible helper endpoint.
   */
  app.post("/helper-targets/models", async (c) => {
    const body = await c.req.json<{ baseUrl?: unknown }>();
    const baseUrl = normalizeOpenAiCompatibleBaseUrl(body.baseUrl);
    if (!baseUrl) {
      return c.json({ error: "baseUrl must be an http(s) URL" }, 400);
    }

    const models = await discoverOpenAiCompatibleModels(baseUrl);
    if (!models) {
      return c.json({ error: "Failed to load helper target models" }, 502);
    }

    return c.json({ baseUrl, models });
  });

  /**
   * PUT /api/settings/remote-executors
   * Update list of remote executors
   */
  app.put("/remote-executors", (c) =>
    serializeSettingsUpdate(async () => {
      const body = await c.req.json<{ executors: string[] }>();

      if (!Array.isArray(body.executors)) {
        return c.json({ error: "executors must be an array" }, 400);
      }

      const { hosts: validExecutors, invalidHost } = parseHostAliasList(
        body.executors,
      );
      if (invalidHost) {
        return c.json(
          { error: `Invalid remote executor host alias: ${invalidHost}` },
          400,
        );
      }

      await serverSettingsService.updateSettings({
        remoteExecutors: validExecutors,
      });

      return c.json({ executors: validExecutors });
    }),
  );

  /**
   * POST /api/settings/remote-executors/:host/test
   * Test SSH connection to a remote executor
   */
  app.post("/remote-executors/:host/test", async (c) => {
    const host = normalizeSshHostAlias(c.req.param("host"));

    if (!host) {
      return c.json({ error: "host is required" }, 400);
    }
    if (!isValidSshHostAlias(host)) {
      return c.json({ error: "host must be a valid SSH host alias" }, 400);
    }

    const result = await testSSHConnection(host);
    return c.json(result);
  });

  return app;
}
