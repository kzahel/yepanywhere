import { seedHistoricalReceiptAlias } from "../support/legacy-session-aliases.js";
import { expect, it, vi } from "vitest";
import { openSqliteOrThrow } from "../../src/storage/sqlite.js";
import { migrateDiscoveryDatabase } from "../../src/storage/discovery-sqlite.js";
import { ApiReceiptStore } from "../../src/core-api/receipt-store.js";
import {
  SessionCommands,
  type SessionCommandOwner,
} from "../../src/core-api/session-commands.js";
import { sendMessageRequest } from "../../src/core-api/command-contracts.js";
import { CoreApi } from "../../src/core-api/service.js";
import { SUPERUSER } from "../../src/auth/principal.js";

const session = {
  id: "target",
  projectId: "p",
  provider: "codex",
  title: null,
  updatedAt: "",
  state: "in-turn",
};
const launch = { id: "parent", launchId: "launch", management: true as const };
const input = sendMessageRequest.parse({
  requestId: "follow-up-001",
  message: "Give the result",
});
function fixture(owner: SessionCommandOwner) {
  const database = openSqliteOrThrow(":memory:");
  migrateDiscoveryDatabase(database);
  const store = new ApiReceiptStore(database);
  let enabled = true;
  const commands = new SessionCommands("A", store, owner, () => enabled);
  const core = new CoreApi("A", {
    commands,
    projects: async () => ({ items: [] }),
    providers: async () => [],
    sessions: async () => ({ items: [session] }),
  });
  return {
    database,
    store,
    commands,
    core,
    disable() {
      enabled = false;
    },
    close() {
      commands.close();
      store.close();
      database.close();
    },
  };
}

it("binds retry identity to native input, follows consumption, and preserves receipts when an owner stops", async () => {
  let running = true,
    sends = 0;
  let consumed = () => {},
    ended = () => {};
  const f = fixture({
    async start() {
      return { rejected: true };
    },
    canSend: () => running,
    send(_id, _request, _receipt, onConsumed, onEnded) {
      sends++;
      consumed = onConsumed;
      ended = onEnded;
      return { accepted: true };
    },
  });
  try {
    const [first, retry] = await Promise.all([
      f.core.call("sendMessage", SUPERUSER, {
        serverId: "A",
        sessionId: "target",
        body: input,
        launch,
      }),
      f.core.call("sendMessage", SUPERUSER, {
        sessionId: "target",
        body: input,
        launch,
      }),
    ]);
    expect(first).toMatchObject({
      state: "accepted",
      delivery: "unknown",
      completion: "unknown",
      kind: "sendMessage",
      creator: { sessionId: "parent" },
    });
    const id = (first as { id: string }).id;
    expect(retry).toHaveProperty("id", id);
    expect(sends).toBe(1);
    await expect(
      f.core.call("sendMessage", SUPERUSER, {
        sessionId: "target",
        body: { ...input, message: "different" },
        launch,
      }),
    ).rejects.toMatchObject({ code: "request_id_conflict", status: 409 });
    const initial = await f.commands.follow(id, { waitMs: "0" });
    const waiting = f.commands.follow(id, {
      after: initial.cursor,
      waitMs: "4000",
    });
    consumed();
    expect(await waiting).toMatchObject({
      changed: true,
      receipt: { id, delivery: "consumed", completion: "unknown" },
    });
    const final = await f.commands.follow(id, { waitMs: "0" });
    consumed();
    expect(
      await f.commands.follow(id, { after: final.cursor, waitMs: "0" }),
    ).toEqual({ cursor: final.cursor, changed: false, receipt: null });
    running = false;
    ended();
    expect(
      await f.core.call("sendMessage", SUPERUSER, {
        sessionId: "target",
        body: input,
        launch,
      }),
    ).toMatchObject({ id, delivery: "consumed" });
    await expect(
      f.core.call("sendMessage", SUPERUSER, {
        sessionId: "target",
        body: { ...input, requestId: "follow-up-002" },
        launch,
      }),
    ).rejects.toMatchObject({ code: "session_not_running", status: 409 });
    await expect(
      f.core.call("sendMessage", SUPERUSER, {
        sessionId: "target",
        body: input,
        launch: { id: "parent", launchId: "read-only" },
      }),
    ).rejects.toMatchObject({ status: 403 });
  } finally {
    f.close();
  }
});

it("keeps stronger consumption evidence after a late admission error", async () => {
  const f = fixture({
    async start() {
      return { rejected: true };
    },
    canSend: () => true,
    send(_id, _request, _receipt, consumed) {
      consumed();
      throw new Error("response lost after input consumption");
    },
  });
  try {
    const receipt = await f.core.call("sendMessage", SUPERUSER, {
      sessionId: "target",
      body: input,
      launch,
    });
    expect(receipt).toMatchObject({
      state: "accepted",
      delivery: "consumed",
      completion: "unknown",
    });
    expect(receipt).not.toHaveProperty("failure");
  } finally {
    f.close();
  }
});

it("marks missing consumption uncertain after owner loss/restart and releases receipt waits on abort/close", async () => {
  let ended = () => {};
  const owner: SessionCommandOwner = {
    async start() {
      return { rejected: true };
    },
    canSend: () => true,
    send(_id, _request, _receipt, _consumed, onEnded) {
      ended = onEnded;
      return { accepted: true };
    },
  };
  const f = fixture(owner);
  try {
    const receipt = f.commands.send(session, input, launch);
    ended();
    expect(f.store.get(receipt.id)).toMatchObject({
      state: "accepted",
      delivery: "uncertain",
      failure: { code: "delivery_uncertain" },
    });
    const restarted = new SessionCommands("A", f.store, owner, () => true);
    expect(
      restarted.replaySend("target", input, {
        ...launch,
        launchId: "replacement",
      }),
    ).toMatchObject({ id: receipt.id, delivery: "uncertain" });
    const first = await restarted.follow(receipt.id, { waitMs: "0" });
    const abort = new AbortController();
    const waiting = restarted.follow(
      receipt.id,
      { after: first.cursor },
      abort.signal,
    );
    abort.abort();
    await expect(waiting).rejects.toMatchObject({ status: 503 });
    const closing = restarted.follow(receipt.id, { after: first.cursor });
    restarted.close();
    await expect(closing).rejects.toMatchObject({ status: 503 });
    await expect(f.commands.follow("missing", {})).rejects.toMatchObject({
      status: 404,
    });
  } finally {
    f.close();
  }
});

it("replays after target alias changes without repeating input and publishes committed remaps", async () => {
  let sends = 0;
  const f = fixture({
    async start() {
      return { rejected: true };
    },
    canSend: () => true,
    send() {
      sends++;
      return { accepted: true };
    },
  });
  try {
    const first = f.commands.send(session, input, launch);
    const initial = await f.commands.follow(first.id, {});
    const waiting = f.commands.follow(first.id, { after: initial.cursor });
    seedHistoricalReceiptAlias(f.store, "target", "canonical-target");
    expect(await waiting).toMatchObject({
      changed: true,
      receipt: { sessionId: "canonical-target" },
    });
    expect(
      f.commands.send({ ...session, id: "canonical-target" }, input, launch).id,
    ).toBe(first.id);
    expect(sends).toBe(1);
  } finally {
    f.close();
  }
});

it("bounds receipt observers, releases aborted capacity, and keeps a newer subscribed publication over a stale initial read", async () => {
  const f = fixture({
    async start() {
      return { rejected: true };
    },
    canSend: () => true,
    send: () => ({ accepted: true }),
  });
  const abort = new AbortController();
  try {
    const receipt = f.commands.send(session, input, launch);
    const initial = await f.commands.follow(receipt.id, { waitMs: "0" });
    const waits = Array.from({ length: 128 }, () =>
      f.commands
        .follow(receipt.id, { after: initial.cursor }, abort.signal)
        .catch((error) => error),
    );
    await Promise.resolve();
    await Promise.resolve();
    await expect(
      f.commands.follow(receipt.id, { after: initial.cursor }),
    ).rejects.toMatchObject({ status: 503 });
    abort.abort();
    expect(
      (await Promise.all(waits)).every((error) => error.status === 503),
    ).toBe(true);
    expect(
      await f.commands.follow(receipt.id, {
        after: initial.cursor,
        waitMs: "0",
      }),
    ).toMatchObject({ changed: false });
    const get = f.store.get.bind(f.store);
    const spy = vi.spyOn(f.store, "get").mockImplementationOnce((id) => {
      const stale = get(id);
      f.store.update(id, { delivery: "consumed" });
      return stale;
    });
    // Exercise the subscribe-before-read primitive without reconciliation reads.
    const { followReceipt } = await import(
      "../../src/core-api/receipt-follow.js"
    );
    expect(
      await followReceipt(
        f.store,
        receipt.id,
        { after: initial.cursor },
        new AbortController().signal,
      ),
    ).toMatchObject({ changed: true, receipt: { delivery: "consumed" } });
    spy.mockRestore();
  } finally {
    abort.abort();
    f.close();
  }
});
