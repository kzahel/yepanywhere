import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";

describe("optional discovery storage failure isolation", () => {
  it("retains an initialization error even when partial-open cleanup fails", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ya-sqlite-failure-"));
    const initializationError = new Error("database unavailable");
    const close = vi.fn(() => {
      throw new Error("close also failed");
    });
    const onError = vi.fn();
    try {
      const service = new DiscoverySqliteService({
        dataDir,
        mode: "auto",
        loadDriver: () => ({
          open: () => ({
            exec: () => {
              throw initializationError;
            },
            prepare: () => {
              throw new Error("not reached");
            },
            transaction: () => {
              throw new Error("not reached");
            },
            close,
          }),
        }),
        onError,
      });
      expect(service.getStatus()).toEqual({ state: "error" });
      expect(service.getDatabase()).toBeUndefined();
      expect(close).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(initializationError);
      service.close();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
