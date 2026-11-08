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
  type NativeSessionFamily,
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

/** Actual canonical provider store selected before native allocation. */
export type NativeSessionNamespace = Pick<
  NativeSessionRef,
  "family" | "storageScope"
>;
export function validateNativeSessionNamespace(
  namespace: NativeSessionNamespace,
): NativeSessionNamespace {
  if (
    !namespace ||
    !NATIVE_SESSION_FAMILIES.includes(namespace.family) ||
    typeof namespace.storageScope !== "string" ||
    !isAbsolute(namespace.storageScope) ||
    namespace.storageScope.length > 4096 ||
    [...namespace.storageScope].some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
    )
  )
    throw new Error("Invalid native session namespace");
  return { family: namespace.family, storageScope: namespace.storageScope };
}
export class NativeSessionAllocationPending extends Error {
  constructor() {
    super("Native session allocation is unresolved in this provider store");
    this.name = "NativeSessionAllocationPending";
  }
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
  // Seven fixed statements, released with this owner or the database.
  private readonly byPublicId: SqliteStatement;
  private readonly byNativeRef: SqliteStatement;
  private readonly byNativeIds: SqliteStatement;
  private readonly insert: SqliteStatement;
  private readonly bind: SqliteStatement;
  private readonly pendingScope: SqliteStatement;
  private readonly pendingFamily: SqliteStatement;

  constructor(private readonly database: SqliteDatabase) {
    this.pendingScope = database.prepare(
      "SELECT 1 FROM native_session_allocations WHERE native_family = ? AND native_scope = ? LIMIT 1",
    );
    this.pendingFamily = database.prepare(
      "SELECT 1 FROM native_session_allocations WHERE native_family = ? LIMIT 1",
    );
    this.byPublicId = database.prepare(
      "SELECT * FROM session_identities WHERE session_id = ?",
    );
    this.byNativeRef = database.prepare(
      "SELECT * FROM session_identities WHERE native_family = ? AND native_scope = ? AND native_id = ?",
    );
    this.byNativeIds = database.prepare(
      "SELECT * FROM session_identities WHERE native_family = ? AND native_scope = ? AND native_id IN (SELECT value FROM json_each(?))",
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
   * `lookupNative` for a whole publication: one indexed read per provider store
   * instead of one per session, returning only the requested bindings. Nothing
   * outlives the call.
   */
  lookupNativeBatch(
    natives: readonly NativeSessionRef[],
  ): Array<SessionIdentity | undefined> {
    // Grouped per store; a family name never contains NUL.
    const storeKey = (native: NativeSessionRef) =>
      `${native.family}\0${native.storageScope}`;
    const stores = new Map<
      string,
      { native: NativeSessionRef; ids: Set<string> }
    >();
    for (const native of natives) {
      validateNative(native);
      const key = storeKey(native);
      const store = stores.get(key);
      if (store) store.ids.add(native.id);
      else stores.set(key, { native, ids: new Set([native.id]) });
    }
    const found = new Map<string, SessionIdentity>();
    for (const [key, { native, ids }] of stores)
      for (const row of this.byNativeIds.all<IdentityRow>(
        native.family,
        native.storageScope,
        JSON.stringify([...ids]),
      ))
        found.set(`${key}\0${row.native_id}`, decode(row)!);
    return natives.map((native) =>
      found.get(`${storeKey(native)}\0${native.id}`),
    );
  }

  /** Known bindings remain addressable; only unknown native discovery defers. */
  isNativeNamespacePending(namespace: NativeSessionNamespace): boolean {
    validateNativeSessionNamespace(namespace);
    return (
      this.pendingScope.get(namespace.family, namespace.storageScope) !==
      undefined
    );
  }
  hasPendingNativeFamily(family: NativeSessionFamily): boolean {
    if (!NATIVE_SESSION_FAMILIES.includes(family))
      throw new Error("Invalid native session family");
    return this.pendingFamily.get(family) !== undefined;
  }
  canDiscoverNative(native: NativeSessionRef): boolean {
    return (
      Boolean(this.lookupNative(native)) ||
      !this.isNativeNamespacePending(native)
    );
  }

  /**
   * Explicit native discovery/import boundary. An already bound resource keeps
   * its YA identity, while a legacy resource keeps its existing native/public id.
   * This cannot bind an unbound managed session; attempts own that later step.
   */
  adoptDiscovered(input: DiscoveredSessionIdentity): SessionIdentity {
    const identity = this.adoptDiscoveredBatch([input])[0];
    if (!identity) throw new NativeSessionAllocationPending();
    return identity;
  }

  /** One discovery publication takes one transaction, never a lock per row. */
  adoptDiscoveredBatch(
    inputs: readonly DiscoveredSessionIdentity[],
  ): Array<SessionIdentity | undefined> {
    if (inputs.length === 0) return [];
    return this.database.transaction(() =>
      inputs.map((input) => this.adopt(input)),
    );
  }

  /** Only a known successful owned native copy may bypass discovery quarantine. */
  adoptCopiedNative(
    input: Omit<DiscoveredSessionIdentity, "legacyProvider">,
  ): SessionIdentity {
    return this.database.transaction(() => this.adopt(input, true)!);
  }

  private adopt(
    input: DiscoveredSessionIdentity,
    copied = false,
  ): SessionIdentity | undefined {
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
    if (!copied && this.isNativeNamespacePending(input.native)) return;
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
    this.byNativeIds.finalize();
    this.insert.finalize();
    this.bind.finalize();
    this.pendingScope.finalize();
    this.pendingFamily.finalize();
  }
}
