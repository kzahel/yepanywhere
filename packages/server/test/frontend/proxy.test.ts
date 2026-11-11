import { once } from "node:events";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { serve, upgradeWebSocket } from "@hono/node-server";
import type { HttpBindings } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { attachUnifiedUpgradeHandler } from "../../src/frontend/proxy.js";

it.each(["esm", "cjs"])(
  "leaves a direct Node response to its owner after Hono adds headers (%s)",
  async (moduleKind) => {
    const startServer: typeof serve =
      moduleKind === "cjs"
        ? createRequire(import.meta.url)("@hono/node-server").serve
        : serve;
    const app = new Hono<{ Bindings: HttpBindings }>();
    app.use("*", async (c, next) => {
      await next();
      // Hono wraps the sentinel in the adapter's optimized Response. This is
      // also possible when another in-process server has replaced the globals.
      c.header("X-Fixture", "middleware");
    });
    let prematurelySent = false;
    app.get("/", (c) => {
      const { outgoing } = c.env;
      setImmediate(() => {
        prematurelySent = outgoing.headersSent;
        if (prematurelySent) return;
        outgoing.writeHead(200, { "Content-Type": "text/plain" });
        outgoing.end("upstream body");
      });
      return RESPONSE_ALREADY_SENT;
    });
    const server = startServer({
      fetch: app.fetch,
      port: 0,
      hostname: "127.0.0.1",
    });
    await once(server, "listening");
    try {
      const response = await fetch(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
      );
      expect(await response.text()).toBe("upstream body");
      expect(prematurelySent).toBe(false);
      expect(response.headers.has("x-hono-already-sent")).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it("delegates API authentication, handshake headers and frames to Hono", async () => {
  const app = new Hono();
  app.use("/api/*", async (c, next) => {
    if (c.req.header("authorization") !== "Bearer fixture") {
      return c.text("Unauthorized", 401);
    }
    await next();
    c.header("Set-Cookie", "fixture=accepted; HttpOnly");
  });
  app.get(
    "/api/ws",
    upgradeWebSocket(() => ({
      onMessage(event, ws) {
        ws.send(event.data as string | ArrayBuffer);
      },
    })),
  );
  const wss = new WebSocketServer({ noServer: true });
  const server = serve({
    fetch: app.fetch,
    websocket: { server: wss },
    port: 0,
    hostname: "127.0.0.1",
  });
  attachUnifiedUpgradeHandler(server, {
    isApiPath: (path) => path.startsWith("/api"),
  });
  await once(server, "listening");
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/ws`;
  const clients: WebSocket[] = [];
  try {
    const denied = new WebSocket(url);
    clients.push(denied);
    denied.on("error", () => {});
    const status = await new Promise<number>((resolve, reject) => {
      denied.once("open", () =>
        reject(new Error("Unauthenticated upgrade accepted")),
      );
      denied.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode!);
        denied.terminate();
      });
      denied.once("error", reject);
    });
    expect(status).toBe(401);
    expect(wss.clients.size).toBe(0);

    const accepted = new WebSocket(url, {
      headers: { authorization: "Bearer fixture" },
    });
    clients.push(accepted);
    const handshake = once(accepted, "upgrade");
    const opened = once(accepted, "open");
    const [response] = await handshake;
    await opened;
    expect(response.headers["set-cookie"]).toEqual([
      "fixture=accepted; HttpOnly",
    ]);
    for (const payload of ["hello", Buffer.from([0, 128, 255])]) {
      const received = once(accepted, "message");
      accepted.send(payload);
      const [data, binary] = await received;
      expect(binary).toBe(Buffer.isBuffer(payload));
      expect(data).toEqual(Buffer.from(payload));
    }
  } finally {
    for (const client of clients) client.terminate();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
