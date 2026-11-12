import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTHENTICATED_SRP_TRANSPORT } from "../../src/middleware/authenticated-transport.js";
import {
  wouldAllowHost,
  wouldAllowOrigin,
} from "../../src/middleware/allowed-hosts.js";
import { allowedHostsChangeImpact } from "../../src/network/connection-impact.js";
import { REQUEST_CONNECTION_PATH } from "../../src/network/connection-path.js";
import {
  type ListenerFactory,
  NetworkListeners,
} from "../../src/network/listeners.js";
import { createRemoteAccessRoutes } from "../../src/remote-access/routes.js";
import { RemoteAccessService } from "../../src/remote-access/RemoteAccessService.js";
import { createNetworkBindingRoutes } from "../../src/routes/network-binding.js";
import { NetworkBindingService } from "../../src/services/NetworkBindingService.js";
import { EventBus } from "../../src/watcher/EventBus.js";

const LOOPBACK = "127.0.0.1";

function factoryFor(app: Hono): ListenerFactory {
  return ({ host, port }) => {
    const server = serve({ fetch: app.fetch, port, hostname: host });
    // Bind failures are reported through the controller, as in server-main.
    server.on("error", () => {});
    return server;
  };
}

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, LOOPBACK, resolve));
  const address = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

async function openSocket(port: number): Promise<net.Socket> {
  const socket = net.connect(port, LOOPBACK);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  return socket;
}

function closed(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) resolve();
    else socket.once("close", () => resolve());
  });
}

async function refusesConnections(port: number): Promise<boolean> {
  try {
    (await openSocket(port)).destroy();
    return false;
  } catch {
    return true;
  }
}

describe("network listeners", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  let listeners: NetworkListeners;

  beforeEach(() => {
    const app = new Hono().get("/", (c) => c.text("ok"));
    listeners = new NetworkListeners({
      create: factoryFor(app),
      retireGraceMs: 0,
    });
    cleanups.push(() => listeners.close());
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("keeps serving on the old port when the new one is taken", async () => {
    await listeners.start(0);
    const original = listeners.current().localhostPort;
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, LOOPBACK, resolve));
    cleanups.push(
      () => new Promise((resolve) => blocker.close(() => resolve())),
    );
    const taken = (blocker.address() as net.AddressInfo).port;

    const result = await listeners.apply({
      localhostPort: taken,
      network: null,
    });

    expect(result).toMatchObject({ success: false });
    expect(listeners.current().localhostPort).toBe(original);
    const response = await fetch(`http://${LOOPBACK}:${original}/`);
    expect(await response.text()).toBe("ok");
  });

  it("closes the replaced listener and the connections it accepted", async () => {
    await listeners.start(0);
    const original = listeners.current().localhostPort;
    const openConnection = await openSocket(original);
    const moved = await freePort();

    const result = await listeners.apply({
      localhostPort: moved,
      network: null,
    });

    expect(result).toEqual({ success: true });
    await closed(openConnection);
    expect(await refusesConnections(original)).toBe(true);
    const response = await fetch(`http://${LOOPBACK}:${moved}/`);
    expect(await response.text()).toBe("ok");
  });

  it("rebinds a released socket when its replacement cannot bind", async () => {
    await listeners.start(0);
    const { localhostPort } = listeners.current();
    const networkPort = await freePort();
    await listeners.apply({
      localhostPort,
      network: { host: LOOPBACK, port: networkPort },
    });
    const openConnection = await openSocket(networkPort);
    cleanups.push(() => openConnection.destroy());

    // TEST-NET-3 is never a local address, so the bind fails after the
    // existing socket on the same port has been released for it.
    const result = await listeners.apply({
      localhostPort,
      network: { host: "203.0.113.7", port: networkPort },
    });

    expect(result).toMatchObject({ success: false });
    expect(listeners.current().network).toEqual({
      host: LOOPBACK,
      port: networkPort,
    });
    expect(openConnection.destroyed).toBe(false);
    const response = await fetch(`http://${LOOPBACK}:${networkPort}/`);
    expect(await response.text()).toBe("ok");
  });
});

describe("network binding routes", () => {
  let app: Hono;
  let dataDir: string;
  let listeners: NetworkListeners;
  let service: NetworkBindingService;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "network-binding-"));
    service = new NetworkBindingService({ dataDir });
    await service.initialize();
    app = new Hono();
    app.route(
      "/api/network-binding",
      createNetworkBindingRoutes({
        networkBindingService: service,
        eventBus: new EventBus(),
        listeners: () => listeners,
      }),
    );
    // The caller's own connection must outlive the response to its change.
    listeners = new NetworkListeners({
      create: factoryFor(app),
      retireGraceMs: 200,
    });
    await listeners.start(0);
  });

  afterEach(async () => {
    listeners.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const put = (port: number, body: unknown, confirmed = false) =>
    fetch(
      `http://${LOOPBACK}:${port}/api/network-binding${
        confirmed ? "?confirmConnectionImpact=1" : ""
      }`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );

  it("asks before moving the caller's own listener, then redirects it", async () => {
    const original = listeners.current().localhostPort;
    const moved = await freePort();

    const refused = await put(original, { localhostPort: moved });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      reason: "connection-impact",
      connectionImpact: {
        reasons: [
          { kind: "listener-closed", listener: `${LOOPBACK}:${original}` },
        ],
      },
    });
    expect(listeners.current().localhostPort).toBe(original);

    const applied = await put(original, { localhostPort: moved }, true);
    expect(await applied.json()).toEqual({
      success: true,
      redirectUrl: `http://${LOOPBACK}:${moved}`,
    });
    expect(service.getLocalhostPort()).toBe(moved);
    const state = await fetch(
      `http://${LOOPBACK}:${moved}/api/network-binding`,
    );
    expect(state.status).toBe(200);
  });

  it("applies changes that leave the caller's listener alone", async () => {
    const { localhostPort } = listeners.current();
    const networkPort = await freePort();

    const response = await put(localhostPort, {
      network: { enabled: true, host: LOOPBACK, port: networkPort },
    });

    expect(await response.json()).toEqual({ success: true });
    expect(service.getNetworkConfig()).toMatchObject({
      enabled: true,
      host: LOOPBACK,
      port: networkPort,
    });
  });

  it("asks a client tunneled over a WebSocket about its own listener", async () => {
    const { localhostPort } = listeners.current();
    const response = await app.request(
      "/api/network-binding",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localhostPort: await freePort() }),
      },
      {
        [REQUEST_CONNECTION_PATH]: {
          kind: "listener",
          localAddress: `::ffff:${LOOPBACK}`,
          localPort: localhostPort,
          host: `localhost:${localhostPort}`,
        },
      },
    );

    expect(response.status).toBe(409);
    expect(listeners.current().localhostPort).toBe(localhostPort);
  });

  it("applies concurrent changes one after another", async () => {
    const { localhostPort } = listeners.current();
    const [movedPort, networkPort] = [await freePort(), await freePort()];

    const responses = await Promise.all([
      put(localhostPort, { localhostPort: movedPort }, true),
      put(localhostPort, {
        network: { enabled: true, host: LOOPBACK, port: networkPort },
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(listeners.current()).toEqual({
      localhostPort: movedPort,
      network: { host: LOOPBACK, port: networkPort },
    });
    expect(service.getLocalhostPort()).toBe(movedPort);
  });

  it("does not save a port that failed to bind", async () => {
    const { localhostPort } = listeners.current();
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, LOOPBACK, resolve));
    const taken = (blocker.address() as net.AddressInfo).port;
    try {
      const response = await put(localhostPort, { localhostPort: taken }, true);
      expect(response.status).toBe(400);
      expect(service.getLocalhostPort()).not.toBe(taken);
      expect(listeners.current().localhostPort).toBe(localhostPort);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

describe("Remote Access self-disconnect", () => {
  let dataDir: string;
  let routes: Hono;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-access-"));
    const remoteAccessService = new RemoteAccessService({ dataDir });
    await remoteAccessService.initialize();
    await remoteAccessService.setRelayConfig({
      url: "wss://relay.example/ws",
      username: "alice",
    });
    routes = createRemoteAccessRoutes({ remoteAccessService });
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const relayCaller = {
    [AUTHENTICATED_SRP_TRANSPORT]: {
      kind: "srp",
      username: "alice",
      sessionId: "session-1",
      transportNonce: "nonce",
      authenticationMethod: "srp-full",
      transport: "relay",
      connectionId: "connection-1",
      closeConnection: () => {},
      closeAfterResponse: () => {},
      deferAfterResponse: () => {},
    },
  };

  it("asks a relay caller before removing its own relay login", async () => {
    const refused = await routes.request(
      "/relay",
      { method: "DELETE" },
      relayCaller,
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      reason: "connection-impact",
      connectionImpact: {
        reasons: [
          { kind: "remote-session-ended" },
          { kind: "relay-disconnected" },
        ],
      },
    });

    const confirmed = await routes.request(
      "/relay?confirmConnectionImpact=1",
      { method: "DELETE" },
      relayCaller,
    );
    expect(confirmed.status).toBe(200);
  });

  it("does not ask callers the change leaves connected", async () => {
    expect((await routes.request("/relay", { method: "DELETE" })).status).toBe(
      200,
    );
  });
});

describe("allowed hosts self-disconnect", () => {
  const caller = (host: string) => ({
    kind: "listener" as const,
    localAddress: LOOPBACK,
    localPort: 3400,
    host,
  });
  const allowedBy = (value: string | undefined) => ({
    host: (host: string) => wouldAllowHost(host, value),
    origin: (origin: string) => wouldAllowOrigin(origin, undefined, value),
  });

  it("reports only the caller's own Host or page Origin losing admission", () => {
    expect(
      allowedHostsChangeImpact(
        caller("yep.example.com:443"),
        undefined,
        allowedBy("yep.example.com"),
        allowedBy("other.example.com"),
      ),
    ).toEqual([{ kind: "host-not-allowed", host: "yep.example.com" }]);
    expect(
      allowedHostsChangeImpact(
        caller("127.0.0.1:3400"),
        "https://dashboard.example.com",
        allowedBy("dashboard.example.com"),
        allowedBy(undefined),
      ),
    ).toEqual([{ kind: "host-not-allowed", host: "dashboard.example.com" }]);
    expect(
      allowedHostsChangeImpact(
        caller("192.168.1.20:3400"),
        "http://192.168.1.20:3400",
        allowedBy("*"),
        allowedBy(undefined),
      ),
    ).toEqual([]);
  });
});
