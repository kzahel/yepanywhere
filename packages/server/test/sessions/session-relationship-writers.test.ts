import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nativeSessionRef,
  parseNativeSessionId,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { afterEach, expect, it, vi } from "vitest";
import { ApiReceiptStore } from "../../src/core-api/receipt-store.js";
import type {
  ApiCreator,
  ApiReceipt,
} from "../../src/core-api/command-contracts.js";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { PeerOutboundStore } from "../../src/peer-api/outbound-store.js";
import type { SavedCreationRequest } from "../../src/sessions/SessionCreationStore.js";
import { reconcileSessionRelationships } from "../../src/sessions/session-relationship-reconciliation.js";
import { migrateDiscoveryDatabase } from "../../src/storage/discovery-sqlite.js";
import {
  openSqliteOrThrow,
  type SqliteDatabase,
} from "../../src/storage/sqlite.js";
import { writeStoredMetadata } from "../utils/session-metadata-database.js";

const roots: string[] = [],
  databases: SqliteDatabase[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});
async function fixture(file?: string) {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const root = await mkdtemp(join(tmpdir(), "ya-relationship-writers-"));
  roots.push(root);
  const database = openSqliteOrThrow(file ?? join(root, "profile.sqlite"));
  databases.push(database);
  migrateDiscoveryDatabase(database);
  const metadata = new SessionMetadataService({ dataDir: root, database });
  await metadata.initialize();
  const writer = metadata.relationships;
  const receipts = new ApiReceiptStore(database, writer);
  const outbound = new PeerOutboundStore(database, writer);
  const resource = (id: string) => writer.session(id);
  const edges = (id: string) =>
    writer.index.list({ resource: resource(id), direction: "both", limit: 200 })
      .edges;
  const creator: ApiCreator = {
    serverId: writer.serverId,
    sessionId: "initiator",
    launchId: "trusted-launch",
    principal: { kind: "superuser" },
  };
  const reserve = (
    overrides: Partial<{
      requestId: string;
      kind: ApiReceipt["kind"];
      sessionId: string | null;
      creator: ApiCreator;
    }> = {},
  ) =>
    receipts.reserve({
      requestId: "creation-test-0001",
      kind: "createSession",
      projectId: "project",
      sessionId: null,
      creator,
      destinationServerId: writer.serverId,
      payload: { message: "SECRET-PROMPT" },
      ...overrides,
    });
  return {
    root,
    database,
    metadata,
    writer,
    receipts,
    outbound,
    resource,
    edges,
    creator,
    reserve,
  };
}
const context = {
  owner: { kind: "superuser" as const },
  source: { kind: "request" as const, provenance: { surface: "api" as const } },
};
const request: SavedCreationRequest = {
  provider: "claude",
  projectId: toUrlProjectId("/fixture/project"),
  projectPath: "/fixture/project",
  message: "SECRET-PROMPT",
  settings: {
    requestedModel: null,
    permissionMode: "default",
    serviceTier: null,
    thinking: null,
    effort: null,
  },
};
const copy = (kind: "fork" | "clone") => ({
  kind,
  sourceSessionId: "source",
  upToMessageId: "boundary",
  source: {
    native: nativeSessionRef(
      "claude",
      "/fixture/native",
      parseNativeSessionId("native-source"),
    ),
    projectId: request.projectId,
    filePath: "/fixture/native/source.jsonl",
  },
});
function query(database: SqliteDatabase, sql: string) {
  const statement = database.prepare(sql);
  try {
    return statement.all();
  } finally {
    statement.finalize();
  }
}

it("commits exact copy/aside/successor intent with YA admission, rolls back together and keeps facts through payload/content deletion", async () => {
  const f = await fixture();
  for (const kind of ["fork", "clone"] as const) {
    const input = {
      requestId: `copy-${kind}-0001`,
      context,
      request: {
        ...request,
        intent: "copy" as const,
        copy: copy(kind),
        lineage: { asideOf: "mother", continuedFrom: "previous" },
      },
    };
    const saved = f.metadata.creations.admit(input);
    expect(f.metadata.creations.admit(input).sessionId).toBe(saved.sessionId);
    expect(
      f
        .edges(saved.sessionId)
        .map((edge) => edge.type)
        .sort(),
    ).toEqual(
      [
        "aside_of",
        "continued_from",
        kind === "fork" ? "forked_from" : "cloned_from",
      ].sort(),
    );
    expect(f.metadata.getMetadata(saved.sessionId)).toMatchObject({
      parentSessionId: "mother",
      parentSessionKind: "btw-aside",
      forkedFromSessionId: "source",
    });
    expect(
      f
        .edges(saved.sessionId)
        .every(
          (edge) =>
            edge.source.kind === "session" &&
            edge.source.sessionId === saved.sessionId,
        ),
    ).toBe(true);
    // Existing retention may discard the saved text; it cannot weaken lineage.
    const remove = f.database.prepare(
      "UPDATE session_creations SET payload_json = NULL WHERE session_id = ?",
    );
    try {
      remove.run(saved.sessionId);
    } finally {
      remove.finalize();
    }
    await f.metadata.updateMetadata(saved.sessionId, {
      title: "changed after pruning",
    });
    await f.metadata.clearSession(saved.sessionId);
    expect(f.edges(saved.sessionId)).toHaveLength(3);
  }
  const before = query(f.database, "SELECT session_id FROM session_identities");
  f.database.exec(
    "CREATE TRIGGER fail_relationship BEFORE INSERT ON session_relationship_evidence BEGIN SELECT RAISE(ABORT, 'projection failure'); END;",
  );
  expect(() =>
    f.metadata.creations.admit({
      requestId: "rollback-0001",
      context,
      request: { ...request, lineage: { continuedFrom: "previous" } },
    }),
  ).toThrow("projection failure");
  expect(
    query(f.database, "SELECT session_id FROM session_identities"),
  ).toEqual(before);
  expect(Object.keys(f.metadata.getAllMetadata())).toHaveLength(0);
  f.database.exec("DROP TRIGGER fail_relationship");
  const retried = f.metadata.creations.admit({
    requestId: "rollback-0001",
    context,
    request: { ...request, lineage: { continuedFrom: "previous" } },
  });
  expect(f.edges(retried.sessionId)).toHaveLength(1);
  f.database.close();
  const reopened = await fixture(join(f.root, "profile.sqlite"));
  expect(reopened.writer.serverId).toBe(f.writer.serverId);
  expect(reopened.edges(retried.sessionId)).toHaveLength(1);
  expect(reopened.edges("source")).toHaveLength(2);
});

it("keeps descriptive provenance and ambiguous legacy lineage separate from trusted creator evidence", async () => {
  const f = await fixture();
  const saved = f.metadata.creations.admit({
    requestId: "ordinary-0001",
    context,
    request,
  });
  expect(f.edges(saved.sessionId)).toEqual([]);
  await f.metadata.updateMetadata("legacy-copy", {
    forkedFromSessionId: "old-source",
    parentSessionId: "mother",
    parentSessionKind: "btw-aside",
  });
  expect(
    f
      .edges("legacy-copy")
      .map((edge) => edge.type)
      .sort(),
  ).toEqual(["aside_of", "derived_from"]);
  await f.metadata.updateMetadata("legacy-copy", { title: "renamed" });
  expect(
    query(
      f.database,
      "SELECT COUNT(*) AS total FROM session_relationship_evidence",
    )[0],
  ).toEqual({ total: 2 });
  await f.metadata.updateMetadata("legacy-copy", {
    parentSessionId: "different-mother",
  });
  expect(
    f
      .edges("legacy-copy")
      .map((edge) => edge.target.kind === "session" && edge.target.sessionId)
      .sort(),
  ).toEqual(["different-mother", "old-source"]);
  await f.metadata.updateMetadata("legacy-copy", {
    parentSessionId: null,
    forkedFromSessionId: null,
  });
  expect(f.edges("legacy-copy")).toEqual([]);
  await f.metadata.updateMetadata("legacy-copy", {
    parentSessionId: "mother",
    forkedFromSessionId: "old-source",
  });
  await f.metadata.clearSession("legacy-copy");
  expect(f.edges("legacy-copy")).toHaveLength(2);
  await f.metadata.updateMetadata("legacy-invalid", {
    forkedFromSessionId: "legacy-invalid",
  });
  expect(f.edges("legacy-invalid")).toEqual([]);
});

it("retracts only metadata evidence on an explicit clear while retaining independently admitted lineage", async () => {
  const f = await fixture();
  const saved = f.metadata.creations.admit({
    requestId: "clear-admitted-0001",
    context,
    request: {
      ...request,
      intent: "copy",
      copy: copy("clone"),
      lineage: { asideOf: "mother" },
    },
  });
  const aside = f
    .edges(saved.sessionId)
    .find((edge) => edge.type === "aside_of")!;
  expect(f.writer.index.evidence(aside.id)).toHaveLength(2);
  await f.metadata.updateMetadata(saved.sessionId, {
    parentSessionId: null,
    forkedFromSessionId: null,
  });
  expect(
    f
      .edges(saved.sessionId)
      .map((edge) => edge.type)
      .sort(),
  ).toEqual(["aside_of", "cloned_from"]);
  expect(
    f.writer.index.evidence(aside.id).map((evidence) => evidence.producer),
  ).toEqual(["ya-creation-v1"]);
  expect(
    f.writer.index
      .evidence(aside.id, { history: true })
      .find((evidence) => evidence.producer === "ya-metadata-lineage-v1")
      ?.state,
  ).toBe("superseded");
});

it("records trusted v0 creation in admission before its later receipt callback, and reconciles that exact saved correlation after a crash", async () => {
  const f = await fixture();
  const { receipt } = f.reserve();
  const input = {
    requestId: receipt.id,
    context,
    request: {
      ...request,
      input: { schemaVersion: 1 as const, nativeReceiptId: receipt.id },
    },
  };
  const saved = f.metadata.creations.admit(input);
  expect(f.receipts.get(receipt.id)?.sessionId).toBeNull();
  expect(f.edges(saved.sessionId)[0]).toMatchObject({
    type: "created_session",
    source: f.resource("initiator"),
    target: f.resource(saved.sessionId),
  });
  const oldRevision = f.writer.index.checkpoint(
    "v0-receipt-v1",
    receipt.id,
  )?.revision;
  f.receipts.update(receipt.id, { sessionId: saved.sessionId });
  expect(f.writer.index.checkpoint("v0-receipt-v1", receipt.id)?.revision).toBe(
    oldRevision,
  );
  f.receipts.update(receipt.id, { sessionId: null, state: "uncertain" });
  f.database.exec(
    "DELETE FROM session_relationship_evidence; DELETE FROM session_relationship_edges; DELETE FROM session_relationship_checkpoints;",
  );
  await reconcileSessionRelationships(
    f.database,
    f.writer,
    new AbortController().signal,
  );
  expect(f.edges(saved.sessionId)).toHaveLength(1);
  expect(f.receipts.get(receipt.id)).toMatchObject({
    sessionId: null,
    state: "uncertain",
  });
  // Projection never substitutes for the receipt owner's uncertain outcome.
  expect(f.metadata.creations.admit(input).sessionId).toBe(saved.sessionId);
});

it("publishes creator edges atomically with receipts, only after a destination is known, without rewriting uncertainty or replaying effects", async () => {
  const f = await fixture();
  const { receipt } = f.reserve();
  const seen: string[] = [];
  const unsubscribe = f.receipts.subscribe(receipt.id, (value) => {
    // Postcommit observation can begin a fresh transaction and see both owners.
    f.database.transaction(() => expect(f.edges("initiator")).toHaveLength(1));
    seen.push(value.state);
  });
  expect(f.edges("initiator")).toEqual([]);
  f.database.exec(
    "CREATE TRIGGER fail_relationship BEFORE INSERT ON session_relationship_evidence BEGIN SELECT RAISE(ABORT, 'receipt graph failure'); END;",
  );
  expect(() => f.receipts.update(receipt.id, { sessionId: "new-ya" })).toThrow(
    "receipt graph failure",
  );
  expect(f.receipts.get(receipt.id)?.sessionId).toBeNull();
  expect(seen).toEqual([]);
  f.database.exec("DROP TRIGGER fail_relationship");
  f.receipts.update(receipt.id, { sessionId: "new-ya" });
  f.receipts.update(receipt.id, { sessionId: "new-ya" });
  expect(seen).toEqual(["dispatching"]);
  f.receipts.recoverInterrupted();
  expect(f.receipts.get(receipt.id)).toMatchObject({
    state: "uncertain",
    delivery: "uncertain",
    sessionId: "new-ya",
  });
  expect(f.reserve().created).toBe(false);
  expect(f.edges("new-ya")[0]).toMatchObject({
    type: "created_session",
    source: f.resource("initiator"),
    target: f.resource("new-ya"),
  });
  expect(f.writer.index.evidence(f.edges("new-ya")[0]!.id)[0]).toMatchObject({
    trust: "local-authenticated",
    metadata: { receiptId: receipt.id, launchId: "trusted-launch" },
  });
  // A known corrected canonical destination supersedes only this receipt.
  unsubscribe();
  f.receipts.update(receipt.id, {
    sessionId: "canonical-ya",
    state: "accepted",
  });
  expect(f.edges("new-ya")).toEqual([]);
  expect(f.edges("canonical-ya")).toHaveLength(1);
  f.reserve({
    requestId: "send-existing-0001",
    kind: "sendMessage",
    sessionId: "existing",
  });
  const operator = f.reserve({
    requestId: "operator-0001",
    creator: { ...f.creator, sessionId: null, launchId: null },
  });
  f.receipts.update(operator.receipt.id, { sessionId: "operator-created" });
  expect(f.edges("existing")).toEqual([]);
  expect(f.edges("operator-created")).toEqual([]);
  f.database.close();
  const reopened = await fixture(join(f.root, "profile.sqlite"));
  expect(reopened.edges("canonical-ya")).toHaveLength(1);
  const serialized = JSON.stringify(
    query(reopened.database, "SELECT * FROM session_relationship_evidence"),
  );
  expect(serialized).not.toContain("SECRET-PROMPT");
});

it("preserves peer namespace/attestation and records source-side creation only from a correlated confirmed result", async () => {
  const f = await fixture();
  const creator: ApiCreator = {
    serverId: "remote",
    sessionId: "same-id",
    launchId: "remote-launch",
    principal: { kind: "peer" },
    authentication: {
      credentialId: "SECRET-CREDENTIAL",
      sessionAttribution: "source-attested",
    },
  };
  const incoming = f.reserve({ creator });
  f.receipts.update(incoming.receipt.id, {
    sessionId: "same-id",
    state: "accepted",
  });
  expect(f.edges("same-id")[0]).toMatchObject({
    source: { serverId: "remote", sessionId: "same-id" },
    target: f.resource("same-id"),
  });
  expect(f.writer.index.evidence(f.edges("same-id")[0]!.id)[0]?.trust).toBe(
    "peer-attested",
  );
  const unattested = f.reserve({
    requestId: "unattested-0001",
    creator: { ...creator, authentication: undefined },
  });
  f.receipts.update(unattested.receipt.id, { sessionId: "unattested-child" });
  expect(f.edges("unattested-child")).toEqual([]);
  const outbound = f.outbound.reserve(
    {
      sourceServerId: f.writer.serverId,
      sourceSessionId: "local-source",
      attestedSessionId: "original-source",
      sourceLaunchId: "local-launch",
      destinationServerId: "remote",
      operation: "createSession",
      resource: "project",
      requestId: "outbound-0001",
    },
    { message: "SECRET-PROMPT" },
  );
  expect(f.edges("local-source")).toEqual([]);
  const remoteReceipt: ApiReceipt = {
    ...incoming.receipt,
    id: "remote-receipt",
    requestId: outbound.requestId,
    sessionId: null,
    destinationServerId: "remote",
    creator: {
      ...creator,
      serverId: f.writer.serverId,
      sessionId: "original-source",
    },
  };
  expect(() =>
    f.outbound.confirm(outbound, {
      ...remoteReceipt,
      creator: { ...remoteReceipt.creator, sessionId: "unrelated" },
    }),
  ).toThrow("attribution");
  f.outbound.confirm(outbound, remoteReceipt);
  expect(f.edges("local-source")).toEqual([]);
  f.database.exec(
    "CREATE TRIGGER fail_relationship BEFORE INSERT ON session_relationship_evidence BEGIN SELECT RAISE(ABORT, 'outbound graph failure'); END;",
  );
  expect(() =>
    f.outbound.observe("remote", {
      ...remoteReceipt,
      sessionId: "remote-child",
    }),
  ).toThrow("outbound graph failure");
  expect(
    f.outbound.list("local-source", 0, 10).items[0]?.destinationSessionId,
  ).toBeNull();
  f.database.exec("DROP TRIGGER fail_relationship");
  f.outbound.observe("remote", { ...remoteReceipt, sessionId: "remote-child" });
  expect(f.edges("local-source")[0]).toMatchObject({
    source: f.resource("local-source"),
    target: { serverId: "remote", sessionId: "remote-child" },
  });
  expect(
    JSON.stringify(
      query(f.database, "SELECT * FROM session_relationship_evidence"),
    ),
  ).not.toMatch(/SECRET-(PROMPT|CREDENTIAL)/);
});

it("resumes bounded SQL-only reconciliation after interruption and imports old records without guessing copy subtype or creator", async () => {
  const f = await fixture();
  const saved = f.metadata.creations.admit({
    requestId: "backfill-copy-0001",
    context,
    request: {
      ...request,
      intent: "copy",
      copy: copy("clone"),
      lineage: { continuedFrom: "previous" },
    },
  });
  const incoming = f.reserve();
  f.receipts.update(incoming.receipt.id, { sessionId: "receipt-child" });
  f.database.transaction(() =>
    writeStoredMetadata(
      f.database,
      Object.fromEntries(
        Array.from({ length: 205 }, (_, i) => [
          `legacy-${String(i).padStart(3, "0")}`,
          {
            forkedFromSessionId: "old-source",
            creationProvenance: { surface: "api" },
            initialPrompt: "SECRET-PROMPT",
          },
        ]),
      ),
    ),
  );
  // Simulate existing authoritative owners at the additive migration boundary.
  f.database.exec(
    "DELETE FROM session_relationship_evidence; DELETE FROM session_relationship_edges; DELETE FROM session_relationship_checkpoints;",
  );
  const controller = new AbortController();
  const original = f.database.transaction.bind(f.database);
  let committed = 0;
  const transaction = vi
    .spyOn(f.database, "transaction")
    .mockImplementation((write) => {
      const result = original(write);
      if (++committed === 2) controller.abort();
      return result;
    });
  await reconcileSessionRelationships(f.database, f.writer, controller.signal);
  transaction.mockRestore();
  expect(committed).toBe(2);
  const partial = f.writer.index.checkpoint(
    "ya-relationship-reconciliation-v1",
    "profile",
  );
  expect(partial?.state).toBe("partial");
  expect(JSON.parse(partial!.cursor)).toMatchObject({
    phase: 1,
    through: "legacy-098",
  });
  expect(
    f
      .edges(saved.sessionId)
      .map((edge) => edge.type)
      .sort(),
  ).toEqual(["cloned_from", "continued_from"]);
  f.database.close();
  const reopened = await fixture(join(f.root, "profile.sqlite"));
  await reconcileSessionRelationships(
    reopened.database,
    reopened.writer,
    new AbortController().signal,
  );
  expect(
    reopened.writer.index.checkpoint(
      "ya-relationship-reconciliation-v1",
      "profile",
    )?.state,
  ).toBe("complete");
  expect(
    query(
      reopened.database,
      "SELECT COUNT(*) AS total FROM session_relationship_edges WHERE active = 1",
    )[0],
  ).toEqual({ total: 208 });
  expect(reopened.edges("receipt-child")).toHaveLength(1);
  expect(
    reopened
      .edges(saved.sessionId)
      .map((edge) => edge.type)
      .sort(),
  ).toEqual(["cloned_from", "continued_from"]);
  const before = query(
    reopened.database,
    "SELECT * FROM session_relationship_checkpoints",
  );
  await reconcileSessionRelationships(
    reopened.database,
    reopened.writer,
    new AbortController().signal,
  );
  expect(
    query(reopened.database, "SELECT * FROM session_relationship_checkpoints"),
  ).toEqual(before);
  expect(
    JSON.stringify(
      query(reopened.database, "SELECT * FROM session_relationship_evidence"),
    ),
  ).not.toContain("SECRET-PROMPT");
});

it("resolves only local historical aliases during import and ignores unrepresentable legacy relationship values", async () => {
  const f = await fixture();
  const local = f.reserve();
  f.receipts.update(local.receipt.id, { sessionId: "old-child" });
  const peer = f.reserve({
    requestId: "peer-alias-0001",
    creator: {
      ...f.creator,
      serverId: "remote",
      principal: { kind: "peer" },
      authentication: {
        credentialId: "private",
        sessionAttribution: "source-attested",
      },
    },
  });
  f.receipts.update(peer.receipt.id, { sessionId: "peer-child" });
  const outbound = f.outbound.reserve(
    {
      sourceServerId: f.writer.serverId,
      sourceSessionId: "initiator",
      attestedSessionId: "initiator",
      sourceLaunchId: "launch",
      destinationServerId: "remote",
      operation: "createSession",
      resource: "project",
      requestId: "outbound-alias-0001",
    },
    {},
  );
  f.outbound.confirm(outbound, {
    ...local.receipt,
    id: "remote-receipt",
    requestId: outbound.requestId,
    destinationServerId: "remote",
    sessionId: "old-child",
    creator: { ...f.creator, principal: { kind: "peer" } },
  });
  const insert = f.database.prepare(
    "INSERT INTO agent_api_session_aliases(id, target) VALUES (?, ?)",
  );
  try {
    insert.run("initiator", "canonical-initiator");
    insert.run("old-child", "canonical-child");
  } finally {
    insert.finalize();
  }
  f.database.exec(
    `INSERT INTO session_metadata (session_id, extra) VALUES ('legacy-invalid', '{"forkedFromSessionId":{"bad":"value"}}'); DELETE FROM session_relationship_evidence; DELETE FROM session_relationship_edges; DELETE FROM session_relationship_checkpoints;`,
  );
  await reconcileSessionRelationships(
    f.database,
    f.writer,
    new AbortController().signal,
    (id) => f.receipts.resolveId(id),
  );
  expect(f.edges("canonical-child")[0]).toMatchObject({
    source: f.resource("canonical-initiator"),
    target: f.resource("canonical-child"),
  });
  expect(f.edges("peer-child")[0]).toMatchObject({
    source: { kind: "session", serverId: "remote", sessionId: "initiator" },
  });
  expect(
    f
      .edges("canonical-initiator")
      .find((edge) => edge.target.serverId === "remote"),
  ).toMatchObject({
    target: { kind: "session", serverId: "remote", sessionId: "old-child" },
  });
  expect(f.edges("legacy-invalid")).toEqual([]);
});

it("pages opaque Unicode session keys in SQLite order without skipping a frontier row", async () => {
  const f = await fixture();
  const insert = f.database.prepare(
    "INSERT INTO session_metadata(session_id, forked_from_session_id, extra) VALUES (?, ?, '{}')",
  );
  try {
    f.database.transaction(() => {
      // SQLite's UTF-8 binary ordering differs from JS UTF-16 here. The first
      // full 100-row page ends at U+E000; U+10000 must be read on the next page.
      for (const id of [
        ...Array.from(
          { length: 99 },
          (_, i) => `ascii-${String(i).padStart(3, "0")}`,
        ),
        "\uE000",
        "\u{10000}",
      ])
        insert.run(id, "origin");
    });
  } finally {
    insert.finalize();
  }
  await reconcileSessionRelationships(
    f.database,
    f.writer,
    new AbortController().signal,
  );
  expect(f.edges("\uE000")).toHaveLength(1);
  expect(f.edges("\u{10000}")).toHaveLength(1);
  expect(
    query(
      f.database,
      "SELECT COUNT(*) AS total FROM session_relationship_edges WHERE active = 1",
    )[0],
  ).toEqual({ total: 101 });
});
