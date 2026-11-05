import { describe, expect, it, vi } from "vitest";
import {
  parseYaSessionId,
  nativeSessionRef,
  parseNativeSessionId,
} from "@yep-anywhere/shared";
import { encodeProjectId } from "../../src/projects/paths.js";
import { SessionIdentityStore } from "../../src/sessions/SessionIdentityStore.js";
import {
  SessionRelationshipStore,
  type RelationshipEvidence,
  type RelationshipFact,
  type RelationshipResource,
} from "../../src/sessions/SessionRelationshipStore.js";
import { projectRelationshipBatch } from "../../src/sessions/session-relationship-query.js";
import { migrateDiscoveryDatabase } from "../../src/storage/discovery-sqlite.js";
import { openSqliteOrThrow } from "../../src/storage/sqlite.js";

const session = (
  sessionId: string,
  serverId = "local",
): RelationshipResource => ({ kind: "session", serverId, sessionId });
const native = (id: string, scope = "/native/one"): RelationshipResource => ({
  kind: "native",
  serverId: "local",
  native: nativeSessionRef("codex", scope, parseNativeSessionId(id)),
});
function fixture() {
  const database = openSqliteOrThrow(":memory:");
  migrateDiscoveryDatabase(database);
  const store = new SessionRelationshipStore(database);
  const identities = new SessionIdentityStore(database);
  return {
    database,
    store,
    identities,
    [Symbol.dispose]() {
      store.dispose();
      database.close();
    },
  };
}
const observedAt = "2026-11-05T00:00:00.000Z";
const observation = {
  producer: "qualified-test-source",
  sourceKey: "/private/provider/source",
  sourceVersion: "private-native-version",
  extractorVersion: 1,
  observedAt,
};

describe("internal authorized relationship projection", () => {
  it("merges two independently full indexed pages without skipping or repeating mixed incoming/outgoing facts", () => {
    using f = fixture();
    const resources = [session("parent"), native("parent")];
    const facts: RelationshipFact[] = Array.from({ length: 510 }, (_, i) => {
      const anchor = resources[i % 2]!;
      const other = session(`child-${i}`);
      return {
        type: "launched_harness",
        source: i % 3 === 0 ? other : anchor,
        target: i % 3 === 0 ? anchor : other,
        recordKey: `call-${i}`,
        trust: "command-observed",
        metadata: { toolUseId: `call-${i}` },
      };
    });
    f.store.record(observation, facts);
    const calls = new Set<string>();
    const expected = new Set(facts.map((fact) => fact.recordKey));
    let after: string | undefined,
      batches = 0;
    do {
      const page = projectRelationshipBatch(
        f.store,
        { resources, after },
        {
          anchor: () => true,
          endpoint: (resource) =>
            resource.kind === "session"
              ? resource.sessionId
              : resource.native.id,
          evidence: (entry) => entry.metadata.toolUseId,
        },
      )!;
      batches++;
      expect(page.withheld).toBe(false);
      for (const edge of page.relationships) {
        expect(calls.has(edge.evidence[0]!)).toBe(false);
        calls.add(edge.evidence[0]!);
      }
      if (page.scanAfter) expect(page.scanAfter > (after ?? "")).toBe(true);
      after = page.scanAfter ?? undefined;
      if (batches === 1) {
        const cursor = after!;
        f.store.record(
          observation,
          Array.from({ length: 32 }, (_, i) => ({
            ...facts[i]!,
            source: resources[i % 2]!,
            target: session(`late-child-${i}`),
            recordKey: `late-${i}`,
            metadata: { toolUseId: `late-${i}` },
          })),
        );
        // Independent SQL oracle uses actual stored ids, not a replica of
        // the store's hash algorithm. Keyset scans see inserts after their
        // cursor; earlier inserts belong to a subsequent fresh scan.
        const statement = f.database.prepare(
          "SELECT edge_id, record_key FROM session_relationship_evidence WHERE producer = ? AND source_key = ? AND record_key LIKE 'late-%'",
        );
        let rows: { edge_id: string; record_key: string }[];
        try {
          rows = statement.all(observation.producer, observation.sourceKey);
        } finally {
          statement.finalize();
        }
        expect(rows.some((row) => row.edge_id <= cursor)).toBe(true);
        expect(rows.some((row) => row.edge_id > cursor)).toBe(true);
        for (const row of rows)
          if (row.edge_id > cursor) expected.add(row.record_key);
      }
    } while (after);
    expect(batches).toBe(3);
    expect(calls).toEqual(expected);
  });

  it("joins the existing YA/native identity owners and pages mixed directions without disclosing withheld endpoints or proof fields", () => {
    using f = fixture();
    const allowed = encodeProjectId("/allowed"),
      hidden = encodeProjectId("/hidden");
    for (const [id, nativeRef, projectId] of [
      ["ya-parent", native("native-parent"), allowed],
      ["ya-child", native("native-child"), allowed],
      // Identical native spelling in another root remains another identity.
      ["other-child", native("native-child", "/native/two"), hidden],
    ] as const) {
      f.database.transaction(() => {
        f.identities.allocateWithinTransaction({
          sessionId: parseYaSessionId(id),
          provider: "codex",
          projectId,
          createdAt: observedAt,
        });
        if (nativeRef.kind === "native")
          f.identities.bindWithinTransaction(
            parseYaSessionId(id),
            nativeRef.native,
          );
      });
    }
    const parent = session("ya-parent"),
      child = session("ya-child");
    const facts: RelationshipFact[] = [
      {
        type: "created_session",
        source: parent,
        target: child,
        recordKey: "creation",
        trust: "local-authenticated",
        metadata: { receiptId: "visible-receipt" },
      },
      {
        type: "launched_harness",
        source: native("native-parent"),
        target: native("native-child"),
        recordKey: "launch",
        trust: "command-observed",
        metadata: { toolUseId: "launch-call" },
      },
      {
        type: "aside_of",
        source: child,
        target: parent,
        recordKey: "aside",
        trust: "local-authenticated",
      },
      {
        type: "forked_from",
        source: parent,
        target: native("native-child", "/native/two"),
        recordKey: "hidden-root",
        trust: "local-authenticated",
        metadata: { title: "HIDDEN ROOT" },
      },
      {
        type: "created_session",
        source: parent,
        target: session("ya-child", "remote"),
        recordKey: "remote",
        trust: "peer-attested",
        metadata: { title: "REMOTE PRIVATE" },
      },
      {
        type: "cloned_from",
        source: parent,
        target: session("missing"),
        recordKey: "unresolved",
        trust: "local-authenticated",
        metadata: { title: "UNRESOLVED" },
      },
      {
        type: "continued_from",
        source: parent,
        target: child,
        recordKey: "hidden-receipt",
        trust: "local-authenticated",
        metadata: { receiptId: "hidden-receipt" },
      },
    ];
    f.store.record(observation, facts);
    f.store.record({ ...observation, producer: "separate-private-receipt" }, [
      { ...facts[0]!, metadata: { receiptId: "hidden-receipt" } },
    ]);
    const resources = [parent, native("native-parent")];
    const endpoint = (resource: RelationshipResource) => {
      if (resource.serverId !== "local") return undefined;
      const identity =
        resource.kind === "session"
          ? f.identities.resolveYa(parseYaSessionId(resource.sessionId))
          : f.identities.lookupNative(resource.native);
      return identity?.projectId === allowed ? identity.sessionId : undefined;
    };
    const access = {
      anchor: (resource: RelationshipResource) =>
        endpoint(resource) === "ya-parent",
      endpoint,
      evidence: (entry: RelationshipEvidence) =>
        entry.metadata.receiptId === "hidden-receipt"
          ? undefined
          : {
              trust: entry.trust,
              toolUseId: entry.metadata.toolUseId,
              receiptId: entry.metadata.receiptId,
            },
    };
    const seen = new Set<string>();
    const visible: unknown[] = [];
    let after: string | undefined,
      withheld = false,
      batches = 0;
    do {
      const page = projectRelationshipBatch(
        f.store,
        { resources, after, limit: 2 },
        access,
      )!;
      batches++;
      expect(page.relationships.length).toBeLessThanOrEqual(2);
      for (const edge of page.relationships) {
        const key = JSON.stringify([edge.type, edge.source, edge.target]);
        expect(seen.has(key)).toBe(false);
        seen.add(key);
        visible.push(edge);
      }
      withheld ||= page.withheld;
      after = page.scanAfter ?? undefined;
      // Unrelated source changes must not restart or broaden this scan.
      f.store.record(observation, [
        { ...facts[0]!, source: session("unrelated"), target: child },
      ]);
    } while (after);
    expect(batches).toBeGreaterThan(1);
    expect(withheld).toBe(true);
    expect(visible).toHaveLength(3);
    expect(visible).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "created_session",
          source: "ya-parent",
          target: "ya-child",
          evidence: [
            {
              trust: "local-authenticated",
              receiptId: "visible-receipt",
              toolUseId: undefined,
            },
          ],
        }),
        expect.objectContaining({
          type: "launched_harness",
          source: "ya-parent",
          target: "ya-child",
        }),
        expect.objectContaining({
          type: "aside_of",
          source: "ya-child",
          target: "ya-parent",
        }),
      ]),
    );
    const serialized = JSON.stringify(visible);
    const privateEdgeIds = resources.flatMap((resource) =>
      f.store.list({ resource }).edges.map((edge) => edge.id),
    );
    for (const id of privateEdgeIds) expect(serialized).not.toContain(id);
    for (const edge of visible) expect(edge).not.toHaveProperty("id");
    for (const privateValue of [
      "/native/",
      "/private/provider",
      "private-native-version",
      "hidden-receipt",
      "HIDDEN ROOT",
      "REMOTE PRIVATE",
      "UNRESOLVED",
      "sourceKey",
      "sourceVersion",
      "observedAt",
      "other-child",
    ])
      expect(serialized).not.toContain(privateValue);
    const incoming = projectRelationshipBatch(
      f.store,
      { resources, direction: "incoming", type: "aside_of" },
      access,
    )!;
    expect(incoming.relationships).toHaveLength(1);
    expect(incoming.scanAfter).toBeNull();
  });

  it("authorizes every query anchor before SQL and withholds evidence before any display projection", () => {
    using f = fixture();
    f.store.record(observation, [
      {
        type: "created_session",
        source: session("parent"),
        target: session("child"),
        recordKey: "receipt",
        trust: "local-authenticated",
        metadata: { receiptId: "private" },
      },
    ]);
    const list = vi.spyOn(f.store, "list");
    const endpoint = vi.fn((resource: RelationshipResource) => resource);
    const evidence = vi.fn(() => undefined);
    expect(
      projectRelationshipBatch(
        f.store,
        { resources: [session("parent"), native("not-authorized")] },
        { anchor: (r) => r.kind === "session", endpoint, evidence },
      ),
    ).toBeUndefined();
    expect(list).not.toHaveBeenCalled();
    expect(endpoint).not.toHaveBeenCalled();
    const page = projectRelationshipBatch(
      f.store,
      { resources: [session("parent")] },
      { anchor: () => true, endpoint, evidence },
    )!;
    expect(page.relationships).toEqual([]);
    expect(page.withheld).toBe(true);
    expect(JSON.parse(JSON.stringify(page))).toEqual({ relationships: [] });
    expect({ ...page }).toEqual({ relationships: [] });
    expect(evidence).toHaveBeenCalledTimes(1);
    expect(() =>
      projectRelationshipBatch(
        f.store,
        { resources: [session("parent")], limit: 201 },
        { anchor: () => true, endpoint, evidence },
      ),
    ).toThrow(/batch size/);
    list.mockRestore();
  });
});
