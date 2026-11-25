import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ProjectAppHostPorts } from "../../src/projects/ProjectAppHostPorts.js";
import type { ProjectServiceUpstream } from "../../src/projects/ProjectServiceManager.js";

let dir: string;
let servers: Server[];
let hostPorts: ProjectAppHostPorts | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ya-host-ports-"));
  servers = [];
});
afterEach(async () => {
  await hostPorts?.close();
  await Promise.all(
    servers.map((server) => new Promise((done) => server.close(done))),
  );
  await rm(dir, { recursive: true });
});

function listen(server: Server, target: string | number): Promise<number> {
  servers.push(server);
  return new Promise((ready) =>
    server.listen(
      typeof target === "number" ? { host: "127.0.0.1", port: 0 } : target,
      () => {
        const address = server.address();
        ready(typeof address === "object" && address ? address.port : 0);
      },
    ),
  );
}

/** The broker's contract: a port line, then a splice to that port. */
async function fakeBroker(): Promise<string> {
  const socket = join(dir, "broker.sock");
  await listen(
    createServer((client) => {
      client.once("data", (chunk) => {
        const newline = chunk.indexOf(0x0a);
        const port = Number(chunk.subarray(0, newline).toString());
        const target = connect(port, "127.0.0.1");
        target.write(chunk.subarray(newline + 1));
        client.pipe(target).pipe(client);
      });
    }),
    socket,
  );
  return socket;
}

function freePort(): Promise<number> {
  return listen(createServer(), 0).then(async (port) => {
    const server = servers.pop()!;
    await new Promise((done) => server.close(done));
    return port;
  });
}

/** Like an HTTP client, never half-closes: the broker does not support it. */
function exchange(port: number, text?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    if (text !== undefined) socket.once("connect", () => socket.write(text));
    let reply = "";
    socket.on("data", (chunk) => (reply += chunk));
    socket.on("close", () => resolve(reply));
    socket.on("error", reject);
  });
}

it("splices the host port through the sandbox broker, starting a stopped app only through auto-start", async () => {
  const appPort = await listen(
    createServer((socket) =>
      socket.on("data", (chunk) => socket.end(`app saw ${chunk}`)),
    ),
    0,
  );
  const upstream: ProjectServiceUpstream = {
    projectId: "p",
    port: appPort,
    brokerSocket: await fakeBroker(),
    generation: "g",
    token: "t",
    basePath: "",
    entry: "/",
  };
  let running = false;
  const recovered: string[] = [];
  hostPorts = new ProjectAppHostPorts({
    services: { upstream: () => (running ? upstream : null) },
    autoStart: {
      recover: async (projectId) => {
        recovered.push(projectId);
        running = true;
        return upstream;
      },
    },
  });
  const hostPort = await freePort();
  await hostPorts.reconcile("p", hostPort);
  expect(hostPorts.status("p")).toEqual({ listening: true });
  expect(await exchange(hostPort, "hello")).toBe("app saw hello");
  expect(recovered).toEqual(["p"]);
  expect(await exchange(hostPort, "again")).toBe("app saw again");
  expect(recovered).toEqual(["p"]);

  await hostPorts.reconcile("p", undefined);
  expect(hostPorts.status("p")).toBeUndefined();
  await expect(exchange(hostPort, "gone")).rejects.toThrow();
});

it("reports a busy port and takes it once it is free", async () => {
  const busy = createServer();
  const port = await listen(busy, 0);
  hostPorts = new ProjectAppHostPorts({ services: { upstream: () => null } });
  await hostPorts.reconcile("p", port);
  expect(hostPorts.status("p")).toEqual({
    listening: false,
    error: `Port ${port} is already in use on this host`,
  });
  servers.pop();
  await new Promise((done) => busy.close(done));
  await hostPorts.reconcile("p", port);
  expect(hostPorts.status("p")).toEqual({ listening: true });
  // With no running app and no auto-start the connection just closes.
  expect(await exchange(port)).toBe("");
});
