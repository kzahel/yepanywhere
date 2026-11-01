import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  ALL_PROVIDERS,
  NATIVE_SESSION_FAMILIES,
  assertUrlProjectId,
  nativeSessionFamily,
  nativeSessionRef,
  parseNativeSessionId,
  parseYaSessionId,
  type NativeSessionRef,
  type NativeSessionId,
  type ProviderName,
  type UrlProjectId,
  type YaSessionId,
} from "@yep-anywhere/shared";
import type { SqliteDatabase, SqliteStatement } from "../storage/sqlite.js";

export interface SessionIdentity {
  readonly sessionId: YaSessionId;
  /** Launch variant, not the native reader/storage family. */
  readonly provider: ProviderName;
  /** Original transcript project; working-project overlays remain metadata. */
  readonly projectId: UrlProjectId;
  readonly createdAt: string;
  readonly native: NativeSessionRef | null;
}

/** A request may carry this lookup once; legacy never means a stored unbound row. */
export type SessionIdentityLookup =
  | { kind: "stored"; identity: SessionIdentity }
  | { kind: "legacy" };

export interface DiscoveredSessionIdentity {
  native: NativeSessionRef;
  provider: ProviderName;
  projectId: UrlProjectId;
  createdAt: string;
  /** Native-string metadata is meaningful only after legacy adoption is verified. */
  legacyProvider?: ProviderName;
}

interface IdentityRow {
  session_id: string;
  provider: string;
  project_id: string;
  created_at: string;
  native_family: string | null;
  native_scope: string | null;
  native_id: string | null;
}

export class SessionIdentityConflict extends Error {
  constructor() {
    super("Session identity conflicts with an existing native binding");
    this.name = "SessionIdentityConflict";
  }
}

/** Resolve filesystem aliases once at trusted provider/discovery ingress. */
export async function resolveNativeSessionRef(
  provider: ProviderName,
  storageRoot: string,
  id: NativeSessionId,
): Promise<NativeSessionRef> {
  return nativeSessionRef(
    nativeSessionFamily(provider),
    await realpath(storageRoot),
    id,
  );
}

function validateNative(native: NativeSessionRef): NativeSessionRef {
  if (!isAbsolute(native.storageScope)) {
    throw new Error("Native session storage scope must be absolute");
  }
  return nativeSessionRef(native.family, native.storageScope, native.id);
}

function decode(row: IdentityRow | undefined): SessionIdentity | undefined {
  if (!row) return;
  const provider = ALL_PROVIDERS.find((name) => name === row.provider);
  if (!provider) throw new Error("Invalid stored session provider");
  assertUrlProjectId(row.project_id);
  let native: NativeSessionRef | null = null;
  if (row.native_family !== null) {
    const family = NATIVE_SESSION_FAMILIES.find(
      (name) => name === row.native_family,
    );
    if (!family || row.native_scope === null || row.native_id === null) {
      throw new Error("Invalid stored native session binding");
    }
    native = validateNative(
      nativeSessionRef(
        family,
        row.native_scope,
        parseNativeSessionId(row.native_id),
      ),
    );
    if (nativeSessionFamily(provider) !== family) {
      throw new Error("Stored session provider does not match native family");
    }
  }
  return {
    sessionId: parseYaSessionId(row.session_id),
    provider,
    projectId: row.project_id,
    createdAt: row.created_at,
    native,
  };
}

/** Profile-owned indexed identity lookup, with no per-session cache or timers. */
export class SessionIdentityStore {
  // Four fixed statements, released with this owner or the database.
  private readonly byPublicId: SqliteStatement;
  private readonly byNativeRef: SqliteStatement;
  private readonly insert: SqliteStatement;
  private readonly bind: SqliteStatement;

  constructor(private readonly database: SqliteDatabase) {
    this.byPublicId = database.prepare(
      "SELECT * FROM session_identities WHERE session_id = ?",
    );
    this.byNativeRef = database.prepare(
      "SELECT * FROM session_identities WHERE native_family = ? AND native_scope = ? AND native_id = ?",
    );
    this.bind = database.prepare(
      "UPDATE session_identities SET native_family = ?, native_scope = ?, native_id = ? WHERE session_id = ? AND native_id IS NULL",
    );
    this.insert = database.prepare(
      "INSERT INTO session_identities (session_id, provider, project_id, created_at, native_family, native_scope, native_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
  }

  resolveYa(sessionId: YaSessionId): SessionIdentity | undefined {
    return decode(this.byPublicId.get<IdentityRow>(sessionId));
  }

  lookupNative(native: NativeSessionRef): SessionIdentity | undefined {
    validateNative(native);
    return decode(
      this.byNativeRef.get<IdentityRow>(
        native.family,
        native.storageScope,
        native.id,
      ),
    );
  }

  /**
   * Explicit native discovery/import boundary. An already bound resource keeps
   * its YA identity, while a legacy resource keeps its existing native/public id.
   * This cannot bind an unbound managed session; attempts own that later step.
   */
  adoptDiscovered(input: DiscoveredSessionIdentity): SessionIdentity {
    return this.adoptDiscoveredBatch([input])[0]!;
  }

  /** One discovery publication takes one transaction, never a lock per row. */
  adoptDiscoveredBatch(
    inputs: readonly DiscoveredSessionIdentity[],
  ): SessionIdentity[] {
    if (inputs.length === 0) return [];
    return this.database.transaction(() =>
      inputs.map((input) => this.adopt(input)),
    );
  }

  private adopt(input: DiscoveredSessionIdentity): SessionIdentity {
    validateNative(input.native);
    if (nativeSessionFamily(input.provider) !== input.native.family) {
      throw new SessionIdentityConflict();
    }
    assertUrlProjectId(input.projectId);
    const bound = this.lookupNative(input.native);
    if (bound) {
      if (bound.projectId !== input.projectId) {
        throw new SessionIdentityConflict();
      }
      return bound;
    }
    // Conversion is specific to legacy native discovery, never an I/O fallback.
    const sessionId = parseYaSessionId(input.native.id);
    if (this.resolveYa(sessionId)) throw new SessionIdentityConflict();
    const provider = input.legacyProvider ?? input.provider;
    if (nativeSessionFamily(provider) !== input.native.family)
      throw new SessionIdentityConflict();
    this.insert.run(
      sessionId,
      provider,
      input.projectId,
      input.createdAt,
      input.native.family,
      input.native.storageScope,
      input.native.id,
    );
    return this.resolveYa(sessionId)!;
  }

  /** Only the synchronous creation transaction may allocate managed identities. */
  allocateWithinTransaction(input: Omit<SessionIdentity, "native">): void {
    parseYaSessionId(input.sessionId);
    assertUrlProjectId(input.projectId);
    if (!ALL_PROVIDERS.includes(input.provider))
      throw new Error("Invalid session provider");
    this.insert.run(
      input.sessionId,
      input.provider,
      input.projectId,
      input.createdAt,
      null,
      null,
      null,
    );
  }

  /** Caller owns the current-attempt fence and the same profile transaction. */
  bindWithinTransaction(
    sessionId: YaSessionId,
    native: NativeSessionRef,
  ): void {
    validateNative(native);
    const identity = this.resolveYa(sessionId);
    if (!identity || nativeSessionFamily(identity.provider) !== native.family)
      throw new SessionIdentityConflict();
    if (identity.native) {
      if (
        identity.native.family !== native.family ||
        identity.native.storageScope !== native.storageScope ||
        identity.native.id !== native.id
      )
        throw new SessionIdentityConflict();
      return;
    }
    if (this.lookupNative(native)) throw new SessionIdentityConflict();
    this.bind.run(native.family, native.storageScope, native.id, sessionId);
  }

  close(): void {
    this.byPublicId.finalize();
    this.byNativeRef.finalize();
    this.insert.finalize();
    this.bind.finalize();
  }
}
