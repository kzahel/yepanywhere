import { execFileSync, spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const isWindows = process.platform === "win32";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function request(port, message) {
  return new Promise((resolveRequest, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: Number(port) });
    let response = "";
    socket.setTimeout(2_000, () =>
      socket.destroy(new Error("request timeout")),
    );
    socket.on("error", reject);
    socket.on("connect", () => socket.end(`${JSON.stringify(message)}\n`));
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("end", () =>
      resolveRequest(response ? JSON.parse(response) : null),
    );
  });
}

it("restarts once per request, ignores retired exits and reaps launcher descendants", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ya-dev-portable-"));
  const eventsFile = join(directory, "events.jsonl");
  const fixture = join(here, "fixtures/dev-wrapper-registered-child.mjs");
  if (isWindows) {
    await writeFile(
      join(directory, "pnpm.cmd"),
      `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`,
    );
  } else {
    await copyFile(fixture, join(directory, "pnpm"));
    await chmod(join(directory, "pnpm"), 0o755);
  }
  const env = { ...process.env };
  // Windows environment names are case insensitive; an ambient Path can win
  // over a second PATH entry when Node constructs the native environment.
  for (const key of Object.keys(env)) {
    if (
      key.toLowerCase() === "path" ||
      /^YEP_(DEV_|SERVER_GENERATION|PROVIDER_)/.test(key)
    ) {
      delete env[key];
    }
  }
  Object.assign(env, {
    PATH: `${directory}${delimiter}${process.env.PATH}`,
    USE_MOCK_SDK: "true",
    YEP_DATA_DIR: join(directory, "profile"),
    YA_TEST_WRAPPER_EVENTS: eventsFile,
    PORT: "3499",
    VITE_PORT: "3501",
  });
  const wrapper = spawn(
    process.execPath,
    [
      "--import",
      pathToFileURL(join(here, "fixtures/dev-wrapper-delayed-exit.mjs")).href,
      join(root, "scripts/dev.js"),
    ],
    { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  wrapper.stdout.on("data", (chunk) => {
    output += chunk;
  });
  wrapper.stderr.on("data", (chunk) => {
    output += chunk;
  });
  async function events() {
    try {
      return (await readFile(eventsFile, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }
  const pids = (entries) =>
    entries.flatMap((event) =>
      [event.pid, event.descendantPid].filter(Boolean),
    );
  try {
    await expect
      .poll(async () => (await events()).length, { timeout: 10_000 })
      .toBe(2);
    for (let round = 1; round <= 3; round++) {
      const before = await events();
      const backend = before.filter((event) => event.role === "server").at(-1);
      const responses = await Promise.all([
        request(backend.port, { token: backend.token, op: "reload" }),
        request(backend.port, { token: backend.token, op: "reload" }),
      ]);
      expect(responses.every((response) => response.ok)).toBe(true);
      await expect
        .poll(async () => (await events()).length, { timeout: 10_000 })
        .toBe(2 * (round + 1));
      // Let the deliberately late exit and both coalesced requests arrive.
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
      expect((await events()).length).toBe(2 * (round + 1));
      expect(wrapper.exitCode ?? wrapper.signalCode).toBeNull();
      expect(pids(before).filter(alive)).toEqual([]);
      expect(output).not.toContain("[Recovery]");
      expect(output).not.toContain("invalid backend registration");
    }
    const all = await events();
    const backend = all.filter((event) => event.role === "server").at(-1);
    // A clean backend exit asks the actual wrapper to execute terminal cleanup,
    // including Windows, where child.kill(SIGTERM) would bypass JS handlers.
    await request(backend.controlPort, { exit: true });
    await expect.poll(() => wrapper.exitCode, { timeout: 10_000 }).toBe(0);
    expect(pids(all).filter(alive)).toEqual([]);
  } catch (error) {
    throw new Error(`${error.message}\n${output}`, { cause: error });
  } finally {
    // Emergency cleanup is scoped to this test's wrapper and recorded children.
    for (const pid of [wrapper.pid, ...pids(await events())]) {
      if (!alive(pid)) continue;
      if (isWindows) {
        execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } else {
        process.kill(pid, "SIGKILL");
      }
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}, 30_000);
