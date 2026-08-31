import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { CodexNativeTitleService } from "../../src/services/CodexNativeTitleService.js";
import type { EventBus } from "../../src/watcher/EventBus.js";

describe("CodexNativeTitleService", () => {
  let testDir: string;
  let metadataService: SessionMetadataService;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "codex-native-titles-"));
    metadataService = new SessionMetadataService({ dataDir: testDir });
    await metadataService.initialize();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(testDir, { recursive: true, force: true });
  });

  it("projects provider titles, writes native renames, and removes local copies", async () => {
    await metadataService.setTitle("thread-1", "Yep fallback");
    let listener: ((sessionId: string, title: string) => void) | undefined;
    const emit = vi.fn();
    const provider = {
      listNativeSessionTitles: vi.fn(async () => ({
        titles: new Map([["thread-1", "Codex native"]]),
        complete: true,
      })),
      setNativeSessionTitle: vi.fn(async () => undefined),
      onNativeSessionTitleChanged: vi.fn((next: typeof listener) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      }),
      closeNativeSessionTitles: vi.fn(async () => undefined),
    };
    const service = new CodexNativeTitleService({
      provider,
      metadataService,
      eventBus: { emit } as unknown as EventBus,
    });

    await service.start();
    expect(metadataService.getMetadata("thread-1")?.customTitle).toBe(
      "Codex native",
    );

    await service.rename("thread-1", "Renamed in Yep");
    expect(provider.setNativeSessionTitle).toHaveBeenCalledWith(
      "thread-1",
      "Renamed in Yep",
    );
    expect(metadataService.getMetadata("thread-1")?.customTitle).toBe(
      "Renamed in Yep",
    );
    const persisted = JSON.parse(
      await readFile(join(testDir, "session-metadata.json"), "utf-8"),
    );
    expect(persisted.sessions["thread-1"]).toBeUndefined();

    listener?.("thread-1", "Renamed in Codex");
    expect(metadataService.getMetadata("thread-1")?.customTitle).toBe(
      "Renamed in Codex",
    );
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session-metadata-changed",
        sessionId: "thread-1",
        title: "Renamed in Codex",
      }),
    );
    await service.stop();
    expect(provider.closeNativeSessionTitles).toHaveBeenCalledOnce();
  });

  it("refreshes on a bounded timer and retains the last projection on failure", async () => {
    vi.useFakeTimers();
    const listNativeSessionTitles = vi
      .fn()
      .mockResolvedValueOnce({
        titles: new Map([["thread-1", "Initial"]]),
        complete: true,
      })
      .mockRejectedValueOnce(new Error("app-server unavailable"))
      .mockResolvedValueOnce({
        titles: new Map([["thread-1", "External rename"]]),
        complete: true,
      });
    const provider = {
      listNativeSessionTitles,
      setNativeSessionTitle: vi.fn(async () => undefined),
      onNativeSessionTitleChanged: vi.fn(() => () => undefined),
      closeNativeSessionTitles: vi.fn(async () => undefined),
    };
    const service = new CodexNativeTitleService({
      provider,
      metadataService,
      refreshIntervalMs: 10_000,
    });

    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(metadataService.getMetadata("thread-1")?.customTitle).toBe(
      "Initial",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(metadataService.getMetadata("thread-1")?.customTitle).toBe(
      "External rename",
    );
    expect(listNativeSessionTitles).toHaveBeenCalledTimes(3);
    await service.stop();
  });

  it("does not block startup and closes a stuck refresh before shutdown", async () => {
    let rejectRefresh: ((error: Error) => void) | undefined;
    const provider = {
      listNativeSessionTitles: vi.fn(
        () =>
          new Promise<never>((_resolve, reject) => {
            rejectRefresh = reject;
          }),
      ),
      setNativeSessionTitle: vi.fn(async () => undefined),
      onNativeSessionTitleChanged: vi.fn(() => () => undefined),
      closeNativeSessionTitles: vi.fn(async () => {
        rejectRefresh?.(new Error("app-server closed"));
      }),
    };
    const service = new CodexNativeTitleService({
      provider,
      metadataService,
    });

    await service.start();
    expect(provider.listNativeSessionTitles).toHaveBeenCalledOnce();
    await service.stop();
    expect(provider.closeNativeSessionTitles).toHaveBeenCalledOnce();
  });

  it("does not publish a refresh snapshot older than a provider update", async () => {
    let listener: ((sessionId: string, title: string) => void) | undefined;
    let resolveRefresh:
      | ((snapshot: {
          titles: ReadonlyMap<string, string>;
          complete: boolean;
        }) => void)
      | undefined;
    const provider = {
      listNativeSessionTitles: vi.fn(
        () =>
          new Promise<{
            titles: ReadonlyMap<string, string>;
            complete: boolean;
          }>((resolve) => {
            resolveRefresh = resolve;
          }),
      ),
      setNativeSessionTitle: vi.fn(async () => undefined),
      onNativeSessionTitleChanged: vi.fn((next: typeof listener) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      }),
      closeNativeSessionTitles: vi.fn(async () => undefined),
    };
    const service = new CodexNativeTitleService({
      provider,
      metadataService,
    });

    await service.start();
    listener?.("thread-1", "New title");
    resolveRefresh?.({
      titles: new Map([["thread-1", "Old title"]]),
      complete: true,
    });
    await service.refresh();

    expect(metadataService.getMetadata("thread-1")?.customTitle).toBe(
      "New title",
    );
    await service.stop();
  });
});
