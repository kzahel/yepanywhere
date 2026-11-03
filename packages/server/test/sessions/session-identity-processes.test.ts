import { createServer } from "node:http";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseYaSessionId, toUrlProjectId } from "@yep-anywhere/shared";
import { expect, it, vi } from "vitest";
import {
  getDebugContext,
  handleDebugRequest,
  setDebugContext,
} from "../../src/maintenance/debug-routes.js";
import { boundSessionSource } from "../../src/sessions/provider-resolution.js";
import type { Process } from "../../src/supervisor/Process.js";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import * as claudeSummary from "../../src/sessions/claude-summary.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import { attachProviderChildSessions } from "../../src/sessions/provider-child-sessions.js";
import { ScriptedClaudeProvider } from "../support/scripted-provider.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import type { ProcessInfo } from "../../src/supervisor/types.js";
import {
  EventBus,
  type BusEvent,
  type FileChangeEvent,
} from "../../src/watcher/EventBus.js";
import { createApp } from "../setup/create-app.js";

it.each(["claude", "codex"] as const)(
  "keeps %s process and child projections public while reading the bound native source after reopen",
  async (provider) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "ya-process-identity-")),
    );
    const originalPath = join(root, "original");
    const workingPath = join(root, "working");
    const originalId = toUrlProjectId(originalPath);
    const workingId = toUrlProjectId(workingPath);
    const nativeRoot = join(root, "private-native");
    const projectsDir = join(root, "ambient-claude");
    const codexSessionsDir = join(root, "ambient-codex");
    const dataDir = join(root, "data");
    const sessionId = "permanent-owned-parent";
    const nativeId = "019a0000-eeee-7eee-8eee-eeeeeeeeeeee";
    const childId = "019a0000-ffff-7fff-8fff-ffffffffffff";
    const timestamp = new Date().toISOString();
    let parentObservationFile: string | undefined;
    let app: ReturnType<typeof createApp> | undefined;
    let storage: DiscoverySqliteService | undefined;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const line = (type: string, payload: unknown) =>
      JSON.stringify({ type, timestamp, payload });
    const filename = (id: string) =>
      provider === "claude" ? id + ".jsonl" : `rollout-${id}.jsonl`;
    const rows = (id: string, title: string, model: string): string[] =>
      provider === "claude"
        ? [
            JSON.stringify({
              type: "user",
              uuid: "user",
              sessionId: id,
              cwd: originalPath,
              timestamp,
              message: { role: "user", content: title },
            }),
            JSON.stringify({
              type: "assistant",
              uuid: "assistant",
              parentUuid: "user",
              sessionId: id,
              cwd: originalPath,
              timestamp,
              message: {
                role: "assistant",
                model,
                content: [{ type: "text", text: "answer" }],
              },
            }),
          ]
        : [
            line("session_meta", {
              id,
              cwd: originalPath,
              timestamp,
              model_provider: "openai",
            }),
            line("turn_context", {
              cwd: originalPath,
              model,
              effort: "high",
              approval_policy: "never",
              sandbox_policy: { type: "danger-full-access" },
            }),
            line("event_msg", { type: "user_message", message: title }),
            line("response_item", {
              type: "function_call",
              name: "spawn_agent",
              call_id: "spawn",
              arguments: JSON.stringify({
                role: "reviewer",
                prompt: "Inspect native child",
              }),
            }),
            line("response_item", {
              type: "function_call_output",
              call_id: "spawn",
              output: JSON.stringify({
                agent_id: childId,
                nickname: "Native child",
              }),
            }),
          ];
    try {
      const ambientRoot =
        provider === "claude"
          ? join(projectsDir, originalPath.replace(/[/\\:]/g, "-"))
          : codexSessionsDir;
      await Promise.all(
        [originalPath, workingPath, nativeRoot, ambientRoot].map((p) =>
          mkdir(p, { recursive: true }),
        ),
      );
      await writeFile(
        join(nativeRoot, filename(nativeId)),
        rows(
          nativeId,
          "correct native title",
          provider === "claude" ? "claude-opus-4-6" : "gpt-6.1-sol",
        ).join("\n") + "\n",
      );
      // Same native spelling in an unrelated configured store must never win.
      await writeFile(
        join(ambientRoot, filename(nativeId)),
        rows(nativeId, "WRONG AMBIENT TITLE", "wrong-model").join("\n") + "\n",
      );
      if (provider === "codex")
        await writeFile(
          join(nativeRoot, filename(childId)),
          [
            line("session_meta", {
              id: childId,
              cwd: originalPath,
              timestamp,
              model_provider: "openai",
              parent_thread_id: nativeId,
              source: {
                subagent: { thread_spawn: { parent_thread_id: nativeId } },
              },
            }),
            line("response_item", {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "private child history" }],
            }),
          ].join("\n") + "\n",
        );
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
        if (restart === 0) {
          const insert = storage
            .getDatabase()
            .prepare(
              "INSERT INTO session_identities VALUES (?, ?, ?, ?, ?, ?, ?)",
            );
          try {
            insert.run(
              sessionId,
              provider,
              originalId,
              timestamp,
              provider,
              nativeRoot,
              nativeId,
            );
            insert.run(
              nativeId,
              provider,
              originalId,
              timestamp,
              provider,
              nativeRoot,
              "unrelated-native-resource",
            );
          } finally {
            insert.finalize();
          }
          // Metadata under N belongs to another YA resource, not to P's source.
          await metadata.setTitle(nativeId, "WRONG PUBLIC METADATA");
          await metadata.setWorkingProject(sessionId, workingId, originalId);
        }
        const eventBus = new EventBus();
        const observed: BusEvent[] = [];
        eventBus.subscribe((event) => observed.push(event));
        app = createApp({
          provider: new ScriptedClaudeProvider(),
          eventBus,
          dataDir,
          projectsDir,
          codexSessionsDir,
          discoverySqlite: storage,
          sessionMetadataService: metadata,
        });
        // No transcript exists in the working project. The scanner has not yet
        // seen it; public routing/recovery must materialize that known path.
        vi.spyOn(app.supervisor, "getProcessInfoList").mockReturnValue([
          {
            id: "owned-process",
            sessionId,
            projectId: workingId,
            projectPath: workingPath,
            projectName: "working",
            sessionTitle: null,
            state: "idle",
            startedAt: timestamp,
            queueDepth: 0,
            provider: provider === "codex" ? "codex-oss" : "claude",
          } satisfies ProcessInfo,
        ]);
        const processResponse = await app.app.request("/api/processes");
        expect(processResponse.status).toBe(200);
        expect((await processResponse.json()).processes).toEqual([
          expect.objectContaining({
            sessionId,
            projectId: workingId,
            provider,
            sessionTitle: "correct native title",
            model: provider === "claude" ? "claude-opus-4-6" : "gpt-6.1-sol",
          }),
        ]);
        const unrelatedOwned = vi
          .spyOn(app.supervisor, "getProcessForSession")
          .mockImplementation((id) =>
            id === nativeId
              ? ({ projectId: originalId } as Process)
              : undefined,
          );
        try {
          const tracker = app.externalTracker!;
          const fileEvent: FileChangeEvent = {
            type: "file-change",
            provider,
            path: parentObservationFile ?? join(nativeRoot, filename(nativeId)),
            relativePath: filename(nativeId),
            nativeStorageScope: nativeRoot,
            changeType: "modify",
            fileType: "session",
            timestamp,
          };
          const settleSource = async (count: number) =>
            vi.waitFor(() => {
              const state = tracker.getDiagnostics().nativeSourceBatch!;
              expect(state.counters.tasksSucceeded).toBe(count);
              expect(state.processing).toBe(false);
            });
          eventBus.emit(fileEvent);
          await settleSource(1);
          expect(tracker.isExternal(sessionId)).toBe(true);
          expect(tracker.isExternal(nativeId)).toBe(false);
          await vi.waitFor(() =>
            expect(
              observed.some(
                (event) =>
                  (event.type === "session-created" &&
                    event.session.id === sessionId &&
                    event.session.projectId === workingId) ||
                  (event.type === "session-updated" &&
                    event.sessionId === sessionId &&
                    event.projectId === workingId),
              ),
            ).toBe(true),
          );
          // A valid same-N file in the ambient store cannot borrow P's binding
          // or ownership from the unrelated public resource named N.
          eventBus.emit({
            ...fileEvent,
            path: join(ambientRoot, filename(nativeId)),
            nativeStorageScope: ambientRoot,
          });
          await settleSource(2);
          expect(tracker.isExternal(nativeId)).toBe(false);
          expect(
            observed.some(
              (event) =>
                (event.type === "session-created" &&
                  event.session.id === nativeId) ||
                ((event.type === "session-updated" ||
                  event.type === "session-status-changed") &&
                  event.sessionId === nativeId),
            ),
          ).toBe(false);
          let completed = 2;
          if (provider === "codex") {
            eventBus.emit({
              ...fileEvent,
              path: join(nativeRoot, filename(childId)),
              relativePath: filename(childId),
            });
            await settleSource(++completed);
            expect(tracker.isExternal(childId)).toBe(false);
            expect(
              metadata.identities.resolveYa(parseYaSessionId(childId)),
            ).toBeUndefined();
          }
          const legacyNativeId = "019a0000-9999-7999-8999-999999999999";
          await writeFile(
            join(nativeRoot, filename(legacyNativeId)),
            rows(
              legacyNativeId,
              "new native legacy source",
              "legacy-model",
            ).join("\n") + "\n",
          );
          eventBus.emit({
            ...fileEvent,
            path: join(nativeRoot, filename(legacyNativeId)),
            relativePath: filename(legacyNativeId),
          });
          await settleSource(++completed);
          expect(
            metadata.identities.resolveYa(parseYaSessionId(legacyNativeId)),
          ).toMatchObject({
            sessionId: legacyNativeId,
            projectId: originalId,
            native: { id: legacyNativeId, storageScope: nativeRoot },
          });
          expect(tracker.isExternal(legacyNativeId)).toBe(true);
          if (provider === "codex") {
            const leafId = "019a0000-1234-7234-8234-123412341234";
            const leaf = join(
              nativeRoot,
              `rollout-2026-11-01T12-00-00-${nativeId}_${leafId}.jsonl`,
            );
            await writeFile(
              leaf,
              [
                ...rows(nativeId, "correct native title", "gpt-6.1-sol"),
                line("event_msg", {
                  type: "user_message",
                  message: "native reverted leaf observed",
                }),
              ].join("\n") + "\n",
            );
            eventBus.emit({
              ...fileEvent,
              path: leaf,
              relativePath: leaf.split("/").at(-1)!,
            });
            await settleSource(++completed);
            expect(
              metadata.identities.resolveYa(parseYaSessionId(leafId)),
            ).toBeUndefined();
            expect(tracker.isExternal(leafId)).toBe(false);
            const history = await app.app.request(
              `/api/projects/${workingId}/sessions/${sessionId}`,
            );
            expect(history.status).toBe(200);
            expect(JSON.stringify(await history.json())).toContain(
              "native reverted leaf observed",
            );
            parentObservationFile = leaf;
          }
        } finally {
          unrelatedOwned.mockRestore();
        }
        if (provider === "claude") {
          const prior = getDebugContext();
          const lookup = vi
            .spyOn(app.supervisor, "getProcessForSession")
            .mockReturnValue({
              projectPath: workingPath,
              projectId: workingId,
              getMessageHistory: () => [
                {
                  type: "user",
                  uuid: "user",
                  message: { role: "user", content: "correct native title" },
                },
              ],
            } as unknown as Process);
          setDebugContext({
            supervisor: app.supervisor,
            claudeSessionsDir: projectsDir,
            getSessionSource: async () => {
              const project = await app!.scanner.getOrCreateProject(originalId);
              if (!project) return null;
              const source = boundSessionSource(project, sessionId, {
                readerFactory: app!.readerFactory,
                identities: metadata.identities,
              });
              return source
                ? {
                    reader: source.source.reader,
                    nativeSessionId: source.nativeSessionId,
                    projectId: source.projectId,
                  }
                : null;
            },
          });
          const server = createServer((req, res) => {
            void handleDebugRequest(
              req,
              res,
              new URL(req.url!, "http://127.0.0.1"),
            ).catch(() => {
              res.writeHead(500);
              res.end();
            });
          });
          try {
            await new Promise<void>((resolve) =>
              server.listen(0, "127.0.0.1", resolve),
            );
            const address = server.address();
            if (!address || typeof address === "string")
              throw new Error("expected test listener");
            const response = await fetch(
              `http://127.0.0.1:${address.port}/debug/sessions/${sessionId}/compare`,
            );
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({
              sessionId,
              jsonl: { count: 2 },
              comparison: {
                matching: 1,
                inSseOnly: [],
                inJsonlOnly: ["assistant"],
              },
            });
          } finally {
            setDebugContext(prior);
            lookup.mockRestore();
            await new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            );
          }
        }
        if (provider === "codex") {
          const nativeReader = new CodexSessionReader({
            sessionsDir: nativeRoot,
            projectPath: originalPath,
          });
          try {
            const project = await app.scanner.getOrCreateProject(workingId);
            expect(project).not.toBeNull();
            const attached = await attachProviderChildSessions(
              [{ id: sessionId, provider: "codex-oss" as const }],
              project!,
              {
                identities: metadata.identities,
                readerFactory: (sourceProject, native) => {
                  expect(sourceProject.id).toBe(originalId);
                  expect(native?.storageScope).toBe(nativeRoot);
                  return nativeReader;
                },
              },
              "fresh",
            );
            expect(attached[0]?.providerChildren).toEqual([
              expect.objectContaining({
                id: childId,
                parentSessionId: sessionId,
              }),
            ]);
          } finally {
            await nativeReader.close();
          }
          // No public provider/model metadata exists: the native binding must
          // win over a stale provider hint and the empty project's default.
          const recovered = await app.supervisor.resolveForkLaunchSettings(
            sessionId,
            workingPath,
            "codex-oss",
          );
          expect(recovered).toMatchObject({
            requestedModel: "gpt-6.1-sol",
            effort: "high",
            permissionMode: "bypassPermissions",
          });
          for (const suffix of ["/metadata", ""]) {
            const response = await app.app.request(
              `/api/projects/${workingId}/sessions/${sessionId}${suffix}`,
            );
            expect(response.status).toBe(200);
            expect((await response.json()).session).toMatchObject({
              id: sessionId,
              projectId: workingId,
              providerChildren: [
                expect.objectContaining({
                  id: childId,
                  parentSessionId: sessionId,
                }),
              ],
            });
          }
          const children = await app.app.request(
            `/api/projects/${workingId}/sessions/${sessionId}/agents/${childId}`,
          );
          expect(children.status).toBe(200);
          expect(JSON.stringify(await children.json())).toContain(
            "private child history",
          );
          const process = (
            await (await app.app.request("/api/processes")).json()
          ).processes[0];
          expect(process.providerChildren).toEqual([
            expect.objectContaining({
              id: childId,
              parentSessionId: sessionId,
            }),
          ]);
        }
        app.stopNotifications();
        await app.disposeSessionReaders();
        app = undefined;
        storage.close();
        storage = undefined;
      }
    } finally {
      app?.stopNotifications();
      await app?.disposeSessionReaders();
      storage?.close();
      await rm(root, { recursive: true, force: true });
      log.mockRestore();
    }
  },
);

it.each([false, true])(
  "preserves public process facts without ambient I/O for an unreadable identity (bound=%s)",
  async (bound) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "ya-process-unbound-")),
    );
    const projectPath = join(root, "project");
    const projectId = toUrlProjectId(projectPath);
    const sessionId = "saved-public-session";
    const nativeId = "019a0000-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
    let app: ReturnType<typeof createApp> | undefined;
    let storage: DiscoverySqliteService | undefined;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const dataDir = join(root, "data");
      const projectsDir = join(root, "claude");
      const ambient = join(projectsDir, projectPath.replace(/[/\\:]/g, "-"));
      await mkdir(ambient, { recursive: true });
      await mkdir(projectPath);
      for (const id of [sessionId, nativeId])
        await writeFile(
          join(ambient, `${id}.jsonl`),
          JSON.stringify({
            type: "user",
            uuid: "ambient",
            sessionId: id,
            cwd: projectPath,
            timestamp: new Date().toISOString(),
            message: { role: "user", content: "wrong ambient" },
          }) + "\n",
        );
      storage = new DiscoverySqliteService({
        dataDir,
        probeNetworkFilesystem: () => undefined,
      });
      const metadata = new SessionMetadataService({
        dataDir,
        database: storage.getDatabase(),
      });
      await metadata.initialize();
      const insert = storage
        .getDatabase()
        .prepare("INSERT INTO session_identities VALUES (?, ?, ?, ?, ?, ?, ?)");
      try {
        insert.run(
          sessionId,
          "claude",
          projectId,
          new Date().toISOString(),
          bound ? "claude" : null,
          bound ? join(root, "missing") : null,
          bound ? nativeId : null,
        );
      } finally {
        insert.finalize();
      }
      await metadata.setTitle(sessionId, "saved title");
      const eventBus = new EventBus();
      app = createApp({
        provider: new ScriptedClaudeProvider(),
        eventBus,
        dataDir,
        projectsDir,
        discoverySqlite: storage,
        sessionMetadataService: metadata,
      });
      vi.spyOn(app.supervisor, "getProcessInfoList").mockReturnValue([
        {
          id: "owned-process",
          sessionId,
          projectId,
          projectPath,
          projectName: "project",
          sessionTitle: null,
          state: "idle",
          startedAt: new Date().toISOString(),
          queueDepth: 0,
          provider: "claude",
        } satisfies ProcessInfo,
      ]);
      const process = (await (await app.app.request("/api/processes")).json())
        .processes[0];
      expect(process).toMatchObject({
        sessionId,
        provider: "claude",
        sessionTitle: "saved title",
      });
      expect(process.model).toBeUndefined();
      expect(process.providerChildren).toBeUndefined();
      expect(JSON.stringify(process)).not.toContain("wrong ambient");
      eventBus.emit({
        type: "file-change",
        provider: "claude",
        path: join(ambient, `${sessionId}.jsonl`),
        relativePath: `${sessionId}.jsonl`,
        changeType: "modify",
        fileType: "session",
        timestamp: new Date().toISOString(),
      });
      await vi.waitFor(() =>
        expect(
          app!.externalTracker!.getDiagnostics().nativeSourceBatch!.counters
            .tasksSucceeded,
        ).toBe(1),
      );
      expect(app.externalTracker!.isExternal(sessionId)).toBe(false);
    } finally {
      app?.stopNotifications();
      await app?.disposeSessionReaders();
      storage?.close();
      await rm(root, { recursive: true, force: true });
      log.mockRestore();
    }
  },
);

it("cancels a native discovery before it can adopt or publish after app/database shutdown", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "ya-observer-shutdown-")),
  );
  const projectPath = join(root, "project");
  const nativeRoot = join(root, "native");
  const dataDir = join(root, "data");
  const nativeId = "019a0000-7777-7777-8777-777777777777";
  const nativeFile = join(nativeRoot, `${nativeId}.jsonl`);
  const eventBus = new EventBus();
  const events: BusEvent[] = [];
  eventBus.subscribe((event) => events.push(event));
  let app: ReturnType<typeof createApp> | undefined;
  let storage: DiscoverySqliteService | undefined;
  let release = () => {};
  let entered = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const head = claudeSummary.readClaudeCatalogHead;
  const pause = vi
    .spyOn(claudeSummary, "readClaudeCatalogHead")
    .mockImplementation(async (...args) => {
      const value = await head(...args);
      if (args[0] === nativeFile) {
        entered();
        await held;
      }
      return value;
    });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await Promise.all(
      [projectPath, nativeRoot].map((path) => mkdir(path, { recursive: true })),
    );
    await writeFile(
      nativeFile,
      JSON.stringify({
        type: "user",
        uuid: "original",
        sessionId: nativeId,
        cwd: projectPath,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "native discovery before shutdown" },
      }) + "\n",
    );
    storage = new DiscoverySqliteService({
      dataDir,
      probeNetworkFilesystem: () => undefined,
    });
    const metadata = new SessionMetadataService({
      dataDir,
      database: storage.getDatabase(),
    });
    await metadata.initialize();
    const adoption = vi.spyOn(metadata.identities, "adoptDiscoveredBatch");
    app = createApp({
      provider: new ScriptedClaudeProvider(),
      dataDir,
      projectsDir: join(root, "empty-claude"),
      eventBus,
      discoverySqlite: storage,
      sessionMetadataService: metadata,
    });
    eventBus.emit({
      type: "file-change",
      provider: "claude",
      path: nativeFile,
      relativePath: `${nativeId}.jsonl`,
      changeType: "create",
      fileType: "session",
      timestamp: new Date().toISOString(),
    });
    await started;
    expect(adoption).not.toHaveBeenCalled();
    const tracker = app.externalTracker!;
    app.stopNotifications();
    await app.disposeSessionReaders();
    storage.close();
    storage = undefined;
    release();
    await vi.waitFor(() =>
      expect(tracker.getDiagnostics().nativeSourceBatch!.processing).toBe(
        false,
      ),
    );
    expect(adoption).not.toHaveBeenCalled();
    expect(
      events.filter(
        (event) =>
          event.type === "session-created" ||
          event.type === "session-updated" ||
          event.type === "session-status-changed",
      ),
    ).toEqual([]);
    expect(tracker.getExternalSessions()).toEqual([]);
  } finally {
    release();
    app?.stopNotifications();
    await app?.disposeSessionReaders();
    storage?.close();
    await rm(root, { recursive: true, force: true });
    pause.mockRestore();
    log.mockRestore();
  }
});
