import { afterEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { CoreApi } from "../../src/core-api/service.js";
import { SRPClientSession } from "tssrp6a";
import * as nacl from "../../src/crypto/nacl-wrapper.js";
import { SrpPeerTransport } from "../../src/peer-api/srp-client.js";
import {
  PeerChannelBudget,
  PEER_IDLE_MS,
  PEER_LIFETIME_MS,
  PEER_WIRE_BYTES,
  PEER_CHANNEL_MS,
} from "../../src/peer-api/srp-protocol.js";
import { protectedProfile } from "./peer-fixture.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function connection() {
  const a = await protectedProfile(cleanup),
    b = await protectedProfile(cleanup);
  const invitation = await b.manager.issue({
    sourceServerId: a.id,
    projects: ["p"],
    operations: ["projects", "sessions"],
    expiresAt: Date.now() + 600_000,
  });
  const budget = new PeerChannelBudget();
  cleanup.push(() => budget.close());
  const transport = new SrpPeerTransport(invitation, b.route, budget);
  const read = (
    operation: "projects" | "sessions",
    signal?: AbortSignal,
    operations?: string[],
  ) =>
    transport.request(
      operation,
      { serverId: b.id, signal },
      {
        sessionId: null,
        launchId: null,
        ...(operations ? { operations } : {}),
      },
    );
  return { a, b, transport, read, budget, invitation };
}

it("shares cold setup and a warm channel while authorizing and cancelling each request independently", async () => {
  const { b, read } = await connection();
  const crypto = vi.spyOn(SRPClientSession.prototype, "step1");
  expect(
    await Promise.all([read("projects"), read("sessions"), read("projects")]),
  ).toHaveLength(3);
  expect(crypto).toHaveBeenCalledTimes(1);
  const entered = deferred(),
    held = deferred();
  b.sources.projects = async () => {
    entered.resolve();
    await held.promise;
    return { items: [] };
  };
  const cancellation = new AbortController();
  const waiting = read("projects", cancellation.signal).catch(
    (error: unknown) => error,
  );
  try {
    await entered.promise;
    // A pending observation does not block a quick read or grant it another caller's rights.
    expect(await read("sessions")).toMatchObject({ items: [{ id: "parent" }] });
    await expect(
      read("projects", undefined, ["sessions"]),
    ).rejects.toMatchObject({ code: "forbidden" });
    cancellation.abort();
    expect(await waiting).toMatchObject({ code: "peer_unavailable" });
    expect(await read("sessions")).toMatchObject({ items: [{ id: "parent" }] });
    expect(crypto).toHaveBeenCalledTimes(1);
  } finally {
    held.resolve();
  }
});

it("bounds concurrent pending requests and frees cancelled slots without closing sibling reads", async () => {
  const { b, read } = await connection();
  // Negotiate all four sockets with quick reads before holding their full capacity.
  await Promise.all(Array.from({ length: 32 }, () => read("sessions")));
  let count = 0;
  const entered = deferred(),
    held = deferred();
  b.sources.projects = async () => {
    if (++count === 32) entered.resolve();
    await held.promise;
    return { items: [] };
  };
  const cancellations = Array.from({ length: 32 }, () => new AbortController());
  const waiting = cancellations.map((c) =>
    read("projects", c.signal).catch((error: unknown) => error),
  );
  try {
    await entered.promise;
    await expect(read("sessions")).rejects.toMatchObject({
      code: "command_capacity",
    });
    for (const c of cancellations) c.abort();
    expect(
      (await Promise.all(waiting)).every(
        (e) => (e as { code: string }).code === "peer_unavailable",
      ),
    ).toBe(true);
    await vi.waitFor(async () =>
      expect(await read("sessions")).toMatchObject({
        items: [{ id: "parent" }],
      }),
    );
  } finally {
    held.resolve();
  }
});

it("releases idle/lifetime sockets, reconnects only on demand, and fences a warm credential on revocation", async () => {
  const { b, read, invitation } = await connection();
  const crypto = vi.spyOn(SRPClientSession.prototype, "step1");
  const idle: (() => void)[] = [],
    lifetime: (() => void)[] = [];
  const original = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    // Deliver actual timer callbacks explicitly, keeping crypto and sockets on real scheduling.
    if (delay === PEER_IDLE_MS || delay === PEER_IDLE_MS - 5_000)
      idle.push(() => callback(...args));
    if (delay && delay > PEER_LIFETIME_MS - 15_000 && delay <= PEER_LIFETIME_MS)
      lifetime.push(() => callback(...args));
    return original(callback, delay, ...args);
  }) as typeof setTimeout);
  await read("projects");
  await vi.waitFor(() => expect(idle.length).toBeGreaterThanOrEqual(2));
  for (const expire of idle.splice(0)) expire();
  expect(crypto).toHaveBeenCalledTimes(1); // Expiry itself starts no reconnect.
  await read("projects");
  expect(crypto).toHaveBeenCalledTimes(2);
  for (const expire of lifetime.splice(0)) expire();
  await read("projects");
  expect(crypto).toHaveBeenCalledTimes(3);
  await b.manager.store.revokeIncoming(invitation.credentialId);
  await expect(read("sessions")).rejects.toMatchObject({
    code: expect.stringMatching(/^(unauthorized|peer_unavailable)$/),
  });
});

it("uses authenticated single-request fallback for concurrent calls to a legacy peer", async () => {
  const { read } = await connection();
  const encrypt = nacl.encryptToBinaryEnvelope;
  vi.spyOn(nacl, "encryptToBinaryEnvelope").mockImplementation(
    (plaintext, key) => {
      const value = JSON.parse(plaintext);
      // A real, correctly encrypted legacy reply without a reuse acknowledgement.
      if (value.msg?.type === "response")
        delete value.msg.headers["X-YA-Peer-Channel"];
      return encrypt(JSON.stringify(value), key);
    },
  );
  const crypto = vi.spyOn(SRPClientSession.prototype, "step1");
  expect(
    await Promise.all([read("projects"), read("sessions"), read("projects")]),
  ).toHaveLength(3);
  expect(crypto).toHaveBeenCalledTimes(4); // One safe capability probe, then three legacy calls.
  await read("sessions");
  expect(crypto).toHaveBeenCalledTimes(5);
});

it("keeps a shared handshake alive when one joining caller cancels", async () => {
  const { read } = await connection();
  const entered = deferred(),
    held = deferred();
  const original = SRPClientSession.prototype.step1;
  const crypto = vi
    .spyOn(SRPClientSession.prototype, "step1")
    .mockImplementationOnce(async function (this: SRPClientSession, ...args) {
      entered.resolve();
      await held.promise;
      return original.apply(this, args);
    });
  const cancellation = new AbortController();
  const first = read("projects", cancellation.signal).catch(
    (error: unknown) => error,
  );
  await entered.promise;
  const second = read("sessions");
  cancellation.abort();
  try {
    expect(await first).toMatchObject({ code: "peer_unavailable" });
    held.resolve();
    expect(await second).toMatchObject({ items: [{ id: "parent" }] });
    expect(crypto).toHaveBeenCalledTimes(1);
  } finally {
    held.resolve();
  }
});

it("negotiates before a cold slow operation so quick callers never wait behind it", async () => {
  const { b, read } = await connection();
  const entered = deferred(),
    held = deferred();
  b.sources.projects = async () => {
    entered.resolve();
    await held.promise;
    return { items: [] };
  };
  const crypto = vi.spyOn(SRPClientSession.prototype, "step1");
  const cancellation = new AbortController();
  const first = read("projects", cancellation.signal).catch(
    (error: unknown) => error,
  );
  await entered.promise;
  try {
    expect(await read("sessions")).toMatchObject({ items: [{ id: "parent" }] });
    cancellation.abort();
    expect(await first).toMatchObject({ code: "peer_unavailable" });
    expect(crypto).toHaveBeenCalledTimes(1);
  } finally {
    held.resolve();
  }
});

it("isolates a wire-inflated reply and local backpressure from already submitted siblings", async () => {
  const { b, read } = await connection();
  await read("sessions");
  const crypto = vi.spyOn(SRPClientSession.prototype, "step1");
  const entered = deferred(),
    held = deferred();
  const originalSessions = b.sources.sessions;
  b.sources.sessions = async (...args) => {
    entered.resolve();
    await held.promise;
    return originalSessions(...args);
  };
  const sibling = read("sessions");
  try {
    await entered.promise;
    b.sources.projects = async () => ({
      items: [{ id: "p", name: '"'.repeat(100_000), path: "/fixture/project" }],
    });
    await expect(read("projects")).rejects.toMatchObject({
      code: "peer_response_too_large",
    });
    const getter = Object.getOwnPropertyDescriptor(
      WebSocket.prototype,
      "bufferedAmount",
    )!.get!;
    const pressure = vi
      .spyOn(WebSocket.prototype, "bufferedAmount", "get")
      .mockImplementation(function (this: WebSocket) {
        return this.url ? PEER_WIRE_BYTES : getter.call(this);
      });
    await expect(read("projects")).rejects.toMatchObject({
      code: "command_capacity",
    });
    pressure.mockRestore();
    held.resolve();
    expect(await sibling).toMatchObject({ items: [{ id: "parent" }] });
    expect(await read("sessions")).toMatchObject({ items: [{ id: "parent" }] });
    expect(crypto).not.toHaveBeenCalled();
  } finally {
    held.resolve();
  }
});

it("retains cancelled handler reservations until ignored cancellation actually settles", async () => {
  const { read } = await connection();
  await read("sessions");
  const held = deferred(),
    entered = deferred();
  let work = 0,
    acknowledgements = 0;
  const original = CoreApi.prototype.read;
  vi.spyOn(CoreApi.prototype, "read").mockImplementation(async function (
    this: CoreApi,
    operation,
    ...args
  ) {
    if (operation === "projects") {
      if (++work === 8) entered.resolve();
      await held.promise;
    }
    return original.call(this, operation, ...args);
  });
  const encrypt = nacl.encryptToBinaryEnvelope;
  vi.spyOn(nacl, "encryptToBinaryEnvelope").mockImplementation(
    (plaintext, key) => {
      const value = JSON.parse(plaintext);
      if (value.msg?.type === "response" && value.msg.status === 503)
        acknowledgements++;
      return encrypt(plaintext, key);
    },
  );
  const controllers = Array.from({ length: 8 }, () => new AbortController());
  const pending = controllers.map((c) =>
    read("projects", c.signal).catch((error: unknown) => error),
  );
  try {
    await entered.promise;
    for (const c of controllers) c.abort();
    await Promise.all(pending);
    await vi.waitFor(() => expect(acknowledgements).toBe(8));
    for (let i = 0; i < 8; i++) {
      await expect(read("projects")).rejects.toMatchObject({
        code: "command_capacity",
      });
    }
    expect(work).toBe(8);
    held.resolve();
    await vi.waitFor(async () =>
      expect(await read("sessions")).toMatchObject({
        items: [{ id: "parent" }],
      }),
    );
  } finally {
    held.resolve();
  }
});

it("cannot publish a channel after transport close while fleet authority is pending", async () => {
  const { invitation, b, budget } = await connection();
  const entered = deferred(),
    held = deferred();
  const crypto = vi.spyOn(SRPClientSession.prototype, "step1");
  const transport = new SrpPeerTransport(invitation, b.route, budget, {
    assertActive() {},
    async token() {
      entered.resolve();
      await held.promise;
      return { token: "unused", expiresAt: Date.now() + 60_000 };
    },
  });
  const pending = transport.request(
    "projects",
    { serverId: b.id },
    { sessionId: null, launchId: null },
  );
  await entered.promise;
  transport.close();
  held.resolve();
  await expect(pending).rejects.toMatchObject({ code: "peer_unavailable" });
  expect(crypto).not.toHaveBeenCalled();
});

it("allows a cancel acknowledgement a full grace period when a request reaches its deadline", async () => {
  const { b, read } = await connection();
  await read("sessions");
  const crypto = vi.spyOn(SRPClientSession.prototype, "step1");
  const firstEntered = deferred(),
    siblingEntered = deferred(),
    held = deferred(),
    ackEntered = deferred();
  b.sources.projects = async () => {
    firstEntered.resolve();
    await held.promise;
    return { items: [] };
  };
  const originalSessions = b.sources.sessions;
  b.sources.sessions = async (...args) => {
    siblingEntered.resolve();
    await held.promise;
    return originalSessions(...args);
  };
  let ack: unknown, releaseAck: (() => void) | undefined;
  const encrypt = nacl.encryptToBinaryEnvelope;
  vi.spyOn(nacl, "encryptToBinaryEnvelope").mockImplementation(
    (plaintext, key) => {
      const frame = encrypt(plaintext, key),
        value = JSON.parse(plaintext);
      if (value.msg?.type === "response" && value.msg.status === 503)
        ack = frame;
      return frame;
    },
  );
  const send = WebSocket.prototype.send;
  vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
    this: WebSocket,
    ...args: Parameters<WebSocket["send"]>
  ) {
    if (args[0] === ack) {
      releaseAck = () => send.apply(this, args);
      ackEntered.resolve();
    } else send.apply(this, args);
  });
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout"],
    shouldClearNativeTimers: true,
  });
  const cancellation = new AbortController();
  const first = read("projects", cancellation.signal).catch(
    (error: unknown) => error,
  );
  let sibling: Promise<unknown> | undefined;
  try {
    await firstEntered.promise;
    await vi.advanceTimersByTimeAsync(1000);
    sibling = read("sessions");
    await siblingEntered.promise;
    await vi.advanceTimersByTimeAsync(PEER_CHANNEL_MS - 1001);
    cancellation.abort();
    expect(await first).toMatchObject({ code: "peer_unavailable" });
    await ackEntered.promise;
    // Cross the original request deadline while its acknowledgement is still held.
    await vi.advanceTimersByTimeAsync(2);
    held.resolve();
    releaseAck!();
    expect(await sibling).toMatchObject({ items: [{ id: "parent" }] });
    expect(crypto).not.toHaveBeenCalled();
  } finally {
    held.resolve();
    vi.useRealTimers();
    await Promise.allSettled([first, ...(sibling ? [sibling] : [])]);
  }
});
