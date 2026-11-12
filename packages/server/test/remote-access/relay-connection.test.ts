import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RemoteAccessService } from "../../src/remote-access/RemoteAccessService.js";
import { createRemoteAccessRoutes } from "../../src/remote-access/routes.js";

/**
 * The server reconnects its relay client from getActiveRelayConfig() each
 * time a route reports a change, and once at startup (server-main.ts
 * updateRelayConnection). Disabling must leave nothing to connect to.
 */
describe("relay connection follows Remote Access enablement", () => {
  let dataDir: string;
  let service: RemoteAccessService;
  let connectedTo: (string | null)[];
  let post: (route: string, body?: unknown) => Promise<number>;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-access-relay-"));
    service = new RemoteAccessService({ dataDir });
    await service.initialize();
    await service.setRelayConfig({
      url: "wss://relay.example/ws",
      username: "alice",
    });
    connectedTo = [];
    const routes = createRemoteAccessRoutes({
      remoteAccessService: service,
      onRelayConfigChanged: async () => {
        connectedTo.push(service.getActiveRelayConfig()?.username ?? null);
      },
    });
    post = async (route, body) =>
      (
        await routes.request(route, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body ?? {}),
        })
      ).status;
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("connects on enable and disconnects on disable or clear", async () => {
    expect(service.getActiveRelayConfig()).toBeNull();

    expect(await post("/configure", { password: "long-enough" })).toBe(200);
    expect(await post("/disable")).toBe(200);
    expect(await post("/enable")).toBe(200);
    expect(await post("/clear")).toBe(200);
    expect(connectedTo).toEqual(["alice", null, "alice", null]);
  });

  it("stays disconnected after a restart while disabled", async () => {
    expect(await post("/configure", { password: "long-enough" })).toBe(200);
    expect(await post("/disable")).toBe(200);

    const restarted = new RemoteAccessService({ dataDir });
    await restarted.initialize();
    expect(restarted.getActiveRelayConfig()).toBeNull();
    expect(restarted.getRelayConfig()?.username).toBe("alice");
  });
});
