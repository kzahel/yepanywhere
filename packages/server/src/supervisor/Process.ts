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

  /** Pending tool approval request (from canUseTool callback) */
  private pendingToolApproval: PendingToolApproval | null = null;

  /** Current permission mode for tool approvals */
  private _permissionMode: PermissionMode = "default";

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

  /**
   * Update the permission mode for this process.
   * Affects how subsequent tool approvals are handled.
   */
  setPermissionMode(mode: PermissionMode): void {
    this._permissionMode = mode;
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
    if (this._state.type === "waiting-input") {
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
   * Queue a message to be sent to the SDK.
   * For real SDK, pushes to MessageQueue.
   * For mock SDK, uses legacy queue behavior.
   */
  queueMessage(message: UserMessage): number {
    // Emit user message to SSE subscribers so other clients see it immediately
    const uuid = randomUUID();
    this.emit({
      type: "message",
      message: {
        type: "user",
        uuid,
        message: { role: "user", content: message.text },
      },
    });

    if (this.messageQueue) {
      return this.messageQueue.push(message);
    }

    // Legacy behavior for mock SDK
    this.legacyQueue.push(message);
    if (this._state.type === "idle") {
      this.processNextInQueue();
    }
    return this.legacyQueue.length;
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
      this.emit({ type: "error", error: error as Error });
      // Don't transition to idle if we're waiting for input
      if (this._state.type !== "waiting-input") {
        this.transitionToIdle();
      }
    }
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
