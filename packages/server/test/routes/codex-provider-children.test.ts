import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { createProjectsRoutes } from "../../src/routes/projects.js";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeProjectId } from "../../src/projects/paths.js";
import {
  createSessionsRoutes,
  type SessionsDeps,
} from "../../src/routes/sessions.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Project } from "../../src/supervisor/types.js";
import { nativeSessionRef, parseNativeSessionId } from "@yep-anywhere/shared";
import {
  ProviderChildRelationshipService,
  type ProviderChildObservation,
} from "../../src/sessions/ProviderChildRelationshipService.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";

const PROJECT_PATH = "/test/codex-provider-children";

function line(type: string, payload: unknown, timestamp: string): string {
  return JSON.stringify({ type, timestamp, payload });
}

function sessionMeta(
  id: string,
  timestamp: string,
  extra: Record<string, unknown> = {},
): string {
  return line(
    "session_meta",
    {
      id,
      cwd: PROJECT_PATH,
      timestamp,
      model_provider: "openai",
      ...extra,
    },
    timestamp,
  );
}

async function writeRollout(
  sessionsDir: string,
  id: string,
  lines: string[],
): Promise<void> {
  const dateDir = join(sessionsDir, "2026", "06", "25");
  await mkdir(dateDir, { recursive: true });
  await writeFile(
    join(dateDir, `rollout-${id}.jsonl`),
    `${lines.join("\n")}\n`,
  );
}

function emptyReader(): ISessionReader {
  return {
    getSessionSummary: vi.fn(async () => null),
    getSession: vi.fn(async () => null),
    listSessions: vi.fn(async () => []),
    getAgentMappings: vi.fn(async () => []),
    getAgentSession: vi.fn(async () => null),
  } as unknown as ISessionReader;
}

describe("Codex provider child route contract", () => {
  let sessionsDir: string;
  let isolatedProviderDir: string;

  beforeEach(async () => {
    sessionsDir = join(tmpdir(), `codex-child-routes-${randomUUID()}`);
    isolatedProviderDir = join(tmpdir(), `codex-child-other-${randomUUID()}`);
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(isolatedProviderDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(sessionsDir, { recursive: true, force: true });
    await rm(isolatedProviderDir, { recursive: true, force: true });
  });

  it("feeds metadata and the nested agent page from a child rollout", async () => {
    const now = "2026-06-25T12:00:00.000Z";
    const parentId = "route-parent-thread";
    const childId = "route-child-thread";
    const callId = "call-route-spawn";

    await writeRollout(sessionsDir, parentId, [
      sessionMeta(parentId, now),
      line(
        "response_item",
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Use a subagent" }],
        },
        now,
      ),
      line(
        "response_item",
        {
          type: "function_call",
          name: "spawn_agent",
          call_id: callId,
          arguments: JSON.stringify({
            role: "reviewer",
            prompt: "Inspect the nested page",
          }),
        },
        now,
      ),
      line(
        "response_item",
        {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify({
            agent_id: childId,
            nickname: "Nested page",
          }),
        },
        now,
      ),
    ]);
    await writeRollout(sessionsDir, childId, [
      sessionMeta(childId, now, {
        parent_thread_id: parentId,
        source: {
          subagent: { thread_spawn: { parent_thread_id: parentId } },
        },
      }),
      line(
        "response_item",
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Child rollout" }],
        },
        now,
      ),
      line(
        "event_msg",
        {
          type: "task_complete",
          turn_id: "turn-child",
          last_agent_message: "Child rollout",
        },
        now,
      ),
    ]);

    const projectId = encodeProjectId(PROJECT_PATH);
    const project: Project = {
      id: projectId,
      path: PROJECT_PATH,
      name: "codex-children",
      sessionCount: 1,
      sessionDir: sessionsDir,
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
      provider: "codex",
    };
    const reader = new CodexSessionReader({
      sessionsDir,
      projectPath: PROJECT_PATH,
    });
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => null),
        wasEverOwned: vi.fn(() => false),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getProject: vi.fn(async () => project),
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: (selected) =>
        selected.provider === "codex" ? reader : emptyReader(),
      codexSessionsDir: sessionsDir,
      codexReaderFactory: () => reader,
      grokSessionsDir: isolatedProviderDir,
      piSessionsDir: isolatedProviderDir,
    });

    const metadataResponse = await routes.request(
      `/projects/${projectId}/sessions/${parentId}/metadata`,
    );
    expect(metadataResponse.status).toBe(200);
    await expect(metadataResponse.json()).resolves.toMatchObject({
      session: {
        id: parentId,
        provider: "codex",
        providerChildren: [
          expect.objectContaining({
            id: childId,
            parentSessionId: parentId,
          }),
        ],
      },
    });

    const agentResponse = await routes.request(
      `/projects/${projectId}/sessions/${parentId}/agents/${childId}`,
    );
    expect(agentResponse.status).toBe(200);
    await expect(agentResponse.json()).resolves.toMatchObject({
      status: "completed",
      messages: [
        expect.objectContaining({
          type: "assistant",
          isSubagent: true,
        }),
        expect.objectContaining({
          type: "system",
          subtype: "turn_complete",
          codexTurnId: "turn-child",
          isSubagent: true,
        }),
      ],
    });
  });

  it("delivers detail, history and metadata while discovery is held, then serves durable child facts after reopen", async () => {
    const now = "2026-11-04T12:00:00.000Z";
    const parentId = "nonblocking-parent",
      childId = "durable-child";
    await writeRollout(sessionsDir, parentId, [
      sessionMeta(parentId, now),
      line(
        "response_item",
        {
          type: "message",
          id: "first",
          role: "user",
          content: [{ type: "input_text", text: "Parent transcript" }],
        },
        now,
      ),
      line(
        "response_item",
        {
          type: "message",
          id: "last",
          role: "assistant",
          content: [{ type: "output_text", text: "Parent reply" }],
        },
        now,
      ),
    ]);
    const projectId = encodeProjectId(PROJECT_PATH);
    const project: Project = {
      id: projectId,
      path: PROJECT_PATH,
      name: "nonblocking",
      sessionCount: 1,
      sessionDir: sessionsDir,
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
      provider: "codex",
    };
    const reader = new CodexSessionReader({
      sessionsDir,
      projectPath: PROJECT_PATH,
    });
    let release!: (value: ProviderChildObservation) => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = new Promise<ProviderChildObservation>((resolve) => {
      release = resolve;
    });
    const source = {
      observe: vi.fn(async () => {
        started();
        return held;
      }),
      isCurrent: async () => true,
    };
    vi.spyOn(reader, "getProviderChildSource").mockReturnValue(source);
    const legacyDiscovery = vi.spyOn(reader, "listProviderChildSessions");
    const dbDir = join(isolatedProviderDir, "profile");
    let database = new DiscoverySqliteService({
      dataDir: dbDir,
      probeNetworkFilesystem: () => undefined,
    });
    const owners: string[] = [];
    let committed!: () => void;
    const committedPromise = new Promise<void>((resolve) => {
      committed = resolve;
    });
    let service = new ProviderChildRelationshipService(
      database.getDatabase(),
      "local",
      (owner) => {
        owners.push(owner.sessionId);
        committed();
      },
    );
    let metadata = new SessionMetadataService({
      dataDir: dbDir,
      database: database.getDatabase(),
    });
    const routes = () =>
      createSessionsRoutes({
        supervisor: {
          getProcessForSession: vi.fn(() => null),
          wasEverOwned: vi.fn(() => false),
        } as unknown as SessionsDeps["supervisor"],
        scanner: {
          getProject: vi.fn(async () => project),
          getOrCreateProject: vi.fn(async () => project),
        } as unknown as SessionsDeps["scanner"],
        readerFactory: (selected) =>
          selected.provider === "codex" ? reader : emptyReader(),
        codexSessionsDir: sessionsDir,
        codexReaderFactory: () => reader,
        grokSessionsDir: isolatedProviderDir,
        piSessionsDir: isolatedProviderDir,
        providerChildRelationships: service,
        sessionMetadataService: metadata,
      });
    try {
      const list = createProjectsRoutes({
        scanner: {
          getOrCreateProject: async () => project,
        } as unknown as SessionsDeps["scanner"],
        readerFactory: (selected) =>
          selected.provider === "codex" ? reader : emptyReader(),
        codexSessionsDir: sessionsDir,
        codexReaderFactory: () => reader,
        grokSessionsDir: isolatedProviderDir,
        piSessionsDir: isolatedProviderDir,
        providerChildRelationships: service,
        sessionMetadataService: metadata,
      });
      const unpublished = await list.request(`/${projectId}/sessions`);
      expect(unpublished.status).toBe(200);
      expect(
        (await unpublished.json()).sessions[0].providerChildren,
      ).toBeUndefined();
      // List-only navigation must itself initiate finite background acquisition.
      await startedPromise;
      const app = routes();
      const url = `/projects/${projectId}/sessions/${parentId}`;
      // Completion before release, rather than a timing threshold, proves the
      // transcript/pagination/metadata routes do not await native discovery.
      for (const suffix of [
        "?tailCompactions=2",
        "?afterMessageId=first",
        "?beforeMessageId=last",
        "/metadata",
      ]) {
        const response = await app.request(url + suffix);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.session.providerChildren).toBeUndefined();
        if (suffix.startsWith("?tail"))
          expect(JSON.stringify(body.messages)).toContain("Parent reply");
      }
      await startedPromise;
      const scope = await realpath(sessionsDir);
      release({
        version: "owned-v1",
        state: "complete",
        children: [
          {
            native: nativeSessionRef(
              "codex",
              scope,
              parseNativeSessionId(childId),
            ),
            summary: {
              id: childId,
              parentSessionId: parentId,
              title: "Durable child",
              updatedAt: now,
            },
          },
        ],
      });
      await committedPromise;
      expect(owners).toContain(parentId);
      const published = await list.request(`/${projectId}/sessions`);
      expect(
        (await published.json()).sessions[0].providerChildren,
      ).toMatchObject([{ id: childId }]);
      await service.close();
      database.close();
      database = new DiscoverySqliteService({
        dataDir: dbDir,
        probeNetworkFilesystem: () => undefined,
      });
      metadata = new SessionMetadataService({
        dataDir: dbDir,
        database: database.getDatabase(),
      });
      service = new ProviderChildRelationshipService(
        database.getDatabase(),
        "local",
        () => {},
      );
      const reopened = await routes().request(`${url}/metadata`);
      expect(await reopened.json()).toMatchObject({
        session: {
          providerChildren: [{ id: childId, parentSessionId: parentId }],
        },
      });
      expect(legacyDiscovery).not.toHaveBeenCalled();
    } finally {
      await service.close();
      database.close();
      await reader.close();
    }
  });
});
