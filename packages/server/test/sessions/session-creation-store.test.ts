import { createHash } from "node:crypto";
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
  const launch = {
    schemaVersion: 1 as const,
    model: "explicit-native-model",
    routerAccountId: "account_a",
    machineControl: true,
    sandboxLevel: "project-write" as const,
    sandboxNetworkFirewall: false,
    permissions: { allow: ["Read(*)"], deny: ["Bash(curl *)"] },
    compactAtContextPercent: 71,
    globalInstructions: "  selected global instructions\n",
    recapMode: "off" as const,
    desktopControlOrigin: { launch: "DO_NOT_PERSIST_CREDENTIAL" },
    instructionUsername: "do-not-trust-this-actor",
    env: { AUTH_TOKEN: "DO_NOT_PERSIST_ENV" },
  };
  const input = {
    schemaVersion: 1 as const,
    tempId: "optimistic-original",
    mode: "default" as const,
    metadata: {
      origin: "coordination" as const,
      sourceSessionId: "source-public-session",
      turnEffort: "fast" as const,
      serverReceivedAt: "2026-11-01T00:00:00.000Z",
      composition: {
        submittedAt: "2026-11-01T00:00:00.000Z",
        token: "DO_NOT_PERSIST_COMPOSITION",
      },
      speech: {
        clientTurnId: "speech-turn",
        transcriptionIds: ["transcription-one"],
        env: "DO_NOT_PERSIST_SPEECH",
      },
      sentByUser: "DO_NOT_PERSIST_ACTOR",
      apiSubmissionId: "DO_NOT_PERSIST_RECEIPT",
      hidden: true,
      environment: "DO_NOT_PERSIST_METADATA",
    },
    credentials: "DO_NOT_PERSIST_INPUT",
  };
  expect(first.store.generation).toBe(1);
  const admitted = first.store.admit({
    requestId: "request_0001",
    context,
    request: { ...request, launch, input },
  });
  expect(first.store.generation).toBe(2);
  const frozenRequest = structuredClone(admitted.request!);
  expect(admitted.initialInputId).toMatch(/^[a-f0-9-]{36}$/);
  expect(admitted.initialInputId).not.toBe(admitted.sessionId);
  expect(admitted.initialInputId).not.toBe(admitted.attempt.attemptId);
  expect(admitted.request?.launch).toMatchObject({
    model: launch.model,
    permissions: launch.permissions,
    sandboxLevel: "project-write",
    compactAtContextPercent: 71,
    globalInstructions: launch.globalInstructions,
  });
  const persisted = rows(
    first.database,
    "SELECT payload_json FROM session_creations",
  )[0]!.payload_json;
  expect(persisted).not.toContain("DO_NOT_PERSIST");
  expect(admitted.request?.launch).not.toHaveProperty("desktopControlOrigin");
  expect(admitted.request?.launch).not.toHaveProperty("instructionUsername");
  expect(admitted.request?.input?.metadata).not.toHaveProperty("sentByUser");
  expect(admitted.request?.input?.metadata).not.toHaveProperty(
    "apiSubmissionId",
  );
  expect(admitted.request?.input?.metadata).toHaveProperty("hidden", true);
  input.metadata.speech.transcriptionIds[0] = "caller mutation";
  input.metadata.composition.submittedAt = "2026-11-02T00:00:00.000Z";
  launch.permissions.allow[0] = "caller mutation";
  expect(
    first.store.get(context.owner, "request_0001")?.request?.launch?.permissions
      ?.allow,
  ).toEqual(["Read(*)"]);

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
  const reopenedGeneration = second.store.generation;
  expect(
    second.store.admit({
      requestId: "request_0001",
      context,
      request: frozenRequest,
    }).sessionId,
  ).toBe(admitted.sessionId);
  expect(second.store.generation).toBe(reopenedGeneration);
  expect(second.store.get(context.owner, "request_0001")?.initialInputId).toBe(
    admitted.initialInputId,
  );
  expect(
    second.store.get(context.owner, "request_0001")?.request?.input,
  ).toMatchObject({
    schemaVersion: 1,
    tempId: "optimistic-original",
    mode: "default",
    metadata: {
      sourceSessionId: "source-public-session",
      turnEffort: "fast",
      speech: { transcriptionIds: ["transcription-one"] },
      composition: { submittedAt: "2026-11-01T00:00:00.000Z" },
    },
  });
  expect(() =>
    second.store.admit({
      requestId: "request_0001",
      context,
      request: {
        ...frozenRequest,
        input: { ...frozenRequest.input!, tempId: "different-client-input" },
      },
    }),
  ).toThrow(SessionCreationConflict);
  expect(
    second.store.get(context.owner, "request_0001")?.request?.launch
      ?.globalInstructions,
  ).toBe(launch.globalInstructions);
  expect(() =>
    second.store.admit({
      requestId: "request_0001",
      context,
      request: {
        ...frozenRequest,
        launch: {
          ...frozenRequest.launch!,
          permissions: { deny: ["Write(*)"] },
        },
      },
    }),
  ).toThrow(SessionCreationConflict);
  const retiredLaunch = {
    ...frozenRequest.launch!,
    remoteEnv: { TOKEN: "DO_NOT_PERSIST" },
  };
  expect(() =>
    second.store.admit({
      requestId: "bad_remote_01",
      context,
      request: {
        ...frozenRequest,
        launch: retiredLaunch,
      },
    }),
  ).toThrow("Retired execution options");

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
  ).toMatchObject([
    { operations: 0, payload_bytes: 0, attempt_bytes: 0, generation: 1 },
  ]);
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
  const activeA = store.beginDispatch(a.attempt, native),
    activeB = store.beginDispatch(b.attempt, native);
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
  const inputId = a.initialInputId;
  const failedGeneration = store.generation;
  const retry = store.retry(
    context.owner,
    a.requestId,
    "retry_00001",
    a.attempt.attemptId,
  );
  expect(store.generation).toBe(failedGeneration + 1);
  expect(store.getForSession(a.sessionId)?.initialInputId).toBe(inputId);
  expect(
    store.retry(context.owner, a.requestId, "retry_00001", a.attempt.attemptId),
  ).toEqual(retry);
  expect(store.generation).toBe(failedGeneration + 1);
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

it("upgrades an existing admission database without changing its capacity counters", () => {
  const database = openSqliteOrThrow(":memory:");
  databases.push(database);
  migrateDiscoveryDatabase(database, discoveryMigrationPrefix(18));
  database.exec(
    "UPDATE session_creation_capacity SET operations = 4, payload_bytes = 123, attempt_bytes = 456 WHERE id = 1",
  );
  migrateDiscoveryDatabase(database);
  expect(
    rows(database, "SELECT * FROM session_creation_capacity"),
  ).toMatchObject([
    { operations: 4, payload_bytes: 123, attempt_bytes: 456, generation: 1 },
  ]);
});

it("preserves old creation replay without inventing an input identity during the actual 20→21 migration", async () => {
  const database = openSqliteOrThrow(":memory:");
  databases.push(database);
  migrateDiscoveryDatabase(database, discoveryMigrationPrefix(20));
  const normalized = {
    ...request,
    settings: {
      requestedModel: request.settings.requestedModel,
      permissionMode: request.settings.permissionMode,
      thinking: null,
      effort: null,
      serviceTier: null,
    },
  };
  const payload = JSON.stringify(normalized),
    source = JSON.stringify(context),
    bytes = Buffer.byteLength(payload) + Buffer.byteLength(source);
  const hash = createHash("sha256")
    .update(payload)
    .update("\0")
    .update(source)
    .digest("hex");
  const statements = [
    database.prepare(
      "INSERT INTO session_identities VALUES ('legacy-public', 'claude', ?, '2026-11-01T00:00:00Z', NULL, NULL, NULL)",
    ),
    database.prepare(
      "INSERT INTO session_creations (id, owner_key, request_key, request_hash, session_id, payload_json, payload_bytes, context_json, current_attempt, attempt_count, deleted, created_at) VALUES ('legacy-operation', 'limited:alice', 'legacy_request_01', ?, 'legacy-public', ?, ?, ?, 'legacy-attempt', 1, 0, '2026-11-01T00:00:00Z')",
    ),
    database.prepare(
      "INSERT INTO session_creation_attempts VALUES ('legacy-attempt', 'legacy-operation', 0, 'saved', 'not-admitted', '{}', 2, '2026-11-01T00:00:00Z')",
    ),
    database.prepare(
      "UPDATE session_creation_capacity SET operations = 1, payload_bytes = ?, attempt_bytes = 2",
    ),
  ];
  try {
    database.transaction(() => {
      statements[0]!.run(request.projectId);
      statements[1]!.run(hash, payload, bytes, source);
      statements[2]!.run();
      statements[3]!.run(bytes);
    });
  } finally {
    for (const statement of statements) statement.finalize();
  }
  migrateDiscoveryDatabase(database);
  const root = await mkdtemp(join(tmpdir(), "ya-old-creation-input-"));
  roots.push(root);
  const metadata = new SessionMetadataService({ database, dataDir: root });
  await metadata.initialize();
  const store = metadata.creations;
  const replay = store.admit({
    requestId: "legacy_request_01",
    context,
    request,
  });
  expect(replay).toMatchObject({
    sessionId: "legacy-public",
    initialInputId: null,
    request,
  });
  expect(replay.request?.launch).toBeUndefined();
  expect(store.generation).toBe(1);
  store.recoverOwnerLoss(() => false);
  expect(store.getForSession(replay.sessionId)?.attempt.state).toBe("saved");
  expect(store.generation).toBe(1);
  expect(
    rows(database, "SELECT request_hash, payload_json FROM session_creations"),
  ).toEqual([{ request_hash: hash, payload_json: payload }]);
});

it("recovers lost controllers without input replay and accepts only scoped current input proof", async () => {
  const root = await mkdtemp(join(tmpdir(), "ya-owned-recovery-"));
  roots.push(root);
  const { store, metadata } = await fixture();
  const admit = (requestId: string) =>
    store.admit({ requestId, context, request });
  const unbound = admit("owner-unbound");
  const bound = admit("owner-bound");
  const confirmed = admit("owner-confirmed");
  const queued = admit("owner-queued");
  const saved = admit("owner-saved");
  const one = { family: "claude" as const, storageScope: join(root, "one") };
  const two = { family: "claude" as const, storageScope: join(root, "two") };
  const three = {
    family: "claude" as const,
    storageScope: join(root, "three"),
  };
  const first = store.beginDispatch(unbound.attempt, one);
  const second = store.beginDispatch(bound.attempt, two);
  const third = store.beginDispatch(confirmed.attempt, three);
  const boundNative = nativeSessionRef(
    "claude",
    two.storageScope,
    parseNativeSessionId("native-bound"),
  );
  store.bindNative(second, boundNative);
  store.confirmOwnedInput(
    third,
    nativeSessionRef(
      "claude",
      three.storageScope,
      parseNativeSessionId("native-confirmed"),
    ),
    confirmed.initialInputId!,
  );
  store.markQueued(queued.attempt);
  const liveGeneration = store.generation;
  store.recoverOwnerLoss((pid) => {
    expect(pid).toBe(process.pid);
    return true;
  });
  expect(store.generation).toBe(liveGeneration);
  expect(store.getForSession(queued.sessionId)?.attempt.state).toBe("queued");
  expect(store.getForSession(unbound.sessionId)?.attempt.state).toBe(
    "dispatching",
  );
  store.recoverOwnerLoss(() => false);
  expect(store.getForSession(unbound.sessionId)?.attempt).toMatchObject({
    state: "uncertain",
    delivery: "uncertain",
  });
  expect(store.getForSession(bound.sessionId)?.attempt).toMatchObject({
    state: "uncertain",
    delivery: "uncertain",
  });
  expect(store.getForSession(confirmed.sessionId)?.attempt).toMatchObject({
    state: "bound",
    delivery: "consumed",
  });
  expect(store.getForSession(queued.sessionId)?.attempt).toMatchObject({
    state: "failed",
    delivery: "not-admitted",
    failure: "launch-refused",
  });
  expect(store.getForSession(saved.sessionId)?.attempt).toMatchObject({
    state: "failed",
    delivery: "not-admitted",
    failure: "launch-refused",
  });
  expect(store.getForSession(queued.sessionId)?.request?.message).toBe(
    request.message,
  );
  expect(store.getForSession(saved.sessionId)?.request?.message).toBe(
    request.message,
  );
  expect(store.getDispatchNamespace(first)).toEqual(one);
  const native = nativeSessionRef(
    "claude",
    one.storageScope,
    parseNativeSessionId("native-recovered"),
  );
  expect(() => store.confirmOwnedInput(first, native, "wrong-input")).toThrow(
    SessionCreationConflict,
  );
  expect(() =>
    store.confirmOwnedInput(
      { ...first, generation: first.generation + 1 },
      native,
      unbound.initialInputId!,
    ),
  ).toThrow(StaleCreationAttempt);
  expect(() =>
    store.confirmOwnedInput(
      first,
      { ...native, storageScope: two.storageScope },
      unbound.initialInputId!,
    ),
  ).toThrow(SessionCreationConflict);
  expect(metadata.identities.resolveYa(unbound.sessionId)?.native).toBeNull();
  // Binding proves the native owner, not delivery; it cannot reopen input.
  store.bindNative(first, native);
  expect(store.getForSession(unbound.sessionId)?.attempt.state).toBe(
    "uncertain",
  );
  expect(() =>
    store.confirmOwnedInput(
      first,
      { ...native, id: parseNativeSessionId("another-native") },
      unbound.initialInputId!,
    ),
  ).toThrow(SessionIdentityConflict);
  store.confirmOwnedInput(first, native, unbound.initialInputId!);
  store.confirmOwnedInput(second, boundNative, bound.initialInputId!);
  expect(store.getForSession(unbound.sessionId)?.attempt).toMatchObject({
    state: "bound",
    delivery: "consumed",
  });
  expect(store.getForSession(bound.sessionId)?.attempt).toMatchObject({
    state: "bound",
    delivery: "consumed",
  });
  expect(store.getDispatchNamespace(first)).toEqual(one);
  const generation = store.generation;
  store.confirmOwnedInput(first, native, unbound.initialInputId!);
  expect(store.generation).toBe(generation);
});

it("accounts attachment claims transactionally, rejects profile overflow and releases only the deleted operation", async () => {
  const { database, store } = await fixture();
  const attachments = {
    groupId: "a".repeat(64),
    files: [
      {
        id: "owned-file",
        name: "owned-file.txt",
        originalName: "file.txt",
        mimeType: "text/plain",
        size: 2 * 1024 ** 3,
        sha256: "b".repeat(64),
      },
    ],
  };
  const saved = store.admit({
    requestId: "owned-attachments-quota",
    context,
    request: { ...request, attachments },
  });
  expect(store.getAttachmentGroupId(context.owner, saved.requestId)).toBe(
    attachments.groupId,
  );
  expect(
    store.admit({
      requestId: saved.requestId,
      context,
      request: { ...request, attachments },
    }).sessionId,
  ).toBe(saved.sessionId);
  expect(() =>
    store.admit({
      requestId: "owned-attachments-overflow",
      context,
      request: {
        ...request,
        attachments: {
          ...attachments,
          files: [{ ...attachments.files[0]!, size: 1 }],
        },
      },
    }),
  ).toThrow(SessionCreationCapacityError);
  expect(
    rows(
      database,
      "SELECT operations, attachment_bytes FROM session_creation_capacity",
    ),
  ).toEqual([{ operations: 1, attachment_bytes: 2 * 1024 ** 3 }]);
  store.delete(saved.attempt);
  expect(
    store.getAttachmentGroupId(context.owner, saved.requestId),
  ).toBeUndefined();
  expect(
    rows(database, "SELECT attachment_bytes FROM session_creation_capacity"),
  ).toEqual([{ attachment_bytes: 0 }]);
  database.exec(
    "CREATE TRIGGER refuse_attachment_claim BEFORE INSERT ON session_creation_attempts BEGIN SELECT RAISE(ABORT, 'owned refusal'); END",
  );
  expect(() =>
    store.admit({
      requestId: "owned-attachments-rollback",
      context,
      request: { ...request, attachments },
    }),
  ).toThrow("owned refusal");
  expect(
    rows(
      database,
      "SELECT operations, attachment_bytes FROM session_creation_capacity",
    ),
  ).toEqual([{ operations: 1, attachment_bytes: 0 }]);
});
