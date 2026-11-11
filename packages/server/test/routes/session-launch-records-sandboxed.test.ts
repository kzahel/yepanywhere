import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { MessageQueue } from "../../src/sdk/messageQueue.js";
import { ClaudeProvider } from "../../src/sdk/providers/claude.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import {
  createControllableIterator,
  waitFor,
} from "../process.test-support.js";
import { createApp } from "../setup/create-app.js";

/**
 * What a session made from a sandboxed one keeps, when the source was opened
 * through a symlinked project folder. The sandbox runs in the folder's real
 * path while the source stays listed under the link, so the record of each
 * copy names one or the other. Sandboxing needs Linux and Bubblewrap; the
 * unsandboxed cases are in session-launch-records.test.ts.
 */
describe.skipIf(process.platform !== "linux")(
  "the sandbox record of a session made from a symlinked sandboxed source",
  () => {
    const timestamp = "2026-11-01T00:00:00.000Z";
    let root: string;
    let realProject: string;
    let linkProject: string;
    let linkId: string;
    let realId: string;
    let hostRoot: string;
    let storage: DiscoverySqliteService;
    let metadata: SessionMetadataService;
    let provider: ClaudeProvider;
    let app: ReturnType<typeof createApp>;
    /** Message ids of each transcript the provider wrote, by session. */
    const transcripts = new Map<string, string[]>();
    let source: string;

    beforeEach(async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      root = await realpath(
        await mkdtemp(join(tmpdir(), "ya-sandboxed-launch-records-")),
      );
      realProject = join(root, "real-project");
      linkProject = join(root, "linked-project");
      await mkdir(realProject, { recursive: true });
      await symlink(realProject, linkProject);
      linkId = toUrlProjectId(linkProject);
      realId = toUrlProjectId(realProject);
      const claudeConfig = join(root, "claude");
      vi.stubEnv("CLAUDE_CONFIG_DIR", claudeConfig);
      hostRoot = join(claudeConfig, "projects", "host");
      await mkdir(hostRoot, { recursive: true });
      const dataDir = join(root, "data");
      storage = new DiscoverySqliteService({
        dataDir,
        probeNetworkFilesystem: () => undefined,
      });
      metadata = new SessionMetadataService({
        dataDir,
        database: storage.getDatabase(),
      });
      await metadata.initialize();
      provider = new ClaudeProvider();
      vi.spyOn(provider, "isInstalled").mockResolvedValue(true);
      vi.spyOn(provider, "isAuthenticated").mockResolvedValue(true);
      vi.spyOn(provider, "getAuthStatus").mockResolvedValue({
        installed: true,
        authenticated: true,
        enabled: true,
      });
      // A provider that reports its session, confirms each input and, for a
      // new session, writes its transcript where the sandbox keeps it.
      vi.spyOn(provider, "startSession").mockImplementation(async (options) => {
        const sessionId = (options.resumeSessionId ?? options.newSessionId)!;
        if (options.newSessionId) {
          const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
          transcripts.set(sessionId, ids);
          const dir = options.sessionSandbox?.transcriptDir ?? hostRoot;
          await mkdir(dir, { recursive: true });
          await writeFile(
            join(dir, `${sessionId}.jsonl`),
            transcript(sessionId, [
              [ids[0]!, "user", "first question"],
              [ids[1]!, "assistant", "first answer"],
              [ids[2]!, "user", "second question"],
              [ids[3]!, "assistant", "second answer"],
            ]),
          );
        }
        const owner = createControllableIterator();
        const queue = new MessageQueue();
        owner.push({
          type: "system",
          subtype: "init",
          session_id: sessionId,
        } as Parameters<typeof owner.push>[0]);
        void (async () => {
          for await (const input of queue) {
            owner.push({
              type: "assistant",
              session_id: sessionId,
              user_message_uuid: input.uuid,
              message: { role: "assistant", content: "reply" },
            } as Parameters<typeof owner.push>[0]);
          }
        })();
        return { iterator: owner.iterator, queue, abort: owner.finish };
      });
      app = createApp({
        provider,
        dataDir,
        projectsDir: join(claudeConfig, "projects"),
        sessionMetadataService: metadata,
        discoverySqlite: storage,
      });
      // The source: a new sandboxed session started in the linked folder.
      const created = await app.app.request(
        `/api/projects/${linkId}/session-creations`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({
            message: "Build the canvas",
            provider: "claude",
            model: "source-model",
            sandboxLevel: "project-write",
            sandboxNetworkFirewall: false,
            requestId: randomUUID(),
          }),
        },
      );
      expect(created.status, await created.clone().text()).toBeLessThan(300);
      const body = (await created.json()) as {
        sessionId?: string;
        creation?: { sessionId?: string };
      };
      source = (body.sessionId ?? body.creation?.sessionId)!;
      expect(source).toEqual(expect.any(String));
      // Started once its process saved the sandbox it runs in.
      await waitFor(() =>
        expect(metadata.getMetadata(source)?.sandboxStateKey).toBeDefined(),
      );
      await metadata.updateMetadata(source, { title: "Source title" });
      // The copies are made from the source at rest, as in the unsandboxed
      // cases, so no turn of it is still in progress.
      await app.supervisor.abortProcess(
        app.supervisor.getProcessForSession(source)!.id,
      );
    });

    function transcript(
      sessionId: string,
      rows: Array<[uuid: string, type: "user" | "assistant", text: string]>,
    ): string {
      return `${rows
        .map(([uuid, type, text], index) =>
          JSON.stringify({
            type,
            uuid,
            parentUuid: index === 0 ? null : rows[index - 1]![0],
            sessionId,
            cwd: realProject,
            timestamp,
            message:
              type === "user"
                ? { role: "user", content: text }
                : {
                    role: "assistant",
                    model: "claude-transcript-model",
                    content: [{ type: "text", text }],
                  },
          }),
        )
        .join("\n")}\n`;
    }

    afterEach(async () => {
      for (const process of app.supervisor.getAllProcesses()) {
        await process.abort();
      }
      await app.supervisor.stopBackgroundTasks();
      app.stopNotifications();
      await app.disposeSessionReaders();
      storage.close();
      transcripts.clear();
      await rm(root, { recursive: true, force: true });
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });

    async function post(path: string, body: unknown): Promise<Response> {
      return app.app.request(`/api/projects/${linkId}/sessions/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: JSON.stringify(body),
      });
    }

    /** The stored sandbox record, with this run's paths and ids named. */
    function sandboxRecord(sessionId: string): Record<string, unknown> {
      const record = metadata.getMetadata(sessionId) ?? {};
      const kept = Object.fromEntries(
        Object.entries(record).filter(
          ([key]) =>
            key.startsWith("sandbox") ||
            key === "workingProjectId" ||
            key === "transcriptProjectId",
        ),
      );
      return JSON.parse(
        JSON.stringify(kept)
          .replaceAll(linkId, "<link-id>")
          .replaceAll(realId, "<real-id>")
          .replaceAll(linkProject, "<link>")
          .replaceAll(realProject, "<real>")
          .replace(/"project-[0-9a-f]{32}"/, '"<state-key>"'),
      );
    }

    /** Which project's session list shows `sessionId`. */
    async function listedUnder(sessionId: string): Promise<string[]> {
      const listed: string[] = [];
      for (const [name, id] of [
        ["link", linkId],
        ["real", realId],
      ] as const) {
        const response = await app.app.request(
          `/api/projects/${id}/sessions?includeArchived=true`,
          { headers: { "X-Yep-Anywhere": "true" } },
        );
        if (!response.ok) continue;
        const { sessions } = (await response.json()) as {
          sessions: Array<{ id: string }>;
        };
        if (sessions.some((session) => session.id === sessionId))
          listed.push(name);
      }
      return listed;
    }

    /** Where a plain later resume of `sessionId` runs. */
    async function laterResume(sessionId: string) {
      const live = app.supervisor.getProcessForSession(sessionId);
      if (live) await app.supervisor.abortProcess(live.id);
      const response = await post(`${sessionId}/resume`, {
        message: "a later turn",
      });
      expect(response.status, await response.clone().text()).toBe(200);
      const process = app.supervisor.getProcessForSession(sessionId)!;
      const after = metadata.getMetadata(sessionId);
      return JSON.parse(
        JSON.stringify({
          sandbox: process.sandboxEnforcement?.effective ?? "none",
          projectId: process.projectId,
          projectPath: process.projectPath,
          sandboxProjectPath: process.sandboxProjectPath,
          storedAfterwards: {
            workingProjectId: after?.workingProjectId,
            sandboxProjectPath: after?.sandboxProjectPath,
          },
          listedAfterwards: await listedUnder(sessionId),
        })
          .replaceAll(linkId, "<link-id>")
          .replaceAll(realId, "<real-id>")
          .replaceAll(linkProject, "<link>")
          .replaceAll(realProject, "<real>"),
      );
    }

    async function newSession(response: Response): Promise<string> {
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as { sessionId: string }).sessionId;
    }

    it("the source", async () => {
      expect(sandboxRecord(source)).toMatchInlineSnapshot(`
        {
          "sandboxEverConfined": true,
          "sandboxLevel": "project-write",
          "sandboxNetworkFirewall": false,
          "sandboxProjectPath": "<real>",
          "sandboxStateKey": "<state-key>",
          "workingProjectId": "<link-id>",
        }
      `);
      expect(await listedUnder(source)).toMatchInlineSnapshot(`
        [
          "link",
        ]
      `);
      expect(await laterResume(source)).toMatchInlineSnapshot(`
        {
          "listedAfterwards": [
            "real",
          ],
          "projectId": "<real-id>",
          "projectPath": "<real>",
          "sandbox": "project-write",
          "sandboxProjectPath": "<real>",
          "storedAfterwards": {
            "sandboxProjectPath": "<real>",
            "workingProjectId": "<real-id>",
          },
        }
      `);
    });

    it("fork", async () => {
      const child = await newSession(await post(`${source}/fork`, {}));
      expect(sandboxRecord(child)).toMatchInlineSnapshot(`
        {
          "sandboxEverConfined": true,
          "sandboxLevel": "project-write",
          "sandboxNetworkFirewall": false,
          "sandboxProjectPath": "<real>",
          "sandboxStateKey": "<state-key>",
          "transcriptProjectId": "<link-id>",
          "workingProjectId": "<link-id>",
        }
      `);
      expect(await listedUnder(child)).toMatchInlineSnapshot(`
        [
          "link",
        ]
      `);
      expect(await laterResume(child)).toMatchInlineSnapshot(`
        {
          "listedAfterwards": [
            "real",
          ],
          "projectId": "<real-id>",
          "projectPath": "<real>",
          "sandbox": "project-write",
          "sandboxProjectPath": "<real>",
          "storedAfterwards": {
            "sandboxProjectPath": "<real>",
            "workingProjectId": "<real-id>",
          },
        }
      `);
    });

    it("clone", async () => {
      const child = await newSession(
        await post(`${source}/clone`, { parentSessionId: source }),
      );
      expect(sandboxRecord(child)).toMatchInlineSnapshot(`
        {
          "sandboxEverConfined": true,
          "sandboxLevel": "project-write",
          "sandboxNetworkFirewall": false,
          "sandboxProjectPath": "<real>",
          "sandboxStateKey": "<state-key>",
          "transcriptProjectId": "<link-id>",
          "workingProjectId": "<real-id>",
        }
      `);
      expect(await listedUnder(child)).toMatchInlineSnapshot(`
        [
          "real",
        ]
      `);
      expect(await laterResume(child)).toMatchInlineSnapshot(`
        {
          "listedAfterwards": [
            "real",
          ],
          "projectId": "<real-id>",
          "projectPath": "<real>",
          "sandbox": "project-write",
          "sandboxProjectPath": "<real>",
          "storedAfterwards": {
            "sandboxProjectPath": "<real>",
            "workingProjectId": "<real-id>",
          },
        }
      `);
    });

    it("restart handoff", async () => {
      const child = await newSession(
        await post(`${source}/restart`, {
          handoffText: "Handoff of the source session",
        }),
      );
      expect(sandboxRecord(child)).toMatchInlineSnapshot(`
        {
          "sandboxEverConfined": true,
          "sandboxLevel": "project-write",
          "sandboxNetworkFirewall": false,
          "sandboxProjectPath": "<real>",
          "sandboxStateKey": "<state-key>",
          "workingProjectId": "<real-id>",
        }
      `);
      expect(await listedUnder(child)).toMatchInlineSnapshot(`
        [
          "real",
        ]
      `);
      expect(await laterResume(child)).toMatchInlineSnapshot(`
        {
          "listedAfterwards": [
            "real",
          ],
          "projectId": "<real-id>",
          "projectPath": "<real>",
          "sandbox": "project-write",
          "sandboxProjectPath": "<real>",
          "storedAfterwards": {
            "sandboxProjectPath": "<real>",
            "workingProjectId": "<real-id>",
          },
        }
      `);
    });

    it("restart fork", async () => {
      const child = await newSession(
        await post(`${source}/restart`, {
          restartMode: "fork",
          reason: "Continue from here",
        }),
      );
      expect(sandboxRecord(child)).toMatchInlineSnapshot(`
        {
          "sandboxEverConfined": true,
          "sandboxLevel": "project-write",
          "sandboxNetworkFirewall": false,
          "sandboxProjectPath": "<real>",
          "sandboxStateKey": "<state-key>",
          "transcriptProjectId": "<link-id>",
          "workingProjectId": "<real-id>",
        }
      `);
      expect(await listedUnder(child)).toMatchInlineSnapshot(`
        [
          "real",
        ]
      `);
      expect(await laterResume(child)).toMatchInlineSnapshot(`
        {
          "listedAfterwards": [
            "real",
          ],
          "projectId": "<real-id>",
          "projectPath": "<real>",
          "sandbox": "project-write",
          "sandboxProjectPath": "<real>",
          "storedAfterwards": {
            "sandboxProjectPath": "<real>",
            "workingProjectId": "<real-id>",
          },
        }
      `);
    });

    it("retitle helper", async () => {
      const generateSummary = vi
        .spyOn(app.supervisor, "generateSummary")
        .mockResolvedValue({ text: "Proposed title" } as Awaited<
          ReturnType<typeof app.supervisor.generateSummary>
        >);
      const response = await post(`${source}/retitle`, {});
      expect(response.status, await response.clone().text()).toBe(200);
      const generator = generateSummary.mock.calls[0]?.[1]?.generatorSessionId;
      expect(sandboxRecord(generator!)).toMatchInlineSnapshot(`
        {
          "sandboxEverConfined": true,
          "sandboxLevel": "project-write",
          "sandboxNetworkFirewall": false,
          "sandboxProjectPath": "<real>",
          "sandboxStateKey": "<state-key>",
          "transcriptProjectId": "<link-id>",
          "workingProjectId": "<link-id>",
        }
      `);
    });

    it("fork-summary helper and target", async () => {
      const generateSummary = vi
        .spyOn(app.supervisor, "generateSummary")
        .mockResolvedValue({ text: "Summary of the work so far" } as Awaited<
          ReturnType<typeof app.supervisor.generateSummary>
        >);
      const response = await post(`${source}/fork-summary`, {
        sourceMessageId: transcripts.get(source)![2],
      });
      expect(response.status, await response.clone().text()).toBeLessThan(300);
      await waitFor(() =>
        expect(
          metadata.getMetadata(source)?.transcriptDisplayObjects,
        ).toContainEqual(
          expect.objectContaining({ kind: "fork-summary", status: "ready" }),
        ),
      );
      const generator = generateSummary.mock.calls[0]?.[1]?.generatorSessionId;
      const target = metadata
        .getMetadata(source)
        ?.transcriptDisplayObjects?.find(
          (object) => object.kind === "fork-summary",
        ) as { targetSessionId?: string } | undefined;
      expect(sandboxRecord(generator!)).toMatchInlineSnapshot(`
        {
          "sandboxEverConfined": true,
          "sandboxLevel": "project-write",
          "sandboxNetworkFirewall": false,
          "sandboxProjectPath": "<real>",
          "sandboxStateKey": "<state-key>",
          "transcriptProjectId": "<link-id>",
          "workingProjectId": "<link-id>",
        }
      `);
      expect(sandboxRecord(target!.targetSessionId!)).toMatchInlineSnapshot(`
        {
          "sandboxEverConfined": true,
          "sandboxLevel": "project-write",
          "sandboxNetworkFirewall": false,
          "sandboxProjectPath": "<real>",
          "sandboxStateKey": "<state-key>",
          "transcriptProjectId": "<link-id>",
          "workingProjectId": "<real-id>",
        }
      `);
      expect(await listedUnder(target!.targetSessionId!)).toMatchInlineSnapshot(
        `
        [
          "real",
        ]
      `,
      );
      expect(
        await laterResume(target!.targetSessionId!),
      ).toMatchInlineSnapshot(`
        {
          "listedAfterwards": [
            "real",
          ],
          "projectId": "<real-id>",
          "projectPath": "<real>",
          "sandbox": "project-write",
          "sandboxProjectPath": "<real>",
          "storedAfterwards": {
            "sandboxProjectPath": "<real>",
            "workingProjectId": "<real-id>",
          },
        }
      `);
    });
  },
);
