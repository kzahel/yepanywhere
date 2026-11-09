import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_LOG_FILE_MAX_BYTES,
  createClientLogsRoutes,
} from "../../src/routes/client-logs.js";

const deviceId = "40967098-f962-44b4-be36-1094f4199e7d";

describe("client log routes", () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ya-client-logs-"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T12:00:00Z"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(dataDir, { recursive: true, force: true });
  });

  function post(app: ReturnType<typeof createClientLogsRoutes>) {
    return app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId,
        entries: [{ timestamp: 1, level: "info", prefix: "t", message: "m" }],
      }),
    });
  }

  it("deletes daily files past retention and stops growing a full file", async () => {
    const logsDir = join(dataDir, "logs", "client-logs");
    await mkdir(logsDir, { recursive: true });
    const expired = `client-2026-10-25-${deviceId}.jsonl`;
    const kept = `client-2026-10-26-${deviceId}.jsonl`;
    const today = `client-2026-11-09-${deviceId}.jsonl`;
    await writeFile(join(logsDir, expired), "old\n");
    await writeFile(join(logsDir, kept), "recent\n");
    await writeFile(join(logsDir, "notes.txt"), "not a daily file\n");
    const app = createClientLogsRoutes({ dataDir });

    expect(await (await post(app)).json()).toEqual({ received: 1 });
    expect((await readdir(logsDir)).sort()).toEqual(
      [kept, today, "notes.txt"].sort(),
    );

    await writeFile(
      join(logsDir, today),
      "x".repeat(CLIENT_LOG_FILE_MAX_BYTES),
    );
    expect(await (await post(app)).json()).toEqual({
      received: 0,
      dropped: 1,
    });
    expect((await readFile(join(logsDir, today), "utf8")).length).toBe(
      CLIENT_LOG_FILE_MAX_BYTES,
    );
  });
});
