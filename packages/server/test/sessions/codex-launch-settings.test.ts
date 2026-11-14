import { randomUUID } from "node:crypto";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readCodexLatestLaunchSettings } from "../../src/sessions/codex-launch-settings.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";

const headerReads = vi.hoisted(() => ({ failNext: false }));
vi.mock("../../src/sessions/codex-rollout-lineage.js", async (original) => {
  const actual =
    await original<
      typeof import("../../src/sessions/codex-rollout-lineage.js")
    >();
  return {
    ...actual,
    readCodexSessionMeta: async (filePath: string) => {
      if (headerReads.failNext) {
        headerReads.failNext = false;
        throw new Error("EMFILE: too many open files");
      }
      return actual.readCodexSessionMeta(filePath);
    },
  };
});

let dir: string;
beforeEach(async () => {
  dir = join(tmpdir(), `codex-launch-settings-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Past V8's maximum string length, so a whole-rollout read cannot succeed.
const UNREADABLE_HOLE_BYTES = 600 * 1024 * 1024;
const ts = "2026-11-14T00:00:00.000Z";
const meta = (id: string) => ({
  type: "session_meta",
  timestamp: ts,
  payload: { id, cwd: "/test/project", timestamp: ts },
});
const turnContext = (model: string, effort: string) => ({
  type: "turn_context",
  timestamp: ts,
  payload: {
    cwd: "/test/project",
    model,
    effort,
    approval_policy: "never",
    sandbox_policy: { type: "danger-full-access" },
  },
});
const jsonl = (rows: unknown[]) =>
  Buffer.from(rows.map((row) => `${JSON.stringify(row)}\n`).join(""));

async function countBytes<T>(probePath: string, run: () => Promise<T>) {
  const probe = await open(probePath, "r");
  const prototype = Object.getPrototypeOf(probe) as {
    read: (...args: unknown[]) => Promise<{ bytesRead: number }>;
  };
  await probe.close();
  const originalRead = prototype.read;
  let bytes = 0;
  const spy = vi.spyOn(prototype, "read").mockImplementation(async function (
    this: unknown,
    ...args: unknown[]
  ) {
    const result = await originalRead.apply(this, args);
    bytes += result.bytesRead;
    return result;
  });
  try {
    return { value: await run(), bytes };
  } finally {
    spy.mockRestore();
  }
}

it("recovers the latest turn's settings from the end of a rollout too large to read whole", async () => {
  const id = randomUUID();
  const path = join(dir, `rollout-2026-11-14T00-00-00-${id}.jsonl`);
  const file = await open(path, "w");
  try {
    const head = jsonl([meta(id), turnContext("gpt-early", "low")]);
    const tail = Buffer.concat([
      Buffer.from("\n"),
      jsonl([turnContext("gpt-latest", "high")]),
    ]);
    await file.write(head, 0, head.length, 0);
    await file.write(tail, 0, tail.length, head.length + UNREADABLE_HOLE_BYTES);
  } finally {
    await file.close();
  }

  const reader = new CodexSessionReader({ sessionsDir: dir });
  const { value, bytes } = await countBytes(path, () =>
    reader.getRecoveredLaunchSettings(id),
  );
  expect(value).toEqual({
    permissionMode: "bypassPermissions",
    requestedModel: "gpt-latest",
    thinking: { type: "adaptive", display: "summarized" },
    effort: "high",
  });
  expect(bytes).toBeGreaterThan(0);
  expect(bytes).toBeLessThan(8 * 1024 * 1024);
});

it("reads the complete rollout when the latest turn context lies beyond the tail budget", async () => {
  const id = randomUUID();
  const path = join(dir, `rollout-2026-11-14T00-00-00-${id}.jsonl`);
  const output = {
    type: "event_msg",
    timestamp: ts,
    payload: { type: "agent_message", message: "z".repeat(64 * 1024) },
  };
  await writeFile(
    path,
    jsonl([
      meta(id),
      turnContext("gpt-latest", "medium"),
      ...Array.from({ length: 80 }, () => output),
    ]),
  );

  const reader = new CodexSessionReader({ sessionsDir: dir });
  // A missing answer would launch with default permissions instead.
  await expect(reader.getRecoveredLaunchSettings(id)).resolves.toEqual({
    permissionMode: "bypassPermissions",
    requestedModel: "gpt-latest",
    thinking: { type: "adaptive", display: "summarized" },
    effort: "medium",
  });
});

it("does not keep a failed header read as an absence of settings", async () => {
  const id = randomUUID();
  const path = join(dir, `rollout-2026-11-14T00-00-00-${id}.jsonl`);
  await writeFile(path, jsonl([meta(id), turnContext("gpt-latest", "high")]));

  headerReads.failNext = true;
  await expect(
    readCodexLatestLaunchSettings(path, id),
  ).resolves.toBeUndefined();
  await expect(readCodexLatestLaunchSettings(path, id)).resolves.toMatchObject({
    permissionMode: "bypassPermissions",
    requestedModel: "gpt-latest",
  });
});

it("refuses a rollout whose header names no thread, as the complete read does", async () => {
  const id = randomUUID();
  const path = join(dir, `rollout-2026-11-14T00-00-00-${id}.jsonl`);
  const header = meta(id);
  const { id: _omitted, ...payload } = header.payload;
  await writeFile(
    path,
    jsonl([{ ...header, payload }, turnContext("gpt-latest", "high")]),
  );

  await expect(readCodexLatestLaunchSettings(path, id)).resolves.toBeNull();
});
