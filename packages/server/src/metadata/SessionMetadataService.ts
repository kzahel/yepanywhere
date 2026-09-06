/**
 * SessionMetadataService manages custom session metadata (titles, archive status).
 * This enables renaming sessions and archiving them to hide from default view.
 *
 * State is persisted to a JSON file for durability across server restarts.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type CacheMissBillingRecord,
  type DurableRecapMessage,
  type DurableLocalCommandMessage,
  type DurableSyntheticDoneMessage,
  type EffortLevel,
  type PermissionMode,
  type ProviderName,
  type PromptSuggestionMode,
  type RecapMode,
  type SessionSandboxLevel,
  type SlashCommand,
  type ThinkingConfig,
  type TranscriptDisplayObject,
  type UrlProjectId,
  type WorkstreamId,
  normalizeRecapAfterSeconds,
  sanitizeSessionTitle,
} from "@yep-anywhere/shared";
import { createCoalescingSaver } from "../lib/coalescingSaver.js";

export interface EffectiveSessionLaunchSettings {
  /** Record schema, independent of the containing metadata-file schema. */
  schemaVersion: 1;
  /** Monotonic session-local revision for ordered client/server updates. */
  revision: number;
  /** Standing permission selector restored when YA owns a new process. */
  permissionMode: PermissionMode;
  /** Exact YA model token, including "default"; null means provider default. */
  requestedModel: string | null;
  /** Provider-visible service tier; null means provider/default behavior. */
  serviceTier: string | null;
  /** Effective thinking configuration; null means disabled/default behavior. */
  thinking: ThinkingConfig | null;
  /** Effective effort selection; null means provider/default behavior. */
  effort: EffortLevel | null;
}

export type EffectiveSessionLaunchSettingsValue = Omit<
  EffectiveSessionLaunchSettings,
  "schemaVersion" | "revision"
>;

export interface SessionMetadata {
  /** Custom title that overrides auto-generated title */
  customTitle?: string;
  /** Whether the session is archived (hidden from default list) */
  isArchived?: boolean;
  /** Whether the session is starred/favorited */
  isStarred?: boolean;
  /** Interactive Mother session for a YA-owned `/btw` aside. */
  parentSessionId?: string;
  /** Explicit meaning of parentSessionId; absent on legacy records. */
  parentSessionKind?: "btw-aside";
  /** Source session whose provider transcript was cloned or forked. */
  forkedFromSessionId?: string;
  /** Saved viewer-only objects placed in the transcript. */
  transcriptDisplayObjects?: TranscriptDisplayObject[];
  /** Durable YA-owned recap rows merged into the transcript view only. */
  recapMessages?: DurableRecapMessage[];
  localCommandMessages?: DurableLocalCommandMessage[];
  /** Last provider-observed goal, independent of historical command receipts. */
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
  /** Whether this session is opted in to heartbeat turns */
  heartbeatTurnsEnabled?: boolean;
  /** Per-session session-wake override; absent inherits the server default. */
  wakeTurnsEnabled?: boolean;
  /** Explicit Kill blocks YA-owned automatic resume without hiding history. */
  autoResumeDisabled?: boolean;
  /** Optional per-session idle threshold override in minutes */
  heartbeatTurnsAfterMinutes?: number;
  /** Optional per-session heartbeat text override */
  heartbeatTurnText?: string;
  /** Per-session grace minutes before forcing output; null = off */
  heartbeatForceAfterMinutes?: number | null;
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
  /** YA workstream lane for this session. Missing means the implicit main lane. */
  workstreamId?: WorkstreamId;
}

export interface SessionMetadataState {
  /** Map of sessionId -> metadata */
  sessions: Record<string, SessionMetadata>;
  /** Schema version for future migrations */
  version: number;
}

const CURRENT_VERSION = 3;
const MAX_RECAP_MESSAGES_PER_SESSION = 200;
const MAX_SYNTHETIC_DONE_MESSAGES_PER_SESSION = 200;
const MAX_CACHE_MISS_BILLING_EVENTS_PER_SESSION = 100;

export interface SessionMetadataServiceOptions {
  /** Directory to store metadata state (defaults to ~/.yep-anywhere) */
  dataDir?: string;
}

export class SessionMetadataService {
  private state: SessionMetadataState;
  private dataDir: string;
  private filePath: string;
  private sessionIdAliases = new Map<string, string>();
  private unsavedGoalObservations = new Set<string>();
  private metadataSaver = createCoalescingSaver(() => this.doSave());
  private save = this.metadataSaver.save;

  constructor(options: SessionMetadataServiceOptions = {}) {
    this.dataDir =
      options.dataDir ??
      path.join(
        process.env.HOME ?? process.env.USERPROFILE ?? ".",
        ".yep-anywhere",
      );
    this.filePath = path.join(this.dataDir, "session-metadata.json");
    this.state = { sessions: {}, version: CURRENT_VERSION };
  }

  /**
   * Initialize the service by loading state from disk.
   * Creates the data directory and file if they don't exist.
   */
  async initialize(): Promise<void> {
    console.log(`[SessionMetadataService] Initializing from: ${this.filePath}`);
    try {
      // Ensure data directory exists
      await fs.mkdir(this.dataDir, { recursive: true });

      // Try to load existing state
      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as SessionMetadataState;
      console.log(
        `[SessionMetadataService] Loaded ${Object.keys(parsed.sessions).length} sessions from disk`,
      );

      this.state = {
        sessions: parsed.sessions ?? {},
        version: CURRENT_VERSION,
      };

      const migrateLegacyLineage = (parsed.version ?? 0) < 3;
      let changed = parsed.version !== CURRENT_VERSION;
      for (const metadata of Object.values(this.state.sessions)) {
        if (migrateLegacyLineage && metadata.parentSessionId) {
          if (
            /^\/btw(?:\s+|$)/i.test(metadata.customTitle?.trimStart() ?? "")
          ) {
            metadata.parentSessionKind = "btw-aside";
          } else {
            metadata.forkedFromSessionId ??= metadata.parentSessionId;
            metadata.parentSessionId = undefined;
            metadata.parentSessionKind = undefined;
          }
          changed = true;
        }
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
    } catch (error) {
      // File doesn't exist or is invalid - start fresh
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[SessionMetadataService] Failed to load state, starting fresh:",
          error,
        );
      }
      this.state = { sessions: {}, version: CURRENT_VERSION };
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

  getTranscriptDisplayObjects(sessionId: string): TranscriptDisplayObject[] {
    return [
      ...(this.state.sessions[this.resolveSessionId(sessionId)]
        ?.transcriptDisplayObjects ?? []),
    ];
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

  async observeCommandInventory(
    sessionId: string,
    commands: SlashCommand[],
  ): Promise<void> {
    const goal = commands.find((command) => command.name === "goal");
    // An inventory without goal state is unknown, not evidence of a clear.
    if (goal?.providerDetails?.codex?.goalObjective === undefined) return;
    sessionId = this.resolveSessionId(sessionId);
    const previous = this.getMetadata(sessionId)?.codexGoalCommand;
    if (
      JSON.stringify(previous) === JSON.stringify(goal) &&
      !this.unsavedGoalObservations.has(sessionId)
    )
      return;
    this.unsavedGoalObservations.add(sessionId);
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      codexGoalCommand: goal,
    }));
    await this.metadataSaver.flush();
    if (this.getMetadata(sessionId)?.codexGoalCommand === goal) {
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
   * Set YA's workstream lane for a session without modifying provider state.
   *
   * Undefined means the implicit main workstream for the effective project.
   */
  async setWorkstream(
    sessionId: string,
    workstreamId: WorkstreamId | undefined,
  ): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      workstreamId,
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

  /**
   * Update metadata for a session (title, archived, starred).
   */
  async updateMetadata(
    sessionId: string,
    updates: {
      title?: string;
      archived?: boolean;
      starred?: boolean;
      parentSessionId?: string | null;
      parentSessionKind?: "btw-aside" | null;
      forkedFromSessionId?: string | null;
      heartbeatTurnsEnabled?: boolean;
      wakeTurnsEnabled?: boolean | null;
      autoResumeDisabled?: boolean;
      heartbeatTurnsAfterMinutes?: number | null;
      heartbeatTurnText?: string | null;
      heartbeatForceAfterMinutes?: number | null;
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

      if (updates.heartbeatTurnsEnabled !== undefined) {
        result.heartbeatTurnsEnabled =
          updates.heartbeatTurnsEnabled || undefined;
        if (updates.heartbeatTurnsEnabled) {
          result.autoResumeDisabled = undefined;
        }
      }

      if (updates.wakeTurnsEnabled !== undefined) {
        result.wakeTurnsEnabled = updates.wakeTurnsEnabled ?? undefined;
      }

      if (updates.autoResumeDisabled !== undefined) {
        result.autoResumeDisabled = updates.autoResumeDisabled || undefined;
      }

      if (updates.heartbeatTurnsAfterMinutes !== undefined) {
        result.heartbeatTurnsAfterMinutes =
          updates.heartbeatTurnsAfterMinutes ?? undefined;
      }

      if (updates.heartbeatTurnText !== undefined) {
        result.heartbeatTurnText =
          updates.heartbeatTurnText?.trim() || undefined;
      }

      if (updates.heartbeatForceAfterMinutes !== undefined) {
        result.heartbeatForceAfterMinutes = updates.heartbeatForceAfterMinutes;
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
    if (updated.customTitle) cleaned.customTitle = updated.customTitle;
    if (updated.isArchived) cleaned.isArchived = updated.isArchived;
    if (updated.isStarred) cleaned.isStarred = updated.isStarred;
    if (updated.parentSessionId)
      cleaned.parentSessionId = updated.parentSessionId;
    if (updated.parentSessionId && updated.parentSessionKind) {
      cleaned.parentSessionKind = updated.parentSessionKind;
    }
    if (updated.forkedFromSessionId) {
      cleaned.forkedFromSessionId = updated.forkedFromSessionId;
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
    if (updated.executor) cleaned.executor = updated.executor;
    if (updated.initialPrompt) cleaned.initialPrompt = updated.initialPrompt;
    if (updated.heartbeatTurnsEnabled) {
      cleaned.heartbeatTurnsEnabled = updated.heartbeatTurnsEnabled;
    }
    if (updated.wakeTurnsEnabled !== undefined) {
      cleaned.wakeTurnsEnabled = updated.wakeTurnsEnabled;
    }
    if (updated.autoResumeDisabled) {
      cleaned.autoResumeDisabled = updated.autoResumeDisabled;
    }
    if (updated.heartbeatTurnsAfterMinutes !== undefined) {
      cleaned.heartbeatTurnsAfterMinutes = updated.heartbeatTurnsAfterMinutes;
    }
    if (updated.heartbeatTurnText) {
      cleaned.heartbeatTurnText = updated.heartbeatTurnText;
    }
    if (updated.heartbeatForceAfterMinutes !== undefined) {
      cleaned.heartbeatForceAfterMinutes = updated.heartbeatForceAfterMinutes;
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
    if (updated.workstreamId) {
      cleaned.workstreamId = updated.workstreamId;
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
    try {
      const content = JSON.stringify(this.state, null, 2);
      await fs.writeFile(this.filePath, content, "utf-8");
    } catch (error) {
      console.error("[SessionMetadataService] Failed to save state:", error);
      throw error;
    }
  }

  /**
   * Get the file path for testing purposes.
   */
  getFilePath(): string {
    return this.filePath;
  }
}
