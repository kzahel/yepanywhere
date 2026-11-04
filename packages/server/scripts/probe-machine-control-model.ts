import { createStaticRoutes } from "../src/frontend/static.js";
import { createApp } from "../src/app.js";
import { EventBus } from "../src/watcher/index.js";
import { createWsRelayRoutes } from "../src/routes/ws-relay.js";
import { UploadManager } from "../src/uploads/manager.js";
import { serve } from "@hono/node-server";
import { upgradeWebSocket } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { createMachineControlMediaBrowser } from "../../client/scripts/machine-control-media-browser.js";
import type { MachineControlMediaBrowser } from "../../client/scripts/machine-control-media-browser.js";
import type { AppResult } from "../src/app.js";
import type { ServerType } from "@hono/node-server";
/** Explicit real-provider smoke; offline CLI discovery and fixture image only. */
import { strict as assert } from "node:assert";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CodexProvider } from "../src/sdk/providers/codex.js";

import { getDefaultCodexHomeDir } from "../src/projects/codex-scanner.js";

import type { Process } from "../src/supervisor/Process.js";
import { encodeProjectId } from "../src/supervisor/types.js";
import type { ContentBlock, SDKMessage } from "../src/sdk/types.js";

const { values } = parseArgs({
  options: {
    app: { type: "string" },
    publisher: { type: "string" },
    capture: { type: "string" },
    model: { type: "string" },
    "expected-button": { type: "string", default: "Change site icon" },
    browser: { type: "boolean", default: false },
    "client-dist": { type: "string" },
    "browser-executable": { type: "string" },
    "capture-output": { type: "string" },
    "codex-executable": { type: "string" },
  },
});
assert(
  values.app && values.capture,
  "--app and --capture fixture PNG are required",
);
assert(
  (await stat(values.capture)).size <= 8 * 1024 * 1024,
  "Bounded fixture capture required",
);
const expectedButton = values["expected-button"];
assert(
  expectedButton && expectedButton.length <= 80,
  "Bounded expected fixture label required",
);
const captureSize = (await stat(values.capture)).size;
const temporary = await mkdtemp(join(tmpdir(), "ya-mc-provider-smoke-"));
const cwd = join(temporary, "project");
await mkdir(cwd);
const capturePath = join(cwd, "browser.png");
await copyFile(values.capture, capturePath);
const captureBytes = await readFile(capturePath);
const codexHome = join(temporary, "codex");
const provider = new CodexProvider({
  codexHome,
  codexPath: values["codex-executable"],
});
const eventBus = new EventBus();
let full: AppResult | undefined;
let server: ServerType | undefined;
let browser: MachineControlMediaBrowser | undefined;
let disposeSockets: (() => Promise<void>) | undefined;
const messages: SDKMessage[] = [];
let session: Process | undefined;
let unsubscribe: (() => void) | undefined;
let timeout: ReturnType<typeof setTimeout> | undefined;
const failures: unknown[] = [];
function createProbeApp() {
  return createApp({
    provider,
    eventBus,
    dataDir: join(temporary, "data"),
    projectsDir: join(temporary, "empty-claude"),
    codexSessionsDir: join(codexHome, "sessions"),
    geminiSessionsDir: join(temporary, "empty-gemini"),
    grokSessionsDir: join(temporary, "empty-grok"),
    piSessionsDir: join(temporary, "empty-pi"),
    enabledProviders: ["codex"],
    voiceInputEnabled: false,
    getLatestVersion: async () => null,
    authDisabled: true,
    codexSummaryParserWorkerMode: "off",
  });
}
async function closeBackend() {
  await disposeSockets?.();
  disposeSockets = undefined;
  if (server) {
    const ownedServer = server;
    server = undefined;
    if ("closeAllConnections" in ownedServer) ownedServer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      ownedServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
async function bindBrowserBackend(port = 0) {
  assert(full);
  const supervisor = full.supervisor;
  const wss = new WebSocketServer({ noServer: true });
  disposeSockets = async () => {
    for (const client of wss.clients) client.close(1000);
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  };
  full.app.get(
    "/api/ws",
    createWsRelayRoutes({
      app: full.app,
      baseUrl: "http://127.0.0.1",
      supervisor,
      eventBus,
      uploadManager: new UploadManager(),
      upgradeWebSocket,
      conversationSubscriptions: full.conversationSubscriptions,
      focusedSessionWatchManager: full.focusedSessionWatchManager,
      resolveAbsoluteFilePaths: full.resolveAbsoluteFilePaths,
      authorizeSubscription: full.authorizeSubscription,
      activityEventForIdentity: full.activityEventForIdentity,
    }),
  );
  if (values["client-dist"])
    full.app.route(
      "/",
      createStaticRoutes({ distPath: values["client-dist"] }),
    );
  server = serve({
    fetch: full.app.fetch,
    websocket: { server: wss },
    port,
    hostname: "127.0.0.1",
  });
  await new Promise<void>((resolve, reject) => {
    server?.once("listening", () => resolve());
    server?.once("error", reject);
  });
  const address = server.address();
  assert(
    address && typeof address !== "string",
    "Owned loopback listener required",
  );
  return address.port;
}
try {
  // Retain the operator's authentication/endpoint choices, while keeping this
  // bounded probe's provider history and state out of their normal profile.
  await mkdir(codexHome, { mode: 0o700 });
  for (const name of ["auth.json", "config.toml"]) {
    const destination = join(codexHome, name);
    try {
      await copyFile(join(getDefaultCodexHomeDir(), name), destination);
      await chmod(destination, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  full = createProbeApp();
  const supervisor = full.supervisor;
  let browserPort: number | undefined;
  if (values.browser) {
    browserPort = await bindBrowserBackend();
    browser = await createMachineControlMediaBrowser(
      `http://127.0.0.1:${browserPort}`,
      captureBytes,
      {
        direct: !!values["client-dist"],
        executablePath: values["browser-executable"],
        outputRoot: values["capture-output"],
      },
    );
  }
  // Use the real provider entry point, which composes installed MC itself.
  process.env.YEP_MC_APP = values.app;
  if (values.publisher) {
    process.env.YEP_MC_TEAM_ID = values.publisher;
    process.env.YEP_MC_PUBLISHER = values.publisher;
  }
  const launched = await supervisor.createSession(cwd, "bypassPermissions", {
    machineControl: true,
    providerName: "codex",
    model: values.model,
    effort: "low",
  });
  assert("queueMessage" in launched, "Probe launch must be immediate");
  session = launched;
  const completed = new Promise<void>((resolve, reject) => {
    unsubscribe = session?.subscribe((event) => {
      if (event.type !== "message") return;
      messages.push(event.message);
      if (event.message.type === "result") resolve();
      if (event.message.type === "error")
        reject(
          new Error(
            `Provider reported an error: ${JSON.stringify(event.message.error)}`,
          ),
        );
    });
    timeout = setTimeout(() => {
      reject(new Error("Bounded provider smoke timed out"));
      void session?.abort();
    }, 90_000);
  });
  // Browser setup can fail before awaiting the turn. Keep its owning rejection
  // handled during cleanup; the awaited promise still reports provider errors.
  void completed.catch(() => {});
  await browser?.open(encodeProjectId(cwd), session.sessionId);
  session.queueMessage({
    text: "This is a bounded installation/capture acceptance test. Use only the advertised installed Machine Control command to run `agent instructions` and `agent identity` (offline queries). Make no target operations or access requests, run no other commands, edit no files and spawn no agents. Inspect the attached fixture PNG using your image viewer; that read-only tool is allowed. Reply with MC_PROTOCOL=<numeric clientProtocol field from agent identity>, CLI_WORKFLOW=read and CAPTURE_BUTTON=<the text on the topmost fixture button>.",
    attachments: [
      {
        id: "mc-cli-fixture",
        originalName: "browser.png",
        name: "browser.png",
        path: capturePath,
        size: captureSize,
        mimeType: "image/png",
      },
    ],
  });
  await completed;
  assert(
    !messages.some((message) => message.type === "error"),
    "Provider reported an error",
  );
  const content = messages.flatMap<ContentBlock>((message) =>
    typeof message.message?.content === "string"
      ? [{ type: "text", text: message.message.content }]
      : (message.message?.content ?? []),
  );
  const tools = content.filter((block) => block.type === "tool_use");
  const commands = JSON.stringify(tools);
  assert(
    commands.includes("agent instructions") &&
      commands.includes("agent identity"),
    "Provider must actually query the installed client",
  );
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
  assert(
    tools.some(
      (block) =>
        block.name === "ViewImage" &&
        Object.values(block.input ?? {}).some(
          (value) =>
            typeof value === "string" &&
            (process.platform === "win32"
              ? value.replaceAll("\\", "/").toLowerCase() ===
                capturePath.replaceAll("\\", "/").toLowerCase()
              : value === capturePath),
        ),
    ),
    "Provider must invoke its native image viewer",
  );
  assert(
    text.includes("MC_PROTOCOL=1") &&
      text.includes("CLI_WORKFLOW=read") &&
      text.includes(`CAPTURE_BUTTON=${expectedButton}`),
    `Provider must read the CLI identity and observe the fixture image. Observed response: ${text}`,
  );
  const liveMedia = messages.flatMap(
    (message) => message.toolResultMedia ?? [],
  );
  const liveCapture = liveMedia.find((media) => media.state === "stored");
  assert(
    liveCapture?.state === "stored",
    "Live Process output must expose a capture handle",
  );
  const projectId = encodeProjectId(cwd);
  const mediaPath = `/api/projects/${projectId}/sessions/${session.sessionId}/media/${liveCapture.id}`;
  const liveResponse = await full.app.request(mediaPath);
  assert.equal(liveResponse.status, 200);
  assert.equal(liveResponse.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await liveResponse.arrayBuffer()), captureBytes);
  await browser?.prove("live");
  assert((await session.abort()).verifiedStopped);
  await browser?.disconnect();
  full.stopNotifications();
  await closeBackend();
  await full.disposeSessionReaders();
  full = createProbeApp();
  assert(
    !full.supervisor.getProcessForSession(session.sessionId),
    "Reload app has no live provider process",
  );
  if (browserPort !== undefined) await bindBrowserBackend(browserPort);
  const detailResponse = await full.app.request(
    `/api/projects/${projectId}/sessions/${session.sessionId}?provider=codex`,
  );
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  const reloadMedia = (detail.messages as SDKMessage[]).flatMap(
    (message) => message.toolResultMedia ?? [],
  );
  const reloadCapture = reloadMedia.find((media) => media.state === "stored");
  assert(reloadCapture, "Full session detail reconstructs media");
  const reloadResponse = await full.app.request(
    `/api/projects/${projectId}/sessions/${session.sessionId}/media/${reloadCapture.id}`,
  );
  assert.equal(reloadResponse.status, 200);
  assert.deepEqual(
    Buffer.from(await reloadResponse.arrayBuffer()),
    captureBytes,
  );
  await browser?.reload();
  await browser?.prove("reloaded");
  await browser?.present();
} catch (error) {
  failures.push(error);
} finally {
  if (timeout) clearTimeout(timeout);
  const finish = async (actions: (() => unknown)[]) => {
    const results = await Promise.allSettled(
      actions.map((action) => Promise.resolve().then(action)),
    );
    for (const result of results) {
      if (result.status === "rejected") failures.push(result.reason);
    }
  };
  await finish([() => full?.stopNotifications()]);
  await finish([() => session?.abort(), () => browser?.close()]);
  unsubscribe?.();
  await finish([() => full?.disposeSessionReaders(), closeBackend]);
  await finish([
    () =>
      rm(temporary, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      }),
  ]);
}
if (failures.length) throw new AggregateError(failures, "MC acceptance failed");
console.log(
  "PASS real YA full-app provider, live/reloaded session media routes and exact PNG bytes; owned resources cleaned",
);
