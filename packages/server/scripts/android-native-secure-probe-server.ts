import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { createApp } from "../src/app.js";
import { AuthService } from "../src/auth/AuthService.js";
import { attachUnifiedUpgradeHandler } from "../src/frontend/index.js";
import { RemoteSessionService } from "../src/remote-access/RemoteSessionService.js";
import { RemoteAccessService } from "../src/remote-access/index.js";
import { RelayClientService } from "../src/services/RelayClientService.js";
import { SecurityClientService } from "../src/services/SecurityClientService.js";
import {
  createAcceptRelayConnection,
  createWsRelayRoutes,
} from "../src/routes/ws-relay.js";
import { MockClaudeSDK } from "../src/sdk/mock.js";
import { UploadManager } from "../src/uploads/manager.js";
import { InstallService } from "../src/services/InstallService.js";
import { EventBus } from "../src/watcher/index.js";

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

// Optional native-provider history for the Compose conversation AVD proof.
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

const {
  app,
  supervisor,
  conversationSubscriptions,
  disposeSessionReaders,
  stopNotifications,
} = createApp({
  dataDir,
  getCatalogFamilies: () => install.getCatalogFamilies(),
  sdk: new MockClaudeSDK(),
  projectsDir,
  codexSessionsDir,
  geminiSessionsDir,
  grokSessionsDir,
  piSessionsDir,
  eventBus,
  authService,
  authDisabled: true,
  securityClientService,
});
const { upgradeWebSocket, wss } = createNodeWebSocket({ app });
const uploadManager = new UploadManager({ uploadsDir: join(root, "uploads") });
const wsHandler = createWsRelayRoutes({
  upgradeWebSocket,
  app,
  baseUrl: `http://127.0.0.1:${requestedPort}`,
  supervisor,
  eventBus,
  uploadManager,
  remoteAccessService,
  remoteSessionService,
  securityClientService,
  conversationSubscriptions,
});
app.get("/api/ws", wsHandler);
if (conversationProbe) {
  // Only this disposable loopback diagnostic server mounts fixture controls.
  app.post("/__probe/append", async (c) => {
    const message = `Live preview response ${rowCount + 2}`;
    await appendFile(nativePath, row("Live preview request") + row(message));
    return c.json({ ok: true, message });
  });
  app.post("/__probe/disconnect", (c) => {
    for (const socket of wss.clients) socket.close(1012, "Probe reconnect");
    return c.json({ ok: true });
  });
}

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
  });
  relayClientService.start({
    relayUrl,
    username,
    installId: "android-native-probe-install",
    onRelayConnection: acceptRelayConnection,
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
    ({ port }) => {
      console.log(
        `YA_NATIVE_PROBE_READY ${JSON.stringify({ port, username, data: "temporary" })}`,
      );
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

await new Promise<void>((resolveStop) => {
  process.once("SIGINT", resolveStop);
  process.once("SIGTERM", resolveStop);
});

stopNotifications();
await disposeSessionReaders();
await securityClientService.shutdown();
remoteSessionService.shutdown();
relayClientService?.stop();
await new Promise<void>((resolveClosed) =>
  server!.close(() => resolveClosed()),
);
wss.close();
await rm(root, { recursive: true, force: true });
