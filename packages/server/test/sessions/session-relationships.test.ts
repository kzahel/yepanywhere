import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeSessionRef, parseNativeSessionId } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  SessionRelationshipStore,
  type RelationshipFact,
  type RelationshipObservation,
  type RelationshipResource,
} from "../../src/sessions/SessionRelationshipStore.js";
import {
  discoveryMigrationPrefix,
  migrateDiscoveryDatabase,
} from "../../src/storage/discovery-sqlite.js";
import { openSqliteOrThrow } from "../../src/storage/sqlite.js";

const session = (id: string, serverId = "server-a"): RelationshipResource => ({
  kind: "session",
  serverId,
  sessionId: id,
});
const native = (
  id: string,
  storageScope = "/native/a",
  serverId = "server-a",
): RelationshipResource => ({
  kind: "native",
  serverId,
  native: nativeSessionRef("codex", storageScope, parseNativeSessionId(id)),
});
const observation = (
  version = "v1",
  producer = "codex-child",
): RelationshipObservation => ({
  producer,
  sourceKey: "parent-rollout",
  sourceVersion: version,
  extractorVersion: 1,
  observedAt: "2026-11-04T12:00:00.000Z",
});
const fact = (child: string): RelationshipFact => ({
  type: "provider_child",
  source: native("parent"),
  target: native(child),
  recordKey: child,
  trust: "provider-observed",
  metadata: { toolUseId: `call-${child}` },
});
function fixture() {
  const database = openSqliteOrThrow(":memory:");
  migrateDiscoveryDatabase(database);
  const store = new SessionRelationshipStore(database);
  return {
    database,
    store,
    [Symbol.dispose]: () => {
      store.dispose();
      database.close();
    },
  };
}

describe("durable structural relationship evidence", () => {
  it("upgrades the actual previous schema and reopens facts, pending progress and known empty sources", () => {
    const dir = mkdtempSync(join(tmpdir(), "ya-relationships-"));
    try {
      const path = join(dir, "discovery.sqlite");
      const db = openSqliteOrThrow(path);
      migrateDiscoveryDatabase(db, discoveryMigrationPrefix(25));
      db.exec(
        `INSERT INTO session_metadata VALUES ('preserved', '{"customTitle":"keep"}')`,
      );
      migrateDiscoveryDatabase(db);
      const store = new SessionRelationshipStore(db);
      expect(
        store.publish({
          observation: observation(),
          expectedRevision: null,
          facts: [fact("child")],
          progress: {
            state: "partial",
            cursor: '{"offset":100,"pending":["call-2"]}',
          },
        }),
      ).toBe(true);
      expect(
        store.publish({
          observation: { ...observation(), sourceKey: "empty-parent" },
          expectedRevision: null,
          facts: [],
          progress: { state: "complete", cursor: "{}" },
        }),
      ).toBe(true);
      store.dispose();
      db.close();
      const reopened = openSqliteOrThrow(path);
      try {
        migrateDiscoveryDatabase(reopened);
        const accepted = new SessionRelationshipStore(reopened);
        expect(
          accepted.list({ resource: native("parent") }).edges,
        ).toHaveLength(1);
        expect(
          accepted.checkpoint("codex-child", "parent-rollout"),
        ).toMatchObject({
          revision: 1,
          state: "partial",
          cursor: '{"offset":100,"pending":["call-2"]}',
        });
        expect(accepted.checkpoint("codex-child", "empty-parent")?.state).toBe(
          "complete",
        );
        expect(accepted.checkpoint("codex-child", "unknown-parent")).toBeNull();
        const check = reopened.prepare(
          "SELECT custom_title, extra FROM session_metadata WHERE session_id = 'preserved'",
        );
        try {
          expect(check.get()).toEqual({ custom_title: "keep", extra: "{}" });
        } finally {
          check.finalize();
        }
        accepted.dispose();
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves independent evidence across source replacement and rejects stale publications", () => {
    using f = fixture();
    const publish = (
      version: string,
      revision: number | null,
      facts: RelationshipFact[],
    ) =>
      f.store.publish({
        observation: observation(version),
        expectedRevision: revision,
        facts,
        progress: { state: "complete", cursor: "{}" },
        replaceSource: true,
      });
    expect(publish("v1", null, [fact("one"), fact("two")])).toBe(true);
    f.store.record(observation("receipt-1", "independent-native-observer"), [
      fact("two"),
    ]);
    expect(publish("v2", 1, [fact("one")])).toBe(true);
    expect(publish("stale", 1, [])).toBe(false);
    const edges = f.store.list({ resource: native("parent") }).edges;
    expect(edges).toHaveLength(2);
    const two = edges.find(
      (e) => e.target.kind === "native" && e.target.native.id === "two",
    )!;
    expect(f.store.evidence(two.id)).toMatchObject([
      { producer: "independent-native-observer", state: "active" },
    ]);
    expect(
      f.store
        .evidence(two.id, { history: true })
        .map((e) => e.state)
        .sort(),
    ).toEqual(["active", "superseded"]);
    expect(
      f.store.checkpoint("codex-child", "parent-rollout")?.sourceVersion,
    ).toBe("v2");
  });

  it("retains last-known facts through partial replacement and never resurrects them on old replay", () => {
    using f = fixture();
    const publish = (
      version: string,
      revision: number | null,
      state: "partial" | "complete",
      facts: RelationshipFact[],
    ) =>
      f.store.publish({
        observation: observation(version),
        expectedRevision: revision,
        facts,
        progress: { state, cursor: "{}" },
        replaceSource: true,
      });
    publish("v1", null, "complete", [fact("one"), fact("two"), fact("three")]);
    publish("v2", 1, "partial", [fact("one")]);
    expect(f.store.list({ resource: native("parent") }).edges).toHaveLength(3);
    publish("v2", 2, "complete", [fact("two")]);
    expect(f.store.list({ resource: native("parent") }).edges).toHaveLength(2);
    f.store.record(observation("v1"), [fact("three")]);
    expect(f.store.list({ resource: native("parent") }).edges).toHaveLength(2);
    expect(
      f.store.checkpoint("codex-child", "parent-rollout")?.sourceVersion,
    ).toBe("v2");
  });

  it("bounds evidence by distinct source records rather than reconciliation count", () => {
    using f = fixture();
    const facts = Array.from({ length: 200 }, (_, i) => fact(`child-${i}`));
    for (let i = 0; i < 30; i++)
      f.store.publish({
        observation: observation(`version-${i}`),
        expectedRevision: i || null,
        facts,
        progress: { state: "complete", cursor: "{}" },
        replaceSource: true,
      });
    const count = f.database.prepare(
      "SELECT COUNT(*) AS total FROM session_relationship_evidence",
    );
    try {
      expect(count.get()).toEqual({ total: 200 });
    } finally {
      count.finalize();
    }
    const edge = f.store.list({ resource: native("parent") }).edges[0]!;
    expect(f.store.evidence(edge.id, { history: true })).toMatchObject([
      { sourceVersion: "version-29" },
    ]);
    expect(
      f.store.publish({
        observation: observation("empty"),
        expectedRevision: 30,
        facts: [],
        progress: { state: "complete", cursor: "{}" },
        replaceSource: true,
      }),
    ).toBe(true);
    expect(f.store.list({ resource: native("parent") }).edges).toEqual([]);
    expect(f.store.evidence(edge.id, { history: true })[0]?.state).toBe(
      "superseded",
    );
  });

  it("merges mixed incoming/outgoing pages without duplicates and rejects self-lineage", () => {
    using f = fixture();
    const facts = Array.from({ length: 31 }, (_, i) =>
      i % 2
        ? fact(`child-${i}`)
        : {
            ...fact(`child-${i}`),
            source: native(`ancestor-${i}`),
            target: native("parent"),
          },
    );
    f.store.record(observation(), facts);
    const ids = new Set<string>();
    let after: string | undefined;
    do {
      const page = f.store.list({
        resource: native("parent"),
        after,
        limit: 3,
      });
      for (const edge of page.edges) {
        expect(ids.has(edge.id)).toBe(false);
        ids.add(edge.id);
      }
      after = page.next ?? undefined;
    } while (after);
    expect(ids.size).toBe(31);
    expect(() =>
      f.store.record(observation(), [{ ...fact("parent") }]),
    ).toThrow(/Reflexive/);
  });

  it("rolls back all evidence and progress on a bad batch, including an owning admission transaction", () => {
    using f = fixture();
    expect(() =>
      f.store.publish({
        observation: observation(),
        expectedRevision: null,
        facts: [
          fact("valid"),
          { ...fact("invalid"), metadata: { spawnDepth: -1 } },
        ],
        progress: { state: "complete", cursor: "{}" },
      }),
    ).toThrow(/spawn depth/);
    expect(f.store.list({ resource: native("parent") }).edges).toEqual([]);
    expect(f.store.checkpoint("codex-child", "parent-rollout")).toBeNull();
    expect(() =>
      f.database.transaction(() => {
        f.store.recordWithinTransaction(observation(), [fact("valid")]);
        throw new Error("admission refused");
      }),
    ).toThrow("admission refused");
    expect(f.store.list({ resource: native("parent") }).edges).toEqual([]);
    f.store.record(observation(), [fact("valid")]);
    expect(() =>
      f.store.record(observation(), [
        { ...fact("valid"), trust: "local-authenticated" },
      ]),
    ).toThrow(/trust/);
    expect(
      f.store.evidence(
        f.store.list({ resource: native("parent") }).edges[0]!.id,
      )[0]?.trust,
    ).toBe("provider-observed");
  });

  it("keeps same ids isolated by server, family, native scope and public/native kind", () => {
    using f = fixture();
    const resources = [
      native("parent"),
      native("parent", "/native/b"),
      native("parent", "/native/a", "server-b"),
      session("parent"),
      {
        kind: "native",
        serverId: "server-a",
        native: nativeSessionRef(
          "claude",
          "/native/a",
          parseNativeSessionId("parent"),
        ),
      } as RelationshipResource,
    ];
    f.store.record(
      observation(),
      resources.map((source, index) => ({ ...fact(`child-${index}`), source })),
    );
    for (const resource of resources)
      expect(f.store.list({ resource }).edges).toHaveLength(1);
    expect(f.store.list({ resource: session("child-0") }).edges).toEqual([]);
  });

  it("replays idempotently and pages incoming/outgoing types during unrelated concurrent writes", () => {
    using f = fixture();
    const facts = Array.from(
      { length: 320 },
      (_, i) =>
        ({
          ...fact(`child-${i}`),
          type: i % 2 ? "provider_child" : "launched_harness",
        }) as RelationshipFact,
    );
    f.store.record(observation(), facts);
    f.store.record(observation(), facts);
    const ids = new Set<string>();
    let after: string | undefined;
    do {
      const page = f.store.list({
        resource: native("parent"),
        direction: "outgoing",
        type: "provider_child",
        after,
        limit: 13,
      });
      for (const edge of page.edges) {
        expect(ids.has(edge.id)).toBe(false);
        ids.add(edge.id);
      }
      after = page.next ?? undefined;
      f.store.record(observation("other"), [
        { ...fact("other-child"), source: session("unrelated") },
      ]);
    } while (after);
    expect(ids.size).toBe(160);
    expect(
      f.store.list({ resource: native("child-1"), direction: "incoming" })
        .edges,
    ).toHaveLength(1);
    expect(
      f.store.list({ resource: native("child-1"), direction: "outgoing" })
        .edges,
    ).toEqual([]);
    expect(f.store.evidence([...ids][0]!)).toHaveLength(1);
    expect(() =>
      f.store.list({ resource: native("parent"), limit: 201 }),
    ).toThrow(/limit/);
  });
});
