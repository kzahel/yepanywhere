import { randomUUID } from "node:crypto";
import type { MessageQueue } from "../sdk/messageQueue.js";
import type {
  PermissionMode,
  SDKMessage,
  ToolApprovalResult,
  UserMessage,
} from "../sdk/types.js";
import type {
  InputRequest,
  ProcessEvent,
  ProcessInfo,
  ProcessOptions,
  ProcessState,
  ProcessStateType,
} from "./types.js";
import { DEFAULT_IDLE_TIMEOUT_MS } from "./types.js";

type Listener = (event: ProcessEvent) => void;

/**
 * Pending tool approval request.
 * The SDK's canUseTool callback creates this and waits for respondToInput.
 */
interface PendingToolApproval {
  request: InputRequest;
  resolve: (result: ToolApprovalResult) => void;
}

export interface ProcessConstructorOptions extends ProcessOptions {
  /** MessageQueue for real SDK, undefined for mock SDK */
  queue?: MessageQueue;
  /** Abort function from real SDK */
  abortFn?: () => void;
}

export class Process {
  readonly id: string;
  private _sessionId: string;
  readonly projectPath: string;
  readonly projectId: string;
  readonly startedAt: Date;

  private legacyQueue: UserMessage[] = [];
  private messageQueue: MessageQueue | null;
  private abortFn: (() => void) | null;
  private _state: ProcessState = { type: "running" };
  private listeners: Set<Listener> = new Set();
  private idleTimer: NodeJS.Timeout | null = null;
  private idleTimeoutMs: number;
  private iteratorDone = false;

  /** In-memory message history for mock SDK (real SDK persists to disk) */
  private messageHistory: SDKMessage[] = [];

  /** Pending tool approval request (from canUseTool callback) */
  private pendingToolApproval: PendingToolApproval | null = null;

  /** Current permission mode for tool approvals */
  private _permissionMode: PermissionMode = "default";

  /** Version counter for permission mode changes (for multi-tab sync) */
  private _modeVersion = 0;

  /** Resolvers waiting for the real session ID */
  private sessionIdResolvers: Array<(id: string) => void> = [];
  private sessionIdResolved = false;

  constructor(
    private sdkIterator: AsyncIterator<SDKMessage>,
    options: ProcessConstructorOptions,
  ) {
    this.id = randomUUID();
    this._sessionId = options.sessionId;
    this.projectPath = options.projectPath;
    this.projectId = options.projectId;
    this.startedAt = new Date();
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

    // Real SDK provides these, mock SDK doesn't
    this.messageQueue = options.queue ?? null;
    this.abortFn = options.abortFn ?? null;
    this._permissionMode = options.permissionMode ?? "default";

    // Start processing messages from the SDK
    this.processMessages();
  }

  get sessionId(): string {
    return this._sessionId;
  }

  get state(): ProcessState {
    return this._state;
  }

  get queueDepth(): number {
    if (this.messageQueue) {
      return this.messageQueue.depth;
    }
    return this.legacyQueue.length;
  }

  get permissionMode(): PermissionMode {
    return this._permissionMode;
  }

  get modeVersion(): number {
    return this._modeVersion;
  }

  /**
   * Whether the process has been terminated (either manually or due to error).
   * A terminated process cannot accept new messages.
   */
  get isTerminated(): boolean {
    return this._state.type === "terminated";
  }

  /**
   * Get the termination reason if the process was terminated.
   */
  get terminationReason(): string | null {
    if (this._state.type === "terminated") {
      return this._state.reason;
    }
    return null;
  }

  /**
   * Update the permission mode for this process.
   * Increments modeVersion and emits a mode-change event for multi-tab sync.
   */
  setPermissionMode(mode: PermissionMode): void {
    this._permissionMode = mode;
    this._modeVersion++;
    this.emit({ type: "mode-change", mode, version: this._modeVersion });
  }

  /**
   * Mark the process as terminated due to an error or external termination.
   * Emits a terminated event and cleans up resources.
   */
  private markTerminated(reason: string, error?: Error): void {
    if (this._state.type === "terminated") {
      return; // Already terminated
    }

    this.clearIdleTimer();
    this.iteratorDone = true;

    // Resolve any pending tool approval with denial
    if (this.pendingToolApproval) {
      this.pendingToolApproval.resolve({
        behavior: "deny",
        message: `Process terminated: ${reason}`,
      });
      this.pendingToolApproval = null;
    }

    this.setState({ type: "terminated", reason, error });
    this.emit({ type: "terminated", reason, error });
    this.emit({ type: "complete" });
  }

  /**
   * Wait for the real session ID from the SDK's init message.
   * Returns immediately if already received, or waits with a timeout.
   */
  waitForSessionId(timeoutMs = 5000): Promise<string> {
    if (this.sessionIdResolved) {
      return Promise.resolve(this._sessionId);
    }

    return new Promise((resolve) => {
      this.sessionIdResolvers.push(resolve);

      // Timeout fallback - resolve with current ID even if not updated
      setTimeout(() => {
        const index = this.sessionIdResolvers.indexOf(resolve);
        if (index >= 0) {
          this.sessionIdResolvers.splice(index, 1);
          resolve(this._sessionId);
        }
      }, timeoutMs);
    });
  }

  getInfo(): ProcessInfo {
    let stateType: ProcessStateType;
    if (this._state.type === "terminated") {
      stateType = "terminated";
    } else if (this._state.type === "waiting-input") {
      stateType = "waiting-input";
    } else if (this._state.type === "idle") {
      stateType = "idle";
    } else {
      stateType = "running";
    }

    return {
      id: this.id,
      sessionId: this._sessionId,
      projectId: this.projectId,
      projectPath: this.projectPath,
      state: stateType,
      startedAt: this.startedAt.toISOString(),
      queueDepth: this.queueDepth,
    };
  }

  /**
   * Get the in-memory message history.
   * Used by mock SDK sessions where messages aren't persisted to disk.
   */
  getMessageHistory(): SDKMessage[] {
    return [...this.messageHistory];
  }

  /**
   * Add initial user message to history without queuing to SDK.
   * Used for real SDK sessions where the initial message is passed directly
   * to the SDK but needs to be in history for SSE replay to late-joining clients.
   */
  addInitialUserMessage(text: string): void {
    const uuid = randomUUID();
    const sdkMessage = {
      type: "user",
      uuid,
      message: { role: "user", content: text },
    } as SDKMessage;

    this.messageHistory.push(sdkMessage);
    this.emit({ type: "message", message: sdkMessage });
  }

  /**
   * Queue a message to be sent to the SDK.
   * For real SDK, pushes to MessageQueue.
   * For mock SDK, uses legacy queue behavior.
   *
   * @returns Object with success status and queue position or error
   */
  queueMessage(message: UserMessage): {
    success: boolean;
    position?: number;
    error?: string;
  } {
    // Check if process is terminated
    if (this._state.type === "terminated") {
      return {
        success: false,
        error: `Process terminated: ${this._state.reason}`,
      };
    }

    // Create user message with UUID - this UUID will be used by both SSE and SDK
    const uuid = randomUUID();
    const messageWithUuid: UserMessage = { ...message, uuid };

    const sdkMessage = {
      type: "user",
      uuid,
      message: { role: "user", content: message.text },
    } as SDKMessage;

    // Only add to history for mock SDK (real SDK persists to disk, and clients
    // load from disk via API - adding here would cause duplicate messages when
    // SSE replays to late-joining clients who already loaded from disk)
    if (!this.messageQueue) {
      this.messageHistory.push(sdkMessage);
    }

    // Emit to current SSE subscribers so other clients see it immediately
    this.emit({ type: "message", message: sdkMessage });

    if (this.messageQueue) {
      // Transition to running if we were idle
      if (this._state.type === "idle") {
        this.clearIdleTimer();
        this.setState({ type: "running" });
      }
      // Pass message with UUID so SDK uses the same UUID we emitted via SSE
      const position = this.messageQueue.push(messageWithUuid);
      return { success: true, position };
    }

    // Legacy behavior for mock SDK
    this.legacyQueue.push(message);
    if (this._state.type === "idle") {
      this.processNextInQueue();
    }
    return { success: true, position: this.legacyQueue.length };
  }

  /**
   * Handle tool approval request from SDK's canUseTool callback.
   * This is called by the Supervisor when creating the session.
   * Behavior depends on current permission mode:
   * - default: Ask user for approval
   * - acceptEdits: Auto-approve Edit/Write tools, ask for others
   * - plan: Deny all tools (planning only)
   * - bypassPermissions: Auto-approve all tools
   */
  async handleToolApproval(
    toolName: string,
    input: unknown,
    options: { signal: AbortSignal },
  ): Promise<ToolApprovalResult> {
    // Check if aborted
    if (options.signal.aborted) {
      return { behavior: "deny", message: "Operation aborted" };
    }

    // Handle based on permission mode
    switch (this._permissionMode) {
      case "bypassPermissions":
        // Auto-approve all tools
        return { behavior: "allow" };

      case "plan":
        // Deny all tools - planning only
        return { behavior: "deny", message: "Plan mode - tools not executed" };

      case "acceptEdits": {
        // Auto-approve file editing tools, ask for others
        const editTools = ["Edit", "Write", "NotebookEdit"];
        if (editTools.includes(toolName)) {
          return { behavior: "allow" };
        }
        // Fall through to ask user for non-edit tools
        break;
      }

      default:
        // Fall through to ask user
        break;
    }

    // Default behavior: ask user for approval
    const request: InputRequest = {
      id: randomUUID(),
      sessionId: this._sessionId,
      type: "tool-approval",
      prompt: `Allow ${toolName}?`,
      toolName,
      toolInput: input,
      timestamp: new Date().toISOString(),
    };

    // Transition to waiting-input state
    this.setState({ type: "waiting-input", request });

    // Create a promise that will be resolved by respondToInput
    return new Promise<ToolApprovalResult>((resolve) => {
      this.pendingToolApproval = { request, resolve };

      // Handle abort signal
      const onAbort = () => {
        if (this.pendingToolApproval?.request.id === request.id) {
          this.pendingToolApproval = null;
          this.setState({ type: "running" });
          resolve({ behavior: "deny", message: "Operation aborted" });
        }
      };

      options.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Respond to a pending input request (tool approval).
   * Called from the API when user approves/denies a tool.
   */
  respondToInput(requestId: string, response: "approve" | "deny"): boolean {
    if (!this.pendingToolApproval) {
      return false;
    }

    if (this.pendingToolApproval.request.id !== requestId) {
      return false;
    }

    const result: ToolApprovalResult = {
      behavior: response === "approve" ? "allow" : "deny",
      message: response === "deny" ? "User denied permission" : undefined,
    };

    this.pendingToolApproval.resolve(result);
    this.pendingToolApproval = null;

    // Transition back to running state
    this.setState({ type: "running" });

    return true;
  }

  /**
   * Get the pending input request, if any.
   */
  getPendingInputRequest(): InputRequest | null {
    return this.pendingToolApproval?.request ?? null;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async abort(): Promise<void> {
    this.clearIdleTimer();

    // Call the SDK's abort function if available
    if (this.abortFn) {
      this.abortFn();
    }

    // Signal completion to subscribers
    this.emit({ type: "complete" });
    this.listeners.clear();
  }

  private async processMessages(): Promise<void> {
    try {
      while (!this.iteratorDone) {
        const result = await this.sdkIterator.next();

        if (result.done) {
          this.iteratorDone = true;
          // Don't transition to idle if we're waiting for input
          if (this._state.type !== "waiting-input") {
            this.transitionToIdle();
          }
          break;
        }

        const message = result.value;

        // Store message in history (for mock SDK that doesn't persist to disk)
        this.messageHistory.push(message);

        // Extract session ID from init message
        if (
          message.type === "system" &&
          message.subtype === "init" &&
          message.session_id
        ) {
          this._sessionId = message.session_id;
          this.sessionIdResolved = true;
          // Resolve any waiters
          for (const resolve of this.sessionIdResolvers) {
            resolve(this._sessionId);
          }
          this.sessionIdResolvers = [];
        }

        this.emit({ type: "message", message });

        // Handle special message types
        if (message.type === "system" && message.subtype === "input_request") {
          // Legacy mock SDK behavior - handle input_request message
          this.handleInputRequest(message);
        } else if (message.type === "result") {
          this.transitionToIdle();
        }
      }
    } catch (error) {
      const err = error as Error;
      this.emit({ type: "error", error: err });

      // Detect process termination errors
      if (this.isProcessTerminationError(err)) {
        this.markTerminated("underlying process terminated", err);
        return;
      }

      // Don't transition to idle if we're waiting for input
      if (this._state.type !== "waiting-input") {
        this.transitionToIdle();
      }
    }
  }

  /**
   * Check if an error indicates the underlying Claude process was terminated.
   */
  private isProcessTerminationError(error: Error): boolean {
    const message = error.message || "";
    return (
      message.includes("ProcessTransport is not ready") ||
      message.includes("not ready for writing") ||
      message.includes("process exited") ||
      message.includes("SIGTERM") ||
      message.includes("SIGKILL") ||
      message.includes("spawn ENOENT")
    );
  }

  /**
   * Handle input_request message from mock SDK.
   * Real SDK uses canUseTool callback instead.
   */
  private handleInputRequest(message: SDKMessage): void {
    if (!message.input_request) return;

    const request: InputRequest = {
      id: message.input_request.id,
      sessionId: this._sessionId,
      type: message.input_request.type as InputRequest["type"],
      prompt: message.input_request.prompt,
      options: message.input_request.options,
      timestamp: new Date().toISOString(),
    };

    this.setState({ type: "waiting-input", request });
  }

  private transitionToIdle(): void {
    this.clearIdleTimer();
    this.setState({ type: "idle", since: new Date() });
    this.startIdleTimer();
    this.processNextInQueue();
  }

  /**
   * Process next message in legacy queue (for mock SDK).
   */
  private processNextInQueue(): void {
    if (this.legacyQueue.length === 0) return;

    const nextMessage = this.legacyQueue.shift();
    if (nextMessage) {
      // In real implementation with MessageQueue, this happens automatically
      // For mock SDK, we just transition back to running
      this.setState({ type: "running" });
    }
  }

  private startIdleTimer(): void {
    this.idleTimer = setTimeout(() => {
      // Emit completion - Supervisor will clean up
      this.emit({ type: "complete" });
    }, this.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private setState(state: ProcessState): void {
    this._state = state;
    this.emit({ type: "state-change", state });
  }

  private emit(event: ProcessEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Ignore listener errors
      }
    }
  }
}
