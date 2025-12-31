import * as os from "node:os";
import * as path from "node:path";
import { serve } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { createNodeWebSocket } from "@hono/node-ws";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import {
  attachUnifiedUpgradeHandler,
  createFrontendProxy,
} from "./frontend/index.js";
import { ProjectScanner } from "./projects/scanner.js";
import { createUploadRoutes } from "./routes/upload.js";
import { MockClaudeSDK } from "./sdk/mock.js";
import { setupMockProjects } from "./testing/mockProjectData.js";
import { EventBus, FileWatcher } from "./watcher/index.js";

const config = loadConfig();

// Ensure mock data exists
setupMockProjects();

// Create mock SDK with canned scenarios
// Use longer delays to give the client time to connect to SSE before messages are emitted
const mockSdk = new MockClaudeSDK([
  // Session 1
  {
    messages: [
      { type: "system", subtype: "init", session_id: "test-session-001" },
      {
        type: "assistant",
        message: {
          content: "Hello! I received your message. How can I help you today?",
          role: "assistant",
        },
      },
      { type: "result", session_id: "test-session-001" },
    ],
    delayMs: 200, // Enough time for client to connect to SSE
  },
  // Session 2
  {
    messages: [
      { type: "system", subtype: "init", session_id: "test-session-002" },
      {
        type: "assistant",
        message: {
          content: "I understand. Let me help you with that.",
          role: "assistant",
        },
      },
      { type: "result", session_id: "test-session-002" },
    ],
    delayMs: 200,
  },
  // Session 3
  {
    messages: [
      { type: "system", subtype: "init", session_id: "test-session-003" },
      {
        type: "assistant",
        message: {
          content: "Got it. Here's what I can do.",
          role: "assistant",
        },
      },
      { type: "result", session_id: "test-session-003" },
    ],
    delayMs: 200,
  },
  // Session 4
  {
    messages: [
      { type: "system", subtype: "init", session_id: "test-session-004" },
      {
        type: "assistant",
        message: { content: "Processing your request.", role: "assistant" },
      },
      { type: "result", session_id: "test-session-004" },
    ],
    delayMs: 200,
  },
  // Session 5
  {
    messages: [
      { type: "system", subtype: "init", session_id: "test-session-005" },
      {
        type: "assistant",
        message: { content: "Here you go!", role: "assistant" },
      },
      { type: "result", session_id: "test-session-005" },
    ],
    delayMs: 200,
  },
]);

// Create EventBus and FileWatcher for ~/.claude
const eventBus = new EventBus();
const claudeDir = path.join(os.homedir(), ".claude");
const fileWatcher = new FileWatcher({
  watchDir: claudeDir,
  eventBus,
  debounceMs: 200,
});
fileWatcher.start();

// Create frontend proxy if serving frontend
let frontendProxy: ReturnType<typeof createFrontendProxy> | undefined;
if (config.serveFrontend) {
  frontendProxy = createFrontendProxy({ vitePort: config.vitePort });
  console.log(
    `[Frontend] Proxying to Vite at http://localhost:${config.vitePort}`,
  );
}

// Create the main app first (without WebSocket support or frontend proxy)
// We'll add those after setting up WebSocket support to ensure correct route order
const app = createApp({
  sdk: mockSdk,
  idleTimeoutMs: 60000, // 1 minute for testing
  eventBus,
  // Note: upgradeWebSocket and frontendProxy not passed - will be added below
});

// Set up WebSocket support with the main app
// @hono/node-ws requires the app instance to be the same one used by the server
// We get wss for the unified upgrade handler (instead of using injectWebSocket)
const { wss, upgradeWebSocket } = createNodeWebSocket({ app });

// Add the upload routes with WebSocket support
// These must be added BEFORE the frontend proxy catch-all
const scanner = new ProjectScanner();
const uploadRoutes = createUploadRoutes({ scanner, upgradeWebSocket });
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

const port = config.port;
const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`Mock server running at http://localhost:${port}`);
  console.log("Using MockClaudeSDK with canned responses");
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
