import { createServer, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { expect, it, vi } from "vitest";
import { requestDevWrapperSafeReload } from "../src/dev-wrapper-client.js";

it("waits for the wrapper to release a declined safe handoff", async () => {
  const ready = Promise.withResolvers<Record<string, unknown>>();
  const declined = Promise.withResolvers<Socket>();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const lines = createInterface({ input: socket });
    lines.on("line", (line) => {
      const request = JSON.parse(line) as Record<string, unknown>;
      if (request.op === "safeReload") {
        ready.resolve(request);
        socket.write('{"ok":true}\n');
      } else if (request.op === "declineSafeReload") {
        declined.resolve(socket);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected a TCP wrapper address");
    vi.stubEnv("YEP_DEV_WRAPPER_PORT", String(address.port));
    vi.stubEnv("YEP_DEV_WRAPPER_TOKEN", "owned-test-token");
    vi.stubEnv("YEP_SERVER_GENERATION", "test-generation");
    const completed = vi.fn();
    const attempt = requestDevWrapperSafeReload(async () => false);
    void attempt.then(completed, completed);
    expect(await ready.promise).toMatchObject({
      op: "safeReload",
      generation: "test-generation",
      pid: process.pid,
    });
    const socket = await declined.promise;
    expect(completed).not.toHaveBeenCalled();
    socket.end('{"ok":true,"declined":true}\n');
    await expect(attempt).resolves.toBe(false);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
  }
});
