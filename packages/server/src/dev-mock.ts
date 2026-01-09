/**
 * Development server with mock providers.
 *
 * Runs the full application with mock SDK/providers for testing.
 * Supports multiple providers (Claude, Codex, Gemini) via mock implementations.
 *
 * Environment variables:
 * - MOCK_PROVIDER: Default provider to use (claude, codex, gemini). Default: claude
 * - MOCK_DELAY_MS: Delay between mock messages in ms. Default: 200
 */

import * as fs from "node:fs";
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
  createStaticRoutes,
} from "./frontend/index.js";
import { ProjectScanner } from "./projects/scanner.js";
import { createUploadRoutes } from "./routes/upload.js";
import {
  type MockScenario as LegacyMockScenario,
  MockClaudeSDK,
} from "./sdk/mock.js";
import {
  type MockAgentProvider,
  MockClaudeProvider,
  MockCodexOSSProvider,
  MockCodexProvider,
  MockGeminiProvider,
  MockOpenCodeProvider,
  type MockScenario,
} from "./sdk/providers/__mocks__/index.js";
import type { ProviderName } from "./sdk/providers/types.js";
import { setupMockProjects } from "./testing/mockProjectData.js";
import { EventBus, FileWatcher } from "./watcher/index.js";

const config = loadConfig();

// Configuration from environment
const DEFAULT_PROVIDER =
  (process.env.MOCK_PROVIDER as ProviderName) || "claude";
const DELAY_MS = Number.parseInt(process.env.MOCK_DELAY_MS || "200", 10);

// Ensure mock data exists
setupMockProjects();

/**
 * Create mock scenarios for each provider.
 * These simulate realistic responses with appropriate delays.
 */
function createMockScenarios(provider: string): MockScenario[] {
  const prefix = provider.charAt(0).toUpperCase() + provider.slice(1);

  return [
    {
      messages: [
        { type: "system", subtype: "init", session_id: `${provider}-001` },
        {
          type: "assistant",
          message: {
            content: `Hello! I'm ${prefix}. How can I help you today?`,
            role: "assistant",
          },
        },
        { type: "result", session_id: `${provider}-001` },
      ],
      delayMs: DELAY_MS,
      sessionId: `${provider}-001`,
    },
    {
      messages: [
        { type: "system", subtype: "init", session_id: `${provider}-002` },
        {
          type: "assistant",
          message: {
            content: `I understand. Let me help you with that. (${prefix})`,
            role: "assistant",
          },
        },
        { type: "result", session_id: `${provider}-002` },
      ],
      delayMs: DELAY_MS,
      sessionId: `${provider}-002`,
    },
    {
      messages: [
        { type: "system", subtype: "init", session_id: `${provider}-003` },
        {
          type: "assistant",
          message: {
            content: `Got it. Here's what I can do. (${prefix})`,
            role: "assistant",
          },
        },
        { type: "result", session_id: `${provider}-003` },
      ],
      delayMs: DELAY_MS,
      sessionId: `${provider}-003`,
    },
    {
      messages: [
        { type: "system", subtype: "init", session_id: `${provider}-004` },
        {
          type: "assistant",
          message: {
            content: `Processing your request. (${prefix})`,
            role: "assistant",
          },
        },
        { type: "result", session_id: `${provider}-004` },
      ],
      delayMs: DELAY_MS,
      sessionId: `${provider}-004`,
    },
    {
      messages: [
        { type: "system", subtype: "init", session_id: `${provider}-005` },
        {
          type: "assistant",
          message: { content: `Here you go! (${prefix})`, role: "assistant" },
        },
        { type: "result", session_id: `${provider}-005` },
      ],
      delayMs: DELAY_MS,
      sessionId: `${provider}-005`,
    },
  ];
}

// Create mock providers for all provider types
const mockProviders: Record<ProviderName, MockAgentProvider> = {
  claude: new MockClaudeProvider({ scenarios: createMockScenarios("claude") }),
  codex: new MockCodexProvider({ scenarios: createMockScenarios("codex") }),
  "codex-oss": new MockCodexOSSProvider({
    scenarios: createMockScenarios("codex-oss"),
  }),
  gemini: new MockGeminiProvider({ scenarios: createMockScenarios("gemini") }),
  opencode: new MockOpenCodeProvider({
    scenarios: createMockScenarios("opencode"),
  }),
};

// Create legacy mock SDK for backward compatibility
// Uses the same scenarios as the Claude mock provider
// Note: MockScenario from __mocks__ has an extra `sessionId` field, cast to legacy type
const mockSdk = new MockClaudeSDK(
  createMockScenarios("test-session") as LegacyMockScenario[],
);

// Create EventBus and FileWatchers for all provider directories
const eventBus = new EventBus();
const fileWatchers: FileWatcher[] = [];

// Helper to create watcher if directory exists
function createWatcherIfExists(
  watchDir: string,
  provider: "claude" | "gemini" | "codex",
): void {
  if (fs.existsSync(watchDir)) {
    const watcher = new FileWatcher({
      watchDir,
      provider,
      eventBus,
      debounceMs: 200,
    });
    watcher.start();
    fileWatchers.push(watcher);
  }
}

// Create watchers for session directories only (not full provider dirs)
// This reduces inotify pressure and memory usage
// Use configured directories from config (supports env var overrides for test isolation)
createWatcherIfExists(config.claudeSessionsDir, "claude");
createWatcherIfExists(config.geminiSessionsDir, "gemini");
createWatcherIfExists(config.codexSessionsDir, "codex");

// Create frontend proxy or static routes depending on configuration
// If VITE_PORT=0 and CLIENT_DIST_PATH exists, serve static files
// Otherwise, proxy to Vite dev server
let frontendProxy: ReturnType<typeof createFrontendProxy> | undefined;
let useStaticFiles = false;

if (config.serveFrontend) {
  const distExists = fs.existsSync(config.clientDistPath);
  if (config.vitePort === 0 && distExists) {
    // E2E mode: serve pre-built static files
    useStaticFiles = true;
    console.log(
      `[Frontend] Serving static files from ${config.clientDistPath}`,
    );
  } else if (config.vitePort > 0) {
    // Dev mode: proxy to Vite
    frontendProxy = createFrontendProxy({ vitePort: config.vitePort });
    console.log(
      `[Frontend] Proxying to Vite at http://localhost:${config.vitePort}`,
    );
  } else {
    console.warn(
      `[Frontend] No frontend available (VITE_PORT=0 and no dist at ${config.clientDistPath})`,
    );
  }
}

// Create the main app first (without WebSocket support or frontend proxy)
// We'll add those after setting up WebSocket support to ensure correct route order
const { app } = createApp({
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

// Add mock auth status endpoint (auth disabled for testing)
app.get("/api/auth/status", (c) => {
  return c.json({
    enabled: false,
    authenticated: true,
    setupRequired: false,
  });
});

// Add mock providers status endpoint
// Returns all mock providers as available and authenticated
app.get("/api/providers", async (c) => {
  const providers = await Promise.all(
    Object.entries(mockProviders).map(async ([name, provider]) => ({
      name,
      displayName: provider.displayName,
      installed: await provider.isInstalled(),
      authenticated: await provider.isAuthenticated(),
      enabled: await provider.isAuthenticated(),
    })),
  );
  return c.json(providers);
});

// Add mock provider status endpoint
app.get("/api/providers/:name/status", async (c) => {
  const name = c.req.param("name") as ProviderName;
  const provider = mockProviders[name];

  if (!provider) {
    return c.json({ error: `Unknown provider: ${name}` }, 404);
  }

  const status = await provider.getAuthStatus();
  return c.json({
    name,
    displayName: provider.displayName,
    ...status,
  });
});

// Add frontend serving as the final catch-all (AFTER all API routes including uploads)
if (useStaticFiles) {
  // E2E mode: serve static files
  const staticRoutes = createStaticRoutes({
    distPath: config.clientDistPath,
  });
  app.route("/", staticRoutes);
} else if (frontendProxy) {
  // Dev mode: proxy to Vite
  const proxy = frontendProxy;
  app.all("*", (c) => {
    const { incoming, outgoing } = c.env;
    proxy.web(incoming, outgoing);
    return RESPONSE_ALREADY_SENT;
  });
}

const port = config.port;
const server = serve({ fetch: app.fetch, port }, () => {
  // Get actual port (important when binding to port 0)
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  console.log(`Mock server running at http://localhost:${actualPort}`);
  console.log(`Default provider: ${DEFAULT_PROVIDER}`);
  console.log(`Message delay: ${DELAY_MS}ms`);
  console.log("Available mock providers: claude, codex, gemini, local");
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

// Export for testing
export { mockProviders, mockSdk, DEFAULT_PROVIDER };
