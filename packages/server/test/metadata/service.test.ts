import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CacheMissBillingRecord,
  WorkstreamId,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";

function cacheMissRecord(
  id: string,
  overrides: Partial<CacheMissBillingRecord> = {},
): CacheMissBillingRecord {
  return {
    id,
    timestamp: "2026-08-25T12:00:00.000Z",
    provider: "claude",
    sessionId: "session-1",
    projectId: "project-1" as CacheMissBillingRecord["projectId"],
    sessionPath: "/projects/project-1/sessions/session-1",
    reason: "warm-session-cache-miss",
    outcome: "unexpected-recompute",
    exception: true,
    observedUsage: {
      inputTokens: 100_000,
      cacheReadTokens: 0,
      totalContextTokens: 100_000,
      uncachedInputTokens: 100_000,
    },
    expectedInputCost: {
      state: "expected-new-content",
      source: "warm-session",
      prefixBasis: "same-session-prefix",
      freshEnough: true,
      providerFreshWindowMinutes: 60,
    },
    wastedInputTokens: 100_000,
    freshWindowMinutes: 60,
    expectedCacheSource: "warm-session",
    ...overrides,
  };
}

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
      expect(state.version).toBe(3);
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

    it("migrates legacy parent links into /btw or fork lineage", async () => {
      await writeFile(
        join(testDir, "session-metadata.json"),
        JSON.stringify({
          version: 2,
          sessions: {
            aside: {
              customTitle: "/btw check the side path",
              parentSessionId: "mother-session",
            },
            clone: {
              customTitle: "Clone: main session",
              parentSessionId: "source-session",
            },
          },
        }),
      );

      await service.initialize();

      expect(service.getMetadata("aside")).toEqual({
        customTitle: "/btw check the side path",
        parentSessionId: "mother-session",
        parentSessionKind: "btw-aside",
      });
      expect(service.getMetadata("clone")).toEqual({
        customTitle: "Clone: main session",
        forkedFromSessionId: "source-session",
      });
      const persisted = JSON.parse(
        await readFile(join(testDir, "session-metadata.json"), "utf-8"),
      );
      expect(persisted.version).toBe(3);
    });

    it("migrates display objects and marks interrupted jobs as errors", async () => {
      const existingState = {
        version: 1,
        sessions: {
          "session-1": {
            transcriptDisplayObjects: [
              {
                id: "display-1",
                kind: "fork-summary",
                createdAt: "2026-06-23T00:00:00.000Z",
                placementAfterMessageId: "assistant-1",
                sourceMessageId: "user-1",
                retainedThroughMessageId: "assistant-1",
                status: "generating",
              },
            ],
          },
        },
      };
      await writeFile(
        join(testDir, "session-metadata.json"),
        JSON.stringify(existingState),
      );

      await service.initialize();

      expect(service.getTranscriptDisplayObjects("session-1")).toEqual([
        expect.objectContaining({
          id: "display-1",
          status: "error",
          error: "Fork summary interrupted by server restart",
        }),
      ]);
      const persisted = JSON.parse(
        await readFile(join(testDir, "session-metadata.json"), "utf-8"),
      );
      expect(persisted.version).toBe(3);
    });

    it("handles corrupted JSON gracefully", async () => {
      await writeFile(
        join(testDir, "session-metadata.json"),
        "not valid json{{{",
      );
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Should not throw
      try {
        await service.initialize();
        expect(warnSpy).toHaveBeenCalledWith(
          "[SessionMetadataService] Failed to load state, starting fresh:",
          expect.any(SyntaxError),
        );
      } finally {
        warnSpy.mockRestore();
      }

      // Should start fresh
      expect(service.getAllMetadata()).toEqual({});
    });
  });

  describe("cache miss billing events", () => {
    it("hides expected expiry evidence unless the caller opts in", async () => {
      await service.initialize();
      await service.addCacheMissBillingEvent(
        "session-1",
        cacheMissRecord("unexpected"),
      );
      await service.addCacheMissBillingEvent(
        "session-1",
        cacheMissRecord("expected-expiry", {
          timestamp: "2026-08-25T13:00:00.000Z",
          reason: "warm-session-cache-expiry",
          outcome: "expected-cache-expiry",
          exception: false,
          expectedInputCost: {
            state: "expected-new-content",
            source: "warm-session",
            prefixBasis: "same-session-prefix",
            freshEnough: false,
            providerFreshWindowMinutes: 60,
          },
        }),
      );

      expect(service.getCacheMissBillingEvents().map(({ id }) => id)).toEqual([
        "unexpected",
      ]);
      expect(
        service
          .getCacheMissBillingEvents(200, { includeExpectedExpiry: true })
          .map(({ id }) => id),
      ).toEqual(["expected-expiry", "unexpected"]);
    });
  });

  describe("session ID remapping", () => {
    it("moves provisional metadata and redirects late writes", async () => {
      await service.initialize();
      await service.setProvider("temporary-session", "claude-gateway");

      await service.remapSessionId("temporary-session", "canonical-session");
      await service.setRequestedModel("temporary-session", "gpt-5.6-terra");

      expect(service.getMetadata("canonical-session")).toEqual({
        provider: "claude-gateway",
        requestedModel: "gpt-5.6-terra",
      });
      expect(service.getMetadata("temporary-session")).toEqual({
        provider: "claude-gateway",
        requestedModel: "gpt-5.6-terra",
      });
      expect(service.getAllMetadata()).toEqual({
        "canonical-session": {
          provider: "claude-gateway",
          requestedModel: "gpt-5.6-terra",
        },
      });
    });
  });

  describe("provider persistence", () => {
    it("does not save when the provider is already current", async () => {
      await service.initialize();
      await service.setProvider("session-1", "codex");
      const saveSpy = vi.spyOn(
        service as unknown as { doSave(): Promise<void> },
        "doSave",
      );

      await service.setProvider("session-1", "codex");

      expect(saveSpy).not.toHaveBeenCalled();
      expect(service.getMetadata("session-1")?.provider).toBe("codex");
    });

    it("returns distinct providers without copying all metadata", async () => {
      await service.initialize();
      await service.setProvider("session-1", "codex");
      await service.setProvider("session-2", "codex");
      await service.setProvider("session-3", "claude-gateway");

      expect(service.getRecordedProviders()).toEqual([
        "codex",
        "claude-gateway",
      ]);
    });
  });

  describe("effective launch settings", () => {
    it("persists complete settings and preserves exact default model tokens", async () => {
      await service.initialize();

      await service.recordEffectiveLaunchSettings("session-1", {
        permissionMode: "bypassPermissions",
        requestedModel: "default",
        serviceTier: "priority",
        thinking: { type: "adaptive", display: "summarized" },
        effort: "high",
      });

      const reloaded = new SessionMetadataService({ dataDir: testDir });
      await reloaded.initialize();
      expect(reloaded.getEffectiveLaunchSettings("session-1")).toEqual({
        schemaVersion: 1,
        revision: 1,
        permissionMode: "bypassPermissions",
        requestedModel: "default",
        serviceTier: "priority",
        thinking: { type: "adaptive", display: "summarized" },
        effort: "high",
      });
      expect(reloaded.getRequestedModel("session-1")).toBe("default");
    });

    it("advances revisions only when the applied snapshot changes", async () => {
      await service.initialize();
      const value = {
        permissionMode: "plan" as const,
        requestedModel: "opus",
        serviceTier: null,
        thinking: null,
        effort: null,
      };

      const first = await service.recordEffectiveLaunchSettings(
        "session-1",
        value,
      );
      const duplicate = await service.recordEffectiveLaunchSettings(
        "session-1",
        value,
      );
      const changed = await service.recordEffectiveLaunchSettings("session-1", {
        ...value,
        effort: "max",
      });

      expect(first.revision).toBe(1);
      expect(duplicate.revision).toBe(1);
      expect(changed.revision).toBe(2);
    });

    it("retries an identical snapshot after its first save fails", async () => {
      await service.initialize();
      const saveSpy = vi
        .spyOn(service as unknown as { doSave(): Promise<void> }, "doSave")
        .mockRejectedValueOnce(new Error("disk full"));
      const value = {
        permissionMode: "plan" as const,
        requestedModel: "opus",
        serviceTier: null,
        thinking: null,
        effort: null,
      };

      await expect(
        service.recordEffectiveLaunchSettings("session-1", value),
      ).rejects.toThrow("disk full");
      await expect(
        service.recordEffectiveLaunchSettings("session-1", value),
      ).resolves.toMatchObject({ revision: 1, requestedModel: "opus" });
      expect(saveSpy).toHaveBeenCalledTimes(2);

      const reloaded = new SessionMetadataService({ dataDir: testDir });
      await reloaded.initialize();
      expect(reloaded.getEffectiveLaunchSettings("session-1")).toMatchObject({
        revision: 1,
        requestedModel: "opus",
      });
    });

    it("uses legacy requestedModel only when no durable record exists", async () => {
      await service.initialize();
      await service.setRequestedModel("legacy", "sonnet");
      expect(service.getRequestedModel("legacy")).toBe("sonnet");

      await service.recordEffectiveLaunchSettings("legacy", {
        permissionMode: "default",
        requestedModel: null,
        serviceTier: null,
        thinking: null,
        effort: null,
      });

      expect(service.getRequestedModel("legacy")).toBeUndefined();
      expect(service.getMetadata("legacy")?.requestedModel).toBeUndefined();
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

    it("stores per-session heartbeat settings and preserves other metadata", async () => {
      await service.initialize();
      await service.setTitle("session-1", "Heartbeat Session");

      await service.updateMetadata("session-1", {
        heartbeatTurnsEnabled: true,
        heartbeatTurnsAfterMinutes: 7,
        heartbeatTurnText: "session heartbeat override",
      });

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "Heartbeat Session",
        heartbeatTurnsEnabled: true,
        heartbeatTurnsAfterMinutes: 7,
        heartbeatTurnText: "session heartbeat override",
      });
    });

    it("clears heartbeat overrides while keeping the session opt-in flag", async () => {
      await service.initialize();

      await service.updateMetadata("session-1", {
        heartbeatTurnsEnabled: true,
        heartbeatTurnsAfterMinutes: 9,
        heartbeatTurnText: "override",
      });
      await service.updateMetadata("session-1", {
        heartbeatTurnsAfterMinutes: null,
        heartbeatTurnText: null,
      });

      expect(service.getMetadata("session-1")).toEqual({
        heartbeatTurnsEnabled: true,
      });
    });

    it("persists both session-wake override values and clears to inheritance", async () => {
      await service.initialize();

      await service.updateMetadata("session-1", { wakeTurnsEnabled: false });
      expect(service.getMetadata("session-1")).toEqual({
        wakeTurnsEnabled: false,
      });

      await service.updateMetadata("session-1", { wakeTurnsEnabled: true });
      expect(service.getMetadata("session-1")).toEqual({
        wakeTurnsEnabled: true,
      });

      await service.updateMetadata("session-1", { wakeTurnsEnabled: null });
      expect(service.getMetadata("session-1")).toBeUndefined();
    });

    it("persists an automatic-resume block until heartbeat is re-enabled", async () => {
      await service.initialize();
      await service.updateMetadata("session-1", {
        heartbeatTurnsEnabled: false,
        autoResumeDisabled: true,
      });

      const reloaded = new SessionMetadataService({ dataDir: testDir });
      await reloaded.initialize();
      expect(reloaded.getMetadata("session-1")).toEqual({
        autoResumeDisabled: true,
      });

      await reloaded.updateMetadata("session-1", {
        heartbeatTurnsEnabled: true,
      });
      expect(reloaded.getMetadata("session-1")).toEqual({
        heartbeatTurnsEnabled: true,
      });
    });

    it("stores and clears a /btw parent session link", async () => {
      await service.initialize();

      await service.updateMetadata("session-1", {
        parentSessionId: "  parent-session  ",
      });

      expect(service.getMetadata("session-1")).toEqual({
        parentSessionId: "parent-session",
        parentSessionKind: "btw-aside",
      });

      await service.updateMetadata("session-1", {
        parentSessionId: null,
      });

      expect(service.getMetadata("session-1")).toBeUndefined();
    });

    it("stores ordinary fork provenance separately from /btw parentage", async () => {
      await service.initialize();

      await service.updateMetadata("session-1", {
        forkedFromSessionId: "  source-session  ",
      });

      expect(service.getMetadata("session-1")).toEqual({
        forkedFromSessionId: "source-session",
      });
    });

    it("stores an explicit 'off' prompt-suggestion preference", async () => {
      await service.initialize();

      await service.updateMetadata("session-1", {
        promptSuggestionMode: "off",
      });

      // "off" is a meaningful stored value; it must survive the prune block
      // even when it is the only field.
      expect(service.getMetadata("session-1")).toEqual({
        promptSuggestionMode: "off",
      });
      expect(service.getPromptSuggestionMode("session-1")).toBe("off");
    });

    it("clears the prompt-suggestion preference when set to null", async () => {
      await service.initialize();

      await service.updateMetadata("session-1", {
        promptSuggestionMode: "native",
      });
      expect(service.getPromptSuggestionMode("session-1")).toBe("native");

      await service.updateMetadata("session-1", {
        promptSuggestionMode: null,
      });

      expect(service.getMetadata("session-1")).toBeUndefined();
      expect(service.getPromptSuggestionMode("session-1")).toBeUndefined();
    });

    it("persists the prompt-suggestion preference across restarts", async () => {
      await service.initialize();
      await service.updateMetadata("session-1", {
        promptSuggestionMode: "off",
      });

      const newService = new SessionMetadataService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getPromptSuggestionMode("session-1")).toBe("off");
    });

    it("stores an explicit recap mode, including 'off'", async () => {
      await service.initialize();

      await service.updateMetadata("session-1", { recapMode: "fork" });
      expect(service.getRecapMode("session-1")).toBe("fork");

      // "off" is meaningful-stored: it must override the default on resume, so
      // it survives the prune block even as the only field.
      await service.updateMetadata("session-2", { recapMode: "off" });
      expect(service.getMetadata("session-2")).toEqual({ recapMode: "off" });
      expect(service.getRecapMode("session-2")).toBe("off");
    });

    it("clears the recap mode when set to null", async () => {
      await service.initialize();

      await service.updateMetadata("session-1", { recapMode: "fork" });
      expect(service.getRecapMode("session-1")).toBe("fork");

      await service.updateMetadata("session-1", { recapMode: null });
      expect(service.getMetadata("session-1")).toBeUndefined();
      expect(service.getRecapMode("session-1")).toBeUndefined();
    });

    it("persists the recap mode across restarts", async () => {
      await service.initialize();
      await service.updateMetadata("session-1", { recapMode: "fork" });

      const newService = new SessionMetadataService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getRecapMode("session-1")).toBe("fork");
    });

    it("persists and clears the recap pause across restarts", async () => {
      await service.initialize();
      await service.updateMetadata("session-1", {
        recapPausedUntilUserTurn: true,
      });

      const newService = new SessionMetadataService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getMetadata("session-1")).toEqual({
        recapPausedUntilUserTurn: true,
      });

      await newService.updateMetadata("session-1", {
        recapPausedUntilUserTurn: false,
      });
      expect(newService.getMetadata("session-1")).toBeUndefined();
    });
  });

  describe("recapMessages", () => {
    it("persists durable recap overlay rows across restarts", async () => {
      await service.initialize();

      await service.addRecapMessage("session-1", {
        type: "system",
        subtype: "away_summary",
        content: "Finished the smoke test.",
        timestamp: "2026-06-24T00:00:00.000Z",
        uuid: "recap-1",
        id: "recap-1",
        isSynthetic: true,
        yaRecapSource: "ya-synthetic",
      });

      const newService = new SessionMetadataService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getRecapMessages("session-1")).toEqual([
        expect.objectContaining({
          content: "Finished the smoke test.",
          uuid: "recap-1",
          yaRecapSource: "ya-synthetic",
        }),
      ]);
    });

    it("dedupes durable recap overlay rows by uuid", async () => {
      await service.initialize();

      await service.addRecapMessage("session-1", {
        type: "system",
        subtype: "away_summary",
        content: "First text.",
        timestamp: "2026-06-24T00:00:00.000Z",
        uuid: "recap-1",
        id: "recap-1",
        yaRecapSource: "provider-native",
      });
      await service.addRecapMessage("session-1", {
        type: "system",
        subtype: "away_summary",
        content: "Updated text.",
        timestamp: "2026-06-24T00:00:01.000Z",
        uuid: "recap-1",
        id: "recap-1",
        yaRecapSource: "provider-native",
      });

      expect(service.getRecapMessages("session-1")).toEqual([
        expect.objectContaining({
          content: "Updated text.",
          uuid: "recap-1",
        }),
      ]);
    });
  });

  describe("synthetic done messages", () => {
    it("persists the overlay and automation pause atomically", async () => {
      await service.initialize();
      const message = {
        type: "user" as const,
        content: "/done" as const,
        message: { role: "user" as const, content: "/done" as const },
        timestamp: "2026-08-16T12:00:00.000Z",
        uuid: "done-1",
        id: "done-1",
        isSynthetic: true as const,
        yaSyntheticSource: "done" as const,
      };

      await service.recordSyntheticDone("session-1", message);

      expect(service.getSyntheticDoneMessages("session-1")).toEqual([message]);
      expect(service.getMetadata("session-1")).toMatchObject({
        syntheticDoneMessages: [message],
        automationPausedUntilUserTurn: true,
      });

      const reloaded = new SessionMetadataService({ dataDir: testDir });
      await reloaded.initialize();
      expect(reloaded.getMetadata("session-1")).toMatchObject({
        syntheticDoneMessages: [message],
        automationPausedUntilUserTurn: true,
      });

      await reloaded.updateMetadata("session-1", {
        automationPausedUntilUserTurn: false,
      });
      expect(
        reloaded.getMetadata("session-1")?.automationPausedUntilUserTurn,
      ).toBeUndefined();
      expect(reloaded.getSyntheticDoneMessages("session-1")).toEqual([message]);
    });

    it("keeps a pending boundary visible and recoverable across reload", async () => {
      await service.initialize();
      const message = {
        type: "user" as const,
        content: "/done" as const,
        message: { role: "user" as const, content: "/done" as const },
        timestamp: "2026-08-16T12:00:00.000Z",
        uuid: "pending-done-1",
        id: "pending-done-1",
        isSynthetic: true as const,
        yaSyntheticSource: "done" as const,
      };
      await service.updateMetadata("session-1", {
        automationPausedUntilUserTurn: true,
        pendingSyntheticDone: { message, userTurnVersion: 7 },
      });

      const reloaded = new SessionMetadataService({ dataDir: testDir });
      await reloaded.initialize();
      expect(reloaded.getSyntheticDoneMessages("session-1")).toEqual([]);
      expect(reloaded.getMetadata("session-1")?.pendingSyntheticDone).toEqual({
        message,
        userTurnVersion: 7,
      });

      await reloaded.recordSyntheticDone("session-1", message);
      expect(
        reloaded.getMetadata("session-1")?.pendingSyntheticDone,
      ).toBeUndefined();
      expect(reloaded.getSyntheticDoneMessages("session-1")).toEqual([message]);
    });

    it("persists archive with the boundary row in one mutation", async () => {
      await service.initialize();
      const message = {
        type: "user" as const,
        content: "/archive" as const,
        message: { role: "user" as const, content: "/archive" as const },
        timestamp: "2026-08-17T12:00:00.000Z",
        uuid: "archive-1",
        id: "archive-1",
        isSynthetic: true as const,
        yaSyntheticSource: "done" as const,
      };

      await service.recordSyntheticDone("session-1", message, {
        archived: true,
      });

      expect(service.getMetadata("session-1")).toMatchObject({
        syntheticDoneMessages: [message],
        automationPausedUntilUserTurn: true,
        isArchived: true,
      });
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

  describe("setWorkstream", () => {
    it("sets and clears workstream identity", async () => {
      await service.initialize();

      await service.setWorkstream("session-1", "ws-feature" as WorkstreamId);

      expect(service.getMetadata("session-1")).toEqual({
        workstreamId: "ws-feature",
      });

      await service.setWorkstream("session-1", undefined);

      expect(service.getMetadata("session-1")).toBeUndefined();
    });

    it("preserves other metadata when updating workstream identity", async () => {
      await service.initialize();
      await service.setTitle("session-1", "My Title");

      await service.setWorkstream("session-1", "ws-feature" as WorkstreamId);

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "My Title",
        workstreamId: "ws-feature",
      });
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

  describe("setExecutor", () => {
    it("sets executor for a session", async () => {
      await service.initialize();

      await service.setExecutor("session-1", "my-remote-server");

      expect(service.getMetadata("session-1")).toEqual({
        executor: "my-remote-server",
      });
    });

    it("clears executor when undefined provided", async () => {
      await service.initialize();
      await service.setExecutor("session-1", "my-remote-server");

      await service.setExecutor("session-1", undefined);

      expect(service.getMetadata("session-1")).toBeUndefined();
    });

    it("clears executor when empty string provided", async () => {
      await service.initialize();
      await service.setExecutor("session-1", "my-remote-server");

      await service.setExecutor("session-1", "");

      expect(service.getMetadata("session-1")).toBeUndefined();
    });

    it("preserves other fields when updating executor", async () => {
      await service.initialize();
      await service.setTitle("session-1", "My Title");
      await service.setArchived("session-1", true);

      await service.setExecutor("session-1", "remote-host");

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "My Title",
        isArchived: true,
        executor: "remote-host",
      });
    });

    it("persists executor to disk", async () => {
      await service.initialize();
      await service.setExecutor("session-1", "persistent-executor");

      const newService = new SessionMetadataService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getMetadata("session-1")?.executor).toBe(
        "persistent-executor",
      );
    });
  });

  describe("getExecutor", () => {
    it("returns executor for a session", async () => {
      await service.initialize();
      await service.setExecutor("session-1", "my-server");

      expect(service.getExecutor("session-1")).toBe("my-server");
    });

    it("returns undefined for session without executor", async () => {
      await service.initialize();
      await service.setTitle("session-1", "No Executor");

      expect(service.getExecutor("session-1")).toBeUndefined();
    });

    it("returns undefined for unknown session", async () => {
      await service.initialize();

      expect(service.getExecutor("nonexistent")).toBeUndefined();
    });
  });

  describe("provider-native title overlay", () => {
    it("prefers native titles without persisting them", async () => {
      await service.initialize();
      await service.setTitle("session-1", "Yep fallback");

      expect(
        service.replaceNativeTitles(
          new Map([
            ["session-1", "Codex native"],
            ["session-2", "External Codex session"],
          ]),
        ),
      ).toEqual([
        { sessionId: "session-1", title: "Codex native" },
        { sessionId: "session-2", title: "External Codex session" },
      ]);
      expect(service.getMetadata("session-1")?.customTitle).toBe(
        "Codex native",
      );
      expect(service.getAllMetadata()["session-2"]?.customTitle).toBe(
        "External Codex session",
      );

      const state = JSON.parse(
        await readFile(join(testDir, "session-metadata.json"), "utf-8"),
      );
      expect(state.sessions["session-1"].customTitle).toBe("Yep fallback");
      expect(state.sessions["session-2"]).toBeUndefined();
    });

    it("merges bounded snapshots and replaces complete snapshots", async () => {
      await service.initialize();
      service.replaceNativeTitles(new Map([["session-1", "One"]]));

      service.mergeNativeTitles(new Map([["session-2", "Two"]]));
      expect(service.getMetadata("session-1")?.customTitle).toBe("One");
      expect(service.getMetadata("session-2")?.customTitle).toBe("Two");

      service.replaceNativeTitles(new Map([["session-2", "Two updated"]]));
      expect(service.getMetadata("session-1")).toBeUndefined();
      expect(service.getMetadata("session-2")?.customTitle).toBe("Two updated");
    });

    it("moves and clears native titles with session identity", async () => {
      await service.initialize();
      service.setNativeTitle("temporary", "Native title");

      await service.remapSessionId("temporary", "canonical");
      expect(service.getMetadata("temporary")?.customTitle).toBe(
        "Native title",
      );
      expect(service.getMetadata("canonical")?.customTitle).toBe(
        "Native title",
      );

      await service.clearSession("canonical");
      expect(service.getMetadata("canonical")).toBeUndefined();
    });
  });

  describe("executor with other metadata", () => {
    it("loads executor from existing state", async () => {
      const existingState = {
        version: 1,
        sessions: {
          "session-1": { executor: "saved-host" },
          "session-2": { customTitle: "Title", executor: "another-host" },
        },
      };
      await writeFile(
        join(testDir, "session-metadata.json"),
        JSON.stringify(existingState),
      );

      await service.initialize();

      expect(service.getExecutor("session-1")).toBe("saved-host");
      expect(service.getExecutor("session-2")).toBe("another-host");
      expect(service.getMetadata("session-2")).toEqual({
        customTitle: "Title",
        executor: "another-host",
      });
    });

    it("preserves executor when updating other fields", async () => {
      await service.initialize();
      await service.setExecutor("session-1", "my-executor");

      await service.setTitle("session-1", "New Title");
      await service.setArchived("session-1", true);
      await service.setStarred("session-1", true);

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "New Title",
        isArchived: true,
        isStarred: true,
        executor: "my-executor",
      });
    });

    it("clears executor when session is cleared", async () => {
      await service.initialize();
      await service.setExecutor("session-1", "to-clear");
      await service.setTitle("session-1", "Title");

      await service.clearSession("session-1");

      expect(service.getExecutor("session-1")).toBeUndefined();
      expect(service.getMetadata("session-1")).toBeUndefined();
    });
  });
});
