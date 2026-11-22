import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
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

/** A store with one conversation: database, WAL, log and summaries index. */
async function store(at: string) {
  const logs = join(at, "brain", ID, ".system_generated", "logs");
  await mkdir(logs, { recursive: true });
  await mkdir(join(at, "conversations"), { recursive: true });
  await writeFile(join(at, "conversations", `${ID}.db`), "db");
  await writeFile(join(at, "conversations", `${ID}.db-wal`), "wal");
  await writeFile(join(logs, "transcript_full.jsonl"), "{}\n");
  await writeFile(join(at, "conversation_summaries.db"), "index");
  return at;
}

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
    const changed = stageConversation(source, target, ID, () => {
      appendFileSync(join(source, "conversations", `${ID}.db-wal`), "+");
    });
    expect(changed).toEqual({ coherent: false });
  });

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

  it("never starts agy for a store whose conversations are a link", async () => {
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
  }, 60_000);
});
