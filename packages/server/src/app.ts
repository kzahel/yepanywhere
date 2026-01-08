import type { HttpBindings } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { Hono } from "hono";
import type { AuthService } from "./auth/AuthService.js";
import { createAuthRoutes } from "./auth/routes.js";
import type { FrontendProxy } from "./frontend/index.js";
import type { SessionIndexService } from "./indexes/index.js";
import type { SessionMetadataService } from "./metadata/index.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { corsMiddleware, requireCustomHeader } from "./middleware/security.js";
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
import { createActivityRoutes } from "./routes/activity.js";
import { createBeadsRoutes } from "./routes/beads.js";
import { createDebugStreamingRoutes } from "./routes/debug-streaming.js";
import { createDevRoutes } from "./routes/dev.js";
import { createFilesRoutes } from "./routes/files.js";
import { createGlobalSessionsRoutes } from "./routes/global-sessions.js";
import { health } from "./routes/health.js";
import { createInboxRoutes } from "./routes/inbox.js";
import { createProcessesRoutes } from "./routes/processes.js";
import { createProjectsRoutes } from "./routes/projects.js";
import { createProvidersRoutes } from "./routes/providers.js";
import { createRecentsRoutes } from "./routes/recents.js";
import { createSessionsRoutes } from "./routes/sessions.js";
import { createStreamRoutes } from "./routes/stream.js";
import { type UploadDeps, createUploadRoutes } from "./routes/upload.js";
import type {
  ClaudeSDK,
  PermissionMode,
  RealClaudeSDKInterface,
} from "./sdk/types.js";
import { CodexSessionReader } from "./sessions/codex-reader.js";
import { GeminiSessionReader } from "./sessions/gemini-reader.js";
import { OpenCodeSessionReader } from "./sessions/opencode-reader.js";
import { ClaudeSessionReader } from "./sessions/reader.js";
import type { ISessionReader } from "./sessions/types.js";
import { ExternalSessionTracker } from "./supervisor/ExternalSessionTracker.js";
import { Supervisor } from "./supervisor/Supervisor.js";
import type { Project } from "./supervisor/types.js";
import type { EventBus } from "./watcher/index.js";

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
  /** SessionIndexService for caching session summaries */
  sessionIndexService?: SessionIndexService;
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
  /** Whether auth is enabled */
  authEnabled?: boolean;
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

  // Security middleware: CORS + custom header requirement
  app.use("/api/*", corsMiddleware);
  app.use("/api/*", requireCustomHeader);

  // Auth middleware (if authService is provided and enabled)
  if (options.authService && options.authEnabled !== false) {
    app.use(
      "/api/*",
      createAuthMiddleware({
        authService: options.authService,
        enabled: true,
      }),
    );
  }

  // Auth routes (always mounted if authService is provided, even if auth is disabled)
  // This allows checking auth status and setting up account
  if (options.authService) {
    app.route(
      "/api/auth",
      createAuthRoutes({
        authService: options.authService,
        authEnabled: options.authEnabled,
      }),
    );
  }

  // Create dependencies
  const scanner = new ProjectScanner({ projectsDir: options.projectsDir });
  const codexScanner = new CodexSessionScanner();
  const geminiScanner = new GeminiSessionScanner();
  const supervisor = new Supervisor({
    sdk: options.sdk,
    realSdk: options.realSdk,
    idleTimeoutMs: options.idleTimeoutMs,
    defaultPermissionMode: options.defaultPermissionMode,
    eventBus: options.eventBus,
    maxWorkers: options.maxWorkers,
    idlePreemptThresholdMs: options.idlePreemptThresholdMs,
    maxQueueSize: options.maxQueueSize,
  });
  /**
   * Create a session reader appropriate for the project's provider.
   * Routes call this with the project to get the right reader.
   */
  const readerFactory = (project: Project): ISessionReader => {
    switch (project.provider) {
      case "codex":
      case "codex-oss":
        return new CodexSessionReader({
          sessionsDir: project.sessionDir,
          projectPath: project.path,
        });
      case "gemini":
        return new GeminiSessionReader({
          sessionsDir: GEMINI_TMP_DIR,
          projectPath: project.path,
          hashToCwd: geminiScanner.getHashToCwd(),
        });
      case "claude":
        return new ClaudeSessionReader({ sessionDir: project.sessionDir });
      case "opencode":
        return new OpenCodeSessionReader({
          projectPath: project.path,
        });
    }
  };

  // Create external session tracker if eventBus is available
  const externalTracker = options.eventBus
    ? new ExternalSessionTracker({
        eventBus: options.eventBus,
        supervisor,
        scanner,
        decayMs: 30000, // 30 seconds
        // Callback to get session summary for new external sessions
        // projectId is now UrlProjectId (base64url) - ExternalSessionTracker converts it
        getSessionSummary: async (sessionId, projectId) => {
          const project = await scanner.getProject(projectId);
          if (!project) return null;
          const reader = readerFactory(project);
          return reader.getSessionSummary(sessionId, project.id);
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

  // Health check (outside /api)
  app.route("/health", health);

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
      sessionIndexService: options.sessionIndexService,
      codexScanner,
      codexSessionsDir: CODEX_SESSIONS_DIR,
      geminiScanner,
      geminiSessionsDir: GEMINI_TMP_DIR,
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
      geminiScanner,
      geminiSessionsDir: GEMINI_TMP_DIR,
    }),
  );
  app.route(
    "/api/processes",
    createProcessesRoutes({
      supervisor,
      scanner,
      readerFactory,
      sessionIndexService: options.sessionIndexService,
    }),
  );
  app.route("/api", createStreamRoutes({ supervisor }));

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
      geminiScanner,
      geminiSessionsDir: GEMINI_TMP_DIR,
    }),
  );

  // Beads task tracker routes (project-scoped) - must be before files routes
  app.route("/api/projects", createBeadsRoutes({ scanner }));

  // Files routes (file browser)
  app.route("/api/projects", createFilesRoutes({ scanner }));

  // Recents routes (recently visited sessions)
  if (options.recentsService) {
    app.route(
      "/api/recents",
      createRecentsRoutes({
        recentsService: options.recentsService,
        scanner,
        readerFactory,
        sessionIndexService: options.sessionIndexService,
      }),
    );
  }

  // Provider routes (multi-provider detection)
  app.route("/api/providers", createProvidersRoutes());

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
      createActivityRoutes({ eventBus: options.eventBus }),
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
