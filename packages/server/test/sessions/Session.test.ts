import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toUrlProjectId } from "@yep-anywhere/shared";
import type { AppSessionSummary } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionIndexService } from "../../src/indexes/SessionIndexService.js";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { Session, type SessionDeps } from "../../src/sessions/Session.js";
import { SessionReader } from "../../src/sessions/reader.js";

describe("Session", () => {
  let testDir: string;
  let sessionDir: string;
  let indexDir: string;
  let metadataDir: string;
  let reader: SessionReader;
  let indexService: SessionIndexService;
  let metadataService: SessionMetadataService;
  let deps: SessionDeps;
  const projectId = toUrlProjectId("/test/project");

  beforeEach(async () => {
    testDir = join(tmpdir(), `claude-session-test-${randomUUID()}`);
    sessionDir = join(testDir, "sessions");
    indexDir = join(testDir, "indexes");
    metadataDir = join(testDir, "metadata");

    await mkdir(sessionDir, { recursive: true });
    await mkdir(indexDir, { recursive: true });
    await mkdir(metadataDir, { recursive: true });

    reader = new SessionReader({ sessionDir });
    indexService = new SessionIndexService({
      dataDir: indexDir,
      projectsDir: testDir,
    });
    metadataService = new SessionMetadataService({ dataDir: metadataDir });

    await indexService.initialize();
    await metadataService.initialize();

    deps = {
      indexService,
      metadataService,
      reader,
      sessionDir,
    };
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // Helper to create a session JSONL file
  async function createSessionFile(
    sessionId: string,
    firstMessage: string,
  ): Promise<void> {
    const jsonl = JSON.stringify({
      type: "user",
      message: { content: firstMessage, role: "user" },
      uuid: `msg-${sessionId}-1`,
      timestamp: new Date().toISOString(),
    });
    await writeFile(join(sessionDir, `${sessionId}.jsonl`), `${jsonl}\n`);
  }

  describe("load", () => {
    it("loads session from disk with auto-title", async () => {
      await createSessionFile("session-456", "Hello, help me with this task");

      const session = await Session.load("session-456", projectId, deps);

      expect(session).not.toBeNull();
      expect(session?.id).toBe("session-456");
      expect(session?.autoTitle).toBe("Hello, help me with this task");
      expect(session?.displayTitle).toBe("Hello, help me with this task");
      expect(session?.projectId).toBe(projectId);
    });

    it("loads session with custom title from metadata", async () => {
      await createSessionFile("session-789", "Original prompt");
      await metadataService.setTitle("session-789", "My renamed session");

      const session = await Session.load("session-789", projectId, deps);

      expect(session).not.toBeNull();
      expect(session?.autoTitle).toBe("Original prompt");
      expect(session?.customTitle).toBe("My renamed session");
      expect(session?.displayTitle).toBe("My renamed session");
    });

    it("loads session with archived status", async () => {
      await createSessionFile("session-archived", "Some prompt");
      await metadataService.setArchived("session-archived", true);

      const session = await Session.load("session-archived", projectId, deps);

      expect(session).not.toBeNull();
      expect(session?.isArchived).toBe(true);
    });

    it("loads session with starred status", async () => {
      await createSessionFile("session-starred", "Some prompt");
      await metadataService.setStarred("session-starred", true);

      const session = await Session.load("session-starred", projectId, deps);

      expect(session).not.toBeNull();
      expect(session?.isStarred).toBe(true);
    });

    it("returns null for non-existent session", async () => {
      const session = await Session.load("nonexistent", projectId, deps);

      expect(session).toBeNull();
    });

    it("includes all summary fields", async () => {
      await createSessionFile("session-full", "Test prompt");

      const session = await Session.load("session-full", projectId, deps);

      expect(session).not.toBeNull();
      expect(session?.createdAt).toBeDefined();
      expect(session?.updatedAt).toBeDefined();
      expect(session?.messageCount).toBe(1);
      expect(session?.status).toEqual({ state: "idle" });
    });
  });

  describe("fromSummary", () => {
    it("creates Session from AppSessionSummary", () => {
      const summary: AppSessionSummary = {
        id: "session-from-summary",
        projectId,
        title: "Auto title",
        fullTitle: "Full auto title",
        customTitle: "Custom name",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-02T00:00:00Z",
        messageCount: 10,
        status: { state: "owned", processId: "proc-1" },
        isArchived: true,
        isStarred: true,
        pendingInputType: "tool-approval",
        processState: "waiting-input",
        hasUnread: true,
      };

      const session = Session.fromSummary(summary, deps);

      expect(session.id).toBe("session-from-summary");
      expect(session.autoTitle).toBe("Auto title");
      expect(session.fullTitle).toBe("Full auto title");
      expect(session.customTitle).toBe("Custom name");
      expect(session.displayTitle).toBe("Custom name");
      expect(session.isArchived).toBe(true);
      expect(session.isStarred).toBe(true);
      expect(session.isActive).toBe(true);
      expect(session.isWaitingForInput).toBe(true);
      expect(session.hasUnread).toBe(true);
      expect(session.needsAttention).toBe(true);
    });
  });

  describe("rename", () => {
    it("sets custom title via metadata service", async () => {
      await createSessionFile("session-rename", "Original");
      const session = await Session.load("session-rename", projectId, deps);

      await session?.rename("New custom name");

      // Verify it was persisted
      expect(metadataService.getMetadata("session-rename")?.customTitle).toBe(
        "New custom name",
      );
    });

    it("clears custom title when passed undefined", async () => {
      await createSessionFile("session-clear", "Original");
      await metadataService.setTitle("session-clear", "Had a name");
      const session = await Session.load("session-clear", projectId, deps);

      await session?.rename(undefined);

      expect(
        metadataService.getMetadata("session-clear")?.customTitle,
      ).toBeUndefined();
    });

    it("clears custom title when passed empty string", async () => {
      await createSessionFile("session-empty", "Original");
      await metadataService.setTitle("session-empty", "Had a name");
      const session = await Session.load("session-empty", projectId, deps);

      await session?.rename("");

      expect(metadataService.getMetadata("session-empty")).toBeUndefined();
    });
  });

  describe("setArchived", () => {
    it("sets archived status via metadata service", async () => {
      await createSessionFile("session-archive", "Prompt");
      const session = await Session.load("session-archive", projectId, deps);

      await session?.setArchived(true);

      expect(metadataService.getMetadata("session-archive")?.isArchived).toBe(
        true,
      );
    });

    it("clears archived status when set to false", async () => {
      await createSessionFile("session-unarchive", "Prompt");
      await metadataService.setArchived("session-unarchive", true);
      const session = await Session.load("session-unarchive", projectId, deps);

      await session?.setArchived(false);

      expect(metadataService.getMetadata("session-unarchive")).toBeUndefined();
    });
  });

  describe("setStarred", () => {
    it("sets starred status via metadata service", async () => {
      await createSessionFile("session-star", "Prompt");
      const session = await Session.load("session-star", projectId, deps);

      await session?.setStarred(true);

      expect(metadataService.getMetadata("session-star")?.isStarred).toBe(true);
    });

    it("clears starred status when set to false", async () => {
      await createSessionFile("session-unstar", "Prompt");
      await metadataService.setStarred("session-unstar", true);
      const session = await Session.load("session-unstar", projectId, deps);

      await session?.setStarred(false);

      expect(metadataService.getMetadata("session-unstar")).toBeUndefined();
    });
  });

  describe("refresh", () => {
    it("returns new Session instance with updated data", async () => {
      await createSessionFile("session-refresh", "Initial prompt");
      const session = await Session.load("session-refresh", projectId, deps);

      // Update the metadata externally
      await metadataService.setTitle("session-refresh", "Updated name");

      // Refresh should pick up the change
      const refreshed = await session?.refresh();

      expect(refreshed).not.toBeNull();
      expect(refreshed?.customTitle).toBe("Updated name");
      expect(refreshed?.displayTitle).toBe("Updated name");
    });

    it("invalidates cache and re-reads from disk", async () => {
      await createSessionFile("session-cache", "First prompt");
      const session = await Session.load("session-cache", projectId, deps);

      // Modify the file directly
      const newJsonl = JSON.stringify({
        type: "user",
        message: { content: "Updated prompt", role: "user" },
        uuid: "msg-new",
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(sessionDir, "session-cache.jsonl"), `${newJsonl}\n`);

      const refreshed = await session?.refresh();

      expect(refreshed).not.toBeNull();
      expect(refreshed?.autoTitle).toBe("Updated prompt");
    });
  });

  describe("getAutoTitle", () => {
    it("returns the auto-generated title", async () => {
      await createSessionFile("session-auto", "My auto title");
      const session = await Session.load("session-auto", projectId, deps);

      expect(session?.getAutoTitle()).toBe("My auto title");
    });
  });

  describe("toJSON", () => {
    it("returns plain object with all properties", async () => {
      await createSessionFile("session-json", "Auto title here");
      await metadataService.setTitle("session-json", "Custom name");
      await metadataService.setArchived("session-json", true);
      await metadataService.setStarred("session-json", true);

      const session = await Session.load("session-json", projectId, deps);
      const json = session?.toJSON();

      expect(json.id).toBe("session-json");
      expect(json.projectId).toBe(projectId);
      expect(json.title).toBe("Auto title here");
      expect(json.fullTitle).toBe("Auto title here");
      expect(json.customTitle).toBe("Custom name");
      expect(json.isArchived).toBe(true);
      expect(json.isStarred).toBe(true);
      expect(json.createdAt).toBeDefined();
      expect(json.updatedAt).toBeDefined();
      expect(json.messageCount).toBe(1);
      expect(json.status).toEqual({ state: "idle" });
    });
  });

  describe("inherited getters from SessionView", () => {
    it("hasCustomTitle returns true when customTitle is set", async () => {
      await createSessionFile("session-has-custom", "Prompt");
      await metadataService.setTitle("session-has-custom", "Custom");
      const session = await Session.load("session-has-custom", projectId, deps);

      expect(session?.hasCustomTitle).toBe(true);
    });

    it("hasCustomTitle returns false when no customTitle", async () => {
      await createSessionFile("session-no-custom", "Prompt");
      const session = await Session.load("session-no-custom", projectId, deps);

      expect(session?.hasCustomTitle).toBe(false);
    });

    it("tooltipTitle returns fullTitle", async () => {
      await createSessionFile(
        "session-tooltip",
        "This is a longer prompt for tooltip",
      );
      const session = await Session.load("session-tooltip", projectId, deps);

      expect(session?.tooltipTitle).toBe("This is a longer prompt for tooltip");
    });

    it("isIdle returns true for idle sessions", async () => {
      await createSessionFile("session-idle", "Prompt");
      const session = await Session.load("session-idle", projectId, deps);

      expect(session?.isIdle).toBe(true);
      expect(session?.isActive).toBe(false);
      expect(session?.isExternal).toBe(false);
    });

    it("needsAttention reflects unread and pending state", () => {
      const summary: AppSessionSummary = {
        id: "session-attention",
        projectId,
        title: "Test",
        fullTitle: "Test",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        messageCount: 1,
        status: { state: "idle" },
        hasUnread: true,
        pendingInputType: "tool-approval",
      };

      const session = Session.fromSummary(summary, deps);

      expect(session.needsAttention).toBe(true);
      expect(session.hasUnread).toBe(true);
      expect(session.pendingInputType).toBe("tool-approval");
    });
  });
});
