/**
 * SessionMetadataService manages custom session metadata (titles, archive status).
 * This enables renaming sessions and archiving them to hide from default view.
 *
 * State is persisted to the server's SQLite database, one row per session.
 * The legacy `session-metadata.json` is imported once and never written again.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type CacheMissBillingRecord,
  type NonHumanUserTurn,
  type DurableRecapMessage,
  type DurableLocalCommandMessage,
  type DurableSyntheticDoneMessage,
  type EffectiveSessionLaunchSettings,
  type ProviderName,
  type PromptSuggestionMode,
  type RecapMode,
  type SessionClearloopJob,
  type SessionCreationProvenance,
  type SessionPendingRewind,
  type SessionRewindRecord,
  type SessionSandboxLevel,
  type SlashCommand,
  type TranscriptDisplayObject,
  type UrlProjectId,
  findGoalCommand,
  normalizeRecapAfterSeconds,
  readGoalDetails,
  sanitizeSessionTitle,
} from "@yep-anywhere/shared";
import { createCoalescingSaver } from "../lib/coalescingSaver.js";
import { SessionCreationStore } from "../sessions/SessionCreationStore.js";
import { SessionIdentityStore } from "../sessions/SessionIdentityStore.js";
import type { SqliteDatabase, SqliteStatement } from "../storage/sqlite.js";

export type { EffectiveSessionLaunchSettings } from "@yep-anywhere/shared";

export type EffectiveSessionLaunchSettingsValue = Omit<
  EffectiveSessionLaunchSettings,
  "schemaVersion" | "revision"
>;

/** A fork number claimed from a lineage root's `forksCreated` count. */
export interface ForkOrdinalClaim {
  ordinal: number;
  lineageRootId: string;
}

export interface SessionMetadata {
  routerBinding?: {
    poolId?: string;
    poolName?: string;
    accountDisplayName?: string;
    policy?: string;
    policyLabel?: string;
    reason?: string;
    observedAt?: string;
    id: string;
    routerId: string;
    accountId: string;
    provider: "claude" | "codex";
  };
  /** Client-declared UI that first created this YA-owned session. */
  creationProvenance?: SessionCreationProvenance;
  /**
   * Limited user who started this session, when one did. Absent means the
   * superuser started it (or it predates limited users). A limited user can
   * always read their own sessions, even after a project grant is removed:
   * topics/limited-users.md § Delivery v1 — Authorization.
   */
  createdByUser?: string;
  /** Retain the acknowledged receipt so replay cannot raise it again. */
  nonHumanUserTurn?: NonHumanUserTurn & { acknowledged?: boolean };
  /** Custom title that overrides auto-generated title */
  customTitle?: string;
  /** Whether the session is archived (hidden from default list) */
  isArchived?: boolean;
  /** Whether the session is starred/favorited */
  isStarred?: boolean;
  /** User-named sidebar category this session is filed under. */
  sidebarCategory?: string;
  /** Interactive Mother session for a YA-owned `/btw` aside. */
  parentSessionId?: string;
  /** Explicit meaning of parentSessionId; absent on legacy records. */
  parentSessionKind?: "btw-aside";
  /** Source session whose provider transcript was cloned or forked. */
  forkedFromSessionId?: string;
  /**
   * How many forks/clones have been created in this session's fork lineage, so
   * each new one can be titled with its own ordinal instead of repeating
   * "Fork: <source>". Only meaningful on a lineage root — a session whose own
   * `forkLineageRootId` is absent. Counts forks created, never forks that still
   * exist: deleting a fork does not release its number.
   */
  forksCreated?: number;
  /**
   * The lineage root whose `forksCreated` numbers this session's forks. Set on
   * every fork target so forking a fork continues the original session's
   * numbering instead of restarting at "Fork:".
   */
  forkLineageRootId?: string;
  /** Saved viewer-only objects placed in the transcript. */
  transcriptDisplayObjects?: TranscriptDisplayObject[];
  /** Durable YA-owned recap rows merged into the transcript view only. */
  recapMessages?: DurableRecapMessage[];
  localCommandMessages?: DurableLocalCommandMessage[];
  /** Same-session rewinds; the reader groups the rows they dropped. */
  rewindRecords?: SessionRewindRecord[];
  /** A rewind the next provider resume must apply. */
  pendingRewind?: SessionPendingRewind;
  /** The latest `/clearloop` job, running or terminal. */
  clearloop?: SessionClearloopJob;
  /** Last observed goal, independent of historical command receipts. */
  goalCommand?: SlashCommand;
  /** Pre-Claude name for the same record; still read, no longer written. */
  codexGoalCommand?: SlashCommand;
  /** Durable YA-only `/done` rows merged into the transcript view only. */
  syntheticDoneMessages?: DurableSyntheticDoneMessage[];
  /** Requested boundary awaiting the live provider turn's idle edge. */
  pendingSyntheticDone?: {
    message: DurableSyntheticDoneMessage;
    userTurnVersion: number;
  };
  /** Provider usage evidence for warm/forked prefix cache hits and recomputes. */
  cacheMissBillingEvents?: CacheMissBillingRecord[];
  /**
   * YA model id (launch alias, e.g. "opus"/"default") chosen when YA started
   * this session. Persisted so per-model settings still key by the requested
   * YA id after a server restart, instead of falling back to the reported model.
   * Absent for sessions YA didn't start. See topics/provider-abstraction.md.
   */
  requestedModel?: string;
  /** Last successfully applied per-session process launch settings. */
  effectiveLaunchSettings?: EffectiveSessionLaunchSettings;
  /** Provider used for this session (for backward compatibility with sessions that don't have provider in JSONL) */
  provider?: ProviderName;
  /** SSH host alias for remote execution (undefined = local) */
  executor?: string;
  /** Initial prompt text accepted by YA for new-session recovery/copy. */
  initialPrompt?: string;
  /** Per-session session-wake override; absent inherits the server default. */
  wakeTurnsEnabled?: boolean;
  /** Explicit Kill blocks YA-owned automatic resume without hiding history. */
  autoResumeDisabled?: boolean;
  /** Per-session prompt-suggestion preference (off | native) */
  promptSuggestionMode?: PromptSuggestionMode;
  /** Browser-away duration before YA asks the live process for a recap. */
  recapAfterSeconds?: number;
  /** Explicit Stop/Terminate suppresses recaps until a fresh user turn. */
  recapPausedUntilUserTurn?: boolean;
  /** YA `/done` suppresses all automatic session turns until a real user turn. */
  automationPausedUntilUserTurn?: boolean;
  /** Settled YA host filesystem confinement for every launch of this session. */
  sandboxLevel?: SessionSandboxLevel;
  /** Public-only egress selection; absent means on for project-write. */
  sandboxNetworkFirewall?: boolean;
  /** Opaque key for the canonical project's private provider runtime state. */
  sandboxStateKey?: string;
  /** Effective host project path used to locate private provider transcripts. */
  sandboxProjectPath?: string;
  /**
   * Per-session recap strategy (off | native | side-session | fork). Durable
   * so a process-dead session still knows whether/how to recap — required to
   * revive a cold fork-mode session on the away trigger. See
   * topics/fork-recap.md.
   */
  recapMode?: RecapMode;
  /** YA's effective project/working directory for this session. */
  workingProjectId?: UrlProjectId;
  /** Provider transcript project when it differs from the effective project. */
  transcriptProjectId?: UrlProjectId;
}

export interface SessionMetadataState {
  /** Map of sessionId -> metadata */
  sessions: Record<string, SessionMetadata>;
}

/** Shape of the legacy `session-metadata.json`, read only by the one-time import. */
interface LegacySessionMetadataFile {
  sessions?: Record<string, SessionMetadata>;
  version?: number;
}

const MAX_RECAP_MESSAGES_PER_SESSION = 200;
const MAX_SYNTHETIC_DONE_MESSAGES_PER_SESSION = 200;
const MAX_CACHE_MISS_BILLING_EVENTS_PER_SESSION = 100;

export interface SessionMetadataServiceOptions {
  /** Data directory holding the legacy JSON file to import (defaults to ~/.yep-anywhere) */
  dataDir?: string;
  /** The server's discovery database; the caller owns and closes it. */
  database: SqliteDatabase;
}

/** Public projection omits the persisted acknowledgement tombstone. */
function pendingNonHumanUserTurn(
  metadata: SessionMetadata | undefined,
): NonHumanUserTurn | undefined {
  const turn = metadata?.nonHumanUserTurn;
  if (!turn || turn.acknowledged) return undefined;
  return {
    messageId: turn.messageId,
    timestamp: turn.timestamp,
    sourceSessionId: turn.sourceSessionId,
  };
}

/**
 * Session row and event field carrying the pending non-human user turn.
 * Explicit null is the wire value for "no pending turn"; an omitted field
 * means unknown, so a caller without metadata storage still reports null.
 */
export function nonHumanUserTurnField(
  service: SessionMetadataService | undefined,
  sessionId: string,
): NonHumanUserTurn | null {
  return pendingNonHumanUserTurn(service?.getMetadata(sessionId)) ?? null;
}

/**
 * Last observed goal command held by a session's metadata, reading the
 * pre-Claude `codexGoalCommand` record when the current field is absent.
 */
export function goalCommandOf(
  metadata: SessionMetadata | undefined,
): SlashCommand | undefined {
  return metadata?.goalCommand ?? metadata?.codexGoalCommand;
}

export class SessionMetadataService {
  private identityStore?: SessionIdentityStore;
  private creationStore?: SessionCreationStore;

  /** One durable creation owner on the same profile connection as metadata. */
  get creations(): SessionCreationStore {
    this.creationStore ??= new SessionCreationStore(this.database, this);
    return this.creationStore;
  }

  /** Internal transaction participants cannot silently select another profile. */
  assertProfileConnection(database: SqliteDatabase): void {
    if (database !== this.database)
      throw new Error("Creation requires the profile connection");
  }

  /** One indexed identity owner per metadata/profile connection. */
  get identities(): SessionIdentityStore {
    this.identityStore ??= new SessionIdentityStore(this.database);
    return this.identityStore;
  }

  /**
   * Internal admission transaction: only a new identity may publish metadata.
   * Domain writes and metadata use this exact connection; mirrors change only
   * after COMMIT. The callback must contain synchronous SQLite operations only.
   */
  commitNewSession<T>(
    database: SqliteDatabase,
    sessionId: string,
    metadata: SessionMetadata,
    write: () => T,
  ): T {
    this.assertProfileConnection(database);
    if (this.state.sessions[sessionId] || this.sessionIdAliases.has(sessionId))
      throw new Error("Creation cannot replace existing session metadata");
    const text = JSON.stringify(metadata);
    const snapshot: SessionMetadata = JSON.parse(text);
    const result = this.database.transaction(() => {
      const value = write();
      if (
        value !== null &&
        (typeof value === "object" || typeof value === "function") &&
        "then" in value
      )
        throw new Error("Creation transaction requires synchronous writes");
      this.statements.upsert.run(sessionId, text);
      return value;
    });
    this.state.sessions[sessionId] = snapshot;
    this.persisted.set(sessionId, text);
    return result;
  }

  private state: SessionMetadataState;
  private dataDir: string;
  private legacyFilePath: string;
  private readonly database: SqliteDatabase;
  private readonly statements: {
    selectImport: SqliteStatement;
    insertImport: SqliteStatement;
    selectAll: SqliteStatement;
    upsert: SqliteStatement;
    remove: SqliteStatement;
  };
  /** Last JSON written per session, so a save writes only changed rows. */
  private persisted = new Map<string, string>();
  /** Session ID rewrites seen since process start; small ID pairs. */
  private sessionIdAliases = new Map<string, string>();
  private unsavedGoalObservations = new Set<string>();
  private metadataSaver = createCoalescingSaver(() => this.doSave());
  private save = this.metadataSaver.flush;

  constructor(options: SessionMetadataServiceOptions) {
    this.dataDir =
      options.dataDir ??
      path.join(
        process.env.HOME ?? process.env.USERPROFILE ?? ".",
        ".yep-anywhere",
      );
    this.legacyFilePath = path.join(this.dataDir, "session-metadata.json");
    this.database = options.database;
    this.statements = {
      selectImport: this.database.prepare(
        "SELECT source FROM session_metadata_import WHERE id = 1",
      ),
      insertImport: this.database.prepare(
        "INSERT INTO session_metadata_import (id, imported_at, source) VALUES (1, ?, ?)",
      ),
      selectAll: this.database.prepare(
        "SELECT session_id, metadata FROM session_metadata",
      ),
      upsert: this.database.prepare(
        "INSERT INTO session_metadata (session_id, metadata) VALUES (?, ?) ON CONFLICT (session_id) DO UPDATE SET metadata = excluded.metadata",
      ),
      remove: this.database.prepare(
        "DELETE FROM session_metadata WHERE session_id = ?",
      ),
    };
    this.state = { sessions: {} };
  }

  /**
   * Load state from the database, first importing the legacy JSON file if
   * this database has never imported it. A legacy file that cannot be read or
   * parsed stops startup rather than being silently replaced.
   */
  async initialize(): Promise<void> {
    if (!this.statements.selectImport.get()) {
      await this.importLegacyFile();
    }
    for (const row of this.statements.selectAll.all<{
      session_id: string;
      metadata: string;
    }>()) {
      this.state.sessions[row.session_id] = JSON.parse(
        row.metadata,
      ) as SessionMetadata;
      this.persisted.set(row.session_id, row.metadata);
    }
    console.log(
      `[SessionMetadataService] Loaded ${this.persisted.size} sessions from the database`,
    );

    let changed = false;
    for (const metadata of Object.values(this.state.sessions)) {
      if (!metadata.transcriptDisplayObjects) {
        continue;
      }
      const recovered = metadata.transcriptDisplayObjects.map((object) => {
        if (object.status === "generating") {
          return {
            ...object,
            status: "error" as const,
            error: "Fork summary interrupted by server restart",
          };
        }
        if (object.kind === "bang-command" && object.status === "running") {
          return {
            ...object,
            status: "killed" as const,
            error: "Interrupted by server restart",
          };
        }
        return object;
      });
      if (
        recovered.some(
          (object, index) =>
            object !== metadata.transcriptDisplayObjects?.[index],
        )
      ) {
        metadata.transcriptDisplayObjects = recovered;
        changed = true;
      }
    }
    if (changed) {
      await this.save();
    }
  }

  private async importLegacyFile(): Promise<void> {
    const content = await fs
      .readFile(this.legacyFilePath, "utf-8")
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw new Error(
          `Cannot read ${this.legacyFilePath} for import into the database`,
          { cause: error },
        );
      });
    let sessions: Record<string, SessionMetadata> = {};
    if (content !== undefined) {
      let parsed: LegacySessionMetadataFile;
      try {
        parsed = JSON.parse(content) as LegacySessionMetadataFile;
      } catch (error) {
        throw new Error(
          `Cannot import ${this.legacyFilePath}: it is not valid JSON. Repair or move it aside and restart.`,
          { cause: error },
        );
      }
      sessions = parsed.sessions ?? {};
      if ((parsed.version ?? 0) < 3) {
        for (const metadata of Object.values(sessions)) {
          if (!metadata.parentSessionId) continue;
          if (
            /^\/btw(?:\s+|$)/i.test(metadata.customTitle?.trimStart() ?? "")
          ) {
            metadata.parentSessionKind = "btw-aside";
          } else {
            metadata.forkedFromSessionId ??= metadata.parentSessionId;
            metadata.parentSessionId = undefined;
            metadata.parentSessionKind = undefined;
          }
        }
      }
    }
    const imported = this.database.transaction(() => {
      // Another connection may have imported while the file was being read.
      if (this.statements.selectImport.get()) return false;
      for (const [sessionId, metadata] of Object.entries(sessions)) {
        this.statements.upsert.run(sessionId, JSON.stringify(metadata));
      }
      this.statements.insertImport.run(
        new Date().toISOString(),
        content === undefined ? "none" : "json",
      );
      return true;
    });
    if (imported && content !== undefined) {
      console.log(
        `[SessionMetadataService] Imported ${Object.keys(sessions).length} sessions from ${this.legacyFilePath}; the file is no longer read or written`,
      );
    }
  }

  /**
   * Get metadata for a session.
   */
  getMetadata(sessionId: string): SessionMetadata | undefined {
    return this.state.sessions[this.resolveSessionId(sessionId)];
  }

  /**
   * Get all session metadata.
   */
  getAllMetadata(): Record<string, SessionMetadata> {
    return { ...this.state.sessions };
  }

  /** Distinct providers persisted by prior successful YA session boundaries. */
  getRecordedProviders(): ProviderName[] {
    const providers = new Set<ProviderName>();
    for (const sessionId in this.state.sessions) {
      const metadata = this.state.sessions[sessionId];
      if (metadata?.provider) providers.add(metadata.provider);
    }
    return [...providers];
  }

  getPendingNonHumanUserTurn(sessionId: string): NonHumanUserTurn | undefined {
    return pendingNonHumanUserTurn(this.getMetadata(sessionId));
  }

  async recordNonHumanUserTurn(
    sessionId: string,
    turn: NonHumanUserTurn,
  ): Promise<void> {
    const previous = this.getMetadata(sessionId)?.nonHumanUserTurn;
    if (
      previous?.messageId !== turn.messageId &&
      (!previous ||
        Date.parse(turn.timestamp) >= Date.parse(previous.timestamp))
    ) {
      this.updateSessionMetadata(sessionId, (metadata) => ({
        ...metadata,
        nonHumanUserTurn: { ...turn },
      }));
    }
    await this.metadataSaver.flush();
  }

  async acknowledgeNonHumanUserTurn(
    sessionId: string,
    messageId: string,
  ): Promise<boolean> {
    const turn = this.getMetadata(sessionId)?.nonHumanUserTurn;
    if (!turn || turn.messageId !== messageId) return false;
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      nonHumanUserTurn: { ...turn, acknowledged: true },
    }));
    await this.metadataSaver.flush();
    return true;
  }

  getTranscriptDisplayObjects(sessionId: string): TranscriptDisplayObject[] {
    return (
      this.state.sessions[this.resolveSessionId(sessionId)]
        ?.transcriptDisplayObjects ?? []
    ).map((object) => {
      if (
        object.kind !== "fork-summary" ||
        object.targetSessionId ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(object.id)
      )
        return object;
      // Recover the projection if admission committed before its association.
      // Indexed, compact point lookup; no prompt decoding or background loop.
      const sessionId = this.creations.getPublicSessionId(
        { kind: "superuser" },
        `fork-summary-target-${object.id}`,
      );
      return sessionId ? { ...object, targetSessionId: sessionId } : object;
    });
  }

  getRecapMessages(sessionId: string): DurableRecapMessage[] {
    return [
      ...(this.state.sessions[this.resolveSessionId(sessionId)]
        ?.recapMessages ?? []),
    ];
  }

  getSyntheticDoneMessages(sessionId: string): DurableSyntheticDoneMessage[] {
    return [
      ...(this.state.sessions[this.resolveSessionId(sessionId)]
        ?.syntheticDoneMessages ?? []),
    ];
  }

  getLocalCommandMessages(sessionId: string): DurableLocalCommandMessage[] {
    return [
      ...(this.state.sessions[this.resolveSessionId(sessionId)]
        ?.localCommandMessages ?? []),
    ];
  }

  async addLocalCommandMessage(
    sessionId: string,
    message: DurableLocalCommandMessage,
  ): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      localCommandMessages: [
        ...(metadata.localCommandMessages ?? []).filter(
          (row) => row.uuid !== message.uuid,
        ),
        message,
      ],
    }));
    await this.metadataSaver.flush();
  }

  getRewindRecords(sessionId: string): SessionRewindRecord[] {
    return [
      ...(this.state.sessions[this.resolveSessionId(sessionId)]
        ?.rewindRecords ?? []),
    ];
  }

  getPendingRewind(sessionId: string): SessionPendingRewind | undefined {
    return this.state.sessions[this.resolveSessionId(sessionId)]?.pendingRewind;
  }

  /** Record a rewind and arm it for the next provider resume. */
  async addRewindRecord(
    sessionId: string,
    record: SessionRewindRecord,
    pending: SessionPendingRewind,
  ): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      rewindRecords: [
        ...(metadata.rewindRecords ?? []).filter((row) => row.id !== record.id),
        record,
      ],
      pendingRewind: pending,
    }));
    await this.metadataSaver.flush();
  }

  /** Forget a rewind that was refused before it could apply. */
  async removeRewindRecord(sessionId: string, recordId: string): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      rewindRecords: (metadata.rewindRecords ?? []).filter(
        (row) => row.id !== recordId,
      ),
      pendingRewind:
        metadata.pendingRewind?.recordId === recordId
          ? undefined
          : metadata.pendingRewind,
    }));
    await this.metadataSaver.flush();
  }

  /**
   * Give a verbatim transcript copy the source's rewind history. Only valid
   * when the copy keeps the source's message uuids (the legacy Claude clone);
   * an SDK fork remaps them and is sliced at the cut instead.
   */
  async copyRewindState(
    sourceSessionId: string,
    targetSessionId: string,
  ): Promise<void> {
    const source = this.state.sessions[this.resolveSessionId(sourceSessionId)];
    if (!source?.rewindRecords?.length && !source?.pendingRewind) return;
    this.updateSessionMetadata(targetSessionId, (metadata) => ({
      ...metadata,
      ...(source.rewindRecords?.length
        ? { rewindRecords: [...source.rewindRecords] }
        : {}),
      ...(source.pendingRewind
        ? { pendingRewind: { ...source.pendingRewind } }
        : {}),
    }));
    await this.metadataSaver.flush();
  }

  async clearPendingRewind(sessionId: string): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      pendingRewind: undefined,
    }));
    await this.metadataSaver.flush();
  }

  /** Sessions whose durable clearloop record still says `running`. */
  listSessionIdsWithRunningClearloop(): string[] {
    return Object.entries(this.state.sessions)
      .filter(([, metadata]) => metadata.clearloop?.state === "running")
      .map(([sessionId]) => sessionId);
  }

  getClearloop(sessionId: string): SessionClearloopJob | undefined {
    return this.state.sessions[this.resolveSessionId(sessionId)]?.clearloop;
  }

  async setClearloop(
    sessionId: string,
    job: SessionClearloopJob | undefined,
  ): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      clearloop: job,
    }));
    await this.metadataSaver.flush();
  }

  /** Last observed goal command for a session, whichever provider reported it. */
  getGoalCommand(sessionId: string): SlashCommand | undefined {
    return goalCommandOf(this.getMetadata(this.resolveSessionId(sessionId)));
  }

  async observeCommandInventory(
    sessionId: string,
    commands: SlashCommand[],
  ): Promise<void> {
    const goal = findGoalCommand(commands);
    // An inventory without goal state is unknown, not evidence of a clear.
    if (readGoalDetails(goal)?.goalObjective === undefined) return;
    sessionId = this.resolveSessionId(sessionId);
    const previous = this.getGoalCommand(sessionId);
    if (
      JSON.stringify(previous) === JSON.stringify(goal) &&
      !this.unsavedGoalObservations.has(sessionId)
    )
      return;
    this.unsavedGoalObservations.add(sessionId);
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      goalCommand: goal,
    }));
    await this.metadataSaver.flush();
    if (this.getMetadata(sessionId)?.goalCommand === goal) {
      this.unsavedGoalObservations.delete(sessionId);
    }
  }

  getCacheMissBillingEvents(
    limit = 200,
    options: { includeExpectedExpiry?: boolean } = {},
  ): CacheMissBillingRecord[] {
    const safeLimit = Math.max(0, Math.min(500, Math.floor(limit)));
    if (safeLimit === 0) {
      return [];
    }
    return Object.values(this.state.sessions)
      .flatMap((metadata) => metadata.cacheMissBillingEvents ?? [])
      .filter(
        (event) =>
          options.includeExpectedExpiry || event.expectedInputCost.freshEnough,
      )
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, safeLimit);
  }

  async addCacheMissBillingEvent(
    sessionId: string,
    event: CacheMissBillingRecord,
  ): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      cacheMissBillingEvents: [
        ...(metadata.cacheMissBillingEvents ?? []),
        event,
      ].slice(-MAX_CACHE_MISS_BILLING_EVENTS_PER_SESSION),
    }));
    await this.save();
  }

  async addRecapMessage(
    sessionId: string,
    message: DurableRecapMessage,
  ): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => {
      const existing = metadata.recapMessages ?? [];
      const duplicate = existing.some(
        (candidate) =>
          candidate.uuid === message.uuid ||
          (candidate.content === message.content &&
            candidate.timestamp === message.timestamp),
      );
      const nextMessages = duplicate
        ? existing.map((candidate) =>
            candidate.uuid === message.uuid ? message : candidate,
          )
        : [...existing, message];
      return {
        ...metadata,
        recapMessages: nextMessages.slice(-MAX_RECAP_MESSAGES_PER_SESSION),
      };
    });
    await this.save();
  }

  async recordSyntheticDone(
    sessionId: string,
    message: DurableSyntheticDoneMessage,
    options?: { archived?: boolean },
  ): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => {
      const existing = metadata.syntheticDoneMessages ?? [];
      const nextMessages = existing.some(
        (candidate) => candidate.uuid === message.uuid,
      )
        ? existing.map((candidate) =>
            candidate.uuid === message.uuid ? message : candidate,
          )
        : [...existing, message];
      return {
        ...metadata,
        syntheticDoneMessages: nextMessages.slice(
          -MAX_SYNTHETIC_DONE_MESSAGES_PER_SESSION,
        ),
        pendingSyntheticDone:
          metadata.pendingSyntheticDone?.message.uuid === message.uuid
            ? undefined
            : metadata.pendingSyntheticDone,
        automationPausedUntilUserTurn: true,
        ...(options?.archived ? { isArchived: true } : {}),
      };
    });
    await this.save();
  }

  /** All sessions that carry display objects, for cross-session views. */
  listTranscriptDisplayObjectSessions(): Array<{
    sessionId: string;
    workingProjectId?: UrlProjectId;
    objects: TranscriptDisplayObject[];
  }> {
    return Object.entries(this.state.sessions).flatMap(
      ([sessionId, metadata]) =>
        metadata.transcriptDisplayObjects?.length
          ? [
              {
                sessionId,
                workingProjectId: metadata.workingProjectId,
                objects: [...metadata.transcriptDisplayObjects],
              },
            ]
          : [],
    );
  }

  async addTranscriptDisplayObject(
    sessionId: string,
    object: TranscriptDisplayObject,
  ): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      transcriptDisplayObjects: [
        ...(metadata.transcriptDisplayObjects ?? []),
        object,
      ],
    }));
    await this.save();
  }

  async updateTranscriptDisplayObject(
    sessionId: string,
    objectId: string,
    updater: (object: TranscriptDisplayObject) => TranscriptDisplayObject,
  ): Promise<TranscriptDisplayObject | undefined> {
    let updatedObject: TranscriptDisplayObject | undefined;
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      transcriptDisplayObjects: metadata.transcriptDisplayObjects?.map(
        (object) => {
          if (object.id !== objectId) {
            return object;
          }
          updatedObject = updater(object);
          return updatedObject;
        },
      ),
    }));
    if (!updatedObject) {
      return undefined;
    }
    await this.save();
    return updatedObject;
  }

  async removeTranscriptDisplayObject(
    sessionId: string,
    objectId: string,
  ): Promise<boolean> {
    let removed = false;
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      transcriptDisplayObjects: metadata.transcriptDisplayObjects?.filter(
        (object) => {
          if (object.id !== objectId) {
            return true;
          }
          removed = true;
          return false;
        },
      ),
    }));
    if (!removed) {
      return false;
    }
    await this.save();
    return true;
  }

  /**
   * Set the custom title for a session.
   * Pass undefined or empty string to clear the custom title.
   */
  async setTitle(sessionId: string, title: string | undefined): Promise<void> {
    const trimmedTitle =
      title === undefined ? undefined : sanitizeSessionTitle(title);
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      customTitle: trimmedTitle || undefined,
    }));
    await this.save();
  }

  /**
   * Set the archived status for a session.
   */
  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      isArchived: archived || undefined,
    }));
    await this.save();
  }

  /**
   * Set the starred status for a session.
   */
  async setStarred(sessionId: string, starred: boolean): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      isStarred: starred || undefined,
    }));
    await this.save();
  }

  /**
   * Set the provider for a session.
   * This stores the provider name for backward compatibility with sessions
   * that don't have provider information in their JSONL files.
   */
  async setProvider(
    sessionId: string,
    provider: ProviderName | undefined,
  ): Promise<void> {
    const normalizedProvider = provider || undefined;
    if (this.getMetadata(sessionId)?.provider === normalizedProvider) return;
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      provider: normalizedProvider,
    }));
    await this.save();
  }

  /**
   * Set the executor (SSH host) for a session.
   * Used to track which remote executor ran a session for resume.
   */
  async setExecutor(
    sessionId: string,
    executor: string | undefined,
  ): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      executor: executor || undefined,
    }));
    await this.save();
  }

  /**
   * Claim the next fork ordinal for a source session: 1 for the lineage's first
   * fork, 2 for the next, and so on. Callers use it to title repeated forks
   * "Fork: X", "Fork 2: X", "Fork 3: X" instead of naming them alike, and must
   * record the returned `lineageRootId` on the new fork (see `updateMetadata`'s
   * `forkLineageRootId`) so forking that fork continues the same sequence.
   * A deleted fork's number is not reissued; a fork that was never created
   * gives its number back through `releaseForkOrdinal`.
   */
  async nextForkOrdinal(sessionId: string): Promise<ForkOrdinalClaim> {
    const lineageRootId = this.forkLineageRoot(sessionId);
    const ordinal = (this.getMetadata(lineageRootId)?.forksCreated ?? 0) + 1;
    this.updateSessionMetadata(lineageRootId, (metadata) => ({
      ...metadata,
      forksCreated: ordinal,
    }));
    await this.save();
    return { ordinal, lineageRootId };
  }

  /**
   * Return a fork ordinal whose fork was never created. Only the lineage's
   * latest claim can be returned: once a later fork has taken a number, the
   * failed one stays used rather than being handed out a second time.
   */
  async releaseForkOrdinal(claim: ForkOrdinalClaim): Promise<void> {
    if (this.getMetadata(claim.lineageRootId)?.forksCreated !== claim.ordinal) {
      return;
    }
    this.updateSessionMetadata(claim.lineageRootId, (metadata) => ({
      ...metadata,
      forksCreated: claim.ordinal - 1 || undefined,
    }));
    await this.save();
  }

  /**
   * Set the YA model id (launch alias) chosen when YA started this session.
   * Persisted so per-model settings still key by the requested YA id after a
   * server restart. See topics/provider-abstraction.md § Per-model settings keying.
   */
  async setRequestedModel(
    sessionId: string,
    requestedModel: string | undefined,
  ): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      requestedModel: requestedModel || undefined,
      ...(metadata.effectiveLaunchSettings &&
      metadata.effectiveLaunchSettings.requestedModel !==
        (requestedModel || null)
        ? {
            effectiveLaunchSettings: {
              ...metadata.effectiveLaunchSettings,
              revision: metadata.effectiveLaunchSettings.revision + 1,
              requestedModel: requestedModel || null,
            },
          }
        : {}),
    }));
    await this.save();
  }

  getEffectiveLaunchSettings(
    sessionId: string,
  ): EffectiveSessionLaunchSettings | undefined {
    return this.getMetadata(sessionId)?.effectiveLaunchSettings;
  }

  /**
   * Record one complete, successfully applied launch-settings snapshot.
   * Identical snapshots are no-ops so reload-safe host reattachment does not
   * manufacture revisions or rewrite metadata.
   */
  async recordEffectiveLaunchSettings(
    sessionId: string,
    value: EffectiveSessionLaunchSettingsValue,
  ): Promise<EffectiveSessionLaunchSettings> {
    const existing = this.getEffectiveLaunchSettings(sessionId);
    if (
      existing &&
      existing.permissionMode === value.permissionMode &&
      existing.requestedModel === value.requestedModel &&
      existing.serviceTier === value.serviceTier &&
      JSON.stringify(existing.thinking) === JSON.stringify(value.thinking) &&
      existing.effort === value.effort
    ) {
      await this.metadataSaver.flush();
      return existing;
    }

    const next: EffectiveSessionLaunchSettings = {
      schemaVersion: 1,
      revision: (existing?.revision ?? 0) + 1,
      ...value,
    };
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      requestedModel: value.requestedModel || undefined,
      effectiveLaunchSettings: next,
    }));
    await this.metadataSaver.flush();
    return next;
  }

  /**
   * Rewrite the current metadata snapshot and wait for the coalesced writer to
   * reach quiescence. Callers use this after a group of ordinary metadata
   * mutations when their response must acknowledge durable state.
   */
  async flushPendingWrites(): Promise<void> {
    await this.metadataSaver.flush();
  }

  /**
   * Set YA's effective project for a session without modifying provider state.
   *
   * `transcriptProjectId` is only needed when the provider transcript still
   * lives under a different project than `workingProjectId`.
   */
  async setWorkingProject(
    sessionId: string,
    workingProjectId: UrlProjectId | undefined,
    transcriptProjectId: UrlProjectId | undefined,
  ): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      workingProjectId,
      transcriptProjectId: workingProjectId ? transcriptProjectId : undefined,
    }));
    await this.save();
  }

  /**
   * Set the durable YA host sandbox selection and private provider-state root.
   */
  async setSessionSandbox(
    sessionId: string,
    sandbox: {
      level: SessionSandboxLevel;
      networkFirewall?: boolean;
      stateKey?: string;
      projectPath: string;
      projectId: UrlProjectId;
      provider?: ProviderName;
    },
  ): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      ...(sandbox.provider ? { provider: sandbox.provider } : {}),
      sandboxLevel: sandbox.level,
      sandboxNetworkFirewall:
        sandbox.level === "project-write"
          ? sandbox.networkFirewall !== false
          : undefined,
      sandboxStateKey: sandbox.stateKey,
      sandboxProjectPath: sandbox.projectPath,
      workingProjectId: sandbox.projectId,
    }));
    await this.save();
  }

  /**
   * Get the provider for a session.
   * Returns undefined if the provider was never explicitly saved.
   */
  getProvider(sessionId: string): ProviderName | undefined {
    return this.getMetadata(sessionId)?.provider;
  }

  /**
   * Get the requested YA model id for a session.
   * Returns undefined for sessions YA didn't start (no requested id was stored).
   */
  getRequestedModel(sessionId: string): string | undefined {
    const metadata = this.getMetadata(sessionId);
    if (metadata?.effectiveLaunchSettings) {
      return metadata.effectiveLaunchSettings.requestedModel ?? undefined;
    }
    return metadata?.requestedModel;
  }

  /**
   * The session whose fork count numbers this session's forks: the lineage
   * root, or the session itself when it is one. Read-only companion to
   * `nextForkOrdinal` for callers that record lineage without claiming a number.
   * A fork created before targets recorded `forkLineageRootId` still names its
   * source in `forkedFromSessionId`, so the root is found by walking sources.
   */
  forkLineageRoot(sessionId: string): string {
    const visited = new Set<string>();
    let current = sessionId;
    for (;;) {
      const metadata = this.getMetadata(current);
      if (metadata?.forkLineageRootId) {
        return metadata.forkLineageRootId;
      }
      visited.add(current);
      const source = metadata?.forkedFromSessionId;
      if (!source || visited.has(source)) {
        return current;
      }
      current = source;
    }
  }

  /**
   * Get the executor for a session.
   * Returns undefined if the session ran locally or executor is unknown.
   */
  getExecutor(sessionId: string): string | undefined {
    return this.getMetadata(sessionId)?.executor;
  }

  /**
   * Get the persisted prompt-suggestion preference for a session.
   * Returns undefined if it was never explicitly saved (use provider default).
   */
  getPromptSuggestionMode(sessionId: string): PromptSuggestionMode | undefined {
    return this.getMetadata(sessionId)?.promptSuggestionMode;
  }

  /**
   * Get the persisted away-recap timing preference for a session.
   * Returns undefined if it was never explicitly saved (use default).
   */
  getRecapAfterSeconds(sessionId: string): number | undefined {
    return this.getMetadata(sessionId)?.recapAfterSeconds;
  }

  /**
   * Get the persisted recap strategy for a session, or undefined if it was
   * never explicitly saved (use default). Used to decide whether a cold
   * (process-dead) session should be revived for a forked recap.
   */
  getRecapMode(sessionId: string): RecapMode | undefined {
    return this.getMetadata(sessionId)?.recapMode;
  }

  /**
   * Move metadata from a provisional process ID to the provider's canonical
   * session ID. The in-memory alias also redirects writes that began before
   * the provider announced the canonical ID but finish after this remap.
   */
  async remapSessionId(
    provisionalSessionId: string,
    canonicalSessionId: string,
  ): Promise<void> {
    if (provisionalSessionId === canonicalSessionId) return;

    const sourceId = this.resolveSessionId(provisionalSessionId);
    const targetId = this.resolveSessionId(canonicalSessionId);
    this.sessionIdAliases.set(provisionalSessionId, targetId);
    if (sourceId !== targetId) {
      this.sessionIdAliases.set(sourceId, targetId);
    }

    const source = this.state.sessions[sourceId];
    if (!source || sourceId === targetId) return;

    this.state.sessions[targetId] = {
      ...source,
      ...this.state.sessions[targetId],
    };
    const { [sourceId]: _, ...remaining } = this.state.sessions;
    this.state.sessions = remaining;
    await this.save();
  }

  /**
   * Set the initial prompt accepted for a new session.
   * Used as a durable recovery source if provider startup fails before JSONL
   * persistence writes the user message.
   */
  async setInitialPrompt(
    sessionId: string,
    initialPrompt: string | undefined,
  ): Promise<void> {
    const prompt = initialPrompt?.trim() || undefined;
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      initialPrompt: prompt,
    }));
    await this.save();
  }

  /** Preserve the first client-declared creation source across later writes. */
  async recordCreationProvenance(
    sessionId: string,
    provenance: SessionCreationProvenance,
  ): Promise<void> {
    if (this.getMetadata(sessionId)?.creationProvenance) return;
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      creationProvenance: metadata.creationProvenance ?? provenance,
    }));
    await this.flushPendingWrites();
  }

  /** Record the limited user who started a session, at creation time. */
  async recordSessionCreator(
    sessionId: string,
    username: string,
  ): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      createdByUser: username,
    }));
    await this.flushPendingWrites();
  }

  /**
   * Update metadata for a session (title, archived, starred).
   */
  async updateMetadata(
    sessionId: string,
    updates: {
      routerBinding?: SessionMetadata["routerBinding"];
      title?: string;
      archived?: boolean;
      starred?: boolean;
      sidebarCategory?: string | null;
      parentSessionId?: string | null;
      parentSessionKind?: "btw-aside" | null;
      forkedFromSessionId?: string | null;
      forkLineageRootId?: string | null;
      wakeTurnsEnabled?: boolean | null;
      autoResumeDisabled?: boolean;
      promptSuggestionMode?: PromptSuggestionMode | null;
      recapAfterSeconds?: number | null;
      recapMode?: RecapMode | null;
      recapPausedUntilUserTurn?: boolean;
      automationPausedUntilUserTurn?: boolean;
      pendingSyntheticDone?: SessionMetadata["pendingSyntheticDone"] | null;
    },
  ): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => {
      const result = { ...metadata };
      if (updates.routerBinding) result.routerBinding = updates.routerBinding;

      // Handle title
      if (updates.title !== undefined) {
        const trimmedTitle = sanitizeSessionTitle(updates.title);
        result.customTitle = trimmedTitle || undefined;
      }

      // Handle archived
      if (updates.archived !== undefined) {
        result.isArchived = updates.archived || undefined;
      }

      // Handle starred
      if (updates.starred !== undefined) {
        result.isStarred = updates.starred || undefined;
      }

      if (updates.sidebarCategory !== undefined) {
        result.sidebarCategory = updates.sidebarCategory || undefined;
      }

      if (updates.parentSessionId !== undefined) {
        result.parentSessionId = updates.parentSessionId?.trim() || undefined;
        result.parentSessionKind = result.parentSessionId
          ? (updates.parentSessionKind ?? "btw-aside")
          : undefined;
      } else if (updates.parentSessionKind !== undefined) {
        result.parentSessionKind =
          result.parentSessionId && updates.parentSessionKind === "btw-aside"
            ? "btw-aside"
            : undefined;
      }

      if (updates.forkedFromSessionId !== undefined) {
        result.forkedFromSessionId =
          updates.forkedFromSessionId?.trim() || undefined;
      }

      if (updates.forkLineageRootId !== undefined) {
        const lineageRootId = updates.forkLineageRootId?.trim() || undefined;
        // A session is never its own lineage root record: the root's count is
        // found by the absence of this field.
        result.forkLineageRootId =
          lineageRootId === sessionId ? undefined : lineageRootId;
      }

      if (updates.wakeTurnsEnabled !== undefined) {
        result.wakeTurnsEnabled = updates.wakeTurnsEnabled ?? undefined;
      }

      if (updates.autoResumeDisabled !== undefined) {
        result.autoResumeDisabled = updates.autoResumeDisabled || undefined;
      }

      // null clears the preference (revert to default); "off"/"native" store
      // as-is. "off" is a meaningful stored value — it must override the
      // provider's native default on resume — so it is not collapsed away.
      if (updates.promptSuggestionMode !== undefined) {
        result.promptSuggestionMode = updates.promptSuggestionMode ?? undefined;
      }

      if (updates.recapAfterSeconds !== undefined) {
        result.recapAfterSeconds =
          updates.recapAfterSeconds === null
            ? undefined
            : normalizeRecapAfterSeconds(updates.recapAfterSeconds);
      }

      // null clears (revert to default); "off" is meaningful-stored — it must
      // override the default on resume — so it is not collapsed away.
      if (updates.recapMode !== undefined) {
        result.recapMode = updates.recapMode ?? undefined;
      }

      if (updates.recapPausedUntilUserTurn !== undefined) {
        result.recapPausedUntilUserTurn =
          updates.recapPausedUntilUserTurn || undefined;
      }

      if (updates.automationPausedUntilUserTurn !== undefined) {
        result.automationPausedUntilUserTurn =
          updates.automationPausedUntilUserTurn || undefined;
      }

      if (updates.pendingSyntheticDone !== undefined) {
        result.pendingSyntheticDone = updates.pendingSyntheticDone ?? undefined;
      }

      return result;
    });
    await this.save();
  }

  /**
   * Helper to update session metadata and clean up empty entries.
   */
  private updateSessionMetadata(
    sessionId: string,
    updater: (current: SessionMetadata) => SessionMetadata,
  ): void {
    const resolvedSessionId = this.resolveSessionId(sessionId);
    const existing = this.state.sessions[resolvedSessionId] ?? {};
    const updated = updater(existing);

    // Remove undefined values and check if entry should be deleted
    const cleaned: SessionMetadata = {};
    if (updated.creationProvenance) {
      cleaned.creationProvenance = updated.creationProvenance;
    }
    if (updated.createdByUser) cleaned.createdByUser = updated.createdByUser;
    if (updated.nonHumanUserTurn) {
      cleaned.nonHumanUserTurn = updated.nonHumanUserTurn;
    }
    if (updated.customTitle) cleaned.customTitle = updated.customTitle;
    if (updated.isArchived) cleaned.isArchived = updated.isArchived;
    if (updated.isStarred) cleaned.isStarred = updated.isStarred;
    if (updated.sidebarCategory) {
      cleaned.sidebarCategory = updated.sidebarCategory;
    }
    if (updated.parentSessionId)
      cleaned.parentSessionId = updated.parentSessionId;
    if (updated.parentSessionId && updated.parentSessionKind) {
      cleaned.parentSessionKind = updated.parentSessionKind;
    }
    if (updated.forkedFromSessionId) {
      cleaned.forkedFromSessionId = updated.forkedFromSessionId;
    }
    if (updated.forksCreated) {
      cleaned.forksCreated = updated.forksCreated;
    }
    if (updated.forkLineageRootId) {
      cleaned.forkLineageRootId = updated.forkLineageRootId;
    }
    if (updated.transcriptDisplayObjects?.length) {
      cleaned.transcriptDisplayObjects = updated.transcriptDisplayObjects;
    }
    if (updated.recapMessages?.length) {
      cleaned.recapMessages = updated.recapMessages;
    }
    if (updated.localCommandMessages?.length) {
      cleaned.localCommandMessages = updated.localCommandMessages;
    }
    if (updated.rewindRecords?.length) {
      cleaned.rewindRecords = updated.rewindRecords;
    }
    if (updated.pendingRewind) {
      cleaned.pendingRewind = updated.pendingRewind;
    }
    if (updated.clearloop) {
      cleaned.clearloop = updated.clearloop;
    }
    if (updated.goalCommand) {
      cleaned.goalCommand = updated.goalCommand;
    }
    if (updated.codexGoalCommand) {
      cleaned.codexGoalCommand = updated.codexGoalCommand;
    }
    if (updated.syntheticDoneMessages?.length) {
      cleaned.syntheticDoneMessages = updated.syntheticDoneMessages;
    }
    if (updated.pendingSyntheticDone) {
      cleaned.pendingSyntheticDone = updated.pendingSyntheticDone;
    }
    if (updated.cacheMissBillingEvents?.length) {
      cleaned.cacheMissBillingEvents = updated.cacheMissBillingEvents;
    }
    if (updated.requestedModel) cleaned.requestedModel = updated.requestedModel;
    if (updated.effectiveLaunchSettings) {
      cleaned.effectiveLaunchSettings = updated.effectiveLaunchSettings;
    }
    if (updated.provider) cleaned.provider = updated.provider;
    if (updated.routerBinding) cleaned.routerBinding = updated.routerBinding;
    if (updated.executor) cleaned.executor = updated.executor;
    if (updated.initialPrompt) cleaned.initialPrompt = updated.initialPrompt;
    if (updated.wakeTurnsEnabled !== undefined) {
      cleaned.wakeTurnsEnabled = updated.wakeTurnsEnabled;
    }
    if (updated.autoResumeDisabled) {
      cleaned.autoResumeDisabled = updated.autoResumeDisabled;
    }
    if (updated.promptSuggestionMode) {
      cleaned.promptSuggestionMode = updated.promptSuggestionMode;
    }
    if (updated.recapAfterSeconds !== undefined) {
      cleaned.recapAfterSeconds = updated.recapAfterSeconds;
    }
    if (updated.recapMode) {
      cleaned.recapMode = updated.recapMode;
    }
    if (updated.recapPausedUntilUserTurn) {
      cleaned.recapPausedUntilUserTurn = updated.recapPausedUntilUserTurn;
    }
    if (updated.automationPausedUntilUserTurn) {
      cleaned.automationPausedUntilUserTurn =
        updated.automationPausedUntilUserTurn;
    }
    if (updated.sandboxLevel) {
      cleaned.sandboxLevel = updated.sandboxLevel;
    }
    if (updated.sandboxNetworkFirewall !== undefined) {
      cleaned.sandboxNetworkFirewall = updated.sandboxNetworkFirewall;
    }
    if (updated.sandboxStateKey) {
      cleaned.sandboxStateKey = updated.sandboxStateKey;
    }
    if (updated.sandboxProjectPath) {
      cleaned.sandboxProjectPath = updated.sandboxProjectPath;
    }
    if (updated.workingProjectId) {
      cleaned.workingProjectId = updated.workingProjectId;
    }
    if (updated.transcriptProjectId) {
      cleaned.transcriptProjectId = updated.transcriptProjectId;
    }

    if (Object.keys(cleaned).length === 0) {
      // Remove the entry entirely if empty
      const { [resolvedSessionId]: _, ...rest } = this.state.sessions;
      this.state.sessions = rest;
    } else {
      this.state.sessions[resolvedSessionId] = cleaned;
    }
  }

  /**
   * Clear all metadata for a session.
   * Useful when a session is deleted.
   */
  async clearSession(sessionId: string): Promise<void> {
    const resolvedSessionId = this.resolveSessionId(sessionId);
    if (this.state.sessions[resolvedSessionId]) {
      const { [resolvedSessionId]: _, ...rest } = this.state.sessions;
      this.state.sessions = rest;
      await this.save();
    }
  }

  private resolveSessionId(sessionId: string): string {
    let resolved = sessionId;
    const visited = new Set<string>();
    while (!visited.has(resolved)) {
      visited.add(resolved);
      const next = this.sessionIdAliases.get(resolved);
      if (!next) break;
      resolved = next;
    }
    return resolved;
  }

  private async doSave(): Promise<void> {
    const changed = new Map<string, string>();
    for (const [sessionId, metadata] of Object.entries(this.state.sessions)) {
      const text = JSON.stringify(metadata);
      if (this.persisted.get(sessionId) !== text) changed.set(sessionId, text);
    }
    const removed = [...this.persisted.keys()].filter(
      (sessionId) => !(sessionId in this.state.sessions),
    );
    if (changed.size === 0 && removed.length === 0) return;
    try {
      this.database.transaction(() => {
        for (const [sessionId, text] of changed) {
          this.statements.upsert.run(sessionId, text);
        }
        for (const sessionId of removed) {
          this.statements.remove.run(sessionId);
        }
      });
    } catch (error) {
      console.error("[SessionMetadataService] Failed to save state:", error);
      throw error;
    }
    for (const [sessionId, text] of changed)
      this.persisted.set(sessionId, text);
    for (const sessionId of removed) this.persisted.delete(sessionId);
  }

  /** Where session metadata is stored, for diagnostics. */
  getFilePath(): string {
    return path.join(this.dataDir, "discovery.sqlite");
  }
}
