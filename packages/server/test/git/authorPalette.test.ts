import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import {
  getGitAuthorPalette,
  settleGitAuthorPaletteRefreshes,
  warmGitAuthorPalette,
} from "../../src/git/authorPalette.js";
import { ProjectStoragePolicy } from "../../src/projects/projectStoragePolicy.js";

const execFileAsync = promisify(execFile);
const dirs: string[] = [];

afterEach(async () => {
  await settleGitAuthorPaletteRefreshes();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

it("re-warming a loaded palette leaves HEAD tracking to blame's read", async () => {
  const repo = await mkdtemp(join(tmpdir(), "ya-palette-repo-"));
  const dataDir = await mkdtemp(join(tmpdir(), "ya-palette-data-"));
  dirs.push(repo, dataDir);
  const git = async (...args: string[]) =>
    (await execFileAsync("git", ["-C", repo, ...args])).stdout.trim();
  await git("init");
  await git("config", "user.email", "a@example.com");
  await git("config", "user.name", "a");
  const commit = async (content: string) => {
    await writeFile(join(repo, "a.txt"), content);
    await git("add", "-A");
    await git("commit", "-m", content);
    return git("rev-parse", "HEAD");
  };
  const storage = new ProjectStoragePolicy({
    dataDir,
    getMode: () => "app-data",
  });
  const savedHead = async () =>
    JSON.parse(
      await readFile(
        storage.writePath(repo, "git-author-palette.json"),
        "utf8",
      ),
    ).head;

  const first = await commit("one");
  await warmGitAuthorPalette(repo, storage);
  expect(await savedHead()).toBe(first);

  // Project reads warm on every poll; a loaded palette must not re-resolve
  // HEAD (one git process per poll).
  const second = await commit("two");
  await warmGitAuthorPalette(repo, storage);
  expect(await savedHead()).toBe(first);

  expect((await getGitAuthorPalette(repo, storage))?.head).toBe(second);
  expect(await savedHead()).toBe(second);
});
