import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fromUrlProjectId, toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp as createFixtureApp } from "../setup/create-app.js";
import {
  ScriptedClaudeProvider,
  createMockScenario,
} from "../support/scripted-provider.js";
import {
  closeProviderRuntimeHostRegistration,
  initializeProviderRuntimeHost,
  isProviderRuntimeHostAvailable,
} from "../../src/sdk/providers/provider-runtime-host.js";
import { controlledProvider } from "../support/scripted-provider.js";
import { MessageQueue } from "../../src/sdk/messageQueue.js";
import { PublicShareService } from "../../src/services/PublicShareService.js";
import { ClaudeSessionReader } from "../../src/sessions/reader.js";
import type { ServerSettingsService } from "../../src/services/ServerSettingsService.js";
import { encodeProjectId } from "../../src/supervisor/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures", "agents");

async function readOptionalText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function createSettingsServiceForAuditLog(
  enabled: boolean,
): ServerSettingsService {
  return {
    getSetting: (key: string) =>
      key === "approvalAuditLogEnabled" ? enabled : undefined,
    getSettings: () => ({
      hostProcessObservabilityEnabled: false,
    }),
    onSettingsChanged: () => () => {},
  } as unknown as ServerSettingsService;
}

function createSettingsServiceForPublicShares(): ServerSettingsService {
  return {
    getSetting: (key: string) =>
      key === "publicSharesEnabled" ? true : undefined,
    getSettings: () => ({
      hostProcessObservabilityEnabled: false,
    }),
    onSettingsChanged: () => () => {},
  } as unknown as ServerSettingsService;
}

describe("Sessions API", () => {
  const ownedApps = new Set<ReturnType<typeof createFixtureApp>>();
  const createApp: typeof createFixtureApp = (options) => {
    const app = createFixtureApp(options);
    ownedApps.add(app);
    return app;
  };
  // Input/share tests seed an existing live runtime; creation is covered by
  // the real SQLite admission route suites, never a synthetic HTTP reply.
  async function seedActiveSession(
    app: ReturnType<typeof createFixtureApp>["app"],
    project: string,
    sessionId: string,
  ) {
    const fixture = [...ownedApps].find((value) => value.app === app);
    if (!fixture) throw new Error("Unowned API fixture");
    const process = await fixture.supervisor.resumeSession(
      sessionId,
      fromUrlProjectId(project),
      { text: "hello" },
    );
    if (!("id" in process)) throw new Error("Expected an active fixture");
    return { sessionId: process.sessionId, processId: process.id };
  }
  let mockSdk: ScriptedClaudeProvider;
  let testDir: string;
  let projectId: string;

  beforeEach(async () => {
    mockSdk = new ScriptedClaudeProvider();
    // Create temp directory structure with a valid project
    testDir = join(tmpdir(), `claude-test-${randomUUID()}`);
    const projectPath = "/home/user/myproject";
    projectId = encodeProjectId(projectPath);
    const encodedPath = projectPath.replace(/[/\\:]/g, "-");

    await mkdir(join(testDir, "localhost", encodedPath), { recursive: true });
    // Session file must include cwd field for project path discovery
    await writeFile(
      join(testDir, "localhost", encodedPath, "sess-existing.jsonl"),
      `{"type":"user","cwd":"${projectPath}","message":{"content":"Hello"}}\n`,
    );
  });

  afterEach(async () => {
    const apps = Array.from(ownedApps);
    ownedApps.clear();
    const results = await Promise.allSettled(
      apps.map(async (app) => {
        app.stopNotifications();
        await app.disposeSessionReaders();
      }),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length)
      throw new AggregateError(failures, "Sessions API fixture cleanup failed");
    // Per-case provider history has a shorter lifetime than the file's app
    // registry. Stop its readers/watchers before removing that history.
    await rm(testDir, { recursive: true, force: true });
  });

  it("does not expose retired browser creation routes", async () => {
    const { app, supervisor } = createApp({
      provider: mockSdk,
      projectsDir: testDir,
    });
    const start = vi.spyOn(supervisor, "startSession");
    for (const path of [
      "/api/sessions",
      "/api/sessions/create",
      `/api/projects/${projectId}/sessions`,
      `/api/projects/${projectId}/sessions/create`,
    ]) {
      const response = await app.request(path, {
        method: "POST",
        headers: {
          "X-Yep-Anywhere": "true",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: "old creation" }),
      });
      expect(response.status).toBe(404);
    }
    expect(start).not.toHaveBeenCalled();
  });

  describe("POST /api/projects/:projectId/sessions/:sessionId/resume", () => {
    beforeEach(async () => {
      // Resume a persisted Claude session, rather than making a missing mock
      // id probe unrelated providers before falling back to Claude. The
      // full workspace run hit 5s in that unrelated discovery before teardown.
      await writeFile(
        join(testDir, "localhost", "-home-user-myproject", "sess-123.jsonl"),
        `${JSON.stringify({ type: "user", cwd: "/home/user/myproject", message: { content: "Hello" } })}\n`,
      );
    });

    it("returns 400 if message is missing", async () => {
      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-123/resume`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({}),
        },
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("Message is required");
    });

    it("returns 404 for unknown project", async () => {
      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });

      const res = await app.request(
        "/api/projects/unknown/sessions/sess-123/resume",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({ message: "hello" }),
        },
      );

      expect(res.status).toBe(404);
    });

    it("refuses a retired SSH executor before launch", async () => {
      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-123/resume`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({
            message: "continue",
            executor: "-oProxyCommand=touch_/tmp/pwned",
          }),
        },
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("SSH executors have been removed");
    });

    it("resumes a session and returns processId", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Resumed!"));
      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-123/resume`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({ message: "continue" }),
        },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.processId).toBeDefined();
    });

    it("resumes a session from an attachment without text", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Resumed!"));
      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-123/resume`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({
            message: "",
            attachments: [
              {
                id: "attachment-2",
                originalName: "note.txt",
                name: "attachment-2-note.txt",
                path: "/tmp/attachment-2-note.txt",
                size: 8,
                mimeType: "text/plain",
              },
            ],
          }),
        },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.processId).toBeDefined();
    });

    it("accepts permission mode parameter", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Resumed!"));
      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-123/resume`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({ message: "continue", mode: "plan" }),
        },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.processId).toBeDefined();
    });

    it("returns permissionMode and modeVersion in response", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Resumed!"));
      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-123/resume`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({
            message: "continue",
            mode: "bypassPermissions",
          }),
        },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.permissionMode).toBe("bypassPermissions");
      expect(json.modeVersion).toBe(0);
    });
  });

  describe("POST /api/sessions/:sessionId/messages", () => {
    it("returns 404 if no active process", async () => {
      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });

      const res = await app.request("/api/sessions/unknown/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: JSON.stringify({ message: "hello" }),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("No active process for session");
    });
  });

  describe("GET /api/sessions/:sessionId/pending-input", () => {
    it("returns null request when no active process", async () => {
      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });

      const res = await app.request("/api/sessions/unknown/pending-input");
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.request).toBeNull();
    });
  });

  describe("GET /api/projects/:projectId/sessions/:sessionId", () => {
    const projectPath = "/home/user/myproject";

    async function writeCompactedSession(
      name: string,
      sessionProjectPath = projectPath,
    ) {
      const encodedPath = sessionProjectPath.replace(/[/\\:]/g, "-");
      const sessionDir = join(testDir, "localhost", encodedPath);
      await mkdir(sessionDir, { recursive: true });
      const timestamp = (second: number) =>
        `2026-01-01T00:00:${String(second).padStart(2, "0")}Z`;
      const user = (uuid: string, parentUuid: string | null, second: number) =>
        ({
          type: "user",
          cwd: sessionProjectPath,
          sessionId: name,
          uuid,
          ...(parentUuid ? { parentUuid } : {}),
          timestamp: timestamp(second),
          message: { role: "user", content: uuid },
        }) satisfies Record<string, unknown>;
      const assistant = (uuid: string, parentUuid: string, second: number) =>
        ({
          type: "assistant",
          cwd: sessionProjectPath,
          sessionId: name,
          uuid,
          parentUuid,
          timestamp: timestamp(second),
          message: { role: "assistant", content: uuid },
        }) satisfies Record<string, unknown>;
      const compactBoundary = (
        uuid: string,
        logicalParentUuid: string,
        second: number,
      ) =>
        ({
          type: "system",
          subtype: "compact_boundary",
          cwd: sessionProjectPath,
          sessionId: name,
          uuid,
          parentUuid: null,
          logicalParentUuid,
          timestamp: timestamp(second),
          content: "Conversation compacted",
          compactMetadata: { trigger: "auto", preTokens: 100000 + second },
        }) satisfies Record<string, unknown>;

      const entries = [
        user("u1", null, 1),
        assistant("a1", "u1", 2),
        compactBoundary("cb1", "a1", 3),
        user("u2", "cb1", 4),
        assistant("a2", "u2", 5),
        compactBoundary("cb2", "a2", 6),
        user("u3", "cb2", 7),
        assistant("a3", "u3", 8),
        compactBoundary("cb3", "a3", 9),
        user("u4", "cb3", 10),
      ];

      const sessionFile = join(sessionDir, `${name}.jsonl`);
      await writeFile(
        sessionFile,
        `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      );
      return sessionFile;
    }

    it("defaults no-query detail requests to a compact tail", async () => {
      await writeCompactedSession("sess-compact-default");
      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-compact-default`,
        { headers: { "X-Yep-Anywhere": "true" } },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.transcriptSnapshotUpdatedAt).toEqual(expect.any(String));
      expect(
        json.messages.map((message: { uuid?: string }) => message.uuid),
      ).toEqual(["cb2", "u3", "a3", "cb3", "u4"]);
      expect(json.pagination).toMatchObject({
        hasOlderMessages: true,
        returnedMessageCount: 5,
        totalCompactions: 3,
        truncatedBeforeMessageId: "cb2",
      });
    });

    it("reports additive detail phases through Server-Timing", async () => {
      await writeCompactedSession("sess-timed");
      const children = vi
        .spyOn(ClaudeSessionReader.prototype, "listProviderChildSessions")
        .mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return [];
        });
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: testDir,
        persistedAugmentDelayMs: 50,
      });

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-timed`,
        { headers: { "X-Yep-Anywhere": "true" } },
      );

      expect(res.status).toBe(200);
      const serverTiming = res.headers.get("Server-Timing") ?? "";
      const entries = Object.fromEntries(
        serverTiming.split(", ").map((entry) => {
          const match = /^(ya-[a-z]+);dur=([0-9.]+)/.exec(entry);
          expect(match).not.toBeNull();
          return [match?.[1], Number(match?.[2])];
        }),
      );
      expect(Object.keys(entries)).toEqual([
        "ya-augment",
        "ya-metadata",
        "ya-normalize",
        "ya-project",
        "ya-read",
        "ya-route",
        "ya-total",
      ]);
      expect(entries["ya-total"]).toBeGreaterThanOrEqual(
        entries["ya-project"] +
          entries["ya-read"] +
          entries["ya-metadata"] +
          entries["ya-normalize"] +
          entries["ya-route"] +
          entries["ya-augment"] -
          0.5,
      );
      expect(entries["ya-metadata"]).toBeGreaterThanOrEqual(25);
      expect(entries["ya-route"]).toBeLessThan(entries["ya-metadata"]);
      children.mockRestore();
      expect(entries["ya-augment"]).toBeGreaterThanOrEqual(45);
      expect(serverTiming).toMatch(
        /ya-augment;dur=[0-9.]+;desc="messages=5 changed=[0-5] cache-hit=[0-9]+ cache-join=[0-9]+ cache-miss=[0-9]+"/,
      );
    });

    it("returns full transcript only when fullHistory=1 is explicit", async () => {
      await writeCompactedSession("sess-compact-full");
      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-compact-full?fullHistory=1&fullHistoryReason=test`,
        { headers: { "X-Yep-Anywhere": "true" } },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(
        json.messages.map((message: { uuid?: string }) => message.uuid),
      ).toEqual([
        "u1",
        "a1",
        "cb1",
        "u2",
        "a2",
        "cb2",
        "u3",
        "a3",
        "cb3",
        "u4",
      ]);
      expect(json.pagination).toBeUndefined();
    });

    it("captures complete history for frozen public shares", async () => {
      const shareProjectPath = join(testDir, "share-project");
      const shareProjectId = encodeProjectId(shareProjectPath);
      await mkdir(shareProjectPath);
      await writeCompactedSession("sess-public-share-full", shareProjectPath);
      const publicShareService = new PublicShareService({
        dataDir: join(testDir, "share-data"),
      });
      await publicShareService.initialize();
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: testDir,
        publicShareService,
        serverSettingsService: createSettingsServiceForPublicShares(),
        remoteAccessService: {
          getRelayConfig: () => ({
            url: "wss://relay.example/ws",
            username: "host-one",
          }),
          isEnabled: () => true,
        } as never,
      });
      const originalFetch = app.fetch.bind(app);
      const detailRequests: URL[] = [];
      vi.spyOn(app, "fetch").mockImplementation(async (...args) => {
        const requestUrl = new URL(args[0].url);
        if (
          requestUrl.pathname ===
          `/api/projects/${shareProjectId}/sessions/sess-public-share-full`
        ) {
          detailRequests.push(requestUrl);
        }
        return originalFetch(...args);
      });

      const response = await app.fetch(
        new Request("http://127.0.0.1/api/public-shares", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({
            projectId: shareProjectId,
            sessionId: "sess-public-share-full",
            mode: "frozen",
          }),
        }),
      );
      const body = (await response.json()) as { url: string };

      expect(response.status).toBe(200);
      expect(detailRequests).toHaveLength(2);
      for (const requestUrl of detailRequests) {
        expect(requestUrl.searchParams.get("publicShare")).toBe("1");
        expect(requestUrl.searchParams.get("fullHistory")).toBe("1");
      }
      const secret = new URL(body.url).pathname.split("/").at(-1)!;
      const stored = await publicShareService.getFrozenShareBySecret(secret);
      expect(stored?.session.messages?.map((message) => message.uuid)).toEqual([
        "u1",
        "a1",
        "cb1",
        "u2",
        "a2",
        "cb2",
        "u3",
        "a3",
        "cb3",
        "u4",
      ]);
    });

    it("freezes the durable completed prefix while a later turn is active", async () => {
      const activeProjectPath = join(testDir, "active-share-project");
      const activeProjectId = encodeProjectId(activeProjectPath);
      await mkdir(activeProjectPath);
      const activeSessionFile = await writeCompactedSession(
        "sess-existing",
        activeProjectPath,
      );
      await appendFile(
        activeSessionFile,
        `${JSON.stringify({
          type: "assistant",
          cwd: activeProjectPath,
          sessionId: "sess-existing",
          uuid: "a4",
          parentUuid: "u4",
          timestamp: "2026-01-01T00:00:11Z",
          message: { role: "assistant", content: "a4" },
        })}\n`,
      );
      let releaseProcess!: () => void;
      const processGate = new Promise<void>((resolve) => {
        releaseProcess = resolve;
      });
      const heldSdk = controlledProvider({
        async startSession() {
          async function* messages() {
            yield {
              type: "system",
              subtype: "init",
              session_id: "sess-existing",
            };
            yield {
              type: "assistant",
              message: {
                role: "assistant",
                content: "replay-only active marker",
              },
            };
            await processGate;
            yield { type: "result", session_id: "sess-existing" };
          }
          return {
            iterator: messages() as AsyncIterableIterator<
              import("../../src/sdk/types.js").SDKMessage
            >,
            queue: new MessageQueue(),
            abort: releaseProcess,
          };
        },
      });
      await initializeProviderRuntimeHost();
      closeProviderRuntimeHostRegistration();
      expect(isProviderRuntimeHostAvailable()).toBe(false);
      const publicShareService = new PublicShareService({
        dataDir: join(testDir, "active-share-data"),
      });
      await publicShareService.initialize();
      const { app, supervisor } = createApp({
        provider: heldSdk,
        projectsDir: testDir,
        publicShareService,
        serverSettingsService: createSettingsServiceForPublicShares(),
        remoteAccessService: {
          getRelayConfig: () => ({
            url: "wss://relay.example/ws",
            username: "host-one",
          }),
          isEnabled: () => true,
        } as never,
      });
      const resumed = await seedActiveSession(
        app,
        activeProjectId,
        "sess-existing",
      );
      const { processId } = resumed as { processId: string };

      try {
        await vi.waitFor(
          async () => {
            const detail = await app.request(
              `/api/projects/${activeProjectId}/sessions/sess-existing?fullHistory=1&fullHistoryReason=test`,
              { headers: { "X-Yep-Anywhere": "true" } },
            );
            expect(detail.status).toBe(200);
            const body = await detail.json();
            expect(body.session.ownership).toMatchObject({ owner: "self" });
          },
          { timeout: 4_000, interval: 25 },
        );
        await appendFile(
          activeSessionFile,
          `${JSON.stringify({
            type: "user",
            cwd: activeProjectPath,
            sessionId: "sess-existing",
            uuid: "u5",
            parentUuid: "a4",
            timestamp: new Date().toISOString(),
            message: { role: "user", content: "incomplete active turn" },
          })}\n`,
        );
        await vi.waitFor(
          async () => {
            const detail = await app.request(
              `/api/projects/${activeProjectId}/sessions/sess-existing?fullHistory=1&fullHistoryReason=test`,
              { headers: { "X-Yep-Anywhere": "true" } },
            );
            expect(detail.status).toBe(200);
            expect(JSON.stringify((await detail.json()).messages)).toContain(
              "incomplete active turn",
            );
          },
          { timeout: 4_000, interval: 25 },
        );

        const frozen = await app.request("/api/public-shares", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({
            projectId: activeProjectId,
            sessionId: "sess-existing",
            mode: "frozen",
          }),
        });

        expect(frozen.status).toBe(200);
        const frozenBody = (await frozen.json()) as { url: string };
        const secret = new URL(frozenBody.url).pathname.split("/").at(-1)!;
        const stored = await publicShareService.getFrozenShareBySecret(secret);
        expect(stored?.session.messages?.at(-1)?.uuid).toBe("a4");
        expect(JSON.stringify(stored?.session.messages)).not.toContain(
          "replay-only active marker",
        );
        expect(JSON.stringify(stored?.session.messages)).not.toContain(
          "incomplete active turn",
        );
        expect(
          publicShareService.getSessionShareStatus(
            toUrlProjectId(activeProjectPath),
            "sess-existing",
          ).activeCount,
        ).toBe(1);
      } finally {
        releaseProcess();
        await supervisor.abortProcess(processId);
      }
    }, 10_000);

    it("rejects partial history returned to the frozen-share adapter", async () => {
      const shareProjectPath = join(testDir, "partial-share-project");
      const shareProjectId = encodeProjectId(shareProjectPath);
      await mkdir(shareProjectPath);
      await writeCompactedSession(
        "sess-public-share-partial",
        shareProjectPath,
      );
      const publicShareService = new PublicShareService({
        dataDir: join(testDir, "partial-share-data"),
      });
      await publicShareService.initialize();
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: testDir,
        publicShareService,
        serverSettingsService: createSettingsServiceForPublicShares(),
        remoteAccessService: {
          getRelayConfig: () => ({
            url: "wss://relay.example/ws",
            username: "host-one",
          }),
          isEnabled: () => true,
        } as never,
      });
      const originalFetch = app.fetch.bind(app);
      vi.spyOn(app, "fetch").mockImplementation(async (...args) => {
        const requestUrl = new URL(args[0].url);
        const response = await originalFetch(...args);
        if (
          requestUrl.pathname !==
          `/api/projects/${shareProjectId}/sessions/sess-public-share-partial`
        ) {
          return response;
        }
        const body = (await response.json()) as Record<string, unknown>;
        return Response.json({
          ...body,
          pagination: { hasOlderMessages: true },
        });
      });

      const response = await app.fetch(
        new Request("http://127.0.0.1/api/public-shares", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({
            projectId: shareProjectId,
            sessionId: "sess-public-share-partial",
            mode: "frozen",
          }),
        }),
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ retryable: true });
      expect(
        publicShareService.getSessionShareStatus(
          shareProjectId,
          "sess-public-share-partial",
        ).activeCount,
      ).toBe(0);
    });

    it("preserves explicit compact-tail bounds", async () => {
      await writeCompactedSession("sess-compact-explicit");
      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-compact-explicit?tailCompactions=1`,
        { headers: { "X-Yep-Anywhere": "true" } },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(
        json.messages.map((message: { uuid?: string }) => message.uuid),
      ).toEqual(["cb3", "u4"]);
      expect(json.pagination).toMatchObject({
        hasOlderMessages: true,
        returnedMessageCount: 2,
        totalCompactions: 3,
        truncatedBeforeMessageId: "cb3",
      });
    });

    it("applies turn tails inside the default compact scope", async () => {
      await writeCompactedSession("sess-compact-turn-tail");
      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-compact-turn-tail?tailTurns=20`,
        { headers: { "X-Yep-Anywhere": "true" } },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(
        json.messages.map((message: { uuid?: string }) => message.uuid),
      ).toEqual(["cb2", "u3", "a3", "cb3", "u4"]);
      expect(json.pagination).toMatchObject({
        hasOlderMessages: true,
        returnedMessageCount: 5,
        totalCompactions: 3,
        totalUserTurns: 4,
        truncatedBeforeMessageId: "cb2",
        truncatedBy: "compact_boundary",
      });
    });

    it("narrows an uncompacted indexed read to a turn tail", async () => {
      // The indexed reader returns the whole uncompacted transcript, so the
      // turn selector alone trims older history; that must not be rejected
      // as a lost provider boundary.
      const name = "sess-uncompacted-turn-tail";
      const sessionDir = join(
        testDir,
        "localhost",
        projectPath.replace(/[/\\:]/g, "-"),
      );
      await mkdir(sessionDir, { recursive: true });
      const entries = ["1", "2", "3"].flatMap((turn, index) => [
        {
          type: "user",
          cwd: projectPath,
          sessionId: name,
          uuid: `u${turn}`,
          ...(index > 0 ? { parentUuid: `a${index}` } : {}),
          timestamp: `2026-01-01T00:00:0${index * 2 + 1}Z`,
          message: { role: "user", content: `u${turn}` },
        },
        {
          type: "assistant",
          cwd: projectPath,
          sessionId: name,
          uuid: `a${turn}`,
          parentUuid: `u${turn}`,
          timestamp: `2026-01-01T00:00:0${index * 2 + 2}Z`,
          message: { role: "assistant", content: `a${turn}` },
        },
      ]);
      await writeFile(
        join(sessionDir, `${name}.jsonl`),
        `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      );
      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });

      const res = await app.request(
        `/api/projects/${projectId}/sessions/${name}?tailTurns=2`,
        { headers: { "X-Yep-Anywhere": "true" } },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(
        json.messages.map((message: { uuid?: string }) => message.uuid),
      ).toEqual(["u2", "a2", "u3", "a3"]);
      expect(json.pagination).toMatchObject({
        hasOlderMessages: true,
        truncatedBeforeMessageId: "u2",
        truncatedBy: "user_turn",
      });
    });

    it("allows full-history scope to be narrowed by user turns", async () => {
      await writeCompactedSession("sess-full-turn-tail");
      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-full-turn-tail?fullHistory=1&fullHistoryReason=test&tailTurns=2`,
        { headers: { "X-Yep-Anywhere": "true" } },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(
        json.messages.map((message: { uuid?: string }) => message.uuid),
      ).toEqual(["u3", "a3", "cb3", "u4"]);
      expect(json.pagination).toMatchObject({
        hasOlderMessages: true,
        returnedMessageCount: 4,
        totalCompactions: 3,
        totalUserTurns: 4,
        truncatedBeforeMessageId: "u3",
        truncatedBy: "user_turn",
      });
    });
  });

  describe("POST /api/sessions/:sessionId/input", () => {
    it("returns 404 if no active process", async () => {
      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });

      const res = await app.request("/api/sessions/unknown/input", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: JSON.stringify({ requestId: "req-1", response: "approve" }),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("No active process for session");
    });

    it("returns 400 if process is not waiting for input", async () => {
      // Create a session that immediately completes (not waiting for input)
      mockSdk.addScenario(createMockScenario("sess-no-wait", "Done!"));
      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });

      // Start the session
      const startRes = await seedActiveSession(
        app,
        projectId,
        "input-owned-session",
      );
      const { sessionId } = startRes;

      // Wait for session to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Try to send input - should fail because process completed
      const inputRes = await app.request(`/api/sessions/${sessionId}/input`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: JSON.stringify({ requestId: "req-1", response: "approve" }),
      });

      // Process likely terminated or not waiting
      expect([400, 404]).toContain(inputRes.status);
    });

    it("returns 400 for missing required fields", async () => {
      // Create a session with tool approval
      mockSdk.addScenario({
        messages: [
          { type: "system", subtype: "init", session_id: "sess-tool" },
          {
            type: "system",
            subtype: "input_request",
            input_request: {
              id: "req-tool-1",
              type: "tool-approval",
              prompt: "Allow Edit?",
            },
          },
        ],
        delayMs: 5,
      });
      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });

      // Start the session
      const startRes = await seedActiveSession(
        app,
        projectId,
        "input-owned-session",
      );
      const { sessionId } = startRes;

      // Wait for session to enter waiting-input state
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Try to send input without requestId
      const inputRes = await app.request(`/api/sessions/${sessionId}/input`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: JSON.stringify({ response: "approve" }),
      });

      expect(inputRes.status).toBe(400);
      const json = await inputRes.json();
      expect(json.error).toBe("requestId and response are required");
    });

    it("returns 400 for invalid requestId", async () => {
      // Create a session with tool approval
      mockSdk.addScenario({
        messages: [
          { type: "system", subtype: "init", session_id: "sess-tool" },
          {
            type: "system",
            subtype: "input_request",
            input_request: {
              id: "req-tool-1",
              type: "tool-approval",
              prompt: "Allow Edit?",
            },
          },
        ],
        delayMs: 5,
      });
      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });

      // Start the session
      const startRes = await seedActiveSession(
        app,
        projectId,
        "input-owned-session",
      );
      const { sessionId } = startRes;

      // Wait for session to enter waiting-input state
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Try to send input with wrong requestId
      const inputRes = await app.request(`/api/sessions/${sessionId}/input`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: JSON.stringify({ requestId: "wrong-id", response: "approve" }),
      });

      expect(inputRes.status).toBe(400);
      const json = await inputRes.json();
      expect(json.error).toBe("Invalid request ID or no pending request");
    });

    it("accepts approve response with correct requestId", async () => {
      const requestId = `req-${Date.now()}`;
      // Create a session with tool approval
      mockSdk.addScenario({
        messages: [
          { type: "system", subtype: "init", session_id: "sess-tool-approve" },
          {
            type: "system",
            subtype: "input_request",
            input_request: {
              id: requestId,
              type: "tool-approval",
              prompt: "Allow Edit?",
            },
          },
        ],
        delayMs: 5,
      });
      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });

      // Start the session
      const startRes = await seedActiveSession(
        app,
        projectId,
        "input-owned-session",
      );
      const { sessionId } = startRes;

      // Wait for session to enter waiting-input state
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify pending input exists
      const pendingRes = await app.request(
        `/api/sessions/${sessionId}/pending-input`,
      );
      expect(pendingRes.status).toBe(200);
      const pendingJson = await pendingRes.json();
      expect(pendingJson.request).toBeDefined();
      expect(pendingJson.request.id).toBe(requestId);

      // Send approve
      const inputRes = await app.request(`/api/sessions/${sessionId}/input`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: JSON.stringify({ requestId, response: "approve" }),
      });

      expect(inputRes.status).toBe(200);
      const json = await inputRes.json();
      expect(json.accepted).toBe(true);
      expect(json.pendingInputRequest).toBeNull();
    });

    it("writes approval audit entries only when enabled", async () => {
      const logPath = join(testDir, "logs", "approval-decisions.jsonl");

      mockSdk.addScenario({
        messages: [
          {
            type: "system",
            subtype: "init",
            session_id: "sess-tool-audit-disabled",
          },
          {
            type: "system",
            subtype: "input_request",
            input_request: {
              id: "req-audit-disabled",
              type: "tool-approval",
              prompt: "Allow Bash?",
            },
          },
        ],
        delayMs: 5,
      });
      const disabledApp = createApp({
        provider: mockSdk,
        projectsDir: testDir,
        dataDir: testDir,
        serverSettingsService: createSettingsServiceForAuditLog(false),
      }).app;

      const disabledStart = await seedActiveSession(
        disabledApp,
        projectId,
        "input-owned-session",
      );
      const disabledSession = disabledStart;
      await new Promise((resolve) => setTimeout(resolve, 50));

      const disabledInput = await disabledApp.request(
        `/api/sessions/${disabledSession.sessionId}/input`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({
            requestId: "req-audit-disabled",
            response: "approve",
          }),
        },
      );
      expect(disabledInput.status).toBe(200);
      expect(await readOptionalText(logPath)).toBe("");

      mockSdk.addScenario({
        messages: [
          {
            type: "system",
            subtype: "init",
            session_id: "sess-tool-audit-enabled",
          },
          {
            type: "system",
            subtype: "input_request",
            input_request: {
              id: "req-audit-enabled",
              type: "tool-approval",
              prompt: "Allow Bash?",
            },
          },
        ],
        delayMs: 5,
      });
      const enabledApp = createApp({
        provider: mockSdk,
        projectsDir: testDir,
        dataDir: testDir,
        serverSettingsService: createSettingsServiceForAuditLog(true),
      }).app;

      const enabledStart = await seedActiveSession(
        enabledApp,
        projectId,
        "input-owned-session",
      );
      const enabledSession = enabledStart;
      await new Promise((resolve) => setTimeout(resolve, 50));

      const enabledInput = await enabledApp.request(
        `/api/sessions/${enabledSession.sessionId}/input`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({
            requestId: "req-audit-enabled",
            response: "approve",
          }),
        },
      );
      expect(enabledInput.status).toBe(200);
      const auditLines = (await readOptionalText(logPath)).trim().split("\n");
      expect(auditLines).toHaveLength(1);
      expect(JSON.parse(auditLines[0] ?? "{}")).toMatchObject({
        requestId: "req-audit-enabled",
        normalizedResponse: "approve",
        accepted: true,
      });
    });

    it("accepts deny response with correct requestId", async () => {
      const requestId = `req-${Date.now()}`;
      // Create a session with tool approval
      mockSdk.addScenario({
        messages: [
          { type: "system", subtype: "init", session_id: "sess-tool-deny" },
          {
            type: "system",
            subtype: "input_request",
            input_request: {
              id: requestId,
              type: "tool-approval",
              prompt: "Allow Edit?",
            },
          },
        ],
        delayMs: 5,
      });
      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });

      // Start the session
      const startRes = await seedActiveSession(
        app,
        projectId,
        "input-owned-session",
      );
      const { sessionId } = startRes;

      // Wait for session to enter waiting-input state
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Send deny
      const inputRes = await app.request(`/api/sessions/${sessionId}/input`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: JSON.stringify({ requestId, response: "deny" }),
      });

      expect(inputRes.status).toBe(200);
      const json = await inputRes.json();
      expect(json.accepted).toBe(true);
    });
  });

  describe("GET /api/projects/:projectId/sessions/:sessionId/agents/:agentId", () => {
    it("returns agent messages for existing agent file", async () => {
      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });

      // Get project path from projectId
      const projectPath = "/home/user/myproject";
      const encodedPath = projectPath.replace(/[/\\:]/g, "-");
      const sessionDir = join(testDir, "localhost", encodedPath);

      // Copy completed agent fixture to session directory
      const fixtureContent = await readFile(
        join(fixturesDir, "agent-completed.jsonl"),
        "utf-8",
      );
      await writeFile(
        join(sessionDir, "agent-test-agent.jsonl"),
        fixtureContent,
      );

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-existing/agents/test-agent`,
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.messages).toBeDefined();
      expect(Array.isArray(json.messages)).toBe(true);
      expect(json.messages.length).toBeGreaterThan(0);
      expect(json.status).toBe("completed");
    });

    it("returns 200 with empty messages for unknown agent", async () => {
      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-existing/agents/unknown-agent`,
      );

      // Graceful handling - don't 404, just return empty
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.messages).toHaveLength(0);
      expect(json.status).toBe("pending");
    });

    it("returns 404 for unknown project", async () => {
      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });

      const res = await app.request(
        "/api/projects/unknown/sessions/sess-1/agents/agent-1",
      );

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("Project not found");
    });

    it("infers status correctly for failed agent", async () => {
      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });

      const projectPath = "/home/user/myproject";
      const encodedPath = projectPath.replace(/[/\\:]/g, "-");
      const sessionDir = join(testDir, "localhost", encodedPath);

      const fixtureContent = await readFile(
        join(fixturesDir, "agent-failed.jsonl"),
        "utf-8",
      );
      await writeFile(
        join(sessionDir, "agent-failed-agent.jsonl"),
        fixtureContent,
      );

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-existing/agents/failed-agent`,
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe("failed");
    });

    it("infers status correctly for running agent", async () => {
      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });

      const projectPath = "/home/user/myproject";
      const encodedPath = projectPath.replace(/[/\\:]/g, "-");
      const sessionDir = join(testDir, "localhost", encodedPath);

      const fixtureContent = await readFile(
        join(fixturesDir, "agent-running.jsonl"),
        "utf-8",
      );
      await writeFile(
        join(sessionDir, "agent-running-agent.jsonl"),
        fixtureContent,
      );

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-existing/agents/running-agent`,
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe("running");
    });
  });

  // Guards the `app.use("/api/*", compress())` wiring in app.ts. Runs on the
  // CI Node-20 floor, so it also catches any CompressionStream regression there.
  describe("GET /api/projects/:projectId/sessions/:sessionId (compression)", () => {
    const projectPath = "/home/user/myproject";

    async function writeBigSession(name: string) {
      const encodedPath = projectPath.replace(/[/\\:]/g, "-");
      const sessionDir = join(testDir, "localhost", encodedPath);
      // Comfortably exceeds the 1KB compress threshold so encoding kicks in.
      const bigText = "the quick brown fox jumps over the lazy dog ".repeat(
        400,
      );
      const line = JSON.stringify({
        type: "user",
        cwd: projectPath,
        sessionId: name,
        uuid: `${name}-u1`,
        timestamp: "2026-01-01T00:00:00Z",
        message: { role: "user", content: bigText },
      });
      await writeFile(join(sessionDir, `${name}.jsonl`), `${line}\n`);
    }

    it("gzip-encodes large responses when the client accepts it", async () => {
      await writeBigSession("sess-big");
      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-big`,
        { headers: { "X-Yep-Anywhere": "true", "Accept-Encoding": "gzip" } },
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("content-encoding")).toBe("gzip");
      // Encoded responses drop Content-Length in favor of chunked streaming.
      expect(res.headers.get("content-length")).toBeNull();

      // Body is gzip on the wire — decode it and confirm a clean round-trip.
      const raw = Buffer.from(await res.arrayBuffer());
      const json = JSON.parse(gunzipSync(raw).toString("utf-8"));
      expect(Array.isArray(json.messages)).toBe(true);
      expect(json.messages.length).toBeGreaterThan(0);
    });

    it("leaves responses uncompressed when Accept-Encoding is absent", async () => {
      await writeBigSession("sess-plain");
      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-plain`,
        { headers: { "X-Yep-Anywhere": "true" } },
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("content-encoding")).toBeNull();
      // Plain body parses directly (no manual decode needed).
      const json = await res.json();
      expect(Array.isArray(json.messages)).toBe(true);
    });
  });
});
