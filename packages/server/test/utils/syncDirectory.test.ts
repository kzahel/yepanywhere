import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncDirectory } from "../../src/utils/syncDirectory.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("syncDirectory", () => {
  it("supports a real directory on the current platform", async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), "ya-directory-sync-"));
    try {
      await expect(syncDirectory(directory)).resolves.toBeUndefined();
    } finally {
      await fs.rm(directory, { recursive: true });
    }
  });

  describe.each(["win32", "linux", "darwin"])("%s", (platform) => {
    it("does not suppress directory close failures", async () => {
      vi.stubGlobal("process", { ...process, platform });
      const error = Object.assign(new Error("close failed"), { code: "EPERM" });
      vi.spyOn(fs, "open").mockResolvedValueOnce({
        sync: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockRejectedValue(error),
      } as unknown as fs.FileHandle);
      await expect(syncDirectory("directory")).rejects.toBe(error);
    });

    it.each(["EISDIR", "EINVAL", "EPERM"])(
      "only tolerates unsupported %s errors on Windows",
      async (code) => {
        vi.stubGlobal("process", { ...process, platform });
        const error = Object.assign(new Error(code), { code });
        const close = vi.fn().mockResolvedValue(undefined);
        const sync = vi.fn().mockRejectedValue(error);
        const open = vi.spyOn(fs, "open");
        for (const stage of ["open", "sync"]) {
          if (stage === "open") open.mockRejectedValueOnce(error);
          else
            open.mockResolvedValueOnce({
              sync,
              close,
            } as unknown as fs.FileHandle);
          const result = syncDirectory("directory");
          if (platform === "win32")
            await expect(result).resolves.toBeUndefined();
          else await expect(result).rejects.toBe(error);
        }
        expect(close).toHaveBeenCalledTimes(1);
      },
    );

    it.each(["EIO", "ENOSPC", "ENOENT", "EACCES"])(
      "propagates %s and releases the directory handle",
      async (code) => {
        vi.stubGlobal("process", { ...process, platform });
        const error = Object.assign(new Error(code), { code });
        const close = vi.fn().mockResolvedValue(undefined);
        vi.spyOn(fs, "open").mockResolvedValueOnce({
          sync: vi.fn().mockRejectedValue(error),
          close,
        } as unknown as fs.FileHandle);
        await expect(syncDirectory("directory")).rejects.toBe(error);
        expect(close).toHaveBeenCalledTimes(1);
      },
    );
  });
});
