import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalResourcePathPolicy } from "../../src/routes/local-resource-policy.js";
import { projectForPath } from "./route-fixtures.js";

describe("file-access path policy (dynamic + project gate)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "yep-file-access-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("re-evaluates a dynamic allow-list and gates scanned projects", async () => {
    const allowedDir = path.join(tempDir, "allowed");
    const projectDir = path.join(tempDir, "project");
    await mkdir(allowedDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });

    const fileInAllowed = path.join(allowedDir, "a.txt");
    const fileInProject = path.join(projectDir, "b.txt");
    await writeFile(fileInAllowed, "a");
    await writeFile(fileInProject, "b");

    let allow: string[] = [];
    let includeProjects = true;
    const policy = createLocalResourcePathPolicy({
      allowedPaths: () => allow,
      includeProjects: () => includeProjects,
      scanner: {
        async listProjects() {
          return [projectForPath(projectDir)];
        },
      },
    });

    // Nothing in the custom list yet, but projects are included.
    expect((await policy.resolveAllowedFilePath(fileInAllowed)).ok).toBe(false);
    expect((await policy.resolveAllowedFilePath(fileInProject)).ok).toBe(true);

    // Gate projects off — the in-project file is now denied.
    includeProjects = false;
    expect((await policy.resolveAllowedFilePath(fileInProject)).ok).toBe(false);

    // Add the folder dynamically — the cache re-resolves and allows it.
    allow = [allowedDir];
    expect((await policy.resolveAllowedFilePath(fileInAllowed)).ok).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "denies symlinks that escape the allow-set",
    async () => {
      const allowedDir = path.join(tempDir, "allowed");
      const outsideDir = path.join(tempDir, "outside");
      await mkdir(allowedDir, { recursive: true });
      await mkdir(outsideDir, { recursive: true });

      const outsideFile = path.join(outsideDir, "secret.txt");
      const linkPath = path.join(allowedDir, "link.txt");
      await writeFile(outsideFile, "secret");
      await symlink(outsideFile, linkPath);

      const policy = createLocalResourcePathPolicy({
        allowedPaths: [allowedDir],
      });

      const result = await policy.resolveAllowedFilePath(linkPath);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(403);
      }
    },
  );
});
