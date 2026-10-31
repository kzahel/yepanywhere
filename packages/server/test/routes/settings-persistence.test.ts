import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectStoragePolicy } from "../../src/projects/projectStoragePolicy.js";
import { createSettingsRoutes } from "../../src/routes/settings.js";
import { ServerSettingsService } from "../../src/services/ServerSettingsService.js";
import { RemoteSessionService } from "../../src/remote-access/RemoteSessionService.js";
import * as directorySync from "../../src/utils/syncDirectory.js";

afterEach(() => vi.restoreAllMocks());

describe("settings persistence through the API", () => {
  it.each(["fresh", "existing-unset"])(
    "restores SRP sessions by default and preserves an API opt-out for %s settings",
    async (profile) => {
      const dataDir = await mkdtemp(join(tmpdir(), "ya-resume-default-"));
      let remote = new RemoteSessionService({ dataDir });
      try {
        if (profile === "existing-unset")
          await writeFile(
            join(dataDir, "server-settings.json"),
            JSON.stringify({
              version: 2,
              settings: { serviceWorkerEnabled: true },
            }),
          );
        const settings = new ServerSettingsService({ dataDir });
        await settings.initialize();
        // Apply the product setting before initialization, as normal startup does.
        await remote.setDiskPersistenceEnabled(
          settings.getSetting("persistRemoteSessionsToDisk"),
        );
        await remote.initialize();
        const id = await remote.createSession(
          "owner",
          new Uint8Array(32).fill(42),
        );
        remote.shutdown();
        await remote.waitForPendingWrites();
        remote = new RemoteSessionService({ dataDir });
        await remote.setDiskPersistenceEnabled(
          settings.getSetting("persistRemoteSessionsToDisk"),
        );
        await remote.initialize();
        expect(remote.getSession(id)?.username).toBe("owner");

        const routes = createSettingsRoutes({
          serverSettingsService: settings,
          onRemoteSessionPersistenceChanged: (enabled) =>
            remote.setDiskPersistenceEnabled(enabled),
        });
        const response = await routes.request("/", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ persistRemoteSessionsToDisk: false }),
        });
        expect(response.status).toBe(200);
        expect(remote.getSession(id)?.username).toBe("owner");
        await expect(
          stat(join(dataDir, "remote-sessions.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        remote.shutdown();
        await remote.waitForPendingWrites();

        const reloaded = new ServerSettingsService({ dataDir });
        await reloaded.initialize();
        expect(reloaded.getSetting("persistRemoteSessionsToDisk")).toBe(false);
        remote = new RemoteSessionService({ dataDir });
        await remote.setDiskPersistenceEnabled(
          reloaded.getSetting("persistRemoteSessionsToDisk"),
        );
        await remote.initialize();
        expect(remote.getSession(id)).toBeNull();
      } finally {
        remote.shutdown();
        await remote.waitForPendingWrites();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  );

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
