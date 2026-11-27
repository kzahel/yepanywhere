import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiAttachmentUploads } from "../../src/core-api/attachment-uploads.js";
import { ProjectStoragePolicy } from "../../src/projects/projectStoragePolicy.js";
import { SessionQueuePersistenceService } from "../../src/services/SessionQueuePersistenceService.js";
import { runIdleSweeps } from "../../src/lib/processIdleSweep.js";
import {
  Process,
  MessageQueue,
  createControllableIterator,
  waitFor,
  withSessionQueuePersistence,
  type UrlProjectId,
} from "../process.test-support.js";
import { openSqliteOrThrow } from "../../src/storage/sqlite.js";
import { migrateDiscoveryDatabase } from "../../src/storage/discovery-sqlite.js";
import { ApiReceiptStore } from "../../src/core-api/receipt-store.js";
import { SessionCommands } from "../../src/core-api/session-commands.js";
import { nativeSessionCommandOwner } from "../../src/core-api/native-session-commands.js";
import { CoreApi } from "../../src/core-api/service.js";
import { apiSessionState } from "../../src/core-api/owned-sessions.js";
import { SUPERUSER } from "../../src/auth/principal.js";
import type { ApiReceipt } from "../../src/core-api/command-contracts.js";
import type { ApiPendingInput } from "../../src/core-api/input-contracts.js";
import type { SDKMessage } from "../../src/sdk/types.js";

const controllers: ReturnType<typeof createControllableIterator>[] = [];
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of controllers.splice(0)) c.finish();
  for (const close of cleanup.splice(0).reverse()) await close();
});

const launch = { id: "parent", launchId: "launch", management: true as const };

function fixture(
  options: {
    provider?: "codex" | "claude";
    commands?: string[];
    persistence?: SessionQueuePersistenceService;
    running?: boolean;
    attachmentUploads?: ApiAttachmentUploads;
    attachmentStoragePolicy?: ProjectStoragePolicy;
    commandsGate?: () => Promise<void>;
  } = {},
) {
  const c = createControllableIterator();
  controllers.push(c);
  const queue = new MessageQueue();
  const run = vi.fn(async () => ({ handled: options.provider !== "claude" }));
  const process = new Process(c.iterator, {
    projectPath: "/test",
    projectId: "p" as UrlProjectId,
    sessionId: "target",
    provider: options.provider ?? "codex",
    queue,
    runProviderCommandFn: run,
    supportedCommandsFn: async () => {
      await options.commandsGate?.();
      return (options.commands ?? ["compact"]).map((name) => ({
        name,
        description: name,
      }));
    },
    sessionQueuePersistenceService: options.persistence,
    abortFn: async () => c.finish(),
    interruptFn: async () => true,
    idleTimeoutMs: 60_000,
  });
  const database = openSqliteOrThrow(":memory:");
  migrateDiscoveryDatabase(database);
  const store = new ApiReceiptStore(database);
  const running = options.running ?? true;
  let enabled = true;
  const commands = new SessionCommands(
    "A",
    store,
    nativeSessionCommandOwner({
      supervisor: {
        startSession: async () => {
          throw new Error("Unexpected launch");
        },
        getAllProcesses: () => (running ? [process] : []),
        getProcessForSession: (id) =>
          running && id === "target" ? process : undefined,
      },
      sessionQueuePersistenceService: options.persistence,
      attachmentStoragePolicy: options.attachmentStoragePolicy,
      globalInstructions: () => undefined,
    }),
    () => enabled,
    undefined,
    undefined,
    options.attachmentUploads,
  );
  const core = new CoreApi("A", {
    commands,
    projects: async () => ({ items: [] }),
    providers: async () => [],
    sessions: async () => ({
      items: [
        {
          id: "target",
          projectId: "p",
          provider: options.provider ?? "codex",
          title: null,
          updatedAt: "",
          state: "in-turn",
        },
      ],
    }),
  });
  cleanup.push(async () => {
    commands.close();
    await commands.idle();
    store.close();
    database.close();
  });
  const event = async (message: SDKMessage) => {
    const marker = Math.random();
    let resolve!: () => void;
    const seen = new Promise<void>((r) => (resolve = r));
    const off = process.subscribe((e) => {
      if (e.type === "message" && e.message.marker === marker) resolve();
    });
    c.push({ ...message, marker, session_id: "target" });
    await seen;
    off();
    await Promise.resolve();
  };
  const call = (operation: Parameters<CoreApi["call"]>[0], input = {}) =>
    core.call(operation, SUPERUSER, { sessionId: "target", launch, ...input });
  const create = (requestId: string, body: Record<string, unknown>) =>
    call("createInput", { body: { requestId, ...body } }) as Promise<
      ApiReceipt & { requestedSessionId: string }
    >;
  const list = async () =>
    ((await call("inputs")) as { items: ApiPendingInput[] }).items;
  const cancel = (requestId: string, inputId: string) =>
    call("cancelInput", {
      inputId,
      body: { requestId },
    }) as Promise<ApiReceipt>;
  return {
    process,
    queue,
    run,
    store,
    event,
    create,
    list,
    cancel,
    commands,
    receipt: (receiptId: string) =>
      call("receipt", { receiptId }) as Promise<ApiReceipt>,
    disable: () => {
      enabled = false;
    },
  };
}

it("queues compaction then a follow-up through YA's queue and reports the compaction outcome", async () => {
  const f = fixture();
  const compact = await f.create("compact-0001", {
    type: "compact",
    instructions: "keep decisions",
  });
  expect(compact).toMatchObject({
    kind: "input",
    state: "accepted",
    delivery: "unknown",
    completion: "unknown",
    input: { type: "compact", delivery: "deferred", status: "queued" },
  });
  const follow = await f.create("follow-0001", {
    type: "prompt",
    text: "FOLLOW_UP",
  });
  expect(follow.input).toEqual({
    type: "prompt",
    delivery: "deferred",
    status: "queued",
  });
  // Nothing reached the provider during the active turn.
  expect(f.queue.depth).toBe(0);
  expect(await f.list()).toMatchObject([
    {
      id: compact.id,
      receiptId: compact.id,
      type: "compact",
      status: "queued",
      cancellable: true,
      text: "/compact keep decisions",
      creator: { origin: "coordination", sourceSessionId: "parent" },
    },
    { id: follow.id, type: "prompt", text: "FOLLOW_UP", cancellable: true },
  ]);

  await f.event({ type: "result" });
  await waitFor(() =>
    expect(f.run).toHaveBeenCalledWith("compact", "keep decisions"),
  );
  await waitFor(() =>
    expect(f.store.get(compact.id)?.input?.compaction).toBe("compacting"),
  );
  expect(apiSessionState(f.process)).toBe("compacting");
  expect((await f.list())[0]).toMatchObject({
    status: "compacting",
    cancellable: false,
  });
  await expect(f.cancel("cancel-0001", compact.id)).rejects.toMatchObject({
    code: "input_not_cancellable",
    status: 409,
  });

  await f.event({ type: "system", subtype: "compact_boundary" });
  await f.event({ type: "result" });
  await waitFor(() =>
    expect(f.store.get(compact.id)).toMatchObject({
      delivery: "consumed",
      completion: "compacted",
      input: { status: "released", compaction: "compacted" },
    }),
  );
  await waitFor(() => expect(f.queue.depth).toBe(1));
  expect(f.queue.drain()[0]?.text).toBe("FOLLOW_UP");
  expect(f.store.get(follow.id)?.input?.status).toBe("released");
  expect(apiSessionState(f.process)).not.toBe("compacting");
  expect(await f.list()).toEqual([]);
});

it("reports a failed compaction, holds later input, and releases it when the compaction is cancelled", async () => {
  const f = fixture();
  const compact = await f.create("compact-0002", { type: "compact" });
  const follow = await f.create("follow-0002", {
    type: "prompt",
    text: "NEXT",
    delivery: "patient",
  });
  await f.event({ type: "result" });
  await waitFor(() => expect(f.run).toHaveBeenCalledWith("compact", ""));
  await f.event({ type: "error", error: "compact refused" });
  await f.event({ type: "result" });
  await waitFor(() =>
    expect(f.store.get(compact.id)).toMatchObject({
      completion: "failed",
      input: { compaction: "failed" },
      failure: { code: "compaction_failed", message: "compact refused" },
    }),
  );
  expect(await f.list()).toMatchObject([
    { id: compact.id, status: "failed", cancellable: true },
    { id: follow.id, delivery: "patient", status: "queued" },
  ]);
  expect(f.queue.depth).toBe(0);
  const cancelled = await f.cancel("cancel-0002", compact.id);
  expect(cancelled).toMatchObject({ kind: "cancelInput" });
  await waitFor(() =>
    expect(f.store.get(cancelled.id)).toMatchObject({
      state: "accepted",
      result: { cancelled: true, inputId: compact.id },
    }),
  );
  expect(f.store.get(compact.id)).toMatchObject({
    delivery: "cancelled",
    completion: "failed",
    input: { status: "cancelled" },
  });
  await waitFor(() => expect(f.queue.depth).toBe(1));
  expect(f.queue.drain()[0]?.text).toBe("NEXT");
});

it("cancels queued prompts, refuses unknown ids and unsupported compaction before any receipt", async () => {
  const f = fixture({ provider: "claude", commands: [] });
  await expect(
    f.create("compact-0003", { type: "compact" }),
  ).rejects.toMatchObject({ code: "compaction_unsupported", status: 409 });
  await expect(
    f.create("steer-compact", { type: "compact", delivery: "steer" }),
  ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
  const queued = await f.create("prompt-0003", {
    type: "prompt",
    text: "LATER",
  });
  expect(f.store.get(queued.id)?.input?.status).toBe("queued");
  await expect(f.cancel("cancel-0003", "missing")).rejects.toMatchObject({
    code: "input_not_pending",
    status: 409,
  });
  const cancelled = await f.cancel("cancel-0004", queued.id);
  await waitFor(() =>
    expect(f.store.get(cancelled.id)?.result).toEqual({
      cancelled: true,
      inputId: queued.id,
    }),
  );
  expect(f.store.get(queued.id)).toMatchObject({
    delivery: "cancelled",
    input: { status: "cancelled" },
  });
  // The identical retry replays the receipt instead of failing on absence.
  expect((await f.cancel("cancel-0004", queued.id)).id).toBe(cancelled.id);
  await f.event({ type: "result" });
  expect(f.queue.depth).toBe(0);
  expect(await f.list()).toEqual([]);
  // Owner loss after cancellation does not turn it into uncertain delivery.
  await f.process.abort();
  expect(f.store.get(queued.id)?.delivery).toBe("cancelled");
});

it("marks a cancelled unconsumed steer cancelled, and an interrupted compaction uncertain", async () => {
  const f = fixture();
  // No steering hook: the steer waits in the provider queue, unconsumed.
  const steer = await f.create("steer-0001", {
    type: "prompt",
    text: "NOW",
    delivery: "steer",
  });
  expect(f.store.get(steer.id)?.input?.status).toBe("released");
  expect(f.queue.depth).toBe(1);
  const cancelled = await f.cancel("cancel-steer", steer.id);
  await waitFor(() =>
    expect(f.store.get(cancelled.id)?.state).toBe("accepted"),
  );
  expect(f.queue.depth).toBe(0);
  expect(f.store.get(steer.id)).toMatchObject({
    delivery: "cancelled",
    input: { status: "cancelled" },
  });
  expect(f.store.get(steer.id)?.failure).toBeUndefined();

  const compact = await f.create("compact-ended", { type: "compact" });
  await f.event({ type: "result" });
  await waitFor(() =>
    expect(f.store.get(compact.id)?.input?.compaction).toBe("compacting"),
  );
  await f.process.abort();
  await waitFor(() =>
    expect(f.store.get(compact.id)).toMatchObject({
      delivery: "uncertain",
      failure: { code: "delivery_uncertain" },
    }),
  );
});

it("refuses input whose command authority ends during admission, without queueing it", async () => {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const f = fixture({ commandsGate: () => gate });
  const pending = f.create("revoked-0001", { type: "compact" });
  await Promise.resolve();
  f.disable();
  open();
  await expect(pending).rejects.toMatchObject({ status: 403 });
  expect(await f.list()).toEqual([]);
  expect(f.store.get("revoked-0001")).toBeUndefined();
});

it("lists and cancels a restart-paused patient item without a running process", async () => {
  await withSessionQueuePersistence(async ({ service, projectId }) => {
    const now = new Date().toISOString();
    await service.upsertItem({
      id: "persisted-1",
      sessionId: "target",
      projectId,
      projectPath: "/test",
      provider: "claude",
      kind: "patient",
      message: {
        text: "RESUME ME",
        tempId: "composer-temp-1",
        metadata: { deliveryIntent: "patient", origin: "user" },
      },
      createdAt: now,
      updatedAt: now,
      queuedAt: now,
      status: "paused-after-restart",
    });
    const f = fixture({ persistence: service, running: false });
    expect(await f.list()).toMatchObject([
      {
        id: "composer-temp-1",
        receiptId: null,
        type: "prompt",
        delivery: "patient",
        status: "paused-after-restart",
        cancellable: true,
        text: "RESUME ME",
        creator: { origin: "user" },
      },
    ]);
    await expect(
      f.create("stopped-0001", { type: "prompt", text: "x" }),
    ).rejects.toMatchObject({ code: "session_not_running" });
    const cancelled = await f.cancel("cancel-0005", "composer-temp-1");
    await waitFor(() =>
      expect(f.store.get(cancelled.id)?.result).toEqual({
        cancelled: true,
        inputId: "composer-temp-1",
      }),
    );
    expect(service.listSession("target")).toEqual([]);
  });
});

it("claims compaction only from its own confirmed outcome, not consumed command text or drains", async () => {
  const f = fixture({ provider: "claude" });
  const compact = await f.create("compact-claude", { type: "compact" });
  await f.event({ type: "result" });
  await waitFor(() => expect(f.queue.depth).toBe(1));
  // Claude consumes /compact, but no compact boundary has been observed.
  const input = f.queue.generator();
  await input.next();
  expect(await f.receipt(compact.id)).toMatchObject({
    delivery: "unknown",
    completion: "unknown",
  });
  await input.return();

  const g = fixture();
  const drained = await g.create("compact-drain", { type: "compact" });
  await g.event({ type: "result" });
  await waitFor(() =>
    expect(g.store.get(drained.id)?.input?.compaction).toBe("compacting"),
  );
  g.process.drainDeferredMessages();
  // Removal without its own confirmed outcome is not success.
  expect(g.store.get(drained.id)).toMatchObject({
    delivery: "unknown",
    completion: "unknown",
    input: { status: "queued", compaction: "compacting" },
  });
  await g.process.abort();
  await waitFor(() =>
    expect(g.store.get(drained.id)?.delivery).toBe("uncertain"),
  );
  expect(g.store.get(drained.id)?.completion).not.toBe("compacted");
});

it("keeps input queued when an interrupt drains and requeues it", async () => {
  const f = fixture();
  const compact = await f.create("compact-int", { type: "compact" });
  const prompt = await f.create("prompt-int", {
    type: "prompt",
    text: "AFTER",
  });
  expect(await f.process.interrupt()).toBe(true);
  expect(f.queue.depth).toBe(0);
  expect((await f.list()).map((item) => item.id)).toEqual([
    compact.id,
    prompt.id,
  ]);
  expect(f.store.get(prompt.id)?.input?.status).toBe("queued");
  expect(f.store.get(compact.id)?.input?.status).toBe("queued");
});

it("steers exact text without provider-command translation and releases observers on shutdown", async () => {
  const f = fixture();
  const listeners = (f.process as unknown as { listeners: Set<unknown> })
    .listeners;
  const baseline = listeners.size;
  await f.create("steer-slash", {
    type: "prompt",
    text: "/compact",
    delivery: "steer",
  });
  expect(f.run).not.toHaveBeenCalled();
  expect(f.queue.drain()[0]?.text).toBe("/compact");
  await f.create("queued-close", { type: "prompt", text: "LATER" });
  await f.create("compact-close", { type: "compact" });
  expect(listeners.size).toBeGreaterThan(baseline);
  f.commands.close();
  expect(listeners.size).toBe(baseline);
});

it("keeps consumed input released when unrelated queued input is cancelled", async () => {
  const f = fixture();
  const first = await f.create("joined-1", { type: "prompt", text: "ONE" });
  const second = await f.create("joined-2", { type: "prompt", text: "TWO" });
  // Interrupt joins both into one provider turn.
  expect(await f.process.interrupt()).toBe(true);
  expect(f.queue.depth).toBe(1);
  const input = f.queue.generator();
  await input.next();
  await input.return();
  await waitFor(() =>
    expect(f.store.get(second.id)?.delivery).toBe("consumed"),
  );
  const later = await f.create("joined-3", { type: "prompt", text: "THREE" });
  await f.cancel("cancel-later", later.id);
  await waitFor(() =>
    expect(f.store.get(later.id)?.delivery).toBe("cancelled"),
  );
  for (const id of [first.id, second.id])
    expect(f.store.get(id)).toMatchObject({
      delivery: "consumed",
      input: { status: "released" },
    });
});

it("keeps a restart-paused patient attachment after its reusable staged ID expires", async () => {
  const root = await mkdtemp(join(tmpdir(), "ya-v0-patient-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  let now = Date.now();
  const uploads = new ApiAttachmentUploads(root, undefined, () => now);
  const persistence = new SessionQueuePersistenceService({ dataDir: root });
  await persistence.initialize();
  const f = fixture({
    persistence,
    attachmentUploads: uploads,
    attachmentStoragePolicy: new ProjectStoragePolicy({
      dataDir: root,
      getMode: () => "app-data",
    }),
  });
  const bytes = Buffer.from("file survives the staging lifetime");
  const creator = f.commands.creator(launch);
  const uploaded = await uploads.upload(
    creator,
    "p",
    "patient-file-upload",
    0,
    {
      name: "patient.txt",
      mimeType: "text/plain",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      data: bytes.toString("base64"),
    },
    () => {},
  );
  const body = {
    type: "prompt",
    text: "",
    delivery: "patient",
    attachmentIds: [uploaded.attachmentId],
  };
  const receipt = await f.create("patient-file-message", body);
  expect(receipt).toMatchObject({
    state: "accepted",
    input: { status: "queued" },
  });
  expect(persistence.listSession("target")).toHaveLength(1);
  now = Date.parse(uploaded.expiresAt) + 1;
  runIdleSweeps(now);
  await uploads.idle();
  expect(await f.create("patient-file-message", body)).toMatchObject({
    id: receipt.id,
  });
  await expect(f.create("patient-file-new-key", body)).rejects.toMatchObject({
    code: "attachment_not_found",
  });
  const reopened = new SessionQueuePersistenceService({ dataDir: root });
  await reopened.initialize();
  const [paused] = reopened.listSession("target");
  expect(paused).toMatchObject({ status: "paused-after-restart" });
  const [file] = paused?.message.attachments ?? [];
  expect(await readFile(file!.path)).toEqual(bytes);
  expect(f.queue.depth).toBe(0);
});
