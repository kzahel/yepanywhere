import { createConnection } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { MessageQueue } from "../../../src/sdk/messageQueue.js";
import type { SDKMessage } from "../../../src/sdk/types.js";
import { createAgentctlSessionEnvBridge } from "../../../src/sdk/providers/agentctl-session-env.js";
import { parseCreationRuntimeIdentity } from "../../../src/sdk/providers/creation-runtime-identity.js";
import { ProviderSessionOwner } from "../../../src/sdk/providers/provider-session-owner.js";
import { ProviderRuntimeSocketAdapter } from "../../../src/sdk/providers/provider-runtime-socket-adapter.js";

const identity = () =>
  parseCreationRuntimeIdentity({
    version: 1,
    sessionId: "public-session",
    creationId: "operation",
    attemptId: "attempt",
    generation: 1,
    nativeNamespace: { family: "claude", storageScope: tmpdir() },
    nativeSessionId: "native-session",
    initialInputId: "initial-input",
  });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(abortBarrier?: Promise<void>) {
  const events = new PassThrough({ objectMode: true });
  const queue = new MessageQueue();
  const processed: SDKMessage[] = [];
  async function* output() {
    for await (const message of events) {
      yield message as SDKMessage;
      processed.push(message as SDKMessage);
    }
  }
  const supervisor: Record<string, unknown>[] = [];
  const controller: Record<string, unknown>[] = [];
  const bridge = createAgentctlSessionEnvBridge("public-session");
  const owner = new ProviderSessionOwner({
    runtimeId: "owned-runtime",
    emitSupervisor: (message) =>
      supervisor.push(message as Record<string, unknown>),
  });
  owner.setCreationIdentity({ ...identity(), token: "never-retain" });
  await owner.start(async () => ({
    session: {
      iterator: output(),
      queue,
      abort: async () => {
        await abortBarrier;
        events.destroy();
      },
    },
    agentctlSessionEnvBridge: bridge,
  }));
  cleanups.push(() => owner.shutdown("test complete"));
  owner.attach(
    "first",
    "controller-one",
    (message) => controller.push(message as Record<string, unknown>),
    { creation: identity() },
  );
  owner.begin();
  return { owner, events, queue, supervisor, controller, bridge, processed };
}

it("retains scoped binding/input proof through detach, acknowledgement and replay without another input", async () => {
  const { owner, events, queue, controller, supervisor, bridge, processed } =
    await fixture();
  queue.push({ text: "saved input", uuid: "initial-input" });
  await queue[Symbol.asyncIterator]().next();
  expect(owner.creationEvidence()?.initialInputConsumed).toBe(false);
  // Title telemetry may precede init; native binding must already be evidence.
  events.write({
    type: "system",
    subtype: "session_title",
    session_id: "native-session",
  });
  await expect
    .poll(() => owner.creationEvidence()?.nativeSessionId)
    .toBe("native-session");
  expect(owner.creationEvidence()?.initialInputConsumed).toBe(false);
  owner.detach("first");
  await expect(
    owner.handleControllerRequest("first", { type: "ack", sequence: 0 }),
  ).rejects.toThrow("Stale");
  events.write({
    type: "result",
    subtype: "error_during_execution",
    session_id: "native-session",
    user_message_uuid: "initial-input",
  });
  events.write({
    type: "assistant",
    session_id: "native-session",
    parent_tool_use_id: "child",
    user_message_uuid: "initial-input",
  });
  events.write({
    type: "assistant",
    session_id: "native-session",
    user_message_uuid: "other-input",
  });
  events.write({
    type: "assistant",
    session_id: "native-session",
    user_message_uuids: Array(65).fill("initial-input"),
  });
  await expect.poll(() => processed.length).toBe(5);
  expect(
    supervisor.filter((row) => row.type === "creationEvidence"),
  ).toHaveLength(1);
  expect(owner.creationEvidence()?.initialInputConsumed).toBe(false);
  events.write({
    type: "assistant",
    session_id: "native-session",
    user_message_uuid: "initial-input",
  });
  await expect
    .poll(() => owner.creationEvidence()?.initialInputConsumed)
    .toBe(true);
  const resumed: Record<string, unknown>[] = [];
  const state = owner.attach(
    "second",
    "controller-two",
    (message) => resumed.push(message as Record<string, unknown>),
    { creation: identity() },
  );
  expect(state).toMatchObject({
    protocolVersion: 2,
    providerSessionId: "native-session",
    creation: { identity: identity(), initialInputConsumed: true },
  });
  expect(JSON.stringify(state)).not.toContain("never-retain");
  const sequence = Math.max(
    ...resumed
      .filter((row) => row.type === "event")
      .map((row) => Number(row.sequence)),
  );
  await owner.handleControllerRequest("second", { type: "ack", sequence });
  owner.detach("second");
  const next: Record<string, unknown>[] = [];
  owner.attach(
    "third",
    "controller-three",
    (message) => next.push(message as Record<string, unknown>),
    { creation: identity() },
  );
  expect(next.filter((row) => row.type === "event")).toHaveLength(0);
  expect(next[0]).toMatchObject({ creation: { initialInputConsumed: true } });
  expect(queue.depth).toBe(0);
  expect(controller.filter((row) => row.type === "event")).toHaveLength(1);
  await expect(
    owner.handleControllerRequest("third", {
      type: "rpc",
      id: 1,
      method: "publishAgentctlSessionId",
      args: ["native-session"],
    }),
  ).rejects.toThrow("YA session id");
  expect(
    await readFile(join(bridge.directory, "agentctl-session.env"), "utf8"),
  ).toContain("public-session");
  expect(
    await readFile(join(bridge.directory, "agentctl-session.env"), "utf8"),
  ).not.toContain("native-session");
});

it("rejects stale attach before replay or replacing a controller", async () => {
  const { owner, events, controller } = await fixture();
  events.write({
    type: "system",
    subtype: "init",
    session_id: "native-session",
  });
  await expect
    .poll(() => controller.filter((row) => row.type === "event").length)
    .toBe(1);
  owner.detach("first");
  for (const creation of [
    undefined,
    { ...identity(), generation: 2 },
    { ...identity(), initialInputId: "wrong" },
    {
      ...identity(),
      nativeNamespace: {
        family: "claude",
        storageScope: join(tmpdir(), "other"),
      },
    },
  ]) {
    const replay: unknown[] = [];
    expect(() =>
      owner.attach(
        "stale",
        "new-controller",
        (message) => replay.push(message),
        { creation },
      ),
    ).toThrow("creation identity");
    expect(replay).toHaveLength(0);
  }
  expect(
    owner.attach("current", "current-controller", () => {}, {
      creation: identity(),
    }).providerSessionId,
  ).toBe("native-session");
});

it.each(["conflict", "native-api-error", "complete"])(
  "closes input before failure publication and retains native proof (%s)",
  async (mode) => {
    let releaseAbort!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });
    const { owner, events, controller } = await fixture(barrier);
    cleanups.push(async () => {
      releaseAbort();
    });
    events.write({
      type: "system",
      subtype: "init",
      session_id: "native-session",
    });
    await expect
      .poll(() => owner.creationEvidence()?.nativeSessionId)
      .toBe("native-session");
    if (mode === "complete") events.end();
    else if (mode === "conflict")
      events.write({
        type: "system",
        subtype: "init",
        session_id: "other-native",
      });
    else
      events.write({
        type: "assistant",
        session_id: "native-session",
        isApiErrorMessage: true,
      });
    await expect
      .poll(() =>
        controller.some(
          (row) =>
            row.type === "failed" ||
            row.type === "complete" ||
            (row.type === "event" &&
              (row.message as SDKMessage).isApiErrorMessage),
        ),
      )
      .toBe(true);
    await expect(
      owner.handleControllerRequest("first", {
        type: "queuePush",
        message: { text: "must refuse" },
      }),
    ).rejects.toThrow("owner has ended");
    expect(owner.creationEvidence()).toMatchObject({
      nativeSessionId: "native-session",
      initialInputConsumed: false,
    });
  },
);

it.skipIf(!["linux", "darwin"].includes(process.platform))(
  "refuses protocol-1 and forged protocol-2 sockets before managed replay",
  async () => {
    const { owner } = await fixture();
    owner.detach("first");
    const root = await mkdtemp(
      join(process.platform === "darwin" ? "/tmp" : tmpdir(), "ya-csock-"),
    );
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const path = join(root, "worker.sock");
    const adapter = new ProviderRuntimeSocketAdapter(path, "secret", owner);
    await adapter.listen();
    cleanups.push(() => adapter.close());
    const attach = (protocolVersion: number, creation: unknown) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const socket = createConnection(path);
        socket.setEncoding("utf8");
        socket.on("error", reject);
        let data = "";
        socket.on("data", (chunk) => {
          data += chunk;
          if (data.includes("\n")) {
            resolve(JSON.parse(data.split("\n")[0]!));
            socket.destroy();
          }
        });
        socket.on("connect", () =>
          socket.write(
            JSON.stringify({
              type: "attach",
              token: "secret",
              generation: "new-controller",
              protocolVersion,
              creation,
            }) + "\n",
          ),
        );
      });
    expect(await attach(1, undefined)).toMatchObject({
      type: "error",
      error: "Incompatible provider worker protocol",
    });
    expect(
      await attach(2, { ...identity(), attemptId: "old-attempt" }),
    ).toMatchObject({
      type: "error",
      error: "Provider worker creation identity does not match",
    });
    expect(await attach(2, identity())).toMatchObject({
      type: "attached",
      protocolVersion: 2,
      creation: { identity: identity() },
    });
  },
);

it("closes admission when public publication fails and retains the real session for cleanup", async () => {
  let aborted = false;
  const owner = new ProviderSessionOwner({ runtimeId: "failed-publication" });
  owner.setCreationIdentity(identity());
  cleanups.push(() => owner.shutdown("failed-publication cleanup"));
  await expect(
    owner.start(async () => ({
      session: {
        queue: new MessageQueue(),
        iterator: (async function* () {})(),
        publishAgentctlSessionId: () => {
          throw new Error("publication refused");
        },
        abort: () => {
          aborted = true;
        },
      },
    })),
  ).rejects.toThrow("publication refused");
  expect(aborted).toBe(false);
  expect(
    owner.attach("controller", "generation", () => {}, { creation: identity() })
      .providerAlive,
  ).toBe(false);
  await expect(
    owner.handleControllerRequest("controller", {
      type: "queuePush",
      message: { text: "must refuse" },
    }),
  ).rejects.toThrow("owner has ended");
  await owner.shutdown("verify retained startup owner");
  expect(aborted).toBe(true);
});
