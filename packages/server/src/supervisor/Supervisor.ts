import { randomUUID } from "node:crypto";
import type {
  ClaudeSDK,
  PermissionMode,
  RealClaudeSDKInterface,
  UserMessage,
} from "../sdk/types.js";
import { Process, type ProcessConstructorOptions } from "./Process.js";
import type { ProcessInfo, ProcessOptions } from "./types.js";
import { encodeProjectId } from "./types.js";

export interface SupervisorOptions {
  /** Legacy SDK interface for mock SDK */
  sdk?: ClaudeSDK;
  /** Real SDK interface with full features */
  realSdk?: RealClaudeSDKInterface;
  idleTimeoutMs?: number;
  /** Default permission mode for new sessions */
  defaultPermissionMode?: PermissionMode;
}

export class Supervisor {
  private processes: Map<string, Process> = new Map();
  private sessionToProcess: Map<string, string> = new Map(); // sessionId -> processId
  private sdk: ClaudeSDK | null;
  private realSdk: RealClaudeSDKInterface | null;
  private idleTimeoutMs?: number;
  private defaultPermissionMode: PermissionMode;

  constructor(options: SupervisorOptions) {
    this.sdk = options.sdk ?? null;
    this.realSdk = options.realSdk ?? null;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.defaultPermissionMode = options.defaultPermissionMode ?? "default";

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
    projectId: string,
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

    const result = await this.realSdk.startSession({
      cwd: projectPath,
      initialMessage: message,
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

    // Wait for the real session ID from the SDK before registering
    // This ensures the client gets the correct ID to use for persistence
    if (!resumeSessionId) {
      await process.waitForSessionId();
    }

    this.registerProcess(process);

    return process;
  }

  /**
   * Start a session using the legacy mock SDK.
   */
  private startLegacySession(
    projectPath: string,
    projectId: string,
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

    this.registerProcess(process);

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
        // Update permission mode if specified
        if (permissionMode) {
          existingProcess.setPermissionMode(permissionMode);
        }
        // Queue message to existing process
        existingProcess.queueMessage(message);
        return existingProcess;
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

  async abortProcess(processId: string): Promise<boolean> {
    const process = this.processes.get(processId);
    if (!process) return false;

    await process.abort();
    this.unregisterProcess(process);
    return true;
  }

  private registerProcess(process: Process): void {
    this.processes.set(process.id, process);
    this.sessionToProcess.set(process.sessionId, process.id);

    // Listen for completion to auto-cleanup
    process.subscribe((event) => {
      if (event.type === "complete") {
        this.unregisterProcess(process);
      }
    });
  }

  private unregisterProcess(process: Process): void {
    this.processes.delete(process.id);
    this.sessionToProcess.delete(process.sessionId);
  }
}
