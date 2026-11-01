import { stat } from "node:fs/promises";
import * as path from "node:path";
import {
  type DirProjectId,
  type UrlProjectId,
  asDirProjectId,
  type ProviderName,
} from "@yep-anywhere/shared";
import {
  decodeProjectId,
  encodeProjectId,
  getProjectName,
  type ProjectDisplayNameResolver,
} from "../projects/paths.js";
import type { SessionListSummary } from "../sessions/types.js";
import type { ProjectScanner } from "../projects/scanner.js";
import { getCodexRolloutActivityTimeMs } from "../utils/codexRolloutFiles.js";
import { readFirstLine } from "../utils/jsonl.js";
import {
  BatchProcessor,
  type BatchProcessorDiagnostics,
} from "../watcher/BatchProcessor.js";
import type {
  BusEvent,
  EventBus,
  FileChangeEvent,
  SessionCreatedEvent,
  SessionStatusEvent,
  SessionUpdatedEvent,
} from "../watcher/EventBus.js";
import type { Supervisor } from "./Supervisor.js";
import type {
  ContextUsage,
  SessionOwnership,
  SessionSummary,
} from "./types.js";

interface ExternalSessionInfo {
  detectedAt: Date;
  lastActivity: Date;
  /** Directory-format projectId (from file path, NOT base64url) */
  dirProjectId?: DirProjectId;
  /** URL-format projectId (base64url) */
  projectId?: UrlProjectId;
  /** Session provider */
  provider: FileChangeEvent["provider"];
  timeoutId: ReturnType<typeof setTimeout>;
}

/**
 * Why this server itself recently wrote a session's transcript. Writes inside
 * the grace that follows are ours, never evidence of an external writer:
 * - `abort`: our stopped process's cleanup; the write is ignored outright.
 * - `fork`: our fork created the transcript; the session is still discovered,
 *   but reported unowned.
 */
type OwnWriteReason = "abort" | "fork";

/** Default grace period after abort before external detection resumes (30 seconds) */
const DEFAULT_ABORT_GRACE_MS = 30000;

/** Default grace period after this server forks a session (30 seconds) */
const DEFAULT_FORK_GRACE_MS = 30000;

type TrackedSessionSummary =
  | { fidelity: "complete"; summary: SessionSummary }
  | { fidelity: "list"; summary: SessionListSummary };

export interface ObservedPublicSession {
  sessionId: string;
  projectId: UrlProjectId;
  provider: ProviderName;
}

export interface ExternalSessionTrackerOptions {
  eventBus: EventBus;
  /** Undefined preserves verified legacy ingress; null refuses ambiguous source. */
  resolveObservedSession?: (
    event: FileChangeEvent,
    signal: AbortSignal,
  ) => Promise<ObservedPublicSession | null | undefined>;
  supervisor: Supervisor;
  scanner: ProjectScanner;
  /** Names a detected session's project; defaults to the path's name. */
  projectDisplayName?: ProjectDisplayNameResolver;
  /** Time in ms before external status decays to idle (default: 30000) */
  decayMs?: number;
  /** Grace period in ms after abort before external detection resumes (default: 30000) */
  abortGraceMs?: number;
  /** Grace period in ms after our own fork writes a transcript (default: 30000) */
  forkGraceMs?: number;
  /** Optional callback to get session summary for new external sessions */
  getSessionSummary?: (
    sessionId: string,
    projectId: UrlProjectId,
  ) => Promise<SessionSummary | null>;
  /** Optional bounded callback for Codex title/recency observations. */
  getSessionListSummary?: (
    sessionId: string,
    projectId: UrlProjectId,
  ) => Promise<SessionListSummary | null>;
}

export interface ExternalSessionTrackerDiagnostics {
  nativeSourceBatch?: BatchProcessorDiagnostics;
  droppedSourceEvents: number;
  sessionSummaryBatch: BatchProcessorDiagnostics;
}

/**
 * Tracks sessions that are being modified by external programs (not owned by this app).
 *
 * Uses file change events to detect when a session file is modified, then checks
 * if we own that session via Supervisor. If not owned, marks as "external" until
 * the decay timeout passes with no activity.
 */
export class ExternalSessionTracker {
  private readonly controller = new AbortController();
  private readonly nativeSourceBatch?: BatchProcessor<void>;
  private droppedSourceEvents = 0;
  private readonly resolveObservedSession?: ExternalSessionTrackerOptions["resolveObservedSession"];
  private externalSessions: Map<string, ExternalSessionInfo> = new Map();
  /** Sessions this server itself just wrote, with why and when (ms). */
  private recentOwnWrites: Map<string, { reason: OwnWriteReason; at: number }> =
    new Map();
  private eventBus: EventBus;
  private supervisor: Supervisor;
  private scanner: ProjectScanner;
  private readonly projectDisplayName: ProjectDisplayNameResolver;
  private decayMs: number;
  private abortGraceMs: number;
  private forkGraceMs: number;
  private unsubscribe: (() => void) | null = null;
  private getSessionSummary?: (
    sessionId: string,
    projectId: UrlProjectId,
  ) => Promise<SessionSummary | null>;
  private getSessionListSummary?: (
    sessionId: string,
    projectId: UrlProjectId,
  ) => Promise<SessionListSummary | null>;
  /** Batches session parsing to prevent OOM from concurrent file reads */
  private sessionParser: BatchProcessor<TrackedSessionSummary | null>;
  /**
   * Tracks sessions that have already emitted session-created. Semantic, not
   * a cache: one session ID per external session seen since process start
   * (reset on restart). Evicting would re-emit session-created.
   */
  private createdSessions: Set<string> = new Set();
  /**
   * Last known session state for change detection. Grows with external
   * sessions seen since process start (about 0.5–2 KB each); evicting would
   * report a spurious change, so a bound must follow session removal.
   */
  private sessionStateCache: Map<
    string,
    {
      title: string | null;
      updatedAt: string;
      messageCount?: number;
      projectId: UrlProjectId;
      contextUsage?: ContextUsage;
      model?: string;
      asyncQuestions?: SessionSummary["asyncQuestions"];
    }
  > = new Map();

  constructor(options: ExternalSessionTrackerOptions) {
    this.eventBus = options.eventBus;
    this.resolveObservedSession = options.resolveObservedSession;
    this.supervisor = options.supervisor;
    this.scanner = options.scanner;
    this.projectDisplayName = options.projectDisplayName ?? getProjectName;
    this.decayMs = options.decayMs ?? 30000;
    this.abortGraceMs = options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
    this.forkGraceMs = options.forkGraceMs ?? DEFAULT_FORK_GRACE_MS;
    this.getSessionSummary = options.getSessionSummary;
    this.getSessionListSummary = options.getSessionListSummary;

    // Initialize batch processor for session parsing
    // Limits concurrent JSONL parsing to prevent OOM during bulk file operations
    this.sessionParser = new BatchProcessor<TrackedSessionSummary | null>({
      concurrency: 5,
      batchMs: 300,
      onResult: (sessionId, observed) => {
        if (this.controller.signal.aborted || !observed) return;

        const summary = observed.summary;
        const isComplete = observed.fidelity === "complete";
        const projectId = summary.projectId as UrlProjectId;
        const now = new Date().toISOString();
        const cached = this.sessionStateCache.get(sessionId);
        const nextState = {
          ...cached,
          title: summary.title,
          updatedAt: summary.updatedAt,
          asyncQuestions: summary.asyncQuestions ?? cached?.asyncQuestions,
          projectId,
          ...(isComplete
            ? {
                messageCount: observed.summary.messageCount,
                contextUsage: observed.summary.contextUsage,
                model: observed.summary.model,
              }
            : {}),
        };

        // Check if supervisor owns this session
        const isOwned = !!this.supervisor.getProcessForSession(sessionId);

        // Clean up external tracking if owned
        if (isOwned) {
          this.removeExternal(sessionId);
        }

        // For owned sessions, we only emit session-updated (supervisor handles session-created)
        // For external sessions, we emit both session-created (first time) and session-updated
        if (!this.createdSessions.has(sessionId)) {
          if (isOwned) {
            // Owned session - supervisor already emitted session-created with title: null
            // Cache state and emit only fields observed at this fidelity.
            this.sessionStateCache.set(sessionId, nextState);
            this.createdSessions.add(sessionId);

            // Supervisor emits session-created before this observation.
            const event: SessionUpdatedEvent = {
              type: "session-updated",
              sessionId,
              projectId,
              title: summary.title,
              updatedAt: summary.updatedAt,
              asyncQuestions: summary.asyncQuestions,
              ...(isComplete
                ? {
                    messageCount: observed.summary.messageCount,
                    contextUsage: observed.summary.contextUsage,
                    model: observed.summary.model,
                    lastAgentText: observed.summary.lastAgentText,
                  }
                : {}),
              timestamp: now,
            };
            this.emit(event);
          } else if (isComplete) {
            // New external session - emit session-created
            const event: SessionCreatedEvent = {
              type: "session-created",
              session: {
                ...observed.summary,
                ownership: this.detectedOwnership(sessionId),
                projectName:
                  observed.summary.projectName ??
                  this.projectDisplayName(decodeProjectId(projectId)),
              },
              timestamp: now,
            };
            this.emit(event);
            this.createdSessions.add(sessionId);

            // Cache initial state for future change detection
            this.sessionStateCache.set(sessionId, nextState);
          } else {
            // Codex normally emits its synthetic session-created before the
            // batched list read completes. If header creation failed or raced,
            // fall back to a complete read rather than inventing required
            // SessionSummary fields from a partial projection.
            this.enqueueTrackedSummary(sessionId, projectId, "complete");
          }
        } else {
          // Existing session - check for changes and emit session-updated
          const titleChanged = cached?.title !== summary.title;
          const updatedAtChanged = cached?.updatedAt !== summary.updatedAt;
          const messageCountChanged =
            isComplete &&
            cached?.messageCount !== observed.summary.messageCount;
          // Compare context usage by input tokens (percentage can be derived)
          const contextUsageChanged =
            isComplete &&
            cached?.contextUsage?.inputTokens !==
              observed.summary.contextUsage?.inputTokens;
          const modelChanged =
            isComplete && cached?.model !== observed.summary.model;

          if (
            titleChanged ||
            updatedAtChanged ||
            messageCountChanged ||
            contextUsageChanged ||
            modelChanged ||
            (summary.asyncQuestions !== undefined &&
              JSON.stringify(summary.asyncQuestions) !==
                JSON.stringify(cached?.asyncQuestions))
          ) {
            const event: SessionUpdatedEvent = {
              type: "session-updated",
              sessionId,
              projectId,
              title: summary.title,
              updatedAt: summary.updatedAt,
              asyncQuestions: summary.asyncQuestions,
              ...(isComplete
                ? {
                    messageCount: observed.summary.messageCount,
                    contextUsage: observed.summary.contextUsage,
                    model: observed.summary.model,
                    lastAgentText: observed.summary.lastAgentText,
                  }
                : {}),
              timestamp: now,
            };
            this.emit(event);

            // Update cache
            this.sessionStateCache.set(sessionId, nextState);
          }
        }
      },
      onError: (sessionId, error) => {
        if (this.controller.signal.aborted) return;
        // Log but don't fail - session may not be readable yet
        console.warn(
          `[ExternalSessionTracker] Failed to read session ${sessionId}:`,
          error.message,
        );
      },
    });

    if (options.resolveObservedSession) {
      this.nativeSourceBatch = new BatchProcessor<void>({
        concurrency: 5,
        batchMs: 0,
      });
    }

    // Subscribe to bus events
    this.unsubscribe = options.eventBus.subscribe((event: BusEvent) => {
      if (event.type === "file-change") {
        if (this.nativeSourceBatch) {
          if (
            event.fileType !== "session" &&
            event.fileType !== "agent-session"
          )
            return;
          // At most one bounded batch and one bounded trailing batch. Dropped
          // observations remain unproven; the catalogue and later writes still
          // supply history without inventing an ownership transition.
          if (this.nativeSourceBatch.pendingCount >= 1024) {
            this.droppedSourceEvents++;
            return;
          }
          this.nativeSourceBatch.enqueue(
            JSON.stringify([event.provider, event.path]),
            () => this.handleFileChange(event),
          );
        } else void this.handleFileChange(event);
      } else if (event.type === "session-aborted") {
        this.markOwnWrite(event.sessionId, "abort");
      } else if (event.type === "session-forked") {
        this.markOwnWrite(event.sessionId, "fork");
      }
    });
  }

  private emit(event: BusEvent): void {
    if (!this.controller.signal.aborted) this.eventBus.emit(event);
  }

  /**
   * Check if a session is currently marked as external.
   */
  isExternal(sessionId: string): boolean {
    return this.externalSessions.has(sessionId);
  }

  /**
   * Get info about an external session, or null if not external.
   * Returns the directory-format projectId (for internal use only).
   */
  getExternalSessionInfo(
    sessionId: string,
  ): { lastActivity: Date; dirProjectId: DirProjectId } | null {
    const info = this.externalSessions.get(sessionId);
    if (!info) return null;
    if (!info.dirProjectId) return null;
    return { lastActivity: info.lastActivity, dirProjectId: info.dirProjectId };
  }

  /**
   * Get info about an external session with URL-format projectId.
   * Use this for API responses and events.
   */
  async getExternalSessionInfoWithUrlId(
    sessionId: string,
    options?: { retained?: boolean },
  ): Promise<{ lastActivity: Date; projectId: UrlProjectId } | null> {
    const info = this.externalSessions.get(sessionId);
    if (!info) return null;

    if (info.projectId) {
      return {
        lastActivity: info.lastActivity,
        projectId: info.projectId,
      };
    }

    if (!info.dirProjectId) return null;

    const project = options?.retained
      ? this.scanner.getRetainedProjectBySessionDirSuffix(info.dirProjectId)
      : await this.scanner.getProjectBySessionDirSuffix(info.dirProjectId);
    if (!project) return null;

    return {
      lastActivity: info.lastActivity,
      projectId: project.id as UrlProjectId,
    };
  }

  /**
   * Record that this server itself is writing a session's transcript (the
   * Supervisor aborted its process, or forked it). The session stops being
   * external at once; see `attributeUnownedWrite` for the grace that follows.
   */
  private markOwnWrite(sessionId: string, reason: OwnWriteReason): void {
    this.recentOwnWrites.set(sessionId, { reason, at: Date.now() });
    this.removeExternal(sessionId);
  }

  /** Why this server recently wrote the session, while that grace lasts. */
  private ownWriteReason(sessionId: string): OwnWriteReason | undefined {
    const ownWrite = this.recentOwnWrites.get(sessionId);
    if (!ownWrite) return undefined;

    const graceMs =
      ownWrite.reason === "abort" ? this.abortGraceMs : this.forkGraceMs;
    if (Date.now() - ownWrite.at >= graceMs) {
      this.recentOwnWrites.delete(sessionId);
      return undefined;
    }
    return ownWrite.reason;
  }

  /**
   * Ownership to report for a session we do not run a process for. A session
   * this server just wrote is unowned, not externally driven.
   */
  private detectedOwnership(sessionId: string): SessionOwnership {
    return this.ownWriteReason(sessionId)
      ? { owner: "none" }
      : { owner: "external" };
  }

  /**
   * The one decision for a transcript write no process of ours owns: ignore our
   * abort cleanup, discover our own fork without calling it external, and mark
   * anything else external. Returns whether the session was tracked.
   */
  private attributeUnownedWrite(
    sessionId: string,
    info: {
      provider: FileChangeEvent["provider"];
      dirProjectId?: DirProjectId;
      projectId?: UrlProjectId;
    },
  ): boolean {
    if (this.controller.signal.aborted) return false;
    switch (this.ownWriteReason(sessionId)) {
      case "abort":
        return false;
      case "fork":
        this.enqueueDetectedSummary(sessionId, info);
        return true;
      case undefined:
        this.markExternal(sessionId, info);
        return true;
    }
  }

  /**
   * Get all currently external session IDs.
   */
  getExternalSessions(): string[] {
    return Array.from(this.externalSessions.keys());
  }

  getDiagnostics(): ExternalSessionTrackerDiagnostics {
    return {
      sessionSummaryBatch: this.sessionParser.getDiagnostics(),
      nativeSourceBatch: this.nativeSourceBatch?.getDiagnostics(),
      droppedSourceEvents: this.droppedSourceEvents,
    };
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    this.controller.abort();
    this.nativeSourceBatch?.dispose();
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    // Clear batch processor
    this.sessionParser.dispose();

    // Clear all timeouts
    for (const info of this.externalSessions.values()) {
      clearTimeout(info.timeoutId);
    }
    this.externalSessions.clear();
    this.recentOwnWrites.clear();
  }

  private async loadTrackedSummary(
    sessionId: string,
    projectId: UrlProjectId,
    fidelity: "complete" | "list",
  ): Promise<TrackedSessionSummary | null> {
    if (this.controller.signal.aborted) return null;
    if (fidelity === "list" && this.getSessionListSummary) {
      const summary = await this.getSessionListSummary(sessionId, projectId);
      return summary ? { fidelity: "list", summary } : null;
    }
    if (!this.getSessionSummary) {
      return null;
    }
    const summary = await this.getSessionSummary(sessionId, projectId);
    return summary ? { fidelity: "complete", summary } : null;
  }

  private enqueueTrackedSummary(
    sessionId: string,
    projectId: UrlProjectId,
    fidelity: "complete" | "list",
  ): void {
    if (
      this.controller.signal.aborted ||
      (!this.getSessionSummary && !this.getSessionListSummary)
    ) {
      return;
    }
    this.sessionParser.enqueue(sessionId, () =>
      this.loadTrackedSummary(sessionId, projectId, fidelity),
    );
  }

  private async handleFileChange(event: FileChangeEvent): Promise<void> {
    if (this.controller.signal.aborted) return;
    // Only care about session files
    if (event.fileType !== "session" && event.fileType !== "agent-session") {
      return;
    }

    let publicSession: ObservedPublicSession | null | undefined;
    try {
      publicSession = await this.resolveObservedSession?.(
        event,
        this.controller.signal,
      );
    } catch {
      // An unreadable/conflicting native source is not evidence for a public
      // ownership transition. A later source observation may establish it.
      return;
    }
    if (this.controller.signal.aborted || publicSession === null) return;
    if (publicSession) {
      const { sessionId, projectId, provider } = publicSession;
      const process = this.supervisor.getProcessForSession(sessionId);
      if (process) {
        this.removeExternal(sessionId);
        this.enqueueTrackedSummary(
          sessionId,
          projectId,
          event.provider === "codex" ? "list" : "complete",
        );
      } else if (
        this.attributeUnownedWrite(sessionId, {
          provider: event.provider,
          projectId,
        }) &&
        event.provider === "codex"
      ) {
        await this.ensureCodexSessionCreated(
          sessionId,
          event.path,
          projectId,
          provider,
        );
      }
      return;
    }

    if (event.provider === "codex") {
      await this.handleCodexFileChange(event);
      return;
    }

    if (event.provider === "pi") {
      await this.handlePiFileChange(event);
      return;
    }

    // Parse sessionId and projectId from path
    // Format: projects/<projectId>/<sessionId>.jsonl
    const parsed = this.parseSessionPath(event.relativePath);
    if (!parsed) return;

    const { sessionId, dirProjectId } = parsed;

    // Check if we own this session
    const process = this.supervisor.getProcessForSession(sessionId);
    if (process) {
      // We own it - remove from external tracking if present
      this.removeExternal(sessionId);
      // Claude summaries are complete; preserve their exact event fields.
      this.enqueueTrackedSummary(sessionId, process.projectId, "complete");
      return;
    }

    this.attributeUnownedWrite(sessionId, {
      provider: event.provider,
      dirProjectId,
    });
  }

  private parseSessionPath(
    relativePath: string,
  ): { sessionId: string; dirProjectId: DirProjectId } | null {
    // Expected formats:
    // - projects/<projectId>/<sessionId>.jsonl
    // - projects/<hostname>/<projectId>/<sessionId>.jsonl
    // - <projectId>/<sessionId>.jsonl (when watchDir is already ~/.claude/projects)
    // - <hostname>/<projectId>/<sessionId>.jsonl (same case with hostname)
    const parts = relativePath.split(path.sep).filter(Boolean);
    if (parts.length < 2) return null;

    const startIdx = parts[0] === "projects" ? 1 : 0;
    if (parts.length - startIdx < 2) return null;

    // Find the .jsonl file
    const filename = parts[parts.length - 1];
    if (!filename?.endsWith(".jsonl")) return null;

    // Extract sessionId (filename without .jsonl)
    const sessionId = filename.slice(0, -6); // Remove '.jsonl'

    // Skip agent sessions (they start with 'agent-')
    if (sessionId.startsWith("agent-")) return null;

    // ProjectId is everything between 'projects/' and the filename
    // For: projects/aG9tZS.../.../session.jsonl
    // ProjectId could be single part or multiple parts (hostname + encoded path)
    const projectParts = parts.slice(startIdx, -1);
    if (projectParts.length === 0) return null;

    // Use the first part as projectId (encoded project path)
    // In the hostname case, use hostname/encodedPath format
    const dirProjectId = asDirProjectId(projectParts.join("/"));

    return { sessionId, dirProjectId };
  }

  private async handleCodexFileChange(event: FileChangeEvent): Promise<void> {
    const sessionId = this.extractCodexSessionId(event.relativePath);
    if (!sessionId) return;

    const process = this.supervisor.getProcessForSession(sessionId);
    if (process) {
      this.removeExternal(sessionId);
      // Codex title/recency is bounded; the owned SDK remains authoritative
      // for message count, model, context usage, and recent output.
      this.enqueueTrackedSummary(sessionId, process.projectId, "list");
      return;
    }

    const projectId = await this.readCodexProjectIdFromFile(event.path);
    if (!projectId) return;

    if (
      !this.attributeUnownedWrite(sessionId, {
        provider: event.provider,
        projectId,
      })
    ) {
      return;
    }
    await this.ensureCodexSessionCreated(sessionId, event.path, projectId);
  }

  private extractCodexSessionId(relativePath: string): string | null {
    const filename = relativePath.split(path.sep).pop();
    if (!filename?.endsWith(".jsonl")) return null;
    const base = filename.slice(0, -6);
    const match = base.match(/([0-9a-fA-F-]{36})$/);
    return match?.[1] ?? null;
  }

  private async readCodexProjectIdFromFile(
    filePath: string,
  ): Promise<UrlProjectId | null> {
    const meta = await this.readCodexSessionMeta(filePath);
    if (!meta) return null;
    return encodeProjectId(meta.cwd);
  }

  private async readCodexSessionMeta(
    filePath: string,
  ): Promise<{ cwd: string; timestamp: string; model?: string } | null> {
    try {
      const firstLine = await readFirstLine(filePath);
      if (!firstLine) return null;

      const parsed = JSON.parse(firstLine) as {
        type?: string;
        payload?: { cwd?: string; timestamp?: string; model?: string };
      };
      if (
        parsed.type !== "session_meta" ||
        !parsed.payload?.cwd ||
        !parsed.payload?.timestamp
      ) {
        return null;
      }

      return {
        cwd: parsed.payload.cwd,
        timestamp: parsed.payload.timestamp,
        model: parsed.payload.model,
      };
    } catch {
      return null;
    }
  }

  private async ensureCodexSessionCreated(
    sessionId: string,
    filePath: string,
    projectId: UrlProjectId,
    provider: ProviderName = "codex",
  ): Promise<void> {
    if (this.controller.signal.aborted || this.createdSessions.has(sessionId))
      return;

    const meta = await this.readCodexSessionMeta(filePath);
    if (!meta || this.controller.signal.aborted) return;

    try {
      const stats = await stat(filePath);
      if (this.controller.signal.aborted) return;
      const summary: SessionSummary = {
        id: sessionId,
        projectId,
        projectName: this.projectDisplayName(decodeProjectId(projectId)),
        title: null,
        fullTitle: null,
        createdAt: meta.timestamp,
        updatedAt: new Date(
          getCodexRolloutActivityTimeMs(filePath, stats),
        ).toISOString(),
        messageCount: 0,
        ownership: this.detectedOwnership(sessionId),
        provider,
        model: meta.model,
      };

      const event: SessionCreatedEvent = {
        type: "session-created",
        session: summary,
        timestamp: new Date().toISOString(),
      };
      this.emit(event);
      this.createdSessions.add(sessionId);
    } catch {
      // Ignore failures until next file change
    }
  }

  private async handlePiFileChange(event: FileChangeEvent): Promise<void> {
    const meta = await this.readPiSessionHeader(event.path);
    if (!meta) return;

    const process = this.supervisor.getProcessForSession(meta.id);
    if (process) {
      this.removeExternal(meta.id);
      this.enqueueTrackedSummary(meta.id, process.projectId, "complete");
      return;
    }

    const projectId = encodeProjectId(meta.cwd);
    if (
      !this.attributeUnownedWrite(meta.id, {
        provider: event.provider,
        projectId,
      })
    ) {
      return;
    }
    await this.ensurePiSessionCreated(meta, event.path, projectId);
  }

  private async readPiSessionHeader(filePath: string): Promise<{
    id: string;
    cwd: string;
    timestamp: string;
    model?: string;
  } | null> {
    try {
      const firstLine = await readFirstLine(filePath);
      if (!firstLine) return null;

      const parsed = JSON.parse(firstLine) as {
        type?: string;
        id?: string;
        cwd?: string;
        timestamp?: string;
      };
      if (
        parsed.type !== "session" ||
        !parsed.id ||
        !parsed.cwd ||
        !parsed.timestamp
      ) {
        return null;
      }

      return {
        id: parsed.id,
        cwd: parsed.cwd,
        timestamp: parsed.timestamp,
      };
    } catch {
      return null;
    }
  }

  private async ensurePiSessionCreated(
    meta: { id: string; cwd: string; timestamp: string; model?: string },
    filePath: string,
    projectId: UrlProjectId,
  ): Promise<void> {
    if (this.createdSessions.has(meta.id)) return;

    try {
      const stats = await stat(filePath);
      const summary: SessionSummary = {
        id: meta.id,
        projectId,
        projectName: this.projectDisplayName(meta.cwd),
        title: null,
        fullTitle: null,
        createdAt: meta.timestamp,
        updatedAt: stats.mtime.toISOString(),
        messageCount: 0,
        ownership: this.detectedOwnership(meta.id),
        provider: "pi",
        model: meta.model,
      };

      const event: SessionCreatedEvent = {
        type: "session-created",
        session: summary,
        timestamp: new Date().toISOString(),
      };
      this.emit(event);
      this.createdSessions.add(meta.id);
    } catch {
      // Ignore failures until the next file change.
    }
  }

  private markExternal(
    sessionId: string,
    info: {
      provider: FileChangeEvent["provider"];
      dirProjectId?: DirProjectId;
      projectId?: UrlProjectId;
    },
  ): void {
    if (this.controller.signal.aborted) return;
    const now = new Date();
    const existing = this.externalSessions.get(sessionId);

    if (existing) {
      clearTimeout(existing.timeoutId);
      existing.lastActivity = now;
      existing.projectId = info.projectId;
      existing.dirProjectId = info.dirProjectId;
      existing.provider = info.provider;
      existing.timeoutId = this.createDecayTimeout(sessionId);
      this.enqueueDetectedSummary(sessionId, { ...info });
    } else {
      // New external session
      const externalInfo: ExternalSessionInfo = {
        detectedAt: now,
        lastActivity: now,
        dirProjectId: info.dirProjectId,
        projectId: info.projectId,
        provider: info.provider,
        timeoutId: this.createDecayTimeout(sessionId),
      };
      this.externalSessions.set(sessionId, externalInfo);

      // Queue session parsing - batched to prevent OOM from bulk file operations
      this.enqueueDetectedSummary(sessionId, externalInfo);

      // Emit ownership change event
      void this.emitOwnershipChangeByInfo(sessionId, externalInfo, {
        owner: "external",
      });
    }
  }

  /**
   * Read a detected session's summary off the batch queue. Shared by external
   * detection and by sessions we forked ourselves, which are discovered the
   * same way but never reported as externally owned.
   */
  private enqueueDetectedSummary(
    sessionId: string,
    info: {
      provider: FileChangeEvent["provider"];
      dirProjectId?: DirProjectId;
      projectId?: UrlProjectId;
    },
  ): void {
    if (
      this.controller.signal.aborted ||
      (!this.getSessionSummary && !this.getSessionListSummary)
    )
      return;
    this.sessionParser.enqueue(sessionId, async () => {
      if (this.controller.signal.aborted) return null;
      const project = await this.resolveProjectForSession(info);
      if (!project || this.controller.signal.aborted) return null;
      return this.loadTrackedSummary(
        sessionId,
        project.id as UrlProjectId,
        info.provider === "codex" ? "list" : "complete",
      );
    });
  }

  private removeExternal(sessionId: string): void {
    const existing = this.externalSessions.get(sessionId);
    if (existing) {
      clearTimeout(existing.timeoutId);
      this.externalSessions.delete(sessionId);

      // Emit ownership change event
      void this.emitOwnershipChangeByInfo(sessionId, existing, {
        owner: "none",
      });
    }
  }

  private createDecayTimeout(sessionId: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const info = this.externalSessions.get(sessionId);
      if (info) {
        this.externalSessions.delete(sessionId);
        // Emit ownership change to none
        void this.emitOwnershipChangeByInfo(sessionId, info, { owner: "none" });
      }
    }, this.decayMs);
  }

  private async emitOwnershipChangeByInfo(
    sessionId: string,
    info: ExternalSessionInfo,
    ownership: SessionOwnership,
  ): Promise<void> {
    if (info.projectId) {
      const event: SessionStatusEvent = {
        type: "session-status-changed",
        sessionId,
        projectId: info.projectId,
        ownership,
        timestamp: new Date().toISOString(),
      };
      this.emit(event);
      return;
    }

    if (!info.dirProjectId) return;

    // Convert directory format to URL format for events
    const project = await this.scanner.getProjectBySessionDirSuffix(
      info.dirProjectId,
    );
    if (!project) {
      console.warn(
        `[ExternalSessionTracker] Cannot emit ownership change - project not found: ${info.dirProjectId}`,
      );
      return;
    }

    const event: SessionStatusEvent = {
      type: "session-status-changed",
      sessionId,
      projectId: project.id,
      ownership,
      timestamp: new Date().toISOString(),
    };

    // Emit through EventBus so it gets broadcast via SSE
    this.emit(event);
  }

  private async resolveProjectForSession(info: {
    provider: FileChangeEvent["provider"];
    dirProjectId?: DirProjectId;
    projectId?: UrlProjectId;
  }): Promise<{ id: UrlProjectId } | null> {
    if (info.projectId) {
      return { id: info.projectId };
    }
    if (!info.dirProjectId) return null;
    const project = await this.scanner.getProjectBySessionDirSuffix(
      info.dirProjectId,
    );
    if (!project) {
      console.warn(
        `[ExternalSessionTracker] Cannot emit session-created - project not found: ${info.dirProjectId}`,
      );
      return null;
    }
    return { id: project.id as UrlProjectId };
  }
}
