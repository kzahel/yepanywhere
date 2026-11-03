import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppResult } from "../../src/app.js";
import { AuthService } from "../../src/auth/AuthService.js";
import { LimitedUsersService } from "../../src/auth/LimitedUsersService.js";
import { SESSION_COOKIE_NAME } from "../../src/auth/routes.js";
import { ProjectMetadataService } from "../../src/metadata/ProjectMetadataService.js";
import { ScriptedClaudeProvider } from "../support/scripted-provider.js";
import { ServerSettingsService } from "../../src/services/ServerSettingsService.js";
import { createApp } from "../setup/create-app.js";

/**
 * A limited user adds a project under the directory the superuser gave them
 * and can then use it, through the whole app rather than the route alone; and
 * a symbolic link under that directory cannot carry the project outside it.
 * topics/limited-users.md § Delivery v1 — Project creation.
 */
describe("a limited user's project creation through the app", () => {
  let testDir: string;
  let root: string;
  let outside: string;
  let instance: AppResult;
  let limitedUsersService: LimitedUsersService;
  let projectMetadataService: ProjectMetadataService;
  let cookie: string;

  beforeEach(async () => {
    testDir = await realpath(tmpdir()).then((base) =>
      join(base, `project-creation-app-${randomUUID()}`),
    );
    const dataDir = join(testDir, "data");
    root = join(testDir, "archer");
    outside = join(testDir, "outside");
    await mkdir(dataDir, { recursive: true });
    await mkdir(root);
    await mkdir(outside);

    const authService = new AuthService({
      dataDir,
      cookieSecret: "project-creation-app-secret",
    });
    await authService.initialize();
    await authService.enableAuth("superuser-password");
    cookie = `${SESSION_COOKIE_NAME}=${await authService.createSession("archer", "archer")}`;

    limitedUsersService = new LimitedUsersService({ dataDir });
    await limitedUsersService.initialize();
    await limitedUsersService.create({
      username: "archer",
      password: "correct-horse-battery",
      projectRoot: root,
    });
    const serverSettingsService = new ServerSettingsService({ dataDir });
    await serverSettingsService.initialize();
    await serverSettingsService.updateSettings({ limitedUsersEnabled: true });
    projectMetadataService = new ProjectMetadataService({ dataDir });
    await projectMetadataService.initialize();

    instance = createApp({
      provider: new ScriptedClaudeProvider(),
      dataDir,
      projectsDir: join(testDir, "claude"),
      getCatalogFamilies: () => ["claude"],
      authService,
      authDisabled: false,
      limitedUsersService,
      serverSettingsService,
      projectMetadataService,
    });
  });

  afterEach(async () => {
    await instance.disposeSessionReaders();
    await rm(testDir, { recursive: true, force: true });
  });

  function addProject(path: string, extra: Record<string, unknown> = {}) {
    return instance.app.request("/api/projects", {
      method: "POST",
      headers: {
        Cookie: cookie,
        "X-Yep-Anywhere": "true",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path, create: true, ...extra }),
    });
  }

  function get(path: string) {
    return instance.app.request(path, {
      headers: { Cookie: cookie, "X-Yep-Anywhere": "true" },
    });
  }

  it("can list, open, and start sessions in the project it just created", async () => {
    const projectPath = join(root, "notes");
    const response = await addProject(projectPath);
    expect(response.status).toBe(200);
    const projectId = toUrlProjectId(projectPath);

    const list = (await (await get("/api/projects")).json()) as {
      projects: Array<{ id: string }>;
    };
    expect(list.projects.map((project) => project.id)).toContain(projectId);
    expect((await get(`/api/projects/${projectId}`)).status).toBe(200);
    await expect(
      instance.authorizeSubscription({
        username: "archer",
        target: { kind: "scoped", projectIds: [projectId], sessionIds: [] },
      }),
    ).resolves.toBe(true);
    // Starting a session is the new-session grant, which the superuser can
    // see and revoke in Settings → Users like any other.
    expect(
      limitedUsersService.getActiveGrants("archer")?.newSessionProjects,
    ).toEqual([projectId]);
  });

  it("may add its own project again", async () => {
    const projectPath = join(root, "notes");
    expect((await addProject(projectPath)).status).toBe(200);

    expect((await addProject(projectPath)).status).toBe(200);
    expect(
      projectMetadataService.getMetadata(toUrlProjectId(projectPath))
        ?.ownerUsername,
    ).toBe("archer");
  });

  it("creates the configured root and nested parents on first creation", async () => {
    await rm(root, { recursive: true });
    const projectPath = join(root, "games", "scooter-race");
    const response = await addProject(projectPath);
    expect(response.status, await response.text()).toBe(200);
    expect((await stat(join(projectPath, ".git"))).isDirectory()).toBe(true);
    expect(
      projectMetadataService.getMetadata(toUrlProjectId(projectPath))
        ?.ownerUsername,
    ).toBe("archer");
  });

  it("creates a folder without a repository when Git is declined", async () => {
    const projectPath = join(root, "sketches");
    const response = await addProject(projectPath, { gitInit: false });
    expect(response.status, await response.text()).toBe(200);
    expect((await stat(projectPath)).isDirectory()).toBe(true);
    await expect(stat(join(projectPath, ".git"))).rejects.toThrow();
    expect(
      (await addProject(join(root, "odd"), { gitInit: "no" })).status,
    ).toBe(400);
  });

  it("rejects missing descendants beneath an escaping symlink before mkdir", async () => {
    await symlink(outside, join(root, "via"));
    expect(
      (await addProject(join(root, "via", "missing", "made"))).status,
    ).toBe(403);
    await expect(stat(join(outside, "missing"))).rejects.toThrow();
  });

  it.each(["before discovery", "during preparation"])(
    "refuses to claim a project registered %s",
    async (timing) => {
      const projectPath = join(root, "shared");
      await mkdir(projectPath);
      const projectId = toUrlProjectId(projectPath);
      expect(await instance.scanner.getProject(projectId)).toBeNull();
      if (timing === "before discovery") {
        await projectMetadataService.addProject(projectId, projectPath);
      } else {
        const getOrCreate = instance.scanner.getOrCreateProject.bind(
          instance.scanner,
        );
        vi.spyOn(instance.scanner, "getOrCreateProject").mockImplementationOnce(
          async (id) => {
            const project = await getOrCreate(id);
            await projectMetadataService.addProject(projectId, projectPath);
            return project;
          },
        );
      }

      expect((await addProject(projectPath)).status).toBe(403);
      expect(
        projectMetadataService.getMetadata(projectId)?.ownerUsername,
      ).toBeUndefined();
      expect(
        limitedUsersService.getActiveGrants("archer")?.newSessionProjects,
      ).toEqual([]);
    },
  );

  it("refuses to bring back a project the superuser hid", async () => {
    const projectPath = join(root, "retired");
    await mkdir(projectPath);
    const projectId = toUrlProjectId(projectPath);
    await projectMetadataService.addProject(projectId, projectPath);
    await projectMetadataService.hideProject(projectId, projectPath);

    expect((await addProject(projectPath)).status).toBe(403);
    expect(projectMetadataService.isHiddenProjectPath(projectPath)).toBe(true);
  });

  it("refuses a symbolic link under the root that points outside it", async () => {
    const link = join(root, "escape");
    await symlink(outside, link);
    const response = await addProject(link);
    expect(response.status).toBe(403);
    expect(
      limitedUsersService.getActiveGrants("archer")?.newSessionProjects,
    ).toEqual([]);
  });

  it("refuses to create a project through a symlinked parent", async () => {
    await symlink(outside, join(root, "via"));
    const response = await addProject(join(root, "via", "made"));
    expect(response.status).toBe(403);
    await expect(stat(join(outside, "made"))).rejects.toThrow();
  });

  it("refuses a symbolic link even when it points back under the root", async () => {
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "alias"));
    const response = await addProject(join(root, "alias"));
    expect(response.status).toBe(403);
  });
});
