import { Hono } from "hono";
import { corsMiddleware, requireCustomHeader } from "./middleware/security.js";
import type { NotificationService } from "./notifications/index.js";
import { ProjectScanner } from "./projects/scanner.js";
import { createActivityRoutes } from "./routes/activity.js";
import { createDevRoutes } from "./routes/dev.js";
import { health } from "./routes/health.js";
import { createProcessesRoutes } from "./routes/processes.js";
import { createProjectsRoutes } from "./routes/projects.js";
import { createSessionsRoutes } from "./routes/sessions.js";
import { createStreamRoutes } from "./routes/stream.js";
import { type UploadDeps, createUploadRoutes } from "./routes/upload.js";
import type {
  ClaudeSDK,
  PermissionMode,
  RealClaudeSDKInterface,
} from "./sdk/types.js";
import { SessionReader } from "./sessions/reader.js";
import { ExternalSessionTracker } from "./supervisor/ExternalSessionTracker.js";
import { Supervisor } from "./supervisor/Supervisor.js";
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
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();

  // Security middleware: CORS + custom header requirement
  app.use("/api/*", corsMiddleware);
  app.use("/api/*", requireCustomHeader);

  // Create dependencies
  const scanner = new ProjectScanner({ projectsDir: options.projectsDir });
  const supervisor = new Supervisor({
    sdk: options.sdk,
    realSdk: options.realSdk,
    idleTimeoutMs: options.idleTimeoutMs,
    defaultPermissionMode: options.defaultPermissionMode,
    eventBus: options.eventBus,
  });
  const readerFactory = (sessionDir: string) =>
    new SessionReader({ sessionDir });

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
          const reader = readerFactory(project.sessionDir);
          return reader.getSessionSummary(sessionId, project.id);
        },
      })
    : undefined;

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
    }),
  );
  app.route("/api/processes", createProcessesRoutes({ supervisor }));
  app.route("/api", createStreamRoutes({ supervisor }));

  // Upload routes (WebSocket file uploads)
  if (options.upgradeWebSocket) {
    app.route(
      "/api",
      createUploadRoutes({
        scanner,
        upgradeWebSocket: options.upgradeWebSocket,
      }),
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

  return app;
}

// Default app for backwards compatibility (health check only)
// Full API requires createApp() with SDK injection
export const app = new Hono();
app.route("/health", health);
