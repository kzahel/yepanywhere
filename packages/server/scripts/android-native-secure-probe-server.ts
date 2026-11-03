import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { serve, type HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { createApp } from "../src/app.js";
import { AuthService } from "../src/auth/AuthService.js";
import { attachUnifiedUpgradeHandler } from "../src/frontend/index.js";
import { RemoteSessionService } from "../src/remote-access/RemoteSessionService.js";
import { RemoteAccessService } from "../src/remote-access/index.js";
import { RelayClientService } from "../src/services/RelayClientService.js";
import { SecurityClientService } from "../src/services/SecurityClientService.js";
import { NativePushService } from "../src/push/NativePushService.js";
import { PushService } from "../src/push/PushService.js";
import {
  createAcceptRelayConnection,
  createWsRelayRoutes,
} from "../src/routes/ws-relay.js";
import { ScriptedClaudeProvider } from "../test/support/scripted-provider.js";
import { UploadManager } from "../src/uploads/manager.js";
import { InstallService } from "../src/services/InstallService.js";
import { EventBus, FileWatcher } from "../src/watcher/index.js";
import { AttachmentStagingService } from "../src/uploads/AttachmentStagingService.js";
import { ServerSettingsService } from "../src/services/ServerSettingsService.js";
import { ProjectQueueService } from "../src/services/ProjectQueueService.js";
import { RecentsService } from "../src/recents/RecentsService.js";
import { ProjectGlossarySubscriptionManager } from "../src/projects/projectGlossarySubscriptionManager.js";
import { SessionMetadataService } from "../src/metadata/SessionMetadataService.js";
import { DiscoverySqliteService } from "../src/storage/discovery-sqlite.js";

const username = process.env.YA_NATIVE_PROBE_USERNAME;
const password = process.env.YA_NATIVE_PROBE_PASSWORD;
const requestedPort = Number.parseInt(
  process.env.YA_NATIVE_PROBE_PORT ?? "38901",
  10,
);
const relayUrl = process.env.YA_NATIVE_PROBE_RELAY_URL;

if (!username || !/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(username)) {
  throw new Error(
    "YA_NATIVE_PROBE_USERNAME must be a valid 3-32 character SRP identity",
  );
}
if (!password || password.length < 8) {
  throw new Error(
    "YA_NATIVE_PROBE_PASSWORD must contain at least 8 characters",
  );
}
if (
  !Number.isSafeInteger(requestedPort) ||
  requestedPort < 1024 ||
  requestedPort > 65535
) {
  throw new Error("YA_NATIVE_PROBE_PORT must be an unprivileged TCP port");
}

const root = await mkdtemp(join(tmpdir(), "ya-android-native-probe-"));
const projectsDir = join(root, "projects");
const codexSessionsDir = join(root, "codex-sessions");
const geminiSessionsDir = join(root, "gemini-sessions");
const grokSessionsDir = join(root, "grok-sessions");
const piSessionsDir = join(root, "pi-sessions");
const dataDir = join(root, "data");
await mkdir(projectsDir, { recursive: true });
await mkdir(codexSessionsDir, { recursive: true });
await mkdir(geminiSessionsDir, { recursive: true });
await mkdir(grokSessionsDir, { recursive: true });
await mkdir(piSessionsDir, { recursive: true });
await mkdir(dataDir, { recursive: true });

// Optional provider history for native-core and bundled-web integration proofs.
const conversationProbe = process.env.YA_NATIVE_PROBE_CONVERSATION === "true";
const sessionId = "android-preview-session";
const projectPath = join(root, "preview-project");
const nativeDir = join(
  projectsDir,
  hostname(),
  projectPath.replace(/[^a-zA-Z0-9]/g, "-"),
);
const nativePath = join(nativeDir, `${sessionId}.jsonl`);
let rowCount = 0;
function row(text: string) {
  const index = rowCount++;
  const role = index % 2 === 0 ? "user" : "assistant";
  return (
    JSON.stringify({
      type: role,
      uuid: `preview-${index}`,
      parentUuid: index ? `preview-${index - 1}` : null,
      sessionId,
      cwd: projectPath,
      timestamp: new Date(Date.now() - (100 - index) * 1000).toISOString(),
      message: { role, content: [{ type: "text", text }] },
    }) + "\n"
  );
}
const install = new InstallService({ dataDir });
await install.initialize();
if (conversationProbe) {
  await mkdir(projectPath, { recursive: true });
  const streamFile = join(projectPath, "native-stream.bin");
  await writeFile(streamFile, "");
  const streamBlock = Buffer.alloc(1024 * 1024, 171);
  for (let i = 0; i < 40; i++) await appendFile(streamFile, streamBlock);
  await mkdir(nativeDir, { recursive: true });
  await writeFile(
    nativePath,
    Array.from({ length: 50 }, (_, i) =>
      row(
        i === 0 ? "Android conversation fixture" : `Preview message ${i + 1}`,
      ),
    ).join(""),
  );
  await install.recordSuccessfulProviders(["claude"]);
}

const eventBus = new EventBus();
const watcher = conversationProbe
  ? new FileWatcher({ watchDir: projectsDir, provider: "claude", eventBus })
  : null;
watcher?.start();
await watcher?.waitForInitialBaseline();
const authService = new AuthService({
  dataDir,
  cookieSecret: "android-native-probe-cookie-secret",
});
await authService.initialize();

const remoteAccessService = new RemoteAccessService({ dataDir });
await remoteAccessService.initialize();
// The production state model currently stores SRP identity with relay config.
// Direct-only runs supply the value without starting RelayClientService. An
// explicitly supplied test relay URL enables the separate legacy-relay proof.
await remoteAccessService.setRelayConfig({
  url: relayUrl ?? "wss://unused.invalid/ws",
  username,
});
await remoteAccessService.configure(password);

const remoteSessionService = new RemoteSessionService({ dataDir });
await remoteSessionService.initialize();
const securityClientService = new SecurityClientService({
  dataDir,
  remoteSessionService,
});
await securityClientService.initialize();
const nativePushService = new NativePushService(securityClientService);
const pushService = new PushService({ dataDir });
await pushService.initialize();
pushService.setNativePushService(nativePushService);
const attachmentStagingService = new AttachmentStagingService({
  dataDir,
  maxUploadSizeBytes: 100 * 1024 * 1024,
});
const serverSettingsService = new ServerSettingsService({ dataDir });
const projectQueueService = new ProjectQueueService({
  dataDir,
  eventBus,
  attachmentStagingService,
});
const recentsService = new RecentsService({ dataDir });
const discoverySqlite = new DiscoverySqliteService({ dataDir });
const sessionMetadataService = new SessionMetadataService({
  dataDir,
  database: discoverySqlite.getDatabase(),
});
await Promise.all([
  attachmentStagingService.initialize(),
  serverSettingsService.initialize(),
  projectQueueService.initialize(),
  recentsService.initialize(),
  sessionMetadataService.initialize(),
]);

// Use the same upgrade function for the full HTTP app and the native socket.
// createApp mounts staging validation/materialization with its upload routes.
const app = new Hono<{ Bindings: HttpBindings }>();
const { upgradeWebSocket, wss } = createNodeWebSocket({ app });
const {
  app: yaApp,
  supervisor,
  conversationSubscriptions,
  disposeSessionReaders,
  stopNotifications,
  focusedSessionWatchManager,
  scanner,
  glossaryIndexService,
} = createApp({
  dataDir,
  discoverySqlite,
  getCatalogFamilies: () => install.getCatalogFamilies(),
  provider: new ScriptedClaudeProvider(),
  projectsDir,
  codexSessionsDir,
  geminiSessionsDir,
  grokSessionsDir,
  piSessionsDir,
  eventBus,
  authService,
  authDisabled: true,
  securityClientService,
  nativePushService,
  pushService,
  remoteAccessService,
  remoteSessionService,
  attachmentStagingService,
  serverSettingsService,
  projectQueueService,
  recentsService,
  sessionMetadataService,
  upgradeWebSocket,
  maxUploadSizeBytes: 100 * 1024 * 1024,
});
const projectGlossarySubscriptionManager =
  new ProjectGlossarySubscriptionManager({ scanner, glossaryIndexService });
// Pad a real API response without burdening transcript rendering or adding a
// production endpoint. This crosses the encrypted circuit and the WebView.
// A test-controlled response delay keeps API requests in flight while a probe
// drops the socket, so reconnect handling of pending requests is deterministic.
let apiDelayMs = 0;
let delayedRequests = 0;
let delayedValidationRequests = 0;
app.use("/api/*", async (c, next) => {
  if (apiDelayMs > 0 && c.req.path !== "/api/ws") {
    delayedRequests++;
    const validation =
      /^\/api\/attachments\/staging\/drafts\/[^/]+\/validate$/.test(c.req.path);
    if (validation) delayedValidationRequests++;
    try {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, apiDelayMs));
    } finally {
      delayedRequests--;
      if (validation) delayedValidationRequests--;
    }
  }
  await next();
});
app.get("/api/version", async (c) => {
  const response = await yaApp.fetch(c.req.raw, c.env);
  if (!conversationProbe || !response.ok) return response;
  const body = await response.json();
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(
    JSON.stringify({ ...body, __nativeProbePadding: "x".repeat(1024 * 1024) }),
    { status: response.status, headers },
  );
});
app.route("/", yaApp);
const uploadManager = new UploadManager({ uploadsDir: join(root, "uploads") });
// A bounded test-controlled pause makes switching during a real resume
// deterministic. Only the disposable probe exposes this handshake gate.
let holdResume = false;
let heldResumes = 0;
const resumeWaiters = new Set<() => void>();
function releaseResumes() {
  holdResume = false;
  for (const release of resumeWaiters) release();
  resumeWaiters.clear();
}
// A test-controlled outage refuses every new socket, as when a phone's network
// is still down after waking, so reconnect attempts fail instead of waiting.
let outage = false;
const wsHandler = createWsRelayRoutes({
  upgradeWebSocket: (createEvents) =>
    upgradeWebSocket((context) => {
      const events = createEvents(context);
      return {
        ...events,
        onOpen: (event, ws) => {
          if (outage) {
            ws.close(1013, "Probe outage");
            return;
          }
          return events.onOpen?.(event, ws);
        },
        onMessage: async (event, ws) => {
          if (outage) return;
          if (
            holdResume &&
            typeof event.data === "string" &&
            JSON.parse(event.data).type === "srp_resume_init"
          ) {
            heldResumes += 1;
            await new Promise<void>((resolveResume) => {
              const timer = setTimeout(release, 15_000);
              function release() {
                clearTimeout(timer);
                resumeWaiters.delete(release);
                resolveResume();
              }
              resumeWaiters.add(release);
            });
          }
          return events.onMessage?.(event, ws);
        },
      };
    }),
  app,
  baseUrl: `http://127.0.0.1:${requestedPort}`,
  supervisor,
  eventBus,
  uploadManager,
  remoteAccessService,
  remoteSessionService,
  securityClientService,
  conversationSubscriptions,
  focusedSessionWatchManager,
  projectGlossarySubscriptionManager,
  attachmentStagingService,
  serverSettingsService,
});
app.get("/api/ws", wsHandler);
if (conversationProbe) {
  // Only this disposable loopback diagnostic server mounts fixture controls.
  app.post("/__probe/push", async (c) => {
    const result = await pushService.sendToAll({
      type: "session-halted",
      timestamp: new Date().toISOString(),
      sessionId,
      projectId: Buffer.from(projectPath).toString("base64url"),
      projectName: "Private native push fixture",
      reason: "completed",
      duration: 1,
    });
    return c.json({
      sent: result.filter((row) => row.success).length,
      failed: result.filter((row) => !row.success).length,
      sessionId,
    });
  });
  app.post("/__probe/append", async (c) => {
    const message = `Live preview response ${rowCount + 2}`;
    await appendFile(nativePath, row("Live preview request") + row(message));
    return c.json({ ok: true, message });
  });
  app.post("/__probe/resume-hold", (c) => {
    if (c.req.query("enabled") === "true") {
      holdResume = true;
      heldResumes = 0;
    } else releaseResumes();
    return c.json({ heldResumes });
  });
  app.get("/__probe/resume-hold", (c) => c.json({ heldResumes }));
  app.post("/__probe/api-delay", (c) => {
    apiDelayMs = Math.min(Math.max(Number(c.req.query("ms")) || 0, 0), 15_000);
    return c.json({ apiDelayMs });
  });
  app.get("/__probe/status", (c) =>
    c.json({
      apiDelayMs,
      delayedRequests,
      delayedValidationRequests,
      heldResumes,
      outage,
    }),
  );
  app.post("/__probe/outage", (c) => {
    outage = c.req.query("enabled") === "true";
    if (outage)
      for (const socket of wss.clients) socket.close(1013, "Probe outage");
    return c.json({ outage });
  });
  app.post("/__probe/disconnect", (c) => {
    for (const socket of wss.clients) socket.close(1012, "Probe reconnect");
    return c.json({ ok: true });
  });
}

let resolveRelayReady: () => void = () => {};
const relayReady = relayUrl
  ? new Promise<void>((resolve) => {
      resolveRelayReady = resolve;
    })
  : Promise.resolve();
const relayClientService = relayUrl ? new RelayClientService() : null;
if (relayClientService) {
  const acceptRelayConnection = createAcceptRelayConnection({
    app,
    baseUrl: `http://127.0.0.1:${requestedPort}`,
    supervisor,
    eventBus,
    uploadManager,
    remoteAccessService,
    remoteSessionService,
    securityClientService,
    conversationSubscriptions,
    focusedSessionWatchManager,
    projectGlossarySubscriptionManager,
    attachmentStagingService,
    serverSettingsService,
  });
  relayClientService.start({
    relayUrl,
    username,
    installId: "android-native-probe-install",
    onRelayConnection: acceptRelayConnection,
    onStatusChange: (status) => {
      if (status === "waiting") resolveRelayReady();
    },
  });
}

let server: ReturnType<typeof serve>;
await new Promise<void>((resolveReady) => {
  server = serve(
    {
      fetch: app.fetch,
      hostname: "127.0.0.1",
      port: requestedPort,
    },
    () => {
      resolveReady();
    },
  );
});
attachUnifiedUpgradeHandler(server!, {
  frontendProxy: undefined,
  isApiPath: (path) => path.startsWith("/api"),
  app,
  wss,
});

// The fixture runner already bounds startup. A listening HTTP port alone does
// not mean a public-relay phone can pair with this freshly registered host.
await relayReady;
console.log(
  `YA_NATIVE_PROBE_READY ${JSON.stringify({ port: requestedPort, username, data: "temporary" })}`,
);

await new Promise<void>((resolveStop) => {
  process.once("SIGINT", resolveStop);
  process.once("SIGTERM", resolveStop);
});

releaseResumes();
stopNotifications();
watcher?.stop();
projectGlossarySubscriptionManager.dispose();
await disposeSessionReaders();
nativePushService.shutdown();
await securityClientService.shutdown();
remoteSessionService.shutdown();
relayClientService?.stop();
await new Promise<void>((resolveClosed) =>
  server!.close(() => resolveClosed()),
);
wss.close();
await rm(root, { recursive: true, force: true });
