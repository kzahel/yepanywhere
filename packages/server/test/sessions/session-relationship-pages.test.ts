import { describe, expect, it, vi } from "vitest";
import { nativeSessionRef, parseNativeSessionId } from "@yep-anywhere/shared";
import {
  SessionRelationshipStore,
  type RelationshipFact,
  type RelationshipResource,
} from "../../src/sessions/SessionRelationshipStore.js";
import {
  RelationshipPageError,
  SessionRelationshipPages,
} from "../../src/sessions/session-relationship-pages.js";
import { migrateDiscoveryDatabase } from "../../src/storage/discovery-sqlite.js";
import { openSqliteOrThrow } from "../../src/storage/sqlite.js";

const anchor: RelationshipResource = {
  kind: "session",
  serverId: "local",
  sessionId: "parent",
};
const native: RelationshipResource = {
  kind: "native",
  serverId: "local",
  native: nativeSessionRef(
    "codex",
    "/private/native/store",
    parseNativeSessionId("parent"),
  ),
};
function fixture(count: number) {
  const database = openSqliteOrThrow(":memory:");
  migrateDiscoveryDatabase(database);
  const store = new SessionRelationshipStore(database);
  const facts: RelationshipFact[] = Array.from({ length: count }, (_, i) => ({
    type: "launched_harness",
    source: i % 2 === 0 ? anchor : native,
    target: { kind: "session", serverId: "local", sessionId: `child-${i}` },
    recordKey: `call-${i}`,
    trust: "command-observed",
    metadata: { toolUseId: `call-${i}` },
  }));
  const observation = {
    producer: "owned-fixture",
    sourceKey: "/private/transcript",
    sourceVersion: "private-version",
    extractorVersion: 1,
    observedAt: "2026-11-06T00:00:00Z",
  };
  for (let offset = 0; offset < facts.length; offset += 200)
    store.record(observation, facts.slice(offset, offset + 200));
  const access = {
    anchor: () => true,
    endpoint: (resource: RelationshipResource) =>
      resource.kind === "session" ? resource.sessionId : "parent",
    evidence: () => "observed",
  };
  return {
    database,
    store,
    access,
    input: {
      source: () => store,
      resources: [anchor, native],
      binding: "owner",
      access,
    },
    [Symbol.dispose]() {
      store.dispose();
      database.close();
    },
  };
}

describe("authorized relationship pages", () => {
  it("fills pages across hidden rows and resumes at the last returned edge, without exposing raw progress", async () => {
    using f = fixture(570);
    const visible = (id: string) => Number(id.slice(6)) % 3 === 0;
    const access = {
      ...f.access,
      endpoint: (resource: RelationshipResource) => {
        const id = f.access.endpoint(resource);
        return id === "parent" || visible(id) ? id : undefined;
      },
    };
    const pages = new SessionRelationshipPages();
    const actual: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await pages.read({ ...f.input, access, limit: 13, cursor });
      expect(page.relationships.length).toBeLessThanOrEqual(13);
      actual.push(...page.relationships.map((edge) => edge.target));
      const json = JSON.stringify(page);
      for (const privateValue of [
        "/private/",
        "scanAfter",
        "withheld",
        "sourceVersion",
        "sourceKey",
      ])
        expect(json).not.toContain(privateValue);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const statement = f.database.prepare(
      "SELECT target FROM session_relationship_edges WHERE active = 1 ORDER BY id",
    );
    try {
      const expected = statement
        .all<{ target: string }>()
        .map((row) => JSON.parse(row.target)[2] as string)
        .filter(visible);
      expect(actual).toEqual(expected);
      expect(new Set(actual).size).toBe(actual.length);
    } finally {
      statement.finalize();
    }
  });

  it("authenticates cursor contents and binds principal, exact namespace, query, expiry and process lifetime", async () => {
    using f = fixture(30);
    let now = 10_000;
    const pages = new SessionRelationshipPages(() => now);
    const first = await pages.read({ ...f.input, limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    const cursor = first.nextCursor!;
    const next = await pages.read({ ...f.input, cursor, limit: 1 });
    expect(next.relationships).toHaveLength(1);
    expect(next.relationships[0]).not.toEqual(first.relationships[0]);
    const bytes = Buffer.from(cursor, "base64url");
    bytes[35] = bytes[35]! ^ 1;
    for (const input of [
      { ...f.input, cursor: bytes.toString("base64url") },
      { ...f.input, cursor, binding: "other-principal" },
      { ...f.input, cursor, direction: "incoming" as const },
      { ...f.input, cursor, type: "provider_child" as const },
      { ...f.input, cursor, resources: [anchor] },
    ])
      await expect(pages.read(input)).rejects.toMatchObject({
        code: "invalid_cursor",
      });
    await expect(
      new SessionRelationshipPages(() => now).read({
        ...f.input,
        cursor,
      }),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
    now += 10 * 60_000;
    await expect(pages.read({ ...f.input, cursor })).rejects.toMatchObject({
      code: "invalid_cursor",
    });
  });

  it("returns the same authorized empty page for hidden evidence and no stored relationships", async () => {
    using hidden = fixture(50);
    using empty = fixture(0);
    const page = await new SessionRelationshipPages().read({
      ...hidden.input,
      access: { ...hidden.access, evidence: () => undefined },
    });
    expect(page).toEqual(
      await new SessionRelationshipPages().read(empty.input),
    );
    expect(page).toEqual({ relationships: [], nextCursor: null });
  });

  it("fails a bounded scan without issuing a cursor or an incomplete empty result", async () => {
    using f = fixture(2_100);
    const list = vi.spyOn(f.store, "list");
    await expect(
      new SessionRelationshipPages().read({
        ...f.input,
        access: { ...f.access, endpoint: () => undefined },
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    // Two exact anchor reads for each of ten 200-edge batches.
    expect(list).toHaveBeenCalledTimes(20);
  });

  it("checks authority before opening SQL and discards accumulated rows when authority changes at a yield", async () => {
    using f = fixture(450);
    let allowed = false;
    const getStore = vi.fn(() => f.store);
    const access = { ...f.access, anchor: () => allowed };
    const pages = new SessionRelationshipPages();
    await expect(
      pages.read({ ...f.input, source: getStore, access }),
    ).rejects.toBeInstanceOf(RelationshipPageError);
    expect(getStore).not.toHaveBeenCalled();
    allowed = true;
    await expect(
      pages.read({
        ...f.input,
        source: getStore,
        access: {
          ...access,
          endpoint: () => {
            queueMicrotask(() => {
              allowed = false;
            });
            return undefined;
          },
        },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(getStore).toHaveBeenCalledTimes(1);
  });

  it("rechecks a different endpoint's permission before returning a page collected across yields", async () => {
    using f = fixture(450);
    // An independent SQL oracle chooses visible rows in different batches.
    const statement = f.database.prepare(
      "SELECT target FROM session_relationship_edges ORDER BY id",
    );
    let ordered: string[];
    try {
      ordered = statement
        .all<{ target: string }>()
        .map((row) => JSON.parse(row.target)[2]);
    } finally {
      statement.finalize();
    }
    const first = ordered[0]!,
      lookahead = ordered[400]!;
    let firstAllowed = true;
    const access = {
      ...f.access,
      endpoint: (resource: RelationshipResource) => {
        const id = f.access.endpoint(resource);
        if (id === "parent") return id;
        if (id === first && firstAllowed) {
          queueMicrotask(() => {
            firstAllowed = false;
          });
          return id;
        }
        return id === lookahead ? id : undefined;
      },
    };
    await expect(
      new SessionRelationshipPages().read({
        ...f.input,
        access,
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
});
