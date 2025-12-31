import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";

describe("SessionMetadataService", () => {
  let testDir: string;
  let service: SessionMetadataService;

  beforeEach(async () => {
    testDir = join(tmpdir(), `claude-metadata-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    service = new SessionMetadataService({ dataDir: testDir });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("initialization", () => {
    it("starts with empty state when file doesn't exist", async () => {
      await service.initialize();

      expect(service.getAllMetadata()).toEqual({});
    });

    it("creates file on first update when file doesn't exist", async () => {
      await service.initialize();
      await service.setTitle("session-1", "My Custom Title");

      const content = await readFile(
        join(testDir, "session-metadata.json"),
        "utf-8",
      );
      const state = JSON.parse(content);
      expect(state.version).toBe(1);
      expect(state.sessions["session-1"]).toBeDefined();
      expect(state.sessions["session-1"].customTitle).toBe("My Custom Title");
    });

    it("loads existing state from JSON file", async () => {
      const existingState = {
        version: 1,
        sessions: {
          "session-1": { customTitle: "Test Title" },
          "session-2": { isArchived: true },
          "session-3": { customTitle: "Archived One", isArchived: true },
        },
      };
      await writeFile(
        join(testDir, "session-metadata.json"),
        JSON.stringify(existingState),
      );

      await service.initialize();

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "Test Title",
      });
      expect(service.getMetadata("session-2")).toEqual({ isArchived: true });
      expect(service.getMetadata("session-3")).toEqual({
        customTitle: "Archived One",
        isArchived: true,
      });
    });

    it("handles corrupted JSON gracefully", async () => {
      await writeFile(
        join(testDir, "session-metadata.json"),
        "not valid json{{{",
      );

      // Should not throw
      await service.initialize();

      // Should start fresh
      expect(service.getAllMetadata()).toEqual({});
    });
  });

  describe("setTitle", () => {
    it("sets custom title for a session", async () => {
      await service.initialize();

      await service.setTitle("session-1", "My Project Work");

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "My Project Work",
      });
    });

    it("trims whitespace from title", async () => {
      await service.initialize();

      await service.setTitle("session-1", "  Padded Title  ");

      expect(service.getMetadata("session-1")?.customTitle).toBe(
        "Padded Title",
      );
    });

    it("clears title when empty string provided", async () => {
      await service.initialize();
      await service.setTitle("session-1", "Initial Title");

      await service.setTitle("session-1", "");

      expect(service.getMetadata("session-1")).toBeUndefined();
    });

    it("clears title when undefined provided", async () => {
      await service.initialize();
      await service.setTitle("session-1", "Initial Title");

      await service.setTitle("session-1", undefined);

      expect(service.getMetadata("session-1")).toBeUndefined();
    });

    it("preserves archived status when updating title", async () => {
      await service.initialize();
      await service.setArchived("session-1", true);

      await service.setTitle("session-1", "New Title");

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "New Title",
        isArchived: true,
      });
    });

    it("persists title to disk", async () => {
      await service.initialize();
      await service.setTitle("session-1", "Persistent Title");

      // Create new instance and verify it loads the persisted data
      const newService = new SessionMetadataService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getMetadata("session-1")?.customTitle).toBe(
        "Persistent Title",
      );
    });
  });

  describe("setArchived", () => {
    it("sets archived status for a session", async () => {
      await service.initialize();

      await service.setArchived("session-1", true);

      expect(service.getMetadata("session-1")).toEqual({ isArchived: true });
    });

    it("clears archived status when set to false", async () => {
      await service.initialize();
      await service.setArchived("session-1", true);

      await service.setArchived("session-1", false);

      expect(service.getMetadata("session-1")).toBeUndefined();
    });

    it("preserves custom title when updating archived status", async () => {
      await service.initialize();
      await service.setTitle("session-1", "My Title");

      await service.setArchived("session-1", true);

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "My Title",
        isArchived: true,
      });
    });

    it("persists archived status to disk", async () => {
      await service.initialize();
      await service.setArchived("session-1", true);

      const newService = new SessionMetadataService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getMetadata("session-1")?.isArchived).toBe(true);
    });
  });

  describe("setStarred", () => {
    it("sets starred status for a session", async () => {
      await service.initialize();

      await service.setStarred("session-1", true);

      expect(service.getMetadata("session-1")).toEqual({ isStarred: true });
    });

    it("clears starred status when set to false", async () => {
      await service.initialize();
      await service.setStarred("session-1", true);

      await service.setStarred("session-1", false);

      expect(service.getMetadata("session-1")).toBeUndefined();
    });

    it("preserves other fields when updating starred status", async () => {
      await service.initialize();
      await service.setTitle("session-1", "My Title");
      await service.setArchived("session-1", true);

      await service.setStarred("session-1", true);

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "My Title",
        isArchived: true,
        isStarred: true,
      });
    });

    it("persists starred status to disk", async () => {
      await service.initialize();
      await service.setStarred("session-1", true);

      const newService = new SessionMetadataService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getMetadata("session-1")?.isStarred).toBe(true);
    });
  });

  describe("updateMetadata", () => {
    it("updates title, archived, and starred at once", async () => {
      await service.initialize();

      await service.updateMetadata("session-1", {
        title: "New Title",
        archived: true,
        starred: true,
      });

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "New Title",
        isArchived: true,
        isStarred: true,
      });
    });

    it("updates only title when others not provided", async () => {
      await service.initialize();
      await service.setArchived("session-1", true);
      await service.setStarred("session-1", true);

      await service.updateMetadata("session-1", { title: "Just Title" });

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "Just Title",
        isArchived: true,
        isStarred: true,
      });
    });

    it("updates only starred when others not provided", async () => {
      await service.initialize();
      await service.setTitle("session-1", "Existing Title");
      await service.setArchived("session-1", true);

      await service.updateMetadata("session-1", { starred: false });

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "Existing Title",
        isArchived: true,
      });
    });

    it("clears title with empty string while setting archived", async () => {
      await service.initialize();
      await service.setTitle("session-1", "Old Title");

      await service.updateMetadata("session-1", { title: "", archived: true });

      expect(service.getMetadata("session-1")).toEqual({ isArchived: true });
    });
  });

  describe("clearSession", () => {
    it("removes all metadata for a session", async () => {
      await service.initialize();
      await service.setTitle("session-1", "Title");
      await service.setArchived("session-1", true);

      await service.clearSession("session-1");

      expect(service.getMetadata("session-1")).toBeUndefined();
    });

    it("persists removal to disk", async () => {
      await service.initialize();
      await service.setTitle("session-1", "Title");
      await service.clearSession("session-1");

      const newService = new SessionMetadataService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getMetadata("session-1")).toBeUndefined();
    });

    it("does nothing if session not tracked", async () => {
      await service.initialize();

      // Should not throw
      await service.clearSession("nonexistent-session");

      expect(service.getMetadata("nonexistent-session")).toBeUndefined();
    });
  });

  describe("getAllMetadata", () => {
    it("returns copy of all entries", async () => {
      await service.initialize();

      await service.setTitle("session-1", "Title One");
      await service.setArchived("session-2", true);
      await service.updateMetadata("session-3", {
        title: "Title Three",
        archived: true,
      });

      const all = service.getAllMetadata();

      expect(all).toEqual({
        "session-1": { customTitle: "Title One" },
        "session-2": { isArchived: true },
        "session-3": { customTitle: "Title Three", isArchived: true },
      });

      // Verify it's a copy (modifying shouldn't affect internal state)
      all["session-4"] = { customTitle: "Injected" };
      expect(service.getMetadata("session-4")).toBeUndefined();
    });
  });

  describe("concurrent operations", () => {
    it("handles concurrent updates gracefully", async () => {
      await service.initialize();

      // Fire off multiple concurrent updates
      await Promise.all([
        service.setTitle("session-1", "Title 1"),
        service.setArchived("session-2", true),
        service.updateMetadata("session-3", {
          title: "Title 3",
          archived: true,
        }),
        service.setTitle("session-1", "Updated Title 1"), // Update session-1 again
      ]);

      // All should be persisted
      const newService = new SessionMetadataService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getMetadata("session-1")?.customTitle).toBe(
        "Updated Title 1",
      );
      expect(newService.getMetadata("session-2")?.isArchived).toBe(true);
      expect(newService.getMetadata("session-3")).toEqual({
        customTitle: "Title 3",
        isArchived: true,
      });
    });
  });

  describe("file path", () => {
    it("returns the correct file path", async () => {
      expect(service.getFilePath()).toBe(
        join(testDir, "session-metadata.json"),
      );
    });
  });
});
