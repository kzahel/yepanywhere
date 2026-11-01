import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { expect, it, vi } from "vitest";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import { attachProviderChildSessions } from "../../src/sessions/provider-child-sessions.js";
import { MockClaudeSDK } from "../../src/sdk/mock.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import type { ProcessInfo } from "../../src/supervisor/types.js";
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
          } finally {
            insert.finalize();
          }
          // Metadata under N belongs to another YA resource, not to P's source.
          await metadata.setTitle(nativeId, "WRONG PUBLIC METADATA");
          await metadata.setWorkingProject(sessionId, workingId, originalId);
        }
        app = createApp({
          sdk: new MockClaudeSDK(),
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
      app = createApp({
        sdk: new MockClaudeSDK(),
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
    } finally {
      app?.stopNotifications();
      await app?.disposeSessionReaders();
      storage?.close();
      await rm(root, { recursive: true, force: true });
      log.mockRestore();
    }
  },
);
