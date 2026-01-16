import * as fs from "node:fs";
import * as path from "node:path";
import { serve } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { createNodeWebSocket } from "@hono/node-ws";
import { createApp } from "./app.js";
import { AuthService } from "./auth/AuthService.js";
import { loadConfig } from "./config.js";
import {
  attachUnifiedUpgradeHandler,
  createFrontendProxy,
  createStaticRoutes,
} from "./frontend/index.js";
import { SessionIndexService } from "./indexes/index.js";
import {
  getLogFilePath,
  initLogger,
  interceptConsole,
} from "./logging/index.js";
import {
  setDebugContext,
  startMaintenanceServer,
} from "./maintenance/index.js";
import {
  ProjectMetadataService,
  SessionMetadataService,
} from "./metadata/index.js";
import { NotificationService } from "./notifications/index.js";
import { ProjectScanner } from "./projects/scanner.js";
import { PushService, getOrCreateVapidKeys } from "./push/index.js";
import { RecentsService } from "./recents/index.js";
import {
  RemoteAccessService,
  RemoteSessionService,
} from "./remote-access/index.js";
import { createUploadRoutes } from "./routes/upload.js";
import { createWsRelayRoutes } from "./routes/ws-relay.js";
import { createAcceptRelayConnection } from "./routes/ws-relay.js";
import { detectClaudeCli } from "./sdk/cli-detection.js";
import { initMessageLogger } from "./sdk/messageLogger.js";
import { RealClaudeSDK } from "./sdk/real.js";
import {
  BrowserProfileService,
  ConnectedBrowsersService,
  InstallService,
  NetworkBindingService,
  RelayClientService,
  ServerSettingsService,
} from "./services/index.js";
import { ClaudeSessionReader } from "./sessions/reader.js";
import { UploadManager } from "./uploads/manager.js";
import { EventBus, FileWatcher, SourceWatcher } from "./watcher/index.js";

// Allow many concurrent Claude sessions without listener warnings.
// Each SDK session registers an exit handler; default limit is 10.
process.setMaxListeners(50);

const config = loadConfig();

// Track supervisor for graceful shutdown (set after createApp)
let supervisorForShutdown:
  | Awaited<ReturnType<typeof createApp>>["supervisor"]
  | null = null;
let isShuttingDown = false;

/**
 * Graceful shutdown handler.
 * Aborts all running Claude processes before exiting to prevent orphaned child processes.
 */
async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    console.log(`[Shutdown] Already shutting down, ignoring ${signal}`);
    return;
  }
  isShuttingDown = true;

  console.log(`[Shutdown] Received ${signal}, cleaning up...`);

  if (supervisorForShutdown) {
    const processes = supervisorForShutdown.getAllProcesses();
    if (processes.length > 0) {
      console.log(
        `[Shutdown] Aborting ${processes.length} active session(s)...`,
      );
      await Promise.all(
        processes.map(async (p) => {
          try {
            await p.abort();
            console.log(`[Shutdown] Aborted session ${p.sessionId}`);
          } catch (error) {
            console.error(
              `[Shutdown] Error aborting session ${p.sessionId}:`,
              error,
            );
          }
        }),
      );
    }
  }

  console.log("[Shutdown] Cleanup complete, exiting");
  process.exit(0);
}

// Register shutdown handlers early
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Initialize logging early to capture all output
initLogger({
  logDir: config.logDir,
  logFile: config.logFile,
  consoleLevel: config.logLevel,
  fileLevel: config.logFileLevel,
  logToFile: config.logToFile,
  logToConsole: config.logToConsole,
  prettyPrint: process.env.NODE_ENV !== "production",
});
interceptConsole();

// Initialize SDK message logger (if LOG_SDK_MESSAGES=true)
initMessageLogger();

// Log configuration for discoverability
console.log(`[Config] Data dir: ${config.dataDir}`);
console.log(
  `[Config] Log file: ${getLogFilePath({ logDir: config.logDir, logFile: config.logFile })}`,
);

// Check for Claude CLI (optional - warn if not found)
const cliInfo = detectClaudeCli();
if (cliInfo.found) {
  console.log(`Claude CLI found: ${cliInfo.path} (${cliInfo.version})`);
} else {
  console.warn("Warning: Claude CLI not found.");
  console.warn("Claude Code sessions will not be available.");
  console.warn("Install: curl -fsSL https://claude.ai/install.sh | bash");
}

// Create the real SDK
const realSdk = new RealClaudeSDK();

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
  } else {
    console.log(`[FileWatcher] Skipping ${provider} (${watchDir} not found)`);
  }
}

// Create watchers for session directories only (not full provider dirs)
// This reduces inotify pressure and memory usage
createWatcherIfExists(config.claudeSessionsDir, "claude");
createWatcherIfExists(config.geminiSessionsDir, "gemini");
createWatcherIfExists(config.codexSessionsDir, "codex");

// When running without tsx watch (NO_BACKEND_RELOAD=true), start source watcher
// to notify the UI when server code changes and needs manual reload
if (process.env.NO_BACKEND_RELOAD === "true") {
  const sourceWatcher = new SourceWatcher({ eventBus });
  sourceWatcher.start();
}

// Create and initialize services (all use config.dataDir for state)
const notificationService = new NotificationService({
  eventBus,
  dataDir: config.dataDir,
});
const sessionMetadataService = new SessionMetadataService({
  dataDir: config.dataDir,
});
const projectMetadataService = new ProjectMetadataService({
  dataDir: config.dataDir,
});
const sessionIndexService = new SessionIndexService({
  projectsDir: config.claudeProjectsDir,
  dataDir: path.join(config.dataDir, "indexes"),
});
const pushService = new PushService({ dataDir: config.dataDir });
const browserProfileService = new BrowserProfileService({
  dataDir: config.dataDir,
});
const recentsService = new RecentsService({ dataDir: config.dataDir });
const authService = new AuthService({
  dataDir: config.dataDir,
  sessionTtlMs: config.authSessionTtlMs,
  cookieSecret: config.authCookieSecret,
});
const remoteAccessService = new RemoteAccessService({
  dataDir: config.dataDir,
});
const remoteSessionService = new RemoteSessionService({
  dataDir: config.dataDir,
});
const installService = new InstallService({
  dataDir: config.dataDir,
});
const relayClientService = new RelayClientService();
const networkBindingService = new NetworkBindingService({
  dataDir: config.dataDir,
  cliPortOverride: config.cliPortOverride ? config.port : undefined,
  cliHostOverride: config.cliHostOverride ? config.host : undefined,
  defaultPort: 3400,
});
const connectedBrowsersService = new ConnectedBrowsersService(eventBus);
const serverSettingsService = new ServerSettingsService({
  dataDir: config.dataDir,
});

async function startServer() {
  // Initialize services (loads state from disk)
  // InstallService first since it generates the installation ID used by other services
  await installService.initialize();
  await notificationService.initialize();
  await sessionMetadataService.initialize();
  await projectMetadataService.initialize();
  await sessionIndexService.initialize();
  await pushService.initialize();
  await browserProfileService.initialize();
  await recentsService.initialize();
  await authService.initialize();
  await remoteAccessService.initialize();
  await remoteSessionService.initialize();
  await networkBindingService.initialize();
  await serverSettingsService.initialize();

  // Log auth status
  if (config.authDisabled) {
    console.log("[Auth] Cookie auth disabled by --auth-disable flag");
  } else if (authService.isEnabled()) {
    console.log("[Auth] Cookie auth enabled (configured in settings)");
  } else {
    console.log("[Auth] Cookie auth not enabled (enable in Settings)");
  }

  // Load or auto-create VAPID keys for push notifications
  const vapidKeys = await getOrCreateVapidKeys();
  pushService.setVapidKeys(vapidKeys);
  console.log("[Push] VAPID keys loaded, push notifications enabled");

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

  // Callback holder for relay config changes - will be set after app creation
  const relayConfigCallbackHolder: { callback?: () => Promise<void> } = {};

  // Callback holder for network binding changes - will be set after servers are created
  const networkBindingCallbackHolder: {
    onLocalhostPortChange?: (
      port: number,
    ) => Promise<{ success: boolean; error?: string; redirectUrl?: string }>;
    onNetworkBindingChange?: (
      config: { host: string; port: number } | null,
    ) => Promise<{ success: boolean; error?: string }>;
  } = {};

  // Determine effective port for server-info (CLI override or saved setting)
  const effectiveServerPort = networkBindingService.getLocalhostPort();

  // Create the app first (without WebSocket support initially)
  // We'll add WebSocket routes after setting up WebSocket support
  const { app, supervisor, scanner } = createApp({
    realSdk,
    projectsDir: config.claudeProjectsDir,
    idleTimeoutMs: config.idleTimeoutMs,
    defaultPermissionMode: config.defaultPermissionMode,
    eventBus,
    // Note: uploadeWebSocket not passed yet - will be added below
    notificationService,
    sessionMetadataService,
    projectMetadataService,
    sessionIndexService,
    maxWorkers: config.maxWorkers,
    idlePreemptThresholdMs: config.idlePreemptThresholdMs,
    pushService,
    recentsService,
    authService,
    authDisabled: config.authDisabled,
    remoteAccessService,
    remoteSessionService,
    relayClientService,
    relayConfigCallbackHolder,
    // Note: frontendProxy not passed - will be added below
    serverHost: "127.0.0.1", // Always report localhost as main binding
    serverPort: effectiveServerPort,
    installId: installService.getInstallId(),
    dataDir: config.dataDir,
    networkBindingService,
    networkBindingCallbackHolder,
    connectedBrowsers: connectedBrowsersService,
    browserProfileService,
    serverSettingsService,
  });

  // Set supervisor reference for graceful shutdown
  supervisorForShutdown = supervisor;

  // Set up debug context for maintenance server
  setDebugContext({
    supervisor,
    claudeSessionsDir: config.claudeSessionsDir,
    getSessionReader: async (projectPath: string) => {
      // Find the project by scanning - projectPath is the absolute path
      const projects = await scanner.listProjects();
      const project = projects.find((p) => p.path === projectPath);
      if (!project || project.provider !== "claude") return null;
      return new ClaudeSessionReader({ sessionDir: project.sessionDir });
    },
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
    maxUploadSizeBytes: config.maxUploadSizeBytes,
  });
  app.route("/api", uploadRoutes);

  // Add WebSocket relay route for Phase 2b/2c/2d
  // This allows clients to make HTTP-like requests, subscriptions, and uploads over WebSocket
  const baseUrl = `http://${config.host}:${config.port}`;
  const wsRelayUploadManager = new UploadManager({
    maxUploadSizeBytes: config.maxUploadSizeBytes,
  });
  const wsRelayHandler = createWsRelayRoutes({
    upgradeWebSocket,
    app,
    baseUrl,
    supervisor,
    eventBus,
    uploadManager: wsRelayUploadManager,
    remoteAccessService,
    remoteSessionService,
    connectedBrowsers: connectedBrowsersService,
    browserProfileService,
  });
  app.get("/api/ws", wsRelayHandler);

  // Create relay connection handler for connections from relay server (Phase 7)
  // This accepts WebSocket connections that have already been upgraded at the relay
  const acceptRelayConnection = createAcceptRelayConnection({
    app,
    baseUrl,
    supervisor,
    eventBus,
    uploadManager: wsRelayUploadManager,
    remoteAccessService,
    remoteSessionService,
    connectedBrowsers: connectedBrowsersService,
    browserProfileService,
  });

  // Function to start/restart relay client with current config
  async function updateRelayConnection() {
    const relayConfig = remoteAccessService.getRelayConfig();
    if (relayConfig?.url && relayConfig?.username) {
      relayClientService.start({
        relayUrl: relayConfig.url,
        username: relayConfig.username,
        installId: installService.getInstallId(),
        onRelayConnection: acceptRelayConnection,
        onStatusChange: (status) => {
          console.log(`[Relay] Status: ${status}`);
        },
      });
    } else {
      relayClientService.stop();
    }
  }

  // Wire up the callback for relay config changes from API routes
  relayConfigCallbackHolder.callback = updateRelayConnection;

  // Start relay connection on boot if configured
  await updateRelayConnection();

  // Serve stable (emergency) UI from /_stable/ path if available
  // This bypasses HMR and serves pre-built assets directly
  if (config.serveFrontend && fs.existsSync(config.stableDistPath)) {
    const stableRoutes = createStaticRoutes({
      distPath: config.stableDistPath,
      basePath: "/_stable",
    });
    app.route("/_stable", stableRoutes);
    console.log(
      `[Frontend] Stable UI available at /_stable/ from ${config.stableDistPath}`,
    );
  }

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

  // Determine effective port (CLI override or saved setting or default)
  const effectivePort = networkBindingService.getLocalhostPort();

  // Track servers for multi-socket management
  let localhostServer: ReturnType<typeof serve>;
  let networkServer: ReturnType<typeof serve> | null = null;

  // Helper to create a server with WebSocket support
  function createServer(
    port: number,
    hostname: string,
    onReady?: (info: { port: number }) => void,
  ): ReturnType<typeof serve> {
    const server = serve({ fetch: app.fetch, port, hostname }, onReady);
    attachUnifiedUpgradeHandler(server, {
      frontendProxy,
      isApiPath: (urlPath) => urlPath.startsWith("/api"),
      app,
      wss,
    });
    return server;
  }

  // Callback for localhost port changes (test-first pattern)
  async function onLocalhostPortChange(
    newPort: number,
  ): Promise<{ success: boolean; error?: string; redirectUrl?: string }> {
    const currentPort = networkBindingService.getLocalhostPort();

    // If port hasn't changed, no action needed
    if (newPort === currentPort) {
      return { success: true };
    }

    try {
      // Test-first: try to bind new port before closing old one
      const testServer = serve(
        { fetch: app.fetch, port: newPort, hostname: "127.0.0.1" },
        () => {},
      );

      // If we got here, the port is available
      // Close the test server and the old server
      testServer.close();

      // Close old localhost server
      localhostServer.close();

      // Create new localhost server
      localhostServer = createServer(newPort, "127.0.0.1", (info) => {
        console.log(
          `[NetworkBinding] Localhost server restarted on port ${info.port}`,
        );
      });

      return {
        success: true,
        // Only include redirectUrl if port actually changed
        redirectUrl: `http://127.0.0.1:${newPort}`,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to bind port";
      console.error(
        `[NetworkBinding] Failed to bind port ${newPort}:`,
        message,
      );
      return { success: false, error: message };
    }
  }

  // Track whether we're currently bound to 0.0.0.0 (which covers localhost)
  let boundToAllInterfaces = false;

  // Callback for network socket changes
  async function onNetworkBindingChange(
    bindConfig: { host: string; port: number } | null,
  ): Promise<{ success: boolean; error?: string }> {
    const isBindingToAllInterfaces =
      bindConfig?.host === "0.0.0.0" || bindConfig?.host === "::";
    const localhostPort = networkBindingService.getLocalhostPort();
    const samePortAsLocalhost = bindConfig?.port === localhostPort;
    const needsLocalhostClose = isBindingToAllInterfaces && samePortAsLocalhost;

    try {
      // Close existing network server if running
      if (networkServer) {
        networkServer.close();
        networkServer = null;
        console.log("[NetworkBinding] Network socket closed");
      }

      // If we were bound to 0.0.0.0 and now we're not, rebind localhost
      if (boundToAllInterfaces && !isBindingToAllInterfaces) {
        localhostServer = createServer(localhostPort, "127.0.0.1", (info) => {
          console.log(
            `[NetworkBinding] Localhost server rebound on port ${info.port}`,
          );
        });
        boundToAllInterfaces = false;
      }

      // Create new network server if config provided
      if (bindConfig) {
        // If binding to 0.0.0.0 on the same port as localhost, we need to
        // close the localhost server first since 0.0.0.0 includes 127.0.0.1
        if (needsLocalhostClose) {
          localhostServer.close();
          console.log(
            "[NetworkBinding] Closed localhost server to bind to all interfaces",
          );
        }

        try {
          networkServer = createServer(
            bindConfig.port,
            bindConfig.host,
            (info) => {
              console.log(
                `[NetworkBinding] Network socket listening on ${bindConfig.host}:${info.port}`,
              );
            },
          );
          // Only set this flag after successful binding
          if (needsLocalhostClose) {
            boundToAllInterfaces = true;
          }
        } catch (bindError) {
          // If we closed localhost but failed to bind network, recover localhost
          if (needsLocalhostClose) {
            console.log(
              "[NetworkBinding] Recovering localhost server after failed bind",
            );
            localhostServer = createServer(
              localhostPort,
              "127.0.0.1",
              (info) => {
                console.log(
                  `[NetworkBinding] Localhost server recovered on port ${info.port}`,
                );
              },
            );
          }
          throw bindError;
        }
      }

      return { success: true };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to bind network socket";
      console.error("[NetworkBinding] Failed to bind network socket:", message);
      return { success: false, error: message };
    }
  }

  // Wire up the callbacks to the holder so routes can use them
  networkBindingCallbackHolder.onLocalhostPortChange = onLocalhostPortChange;
  networkBindingCallbackHolder.onNetworkBindingChange = onNetworkBindingChange;

  // Create the main localhost server
  localhostServer = createServer(effectivePort, "127.0.0.1", (info) => {
    // Write port to file if requested (for test harnesses)
    if (config.portFile) {
      fs.writeFileSync(config.portFile, String(info.port));
    }

    console.log(`Server running at http://127.0.0.1:${info.port}`);
    console.log(`Projects dir: ${config.claudeProjectsDir}`);
    console.log(`Permission mode: ${config.defaultPermissionMode}`);

    // Notify all connected clients that the backend has restarted
    // This allows other tabs to clear their "reload needed" banner
    eventBus.emit({
      type: "backend-reloaded",
      timestamp: new Date().toISOString(),
    });
  });

  // Start network socket if enabled in saved settings (and not CLI-overridden)
  const networkConfig = networkBindingService.getNetworkConfig();
  if (
    networkConfig.enabled &&
    networkConfig.host &&
    !networkBindingService.isNetworkOverridden()
  ) {
    const networkPort = networkConfig.port ?? effectivePort;
    await onNetworkBindingChange({
      host: networkConfig.host,
      port: networkPort,
    });
  }

  // If CLI host override was specified (not localhost), also bind to that interface
  // This handles the case where user runs `yepanywhere --host 0.0.0.0`
  if (
    config.cliHostOverride &&
    config.host !== "127.0.0.1" &&
    config.host !== "localhost"
  ) {
    await onNetworkBindingChange({ host: config.host, port: effectivePort });
  }

  // Start maintenance server on separate port (for out-of-band diagnostics)
  // This runs independently from the main server and can be used to debug
  // issues even when the main server is unresponsive
  // Port values: 0 = disabled, -1 = auto-assign, >0 = specific port
  if (config.maintenancePort !== 0) {
    startMaintenanceServer({
      port: config.maintenancePort < 0 ? 0 : config.maintenancePort,
      portFile: config.maintenancePortFile,
      host: "127.0.0.1", // Maintenance always on localhost
      mainServerPort: effectivePort,
    });
  }

  // Export callbacks for use by API routes (via app options)
  return { onLocalhostPortChange, onNetworkBindingChange };
}

startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
