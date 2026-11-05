import type {
  ProviderForkSource,
  ProviderForkBoundary,
} from "../sdk/providers/types.js";
import {
  snapshotCreationAttachments,
  type CreationAttachmentSnapshot,
} from "./creation-attachments.js";
import {
  snapshotCreationLaunch,
  type CreationLaunchSnapshot,
} from "./session-creation-launch.js";
import {
  snapshotCreationInput,
  type CreationInputSnapshot,
} from "./session-creation-input.js";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  ALL_PERMISSION_MODES,
  ALL_PROVIDERS,
  EFFORT_LEVEL_ORDER,
  assertUrlProjectId,
  parseYaSessionId,
  nativeSessionFamily,
  nativeSessionRef,
  parseNativeSessionId,
  type NativeSessionRef,
  type SessionCreationStatus,
  type ProviderName,
  type SessionCreationProvenance,
  type UrlProjectId,
  type YaSessionId,
} from "@yep-anywhere/shared";
import type {
  EffectiveSessionLaunchSettingsValue,
  SessionMetadataService,
} from "../metadata/SessionMetadataService.js";
import {
  validateNativeSessionNamespace,
  type NativeSessionNamespace,
} from "./SessionIdentityStore.js";
import type { SqliteDatabase, SqliteStatement } from "../storage/sqlite.js";
import type { CreationLineage } from "./SessionRelationshipWriter.js";

/** Trusted ownership, separate from descriptive client hints. Never stores grants. */
export type CreationOwner =
  | { kind: "superuser" }
  | { kind: "limited"; username: string };
export type CreationContext = {
  owner: CreationOwner;
  source:
    | { kind: "request"; provenance: SessionCreationProvenance }
    | { kind: "unknown"; reason: "legacy-project-queue" }
    | { kind: "internal"; reason: "recap" | "retitle" | "fork-summary" };
};
export interface CreationCopySnapshot {
  kind: "fork" | "clone";
  sourceSessionId: string;
  source: ProviderForkSource;
  upToMessageId?: string;
  boundary?: ProviderForkBoundary;
  title?: string;
}
export interface SavedCreationRequest {
  /** Hash of the submitted wire request, before mutable launch defaults. */
  submissionHash?: string;
  provider: ProviderName;
  projectId: UrlProjectId;
  projectPath: string;
  message: string;
  intent?: "prepare" | "copy";
  copy?: CreationCopySnapshot;
  /** Trusted server-side operation context; never a submitted provenance hint. */
  lineage?: CreationLineage;
  settings: EffectiveSessionLaunchSettingsValue;
  /** Absent only on storage-foundation/legacy records with no runtime launch. */
  launch?: CreationLaunchSnapshot;
  input?: CreationInputSnapshot;
  attachments?: CreationAttachmentSnapshot;
}
export type CreationState = SessionCreationStatus["state"];
export type CreationDelivery = SessionCreationStatus["delivery"];
export interface SessionCreationProjection {
  sessionId: YaSessionId;
  projectId: UrlProjectId;
  provider: ProviderName;
  createdAt: string;
  updatedAt: string;
  nativeBound: boolean;
  deleted: boolean;
  creation: SessionCreationStatus;
}
interface ProjectionRow {
  creation_id: string;
  generation: number;
  session_id: string;
  project_id: string;
  provider: ProviderName;
  created_at: string;
  updated_at: string;
  native_bound: number;
  deleted: number;
  input_expected: number;
  attempt_id: string;
  state: CreationState;
  delivery: CreationDelivery;
  detail_json: string;
}
export interface CreationAttemptFence {
  readonly creationId: string;
  readonly attemptId: string;
  readonly generation: number;
}
export interface CreationAttempt extends CreationAttemptFence {
  readonly kind?: "copy";
  readonly state: CreationState;
  readonly delivery: CreationDelivery;
  readonly updatedAt: string;
  readonly failure?: SessionCreationStatus["failure"];
}
export interface SavedSessionCreation {
  readonly id: string;
  readonly requestId: string;
  /** Null marks an older record that cannot be dispatched as a fresh request. */
  readonly initialInputId: string | null;
  readonly sessionId: YaSessionId;
  readonly request: SavedCreationRequest | null;
  readonly context: CreationContext;
  readonly attempt: CreationAttempt;
  readonly deleted: boolean;
  readonly createdAt: string;
}
export class SessionCreationConflict extends Error {
  constructor() {
    super("Creation request or attempt conflicts with saved state");
  }
}
export class SessionCreationCapacityError extends Error {
  constructor() {
    super("Saved session creation capacity reached");
  }
}
export class StaleCreationAttempt extends Error {
  constructor() {
    super("Session creation attempt is no longer current");
  }
}
interface OperationRow {
  id: string;
  owner_key: string;
  request_key: string;
  initial_input_id: string | null;
  input_expected: number;
  request_hash: string;
  session_id: string;
  payload_json: string | null;
  payload_bytes: number;
  context_json: string;
  current_attempt: string;
  attempt_count: number;
  deleted: number;
  created_at: string;
}
type CreationControlRow = Pick<
  OperationRow,
  "id" | "current_attempt" | "input_expected" | "created_at" | "deleted"
>;
interface AttemptRow {
  id: string;
  creation_id: string;
  generation: number;
  state: CreationState;
  delivery: CreationDelivery;
  detail_json: string;
  detail_bytes: number;
  updated_at: string;
}
interface RetryRow {
  failed_attempt: string;
  result_attempt: string;
}
const MAX_OPERATIONS = 10_000,
  MAX_PAYLOAD = 512 * 1024 * 1024,
  MAX_REQUEST = 256 * 1024,
  MAX_ATTEMPTS = 64,
  MAX_ATTEMPT_BYTES = 64 * 1024 * 1024;
const keyPattern = /^[A-Za-z0-9_-]{8,128}$/;
function key(value: string): string {
  if (typeof value !== "string" || !keyPattern.test(value))
    throw new Error("Invalid creation request key");
  return value;
}
function ownerKey(owner: CreationOwner): string {
  if (owner?.kind === "superuser") return "superuser";
  if (
    owner?.kind === "limited" &&
    typeof owner.username === "string" &&
    /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(owner.username)
  )
    return `limited:${owner.username}`;
  throw new Error("Creation requires an authenticated owner");
}
function bounded(value: unknown, limit: number): string | undefined {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length === 0 || value.length > limit)
    throw new Error("Invalid creation context field");
  return value;
}
/** Rebuild the persisted context, excluding transport credentials and live grants. */
function contextSnapshot(context: CreationContext): CreationContext {
  ownerKey(context?.owner);
  const owner: CreationOwner =
    context.owner.kind === "limited"
      ? { kind: "limited", username: context.owner.username }
      : { kind: "superuser" };
  if (
    context.source?.kind === "unknown" &&
    context.source.reason === "legacy-project-queue"
  )
    return {
      owner,
      source: { kind: "unknown", reason: "legacy-project-queue" },
    };
  if (context.source?.kind === "internal") {
    if (!["recap", "retitle", "fork-summary"].includes(context.source.reason))
      throw new Error("Invalid internal creation reason");
    return {
      owner,
      source: { kind: "internal", reason: context.source.reason },
    };
  }
  if (context.source?.kind !== "request")
    throw new Error("Creation requires an explicit source decision");
  const p = context.source.provenance;
  if (!p || !["web", "desktop", "api"].includes(p.surface))
    throw new Error("Invalid creation provenance");
  const clientOrigin = bounded(p.clientOrigin, 512),
    clientVersion = bounded(p.clientVersion, 120),
    clientCommit = bounded(p.clientCommit, 120);
  if (clientOrigin) {
    const url = new URL(clientOrigin);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.origin !== clientOrigin
    )
      throw new Error("Invalid creation origin");
  }
  return {
    owner,
    source: {
      kind: "request",
      provenance: {
        surface: p.surface,
        ...(clientOrigin ? { clientOrigin } : {}),
        ...(clientVersion ? { clientVersion } : {}),
        ...(clientCommit ? { clientCommit } : {}),
      },
    },
  };
}
function requestSnapshot(request: SavedCreationRequest): SavedCreationRequest {
  if (
    request?.submissionHash !== undefined &&
    !/^[a-f0-9]{64}$/.test(request.submissionHash)
  )
    throw new Error("Invalid creation submission hash");
  if (
    request?.intent !== undefined &&
    (!["prepare", "copy"].includes(request.intent) ||
      (request.intent === "prepare" && request.message !== "") ||
      request.attachments !== undefined ||
      request.input?.nativeReceiptId ||
      (request.intent === "copy") !== Boolean(request.copy))
  )
    throw new Error("Invalid non-input session intent");
  if (request?.copy && request.intent !== "copy")
    throw new Error("Copy intent is required");
  let copy: CreationCopySnapshot | undefined;
  if (request?.copy) {
    const c = request.copy,
      source = c.source;
    if (
      !["fork", "clone"].includes(c.kind) ||
      !source ||
      !isAbsolute(source.filePath) ||
      !source.native ||
      source.native.family !== nativeSessionFamily(request.provider)
    )
      throw new Error("Invalid saved copy source");
    assertUrlProjectId(source.projectId);
    const native = nativeSessionRef(
      source.native.family,
      source.native.storageScope,
      parseNativeSessionId(source.native.id),
    );
    validateNativeSessionNamespace(native);
    const sourceSessionId = bounded(c.sourceSessionId, 128);
    if (!sourceSessionId) throw new Error("Copy requires its logical source");
    let boundary: ProviderForkBoundary | undefined;
    if (c.boundary) {
      const b = c.boundary;
      if (b.provider !== request.provider)
        throw new Error("Copy boundary provider mismatch");
      if (b.kind === "message" && bounded(b.messageId, 256))
        boundary = {
          kind: b.kind,
          provider: b.provider,
          messageId: b.messageId,
        };
      else if (b.kind === "turn" && bounded(b.turnId, 256))
        boundary = { kind: b.kind, provider: b.provider, turnId: b.turnId };
      else if (b.kind === "entry" && bounded(b.entryId, 256))
        boundary = { kind: b.kind, provider: b.provider, entryId: b.entryId };
      else throw new Error("Invalid copy boundary");
    }
    copy = {
      kind: c.kind,
      sourceSessionId,
      source: {
        native,
        filePath: source.filePath,
        projectId: source.projectId,
      },
      ...(boundary ? { boundary } : {}),
      ...(c.upToMessageId
        ? { upToMessageId: bounded(c.upToMessageId, 256) }
        : {}),
      ...(c.title ? { title: bounded(c.title, 4096) } : {}),
    };
  }
  if (
    !request ||
    !ALL_PROVIDERS.includes(request.provider) ||
    typeof request.message !== "string" ||
    typeof request.projectPath !== "string" ||
    !isAbsolute(request.projectPath)
  )
    throw new Error("Invalid saved creation request");
  assertUrlProjectId(request.projectId);
  const s = request.settings;
  if (
    !s ||
    !ALL_PERMISSION_MODES.includes(s.permissionMode) ||
    !(s.requestedModel === null || typeof s.requestedModel === "string") ||
    !(s.serviceTier === null || typeof s.serviceTier === "string") ||
    !(s.effort === null || EFFORT_LEVEL_ORDER.includes(s.effort))
  )
    throw new Error("Invalid saved launch settings");
  const t = s.thinking;
  if (
    t !== null &&
    (!t || !["adaptive", "enabled", "disabled"].includes(t.type))
  )
    throw new Error("Invalid saved thinking settings");
  if (
    t?.type === "enabled" &&
    t.budgetTokens !== undefined &&
    (!Number.isSafeInteger(t.budgetTokens) || t.budgetTokens < 0)
  )
    throw new Error("Invalid thinking budget");
  if (
    t &&
    "display" in t &&
    t.display !== undefined &&
    t.display !== "summarized" &&
    t.display !== "omitted"
  )
    throw new Error("Invalid thinking display");
  const thinking =
    t === null
      ? null
      : t.type === "disabled"
        ? { type: t.type }
        : {
            type: t.type,
            ...(t.type === "enabled" && t.budgetTokens !== undefined
              ? { budgetTokens: t.budgetTokens }
              : {}),
            ...(t.display !== undefined ? { display: t.display } : {}),
          };
  return {
    provider: request.provider,
    ...(request.lineage
      ? {
          lineage: {
            ...(request.lineage.asideOf
              ? { asideOf: parseYaSessionId(request.lineage.asideOf) }
              : {}),
            ...(request.lineage.continuedFrom
              ? {
                  continuedFrom: parseYaSessionId(
                    request.lineage.continuedFrom,
                  ),
                }
              : {}),
          },
        }
      : {}),
    ...(request.submissionHash
      ? { submissionHash: request.submissionHash }
      : {}),
    projectId: request.projectId,
    projectPath: request.projectPath,
    message: request.message,
    ...(request.intent ? { intent: request.intent } : {}),
    ...(copy ? { copy } : {}),
    ...(request.launch !== undefined
      ? { launch: snapshotCreationLaunch(request.launch) }
      : {}),
    ...(request.input !== undefined
      ? { input: snapshotCreationInput(request.input) }
      : {}),
    ...(request.attachments !== undefined
      ? { attachments: snapshotCreationAttachments(request.attachments) }
      : {}),
    settings: {
      requestedModel: s.requestedModel,
      permissionMode: s.permissionMode,
      thinking,
      effort: s.effort,
      serviceTier: s.serviceTier,
    },
  };
}

/** Conservative liveness only; a live/reused PID never authorizes recovery. */
function controllerAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Profile-owned synchronous control state. Fixed statements, no timers or caches. */
export class SessionCreationStore {
  /** App-owned subscribers are released at app disposal, not retained per session. */
  private readonly listeners = new Set<
    (sessionId: YaSessionId, creation: SessionCreationStatus) => void
  >();
  /** Exists only during one synchronous transaction, bounded by creation capacity. */
  private transactionChanges?: Set<string>;

  subscribeChanges(
    listener: (sessionId: YaSessionId, creation: SessionCreationStatus) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publishChange(creationId: string): void {
    if (!this.listeners.size) return;
    const row = this.statements.byId.get<OperationRow>(creationId);
    if (!row) return;
    const sessionId = parseYaSessionId(row.session_id);
    const status = this.statusForSession(sessionId)!;
    for (const listener of this.listeners) {
      try {
        listener(sessionId, status);
      } catch (error) {
        // A failed observer must not turn a committed creation into a refusal.
        console.error("[SessionCreationStore] Status listener failed", error);
      }
    }
  }

  private transaction<T>(operation: () => T): T {
    const changes = new Set<string>();
    const result = this.database.transaction(() => {
      this.transactionChanges = changes;
      try {
        return operation();
      } finally {
        this.transactionChanges = undefined;
      }
    });
    // Failed writes/COMMITs never publish, and observers may safely read SQLite.
    for (const id of changes) this.publishChange(id);
    return result;
  }
  private readonly statements: Record<
    | "claimNative"
    | "nativeClaim"
    | "releaseNativeClaim"
    | "advanceGeneration"
    | "projections"
    | "byId"
    | "byKey"
    | "publicByKey"
    | "attachmentGroup"
    | "bySession"
    | "attempt"
    | "retry"
    | "capacity"
    | "reserve"
    | "insert"
    | "insertAttempt"
    | "updateAttempt"
    | "current"
    | "insertRetry"
    | "removePayload",
    SqliteStatement
  >;
  constructor(
    private readonly database: SqliteDatabase,
    private readonly metadata: SessionMetadataService,
  ) {
    metadata.assertProfileConnection(database);
    this.statements = {
      claimNative: database.prepare(
        "INSERT INTO native_session_allocations (creation_id, attempt_id, generation, native_family, native_scope) VALUES (?, ?, ?, ?, ?)",
      ),
      nativeClaim: database.prepare(
        "SELECT * FROM native_session_allocations WHERE creation_id = ?",
      ),
      releaseNativeClaim: database.prepare(
        "DELETE FROM native_session_allocations WHERE creation_id = ? AND attempt_id = ? AND generation = ?",
      ),
      advanceGeneration: database.prepare(
        "UPDATE session_creation_capacity SET generation = generation + 1 WHERE id = 1",
      ),
      projections: database.prepare(
        "SELECT c.id AS creation_id, a.generation, i.session_id, i.project_id, i.provider, i.created_at, a.updated_at, i.native_id IS NOT NULL AS native_bound, c.deleted, c.input_expected, a.id AS attempt_id, a.state, a.delivery, a.detail_json FROM session_creations c JOIN session_identities i ON i.session_id = c.session_id JOIN session_creation_attempts a ON a.id = c.current_attempt",
      ),
      byId: database.prepare("SELECT * FROM session_creations WHERE id = ?"),
      publicByKey: database.prepare(
        "SELECT session_id FROM session_creations WHERE owner_key = ? AND request_key = ?",
      ),
      attachmentGroup: database.prepare(
        "SELECT json_extract(payload_json, '$.attachments.groupId') AS group_id FROM session_creations WHERE owner_key = ? AND request_key = ? AND deleted = 0",
      ),
      byKey: database.prepare(
        "SELECT * FROM session_creations WHERE owner_key = ? AND request_key = ?",
      ),
      bySession: database.prepare(
        "SELECT id, current_attempt, input_expected, created_at, deleted FROM session_creations WHERE session_id = ?",
      ),
      attempt: database.prepare(
        "SELECT * FROM session_creation_attempts WHERE id = ?",
      ),
      retry: database.prepare(
        "SELECT * FROM session_creation_retries WHERE creation_id = ? AND retry_key = ?",
      ),
      capacity: database.prepare(
        "SELECT * FROM session_creation_capacity WHERE id = 1",
      ),
      reserve: database.prepare(
        "UPDATE session_creation_capacity SET operations = operations + ?, payload_bytes = payload_bytes + ?, attempt_bytes = attempt_bytes + ?, attachment_bytes = attachment_bytes + ? WHERE id = 1",
      ),
      insert: database.prepare(
        "INSERT INTO session_creations (id, owner_key, request_key, request_hash, session_id, payload_json, payload_bytes, context_json, current_attempt, attempt_count, created_at, initial_input_id, input_expected) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
      ),
      insertAttempt: database.prepare(
        "INSERT INTO session_creation_attempts (id, creation_id, state, delivery, detail_json, detail_bytes, updated_at) VALUES (?, ?, 'saved', 'not-admitted', ?, ?, ?)",
      ),
      updateAttempt: database.prepare(
        "UPDATE session_creation_attempts SET generation = ?, state = ?, delivery = ?, detail_json = ?, detail_bytes = ?, updated_at = ? WHERE id = ?",
      ),
      current: database.prepare(
        "UPDATE session_creations SET current_attempt = ?, attempt_count = attempt_count + 1 WHERE id = ?",
      ),
      insertRetry: database.prepare(
        "INSERT INTO session_creation_retries VALUES (?, ?, ?, ?)",
      ),
      removePayload: database.prepare(
        "UPDATE session_creations SET payload_json = NULL, payload_bytes = 0, deleted = 1 WHERE id = ?",
      ),
    };
  }
  /** One fixed-size scalar read; no per-session scan or timer. */
  get generation(): number {
    return this.statements.capacity.get<{ generation: number }>()!.generation;
  }

  /** Once per Hono startup: compact control rows only, never saved prompts. */
  recoverOwnerLoss(
    isControllerAlive: (pid: number) => boolean = controllerAlive,
  ): void {
    this.transaction(() => {
      const liveness = new Map<number, boolean>();
      for (const row of this.statements.projections.all<ProjectionRow>()) {
        const { controllerPid } = JSON.parse(row.detail_json) as {
          controllerPid?: number;
        };
        if (controllerPid !== undefined) {
          if (!liveness.has(controllerPid))
            liveness.set(controllerPid, isControllerAlive(controllerPid));
          // Another API controller may still own this exact attempt/queue,
          // including a duplicate startup that has not attempted its bind yet.
          if (liveness.get(controllerPid)) continue;
        }
        if (!row.deleted && ["saved", "queued"].includes(row.state)) {
          // Legacy attempts have no controller evidence; do not infer owner loss.
          if (controllerPid === undefined) continue;
          // The prior controller's in-memory dispatch queue cannot promote this
          // item. No dispatch fence was entered, so preserve intent as a safe
          // failure rather than an indefinitely queued session or silent replay.
          this.update(
            {
              creationId: row.creation_id,
              attemptId: row.attempt_id,
              generation: row.generation,
            },
            "failed",
            "not-admitted",
            "launch-refused",
          );
          continue;
        }
        if (
          row.deleted ||
          row.delivery === "consumed" ||
          (row.input_expected === 0 && row.state === "bound") ||
          !["dispatching", "bound"].includes(row.state)
        )
          continue;
        this.update(
          {
            creationId: row.creation_id,
            attemptId: row.attempt_id,
            generation: row.generation,
          },
          "uncertain",
          "uncertain",
        );
      }
    });
  }

  /** At most 10,000 compact rows; never fetch/parse saved request payloads. */
  listProjections(): SessionCreationProjection[] {
    return this.statements.projections.all<ProjectionRow>().map((row) => {
      assertUrlProjectId(row.project_id);
      const detail: Pick<SessionCreationStatus, "failure" | "kind"> =
        JSON.parse(row.detail_json);
      return {
        sessionId: parseYaSessionId(row.session_id),
        projectId: row.project_id,
        provider: row.provider,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        nativeBound: row.native_bound === 1,
        deleted: row.deleted === 1,
        creation: {
          state: row.state,
          attemptId: row.attempt_id,
          updatedAt: row.updated_at,
          delivery: row.delivery,
          ...(row.input_expected === 0
            ? { initialInputExpected: false as const }
            : {}),
          ...(detail.kind === "copy" ? { kind: "copy" as const } : {}),
          ...(detail.failure ? { failure: detail.failure } : {}),
        },
      };
    });
  }

  /** Point status avoids decoding the immutable request/context payload. */
  statusForSession(sessionId: YaSessionId): SessionCreationStatus | undefined {
    const row = this.statements.bySession.get<CreationControlRow>(
      parseYaSessionId(sessionId),
    );
    if (!row) return;
    const attempt = this.readAttempt(row.current_attempt);
    return {
      revision: this.generation,
      state: attempt.state,
      attemptId: attempt.attemptId,
      updatedAt: attempt.updatedAt,
      delivery: attempt.delivery,
      ...(row.input_expected === 0
        ? { initialInputExpected: false as const }
        : {}),
      ...(attempt.kind ? { kind: attempt.kind } : {}),
      ...(attempt.failure ? { failure: attempt.failure } : {}),
    };
  }

  private readAttempt(id: string): CreationAttempt {
    const row = this.statements.attempt.get<AttemptRow>(id);
    if (!row) throw new Error("Missing saved creation attempt");
    const detail: Pick<CreationAttempt, "failure" | "kind"> = JSON.parse(
      row.detail_json,
    );
    return {
      creationId: row.creation_id,
      attemptId: row.id,
      generation: row.generation,
      state: row.state,
      delivery: row.delivery,
      updatedAt: row.updated_at,
      ...(detail.kind === "copy" ? { kind: "copy" as const } : {}),
      ...(detail.failure ? { failure: detail.failure } : {}),
    };
  }
  private read(row: OperationRow): SavedSessionCreation {
    return {
      id: row.id,
      requestId: row.request_key,
      initialInputId: row.initial_input_id,
      sessionId: parseYaSessionId(row.session_id),
      request:
        row.payload_json === null
          ? null
          : requestSnapshot(JSON.parse(row.payload_json)),
      context: contextSnapshot(JSON.parse(row.context_json)),
      attempt: this.readAttempt(row.current_attempt),
      deleted: row.deleted === 1,
      createdAt: row.created_at,
    };
  }
  /** Indexed retention claim; does not read saved prompts or launch payloads. */
  getAttachmentGroupId(
    owner: CreationOwner,
    requestId: string,
  ): string | undefined {
    return (
      this.statements.attachmentGroup.get<{ group_id: string | null }>(
        ownerKey(owner),
        key(requestId),
      )?.group_id ?? undefined
    );
  }

  /** Compact association recovery without reading saved payloads. */
  getPublicSessionId(
    owner: CreationOwner,
    requestId: string,
  ): YaSessionId | undefined {
    const row = this.statements.publicByKey.get<{ session_id: string }>(
      ownerKey(owner),
      key(requestId),
    );
    return row ? parseYaSessionId(row.session_id) : undefined;
  }
  /** Caller authorizes current resource access before exposing this private row. */
  get(
    owner: CreationOwner,
    requestId: string,
  ): SavedSessionCreation | undefined {
    const row = this.statements.byKey.get<OperationRow>(
      ownerKey(owner),
      key(requestId),
    );
    return row ? this.read(row) : undefined;
  }
  getForSession(sessionId: YaSessionId): SavedSessionCreation | undefined {
    const control = this.statements.bySession.get<CreationControlRow>(
      parseYaSessionId(sessionId),
    );
    const row = control && this.statements.byId.get<OperationRow>(control.id);
    return row ? this.read(row) : undefined;
  }
  /** Source admission evidence only; neither discovery adoption nor an access grant. */
  admissionForSession(
    sessionId: YaSessionId,
  ): { createdAt: string; deleted: boolean; copy: boolean } | undefined {
    const row = this.statements.bySession.get<CreationControlRow>(
      parseYaSessionId(sessionId),
    );
    return row
      ? {
          createdAt: row.created_at,
          deleted: row.deleted === 1,
          copy: this.readAttempt(row.current_attempt).kind === "copy",
        }
      : undefined;
  }
  assertAttachmentCapacity(bytes: number): void {
    const usage = this.statements.capacity.get<{ attachment_bytes: number }>()!;
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      usage.attachment_bytes + bytes > 2 * 1024 ** 3
    )
      throw new SessionCreationCapacityError();
  }
  private reserve(
    operations: number,
    payload: number,
    attempts: number,
    attachments = 0,
  ): void {
    const usage = this.statements.capacity.get<{
      operations: number;
      payload_bytes: number;
      attempt_bytes: number;
      attachment_bytes: number;
    }>()!;
    if (
      usage.operations + operations > MAX_OPERATIONS ||
      usage.payload_bytes + payload > MAX_PAYLOAD ||
      usage.attempt_bytes + attempts > MAX_ATTEMPT_BYTES ||
      usage.attachment_bytes + attachments > 2 * 1024 ** 3
    )
      throw new SessionCreationCapacityError();
    this.statements.reserve.run(operations, payload, attempts, attachments);
  }
  /** No provider effects. The exact initial text and normalized facts commit together. */
  admit(input: {
    requestId: string;
    context: CreationContext;
    request: SavedCreationRequest;
  }): SavedSessionCreation {
    const requestId = key(input.requestId),
      context = contextSnapshot(input.context),
      request = requestSnapshot(input.request);
    const payload = JSON.stringify(request),
      contextText = JSON.stringify(context),
      bytes = Buffer.byteLength(payload) + Buffer.byteLength(contextText);
    if (bytes > MAX_REQUEST) throw new SessionCreationCapacityError();
    const hash = createHash("sha256")
      .update(payload)
      .update("\0")
      .update(contextText)
      .digest("hex");
    const existing = this.statements.byKey.get<OperationRow>(
      ownerKey(context.owner),
      requestId,
    );
    if (existing) {
      if (existing.request_hash !== hash) throw new SessionCreationConflict();
      return this.read(existing);
    }
    const sessionId = parseYaSessionId(randomUUID()),
      id = randomUUID(),
      attempt = randomUUID(),
      initialInputId = request.input?.nativeReceiptId ?? randomUUID(),
      now = new Date().toISOString();
    const detail = JSON.stringify({
      controllerPid: process.pid,
      ...(request.intent === "copy" ? { kind: "copy" } : {}),
    });
    const detailBytes = Buffer.byteLength(detail);
    try {
      this.metadata.commitNewSession(
        this.database,
        sessionId,
        {
          provider: request.provider,
          initialPrompt: request.message,
          workingProjectId: request.projectId,
          sandboxLevel: request.launch?.sandboxLevel ?? "none",
          sandboxEverConfined: request.launch?.sandboxLevel === "project-write",
          ...(request.launch?.sandboxLevel === "project-write"
            ? {
                sandboxNetworkFirewall:
                  request.launch.sandboxNetworkFirewall !== false,
                sandboxProjectPath: request.projectPath,
                ...(request.launch.sandboxStateKey
                  ? { sandboxStateKey: request.launch.sandboxStateKey }
                  : {}),
              }
            : {}),
          ...(request.settings.requestedModel
            ? { requestedModel: request.settings.requestedModel }
            : {}),
          ...(request.launch?.promptSuggestionMode !== undefined
            ? { promptSuggestionMode: request.launch.promptSuggestionMode }
            : {}),
          ...(request.launch?.recapAfterSeconds !== undefined
            ? { recapAfterSeconds: request.launch.recapAfterSeconds }
            : {}),
          ...(request.launch?.recapMode !== undefined
            ? { recapMode: request.launch.recapMode }
            : {}),
          ...(request.copy
            ? {
                forkedFromSessionId: request.copy.sourceSessionId,
                ...(request.copy.source.projectId !== request.projectId
                  ? {
                      workingProjectId: request.projectId,
                      transcriptProjectId: request.copy.source.projectId,
                    }
                  : {}),
              }
            : {}),
          ...(request.copy?.title ? { customTitle: request.copy.title } : {}),
          ...(request.lineage?.asideOf
            ? {
                parentSessionId: request.lineage.asideOf,
                parentSessionKind: "btw-aside" as const,
              }
            : {}),
          effectiveLaunchSettings: {
            schemaVersion: 1,
            revision: 1,
            ...request.settings,
          },
          ...(context.source.kind === "internal" ? { isArchived: true } : {}),
          ...(context.owner.kind === "limited"
            ? { createdByUser: context.owner.username }
            : {}),
          ...(context.source.kind === "request"
            ? { creationProvenance: context.source.provenance }
            : {}),
        },
        () => {
          if (this.statements.byKey.get(ownerKey(context.owner), requestId))
            throw new SessionCreationConflict();
          this.reserve(
            1,
            bytes,
            detailBytes,
            request.attachments?.files.reduce((sum, f) => sum + f.size, 0) ?? 0,
          );
          this.metadata.identities.allocateWithinTransaction({
            sessionId,
            provider: request.provider,
            projectId: request.copy?.source.projectId ?? request.projectId,
            createdAt: now,
          });
          this.statements.insert.run(
            id,
            ownerKey(context.owner),
            requestId,
            hash,
            sessionId,
            payload,
            bytes,
            contextText,
            attempt,
            now,
            initialInputId,
            request.intent ? 0 : 1,
          );
          this.statements.insertAttempt.run(
            attempt,
            id,
            detail,
            detailBytes,
            now,
          );
          this.statements.advanceGeneration.run();
          this.metadata.relationships.creationWithinTransaction({
            id,
            sessionId,
            createdAt: now,
            copy: request.copy,
            lineage: request.lineage,
            nativeReceiptId:
              context.owner.kind === "superuser" &&
              requestId === initialInputId &&
              request.input?.nativeReceiptId === requestId
                ? requestId
                : undefined,
          });
        },
      );
    } catch (error) {
      if (!(error instanceof SessionCreationConflict)) throw error;
      const raced = this.statements.byKey.get<OperationRow>(
        ownerKey(context.owner),
        requestId,
      );
      if (!raced || raced.request_hash !== hash) throw error;
      return this.read(raced);
    }
    const saved = this.get(context.owner, requestId)!;
    this.publishChange(saved.id);
    return saved;
  }
  /** Every callback/effect rechecks this fence; possession of an old reference is insufficient. */
  assertCurrent(fence: CreationAttemptFence): SavedSessionCreation {
    const row = this.statements.attempt.get<AttemptRow>(fence.attemptId);
    if (
      !row ||
      row.creation_id !== fence.creationId ||
      row.generation !== fence.generation
    )
      throw new StaleCreationAttempt();
    // Indexed lookup via the identity referenced by this operation's current attempt.
    const current = this.byAttemptSession(row);
    if (current.deleted || current.attempt.attemptId !== fence.attemptId)
      throw new StaleCreationAttempt();
    return current;
  }
  private byAttemptSession(row: AttemptRow): SavedSessionCreation {
    const operation = this.statements.byId.get<OperationRow>(row.creation_id);
    if (!operation) throw new StaleCreationAttempt();
    return this.read(operation);
  }

  private update(
    fence: CreationAttemptFence,
    state: CreationState,
    delivery: CreationDelivery,
    failure?: CreationAttempt["failure"],
    generation = fence.generation,
    namespace?: NativeSessionNamespace,
  ): CreationAttempt {
    const previous = this.statements.attempt.get<AttemptRow>(fence.attemptId)!;
    const retained: {
      nativeNamespace?: NativeSessionNamespace;
      controllerPid?: number;
      kind?: "copy";
    } = JSON.parse(previous.detail_json);
    const nativeNamespace = namespace ?? retained.nativeNamespace;
    const detail = JSON.stringify({
        ...(retained.kind === "copy" ? { kind: "copy" } : {}),
        ...(retained.controllerPid !== undefined
          ? { controllerPid: retained.controllerPid }
          : {}),
        ...(nativeNamespace
          ? { nativeNamespace: validateNativeSessionNamespace(nativeNamespace) }
          : {}),
        ...(failure ? { failure } : {}),
      }),
      size = Buffer.byteLength(detail);
    if (size > 8192) throw new SessionCreationCapacityError();
    this.reserve(0, 0, size - previous.detail_bytes);
    this.statements.updateAttempt.run(
      generation,
      state,
      delivery,
      detail,
      size,
      new Date().toISOString(),
      fence.attemptId,
    );
    this.statements.advanceGeneration.run();
    if (
      previous.state !== state ||
      previous.delivery !== delivery ||
      previous.generation !== generation ||
      previous.detail_json !== detail
    )
      this.transactionChanges?.add(fence.creationId);
    return this.readAttempt(fence.attemptId);
  }
  markQueued(fence: CreationAttemptFence): CreationAttempt {
    return this.transaction(() => {
      const current = this.assertCurrent(fence);
      if (current.attempt.state !== "saved")
        throw new SessionCreationConflict();
      return this.update(fence, "queued", "not-admitted");
    });
  }
  /** Persist before the external launch. The returned generation owns its callbacks. */
  beginDispatch(
    fence: CreationAttemptFence,
    namespace: NativeSessionNamespace,
  ): CreationAttempt {
    const selected = validateNativeSessionNamespace(namespace);
    return this.transaction(() => {
      const current = this.assertCurrent(fence);
      if (!["saved", "queued"].includes(current.attempt.state))
        throw new SessionCreationConflict();
      if (nativeSessionFamily(current.request!.provider) !== selected.family)
        throw new SessionCreationConflict();
      this.statements.claimNative.run(
        fence.creationId,
        fence.attemptId,
        fence.generation + 1,
        selected.family,
        selected.storageScope,
      );
      return this.update(
        fence,
        "dispatching",
        "not-admitted",
        undefined,
        fence.generation + 1,
        selected,
      );
    });
  }
  failBeforeEffects(
    fence: CreationAttemptFence,
    failure: NonNullable<CreationAttempt["failure"]>,
  ): CreationAttempt {
    if (
      ![
        "startup-unavailable",
        "launch-refused",
        "cancelled",
        "provider-host-outdated",
      ].includes(failure)
    )
      throw new Error("Invalid safe creation failure");
    return this.transaction(() => {
      const current = this.assertCurrent(fence);
      if (!["saved", "queued"].includes(current.attempt.state))
        throw new SessionCreationConflict();
      return this.update(fence, "failed", "not-admitted", failure);
    });
  }
  /**
   * The router refused the session's account after dispatch began but before
   * any provider started. The native claim is still this attempt's, so no
   * native session was bound and no input sent: release the claim and record
   * a known, retryable failure rather than uncertainty.
   */
  failBeforeProvider(
    fence: CreationAttemptFence,
    failure: "router-login-required" | "router-refused",
  ): CreationAttempt {
    return this.transaction(() => {
      const current = this.assertCurrent(fence);
      const claim = this.statements.nativeClaim.get<{
        attempt_id: string;
        generation: number;
      }>(fence.creationId);
      if (
        current.attempt.state !== "dispatching" ||
        current.attempt.delivery !== "not-admitted" ||
        claim?.attempt_id !== fence.attemptId ||
        claim.generation !== fence.generation
      )
        throw new SessionCreationConflict();
      this.statements.releaseNativeClaim.run(
        fence.creationId,
        fence.attemptId,
        fence.generation,
      );
      return this.update(fence, "failed", "not-admitted", failure);
    });
  }
  bindNative(
    fence: CreationAttemptFence,
    native: NativeSessionRef,
  ): CreationAttempt {
    return this.transaction(() => {
      const current = this.assertCurrent(fence);
      if (
        !["dispatching", "bound", "uncertain"].includes(current.attempt.state)
      )
        throw new SessionCreationConflict();
      this.applyNativeBinding(fence, current, native);
      return this.update(
        fence,
        current.attempt.state === "uncertain" ? "uncertain" : "bound",
        current.attempt.delivery,
      );
    });
  }

  getDispatchNamespace(
    fence: CreationAttemptFence,
  ): NativeSessionNamespace | undefined {
    const current = this.assertCurrent(fence);
    const claim = this.statements.nativeClaim.get<{
      attempt_id: string;
      generation: number;
      native_family: NativeSessionNamespace["family"];
      native_scope: string;
    }>(fence.creationId);
    if (claim) {
      if (
        claim.attempt_id !== fence.attemptId ||
        claim.generation !== fence.generation
      )
        throw new SessionCreationConflict();
      return validateNativeSessionNamespace({
        family: claim.native_family,
        storageScope: claim.native_scope,
      });
    }
    const native = this.metadata.identities.resolveYa(
      current.sessionId,
    )?.native;
    return native
      ? { family: native.family, storageScope: native.storageScope }
      : undefined;
  }

  /** Positive owner proof only; no absence test or permission to replay input. */
  confirmOwnedInput(
    fence: CreationAttemptFence,
    native: NativeSessionRef,
    initialInputId: string,
  ): CreationAttempt {
    return this.transaction(() => {
      const current = this.assertCurrent(fence);
      if (
        current.initialInputId !== initialInputId ||
        !["dispatching", "bound", "uncertain"].includes(current.attempt.state)
      )
        throw new SessionCreationConflict();
      this.applyNativeBinding(fence, current, native);
      if (
        current.attempt.state === "bound" &&
        current.attempt.delivery === "consumed"
      )
        return current.attempt;
      return this.update(fence, "bound", "consumed");
    });
  }

  private applyNativeBinding(
    fence: CreationAttemptFence,
    current: SavedSessionCreation,
    native: NativeSessionRef,
  ): void {
    const claim = this.statements.nativeClaim.get<{
      attempt_id: string;
      generation: number;
      native_family: string;
      native_scope: string;
    }>(fence.creationId);
    if (
      claim &&
      (claim.attempt_id !== fence.attemptId ||
        claim.generation !== fence.generation ||
        claim.native_family !== native.family ||
        claim.native_scope !== native.storageScope)
    )
      throw new SessionCreationConflict();
    if (
      !claim &&
      current.attempt.state !== "bound" &&
      !(
        current.attempt.state === "uncertain" &&
        this.metadata.identities.resolveYa(current.sessionId)?.native
      )
    )
      throw new SessionCreationConflict();
    this.metadata.identities.bindWithinTransaction(current.sessionId, native);
    this.statements.releaseNativeClaim.run(
      fence.creationId,
      fence.attemptId,
      fence.generation,
    );
  }
  markDelivery(
    fence: CreationAttemptFence,
    delivery: Exclude<CreationDelivery, "not-admitted">,
  ): CreationAttempt {
    if (delivery !== "uncertain" && delivery !== "consumed")
      throw new Error("Invalid delivery evidence");
    return this.transaction(() => {
      const current = this.assertCurrent(fence);
      if (
        current.attempt.state !== "bound" ||
        current.attempt.delivery === "consumed"
      )
        throw new SessionCreationConflict();
      return this.update(fence, "bound", delivery);
    });
  }
  markUncertain(fence: CreationAttemptFence): CreationAttempt {
    return this.transaction(() => {
      const current = this.assertCurrent(fence);
      if (
        !["dispatching", "bound", "uncertain"].includes(current.attempt.state)
      )
        throw new SessionCreationConflict();
      return this.update(
        fence,
        "uncertain",
        current.attempt.delivery === "consumed" ? "consumed" : "uncertain",
      );
    });
  }
  retry(
    owner: CreationOwner,
    requestId: string,
    retryId: string,
    failedAttemptId: string,
  ): CreationAttempt {
    key(retryId);
    key(failedAttemptId);
    return this.transaction(() => {
      const row = this.statements.byKey.get<OperationRow>(
        ownerKey(owner),
        key(requestId),
      );
      if (!row) throw new SessionCreationConflict();
      const previous = this.statements.retry.get<RetryRow>(row.id, retryId);
      if (previous) {
        if (previous.failed_attempt !== failedAttemptId)
          throw new SessionCreationConflict();
        return this.readAttempt(previous.result_attempt);
      }
      const current = this.read(row);
      if (
        current.deleted ||
        current.attempt.attemptId !== failedAttemptId ||
        current.attempt.state !== "failed" ||
        current.attempt.delivery !== "not-admitted"
      )
        throw new SessionCreationConflict();
      if (row.attempt_count >= MAX_ATTEMPTS)
        throw new SessionCreationCapacityError();
      const detail = JSON.stringify({
        controllerPid: process.pid,
        ...(current.request?.intent === "copy" ? { kind: "copy" } : {}),
      });
      const detailBytes = Buffer.byteLength(detail);
      this.reserve(0, 0, detailBytes);
      const attempt = randomUUID();
      this.statements.insertAttempt.run(
        attempt,
        row.id,
        detail,
        detailBytes,
        new Date().toISOString(),
      );
      this.statements.current.run(attempt, row.id);
      this.transactionChanges?.add(row.id);
      this.statements.insertRetry.run(
        row.id,
        retryId,
        failedAttemptId,
        attempt,
      );
      this.statements.advanceGeneration.run();
      return this.readAttempt(attempt);
    });
  }
  /** Tombstones retain request/hash and retry results; replay can never relaunch. */
  delete(fence: CreationAttemptFence): void {
    this.transaction(() => {
      const current = this.assertCurrent(fence),
        row = this.statements.byId.get<OperationRow>(current.id)!;
      this.update(
        fence,
        "deleted",
        current.attempt.delivery,
        undefined,
        fence.generation + 1,
      );
      this.statements.removePayload.run(current.id);
      this.reserve(
        0,
        -row.payload_bytes,
        0,
        -(
          current.request?.attachments?.files.reduce(
            (sum, f) => sum + f.size,
            0,
          ) ?? 0
        ),
      );
    });
  }
  close(): void {
    this.listeners.clear();
    for (const statement of Object.values(this.statements))
      statement.finalize();
  }
}
