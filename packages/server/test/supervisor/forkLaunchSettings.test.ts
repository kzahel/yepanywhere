import {
  parseYaSessionId,
  nativeSessionRef,
  nativeSessionFamily,
  parseNativeSessionId,
} from "@yep-anywhere/shared";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EffectiveSessionLaunchSettings,
  ProviderName,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { getLogger } from "../../src/logging/logger.js";
import { MessageQueue } from "../../src/sdk/messageQueue.js";
import type { AgentProvider } from "../../src/sdk/providers/types.js";
import {
  ForkSettingsPersistenceError,
  Supervisor,
  type SupervisorOptions,
} from "../../src/supervisor/Supervisor.js";
import {
  createSessionsRoutes,
  type SessionsDeps,
} from "../../src/routes/sessions.js";
import { encodeProjectId } from "../../src/projects/paths.js";
import {
  closeTestDiscoveryDatabases,
  createTestSessionMetadataService,
} from "../utils/session-metadata-database.js";

const source: EffectiveSessionLaunchSettings = {
  schemaVersion: 1,
  revision: 7,
  permissionMode: "bypassPermissions",
  requestedModel: "source-model",
  serviceTier: "priority",
  thinking: { type: "adaptive", display: "summarized" },
  effort: "high",
};

describe("fork launch settings", () => {
  let dataDir: string;
  let metadata: SessionMetadataService;
  let nativeDir: string;
  const owners: Supervisor[] = [];

  beforeEach(async () => {
    dataDir = await realpath(await mkdtemp(join(tmpdir(), "fork-settings-")));
    nativeDir = join(dataDir, "claude", "projects", "source");
    await mkdir(nativeDir, { recursive: true });
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(dataDir, "claude"));
    metadata = createTestSessionMetadataService(dataDir);
    await metadata.initialize();
    await metadata.recordEffectiveLaunchSettings("source", source);
  });
  afterEach(async () => {
    for (const owner of owners.splice(0)) await dispose(owner);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    closeTestDiscoveryDatabases();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function dispose(supervisor: Supervisor) {
    await Promise.all(
      supervisor
        .getAllProcesses()
        .map((process) => supervisor.abortProcess(process.id)),
    );
    await supervisor.stopBackgroundTasks();
  }

  // These tests exercise settings/pins with controlled native effects. Their
  // server-side caller supplies trusted context; route admission has real I/O coverage.
  function ownedSupervisor(options: SupervisorOptions): Supervisor {
    const service = options.sessionMetadataService!,
      original = options.provider!;
    let copies = 0;
    const provider = {
      ...original,
      supportsNativeResumeSource: true,
      ...(original.forkSession
        ? {
            forkSession: async (
              input: Parameters<NonNullable<AgentProvider["forkSession"]>>[0],
            ) => {
              const result = await original.forkSession!(input);
              copies++;
              const id = parseNativeSessionId(
                copies === 1
                  ? result.nativeSessionId
                  : result.nativeSessionId + "-" + copies,
              );
              return {
                ...result,
                nativeSessionId: id,
                native: nativeSessionRef(
                  nativeSessionFamily(original.name),
                  nativeDir,
                  id,
                ),
              };
            },
          }
        : {}),
    } as AgentProvider;
    const supervisor = new Supervisor({
      ...options,
      provider,
      resolveNativeSessionSource: async (id, cwd) => {
        const native =
          service.identities.resolveYa(parseYaSessionId(id))?.native ??
          nativeSessionRef(
            nativeSessionFamily(original.name),
            nativeDir,
            parseNativeSessionId(id),
          );
        return {
          native,
          filePath: join(nativeDir, native.id + ".jsonl"),
          projectId: encodeProjectId(cwd),
        };
      },
    });
    const fork = supervisor.forkSession.bind(supervisor);
    supervisor.forkSession = (options) =>
      fork({
        ...options,
        creation: options.creation ?? {
          context: {
            owner: { kind: "superuser" },
            source: { kind: "request", provenance: { surface: "api" } },
          },
          authorize: async () => {},
        },
      });
    return supervisor;
  }
  function owner(providerName: ProviderName, service = metadata) {
    const startSession = vi.fn<AgentProvider["startSession"]>(
      async (options) => {
        const queue = new MessageQueue();
        const messages = queue.generator();
        async function* iterator() {
          yield {
            type: "system" as const,
            subtype: "init" as const,
            session_id: options.resumeSessionId,
          };
          for await (const message of messages) {
            void message;
            yield {
              type: "result" as const,
              subtype: "success" as const,
              session_id: options.resumeSessionId,
            };
          }
        }
        return {
          iterator: iterator(),
          queue,
          abort: async () => {
            await messages.return();
          },
        };
      },
    );
    const forkSession = vi.fn<NonNullable<AgentProvider["forkSession"]>>(
      async () => ({
        nativeSessionId: parseNativeSessionId("child"),
      }),
    );
    const supervisor = ownedSupervisor({
      provider: {
        name: providerName,
        forkSession,
        startSession,
      } as unknown as AgentProvider,
      sessionMetadataService: service,
      defaultPermissionMode: "default",
    });
    owners.push(supervisor);
    return { supervisor, startSession, forkSession };
  }

  it.each([false, true])(
    "refuses a retired remote source before forking (frozen settings: %s)",
    async (frozenSettings) => {
      await metadata.setExecutor("source", "retired-host");
      const { supervisor, startSession, forkSession } = owner("claude");
      await expect(
        supervisor.forkSession({
          sessionId: "source",
          projectPath: dataDir,
          providerName: "claude",
          ...(frozenSettings ? { launchSettings: source } : {}),
        }),
      ).rejects.toThrow("SSH executors have been removed");
      expect(forkSession).not.toHaveBeenCalled();
      expect(startSession).not.toHaveBeenCalled();
      expect(metadata.getEffectiveLaunchSettings("child")).toBeUndefined();
    },
  );

  for (const providerName of ["claude", "codex", "pi"] as const) {
    for (const [permissionMode, thinking, effort] of [
      ["bypassPermissions", source.thinking, "high"],
      ["plan", { type: "disabled" }, null],
      ["default", null, null],
    ] as const) {
      it(`${providerName}: retains ${permissionMode} through first send and a fresh server owner`, async () => {
        const expected = { ...source, permissionMode, thinking, effort };
        await metadata.recordEffectiveLaunchSettings("source", expected);
        const original = metadata.getMetadata("source");
        const { supervisor, forkSession } = owner(providerName);
        const fork = await supervisor.forkSession({
          sessionId: "source",
          projectPath: dataDir,
          providerName,
          // Prefix selection must not choose historical configuration.
          upToMessageId: "older-turn",
        });
        expect(forkSession).toHaveBeenCalledWith(
          expect.objectContaining({
            upToMessageId: "older-turn",
            launchSettings: {
              permissionMode,
              requestedModel: "source-model",
              serviceTier: "priority",
              thinking,
              effort,
            },
          }),
        );
        expect(metadata.getEffectiveLaunchSettings(fork.sessionId)).toEqual({
          ...expected,
          schemaVersion: 1,
          revision: 1,
        });
        expect(metadata.getMetadata("source")).toEqual(original);

        for (let turn = 0; turn < 2; turn++) {
          const restored = createTestSessionMetadataService(dataDir);
          await restored.initialize();
          const resumed = owner(providerName, restored);
          const process = await resumed.supervisor.resumeSession(
            fork.sessionId,
            dataDir,
            { text: `Child turn ${turn}` },
            undefined,
            { providerName },
          );
          expect(resumed.startSession).toHaveBeenCalledWith(
            expect.objectContaining({
              resumeSessionId: "child",
              permissionMode,
              model: "source-model",
              serviceTier: "priority",
              thinking: thinking ?? undefined,
              effort: effort ?? undefined,
            }),
          );
          expect(process).toHaveProperty("sessionId", fork.sessionId);
          await dispose(resumed.supervisor);
        }
      });
    }
  }

  it("checks a routed source's pin before copying and pins the copy after", async () => {
    await metadata.updateMetadata("source", {
      routerBinding: {
        id: "parent-binding",
        routerId: "router",
        accountId: "account",
        provider: "claude",
      },
    });
    const order: string[] = [];
    const router = {
      assertInheritable: vi.fn(() => order.push("check")),
      inheritBinding: vi.fn(async () => {
        order.push("inherit");
      }),
    };
    const forkSession = vi.fn(async () => {
      order.push("fork");
      return { nativeSessionId: parseNativeSessionId("child") };
    });
    const supervisor = ownedSupervisor({
      provider: { name: "claude", forkSession } as unknown as AgentProvider,
      sessionMetadataService: metadata,
      agentAuthRouter: router as never,
    });
    owners.push(supervisor);
    await supervisor.forkSession({
      sessionId: "source",
      projectPath: dataDir,
      providerName: "claude",
    });
    expect(order).toEqual(["check", "fork", "inherit"]);
    expect(router.inheritBinding).toHaveBeenCalledWith(
      "source",
      expect.any(String),
    );

    // A pin that cannot be kept stops the copy before any transcript exists.
    router.assertInheritable.mockImplementation(() => {
      throw new Error("lost its router binding");
    });
    await expect(
      supervisor.forkSession({
        sessionId: "source",
        projectPath: dataDir,
        providerName: "claude",
      }),
    ).rejects.toThrow("lost its router binding");
    expect(forkSession).toHaveBeenCalledOnce();
  });

  it("discards a copy that cannot inherit the routed source's account", async () => {
    await metadata.updateMetadata("source", {
      routerBinding: {
        id: "parent-binding",
        routerId: "router",
        accountId: "account",
        provider: "codex",
      },
    });
    const rollout = join(dataDir, "rollout-child.jsonl");
    await writeFile(rollout, "{}\n");
    const supervisor = ownedSupervisor({
      provider: {
        name: "codex",
        forkSession: vi.fn(async () => ({
          nativeSessionId: parseNativeSessionId("child"),
          filePath: rollout,
        })),
      } as unknown as AgentProvider,
      sessionMetadataService: metadata,
      agentAuthRouter: {
        assertInheritable: () => {},
        inheritBinding: async () => {
          throw new Error("metadata write failed");
        },
      } as never,
    });
    owners.push(supervisor);
    const error = vi.spyOn(getLogger(), "error").mockImplementation(() => {});
    await expect(
      supervisor.forkSession({
        sessionId: "source",
        projectPath: dataDir,
        providerName: "codex",
      }),
    ).rejects.toThrow(/could not keep .* so it was discarded/);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "routed_copy_binding_failed",
        discarded: true,
      }),
      expect.any(String),
    );
    await expect(readFile(rollout)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replaces only explicit thinking and keeps a frozen source for summary targets", async () => {
    const { supervisor } = owner("claude");
    const generator = await supervisor.forkSession({
      sessionId: "source",
      projectPath: dataDir,
      launchOverrides: { thinking: "on:low" },
    });
    expect(generator.launchSettings).toEqual({
      permissionMode: "bypassPermissions",
      requestedModel: "source-model",
      serviceTier: "priority",
      thinking: source.thinking,
      effort: "low",
    });
    const frozen = await supervisor.resolveForkLaunchSettings(
      "source",
      dataDir,
      "claude",
    );
    await metadata.recordEffectiveLaunchSettings("source", {
      ...source,
      permissionMode: "default",
      effort: "max",
    });
    const target = await supervisor.forkSession({
      sessionId: "source",
      projectPath: dataDir,
      launchSettings: frozen,
      launchOverrides: { permissionMode: "plan" },
    });
    expect(target.launchSettings).toEqual({
      ...frozen,
      permissionMode: "plan",
    });
    expect(target.launchSettings.effort).toBe("high");
  });

  it("recovers a legacy source without activating or migrating it", async () => {
    const provider = {
      name: "codex",
      forkSession: vi.fn(async () => ({
        nativeSessionId: parseNativeSessionId("child"),
      })),
    } as unknown as AgentProvider;
    const recover = vi.fn(async () => ({
      permissionMode: "bypassPermissions" as const,
      requestedModel: "recovered-model",
      thinking: source.thinking!,
      effort: "high" as const,
    }));
    const supervisor = ownedSupervisor({
      provider,
      sessionMetadataService: metadata,
      recoverSessionLaunchSettings: recover,
    });
    owners.push(supervisor);
    const fork = await supervisor.forkSession({
      sessionId: "legacy",
      projectPath: dataDir,
    });
    expect(fork.launchSettings).toMatchObject({
      permissionMode: "bypassPermissions",
      requestedModel: "recovered-model",
      effort: "high",
    });
    expect(recover).toHaveBeenCalledTimes(1);
    expect(metadata.getMetadata("legacy")).toBeUndefined();
    expect(supervisor.getProcessForSession("legacy")).toBeUndefined();
  });

  it("copies the same snapshot for a legacy Claude aside clone", async () => {
    const sessionsDir = nativeDir;
    await writeFile(
      join(sessionsDir, "source.jsonl"),
      `${JSON.stringify({
        type: "user",
        uuid: "prompt",
        sessionId: "source",
        parentUuid: null,
        message: { role: "user", content: "Retained prompt" },
      })}\n`,
    );
    const { supervisor } = owner("claude");
    const projectId = encodeProjectId(dataDir);
    const routes = createSessionsRoutes({
      supervisor,
      sessionMetadataService: metadata,
      scanner: {
        getOrCreateProject: async () => ({
          id: projectId,
          path: dataDir,
          provider: "claude",
          sessionDir: sessionsDir,
        }),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: () =>
        ({
          getSessionSummary: async () => ({
            id: "source",
            title: "Source",
            provider: "claude",
            messageCount: 1,
          }),
        }) as unknown as ReturnType<SessionsDeps["readerFactory"]>,
    });
    const response = await routes.request(
      `/projects/${projectId}/sessions/source/clone`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentSessionId: "source" }),
      },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const child = (await response.json()) as { sessionId: string };
    expect(metadata.getEffectiveLaunchSettings(child.sessionId)).toEqual({
      ...source,
      revision: 1,
    });
    expect(metadata.getMetadata(child.sessionId)?.parentSessionKind).toBe(
      "btw-aside",
    );
  });

  it("returns an honest creation failure if the child snapshot cannot be saved", async () => {
    await metadata.setTitle("source", "Source");
    vi.spyOn(getLogger(), "error").mockImplementation(() => undefined);
    const record = metadata.recordEffectiveLaunchSettings.bind(metadata);
    vi.spyOn(metadata, "recordEffectiveLaunchSettings").mockImplementation(
      (id, value) => {
        if (id !== "source") throw new Error("disk unavailable");
        return record(id, value);
      },
    );
    const { supervisor, forkSession } = owner("claude");
    const projectId = encodeProjectId(dataDir);
    const routes = createSessionsRoutes({
      supervisor,
      sessionMetadataService: metadata,
      scanner: {
        getOrCreateProject: async () => ({
          id: projectId,
          path: dataDir,
          provider: "claude",
        }),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: () =>
        ({
          getSessionListSummary: async () => null,
          getSessionSummary: async () => null,
        }) as unknown as ReturnType<SessionsDeps["readerFactory"]>,
    });
    vi.spyOn(getLogger(), "warn").mockImplementation(() => undefined);
    const response = await routes.request(
      `/projects/${projectId}/sessions/source/fork`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ forkKind: "clone-latest-complete" }),
      },
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("child was created"),
    });
    expect(forkSession).toHaveBeenCalledTimes(1);
    expect(metadata.getMetadata("source")?.forksCreated).toBe(1);
    expect(metadata.getEffectiveLaunchSettings("source")).toMatchObject(source);
    await expect(
      supervisor.recordForkLaunchSettings("child", source),
    ).rejects.toBeInstanceOf(ForkSettingsPersistenceError);
  });
  it("coalesces a copy across dispatch generation and isolates saved intent from acceptance observers", async () => {
    const { supervisor, forkSession } = owner("claude");
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    forkSession.mockImplementationOnce(async () => {
      await barrier;
      return { nativeSessionId: parseNativeSessionId("child") };
    });
    const creation = {
      requestId: "immutable-copy-operation",
      context: {
        owner: { kind: "superuser" as const },
        source: {
          kind: "request" as const,
          provenance: { surface: "web" as const },
        },
      },
      authorize: async () => {},
      onAccepted: (
        saved: import("../../src/sessions/SessionCreationStore.js").SavedSessionCreation,
      ) => {
        saved.request!.copy!.title = "observer mutation";
      },
    };
    const options = {
      sessionId: "source",
      projectPath: dataDir,
      title: "Original copy title",
      creation,
    };
    const admissions = vi.spyOn(metadata.creations, "admit");
    const first = supervisor.forkSession(options);
    await vi.waitFor(() => expect(forkSession).toHaveBeenCalledTimes(1));
    const projection = metadata.creations.listProjections()[0]!;
    expect(projection.creation).toMatchObject({
      kind: "copy",
      state: "dispatching",
      initialInputExpected: false,
    });
    const second = supervisor.forkSession({ ...options });
    void second.catch(() => {});
    await vi.waitFor(() => expect(admissions).toHaveBeenCalledTimes(2));
    release();
    const [one, two] = await Promise.all([first, second]);
    expect(two.sessionId).toBe(one.sessionId);
    expect(forkSession).toHaveBeenCalledTimes(1);
    expect(forkSession.mock.calls[0]?.[0]).toMatchObject({
      title: "Original copy title",
    });
    const saved = metadata.creations.get(
      { kind: "superuser" },
      creation.requestId,
    )!;
    expect(saved.request?.copy?.title).toBe("Original copy title");
    const reopened = createTestSessionMetadataService(dataDir);
    await reopened.initialize();
    const cold = owner("claude", reopened);
    expect((await cold.supervisor.forkSession({ ...options })).sessionId).toBe(
      one.sessionId,
    );
    expect(cold.forkSession).not.toHaveBeenCalled();
  });

  it("retains failed internal helper intent archived before native copy effects", async () => {
    const { supervisor, forkSession } = owner("claude");
    forkSession.mockImplementationOnce(async () => {
      const row = metadata.creations.listProjections()[0]!;
      expect(metadata.getMetadata(row.sessionId)?.isArchived).toBe(true);
      throw new Error("lost native copy result");
    });
    const options = {
      sessionId: "source",
      projectPath: dataDir,
      creation: {
        requestId: "failed-helper-copy",
        context: {
          owner: { kind: "superuser" as const },
          source: { kind: "internal" as const, reason: "retitle" as const },
        },
        authorize: async () => {},
      },
    };
    await expect(supervisor.forkSession(options)).rejects.toMatchObject({
      name: "ForkSettingsPersistenceError",
      sessionId: expect.any(String),
    });
    const saved = metadata.creations.get(
      { kind: "superuser" },
      options.creation.requestId,
    )!;
    expect(saved.attempt).toMatchObject({ kind: "copy", state: "uncertain" });
    expect(metadata.getMetadata(saved.sessionId)).toMatchObject({
      isArchived: true,
      forkedFromSessionId: "source",
    });
    await expect(supervisor.forkSession(options)).rejects.toThrow(
      "will not be copied again",
    );
    expect(forkSession).toHaveBeenCalledTimes(1);
  });

  it("recovers a fork-summary target association from canonical admission after a lost projection write", async () => {
    const { supervisor } = owner("claude"),
      id = "owned-summary-job";
    await metadata.addTranscriptDisplayObject("source", {
      id,
      kind: "fork-summary",
      createdAt: new Date().toISOString(),
      placementAfterMessageId: "answer",
      sourceMessageId: "question",
      retainedThroughMessageId: "answer",
      status: "generating",
    });
    const copied = await supervisor.forkSession({
      sessionId: "source",
      projectPath: dataDir,
      initialPrompt: "SAVED_GENERATED_CONTINUATION",
      creation: {
        requestId: `fork-summary-target-${id}`,
        context: {
          owner: { kind: "superuser" },
          source: { kind: "request", provenance: { surface: "web" } },
        },
        authorize: async () => {},
      },
    });
    const reopened = createTestSessionMetadataService(dataDir);
    await reopened.initialize();
    expect(reopened.getTranscriptDisplayObjects("source")[0]).toMatchObject({
      targetSessionId: copied.sessionId,
    });
    expect(
      reopened.creations.getForSession(parseYaSessionId(copied.sessionId))
        ?.request?.message,
    ).toBe("SAVED_GENERATED_CONTINUATION");
  });
});
