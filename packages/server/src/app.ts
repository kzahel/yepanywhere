import { AgentAuthRouter } from "./services/AgentAuthRouter.js";
import { createAgentAuthRouterRoutes } from "./routes/agent-auth-router.js";
import { DraftStore } from "./drafts/DraftStore.js";
import { createDraftRoutes } from "./routes/drafts.js";
import { ConversationSubscriptions } from "./experimental/conversation-subscriptions.js";
import { retireLegacyComputerControl } from "./machine-control/legacy-retirement.js";
import {
  createMachineControlRoutes,
  supportsInstalledMachineControl,
} from "./routes/machine-control.js";
import { createConversationSource } from "./experimental/conversation-source.js";
import { createExperimentalConversationRoutes } from "./routes/experimental-conversation.js";
import { IssueStore } from "./services/issues/IssueStore.js";
import { IssueIndexer } from "./services/issues/IssueIndexer.js";
import { createIssueRoutes } from "./routes/issues.js";
import { IssueCredentials } from "./services/issues/credentials.js";
import { IssueConfirmer } from "./services/issues/confirm.js";
import { IssueStatusRefresher } from "./services/issues/status.js";
import { getSessionSources } from "./sessions/provider-resolution.js";
import type { HttpBindings } from "@hono/node-server";
import { artifactViewerAgentEnvironment } from "./artifacts/agentEnvironment.js";
import { ArtifactServer } from "./artifacts/ArtifactServer.js";
import {
  validateArtifactConfig,
  type ArtifactConfig,
} from "./artifacts/config.js";
import { createArtifactConfigWriter } from "./routes/artifactConfigWriter.js";
import { createArtifactPreviewRoutes } from "./routes/artifact-previews.js";
import { createArtifactRoutes } from "./routes/artifacts.js";
import { createVhostSiteRoutes } from "./routes/vhostSites.js";
import { createVhostAppRoutes } from "./routes/vhostApps.js";
import { createVhostAccessRoutes } from "./routes/vhostAccess.js";
import { createVhostOauthRoutes } from "./routes/vhostOauth.js";
import {
  createSessionAppRoutes,
  sessionAppBrokerSocket,
} from "./routes/sessionApps.js";
import { createMcpAppRoutes } from "./routes/mcpApps.js";
import { createSessionPathScopeResolver } from "./routes/session-path-scope.js";
import { createSessionLocalFileRoutes } from "./routes/session-local-files.js";
import {
  VhostAppControl,
  vhostAppControlAvailable,
} from "./artifacts/VhostAppControl.js";
import { gatewayServiceUsage } from "./sdk/providers/gatewayServiceUsage.js";
import { syncGatewayServiceExports } from "./sdk/providers/gatewayServiceExport.js";
import { noteGatewayServiceUsage } from "./sdk/providers/claude-gateway.js";
import {
  isArtifactHost,
  isArtifactOrigin,
  isVhostHost,
  isVhostOrigin,
} from "./middleware/allowed-hosts.js";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import type {
  AppContentBlock,
  AppSession,
  ProviderName,
  SafeRestartPreservedWork,
  UrlProjectId,
} from "@yep-anywhere/shared";
import {
  DEFAULT_CLEARLOOP_INACTIVITY_SECONDS,
  clampClearloopInactivitySeconds,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import {
  DEFAULT_HEARTBEAT_TURN_TEXT,
  DEFAULT_ISSUE_SETTINGS,
  DEFAULT_HEARTBEAT_TURNS_AFTER_MINUTES,
  DEFAULT_PROJECT_QUEUE_QUIET_SECONDS,
  DEFAULT_PROMPT_CACHE_KEEPALIVE_INACTIVITY_MINUTES,
  DEFAULT_SUBAGENT_MAX_DEPTH,
  buildEffectiveAgentContext,
  clampProjectQueueQuietSeconds,
  idleReapHoursToMs,
  idleReapMsToHours,
  isClaudeProviderName,
  withPathGrantProjects,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { join } from "node:path";
import type { AuthService } from "./auth/AuthService.js";
import { createAuthRoutes } from "./auth/routes.js";
import type { UserUsageService } from "./auth/UserUsageService.js";
import type { LimitedUsersService } from "./auth/LimitedUsersService.js";
import { limitedUserInstructionsForLaunch } from "./auth/limitedUserInstructions.js";
import { limitedActivityEvent } from "./auth/activityEventAccess.js";
import { SessionAccessResolver } from "./auth/sessionAccess.js";
import type { SubscriptionAccessTarget } from "./routes/ws-relay-handlers.js";
import type { SrpLimitedUserLookup } from "./routes/ws-srp-handlers.js";
import { createLimitedUsersMiddleware } from "./middleware/limited-users.js";
import { createUsersRoutes } from "./routes/users.js";
import { createPdfjsRoutes } from "./routes/pdfjs.js";
import { createProjectTemplateSourceRoutes } from "./routes/project-template-source.js";
import { createProjectTemplateRoutes } from "./routes/project-templates.js";
import { TemplateSourceService } from "./projects/TemplateSourceService.js";
import { TemplateCreationService } from "./projects/TemplateCreationService.js";
import { ProjectAppAutoStart } from "./projects/ProjectAppAutoStart.js";
import { ProjectAppStore } from "./projects/ProjectAppStore.js";
import {
  ProjectServiceManager,
  readProjectService,
  readStaticAddressMode,
  projectServiceStaticApp,
} from "./projects/ProjectServiceManager.js";
import { ProjectAppDelivery } from "./artifacts/ProjectAppDelivery.js";
import { clientVhostSite } from "./artifacts/vhosts.js";
import { HostedProjectServices } from "./projects/HostedProjectServices.js";
import { projectAppPublicAllowed } from "./projects/projectAppPolicy.js";
import { createProjectAccessRoutes } from "./routes/project-access.js";
import { createProjectAppRoutes } from "./routes/project-app.js";
import { SESSION_COOKIE_NAME } from "./auth/routes.js";
import { getCookie as getRequestCookie } from "hono/cookie";
import { levelFor, satisfies } from "./auth/limitedUserPolicy.js";
import type { DesktopBootstrapService } from "./desktop/DesktopBootstrapService.js";
import type { DeviceBridgeService } from "./device/DeviceBridgeService.js";
import type { FrontendProxy } from "./frontend/index.js";
import type {
  SessionDiscoveryIndexRegistry,
  SessionIndexService,
} from "./indexes/index.js";
import { createLruMap, refreshLruMap } from "./lib/lruCollections.js";
import type {
  ProjectMetadataService,
  SessionMetadataService,
} from "./metadata/index.js";
import { ToolResultMediaStore } from "./media/ToolResultMediaStore.js";
import {
  getClaudeSandboxProjectDir,
  getCodexSandboxSessionsDir,
  getSessionSandboxAvailability,
  listSandboxPrivateTempRoots,
} from "./session-sandbox.js";
import { updateAllowedHosts } from "./middleware/allowed-hosts.js";
import { AgentServerTokens } from "./auth/AgentServerTokens.js";
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
  getProjectName,
  grokSessionMediaRoots,
  type ProjectDisplayNameResolver,
} from "./projects/paths.js";
import { ProjectScanner } from "./projects/scanner.js";
import {
  InactivityPushNotifier,
  PushNotifier,
  type PushService,
} from "./push/index.js";
import { createPushRoutes } from "./push/routes.js";
import { ProjectStoragePolicy } from "./projects/projectStoragePolicy.js";
import { settleGitAuthorPaletteRefreshes } from "./git/authorPalette.js";
import type { RecentsService } from "./recents/index.js";
import type {
  RemoteAccessService,
  RemoteSessionService,
} from "./remote-access/index.js";
import { createRemoteAccessRoutes } from "./remote-access/index.js";
import { createAndroidHostSummaryRoutes } from "./routes/android-host-summary.js";
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
import {
  type ClearloopBadgeResolver,
  ClearloopService,
} from "./services/ClearloopService.js";
import { createGitBrowseRoutes } from "./routes/git-browse.js";
import { createGitFileRevisionRoutes } from "./routes/git-file-revision.js";
import { createGitFileProjectionRoutes } from "./routes/git-file-projections.js";
import { createGitInclusiveToHeadRoutes } from "./routes/git-inclusive-to-head.js";
import { createGitIncomingCommitsRoutes } from "./routes/git-incoming-commits.js";
import { createGitProjectionRoutes } from "./routes/git-projections.js";
import { createGitStatusRoutes } from "./routes/git-status.js";
import { createGitWorkingTreeFilesRoutes } from "./routes/git-working-tree-files.js";
import { createFileOwnerRoutes } from "./routes/file-owner.js";
import { createProjectFileCompletionRoutes } from "./routes/project-file-completion.js";
import { createProjectFileViewSearchRoutes } from "./routes/project-file-view-search.js";
import { createToolCommentaryRoutes } from "./routes/tool-commentary.js";
import { ProjectFileCompletion } from "./services/projectFileCompletion.js";
import { createConversationContextRoutes } from "./routes/conversation-context.js";
import { createGlossaryArtifactRoutes } from "./routes/glossary-artifacts.js";
import { createGlobalSessionsRoutes } from "./routes/global-sessions.js";
import {
  getActiveSessionIndexOptions,
  isSessionAutoArchived,
} from "./routes/session-list-options.js";
import { RetainedSessionCollections } from "./services/RetainedSessionCollections.js";
import { collectionCatalogAdapters } from "./sessions/catalog-adapters/collection-catalog-adapters.js";
import {
  providerCatalogFamily,
  type ProviderCatalogFamily,
} from "./sessions/provider-catalog-family.js";
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
import {
  createProcessesRoutes,
  describeCatalogSession,
} from "./routes/processes.js";
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
import { createContextBreakdownRoutes } from "./routes/context-breakdown.js";
import { createSessionViewRoutes } from "./routes/session-view.js";
import { agentSelfEnabled } from "./sdk/providers/agent-self.js";
import { createSessionsRoutes } from "./routes/sessions.js";
import { createSessionWakeRoutes } from "./routes/session-wake.js";
import { createSettingsRoutes } from "./routes/settings.js";
import { streamNewSessionBootstrap } from "./routes/new-session-bootstrap.js";
import { createSharingRoutes } from "./routes/sharing.js";
import { createSupervisorQueueRoutes } from "./routes/supervisor-queue.js";
import { createToolResultMediaRoutes } from "./routes/tool-result-media.js";
import { ClaudeGatewayProvider } from "./sdk/providers/claude-gateway.js";
import { gatewayEffortProbeCache } from "./services/GatewayEffortProbe.js";
import { ClaudeOllamaProvider } from "./sdk/providers/claude-ollama.js";
import { grokACPProvider } from "./sdk/providers/grok-acp.js";

import { createLocalFileRoutes } from "./routes/local-file.js";
import { createFileEditRoutes } from "./routes/file-edit.js";
import { ArtifactRebuildService } from "./services/ArtifactRebuildService.js";
import { createLocalImageRoutes } from "./routes/local-image.js";
import {
  createLocalResourcePathPolicy,
  isPathInsideDirectory,
} from "./routes/local-resource-policy.js";
import { type UploadDeps, createUploadRoutes } from "./routes/upload.js";
import { createSpeechRoutes } from "./routes/speech.js";
import type { SpeechBackendInstallService } from "./services/voice/speechBackendInstall.js";
import { createSecurityClientRoutes } from "./routes/security-clients.js";
import { createNativePushRoutes } from "./routes/native-push.js";
import type { NativePushService } from "./push/NativePushService.js";
import { DiscoverySqliteService } from "./storage/discovery-sqlite.js";
import {
  createVersionRoutes,
  type VersionRouteOptions,
} from "./routes/version.js";
import { createProviderHostRoutes } from "./routes/provider-host.js";
import { createWorkstreamRoutes } from "./routes/workstreams.js";
import { WS_INTERNAL_AUTHENTICATED } from "./middleware/internal-auth.js";
import {
  configureProviderRuntime,
  getProvider,
  isProviderRuntimeHostAvailable,
} from "./sdk/providers/index.js";
import type {
  CodexCyberAccessProgram,
  CodexPlanToolMode,
} from "@yep-anywhere/shared";
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
import type { ConnectedBrowsersService } from "./services/ConnectedBrowsersService.js";
import type { DirtyFileEditorService } from "./services/DirtyFileEditorService.js";
import { HeartbeatCandidateRegistry } from "./services/HeartbeatCandidateRegistry.js";
import type { HostAwakeService } from "./services/host-awake/HostAwakeService.js";
import type { ModelInfoService } from "./services/ModelInfoService.js";
import type { NetworkBindingService } from "./services/NetworkBindingService.js";
import { PdfjsAssetCache } from "./services/PdfjsAssetCache.js";
import { ProjectQueueScheduler } from "./services/ProjectQueueScheduler.js";
import { initializeSessionHeartbeatDefaults } from "./services/sessionHeartbeatDefaults.js";
import type { ProjectQueueService } from "./services/ProjectQueueService.js";
import type { RelayClientService } from "./services/RelayClientService.js";
import type { ServerSettingsService } from "./services/ServerSettingsService.js";
import { RendezWatchService } from "./services/RendezWatchService.js";
import { createRendezSessions } from "./services/rendezSessions.js";
import { onRendezUserTurn } from "./services/rendezActivity.js";
import { getLogger } from "./logging/logger.js";
import { listHostedProviderRuntimes } from "./sdk/providers/provider-runtime-host.js";
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
import { VocabularyStore } from "./services/voice/VocabularyStore.js";
import { VocabularyLearning } from "./services/voice/VocabularyLearning.js";
import { VocabularyKeyterms } from "./services/voice/VocabularyKeyterms.js";
import { vocabularySessions } from "./services/voice/vocabulary-sessions.js";
import { createSpeechVocabularyRoutes } from "./routes/speech-vocabulary.js";
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
  getSessionSourceForProvider,
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
import {
  type BusEvent,
  FocusedSessionWatchManager,
  type EventBus,
} from "./watcher/index.js";
import { LifecycleWebhookService } from "./webhooks/LifecycleWebhookService.js";

export interface AppOptions {
  /** False for self-contained hosts with no external provider sessions. */
  externalSessionsEnabled?: boolean;
  /** Owned update-service lookup for embedded applications and test fixtures. */
  getLatestVersion?: VersionRouteOptions["getLatestVersion"];
  artifacts?: ArtifactConfig;
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
  /** Limited-user records; absent disables the second principal class. */
  limitedUsersService?: LimitedUsersService;
  userUsageService?: UserUsageService;
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
  nativePushService?: NativePushService;
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
  getCatalogFamilies?: () => readonly ProviderCatalogFamily[];
  /** Data directory for persistent state (for onboarding state) */
  dataDir?: string;
  /**
   * The server's required SQLite database. When omitted, the app opens its own
   * below `dataDir` and closes it on dispose; a passed service stays owned by
   * the caller, which shares it with session metadata.
   */
  discoverySqlite?: DiscoverySqliteService;
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
  /** Browser settings the superuser publishes to limited users' clients */
  limitedUserBrowserDefaultsService?: BrowserSettingsBackupService;
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
  /** Thread-scope Codex plan-tool override; provider default when omitted. */
  codexPlanToolMode?: CodexPlanToolMode;
  /** Cyber access program requested per Codex turn; omitted when unset. */
  codexCyberAccessProgram?: CodexCyberAccessProgram;
  /** Whether voice input is enabled. Default: true */
  voiceInputEnabled?: boolean;
  /** Validated server-routed speech backends for capability advertisement. */
  speechBackendRegistry?: SpeechBackendRegistry;
  /** Env-listed STT backends, used to union with persisted Speech settings. */
  envVoiceBackends?: string[];
  /** Installs pixi runtimes and Hugging Face weights for local STT backends. */
  speechBackendInstallService?: SpeechBackendInstallService;
  /** xAI STT key used for ya-grok and to mint direct-browser client secrets. */
  xaiSttApiKey?: string;
  /** Whether authenticated clients may borrow the long-lived xAI STT key. */
  shareXaiSttApiKeyWithClients?: boolean;
  /** Allowed directory prefixes for serving local images. Default: ["/tmp"] */
  allowedImagePaths?: string[];
}

export interface AppResult {
  safeRestartService?: SafeRestartService;
  focusedSessionWatchManager: FocusedSessionWatchManager;
  conversationSubscriptions: ConversationSubscriptions;
  artifactServer: ArtifactServer;
  app: Hono<{ Bindings: HttpBindings }>;
  /** Supervisor instance for debug API access */
  supervisor: Supervisor;
  /** Project scanner for debug API access */
  scanner: ProjectScanner;
  /** Session reader factory for debug API access */
  readerFactory: (project: Project) => ISessionReader;
  /** Close cached session readers and their owned parser workers. */
  disposeSessionReaders: () => Promise<void>;
  /** Stop push generation and supervisor automation before provider shutdown. */
  stopNotifications: () => void;
  /** Shared resolver used by the artifact route and glossary subscriptions. */
  glossaryIndexService: GlossaryIndexService;
  /** Global external-session observer and its bounded background diagnostics. */
  externalTracker?: ExternalSessionTracker;
  /** Authenticated exact probes for bare absolute-path viewer links. */
  resolveAbsoluteFilePaths: (
    paths: readonly string[],
  ) => Promise<ReadonlySet<string>>;
  /** Limited-user SRP verifier lookup for the relay handshake. */
  limitedUsers?: SrpLimitedUserLookup;
  /**
   * Whether an authenticated websocket identity may open a subscription.
   * See topics/limited-users.md § Delivery v1 — Authorization.
   */
  authorizeSubscription: (params: {
    username: string | null;
    target: SubscriptionAccessTarget;
  }) => Promise<boolean>;
  /** One activity event as an authenticated identity may receive it. */
  activityEventForIdentity: (
    username: string | null,
    event: BusEvent,
  ) => BusEvent | null;
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
  let artifactServer: ArtifactServer;
  let supervisor!: Supervisor;
  const isLocalAuthEnforced = (): boolean =>
    options.authDisabled !== true &&
    options.authService !== undefined &&
    !options.authService.isLocalhostOpen() &&
    (options.authService.isEnabled() ||
      Boolean(options.desktopAuthToken || options.desktopBootstrapService));
  const getConfiguredSubagentMaxDepth = () => {
    const configured =
      options.serverSettingsService?.getSetting("subagentMaxDepth");
    return configured === undefined ? DEFAULT_SUBAGENT_MAX_DEPTH : configured;
  };
  configureProviderRuntime({
    codexCliPath: options.codexCliPath,
    getClaudeAdditionalModels: () =>
      options.serverSettingsService?.getSetting("claudeAdditionalModels"),
    getClaudeModelEffortLevels: () =>
      options.serverSettingsService?.getSetting("newSessionDefaults")?.providers
        ?.claude?.modelEffortLevels,
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
      codexPlanToolMode:
        options.serverSettingsService?.getSetting("codexPlanToolMode") ??
        options.codexPlanToolMode,
      codexCyberAccessProgram:
        options.serverSettingsService?.getSetting("codexCyberAccessProgram") ??
        options.codexCyberAccessProgram,
      codexReasoningSummary: options.serverSettingsService?.getSetting(
        "codexReasoningSummary",
      ),
      mcpAppViews: options.serverSettingsService?.getSetting("mcpAppViews"),
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
      gatewayServices:
        options.serverSettingsService?.getSetting("gatewayServices"),
      defaultGatewayServiceId: options.serverSettingsService?.getSetting(
        "defaultGatewayServiceId",
      ),
      gatewayServiceEffortDetection: options.serverSettingsService?.getSetting(
        "gatewayServiceEffortDetection",
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
  app.use("*", async (c, next) => {
    const host = c.req.header("Host") ?? new URL(c.req.url).host;
    const dispatched = artifactServer
      ? await artifactServer.dispatchHost(
          c.req.raw,
          c.env?.incoming?.socket?.remoteAddress,
        )
      : null;
    if (dispatched) return dispatched;
    if (
      isArtifactHost(host) ||
      isVhostHost(host) ||
      isArtifactOrigin(c.req.header("Origin")) ||
      isVhostOrigin(c.req.header("Origin"))
    )
      return c.json({ error: "Artifact documents cannot access YA" }, 403);
    await next();
  });
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
  const projectAppStore = new ProjectAppStore(effectiveDataDir);
  const legacyRetirement = options.serverSettingsService
    ? retireLegacyComputerControl(
        options.serverSettingsService,
        effectiveDataDir,
      )
        .then((result) => {
          if (result.state === "pending")
            console.warn(
              "[Machine Control] Old YA component cleanup needs attention; it remains disabled. Restart YA to retry. Independent MC desktop access is unchanged.",
            );
        })
        .catch(() => {
          console.warn(
            "[Machine Control] Could not persist old component retirement; legacy launches remain unavailable. Restart YA to retry.",
          );
        })
    : Promise.resolve();
  const ownsDiscoverySqlite = !options.discoverySqlite;
  const discoverySqlite =
    options.discoverySqlite ??
    new DiscoverySqliteService({ dataDir: effectiveDataDir });
  let draftStore: DraftStore | undefined;
  try {
    draftStore = new DraftStore(discoverySqlite.getDatabase());
  } catch (error) {
    console.warn("[DraftSync] Storage unavailable:", error);
  }
  const draftCleanup = draftStore
    ? setInterval(() => {
        try {
          draftStore?.cleanup();
        } catch (error) {
          console.warn("[DraftSync] Cleanup failed:", error);
        }
      }, 60_000)
    : undefined;
  draftCleanup?.unref();
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
  if (draftStore)
    attachmentStagingService.setDraftProtection(
      (username, id) => draftStore?.protects(username ?? "", id) ?? false,
    );
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

  // Operator API tokens for unsandboxed superuser agent sessions
  // (topics/agent-session-access.md § Operator API token). Turning the
  // setting off revokes every token, so turning it on again revives none.
  const agentServerTokens = new AgentServerTokens(
    () =>
      options.serverSettingsService?.getSetting("agentServerAccessEnabled") ===
      true,
  );
  options.serverSettingsService?.onSettingsChanged((settings, previous) => {
    if (
      previous.agentServerAccessEnabled &&
      !settings.agentServerAccessEnabled
    ) {
      agentServerTokens.revokeAll();
    }
  });

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
        agentServerTokens,
      }),
    );
  }

  /*
   * Limited users (topics/limited-users.md § Delivery v1). The middleware
   * resolves the acting principal for every request and, when that is a
   * limited user, refuses anything outside their grants — by default, so a
   * route added later is unreachable for them until it is listed.
   */
  const limitedUsersService = options.limitedUsersService;
  const isLimitedUsersEnabled = (): boolean =>
    limitedUsersService !== undefined &&
    options.serverSettingsService?.getSetting("limitedUsersEnabled") === true;
  // The projects a directory grant can cover, for surfaces that list a user's
  // projects. Bound once the scanner exists; per-project checks decode the
  // project's path from its id and need no list.
  let knownProjectsForGrants: () => Iterable<{ id: string; path: string }> =
    () => [];
  // Turning the feature off keeps the records but lets no limited login act.
  const getActiveLimitedGrants = (username: string) => {
    if (!isLimitedUsersEnabled()) return null;
    const grants = limitedUsersService?.getActiveGrants(username) ?? null;
    return grants && withPathGrantProjects(grants, knownProjectsForGrants());
  };
  const sessionAccessResolver = new SessionAccessResolver({
    getLiveSession: (sessionId) => {
      const process = supervisor?.getProcessForSession(sessionId);
      if (!process) return undefined;
      return {
        projectId: process.projectId,
        provider: process.provider,
        lastActivityMs: process.lastProviderMessageTime?.getTime() ?? null,
        sandboxed:
          process.sandboxEnforcement?.effective === "project-write" &&
          process.sandboxEnforcement.networkFirewall !== false,
      };
    },
    // The one retained catalog All Sessions and Inbox read, built below.
    getCatalogVersion: () => retainedCollections?.getVersion(),
    readCatalogRows: async () => {
      if (!retainedCollections) {
        throw new Error("Session catalog read before the app was built");
      }
      const { rows } = await retainedCollections.read();
      return rows.map((row) => ({
        sessionId: row.sessionId,
        projectId: row.projectId,
        provider: row.provider ?? row.catalogFamily,
        updatedAt: row.updatedAt,
      }));
    },
    getSessionMetadata: (sessionId) =>
      options.sessionMetadataService?.getMetadata(sessionId),
  });
  if (limitedUsersService && options.authService) {
    const authService = options.authService;
    app.use(
      "/api/*",
      createLimitedUsersMiddleware({
        getActiveGrants: getActiveLimitedGrants,
        getHiddenProjectIds: (username) =>
          projectAppStore.hiddenProjectIds(username),
        sessionAccess: sessionAccessResolver,
        getSuperuserIdentity: () =>
          options.remoteAccessService?.getUsername() ?? null,
        getCookieSessionUsername: async (c) =>
          authService.getSessionUsername(
            getRequestCookie(c, SESSION_COOKIE_NAME),
          ),
        getCookieSecret: () => authService.getCookieSecret(),
      }),
    );
    app.route(
      "/api/users",
      createUsersRoutes({
        forgetDrafts: (username) => draftStore?.deleteOwner(username),
        limitedUsers: limitedUsersService,
        authService,
        isEnabled: isLimitedUsersEnabled,
        setEnabled: async (enabled) => {
          await options.serverSettingsService?.updateSettings({
            limitedUsersEnabled: enabled,
          });
        },
        ...(options.userUsageService
          ? { userUsage: options.userUsageService }
          : {}),
        revokeUserLogins: async (username) => {
          await authService.invalidateUserSessions(username);
          // Relay sessions are keyed by SRP identity, and a limited name equal
          // to the superuser's relay identity logs in as the superuser.
          if (username === options.remoteAccessService?.getUsername()) return;
          await options.remoteSessionService?.invalidateUserSessions(username);
        },
        revokeRelaySession: async (sessionId) => {
          await options.remoteSessionService?.deleteSession(sessionId);
        },
      }),
    );
  }

  // Mount /api routers only after the security and auth middleware above:
  // Hono runs only the middleware registered before a route, so an earlier
  // mount answers without them (test/auth/api-auth-boundary.test.ts).
  if (supportsInstalledMachineControl())
    app.route("/api", createMachineControlRoutes());
  const templateSources = new TemplateSourceService(effectiveDataDir);
  const templateCreations = new TemplateCreationService(
    effectiveDataDir,
    templateSources,
  );
  // Restore the creator a queued preparation start failed to record, so the
  // session reaches its user's sidebar group and ownership-based reads.
  if (options.sessionMetadataService) {
    const metadata = options.sessionMetadataService;
    void templateCreations
      .startedSessionOwners()
      .then(async (owners) => {
        for (const { sessionId, ownerUsername } of owners) {
          if (metadata.getMetadata(sessionId)?.createdByUser) continue;
          await metadata.recordSessionCreator(sessionId, ownerUsername);
        }
      })
      .catch((error: unknown) => {
        console.error(
          "[TemplateCreation] Failed to restore preparation session creators:",
          error,
        );
      });
  }
  app.route(
    "/api",
    createProjectTemplateSourceRoutes(effectiveDataDir, templateSources),
  );
  app.route(
    "/api",
    createProjectTemplateRoutes(
      templateSources,
      templateCreations,
      async (context, path, body, method = "POST") => {
        const headers = new Headers(context.req.raw.headers);
        headers.set("Content-Type", "application/json");
        headers.delete("Content-Length");
        // In-process responses are consumed directly, without fetch's decompression.
        headers.delete("Accept-Encoding");
        return app.request(
          new Request(new URL(path, context.req.url), {
            method,
            headers,
            // The dispatcher accepts only POST | PUT, defaulting to POST;
            // Oxlint's no-invalid-fetch-options incorrectly assumes GET here.
            body: JSON.stringify(body),
          }),
          undefined,
          context.env,
        );
      },
      getActiveLimitedGrants,
    ),
  );
  app.route("/api", createPdfjsRoutes(new PdfjsAssetCache(effectiveDataDir)));
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
        limitedUsers: limitedUsersService,
        isLimitedUsersEnabled,
        getOwnerRelayUsername: () =>
          options.remoteAccessService?.getUsername() ?? null,
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
    if (options.nativePushService)
      app.route(
        "/",
        createNativePushRoutes(
          options.securityClientService,
          options.nativePushService,
        ),
      );
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
  // Sandboxed Claude sessions write their transcripts under the project's
  // private provider root (topics/session-sandboxing.md); every reader and
  // list of a project must include those directories.
  const claudeSandboxSessionDirs = (): Map<string, string[]> => {
    const byProject = new Map<string, string[]>();
    for (const metadata of Object.values(
      options.sessionMetadataService?.getAllMetadata() ?? {},
    )) {
      if (
        !metadata.provider ||
        !isClaudeProviderName(metadata.provider) ||
        metadata.sandboxLevel !== "project-write" ||
        !metadata.sandboxStateKey ||
        !metadata.workingProjectId
      ) {
        continue;
      }
      let projectPath = metadata.sandboxProjectPath;
      if (!projectPath) {
        try {
          projectPath = decodeProjectId(metadata.workingProjectId);
        } catch {
          continue;
        }
      }
      const dir = getClaudeSandboxProjectDir({
        dataDir: effectiveDataDir,
        stateKey: metadata.sandboxStateKey,
        projectPath,
      });
      const dirs = byProject.get(metadata.workingProjectId) ?? [];
      if (!dirs.includes(dir)) dirs.push(dir);
      byProject.set(metadata.workingProjectId, dirs);
    }
    return byProject;
  };
  const scanner = new ProjectScanner({
    getSandboxSessionDirs: claudeSandboxSessionDirs,
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
  // Restore retained rows and start bounded discovery while the server starts,
  // so the first route bootstrap consumes prepared state instead of owning it.
  // The scanner retains refresh failures and drains this work during disposal.
  void scanner.refreshRetainedProjects();
  knownProjectsForGrants = () => {
    const known = new Map<string, string>();
    for (const project of scanner.cachedProjects())
      known.set(project.id, project.path);
    // Added projects are known before any scan, including one a limited
    // user created a moment ago.
    for (const [id, metadata] of Object.entries(
      options.projectMetadataService?.getAllProjects() ?? {},
    ))
      known.set(id, metadata.path);
    return [...known].map(([id, path]) => ({ id, path }));
  };
  const glossaryIndexService = new GlossaryIndexService();
  const localResourcePathPolicy = createLocalResourcePathPolicy({
    allowedPaths: getAllowedFilePaths,
    scanner,
    includeProjects: shouldIncludeProjects,
  });
  const artifactConfig = options.artifacts ??
    options.serverSettingsService?.getSetting("artifactViewer") ?? {
      port: 4402,
    };
  const sandboxStateRoot = join(effectiveDataDir, "session-sandboxes");
  artifactServer = new ArtifactServer(
    validateArtifactConfig(artifactConfig),
    // Artifact reads also admit sandboxes' private /tmp scratch, where a
    // sandboxed session writes what it wants to show; the session-scoped
    // grant route confines a limited user to their own session's.
    createLocalResourcePathPolicy({
      allowedPaths: () => [
        ...getAllowedFilePaths(),
        ...listSandboxPrivateTempRoots(sandboxStateRoot),
      ],
      scanner,
      includeProjects: shouldIncludeProjects,
    }),
    {
      stateDir: join(effectiveDataDir, "artifacts"),
      // An owning grant may never delete YA's own state or the checkout it
      // runs from, however the request was phrased.
      protectedPaths: [effectiveDataDir, process.cwd()],
    },
  );
  // Paths as a session names them: a sandboxed session's /tmp is its own.
  // Shared by the session-scoped file reads below and the artifact grant.
  const sessionPathScope = createSessionPathScopeResolver({
    sessionMetadataService: options.sessionMetadataService,
    sandboxStateRoot,
    allowedPaths: getAllowedFilePaths,
    includeProjects: shouldIncludeProjects,
  });
  const artifactPreviews = createArtifactPreviewRoutes({
    policy: localResourcePathPolicy,
    scope: sessionPathScope,
    scanner,
  });
  app.route("/api", artifactPreviews.routes);
  const projectServices = isProviderRuntimeHostAvailable()
    ? new HostedProjectServices(effectiveDataDir)
    : new ProjectServiceManager(effectiveDataDir);
  const projectAppAutoStart = new ProjectAppAutoStart(effectiveDataDir, {
    services: projectServices,
    projectPath: async (projectId) =>
      (await scanner.getProject(projectId))?.path ?? null,
    // The enabling principal must still hold what enabling it required.
    mayAutoStart: async (by, projectId) => {
      if (by === "superuser") return true;
      const grants = getActiveLimitedGrants(by);
      return (
        grants?.allowPublicApps === true &&
        satisfies(levelFor(grants, projectId), "new-session")
      );
    },
  });
  const projectAppDelivery = new ProjectAppDelivery(
    artifactServer,
    projectServices,
    projectAppStore,
    async (projectId) => {
      const project = await scanner.getProject(projectId);
      if (!project) return null;
      const declaration = await readProjectService(project.path);
      if (declaration?.where.kind !== "static") return null;
      return {
        ...(await projectServiceStaticApp(project.path, declaration)),
        address: await readStaticAddressMode(project.path),
      };
    },
    async (reservation) => {
      const project = await scanner.getProject(reservation.projectId);
      return (
        !!project &&
        projectAppPublicAllowed(
          project.ownerUsername,
          reservation,
          getActiveLimitedGrants,
        )
      );
    },
    projectAppAutoStart,
  );
  artifactServer.setProjectAppDelivery(projectAppDelivery);
  app.route(
    "/api",
    createProjectAppRoutes({
      scanner,
      store: projectAppStore,
      services: projectServices,
      artifacts: artifactServer,
      sessionAccess: sessionAccessResolver,
      sessionPathScope,
      activeGrants: getActiveLimitedGrants,
      delivery: projectAppDelivery,
      autoStart: projectAppAutoStart,
      onVisibilityChanged: (projectId) =>
        options.eventBus?.emit({
          type: "projects-changed",
          projectIds: [projectId],
          timestamp: new Date().toISOString(),
        }),
      openService: (projectId, audience) =>
        projectAppDelivery.open(projectId, audience),
    }),
  );
  if (limitedUsersService && options.projectMetadataService) {
    app.route(
      "/api",
      createProjectAccessRoutes({
        scanner,
        limitedUsers: limitedUsersService,
        metadata: options.projectMetadataService,
      }),
    );
  }
  // Settings saves and file vhost claims change one configuration in turn.
  artifactServer.setFileSiteAdmission((site) => {
    if (!site.ownerUsername) return true;
    const grants = getActiveLimitedGrants(site.ownerUsername);
    return (
      !!grants &&
      grants.allowPublicApps === true &&
      !!site.projectId &&
      grants.newSessionProjects.includes(site.projectId) &&
      (site.public === true || grants.allowPrivateAppLinks !== false)
    );
  });
  const artifactConfigWriter = createArtifactConfigWriter({
    server: artifactServer,
    settings: options.serverSettingsService,
    locked: options.artifacts !== undefined,
  });
  app.route(
    "/api",
    createVhostSiteRoutes({
      server: artifactServer,
      scanner,
      writer: artifactConfigWriter,
      activeGrants: getActiveLimitedGrants,
    }),
  );
  app.route(
    "/api",
    createArtifactRoutes({
      server: artifactServer,
      scanner,
      settings: options.serverSettingsService,
      locked: options.artifacts !== undefined,
      writer: artifactConfigWriter,
      onArtifactCreated: async (path, projectId) => {
        const candidates = projectId
          ? [await scanner.getProject(projectId)]
          : await scanner.listProjects();
        const project = candidates
          .filter((candidate) => candidate !== null)
          .filter((candidate) => isPathInsideDirectory(path, candidate.path))
          .sort((left, right) => right.path.length - left.path.length)[0];
        if (project) await projectAppStore.associate(project.id, path);
      },
    }),
  );
  app.route(
    "/api",
    createSessionLocalFileRoutes({
      allowedPaths: getAllowedFilePaths,
      includeProjects: shouldIncludeProjects,
      scanner,
      scope: sessionPathScope,
      artifactServer,
      onArtifactCreated: async (sessionId, path) => {
        const session = await sessionAccessResolver.resolve(sessionId);
        if (session && (await scanner.getProject(session.projectId)))
          await projectAppStore.associate(session.projectId, path, sessionId);
      },
    }),
  );
  app.route(
    "/api",
    createFileEditRoutes({
      policy: localResourcePathPolicy,
      scanner,
      resolveArtifactUrl: (url) => artifactServer.resolveSourceUrl(url),
      isWritePending: async (path) =>
        (await options.dirtyFileEditorService?.isWritePending(path)) ?? false,
      rebuild: new ArtifactRebuildService(
        join(effectiveDataDir, "artifact-rebuild"),
      ),
    }),
  );
  const vhostAppControl = new VhostAppControl(
    () => artifactServer.config.vhosts ?? [],
  );
  app.route("/api", createVhostAppRoutes(vhostAppControl));
  app.route("/api", createVhostAccessRoutes(artifactServer));
  app.route("/api", createVhostOauthRoutes(artifactServer));
  // Sandboxed sessions' loopback servers, through their port brokers. The
  // supervisor is assigned later; both callbacks run only at request time.
  artifactServer.setSessionAppUpstream((sessionId) =>
    sessionAppBrokerSocket(supervisor.getProcessForSession(sessionId)),
  );
  app.route(
    "/api",
    createSessionAppRoutes({
      getArtifactServer: () => artifactServer,
      getProcessForSession: (sessionId) =>
        supervisor.getProcessForSession(sessionId),
    }),
  );
  app.route(
    "/api",
    createMcpAppRoutes({
      getProcessForSession: (sessionId) =>
        supervisor.getProcessForSession(sessionId),
      isEnabled: () =>
        options.serverSettingsService?.getSetting("mcpAppViews") === true,
    }),
  );
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
  /** Least recently used first; bounded by `maxReaderCacheSize`. */
  const readerCache = createLruMap<string, ISessionReader>();
  const projectFileCompletion = new ProjectFileCompletion(effectiveDataDir, {
    eventBus: options.eventBus,
  });
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
  const focusedSessionWatchManager = new FocusedSessionWatchManager({
    scanner,
    codexScanner,
    geminiScanner,
  });
  let conversationSubscriptions: ConversationSubscriptions | undefined;
  let retainedCollections: RetainedSessionCollections | undefined;
  let issueIndexer: IssueIndexer | undefined;
  let issueConfirmer: IssueConfirmer | undefined;
  let issueStatuses: IssueStatusRefresher | undefined;
  const issueDisposers: Array<() => void> = [];
  let vocabularyLearning: VocabularyLearning | undefined;
  let vocabularyKeyterms: VocabularyKeyterms | undefined;
  let unsubscribeVocabulary: (() => void) | undefined;
  let sessionReadersDisposal: Promise<void> | undefined;
  const rendezWatch = options.serverSettingsService
    ? new RendezWatchService(
        options.serverSettingsService,
        async () => {
          const paths = new Set(
            supervisor
              .getAllProcesses()
              .filter(
                (process) =>
                  process.execution.kind === "local" &&
                  process.isProcessAlive === true,
              )
              .map((process) => process.projectPath),
          );
          try {
            for (const runtime of await listHostedProviderRuntimes()) {
              if (runtime.state !== "closing") paths.add(runtime.projectPath);
            }
          } catch (error) {
            getLogger().warn(
              { error: String(error) },
              "Rendez provider inventory unavailable; using local live sessions",
            );
          }
          return [...paths].map((path) => ({ path }));
        },
        createRendezSessions(() => supervisor.getAllProcesses()),
        onRendezUserTurn,
      )
    : undefined;
  const disposeSessionReaders = (): Promise<void> => {
    // Explicit shutdown and fixture ownership may join the same disposal.
    // Cache the promise before asynchronous cleanup can close shared services.
    sessionReadersDisposal ??= (async () => {
      await supervisor.stopBackgroundTasks();
      await rendezWatch?.close();
      await projectServices.close();
      await projectAppStore.close();
      await projectAppAutoStart.close();
      await templateCreations.close();
      await legacyRetirement;
      conversationSubscriptions?.close();
      focusedSessionWatchManager.dispose();
      for (const dispose of issueDisposers) dispose();
      await issueIndexer?.close();
      await issueConfirmer?.close();
      await issueStatuses?.close();
      unsubscribeVocabulary?.();
      options.speechBackendRegistry?.setVocabularySource(undefined);
      await vocabularyKeyterms?.close();
      await vocabularyLearning?.close();
      if (draftCleanup) clearInterval(draftCleanup);
      draftStore?.close();
      if (ownsDiscoverySqlite) discoverySqlite.close();
      await retainedCollections?.dispose();
      await projectQueueScheduler?.dispose();
      artifactPreviews.close();
      await artifactServer.close();
      await projectFileCompletion.dispose();
      await bangCommandService?.dispose();
      await scanner.dispose();
      await settleGitAuthorPaletteRefreshes();
      const entries = Array.from(readerCache.entries());
      readerCache.clear();
      await Promise.all(
        entries.map(([key, reader]) => closeReader(key, reader)),
      );
    })();
    return sessionReadersDisposal;
  };

  const getOrCreateReader = <T extends ISessionReader>(
    key: string,
    factory: () => T,
  ): T => {
    const cached = readerCache.get(key);
    if (cached) {
      refreshLruMap(readerCache, key, cached);
      return cached as T;
    }

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
        // A project from the scanner already lists these among its merged
        // directories; one built elsewhere from an id may not.
        const sandboxSessionDirs = (
          claudeSandboxSessionDirs().get(project.id) ?? []
        ).filter((dir) => !project.mergedSessionDirs?.includes(dir));
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

  let pushNotifier: PushNotifier | undefined;
  let inactivityPushNotifier: InactivityPushNotifier | undefined;
  const stopNotifications = () => {
    pushNotifier?.dispose();
    inactivityPushNotifier?.dispose();
    // Fence automation before provider shutdown; reader disposal joins work
    // already admitted before closing its metadata/catalog dependencies.
    void supervisor.stopBackgroundTasks();
  };

  const clearloopService = options.sessionMetadataService
    ? new ClearloopService({
        getSupervisor: () => supervisor,
        sessionMetadataService: options.sessionMetadataService,
        eventBus: options.eventBus,
        getInactivitySeconds: () =>
          clampClearloopInactivitySeconds(
            options.serverSettingsService?.getSetting(
              "clearloopInactivitySeconds",
            ),
          ) ?? DEFAULT_CLEARLOOP_INACTIVITY_SECONDS,
        // The scheduler is constructed below; a loop reads this only once a
        // user has started one, long after startup.
        getProjectIdleStatus:
          options.eventBus && options.projectQueueService
            ? (projectId) =>
                projectQueueScheduler?.getProjectWorkStatusYieldingToQueue(
                  projectId,
                ) ??
                Promise.resolve({
                  idle: false,
                  blockers: ["project-scheduler-unavailable"],
                })
            : undefined,
      })
    : undefined;
  // Session metadata is initialized before createApp; loops left running by
  // a previous server process are closed out here.
  void clearloopService?.reconcileAfterRestart();
  const getClearloopBadge: ClearloopBadgeResolver | undefined = clearloopService
    ? (sessionId) => clearloopService.getBadge(sessionId)
    : undefined;

  // Every server surface names a project the same way: its chosen name, else
  // its path's (topics/project-names.md).
  const projectMetadataForNames = options.projectMetadataService;
  const projectDisplayName: ProjectDisplayNameResolver = projectMetadataForNames
    ? (projectPath) =>
        projectMetadataForNames.getProjectDisplayName(projectPath)
    : getProjectName;

  const agentAuthRouter = new AgentAuthRouter(
    effectiveDataDir,
    options.sessionMetadataService,
  );
  app.route("/api", createAgentAuthRouterRoutes(agentAuthRouter));

  supervisor = new Supervisor({
    agentAuthRouter,
    projectDisplayName,
    getLimitedUserInstructions: (username) =>
      limitedUserInstructionsForLaunch(
        username,
        limitedUsersService,
        options.serverSettingsService,
      ),
    onProcessInventoryChanged: () => {
      // Gateway services that opted into auto-stop need to know when their
      // last session goes away; the live process list is that answer.
      noteGatewayServiceUsage(gatewayServiceUsage(supervisor));
    },
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
    ...(options.userUsageService
      ? {
          recordTokenUsage: (record) => {
            void options.userUsageService?.recordTokens(record);
          },
        }
      : {}),
    maxWorkers: options.maxWorkers,
    idlePreemptThresholdMs: options.idlePreemptThresholdMs,
    maxQueueSize: options.maxQueueSize,
    sessionQueuePersistenceService: options.sessionQueuePersistenceService,
    toolResultMediaStore,
    dirtyFileEditorService: options.dirtyFileEditorService,
    sandboxStateRoot: join(effectiveDataDir, "session-sandboxes"),
    // Save executor for remote sessions to support resume
    onSessionExecutor: options.sessionMetadataService
      ? (sessionId, executor) =>
          options.sessionMetadataService?.setExecutor(sessionId, executor) ??
          Promise.resolve()
      : undefined,
    onSuccessfulProviderSession: options.onSuccessfulProviderSession,
    mintAgentServerAccess: () => agentServerTokens.mint(),
    getSessionChildEnv: (sessionId, executor) => {
      const wakeBaseUrl = options.getSessionWakeBaseUrl?.(executor);
      const browserDebugConnection =
        options.getBrowserDebugConnection?.(executor);
      const serverUrl = browserDebugConnection?.baseUrl ?? wakeBaseUrl;
      return {
        ...(serverUrl ? { AGENT_SERVER_URL: serverUrl } : {}),
        ...artifactViewerAgentEnvironment(artifactServer, serverUrl, executor),
        ...(browserDebugConnection
          ? browserDebugService.getAgentEnvironment(
              browserDebugConnection.baseUrl,
              browserDebugConnection.caCertificate,
            )
          : {}),
        ...(wakeBaseUrl
          ? sessionWakeService?.environmentForSession(sessionId, wakeBaseUrl)
          : {}),
      };
    },
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
    getPostCompactReplaySettings: () =>
      options.serverSettingsService?.getSetting("postCompactReplay"),
    getInstructionRestorationSettings: () =>
      options.serverSettingsService?.getSetting("instructionRestoration"),
    readInstructionHistory: async (sessionId, projectId, provider) => {
      const project = await scanner.getProject(projectId);
      if (!project)
        throw new Error("Instruction history project is unavailable");
      const reader = readerFactory({ ...project, provider });
      const loaded = await reader.getSession(sessionId, projectId);
      if (!loaded)
        throw new Error(
          "Instruction history is unavailable for resumed session",
        );
      return normalizeSession(loaded).messages.map((message) => ({
        type: message.type,
        uuid: message.uuid,
        subtype:
          typeof message.subtype === "string" ? message.subtype : undefined,
        content: message.message?.content ?? message.content,
        parent_tool_use_id:
          typeof message.parent_tool_use_id === "string"
            ? message.parent_tool_use_id
            : undefined,
      }));
    },
    getCacheMissBillingSettings: () =>
      options.serverSettingsService?.getSetting("cacheMissBilling"),
    getClaudeSteerBackgroundBashSettings: () =>
      options.serverSettingsService?.getSetting("claudeSteerBackgroundBash"),
  });
  options.serverSettingsService?.onSettingsChanged((settings, previous) => {
    if (settings.instructionRestoration !== previous.instructionRestoration)
      void supervisor.refreshInstructionRestoration();
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
  const externalTracker =
    options.eventBus && options.externalSessionsEnabled !== false
      ? new ExternalSessionTracker({
          eventBus: options.eventBus,
          supervisor,
          scanner,
          projectDisplayName,
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
      getReadinessCommand: () =>
        options.serverSettingsService?.getSetting(
          "projectQueueReadinessCheck",
        ) ?? null,
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
      getSessionLaunchMetadata: (sessionId) => {
        const metadata = options.sessionMetadataService?.getMetadata(sessionId);
        if (!metadata) return undefined;
        return {
          sandboxLevel: metadata.sandboxLevel,
          sandboxNetworkFirewall: metadata.sandboxNetworkFirewall,
          sandboxStateKey: metadata.sandboxStateKey,
          sandboxProjectPath: metadata.sandboxProjectPath,
          workingProjectId: metadata.workingProjectId,
          createdByUser: metadata.createdByUser,
          provider: options.sessionMetadataService?.getProvider(sessionId),
        };
      },
      getLimitedUserGrants: getActiveLimitedGrants,
      isSessionFreshForLimitedTurn: async (sessionId, grants) => {
        const facts = await sessionAccessResolver.resolve(sessionId);
        return (
          facts !== null &&
          sessionAccessResolver.isFresh(facts, {
            offsetMinutes: grants.joinStaleOffsetMinutes,
          })
        );
      },
      onSessionStarted: async ({ item, process }) => {
        if (item.target.type !== "new-session") return;
        const metadata = options.sessionMetadataService;
        if (!metadata) return;

        if (item.createdByUser) {
          // A limited user's queued session is theirs, like one they start
          // directly (topics/limited-users.md § Delivery v1).
          await metadata.recordSessionCreator(
            process.sessionId,
            item.createdByUser,
          );
        }
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
    pushNotifier = new PushNotifier({
      eventBus: options.eventBus,
      pushService: options.pushService,
      supervisor,
      projectDisplayName,
    });
  }

  if (options.eventBus && options.pushService && options.projectQueueService) {
    inactivityPushNotifier = new InactivityPushNotifier({
      eventBus: options.eventBus,
      pushService: options.pushService,
      supervisor,
      projectQueueService: options.projectQueueService,
      externalTracker,
      projectDisplayName,
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
      getLatestVersion: options.getLatestVersion,
      installedMachineControlAvailable: supportsInstalledMachineControl(),
      agentSessionViewAvailable: agentSelfEnabled(),
      agentAuthRouterAvailable:
        process.platform !== "win32" && Boolean(options.sessionMetadataService),
      getExperimentalConversationAvailable: () =>
        Boolean(conversationSubscriptions),
      getSqliteStatus: () => discoverySqlite.getStatus(),
      getDraftSyncAvailable: () => Boolean(draftStore),
      getIssueAssociationsAvailable: () => Boolean(issueIndexer),
      vhostAppControlAvailable,
      getArtifactViewerStatus: () => ({
        ...artifactServer.config,
        vhostSites: (artifactServer.config.vhostSites ?? []).map(
          clientVhostSite,
        ),
        available: artifactServer.available,
        locked:
          options.artifacts !== undefined || !options.serverSettingsService,
        defaultLocalOrigin: `http://artifacts.localhost:${options.serverPort ?? 3400}`,
      }),
      browserSettingsBackupAvailable: !!options.browserSettingsBackupService,
      securityClientAuditAvailable: !!options.securityClientService,
      nativePush: options.nativePushService?.version(),
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
      getSessionSandboxAvailability: async (availabilityOptions) => ({
        ...(await getSessionSandboxAvailability({
          ...availabilityOptions,
          stateRoot: join(effectiveDataDir, "session-sandboxes"),
        })),
        localAuthEnforced: isLocalAuthEnforced(),
      }),
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
      projectAppStore,
      readerFactory,
      supervisor,
      externalTracker,
      notificationService: options.notificationService,
      sessionMetadataService: options.sessionMetadataService,
      projectMetadataService: options.projectMetadataService,
      limitedUsersService,
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
        userUsageService: options.userUsageService,
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
      onIssueWindow: (source, messages) =>
        issueIndexer?.observe(source, messages),
      supervisor,
      scanner,
      readerFactory,
      externalTracker,
      notificationService: options.notificationService,
      sessionIndexService: options.sessionIndexService,
      sessionMetadataService: options.sessionMetadataService,
      userUsageService: options.userUsageService,
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
      clearloopService,
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
  app.route("/api/sessions", createContextBreakdownRoutes({ supervisor }));
  if (agentSelfEnabled())
    app.route(
      "/api/sessions",
      createSessionViewRoutes({ sessionViews: supervisor.sessionViews }),
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
      getClearloopBadge,
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
        enabled: options.externalSessionsEnabled !== false,
        describeSession: (sessionId, projectPath) =>
          describeCatalogSession(
            {
              scanner,
              readerFactory,
              sessionIndexService: options.sessionIndexService,
              sessionMetadataService: options.sessionMetadataService,
            },
            toUrlProjectId(projectPath),
            sessionId,
          ),
      }),
    );
  }

  // Inbox routes (cross-project session aggregation)
  retainedCollections = new RetainedSessionCollections({
    dataDir: effectiveDataDir,
    eventBus: options.eventBus,
    shouldReadQuestions: (row) =>
      !(
        options.sessionMetadataService?.getMetadata(row.sessionId)
          ?.isArchived ??
        isSessionAutoArchived(
          row,
          getActiveSessionIndexOptions(options.sessionAutoArchiveDays)
            ?.activeAfterMs,
        )
      ),
    adapters: (rows, signal, changedPaths) =>
      collectionCatalogAdapters(
        {
          scanner,
          readerFactory,
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
          sessionIndexService: options.sessionIndexService,
          getCatalogFamilies:
            options.getCatalogFamilies ??
            (() =>
              (
                options.sessionMetadataService?.getRecordedProviders() ?? []
              ).map(providerCatalogFamily)),
        },
        rows,
        signal,
        changedPaths,
      ),
  });
  const conversationCatalog = retainedCollections;
  conversationSubscriptions = new ConversationSubscriptions(
    createConversationSource({
      resolve: async (sessionId) => {
        const { rows } = await conversationCatalog.read();
        const candidates = rows.filter((row) => row.sessionId === sessionId);
        return candidates.length === 1 ? candidates[0] : undefined;
      },
      getProcess: (sessionId) => supervisor.getProcessForSession(sessionId),
      watch: (row, invalidate) =>
        focusedSessionWatchManager.subscribe(
          {
            sessionId: row.sessionId,
            projectId: row.projectId,
            providerHint: row.provider ?? row.catalogFamily,
          },
          invalidate,
        ),
      eventBus: options.eventBus,
    }),
  );
  app.route(
    "/api/experimental/conversation",
    createExperimentalConversationRoutes(conversationSubscriptions),
  );
  if (draftStore)
    app.route(
      "/api/drafts",
      createDraftRoutes({
        store: draftStore,
        staging: attachmentStagingService,
        scanner,
        sessions: sessionAccessResolver,
      }),
    );
  const issueDatabase = discoverySqlite.getDatabase();
  if (options.serverSettingsService) {
    const catalog = retainedCollections;
    const settings = options.serverSettingsService;
    const readerFor = async (
      projectId: string,
      provider?: import("@yep-anywhere/shared").ProviderName,
    ) => {
      const project = await scanner.getProject(projectId);
      if (!project) return null;
      const deps = heartbeatProviderResolutionDeps();
      if (provider)
        return (
          getSessionSourceForProvider(project, deps, provider)?.reader ?? null
        );
      return getSessionSources(project, deps)[0]?.reader ?? null;
    };
    const issueSettings = () =>
      settings.getSetting("issueAssociations") ?? DEFAULT_ISSUE_SETTINGS;
    const issueCredentials = new IssueCredentials({
      dataDir: effectiveDataDir,
      settings: issueSettings,
    });
    const issueStore = new IssueStore(issueDatabase, issueSettings);
    const confirmer = new IssueConfirmer(issueStore, {
      settings: issueSettings,
      credentials: issueCredentials,
    });
    issueConfirmer = confirmer;
    const statuses = new IssueStatusRefresher({
      store: issueStore,
      settings: issueSettings,
      credentials: issueCredentials,
    });
    issueStatuses = statuses;
    const indexer = new IssueIndexer(issueStore, {
      settings: issueSettings,
      confirm: () => confirmer.schedule(),
      candidates: async function* () {
        yield* (await catalog.read()).rows;
      },
      projectForSession: (id) =>
        options.sessionMetadataService?.getMetadata(id)?.workingProjectId,
      read: async (row, readOptions) => {
        const reader = await readerFor(row.projectId, row.provider);
        return reader?.readIssueTextBatch?.(row.sessionId, readOptions) ?? null;
      },
    });
    issueIndexer = indexer;
    issueDisposers.push(
      settings.onSettingsChanged((next, previous) => {
        if (next.issueAssociations !== previous.issueAssociations)
          indexer.configure();
      }),
    );
    const unmap = supervisor.observeSessionIdRemaps?.((oldId, newId) =>
      indexer.remap(oldId, newId),
    );
    if (unmap) issueDisposers.push(unmap);
    const unsubscribe = options.eventBus?.subscribe((event) => {
      if (event.type === "session-catalog-updated" && !event.catalog.refreshing)
        indexer.refresh(event.catalog);
      if (event.type === "session-metadata-changed" && event.projectId)
        indexer.store.updateProject(event.sessionId, event.projectId);
      if (
        indexer.settings().enabled &&
        indexer.settings().scope === "recent" &&
        (event.type === "session-updated" ||
          (event.type === "process-state-changed" &&
            event.activity !== "in-turn"))
      )
        catalog.invalidate();
    });
    if (unsubscribe) issueDisposers.push(unsubscribe);
    app.route(
      "/api",
      createIssueRoutes(
        indexer,
        settings,
        async (projectId, sessionId) => {
          const process = supervisor.getProcessForSession(sessionId);
          const canonical = process?.sessionId ?? sessionId;
          if (canonical !== sessionId) return { available: false };
          const metadata =
            options.sessionMetadataService?.getMetadata(sessionId);
          if (
            metadata?.workingProjectId &&
            metadata.workingProjectId !== projectId
          )
            return { available: false };
          const physicalProject = metadata?.transcriptProjectId ?? projectId;
          const reader = await readerFor(physicalProject, metadata?.provider);
          const summary = await reader?.getSessionSummary(
            sessionId,
            physicalProject as import("@yep-anywhere/shared").UrlProjectId,
            { readMode: "head" },
          );
          return {
            available: Boolean(summary),
            title: metadata?.customTitle ?? summary?.title ?? undefined,
            initialPrompt: summary?.initialPrompt ?? summary?.fullTitle,
            lastAgentText: summary?.lastAgentText,
            model: summary?.model,
            ownership: process
              ? { owner: "self" as const, processId: process.id }
              : summary?.ownership,
            activity: process?.getInfo().state,
            provider: summary?.provider,
            createdAt: summary?.createdAt,
          };
        },
        issueCredentials,
        confirmer,
        async () => (await catalog.read()).rows,
        statuses,
      ),
    );
    indexer.configure();
  }
  // The learned vocabulary keeps its own SQLite file beside discovery's. The
  // server only starts once discovery has opened, which establishes the facts
  // it needs: a SQLite driver and a data directory on local disk
  // (topics/pluggable-speech-recognition.md § Keyterm Biasing).
  {
    const catalog = retainedCollections;
    const store = new VocabularyStore(effectiveDataDir);
    const keyterms = new VocabularyKeyterms(store, effectiveDataDir);
    const learning = new VocabularyLearning(
      store,
      (cutoff) =>
        vocabularySessions(
          catalog,
          scanner,
          heartbeatProviderResolutionDeps(),
          cutoff,
        ),
      { reference: () => keyterms.reference() },
    );
    vocabularyLearning = learning;
    vocabularyKeyterms = keyterms;
    // Parsing the English baseline costs about 60 ms and the result is now kept
    // for the process lifetime, so pay it here rather than on whichever
    // dictation or scan asks first. Only for an owner who turned the feature
    // on; a server that never uses it should not read the list at all.
    if (store.settings().enabled || store.settings().biasing)
      void keyterms.reference().catch(() => {
        // Already logged and retried on demand by the keyterm path.
      });
    options.speechBackendRegistry?.setVocabularySource((context) =>
      keyterms.get(context?.sessionTerms, context?.sessionId),
    );
    unsubscribeVocabulary = options.eventBus?.subscribe((event) => {
      if (event.type === "session-catalog-updated" && !event.catalog.refreshing)
        learning.scan(false);
      if (
        learning.store.settings().enabled &&
        (event.type === "session-updated" ||
          (event.type === "process-state-changed" &&
            event.activity !== "in-turn"))
      )
        catalog.invalidate();
    });
    app.route("/api/speech", createSpeechVocabularyRoutes(learning));
    learning.scan(false);
  }
  app.route(
    "/api/inbox",
    createInboxRoutes({
      retainedCollections,
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
      projectDisplayName,
    }),
  );

  // Global sessions route (flat list of all sessions for navigation)
  app.route(
    "/api/sessions",
    createGlobalSessionsRoutes({
      retainedCollections,
      scanner,
      readerFactory,
      supervisor,
      externalTracker,
      notificationService: options.notificationService,
      sessionIndexService: options.sessionIndexService,
      sessionMetadataService: options.sessionMetadataService,
      getClearloopBadge,
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
      projectDisplayName,
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
  app.route("/api/projects", createConversationContextRoutes({ supervisor }));
  app.route(
    "/api/projects",
    createToolCommentaryRoutes({
      scanner,
      resolveAbsoluteFilePaths: localResourcePathPolicy.findAllowedFilePaths,
    }),
  );

  // Current-content inventory and last-fetched incoming history.
  app.route(
    "/api/projects",
    createProjectFileCompletionRoutes({
      scanner,
      dataDir: effectiveDataDir,
      service: projectFileCompletion,
    }),
  );
  app.route(
    "/api/projects",
    createProjectFileViewSearchRoutes({
      scanner,
      service: projectFileCompletion,
      allowedPaths: getAllowedFilePaths,
      includeProjects: shouldIncludeProjects,
    }),
  );
  app.route(
    "/api/projects",
    createGitWorkingTreeFilesRoutes({
      scanner,
      dataDir: effectiveDataDir,
      dirtyFileEditorService: options.dirtyFileEditorService,
      allowedPaths: getAllowedFilePaths,
      includeProjects: shouldIncludeProjects,
    }),
  );
  app.route(
    "/api/projects",
    createFileOwnerRoutes({
      scanner,
      allowedPaths: getAllowedFilePaths,
      includeProjects: shouldIncludeProjects,
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
        retainedCollections,
        projectDisplayName,
        sessionMetadataService: options.sessionMetadataService,
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
        newSessionBootstrap: (context) =>
          streamNewSessionBootstrap(context, async (path, signal) => {
            const headers = new Headers(context.req.raw.headers);
            headers.delete("Accept-Encoding");
            headers.delete("Content-Length");
            headers.delete("If-None-Match");
            headers.delete("If-Modified-Since");
            headers.set("Accept", "application/json");
            return app.fetch(
              new Request(new URL(path, context.req.url), { headers, signal }),
              context.env,
            );
          }),
        projectStoragePolicy,
        hostAwakeService: options.hostAwakeService,
        sessionMetadataService: options.sessionMetadataService,
        getRendezStatus: rendezWatch ? () => rendezWatch.status() : undefined,
        onAllowedHostsChanged: updateAllowedHosts,
        onFileAccessChanged: updateFileAccess,
        onRemoteSessionPersistenceChanged: options.remoteSessionService
          ? (enabled) =>
              options.remoteSessionService?.setDiskPersistenceEnabled(enabled)
          : undefined,
        onClaudeGatewaySettingsChanged: async (settings) => {
          // Applied before the services are, so a read triggered by the
          // reconfigure already sees the current answer about whether to ask.
          gatewayEffortProbeCache.setEnabled(settings.effortDetection ?? true);
          await ClaudeGatewayProvider.configureGatewayServices(settings);
          // The export mirrors the configured list, so it re-syncs on every
          // change rather than only when the export itself is toggled.
          await syncGatewayServiceExports({
            services: settings.services,
            enabled: settings.exportToProviderClis ?? false,
          });
        },
        onOllamaUrlChanged: (url) => {
          ClaudeOllamaProvider.setOllamaUrl(url);
        },
        onHeartbeatSettingsChanged: () => {
          supervisor.notifyHeartbeatScheduleChanged();
        },
        onProjectQueueReadinessChanged: () => {
          projectQueueScheduler?.readinessSettingsChanged();
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
  if (options.limitedUserBrowserDefaultsService) {
    // Same slot shape as the backup above; limitedUserPolicy lets limited
    // users read it and refuses their writes.
    app.route(
      "/api/settings/limited-user-defaults",
      createBrowserSettingsBackupRoutes({
        browserSettingsBackupService: options.limitedUserBrowserDefaultsService,
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
      listProjectRoots: async () =>
        (await scanner.listProjects()).map((project) => project.path),
      loadSession: loadPublicShareSession,
      loadCompleteSession: loadCompletePublicShareSession,
      projectDisplayName,
      loadSessionUpdatedAt: loadPublicShareSessionUpdatedAt,
      loadSessionSummary: loadPublicShareSessionSummary,
      fetchProjectFile: fetchPublicShareProjectFile,
      dataDir: effectiveDataDir,
      localFilePolicy: localResourcePathPolicy,
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
        envVoiceBackends: options.envVoiceBackends,
        speechBackendInstallService: options.speechBackendInstallService,
        safeRestartService,
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

  // This native-only count stream is paired with the app-private Android runtime.
  // Hosted clients never depend on it; older staged payloads yield HTTP 404.
  if (process.env.YEP_ANDROID_SAF_SOCKET && options.eventBus) {
    app.route(
      "/api/android-host",
      createAndroidHostSummaryRoutes({
        supervisor,
        eventBus: options.eventBus,
      }),
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
    conversationSubscriptions,
    safeRestartService,
    focusedSessionWatchManager,
    artifactServer,
    supervisor,
    scanner,
    readerFactory,
    disposeSessionReaders,
    stopNotifications,
    glossaryIndexService,
    externalTracker,
    resolveAbsoluteFilePaths: localResourcePathPolicy.findAllowedFilePaths,
    limitedUsers: limitedUsersService
      ? {
          isEnabled: isLimitedUsersEnabled,
          getSrpChallengeInputs: (username) =>
            limitedUsersService.getSrpChallengeInputs(username),
        }
      : undefined,
    activityEventForIdentity: (username, event) => {
      if (!username) return event;
      if (username === options.remoteAccessService?.getUsername()) return event;
      const grants = getActiveLimitedGrants(username);
      if (!grants) return null;
      return limitedActivityEvent(event, {
        isProjectAccessible: (projectId) =>
          levelFor(grants, projectId) !== "none",
        knownSessionProject: (sessionId) =>
          sessionAccessResolver.resolveKnown(sessionId)?.projectId,
      });
    },
    authorizeSubscription: async ({ username, target }) => {
      // The superuser (no limited identity on the socket) subscribes freely.
      if (!username) return true;
      if (username === options.remoteAccessService?.getUsername()) return true;
      const grants = getActiveLimitedGrants(username);
      if (!grants) return false;
      // The activity channel carries events for every project; its rows are
      // filtered by the same grants downstream.
      if (target.kind === "global") return true;
      if (target.kind === "unknown") return false;
      const { projectIds, sessionIds } = target;
      if (projectIds.length === 0 && sessionIds.length === 0) return false;
      if (projectIds.some((id) => levelFor(grants, id) === "none")) {
        return false;
      }
      for (const sessionId of sessionIds) {
        const facts = await sessionAccessResolver.resolve(sessionId);
        if (!facts) return false;
        if (
          facts.createdByUser !== username &&
          levelFor(grants, facts.projectId) === "none"
        ) {
          return false;
        }
      }
      return true;
    },
  };
}

// Default app for backwards compatibility (health check only)
// Full API requires createApp() with SDK injection
export const app = new Hono();
app.route("/health", health);
