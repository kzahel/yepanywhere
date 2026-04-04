import type { HttpBindings } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { Hono } from "hono";
import type { AuthService } from "./auth/AuthService.js";
import { createAuthRoutes } from "./auth/routes.js";
import type { DeviceBridgeService } from "./device/DeviceBridgeService.js";
import type { FrontendProxy } from "./frontend/index.js";
import type { SessionIndexService } from "./indexes/index.js";
import type {
  ProjectMetadataService,
  SessionMetadataService,
} from "./metadata/index.js";
import { updateAllowedHosts } from "./middleware/allowed-hosts.js";
import { createAuthMiddleware } from "./middleware/auth.js";
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
import { ProjectScanner } from "./projects/scanner.js";
import { PushNotifier, type PushService } from "./push/index.js";
import { createPushRoutes } from "./push/routes.js";
import type { RecentsService } from "./recents/index.js";
import type {
  RemoteAccessService,
  RemoteSessionService,
} from "./remote-access/index.js";
import { createRemoteAccessRoutes } from "./remote-access/index.js";
import { createActivityRoutes } from "./routes/activity.js";
import { createBrowserProfilesRoutes } from "./routes/browser-profiles.js";
import { createClientLogsRoutes } from "./routes/client-logs.js";
import { createConnectionsRoutes } from "./routes/connections.js";
import { createDebugStreamingRoutes } from "./routes/debug-streaming.js";
import { createDevRoutes } from "./routes/dev.js";
import { createDeviceRoutes } from "./routes/devices.js";
import { createFilesRoutes } from "./routes/files.js";
import { createGitStatusRoutes } from "./routes/git-status.js";
import { createGlobalSessionsRoutes } from "./routes/global-sessions.js";
import { health } from "./routes/health.js";
import { createInboxRoutes } from "./routes/inbox.js";
import { createNetworkBindingRoutes } from "./routes/network-binding.js";
import { createOnboardingRoutes } from "./routes/onboarding.js";
import { createProcessesRoutes } from "./routes/processes.js";
import { createProjectsRoutes } from "./routes/projects.js";
import { createProvidersRoutes } from "./routes/providers.js";
import { createRecentsRoutes } from "./routes/recents.js";
import { createServerAdminRoutes } from "./routes/server-admin.js";
import { createServerInfoRoutes } from "./routes/server-info.js";
import { createSessionsRoutes } from "./routes/sessions.js";
import { createSettingsRoutes } from "./routes/settings.js";
import { createSharingRoutes } from "./routes/sharing.js";
import { ClaudeOllamaProvider } from "./sdk/providers/claude-ollama.js";

import { createLocalImageRoutes } from "./routes/local-image.js";
import { type UploadDeps, createUploadRoutes } from "./routes/upload.js";
import { createVersionRoutes } from "./routes/version.js";
import type {
  ClaudeSDK,
  PermissionMode,
  RealClaudeSDKInterface,
} from "./sdk/types.js";
import type { BrowserProfileService } from "./services/BrowserProfileService.js";
import type { ConnectedBrowsersService } from "./services/ConnectedBrowsersService.js";
import type { ModelInfoService } from "./services/ModelInfoService.js";
import type { NetworkBindingService } from "./services/NetworkBindingService.js";
import type { RelayClientService } from "./services/RelayClientService.js";
import type { ServerSettingsService } from "./services/ServerSettingsService.js";
import type { SharingService } from "./services/SharingService.js";
import { CodexSessionReader } from "./sessions/codex-reader.js";
import { GeminiSessionReader } from "./sessions/gemini-reader.js";
import { OpenCodeSessionReader } from "./sessions/opencode-reader.js";
import { findSessionSummaryAcrossProviders } from "./sessions/provider-resolution.js";
import { ClaudeSessionReader } from "./sessions/reader.js";
import type { ISessionReader } from "./sessions/types.js";
import { ExternalSessionTracker } from "./supervisor/ExternalSessionTracker.js";
import { Supervisor } from "./supervisor/Supervisor.js";
import type { Project } from "./supervisor/types.js";
import { cleanupWorktree } from "./utils/worktree.js";
import type { EventBus } from "./watcher/index.js";
import { LifecycleWebhookService } from "./webhooks/LifecycleWebhookService.js";

export interface AppOptions {
  /** Legacy SDK interface for mock SDK (for testing) */
  sdk?: ClaudeSDK;
  /** Real SDK interface with full features */
  realSdk?: RealClaudeSDKInterface;
  projectsDir?: string; // override for testing
  idleTimeoutMs?: number;
  defaultPermissionMode?: PermissionMode;
  /** EventBus for file change events */
  eventBus?: EventBus;
  /** WebSocket upgrader from @hono/node-ws (optional) */
  upgradeWebSocket?: UploadDeps["upgradeWebSocket"];
  /** NotificationService for tracking session read state */
  notificationService?: NotificationService;
  /** SessionMetadataService for custom titles and archive status */
  sessionMetadataService?: SessionMetadataService;
  /** ProjectMetadataService for persisting added projects */
  projectMetadataService?: ProjectMetadataService;
  /** SessionIndexService for caching session summaries */
  sessionIndexService?: SessionIndexService;
  /** Project scanner cache TTL in ms (0 = rescan every request). */
  projectScanCacheTtlMs?: number;
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
  /** Maximum queue size for pending requests. 0 = unlimited */
  maxQueueSize?: number;
  /** AuthService for cookie-based auth (optional) */
  authService?: AuthService;
  /** Whether auth is disabled by env var (--auth-disable). Bypasses all auth. */
  authDisabled?: boolean;
  /** Desktop auth token for Tauri app. Requests with matching X-Desktop-Token header bypass auth. */
  desktopAuthToken?: string;
  /** RemoteAccessService for SRP-based remote access (optional) */
  remoteAccessService?: RemoteAccessService;
  /** RemoteSessionService for session persistence (optional) */
  remoteSessionService?: RemoteSessionService;
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
  };
  /** ConnectedBrowsersService for tracking active browser connections */
  connectedBrowsers?: ConnectedBrowsersService;
  /** BrowserProfileService for tracking browser profile origins */
  browserProfileService?: BrowserProfileService;
  /** ServerSettingsService for server-wide settings */
  serverSettingsService?: ServerSettingsService;
  /** ModelInfoService for cached model metadata (context windows, etc.) */
  modelInfoService?: ModelInfoService;
  /** SharingService for session sharing */
  sharingService?: SharingService;
  /** DeviceBridgeService for Android emulator streaming */
  deviceBridgeService?: DeviceBridgeService;
  /** If non-empty, only these provider names are exposed via the API. */
  enabledProviders?: string[];
  /** Whether voice input is enabled. Default: true */
  voiceInputEnabled?: boolean;
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
}

export function createApp(options: AppOptions): AppResult {
  const app = new Hono<{ Bindings: HttpBindings }>();

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

  // Create dependencies
  const scanner = new ProjectScanner({
    projectsDir: options.projectsDir,
    projectMetadataService: options.projectMetadataService,
    eventBus: options.eventBus,
    cacheTtlMs: options.projectScanCacheTtlMs,
  });
  const codexScanner = new CodexSessionScanner();
  const geminiScanner = new GeminiSessionScanner();
  const readerCache = new Map<string, ISessionReader>();
  const maxReaderCacheSize = 500;

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
      readerCache.delete(oldestKey);
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
      case "codex":
      case "codex-oss":
        return getOrCreateReader(
          `codex::${project.sessionDir}::${project.path}`,
          () =>
            new CodexSessionReader({
              sessionsDir: project.sessionDir,
              projectPath: project.path,
            }),
        );
      case "gemini":
      case "gemini-acp":
        return getOrCreateReader(
          `gemini::${GEMINI_TMP_DIR}::${project.path}`,
          () =>
            new GeminiSessionReader({
              sessionsDir: GEMINI_TMP_DIR,
              projectPath: project.path,
              hashToCwd: geminiScanner.getHashToCwd(),
            }),
        );
      case "claude":
      case "claude-ollama": {
        const mis = options.modelInfoService;
        return getOrCreateReader(
          `claude::${project.sessionDir}${mergedKey}`,
          () =>
            new ClaudeSessionReader({
              sessionDir: project.sessionDir,
              additionalDirs: project.mergedSessionDirs,
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
    }
  };
  const codexReaderFactory = (projectPath: string): CodexSessionReader =>
    getOrCreateReader(
      `codex-extra::${CODEX_SESSIONS_DIR}::${projectPath}`,
      () =>
        new CodexSessionReader({
          sessionsDir: CODEX_SESSIONS_DIR,
          projectPath,
        }),
    );
  const geminiReaderFactory = (projectPath: string): GeminiSessionReader =>
    getOrCreateReader(
      `gemini-extra::${GEMINI_TMP_DIR}::${projectPath}`,
      () =>
        new GeminiSessionReader({
          sessionsDir: GEMINI_TMP_DIR,
          projectPath,
          hashToCwd: geminiScanner.getHashToCwd(),
        }),
    );
  const getSessionSummary = async (sessionId: string, projectId: string) => {
    const project = await scanner.getProject(projectId);
    if (!project) return null;
    const resolved = await findSessionSummaryAcrossProviders(
      project,
      sessionId,
      project.id,
      {
        readerFactory,
        codexSessionsDir: CODEX_SESSIONS_DIR,
        codexReaderFactory,
        geminiSessionsDir: GEMINI_TMP_DIR,
        geminiReaderFactory,
        geminiHashToCwd: geminiScanner.getHashToCwd(),
      },
      options.sessionMetadataService?.getProvider(sessionId),
    );
    return resolved?.summary ?? null;
  };
  const supervisor = new Supervisor({
    sdk: options.sdk,
    realSdk: options.realSdk,
    idleTimeoutMs: options.idleTimeoutMs,
    defaultPermissionMode: options.defaultPermissionMode,
    eventBus: options.eventBus,
    maxWorkers: options.maxWorkers,
    idlePreemptThresholdMs: options.idlePreemptThresholdMs,
    maxQueueSize: options.maxQueueSize,
    // Save executor for remote sessions to support resume
    onSessionExecutor: options.sessionMetadataService
      ? (sessionId, executor) =>
          options.sessionMetadataService?.setExecutor(sessionId, executor) ??
          Promise.resolve()
      : undefined,
    onSessionSummary: getSessionSummary,
    // Clean up worktrees when sessions complete (only removes clean worktrees)
    onSessionComplete: options.sessionMetadataService
      ? async (sessionId) => {
          const worktree =
            options.sessionMetadataService?.getWorktree(sessionId);
          if (!worktree) return;
          const { removed } = await cleanupWorktree({
            worktreePath: worktree.worktreePath,
            branchName: worktree.branchName,
            originalPath: worktree.originalPath,
            originalHeadCommit: worktree.originalHeadCommit,
          });
          if (removed) {
            await options.sessionMetadataService?.setWorktree(
              sessionId,
              undefined,
            );
          }
        }
      : undefined,
  });

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
      })
    : undefined;

  // Create PushNotifier if push notifications are enabled
  // This sends push notifications when sessions need user input
  if (options.eventBus && options.pushService) {
    new PushNotifier({
      eventBus: options.eventBus,
      pushService: options.pushService,
      supervisor,
      connectedBrowsers: options.connectedBrowsers,
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
  app.use("/health/*", corsMiddleware);
  app.route("/health", health);

  // Version check (outside /api for easy access)
  app.route(
    "/api/version",
    createVersionRoutes({
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
    }),
  );

  // Server info (host/port binding info for Local Access settings)
  if (options.serverHost && options.serverPort) {
    app.route(
      "/api/server-info",
      createServerInfoRoutes({
        host: options.serverHost,
        port: options.serverPort,
        installId: options.installId,
        deviceBridgeAvailable: !!options.deviceBridgeService?.hasBinary(),
      }),
    );
  }

  // Server admin routes (restart, always available for remote relay)
  app.route("/api/server", createServerAdminRoutes({ supervisor }));

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
      createOnboardingRoutes({ dataDir: options.dataDir }),
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
    "/api/projects",
    createProjectsRoutes({
      scanner,
      readerFactory,
      supervisor,
      externalTracker,
      notificationService: options.notificationService,
      sessionMetadataService: options.sessionMetadataService,
      projectMetadataService: options.projectMetadataService,
      sessionIndexService: options.sessionIndexService,
      codexScanner,
      codexSessionsDir: CODEX_SESSIONS_DIR,
      codexReaderFactory,
      geminiScanner,
      geminiSessionsDir: GEMINI_TMP_DIR,
      geminiReaderFactory,
    }),
  );
  app.route(
    "/api",
    createSessionsRoutes({
      supervisor,
      scanner,
      readerFactory,
      externalTracker,
      notificationService: options.notificationService,
      sessionMetadataService: options.sessionMetadataService,
      eventBus: options.eventBus,
      codexScanner,
      codexSessionsDir: CODEX_SESSIONS_DIR,
      codexReaderFactory,
      geminiScanner,
      geminiSessionsDir: GEMINI_TMP_DIR,
      geminiReaderFactory,
      serverSettingsService: options.serverSettingsService,
      modelInfoService: options.modelInfoService,
    }),
  );
  app.route(
    "/api/processes",
    createProcessesRoutes({
      supervisor,
      scanner,
      readerFactory,
      processSessionSourceFactory: (process, project) => {
        switch (process.provider) {
          case "codex":
          case "codex-oss":
            return {
              reader: codexReaderFactory(project.path),
              sessionDir: CODEX_SESSIONS_DIR,
            };
          case "gemini":
          case "gemini-acp":
            return {
              reader: geminiReaderFactory(project.path),
              sessionDir: GEMINI_TMP_DIR,
            };
          default:
            return {
              reader: readerFactory(project),
              sessionDir: project.sessionDir,
            };
        }
      },
      sessionIndexService: options.sessionIndexService,
    }),
  );

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
      codexScanner,
      codexSessionsDir: CODEX_SESSIONS_DIR,
      codexReaderFactory,
      geminiScanner,
      geminiSessionsDir: GEMINI_TMP_DIR,
      geminiReaderFactory,
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
      codexSessionsDir: CODEX_SESSIONS_DIR,
      codexReaderFactory,
      geminiScanner,
      geminiSessionsDir: GEMINI_TMP_DIR,
      geminiReaderFactory,
      eventBus: options.eventBus,
    }),
  );

  // Files routes (file browser)
  app.route("/api/projects", createFilesRoutes({ scanner }));

  // Git status routes
  app.route("/api/projects", createGitStatusRoutes({ scanner }));

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
        codexSessionsDir: CODEX_SESSIONS_DIR,
        codexReaderFactory,
        geminiScanner,
        geminiSessionsDir: GEMINI_TMP_DIR,
        geminiReaderFactory,
      }),
    );
  }

  // Provider routes (multi-provider detection)
  app.route(
    "/api/providers",
    createProvidersRoutes({
      modelInfoService: options.modelInfoService,
      enabledProviders: options.enabledProviders,
    }),
  );

  // Server settings routes
  if (options.serverSettingsService) {
    app.route(
      "/api/settings",
      createSettingsRoutes({
        serverSettingsService: options.serverSettingsService,
        onAllowedHostsChanged: updateAllowedHosts,
        onRemoteSessionPersistenceChanged: options.remoteSessionService
          ? (enabled) =>
              options.remoteSessionService?.setDiskPersistenceEnabled(enabled)
          : undefined,
        onOllamaUrlChanged: (url) => {
          ClaudeOllamaProvider.setOllamaUrl(url);
        },
        onOllamaSystemPromptChanged: (prompt) => {
          ClaudeOllamaProvider.setSystemPrompt(prompt);
        },
        onOllamaUseFullSystemPromptChanged: (enabled) => {
          ClaudeOllamaProvider.setUseFullSystemPrompt(enabled);
        },
      }),
    );
  }

  // Sharing routes (session snapshot sharing via Worker)
  if (options.sharingService) {
    app.route(
      "/api/sharing",
      createSharingRoutes({ sharingService: options.sharingService }),
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
      }),
    );
  }

  // Local image serving (opt-in, restricted to allowed paths)
  if (options.allowedImagePaths && options.allowedImagePaths.length > 0) {
    app.route(
      "/api/local-image",
      createLocalImageRoutes({
        allowedPaths: options.allowedImagePaths,
      }),
    );
  }

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
    const isDevMode =
      process.env.NO_BACKEND_RELOAD === "true" ||
      process.env.NO_FRONTEND_RELOAD === "true";
    if (isDevMode) {
      console.log("[Dev] Mounting dev routes at /api/dev");
      app.route("/api/dev", createDevRoutes({ eventBus: options.eventBus }));
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

  return { app, supervisor, scanner, readerFactory };
}

// Default app for backwards compatibility (health check only)
// Full API requires createApp() with SDK injection
export const app = new Hono();
app.route("/health", health);
