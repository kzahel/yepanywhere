import { randomUUID } from "node:crypto";
import type { UrlProjectId } from "@claude-anywhere/shared";
import type {
  ClaudeSDK,
  PermissionMode,
  RealClaudeSDKInterface,
  UserMessage,
} from "../sdk/types.js";
import type {
  EventBus,
  ProcessStateEvent,
  ProcessStateType,
  SessionAbortedEvent,
  SessionCreatedEvent,
  SessionStatusEvent,
  WorkerActivityEvent,
} from "../watcher/EventBus.js";
import { Process, type ProcessConstructorOptions } from "./Process.js";
import {
  type QueuedRequest,
  type QueuedRequestInfo,
  type QueuedResponse,
  WorkerQueue,
} from "./WorkerQueue.js";
import {
  DEFAULT_IDLE_PREEMPT_THRESHOLD_MS,
  type ProcessInfo,
  type ProcessOptions,
  type SessionStatus,
  type SessionSummary,
  encodeProjectId,
} from "./types.js";

/**
 * Model and thinking settings for a session.
 */
export interface ModelSettings {
  /** Model to use (e.g., "sonnet", "opus", "haiku"). undefined = use CLI default */
  model?: string;
  /** Max thinking tokens. undefined = thinking disabled */
  maxThinkingTokens?: number;
}

export interface SupervisorOptions {
  /** Legacy SDK interface for mock SDK */
  sdk?: ClaudeSDK;
  /** Real SDK interface with full features */
  realSdk?: RealClaudeSDKInterface;
  idleTimeoutMs?: number;
  /** Default permission mode for new sessions */
  defaultPermissionMode?: PermissionMode;
  /** EventBus for emitting session status changes */
  eventBus?: EventBus;
  /** Maximum concurrent workers. 0 = unlimited (default for backward compat) */
  maxWorkers?: number;
  /** Idle threshold in milliseconds for preemption. Workers idle longer than this can be preempted. */
  idlePreemptThresholdMs?: number;
}

export class Supervisor {
  private processes: Map<string, Process> = new Map();
  private sessionToProcess: Map<string, string> = new Map(); // sessionId -> processId
  private everOwnedSessions: Set<string> = new Set(); // Sessions we've ever owned (for orphan detection)
  private sdk: ClaudeSDK | null;
  private realSdk: RealClaudeSDKInterface | null;
  private idleTimeoutMs?: number;
  private defaultPermissionMode: PermissionMode;
  private eventBus?: EventBus;
  private maxWorkers: number;
  private idlePreemptThresholdMs: number;
  private workerQueue: WorkerQueue;

  constructor(options: SupervisorOptions) {
    this.sdk = options.sdk ?? null;
    this.realSdk = options.realSdk ?? null;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.defaultPermissionMode = options.defaultPermissionMode ?? "default";
    this.eventBus = options.eventBus;
    this.maxWorkers = options.maxWorkers ?? 0; // 0 = unlimited
    this.idlePreemptThresholdMs =
      options.idlePreemptThresholdMs ?? DEFAULT_IDLE_PREEMPT_THRESHOLD_MS;
    this.workerQueue = new WorkerQueue({ eventBus: options.eventBus });

    if (!this.sdk && !this.realSdk) {
      throw new Error("Either sdk or realSdk must be provided");
    }
  }

  async startSession(
    projectPath: string,
    message: UserMessage,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
  ): Promise<Process | QueuedResponse> {
    const projectId = encodeProjectId(projectPath);

    // Check if at capacity
    if (this.isAtCapacity()) {
      // Try to preempt an idle worker
      const preemptable = this.findPreemptableWorker();
      if (preemptable) {
        await this.preemptWorker(preemptable);
        // Fall through to start session normally
      } else {
        // Queue the request
        const { queueId, position } = this.workerQueue.enqueue({
          type: "new-session",
          projectPath,
          projectId,
          message,
          permissionMode,
        });
        return { queued: true, queueId, position };
      }
    }

    // Use real SDK if available
    if (this.realSdk) {
      return this.startRealSession(
        projectPath,
        projectId,
        message,
        undefined,
        permissionMode,
        modelSettings,
      );
    }

    // Fall back to legacy mock SDK
    return this.startLegacySession(
      projectPath,
      projectId,
      message,
      undefined,
      permissionMode,
    );
  }

  /**
   * Create a session without sending an initial message.
   * Used for two-phase flow: create session first, upload files, then send message.
   * The agent will wait for a message to be pushed to the queue.
   */
  async createSession(
    projectPath: string,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
  ): Promise<Process | QueuedResponse> {
    const projectId = encodeProjectId(projectPath);

    // Check if at capacity
    if (this.isAtCapacity()) {
      // Try to preempt an idle worker
      const preemptable = this.findPreemptableWorker();
      if (preemptable) {
        await this.preemptWorker(preemptable);
        // Fall through to create session normally
      } else {
        // Queue the request - use empty message placeholder
        const { queueId, position } = this.workerQueue.enqueue({
          type: "new-session",
          projectPath,
          projectId,
          message: { text: "" }, // Placeholder, will be replaced when first message sent
          permissionMode,
        });
        return { queued: true, queueId, position };
      }
    }

    // Use real SDK if available
    if (this.realSdk) {
      return this.createRealSession(
        projectPath,
        projectId,
        permissionMode,
        modelSettings,
      );
    }

    // Fall back to legacy mock SDK - not supported for create-only
    throw new Error(
      "createSession requires real SDK - legacy mock SDK not supported",
    );
  }

  /**
   * Create a session using the real SDK without an initial message.
   * The session is created and waits for a message to be queued.
   */
  private async createRealSession(
    projectPath: string,
    projectId: UrlProjectId,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
  ): Promise<Process> {
    if (!this.realSdk) {
      throw new Error("realSdk is not available");
    }

    const processHolder: { process: Process | null } = { process: null };
    const effectiveMode = permissionMode ?? this.defaultPermissionMode;

    // Start session WITHOUT an initial message - agent will wait
    const result = await this.realSdk.startSession({
      cwd: projectPath,
      // No initialMessage - queue will block until one is pushed
      permissionMode: effectiveMode,
      model: modelSettings?.model,
      maxThinkingTokens: modelSettings?.maxThinkingTokens,
      onToolApproval: async (toolName, input, opts) => {
        if (!processHolder.process) {
          return { behavior: "deny", message: "Process not ready" };
        }
        return processHolder.process.handleToolApproval(toolName, input, opts);
      },
    });

    const { iterator, queue, abort } = result;

    const tempSessionId = randomUUID();
    const options: ProcessConstructorOptions = {
      projectPath,
      projectId,
      sessionId: tempSessionId,
      idleTimeoutMs: this.idleTimeoutMs,
      queue,
      abortFn: abort,
      permissionMode: effectiveMode,
    };

    const process = new Process(iterator, options);
    processHolder.process = process;

    // Wait for the real session ID from the SDK
    await process.waitForSessionId();

    // Register as a new session
    this.registerProcess(process, true);

    return process;
  }

  /**
   * Start a session using the real SDK with full features.
   */
  private async startRealSession(
    projectPath: string,
    projectId: UrlProjectId,
    message: UserMessage,
    resumeSessionId?: string,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
  ): Promise<Process> {
    // Create a placeholder process first (needed for tool approval callback)
    const tempSessionId = resumeSessionId ?? randomUUID();

    // realSdk is guaranteed to exist here (checked in startSession)
    if (!this.realSdk) {
      throw new Error("realSdk is not available");
    }

    // We need to reference process in the callback before it's assigned
    // Using a holder object allows us to set the reference later
    const processHolder: { process: Process | null } = { process: null };

    // Use provided mode or fall back to default
    const effectiveMode = permissionMode ?? this.defaultPermissionMode;

    // Generate UUID for the initial message so SDK and SSE use the same ID.
    // This ensures the client can match the SSE replay to its temp message,
    // and prevents duplicates when JSONL is later fetched.
    const messageUuid = randomUUID();
    const messageWithUuid: UserMessage = { ...message, uuid: messageUuid };

    const result = await this.realSdk.startSession({
      cwd: projectPath,
      initialMessage: messageWithUuid,
      resumeSessionId,
      permissionMode: effectiveMode,
      model: modelSettings?.model,
      maxThinkingTokens: modelSettings?.maxThinkingTokens,
      onToolApproval: async (toolName, input, opts) => {
        // Delegate to the process's handleToolApproval
        if (!processHolder.process) {
          return { behavior: "deny", message: "Process not ready" };
        }
        return processHolder.process.handleToolApproval(toolName, input, opts);
      },
    });

    const { iterator, queue, abort } = result;

    const options: ProcessConstructorOptions = {
      projectPath,
      projectId,
      sessionId: tempSessionId,
      idleTimeoutMs: this.idleTimeoutMs,
      queue,
      abortFn: abort,
      permissionMode: effectiveMode,
    };

    const process = new Process(iterator, options);
    processHolder.process = process;

    // Add the initial user message to history with the same UUID we passed to SDK.
    // This ensures SSE replay includes the user message so the client can replace
    // its temp message. The SDK also writes to JSONL with this UUID, so both SSE
    // and JSONL will have matching IDs (no duplicates).
    process.addInitialUserMessage(message.text, messageUuid);

    // Wait for the real session ID from the SDK before registering
    // This ensures the client gets the correct ID to use for persistence
    if (!resumeSessionId) {
      await process.waitForSessionId();
    }

    this.registerProcess(process, !resumeSessionId);

    return process;
  }

  /**
   * Start a session using the legacy mock SDK.
   */
  private startLegacySession(
    projectPath: string,
    projectId: UrlProjectId,
    message: UserMessage,
    resumeSessionId?: string,
    permissionMode?: PermissionMode,
  ): Process {
    // sdk is guaranteed to exist here (checked in startSession)
    if (!this.sdk) {
      throw new Error("sdk is not available");
    }
    const iterator = this.sdk.startSession({
      cwd: projectPath,
      resume: resumeSessionId,
    });

    const sessionId = resumeSessionId ?? randomUUID();

    // Use provided mode or fall back to default
    const effectiveMode = permissionMode ?? this.defaultPermissionMode;

    const options: ProcessOptions = {
      projectPath,
      projectId,
      sessionId,
      idleTimeoutMs: this.idleTimeoutMs,
      permissionMode: effectiveMode,
    };

    const process = new Process(iterator, options);

    this.registerProcess(process, !resumeSessionId);

    // Queue the initial message
    process.queueMessage(message);

    return process;
  }

  async resumeSession(
    sessionId: string,
    projectPath: string,
    message: UserMessage,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
  ): Promise<Process | QueuedResponse> {
    // Check if already have a process for this session
    const existingProcessId = this.sessionToProcess.get(sessionId);
    if (existingProcessId) {
      const existingProcess = this.processes.get(existingProcessId);
      if (existingProcess) {
        // Check if process is terminated - if so, start a fresh one
        if (existingProcess.isTerminated) {
          this.unregisterProcess(existingProcess);
        } else {
          // Update permission mode if specified
          if (permissionMode) {
            existingProcess.setPermissionMode(permissionMode);
          }
          // Queue message to existing process
          const result = existingProcess.queueMessage(message);
          if (result.success) {
            return existingProcess;
          }
          // Failed to queue - process likely terminated, clean up and start fresh
          this.unregisterProcess(existingProcess);
        }
      }
    }

    // Check if there's already a queued request for this session
    const existingQueued = this.workerQueue.findBySessionId(sessionId);
    if (existingQueued) {
      // Already queued - return current position
      const position = this.workerQueue.getPosition(existingQueued.id);
      return {
        queued: true,
        queueId: existingQueued.id,
        position: position ?? 1,
      };
    }

    const projectId = encodeProjectId(projectPath);

    // Check if at capacity
    if (this.isAtCapacity()) {
      // Try to preempt an idle worker
      const preemptable = this.findPreemptableWorker();
      if (preemptable) {
        await this.preemptWorker(preemptable);
        // Fall through to start session normally
      } else {
        // Queue the request
        const { queueId, position } = this.workerQueue.enqueue({
          type: "resume-session",
          projectPath,
          projectId,
          sessionId,
          message,
          permissionMode,
        });
        return { queued: true, queueId, position };
      }
    }

    // Use real SDK if available
    if (this.realSdk) {
      return this.startRealSession(
        projectPath,
        projectId,
        message,
        sessionId,
        permissionMode,
        modelSettings,
      );
    }

    // Fall back to legacy mock SDK
    return this.startLegacySession(
      projectPath,
      projectId,
      message,
      sessionId,
      permissionMode,
    );
  }

  getProcess(processId: string): Process | undefined {
    return this.processes.get(processId);
  }

  getProcessForSession(sessionId: string): Process | undefined {
    const processId = this.sessionToProcess.get(sessionId);
    if (!processId) return undefined;
    return this.processes.get(processId);
  }

  getAllProcesses(): Process[] {
    return Array.from(this.processes.values());
  }

  getProcessInfoList(): ProcessInfo[] {
    return this.getAllProcesses().map((p) => p.getInfo());
  }

  /**
   * Check if a session was ever owned by this server instance.
   * Used to determine if orphaned tool detection should be trusted.
   * For sessions we never owned (external), we can't know if tools were interrupted.
   */
  wasEverOwned(sessionId: string): boolean {
    return this.everOwnedSessions.has(sessionId);
  }

  async abortProcess(processId: string): Promise<boolean> {
    const process = this.processes.get(processId);
    if (!process) return false;

    // Emit session-aborted event BEFORE aborting, so ExternalSessionTracker
    // can set up the grace period before any file changes arrive
    this.emitSessionAborted(process.sessionId, process.projectId);

    await process.abort();
    this.unregisterProcess(process);
    return true;
  }

  private emitSessionAborted(sessionId: string, projectId: UrlProjectId): void {
    if (!this.eventBus) return;

    const event: SessionAbortedEvent = {
      type: "session-aborted",
      sessionId,
      projectId,
      timestamp: new Date().toISOString(),
    };
    this.eventBus.emit(event);
  }

  private registerProcess(process: Process, isNewSession: boolean): void {
    this.processes.set(process.id, process);
    this.sessionToProcess.set(process.sessionId, process.id);
    this.everOwnedSessions.add(process.sessionId);

    const status: SessionStatus = {
      state: "owned",
      processId: process.id,
      permissionMode: process.permissionMode,
      modeVersion: process.modeVersion,
    };

    // Emit session created event for new sessions
    if (isNewSession) {
      this.emitSessionCreated(process, status);
    }

    // Emit status change event
    this.emitStatusChange(process.sessionId, process.projectId, status);

    // Emit initial process state (process starts in running state)
    const initialState = process.state.type;
    if (initialState === "running" || initialState === "waiting-input") {
      this.emitProcessStateChange(
        process.sessionId,
        process.projectId,
        initialState,
      );
    }

    // Emit worker activity after registering (new worker added)
    this.emitWorkerActivity();

    // Listen for completion to auto-cleanup, and state changes for process state events
    process.subscribe((event) => {
      if (event.type === "complete") {
        this.unregisterProcess(process);
      } else if (event.type === "state-change") {
        // Emit process state change for running/waiting-input states
        if (
          event.state.type === "running" ||
          event.state.type === "waiting-input"
        ) {
          this.emitProcessStateChange(
            process.sessionId,
            process.projectId,
            event.state.type,
          );
        }
        // Emit worker activity on any state change (affects hasActiveWork)
        this.emitWorkerActivity();
      }
    });
  }

  private unregisterProcess(process: Process): void {
    this.processes.delete(process.id);
    this.sessionToProcess.delete(process.sessionId);

    // Emit status change event (back to idle)
    this.emitStatusChange(process.sessionId, process.projectId, {
      state: "idle",
    });

    // Emit worker activity after unregistering (worker removed)
    this.emitWorkerActivity();

    // Process queue when a worker becomes available
    void this.processQueue();
  }

  private emitStatusChange(
    sessionId: string,
    projectId: UrlProjectId,
    status: SessionStatus,
  ): void {
    if (!this.eventBus) return;

    const event: SessionStatusEvent = {
      type: "session-status-changed",
      sessionId,
      projectId,
      status,
      timestamp: new Date().toISOString(),
    };
    this.eventBus.emit(event);
  }

  private emitSessionCreated(process: Process, status: SessionStatus): void {
    if (!this.eventBus) return;

    const now = new Date().toISOString();
    const session: SessionSummary = {
      id: process.sessionId,
      projectId: process.projectId,
      title: null, // Title comes from first user message, populated later via file change
      fullTitle: null,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      status,
    };

    const event: SessionCreatedEvent = {
      type: "session-created",
      session,
      timestamp: now,
    };
    this.eventBus.emit(event);
  }

  private emitProcessStateChange(
    sessionId: string,
    projectId: UrlProjectId,
    processState: ProcessStateType,
  ): void {
    if (!this.eventBus) return;

    const event: ProcessStateEvent = {
      type: "process-state-changed",
      sessionId,
      projectId,
      processState,
      timestamp: new Date().toISOString(),
    };
    this.eventBus.emit(event);
  }

  /**
   * Emit worker activity event for safe restart indicator.
   * Called when workers are added, removed, or change state.
   */
  private emitWorkerActivity(): void {
    if (!this.eventBus) return;

    const hasActiveWork = Array.from(this.processes.values()).some(
      (p) => p.state.type === "running" || p.state.type === "waiting-input",
    );

    const event: WorkerActivityEvent = {
      type: "worker-activity-changed",
      activeWorkers: this.processes.size,
      queueLength: this.workerQueue.length,
      hasActiveWork,
      timestamp: new Date().toISOString(),
    };
    this.eventBus.emit(event);
  }

  // ============ Worker Pool Methods ============

  /**
   * Check if we're at worker capacity.
   */
  private isAtCapacity(): boolean {
    if (this.maxWorkers <= 0) return false; // 0 = unlimited
    return this.processes.size >= this.maxWorkers;
  }

  /**
   * Find a preemptable worker (idle longer than threshold).
   * Returns the worker that has been idle longest.
   * Does not preempt workers waiting for input.
   */
  private findPreemptableWorker(): Process | undefined {
    let oldest: Process | undefined;
    let oldestIdleTime = 0;
    const now = Date.now();

    for (const process of this.processes.values()) {
      // Only preempt idle processes, not waiting-input
      if (process.state.type !== "idle") continue;

      const idleMs = now - process.state.since.getTime();
      if (idleMs >= this.idlePreemptThresholdMs && idleMs > oldestIdleTime) {
        oldest = process;
        oldestIdleTime = idleMs;
      }
    }

    return oldest;
  }

  /**
   * Preempt an idle worker to make room for a new request.
   */
  private async preemptWorker(process: Process): Promise<void> {
    await process.abort();
    this.unregisterProcess(process);
  }

  /**
   * Process the queue - called when a worker becomes available.
   */
  private async processQueue(): Promise<void> {
    while (!this.workerQueue.isEmpty && !this.isAtCapacity()) {
      const request = this.workerQueue.dequeue();
      if (!request) break;

      try {
        let process: Process;

        if (request.type === "new-session") {
          const result = await this.startSessionInternal(
            request.projectPath,
            request.projectId,
            request.message,
            undefined,
            request.permissionMode,
          );
          process = result;
        } else {
          const result = await this.startSessionInternal(
            request.projectPath,
            request.projectId,
            request.message,
            request.sessionId,
            request.permissionMode,
          );
          process = result;
        }

        // Emit queue removed event
        this.eventBus?.emit({
          type: "queue-request-removed",
          queueId: request.id,
          sessionId: request.sessionId,
          reason: "started",
          timestamp: new Date().toISOString(),
        });

        request.resolve({ status: "started", processId: process.id });
      } catch (error) {
        // On error, resolve with cancelled status
        request.resolve({
          status: "cancelled",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Internal session start that always starts immediately.
   * Used by queue processing.
   */
  private async startSessionInternal(
    projectPath: string,
    projectId: UrlProjectId,
    message: UserMessage,
    resumeSessionId?: string,
    permissionMode?: PermissionMode,
  ): Promise<Process> {
    // Use real SDK if available
    if (this.realSdk) {
      return this.startRealSession(
        projectPath,
        projectId,
        message,
        resumeSessionId,
        permissionMode,
      );
    }

    // Fall back to legacy mock SDK
    return this.startLegacySession(
      projectPath,
      projectId,
      message,
      resumeSessionId,
      permissionMode,
    );
  }

  // ============ Public Queue Methods ============

  /**
   * Cancel a queued request.
   * @returns true if cancelled, false if not found
   */
  cancelQueuedRequest(queueId: string): boolean {
    return this.workerQueue.cancel(queueId);
  }

  /**
   * Get info about all queued requests.
   */
  getQueueInfo(): QueuedRequestInfo[] {
    return this.workerQueue.getQueueInfo();
  }

  /**
   * Get position for a specific queue entry.
   */
  getQueuePosition(queueId: string): number | undefined {
    return this.workerQueue.getPosition(queueId);
  }

  /**
   * Get current worker count and capacity info.
   */
  getWorkerPoolStatus(): {
    activeWorkers: number;
    maxWorkers: number;
    queueLength: number;
  } {
    return {
      activeWorkers: this.processes.size,
      maxWorkers: this.maxWorkers,
      queueLength: this.workerQueue.length,
    };
  }

  /**
   * Get worker activity status for safe restart indicator.
   * Returns whether any workers are actively processing or waiting for input.
   */
  getWorkerActivity(): {
    activeWorkers: number;
    queueLength: number;
    hasActiveWork: boolean;
  } {
    const hasActiveWork = Array.from(this.processes.values()).some(
      (p) => p.state.type === "running" || p.state.type === "waiting-input",
    );
    return {
      activeWorkers: this.processes.size,
      queueLength: this.workerQueue.length,
      hasActiveWork,
    };
  }
}
