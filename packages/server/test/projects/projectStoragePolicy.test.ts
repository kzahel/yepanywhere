import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectStoragePolicy } from "../../src/projects/projectStoragePolicy.js";

const execFileAsync = promisify(execFile);

describe("ProjectStoragePolicy", () => {
  let projectPath: string;
  let dataDir: string;
  let outsidePath: string;

  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), "ya-storage-project-"));
    dataDir = await mkdtemp(join(tmpdir(), "ya-storage-data-"));
    outsidePath = await mkdtemp(join(tmpdir(), "ya-storage-outside-"));
  });

  afterEach(async () => {
    await Promise.all(
      [projectPath, dataDir, outsidePath].map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("keeps default writes in app data", async () => {
    const policy = new ProjectStoragePolicy({
      dataDir,
      getMode: () => "app-data",
    });

    const directory = await policy.ensureWriteDirectory(
      projectPath,
      "attachments",
      "session",
    );

    expect(directory).toBe(
      policy.writePath(projectPath, "attachments", "session"),
    );
    expect((await stat(directory)).isDirectory()).toBe(true);
    await expect(stat(join(projectPath, ".yep"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("uses one excluded .yep root after project-local opt-in", async () => {
    await execFileAsync("git", ["-C", projectPath, "init"]);
    const policy = new ProjectStoragePolicy({
      dataDir,
      getMode: () => "project",
    });

    const directory = await policy.ensureWriteDirectory(
      projectPath,
      "attachments",
      "session",
    );

    expect(directory).toBe(join(projectPath, ".yep", "attachments", "session"));
    expect(
      await readFile(join(projectPath, ".git", "info", "exclude"), "utf8"),
    ).toContain(".yep/");
  });

  it("allows project-local storage in a confirmed non-Git directory", async () => {
    const policy = new ProjectStoragePolicy({
      dataDir,
      getMode: () => "project",
    });

    await expect(
      policy.ensureWriteDirectory(projectPath, "attachments"),
    ).resolves.toBe(join(projectPath, ".yep", "attachments"));
  });

  it("does not mutate the project when Git inspection fails", async () => {
    const policy = new ProjectStoragePolicy({
      dataDir,
      getMode: () => "project",
      runGit: async () => {
        throw Object.assign(new Error("git inspection timed out"), {
          code: "ETIMEDOUT",
        });
      },
    });

    await expect(
      policy.ensureWriteDirectory(projectPath, "attachments"),
    ).rejects.toThrow("Could not verify project storage Git state");
    await expect(stat(join(projectPath, ".yep"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not create a missing selected project directory", async () => {
    const missingProject = join(projectPath, "missing");
    const policy = new ProjectStoragePolicy({
      dataDir,
      getMode: () => "project",
    });

    await expect(
      policy.ensureWriteDirectory(missingProject, "attachments"),
    ).rejects.toThrow("Could not verify project storage Git state");
    await expect(stat(missingProject)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a tracked .yep root", async () => {
    await execFileAsync("git", ["-C", projectPath, "init"]);
    await execFileAsync("git", [
      "-C",
      projectPath,
      "config",
      "user.email",
      "test@example.com",
    ]);
    await execFileAsync("git", [
      "-C",
      projectPath,
      "config",
      "user.name",
      "Test",
    ]);
    await mkdir(join(projectPath, ".yep"));
    await writeFile(join(projectPath, ".yep", "owned.txt"), "user data\n");
    await execFileAsync("git", ["-C", projectPath, "add", ".yep/owned.txt"]);
    await execFileAsync("git", [
      "-C",
      projectPath,
      "commit",
      "-m",
      "track yep",
    ]);
    const policy = new ProjectStoragePolicy({
      dataDir,
      getMode: () => "project",
    });

    await expect(
      policy.ensureWriteDirectory(projectPath, "attachments", "session"),
    ).rejects.toThrow("tracked .yep root");
    await expect(
      stat(join(projectPath, ".yep", "attachments")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlinked .yep root", async () => {
    await symlink(
      outsidePath,
      join(projectPath, ".yep"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const policy = new ProjectStoragePolicy({
      dataDir,
      getMode: () => "project",
    });

    await expect(
      policy.ensureWriteDirectory(projectPath, "attachments", "session"),
    ).rejects.toThrow("symlinked project storage path");
    await expect(stat(join(outsidePath, "attachments"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
