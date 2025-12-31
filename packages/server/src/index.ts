import * as fs from "node:fs";
import * as path from "node:path";
import { serve } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { createNodeWebSocket } from "@hono/node-ws";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import {
  attachUnifiedUpgradeHandler,
  createFrontendProxy,
  createStaticRoutes,
} from "./frontend/index.js";
import { SessionMetadataService } from "./metadata/index.js";
import { NotificationService } from "./notifications/index.js";
import { ProjectScanner } from "./projects/scanner.js";
import { createUploadRoutes } from "./routes/upload.js";
import { detectClaudeCli } from "./sdk/cli-detection.js";
import { RealClaudeSDK } from "./sdk/real.js";
import { EventBus, FileWatcher, SourceWatcher } from "./watcher/index.js";

const config = loadConfig();

// Check for Claude CLI
const cliInfo = detectClaudeCli();
if (!cliInfo.found) {
  console.error("Error: Claude CLI not found!");
  console.error("");
  console.error("The real SDK requires Claude CLI to be installed.");
  console.error("Install: curl -fsSL https://claude.ai/install.sh | bash");
  console.error("");
  console.error("Alternatively, run with mock SDK: USE_MOCK_SDK=true pnpm dev");
  process.exit(1);
}

console.log(`Claude CLI found: ${cliInfo.path} (${cliInfo.version})`);

// Create the real SDK
const realSdk = new RealClaudeSDK();

// Create EventBus and FileWatcher for ~/.claude
const eventBus = new EventBus();
const claudeDir = path.dirname(config.claudeProjectsDir); // ~/.claude
const fileWatcher = new FileWatcher({
  watchDir: claudeDir,
  eventBus,
  debounceMs: 200,
});

// Start file watcher
fileWatcher.start();

// When running without tsx watch (NO_BACKEND_RELOAD=true), start source watcher
// to notify the UI when server code changes and needs manual reload
if (process.env.NO_BACKEND_RELOAD === "true") {
  const sourceWatcher = new SourceWatcher({ eventBus });
  sourceWatcher.start();
}

// Create and initialize services
const notificationService = new NotificationService({ eventBus });
const sessionMetadataService = new SessionMetadataService();

async function startServer() {
  // Initialize services (loads state from disk)
  await notificationService.initialize();
  await sessionMetadataService.initialize();

  // Determine if we're in production mode (no Vite dev server)
  const isProduction = process.env.NODE_ENV === "production";
  const isDev = !isProduction;

  // Frontend serving setup - create proxy before app so it can be passed in
  let frontendProxy: ReturnType<typeof createFrontendProxy> | undefined;

  if (config.serveFrontend && isDev) {
    // Development: proxy to Vite dev server
    frontendProxy = createFrontendProxy({ vitePort: config.vitePort });
    console.log(
      `[Frontend] Proxying to Vite at http://localhost:${config.vitePort}`,
    );
  }

  // Create the app first (without WebSocket support initially)
  // We'll add WebSocket routes after setting up WebSocket support
  const app = createApp({
    realSdk,
    projectsDir: config.claudeProjectsDir,
    idleTimeoutMs: config.idleTimeoutMs,
    defaultPermissionMode: config.defaultPermissionMode,
    eventBus,
    // Note: uploadeWebSocket not passed yet - will be added below
    notificationService,
    sessionMetadataService,
    maxWorkers: config.maxWorkers,
    idlePreemptThresholdMs: config.idlePreemptThresholdMs,
    // Note: frontendProxy not passed - will be added below
  });

  // Create WebSocket support with the main app
  // This must use the same app instance that has the routes
  // We get wss for the unified upgrade handler (instead of using injectWebSocket)
  const { wss, upgradeWebSocket } = createNodeWebSocket({ app });

  // Add upload routes with WebSocket support
  // These must be added BEFORE the frontend proxy catch-all
  const uploadScanner = new ProjectScanner({
    projectsDir: config.claudeProjectsDir,
  });
  const uploadRoutes = createUploadRoutes({
    scanner: uploadScanner,
    upgradeWebSocket,
  });
  app.route("/api", uploadRoutes);

  // Add frontend proxy as the final catch-all (AFTER all API routes including uploads)
  if (frontendProxy) {
    const proxy = frontendProxy;
    app.all("*", (c) => {
      const { incoming, outgoing } = c.env;
      proxy.web(incoming, outgoing);
      return RESPONSE_ALREADY_SENT;
    });
  }

  // Production: serve static files (must be added after API routes)
  if (config.serveFrontend && isProduction) {
    const distExists = fs.existsSync(config.clientDistPath);
    if (distExists) {
      const staticRoutes = createStaticRoutes({
        distPath: config.clientDistPath,
      });
      app.route("/", staticRoutes);
      console.log(
        `[Frontend] Serving static files from ${config.clientDistPath}`,
      );
    } else {
      console.warn(
        `[Frontend] Warning: dist not found at ${config.clientDistPath}. Run 'pnpm build' first.`,
      );
    }
  }

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`Server running at http://localhost:${info.port}`);
    console.log(`Projects dir: ${config.claudeProjectsDir}`);
    console.log(`Permission mode: ${config.defaultPermissionMode}`);

    // Notify all connected clients that the backend has restarted
    // This allows other tabs to clear their "reload needed" banner
    eventBus.emit({
      type: "backend-reloaded",
      timestamp: new Date().toISOString(),
    });
  });

  // Attach unified WebSocket upgrade handler
  // This replaces both attachFrontendProxyUpgrade and injectWebSocket to avoid
  // conflicts where both would try to handle the same upgrade request
  attachUnifiedUpgradeHandler(server, {
    frontendProxy,
    isApiPath: (urlPath) => urlPath.startsWith("/api"),
    app,
    wss,
  });
}

startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
