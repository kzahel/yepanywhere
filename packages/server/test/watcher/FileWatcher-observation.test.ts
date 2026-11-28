import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FileWatcher } from "../../src/watcher/FileWatcher.js";
import { EventBus } from "../../src/watcher/EventBus.js";
import * as sharedDirectoryWatcher from "../../src/watcher/SharedDirectoryWatcher.js";

describe("FileWatcher observation diagnostics", () => {
  it("ceases reporting observation after a lease error or close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "watch-observation-"));
    class ObservationLease extends EventEmitter {
      close() {
        this.emit("close");
      }

      ref() {
        return this;
      }

      unref() {
        return this;
      }
    }
    const lease = new ObservationLease();
    vi.spyOn(sharedDirectoryWatcher, "watchSharedDirectory").mockReturnValue(
      lease,
    );
    const logError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const watcher = new FileWatcher({
      watchDir: directory,
      provider: "claude",
      eventBus: new EventBus(),
    });
    try {
      watcher.start();
      expect(watcher.getObservationDiagnostics()).toMatchObject({
        watching: true,
        baselineState: "scheduled",
        error: null,
      });
      await watcher.waitForInitialBaseline();
      expect(watcher.getObservationDiagnostics()).toMatchObject({
        watching: true,
        baselineState: "complete",
      });
      const error = new Error("test observation failure");
      lease.emit("error", error);
      expect(watcher.getObservationDiagnostics()).toMatchObject({
        watching: false,
        error: error.message,
      });
      expect(logError).toHaveBeenCalledWith("[FileWatcher] Error:", error);
      lease.close();
      expect(watcher.isWatching).toBe(false);
    } finally {
      watcher.stop();
      vi.restoreAllMocks();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
