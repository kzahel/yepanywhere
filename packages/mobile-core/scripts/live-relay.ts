import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRelayServer } from "../../relay/src/server.js";
import { startFixture } from "./fixture.mjs";
const relay = await createRelayServer({
  port: 0,
  inMemoryDb: true,
  logLevel: "warn",
  disablePrettyPrint: true,
});
let fixture: Awaited<ReturnType<typeof startFixture>> | undefined;
let beta: Awaited<ReturnType<typeof startFixture>> | undefined;
try {
  const origin = `http://127.0.0.1:${relay.port}`;
  fixture = await startFixture({ relayURL: `ws://127.0.0.1:${relay.port}/ws` });
  beta = await startFixture({
    relayURL: `ws://127.0.0.1:${relay.port}/ws`,
    username: "rust-beta",
  });
  const deadline = Date.now() + 30000;
  while (relay.connectionManager.getActiveServers().length < 2) {
    if (Date.now() >= deadline)
      throw new Error("Owned YA relay fixture did not register");
    await new Promise((done) => setTimeout(done, 50));
  }
  for (const mux of [true, false]) {
    await new Promise<void>((done, fail) => {
      const child = spawn(
        "cargo",
        [
          "test",
          "--locked",
          "--test",
          "live",
          "--",
          "--nocapture",
          "--ignored",
          "--test-threads=1",
        ],
        {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          env: {
            ...process.env,
            YA_TEST_ENDPOINT: `ws://127.0.0.1:${relay.port}/ws${mux ? "" : "?legacy=1"}`,
            YA_TEST_RELAY_TARGET: "ios-fixture",
            YA_TEST_RELAY_STATUS: `${origin}/status`,
            YA_TEST_MUX: String(mux),
            ...(mux ? { YA_TEST_SECOND_TARGET: "rust-beta" } : {}),
          },
          stdio: "inherit",
        },
      );
      child.once("error", fail);
      child.once("close", (code) =>
        code === 0
          ? done()
          : fail(
              new Error(`Relay ${mux ? "mux" : "legacy"} proof exited ${code}`),
            ),
      );
    });
  }
} finally {
  await beta?.stop();
  await fixture?.stop();
  await relay.close();
}
