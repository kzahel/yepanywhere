import type { DirProjectId, UrlProjectId } from "@yep-anywhere/shared";
import { asDirProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { ExternalSessionTracker } from "../../src/supervisor/ExternalSessionTracker.js";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";
import {
  EventBus,
  type SessionStatusEvent,
} from "../../src/watcher/EventBus.js";

describe("ExternalSessionTracker", () => {
  let eventBus: EventBus;
  let supervisor: Supervisor;
  let scanner: ProjectScanner;

  beforeEach(() => {
    vi.useFakeTimers();
    eventBus = new EventBus();
    supervisor = {
      getProcessForSession: vi.fn(() => null),
    } as unknown as Supervisor;
    scanner = {
      getProjectBySessionDirSuffix: vi.fn(),
      invalidateCache: vi.fn(),
    } as unknown as ProjectScanner;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries project lookup after invalidating scanner cache", async () => {
    const sessionId = "session-1";
    const dirProjectId = asDirProjectId("C--Users-Administrator-Project");
    const projectId =
      "QzovVXNlcnMvQWRtaW5pc3RyYXRvci9Qcm9qZWN0" as UrlProjectId;
    const statusEvents: SessionStatusEvent[] = [];

    vi.mocked(scanner.getProjectBySessionDirSuffix)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: projectId });

    const tracker = new ExternalSessionTracker({
      eventBus,
      supervisor,
      scanner,
      decayMs: 10_000,
    });

    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === "session-status-changed") {
        statusEvents.push(event);
      }
    });

    eventBus.emit({
      type: "file-change",
      provider: "claude",
      path: `C:\\Users\\Administrator\\.claude\\projects\\${dirProjectId}\\${sessionId}.jsonl`,
      relativePath: `${dirProjectId}\\${sessionId}.jsonl`,
      changeType: "modify",
      timestamp: new Date().toISOString(),
      fileType: "session",
    });

    await vi.waitFor(() => {
      expect(statusEvents).toHaveLength(1);
    });

    expect(statusEvents[0]).toMatchObject({
      sessionId,
      projectId,
      ownership: { owner: "external" },
    });
    expect(scanner.invalidateCache).toHaveBeenCalledTimes(1);
    expect(scanner.getProjectBySessionDirSuffix).toHaveBeenCalledTimes(2);

    unsubscribe();
    tracker.dispose();
  });
});
