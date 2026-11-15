import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRewindRecord } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { encodeProjectId } from "../../src/projects/paths.js";
import {
  createSessionsRoutes,
  type SessionsDeps,
} from "../../src/routes/sessions.js";
import type { AgentProvider } from "../../src/sdk/providers/types.js";
import type {
  ClearloopRunner,
  ClearloopService,
} from "../../src/services/ClearloopService.js";
import type { ProjectQueueScheduler } from "../../src/services/ProjectQueueScheduler.js";
import { ClaudeSessionReader } from "../../src/sessions/reader.js";
import type { Process } from "../../src/supervisor/Process.js";
import { Supervisor } from "../../src/supervisor/Supervisor.js";
import type { Project } from "../../src/supervisor/types.js";
import {
  closeTestDiscoveryDatabases,
  createTestSessionMetadataService,
} from "../utils/session-metadata-database.js";

type YaCommandRunner = Parameters<
  NonNullable<ProjectQueueScheduler["setYaCommandRunner"]>
>[0];

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  closeTestDiscoveryDatabases();
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

type FixtureEntry = (
  type: "user" | "assistant",
  uuid: string,
  parentUuid: string | null,
  text: string,
  extra?: Record<string, unknown>,
) => Record<string, unknown>;

/**
 * A Claude session behind the real routes, reader and metadata: two turns by
 * default, or the transcript `lines` builds.
 */
async function createRewindFixture(
  lines: (entry: FixtureEntry) => Record<string, unknown>[] = (entry) => [
    entry("user", "u1", null, "first"),
    entry("assistant", "a1", "u1", "one"),
    entry("user", "u2", "a1", "second"),
    entry("assistant", "a2", "u2", "two"),
  ],
) {
  const dir = await mkdtemp(join(tmpdir(), "rewind-orchestration-"));
  directories.push(dir);
  const sessionsDir = join(dir, "sessions");
  const projectPath = join(dir, "project");
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(projectPath);
  const sessionId = randomUUID();
  const project: Project = {
    id: encodeProjectId(projectPath),
    path: projectPath,
    name: "project",
    provider: "claude",
    sessionDir: sessionsDir,
    sessionCount: 1,
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
  };
  const entry: FixtureEntry = (type, uuid, parentUuid, text, extra = {}) => ({
    type,
    uuid,
    parentUuid,
    sessionId,
    cwd: projectPath,
    timestamp: "2026-09-26T08:00:00.000Z",
    ...extra,
    message:
      type === "user"
        ? { role: "user", content: text }
        : {
            id: `msg-${uuid}`,
            role: "assistant",
            model: "claude-opus-5-5",
            content: [{ type: "text", text }],
            stop_reason: "end_turn",
          },
  });
  await writeFile(
    join(sessionsDir, `${sessionId}.jsonl`),
    `${lines(entry)
      .map((line) => JSON.stringify(line))
      .join("\n")}\n`,
  );

  const metadata = createTestSessionMetadataService(dir);
  await metadata.initialize();
  await metadata.setProvider(sessionId, "claude");

  const supervisor = new Supervisor({
    provider: { name: "claude" } as unknown as AgentProvider,
  });
  const resume = vi.spyOn(supervisor, "resumeSession").mockResolvedValue({
    id: "process-1",
    permissionMode: "default",
    modeVersion: 0,
  } as unknown as Process);
  const getSession = vi.spyOn(ClaudeSessionReader.prototype, "getSession");

  let clearloopRunner: ClearloopRunner | undefined;
  const clearloopStart = vi.fn(async () => ({ id: "loop-1" }));
  const clearloopService = {
    setRunner: (runner: ClearloopRunner) => {
      clearloopRunner = runner;
    },
    isRunning: () => false,
    getBadge: () => undefined,
    start: clearloopStart,
  } as unknown as ClearloopService;
  let yaCommandRunner: YaCommandRunner | undefined;
  const projectQueueScheduler = {
    setYaCommandRunner: (runner: YaCommandRunner) => {
      yaCommandRunner = runner;
    },
  } as unknown as ProjectQueueScheduler;

  const routes = createSessionsRoutes({
    supervisor,
    scanner: {
      getOrCreateProject: async () => project,
    } as unknown as SessionsDeps["scanner"],
    readerFactory: () => new ClaudeSessionReader({ sessionDir: sessionsDir }),
    sessionMetadataService: metadata,
    clearloopService,
    projectQueueScheduler,
  });
  if (!clearloopRunner || !yaCommandRunner) {
    throw new Error("routes did not install their runners");
  }
  return {
    routes,
    project,
    sessionId,
    metadata,
    resume,
    getSession,
    clearloopStart,
    clearloopRunner,
    yaCommandRunner,
  };
}

/**
 * Turns 1–5, then `/clear 3` dropped 4–5 (its rewind already applied), then
 * turn 6 continued from turn 3. The reader shows 4–5 as a cleared span
 * between turn 3 and turn 6.
 */
async function createClearedTurnFixture() {
  const later = { timestamp: "2026-09-26T09:00:00.000Z" };
  const fixture = await createRewindFixture((entry) => [
    entry("user", "u1", null, "first"),
    entry("assistant", "a1", "u1", "one"),
    entry("user", "u2", "a1", "second"),
    entry("assistant", "a2", "u2", "two"),
    entry("user", "u3", "a2", "third"),
    entry("assistant", "a3", "u3", "three"),
    entry("user", "u4", "a3", "fourth"),
    entry("assistant", "a4", "u4", "four"),
    entry("user", "u5", "a4", "fifth"),
    entry("assistant", "a5", "u5", "five"),
    entry("user", "u6", "a3", "sixth", later),
    entry("assistant", "a6", "u6", "six", later),
  ]);
  await fixture.metadata.addRewindRecord(
    fixture.sessionId,
    {
      id: "clear-3",
      at: "2026-09-26T08:30:00.000Z",
      cutMessageId: "a3",
      cutTurnIndex: 3,
      droppedFromMessageId: "u4",
      droppedTurnCount: 2,
      reason: "clear",
    },
    { recordId: "clear-3", cutMessageId: "a3" },
  );
  await fixture.metadata.clearPendingRewind(fixture.sessionId);
  return fixture;
}

describe("rewind orchestration", () => {
  it("a queued /clear N resolves through one transcript read and bounds the drop after stopping", async () => {
    const fixture = await createRewindFixture();
    fixture.getSession.mockClear();

    await fixture.yaCommandRunner.run({
      sessionId: fixture.sessionId,
      projectId: fixture.project.id,
      projectPath: fixture.project.path,
      command: { name: "clear", argument: "1" },
      commandText: "/clear 1",
    } as Parameters<YaCommandRunner["run"]>[0]);

    const [record] = fixture.metadata.getRewindRecords(fixture.sessionId);
    expect(record).toMatchObject({
      cutMessageId: "a1",
      droppedThroughMessageId: "a2",
      droppedTurnCount: 1,
      reason: "clear",
    });
    // One read resolves the cut. The last row the rewind drops, found after
    // the process stops, comes from a tail read, not a second session read.
    expect(fixture.getSession).toHaveBeenCalledTimes(1);
  });

  it("an interactive rewind records what the queued command records", async () => {
    const queued = await createRewindFixture();
    await queued.yaCommandRunner.run({
      sessionId: queued.sessionId,
      projectId: queued.project.id,
      projectPath: queued.project.path,
      command: { name: "clear", argument: "1" },
      commandText: "/clear 1",
    } as Parameters<YaCommandRunner["run"]>[0]);

    const interactive = await createRewindFixture();
    interactive.getSession.mockClear();
    const response = await interactive.routes.request(
      `/projects/${interactive.project.id}/sessions/${interactive.sessionId}/rewind`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cut: { kind: "after-user-turn", sourceMessageId: "u1" },
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(interactive.getSession).toHaveBeenCalledTimes(1);

    const pick = ({
      cutMessageId,
      cutTurnIndex,
      droppedTurnCount,
      droppedFromMessageId,
      droppedThroughMessageId,
    }: SessionRewindRecord) => ({
      cutMessageId,
      cutTurnIndex,
      droppedTurnCount,
      droppedFromMessageId,
      droppedThroughMessageId,
    });
    expect(
      pick(interactive.metadata.getRewindRecords(interactive.sessionId)[0]!),
    ).toEqual(pick(queued.metadata.getRewindRecords(queued.sessionId)[0]!));
  });

  it("refuses a cut at a compact summary instead of recording /clear 0", async () => {
    const fixture = await createRewindFixture((entry) => [
      entry("user", "u1", null, "first"),
      entry("assistant", "a1", "u1", "one"),
      entry(
        "user",
        "summary",
        "a1",
        "This session is being continued from a previous conversation that ran out of context.",
        { isCompactSummary: true },
      ),
      entry("user", "u2", "summary", "second"),
      entry("assistant", "a2", "u2", "two"),
    ]);

    const response = await fixture.routes.request(
      `/projects/${fixture.project.id}/sessions/${fixture.sessionId}/rewind`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cut: { kind: "before-user-turn", sourceMessageId: "summary" },
        }),
      },
    );

    // The boundary and the turn index share one predicate, so the summary
    // is refused as a cut source rather than recorded as turn 0.
    expect(response.status).toBe(400);
    expect(fixture.metadata.getRewindRecords(fixture.sessionId)).toEqual([]);
  });

  it("records the last live turn as N when clearing before a turn after a clear", async () => {
    const fixture = await createClearedTurnFixture();

    const response = await fixture.routes.request(
      `/projects/${fixture.project.id}/sessions/${fixture.sessionId}/rewind`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cut: { kind: "before-user-turn", sourceMessageId: "u6" },
        }),
      },
    );

    expect(response.status).toBe(200);
    const record = fixture.metadata
      .getRewindRecords(fixture.sessionId)
      .find((row) => row.id !== "clear-3");
    // Clear replacing turn 6 keeps through turn 3, so its header reads
    // `/clear 3`, which is also the N a copied `/clearloop 3 …` accepts.
    expect(record).toMatchObject({ cutMessageId: "a3", cutTurnIndex: 3 });
  });

  it("forks before a turn from that turn's context, not the cleared span above it", async () => {
    const fixture = await createClearedTurnFixture();
    vi.spyOn(Supervisor.prototype, "supportsForkSession").mockReturnValue(true);
    const forkSession = vi
      .spyOn(Supervisor.prototype, "forkSession")
      .mockResolvedValue({ sessionId: "fork-1" } as Awaited<
        ReturnType<Supervisor["forkSession"]>
      >);

    const response = await fixture.routes.request(
      `/projects/${fixture.project.id}/sessions/${fixture.sessionId}/fork`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          forkKind: "before-user-turn",
          sourceMessageId: "u6",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(forkSession.mock.calls[0]?.[0]).toMatchObject({
      boundary: { kind: "message", provider: "claude", messageId: "a3" },
    });
  });

  it("a queued /clearloop starts a patient loop at the resolved cut", async () => {
    const fixture = await createRewindFixture();

    await fixture.yaCommandRunner.run({
      sessionId: fixture.sessionId,
      projectId: fixture.project.id,
      projectPath: fixture.project.path,
      command: { name: "clearloop", argument: "1 3: try again" },
      commandText: "/clearloop 1 3: try again",
    } as Parameters<YaCommandRunner["run"]>[0]);

    expect(fixture.clearloopStart).toHaveBeenCalledWith(
      fixture.sessionId,
      fixture.project.id,
      expect.objectContaining({
        cutMessageId: "a1",
        prompt: "try again",
        total: 3,
        commandText: "/clearloop 1 3: try again",
        patient: true,
      }),
    );
  });

  it("guards a one-turn /clear but not a clearloop iteration's drop", async () => {
    const clear = await createRewindFixture();
    await clear.yaCommandRunner.run({
      sessionId: clear.sessionId,
      projectId: clear.project.id,
      projectPath: clear.project.path,
      command: { name: "clear", argument: "1" },
      commandText: "/clear 1",
    } as Parameters<YaCommandRunner["run"]>[0]);
    expect(clear.metadata.getPendingRewind(clear.sessionId)).toMatchObject({
      dropsTurnPromptId: "u2",
    });

    // A clearloop iteration is discarded whole, task notifications and
    // absorbed queued messages included, so the provider must not refuse it.
    const loop = await createRewindFixture();
    await loop.clearloopRunner.rewind({
      sessionId: loop.sessionId,
      projectId: loop.project.id,
      job: {
        id: "loop-1",
        cutMessageId: "a1",
        cutTurnIndex: 1,
        prompt: "again",
        total: 3,
      },
      iteration: 2,
    } as Parameters<ClearloopRunner["rewind"]>[0]);
    const pending = loop.metadata.getPendingRewind(loop.sessionId);
    expect(pending?.cutMessageId).toBe("a1");
    expect(pending?.dropsTurnPromptId).toBeUndefined();
  });
});

describe("resume launch settings", () => {
  const saveLaunch = async (
    metadata: SessionMetadataService,
    sessionId: string,
  ) => {
    await metadata.recordEffectiveLaunchSettings(sessionId, {
      permissionMode: "acceptEdits",
      requestedModel: "opus",
      serviceTier: null,
      thinking: { type: "adaptive" },
      effort: "high",
    });
    await metadata.updateMetadata(sessionId, {
      recapMode: "side-session",
      recapAfterSeconds: 90,
      promptSuggestionMode: "off",
    });
  };

  it("a clearloop iteration resumes with the session's saved settings", async () => {
    const fixture = await createRewindFixture();
    await saveLaunch(fixture.metadata, fixture.sessionId);

    await fixture.clearloopRunner.send({
      sessionId: fixture.sessionId,
      projectId: fixture.project.id,
      job: { prompt: "again" },
    } as Parameters<ClearloopRunner["send"]>[0]);

    expect(fixture.resume).toHaveBeenCalledTimes(1);
    const [, projectPath, message, permissionMode, settings] =
      fixture.resume.mock.calls[0]!;
    expect(projectPath).toBe(fixture.project.path);
    expect(message.text).toBe("again");
    expect(permissionMode).toBe("acceptEdits");
    expect(settings).toMatchObject({
      model: "opus",
      requestedModel: "opus",
      thinking: { type: "adaptive" },
      effort: "high",
      providerName: "claude",
      sandboxLevel: "none",
      sandboxNetworkFirewall: false,
      recapMode: "side-session",
      recapAfterSeconds: 90,
      promptSuggestionMode: "off",
      resumeMode: "full",
    });
  });

  it("a resume that names no recap mode keeps the session's saved one", async () => {
    const fixture = await createRewindFixture();
    await saveLaunch(fixture.metadata, fixture.sessionId);

    const response = await fixture.routes.request(
      `/projects/${fixture.project.id}/sessions/${fixture.sessionId}/resume`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "continue" }),
      },
    );

    expect(response.status).toBe(200);
    const settings = fixture.resume.mock.calls[0]?.[4];
    expect(settings).toMatchObject({
      model: "opus",
      requestedModel: "opus",
      recapMode: "side-session",
      recapAfterSeconds: 90,
      promptSuggestionMode: "off",
    });
  });
});
