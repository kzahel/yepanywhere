import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectMetadataService } from "../../src/metadata/ProjectMetadataService.js";
import { encodeProjectId } from "../../src/projects/paths.js";

describe("ProjectMetadataService", () => {
  let tempDir: string;
  let service: ProjectMetadataService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join("/tmp", "project-metadata-test-"));
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
                path: "c:/users/kyle/documents/webvam",
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
      const canonicalPath = "C:/users/kyle/documents/webvam";
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

    it("keeps a limited owner across a restart", async () => {
      const projectId = encodeProjectId("/home/archer/notes");
      await service.addProject(projectId, "/home/archer/notes", "archer");

      const reloaded = new ProjectMetadataService({ dataDir: tempDir });
      await reloaded.initialize();

      expect(reloaded.getMetadata(projectId)?.ownerUsername).toBe("archer");
    });

    it("keeps the owner when the superuser adds the project again", async () => {
      const projectId = encodeProjectId("/home/archer/notes");
      await service.addProject(projectId, "/home/archer/notes", "archer");

      await service.addProject(projectId, "/home/archer/notes");

      expect(service.getMetadata(projectId)?.ownerUsername).toBe("archer");
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

    it("deduplicates Windows project metadata by path identity", async () => {
      await service.addProject(
        "legacy-a",
        "C:\\Users\\kyle\\Documents\\webvam",
      );
      await service.addProject(
        "legacy-b",
        "C:\\Users\\kyle\\documents\\webvam",
      );

      const projects = service.getAllProjects();
      expect(Object.keys(projects)).toHaveLength(1);
      expect(
        service.getMetadata(encodeProjectId("C:/Users/kyle/Documents/webvam")),
      ).toBeUndefined();
      expect(
        service.getMetadata(encodeProjectId("C:/Users/kyle/documents/webvam")),
      ).toEqual(
        expect.objectContaining({
          path: "C:/Users/kyle/documents/webvam",
        }),
      );
    });
  });

  describe("project code names", () => {
    it("allocates deterministic unique defaults and persists them", async () => {
      const projects = [
        { id: encodeProjectId("/alpha"), name: "Alpha" },
        { id: encodeProjectId("/alpine"), name: "Alpine" },
        { id: encodeProjectId("/alphanumeric"), name: "Alphanumeric" },
      ];

      const update = await service.ensureProjectCodeNames(projects);
      expect(update).toEqual({
        assignments: [
          { projectId: projects[0].id, codeName: "alh" },
          { projectId: projects[1].id, codeName: "alpi" },
          { projectId: projects[2].id, codeName: "ala" },
        ],
        changedProjectIds: projects.map((project) => project.id).sort(),
      });

      const reloaded = new ProjectMetadataService({ dataDir: tempDir });
      await reloaded.initialize();
      expect(
        await reloaded.ensureProjectCodeNames([...projects].reverse()),
      ).toEqual({
        assignments: [
          { projectId: projects[2].id, codeName: "ala" },
          { projectId: projects[1].id, codeName: "alpi" },
          { projectId: projects[0].id, codeName: "alh" },
        ],
        changedProjectIds: [],
      });
    });

    it("gives an explicit edit priority and reassigns its conflict", async () => {
      const alpha = { id: encodeProjectId("/alpha"), name: "Alpha" };
      const beta = { id: encodeProjectId("/beta"), name: "Beta" };
      await service.ensureProjectCodeNames([alpha, beta]);

      const update = await service.setProjectCodeName(beta.id, "ALP", [
        alpha,
        beta,
      ]);

      expect(update).toEqual({
        assignments: [
          { projectId: beta.id, codeName: "ALP" },
          { projectId: alpha.id, codeName: "alph" },
        ],
        changedProjectIds: [alpha.id, beta.id].sort(),
      });
      expect(service.getProjectCodeName(beta.id)).toBe("ALP");
      expect(service.getProjectCodeName(alpha.id)).toBe("alph");
      await expect(
        service.ensureProjectCodeNames([alpha, beta]),
      ).resolves.toEqual({
        assignments: [
          { projectId: alpha.id, codeName: "alph" },
          { projectId: beta.id, codeName: "ALP" },
        ],
        changedProjectIds: [],
      });
    });

    it("answers a repeated reconciliation from memory until the records change", async () => {
      const alpha = { id: encodeProjectId("/alpha"), name: "Alpha" };
      const beta = { id: encodeProjectId("/beta"), name: "Beta" };
      await service.ensureProjectCodeNames([alpha, beta]);
      const stable = await service.ensureProjectCodeNames([alpha, beta]);
      const again = await service.ensureProjectCodeNames([alpha, beta]);
      expect(again).toEqual(stable);
      // Answered from memory: the same assignments, not a new reconciliation.
      expect(again.assignments[0]).toBe(stable.assignments[0]);
      await service.setProjectCodeName(beta.id, "ALP", [alpha, beta]);
      expect(
        (await service.ensureProjectCodeNames([alpha, beta])).assignments,
      ).toEqual([
        { projectId: alpha.id, codeName: "alph" },
        { projectId: beta.id, codeName: "ALP" },
      ]);
      // A renamed project is a different input.
      expect(
        (
          await service.ensureProjectCodeNames([
            alpha,
            { ...beta, name: "Alpine" },
          ])
        ).assignments,
      ).toContainEqual({ projectId: beta.id, codeName: "ALP" });
    });

    it("reports automatic collision reassignments in code-unit order", async () => {
      const alpha = { id: encodeProjectId("/über/alpha"), name: "Álpha" };
      const first = await service.ensureProjectCodeNames([alpha]);
      expect(first.changedProjectIds).toEqual([alpha.id]);
      expect(first.assignments[0]?.codeName).toBe("alp");

      const alpine = {
        id: encodeProjectId("/東京/alpine"),
        name: "Álpine",
      };
      const update = await service.ensureProjectCodeNames([alpine, alpha]);

      expect(update.changedProjectIds).toEqual([alpha.id, alpine.id].sort());
      expect(update.assignments).toEqual([
        { projectId: alpine.id, codeName: "alpi" },
        { projectId: alpha.id, codeName: "alph" },
      ]);
      expect(
        update.assignments.every(({ projectId }) =>
          /^[A-Za-z0-9_-]+$/.test(projectId),
        ),
      ).toBe(true);
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

  describe("project names", () => {
    it("persists a chosen name, clears it, and drops it on hide", async () => {
      const projectId = encodeProjectId("/repos/alpha");
      await service.addProject(projectId, "/repos/alpha");
      expect(service.getProjectNameOverride(projectId)).toBeUndefined();

      await service.setProjectNameOverride(projectId, "Alpha Service");
      const reloaded = new ProjectMetadataService({ dataDir: tempDir });
      await reloaded.initialize();
      expect(reloaded.getProjectNameOverride(projectId)).toBe("Alpha Service");

      await reloaded.setProjectNameOverride(projectId, null);
      expect(reloaded.getProjectNameOverride(projectId)).toBeUndefined();

      await reloaded.setProjectNameOverride(projectId, "Again");
      await reloaded.hideProject(projectId, "/repos/alpha");
      expect(reloaded.getProjectNameOverride(projectId)).toBeUndefined();
    });

    it("names a project by its chosen name, else by its path's last component", async () => {
      expect(service.getProjectDisplayName("/repos/alpha")).toBe("alpha");
      await service.setProjectNameOverride(
        encodeProjectId("/repos/alpha"),
        "Alpha Service",
      );
      expect(service.getProjectDisplayName("/repos/alpha")).toBe(
        "Alpha Service",
      );
      expect(service.getProjectDisplayName("/repos/beta")).toBe("beta");
    });
  });

  describe("hideProject", () => {
    it("hides a project and removes it from the added list", async () => {
      const projectId = encodeProjectId("/path1");
      await service.addProject(projectId, "/path1");

      await service.hideProject(projectId, "/path1");

      expect(service.getMetadata(projectId)).toBeUndefined();
      expect(service.isHiddenProject(projectId)).toBe(true);
      expect(service.getAllHiddenProjects()[projectId]).toEqual(
        expect.objectContaining({
          path: "/path1",
          hiddenAt: expect.any(String),
        }),
      );
    });

    it("unhides a project when it is added again", async () => {
      const projectId = encodeProjectId("/path1");
      expect(service.isHiddenProjectPath("/path1")).toBe(false);
      await service.hideProject(projectId, "/path1");
      expect(service.isHiddenProjectPath("/path1")).toBe(true);

      await service.addProject(projectId, "/path1");

      expect(service.isHiddenProject(projectId)).toBe(false);
      expect(service.isHiddenProjectPath("/path1")).toBe(false);
      expect(service.getMetadata(projectId)).toBeDefined();
    });

    it("gives a hidden project its owner back when it is added again", async () => {
      const projectId = encodeProjectId("/home/archer/notes");
      await service.addProject(projectId, "/home/archer/notes", "archer");
      await service.hideProject(projectId, "/home/archer/notes");

      const reloaded = new ProjectMetadataService({ dataDir: tempDir });
      await reloaded.initialize();
      expect(reloaded.isHiddenProjectPath("/home/archer/notes")).toBe(true);
      await reloaded.addProject(projectId, "/home/archer/notes");
      expect(reloaded.isHiddenProjectPath("/home/archer/notes")).toBe(false);

      expect(reloaded.getMetadata(projectId)?.ownerUsername).toBe("archer");
    });

    it("hides Windows project casing variants together", async () => {
      const addedPath = "C:/Users/kyle/Documents/webvam";
      const hiddenPath = "C:/Users/kyle/documents/webvam";
      await service.addProject(encodeProjectId(addedPath), addedPath);

      await service.hideProject(encodeProjectId(hiddenPath), hiddenPath);

      expect(service.getAllProjects()).toEqual({});
      expect(service.isHiddenProjectPath(addedPath)).toBe(true);
      expect(service.isHiddenProjectPath(hiddenPath)).toBe(true);
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
});
