import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppResult } from "../../src/app.js";
import { AuthService } from "../../src/auth/AuthService.js";
import { LimitedUsersService } from "../../src/auth/LimitedUsersService.js";
import { SESSION_COOKIE_NAME } from "../../src/auth/routes.js";
import { ProjectMetadataService } from "../../src/metadata/ProjectMetadataService.js";
import { ScriptedClaudeProvider } from "../support/scripted-provider.js";
import { ServerSettingsService } from "../../src/services/ServerSettingsService.js";
import { createApp } from "../setup/create-app.js";

/**
 * Shared project metadata changes require ownership. Removal by a limited
 * owner changes only that user's visibility and retains the canonical project.
 * topics/limited-users.md § Delivery v1 — Authorization.
 */
describe("a limited user's edits to shared project metadata through the app", () => {
  let testDir: string;
  let root: string;
  let instance: AppResult;
  let authService: AuthService;
  let projectMetadataService: ProjectMetadataService;
  let limitedCookie: string;
  let superuserCookie: string;
  let sharedPath: string;
  let sharedId: string;

  beforeEach(async () => {
    testDir = await realpath(tmpdir()).then((base) =>
      join(base, `project-metadata-app-${randomUUID()}`),
    );
    const dataDir = join(testDir, "data");
    root = join(testDir, "archer");
    await mkdir(dataDir, { recursive: true });
    await mkdir(root);

    authService = new AuthService({
      dataDir,
      cookieSecret: "project-metadata-app-secret",
    });
    await authService.initialize();
    await authService.enableAuth("superuser-password");
    limitedCookie = `${SESSION_COOKIE_NAME}=${await authService.createSession("archer", "archer")}`;
    superuserCookie = `${SESSION_COOKIE_NAME}=${await authService.createSession("superuser")}`;

    const limitedUsersService = new LimitedUsersService({ dataDir });
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

    // The superuser's project, in which archer may start sessions.
    sharedPath = join(testDir, "shared");
    await mkdir(sharedPath);
    sharedId = toUrlProjectId(sharedPath);
    await projectMetadataService.addProject(sharedId, sharedPath);
    await limitedUsersService.grantNewSessionProject("archer", sharedId);

    // Start discovery after the fixture registration, as a persisted startup.
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
    await authService.flushPendingWrites();
    await rm(testDir, { recursive: true, force: true });
  });

  function send(
    cookie: string,
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ) {
    return instance.app.request(path, {
      method,
      headers: {
        Cookie: cookie,
        "X-Yep-Anywhere": "true",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  it("cannot rename, recaption, re-code-name or remove a project it does not own", async () => {
    const base = `/api/projects/${sharedId}`;
    expect(
      (await send(limitedCookie, "PATCH", `${base}/name`, { name: "mine" }))
        .status,
    ).toBe(403);
    expect(
      (
        await send(limitedCookie, "PATCH", `${base}/caption`, {
          caption: "mine",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await send(limitedCookie, "PATCH", `${base}/code-name`, {
          codeName: "MINE",
        })
      ).status,
    ).toBe(403);
    expect((await send(limitedCookie, "DELETE", base)).status).toBe(403);

    expect(projectMetadataService.getProjectNameOverride(sharedId)).toBe(
      undefined,
    );
    expect(projectMetadataService.getProjectCaptionOverride(sharedId)).toBe(
      undefined,
    );
    expect(projectMetadataService.getProjectCodeName(sharedId)).not.toBe(
      "MINE",
    );
    expect(projectMetadataService.isHiddenProjectPath(sharedPath)).toBe(false);
  });

  it("may rename, recaption, re-code-name and remove its own project", async () => {
    const ownPath = join(root, "notes");
    const added = await send(limitedCookie, "POST", "/api/projects", {
      path: ownPath,
      create: true,
    });
    expect(added.status).toBe(200);
    const ownId = toUrlProjectId(ownPath);
    const base = `/api/projects/${ownId}`;

    expect(
      (await send(limitedCookie, "PATCH", `${base}/name`, { name: "Journal" }))
        .status,
    ).toBe(200);
    expect(projectMetadataService.getProjectNameOverride(ownId)).toBe(
      "Journal",
    );
    expect(
      (
        await send(limitedCookie, "PATCH", `${base}/caption`, {
          caption: "Daily notes",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await send(limitedCookie, "PATCH", `${base}/code-name`, {
          codeName: "JRN",
        })
      ).status,
    ).toBe(200);
    expect((await send(limitedCookie, "DELETE", base)).status).toBe(200);
    expect(projectMetadataService.isHiddenProjectPath(ownPath)).toBe(false);
    const limitedProjects = await (
      await send(limitedCookie, "GET", "/api/projects")
    ).json();
    expect(limitedProjects.projects).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: ownId })]),
    );
    const superuserProjects = await (
      await send(superuserCookie, "GET", "/api/projects")
    ).json();
    expect(superuserProjects.projects).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: ownId })]),
    );
    expect((await send(limitedCookie, "GET", base)).status).toBe(200);
  });

  it("lets the superuser rename any listed project and no other directory", async () => {
    const renamed = await send(
      superuserCookie,
      "PATCH",
      `/api/projects/${sharedId}/name`,
      { name: "Team" },
    );
    expect(renamed.status).toBe(200);
    expect(projectMetadataService.getProjectNameOverride(sharedId)).toBe(
      "Team",
    );

    const stray = join(testDir, "stray");
    await mkdir(stray);
    const strayId = toUrlProjectId(stray);
    const refused = await send(
      superuserCookie,
      "PATCH",
      `/api/projects/${strayId}/name`,
      { name: "Stray" },
    );
    expect(refused.status).toBe(404);
    expect(projectMetadataService.getProjectNameOverride(strayId)).toBe(
      undefined,
    );
    expect(projectMetadataService.getMetadata(strayId)).toBeUndefined();
  });
});
