import { antigravitySessionsDir } from "./sdk/providers/antigravity-runtime.js";
import { localPeerHost } from "./peer-api/connection-contracts.js";
import { PeerAccessManager } from "./peer-api/manager.js";
import { readServerIdentity } from "./core-api/server-identity.js";
import { revokeHostedPeerAgentApiAccess } from "./sdk/providers/provider-runtime-host.js";
import "./startupEnv.js";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { serve, upgradeWebSocket } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { WebSocketServer } from "ws";
import {
  SPEECH_RELAY_CHANNEL,
  idleReapHoursToMs,
  isClaudeProviderName,
  isYaSessionId,
  toUrlProjectId,
  parseSpeechVoiceBackends,
  unionSpeechVoiceBackends,
} from "@yep-anywhere/shared";
import { createApp } from "./app.js";
import { markdownAugmentCacheDiagnostics } from "./augments/markdown-augments.js";
import { AuthService } from "./auth/AuthService.js";
import { UserUsageService } from "./auth/UserUsageService.js";
import { LimitedUsersService } from "./auth/LimitedUsersService.js";
import {
  closeCodexCorrelationDebugLogger,
  initCodexCorrelationDebugLogger,
} from "./codex/correlationDebugLogger.js";
import { loadConfig } from "./config.js";
import {
  registerDevWrapperBackend,
  reportDevWrapperListening,
} from "./dev-wrapper-client.js";
import { DeviceBridgeService } from "./device/DeviceBridgeService.js";
import { detectAdb } from "./device/adb.js";
import { DESKTOP_BOOTSTRAP_PROTOCOL_VERSION } from "./desktop/DesktopBootstrapService.js";
import { readDesktopBootstrapServiceFromStdin } from "./desktop/startup.js";
import {
  attachUnifiedUpgradeHandler,
  createFrontendProxy,
  createStaticRoutes,
} from "./frontend/index.js";
import { highlightWorker } from "./highlighting/highlight-worker-host.js";
import { ensureSelfSignedCertificate } from "./https/self-signed.js";
import {
  SessionDiscoveryIndexRegistry,
  SessionIndexService,
} from "./indexes/index.js";
import {
  getLogFilePath,
  getLogger,
  initLogger,
  interceptConsole,
  startResourceSampling,
} from "./logging/index.js";
import {
  setDebugContext,
  startMaintenanceServer,
} from "./maintenance/index.js";
import {
  ProjectMetadataService,
  SessionMetadataService,
} from "./metadata/index.js";
import { updateAllowedHosts } from "./middleware/allowed-hosts.js";
import { initFileAccess, updateFileAccess } from "./middleware/file-access.js";
import { NotificationService } from "./notifications/index.js";
import {
  DiscoverySqliteService,
  DiscoveryStorageError,
} from "./storage/discovery-sqlite.js";
import { ProjectGlossarySubscriptionManager } from "./projects/projectGlossarySubscriptionManager.js";
import { ProjectWorktreeSubscriptionManager } from "./projects/projectWorktreeSubscriptionManager.js";
import { projectPathCacheDiagnostics } from "./projects/projectPathIndex.js";
import { GROK_SESSIONS_DIR } from "./projects/paths.js";
import { OPENCODE_DB_PATH } from "./sessions/opencode-reader.js";
import { openCodeRelationshipWatcherSpec } from "./sessions/opencode-child-source.js";
import { ProjectStoragePolicy } from "./projects/projectStoragePolicy.js";
import { PushService, getOrCreateVapidKeys } from "./push/index.js";
import { RecentsService } from "./recents/index.js";
import {
  RemoteAccessService,
  RemoteSessionService,
} from "./remote-access/index.js";
import { createSpeechRoutes } from "./routes/speech.js";
import { createUploadRoutes } from "./routes/upload.js";
import { getServerCompatibilityInfo } from "./routes/version.js";
import { createWsRelayRoutes } from "./routes/ws-relay.js";
import { createAcceptRelayConnection } from "./routes/ws-relay.js";
import { relayResponseSerializationDiagnostics } from "./routes/ws-relay-handlers.js";
import { warnIfCodexVersionMismatch } from "./codex-version-advisory.js";
import { detectClaudeCli } from "./sdk/cli-detection.js";
import { initMessageLogger } from "./sdk/messageLogger.js";
import { MockServerClaudeProvider } from "./sdk/mock.js";
import {
  closeProviderRuntimeHostRegistration,
  ensureProviderRuntimeHost,
  hasHostedProviderRuntime,
  isProviderRuntimeHostAvailable,
  listHostedProviderRuntimes,
  retainProviderRuntimeProcessGroup,
} from "./sdk/providers/provider-runtime-host.js";
import { isProviderHostDegraded } from "./sdk/providers/provider-host-status.js";
import { ClaudeGatewayProvider } from "./sdk/providers/claude-gateway.js";
import { gatewayEffortProbeCache } from "./services/GatewayEffortProbe.js";
import { syncGatewayServiceExports } from "./sdk/providers/gatewayServiceExport.js";
import { ClaudeOllamaProvider } from "./sdk/providers/claude-ollama.js";
import { grokACPProvider } from "./sdk/providers/grok-acp.js";
import { configureAuthAudit } from "./security/authAuditLog.js";
import {
  BrowserProfileService,
  BrowserSettingsBackupService,
  ConnectedBrowsersService,
  DirtyFileEditorService,
  HostAwakeService,
  InstallService,
  ModelInfoService,
  NetworkBindingService,
  ProjectQueueService,
  PublicShareService,
  RelayClientService,
  SecurityClientService,
  ServerSettingsService,
  loadOrCreateSessionWakeSecret,
  SessionQueuePersistenceService,
  SharingService,
} from "./services/index.js";
import { providerInstallationCoordinator } from "./services/ProviderInstallationCoordinator.js";
import { NativePushService } from "./push/NativePushService.js";
import { configureInboundWebSocketMessageLimit } from "./websocketLimits.js";
import {
  type SpeechRegistryInitOptions,
  SpeechBackendRegistry,
  getRequestedSpeechBackendIds,
  registerSpeechBackends,
} from "./services/voice/registry.js";
import { SpeechBackendInstallService } from "./services/voice/speechBackendInstall.js";
import { codexEntryCacheBudget } from "./sessions/codex-entry-cache-budget.js";
import { observeCodexRolloutTree } from "./sessions/codex-shared-scan-cache.js";
import { codexSessionWatcherSpec } from "./sessions/codex-thread-index.js";
import {
  formatListenerAddress,
  type NetworkListenerControl,
  NetworkListeners,
} from "./network/listeners.js";
import { providerCatalogFamily } from "./sessions/provider-catalog-family.js";
import {
  boundSessionSource,
  resolveLegacySessionSource,
} from "./sessions/provider-resolution.js";
import { AttachmentStagingService } from "./uploads/AttachmentStagingService.js";
import { UploadManager } from "./uploads/manager.js";
import {
  EventBus,
  ProviderSessionWatcherRegistry,
  SourceWatcher,
} from "./watcher/index.js";

// Allow many concurrent Claude sessions without listener warnings.
// Each SDK session registers an exit handler; default limit is 10.
process.setMaxListeners(50);

// Prevent unhandled promise rejections from crashing the server.
// The Claude Agent SDK can throw "ProcessTransport is not ready for writing"
// from its internal streamInput() in a detached async context when a CLI
// process dies. This isn't catchable from our Process.processMessages() loop.
process.on("unhandledRejection", (reason) => {
  const message =
    reason instanceof Error ? reason.message : String(reason ?? "unknown");
  const stack = reason instanceof Error ? reason.stack : undefined;

  // Known SDK transport errors — these are already handled by Process via
  // isProcessTerminationError when they surface through the iterator, but
  // streamInput failures arrive as unhandled rejections.
  const isTransportError =
    message.includes("ProcessTransport is not ready") ||
    message.includes("not ready for writing");

  if (isTransportError) {
    console.warn(
      `[unhandledRejection] SDK transport error (session process likely died): ${message}`,
    );
  } else {
    console.error(`[unhandledRejection] ${message}`);
    if (stack) {
      console.error(stack);
    }
  }
});

const desktopBootstrapService = await readDesktopBootstrapServiceFromStdin();
const config = loadConfig();

function readPerfPersistedAugmentDelayMs(): number | undefined {
  const raw = process.env.YA_PERF_PERSISTED_AUGMENT_DELAY_MS;
  if (raw === undefined) return undefined;
  if (!process.env.PERF_RUN_ID) {
    throw new Error(
      "YA_PERF_PERSISTED_AUGMENT_DELAY_MS requires a tracked performance run",
    );
  }
  const delayMs = Number(raw);
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 10_000) {
    throw new Error(
      "YA_PERF_PERSISTED_AUGMENT_DELAY_MS must be between 0 and 10000",
    );
  }
  return delayMs;
}

const ATTACHMENT_STAGING_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PROVIDER_WATCH_ACTIVATION_DELAY_MS = 1_000;
const PROVIDER_WATCH_ACTIVATION_YIELD_MS = 100;

// Track services for graceful shutdown (set after createApp)
let supervisorForShutdown:
  | Awaited<ReturnType<typeof createApp>>["supervisor"]
  | null = null;
let disposeAppForShutdown:
  | Awaited<ReturnType<typeof createApp>>["disposeSessionReaders"]
  | null = null;
let stopNotificationsForShutdown: (() => void) | null = null;
let deviceBridgeForShutdown: DeviceBridgeService | null = null;
let projectGlossarySubscriptionsForShutdown: ProjectGlossarySubscriptionManager | null =
  null;
let projectWorktreeSubscriptionsForShutdown: ProjectWorktreeSubscriptionManager | null =
  null;
let hostAwakeForShutdown: HostAwakeService | null = null;
let securityClientForShutdown: SecurityClientService | null = null;
let nativePushForShutdown: NativePushService | null = null;
let providerSessionWatchersForShutdown: ProviderSessionWatcherRegistry | null =
  null;
let attachmentStagingCleanupTimer: ReturnType<typeof setInterval> | null = null;
let stopResourceSampling: (() => void) | null = null;
let isShuttingDown = false;

/**
 * Graceful shutdown handler.
 * Aborts all running provider processes before exiting to prevent orphans.
 * SIGHUP is the wrapper-owned Hono replacement path: reload-safe provider
 * clients release their socket claim while their wrapper-lifetime host keeps
 * the runtime alive for the next generation.
 */
async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    console.log(`[Shutdown] Already shutting down, ignoring ${signal}`);
    return;
  }
  isShuttingDown = true;
  // Shutdown is intentional on every platform, whether providers are aborted
  // locally or detached to the Linux host. Cleanup is not new task activity.
  stopNotificationsForShutdown?.();

  console.log(`[Shutdown] Received ${signal}, cleaning up...`);

  // An admitted provider package mutation (npm install -g) must not be
  // interrupted mid-replacement: hold reload/shutdown on a bounded drain.
  // If the deadline passes, exit with an explicit recovery diagnostic —
  // the abandoned writer lease is removed by owner-identity stale cleanup
  // once this PID is gone, so the next server can update again.
  const updateDrainMs = signal === "SIGHUP" ? 30_000 : 10_000;
  try {
    const pendingUpdates =
      await providerInstallationCoordinator.waitForLocalUpdates(updateDrainMs);
    if (pendingUpdates.length > 0) {
      console.warn(
        `[Shutdown] Provider installation update for ${pendingUpdates.join(", ")} ` +
          `still running after ${updateDrainMs}ms; exiting anyway — stale-writer ` +
          "owner verification recovers the lease on the next start",
      );
    }
  } catch (error) {
    console.error(
      "[Shutdown] Error draining provider installation updates:",
      error,
    );
  }

  if (attachmentStagingCleanupTimer) {
    clearInterval(attachmentStagingCleanupTimer);
    attachmentStagingCleanupTimer = null;
  }

  if (stopResourceSampling) {
    stopResourceSampling();
    stopResourceSampling = null;
  }

  if (hostAwakeForShutdown) {
    try {
      await hostAwakeForShutdown.shutdown();
      console.log("[Shutdown] Host-awake assertion released");
    } catch (error) {
      console.error("[Shutdown] Error releasing host-awake assertion:", error);
    }
  }

  if (securityClientForShutdown) {
    try {
      nativePushForShutdown?.shutdown();
      await securityClientForShutdown.shutdown();
      console.log("[Shutdown] Security-client audit state flushed");
    } catch (error) {
      console.error("[Shutdown] Error flushing security-client audit:", error);
    }
  }

  if (supervisorForShutdown) {
    // Join admitted background maintenance before taking the abort/detach
    // inventory so no in-flight maintenance can outlive shutdown.
    await supervisorForShutdown.stopBackgroundTasks();
    const processes = supervisorForShutdown.getAllProcesses();
    if (processes.length > 0) {
      console.log(
        `[Shutdown] Aborting ${processes.length} active session(s)...`,
      );
      await Promise.all(
        processes.map(async (p) => {
          try {
            if (
              signal === "SIGHUP" &&
              hasHostedProviderRuntime(p.sessionId) &&
              p.queueDepth === 0 &&
              !p.hasVolatileDeferredMessages()
            ) {
              try {
                await supervisorForShutdown?.prepareForServerReload(p);
              } catch (error) {
                // A retained callback must never resume under stale standing policy.
                await p.abort();
                throw error;
              }
              await p.detachForServerReload();
              console.log(
                `[Shutdown] Detached ${p.provider} session ${p.sessionId}`,
              );
            } else {
              await p.abort();
              console.log(`[Shutdown] Aborted session ${p.sessionId}`);
            }
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

  let retainedGateway = false;
  if (signal === "SIGHUP") {
    const retentions =
      await ClaudeGatewayProvider.retainOwnedGatewayProcessGroups(
        retainProviderRuntimeProcessGroup,
      );
    for (const retention of retentions) {
      if (retention.error) {
        console.error(
          `[Shutdown] Could not retain managed Claude Gateway process group ${retention.processGroupId}:`,
          retention.error,
        );
      } else if (retention.relinquished) {
        console.log(
          `[Shutdown] Managed Claude Gateway process group ${retention.processGroupId} retained by wrapper`,
        );
      }
    }
    // Stop the gateway unless every service handed its child over: a child
    // that stayed owned here is still this process's to kill.
    retainedGateway =
      retentions.length > 0 &&
      retentions.every((retention) => retention.relinquished);
  }
  if (!retainedGateway) {
    try {
      await ClaudeGatewayProvider.shutdownGateway();
      console.log("[Shutdown] Managed Claude Gateway stopped");
    } catch (error) {
      console.error("[Shutdown] Error stopping managed Claude Gateway:", error);
    }
  }

  closeProviderRuntimeHostRegistration();

  if (disposeAppForShutdown) {
    try {
      await disposeAppForShutdown();
      console.log("[Shutdown] Session readers disposed");
    } catch (error) {
      console.error("[Shutdown] Error disposing session readers:", error);
    }
  }
  projectGlossarySubscriptionsForShutdown?.dispose();
  projectGlossarySubscriptionsForShutdown = null;
  projectWorktreeSubscriptionsForShutdown?.dispose();
  projectWorktreeSubscriptionsForShutdown = null;
  providerSessionWatchersForShutdown?.stop();
  providerSessionWatchersForShutdown = null;

  // Shut down device bridge sidecar
  if (deviceBridgeForShutdown) {
    try {
      await deviceBridgeForShutdown.shutdown();
      console.log("[Shutdown] Device bridge shut down");
    } catch (error) {
      console.error("[Shutdown] Error shutting down emulator bridge:", error);
    }
  }

  // Let a credential save already in progress finish before exiting. An exit
  // during an in-place save once left auth.json empty, and the next start came
  // up with no password (topics/security.md). This waits only: shutdown
  // itself writes no credential file.
  const credentialStores = [
    ["auth", authService],
    ["limited users", limitedUsersService],
    ["remote access", remoteAccessService],
    ["remote sessions", remoteSessionService],
  ] as const;
  for (const [name, store] of credentialStores) {
    try {
      await store.waitForPendingWrites();
    } catch (error) {
      console.error(`[Shutdown] Error waiting on ${name} state:`, error);
    }
  }
  console.log("[Shutdown] Credential saves settled");

  closeCodexCorrelationDebugLogger();
  console.log("[Shutdown] Cleanup complete, exiting");
  process.exit(0);
}

// Register shutdown handlers early
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
if (process.platform !== "win32") {
  process.on("SIGHUP", () => {
    void gracefulShutdown("SIGHUP");
  });
}

// Initialize logging early to capture all output
initLogger({
  logDir: config.logDir,
  logFile: config.logFile,
  consoleLevel: config.logLevel,
  fileLevel: config.logFileLevel,
  logToFile: config.logToFile,
  prettyPrint: config.logPretty,
});
interceptConsole();

// Initialize SDK message logger (if LOG_SDK_MESSAGES=true)
initMessageLogger();
initCodexCorrelationDebugLogger();

// Log configuration for discoverability
console.log(`[Config] Data dir: ${config.dataDir}`);
configureAuthAudit(config.dataDir);
console.log(
  `[Config] Log file: ${getLogFilePath({ logDir: config.logDir, logFile: config.logFile })}`,
);
if (config.desktopRuntime) {
  console.log("[Config] Desktop runtime enabled");
}
if (config.codexCliPath) {
  console.log(`[Config] Codex CLI path: ${config.codexCliPath}`);
}
getLogger().info(
  {
    event: "summary_parser_worker_config",
    claudeSummaryParserWorkerMode: config.claudeSummaryParserWorkerMode,
    codexSummaryParserWorkerMode: config.codexSummaryParserWorkerMode,
    claudeSummaryParserWorkerEnv:
      process.env.CLAUDE_SUMMARY_PARSER_WORKER ?? null,
    codexSummaryParserWorkerEnv:
      process.env.CODEX_SUMMARY_PARSER_WORKER ?? null,
  },
  "SUMMARY_PARSER_WORKER: evaluated config",
);

// Check for Claude CLI (optional - warn if not found)
const cliInfo = detectClaudeCli();
if (cliInfo.found) {
  console.log(`Claude CLI found: ${cliInfo.path} (${cliInfo.version})`);
} else {
  console.warn("Warning: Claude CLI not found.");
  console.warn("Claude Code sessions will not be available.");
  console.warn(
    process.platform === "win32"
      ? "Install: irm https://claude.ai/install.ps1 | iex"
      : "Install: curl -fsSL https://claude.ai/install.sh | bash",
  );
}

await warnIfCodexVersionMismatch(config);

const mockProvider = config.useMockSdk
  ? new MockServerClaudeProvider()
  : undefined;

// Create the event bus and the eligibility-gated provider watcher owner.
const eventBus = new EventBus();
const openCodeRelationshipWatcher =
  openCodeRelationshipWatcherSpec(OPENCODE_DB_PATH);
const providerSessionWatchers = new ProviderSessionWatcherRegistry({
  eventBus,
  activationDelayMs: PROVIDER_WATCH_ACTIVATION_DELAY_MS,
  activationYieldMs: PROVIDER_WATCH_ACTIVATION_YIELD_MS,
  specs: [
    {
      family: "antigravity",
      provider: "antigravity",
      watchDir: antigravitySessionsDir(),
      debounceMs: 200,
    },
    {
      family: "claude",
      watchDir: config.claudeSessionsDir,
      provider: "claude",
      debounceMs: 200,
    },
    {
      family: "gemini",
      watchDir: config.geminiSessionsDir,
      provider: "gemini",
      debounceMs: 200,
    },
    codexSessionWatcherSpec(
      config.codexSessionsDir,
      config.codexWatchPeriodicRescanMs,
    ),
    {
      family: "pi",
      watchDir: config.piSessionsDir,
      provider: "pi",
      debounceMs: 200,
    },
    {
      family: "grok",
      provider: "grok",
      watchDir: GROK_SESSIONS_DIR,
      debounceMs: 200,
      internalOnly: true,
    },
    ...(openCodeRelationshipWatcher ? [openCodeRelationshipWatcher] : []),
  ],
});
providerSessionWatchersForShutdown = providerSessionWatchers;
// While the Codex watcher observes the sessions tree, cached enumerations stay
// current between its reports instead of re-walking cold history on a timer.
observeCodexRolloutTree({
  sessionsDir: config.codexSessionsDir,
  eventBus,
  epoch: () => providerSessionWatchers.getObservationEpoch("codex"),
});

// When running without tsx watch (NO_BACKEND_RELOAD=true), start source watcher
// to notify the UI when server code changes and needs manual reload
if (process.env.NO_BACKEND_RELOAD === "true") {
  const sourceWatcher = new SourceWatcher({ eventBus });
  sourceWatcher.start();
}

// The SQLite database is required: session metadata lives there, so a server
// that cannot open it does not start (topics/required-sqlite.md).
const discoverySqlite = (() => {
  try {
    return new DiscoverySqliteService({ dataDir: config.dataDir });
  } catch (error) {
    if (!(error instanceof DiscoveryStorageError)) throw error;
    console.error(`[Startup] ${error.message}`);
    process.exit(1);
  }
})();

const notificationService = new NotificationService({
  database: discoverySqlite.getDatabase(),
  eventBus,
  dataDir: config.dataDir,
});
const sessionMetadataService = new SessionMetadataService({
  dataDir: config.dataDir,
  database: discoverySqlite.getDatabase(),
});
const projectMetadataService = new ProjectMetadataService({
  dataDir: config.dataDir,
});
const projectQueueService = new ProjectQueueService({
  dataDir: config.dataDir,
  eventBus,
});
const sessionQueuePersistenceService = new SessionQueuePersistenceService({
  dataDir: config.dataDir,
  eventBus,
});
const sessionDiscoveryIndexRegistry = new SessionDiscoveryIndexRegistry();
const sessionIndexService = new SessionIndexService({
  database: discoverySqlite.getDatabase(),
  projectsDir: config.claudeProjectsDir,
  dataDir: path.join(config.dataDir, "indexes"),
  fullValidationIntervalMs: config.sessionIndexFullValidationMs,
  summaryParseConcurrency: config.sessionIndexSummaryParseConcurrency,
  sessionDiscoveryIndexRegistry,
  eventBus,
});
const pushService = new PushService({ dataDir: config.dataDir });
const browserProfileService = new BrowserProfileService({
  dataDir: config.dataDir,
  getProtectedBrowserProfileIds: () =>
    Object.keys(pushService.getSubscriptions()),
});
const recentsService = new RecentsService({
  dataDir: config.dataDir,
  onChanged: () =>
    eventBus.emit({
      type: "recents-changed",
      timestamp: new Date().toISOString(),
    }),
});
const authService = new AuthService({
  dataDir: config.dataDir,
  sessionTtlMs: config.authSessionTtlMs,
  cookieSecret: config.authCookieSecret,
});
const limitedUsersService = new LimitedUsersService({
  dataDir: config.dataDir,
});
const userUsageService = new UserUsageService({ dataDir: config.dataDir });
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
const relaySpeechClientService = new RelayClientService();
const networkBindingService = new NetworkBindingService({
  dataDir: config.dataDir,
  cliPortOverride: config.cliPortOverride ? config.port : undefined,
  cliHostOverride: config.cliHostOverride ? config.host : undefined,
  defaultPort: 3400,
});
const connectedBrowsersService = new ConnectedBrowsersService(eventBus);
const securityClientService = new SecurityClientService({
  dataDir: config.dataDir,
  remoteSessionService,
  browserProfileService,
  connectedBrowsers: connectedBrowsersService,
  pushService,
});
const nativePushService = new NativePushService(securityClientService);
nativePushForShutdown = nativePushService;
pushService.setNativePushService(nativePushService);
const serverSettingsService = new ServerSettingsService({
  dataDir: config.dataDir,
});
const projectStoragePolicy = new ProjectStoragePolicy({
  dataDir: config.dataDir,
  getMode: () =>
    serverSettingsService.getSetting("projectDirectoryStorage") ?? "app-data",
});
const hostAwakeService = new HostAwakeService();
hostAwakeForShutdown = hostAwakeService;
const browserSettingsBackupService = new BrowserSettingsBackupService({
  dataDir: config.dataDir,
});
const limitedUserBrowserDefaultsService = new BrowserSettingsBackupService({
  dataDir: config.dataDir,
  fileName: "limited-user-browser-defaults.json",
});
const sharingService = new SharingService({
  dataDir: config.dataDir,
});
const publicShareService = new PublicShareService({
  dataDir: config.dataDir,
});
const modelInfoService = new ModelInfoService({ dataDir: config.dataDir });
const attachmentStagingService = new AttachmentStagingService({
  dataDir: config.dataDir,
  maxUploadSizeBytes: config.maxUploadSizeBytes,
  storagePolicy: projectStoragePolicy,
});
const dirtyFileEditorService = new DirtyFileEditorService({
  dataDir: config.dataDir,
});

function startAttachmentStagingCleanup(): void {
  if (attachmentStagingCleanupTimer) return;
  attachmentStagingCleanupTimer = setInterval(() => {
    attachmentStagingService.cleanupStaleDraftAttachments().catch((error) => {
      console.error("[AttachmentStagingService] TTL cleanup failed:", error);
    });
  }, ATTACHMENT_STAGING_CLEANUP_INTERVAL_MS);
  attachmentStagingCleanupTimer.unref?.();
}

async function startServer() {
  const startupStart = Date.now();
  let lastStartupMark = startupStart;
  const startupTimings: Array<{
    phase: string;
    deltaMs: number;
    elapsedMs: number;
  }> = [];

  const markStartup = (phase: string): void => {
    const now = Date.now();
    const timing = {
      phase,
      deltaMs: now - lastStartupMark,
      elapsedMs: now - startupStart,
    };
    startupTimings.push(timing);
    lastStartupMark = now;
    console.log(
      `[Startup] ${timing.phase} (+${timing.deltaMs}ms, total ${timing.elapsedMs}ms)`,
    );
  };

  markStartup("startup began");

  // Sampling starts before the slow initialization below so a server that is
  // already struggling at startup leaves the same evidence as one that
  // degrades hours later.
  stopResourceSampling = startResourceSampling({ dataDir: config.dataDir });

  let tlsOptions: { key: Buffer; cert: Buffer } | undefined;
  if (config.httpsSelfSigned) {
    const certResult = ensureSelfSignedCertificate({
      dataDir: config.dataDir,
      host: config.host,
    });
    tlsOptions = {
      key: certResult.key,
      cert: certResult.cert,
    };
    console.log(
      `[HTTPS] ${certResult.generated ? "Generated" : "Using existing"} self-signed certificate at ${certResult.certPath}`,
    );
  }
  const serverProtocol = tlsOptions ? "https" : "http";
  const sessionWakeSecret = await loadOrCreateSessionWakeSecret(config.dataDir);

  // Initialize services (loads state from disk)
  // InstallService first since it generates the installation ID used by other services
  await installService.initialize();
  markStartup("installService initialized");
  await notificationService.initialize();
  markStartup("notificationService initialized");
  await sessionMetadataService.initialize();
  // Before any new admission: only surviving owner proof can confirm input
  // accepted under the previous controller. No prompt payloads are loaded here.
  sessionMetadataService.creations.recoverOwnerLoss();
  markStartup("sessionMetadataService initialized");
  const migratedCatalogFamilies = installService.needsCatalogMetadataMigration()
    ? await installService.completeCatalogMetadataMigration(
        sessionMetadataService.getRecordedProviders(),
      )
    : [];
  getLogger().info(
    {
      event: "provider_session_watcher_state_loaded",
      catalogFamilies: installService.getCatalogFamilies(),
      migratedCatalogFamilies,
      ...providerSessionWatchers.getMetrics(),
    },
    "FILE_WATCHER: eligible provider watcher state loaded",
  );
  markStartup("eligible provider watcher state loaded");
  await projectMetadataService.initialize();
  markStartup("projectMetadataService initialized");
  await projectQueueService.initialize();
  markStartup("projectQueueService initialized");
  await sessionQueuePersistenceService.initialize();
  markStartup("sessionQueuePersistenceService initialized");
  await dirtyFileEditorService.initialize();
  markStartup("dirtyFileEditorService initialized");
  await attachmentStagingService.initialize();
  startAttachmentStagingCleanup();
  markStartup("attachmentStagingService initialized");
  await sessionIndexService.initialize();
  markStartup("sessionIndexService initialized");
  await pushService.initialize();
  markStartup("pushService initialized");
  await browserProfileService.initialize();
  markStartup("browserProfileService initialized");
  await recentsService.initialize();
  markStartup("recentsService initialized");
  await authService.initialize();
  markStartup("authService initialized");
  await limitedUsersService.initialize();
  markStartup("limitedUsersService initialized");
  await remoteAccessService.initialize();
  markStartup("remoteAccessService initialized");
  await modelInfoService.initialize();
  markStartup("modelInfoService initialized");
  await serverSettingsService.initialize();
  markStartup("serverSettingsService initialized");
  if (await registerDevWrapperBackend()) {
    console.log("[DevWrapper] Registered backend process");
  }
  if (await ensureProviderRuntimeHost()) {
    console.log("[ProviderRuntimeHost] Registered this server generation");
  } else if (isProviderHostDegraded()) {
    console.error(
      "[ProviderRuntimeHost] Server is running without the provider host; local sessions stay in-process",
    );
  }
  markStartup("Provider runtime host registration checked");
  await hostAwakeService.initialize({
    mode: serverSettingsService.getSetting("hostAwakeMode"),
    batteryFloorPercent: serverSettingsService.getSetting(
      "hostAwakeBatteryFloorPercent",
    ),
  });
  markStartup("hostAwakeService initialized");
  await browserSettingsBackupService.initialize();
  markStartup("browserSettingsBackupService initialized");
  await limitedUserBrowserDefaultsService.initialize();
  markStartup("limitedUserBrowserDefaultsService initialized");
  await sharingService.initialize();
  markStartup("sharingService initialized");
  // Loading persisted public shares is not required to bind the listening
  // socket or serve /health, but on a large data dir this file read parks the
  // event loop for several seconds (it queues behind the FileWatcher's initial
  // scan), which previously pushed onReady — and thus the health endpoint — out
  // to ~6s. Start it in the background instead so the socket binds immediately;
  // share routes default to EMPTY_STATE until it resolves (same tradeoff as the
  // deferred speech-backend init).
  void publicShareService
    .initialize(serverSettingsService.getSetting("publicSharesEnabled"))
    .then(() => {
      console.log(
        `[public-shares] Loaded (deferred) at +${Date.now() - startupStart}ms`,
      );
    })
    .catch((error) => {
      console.warn("[public-shares] Deferred initialization failed:", error);
    });
  markStartup("publicShareService initialization started (deferred)");
  await remoteSessionService.setDiskPersistenceEnabled(
    serverSettingsService.getSetting("persistRemoteSessionsToDisk"),
  );
  markStartup("remoteSessionService persistence setting applied");
  await remoteSessionService.initialize();
  markStartup("remoteSessionService initialized");
  await securityClientService.initialize();
  securityClientForShutdown = securityClientService;
  markStartup("securityClientService initialized");
  await networkBindingService.initialize();
  markStartup("networkBindingService initialized");

  // Seed allowed hosts middleware from persisted settings
  updateAllowedHosts(serverSettingsService.getSetting("allowedHosts"));

  // Seed file-access policy (resolved deps + persisted settings)
  initFileAccess({
    uploadsDir: config.managedUploadsDir,
    homeDir: os.homedir(),
    tempPaths: config.fileAccessTempPaths,
    envPaths: config.fileAccessEnvPaths,
    appDataProjectsDir: path.join(config.dataDir, "projects"),
  });
  updateFileAccess(serverSettingsService.getSetting("fileAccess"));

  // Seed Claude transport settings from persisted settings
  gatewayEffortProbeCache.setEnabled(
    serverSettingsService.getSetting("gatewayServiceEffortDetection") ?? true,
  );
  await ClaudeGatewayProvider.configureGatewayServices({
    services: serverSettingsService.getSetting("gatewayServices") ?? [],
    defaultServiceId: serverSettingsService.getSetting(
      "defaultGatewayServiceId",
    ),
    disableAgent: serverSettingsService.getSetting("claudeGatewayDisableAgent"),
    disablePlanMode: serverSettingsService.getSetting(
      "claudeGatewayDisablePlanMode",
    ),
  });
  await syncGatewayServiceExports({
    services: serverSettingsService.getSetting("gatewayServices") ?? [],
    enabled:
      serverSettingsService.getSetting("gatewayServiceExportEnabled") ?? false,
  });
  const savedOllamaUrl = serverSettingsService.getSetting("ollamaUrl");
  const savedOllamaSystemPrompt =
    serverSettingsService.getSetting("ollamaSystemPrompt");
  const savedOllamaUseFullSystemPrompt =
    serverSettingsService.getSetting("ollamaUseFullSystemPrompt") ?? false;
  if (savedOllamaUrl) {
    ClaudeOllamaProvider.setOllamaUrl(savedOllamaUrl);
  }
  ClaudeOllamaProvider.setSystemPrompt(savedOllamaSystemPrompt);
  ClaudeOllamaProvider.setUseFullSystemPrompt(savedOllamaUseFullSystemPrompt);
  grokACPProvider.setAmbientXaiApiKey(config.ambientXaiApiKey);
  grokACPProvider.setUseAmbientXaiApiKey(
    serverSettingsService.getSetting("grokBuildUseXaiApiKey") ?? false,
  );

  // Warm configured model catalogs (non-blocking, best-effort).
  if (ClaudeGatewayProvider.isConfigured()) {
    modelInfoService.warmProvider("claude-gateway").catch(() => {});
  }
  if (
    ClaudeOllamaProvider.isExplicitlyConfigured() ||
    savedOllamaSystemPrompt ||
    savedOllamaUseFullSystemPrompt ||
    sessionMetadataService.hasRecordedProvider("claude-ollama")
  ) {
    modelInfoService.warmProvider("claude-ollama").catch(() => {});
  }

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
    listeners?: NetworkListenerControl;
  } = {};

  // Determine effective port for server-info (CLI override or saved setting)
  const effectiveServerPort = networkBindingService.getLocalhostPort();
  const effectiveLocalhostUrl = `${serverProtocol}://127.0.0.1:${effectiveServerPort}`;
  console.log(`Server URL: ${effectiveLocalhostUrl}`);

  // Detect ADB and create emulator bridge service (lazy start)
  const adbPath = await detectAdb();
  let deviceBridgeService: DeviceBridgeService | undefined;
  if (adbPath) {
    deviceBridgeService = new DeviceBridgeService({
      adbPath,
      dataDir: config.dataDir,
    });
    console.log(`[DeviceBridge] ADB detected at ${adbPath}`);
    if (deviceBridgeService.hasBinary()) {
      console.log(
        "[DeviceBridge] Sidecar binary found (will start on first use)",
      );
    } else {
      console.log(
        "[DeviceBridge] Sidecar binary not found (feature disabled until binary is available)",
      );
    }
  } else {
    console.log(
      "[DeviceBridge] ADB not found, device bridge streaming disabled",
    );
  }

  const persistedSpeechBackends =
    parseSpeechVoiceBackends(
      serverSettingsService.getSetting("speechVoiceBackends"),
    ) ?? [];
  const populatedSpeechBackends = unionSpeechVoiceBackends(
    persistedSpeechBackends,
    config.voiceBackends,
  );
  if (populatedSpeechBackends.join(",") !== persistedSpeechBackends.join(",")) {
    await serverSettingsService.updateSettings({
      speechVoiceBackends: populatedSpeechBackends,
    });
    console.log(
      `[Voice] Copied local backends from YEP_VOICE_BACKENDS into server settings: ${populatedSpeechBackends.join(", ")}`,
    );
  }
  const speechBackendOptions: SpeechRegistryInitOptions = {
    voiceInputEnabled: config.voiceInputEnabled,
    voiceBackends: [...config.voiceBackends, ...populatedSpeechBackends],
    deepgramApiKey: config.deepgramApiKey,
    xaiSttApiKey: config.xaiSttApiKey,
    whisperModel: config.whisperModel,
    whisperDevice:
      serverSettingsService.getSetting("speechWhisperGpu") === undefined
        ? config.whisperDevice
        : serverSettingsService.getSetting("speechWhisperGpu")
          ? "cuda"
          : "cpu",
    whisperComputeType: config.whisperComputeType,
    parakeetModel: config.parakeetModel,
    parakeetDevice: config.parakeetDevice,
    nemoModel: config.nemoModel,
    nemoDevice: config.nemoDevice,
    graniteModel: config.graniteModel,
    graniteDevice: config.graniteDevice,
    qwenModel: config.qwenModel,
    qwenDevice: config.qwenDevice,
  };
  const speechBackendRegistry = new SpeechBackendRegistry();
  const speechBackendInstallService = new SpeechBackendInstallService(
    async (id) => {
      speechBackendRegistry.revalidate(id);
      await speechBackendRegistry.waitForValidation();
    },
  );
  serverSettingsService.onSettingsChanged((next, previous) => {
    speechBackendOptions.whisperDevice =
      next.speechWhisperGpu === undefined
        ? config.whisperDevice
        : next.speechWhisperGpu
          ? "cuda"
          : "cpu";
    if (next.speechVoiceBackends === previous.speechVoiceBackends) return;
    void registerSpeechBackends(speechBackendRegistry, {
      ...speechBackendOptions,
      voiceBackends: [
        ...config.voiceBackends,
        ...unionSpeechVoiceBackends(next.speechVoiceBackends),
      ],
    }).catch((error) => {
      console.error("[Voice] Could not enable speech backends:", error);
    });
  });
  const requestedSpeechBackends =
    getRequestedSpeechBackendIds(speechBackendOptions);
  if (requestedSpeechBackends.length > 0) {
    console.log(
      `[Voice] Server-routed backends requested: ${requestedSpeechBackends.join(", ")}`,
    );
  }

  const savedIdleReapHours = serverSettingsService.getSetting("idleReapHours");
  const idleTimeoutMs =
    savedIdleReapHours === undefined
      ? config.idleTimeoutMs
      : idleReapHoursToMs(savedIdleReapHours);

  const publicServerId = readServerIdentity(discoverySqlite.getDatabase());
  const peerAccess = new PeerAccessManager(
    publicServerId,
    config.dataDir,
    (error) => console.error("[Peers] Lease retirement failed:", error),
    {
      runtimeControl: {
        envOverride:
          process.env.YEP_PEER_API_ENABLED === undefined
            ? undefined
            : config.peerApiEnabled,
      },
      identity: () =>
        localPeerHost(
          publicServerId,
          serverSettingsService.getSetting("hostIdentity")?.icon,
        ),
    },
  );
  const { retiredGrantId } = await peerAccess.initialize();
  if (retiredGrantId)
    await revokeHostedPeerAgentApiAccess(publicServerId, retiredGrantId);

  const {
    app,
    supervisor,
    scanner,
    readerFactory,
    claudeTranscripts,
    disposeSessionReaders,
    stopNotifications,
    glossaryIndexService,
    externalTracker,
    resolveAbsoluteFilePaths,
    limitedUsers: limitedUsersSrpLookup,
    authorizeSubscription,
    activityEventForIdentity,
    artifactServer,
    conversationSubscriptions,
    focusedSessionWatchManager,
    safeRestartService,
  } = createApp({
    peerAccess,
    externalSessionsEnabled: config.externalSessionsEnabled,
    getCatalogFamilies: () => installService.getCatalogFamilies(),
    artifacts: config.artifacts,
    provider: mockProvider,
    projectsDir: config.claudeProjectsDir,
    idleTimeoutMs,
    persistedAugmentDelayMs: readPerfPersistedAugmentDelayMs(),
    defaultPermissionMode: config.defaultPermissionMode,
    eventBus,
    // Note: uploadeWebSocket not passed yet - will be added below
    ...providerSessionWatchers.sourceObservationCallbacks(),
    notificationService,
    sessionMetadataService,
    onSuccessfulProviderSession: async (_sessionId, provider) => {
      await installService.recordSuccessfulProviders([provider]);
      providerSessionWatchers.requestActivation([
        providerCatalogFamily(provider),
      ]);
    },
    projectMetadataService,
    projectQueueService,
    sessionQueuePersistenceService,
    dirtyFileEditorService,
    sessionIndexService,
    sessionDiscoveryIndexRegistry,
    projectScanCacheTtlMs: config.projectScanCacheTtlMs,
    sessionAutoArchiveDays: config.sessionAutoArchiveDays,
    maxWorkers: config.maxWorkers,
    idlePreemptThresholdMs: config.idlePreemptThresholdMs,
    pushService,
    recentsService,
    authService,
    limitedUsersService,
    userUsageService,
    authDisabled: config.authDisabled,
    desktopAuthToken: config.desktopAuthToken,
    desktopBootstrapService,
    desktopRuntime: config.desktopRuntime,
    discoverySqlite,
    remoteAccessService,
    remoteSessionService,
    securityClientService,
    nativePushService,
    relayClientService,
    relayConfigCallbackHolder,
    // Note: frontendProxy not passed - will be added below
    serverHost: "127.0.0.1", // Always report localhost as main binding
    serverPort: effectiveServerPort,
    installId: installService.getInstallId(),
    dataDir: config.dataDir,
    attachmentStagingService,
    networkBindingService,
    networkBindingCallbackHolder,
    connectedBrowsers: connectedBrowsersService,
    browserProfileService,
    browserSettingsBackupService,
    limitedUserBrowserDefaultsService,
    serverSettingsService,
    sessionWakeSecret,
    getSessionWakeBaseUrl: (executor) =>
      config.sessionWakeBaseUrl ??
      (executor || tlsOptions
        ? undefined
        : `http://127.0.0.1:${networkBindingService.getLocalhostPort()}/`),
    getBrowserDebugConnection: (executor) => {
      if (config.sessionWakeBaseUrl) {
        return { baseUrl: config.sessionWakeBaseUrl };
      }
      if (executor) return undefined;
      return {
        baseUrl: `${serverProtocol}://127.0.0.1:${networkBindingService.getLocalhostPort()}/`,
        ...(tlsOptions
          ? { caCertificate: tlsOptions.cert.toString("utf8") }
          : {}),
      };
    },
    projectStoragePolicy,
    hostAwakeService,
    sharingService,
    publicShareService,
    deviceBridgeService,
    modelInfoService,
    enabledProviders: config.enabledProviders,
    claudeSummaryParserWorkerMode: config.claudeSummaryParserWorkerMode,
    codexSummaryParserWorkerMode: config.codexSummaryParserWorkerMode,
    codexCliPath: config.codexCliPath,
    codexPlanToolMode: config.codexPlanToolMode,
    codexCyberAccessProgram: config.codexCyberAccessProgram,
    voiceInputEnabled: config.voiceInputEnabled,
    speechBackendRegistry,
    envVoiceBackends: config.voiceBackends,
    speechBackendInstallService,
    xaiSttApiKey: config.xaiSttApiKey,
    shareXaiSttApiKeyWithClients: config.shareXaiSttApiKeyWithClients,
    allowedImagePaths: config.allowedImagePaths,
  });
  markStartup("app created");
  stopNotificationsForShutdown = stopNotifications;
  await artifactServer.configure(artifactServer.config);
  disposeAppForShutdown = disposeSessionReaders;

  const projectGlossarySubscriptionManager =
    new ProjectGlossarySubscriptionManager({
      scanner,
      glossaryIndexService,
    });
  projectGlossarySubscriptionsForShutdown = projectGlossarySubscriptionManager;
  const projectWorktreeSubscriptionManager =
    new ProjectWorktreeSubscriptionManager({
      scanner,
      enabled: serverSettingsService.getSetting(
        "liveWorktreeMonitoringEnabled",
      ),
    });
  serverSettingsService.onSettingsChanged((settings, previousSettings) => {
    if (
      settings.liveWorktreeMonitoringEnabled ===
      previousSettings.liveWorktreeMonitoringEnabled
    ) {
      return;
    }
    projectWorktreeSubscriptionManager.setEnabled(
      settings.liveWorktreeMonitoringEnabled,
    );
    void updateRelayConnection().catch((error) => {
      console.error(
        "[Relay] Failed to refresh live worktree capability advertisement:",
        error,
      );
    });
  });
  projectWorktreeSubscriptionsForShutdown = projectWorktreeSubscriptionManager;

  // Set service references for graceful shutdown
  supervisorForShutdown = supervisor;
  deviceBridgeForShutdown = deviceBridgeService ?? null;

  const hostedProviderRuntimes = await listHostedProviderRuntimes().catch(
    (error) => {
      console.error(
        "[ProviderRuntimeHost] Failed to list retained runtimes:",
        error,
      );
      return [];
    },
  );
  for (const runtime of hostedProviderRuntimes) {
    if (!runtime.sessionId) continue;
    try {
      await supervisor.reactivateSession(
        runtime.projectPath,
        runtime.sessionId,
        sessionMetadataService.getEffectiveLaunchSettings(runtime.sessionId)
          ?.permissionMode ?? runtime.reattach.permissionMode,
        {
          providerName: runtime.providerName,
          model: runtime.reattach.model,
          serviceTier: runtime.reattach.serviceTier,
          thinking: runtime.reattach.thinking,
          effort: runtime.reattach.effort,
          clientName: runtime.reattach.clientName,
          executor: runtime.reattach.executor,
          sandboxLevel: runtime.reattach.sandboxLevel,
          sandboxNetworkFirewall: runtime.reattach.sandboxNetworkFirewall,
          sandboxStateKey: runtime.reattach.sandboxStateKey,
        },
      );
      console.log(
        `[ProviderRuntimeHost] Reattached ${runtime.providerName} session ${runtime.sessionId}`,
      );
    } catch (error) {
      console.error(
        `[ProviderRuntimeHost] Failed to reattach session ${runtime.sessionId}:`,
        error,
      );
    }
  }
  markStartup("retained provider runtimes reattached");

  // Set up debug context for maintenance server
  setDebugContext({
    supervisor,
    claudeSessionsDir: config.claudeSessionsDir,
    getSessionSource: async (projectPath, sessionId) => {
      const identity = isYaSessionId(sessionId)
        ? sessionMetadataService.identities.resolveYa(sessionId)
        : undefined;
      if (identity && !identity.native) return null;
      const project = await scanner.getOrCreateProject(
        identity?.projectId ?? toUrlProjectId(projectPath),
      );
      if (
        !project ||
        !isClaudeProviderName(identity?.provider ?? project.provider)
      )
        return null;
      const bound = boundSessionSource(
        project,
        sessionId,
        { readerFactory },
        identity ? { kind: "stored", identity } : { kind: "legacy" },
      );
      if (bound === null) return null;
      const legacy = bound
        ? undefined
        : await resolveLegacySessionSource(
            {
              reader: readerFactory(project),
              provider: project.provider,
              sessionDir: project.sessionDir,
              kind: "primary",
            },
            sessionId,
            project,
            { readerFactory, identities: sessionMetadataService.identities },
          );
      return bound || legacy
        ? {
            reader: bound?.source.reader ?? legacy!.source.reader,
            nativeSessionId: bound?.nativeSessionId ?? legacy!.nativeSessionId,
            projectId: bound?.projectId ?? project.id,
          }
        : null;
    },
  });

  // Add upload routes with WebSocket support
  // These must be added BEFORE the frontend proxy catch-all
  const uploadRoutes = createUploadRoutes({
    scanner,
    upgradeWebSocket,
    maxUploadSizeBytes: config.maxUploadSizeBytes,
    attachmentStagingService,
    storagePolicy: projectStoragePolicy,
  });
  app.route("/api", uploadRoutes);
  markStartup("upload routes mounted");

  app.route(
    "/api/speech",
    createSpeechRoutes({
      speechBackendRegistry,
      upgradeWebSocket,
      dataDir: config.dataDir,
      serverSettingsService,
      xaiSttApiKey: config.xaiSttApiKey,
      shareXaiSttApiKeyWithClients: config.shareXaiSttApiKeyWithClients,
      envVoiceBackends: config.voiceBackends,
      speechBackendInstallService,
      safeRestartService,
    }),
  );
  markStartup("speech routes mounted");

  // Add WebSocket relay route for Phase 2b/2c/2d
  // This allows clients to make HTTP-like requests, subscriptions, and uploads over WebSocket
  const baseUrl = `${serverProtocol}://${config.host}:${config.port}`;
  const wsRelayUploadManager = new UploadManager({
    maxUploadSizeBytes: config.maxUploadSizeBytes,
    storagePolicy: projectStoragePolicy,
  });
  const wsRelayHandler = createWsRelayRoutes({
    conversationSubscriptions,
    upgradeWebSocket,
    app,
    baseUrl,
    supervisor,
    eventBus,
    uploadManager: wsRelayUploadManager,
    attachmentStagingService,
    remoteAccessService,
    remoteSessionService,
    securityClientService,
    sessionQueuePersistenceService,
    connectedBrowsers: connectedBrowsersService,
    browserProfileService,
    focusedSessionWatchManager,
    projectGlossarySubscriptionManager,
    projectWorktreeSubscriptionManager,
    deviceBridgeService,
    speechBackendRegistry,
    dataDir: config.dataDir,
    serverSettingsService,
    resolveAbsoluteFilePaths,
    limitedUsers: limitedUsersSrpLookup,
    authorizeSubscription,
    activityEventForIdentity,
  });
  app.get("/api/ws", wsRelayHandler);

  // Create relay connection handler for connections from relay server (Phase 7)
  // This accepts WebSocket connections that have already been upgraded at the relay
  const acceptRelayConnection = createAcceptRelayConnection({
    conversationSubscriptions,
    app,
    baseUrl,
    supervisor,
    eventBus,
    uploadManager: wsRelayUploadManager,
    attachmentStagingService,
    remoteAccessService,
    remoteSessionService,
    securityClientService,
    sessionQueuePersistenceService,
    connectedBrowsers: connectedBrowsersService,
    browserProfileService,
    focusedSessionWatchManager,
    projectGlossarySubscriptionManager,
    projectWorktreeSubscriptionManager,
    deviceBridgeService,
    speechBackendRegistry,
    dataDir: config.dataDir,
    serverSettingsService,
    resolveAbsoluteFilePaths,
    limitedUsers: limitedUsersSrpLookup,
    authorizeSubscription,
    activityEventForIdentity,
  });
  markStartup("relay accept handler configured");

  // Function to start/restart relay client with current config
  async function updateRelayConnection() {
    const relayConfig = remoteAccessService.getActiveRelayConfig();
    if (relayConfig?.url && relayConfig?.username) {
      const compatibility = await getServerCompatibilityInfo({
        browserSettingsBackupAvailable: true,
        securityClientAuditAvailable: true,
        nativePush: nativePushService.version(),
        getDeviceBridgeState: () => {
          if (!deviceBridgeService) return "unavailable";
          return deviceBridgeService.hasBinary() ? "available" : "downloadable";
        },
        isDeviceBridgeEnabled: () =>
          serverSettingsService.getSetting("deviceBridgeEnabled") ?? false,
        providerHostControlAvailable: isProviderRuntimeHostAvailable(),
        isLiveWorktreeMonitoringEnabled: () =>
          serverSettingsService.getSetting("liveWorktreeMonitoringEnabled"),
      });
      relayClientService.start({
        relayUrl: relayConfig.url,
        username: relayConfig.username,
        installId: installService.getInstallId(),
        appVersion: compatibility.appVersion,
        resumeProtocolVersion: compatibility.resumeProtocolVersion,
        renderProtocolVersion: compatibility.renderProtocolVersion,
        remoteCompatibilityLevel: compatibility.remoteCompatibilityLevel,
        capabilities: compatibility.capabilities,
        onRelayConnection: acceptRelayConnection,
        onStatusChange: (status) => {
          console.log(`[Relay] Status: ${status}`);
        },
      });
      if (speechBackendRegistry.enabledIds().length > 0) {
        relaySpeechClientService.start({
          relayUrl: relayConfig.url,
          username: relayConfig.username,
          installId: installService.getInstallId(),
          channel: SPEECH_RELAY_CHANNEL,
          appVersion: compatibility.appVersion,
          resumeProtocolVersion: compatibility.resumeProtocolVersion,
          renderProtocolVersion: compatibility.renderProtocolVersion,
          remoteCompatibilityLevel: compatibility.remoteCompatibilityLevel,
          capabilities: compatibility.capabilities,
          onRelayConnection: acceptRelayConnection,
          onStatusChange: (status) => {
            console.log(`[Relay speech] Status: ${status}`);
          },
        });
      } else {
        relaySpeechClientService.stop();
      }
    } else {
      relayClientService.stop();
      relaySpeechClientService.stop();
    }
  }

  // Wire up the callback for relay config changes from API routes
  relayConfigCallbackHolder.callback = updateRelayConnection;

  let speechBackendInitializationStarted = false;
  function startSpeechBackendInitialization(): void {
    if (
      speechBackendInitializationStarted ||
      requestedSpeechBackends.length === 0
    ) {
      return;
    }
    speechBackendInitializationStarted = true;
    console.log(
      `[Voice] Initializing server-routed backends after health is available: ${requestedSpeechBackends.join(", ")}`,
    );
    void registerSpeechBackends(speechBackendRegistry, speechBackendOptions)
      .then(async () => {
        const enabledSpeechBackends = speechBackendRegistry.enabledIds();
        if (enabledSpeechBackends.length > 0) {
          console.log(
            `[Voice] Enabled server-routed backends: ${enabledSpeechBackends.join(", ")}`,
          );
        }
        await updateRelayConnection();
      })
      .catch((error) => {
        const message =
          error instanceof Error ? error.message : String(error ?? "unknown");
        console.error(`[Voice] Backend initialization failed: ${message}`);
      });
  }

  // Start relay connection on boot if configured
  await updateRelayConnection();
  markStartup("relay connection update completed");

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
  markStartup("frontend routes configured");

  // Add frontend proxy as the final catch-all (AFTER all API routes including uploads)
  if (frontendProxy) {
    const proxy = frontendProxy;
    app.all("*", (c) => {
      const { incoming, outgoing } = c.env;
      if (!incoming || !outgoing) {
        return c.text("Not found", 404);
      }
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

  // Helper to create a server with WebSocket support
  function createServer(
    port: number,
    hostname: string,
    onReady?: (info: { port: number }) => void,
    options?: { fatalOnError?: boolean },
  ): ReturnType<typeof serve> {
    const { fatalOnError = false } = options ?? {};
    // Each listener owns its WebSocket server: closing an old network binding
    // must not close admission on another listener's sockets.
    const wss = new WebSocketServer({ noServer: true });
    configureInboundWebSocketMessageLimit(wss);
    const server = tlsOptions
      ? serve(
          {
            fetch: app.fetch,
            websocket: { server: wss },
            port,
            hostname,
            createServer: createHttpsServer,
            serverOptions: tlsOptions,
          },
          onReady,
        )
      : serve(
          { fetch: app.fetch, websocket: { server: wss }, port, hostname },
          onReady,
        );

    server.on("error", (error: unknown) => {
      const err = error as NodeJS.ErrnoException;
      const listenUrl = `${serverProtocol}://${hostname}:${port}`;
      console.error(
        `[Server] Failed to bind ${listenUrl}: ${err.message ?? "Unknown error"}`,
      );
      if (err.code === "EADDRINUSE") {
        console.error(
          `[Server] Port ${port} is already in use. Stop the existing process or run with a different PORT.`,
        );
      }
      if (fatalOnError) {
        process.exit(1);
      }
    });

    attachUnifiedUpgradeHandler(server, {
      peerUpgrade: (request, socket, head) =>
        peerAccess?.handleUpgrade(request, socket, head) ?? false,
      appUpgrade: (request, socket, head) =>
        artifactServer.handleUpgrade(request, socket, head),
      frontendProxy,
      isApiPath: (urlPath) => urlPath.startsWith("/api"),
    });
    return server;
  }

  // The listening sockets. A change binds its new sockets before releasing
  // the old ones and never exits on failure (topics/connection-safe-settings.md).
  const networkListeners = new NetworkListeners({
    create: ({ host, port }, { fatalOnError, onReady }) =>
      createServer(port, host, onReady, { fatalOnError }),
    onBound: (address) => {
      console.log(
        `Server URL: ${serverProtocol}://${formatListenerAddress(address)}`,
      );
      console.log(
        `[NetworkBinding] Listening on ${formatListenerAddress(address)}`,
      );
    },
  });

  // The network socket to start with: --host, else saved settings (the
  // saved socket is ignored while --host overrides it). A missing saved port
  // follows the loopback port.
  const cliNetworkHost =
    config.cliHostOverride &&
    config.host !== "127.0.0.1" &&
    config.host !== "localhost"
      ? config.host
      : null;
  const networkConfig = networkBindingService.getNetworkConfig();
  const savedNetworkHost =
    networkConfig.enabled &&
    networkConfig.host &&
    !networkBindingService.isNetworkOverridden()
      ? networkConfig.host
      : null;
  const startupNetworkHost = cliNetworkHost ?? savedNetworkHost;
  const startupNetworkPort = cliNetworkHost ? null : networkConfig.port;

  // Create the main localhost server
  const expectedServerUrl = `${serverProtocol}://127.0.0.1:${effectivePort}`;
  console.log(`[Server] Starting on ${expectedServerUrl}`);
  let desktopReadySent = false;
  // Readiness runs once the socket serving loopback listens; a wildcard
  // network socket on the loopback port is that socket, never replaced later.
  const startupReady = (info: { port: number }) => {
    markStartup("localhost server onReady");
    providerSessionWatchers.requestActivation(
      installService.getCatalogFamilies(),
    );
    void reportDevWrapperListening({
      host: "127.0.0.1",
      port: info.port,
    }).catch((error) => {
      console.error(
        "[DevWrapper] Failed to report acquired localhost bind:",
        error,
      );
    });
    // Write port to file if requested (for test harnesses)
    if (config.portFile) {
      fs.writeFileSync(config.portFile, String(info.port));
    }

    const serverUrl = `${serverProtocol}://127.0.0.1:${info.port}`;
    if (desktopBootstrapService && !desktopReadySent) {
      desktopReadySent = true;
      process.stdout.write(
        `YEP_DESKTOP_READY ${JSON.stringify({
          protocol: DESKTOP_BOOTSTRAP_PROTOCOL_VERSION,
          port: info.port,
        })}\n`,
      );
    }
    console.log(`Server URL: ${serverUrl}`);
    console.log(`Server running at ${serverUrl}`);
    console.log(`Projects dir: ${config.claudeProjectsDir}`);
    console.log(`Permission mode: ${config.defaultPermissionMode}`);
    startSpeechBackendInitialization();

    if (config.openBrowser) {
      const platform = os.platform();
      let cmd: string;
      let args: string[];
      if (platform === "darwin") {
        cmd = "open";
        args = [serverUrl];
      } else if (platform === "win32") {
        cmd = "cmd";
        args = ["/c", "start", "", serverUrl];
      } else {
        // Detect WSL: use cmd.exe to open in Windows browser
        let isWsl = false;
        try {
          isWsl = fs
            .readFileSync("/proc/version", "utf-8")
            .toLowerCase()
            .includes("microsoft");
        } catch {}
        if (isWsl) {
          cmd = "cmd.exe";
          args = ["/c", "start", "", serverUrl];
        } else {
          cmd = "xdg-open";
          args = [serverUrl];
        }
      }
      execFile(cmd, args, (err) => {
        if (err) {
          console.warn(`Could not open browser: ${err.message}`);
        }
      });
    }

    // Notify all connected clients that the backend has restarted
    // This allows other tabs to clear their "reload needed" banner
    eventBus.emit({
      type: "backend-reloaded",
      timestamp: new Date().toISOString(),
    });
  };
  await networkListeners.start(
    effectivePort,
    startupReady,
    startupNetworkHost
      ? { host: startupNetworkHost, port: startupNetworkPort ?? effectivePort }
      : null,
  );

  if (startupNetworkHost && !networkListeners.current().network) {
    const { localhostPort } = networkListeners.current();
    const bound = await networkListeners.apply({
      localhostPort,
      network: {
        host: startupNetworkHost,
        port: startupNetworkPort ?? localhostPort,
      },
    });
    if (!bound.success)
      console.error(
        `[NetworkBinding] ${cliNetworkHost ? "--host" : "Saved network"} socket not bound: ${bound.error}`,
      );
    markStartup(
      cliNetworkHost
        ? "network socket bound from CLI override"
        : "network socket bound from settings",
    );
  }

  // Routes change the listeners only once startup has finished binding them.
  networkBindingCallbackHolder.listeners = networkListeners;

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
      getDiagnostics: () => ({
        caches: {
          claudeTranscript: claudeTranscripts.getStats(),
          codexEntries: codexEntryCacheBudget.getStats(),
          markdownAugments: markdownAugmentCacheDiagnostics(),
          projectPaths: projectPathCacheDiagnostics(),
          highlightWorker: highlightWorker.getStats(),
        },
        relay: {
          responseSerialization: relayResponseSerializationDiagnostics(),
        },
        background: {
          providerSessionWatchers: providerSessionWatchers.getDiagnostics(),
          externalSessionTracker: externalTracker?.getDiagnostics() ?? null,
          liveWorktree: projectWorktreeSubscriptionManager.diagnostics(),
        },
      }),
    });
    markStartup("maintenance server started");
  }

  const totalStartupMs = Date.now() - startupStart;
  console.log(`[Startup] completed in ${totalStartupMs}ms`);
  console.log("[Startup] Timing summary:");
  for (const timing of startupTimings) {
    console.log(
      `- ${timing.phase}: +${timing.deltaMs}ms (total ${timing.elapsedMs}ms)`,
    );
  }
}

startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
