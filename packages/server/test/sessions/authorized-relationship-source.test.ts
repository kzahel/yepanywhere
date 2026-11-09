import { describe, expect, it, vi } from "vitest";
import {
  nativeSessionRef,
  parseNativeSessionId,
  parseYaSessionId,
} from "@yep-anywhere/shared";
import { AuthorizedRelationshipSource } from "../../src/sessions/authorized-relationship-source.js";
import { SessionRelationshipPages } from "../../src/sessions/session-relationship-pages.js";
import { SessionIdentityStore } from "../../src/sessions/SessionIdentityStore.js";
import {
  SessionRelationshipStore,
  relationshipResourceKey,
  type RelationshipResource,
} from "../../src/sessions/SessionRelationshipStore.js";
import { migrateDiscoveryDatabase } from "../../src/storage/discovery-sqlite.js";
import { openSqliteOrThrow } from "../../src/storage/sqlite.js";
import { encodeProjectId } from "../../src/projects/paths.js";
import { writeStoredMetadata } from "../utils/session-metadata-database.js";

const visible = encodeProjectId("/visible"),
  hidden = encodeProjectId("/hidden");
const parent: RelationshipResource = {
  kind: "session",
  serverId: "local",
  sessionId: "parent",
};
const native: RelationshipResource = {
  kind: "native",
  serverId: "local",
  native: nativeSessionRef(
    "codex",
    "/private/native",
    parseNativeSessionId("parent"),
  ),
};
const observation = {
  producer: "owned",
  sourceKey: "/private/source",
  sourceVersion: "version",
  extractorVersion: 1,
  observedAt: "2026-11-06T00:00:00Z",
};
const endpoint = (r: RelationshipResource) =>
  r.kind === "session" ? r.sessionId : r.native.id;
function fixture() {
  const db = openSqliteOrThrow(":memory:");
  migrateDiscoveryDatabase(db);
  const identities = new SessionIdentityStore(db),
    store = new SessionRelationshipStore(db);
  const admit = (id: string, projectId = visible) =>
    identities.allocateWithinTransaction({
      sessionId: parseYaSessionId(id),
      projectId,
      provider: "codex",
      createdAt: observation.observedAt,
    });
  db.transaction(() => admit("parent"));
  db.transaction(() =>
    identities.bindWithinTransaction(parseYaSessionId("parent"), native.native),
  );
  let creators = false;
  const source = new AuthorizedRelationshipSource(db, () => store);
  const scoped = source.scoped(() => ({
    serverId: "local",
    projects: [visible],
    creators,
  }));
  const pages = new SessionRelationshipPages();
  const read = () =>
    pages.read({
      source: () => scoped,
      resources: [parent, native],
      binding: "viewer",
      access: { anchor: () => true, endpoint, evidence: () => "visible proof" },
    });
  return {
    db,
    store,
    identities,
    source,
    pages,
    read,
    admit,
    allowCreators: () => {
      creators = true;
    },
    [Symbol.dispose]() {
      source.dispose();
      store.dispose();
      identities.close();
      db.close();
    },
  };
}
describe("SQL-authorized relationship selection", () => {
  it("seeks the exact anchor and keyset range in both directions and reuses one statement", async () => {
    using f = fixture();
    const prepare = vi.spyOn(f.db, "prepare");
    await f.read();
    await f.read();
    const queries = prepare.mock.calls.filter(([sql]) =>
      sql.includes("outgoing AS"),
    );
    expect(queries).toHaveLength(1);
    const explain = f.db.prepare(`EXPLAIN QUERY PLAN ${queries[0]![0]}`);
    try {
      const details = explain
        .all<{ detail: string }>(
          relationshipResourceKey(parent),
          "",
          "both",
          null,
          "local",
          0,
          JSON.stringify([visible]),
          0,
          201,
        )
        .map((row) => row.detail);
      for (const [index, column] of [
        ["outgoing", "source"],
        ["incoming", "target"],
      ])
        expect(
          details.some((detail) =>
            new RegExp(
              `SEARCH e USING INDEX session_relationship_${index}.*${column}=\\?.*id>\\?`,
            ).test(detail),
          ),
        ).toBe(true);
      expect(details.some((detail) => /SCAN e\b/.test(detail))).toBe(false);
    } finally {
      explain.finalize();
    }
  });

  it("filters thousands of hidden targets before LIMIT and follows working-project overlays and creator policy", async () => {
    using f = fixture();
    for (let offset = 0; offset < 2_100; offset += 100) {
      f.db.transaction(() => {
        const facts = Array.from({ length: 100 }, (_, i) => {
          const id = `child-${offset + i}`;
          f.admit(id, hidden);
          return {
            type: "launched_harness" as const,
            source: i % 2 ? native : parent,
            target: {
              kind: "session" as const,
              serverId: "local",
              sessionId: id,
            },
            recordKey: id,
            trust: "command-observed" as const,
          };
        });
        f.store.recordWithinTransaction(observation, facts);
      });
    }
    expect(await f.read()).toEqual({ relationships: [], nextCursor: null });
    // The identity's original project stays hidden; its existing overlay is the
    // current grant resource, exactly as ordinary session routing uses it.
    writeStoredMetadata(f.db, { "child-2099": { workingProjectId: visible } });
    const page = await f.read();
    expect(page.relationships.map((r) => r.target)).toEqual(["child-2099"]);
    expect(page.nextCursor).toBeNull();
    f.store.record(observation, [
      {
        type: "created_session",
        source: parent,
        target: { kind: "session", serverId: "local", sessionId: "child-2099" },
        recordKey: "receipt",
        trust: "local-authenticated",
      },
    ]);
    expect((await f.read()).relationships).toHaveLength(1);
    f.allowCreators();
    expect((await f.read()).relationships).toHaveLength(2);
  });

  it("keeps unbound native children parent-scoped, requiring provider evidence and a unique parent", async () => {
    using f = fixture();
    const child: RelationshipResource = {
      kind: "native",
      serverId: "local",
      native: nativeSessionRef(
        "codex",
        "/private/native",
        parseNativeSessionId("child"),
      ),
    };
    f.store.record(observation, [
      {
        type: "provider_child",
        source: native,
        target: child,
        recordKey: "unproved",
        trust: "command-observed",
      },
    ]);
    expect((await f.read()).relationships).toEqual([]);
    f.store.record(observation, [
      {
        type: "provider_child",
        source: native,
        target: child,
        recordKey: "proved",
        trust: "provider-observed",
      },
    ]);
    expect((await f.read()).relationships.map((r) => r.target)).toEqual([
      "child",
    ]);
    const other: RelationshipResource = {
      kind: "native",
      serverId: "local",
      native: nativeSessionRef(
        "codex",
        "/other/private",
        parseNativeSessionId("other"),
      ),
    };
    f.store.record(observation, [
      {
        type: "provider_child",
        source: other,
        target: child,
        recordKey: "conflict",
        trust: "provider-observed",
      },
    ]);
    expect((await f.read()).relationships).toEqual([]);
  });

  it("does not use the native-child exception to expose a bound child in a hidden project in either direction", async () => {
    using f = fixture();
    const child = nativeSessionRef(
      "codex",
      "/private/native",
      parseNativeSessionId("secret"),
    );
    const target: RelationshipResource = {
      kind: "native",
      serverId: "local",
      native: child,
    };
    f.db.transaction(() => {
      f.admit("bound-secret", hidden);
      f.identities.bindWithinTransaction(
        parseYaSessionId("bound-secret"),
        child,
      );
      f.store.recordWithinTransaction(observation, [
        {
          type: "provider_child",
          source: native,
          target,
          recordKey: "proved",
          trust: "provider-observed",
        },
      ]);
    });
    const source = f.source.scoped(() => ({
      serverId: "local",
      projects: [visible],
      creators: false,
    }));
    expect(
      source.list({ resource: native, direction: "outgoing" }).edges,
    ).toEqual([]);
    expect(
      source.list({ resource: target, direction: "incoming" }).edges,
    ).toEqual([]);
    expect((await f.read()).relationships).toEqual([]);
  });
});
