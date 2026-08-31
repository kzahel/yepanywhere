import type { HttpBindings } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import type {
  AppContentBlock,
  AppSession,
  ProviderName,
  SafeRestartPreservedWork,
  UrlProjectId,
} from "@yep-anywhere/shared";
import {
  DEFAULT_HEARTBEAT_TURN_TEXT,
  DEFAULT_HEARTBEAT_TURNS_AFTER_MINUTES,
  DEFAULT_PROJECT_QUEUE_QUIET_SECONDS,
  DEFAULT_PROMPT_CACHE_KEEPALIVE_INACTIVITY_MINUTES,
  DEFAULT_SUBAGENT_MAX_DEPTH,
  buildEffectiveAgentContext,
  clampProjectQueueQuietSeconds,
  idleReapHoursToMs,
  idleReapMsToHours,
  isClaudeProviderName,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { join } from "node:path";
import type { AuthService } from "./auth/AuthService.js";
import { createAuthRoutes } from "./auth/routes.js";
import type { DesktopBootstrapService } from "./desktop/DesktopBootstrapService.js";
import type { DeviceBridgeService } from "./device/DeviceBridgeService.js";
import type { FrontendProxy } from "./frontend/index.js";
import type {
  SessionDiscoveryIndexRegistry,
  SessionIndexService,
} from "./indexes/index.js";
import type {
  ProjectMetadataService,
  SessionMetadataService,
} from "./metadata/index.js";
import { ToolResultMediaStore } from "./media/ToolResultMediaStore.js";
import {
  applySessionSandboxAuthRequirement,
  getClaudeSandboxProjectDir,
  getCodexSandboxSessionsDir,
  getSessionSandboxAvailability,
} from "./session-sandbox.js";
import { updateAllowedHosts } from "./middleware/allowed-hosts.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { structuredErrorHandler } from "./middleware/error-handler.js";
import {
  getAllowedFilePaths,
  shouldIncludeProjects,
  updateFileAccess,
} from "./middleware/file-access.js";
import {
  corsMiddleware,
  hostCheckMiddleware,
  requireCustomHeader,
} from "./middleware/security.js";
import type { NotificationService } from "./notifications/index.js";
import {
  CODEX_SESSIONS_DIR,
  CodexSessionScanner,
} from "./projects/codex-scanner.js";
import {
  GEMINI_TMP_DIR,
  GeminiSessionScanner,
} from "./projects/gemini-scanner.js";
import { GlossaryIndexService } from "./projects/glossaryIndexService.js";
import {
  GROK_SESSIONS_DIR,
  PI_SESSIONS_DIR,
  decodeProjectId,
  grokSessionMediaRoots,
} from "./projects/paths.js";
import { ProjectScanner } from "./projects/scanner.js";
import {
  InactivityPushNotifier,
  PushNotifier,
  type PushService,
} from "./push/index.js";
import { createPushRoutes } from "./push/routes.js";
import { ProjectStoragePolicy } from "./projects/projectStoragePolicy.js";
import type { RecentsService } from "./recents/index.js";
import type {
  RemoteAccessService,
  RemoteSessionService,
} from "./remote-access/index.js";
import { createRemoteAccessRoutes } from "./remote-access/index.js";
import { createActivityRoutes } from "./routes/activity.js";
import { createBrowserProfilesRoutes } from "./routes/browser-profiles.js";
import { createBrowserSettingsBackupRoutes } from "./routes/browser-settings-backup.js";
import {
  createBrowserDebugAgentRoutes,
  createBrowserDebugClientRoutes,
} from "./routes/browser-debug.js";
import { createClientLogsRoutes } from "./routes/client-logs.js";
import { createConnectionsRoutes } from "./routes/connections.js";
import { createDebugStreamingRoutes } from "./routes/debug-streaming.js";
import { createDevRoutes } from "./routes/dev.js";
import { createDesktopBootstrapRoutes } from "./routes/desktop-bootstrap.js";
import { createDeviceRoutes } from "./routes/devices.js";
import { createFilesRoutes } from "./routes/files.js";
import { canonicalizeManagedAttachmentPath } from "./uploads/attachmentAccess.js";
import { createBangCommandsRoutes } from "./routes/bang-commands.js";
import { BangCommandService } from "./services/BangCommandService.js";
import { createGitBrowseRoutes } from "./routes/git-browse.js";
import { createGitFileRevisionRoutes } from "./routes/git-file-revision.js";
import { createGitFileProjectionRoutes } from "./routes/git-file-projections.js";
import { createGitInclusiveToHeadRoutes } from "./routes/git-inclusive-to-head.js";
import { createGitIncomingCommitsRoutes } from "./routes/git-incoming-commits.js";
import { createGitProjectionRoutes } from "./routes/git-projections.js";
import { createGitStatusRoutes } from "./routes/git-status.js";
import { createGitWorkingTreeFilesRoutes } from "./routes/git-working-tree-files.js";
import { createGlossaryArtifactRoutes } from "./routes/glossary-artifacts.js";
import { createGlobalSessionsRoutes } from "./routes/global-sessions.js";
import { createReviewCommentsRoutes } from "./routes/review-comments.js";
import { createReviewInboxRoutes } from "./routes/review-inbox.js";
import { createReviewSubmissionsRoutes } from "./routes/review-submissions.js";
import { ReviewCaptureService } from "./review/ReviewCaptureService.js";
import { ReviewCommentService } from "./review/ReviewCommentService.js";
import { ReviewResponseObserver } from "./review/ReviewResponseObserver.js";
import { createSupervisorReviewLauncher } from "./review/reviewSessionLauncher.js";
import { health } from "./routes/health.js";
import { createInboxRoutes } from "./routes/inbox.js";
import { createNetworkBindingRoutes } from "./routes/network-binding.js";
import { createOnboardingRoutes } from "./routes/onboarding.js";
import { createHostAgentProcessesRoutes } from "./routes/host-agent-processes.js";
import { createProcessesRoutes } from "./routes/processes.js";
import {
  createGlobalProjectQueueRoutes,
  createProjectQueueRoutes,
} from "./routes/project-queue.js";
import { createProjectsRoutes } from "./routes/projects.js";
import { createProjectSessionDefaultsRoutes } from "./routes/project-session-defaults.js";
import { createProvidersRoutes } from "./routes/providers.js";
import { createCodexUpdateRoutes } from "./routes/codex-updates.js";
import { createPublicFileShareRoutes } from "./routes/public-file-shares.js";
import {
  createPublicSharePublicRoutes,
  createPublicShareRoutes,
} from "./routes/public-shares.js";
import { createPublicShareManagementFreezeRoutes } from "./routes/public-share-management-freeze.js";
import { createPublicShareManagementRoutes } from "./routes/public-share-management.js";
import { createRecentsRoutes } from "./routes/recents.js";
import {
  createServerAdminRoutes,
  triggerServerRestart,
} from "./routes/server-admin.js";
import { createEnvSettingsRoutes } from "./routes/env-settings.js";
import { createServerInfoRoutes } from "./routes/server-info.js";
import { createSessionArchiveRoutes } from "./routes/session-archive.js";
import { createSessionDoneRoutes } from "./routes/session-done.js";
import { createSessionIndexRoutes } from "./routes/session-index.js";
import { createSessionTerminateRoutes } from "./routes/session-terminate.js";
import { createSessionsRoutes } from "./routes/sessions.js";
import { createSessionWakeRoutes } from "./routes/session-wake.js";
import { createSettingsRoutes } from "./routes/settings.js";
import { createSharingRoutes } from "./routes/sharing.js";
import { createSupervisorQueueRoutes } from "./routes/supervisor-queue.js";
import { createToolResultMediaRoutes } from "./routes/tool-result-media.js";
import { ClaudeGatewayProvider } from "./sdk/providers/claude-gateway.js";
import { ClaudeOllamaProvider } from "./sdk/providers/claude-ollama.js";
import { grokACPProvider } from "./sdk/providers/grok-acp.js";

import { createLocalFileRoutes } from "./routes/local-file.js";
import { createLocalImageRoutes } from "./routes/local-image.js";
import { createLocalResourcePathPolicy } from "./routes/local-resource-policy.js";
import { type UploadDeps, createUploadRoutes } from "./routes/upload.js";
import { createSpeechRoutes } from "./routes/speech.js";
import { createSecurityClientRoutes } from "./routes/security-clients.js";
import { createVersionRoutes } from "./routes/version.js";
import { createProviderHostRoutes } from "./routes/provider-host.js";
import { createWorkstreamRoutes } from "./routes/workstreams.js";
import { WS_INTERNAL_AUTHENTICATED } from "./middleware/internal-auth.js";
import {
  configureProviderRuntime,
  getProvider,
  isProviderRuntimeHostAvailable,
} from "./sdk/providers/index.js";
import type { AgentProvider } from "./sdk/providers/types.js";
import type {
  ClaudeSDK,
  PermissionMode,
  RealClaudeSDKInterface,
} from "./sdk/types.js";
import {
  PublicShareCaptureError,
  type PublicShareService,
} from "./services/PublicShareService.js";
import { AttachmentStagingService } from "./uploads/AttachmentStagingService.js";
import type { BrowserProfileService } from "./services/BrowserProfileService.js";
import type { BrowserSettingsBackupService } from "./services/BrowserSettingsBackupService.js";
import {
  BrowserDebugService,
  createBrowserDebugCallerToken,
} from "./services/BrowserDebugService.js";
import { CodexUpdateChecker } from "./services/CodexUpdateChecker.js";
import type { CodexNativeTitleService } from "./services/CodexNativeTitleService.js";
import type { ConnectedBrowsersService } from "./services/ConnectedBrowsersService.js";
import type { DirtyFileEditorService } from "./services/DirtyFileEditorService.js";
import { HeartbeatCandidateRegistry } from "./services/HeartbeatCandidateRegistry.js";
import type { HostAwakeService } from "./services/host-awake/HostAwakeService.js";
import type { ModelInfoService } from "./services/ModelInfoService.js";
import type { NetworkBindingService } from "./services/NetworkBindingService.js";
import { ProjectQueueScheduler } from "./services/ProjectQueueScheduler.js";
import { initializeSessionHeartbeatDefaults } from "./services/sessionHeartbeatDefaults.js";
import type { ProjectQueueService } from "./services/ProjectQueueService.js";
import type { RelayClientService } from "./services/RelayClientService.js";
import type { ServerSettingsService } from "./services/ServerSettingsService.js";
import {
  SessionWakeService,
  type SessionWakeDeliveryResult,
  type SessionWakeLogger,
} from "./services/SessionWakeService.js";
import type { SecurityClientService } from "./services/SecurityClientService.js";
import type { WorkstreamService } from "./services/WorkstreamService.js";
import type {
  PersistedSessionQueuedMessage,
  SessionQueuePersistenceService,
} from "./services/SessionQueuePersistenceService.js";
import { SafeRestartService } from "./services/SafeRestartService.js";
import type { SharingService } from "./services/SharingService.js";
import type { SpeechBackendRegistry } from "./services/voice/registry.js";
import { CodexSessionReader } from "./sessions/codex-reader.js";
import { createCodexSessionDiscoveryIndex } from "./sessions/codex-discovery.js";
import { GeminiSessionReader } from "./sessions/gemini-reader.js";
import { GrokSessionReader } from "./sessions/grok-reader.js";
import { MergedSessionReader } from "./sessions/merged-reader.js";
import { OpenCodeSessionReader } from "./sessions/opencode-reader.js";
import { PiSessionReader } from "./sessions/pi-reader.js";
import {
  findSessionListSummaryAcrossProviders,
  findSessionSummaryAcrossProviders,
} from "./sessions/provider-resolution.js";
import { applyRecapOverlayToSummary } from "./sessions/recap-overlays.js";
import { normalizeSession } from "./sessions/normalization.js";
import { ClaudeSessionReader } from "./sessions/reader.js";
import {
  isAutomaticSessionResumeAllowed,
  isUnownedHeartbeatResumeEligible,
} from "./sessions/resume-exemption.js";
import type { SummaryParserWorkerMode } from "./sessions/summary-parser-worker-protocol.js";
import type {
  GetSessionSummaryOptions,
  ISessionReader,
} from "./sessions/types.js";
import { ExternalSessionTracker } from "./supervisor/ExternalSessionTracker.js";
import {
  Supervisor,
  type HeartbeatTurnCandidate,
} from "./supervisor/Supervisor.js";
import type { Message, Project } from "./supervisor/types.js";
import type { EventBus } from "./watcher/index.js";
import { LifecycleWebhookService } from "./webhooks/LifecycleWebhookService.js";

export interface AppOptions {
  /** Explicit provider override; null suppresses ambient provider discovery. */
  provider?: AgentProvider | null;
  /** Legacy SDK interface for mock SDK (for testing) */
  sdk?: ClaudeSDK;
  /** Real SDK interface with full features */
  realSdk?: RealClaudeSDKInterface;
  projectsDir?: string; // override for testing
  codexSessionsDir?: string; // override for testing
  geminiSessionsDir?: string; // override for testing
  grokSessionsDir?: string; // override for testing
  piSessionsDir?: string; // override for testing
  idleTimeoutMs?: number;
  /** Test-only session-detail augmentation delay for performance clock probes. */
  persistedAugmentDelayMs?: number;
  defaultPermissionMode?: PermissionMode;
  /** EventBus for file change events */
  eventBus?: EventBus;
  /** WebSocket upgrader from @hono/node-ws (optional) */
  upgradeWebSocket?: UploadDeps["upgradeWebSocket"];
  /** NotificationService for tracking session read state */
  notificationService?: NotificationService;
  /** SessionMetadataService for custom titles and archive status */
  sessionMetadataService?: SessionMetadataService;
  /** Provider-native Codex title projection and rename owner. */
  codexNativeTitleService?: CodexNativeTitleService;
  /** Persist install-wide provider use before registering a live process. */
  onSuccessfulProviderSession?: (
    sessionId: string,
    provider: ProviderName,
  ) => Promise<void>;
  /** ProjectMetadataService for persisting added projects */
  projectMetadataService?: ProjectMetadataService;
  /** Durable project-scoped message queue service */
  projectQueueService?: ProjectQueueService;
  /** Durable store for long-lived patient queued messages */
  sessionQueuePersistenceService?: SessionQueuePersistenceService;
  /** Durable last-editor attribution for dirty Source Control files. */
  dirtyFileEditorService?: DirtyFileEditorService;
  /** SessionIndexService for caching session summaries */
  sessionIndexService?: SessionIndexService;
  /** Process-local owner registry for provider discovery shards. */
  sessionDiscoveryIndexRegistry?: SessionDiscoveryIndexRegistry;
  /** Claude summary parser child-process mode. Default off. */
  claudeSummaryParserWorkerMode?: SummaryParserWorkerMode;
  /** Codex summary parser child-process mode. Default on when unset. */
  codexSummaryParserWorkerMode?: SummaryParserWorkerMode;
  /** Project scanner cache TTL in ms (0 = rescan every request). */
  projectScanCacheTtlMs?: number;
  /** Sessions older than this many days are hidden from default scans. 0 disables. */
  sessionAutoArchiveDays?: number;
  /** Maximum concurrent workers. 0 = unlimited (default) */
  maxWorkers?: number;
  /** Idle threshold in milliseconds for preemption */
  idlePreemptThresholdMs?: number;
  /** Frontend proxy for dev mode (proxies non-API requests to Vite) */
  frontendProxy?: FrontendProxy;
  /** PushService for web push notifications */
  pushService?: PushService;
  /** RecentsService for tracking recently visited sessions */
  recentsService?: RecentsService;
  /** Maximum upload file size in bytes. 0 = unlimited */
  maxUploadSizeBytes?: number;
  /** Attachment staging service for draft attachments. */
  attachmentStagingService?: AttachmentStagingService;
  /** Maximum queue size for pending requests. 0 = unlimited */
  maxQueueSize?: number;
  /** AuthService for cookie-based auth (optional) */
  authService?: AuthService;
  /** Whether auth is disabled by env var (--auth-disable). Bypasses all auth. */
  authDisabled?: boolean;
  /** Desktop auth token for Tauri app. Requests with matching X-Desktop-Token header bypass auth. */
  desktopAuthToken?: string;
  /** Reload-safe desktop bootstrap/session service owned by the native shell. */
  desktopBootstrapService?: DesktopBootstrapService;
  /** Whether this server was launched by the signed desktop runtime. */
  desktopRuntime?: boolean;
  /** RemoteAccessService for SRP-based remote access (optional) */
  remoteAccessService?: RemoteAccessService;
  /** RemoteSessionService for session persistence (optional) */
  remoteSessionService?: RemoteSessionService;
  /** Signed continuity-key registry and security audit service. */
  securityClientService?: SecurityClientService;
  /** RelayClientService for relay connection status (optional) */
  relayClientService?: RelayClientService;
  /**
   * Holder for relay config change callback.
   * The `callback` property can be set after createApp returns.
   */
  relayConfigCallbackHolder?: { callback?: () => Promise<void> };
  /** Server host (for server-info endpoint) */
  serverHost?: string;
  /** Server port (for server-info endpoint) */
  serverPort?: number;
  /** Unique installation identifier (for server-info endpoint) */
  installId?: string;
  /** Data directory for persistent state (for onboarding state) */
  dataDir?: string;
  /** NetworkBindingService for runtime binding configuration */
  networkBindingService?: NetworkBindingService;
  /**
   * Holder for network binding change callbacks.
   * The callbacks are set after startServer() initializes the servers.
   */
  networkBindingCallbackHolder?: {
    onLocalhostPortChange?: (
      port: number,
    ) => Promise<{ success: boolean; error?: string; redirectUrl?: string }>;
    onNetworkBindingChange?: (
      config: { host: string; port: number } | null,
    ) => Promise<{ success: boolean; error?: string }>;
    /** Live accessor for the addresses the server is actually listening on. */
    getActiveListeners?: () => string[];
    /** Live localhost port after an optional port-0 bind. */
    getLocalhostPort?: () => number;
  };
  /** ConnectedBrowsersService for tracking active browser connections */
  connectedBrowsers?: ConnectedBrowsersService;
  /** BrowserProfileService for tracking browser profile origins */
  browserProfileService?: BrowserProfileService;
  /** Explicit server-stored backup of portable browser UI settings */
  browserSettingsBackupService?: BrowserSettingsBackupService;
  /** ServerSettingsService for server-wide settings */
  serverSettingsService?: ServerSettingsService;
  /** Persistent server secret used to mint per-session wake credentials. */
  sessionWakeSecret?: Uint8Array;
  /** Session-wake diagnostics sink; injectable for warning-free tests. */
  sessionWakeLogger?: SessionWakeLogger;
  /** Reachable server base URL injected into local provider child shells. */
  getSessionWakeBaseUrl?: (executor?: string) => string | undefined;
  /** Agent-reachable diagnostics broker and optional private trust anchor. */
  getBrowserDebugConnection?: (executor?: string) =>
    | {
        baseUrl: string;
        caCertificate?: string;
      }
    | undefined;
  /** Shared location resolver and transition owner for project-scoped state. */
  projectStoragePolicy?: ProjectStoragePolicy;
  /** Process-global operating-system sleep assertion policy. */
  hostAwakeService?: HostAwakeService;
  /** WorkstreamService for experimental per-project checkout lanes */
  workstreamService?: WorkstreamService;
  /** ModelInfoService for cached model metadata (context windows, etc.) */
  modelInfoService?: ModelInfoService;
  /** SharingService for session sharing */
  sharingService?: SharingService;
  /** PublicShareService for secret-link read-only session shares */
  publicShareService?: PublicShareService;
  /** DeviceBridgeService for Android emulator streaming */
  deviceBridgeService?: DeviceBridgeService;
  /** If non-empty, only these provider names are exposed via the API. */
  enabledProviders?: string[];
  /** Explicit Codex CLI path supplied by an embedding runtime such as desktop. */
  codexCliPath?: string;
  /** Whether voice input is enabled. Default: true */
  voiceInputEnabled?: boolean;
  /** Validated server-routed speech backends for capability advertisement. */
  speechBackendRegistry?: SpeechBackendRegistry;
  /** xAI STT key used for ya-grok and to mint direct-browser client secrets. */
  xaiSttApiKey?: string;
  /** Whether authenticated clients may borrow the long-lived xAI STT key. */
  shareXaiSttApiKeyWithClients?: boolean;
  /** Allowed directory prefixes for serving local images. Default: ["/tmp"] */
  allowedImagePaths?: string[];
}

export interface AppResult {
  app: Hono<{ Bindings: HttpBindings }>;
  /** Supervisor instance for debug API access */
  supervisor: Supervisor;
  /** Project scanner for debug API access */
  scanner: ProjectScanner;
  /** Session reader factory for debug API access */
  readerFactory: (project: Project) => ISessionReader;
  /** Close cached session readers and their owned parser workers. */
  disposeSessionReaders: () => Promise<void>;
  /** Shared resolver used by the artifact route and glossary subscriptions. */
  glossaryIndexService: GlossaryIndexService;
  /** Global external-session observer and its bounded background diagnostics. */
  externalTracker?: ExternalSessionTracker;
  /** Authenticated exact probes for bare absolute-path viewer links. */
  resolveAbsoluteFilePaths: (
    paths: readonly string[],
  ) => Promise<ReadonlySet<string>>;
}

function getMessageContentBlocks(message: Message): AppContentBlock[] {
  const content = message.message?.content ?? message.content;
  return Array.isArray(content) ? content : [];
}

function hasPendingToolCall(messages: Message[]): boolean {
  const pendingToolUseIds = new Set<string>();

  for (const message of messages) {
    for (const block of getMessageContentBlocks(message)) {
      if (block.type === "tool_use" && typeof block.id === "string") {
        pendingToolUseIds.add(block.id);
      } else if (
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      ) {
        pendingToolUseIds.delete(block.tool_use_id);
      }
    }
  }

  return pendingToolUseIds.size > 0;
}

function isRecoveredPatientQueueItem(
  item: PersistedSessionQueuedMessage,
): boolean {
  return item.kind === "patient" && item.status === "paused-after-restart";
}

function getPreservedRestartWork(
  sessionQueuePersistenceService: SessionQueuePersistenceService | undefined,
): SafeRestartPreservedWork[] {
  if (!sessionQueuePersistenceService) return [];

  const recoveredPatientCount = sessionQueuePersistenceService
    .list()
    .filter(isRecoveredPatientQueueItem).length;

  return recoveredPatientCount > 0
    ? [
        {
          type: "recovered-session-queue",
          count: recoveredPatientCount,
        },
      ]
    : [];
}

export function createApp(options: AppOptions): AppResult {
  let supervisor!: Supervisor;
  const isSessionSandboxAuthEnforced = (): boolean =>
    options.authDisabled !== true &&
    options.authService !== undefined &&
    !options.authService.isLocalhostOpen() &&
    (options.authService.isEnabled() ||
      Boolean(options.desktopAuthToken || options.desktopBootstrapService));
  const isAuthenticationRelaxationBlocked = (): boolean =>
    supervisor.isAuthenticationRelaxationBlocked();
  const getConfiguredSubagentMaxDepth = () => {
    const configured =
      options.serverSettingsService?.getSetting("subagentMaxDepth");
    return configured === undefined ? DEFAULT_SUBAGENT_MAX_DEPTH : configured;
  };
  configureProviderRuntime({
    codexCliPath: options.codexCliPath,
    getClaudeAdditionalModels: () =>
      options.serverSettingsService?.getSetting("claudeAdditionalModels"),
    isClaudeOllamaVisible: () =>
      ClaudeOllamaProvider.isExplicitlyConfigured() ||
      Boolean(
        options.serverSettingsService?.getSetting("ollamaSystemPrompt") ||
          options.serverSettingsService?.getSetting(
            "ollamaUseFullSystemPrompt",
          ),
      ) ||
      Object.values(
        options.sessionMetadataService?.getAllMetadata() ?? {},
      ).some((metadata) => metadata.provider === "claude-ollama"),
    getProviderRuntimeSnapshot: () => ({
      codexCliPath: options.codexCliPath,
      codexReasoningSummary: options.serverSettingsService?.getSetting(
        "codexReasoningSummary",
      ),
      claudeAdditionalModels: options.serverSettingsService?.getSetting(
        "claudeAdditionalModels",
      ),
      claudeGatewayUrl:
        options.serverSettingsService?.getSetting("claudeGatewayUrl"),
      claudeGatewayStartCommand: options.serverSettingsService?.getSetting(
        "claudeGatewayStartCommand",
      ),
      claudeGatewayDisableAgent: options.serverSettingsService?.getSetting(
        "claudeGatewayDisableAgent",
      ),
      claudeGatewayDisablePlanMode: options.serverSettingsService?.getSetting(
        "claudeGatewayDisablePlanMode",
      ),
      subagentMaxDepth: getConfiguredSubagentMaxDepth(),
      ollamaUrl: options.serverSettingsService?.getSetting("ollamaUrl"),
      ollamaSystemPrompt:
        options.serverSettingsService?.getSetting("ollamaSystemPrompt"),
      ollamaUseFullSystemPrompt: options.serverSettingsService?.getSetting(
        "ollamaUseFullSystemPrompt",
      ),
      ambientXaiApiKey: process.env.XAI_API_KEY,
      grokBuildUseXaiApiKey: options.serverSettingsService?.getSetting(
        "grokBuildUseXaiApiKey",
      ),
    }),
  });
  const codexSessionsDir = options.codexSessionsDir ?? CODEX_SESSIONS_DIR;
  const geminiSessionsDir = options.geminiSessionsDir ?? GEMINI_TMP_DIR;
  const grokSessionsDir = options.grokSessionsDir ?? GROK_SESSIONS_DIR;
  const piSessionsDir = options.piSessionsDir ?? PI_SESSIONS_DIR;

  const app = new Hono<{ Bindings: HttpBindings }>();
  if (options.desktopBootstrapService) {
    app.route(
      "/desktop-bootstrap",
      createDesktopBootstrapRoutes(options.desktopBootstrapService),
    );
  }
  // Unhandled route throws — including from every mounted sub-app, whose
  // errors Hono routes here rather than to the sub-app — return structured
  // JSON instead of an opaque empty 500.
  app.onError(structuredErrorHandler);
  const effectiveDataDir =
    options.dataDir ??
    join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".yep-anywhere");
  const projectStoragePolicy =
    options.projectStoragePolicy ??
    new ProjectStoragePolicy({
      dataDir: effectiveDataDir,
      getMode: () =>
        options.serverSettingsService?.getSetting("projectDirectoryStorage") ??
        "app-data",
    });
  const attachmentStagingService =
    options.attachmentStagingService ??
    new AttachmentStagingService({
      dataDir: options.dataDir,
      maxUploadSizeBytes: options.maxUploadSizeBytes,
      storagePolicy: projectStoragePolicy,
    });
  options.projectQueueService?.setAttachmentStagingService(
    attachmentStagingService,
  );

  // Compress API responses (gzip/deflate). Large session payloads — multi-MB
  // Codex transcripts — otherwise cross slow first-mile links uncompressed:
  // Cloudflare-tunnel and Tailscale/LAN clients have nothing compressing the
  // origin→edge hop (Cloudflare only compresses edge→browser, and cloudflared
  // ships the origin response raw). Browsers send Accept-Encoding and decompress
  // transparently, so no client changes are needed; the relay path compresses
  // separately. The middleware safely skips WebSocket upgrades, SSE
  // (text/event-stream), already-encoded responses, and sub-1KB bodies. It is a
  // no-op for internal app.fetch() calls (relayed requests) which send no
  // Accept-Encoding, but public-share links opened directly in a browser DO send
  // it — and /public-api/shares/sessions/* serves the same multi-MB session JSON
  // — so that prefix is covered too. Registered first so it wraps the response.
  app.use("/api/*", compress());
  app.use("/public-api/*", compress());

  // Security middleware: host validation, CORS, custom header requirement
  app.use("/api/*", hostCheckMiddleware);
  app.use("/api/*", corsMiddleware);
  app.use("/api/*", requireCustomHeader);

  // Auth middleware (if authService is provided)
  // The middleware checks authService.isEnabled() dynamically
  if (options.authService) {
    app.use(
      "/api/*",
      createAuthMiddleware({
        authService: options.authService,
        authDisabled: options.authDisabled,
        desktopAuthToken: options.desktopAuthToken,
        desktopBootstrapService: options.desktopBootstrapService,
      }),
    );
  }

  // Auth routes (always mounted if authService is provided)
  // This allows checking auth status and enabling/disabling from settings
  if (options.authService) {
    app.route(
      "/api/auth",
      createAuthRoutes({
        authService: options.authService,
        authDisabled: options.authDisabled,
        desktopAuthToken: options.desktopAuthToken,
        desktopBootstrapService: options.desktopBootstrapService,
        isAuthenticationRelaxationBlocked,
      }),
    );
  }

  // Remote access routes (SRP authentication for relay)
  if (options.remoteAccessService) {
    const callbackHolder = options.relayConfigCallbackHolder;
    app.route(
      "/api/remote-access",
      createRemoteAccessRoutes({
        remoteAccessService: options.remoteAccessService,
        remoteSessionService: options.remoteSessionService,
        relayClientService: options.relayClientService,
        onRelayConfigChanged: callbackHolder
          ? () => callbackHolder.callback?.() ?? Promise.resolve()
          : undefined,
      }),
    );
  }

  if (options.securityClientService) {
    app.route("/", createSecurityClientRoutes(options.securityClientService));
  }

  // Create dependencies
  const codexDiscoveryIndexes = new Map<
    string,
    NonNullable<ReturnType<typeof createCodexSessionDiscoveryIndex>>
  >();
  const getCodexDiscoveryIndex = (sessionsDir: string) => {
    const existing = codexDiscoveryIndexes.get(sessionsDir);
    if (existing) return existing;
    const created = createCodexSessionDiscoveryIndex(
      options.dataDir,
      sessionsDir,
      options.sessionDiscoveryIndexRegistry,
    );
    if (created) {
      codexDiscoveryIndexes.set(sessionsDir, created);
    }
    return created;
  };
  const codexDiscoveryIndex = getCodexDiscoveryIndex(codexSessionsDir);
  const codexScanner = new CodexSessionScanner(
    codexDiscoveryIndex
      ? { sessionsDir: codexSessionsDir, discoveryIndex: codexDiscoveryIndex }
      : { sessionsDir: codexSessionsDir },
  );
  const geminiScanner = new GeminiSessionScanner({
    sessionsDir: geminiSessionsDir,
  });
  const projectScanCachePath = options.dataDir
    ? join(options.dataDir, "indexes", "project-scanner-cache.json")
    : undefined;
  const scanner = new ProjectScanner({
    projectsDir: options.projectsDir,
    codexScanner,
    geminiScanner,
    geminiSessionsDir,
    projectScanCachePath,
    projectMetadataService: options.projectMetadataService,
    workstreamService: options.workstreamService,
    eventBus: options.eventBus,
    cacheTtlMs: options.projectScanCacheTtlMs,
  });
  const glossaryIndexService = new GlossaryIndexService();
  const localResourcePathPolicy = createLocalResourcePathPolicy({
    allowedPaths: getAllowedFilePaths,
    scanner,
    includeProjects: shouldIncludeProjects,
  });
  const toolResultMediaStore = new ToolResultMediaStore({
    dataDir: options.dataDir,
    storagePolicy: projectStoragePolicy,
    shouldPreserveLiveMedia: () =>
      options.serverSettingsService?.getSetting(
        "toolResultMediaPreservation",
      ) === "preserve",
    resolveSourcePath: async (absolutePath) => {
      const resolved =
        await localResourcePathPolicy.resolveAllowedFilePath(absolutePath);
      return resolved.ok ? resolved.file.resolvedPath : null;
    },
    providerSourceRoots: ({ provider, projectPath, sessionId }) =>
      provider === "grok"
        ? grokSessionMediaRoots(grokSessionsDir, projectPath, sessionId)
        : [],
  });
  const bangCommandService =
    options.sessionMetadataService && options.dataDir
      ? new BangCommandService({
          dataDir: options.dataDir,
          sessionMetadataService: options.sessionMetadataService,
          eventBus: options.eventBus,
        })
      : null;
  const readerCache = new Map<string, ISessionReader>();
  const maxReaderCacheSize = 500;
  const closeReader = async (
    key: string,
    reader: ISessionReader,
  ): Promise<void> => {
    if (!reader.close) return;
    try {
      await reader.close();
    } catch (error) {
      console.warn(`[App] Failed to close session reader ${key}:`, error);
    }
  };
  const disposeSessionReaders = async (): Promise<void> => {
    await bangCommandService?.dispose();
    const entries = Array.from(readerCache.entries());
    readerCache.clear();
    await Promise.all(entries.map(([key, reader]) => closeReader(key, reader)));
  };

  const getOrCreateReader = <T extends ISessionReader>(
    key: string,
    factory: () => T,
  ): T => {
    const cached = readerCache.get(key);
    if (cached) return cached as T;

    const reader = factory();
    readerCache.set(key, reader);

    while (readerCache.size > maxReaderCacheSize) {
      const oldestKey = readerCache.keys().next().value;
      if (!oldestKey) break;
      const oldestReader = readerCache.get(oldestKey);
      readerCache.delete(oldestKey);
      if (oldestReader) void closeReader(oldestKey, oldestReader);
    }

    return reader;
  };

  /**
   * Create a session reader appropriate for the project's provider.
   * Routes call this with the project to get the right reader.
   */
  const readerFactory = (project: Project): ISessionReader => {
    const mergedKey =
      project.mergedSessionDirs && project.mergedSessionDirs.length > 0
        ? `::merged=${project.mergedSessionDirs.join(",")}`
        : "";

    switch (project.provider) {
      case "codex": {
        const sandboxSessionRoots = [
          ...new Map(
            Object.values(
              options.sessionMetadataService?.getAllMetadata() ?? {},
            ).flatMap((metadata) => {
              if (
                metadata.provider !== "codex" ||
                metadata.sandboxLevel !== "project-write" ||
                !metadata.sandboxStateKey ||
                metadata.workingProjectId !== project.id
              ) {
                return [];
              }
              const root = {
                sessionsDir: getCodexSandboxSessionsDir({
                  dataDir: effectiveDataDir,
                  stateKey: metadata.sandboxStateKey,
                }),
                projectPath: metadata.sandboxProjectPath ?? project.path,
              };
              return [
                [`${root.sessionsDir}\0${root.projectPath}`, root] as const,
              ];
            }),
          ).values(),
        ];
        const sandboxKey =
          sandboxSessionRoots.length > 0
            ? `::sandbox=${sandboxSessionRoots
                .map(
                  ({ sessionsDir, projectPath }) =>
                    `${sessionsDir}:${projectPath}`,
                )
                .join(",")}`
            : "";
        return getOrCreateReader(
          `codex::${project.sessionDir}::${project.path}${sandboxKey}`,
          () => {
            const discoveryIndex = getCodexDiscoveryIndex(project.sessionDir);
            const globalReader = new CodexSessionReader({
              sessionsDir: project.sessionDir,
              projectPath: project.path,
              summaryParserWorkerMode: options.codexSummaryParserWorkerMode,
              ...(discoveryIndex ? { discoveryIndex } : {}),
            });
            if (sandboxSessionRoots.length === 0) {
              return globalReader;
            }
            return new MergedSessionReader([
              ...sandboxSessionRoots.map(
                ({ sessionsDir, projectPath }) =>
                  new CodexSessionReader({
                    sessionsDir,
                    projectPath,
                    summaryParserWorkerMode:
                      options.codexSummaryParserWorkerMode,
                  }),
              ),
              globalReader,
            ]);
          },
        );
      }
      case "codex-oss":
        return getOrCreateReader(
          `codex-oss::${project.sessionDir}::${project.path}`,
          () => {
            const discoveryIndex = getCodexDiscoveryIndex(project.sessionDir);
            return new CodexSessionReader({
              sessionsDir: project.sessionDir,
              projectPath: project.path,
              summaryParserWorkerMode: options.codexSummaryParserWorkerMode,
              ...(discoveryIndex ? { discoveryIndex } : {}),
            });
          },
        );
      case "gemini":
      case "gemini-acp":
        return getOrCreateReader(
          `gemini::${geminiSessionsDir}::${project.path}`,
          () =>
            new GeminiSessionReader({
              sessionsDir: geminiSessionsDir,
              projectPath: project.path,
              hashToCwd: geminiScanner.getHashToCwd(),
            }),
        );
      case "claude":
      case "claude-gateway":
      case "claude-ollama": {
        const mis = options.modelInfoService;
        const sandboxSessionDirs = [
          ...new Set(
            Object.values(
              options.sessionMetadataService?.getAllMetadata() ?? {},
            ).flatMap((metadata) =>
              metadata.provider &&
              isClaudeProviderName(metadata.provider) &&
              metadata.sandboxLevel === "project-write" &&
              metadata.sandboxStateKey &&
              metadata.workingProjectId === project.id
                ? [
                    getClaudeSandboxProjectDir({
                      dataDir: effectiveDataDir,
                      stateKey: metadata.sandboxStateKey,
                      projectPath: metadata.sandboxProjectPath ?? project.path,
                    }),
                  ]
                : [],
            ),
          ),
        ];
        const allAdditionalDirs = [
          ...(project.mergedSessionDirs ?? []),
          ...sandboxSessionDirs,
        ];
        const sandboxKey =
          sandboxSessionDirs.length > 0
            ? `::sandbox=${sandboxSessionDirs.join(",")}`
            : "";
        return getOrCreateReader(
          `claude::${project.sessionDir}${mergedKey}${sandboxKey}`,
          () =>
            new ClaudeSessionReader({
              sessionDir: project.sessionDir,
              additionalDirs: allAdditionalDirs,
              summaryParserWorkerMode: options.claudeSummaryParserWorkerMode,
              getContextWindow: mis
                ? (model, provider) => mis.getContextWindow(model, provider)
                : undefined,
            }),
        );
      }
      case "opencode":
        return getOrCreateReader(
          `opencode::${project.path}`,
          () =>
            new OpenCodeSessionReader({
              projectPath: project.path,
            }),
        );
      case "grok":
        return getOrCreateReader(
          `grok::${grokSessionsDir}::${project.path}`,
          () =>
            new GrokSessionReader({
              sessionsDir: grokSessionsDir,
              projectPath: project.path,
            }),
        );
      case "pi":
        return getOrCreateReader(
          `pi::${piSessionsDir}::${project.path}`,
          () =>
            new PiSessionReader({
              sessionsDir: piSessionsDir,
              projectPath: project.path,
            }),
        );
    }
  };
  const codexReaderFactory = (projectPath: string): CodexSessionReader =>
    getOrCreateReader(
      `codex-extra::${codexSessionsDir}::${projectPath}`,
      () => {
        const discoveryIndex = getCodexDiscoveryIndex(codexSessionsDir);
        return new CodexSessionReader({
          sessionsDir: codexSessionsDir,
          projectPath,
          summaryParserWorkerMode: options.codexSummaryParserWorkerMode,
          ...(discoveryIndex ? { discoveryIndex } : {}),
        });
      },
    );
  const geminiReaderFactory = (projectPath: string): GeminiSessionReader =>
    getOrCreateReader(
      `gemini-extra::${geminiSessionsDir}::${projectPath}`,
      () =>
        new GeminiSessionReader({
          sessionsDir: geminiSessionsDir,
          projectPath,
          hashToCwd: geminiScanner.getHashToCwd(),
        }),
    );
  const grokReaderFactory = (projectPath: string): GrokSessionReader =>
    getOrCreateReader(
      `grok-extra::${grokSessionsDir}::${projectPath}`,
      () =>
        new GrokSessionReader({
          sessionsDir: grokSessionsDir,
          projectPath,
        }),
    );
  const piReaderFactory = (projectPath: string): PiSessionReader =>
    getOrCreateReader(
      `pi-extra::${piSessionsDir}::${projectPath}`,
      () =>
        new PiSessionReader({
          sessionsDir: piSessionsDir,
          projectPath,
        }),
    );
  const getSessionSummary = async (
    sessionId: string,
    projectId: string,
    summaryOptions?: GetSessionSummaryOptions,
  ) => {
    const project = await scanner.getProject(projectId);
    if (!project) return null;
    const resolved = await findSessionSummaryAcrossProviders(
      project,
      sessionId,
      project.id,
      {
        readerFactory,
        codexSessionsDir,
        codexReaderFactory,
        codexSummaryParserWorkerMode: options.codexSummaryParserWorkerMode,
        geminiSessionsDir,
        geminiReaderFactory,
        geminiHashToCwd: geminiScanner.getHashToCwd(),
        grokSessionsDir,
        grokReaderFactory,
        piSessionsDir,
        piReaderFactory,
        claudeSummaryParserWorkerMode: options.claudeSummaryParserWorkerMode,
      },
      options.sessionMetadataService?.getProvider(sessionId),
      summaryOptions,
    );
    const summary = resolved?.summary ?? null;
    if (!summary) return null;
    return applyRecapOverlayToSummary(
      summary,
      options.sessionMetadataService?.getRecapMessages(sessionId) ?? [],
    );
  };
  const getSessionListSummary = async (
    sessionId: string,
    projectId: string,
  ) => {
    const project = await scanner.getProject(projectId);
    if (!project) return null;
    const resolved = await findSessionListSummaryAcrossProviders(
      project,
      sessionId,
      project.id,
      {
        readerFactory,
        codexSessionsDir,
        codexReaderFactory,
        codexSummaryParserWorkerMode: options.codexSummaryParserWorkerMode,
        geminiSessionsDir,
        geminiReaderFactory,
        geminiHashToCwd: geminiScanner.getHashToCwd(),
        grokSessionsDir,
        grokReaderFactory,
        piSessionsDir,
        piReaderFactory,
        claudeSummaryParserWorkerMode: options.claudeSummaryParserWorkerMode,
      },
      options.sessionMetadataService?.getProvider(sessionId),
    );
    return resolved?.summary ?? null;
  };
  const browserDebugService = new BrowserDebugService(
    Date.now,
    undefined,
    createBrowserDebugCallerToken(process.env.YEP_PROVIDER_RUNTIME_TOKEN),
  );
  const sessionWakeService = options.sessionWakeSecret
    ? new SessionWakeService({
        secret: options.sessionWakeSecret,
        logger: options.sessionWakeLogger,
        isEnabled: (sessionId) => {
          const sessionOverride =
            options.sessionMetadataService?.getMetadata(
              sessionId,
            )?.wakeTurnsEnabled;
          return (
            sessionOverride ??
            options.serverSettingsService?.getSetting("wakeTurnsEnabled") ??
            false
          );
        },
        deliver: async ({
          sessionId,
          text,
        }): Promise<SessionWakeDeliveryResult> => {
          const metadata =
            options.sessionMetadataService?.getMetadata(sessionId);
          if (metadata?.automationPausedUntilUserTurn === true) {
            return {
              accepted: false,
              status: 409,
              error: "Session automation is paused until the next user turn",
            };
          }
          const live = supervisor.getProcessForSession(sessionId);
          let projectPath = live?.projectPath;
          if (!projectPath) {
            if (
              metadata?.isArchived ||
              !isAutomaticSessionResumeAllowed(metadata)
            ) {
              return {
                accepted: false,
                status: 409,
                error: "Session is not eligible for automatic resume",
              };
            }
            if (!metadata?.workingProjectId) {
              return {
                accepted: false,
                status: 404,
                error: "Session project could not be resolved",
              };
            }
            const project = await scanner.getProject(metadata.workingProjectId);
            if (!project) {
              return {
                accepted: false,
                status: 404,
                error: "Session project could not be resolved",
              };
            }
            projectPath = project.path;
          }

          const resumed = await supervisor.resumeSession(
            sessionId,
            projectPath,
            {
              text,
              automaticSource: "wake",
            },
          );
          if ("error" in resumed) {
            return {
              accepted: false,
              status: 503,
              error: "Session queue is full",
            };
          }
          return { accepted: true };
        },
      })
    : undefined;
  const heartbeatProviderResolutionDeps = () => ({
    readerFactory,
    codexSessionsDir,
    codexReaderFactory,
    codexSummaryParserWorkerMode: options.codexSummaryParserWorkerMode,
    geminiSessionsDir,
    geminiReaderFactory,
    geminiHashToCwd: geminiScanner.getHashToCwd(),
    grokSessionsDir,
    grokReaderFactory,
    piSessionsDir,
    piReaderFactory,
    claudeSummaryParserWorkerMode: options.claudeSummaryParserWorkerMode,
  });
  const heartbeatCandidates = new HeartbeatCandidateRegistry<Project>({
    listEligible: () =>
      Object.entries(options.sessionMetadataService?.getAllMetadata() ?? {})
        .filter(([, metadata]) => isUnownedHeartbeatResumeEligible(metadata))
        .map(([sessionId, metadata]) => [sessionId, metadata] as const),
    isOwned: (sessionId) => Boolean(supervisor.getProcessForSession(sessionId)),
    listProjects: () => scanner.listProjects(),
    // Indexed lookup, so an already-located candidate never materializes the
    // whole project fleet just to find its own project.
    getProject: async (projectId) =>
      (await scanner.getProject(projectId)) ?? undefined,
    resolve: async (project, sessionId, provider) => {
      const resolved = await findSessionListSummaryAcrossProviders(
        project,
        sessionId,
        project.id,
        heartbeatProviderResolutionDeps(),
        provider,
      );
      if (!resolved) return null;
      const reader = resolved.source.reader;
      return {
        projectId: project.id,
        projectPath: project.path,
        provider: resolved.summary.provider,
        updatedAt: resolved.summary.updatedAt,
        // The provider's activity timestamp is what an append moves, so it is
        // the identity a retained pending-tool fact stays valid for.
        sourceVersion: `${resolved.summary.provider}\0${resolved.summary.updatedAt}`,
        readPendingToolCall: async () => {
          const loaded = await reader.getSession(sessionId, project.id);
          if (!loaded) return false;
          return hasPendingToolCall(normalizeSession(loaded).messages);
        },
      };
    },
  });
  const getHeartbeatTurnCandidates = async (): Promise<
    HeartbeatTurnCandidate[]
  > => {
    if (!options.sessionMetadataService) return [];
    const rows = await heartbeatCandidates.getCandidates();
    return rows.map((row) => ({
      ...row,
      projectId: row.projectId as UrlProjectId,
    }));
  };
  const resolveConfiguredProvider = (
    providerName: ProviderName,
  ): AgentProvider | undefined => {
    const configuredProvider = options.provider;
    if (configuredProvider?.name === providerName) {
      return configuredProvider;
    }
    return configuredProvider === null
      ? undefined
      : (getProvider(providerName) ?? undefined);
  };

  supervisor = new Supervisor({
    sdk: options.sdk,
    realSdk: options.realSdk,
    provider:
      options.provider !== undefined
        ? options.provider
        : isProviderRuntimeHostAvailable()
          ? resolveConfiguredProvider("claude")
          : undefined,
    idleTimeoutMs: options.idleTimeoutMs,
    defaultPermissionMode: options.defaultPermissionMode,
    eventBus: options.eventBus,
    sessionMetadataService: options.sessionMetadataService,
    notificationService: options.notificationService,
    maxWorkers: options.maxWorkers,
    idlePreemptThresholdMs: options.idlePreemptThresholdMs,
    maxQueueSize: options.maxQueueSize,
    sessionQueuePersistenceService: options.sessionQueuePersistenceService,
    toolResultMediaStore,
    dirtyFileEditorService: options.dirtyFileEditorService,
    sandboxStateRoot: join(effectiveDataDir, "session-sandboxes"),
    isSessionSandboxAuthEnforced,
    // Save executor for remote sessions to support resume
    onSessionExecutor: options.sessionMetadataService
      ? (sessionId, executor) =>
          options.sessionMetadataService?.setExecutor(sessionId, executor) ??
          Promise.resolve()
      : undefined,
    onSuccessfulProviderSession: options.onSuccessfulProviderSession,
    getSessionChildEnv:
      options.getSessionWakeBaseUrl || options.getBrowserDebugConnection
        ? (sessionId, executor) => {
            const wakeBaseUrl = options.getSessionWakeBaseUrl?.(executor);
            const browserDebugConnection =
              options.getBrowserDebugConnection?.(executor);
            return {
              ...(browserDebugConnection
                ? browserDebugService.getAgentEnvironment(
                    browserDebugConnection.baseUrl,
                    browserDebugConnection.caCertificate,
                  )
                : {}),
              ...(wakeBaseUrl
                ? sessionWakeService?.environmentForSession(
                    sessionId,
                    wakeBaseUrl,
                  )
                : {}),
            };
          }
        : undefined,
    // Durably record a model's real context window the moment a process
    // observes it (in the result message), independent of any client fetch.
    onContextWindowObserved: options.modelInfoService
      ? (model, contextWindow, provider) =>
          options.modelInfoService?.recordContextWindow(
            model,
            contextWindow,
            provider,
          )
      : undefined,
    onSessionSummary: getSessionSummary,
    recoverSessionLaunchSettings: async (sessionId, projectId, provider) => {
      const project = await scanner.getProject(projectId);
      if (!project) return undefined;
      const recoveryProvider = provider ?? project.provider;
      if (recoveryProvider !== "codex" && recoveryProvider !== "codex-oss") {
        return undefined;
      }
      const reader = readerFactory({
        ...project,
        provider: recoveryProvider,
        sessionDir: codexSessionsDir,
      });
      return reader.getRecoveredLaunchSettings?.(sessionId);
    },
    getHeartbeatTurnSettings:
      options.serverSettingsService || options.sessionMetadataService
        ? (sessionId) => {
            const sessionHeartbeat =
              options.sessionMetadataService?.getMetadata(sessionId);
            return {
              enabled: sessionHeartbeat?.heartbeatTurnsEnabled ?? false,
              afterMinutes:
                sessionHeartbeat?.heartbeatTurnsAfterMinutes ??
                options.serverSettingsService?.getSetting(
                  "heartbeatTurnsAfterMinutes",
                ) ??
                DEFAULT_HEARTBEAT_TURNS_AFTER_MINUTES,
              forceAfterMinutes:
                sessionHeartbeat?.heartbeatForceAfterMinutes ?? null,
              text:
                sessionHeartbeat?.heartbeatTurnText ??
                options.serverSettingsService?.getSetting(
                  "heartbeatTurnText",
                ) ??
                DEFAULT_HEARTBEAT_TURN_TEXT,
            };
          }
        : undefined,
    getHeartbeatTurnCandidates: options.sessionMetadataService
      ? getHeartbeatTurnCandidates
      : undefined,
    getHeartbeatWaitingSessionIds: options.sessionMetadataService
      ? () => heartbeatCandidates.getWaitingSessionIds()
      : undefined,
    getPromptCacheKeepaliveSettings: (providerName) => {
      const capability =
        resolveConfiguredProvider(providerName)?.promptCacheKeepalive;
      if (!capability?.supportsNoContextPollutionNudge) {
        return {
          enabled: false,
          inactivityMinutes: DEFAULT_PROMPT_CACHE_KEEPALIVE_INACTIVITY_MINUTES,
        };
      }

      const saved = options.serverSettingsService?.getSetting(
        "promptCacheKeepalive",
      )?.providers?.[providerName];
      const mode = saved?.mode ?? capability.defaultMode;
      const inactivityMinutes =
        saved?.inactivityMinutes ??
        capability.defaultInactivityMinutes ??
        DEFAULT_PROMPT_CACHE_KEEPALIVE_INACTIVITY_MINUTES;
      return {
        enabled: mode === "auto",
        inactivityMinutes,
      };
    },
    getCacheMissBillingSettings: () =>
      options.serverSettingsService?.getSetting("cacheMissBilling"),
    getClaudeSteerBackgroundBashSettings: () =>
      options.serverSettingsService?.getSetting("claudeSteerBackgroundBash"),
  });
  if (sessionWakeService) {
    app.use("/session-wake/*", hostCheckMiddleware);
    app.route("/session-wake", createSessionWakeRoutes(sessionWakeService));
  }
  app.use("/browser-debug/*", hostCheckMiddleware);
  app.route(
    "/browser-debug/v1",
    createBrowserDebugAgentRoutes(browserDebugService),
  );

  // Create external session tracker if eventBus is available
  const externalTracker = options.eventBus
    ? new ExternalSessionTracker({
        eventBus: options.eventBus,
        supervisor,
        scanner,
        decayMs: 30000, // 30 seconds
        // Callback to get session summary for new external sessions
        // projectId is now UrlProjectId (base64url) - ExternalSessionTracker converts it
        getSessionSummary,
        getSessionListSummary,
      })
    : undefined;

  let projectQueueScheduler: ProjectQueueScheduler | undefined;
  if (options.eventBus && options.projectQueueService) {
    projectQueueScheduler = new ProjectQueueScheduler({
      eventBus: options.eventBus,
      projectQueueService: options.projectQueueService,
      supervisor,
      attachmentStagingService,
      sessionQueuePersistenceService: options.sessionQueuePersistenceService,
      externalTracker,
      getIdleGraceMs: () =>
        (clampProjectQueueQuietSeconds(
          options.serverSettingsService?.getSetting("projectQueueQuietSeconds"),
        ) ?? DEFAULT_PROJECT_QUEUE_QUIET_SECONDS) * 1000,
      getEffectiveProcessProjectId: (process) =>
        options.sessionMetadataService?.getMetadata(process.sessionId)
          ?.workingProjectId ?? process.projectId,
      getGlobalInstructions: () =>
        buildEffectiveAgentContext({
          globalInstructions:
            options.serverSettingsService?.getSetting("globalInstructions"),
          hints: options.serverSettingsService?.getSetting("agentContextHints"),
        }),
      isSessionAutomationPaused: (sessionId) =>
        options.sessionMetadataService?.getMetadata(sessionId)
          ?.automationPausedUntilUserTurn === true,
      onSessionStarted: async ({ item, process }) => {
        if (item.target.type !== "new-session") return;
        const metadata = options.sessionMetadataService;
        if (!metadata) return;

        await initializeSessionHeartbeatDefaults({
          sessionId: process.sessionId,
          projectId: item.projectId,
          sessionMetadataService: metadata,
          projectMetadataService: options.projectMetadataService,
          serverSettingsService: options.serverSettingsService,
        });

        const provider = item.target.provider ?? process.provider;
        if (provider) {
          await metadata.setProvider(process.sessionId, provider);
        }
        if (item.target.executor) {
          await metadata.setExecutor(process.sessionId, item.target.executor);
        }
        if (item.message.text.trim()) {
          await metadata.setInitialPrompt(process.sessionId, item.message.text);
        }
        if (item.target.model) {
          await metadata.setRequestedModel(
            process.sessionId,
            item.target.model,
          );
        }
        await metadata.updateMetadata(process.sessionId, {
          ...(process.promptSuggestionMode !== undefined
            ? { promptSuggestionMode: process.promptSuggestionMode }
            : {}),
          ...(process.recapAfterSeconds !== undefined
            ? { recapAfterSeconds: process.recapAfterSeconds }
            : {}),
        });
      },
    });
  }

  const isManualReloadMode =
    process.env.NO_BACKEND_RELOAD === "true" ||
    process.env.NO_FRONTEND_RELOAD === "true";

  const safeRestartService =
    options.eventBus && isManualReloadMode
      ? new SafeRestartService({
          eventBus: options.eventBus,
          getWorkerActivity: () => supervisor.getWorkerActivity(),
          getPreservedWork: () =>
            getPreservedRestartWork(options.sessionQueuePersistenceService),
          preparePreservedWork: async () => {
            await supervisor.preserveRestartablePatientQueuesForRestart();
          },
          restart: () =>
            triggerServerRestart({
              notificationService: options.notificationService,
              beforeRestart: disposeSessionReaders,
            }),
          pauseProjectQueueDispatch: async () => {
            const service = options.projectQueueService;
            if (!service || service.listAll().length === 0) return false;
            if (service.isDispatchPaused()) return false;
            await service.pauseDispatch("restart");
            return true;
          },
          resumeProjectQueueDispatch: async () => {
            const service = options.projectQueueService;
            if (!service) return;
            const dispatchState = service.getDispatchState();
            if (
              dispatchState.status === "paused" &&
              dispatchState.reason === "restart"
            ) {
              await service.resumeDispatch();
            }
          },
        })
      : undefined;

  // Create PushNotifier if push notifications are enabled
  // This sends push notifications when sessions need user input
  if (options.eventBus && options.pushService) {
    new PushNotifier({
      eventBus: options.eventBus,
      pushService: options.pushService,
      supervisor,
    });
  }

  if (options.eventBus && options.pushService && options.projectQueueService) {
    new InactivityPushNotifier({
      eventBus: options.eventBus,
      pushService: options.pushService,
      supervisor,
      projectQueueService: options.projectQueueService,
      externalTracker,
    });
  }

  if (options.eventBus && options.serverSettingsService) {
    new LifecycleWebhookService({
      eventBus: options.eventBus,
      supervisor,
      serverSettingsService: options.serverSettingsService,
    });
  }

  // Health check (outside /api — needs CORS for Tauri desktop app)
  app.use("/health", corsMiddleware);
  app.use("/health/*", corsMiddleware);
  app.route("/health", health);

  // Version check (outside /api for easy access)
  app.route(
    "/api/version",
    createVersionRoutes({
      browserSettingsBackupAvailable: !!options.browserSettingsBackupService,
      securityClientAuditAvailable: !!options.securityClientService,
      getDeviceBridgeState: () => {
        if (!options.deviceBridgeService) return "unavailable";
        return options.deviceBridgeService.hasBinary()
          ? "available"
          : "downloadable";
      },
      getDeviceBridgeStatus: ({ forceRefresh } = {}) => {
        if (!options.deviceBridgeService) {
          return Promise.resolve({ state: "unavailable" as const });
        }
        return options.deviceBridgeService.getBridgeStatus({ forceRefresh });
      },
      isDeviceBridgeEnabled: () =>
        options.serverSettingsService?.getSetting("deviceBridgeEnabled") ??
        false,
      installId: options.installId,
      voiceInputEnabled: options.voiceInputEnabled,
      getEnabledVoiceBackends: () =>
        options.speechBackendRegistry?.enabledIds() ?? [],
      getVoiceBackendStatuses: () =>
        options.speechBackendRegistry?.allInfo() ?? [],
      getVoiceBackendCapabilities: () =>
        options.speechBackendRegistry?.enabledCapabilities() ?? {},
      getClientDefaults: () =>
        options.serverSettingsService?.getSetting("clientDefaults"),
      getSessionSandboxAvailability: async (availabilityOptions) =>
        applySessionSandboxAuthRequirement(
          await getSessionSandboxAvailability(availabilityOptions),
          isSessionSandboxAuthEnforced(),
        ),
      desktopRuntime: options.desktopRuntime,
      providerHostControlAvailable: isProviderRuntimeHostAvailable(),
      isLiveWorktreeMonitoringEnabled: () =>
        options.serverSettingsService?.getSetting(
          "liveWorktreeMonitoringEnabled",
        ) ?? false,
    }),
  );

  // Server info (host/port binding info for Local Access settings)
  if (options.serverHost && options.serverPort !== undefined) {
    app.route(
      "/api/server-info",
      createServerInfoRoutes({
        host: options.serverHost,
        port: () =>
          options.networkBindingCallbackHolder?.getLocalhostPort?.() ??
          options.serverPort ??
          0,
        installId: options.installId,
        deviceBridgeAvailable: !!options.deviceBridgeService?.hasBinary(),
      }),
    );
  }

  // Documented startup env vars (read-only; secrets redacted server-side).
  // The HOST entry is annotated with the live listen addresses; read the holder
  // lazily since its getter is set after startServer() binds.
  app.route(
    "/api/env-settings",
    createEnvSettingsRoutes({
      getActiveListeners: () =>
        options.networkBindingCallbackHolder?.getActiveListeners?.() ?? [],
    }),
  );

  // Server admin routes (restart, always available for remote relay)
  app.route(
    "/api/server",
    createServerAdminRoutes({
      supervisor,
      notificationService: options.notificationService,
      beforeRestart: disposeSessionReaders,
    }),
  );

  if (options.sessionIndexService) {
    app.route(
      "/api/session-index",
      createSessionIndexRoutes({
        sessionIndexService: options.sessionIndexService,
      }),
    );
  }

  // Network binding routes (runtime port/interface configuration)
  if (
    options.networkBindingService &&
    options.networkBindingCallbackHolder &&
    options.eventBus
  ) {
    app.route(
      "/api/network-binding",
      createNetworkBindingRoutes({
        networkBindingService: options.networkBindingService,
        eventBus: options.eventBus,
        onLocalhostPortChange: async (port) => {
          const callback =
            options.networkBindingCallbackHolder?.onLocalhostPortChange;
          if (!callback) {
            return { success: false, error: "Callback not configured" };
          }
          return callback(port);
        },
        onNetworkBindingChange: async (config) => {
          const callback =
            options.networkBindingCallbackHolder?.onNetworkBindingChange;
          if (!callback) {
            return { success: false, error: "Callback not configured" };
          }
          return callback(config);
        },
      }),
    );
  }

  // Onboarding routes (first-run wizard state)
  if (options.dataDir) {
    app.route(
      "/api/onboarding",
      createOnboardingRoutes({
        dataDir: options.dataDir,
        completeByDefault: options.desktopRuntime === true,
      }),
    );
  }

  // Client logs routes (remote log collection for connection diagnostics)
  if (options.dataDir) {
    app.route(
      "/api/client-logs",
      createClientLogsRoutes({ dataDir: options.dataDir }),
    );
  }

  // Mount API routes
  app.route(
    "/api/browser-debug",
    createBrowserDebugClientRoutes(browserDebugService),
  );
  app.route("/api/provider-host", createProviderHostRoutes());
  app.route(
    "/api/projects",
    createProjectsRoutes({
      scanner,
      readerFactory,
      supervisor,
      externalTracker,
      notificationService: options.notificationService,
      sessionMetadataService: options.sessionMetadataService,
      projectMetadataService: options.projectMetadataService,
      eventBus: options.eventBus,
      projectQueueService: options.projectQueueService,
      sessionIndexService: options.sessionIndexService,
      codexScanner,
      codexSessionsDir,
      codexReaderFactory,
      geminiScanner,
      geminiSessionsDir,
      geminiReaderFactory,
      grokSessionsDir,
      grokReaderFactory,
      piSessionsDir,
      piReaderFactory,
      sessionAutoArchiveDays: options.sessionAutoArchiveDays,
      storagePolicy: projectStoragePolicy,
    }),
  );
  if (options.projectMetadataService) {
    app.route(
      "/api/projects",
      createProjectSessionDefaultsRoutes({
        scanner,
        projectMetadataService: options.projectMetadataService,
      }),
    );
  }
  if (options.projectQueueService) {
    app.route(
      "/api/project-queue",
      createGlobalProjectQueueRoutes({
        scanner,
        readerFactory,
        projectQueueService: options.projectQueueService,
        projectQueueScheduler,
        sessionIndexService: options.sessionIndexService,
        codexSessionsDir,
        codexReaderFactory,
        geminiSessionsDir,
        geminiReaderFactory,
        grokSessionsDir,
        grokReaderFactory,
        piSessionsDir,
        piReaderFactory,
        sessionMetadataService: options.sessionMetadataService,
        sessionQueuePersistenceService: options.sessionQueuePersistenceService,
      }),
    );
    app.route(
      "/api/projects",
      createProjectQueueRoutes({
        scanner,
        readerFactory,
        projectQueueService: options.projectQueueService,
        projectQueueScheduler,
        sessionIndexService: options.sessionIndexService,
        codexSessionsDir,
        codexReaderFactory,
        geminiSessionsDir,
        geminiReaderFactory,
        grokSessionsDir,
        grokReaderFactory,
        piSessionsDir,
        piReaderFactory,
        sessionMetadataService: options.sessionMetadataService,
      }),
    );
  }
  app.route("/api", createSupervisorQueueRoutes(supervisor));
  if (options.sessionMetadataService && bangCommandService) {
    app.route(
      "/api",
      createBangCommandsRoutes({
        scanner,
        sessionMetadataService: options.sessionMetadataService,
        bangCommandService,
        bangHistoryViewEnabled: () =>
          options.serverSettingsService?.getSetting("clientDefaults")
            ?.bangCommandsEnabled === true,
        sessionBelongsToProject: async (project, sessionId) => {
          const metadataProjectId =
            options.sessionMetadataService?.getMetadata(
              sessionId,
            )?.workingProjectId;
          if (metadataProjectId) {
            return metadataProjectId === project.id;
          }
          const process = supervisor.getProcessForSession(sessionId);
          if (process) {
            return process.projectId === project.id;
          }
          return (await getSessionListSummary(sessionId, project.id)) !== null;
        },
      }),
    );
  }
  app.route(
    "/api",
    createSessionsRoutes({
      supervisor,
      scanner,
      readerFactory,
      externalTracker,
      notificationService: options.notificationService,
      sessionIndexService: options.sessionIndexService,
      sessionMetadataService: options.sessionMetadataService,
      codexNativeTitleService: options.codexNativeTitleService,
      projectMetadataService: options.projectMetadataService,
      projectQueueScheduler,
      eventBus: options.eventBus,
      codexScanner,
      codexSessionsDir,
      codexReaderFactory,
      geminiScanner,
      geminiSessionsDir,
      geminiReaderFactory,
      grokSessionsDir,
      grokReaderFactory,
      piSessionsDir,
      piReaderFactory,
      serverSettingsService: options.serverSettingsService,
      workstreamService: options.workstreamService,
      modelInfoService: options.modelInfoService,
      sessionQueuePersistenceService: options.sessionQueuePersistenceService,
      toolResultMediaStore,
      dataDir: options.dataDir,
      persistedAugmentDelayMs: options.persistedAugmentDelayMs,
      resolveAbsoluteFilePaths: localResourcePathPolicy.findAllowedFilePaths,
    }),
  );
  app.route(
    "/api/sessions",
    createSessionDoneRoutes({
      supervisor,
      sessionMetadataService: options.sessionMetadataService,
      sessionQueuePersistenceService: options.sessionQueuePersistenceService,
    }),
  );
  app.route(
    "/api/sessions",
    createSessionArchiveRoutes({
      supervisor,
      sessionMetadataService: options.sessionMetadataService,
      sessionQueuePersistenceService: options.sessionQueuePersistenceService,
      eventBus: options.eventBus,
    }),
  );
  app.route(
    "/api/sessions",
    createSessionTerminateRoutes({
      supervisor,
      sessionMetadataService: options.sessionMetadataService,
      sessionQueuePersistenceService: options.sessionQueuePersistenceService,
      eventBus: options.eventBus,
    }),
  );
  app.route(
    "/api",
    createToolResultMediaRoutes({
      scanner,
      store: toolResultMediaStore,
    }),
  );
  app.route(
    "/api/processes",
    createProcessesRoutes({
      supervisor,
      scanner,
      readerFactory,
      processSessionSourceFactory: (process, project) => {
        const persistedProvider = options.sessionMetadataService?.getProvider(
          process.sessionId,
        );
        const provider = persistedProvider ?? process.provider;

        switch (provider) {
          case "codex":
          case "codex-oss":
            return {
              reader: codexReaderFactory(project.path),
              sessionDir: codexSessionsDir,
            };
          case "gemini":
          case "gemini-acp":
            return {
              reader: geminiReaderFactory(project.path),
              sessionDir: geminiSessionsDir,
            };
          case "grok":
            return {
              reader: grokReaderFactory(project.path),
              sessionDir: grokSessionsDir,
            };
          default:
            return {
              reader: readerFactory(project),
              sessionDir: project.sessionDir,
            };
        }
      },
      sessionIndexService: options.sessionIndexService,
      sessionMetadataService: options.sessionMetadataService,
      // Explicit Kill blocks YA's automatic resume gate while preserving the
      // provider transcript for history and deliberate manual continuation.
      blockSessionResume: async ({ sessionId }) => {
        const result = await supervisor.disableSessionAutoResume(sessionId);
        console.log(
          `[Processes] Blocked auto-resume for killed session ${sessionId}` +
            ` (heartbeatDisabled=${result.heartbeatDisabled})`,
        );
        return result;
      },
    }),
  );
  if (options.serverSettingsService) {
    app.route(
      "/api/host-agent-processes",
      createHostAgentProcessesRoutes({
        supervisor,
        serverSettingsService: options.serverSettingsService,
      }),
    );
  }

  // Inbox routes (cross-project session aggregation)
  app.route(
    "/api/inbox",
    createInboxRoutes({
      scanner,
      readerFactory,
      supervisor,
      notificationService: options.notificationService,
      sessionIndexService: options.sessionIndexService,
      sessionMetadataService: options.sessionMetadataService,
      projectQueueService: options.projectQueueService,
      codexScanner,
      codexSessionsDir,
      codexReaderFactory,
      geminiScanner,
      geminiSessionsDir,
      geminiReaderFactory,
      grokSessionsDir,
      grokReaderFactory,
      piSessionsDir,
      piReaderFactory,
      eventBus: options.eventBus,
      sessionAutoArchiveDays: options.sessionAutoArchiveDays,
    }),
  );

  // Global sessions route (flat list of all sessions for navigation)
  app.route(
    "/api/sessions",
    createGlobalSessionsRoutes({
      scanner,
      readerFactory,
      supervisor,
      externalTracker,
      notificationService: options.notificationService,
      sessionIndexService: options.sessionIndexService,
      sessionMetadataService: options.sessionMetadataService,
      codexScanner,
      codexSessionsDir,
      codexReaderFactory,
      geminiScanner,
      geminiSessionsDir,
      geminiReaderFactory,
      grokSessionsDir,
      grokReaderFactory,
      piSessionsDir,
      piReaderFactory,
      eventBus: options.eventBus,
      sessionAutoArchiveDays: options.sessionAutoArchiveDays,
    }),
  );

  // Files routes (file browser). Absolute/`~` paths go through the shared
  // file-access allow-set (same as the media doors below).
  app.route(
    "/api/projects",
    createFilesRoutes({
      scanner,
      allowedPaths: getAllowedFilePaths,
      includeProjects: shouldIncludeProjects,
    }),
  );

  app.route(
    "/api/projects",
    createGlossaryArtifactRoutes({ scanner, service: glossaryIndexService }),
  );

  // Git status routes
  app.route(
    "/api/projects",
    createGitStatusRoutes({
      scanner,
      dirtyFileEditorService: options.dirtyFileEditorService,
    }),
  );

  // Read-only git browse routes (commit list/diff, blame, search — stage 3)
  app.route(
    "/api/projects",
    createGitBrowseRoutes({ scanner, storagePolicy: projectStoragePolicy }),
  );
  app.route("/api/projects", createGitFileRevisionRoutes({ scanner }));

  // Current-content inventory and last-fetched incoming history.
  app.route(
    "/api/projects",
    createGitWorkingTreeFilesRoutes({
      scanner,
      dataDir: effectiveDataDir,
      dirtyFileEditorService: options.dirtyFileEditorService,
    }),
  );
  app.route("/api/projects", createGitIncomingCommitsRoutes({ scanner }));

  // Optional Source Control diff projections.
  app.route("/api/projects", createGitProjectionRoutes({ scanner }));
  app.route("/api/projects", createGitInclusiveToHeadRoutes({ scanner }));

  // Exact worktree projections shared by file links and file viewers.
  app.route("/api/projects", createGitFileProjectionRoutes({ scanner }));

  // Source-review draft comments (topic: source-review-to-session)
  const reviewCaptureService = new ReviewCaptureService({
    storagePolicy: projectStoragePolicy,
  });
  const reviewCommentService = new ReviewCommentService({
    captureWriter: reviewCaptureService,
    storagePolicy: projectStoragePolicy,
    listProjectPaths: async () =>
      (await scanner.listProjects()).map((project) => project.path),
  });
  projectStoragePolicy.registerTransitionParticipant(reviewCommentService);
  const sourceReviewSubmissionsEnabled = () =>
    options.serverSettingsService?.getSetting(
      "sourceReviewSubmissionsEnabled",
    ) ?? false;
  const reviewResponseObserver = new ReviewResponseObserver(
    reviewCommentService,
  );
  options.eventBus?.subscribe((event) => {
    if (event.type === "process-state-changed" && event.activity === "idle") {
      if (!sourceReviewSubmissionsEnabled()) return;
      const activeProcess = supervisor.getProcessForSession(event.sessionId);
      if (activeProcess) {
        void reviewResponseObserver
          .observeIdle(activeProcess)
          .then((results) => {
            const submissionIds = (results ?? [])
              .filter((result) => result.status === "ingested")
              .map((result) => result.submissionId);
            if (submissionIds.length > 0) {
              options.eventBus?.emit({
                type: "review-response-changed",
                projectId: activeProcess.projectId,
                submissionIds,
                timestamp: new Date().toISOString(),
              });
            }
          })
          .catch((error) => {
            console.warn(
              `[sourceReviewResponseTurns] Could not inspect review responses for ${event.sessionId}:`,
              error,
            );
          });
      }
      return;
    }
    if (event.type === "process-terminated") {
      reviewResponseObserver.forget(event.processId);
      return;
    }
    if (event.type === "session-id-remapped") {
      const activeProcess = supervisor.getProcessForSession(event.newSessionId);
      if (activeProcess) {
        void reviewCommentService
          .remapSubmissionSession(
            activeProcess.projectPath,
            event.oldSessionId,
            event.newSessionId,
          )
          .catch((error) => {
            console.warn(
              `[sourceReviewResponseTurns] Could not remap review submissions from ${event.oldSessionId}:`,
              error,
            );
          });
      }
    }
  });
  app.route(
    "/api/projects",
    createReviewCommentsRoutes({
      scanner,
      service: reviewCommentService,
      launcher: createSupervisorReviewLauncher(
        supervisor,
        async (projectPath, submissionId, acceptance) => {
          await reviewCommentService.acceptSubmission(projectPath, {
            submissionId,
            ...acceptance,
            responseTurnLimit:
              options.serverSettingsService?.getSetting(
                "sourceReviewResponseTurns",
              ) ?? 8,
          });
        },
      ),
      isSubmissionsEnabled: sourceReviewSubmissionsEnabled,
      getResponseTurnLimit: () =>
        options.serverSettingsService?.getSetting(
          "sourceReviewResponseTurns",
        ) ?? 8,
    }),
  );
  app.route(
    "/api/projects",
    createReviewSubmissionsRoutes({
      scanner,
      service: reviewCommentService,
      captureReader: reviewCaptureService,
      isEnabled: sourceReviewSubmissionsEnabled,
    }),
  );
  app.route(
    "/api",
    createReviewInboxRoutes({
      scanner,
      service: reviewCommentService,
      isEnabled: sourceReviewSubmissionsEnabled,
    }),
  );

  if (options.serverSettingsService && options.workstreamService) {
    app.route(
      "/api/projects",
      createWorkstreamRoutes({
        scanner,
        serverSettingsService: options.serverSettingsService,
        workstreamService: options.workstreamService,
      }),
    );
  }

  // Recents routes (recently visited sessions)
  if (options.recentsService) {
    app.route(
      "/api/recents",
      createRecentsRoutes({
        recentsService: options.recentsService,
        scanner,
        readerFactory,
        sessionIndexService: options.sessionIndexService,
        codexScanner,
        codexSessionsDir,
        codexReaderFactory,
        geminiScanner,
        geminiSessionsDir,
        geminiReaderFactory,
        grokSessionsDir,
        grokReaderFactory,
        piSessionsDir,
        piReaderFactory,
      }),
    );
  }

  // Provider routes (multi-provider detection)
  app.route(
    "/api/providers",
    createProvidersRoutes({
      modelInfoService: options.modelInfoService,
      enabledProviders: options.enabledProviders,
      providers:
        options.provider === null
          ? []
          : options.provider
            ? [options.provider]
            : undefined,
      desktopRuntime: options.desktopRuntime,
    }),
  );

  // Server settings routes
  if (options.serverSettingsService) {
    app.route(
      "/api/settings",
      createSettingsRoutes({
        serverSettingsService: options.serverSettingsService,
        projectStoragePolicy,
        hostAwakeService: options.hostAwakeService,
        sessionMetadataService: options.sessionMetadataService,
        onAllowedHostsChanged: updateAllowedHosts,
        onFileAccessChanged: updateFileAccess,
        onRemoteSessionPersistenceChanged: options.remoteSessionService
          ? (enabled) =>
              options.remoteSessionService?.setDiskPersistenceEnabled(enabled)
          : undefined,
        onClaudeGatewaySettingsChanged: (settings) =>
          ClaudeGatewayProvider.configureGateway(settings),
        onOllamaUrlChanged: (url) => {
          ClaudeOllamaProvider.setOllamaUrl(url);
        },
        onHeartbeatSettingsChanged: () => {
          supervisor.notifyHeartbeatScheduleChanged();
        },
        onOllamaSystemPromptChanged: (prompt) => {
          ClaudeOllamaProvider.setSystemPrompt(prompt);
        },
        onOllamaUseFullSystemPromptChanged: (enabled) => {
          ClaudeOllamaProvider.setUseFullSystemPrompt(enabled);
        },
        onGrokBuildUseXaiApiKeyChanged: (enabled) => {
          grokACPProvider.setUseAmbientXaiApiKey(enabled);
        },
        getIdleReapHours: () =>
          idleReapMsToHours(supervisor.getIdleTimeoutMs()),
        onIdleReapHoursChanged: (hours) => {
          supervisor.updateIdleTimeoutMs(idleReapHoursToMs(hours));
        },
        publicShareService: options.publicShareService,
      }),
    );
  }
  if (options.browserSettingsBackupService) {
    app.route(
      "/api/settings/browser-backup",
      createBrowserSettingsBackupRoutes({
        browserSettingsBackupService: options.browserSettingsBackupService,
      }),
    );
  }

  // Codex CLI update checker
  const codexUpdateChecker = new CodexUpdateChecker({
    codexCliPath: options.codexCliPath,
  });
  app.route(
    "/api/codex/updates",
    createCodexUpdateRoutes({ codexUpdateChecker }),
  );
  if (
    options.serverSettingsService?.getSetting("codexUpdatePolicy") === "auto"
  ) {
    void (async () => {
      try {
        const status = await codexUpdateChecker.getStatus();
        if (status.updateAvailable && status.updateMethod === "npm") {
          const result = await codexUpdateChecker.install();
          if (result.success) {
            console.log(
              `[codex-update] Auto-updated to ${result.status.installed ?? "?"}`,
            );
          } else if (result.retryable) {
            console.info(
              `[codex-update] Auto-update deferred: ${result.error ?? "provider active"}`,
            );
          } else {
            console.warn(
              `[codex-update] Auto-update failed: ${result.error ?? "unknown"}`,
            );
          }
        }
      } catch (err) {
        console.warn("[codex-update] Auto-update threw:", err);
      }
    })();
  }

  // Sharing routes (session snapshot sharing via Worker)
  if (options.sharingService) {
    app.route(
      "/api/sharing",
      createSharingRoutes({ sharingService: options.sharingService }),
    );
  }

  // Public read-only session shares. Creation is authenticated under /api;
  // public reads are secret-only and stay outside /api auth/mutation routes.
  if (options.publicShareService) {
    type PublicShareSessionDetailEnvelope = {
      messages?: AppSession["messages"];
      pagination?: unknown;
      publicShareCapture?: { completedMessageCount?: unknown };
      session?: AppSession;
    };

    const parsePublicShareSessionDetail = (
      body: PublicShareSessionDetailEnvelope,
      requireCompleteHistory: boolean,
    ): AppSession | null => {
      if (!body.session || typeof body.session !== "object") return null;
      if (requireCompleteHistory) {
        const completedMessageCount =
          body.publicShareCapture?.completedMessageCount;
        if (
          !Array.isArray(body.messages) ||
          body.pagination !== undefined ||
          body.session.messages !== undefined ||
          !Number.isInteger(body.session.messageCount) ||
          body.session.messageCount < 0 ||
          body.session.messageCount > body.messages.length ||
          !Number.isInteger(completedMessageCount) ||
          (completedMessageCount as number) < 0 ||
          (completedMessageCount as number) > body.messages.length
        ) {
          throw new PublicShareCaptureError(
            "Session detail did not provide complete history; retry frozen capture",
            "incomplete-history",
          );
        }
        return {
          ...body.session,
          messageCount: completedMessageCount as number,
          messages: body.messages.slice(0, completedMessageCount as number),
        };
      }
      return {
        ...body.session,
        messages: Array.isArray(body.session.messages)
          ? body.session.messages
          : (body.messages ?? []),
      };
    };

    const fetchPublicShareSession = async (
      projectId: UrlProjectId,
      sessionId: string,
      options: {
        afterMessageId?: string;
        requireCompleteHistory?: boolean;
      } = {},
    ): Promise<AppSession | null> => {
      const searchParams = new URLSearchParams({ publicShare: "1" });
      if (options.afterMessageId) {
        searchParams.set("afterMessageId", options.afterMessageId);
      }
      if (options.requireCompleteHistory) {
        searchParams.set("fullHistory", "1");
        searchParams.set("fullHistoryReason", "public-share-capture");
      }
      const response = await app.fetch(
        new Request(
          `http://127.0.0.1/api/projects/${projectId}/sessions/${encodeURIComponent(sessionId)}?${searchParams}`,
          { headers: { "X-Yep-Anywhere": "true" } },
        ),
        { [WS_INTERNAL_AUTHENTICATED]: true },
      );
      if (!response.ok) {
        if (options.requireCompleteHistory && response.status !== 404) {
          throw new PublicShareCaptureError(
            "Complete session history is temporarily unavailable; retry frozen capture",
            "incomplete-history",
          );
        }
        return null;
      }
      let body: PublicShareSessionDetailEnvelope;
      try {
        body = (await response.json()) as PublicShareSessionDetailEnvelope;
      } catch (error) {
        if (options.requireCompleteHistory) {
          throw new PublicShareCaptureError(
            "Complete session history response was invalid; retry frozen capture",
            "incomplete-history",
          );
        }
        throw error;
      }
      return parsePublicShareSessionDetail(
        body,
        options.requireCompleteHistory ?? false,
      );
    };

    const loadPublicShareSession = (
      projectId: UrlProjectId,
      sessionId: string,
      options?: { afterMessageId?: string },
    ): Promise<AppSession | null> =>
      fetchPublicShareSession(projectId, sessionId, options);

    const loadCompletePublicShareSession = (
      projectId: UrlProjectId,
      sessionId: string,
    ): Promise<AppSession | null> =>
      fetchPublicShareSession(projectId, sessionId, {
        requireCompleteHistory: true,
      });

    const loadPublicShareSessionUpdatedAt = async (
      projectId: UrlProjectId,
      sessionId: string,
    ): Promise<string | null> => {
      const response = await app.fetch(
        new Request(
          `http://127.0.0.1/api/projects/${projectId}/sessions/${encodeURIComponent(sessionId)}/metadata`,
          { headers: { "X-Yep-Anywhere": "true" } },
        ),
        { [WS_INTERNAL_AUTHENTICATED]: true },
      );
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as {
        session?: { updatedAt?: string | null };
      };
      return body.session?.updatedAt ?? null;
    };

    const loadPublicShareSessionSummary = async (
      projectId: UrlProjectId,
      sessionId: string,
    ): Promise<Pick<
      AppSession,
      | "customTitle"
      | "fullTitle"
      | "initialPrompt"
      | "provider"
      | "title"
      | "updatedAt"
    > | null> => {
      const response = await app.fetch(
        new Request(
          `http://127.0.0.1/api/projects/${projectId}/sessions/${encodeURIComponent(sessionId)}/metadata`,
          { headers: { "X-Yep-Anywhere": "true" } },
        ),
        { [WS_INTERNAL_AUTHENTICATED]: true },
      );
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as {
        session?: Pick<
          AppSession,
          | "customTitle"
          | "fullTitle"
          | "initialPrompt"
          | "provider"
          | "title"
          | "updatedAt"
        >;
      };
      return body.session ?? null;
    };

    const fetchPublicShareProjectFile = async (
      projectId: UrlProjectId,
      filePath: string,
      fileOptions: {
        download?: boolean;
        highlight?: boolean;
        lineEnd?: number;
        lineNumber?: number;
        raw?: boolean;
        projectRoot?: string;
        viewMode?: "full" | "range";
      },
    ): Promise<Response> => {
      const searchParams = new URLSearchParams({ path: filePath });
      if (fileOptions.highlight) {
        searchParams.set("highlight", "true");
      }
      if (fileOptions.lineNumber !== undefined) {
        searchParams.set("line", String(fileOptions.lineNumber));
      }
      if (fileOptions.lineEnd !== undefined) {
        searchParams.set("lineEnd", String(fileOptions.lineEnd));
      }
      if (fileOptions.viewMode === "range") {
        searchParams.set("view", "range");
      }
      if (fileOptions.download) {
        searchParams.set("download", "true");
      }
      const route = fileOptions.raw ? "files/raw" : "files";
      const projectRoot = fileOptions.projectRoot ?? decodeProjectId(projectId);
      const attachmentPath = canonicalizeManagedAttachmentPath(
        filePath,
        effectiveDataDir,
      );
      const shareFiles = createFilesRoutes({
        scanner: {
          getProject: async () => ({ path: projectRoot }),
        } as unknown as ProjectScanner,
        ...(attachmentPath
          ? {
              allowedPaths: () => [
                join(effectiveDataDir, "projects"),
                join(effectiveDataDir, "uploads"),
              ],
              includeProjects: () => false,
            }
          : { strictProjectFileAccess: true }),
      });
      return await shareFiles.request(`/${projectId}/${route}?${searchParams}`);
    };

    const publicShareDeps = {
      publicShareService: options.publicShareService,
      loadSession: loadPublicShareSession,
      loadCompleteSession: loadCompletePublicShareSession,
      loadSessionUpdatedAt: loadPublicShareSessionUpdatedAt,
      loadSessionSummary: loadPublicShareSessionSummary,
      fetchProjectFile: fetchPublicShareProjectFile,
      dataDir: effectiveDataDir,
      getRelayConfig: () =>
        options.remoteAccessService?.getRelayConfig() ?? null,
      getPublicSharesEnabled: () =>
        options.serverSettingsService?.getSetting("publicSharesEnabled") ??
        false,
      getRemoteAccessEnabled: () =>
        options.remoteAccessService?.isEnabled() ?? false,
      getRelayStatus: () =>
        options.relayClientService?.getState().status ?? null,
      getYaClientBaseUrl: () =>
        options.serverSettingsService?.getSetting("yaClientBaseUrl"),
      getPublicShareViewerBaseUrl: () =>
        options.serverSettingsService?.getSetting("publicShareViewerBaseUrl"),
    };

    app.route("/api/public-shares", createPublicShareRoutes(publicShareDeps));
    app.route("/api", createPublicFileShareRoutes(publicShareDeps));
    app.route(
      "/api",
      createPublicShareManagementRoutes({
        publicShareService: options.publicShareService,
      }),
    );
    app.route("/api", createPublicShareManagementFreezeRoutes(publicShareDeps));
    app.route(
      "/public-api/shares",
      createPublicSharePublicRoutes(publicShareDeps),
    );
  }

  // Connections routes (list connected browser profiles)
  if (options.connectedBrowsers) {
    app.route(
      "/api/connections",
      createConnectionsRoutes({
        connectedBrowsers: options.connectedBrowsers,
        pushService: options.pushService,
      }),
    );
  }

  // Browser profiles routes (list browser profiles with origins)
  if (options.browserProfileService) {
    app.route(
      "/api/browser-profiles",
      createBrowserProfilesRoutes({
        browserProfileService: options.browserProfileService,
        pushService: options.pushService,
      }),
    );
  }

  // Emulator streaming routes (Android emulator remote control)
  if (options.deviceBridgeService) {
    app.route(
      "/api/devices",
      createDeviceRoutes({
        deviceBridgeService: options.deviceBridgeService,
        serverSettingsService: options.serverSettingsService,
      }),
    );
  }

  // Upload routes (WebSocket file uploads)
  if (options.upgradeWebSocket) {
    app.route(
      "/api",
      createUploadRoutes({
        scanner,
        upgradeWebSocket: options.upgradeWebSocket,
        maxUploadSizeBytes: options.maxUploadSizeBytes,
        attachmentStagingService,
        storagePolicy: projectStoragePolicy,
      }),
    );
  }

  // Speech audio WebSocket route
  if (options.upgradeWebSocket && options.speechBackendRegistry) {
    app.route(
      "/api/speech",
      createSpeechRoutes({
        speechBackendRegistry: options.speechBackendRegistry,
        upgradeWebSocket: options.upgradeWebSocket,
        dataDir: options.dataDir,
        serverSettingsService: options.serverSettingsService,
        xaiSttApiKey: options.xaiSttApiKey,
        shareXaiSttApiKeyWithClients: options.shareXaiSttApiKeyWithClients,
      }),
    );
  }

  // Local media/file serving — both doors enforce the live file-access
  // allow-set (uploads ∪ temp ∪ home ∪ custom, plus projects). Always mounted;
  // the policy denies anything outside the set.
  app.route(
    "/api/local-image",
    createLocalImageRoutes({
      allowedPaths: getAllowedFilePaths,
      includeProjects: shouldIncludeProjects,
      scanner,
    }),
  );
  app.route(
    "/api/local-file",
    createLocalFileRoutes({
      allowedPaths: getAllowedFilePaths,
      includeProjects: shouldIncludeProjects,
      scanner,
    }),
  );

  // Push notification routes
  if (options.pushService) {
    app.route(
      "/api/push",
      createPushRoutes({ pushService: options.pushService }),
    );
  }

  // Activity routes (file watching)
  if (options.eventBus) {
    app.route(
      "/api/activity",
      createActivityRoutes({
        eventBus: options.eventBus,
        connectedBrowsers: options.connectedBrowsers,
        browserProfileService: options.browserProfileService,
      }),
    );

    // Dev routes (manual reload workflow) - mounted when manual reload is enabled
    if (isManualReloadMode) {
      console.log("[Dev] Mounting dev routes at /api/dev");
      app.route(
        "/api/dev",
        createDevRoutes({
          eventBus: options.eventBus,
          safeRestartService,
        }),
      );
    }
  }

  // Debug streaming routes (always mounted in dev, useful for debugging markdown rendering)
  if (process.env.NODE_ENV !== "production") {
    app.route("/api/debug", createDebugStreamingRoutes());
  }

  // Frontend proxy fallback: proxy all non-API requests to Vite dev server
  // This must be the last route to act as a catch-all
  if (options.frontendProxy) {
    const proxy = options.frontendProxy;
    app.all("*", (c) => {
      const { incoming, outgoing } = c.env;
      proxy.web(incoming, outgoing);
      return RESPONSE_ALREADY_SENT;
    });
  }

  return {
    app,
    supervisor,
    scanner,
    readerFactory,
    disposeSessionReaders,
    glossaryIndexService,
    externalTracker,
    resolveAbsoluteFilePaths: localResourcePathPolicy.findAllowedFilePaths,
  };
}

// Default app for backwards compatibility (health check only)
// Full API requires createApp() with SDK injection
export const app = new Hono();
app.route("/health", health);
