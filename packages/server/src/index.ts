import * as path from "node:path";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { NotificationService } from "./notifications/index.js";
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

// Create WebSocket support
// Note: createNodeWebSocket needs an app reference, but we create it before the real app
// because we need the upgradeWebSocket function to pass to createApp
const wsApp = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({
  app: wsApp,
});

// Create and initialize NotificationService
const notificationService = new NotificationService({ eventBus });

async function startServer() {
  // Initialize notification service (loads state from disk)
  await notificationService.initialize();

  // Create the app with real SDK and WebSocket support
  const app = createApp({
    realSdk,
    projectsDir: config.claudeProjectsDir,
    idleTimeoutMs: config.idleTimeoutMs,
    defaultPermissionMode: config.defaultPermissionMode,
    eventBus,
    upgradeWebSocket,
    notificationService,
  });

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

  // Inject WebSocket handling into the server
  injectWebSocket(server);
}

startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
