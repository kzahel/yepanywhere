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
  SessionCreatedEvent,
  SessionStatusEvent,
} from "../watcher/EventBus.js";
import { Process, type ProcessConstructorOptions } from "./Process.js";
import type {
  ProcessInfo,
  ProcessOptions,
  SessionStatus,
  SessionSummary,
} from "./types.js";
import { encodeProjectId } from "./types.js";

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

  constructor(options: SupervisorOptions) {
    this.sdk = options.sdk ?? null;
    this.realSdk = options.realSdk ?? null;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.defaultPermissionMode = options.defaultPermissionMode ?? "default";
    this.eventBus = options.eventBus;

    if (!this.sdk && !this.realSdk) {
      throw new Error("Either sdk or realSdk must be provided");
    }
  }

  async startSession(
    projectPath: string,
    message: UserMessage,
    permissionMode?: PermissionMode,
  ): Promise<Process> {
    const projectId = encodeProjectId(projectPath);

    // Use real SDK if available
    if (this.realSdk) {
      return this.startRealSession(
        projectPath,
        projectId,
        message,
        undefined,
        permissionMode,
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
   * Start a session using the real SDK with full features.
   */
  private async startRealSession(
    projectPath: string,
    projectId: UrlProjectId,
    message: UserMessage,
    resumeSessionId?: string,
    permissionMode?: PermissionMode,
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
  ): Promise<Process> {
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

    const projectId = encodeProjectId(projectPath);

    // Use real SDK if available
    if (this.realSdk) {
      return this.startRealSession(
        projectPath,
        projectId,
        message,
        sessionId,
        permissionMode,
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

    await process.abort();
    this.unregisterProcess(process);
    return true;
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
}
