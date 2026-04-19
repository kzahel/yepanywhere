import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectMetadataService } from "../../src/metadata/ProjectMetadataService.js";
import { encodeProjectId } from "../../src/projects/paths.js";

describe("ProjectMetadataService", () => {
  let tempDir: string;
  let service: ProjectMetadataService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(tmpdir(), "project-metadata-test-"));
    service = new ProjectMetadataService({ dataDir: tempDir });
    await service.initialize();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("initialize", () => {
    it("creates data directory and starts with empty state", async () => {
      const projects = service.getAllProjects();
      expect(projects).toEqual({});
    });

    it("loads existing state from disk", async () => {
      const projectPath = "/test/path";
      const projectId = encodeProjectId(projectPath);
      // Add a project
      await service.addProject(projectId, projectPath);

      // Create a new service instance with the same data dir
      const newService = new ProjectMetadataService({ dataDir: tempDir });
      await newService.initialize();

      const projects = newService.getAllProjects();
      expect(projects[projectId]).toBeDefined();
      expect(projects[projectId].path).toBe(projectPath);
    });

    it("canonicalizes and deduplicates mixed-slash Windows project metadata", async () => {
      await fs.writeFile(
        path.join(tempDir, "project-metadata.json"),
        JSON.stringify(
          {
            version: 1,
            projects: {
              oldBackslashId: {
                path: "C:\\Users\\kyle\\Documents\\webvam",
                addedAt: "2026-04-06T09:00:00.000Z",
              },
              oldForwardSlashId: {
                path: "c:/Users/kyle/Documents/webvam",
                addedAt: "2026-04-06T10:00:00.000Z",
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const newService = new ProjectMetadataService({ dataDir: tempDir });
      await newService.initialize();

      const projects = newService.getAllProjects();
      const canonicalPath = "C:/Users/kyle/Documents/webvam";
      const canonicalProjectId = encodeProjectId(canonicalPath);
      expect(Object.keys(projects)).toEqual([canonicalProjectId]);
      expect(projects[canonicalProjectId]).toEqual({
        path: canonicalPath,
        addedAt: "2026-04-06T10:00:00.000Z",
      });
    });
  });

  describe("addProject", () => {
    it("adds a project with path and timestamp", async () => {
      const projectPath = "/home/user/code/project1";
      const projectId = encodeProjectId(projectPath);
      await service.addProject(projectId, projectPath);

      const metadata = service.getMetadata(projectId);
      expect(metadata).toBeDefined();
      expect(metadata?.path).toBe(projectPath);
      expect(metadata?.addedAt).toBeDefined();
    });

    it("persists project to disk", async () => {
      const projectPath = "/home/user/code/project1";
      const projectId = encodeProjectId(projectPath);
      await service.addProject(projectId, projectPath);

      // Read the file directly
      const content = await fs.readFile(
        path.join(tempDir, "project-metadata.json"),
        "utf-8",
      );
      const parsed = JSON.parse(content);
      expect(parsed.projects[projectId]).toBeDefined();
    });

    it("stores canonical Windows project IDs and paths", async () => {
      await service.addProject(
        "legacy-id",
        "c:\\Users\\kyle\\Documents\\webvam",
      );

      const canonicalPath = "C:/Users/kyle/Documents/webvam";
      const canonicalProjectId = encodeProjectId(canonicalPath);
      expect(service.getMetadata(canonicalProjectId)).toEqual(
        expect.objectContaining({
          path: canonicalPath,
        }),
      );
      expect(service.getMetadata("legacy-id")).toBeUndefined();
    });
  });

  describe("removeProject", () => {
    it("removes a project from the list", async () => {
      const projectId1 = encodeProjectId("/path1");
      const projectId2 = encodeProjectId("/path2");
      await service.addProject(projectId1, "/path1");
      await service.addProject(projectId2, "/path2");

      await service.removeProject(projectId1);

      expect(service.getMetadata(projectId1)).toBeUndefined();
      expect(service.getMetadata(projectId2)).toBeDefined();
    });
  });

  describe("hideProject", () => {
    it("hides a project without deleting its sessions from disk", async () => {
      const projectPath = "/home/user/code/project1";
      const projectId = encodeProjectId(projectPath);
      await service.hideProject(projectId, projectPath);

      expect(service.getMetadata(projectId)).toBeUndefined();
      expect(service.getAllHiddenProjects()[projectId]).toEqual(
        expect.objectContaining({
          path: projectPath,
        }),
      );
    });

    it("restores a hidden project when it is added again", async () => {
      const projectPath = "/home/user/code/project1";
      const projectId = encodeProjectId(projectPath);
      await service.hideProject(projectId, projectPath);

      await service.addProject(projectId, projectPath);

      expect(service.getAllHiddenProjects()[projectId]).toBeUndefined();
      expect(service.getMetadata(projectId)).toEqual(
        expect.objectContaining({
          path: projectPath,
        }),
      );
    });
  });

  describe("isAddedProject", () => {
    it("returns true for added projects", async () => {
      const projectId = encodeProjectId("/path1");
      await service.addProject(projectId, "/path1");

      expect(service.isAddedProject(projectId)).toBe(true);
      expect(service.isAddedProject("proj-2")).toBe(false);
    });
  });

  describe("getAllProjects", () => {
    it("returns all added projects", async () => {
      const projectId1 = encodeProjectId("/path1");
      const projectId2 = encodeProjectId("/path2");
      await service.addProject(projectId1, "/path1");
      await service.addProject(projectId2, "/path2");

      const projects = service.getAllProjects();
      expect(Object.keys(projects)).toHaveLength(2);
      expect(projects[projectId1].path).toBe("/path1");
      expect(projects[projectId2].path).toBe("/path2");
    });
  });

  describe("getAllHiddenProjects", () => {
    it("returns all hidden projects", async () => {
      const projectId1 = encodeProjectId("/path1");
      const projectId2 = encodeProjectId("/path2");
      await service.hideProject(projectId1, "/path1");
      await service.hideProject(projectId2, "/path2");

      const projects = service.getAllHiddenProjects();
      expect(Object.keys(projects)).toHaveLength(2);
      expect(projects[projectId1].path).toBe("/path1");
      expect(projects[projectId2].path).toBe("/path2");
    });
  });
});
