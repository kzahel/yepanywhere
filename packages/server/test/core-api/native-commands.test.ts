import { getLogger } from "../../src/logging/logger.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import {
  Process,
  createControllableIterator,
} from "../process.test-support.js";
import { afterEach, expect, it, vi } from "vitest";
import { openSqliteOrThrow } from "../../src/storage/sqlite.js";
import { migrateDiscoveryDatabase } from "../../src/storage/discovery-sqlite.js";
import { ApiReceiptStore } from "../../src/core-api/receipt-store.js";
import { SessionCommands } from "../../src/core-api/session-commands.js";
import { nativeSessionCommandOwner } from "../../src/core-api/native-session-commands.js";
import {
  createSessionRequest,
  sendMessageRequest,
} from "../../src/core-api/command-contracts.js";
import { Supervisor } from "../../src/supervisor/Supervisor.js";
import { MessageQueue } from "../../src/sdk/messageQueue.js";
import type {
  AgentProvider,
  StartSessionOptions,
} from "../../src/sdk/providers/types.js";
import { encodeProjectId } from "../../src/projects/paths.js";

const warnings = vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
afterEach(() => {
  for (const [fields, message] of warnings.mock.calls) {
    expect(message).toMatch(/^Process terminated:/);
    expect(fields).toMatchObject({ reason: "provider stream completed" });
  }
  warnings.mockClear();
});

it.each(["superuser", "peer"] as const)(
  "uses native admission and queued input with API provenance independent of %s creator",
  async (principal) => {
    const database = openSqliteOrThrow(":memory:");
    migrateDiscoveryDatabase(database);
    const store = new ApiReceiptStore(database);
    const root = await mkdtemp(join(tmpdir(), "ya-native-api-source-"));
    const metadata = new SessionMetadataService({ database, dataDir: root });
    await metadata.initialize();
    let options: StartSessionOptions | undefined;
    let starts = 0,
      steers = 0;
    const consumed: string[] = [];
    const deliveredText: string[] = [];
    const provenanceCountsAtStart: number[] = [];
    const creatorCountsAtStart: number[] = [];
    let releaseFirst!: () => void;
    const firstTurn = new Promise<void>((resolve) => (releaseFirst = resolve));
    let firstConsumed!: () => void;
    const firstInput = new Promise<void>(
      (resolve) => (firstConsumed = resolve),
    );
    let nextConsumed!: () => void;
    const secondInput = new Promise<void>(
      (resolve) => (nextConsumed = resolve),
    );
    const nativeId = "00000000-0000-4000-8000-000000000042";
    const provider = {
      name: "codex",
      getAuthStatus: async () => ({
        installed: true,
        authenticated: true,
        enabled: true,
      }),
      getNewSessionNamespace: async () => ({
        family: "codex" as const,
        storageScope: root,
      }),
      async startSession(request: StartSessionOptions) {
        starts++;
        creatorCountsAtStart.push(
          metadata.relationships.index.list({
            resource: {
              kind: "session",
              serverId: "A",
              sessionId: request.publicSessionId!,
            },
            direction: "incoming",
            type: "created_session",
          }).edges.length,
        );
        provenanceCountsAtStart.push(
          Object.values(metadata.getAllMetadata()).filter(
            (m) => m.creationProvenance?.surface === "api",
          ).length,
        );
        if (starts > 1) throw new Error("Scripted queued startup failure");
        options = request;
        const queue = new MessageQueue();
        const incoming = queue.generator();
        const iterator = (async function* () {
          yield {
            type: "system" as const,
            subtype: "init" as const,
            session_id: nativeId,
          };
          for await (const message of incoming) {
            request.onNativeInputConsumed?.(nativeId, message.uuid!);
            consumed.push(message.uuid!);
            deliveredText.push(
              typeof message.message.content === "string"
                ? message.message.content
                : message.message.content
                    .map((block) => (block.type === "text" ? block.text : ""))
                    .join(""),
            );
            if (consumed.length === 2) nextConsumed();
            if (consumed.length === 1) {
              firstConsumed();
              await firstTurn;
            }
            yield {
              type: "result" as const,
              subtype: "success" as const,
              session_id: nativeId,
            };
          }
        })();
        return {
          queue,
          iterator,
          steer: async () => {
            steers++;
            return true;
          },
          abort: async () => {
            releaseFirst();
            await incoming.return();
          },
        };
      },
    } as unknown as AgentProvider;
    const supervisor = new Supervisor({
      provider,
      sessionMetadataService: metadata,
      defaultPermissionMode: "default",
      maxWorkers: 1,
    });
    const nativeOwner = nativeSessionCommandOwner({
      supervisor,
      creations: metadata.creations,
      globalInstructions: () => "Fixture guidance",
    });
    let failed!: () => void;
    const failure = new Promise<void>((resolve) => (failed = resolve));
    const owner: typeof nativeOwner = {
      ...nativeOwner,
      start: (
        project,
        request,
        receipt,
        settled,
        onFailed,
        onConsumed,
        admitted,
        authorize,
      ) =>
        nativeOwner.start(
          project,
          request,
          receipt,
          settled,
          () => {
            onFailed();
            failed();
          },
          onConsumed,
          admitted,
          authorize,
        ),
    };
    const commands = new SessionCommands("A", store, owner, () => true);
    const launch = {
      id: "parent",
      launchId: "launch",
      management: true as const,
    };
    try {
      const project = {
        id: encodeProjectId(root),
        name: "Fixture",
        path: root,
      };
      const request = createSessionRequest.parse({
        requestId: "native-review-1",
        projectId: project.id,
        provider: "codex",
        model: "fixture-model",
        thinking: "on:high",
        permissionMode: "bypassPermissions",
        message: "/clear",
      });
      const creator =
        principal === "peer"
          ? {
              serverId: "peer-source",
              sessionId: "parent",
              launchId: "peer-launch",
              principal: { kind: "peer" as const },
              authentication: {
                credentialId: "fixture-peer",
                generation: 1,
                sessionAttribution: "source-attested" as const,
              },
            }
          : undefined;
      const receipt = commands.create(project, request, launch, creator);
      await commands.idle();
      await firstInput;
      const publicId = store.get(receipt.id)!.sessionId!;
      expect(publicId).not.toBe(nativeId);
      expect(deliveredText).toEqual(["/clear"]);
      expect(
        metadata.creations.get({ kind: "superuser" }, receipt.id),
      ).toMatchObject({
        sessionId: publicId,
        initialInputId: receipt.id,
        request: { input: { nativeReceiptId: receipt.id } },
        attempt: { delivery: "consumed" },
      });
      expect(store.get(receipt.id)).toMatchObject({
        state: "accepted",
        sessionId: publicId,
        delivery: "consumed",
        completion: "unknown",
        creator: { sessionId: "parent" },
      });
      expect(metadata.getMetadata(publicId)?.creationProvenance).toEqual({
        surface: "api",
      });
      const reopened = new SessionMetadataService({ database, dataDir: root });
      await reopened.initialize();
      expect(reopened.getMetadata(publicId)?.creationProvenance).toEqual({
        surface: "api",
      });
      expect(store.get(receipt.id)?.creator.principal.kind).toBe(principal);
      expect(options).toMatchObject({
        model: "fixture-model",
        effort: "high",
        permissionMode: "bypassPermissions",
        globalInstructions: "Fixture guidance",
      });
      const nativeProcess = supervisor.getProcessForSession(publicId)!;
      expect(supervisor.getProcessForSession(nativeId)).toBeUndefined();
      expect(nativeProcess.hasAcceptedApiInput(receipt.id)).toBe(true);
      const session = {
        id: publicId,
        projectId: project.id,
        provider: "codex",
        title: null,
        updatedAt: "",
        state: "in-turn",
      };
      const input = sendMessageRequest.parse({
        requestId: "native-input-1",
        message: "Follow up",
      });
      const sent = commands.send(session, input, launch);
      expect(sent).toMatchObject({
        state: "accepted",
        delivery: "unknown",
        completion: "unknown",
      });
      expect(commands.send(session, input, launch).id).toBe(sent.id);
      expect(nativeProcess.getInfo().queueDepth).toBe(1);
      expect(steers).toBe(0);
      const before = await commands.follow(sent.id, {});
      const waiting = commands.follow(sent.id, {
        after: before.cursor,
        waitMs: "4000",
      });
      releaseFirst();
      expect(await waiting).toMatchObject({
        changed: true,
        receipt: { delivery: "consumed", completion: "unknown" },
      });
      await secondInput;
      expect(consumed).toEqual([receipt.id, sent.id]);
      expect(starts).toBe(1);
      expect(steers).toBe(0);
      store.update(receipt.id, { state: "uncertain", sessionId: null });
      expect(await commands.receipt(receipt.id)).toMatchObject({
        state: "accepted",
        sessionId: publicId,
        delivery: "consumed",
      });
      const queued = commands.create(
        project,
        {
          ...request,
          requestId: "native-review-2",
        },
        launch,
        creator,
      );
      await commands.idle();
      expect(store.get(queued.id)?.state).toBe("queued");
      await supervisor.abortProcess(nativeProcess.id);
      await failure;
      expect(store.get(queued.id)).toMatchObject({
        state: "uncertain",
        failure: { code: "launch_uncertain" },
      });
      expect(commands.send(session, input, launch)).toMatchObject({
        id: sent.id,
        delivery: "consumed",
      });
      expect(() =>
        commands.send(
          session,
          { ...input, requestId: "native-input-2" },
          launch,
        ),
      ).toThrow("incumbent active native owner");
      expect(starts).toBe(2);
      // Assert outside the expected failure path: no swallowed provider assertion.
      expect(provenanceCountsAtStart).toEqual([1, 2]);
      expect(creatorCountsAtStart).toEqual([1, 1]);
    } finally {
      releaseFirst();
      commands.close();
      await Promise.all(
        supervisor
          .getAllProcesses()
          .map((process) => supervisor.abortProcess(process.id)),
      );
      await supervisor.stopBackgroundTasks();
      store.close();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("preserves batched input identities, rejects false push evidence, and tears down pending monitors on abort", async () => {
  const database = openSqliteOrThrow(":memory:");
  migrateDiscoveryDatabase(database);
  const store = new ApiReceiptStore(database);
  const queue = new MessageQueue();
  const subscriptions = new Set<() => void>();
  const subscribe = queue.subscribeYielded.bind(queue);
  vi.spyOn(queue, "subscribeYielded").mockImplementation((listener) => {
    const off = subscribe(listener);
    const release = () => {
      subscriptions.delete(release);
      off();
    };
    subscriptions.add(release);
    return release;
  });
  const controlled = createControllableIterator();
  const process = new Process(controlled.iterator, {
    projectPath: "/fixture",
    projectId: "p" as import("@yep-anywhere/shared").UrlProjectId,
    sessionId: "target",
    provider: "codex",
    queue,
    abortFn: async () => controlled.finish(),
  });
  const owner = nativeSessionCommandOwner({
    supervisor: {
      startSession: async () => {
        throw new Error("Unexpected launch");
      },
      getAllProcesses: () => [process],
      getProcessForSession: (id) => (id === "target" ? process : undefined),
    },
    globalInstructions: () => undefined,
  });
  let commands = new SessionCommands("A", store, owner, () => true);
  const session = {
    id: "target",
    projectId: "p",
    provider: "codex",
    title: null,
    updatedAt: "",
    state: "in-turn",
  };
  try {
    const push = vi.spyOn(queue, "push").mockImplementationOnce(() => {
      throw new Error("push rejected");
    });
    const failed = commands.send(
      session,
      sendMessageRequest.parse({
        requestId: "rejected-push",
        message: "Rejected",
      }),
    );
    expect(queue.depth).toBe(0);
    expect(process.hasAcceptedApiInput(failed.id)).toBe(false);
    expect(await commands.receipt(failed.id)).toMatchObject({
      state: "uncertain",
      delivery: "uncertain",
    });
    push.mockRestore();
    const first = commands.send(
      session,
      sendMessageRequest.parse({
        requestId: "batched-first",
        message: "First",
      }),
    );
    const second = commands.send(
      session,
      sendMessageRequest.parse({
        requestId: "batched-second",
        message: "Second",
      }),
    );
    const combined = queue.concatDrain({ interrupted: true })!;
    expect(store.get(first.id)?.delivery).toBe("unknown");
    expect(store.get(second.id)?.delivery).toBe("unknown");
    queue.push(combined);
    const input = queue.generator();
    await input.next();
    await input.return();
    expect(store.get(first.id)?.delivery).toBe("consumed");
    expect(store.get(second.id)?.delivery).toBe("consumed");
    expect(process.hasConsumedApiInput(second.id)).toBe(true);
    const pending = commands.send(
      session,
      sendMessageRequest.parse({
        requestId: "aborted-input",
        message: "Not consumed",
      }),
    );
    commands.close();
    commands = new SessionCommands("A", store, owner, () => true);
    const recovered = await commands.follow(pending.id, { waitMs: "0" });
    expect(recovered.receipt?.delivery).toBe("uncertain");
    const reattached = commands.follow(pending.id, { after: recovered.cursor });
    const resumedInput = queue.generator();
    await resumedInput.next();
    await resumedInput.return();
    expect(await reattached).toMatchObject({
      changed: true,
      receipt: { delivery: "consumed" },
    });
    const cancelled = commands.send(
      session,
      sendMessageRequest.parse({
        requestId: "cancelled-input",
        message: "Cancel this",
      }),
    );
    const cancelBefore = await commands.follow(cancelled.id, { waitMs: "0" });
    const cancelledWait = commands.follow(cancelled.id, {
      after: cancelBefore.cursor,
    });
    expect(process.cancelUnconfirmedSteerMessage(cancelled.id)).toBe(true);
    expect(await cancelledWait).toMatchObject({
      changed: true,
      receipt: { delivery: "uncertain" },
    });
    expect(process.hasAcceptedApiInput(cancelled.id)).toBe(false);
    expect(await commands.receipt(cancelled.id)).toHaveProperty(
      "delivery",
      "uncertain",
    );
    expect(subscriptions.size).toBe(1); // Only Process's incumbent queue observer remains.
    const aborted = commands.send(
      session,
      sendMessageRequest.parse({
        requestId: "final-aborted",
        message: "Never consumed",
      }),
    );
    expect(subscriptions.size).toBeGreaterThan(0);
    await process.abort();
    expect(store.get(aborted.id)).toMatchObject({
      state: "accepted",
      delivery: "uncertain",
    });
    expect(subscriptions.size).toBe(0);
  } finally {
    controlled.finish();
    await process.abort();
    commands.close();
    store.close();
    database.close();
  }
});

it("starts a routed caller's child on the caller's pool or account, never Direct", async () => {
  const database = openSqliteOrThrow(":memory:");
  migrateDiscoveryDatabase(database);
  const store = new ApiReceiptStore(database);
  const startSession = vi.fn(async (..._args: unknown[]) => ({
    sessionId: "child",
  }));
  const owner = nativeSessionCommandOwner({
    supervisor: {
      startSession,
      getAllProcesses: () => [],
      getProcessForSession: () => undefined,
    } as never,
    globalInstructions: () => undefined,
    callerLaunch: (id) =>
      id === "parent"
        ? {
            model: "claude-opus-4-8",
            routerBinding: {
              id: "parent-pin",
              routerId: "router",
              accountId: "acct",
              provider: "claude",
              poolId: "pool",
              policy: "weekly-pace",
            },
          }
        : undefined,
  });
  const commands = new SessionCommands("A", store, owner, () => true);
  const project = { id: "p", name: "Fixture", path: "/fixture" };
  const launch = {
    id: "parent",
    launchId: "launch",
    management: true as const,
  };
  try {
    const create = async (
      requestId: string,
      provider: "claude" | "codex",
      extra: Record<string, unknown> = {},
    ) => {
      const receipt = commands.create(
        project,
        createSessionRequest.parse({
          requestId,
          projectId: project.id,
          provider,
          message: "child work",
          ...extra,
        }),
        launch,
      );
      await commands.idle();
      return store.get(receipt.id);
    };
    expect(await create("routed-child", "claude")).toMatchObject({
      state: "accepted",
      sessionId: "child",
    });
    // A fresh pick from the caller's pool with its policy and model.
    expect(startSession.mock.calls[0]![3]).toMatchObject({
      providerName: "claude",
      model: "claude-opus-4-8",
      routerPoolId: "pool",
      routerPolicy: "weekly-pace",
    });
    expect(startSession.mock.calls[0]![3]).not.toHaveProperty(
      "routerAccountId",
    );
    expect(await create("other-provider", "codex")).toMatchObject({
      state: "failed",
      failure: {
        code: "admission_rejected",
        message: expect.stringContaining("can start only claude sessions"),
      },
    });
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(
      await create("explicit-pool", "codex", {
        routerPoolId: "other-pool",
        routerPolicy: "weekly-pace",
        model: "release-model",
        thinking: "on:high",
        serviceTier: "priority",
        permissionMode: "plan",
      }),
    ).toMatchObject({ state: "accepted" });
    expect(startSession.mock.calls[1]![2]).toBe("plan");
    expect(startSession.mock.calls[1]![3]).toMatchObject({
      providerName: "codex",
      routerPoolId: "other-pool",
      routerPolicy: "weekly-pace",
      model: "release-model",
      effort: "high",
      serviceTier: "priority",
    });
    expect(startSession.mock.calls[1]![3]).not.toHaveProperty(
      "routerAccountId",
      "acct",
    );
  } finally {
    store.close();
    database.close();
  }
});
