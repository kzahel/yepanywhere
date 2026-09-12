import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectStoragePolicy } from "../../src/projects/projectStoragePolicy.js";
import { createSettingsRoutes } from "../../src/routes/settings.js";
import { ServerSettingsService } from "../../src/services/ServerSettingsService.js";
import * as directorySync from "../../src/utils/syncDirectory.js";

afterEach(() => vi.restoreAllMocks());

describe("settings persistence through the API", () => {
  it.each([false, true])(
    "applies and reloads settings with directory I/O failure=%s",
    async (failSync) => {
      const dataDir = await mkdtemp(join(tmpdir(), "ya-settings-api-"));
      try {
        const logger = { error: vi.fn() };
        const service = new ServerSettingsService({ dataDir, logger });
        await service.initialize();
        const policy = new ProjectStoragePolicy({
          dataDir,
          getMode: () => service.getSetting("projectDirectoryStorage"),
        });
        if (failSync) {
          const sync = directorySync.syncDirectory;
          let calls = 0;
          vi.spyOn(directorySync, "syncDirectory").mockImplementation(
            async (directory) => {
              // Journal creation succeeds; fail after the settings file replacement.
              if (++calls === 2)
                throw Object.assign(new Error("disk I/O failure"), {
                  code: "EIO",
                });
              await sync(directory);
            },
          );
        }
        const onFileAccessChanged = vi.fn();
        const routes = createSettingsRoutes({
          serverSettingsService: service,
          projectStoragePolicy: policy,
          onFileAccessChanged,
        });
        routes.onError((error, c) => c.json({ error: error.message }, 500));
        const fileAccess = {
          projects: true,
          uploads: true,
          temp: true,
          home: false,
          custom: [join(dataDir, "custom")],
        };
        const response = await routes.request("/", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileAccess,
            projectDirectoryStorage: "project",
          }),
        });
        expect(response.status).toBe(failSync ? 500 : 200);
        if (failSync)
          expect(await response.json()).toEqual({
            error:
              "Settings were saved, but crash durability could not be confirmed",
          });
        expect(onFileAccessChanged).toHaveBeenCalledWith(fileAccess);
        expect(service.getSetting("fileAccess")).toEqual(fileAccess);
        expect(policy.mode).toBe("project");
        const persisted = JSON.parse(
          await readFile(join(dataDir, "server-settings.json"), "utf8"),
        );
        expect(persisted.settings.fileAccess).toEqual(fileAccess);
        await expect(
          stat(policy.transitionJournalPath()),
        ).rejects.toMatchObject({ code: "ENOENT" });
        const reloaded = new ServerSettingsService({ dataDir });
        await reloaded.initialize();
        expect(reloaded.getSetting("fileAccess")).toEqual(fileAccess);
        expect(reloaded.getSetting("projectDirectoryStorage")).toBe("project");
        expect(logger.error).toHaveBeenCalledTimes(failSync ? 1 : 0);
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  );
});
