import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const repo = resolve(fileURLToPath(new URL("..", import.meta.url)), "../..");
/** @param {{ relayURL?: string, username?: string }} [options] */
export async function startFixture({
  relayURL,
  username = "ios-fixture",
} = {}) {
  const reserve = createServer();
  await new Promise((done) => reserve.listen(0, "127.0.0.1", done));
  const port = reserve.address().port;
  await new Promise((done) => reserve.close(done));
  const child = spawn(
    "pnpm",
    [
      "exec",
      "tsx",
      "--conditions",
      "source",
      "packages/server/scripts/android-native-secure-probe-server.ts",
    ],
    {
      cwd: repo,
      env: {
        ...process.env,
        YA_NATIVE_PROBE_PORT: String(port),
        YA_NATIVE_PROBE_USERNAME: username,
        YA_NATIVE_PROBE_PASSWORD: "native-fixture-password",
        YA_NATIVE_PROBE_CONVERSATION: "true",
        ...(relayURL ? { YA_NATIVE_PROBE_RELAY_URL: relayURL } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  let logs = "";
  const exited = new Promise((done) => child.once("close", done));
  const stop = async () => {
    if (child.exitCode === null) {
      if (process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
      } else child.kill("SIGTERM");
      await Promise.race([
        exited,
        new Promise((done) => setTimeout(done, 5000)),
      ]);
      if (child.exitCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
        await exited;
      }
    }
  };
  const interrupt = () => {
    void stop();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    await new Promise((done, fail) => {
      const timer = setTimeout(
        () =>
          fail(new Error(`YA fixture startup timed out: ${logs.slice(-2000)}`)),
        30000,
      );
      const output = (bytes) => {
        logs = (logs + bytes).slice(-65536);
        if (logs.includes("YA_NATIVE_PROBE_READY")) {
          clearTimeout(timer);
          done();
        }
      };
      child.stdout.on("data", output);
      child.stderr.on("data", output);
      child.once("error", fail);
      child.once("close", () => {
        clearTimeout(timer);
        fail(new Error(`YA fixture exited: ${logs.slice(-2000)}`));
      });
    });
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    port,
    endpoint: `ws://127.0.0.1:${port}/api/ws`,
    stop: async () => {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
      await stop();
    },
  };
}
