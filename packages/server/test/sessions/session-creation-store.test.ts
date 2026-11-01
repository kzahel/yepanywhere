import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  nativeSessionRef,
  parseNativeSessionId,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import {
  SessionCreationStore,
  SessionCreationConflict,
  SessionCreationCapacityError,
  StaleCreationAttempt,
  type CreationContext,
  type SavedCreationRequest,
} from "../../src/sessions/SessionCreationStore.js";
import { SessionIdentityConflict } from "../../src/sessions/SessionIdentityStore.js";
import {
  discoveryMigrationPrefix,
  migrateDiscoveryDatabase,
} from "../../src/storage/discovery-sqlite.js";
import {
  openSqliteOrThrow,
  type SqliteDatabase,
} from "../../src/storage/sqlite.js";

const roots: string[] = [],
  databases: SqliteDatabase[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});
const context: CreationContext = {
  owner: { kind: "limited", username: "alice" },
  source: {
    kind: "request",
    provenance: { surface: "desktop", clientVersion: "1.0" },
  },
};
const request: SavedCreationRequest = {
  provider: "claude",
  projectId: toUrlProjectId("/fixture/project"),
  projectPath: "/fixture/project",
  message: "  exact original prompt\n\n",
  settings: {
    permissionMode: "default",
    requestedModel: "default",
    thinking: null,
    effort: null,
    serviceTier: null,
  },
};
async function fixture(path = ":memory:") {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const database = openSqliteOrThrow(path);
  databases.push(database);
  migrateDiscoveryDatabase(database);
  const root = await mkdtemp(join(tmpdir(), "ya-creation-store-"));
  roots.push(root);
  const metadata = new SessionMetadataService({ database, dataDir: root });
  await metadata.initialize();
  const store = new SessionCreationStore(database, metadata);
  return { database, metadata, store };
}
function rows(database: SqliteDatabase, sql: string) {
  const s = database.prepare(sql);
  try {
    return s.all();
  } finally {
    s.finalize();
  }
}
it("commits exact text, immutable source and creator beside an unbound identity, replaying across reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "ya-creation-reopen-"));
  roots.push(root);
  const path = join(root, "db.sqlite"),
    first = await fixture(path);
  const admitted = first.store.admit({
    requestId: "request_0001",
    context,
    request,
  });
  expect(admitted.request?.message).toBe(request.message);
  expect(first.metadata.identities.resolveYa(admitted.sessionId)).toMatchObject(
    {
      provider: "claude",
      projectId: request.projectId,
      native: null,
    },
  );
  expect(first.metadata.getMetadata(admitted.sessionId)).toMatchObject({
    initialPrompt: request.message,
    createdByUser: "alice",
    creationProvenance:
      context.source.kind === "request" ? context.source.provenance : null,
  });
  admitted.request!.message = "caller mutation";
  expect(first.store.get(context.owner, "request_0001")?.request?.message).toBe(
    request.message,
  );
  const other = first.store.admit({
    requestId: "request_0001",
    context: { ...context, owner: { kind: "superuser" } },
    request,
  });
  expect(other.sessionId).not.toBe(admitted.sessionId);
  first.store.close();
  first.database.close();
  const second = await fixture(path);
  expect(
    second.store.admit({ requestId: "request_0001", context, request })
      .sessionId,
  ).toBe(admitted.sessionId);
  expect(
    second.metadata.getMetadata(admitted.sessionId)?.creationProvenance
      ?.surface,
  ).toBe("desktop");
  expect(() =>
    second.store.admit({
      requestId: "request_0001",
      context,
      request: { ...request, message: "different" },
    }),
  ).toThrow(SessionCreationConflict);
  const helper = second.store.admit({
    requestId: "helper_0001",
    context: {
      owner: { kind: "superuser" },
      source: { kind: "internal", reason: "retitle" },
    },
    request,
  });
  expect(
    second.metadata.getMetadata(helper.sessionId)?.creationProvenance,
  ).toBeUndefined();
});
it("rolls every row, counter and metadata mirror back when the final metadata write fails", async () => {
  const { database, metadata, store } = await fixture();
  await metadata.setTitle("existing", "keep unrelated metadata");
  database.exec(
    "CREATE TRIGGER refuse_saved_metadata BEFORE INSERT ON session_metadata WHEN NEW.session_id <> 'existing' BEGIN SELECT RAISE(ABORT, 'storage refusal'); END",
  );
  expect(() =>
    store.admit({ requestId: "request_0001", context, request }),
  ).toThrow("storage refusal");
  for (const table of [
    "session_identities",
    "session_creations",
    "session_creation_attempts",
  ])
    expect(rows(database, `SELECT * FROM ${table}`)).toEqual([]);
  expect(
    rows(database, "SELECT * FROM session_creation_capacity"),
  ).toMatchObject([{ operations: 0, payload_bytes: 0, attempt_bytes: 0 }]);
  expect(rows(database, "SELECT * FROM session_metadata")).toHaveLength(1);
  expect(metadata.getMetadata("existing")?.customTitle).toBe(
    "keep unrelated metadata",
  );
  database.exec("DROP TRIGGER refuse_saved_metadata");
  const creation = store.admit({ requestId: "request_0001", context, request });
  expect(rows(database, "SELECT * FROM session_metadata")).toHaveLength(2);
  expect(metadata.getMetadata(creation.sessionId)?.initialPrompt).toBe(
    request.message,
  );
  expect(() =>
    store.admit({
      requestId: "no_context",
      context: undefined as unknown as CreationContext,
      request,
    }),
  ).toThrow();
  expect(() =>
    store.admit({
      requestId: "no_source_",
      context: { owner: context.owner } as CreationContext,
      request,
    }),
  ).toThrow();
  expect(rows(database, "SELECT * FROM session_creations")).toHaveLength(1);
});
it("fences generations, binding, delivery, uncertain recovery and stale cleanup in the same SQLite transaction", async () => {
  const { store, metadata } = await fixture();
  const a = store.admit({ requestId: "request_0001", context, request });
  const b = store.admit({ requestId: "request_0002", context, request });
  const native = nativeSessionRef(
    "claude",
    "/native/project",
    parseNativeSessionId("native_00001"),
  );
  const activeA = store.beginDispatch(a.attempt),
    activeB = store.beginDispatch(b.attempt);
  expect(() => store.bindNative(a.attempt, native)).toThrow(
    StaleCreationAttempt,
  );
  store.bindNative(activeA, native);
  expect(() => store.bindNative(activeB, native)).toThrow(
    SessionIdentityConflict,
  );
  expect(metadata.identities.resolveYa(b.sessionId)?.native).toBeNull();
  expect(store.get(context.owner, b.requestId)?.attempt.state).toBe(
    "dispatching",
  );
  expect(store.bindNative(activeA, native).state).toBe("bound");
  expect(store.markDelivery(activeA, "uncertain").delivery).toBe("uncertain");
  expect(store.markDelivery(activeA, "consumed").delivery).toBe("consumed");
  expect(store.markUncertain(activeA).delivery).toBe("consumed");
  expect(() =>
    store.retry(context.owner, a.requestId, "retry_00001", activeA.attemptId),
  ).toThrow(SessionCreationConflict);
  expect(store.markUncertain(activeB).delivery).toBe("uncertain");
  expect(() => store.failBeforeEffects(activeB, "launch-refused")).toThrow(
    SessionCreationConflict,
  );
  store.delete(activeA);
  expect(() => store.bindNative(activeA, native)).toThrow(StaleCreationAttempt);
  expect(() => store.delete(activeA)).toThrow(StaleCreationAttempt);
  expect(
    store.admit({ requestId: a.requestId, context, request }),
  ).toMatchObject({ sessionId: a.sessionId, deleted: true, request: null });
  expect(metadata.identities.resolveYa(a.sessionId)?.native).toEqual(native);
});
it("replays retries before mutable checks, retains historical results, and refuses stale or over-capacity recovery", async () => {
  const { store, database } = await fixture();
  const a = store.admit({ requestId: "request_0001", context, request });
  store.failBeforeEffects(a.attempt, "startup-unavailable");
  const retry = store.retry(
    context.owner,
    a.requestId,
    "retry_00001",
    a.attempt.attemptId,
  );
  expect(
    store.retry(context.owner, a.requestId, "retry_00001", a.attempt.attemptId),
  ).toEqual(retry);
  expect(() =>
    store.retry(context.owner, a.requestId, "retry_00001", retry.attemptId),
  ).toThrow(SessionCreationConflict);
  expect(() =>
    store.retry(context.owner, a.requestId, "retry_00002", a.attempt.attemptId),
  ).toThrow(SessionCreationConflict);
  store.failBeforeEffects(retry, "launch-refused");
  const actualUsage = rows(
    database,
    "SELECT * FROM session_creation_capacity",
  )[0]!;
  database.exec(
    "UPDATE session_creation_capacity SET operations = 10000, payload_bytes = 536870912, attempt_bytes = 67108864",
  );
  expect(
    store.admit({ requestId: a.requestId, context, request }).sessionId,
  ).toBe(a.sessionId);
  expect(
    store.retry(context.owner, a.requestId, "retry_00001", a.attempt.attemptId),
  ).toMatchObject({ attemptId: retry.attemptId });
  expect(() =>
    store.admit({ requestId: "request_0002", context, request }),
  ).toThrow(SessionCreationCapacityError);
  expect(() =>
    store.retry(context.owner, a.requestId, "retry_00002", retry.attemptId),
  ).toThrow(SessionCreationCapacityError);
  expect(store.get(context.owner, a.requestId)?.attempt.attemptId).toBe(
    retry.attemptId,
  );
  database.exec(
    `UPDATE session_creation_capacity SET attempt_bytes = ${actualUsage.attempt_bytes}, payload_bytes = ${actualUsage.payload_bytes}; UPDATE session_creations SET attempt_count = 64`,
  );
  expect(() =>
    store.retry(context.owner, a.requestId, "retry_00003", retry.attemptId),
  ).toThrow(SessionCreationCapacityError);
  store.delete(retry);
  expect(
    store.retry(context.owner, a.requestId, "retry_00001", a.attempt.attemptId)
      .attemptId,
  ).toBe(retry.attemptId);
});
it("upgrades the actual identity schema without adopting or modifying existing native sessions", () => {
  const database = openSqliteOrThrow(":memory:");
  databases.push(database);
  migrateDiscoveryDatabase(database, discoveryMigrationPrefix(17));
  database.exec(
    "INSERT INTO session_metadata VALUES ('legacy', '{\"customTitle\":\"keep\"}')",
  );
  migrateDiscoveryDatabase(database);
  expect(rows(database, "SELECT * FROM session_metadata")).toMatchObject([
    { session_id: "legacy", metadata: '{"customTitle":"keep"}' },
  ]);
  expect(rows(database, "SELECT * FROM session_creations")).toEqual([]);
});
