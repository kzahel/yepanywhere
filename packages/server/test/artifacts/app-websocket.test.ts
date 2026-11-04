import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createAdaptorServer } from "@hono/node-server";
import { afterEach, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { ArtifactServer } from "../../src/artifacts/ArtifactServer.js";
import { createLocalResourcePathPolicy } from "../../src/routes/local-resource-policy.js";
import { attachUnifiedUpgradeHandler } from "../../src/frontend/proxy.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

async function setup() {
  const upstream = createServer();
  const wss = new WebSocketServer({ server: upstream });
  wss.on("connection", (socket, request) => {
    socket.send(JSON.stringify({ url: request.url, headers: request.headers }));
    socket.on("message", (data) => socket.send(data));
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const port = (upstream.address() as AddressInfo).port;
  const artifacts = new ArtifactServer(
    {
      port: 4402,
      localOrigin: "http://artifacts.localhost:4402",
      vhosts: [{ name: "canvas", port }],
    },
    createLocalResourcePathPolicy({
      allowedPaths: () => [],
      includeProjects: () => false,
    }),
  );
  await artifacts.ready;
  const listener = createAdaptorServer({
    fetch: () => new Response(null, { status: 404 }),
    websocket: { server: new WebSocketServer({ noServer: true }) },
  });
  attachUnifiedUpgradeHandler(listener, {
    isApiPath: (path) => path.startsWith("/api"),
    appUpgrade: (req, socket, head) =>
      artifacts.handleUpgrade(req, socket, head),
  });
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  cleanup.push(async () => {
    await artifacts.close();
    for (const client of wss.clients) client.terminate();
    await Promise.all(
      [upstream, listener].map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    wss.close();
  });
  const token = artifacts.vhostAccess.token({ name: "canvas", port });
  const address = `ws://127.0.0.1:${(listener.address() as AddressInfo).port}/`;
  return { artifacts, address, token, wss };
}

it("relays app WebSockets bidirectionally without forwarding YA credentials", async () => {
  const { artifacts, address, token } = await setup();
  const socket = new WebSocket(
    `${address}?ya_access=${token}&keep=1`,
    "vite-hmr",
    {
      headers: {
        host: "canvas.localhost:4402",
        authorization: "Bearer secret",
        cookie: `ya_app_access=${token}; yep-anywhere-session=secret; app=ok`,
      },
    },
  );
  const message = once(socket, "message");
  await once(socket, "open");
  const [data] = await message;
  const received = JSON.parse(String(data));
  expect(received.url).toBe("/?keep=1");
  expect(received.headers.authorization).toBeUndefined();
  expect(received.headers.cookie).toBe("app=ok");
  expect(socket.protocol).toBe("vite-hmr");
  const echoed = once(socket, "message");
  socket.send("updated");
  expect(String((await echoed)[0])).toBe("updated");
  const closed = once(socket, "close");
  await artifacts.close();
  await closed;
});

it("refuses missing credentials and cross-origin cookie upgrades before upstream", async () => {
  const { address, token, wss } = await setup();
  for (const headers of [
    { host: "canvas.localhost:4402" },
    {
      host: "canvas.localhost:4402",
      cookie: `ya_app_access=${token}`,
      origin: "https://evil.example",
    },
    { host: "artifacts.localhost:4402" },
  ]) {
    const socket = new WebSocket(address, { headers });
    const status = await new Promise<number>((resolve, reject) => {
      socket.once("unexpected-response", (_req, response) => {
        response.resume();
        resolve(response.statusCode!);
        socket.terminate();
      });
      socket.once("open", () =>
        reject(new Error("Unauthorized upgrade accepted")),
      );
      socket.on("error", () => {});
    });
    expect([401, 404]).toContain(status);
    expect(wss.clients.size).toBe(0);
  }
});

it("revokes an established socket without stopping its app", async () => {
  const { artifacts, address, token } = await setup();
  const socket = new WebSocket(`${address}?ya_access=${token}`, {
    headers: { host: "canvas.localhost:4402" },
  });
  await once(socket, "open");
  const closed = once(socket, "close");
  await artifacts.vhostAccess.rotate(artifacts.config.vhosts![0]!);
  await closed;
  const replacement = new WebSocket(
    `${address}?ya_access=${artifacts.vhostAccess.token(artifacts.config.vhosts![0]!)}`,
    { headers: { host: "canvas.localhost:4402" } },
  );
  // The upstream sends its request metadata before it echoes application data.
  const greeting = once(replacement, "message");
  await once(replacement, "open");
  await greeting;
  const echoed = once(replacement, "message");
  replacement.send("still running");
  expect(String((await echoed)[0])).toBe("still running");
  replacement.close();
});
