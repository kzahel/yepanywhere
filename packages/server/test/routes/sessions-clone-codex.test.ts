import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type SessionsDeps,
  createSessionsRoutes,
} from "../../src/routes/sessions.js";
import { Supervisor } from "../../src/supervisor/Supervisor.js";
import type { AgentProvider } from "../../src/sdk/providers/types.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Project } from "../../src/supervisor/types.js";

describe("Codex clone route", () => {
  let testDir: string;
  let projectId: UrlProjectId;
  let projectPath: string;
  let project: Project;
  let reader: CodexSessionReader;

  const forkSession = vi.fn(async () => {
    const sessionId = randomUUID();
    const filePath = join(
      testDir,
      "2026",
      "03",
      "08",
      `rollout-2026-03-08T12-00-02-${sessionId}.jsonl`,
    );
    await writeFile(
      filePath,
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          id: sessionId,
          cwd: projectPath,
          timestamp: "2026-03-08T12:00:02.000Z",
          forked_from_id: "source-session",
        },
      })}\n${JSON.stringify({
        type: "event_msg",
        timestamp: "2026-03-08T12:00:01.000Z",
        payload: { type: "user_message", message: "Prime the cache" },
      })}\n`,
    );
    return { nativeSessionId: sessionId, filePath };
  });

  beforeEach(async () => {
    forkSession.mockClear();
    testDir = join(tmpdir(), `codex-clone-route-${randomUUID()}`);
    const sessionDir = join(testDir, "2026", "03", "08");
    await mkdir(sessionDir, { recursive: true });

    projectPath = "/tmp/demo-project";
    projectId = "tmp-demo-project" as UrlProjectId;
    project = {
      id: projectId,
      path: projectPath,
      name: "demo-project",
      sessionCount: 1,
      sessionDir: testDir,
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
      provider: "codex",
    };

    await writeFile(
      join(sessionDir, "rollout-source-session.jsonl"),
      `${[
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-03-08T12:00:00.000Z",
          payload: {
            id: "source-session",
            cwd: projectPath,
            timestamp: "2026-03-08T12:00:00.000Z",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-03-08T12:00:01.000Z",
          payload: {
            type: "user_message",
            message: "Prime the cache",
          },
        }),
      ].join("\n")}\n`,
      "utf-8",
    );

    reader = new CodexSessionReader({
      sessionsDir: testDir,
      projectPath,
    });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("uses a native fork without reading or copying the source transcript", async () => {
    const forkSession = vi.fn(async () => ({ sessionId: "native-fork" }));
    const getSessionFilePath = vi.spyOn(reader, "getSessionFilePath");
    const getSession = vi.spyOn(reader, "getSession");
    const routes = createSessionsRoutes({
      supervisor: {
        forkSession,
        assertRouterBindingInheritable: () => {},
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as SessionsDeps["scanner"],
      readerFactory: vi.fn(() => reader),
      codexReaderFactory: vi.fn(() => reader),
    });

    const response = await routes.request(
      `/projects/${projectId}/sessions/source-session/clone`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Quick answer: why?",
          provider: "codex",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sessionId: "native-fork",
      messageCount: Number.MAX_SAFE_INTEGER,
    });
    expect(forkSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "source-session",
        projectPath,
        providerName: "codex",
        title: "Quick answer: why?",
      }),
    );
    expect(getSessionFilePath).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });

  it("reports native fork failure without creating a storage clone", async () => {
    const forkSession = vi.fn(async () => {
      throw new Error("Native fork unavailable");
    });
    const getSessionFilePath = vi.spyOn(reader, "getSessionFilePath");
    const routes = createSessionsRoutes({
      supervisor: {
        forkSession,
        assertRouterBindingInheritable: () => {},
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as SessionsDeps["scanner"],
      readerFactory: vi.fn(() => reader),
      codexReaderFactory: vi.fn(() => reader),
    });

    const response = await routes.request(
      `/projects/${projectId}/sessions/source-session/clone`,
      { method: "POST" },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Native fork unavailable" });
    expect(getSessionFilePath).not.toHaveBeenCalled();
  });

  it("keeps a native aside inside the source sandbox on fork and resume", async () => {
    const forkSession = vi.fn(async () => ({
      sessionId: "sandbox-fork",
      sandboxStateKey: "child-state",
    }));
    const setSessionSandbox = vi.fn();
    const routes = createSessionsRoutes({
      supervisor: {
        forkSession,
        assertRouterBindingInheritable: () => {},
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as SessionsDeps["scanner"],
      readerFactory: vi.fn(() => reader),
      codexReaderFactory: vi.fn(() => reader),
      sessionMetadataService: {
        getMetadata: () => ({
          sandboxLevel: "project-write",
          sandboxNetworkFirewall: false,
          sandboxProjectPath: projectPath,
          sandboxStateKey: "source-state",
        }),
        setSessionSandbox,
        updateMetadata: vi.fn(),
      } as unknown as SessionsDeps["sessionMetadataService"],
    });
    const response = await routes.request(
      `/projects/${projectId}/sessions/source-session/clone`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect(forkSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxLevel: "project-write",
        sandboxNetworkFirewall: false,
        sandboxStateKey: "source-state",
      }),
    );
    expect(setSessionSandbox).toHaveBeenCalledWith("sandbox-fork", {
      level: "project-write",
      networkFirewall: false,
      stateKey: "child-state",
      projectPath,
      projectId,
    });
  });

  it("registers the native fork so it opens without invalidating discovery", async () => {
    const sourceSummary = await reader.getSessionSummary(
      "source-session",
      projectId,
    );
    expect(sourceSummary).not.toBeNull();

    const codexScanner = {
      invalidateCache: vi.fn(),
    };
    const updateMetadata = vi.fn(async () => {});

    const routes = createSessionsRoutes({
      supervisor: new Supervisor({
        provider: { name: "codex", forkSession } as unknown as AgentProvider,
      }),
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as SessionsDeps["scanner"],
      readerFactory: vi.fn(() => reader),
      codexReaderFactory: vi.fn(() => reader),
      codexScanner: codexScanner as SessionsDeps["codexScanner"],
      sessionMetadataService: {
        getMetadata: vi.fn(() => undefined),
        updateMetadata,
      } as unknown as SessionsDeps["sessionMetadataService"],
    });

    const response = await routes.request(
      `/projects/${projectId}/sessions/source-session/clone`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { sessionId: string };
    expect(body.sessionId).toBeTruthy();

    const clonedSummary = await reader.getSessionSummary(
      body.sessionId,
      projectId,
    );
    expect(clonedSummary).not.toBeNull();
    expect(clonedSummary?.id).toBe(body.sessionId);
    expect(codexScanner.invalidateCache).not.toHaveBeenCalled();
    // The copy carries its title to creation admission, which records it
    // with the source; the route writes neither again.
    expect(forkSession).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Prime the cache [cloned]" }),
    );
    expect(updateMetadata).not.toHaveBeenCalled();
  });

  it("stores parent metadata for /btw clones", async () => {
    const updateMetadata = vi.fn(async () => {});

    const routes = createSessionsRoutes({
      supervisor: new Supervisor({
        provider: { name: "codex", forkSession } as unknown as AgentProvider,
      }),
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as SessionsDeps["scanner"],
      readerFactory: vi.fn(() => reader),
      codexReaderFactory: vi.fn(() => reader),
      sessionMetadataService: {
        getMetadata: vi.fn(() => undefined),
        updateMetadata,
      } as unknown as SessionsDeps["sessionMetadataService"],
    });

    const response = await routes.request(
      `/projects/${projectId}/sessions/source-session/clone`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: "/btw inspect this side path",
          parentSessionId: "  parent-session  ",
        }),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { sessionId: string };
    // A link to a parent other than the source is the route's alone; the
    // title and source travel to creation admission with the copy.
    expect(updateMetadata).toHaveBeenCalledWith(body.sessionId, {
      parentSessionId: "parent-session",
      parentSessionKind: "btw-aside",
    });
  });

  it("clones Codex sessions for mixed-provider projects when the request specifies codex", async () => {
    const claudeProject: Project = {
      ...project,
      provider: "claude",
      sessionDir: join(testDir, "claude-project"),
    };
    const claudeReader = {
      getSessionSummary: vi.fn(async () => null),
    } as unknown as ISessionReader;

    const routes = createSessionsRoutes({
      supervisor: new Supervisor({
        provider: { name: "codex", forkSession } as unknown as AgentProvider,
      }),
      scanner: {
        getOrCreateProject: vi.fn(async () => claudeProject),
      } as SessionsDeps["scanner"],
      readerFactory: vi.fn(() => claudeReader),
      codexReaderFactory: vi.fn(() => reader),
    });

    const response = await routes.request(
      `/projects/${projectId}/sessions/source-session/clone`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ provider: "codex" }),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      sessionId: string;
      provider: string;
    };
    expect(body.provider).toBe("codex");

    const clonedSummary = await reader.getSessionSummary(
      body.sessionId,
      projectId,
    );
    expect(clonedSummary?.id).toBe(body.sessionId);
    expect(claudeReader.getSessionSummary).not.toHaveBeenCalled();
  });
});
