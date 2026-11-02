import * as providerHost from "../../src/sdk/providers/provider-runtime-host.js";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  DEFAULT_INSTRUCTION_RESTORATION,
  parseNativeSessionId,
  parseYaSessionId,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { ClaudeProvider } from "../../src/sdk/providers/claude.js";
import { ClaudeSessionReader } from "../../src/sessions/reader.js";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { creationProcessIdentity } from "../../src/sessions/creation-process-identity.js";
import { migrateDiscoveryDatabase } from "../../src/storage/discovery-sqlite.js";
import { openSqliteOrThrow } from "../../src/storage/sqlite.js";
import { Supervisor } from "../../src/supervisor/Supervisor.js";
import type { AgentProvider } from "../../src/sdk/providers/types.js";
import {
  createControllableIterator,
  MessageQueue,
  Process,
  waitFor,
  type ProcessEvent,
} from "../process.test-support.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.unstubAllEnvs();
});

async function storageFixture() {
  const root = await mkdtemp(join(tmpdir(), "ya-durable-process-"));
  const database = openSqliteOrThrow(join(root, "metadata.sqlite"));
  migrateDiscoveryDatabase(database);
  const metadata = new SessionMetadataService({ dataDir: root, database });
  await metadata.initialize();
  cleanup.push(async () => {
    metadata.creations.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  const store = metadata.creations;
  const saved = store.admit({
    requestId: "durable_process_1",
    context: {
      owner: { kind: "superuser" },
      source: { kind: "request", provenance: { surface: "web" } },
    },
    request: {
      projectPath: root,
      projectId: toUrlProjectId(root),
      provider: "claude",
      message: "exact prompt",
      settings: {
        permissionMode: "default",
        requestedModel: "default",
        thinking: null,
        effort: null,
        serviceTier: null,
      },
      launch: { schemaVersion: 1 },
    },
  });
  const namespace = { family: "claude" as const, storageScope: root };
  return { root, database, metadata, store, saved, namespace };
}

async function fixture(
  initializedSessionId?: string,
  runProviderCommandFn?: import("../../src/supervisor/Process.js").ProcessConstructorOptions["runProviderCommandFn"],
) {
  const { root, metadata, store, saved, namespace } = await storageFixture();
  const fence = store.beginDispatch(saved.attempt, namespace);
  const source = createControllableIterator();
  const queue = new MessageQueue();
  const process = new Process(source.iterator, {
    projectPath: root,
    projectId: toUrlProjectId(root),
    sessionId: saved.sessionId,
    managedIdentity: creationProcessIdentity(store, fence, namespace),
    initializedSessionId,
    queue,
    provider: "claude",
    initialState: "idle",
    abortFn: source.finish,
    runProviderCommandFn,
  });
  cleanup.push(async () => {
    await process.abort();
  });
  const events: ProcessEvent[] = [];
  process.subscribe((event) => events.push(event));
  return { store, metadata, saved, fence, source, queue, process, events };
}

it("binds a different native id before publication, keeping replay and live ids public", async () => {
  const f = await fixture();
  const native = "f93ea87c-2248-4a40-81bd-7b6713259eaa";
  // The pinned Claude CLI can name its session in title telemetry before init.
  f.source.push({
    type: "system",
    subtype: "session_title_changed",
    session_id: native,
  });
  f.source.push({ type: "system", subtype: "init", session_id: native });
  expect(await f.process.waitForProviderSessionId()).toBe(native);
  expect(f.process.sessionId).toBe(f.saved.sessionId);
  expect(f.metadata.identities.resolveYa(f.saved.sessionId)?.native?.id).toBe(
    native,
  );
  f.source.push({
    type: "assistant",
    session_id: native,
    uuid: "answer",
    message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
  });
  await waitFor(() => expect(f.process.getMessageHistory()).toHaveLength(3));
  expect(
    f.process
      .getMessageHistory()
      .every((message) => message.session_id === f.saved.sessionId),
  ).toBe(true);
  expect(
    f.events.filter((event) => event.type === "session-id-changed"),
  ).toEqual([]);
  expect(
    f.events
      .filter((event) => event.type === "message")
      .every((event) => event.message.session_id === f.saved.sessionId),
  ).toBe(true);
  expect(
    f.metadata.identities.resolveYa(parseYaSessionId(native)),
  ).toBeUndefined();
});

it("does not confuse an optimistic echo or SDK queue pull with native input consumption", async () => {
  const f = await fixture();
  f.source.push({
    type: "system",
    subtype: "init",
    session_id: f.saved.sessionId,
  });
  await f.process.waitForProviderSessionId();
  expect(
    f.process.queueMessage({
      text: "exact prompt",
      uuid: f.saved.initialInputId!,
    }).success,
  ).toBe(true);
  expect((await f.queue[Symbol.asyncIterator]().next()).done).toBe(false);
  expect(f.store.assertCurrent(f.fence).attempt.delivery).toBe("not-admitted");
  f.source.push({
    type: "user",
    session_id: f.saved.sessionId,
    uuid: "some-other-user-input",
    message: { role: "user", content: "other" },
  });
  f.source.push({
    type: "user",
    session_id: f.saved.sessionId,
    uuid: f.saved.initialInputId!,
    message: { role: "user", content: "exact prompt" },
  });
  await waitFor(() =>
    expect(f.store.assertCurrent(f.fence).attempt.delivery).toBe("consumed"),
  );
  expect(
    f.process
      .getMessageHistory()
      .filter((message) => message.uuid === f.saved.initialInputId),
  ).toHaveLength(1);
});

it("refuses stale input before its optimistic echo and fences a late native binding", async () => {
  const f = await fixture();
  f.store.delete(f.fence);
  expect(f.process.queueMessage({ text: "must not appear" }).success).toBe(
    false,
  );
  expect(f.process.getMessageHistory()).toEqual([]);
  f.source.push({
    type: "system",
    subtype: "init",
    session_id: f.saved.sessionId,
  });
  await expect(f.process.waitForProviderSessionId()).rejects.toThrow(
    "no longer current",
  );
  expect(f.metadata.identities.resolveYa(f.saved.sessionId)?.native).toBeNull();
  expect(f.process.getMessageHistory()).toEqual([]);
});

it("uses a reattached native id without remapping and refuses a later native replacement", async () => {
  const native = "4cc19d0a-8e73-4bf3-a998-3017b2ba1e96";
  const f = await fixture(native);
  expect(await f.process.waitForProviderSessionId()).toBe(native);
  expect(f.process.sessionId).toBe(f.saved.sessionId);
  f.source.push({
    type: "system",
    subtype: "init",
    session_id: "different-native",
  });
  await waitFor(() =>
    expect(f.events.some((event) => event.type === "error")).toBe(true),
  );
  expect(f.process.queueMessage({ text: "must not send" }).success).toBe(false);
  expect(f.process.sessionId).toBe(f.saved.sessionId);
  expect(f.metadata.identities.resolveYa(f.saved.sessionId)?.native?.id).toBe(
    native,
  );
  expect(f.process.getMessageHistory()).toEqual([]);
});

async function supervisorFixture(
  installed = true,
  maxWorkers = 0,
  control?: { abort(): void | Promise<void>; isProcessAlive(): boolean },
) {
  const f = await storageFixture();
  const starts: string[] = [];
  const source = createControllableIterator();
  const queue = new MessageQueue();
  const provider: AgentProvider = {
    name: "claude",
    acceptsChosenSessionId: true,
    displayName: "Claude",
    supportsPermissionMode: true,
    supportsThinkingToggle: true,
    supportsSlashCommands: true,
    supportsSteering: false,
    initializesOnFirstMessage: true,
    isInstalled: async () => installed,
    isAuthenticated: async () => true,
    getAuthStatus: async () => ({
      installed,
      authenticated: true,
      enabled: true,
    }),
    getAvailableModels: async () => [],
    getNewSessionNamespace: async () => f.namespace,
    startSession: async (options) => {
      expect(f.store.getForSession(f.saved.sessionId)?.attempt.state).toBe(
        "dispatching",
      );
      starts.push(options.newSessionId!);
      return {
        iterator: source.iterator,
        queue,
        abort: control?.abort ?? source.finish,
        isProcessAlive: control?.isProcessAlive,
      };
    },
  };
  const supervisor = new Supervisor({
    provider,
    sessionMetadataService: f.metadata,
    maxWorkers,
  });
  cleanup.push(() => supervisor.stopBackgroundTasks());
  return { ...f, starts, source, queue, supervisor };
}

it("dispatches persisted text through Supervisor with a stable id and native confirmation", async () => {
  const f = await supervisorFixture();
  const pending = f.supervisor.startSavedSession(
    f.saved.attempt,
    async () => {},
  );
  const initial = await f.queue[Symbol.asyncIterator]().next();
  expect(initial.value).toMatchObject({ uuid: f.saved.initialInputId });
  expect(f.store.getForSession(f.saved.sessionId)?.attempt.delivery).toBe(
    "not-admitted",
  );
  f.source.push({
    type: "system",
    subtype: "init",
    session_id: f.saved.sessionId,
  });
  const process = await pending;
  if (!(process instanceof Process)) throw new Error("Expected a live process");
  cleanup.push(async () => {
    await process.abort();
  });
  f.source.push({
    type: "assistant",
    uuid: "native-response",
    user_message_uuid: f.saved.initialInputId!,
    session_id: f.saved.sessionId,
    message: { role: "assistant", content: "response" },
  });
  await waitFor(() =>
    expect(f.store.getForSession(f.saved.sessionId)?.attempt.delivery).toBe(
      "consumed",
    ),
  );
  expect(process.sessionId).toBe(f.saved.sessionId);
  expect(f.starts).toEqual([f.saved.sessionId]);
});

it("keeps unavailable startup durably failed with its source and prompt, without native effects", async () => {
  const f = await supervisorFixture(false);
  await expect(
    f.supervisor.startSavedSession(f.saved.attempt, async () => {}),
  ).rejects.toThrow("unavailable");
  const failed = f.store.getForSession(f.saved.sessionId)!;
  expect(failed.attempt).toMatchObject({
    state: "failed",
    delivery: "not-admitted",
    failure: "startup-unavailable",
  });
  expect(failed.request?.message).toBe("exact prompt");
  expect(failed.context.source).toEqual({
    kind: "request",
    provenance: { surface: "web" },
  });
  expect(f.starts).toEqual([]);
  expect(f.metadata.identities.resolveYa(f.saved.sessionId)?.native).toBeNull();
});

it("rechecks the attempt after asynchronous authorization before any provider launch", async () => {
  const f = await supervisorFixture();
  let release!: () => void;
  const authorization = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = f.supervisor.startSavedSession(
    f.saved.attempt,
    () => authorization,
  );
  f.store.delete(f.saved.attempt);
  release();
  await expect(pending).rejects.toThrow("no longer current");
  expect(f.starts).toEqual([]);
});

it("checks live authority again after launch preparation and refuses revocation before the native call", async () => {
  const f = await supervisorFixture();
  let checks = 0;
  await expect(
    f.supervisor.startSavedSession(f.saved.attempt, async () => {
      if (++checks === 3) throw new Error("Grant revoked during preparation");
    }),
  ).rejects.toThrow("Grant revoked during preparation");
  expect(f.starts).toEqual([]);
  expect(f.store.getForSession(f.saved.sessionId)?.attempt).toMatchObject({
    state: "uncertain",
    delivery: "uncertain",
  });
});

it("retains uncertainty when a bound provider exits without native input confirmation", async () => {
  const f = await fixture();
  f.source.push({
    type: "system",
    subtype: "init",
    session_id: f.saved.sessionId,
  });
  await f.process.waitForProviderSessionId();
  // An error-result echo may identify a send which failed delivery. A subagent
  // stamp is not the main session's input acknowledgement either.
  f.source.push({
    type: "result",
    subtype: "error_during_execution",
    user_message_uuid: f.saved.initialInputId!,
    session_id: f.saved.sessionId,
  });
  f.source.push({
    type: "assistant",
    parent_tool_use_id: "child-tool",
    user_message_uuid: f.saved.initialInputId!,
    session_id: f.saved.sessionId,
    message: { content: "child" },
  });
  f.source.finish();
  await waitFor(() =>
    expect(f.store.getForSession(f.saved.sessionId)?.attempt).toMatchObject({
      state: "uncertain",
      delivery: "uncertain",
    }),
  );
  expect(f.process.queueMessage({ text: "must not resend" }).success).toBe(
    false,
  );
  expect(f.metadata.identities.resolveYa(f.saved.sessionId)?.native?.id).toBe(
    f.saved.sessionId,
  );
});

it("keeps queued intent durable and records cancellation before returning", async () => {
  const f = await supervisorFixture(true, 1);
  const first = f.supervisor.startSavedSession(f.saved.attempt, async () => {});
  await f.queue[Symbol.asyncIterator]().next();
  f.source.push({
    type: "system",
    subtype: "init",
    session_id: f.saved.sessionId,
  });
  const process = await first;
  if (!(process instanceof Process)) throw new Error("Expected a live process");
  cleanup.push(async () => {
    await process.abort();
  });
  const next = f.store.admit({
    requestId: "queued_creation_2",
    context: f.saved.context,
    request: f.saved.request!,
  });
  const queued = await f.supervisor.startSavedSession(
    next.attempt,
    async () => {},
  );
  if (!("queued" in queued)) throw new Error("Expected queued creation");
  expect(f.store.getForSession(next.sessionId)?.attempt.state).toBe("queued");
  expect(f.supervisor.cancelQueuedRequest(queued.queueId)).toBe(true);
  expect(f.store.getForSession(next.sessionId)?.attempt).toMatchObject({
    state: "failed",
    failure: "cancelled",
  });
  expect(f.starts).toEqual([f.saved.sessionId]);
});

it("bounds outstanding admission promises and coalesces repeated queued attempts", async () => {
  const f = await supervisorFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let admitted = 0;
  const authorize = async () => {
    admitted++;
    await gate;
    throw new Error("Authority withdrawn before provider effects");
  };
  const saved = Array.from({ length: 17 }, (_, index) =>
    f.store.admit({
      requestId: `bounded_creation_${index}`,
      context: f.saved.context,
      request: f.saved.request!,
    }),
  );
  const pending = saved
    .slice(0, 16)
    .map((item) =>
      f.supervisor
        .startSavedSession(item.attempt, authorize)
        .catch((error: unknown) => error),
    );
  expect(admitted).toBe(16);
  const queued = await f.supervisor.startSavedSession(
    saved[16]!.attempt,
    authorize,
  );
  expect(queued).toMatchObject({ queued: true, position: 1 });
  expect(
    await f.supervisor.startSavedSession(saved[16]!.attempt, authorize),
  ).toEqual(queued);
  expect(f.supervisor.getQueueInfo()).toHaveLength(1);
  release();
  await Promise.all(pending);
  await waitFor(() =>
    expect(f.store.getForSession(saved[16]!.sessionId)?.attempt.state).toBe(
      "failed",
    ),
  );
  expect(f.starts).toEqual([]);
});

it.each([
  "conflicting-native",
  "native-api-error",
  "external-terminate",
  "external-abort",
])(
  "retains a consumed managed owner through pending/rejected teardown after %s",
  async (failure) => {
    let alive = true,
      failing = true;
    let rejectAbort!: (error: Error) => void;
    const heldAbort = new Promise<void>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const f = await supervisorFixture(true, 0, {
      abort: () => (failing ? heldAbort : undefined),
      isProcessAlive: () => alive,
    });
    const pending = f.supervisor.startSavedSession(
      f.saved.attempt,
      async () => {},
    );
    await f.queue[Symbol.asyncIterator]().next();
    f.source.push({
      type: "system",
      subtype: "init",
      session_id: f.saved.sessionId,
    });
    const process = await pending;
    if (!(process instanceof Process)) throw new Error("Expected live process");
    cleanup.push(async () => {
      failing = false;
      alive = false;
      f.source.finish();
      await process.abort();
    });
    f.source.push({
      type: "assistant",
      session_id: f.saved.sessionId,
      user_message_uuid: f.saved.initialInputId!,
      message: { content: "response" },
    });
    await waitFor(() =>
      expect(f.store.getForSession(f.saved.sessionId)?.attempt.delivery).toBe(
        "consumed",
      ),
    );
    const reentrant: Array<{ kind: string; success: boolean }> = [];
    process.subscribe((event) => {
      if (
        event.type === "provider-runtime-status-change" ||
        (event.type === "message" && event.message.isApiErrorMessage)
      ) {
        reentrant.push({
          kind: event.type,
          success: process.queueMessage({ text: "reentrant failure input" })
            .success,
        });
      }
    });
    if (failure === "external-abort")
      void process.abort().catch(() => undefined);
    else if (failure === "external-terminate")
      process.terminate("controlled external termination");
    else
      f.source.push(
        failure === "conflicting-native"
          ? {
              type: "system",
              subtype: "init",
              session_id: "conflicting-native",
            }
          : {
              type: "assistant",
              session_id: f.saved.sessionId,
              isApiErrorMessage: true,
              apiErrorStatus: 529,
              message: {
                model: "<synthetic>",
                content: "API Error: 529 Overloaded",
              },
            },
      );
    await waitFor(() =>
      expect(process.hasUnverifiedProviderOwnership).toBe(true),
    );
    expect(f.supervisor.getProcessForSession(f.saved.sessionId)).toBe(process);
    await expect(
      f.supervisor.resumeSession(f.saved.sessionId, f.root, {
        text: "must not replace",
      }),
    ).rejects.toThrow("teardown is in progress or unverified");
    rejectAbort(new Error("controlled provider abort rejection"));
    await waitFor(() =>
      expect(process.terminationReason).toContain("teardown failed"),
    );
    expect(process.hasUnverifiedProviderOwnership).toBe(true);
    expect(f.supervisor.getProcessForSession(f.saved.sessionId)).toBe(process);
    await expect(
      f.supervisor.resumeSession(f.saved.sessionId, f.root, {
        text: "still must not replace",
      }),
    ).rejects.toThrow("teardown is in progress or unverified");
    expect(f.starts).toEqual([f.saved.sessionId]);
    if (failure === "native-api-error") {
      expect(reentrant).toEqual([
        { kind: "provider-runtime-status-change", success: false },
        { kind: "message", success: false },
      ]);
      expect(process.getMessageHistory().some((m) => m.isApiErrorMessage)).toBe(
        true,
      );
    }
  },
);

it("closes ordinary and deferred admission before callbacks when a consumed managed iterator completes", async () => {
  const f = await fixture();
  f.source.push({
    type: "system",
    subtype: "init",
    session_id: f.saved.sessionId,
  });
  await f.process.waitForProviderSessionId();
  f.source.push({
    type: "assistant",
    session_id: f.saved.sessionId,
    user_message_uuid: f.saved.initialInputId!,
    message: { content: "response" },
  });
  await waitFor(() =>
    expect(f.store.assertCurrent(f.fence).attempt.delivery).toBe("consumed"),
  );
  expect(
    f.process.deferMessage({ text: "held before owner ends" }).success,
  ).toBe(true);
  const reentrant: boolean[] = [];
  f.process.subscribe((event) => {
    if (event.type === "state-change")
      reentrant.push(
        f.process.queueMessage({ text: "reentrant after stream end" }).success,
      );
  });
  f.source.finish();
  await waitFor(() => expect(f.process.isTerminated).toBe(true));
  expect(f.process.queueMessage({ text: "after completion" }).success).toBe(
    false,
  );
  expect(
    f.process.deferMessage({ text: "deferred after completion" }).success,
  ).toBe(false);
  expect(reentrant).not.toContain(true);
  expect(f.queue.depth).toBe(0);
  expect(
    f.process
      .getMessageHistory()
      .some((m) =>
        String(m.message?.content).includes("held before owner ends"),
      ),
  ).toBe(false);
  expect(f.store.assertCurrent(f.fence).attempt.delivery).toBe("consumed");
});

it("uses the canonical existing native directory leaf for allocation, reader proof and reverse binding", async () => {
  const f = await storageFixture();
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(f.root, "claude"));
  const provider = new ClaudeProvider();
  const absent = await provider.getNewSessionNamespace(f.root);
  const target = join(f.root, "physical-native-store");
  await mkdir(dirname(absent.storageScope), { recursive: true });
  await mkdir(target);
  await symlink(
    target,
    absent.storageScope,
    process.platform === "win32" ? "junction" : "dir",
  );
  const namespace = await provider.getNewSessionNamespace(f.root);
  expect(namespace.storageScope).toBe(await realpath(target));
  const fence = f.store.beginDispatch(f.saved.attempt, namespace);
  await writeFile(
    join(absent.storageScope, `${f.saved.sessionId}.jsonl`),
    "{}\n",
  );
  const reader = new ClaudeSessionReader({ sessionDir: absent.storageScope });
  const native = await reader.getNativeSessionRef(
    parseNativeSessionId(f.saved.sessionId),
  );
  expect(native?.storageScope).toBe(namespace.storageScope);
  expect(f.metadata.identities.canDiscoverNative(native!)).toBe(false);
  f.store.bindNative(fence, native!);
  expect(f.metadata.identities.lookupNative(native!)?.sessionId).toBe(
    f.saved.sessionId,
  );
});

async function retainedHostFixture(maxWorkers = 0) {
  const f = await storageFixture();
  const available = vi
    .spyOn(providerHost, "isProviderRuntimeHostAvailable")
    .mockReturnValue(true);
  cleanup.push(async () => {
    available.mockRestore();
  });
  const saved = f.store.admit({
    requestId: "retained-host",
    context: f.saved.context,
    request: {
      ...f.saved.request!,
      launch: { schemaVersion: 1, runtimeOwner: "host" },
    },
  });
  const fence = f.store.beginDispatch(saved.attempt, f.namespace);
  f.store.bindNative(fence, {
    ...f.namespace,
    id: parseNativeSessionId(saved.sessionId),
  });
  f.store.confirmOwnedInput(
    fence,
    { ...f.namespace, id: parseNativeSessionId(saved.sessionId) },
    saved.initialInputId!,
  );
  // Discovery may race owner loss; attachment must still recheck authority.
  const inventory = vi
    .spyOn(providerHost, "listHostedProviderRuntimes")
    .mockResolvedValue([
      {
        sessionId: saved.sessionId,
        state: "detached",
        creation: { identity: {}, initialInputConsumed: true },
      } as unknown as providerHost.HostedProviderRuntimeInfo,
    ]);
  cleanup.push(async () => inventory.mockRestore());
  let ownerAlive = true,
    allocations = 0,
    attaches = 0,
    commands = 0;
  const queues: MessageQueue[] = [];
  const provider: AgentProvider = {
    name: "claude",
    acceptsChosenSessionId: true,
    runtimeOwner: "host",
    displayName: "retained fixture",
    supportsPermissionMode: true,
    supportsThinkingToggle: true,
    supportsSlashCommands: true,
    supportsSteering: false,
    isInstalled: async () => true,
    isAuthenticated: async () => true,
    getAuthStatus: async () => ({
      installed: true,
      authenticated: true,
      enabled: true,
    }),
    getAvailableModels: async () => [],
    getNewSessionNamespace: async () => f.namespace,
    startSession: async (options) => {
      if (options.creationRuntime) {
        attaches++;
        await options.creationRuntime.authorize();
        if (!ownerAlive) throw new Error("Saved creation owner is unavailable");
        options.creationRuntime.observe({
          identity: options.creationRuntime.identity,
          nativeSessionId: parseNativeSessionId(saved.sessionId),
          initialInputConsumed: true,
        });
      } else allocations++;
      const source = createControllableIterator(),
        queue = new MessageQueue();
      queues.push(queue);
      const id = options.resumeSessionId ?? options.newSessionId!;
      return {
        iterator: source.iterator,
        queue,
        sessionId: id,
        initializedSessionId: id,
        initialTurnState: options.creationRuntime ? "idle" : "in-turn",
        abort: source.finish,
        runProviderCommand: async () => {
          commands++;
          return { handled: true, error: "unexpected compact dispatch" };
        },
      };
    },
  };
  const supervisor = new Supervisor({
    provider,
    sessionMetadataService: f.metadata,
    maxWorkers,
  });
  cleanup.push(async () => {
    for (const process of supervisor.getAllProcesses())
      await supervisor.abortProcess(process.id);
    await supervisor.stopBackgroundTasks();
  });
  return {
    ...f,
    saved,
    fence,
    supervisor,
    queues,
    loseOwner: () => {
      ownerAlive = false;
    },
    get allocations() {
      return allocations;
    },
    get attaches() {
      return attaches;
    },
    get commands() {
      return commands;
    },
  };
}

it.each(["survives", "lost"])(
  "preserves hosted ownership through deferred resume promotion (%s)",
  async (outcome) => {
    const f = await retainedHostFixture(1);
    const blocker = await f.supervisor.startSession(f.root, {
      text: "busy blocker",
    });
    expect(blocker).toBeInstanceOf(Process);
    const queued = await f.supervisor.resumeSession(f.saved.sessionId, f.root, {
      text: "accepted retained turn",
    });
    expect(queued).toMatchObject({ queued: true });
    if (outcome === "lost") f.loseOwner();
    await f.supervisor.abortProcess((blocker as Process).id);
    await waitFor(() => expect(f.attaches).toBe(1));
    if (outcome === "survives") {
      await waitFor(() =>
        expect(
          f.supervisor.getProcessForSession(f.saved.sessionId),
        ).toBeDefined(),
      );
      expect(
        f.supervisor
          .getProcessForSession(f.saved.sessionId)
          ?.getMessageHistory()
          .filter((row) => row.type === "user"),
      ).toHaveLength(1);
    } else {
      await waitFor(() => expect(f.supervisor.getQueueInfo()).toHaveLength(0));
      expect(
        f.supervisor.getProcessForSession(f.saved.sessionId),
      ).toBeUndefined();
    }
    expect(f.allocations).toBe(1); // Only the unrelated capacity blocker allocated.
  },
);

it("refuses hosted replacement and compact-first before disturbing the incumbent", async () => {
  const f = await retainedHostFixture();
  const process = await f.supervisor.reactivateSession(
    f.root,
    f.saved.sessionId,
  );
  expect(process.state.type).toBe("idle");
  await expect(
    f.supervisor.resumeSession(
      f.saved.sessionId,
      f.root,
      { text: "must not enter" },
      undefined,
      { effort: "high" },
    ),
  ).rejects.toThrow("cannot replace its provider owner");
  await expect(
    f.supervisor.reconfigureProcess(process.id, {
      thinking: { type: "enabled", budgetTokens: 1024 },
    }),
  ).rejects.toThrow("cannot replace its provider owner");
  await expect(
    f.supervisor.resumeSession(
      f.saved.sessionId,
      f.root,
      { text: "must not compact" },
      undefined,
      { resumeMode: "compact-first" },
    ),
  ).rejects.toThrow("requires retained-owner resume");
  expect(f.supervisor.getProcessForSession(f.saved.sessionId)).toBe(process);
  expect(process.isTerminated).toBe(false);
  expect(process.queueDepth).toBe(0);
  expect(f.attaches).toBe(1);
  expect(f.allocations).toBe(0);
  expect(f.commands).toBe(0);
});

it("refuses out-of-band native commands while startup is uncertain and reopens only after input proof", async () => {
  const nativeCommand = vi.fn(async () => ({ handled: true }));
  const f = await fixture(undefined, nativeCommand);
  f.source.push({
    type: "system",
    subtype: "init",
    session_id: f.saved.sessionId,
  });
  await f.process.waitForProviderSessionId();
  f.store.markUncertain(f.fence);
  expect(await f.process.runProviderCommand("compact")).toMatchObject({
    handled: true,
    error: expect.any(String),
  });
  expect(nativeCommand).not.toHaveBeenCalled();
  f.source.push({
    type: "assistant",
    session_id: f.saved.sessionId,
    user_message_uuid: f.saved.initialInputId!,
    message: { content: "confirmed" },
  });
  await waitFor(() =>
    expect(f.store.assertCurrent(f.fence).attempt.delivery).toBe("consumed"),
  );
  expect(await f.process.runProviderCommand("status")).toMatchObject({
    handled: true,
  });
  expect(nativeCommand).toHaveBeenCalledOnce();
});

it.each([
  ["reactivate", "continue"],
  ["resume", "continue"],
  ["reactivate", "stale-source"],
  ["resume", "deleted"],
  ["reactivate", "deleted-during-instructions"],
  ["resume", "deleted-during-instructions"],
  ["reactivate", "wrong-provider-id"],
  ["resume", "wrong-provider-id"],
] as const)(
  "cold %s preserves native/public identity (%s)",
  async (entry, outcome) => {
    const f = await storageFixture();
    const native = {
      ...f.namespace,
      id: parseNativeSessionId("native-cold-thread"),
    };
    const fence = f.store.beginDispatch(f.saved.attempt, f.namespace);
    f.store.bindNative(fence, native);
    f.store.confirmOwnedInput(fence, native, f.saved.initialInputId!);
    const source = createControllableIterator();
    const queue = new MessageQueue();
    const starts: import("../../src/sdk/providers/types.js").StartSessionOptions[] =
      [];
    const abort = vi.fn(source.finish);
    const provider = {
      name: "claude",
      acceptsChosenSessionId: true,
      displayName: "controlled native continuation",
      supportsNativeResumeSource: true,
      supportsPermissionMode: true,
      supportsThinkingToggle: true,
      supportsSlashCommands: true,
      supportsSteering: false,
      isInstalled: async () => true,
      isAuthenticated: async () => true,
      getAuthStatus: async () => ({
        installed: true,
        authenticated: true,
        enabled: true,
      }),
      getAvailableModels: async () => [],
      startSession: async (options) => {
        starts.push(options);
        return {
          iterator: source.iterator,
          queue,
          abort,
          sessionId: native.id,
          initializedSessionId:
            outcome === "wrong-provider-id" ? "wrong-native" : native.id,
        };
      },
    } satisfies AgentProvider;
    const resolve = vi.fn(async () => {
      if (outcome === "deleted") f.store.delete(fence);
      return {
        native:
          outcome === "stale-source"
            ? { ...native, storageScope: join(f.root, "wrong-scope") }
            : native,
        filePath: join(f.root, "native.jsonl"),
        projectId: toUrlProjectId(f.root),
      };
    });
    const supervisor = new Supervisor({
      provider,
      sessionMetadataService: f.metadata,
      resolveNativeSessionSource: resolve,
      getInstructionRestorationSettings: () => ({
        ...DEFAULT_INSTRUCTION_RESTORATION,
        providers: { claude: true },
      }),
      readInstructionHistory: async () => {
        if (outcome === "deleted-during-instructions") f.store.delete(fence);
        return [];
      },
    });
    cleanup.push(async () => {
      for (const process of supervisor.getAllProcesses())
        await supervisor.abortProcess(process.id);
      await supervisor.stopBackgroundTasks();
    });
    const launch =
      entry === "reactivate"
        ? supervisor.reactivateSession(f.root, f.saved.sessionId)
        : supervisor.resumeSession(
            f.saved.sessionId,
            f.root,
            {
              text: "later turn",
              uuid: "later-input",
            },
            undefined,
            undefined,
            { requireProviderSessionId: true },
          );
    if (outcome !== "continue") {
      await expect(launch).rejects.toThrow();
      expect(starts).toHaveLength(outcome === "wrong-provider-id" ? 1 : 0);
      expect(abort).toHaveBeenCalledTimes(
        outcome === "wrong-provider-id" ? 1 : 0,
      );
      expect(
        f.metadata.identities.resolveYa(f.saved.sessionId)?.native,
      ).toEqual(native);
      return;
    }
    const process = await launch;
    expect(process).toBeInstanceOf(Process);
    if (!(process instanceof Process)) throw new Error("Expected cold process");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      resumeSessionId: native.id,
      publicSessionId: f.saved.sessionId,
      nativeResumeSource: { native },
    });
    expect(starts[0]?.initialMessage).toBeUndefined();
    expect(process.sessionId).toBe(f.saved.sessionId);
    source.push({ type: "system", subtype: "init", session_id: native.id });
    source.push({
      type: "assistant",
      uuid: "cold-answer",
      session_id: native.id,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "continued" }],
      },
    });
    await waitFor(() =>
      expect(process.getMessageHistory()).toHaveLength(
        entry === "resume" ? 3 : 2,
      ),
    );
    expect(
      process
        .getMessageHistory()
        .every(
          (m) =>
            m.session_id === undefined || m.session_id === f.saved.sessionId,
        ),
    ).toBe(true);
    expect(f.metadata.identities.resolveYa(f.saved.sessionId)?.native).toEqual(
      native,
    );
    expect(f.store.getForSession(f.saved.sessionId)?.attempt.delivery).toBe(
      "consumed",
    );
  },
);
