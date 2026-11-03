import { randomUUID } from "node:crypto";
import { Supervisor } from "../../src/supervisor/Supervisor.js";
import { MockServerClaudeProvider } from "../../src/sdk/mock.js";
import { MessageQueue } from "../../src/sdk/messageQueue.js";
import { encodeProjectId } from "../../src/supervisor/types.js";
import {
  createControllableIterator,
  waitFor,
} from "../process.test-support.js";
import {
  createTestSessionMetadataService,
  closeTestDiscoveryDatabases,
} from "../utils/session-metadata-database.js";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserUsageService } from "../../src/auth/UserUsageService.js";
import {
  type SessionsDeps,
  createSessionsRoutes,
} from "../../src/routes/sessions.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Project } from "../../src/supervisor/types.js";

/**
 * Every route that starts a session or accepts a user turn writes its usage
 * record. Contract: topics/limited-users.md § Usage.
 */

const projectId = "tmp-usage-project" as UrlProjectId;

function createProject(): Project {
  return {
    id: projectId,
    path: "/tmp/usage-project",
    name: "usage-project",
    sessionCount: 1,
    sessionDir: "/tmp/usage-project/.sessions",
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
  };
}

describe("Usage records on the session routes", () => {
  let dir: string;
  const owners: Supervisor[] = [];
  let userUsageService: UserUsageService;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ya-usage-routes-"));
    userUsageService = new UserUsageService({ dataDir: dir });
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    for (const supervisor of owners.splice(0)) {
      await supervisor.stopBackgroundTasks();
      for (const process of supervisor.getAllProcesses()) await process.abort();
    }
    closeTestDiscoveryDatabases();
    consoleLogSpy.mockRestore();
    await fs.rm(dir, { recursive: true, force: true });
  });

  function createRoutes(supervisor: Record<string, unknown>) {
    const project = createProject();
    return createSessionsRoutes({
      supervisor: supervisor as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getMetadata: vi.fn(() => undefined),
        getProvider: vi.fn(() => "claude"),
        getRequestedModel: vi.fn(() => undefined),
        getExecutor: vi.fn(() => undefined),
        forkLineageRoot: vi.fn(() => "sess-1"),
        nextForkOrdinal: vi.fn(async () => ({
          ordinal: 1,
          lineageRootId: "sess-1",
        })),
        setProvider: vi.fn(async () => undefined),
        setExecutor: vi.fn(async () => undefined),
        setInitialPrompt: vi.fn(async () => undefined),
        setRequestedModel: vi.fn(async () => undefined),
        setSessionSandbox: vi.fn(async () => undefined),
        updateMetadata: vi.fn(async () => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
      userUsageService,
    });
  }

  const post = (
    routes: ReturnType<typeof createRoutes>,
    url: string,
    body: unknown,
  ) =>
    routes.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  async function superuserTotals() {
    const report = await userUsageService.report();
    return report.users.find((user) => user.username === null)?.total;
  }

  async function admittedRoutes() {
    const metadata = createTestSessionMetadataService(dir);
    await metadata.initialize();
    const cwd = await fs.realpath(dir);
    const project = { ...createProject(), path: cwd, id: encodeProjectId(cwd) };
    const provider = new MockServerClaudeProvider();
    vi.spyOn(provider, "startSession").mockImplementation(async (options) => {
      const control = createControllableIterator();
      control.push({
        type: "system",
        subtype: "init",
        session_id: options.newSessionId!,
      });
      return {
        iterator: control.iterator,
        queue: new MessageQueue(),
        abort: control.finish,
      };
    });
    const supervisor = new Supervisor({
      provider,
      sessionMetadataService: metadata,
      maxWorkers: 1,
    });
    owners.push(supervisor);
    return {
      supervisor,
      project,
      metadata,
      routes: createSessionsRoutes({
        supervisor,
        sessionMetadataService: metadata,
        userUsageService,
        scanner: {
          getOrCreateProject: async () => project,
        } as unknown as SessionsDeps["scanner"],
        readerFactory: () => ({}) as ISessionReader,
      }),
    };
  }

  it("counts accepted detached intent and its first turn", async () => {
    const f = await admittedRoutes();
    const response = await post(f.routes, "/session-creations", {
      requestId: randomUUID(),
      message: "two words",
    });
    expect(response.status).toBe(202);
    expect(await superuserTotals()).toMatchObject({
      sessions: 1,
      turns: 1,
      words: 2,
    });
    await waitFor(() => expect(f.supervisor.getAllProcesses()).toHaveLength(1));
  });

  it("counts empty preparation without a phantom usage turn", async () => {
    const f = await admittedRoutes();
    const response = await post(f.routes, "/session-creations", {
      requestId: randomUUID(),
      message: "",
      intent: "prepare",
    });
    expect(response.status).toBe(202);
    expect(await superuserTotals()).toMatchObject({ sessions: 1, turns: 0 });
    await waitFor(() => expect(f.supervisor.getAllProcesses()).toHaveLength(1));
  });

  it("counts saved queued input but no pre-admission refusal", async () => {
    const f = await admittedRoutes();
    const url = `/projects/${f.project.id}/session-creations`;
    expect(
      (
        await post(f.routes, url, {
          requestId: randomUUID(),
          message: "occupy worker",
        })
      ).status,
    ).toBe(202);
    await waitFor(() => expect(f.supervisor.getAllProcesses()).toHaveLength(1));
    const requestId = randomUUID();
    expect(
      (await post(f.routes, url, { requestId, message: "wait your turn" }))
        .status,
    ).toBe(202);
    await waitFor(() =>
      expect(
        f.metadata.creations.get({ kind: "superuser" }, requestId)?.attempt
          .state,
      ).toBe("queued"),
    );
    expect(
      (await post(f.routes, url, { requestId: randomUUID(), message: "" }))
        .status,
    ).toBe(400);
    expect(await superuserTotals()).toMatchObject({
      sessions: 2,
      turns: 2,
      words: 5,
    });
  });

  it("counts a fork as a session and nothing else", async () => {
    const routes = createRoutes({
      getProcessForSession: vi.fn(() => undefined),
      supportsForkSession: vi.fn(() => true),
      forkSession: vi.fn(async () => ({ sessionId: "sess-fork" })),
    });

    const response = await post(
      routes,
      `/projects/${projectId}/sessions/sess-1/fork`,
      { upToMessageId: "msg-1" },
    );

    expect(response.status).toBe(200);
    expect(await superuserTotals()).toMatchObject({ sessions: 1, turns: 0 });
  });
});
