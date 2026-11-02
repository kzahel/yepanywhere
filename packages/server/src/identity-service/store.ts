import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import bcrypt from "bcrypt";
import { openSqliteOrThrow, type SqliteDatabase } from "../storage/sqlite.js";
import { enforceOwnerOnlyPathPermissionsStrict } from "../utils/filePermissions.js";
import { writeFileAtomically } from "../utils/writeFileAtomically.js";
import {
  IDENTITY_SERVICE_STATE_BYTES,
  identityServiceStateSchema,
  type IdentityServiceState,
} from "./contracts.js";
import {
  identityServiceOrigin,
  generateIdentityServicePrivateKey,
  verifyIdentityServiceKeyMaterial,
  publicIdentityServiceKey,
  identityServiceThumbprint,
  identityServiceDigest,
} from "./crypto.js";
import { IdentityServiceError } from "./errors.js";

export function identityServiceUsername(value: string) {
  const username = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(username))
    throw new IdentityServiceError(
      "invalid_username",
      "Use a local username of 2–64 ASCII letters, numbers, dots, underscores or hyphens",
    );
  return username;
}
export function identityServicePassword(value: string) {
  if ([...value].length < 12 || Buffer.byteLength(value) > 72)
    throw new IdentityServiceError(
      "invalid_password",
      "Passwords require at least 12 characters and at most 72 UTF-8 bytes",
    );
  return value;
}
function validateState(value: unknown, issuer: string): IdentityServiceState {
  const state = identityServiceStateSchema.parse(value);
  if (state.issuer !== issuer)
    throw new Error("Issuer does not match this directory");
  const unique = (ids: string[]) => new Set(ids).size === ids.length;
  if (
    !unique(state.accounts.map((a) => a.id)) ||
    !unique(
      state.accounts.map((a) =>
        a.kind === "local"
          ? `local:${a.username}`
          : `oidc:${a.issuer}\0${a.subject}`,
      ),
    ) ||
    !unique(state.clients.map((c) => c.id)) ||
    !unique(
      state.clients
        .filter((c) => !c.revoked)
        .map((c) => `${c.accountId}/${c.profileId}`),
    ) ||
    !unique(state.sessions.map((s) => s.id)) ||
    !unique(state.sessions.map((s) => s.clientId)) ||
    !unique(state.relationships.map((r) => r.id)) ||
    !unique(
      state.relationships.flatMap((r) =>
        r.accepted ? [r.accepted.envelopeId] : [],
      ),
    ) ||
    !unique(state.mailbox.map((m) => m.id)) ||
    state.clients.some(
      (c) => !state.accounts.some((a) => a.id === c.accountId),
    ) ||
    state.sessions.some(
      (s) =>
        !state.clients.some(
          (c) => c.id === s.clientId && c.accountId === s.accountId,
        ),
    ) ||
    state.relationships.some(
      (r) =>
        r.sourceClientId === r.targetClientId ||
        ![r.sourceClientId, r.targetClientId].every((id) =>
          state.clients.some((c) => c.id === id && c.accountId === r.accountId),
        ),
    ) ||
    state.mailbox.some(
      (m) =>
        !state.relationships.some(
          (r) =>
            r.id === m.relationshipId &&
            r.generation === m.generation &&
            r.sourceClientId === m.sourceClientId &&
            r.targetClientId === m.targetClientId &&
            r.accepted?.envelopeId === m.id &&
            r.accepted.digest === identityServiceDigest(m.ciphertext),
        ),
    )
  )
    throw new Error("Inconsistent identity service directory");
  return state;
}

export function retireIdentityServiceClient(
  state: IdentityServiceState,
  id: string,
) {
  const client = state.clients.find((c) => c.id === id);
  if (!client)
    throw new IdentityServiceError("not_found", "Client not found", 404);
  if (!client.revoked)
    state.accounts.find((a) => a.id === client.accountId)!
      .enrollmentGeneration++;
  client.revoked = true;
  state.sessions = state.sessions.filter((s) => s.clientId !== id);
  const retired = new Set(
    state.relationships
      .filter((r) => [r.sourceClientId, r.targetClientId].includes(id))
      .map((r) => {
        r.revoked = true;
        return r.id;
      }),
  );
  state.mailbox = state.mailbox.filter((m) => !retired.has(m.relationshipId));
}
export function pruneRetiredIdentityServiceClients(
  state: IdentityServiceState,
) {
  state.clients = state.clients.filter((c) => !c.revoked);
  const retained = new Set(state.clients.map((c) => c.id));
  state.sessions = state.sessions.filter((s) => retained.has(s.clientId));
  state.relationships = state.relationships.filter(
    (r) => retained.has(r.sourceClientId) && retained.has(r.targetClientId),
  );
  const relationships = new Set(state.relationships.map((r) => r.id));
  state.mailbox = state.mailbox.filter((m) =>
    relationships.has(m.relationshipId),
  );
}

/** Exclusive process ownership and serialized durable publication, without timers. */
export class IdentityServiceStore {
  readonly path: string;
  private ownership?: SqliteDatabase;
  private state?: IdentityServiceState;
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private closed = false;
  private failed = false;
  constructor(
    readonly directory: string,
    readonly issuer: string,
    readonly allowInsecureLoopback = false,
  ) {
    this.issuer = identityServiceOrigin(issuer, allowInsecureLoopback);
    this.path = join(directory, "state.json");
  }
  async initialize() {
    if (this.state || this.ownership || this.closed)
      throw new Error("Identity Service store already initialized or closed");
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await enforceOwnerOnlyPathPermissionsStrict(this.directory, "directory");
      const lockPath = join(this.directory, "ownership.sqlite");
      const file = await open(lockPath, "a", 0o600);
      await file.close();
      await enforceOwnerOnlyPathPermissionsStrict(lockPath, "file");
      const db = await openSqliteOrThrow(lockPath);
      this.ownership = db;
      db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
      const identityPath = join(this.directory, "identity");
      let identity: string | undefined;
      try {
        await enforceOwnerOnlyPathPermissionsStrict(identityPath, "file");
        identity = await readFile(identityPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      let saved: unknown;
      try {
        if ((await stat(this.path)).size > IDENTITY_SERVICE_STATE_BYTES)
          throw new Error("Oversized identity service state");
        await enforceOwnerOnlyPathPermissionsStrict(this.path, "file");
        saved = JSON.parse(await readFile(this.path, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (identity !== undefined)
          throw new Error(
            "Missing state for an existing identity service identity",
          );
        // The ownership database is deliberately not the service identity.
        saved = {
          version: 1,
          issuer: this.issuer,
          serviceId: randomUUID(),
          signingKey: await generateIdentityServicePrivateKey(),
          previousSigningKeys: [],
          accounts: [],
          clients: [],
          sessions: [],
          relationships: [],
          mailbox: [],
        };
        await writeFileAtomically(this.path, JSON.stringify(saved), {
          mode: 0o600,
          durable: true,
        });
      }
      this.state = validateState(saved, this.issuer);
      if (identity !== undefined && identity !== this.state.serviceId)
        throw new Error("Identity Service identity marker mismatch");
      if (identity === undefined)
        await writeFileAtomically(identityPath, this.state.serviceId, {
          mode: 0o600,
          durable: true,
        });
      await verifyIdentityServiceKeyMaterial(this.state.signingKey);
    } catch {
      this.failed = true;
      this.ownership?.close();
      this.ownership = undefined;
      throw new IdentityServiceError(
        "fleet_state_unavailable",
        "Identity Service directory is already owned or cannot be loaded safely",
        503,
      );
    }
  }
  read(): Readonly<IdentityServiceState> {
    if (!this.state || this.failed || this.closed)
      throw new IdentityServiceError(
        "fleet_state_unavailable",
        "Identity Service directory is unavailable",
        503,
      );
    return this.state;
  }
  mutate<T>(
    update: (state: IdentityServiceState) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    this.read();
    if (this.queued >= 16)
      return Promise.reject(
        new IdentityServiceError(
          "capacity",
          "Identity Service publication queue is full",
          503,
        ),
      );
    this.queued++;
    const work = this.tail.then(async () => {
      const next = structuredClone(this.read());
      signal?.throwIfAborted();
      const result = update(next);
      const valid = validateState(next, this.issuer),
        content = JSON.stringify(valid);
      if (Buffer.byteLength(content) > IDENTITY_SERVICE_STATE_BYTES)
        throw new IdentityServiceError(
          "capacity",
          "Identity Service directory exceeds its byte limit",
          503,
        );
      try {
        await writeFileAtomically(this.path, content, {
          mode: 0o600,
          durable: true,
        });
        this.state = valid;
      } catch {
        this.failed = true;
        throw new IdentityServiceError(
          "fleet_state_unavailable",
          "Identity Service publication is uncertain; admission is closed",
          503,
        );
      }
      return result;
    });
    this.tail = work.catch(() => {});
    return work.finally(() => {
      this.queued--;
    });
  }
  /** Offline only: ownership acquisition prevents racing a running service. */
  async provisionLocal(
    usernameValue: string,
    passwordValue: string,
    displayName = usernameValue,
  ) {
    const username = identityServiceUsername(usernameValue),
      password = identityServicePassword(passwordValue);
    const passwordHash = await bcrypt.hash(password, 10);
    return this.mutate((state) => {
      const existing = state.accounts.find(
        (a) => a.kind === "local" && a.username === username,
      );
      const account = {
        id: existing?.id ?? randomUUID(),
        kind: "local" as const,
        username,
        passwordHash,
        authGeneration: (existing?.authGeneration ?? 0) + 1,
        enrollmentGeneration: (existing?.enrollmentGeneration ?? 0) + 1,
        displayName,
      };
      state.accounts = [
        ...state.accounts.filter((a) => a.id !== account.id),
        account,
      ];
      state.sessions = state.sessions.filter((s) => s.accountId !== account.id);
      return account.id;
    });
  }
  provisionOidc(issuer: string, subject: string, displayName: string) {
    return this.mutate((state) => {
      if (
        state.accounts.some(
          (a) =>
            a.kind === "oidc" && a.issuer === issuer && a.subject === subject,
        )
      )
        throw new IdentityServiceError(
          "conflict",
          "External account already provisioned",
          409,
        );
      const id = randomUUID();
      state.accounts.push({
        id,
        kind: "oidc",
        issuer,
        subject,
        displayName,
        authGeneration: 1,
        enrollmentGeneration: 1,
      });
      return id;
    });
  }
  revokeClient(id: string) {
    return this.mutate((state) => retireIdentityServiceClient(state, id));
  }
  async rotateSigningKey() {
    const signingKey = await generateIdentityServicePrivateKey();
    await this.mutate((state) => {
      if (state.previousSigningKeys.length >= 3)
        throw new IdentityServiceError(
          "capacity",
          "Explicitly retire an old public signing key before rotating again",
          409,
        );
      state.previousSigningKeys.push(
        publicIdentityServiceKey(state.signingKey),
      );
      state.signingKey = signingKey;
    });
  }
  async forgetSigningKey(kid: string) {
    const previous = this.read().previousSigningKeys;
    const ids = await Promise.all(previous.map(identityServiceThumbprint));
    await this.mutate((state) => {
      state.previousSigningKeys = state.previousSigningKeys.filter(
        (key) =>
          !previous.some(
            (old, index) =>
              old.x === key.x && old.y === key.y && ids[index] === kid,
          ),
      );
    });
  }
  async close() {
    this.closed = true;
    await this.tail;
    this.ownership?.close();
    this.ownership = undefined;
  }
}
