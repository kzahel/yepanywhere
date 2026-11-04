import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { readHeadSha } from "../../src/git/headSha.js";

const execFileAsync = promisify(execFile);
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

async function repo() {
  const dir = await mkdtemp(join(tmpdir(), "ya-head-sha-"));
  dirs.push(dir);
  const git = async (...args: string[]) =>
    (await execFileAsync("git", ["-C", dir, ...args])).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.email", "a@example.com");
  await git("config", "user.name", "a");
  const commit = async (message: string) => {
    await writeFile(join(dir, "a.txt"), message);
    await git("add", "-A");
    await git("commit", "-m", message);
  };
  return { dir, git, commit };
}

it("matches git rev-parse across ref layouts without spawning git", async () => {
  const { dir, git, commit } = await repo();
  // Unborn branch: HEAD names no commit yet.
  expect(await readHeadSha(dir)).toBeNull();

  await commit("one");
  expect(await readHeadSha(dir)).toBe(await git("rev-parse", "HEAD"));

  // Packed refs, from a subdirectory.
  await git("pack-refs", "--all");
  await mkdir(join(dir, "sub"));
  expect(await readHeadSha(join(dir, "sub"))).toBe(
    await git("rev-parse", "HEAD"),
  );

  // A new commit after packing writes a loose ref that wins.
  await commit("two");
  expect(await readHeadSha(dir)).toBe(await git("rev-parse", "HEAD"));

  // Detached HEAD.
  await git("checkout", "-q", "--detach", "HEAD~1");
  expect(await readHeadSha(dir)).toBe(await git("rev-parse", "HEAD"));
  await git("checkout", "-q", "main");

  // Linked worktree: `.git` is a gitdir file, branch refs live in commondir.
  const linked = join(dir, "..", `${dir.split("/").pop()}-linked`);
  dirs.push(linked);
  await git("worktree", "add", "-q", "-b", "side", linked, "HEAD~1");
  const linkedHead = (
    await execFileAsync("git", ["-C", linked, "rev-parse", "HEAD"])
  ).stdout.trim();
  expect(await readHeadSha(linked)).toBe(linkedHead);
  expect(await readHeadSha(dir)).toBe(await git("rev-parse", "HEAD"));
});

it("returns null outside any repository", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ya-head-none-"));
  dirs.push(dir);
  expect(await readHeadSha(dir)).toBeNull();
});
