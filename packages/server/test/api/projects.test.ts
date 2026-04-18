import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { ProjectMetadataService } from "../../src/metadata/ProjectMetadataService.js";
import { MockClaudeSDK } from "../../src/sdk/mock.js";

describe("Projects API", () => {
  let mockSdk: MockClaudeSDK;
  let testDir: string;
  let metadataDir: string;
  let projectPath: string;

  beforeEach(async () => {
    mockSdk = new MockClaudeSDK();
    // Create temp directory structure mimicking ~/.claude/projects/
    testDir = join(tmpdir(), `claude-test-${randomUUID()}`);
    metadataDir = join(tmpdir(), `project-metadata-test-${randomUUID()}`);
    projectPath = join(tmpdir(), `project-root-${randomUUID()}`);
    await mkdir(projectPath, { recursive: true });
    await mkdir(join(testDir, "localhost"), { recursive: true });
    await mkdir(join(testDir, "localhost", "-home-user-myproject"), {
      recursive: true,
    });
    // Create a sample session file with cwd field (required for project path discovery)
    await writeFile(
      join(testDir, "localhost", "-home-user-myproject", "sess-123.jsonl"),
      `{"type":"user","cwd":"${projectPath.replaceAll("\\", "\\\\")}","message":{"content":"Hello"}}\n`,
    );
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    await rm(metadataDir, { recursive: true, force: true });
    await rm(projectPath, { recursive: true, force: true });
  });

  describe("GET /api/projects", () => {
    it("returns list of projects", async () => {
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request("/api/projects");
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.projects).toBeDefined();
      expect(Array.isArray(json.projects)).toBe(true);
    });

    it("returns no scanned projects when projects directory is missing", async () => {
      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: "/nonexistent/path",
      });

      const res = await app.request("/api/projects");
      const json = await res.json();

      expect(res.status).toBe(200);
      // No Claude projects with actual sessions should be found.
      // The home-directory fallback (sessionCount: 0) or Codex/Gemini
      // sessions may still appear.
      const claudeWithSessions = json.projects.filter(
        (p: { provider: string; sessionCount: number }) =>
          p.provider === "claude" && p.sessionCount > 0,
      );
      expect(claudeWithSessions).toEqual([]);
    });

    it("discovers projects from directory structure", async () => {
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request("/api/projects");
      const json = await res.json();

      expect(res.status).toBe(200);
      // Should find the project we created
      expect(json.projects.length).toBeGreaterThan(0);
    });
  });

  describe("GET /api/projects/:projectId", () => {
    it("returns 404 for unknown project", async () => {
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request("/api/projects/unknown-id");

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("Project not found");
    });
  });

  describe("GET /api/projects/:projectId/sessions", () => {
    it("returns 404 for unknown project", async () => {
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request("/api/projects/unknown-id/sessions");

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("Project not found");
    });
  });

  describe("DELETE /api/projects/:projectId", () => {
    it("hides a visible project and allows restoring it by adding the path again", async () => {
      const projectMetadataService = new ProjectMetadataService({
        dataDir: metadataDir,
      });
      await projectMetadataService.initialize();
      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: testDir,
        projectMetadataService,
      });

      const initial = await app.request("/api/projects");
      const initialJson = await initial.json();
      const listedProject = initialJson.projects.find(
        (p: { id: string; path: string }) =>
          p.path === projectPath.replaceAll("\\", "/"),
      );
      expect(listedProject).toBeDefined();

      const removeRes = await app.request(`/api/projects/${listedProject.id}`, {
        method: "DELETE",
        headers: {
          "X-Yep-Anywhere": "true",
        },
      });
      const removeJson = await removeRes.json();
      expect(removeRes.status).toBe(200);
      expect(removeJson.removed).toBe(true);

      const hidden = await app.request("/api/projects");
      const hiddenJson = await hidden.json();
      expect(
        hiddenJson.projects.some(
          (p: { id: string }) => p.id === listedProject.id,
        ),
      ).toBe(false);

      const restoreRes = await app.request("/api/projects", {
        method: "POST",
        body: JSON.stringify({ path: projectPath }),
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
      });
      expect(restoreRes.status).toBe(200);

      const restored = await app.request("/api/projects");
      const restoredJson = await restored.json();
      expect(
        restoredJson.projects.some(
          (p: { id: string }) => p.id === listedProject.id,
        ),
      ).toBe(true);
    });
  });
});
