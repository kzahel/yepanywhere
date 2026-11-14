import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  launchProject,
  missingProjectFolder,
} from "../../src/projects/launch-project.js";
import { encodeProjectId } from "../../src/projects/paths.js";

// Windows launches keep the path they were given; see physicalProjectPath.
const posix = it.skipIf(process.platform === "win32");

let root: string;
let folder: string;
let other: string;
let link: string;

beforeEach(async () => {
  // The temp root is itself a link on macOS.
  root = await realpath(await mkdtemp(join(tmpdir(), "ya-launch-project-")));
  folder = join(root, "folder");
  other = join(root, "other");
  link = join(root, "link");
  await Promise.all([mkdir(folder), mkdir(other)]);
  await symlink(folder, link, "dir");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

posix("starts new work in the folder a link names now", async () => {
  expect(await launchProject(link)).toEqual({
    projectPath: folder,
    projectId: encodeProjectId(folder),
  });
  // A link through another link, and a link retargeted since, name whatever
  // folder they reach at the time of the launch.
  const chained = join(root, "chained");
  await symlink(link, chained, "dir");
  expect((await launchProject(chained)).projectPath).toBe(folder);
  await rm(link);
  await symlink(other, link, "dir");
  expect((await launchProject(link)).projectPath).toBe(other);
});

it("keeps a folder selected by its own path", async () => {
  expect(await launchProject(folder)).toEqual({
    projectPath: folder,
    projectId: encodeProjectId(folder),
  });
});

posix("keeps the selected path when the folder cannot be named", async () => {
  // The launch refuses a missing folder; it is not moved somewhere else.
  await rm(folder, { recursive: true });
  expect(await launchProject(link)).toEqual({
    projectPath: link,
    projectId: encodeProjectId(link),
  });
});

posix("keeps a project a limited user's access names", async () => {
  const named: unknown[] = [];
  const kept = await launchProject(link, undefined, {
    namesProject: (projectId, projectPath) => {
      named.push([projectId, projectPath]);
      return true;
    },
  });
  expect(kept).toEqual({
    projectPath: link,
    projectId: encodeProjectId(link),
  });
  expect(named).toEqual([[encodeProjectId(link), link]]);
});

posix("keeps a working folder that belongs to another project", async () => {
  const projectId = encodeProjectId(other);
  expect(await launchProject(link, { projectId })).toEqual({
    projectPath: link,
    projectId,
  });
});

it("refuses to continue in a folder that is gone and says history remains", async () => {
  expect(await missingProjectFolder(folder)).toBeUndefined();
  await rm(folder, { recursive: true });
  for (const path of [folder, link]) {
    const refusal = await missingProjectFolder(path);
    expect(refusal?.reason).toBe("project-folder-missing");
    expect(refusal?.error).toContain(path);
    expect(refusal?.error).toContain("history is still available");
  }
});
