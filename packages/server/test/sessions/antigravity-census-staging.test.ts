import { execFile } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertContained,
  stageConversation,
  stageSummaries,
} from "../../../../scripts/perf-repro/antigravity-store-staging.mjs";

const run = promisify(execFile);
const repo = resolve(import.meta.dirname, "../../../..");
const ID = "19500000-0000-4000-8000-000000000003";
let root: string;

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A store with conversations: database, WAL, log and summaries index. */
async function store(at: string, ids = [ID], log = "{}\n") {
  for (const id of ids) {
    const logs = join(at, "brain", id, ".system_generated", "logs");
    await mkdir(logs, { recursive: true });
    await mkdir(join(at, "conversations"), { recursive: true });
    await writeFile(join(at, "conversations", `${id}.db`), "db");
    await writeFile(join(at, "conversations", `${id}.db-wal`), "wal");
    await writeFile(join(logs, "transcript_full.jsonl"), log);
  }
  await writeFile(join(at, "conversation_summaries.db"), "index");
  await writeFile(join(at, "conversation_summaries.db-wal"), "index wal");
  return at;
}

const KEPT = "19500000-0000-4000-8000-000000000001";
const LOST = "19500000-0000-4000-8000-000000000002";
const at = "2026-11-22T08:00:00Z";
const shortLog = `${[
  {
    step_index: 0,
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    status: "DONE",
    created_at: at,
    content: "<USER_REQUEST>\nQUESTION\n</USER_REQUEST>",
  },
  {
    step_index: 1,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    created_at: at,
    content: "ANSWER",
  },
]
  .map((record) => JSON.stringify(record))
  .join("\n")}\n`;

/**
 * A POSIX stand-in for `agy acp` that replays QUESTION and ANSWER, and
 * runs `sabotage` (shell-free JavaScript) on its first load, while the
 * census is still on the first conversation.
 */
async function replayingAgy(dir: string, sabotage: string) {
  const path = join(dir, "agy");
  await writeFile(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
const send = (v) => process.stdout.write(JSON.stringify(v) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize")
    return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentInfo: { version: "1.5.13" } } });
  if (m.method !== "session/load") return;
  const marker = ${JSON.stringify(join(dir, "sabotaged"))};
  if (!fs.existsSync(marker)) { fs.writeFileSync(marker, ""); ${sabotage} }
  const update = (u) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: m.params.sessionId, update: u } });
  update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "QUESTION" } });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ANSWER" } });
  send({ jsonrpc: "2.0", id: m.id, result: {} });
});
`,
  );
  await chmod(path, 0o755);
  return path;
}

async function census(source: string, agy: string, out: string) {
  await run(
    join(repo, "node_modules/.bin/tsx"),
    [
      "--conditions",
      "source",
      join(repo, "scripts/perf-repro/antigravity-log-census.mjs"),
      "census",
      "--store",
      source,
      "--agy",
      agy,
      "--out",
      out,
    ],
    { cwd: join(repo, "packages/server"), timeout: 60_000 },
  );
  return JSON.parse(await readFile(out, "utf8")).conversations as Record<
    string,
    Record<string, unknown>
  >;
}

/** Runs the pending change once, between the checks and the copy. */
let pending: (() => void) | undefined;
const racing = {
  beforeCopy: () => {
    const change = pending;
    pending = undefined;
    change?.();
  },
};

describe("Antigravity census staging", () => {
  it("copies independent regular files and notices a source that changed", async () => {
    root = await mkdtemp(join(tmpdir(), "ya-agy-stage-"));
    const source = await store(join(root, "source"));
    const target = join(root, "target");
    expect(stageSummaries(source, target)).toEqual({ coherent: true });
    expect(stageConversation(source, target, ID)).toEqual({ coherent: true });
    for (const rel of [
      `conversations/${ID}.db`,
      `conversations/${ID}.db-wal`,
      `brain/${ID}/.system_generated/logs/transcript_full.jsonl`,
    ]) {
      const [copy, original] = await Promise.all([
        lstat(join(target, rel)),
        stat(join(source, rel)),
      ]);
      expect(copy.isFile()).toBe(true);
      expect(copy.ino).not.toBe(original.ino);
    }
    const changed = stageConversation(source, target, ID, {
      afterCopy: () =>
        appendFileSync(join(source, "conversations", `${ID}.db-wal`), "+"),
    });
    expect(changed).toEqual({ coherent: false });
    await expect(
      lstat(join(target, `conversations/${ID}.db`)),
    ).rejects.toThrow();
  });

  it.each([
    [
      "a checkpoint removes the conversation's WAL",
      (source: string) => rmSync(join(source, `conversations/${ID}.db-wal`)),
      (source: string, target: string) =>
        stageConversation(source, target, ID, racing),
    ],
    [
      "the conversation's database is renamed",
      (source: string) =>
        renameSync(
          join(source, `conversations/${ID}.db`),
          join(source, `conversations/${ID}.db.old`),
        ),
      (source: string, target: string) =>
        stageConversation(source, target, ID, racing),
    ],
    [
      "a checkpoint removes the summaries WAL",
      (source: string) => rmSync(join(source, "conversation_summaries.db-wal")),
      (source: string, target: string) =>
        stageSummaries(source, target, racing),
    ],
  ])(
    "discards and retries when %s between the check and the copy",
    async (_name, change, stage) => {
      root = await mkdtemp(join(tmpdir(), "ya-agy-stage-"));
      const source = await store(join(root, "source"));
      const target = join(root, "target");
      pending = () => change(source);
      expect(stage(source, target)).toEqual({ coherent: false });
      const staged = existsSync(target)
        ? readdirSync(target, { recursive: true }).map(String)
        : [];
      expect(staged.filter((name) => name.includes(".db"))).toEqual([]);
      // The next attempt sees the settled source.
      if (existsSync(join(source, `conversations/${ID}.db.old`)))
        renameSync(
          join(source, `conversations/${ID}.db.old`),
          join(source, `conversations/${ID}.db`),
        );
      expect(stage(source, target)).toEqual({ coherent: true });
    },
  );

  it("reports a database renamed for good on the retry as missing", async () => {
    root = await mkdtemp(join(tmpdir(), "ya-agy-stage-"));
    const source = await store(join(root, "source"));
    const target = join(root, "target");
    const db = `conversations/${ID}.db`;
    pending = () => renameSync(join(source, db), join(source, `${db}.old`));
    expect(stageConversation(source, target, ID, racing)).toEqual({
      coherent: false,
    });
    expect(stageConversation(source, target, ID, racing)).toEqual({
      coherent: false,
      missing: [db],
    });
  });

  // A POSIX shell script stands in for agy.
  it.skipIf(process.platform === "win32").each([
    [
      "a database renamed after enumeration",
      (source: string) =>
        `fs.renameSync(${JSON.stringify(join(source, "conversations", `${LOST}.db`))}, ${JSON.stringify(join(source, "conversations", `${LOST}.db.old`))});`,
      `gone since enumeration: conversations/${LOST}.db`,
    ],
    [
      "a log lost after enumeration",
      (source: string) =>
        `fs.rmSync(${JSON.stringify(join(source, "brain", LOST, ".system_generated", "logs", "transcript_full.jsonl"))});`,
      `gone since enumeration: brain/${LOST}/.system_generated/logs/transcript_full.jsonl`,
    ],
  ])(
    "reports %s per conversation and still reports the other",
    async (_name, sabotage, reason) => {
      root = await mkdtemp(join(tmpdir(), "ya-agy-stage-"));
      const source = await store(join(root, "source"), [KEPT, LOST], shortLog);
      const agy = await replayingAgy(root, sabotage(source));
      const conversations = await census(source, agy, join(root, "out.json"));
      expect(conversations[LOST]).toEqual({ inconclusive: reason });
      expect(conversations[KEPT]).toMatchObject({
        status: "known",
        recordsDecoded: 2,
        replayComplete: true,
        mismatches: {},
      });
    },
    60_000,
  );

  it.each([
    ["a linked conversations directory", "conversations"],
    ["a linked database", `conversations/${ID}.db`],
    [
      "a linked log",
      `brain/${ID}/.system_generated/logs/transcript_full.jsonl`,
    ],
  ])("refuses %s", async (_name, rel) => {
    root = await mkdtemp(join(tmpdir(), "ya-agy-stage-"));
    const original = await store(join(root, "original"));
    const source = await store(join(root, "source"));
    await rm(join(source, rel), { recursive: true });
    await symlink(join(original, rel), join(source, rel));
    const target = join(root, "target");
    expect(() => stageConversation(source, target, ID)).toThrow(
      /refusing a link/,
    );
    await expect(
      lstat(join(target, `conversations/${ID}.db`)),
    ).rejects.toThrow();
  });

  it("refuses a profile with a link that leaves it", async () => {
    root = await mkdtemp(join(tmpdir(), "ya-agy-stage-"));
    const profile = join(root, "profile");
    await mkdir(join(profile, "a"), { recursive: true });
    await symlink(join(profile, "a"), join(profile, "inside"));
    expect(() => assertContained(profile)).not.toThrow();
    await symlink(root, join(profile, "a", "outside"));
    expect(() => assertContained(profile)).toThrow(/leaves the profile/);
  });

  // A POSIX shell script stands in for agy.
  it.skipIf(process.platform === "win32")(
    "never starts agy for a store whose conversations are a link",
    async () => {
      root = await mkdtemp(join(tmpdir(), "ya-agy-stage-"));
      const original = await store(join(root, "original"));
      const source = await store(join(root, "source"));
      await rm(join(source, "conversations"), { recursive: true });
      await symlink(
        join(original, "conversations"),
        join(source, "conversations"),
      );
      const marker = join(root, "agy-started");
      const agy = join(root, "agy");
      await writeFile(agy, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
      await chmod(agy, 0o755);
      const census = run(
        join(repo, "node_modules/.bin/tsx"),
        [
          "--conditions",
          "source",
          join(repo, "scripts/perf-repro/antigravity-log-census.mjs"),
          "census",
          "--store",
          source,
          "--agy",
          agy,
        ],
        { cwd: join(repo, "packages/server"), timeout: 60_000 },
      );
      await expect(census).rejects.toMatchObject({
        stderr: expect.stringContaining("refusing a link in the source store"),
      });
      await expect(lstat(marker)).rejects.toThrow();
      // Nothing beside the original database either.
      await expect(
        lstat(join(original, "conversations", `${ID}.db-shm`)),
      ).rejects.toThrow();
    },
    60_000,
  );
});
