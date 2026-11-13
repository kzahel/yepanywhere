import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, "../../../../scripts/ya-instance.mjs");

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeRecord(dataDir, fields) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, "server-instance.json"),
    JSON.stringify({
      version: 1,
      instanceId: "test",
      host: "127.0.0.1",
      url: `http://127.0.0.1:${fields.port}`,
      dataDir,
      profile: null,
      supervisor: null,
      writtenAt: Date.now(),
      ...fields,
    }),
  );
}

// Identity is verified with ps, which Windows lacks; stop refuses there.
describe.skipIf(process.platform === "win32")("ya:instance", () => {
  const cleanup = [];
  afterEach(() => {
    for (const action of cleanup.splice(0)) action();
  });

  function setup() {
    const home = mkdtempSync("/tmp/ya-instance-");
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const run = (...args) =>
      spawnSync(process.execPath, [script, ...args], {
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      });
    const idle = () => {
      const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1e3)"], {
        stdio: "ignore",
      });
      const record = { pid: child.pid, startedAt: Date.now() };
      // The runner is this child's parent, so a stopped child stays a zombie
      // (still signalable) until the exit event reaps it.
      const exited = new Promise((resolveExit) =>
        child.once("exit", resolveExit),
      );
      Object.defineProperty(record, "exited", { value: exited });
      cleanup.push(() => child.exitCode === null && child.kill("SIGKILL"));
      return record;
    };
    return { home, run, idle };
  }

  it("stops only the process whose PID and start time match the record", async () => {
    const { home, run, idle } = setup();
    const side = idle();
    const dataDir = join(home, ".yep-anywhere-side");
    // Same PID, different start time: the recorded server is gone and the PID
    // now names something else, which must not be signalled.
    writeRecord(dataDir, {
      ...side,
      startedAt: side.startedAt - 3_600_000,
      port: 45001,
    });
    expect(JSON.parse(run("list", "--json").stdout)).toEqual([
      expect.objectContaining({ status: "stale", pid: side.pid }),
    ]);
    const reused = run("stop", "--profile", "side");
    expect(reused.status).toBe(0);
    expect(reused.stdout).toContain("not running (stale record)");
    expect(alive(side.pid)).toBe(true);

    writeRecord(dataDir, { ...side, port: 45001 });
    expect(JSON.parse(run("list", "--json").stdout)).toEqual([
      expect.objectContaining({ status: "running", pid: side.pid }),
    ]);
    const stopped = run("stop", "--port", "45001");
    expect(stopped.stderr).toBe("");
    expect(stopped.status).toBe(0);
    expect(await side.exited).toBe(null);
  });

  it("refuses the default instance and any instance it runs under", () => {
    const { home, run, idle } = setup();
    const main = idle();
    writeRecord(join(home, ".yep-anywhere"), { ...main, port: 45002 });
    const refusedDefault = run("stop", "--port", "45002");
    expect(refusedDefault.status).toBe(1);
    expect(refusedDefault.stderr).toContain(
      "refusing to stop the default instance",
    );
    expect(alive(main.pid)).toBe(true);

    // An agent asking to stop the server that hosts it: the record names an
    // ancestor of the stop command.
    const parentDir = join(home, ".yep-anywhere-host");
    const parent = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
        import { spawnSync } from "node:child_process";
        import { mkdirSync, writeFileSync } from "node:fs";
        mkdirSync(${JSON.stringify(parentDir)}, { recursive: true });
        writeFileSync(${JSON.stringify(join(parentDir, "server-instance.json"))}, JSON.stringify({
          version: 1, instanceId: "host", pid: process.pid,
          startedAt: Math.round(performance.timeOrigin), host: "127.0.0.1",
          port: 45003, url: "http://127.0.0.1:45003", profile: "host",
          supervisor: null, writtenAt: Date.now(),
        }));
        const result = spawnSync(process.execPath, [${JSON.stringify(script)}, "stop", "--profile", "host"], { encoding: "utf8" });
        process.stdout.write(JSON.stringify({ status: result.status, stderr: result.stderr }));
        `,
      ],
      { env: { ...process.env, HOME: home }, encoding: "utf8" },
    );
    const nested = JSON.parse(parent.stdout);
    expect(nested.status).toBe(1);
    expect(nested.stderr).toContain("this command is running under it");
  });
});
