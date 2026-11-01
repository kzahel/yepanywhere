import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  ALL_PERMISSION_MODES,
  ALL_PROVIDERS,
  EFFORT_LEVEL_ORDER,
  assertUrlProjectId,
  parseYaSessionId,
  type NativeSessionRef,
  type ProviderName,
  type SessionCreationProvenance,
  type UrlProjectId,
  type YaSessionId,
} from "@yep-anywhere/shared";
import type {
  EffectiveSessionLaunchSettingsValue,
  SessionMetadataService,
} from "../metadata/SessionMetadataService.js";
import type { SqliteDatabase, SqliteStatement } from "../storage/sqlite.js";

/** Trusted ownership, separate from descriptive client hints. Never stores grants. */
export type CreationOwner =
  | { kind: "superuser" }
  | { kind: "limited"; username: string };
export type CreationContext = {
  owner: CreationOwner;
  source:
    | { kind: "request"; provenance: SessionCreationProvenance }
    | { kind: "internal"; reason: "recap" | "retitle" | "fork-summary" };
};
export interface SavedCreationRequest {
  provider: ProviderName;
  projectId: UrlProjectId;
  projectPath: string;
  message: string;
  settings: EffectiveSessionLaunchSettingsValue;
}
export type CreationState =
  | "saved"
  | "queued"
  | "dispatching"
  | "bound"
  | "failed"
  | "uncertain"
  | "deleted";
export type CreationDelivery = "not-admitted" | "uncertain" | "consumed";
export interface CreationAttemptFence {
  readonly creationId: string;
  readonly attemptId: string;
  readonly generation: number;
}
export interface CreationAttempt extends CreationAttemptFence {
  readonly state: CreationState;
  readonly delivery: CreationDelivery;
  readonly failure?: "startup-unavailable" | "launch-refused" | "cancelled";
}
export interface SavedSessionCreation {
  readonly id: string;
  readonly requestId: string;
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
interface AttemptRow {
  id: string;
  creation_id: string;
  generation: number;
  state: CreationState;
  delivery: CreationDelivery;
  detail_json: string;
  detail_bytes: number;
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
    projectId: request.projectId,
    projectPath: request.projectPath,
    message: request.message,
    settings: {
      requestedModel: s.requestedModel,
      permissionMode: s.permissionMode,
      thinking,
      effort: s.effort,
      serviceTier: s.serviceTier,
    },
  };
}

/** Profile-owned synchronous control state. Fixed statements, no timers or caches. */
export class SessionCreationStore {
  private readonly statements: Record<
    | "byId"
    | "byKey"
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
    this.statements = {
      byId: database.prepare("SELECT * FROM session_creations WHERE id = ?"),
      byKey: database.prepare(
        "SELECT * FROM session_creations WHERE owner_key = ? AND request_key = ?",
      ),
      bySession: database.prepare(
        "SELECT * FROM session_creations WHERE session_id = ?",
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
        "UPDATE session_creation_capacity SET operations = operations + ?, payload_bytes = payload_bytes + ?, attempt_bytes = attempt_bytes + ? WHERE id = 1",
      ),
      insert: database.prepare(
        "INSERT INTO session_creations (id, owner_key, request_key, request_hash, session_id, payload_json, payload_bytes, context_json, current_attempt, attempt_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
      ),
      insertAttempt: database.prepare(
        "INSERT INTO session_creation_attempts (id, creation_id, state, delivery, detail_json, detail_bytes, updated_at) VALUES (?, ?, 'saved', 'not-admitted', '{}', 2, ?)",
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
  private readAttempt(id: string): CreationAttempt {
    const row = this.statements.attempt.get<AttemptRow>(id);
    if (!row) throw new Error("Missing saved creation attempt");
    const detail: Pick<CreationAttempt, "failure"> = JSON.parse(
      row.detail_json,
    );
    return {
      creationId: row.creation_id,
      attemptId: row.id,
      generation: row.generation,
      state: row.state,
      delivery: row.delivery,
      ...detail,
    };
  }
  private read(row: OperationRow): SavedSessionCreation {
    return {
      id: row.id,
      requestId: row.request_key,
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
    const row = this.statements.bySession.get<OperationRow>(
      parseYaSessionId(sessionId),
    );
    return row ? this.read(row) : undefined;
  }
  private reserve(operations: number, payload: number, attempts: number): void {
    const usage = this.statements.capacity.get<{
      operations: number;
      payload_bytes: number;
      attempt_bytes: number;
    }>()!;
    if (
      usage.operations + operations > MAX_OPERATIONS ||
      usage.payload_bytes + payload > MAX_PAYLOAD ||
      usage.attempt_bytes + attempts > MAX_ATTEMPT_BYTES
    )
      throw new SessionCreationCapacityError();
    this.statements.reserve.run(operations, payload, attempts);
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
      now = new Date().toISOString();
    try {
      this.metadata.commitNewSession(
        this.database,
        sessionId,
        {
          provider: request.provider,
          initialPrompt: request.message,
          effectiveLaunchSettings: {
            schemaVersion: 1,
            revision: 1,
            ...request.settings,
          },
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
          this.reserve(1, bytes, 2);
          this.metadata.identities.allocateWithinTransaction({
            sessionId,
            provider: request.provider,
            projectId: request.projectId,
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
          );
          this.statements.insertAttempt.run(attempt, id, now);
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
    return this.get(context.owner, requestId)!;
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
  ): CreationAttempt {
    const previous = this.statements.attempt.get<AttemptRow>(fence.attemptId)!;
    const detail = JSON.stringify(failure ? { failure } : {}),
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
    return this.readAttempt(fence.attemptId);
  }
  markQueued(fence: CreationAttemptFence): CreationAttempt {
    return this.database.transaction(() => {
      const current = this.assertCurrent(fence);
      if (current.attempt.state !== "saved")
        throw new SessionCreationConflict();
      return this.update(fence, "queued", "not-admitted");
    });
  }
  /** Persist before the external launch. The returned generation owns its callbacks. */
  beginDispatch(fence: CreationAttemptFence): CreationAttempt {
    return this.database.transaction(() => {
      const current = this.assertCurrent(fence);
      if (!["saved", "queued"].includes(current.attempt.state))
        throw new SessionCreationConflict();
      return this.update(
        fence,
        "dispatching",
        "not-admitted",
        undefined,
        fence.generation + 1,
      );
    });
  }
  failBeforeEffects(
    fence: CreationAttemptFence,
    failure: NonNullable<CreationAttempt["failure"]>,
  ): CreationAttempt {
    if (
      !["startup-unavailable", "launch-refused", "cancelled"].includes(failure)
    )
      throw new Error("Invalid safe creation failure");
    return this.database.transaction(() => {
      const current = this.assertCurrent(fence);
      if (!["saved", "queued"].includes(current.attempt.state))
        throw new SessionCreationConflict();
      return this.update(fence, "failed", "not-admitted", failure);
    });
  }
  bindNative(
    fence: CreationAttemptFence,
    native: NativeSessionRef,
  ): CreationAttempt {
    return this.database.transaction(() => {
      const current = this.assertCurrent(fence);
      if (!["dispatching", "bound"].includes(current.attempt.state))
        throw new SessionCreationConflict();
      this.metadata.identities.bindWithinTransaction(current.sessionId, native);
      return this.update(fence, "bound", current.attempt.delivery);
    });
  }
  markDelivery(
    fence: CreationAttemptFence,
    delivery: Exclude<CreationDelivery, "not-admitted">,
  ): CreationAttempt {
    if (delivery !== "uncertain" && delivery !== "consumed")
      throw new Error("Invalid delivery evidence");
    return this.database.transaction(() => {
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
    return this.database.transaction(() => {
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
    return this.database.transaction(() => {
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
      this.reserve(0, 0, 2);
      const attempt = randomUUID();
      this.statements.insertAttempt.run(
        attempt,
        row.id,
        new Date().toISOString(),
      );
      this.statements.current.run(attempt, row.id);
      this.statements.insertRetry.run(
        row.id,
        retryId,
        failedAttemptId,
        attempt,
      );
      return this.readAttempt(attempt);
    });
  }
  /** Tombstones retain request/hash and retry results; replay can never relaunch. */
  delete(fence: CreationAttemptFence): void {
    this.database.transaction(() => {
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
      this.reserve(0, -row.payload_bytes, 0);
    });
  }
  close(): void {
    for (const statement of Object.values(this.statements))
      statement.finalize();
  }
}
