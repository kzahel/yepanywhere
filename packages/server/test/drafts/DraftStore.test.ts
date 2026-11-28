import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openSqliteOrThrow,
  type SqliteDatabase,
} from "../../src/storage/sqlite.js";
import {
  migrateDiscoveryDatabase,
  discoveryMigrationPrefix,
} from "../../src/storage/discovery-sqlite.js";
import { DraftStore } from "../../src/drafts/DraftStore.js";
import {
  EMPTY_DRAFT,
  draftSlotKey,
  mergeDrafts,
  type DraftPayload,
  type DraftSlot,
  type DraftWrite,
  type StagedAttachmentRef,
} from "@yep-anywhere/shared";

const slot: DraftSlot = { kind: "new-session" };
const text = (value: string): DraftPayload => ({
  fields: value ? { text: value } : {},
  attachments: [],
});
let now: number, db: SqliteDatabase, store: DraftStore;
function save(
  value: string,
  owner = "",
  operationId = crypto.randomUUID(),
): DraftWrite {
  const read = store.read(owner, slot);
  return {
    slot,
    baseRevision: read.snapshot.revision,
    ticket: read.ticket,
    operationId,
    payload: text(value),
  };
}
beforeEach(() => {
  now = Date.now();
  db = openSqliteOrThrow(":memory:");
  migrateDiscoveryDatabase(db);
  store = new DraftStore(db, () => now);
});
afterEach(() => {
  store.close();
  db.close();
});
describe("draft snapshot transactions", () => {
  it("paginates changed rows while excluding earlier clears and other accounts", () => {
    for (let i = 0; i < 250; i++) {
      const slot = { kind: "session" as const, sessionId: `history-${i}` };
      const read = store.read("", slot);
      const saved = store.write("", {
        slot,
        baseRevision: null,
        ticket: read.ticket,
        operationId: `save-${i}`,
        payload: text("sent"),
      });
      store.write("", {
        slot,
        baseRevision: saved.snapshot.revision,
        ticket: saved.ticket,
        operationId: `clear-${i}`,
        payload: EMPTY_DRAFT,
      });
    }
    const since = store.sequence("");
    for (let i = 0; i < 105; i++) {
      const slot = { kind: "session" as const, sessionId: `new-${i}` };
      const read = store.read("", slot);
      store.write("", {
        slot,
        baseRevision: null,
        ticket: read.ticket,
        operationId: `new-${i}`,
        payload: text("new draft"),
      });
    }
    store.write("alice", save("private", "alice"));
    const first = store.list("", "", since);
    expect(first).toHaveLength(100);
    const second = store.list("", draftSlotKey(first[99]!.slot), since);
    expect(second).toHaveLength(5);
    expect(
      [...first, ...second].every((row) => row.sequence > since && !row.empty),
    ).toBe(true);
    expect(
      new Set([...first, ...second].map((row) => draftSlotKey(row.slot))).size,
    ).toBe(105);
    expect(store.list("alice", "", 0)).toHaveLength(1);
  });
  it("preserves draft data and retry receipts when adding the change index", () => {
    const historical = openSqliteOrThrow(":memory:");
    let previous: DraftStore | undefined;
    try {
      migrateDiscoveryDatabase(historical, discoveryMigrationPrefix(8));
      previous = new DraftStore(historical);
      const read = previous.read("", slot);
      const operation = {
        slot,
        baseRevision: null,
        ticket: read.ticket,
        operationId: "pre-migration",
        payload: text("retained draft"),
      };
      const accepted = previous.write("", operation);
      previous.close();
      migrateDiscoveryDatabase(historical);
      previous = new DraftStore(historical);
      expect(previous.write("", operation)).toEqual(accepted);
      expect(previous.read("", slot).snapshot).toEqual(accepted.snapshot);
      expect(previous.list("", "", 0)).toMatchObject([
        { revision: accepted.snapshot.revision },
      ]);
    } finally {
      previous?.close();
      historical.close();
    }
  });
  it("rejects stale writers, replays exact receipts, and never shares accounts", () => {
    const phone = save("phone"),
      desktop = save("desktop");
    const accepted = store.write("", phone);
    expect(accepted.outcome).toBe("accepted");
    expect(store.write("", desktop).outcome).toBe("conflict");
    expect(store.write("", phone)).toEqual(accepted);
    expect(store.read("alice", slot).snapshot.payload).toEqual(EMPTY_DRAFT);
    expect(store.write("alice", phone).outcome).toBe("expired");
    expect(() =>
      store.write("", { ...phone, payload: text("changed retry") }),
    ).toThrow("reused");
  });
  it("retains newer revisions through conditional clear and no-op saves", () => {
    store.write("", save("first"));
    const clear = save("");
    const newer = store.write("", save("next"));
    expect(store.write("", clear).outcome).toBe("conflict");
    expect(store.write("", save("next")).snapshot.revision).toBe(
      newer.snapshot.revision,
    );
  });
  it("does not resurrect a cleared draft after receipts and tombstones expire", () => {
    const original = save("old");
    store.write("", original);
    store.write("", save(""));
    now += 31 * 86_400_000;
    store.cleanup();
    expect(store.read("", slot).snapshot.revision).toBeNull();
    expect(store.write("", original).outcome).toBe("expired");
    expect(store.read("", slot).snapshot.payload).toEqual(EMPTY_DRAFT);
  });
  it("keeps bounded recovery and protects attachments through release grace", () => {
    const ref = { id: "a", batchId: "batch" } as StagedAttachmentRef;
    const first = save("attached");
    first.payload.attachments = [ref];
    store.write("", first);
    now += 10 * 86_400_000;
    store.cleanup();
    expect(store.protects("", "a")).toBe(true);
    const clear = save("");
    clear.recovery = true;
    store.write("", clear);
    expect(store.protects("", "a")).toBe(true);
    for (let i = 0; i < 10; i++)
      store.write("", { ...save(`version ${i}`), recovery: true });
    expect(store.recovery("", slot)).toHaveLength(5);
    now += 8 * 86_400_000;
    store.cleanup();
    expect(store.protects("", "a")).toBe(false);
    expect(store.recovery("", slot)).toEqual([]);
  });
  it("invalidates pre-deletion account tickets and keeps change cursors personal", () => {
    const old = store.read("alice", slot);
    store.deleteOwner("alice");
    const result = store.write("alice", {
      slot,
      baseRevision: null,
      ticket: old.ticket,
      operationId: "old-account",
      payload: { fields: { text: "old" }, attachments: [] },
    });
    expect(result.outcome).toBe("expired");
    expect(store.sequence("bob")).toBe(0);
    expect(store.read("alice", slot).snapshot.payload).toEqual(EMPTY_DRAFT);
  });
  it("persists receipts and revisions when the service owner is replaced", () => {
    const operation = save("durable");
    const accepted = store.write("", operation);
    store.close();
    store = new DraftStore(db, () => now);
    expect(store.write("", operation)).toEqual(accepted);
  });
  it("rolls back a rejected operation without advancing revision", () => {
    const first = store.write("", save("small"));
    expect(() => store.write("", save("x".repeat(300_000)))).toThrow("256 KiB");
    expect(store.read("", slot).snapshot.revision).toBe(
      first.snapshot.revision,
    );
  });
});
describe("conservative field reconciliation", () => {
  it("adopts one-sided changes and preserves both genuinely conflicting texts", () => {
    expect(mergeDrafts(text("base"), text("base"), text("remote"))).toEqual(
      text("remote"),
    );
    expect(mergeDrafts(text("base"), text("local"), text("remote"))).toEqual(
      text("remote\n\nlocal"),
    );
    expect(mergeDrafts(text("base"), text("base"), EMPTY_DRAFT)).toEqual(
      EMPTY_DRAFT,
    );
    expect(
      mergeDrafts(text("base"), text("offline edit"), EMPTY_DRAFT),
    ).toEqual(text("offline edit"));
  });
  it("does not resurrect removed attachments or combine unrelated answers", () => {
    const a = { id: "a" } as StagedAttachmentRef,
      b = { id: "b" } as StagedAttachmentRef;
    expect(
      mergeDrafts(
        { fields: {}, attachments: [a] },
        { fields: { answer1: "one" }, attachments: [a, b] },
        { fields: { answer2: "two" }, attachments: [] },
      ),
    ).toEqual({ fields: { answer1: "one", answer2: "two" }, attachments: [b] });
  });
});

it("retains a comment anchor when deletion conflicts with a remote text edit", () => {
  const meta = JSON.stringify({ id: "c", location: "file", quote: "line" });
  const merged = mergeDrafts(
    { fields: { "c/text": "before", "c/meta": meta }, attachments: [] },
    EMPTY_DRAFT,
    { fields: { "c/text": "edited", "c/meta": meta }, attachments: [] },
  );
  expect(merged.fields).toEqual({ "c/text": "edited", "c/meta": meta });
});
