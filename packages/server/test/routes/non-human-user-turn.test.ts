import { openTestDiscoveryDatabase } from "../utils/session-metadata-database.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { NotificationService } from "../../src/notifications/NotificationService.js";
import { MockServerClaudeProvider } from "../../src/sdk/mock.js";
import { Supervisor } from "../../src/supervisor/Supervisor.js";
import { encodeProjectId, type Project } from "../../src/supervisor/types.js";
import { EventBus } from "../../src/watcher/EventBus.js";
import {
  createSessionsRoutes,
  type SessionsDeps,
} from "../../src/routes/sessions.js";
import { createInboxRoutes } from "../../src/routes/inbox.js";
import {
  closeTestDiscoveryDatabases,
  createTestSessionMetadataService,
} from "../utils/session-metadata-database.js";

it("delivers explicit cross-session input without Inbox escalation and acknowledges only the visited turn", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "delivered-turn-route-"));
  const metadata = createTestSessionMetadataService(dataDir);
  await metadata.initialize();
  const eventBus = new EventBus();
  const notifications = new NotificationService({
    dataDir,
    eventBus,
    database: openTestDiscoveryDatabase(dataDir),
  });
  await notifications.initialize();
  const supervisor = new Supervisor({
    provider: new MockServerClaudeProvider(),
    sessionMetadataService: metadata,
    eventBus,
    idleTimeoutMs: 60_000,
  });
  const project: Project = {
    id: encodeProjectId(dataDir),
    path: dataDir,
    name: "Receiver project",
    sessionDir: dataDir,
    sessionCount: 1,
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
  };
  const scanner = {
    listProjects: async () => [project],
  } as unknown as SessionsDeps["scanner"];
  const readerFactory: SessionsDeps["readerFactory"] = () =>
    ({
      listSessions: async () => [
        {
          id: "receiver",
          projectId: project.id,
          title: "Receiver",
          fullTitle: "Receiver",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          messageCount: 1,
          provider: "claude",
          ownership: { owner: "none" },
        },
      ],
      getAgentMappings: async () => [],
    }) as unknown as ReturnType<SessionsDeps["readerFactory"]>;
  const deps = {
    scanner,
    readerFactory,
    supervisor,
    sessionMetadataService: metadata,
    notificationService: notifications,
    eventBus,
  };
  const routes = createSessionsRoutes(deps);
  // An old, inactive session keeps its receipt without being promoted to Inbox.
  const inbox = createInboxRoutes({ ...deps, supervisor: undefined });
  let process: Awaited<ReturnType<Supervisor["startSession"]>> | undefined;
  const post = (path: string, body: unknown) =>
    routes.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const resumed = await supervisor.resumeSession("receiver", dataDir, {
      text: "Human start",
    });
    if (!("id" in resumed)) throw new Error("Expected an active process");
    process = resumed;
    await vi.waitFor(() => expect(process?.state.type).toBe("idle"));
    expect(metadata.getPendingNonHumanUserTurn("receiver")).toBeUndefined();
    expect(
      (
        await post("/sessions/receiver/messages", {
          message: "bad",
          messageMetadata: { sourceSessionId: 123 },
        })
      ).status,
    ).toBe(400);
    expect(
      (await post("/sessions/receiver/messages", { message: "Human input" }))
        .status,
    ).toBe(200);
    await vi.waitFor(() => expect(process?.state.type).toBe("idle"));
    expect(metadata.getPendingNonHumanUserTurn("receiver")).toBeUndefined();
    expect(
      (
        await post("/sessions/receiver/messages", {
          message: "Self input",
          messageMetadata: { sourceSessionId: "receiver" },
        })
      ).status,
    ).toBe(200);
    await vi.waitFor(() => expect(process?.state.type).toBe("idle"));
    expect(metadata.getPendingNonHumanUserTurn("receiver")).toBeUndefined();
    expect(
      (
        await post("/sessions/receiver/messages", {
          message: "Delivered from sender",
          messageMetadata: { sourceSessionId: "sender" },
        })
      ).status,
    ).toBe(200);
    await vi.waitFor(() =>
      expect(
        metadata.getPendingNonHumanUserTurn("receiver")?.sourceSessionId,
      ).toBe("sender"),
    );
    const turn = metadata.getPendingNonHumanUserTurn("receiver")!;
    expect(
      process
        .getMessageHistory()
        .some((message) => message.uuid === turn.messageId),
    ).toBe(true);
    const deliveredInbox = await (await inbox.request("/")).json();
    for (const tier of [
      "needsAttention",
      "active",
      "recentActivity",
      "unread8h",
      "unread24h",
    ])
      expect(deliveredInbox[tier]).toEqual([]);
    const plainSeen = await post("/sessions/receiver/mark-seen", {});
    expect(await plainSeen.json()).toEqual({ marked: true });
    expect(metadata.getPendingNonHumanUserTurn("receiver")).toEqual(turn);
    const staleSeen = await post("/sessions/receiver/mark-seen", {
      nonHumanUserTurnMessageId: "older-turn",
    });
    // A stale id leaves the receipt pending, and the client is told so.
    expect(await staleSeen.json()).toEqual({
      marked: true,
      acknowledged: false,
    });
    expect(metadata.getPendingNonHumanUserTurn("receiver")).toEqual(turn);
    const visitedSeen = await post("/sessions/receiver/mark-seen", {
      nonHumanUserTurnMessageId: turn.messageId,
    });
    expect(visitedSeen.status).toBe(200);
    expect(await visitedSeen.json()).toEqual({
      marked: true,
      acknowledged: true,
    });
    expect((await (await inbox.request("/")).json()).needsAttention).toEqual(
      [],
    );
    const restored = createTestSessionMetadataService(dataDir);
    await restored.initialize();
    expect(restored.getPendingNonHumanUserTurn("receiver")).toBeUndefined();
  } finally {
    await process?.abort();
    closeTestDiscoveryDatabases();
    await rm(dataDir, { recursive: true });
  }
});
