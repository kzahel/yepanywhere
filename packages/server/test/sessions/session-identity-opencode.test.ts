import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import type { FSWatcher } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { toUrlProjectId, type YepMessage } from "@yep-anywhere/shared";
import { expect, it, vi } from "vitest";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import { openSqliteOrThrow } from "../../src/storage/sqlite.js";
import { SessionIndexService } from "../../src/indexes/SessionIndexService.js";
import { ScriptedClaudeProvider } from "../support/scripted-provider.js";
import { OpenCodeSessionCatalogAdapter } from "../../src/sessions/catalog-adapters/opencode-catalog-adapter.js";
import { projectCatalogIdentities } from "../../src/sessions/catalog-identity.js";
import { OpenCodeSessionReader } from "../../src/sessions/opencode-reader.js";
import { listSessionsAcrossProviders } from "../../src/sessions/provider-resolution.js";
import { handleSessionWatchSubscribe } from "../../src/routes/ws-relay-handlers.js";
import * as sharedWatches from "../../src/watcher/SharedDirectoryWatcher.js";
import { createApp } from "../setup/create-app.js";

it("keeps scoped OpenCode identities through native catalogue, public history, WAL watches, children and profile reopen", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "ya-opencode-identity-")),
  );
  const worktree = join(root, "project");
  const original = join(worktree, "nested");
  const working = join(root, "working");
  const scope = join(root, "private-native");
  const otherScope = join(root, "other-native");
  const dataDir = join(root, "data");
  await Promise.all(
    [original, working, scope, otherScope].map((p) =>
      mkdir(p, { recursive: true }),
    ),
  );
  const alias = join(root, "original-alias");
  await symlink(
    original,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const originalId = toUrlProjectId(alias),
    workingId = toUrlProjectId(working);
  const publicId = "permanent-opencode-public",
    nativeId = "ses_private_native";
  const dbPath = join(scope, "opencode.db");
  const writers = [dbPath, join(otherScope, "opencode.db")].map((path) =>
    openSqliteOrThrow(path),
  );
  for (const [index, writer] of writers.entries()) {
    writer.exec(
      "CREATE TABLE project(id TEXT PRIMARY KEY, worktree TEXT); CREATE TABLE session(id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, agent TEXT, directory TEXT, title TEXT, model TEXT, time_created INTEGER, time_updated INTEGER); CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
    );
    writer
      .prepare("INSERT INTO project VALUES (?,?)")
      .run("git-project", worktree);
    const session = writer.prepare(
      "INSERT INTO session VALUES (?, 'git-project', ?, NULL, ?, ?, NULL, 1, 2)",
    );
    session.run(nativeId, null, original, `native ${index}`);
    session.run("ses_native_child", nativeId, original, "native child");
    session.run("ses_legacy", null, original, "legacy worktree grouping");
    const msg = writer.prepare("INSERT INTO message VALUES (?,?,1,2,?)");
    const part = writer.prepare("INSERT INTO part VALUES (?,?,?,1,2,?)");
    for (const id of [nativeId, "ses_native_child", "ses_legacy"]) {
      msg.run(
        `msg-${id}`,
        id,
        JSON.stringify({ role: "user", time: { created: 1 } }),
      );
      part.run(
        `part-${id}`,
        id,
        `msg-${id}`,
        JSON.stringify({
          type: "text",
          text: `${index === 0 ? "selected" : "other"} exact native history ${id}`,
        }),
      );
    }
    writer.exec("PRAGMA journal_mode=WAL");
  }
  let app: ReturnType<typeof createApp> | undefined,
    storage: DiscoverySqliteService | undefined;
  let index: SessionIndexService | undefined;
  const subscriptions = new Map<string, () => void>();
  try {
    for (let restart = 0; restart < 2; restart++) {
      storage = new DiscoverySqliteService({
        dataDir,
        probeNetworkFilesystem: () => undefined,
      });
      const metadata = new SessionMetadataService({
        dataDir,
        database: storage.getDatabase(),
      });
      await metadata.initialize();
      if (!restart) {
        const insert = storage
          .getDatabase()
          .prepare(
            "INSERT INTO session_identities VALUES (?, 'opencode', ?, '2026-11-01T00:00:00Z', 'opencode', ?, ?)",
          );
        try {
          insert.run(publicId, originalId, scope, nativeId);
          insert.run("other-public", originalId, otherScope, nativeId);
        } finally {
          insert.finalize();
        }
        await metadata.setWorkingProject(publicId, workingId, originalId);
      }
      index = new SessionIndexService({
        dataDir: join(root, "indexes"),
        projectsDir: join(root, "empty-ambient"),
      });
      app = createApp({
        provider: new ScriptedClaudeProvider(),
        dataDir,
        discoverySqlite: storage,
        sessionIndexService: index,
        sessionMetadataService: metadata,
        projectsDir: join(root, "empty-ambient"),
      });
      const history = async (id = publicId, project = workingId) =>
        app!.app.request(`/api/projects/${project}/sessions/${id}`);
      const response = await history();
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.session.id).toBe(publicId);
      expect(JSON.stringify(body.messages)).toContain(
        "selected exact native history",
      );
      expect(JSON.stringify(body.messages)).not.toContain(
        "other exact native history",
      );

      const projectForIndex = (await app.scanner.getOrCreateProject(
        originalId,
      ))!;
      const summaries = await Promise.all(
        [scope, otherScope].map((nativeScope) =>
          index!.getSessionSummaryWithCache(
            nativeScope,
            originalId,
            nativeId,
            app!.readerFactory(
              { ...projectForIndex, provider: "opencode" },
              {
                family: "opencode",
                storageScope: nativeScope,
                id: nativeId as import("@yep-anywhere/shared").NativeSessionId,
              },
            ),
          ),
        ),
      );
      expect(summaries.map((summary) => summary?.title)).toEqual([
        "native 0",
        "native 1",
      ]);
      const metadataReplies = await Promise.all(
        [
          [workingId, publicId],
          [originalId, "other-public"],
        ].map(async ([project, id]) => {
          const response = await app!.app.request(
            `/api/projects/${project}/sessions/${id}/metadata`,
          );
          expect(response.status).toBe(200);
          return response.json();
        }),
      );
      expect(metadataReplies.map((reply) => reply.session.title)).toEqual([
        "native 0",
        "native 1",
      ]);
      const other = await history("other-public", originalId);
      expect(other.status).toBe(200);
      expect(JSON.stringify((await other.json()).messages)).toContain(
        "other exact native history",
      );
      expect((await history(nativeId)).status).toBe(404);
      expect(body.session.providerChildren).toEqual([
        expect.objectContaining({
          id: "ses_native_child",
          parentSessionId: publicId,
        }),
      ]);
      const child = await app.app.request(
        `/api/projects/${workingId}/sessions/${publicId}/agents/ses_native_child`,
      );
      expect(child.status).toBe(200);
      expect(JSON.stringify(await child.json())).toContain(
        "selected exact native history",
      );
      const scan = await new OpenCodeSessionCatalogAdapter({
        databasePath: dbPath,
        storageDir: join(scope, "storage"),
      }).scan({
        catalogEpoch: "test",
        targetGeneration: restart + 1,
        mode: { kind: "complete" },
        signal: new AbortController().signal,
      });
      const raw = [
        ...(scan.rows as Iterable<
          import("../../src/sessions/catalog-types.js").SessionCatalogRow
        >),
      ];
      const projected = await projectCatalogIdentities(raw, metadata);
      expect(projected.find((row) => row.sessionId === publicId)).toMatchObject(
        {
          projectId: originalId,
          projectPath: alias,
          nativeSessionId: nativeId,
          nativeStorageScope: scope,
        },
      );
      expect(
        projected.find((row) => row.sessionId === "ses_legacy")?.projectId,
      ).toBe(toUrlProjectId(worktree));
      const boundRow = raw.find((row) => row.sessionId === nativeId)!;
      await expect(
        projectCatalogIdentities(
          [{ ...boundRow, nativeDirectoryProjectId: workingId }],
          metadata,
        ),
      ).rejects.toThrow("Session identity conflicts");
      const project = await app.scanner.getOrCreateProject(
        toUrlProjectId(worktree),
      );
      expect(project).not.toBeNull();
      const reader = new OpenCodeSessionReader({
        projectPath: worktree,
        databasePath: dbPath,
        storageDir: join(scope, "storage"),
        nativeStorageScope: scope,
      });
      try {
        const sessions = await listSessionsAcrossProviders(project!, {
          readerFactory: (project, native) =>
            project.provider === "opencode"
              ? reader
              : app!.readerFactory(project, native),
          identities: metadata.identities,
        });
        expect(sessions.some((row) => row.id === publicId)).toBe(false);
        expect(sessions.some((row) => row.id === "ses_legacy")).toBe(true);
      } finally {
        reader.close();
      }
      if (!restart) {
        let ready!: (lease: FSWatcher) => void;
        const watching = new Promise<FSWatcher>((resolve) => {
          ready = resolve;
        });
        const watch = sharedWatches.watchSharedDirectory;
        const watchSpy = vi
          .spyOn(sharedWatches, "watchSharedDirectory")
          .mockImplementation((...args) => {
            const lease = watch(...args);
            ready(lease);
            return lease;
          });
        const changes = [0, 1].map(
          (index) =>
            new Promise<YepMessage>((resolve) => {
              handleSessionWatchSubscribe(
                subscriptions,
                {
                  type: "subscribe",
                  channel: "session-watch",
                  subscriptionId: `viewer-${index}`,
                  sessionId: publicId,
                  projectId: workingId,
                  provider: "claude",
                },
                (message) => {
                  if (
                    message.type === "event" &&
                    message.eventType === "session-watch-change"
                  )
                    resolve(message);
                },
                app!.focusedSessionWatchManager,
              );
            }),
        );
        const lease = await watching;
        const close = vi.spyOn(lease, "close");
        const bytes = await readFile(dbPath);
        writers[0]!.transaction(() => {
          writers[0]!
            .prepare("INSERT INTO message VALUES ('msg-wal',?,3,3,?)")
            .run(
              nativeId,
              JSON.stringify({ role: "user", time: { created: 3 } }),
            );
          writers[0]!
            .prepare("INSERT INTO part VALUES ('part-wal',?,'msg-wal',3,3,?)")
            .run(
              nativeId,
              JSON.stringify({
                type: "text",
                text: "new WAL-only native history",
              }),
            );
          writers[0]!
            .prepare("UPDATE session SET time_updated=3 WHERE id=?")
            .run(nativeId);
        });
        const events = await Promise.all(changes);
        for (const event of events) {
          expect(event.type).toBe("event");
          if (event.type === "event")
            expect(event.data).toMatchObject({
              sessionId: publicId,
              projectId: workingId,
              provider: "opencode",
              path: dbPath,
            });
        }
        expect(watchSpy).toHaveBeenCalledTimes(1);
        expect(await readFile(dbPath)).toEqual(bytes);
        expect(
          JSON.stringify((await (await history()).json()).messages),
        ).toContain("new WAL-only native history");
        const updatedMetadata = await app.app.request(
          `/api/projects/${workingId}/sessions/${publicId}/metadata`,
        );
        expect(updatedMetadata.status).toBe(200);
        expect((await updatedMetadata.json()).session.messageCount).toBe(2);
        subscriptions.get("viewer-0")!();
        subscriptions.delete("viewer-0");
        expect(close).not.toHaveBeenCalled();
        subscriptions.get("viewer-1")!();
        subscriptions.delete("viewer-1");
        expect(close).toHaveBeenCalledTimes(1);
        watchSpy.mockRestore();
      } else
        expect(JSON.stringify(body.messages)).toContain(
          "new WAL-only native history",
        );
      await app.disposeSessionReaders();
      app = undefined;
      index.dispose();
      index = undefined;
      if (restart) {
        const controller = new AbortController();
        const pending = projectCatalogIdentities(
          raw,
          metadata,
          controller.signal,
        );
        controller.abort();
        storage.close();
        expect(await pending).toEqual([]);
      }
      storage.close();
      storage = undefined;
    }
  } finally {
    for (const release of subscriptions.values()) release();
    await app?.disposeSessionReaders();
    index?.dispose();
    storage?.close();
    for (const writer of writers) writer.close();
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});
