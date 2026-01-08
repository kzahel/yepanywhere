import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ProviderName, UrlProjectId } from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
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
 * IMPORTANT: Never filter out messages by type before emitting to SSE!
 *
 * Tool results are user-type messages containing tool_result content blocks.
 * If you filter out user messages, tool calls will appear stuck in "pending"
 * state until the page is refreshed (when JSONL is fetched from disk).
 *
 * The client-side mergeMessages handles deduplication by UUID, so duplicate
 * emissions are safe and expected (queueMessage emits user messages, and
 * the iterator also yields them).
 *
 * @returns true - always emit the message
 */
export function shouldEmitMessage(_message: SDKMessage): boolean {
  // Always emit. DO NOT add filtering here!
  // See docstring above for why this is critical.
  return true;
}

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
  readonly projectId: UrlProjectId;
  readonly startedAt: Date;
  readonly provider: ProviderName;

  private legacyQueue: UserMessage[] = [];
  private messageQueue: MessageQueue | null;
  private abortFn: (() => void) | null;
  private _state: ProcessState = { type: "running" };
  private listeners: Set<Listener> = new Set();
  private idleTimer: NodeJS.Timeout | null = null;
  private idleTimeoutMs: number;
  private iteratorDone = false;

  /** Set synchronously when transport/spawn fails to prevent race with queueMessage */
  private transportFailed = false;

  /** In-memory message history for mock SDK (real SDK persists to disk) */
  private messageHistory: SDKMessage[] = [];

  /** Accumulated streaming text for catch-up when clients connect mid-stream */
  private _streamingText = "";
  /** Message ID for current streaming response */
  private _streamingMessageId: string | null = null;

  /** Pending tool approval requests (from canUseTool callback) - supports concurrent approvals */
  private pendingToolApprovals: Map<string, PendingToolApproval> = new Map();
  /** Order of pending approval request IDs for FIFO processing */
  private pendingToolApprovalQueue: string[] = [];

  /** Current permission mode for tool approvals */
  private _permissionMode: PermissionMode = "default";

  /** Version counter for permission mode changes (for multi-tab sync) */
  private _modeVersion = 0;

  /** Max thinking tokens this process was created with (undefined = thinking disabled) */
  private _maxThinkingTokens: number | undefined;

  /** Resolvers waiting for the real session ID */
  private sessionIdResolvers: Array<(id: string) => void> = [];
  private sessionIdResolved = false;

  /** Whether the process is held (soft pause) */
  private _isHeld = false;
  /** When hold mode was activated */
  private _holdSince: Date | null = null;
  /** Resolver to wake up the iterator loop when resumed */
  private _holdResolve: (() => void) | null = null;

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
    this.provider = options.provider;
    this._maxThinkingTokens = options.maxThinkingTokens;

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
   * Max thinking tokens this process was created with.
   * undefined means thinking is disabled.
   */
  get maxThinkingTokens(): number | undefined {
    return this._maxThinkingTokens;
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
   * Whether the process is currently held (soft pause).
   */
  get isHeld(): boolean {
    return this._isHeld;
  }

  /**
   * When the hold started, if currently held.
   */
  get holdSince(): Date | null {
    return this._holdSince;
  }

  /**
   * Set hold mode (soft pause) for this process.
   * When held, the iterator loop will pause before calling next().
   * When resumed, it continues from where it left off.
   */
  setHold(enabled: boolean): void {
    if (enabled === this._isHeld) {
      return; // No change
    }

    const log = getLogger();
    this._isHeld = enabled;

    if (enabled) {
      // Entering hold mode
      this._holdSince = new Date();
      this.clearIdleTimer(); // Don't auto-complete while held
      this.setState({ type: "hold", since: this._holdSince });
      log.info(
        {
          event: "process_hold_enabled",
          sessionId: this._sessionId,
          processId: this.id,
          projectId: this.projectId,
        },
        `Process held: ${this._sessionId}`,
      );
    } else {
      // Resuming from hold
      log.info(
        {
          event: "process_hold_disabled",
          sessionId: this._sessionId,
          processId: this.id,
          projectId: this.projectId,
          holdDurationMs: this._holdSince
            ? Date.now() - this._holdSince.getTime()
            : 0,
        },
        `Process resumed: ${this._sessionId}`,
      );
      this._holdSince = null;

      // Wake up the iterator loop
      if (this._holdResolve) {
        this._holdResolve();
        this._holdResolve = null;
      }

      // Transition back to running (or idle if iterator is done)
      if (this.iteratorDone) {
        this.transitionToIdle();
      } else {
        this.setState({ type: "running" });
      }
    }
  }

  /**
   * Wait until hold mode is disabled.
   * Called by processMessages() when held.
   */
  private waitUntilResumed(): Promise<void> {
    return new Promise((resolve) => {
      this._holdResolve = resolve;
    });
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

    const log = getLogger();
    const durationMs = Date.now() - this.startedAt.getTime();
    const pendingApprovalCount = this.pendingToolApprovals.size;

    log.warn(
      {
        event: "process_terminated",
        sessionId: this._sessionId,
        processId: this.id,
        projectId: this.projectId,
        reason,
        errorMessage: error?.message,
        errorStack: error?.stack,
        durationMs,
        pendingApprovalCount,
        previousState: this._state.type,
      },
      `Process terminated: ${this._sessionId} - ${reason}`,
    );

    this.clearIdleTimer();
    this.iteratorDone = true;

    // Wake up hold wait if held (so processMessages loop can exit)
    if (this._holdResolve) {
      this._holdResolve();
      this._holdResolve = null;
    }
    this._isHeld = false;

    // Resolve all pending tool approvals with denial
    for (const pending of this.pendingToolApprovals.values()) {
      pending.resolve({
        behavior: "deny",
        message: `Process terminated: ${reason}`,
        interrupt: true,
      });
    }
    this.pendingToolApprovals.clear();
    this.pendingToolApprovalQueue = [];

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
    } else if (this._state.type === "hold") {
      stateType = "hold";
    } else {
      stateType = "running";
    }

    const info: ProcessInfo = {
      id: this.id,
      sessionId: this._sessionId,
      projectId: this.projectId,
      projectPath: this.projectPath,
      projectName: path.basename(this.projectPath),
      sessionTitle: null, // Will be populated by Supervisor with session data
      state: stateType,
      startedAt: this.startedAt.toISOString(),
      queueDepth: this.queueDepth,
      provider: this.provider,
      maxThinkingTokens: this._maxThinkingTokens,
    };

    // Add idleSince if idle
    if (this._state.type === "idle") {
      info.idleSince = this._state.since.toISOString();
    }

    // Add holdSince if held
    if (this._state.type === "hold") {
      info.holdSince = this._state.since.toISOString();
    }

    return info;
  }

  /**
   * Get the in-memory message history.
   * Used by mock SDK sessions where messages aren't persisted to disk.
   */
  getMessageHistory(): SDKMessage[] {
    return [...this.messageHistory];
  }

  /**
   * Get accumulated streaming text for catch-up when clients connect mid-stream.
   * Returns the message ID and accumulated text, or null if not streaming.
   */
  getStreamingContent(): { messageId: string; text: string } | null {
    if (!this._streamingMessageId || !this._streamingText) {
      return null;
    }
    return {
      messageId: this._streamingMessageId,
      text: this._streamingText,
    };
  }

  /**
   * Accumulate streaming text from a delta.
   * Called by stream routes when processing stream_event messages.
   */
  accumulateStreamingText(messageId: string, text: string): void {
    if (this._streamingMessageId !== messageId) {
      // New streaming message, reset accumulator
      this._streamingMessageId = messageId;
      this._streamingText = text;
    } else {
      this._streamingText += text;
    }
  }

  /**
   * Clear streaming text accumulator (called when stream ends).
   */
  clearStreamingText(): void {
    this._streamingText = "";
    this._streamingMessageId = null;
  }

  /**
   * Add initial user message to history without queuing to SDK.
   * Used for real SDK sessions where the initial message is passed directly
   * to the SDK but needs to be in history for SSE replay to late-joining clients.
   *
   * @param text - The message text
   * @param uuid - The UUID to use (should match what was passed to SDK)
   * @param tempId - Optional client temp ID for optimistic UI tracking
   */
  addInitialUserMessage(text: string, uuid: string, tempId?: string): void {
    const sdkMessage = {
      type: "user",
      uuid,
      tempId,
      message: { role: "user", content: text },
    } as SDKMessage;

    this.messageHistory.push(sdkMessage);
    this.emit({ type: "message", message: sdkMessage });
  }

  /**
   * Format file size for display.
   */
  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024)
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  /**
   * Build user message content that matches what MessageQueue sends to the SDK.
   * This ensures SSE/history messages can be deduplicated against JSONL.
   */
  private buildUserMessageContent(message: UserMessage): string {
    let text = message.text;

    // Append attachment paths (same format as MessageQueue.toSDKMessage)
    if (message.attachments?.length) {
      const lines = message.attachments.map(
        (f) =>
          `- ${f.originalName} (${this.formatSize(f.size)}, ${f.mimeType}): ${f.path}`,
      );
      text += `\n\nUser uploaded files:\n${lines.join("\n")}`;
    }

    return text;
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
    // Check if process is terminated or transport failed
    if (this._state.type === "terminated") {
      return {
        success: false,
        error: `Process terminated: ${this._state.reason}`,
      };
    }

    // Check if transport failed (spawn error, etc.) - this flag is set synchronously
    // to prevent race conditions where queueMessage is called before markTerminated completes
    if (this.transportFailed) {
      return {
        success: false,
        error: "Process transport failed",
      };
    }

    // Create user message with UUID - this UUID will be used by both SSE and SDK
    const uuid = randomUUID();
    const messageWithUuid: UserMessage = { ...message, uuid };

    // Build content that matches what the SDK will write to JSONL.
    // This ensures SSE/history messages can be deduplicated against JSONL.
    const content = this.buildUserMessageContent(message);

    const sdkMessage = {
      type: "user",
      uuid,
      tempId: message.tempId,
      message: { role: "user", content },
    } as SDKMessage;

    // Add to history for SSE replay to late-joining clients.
    // The client-side deduplication (mergeSSEMessage, mergeJSONLMessages) handles
    // any duplicates when JSONL is later fetched. This is especially important
    // for the two-phase flow (createSession + queueMessage) where the client
    // may connect before the JSONL is written.
    if (shouldEmitMessage(sdkMessage)) {
      // Check for duplicates in history before adding
      // This prevents duplicates if the provider echoes the message back with the same UUID
      const isDuplicate = this.messageHistory.some(
        (m) => m.uuid && m.uuid === sdkMessage.uuid,
      );
      if (!isDuplicate) {
        this.messageHistory.push(sdkMessage);
      }
    }

    // Emit to current SSE subscribers so other clients see it immediately
    // Include the session ID so client can associate it correctly
    // The provider will echo this message back, but if we ensure UUIDs match,
    // the client will merge them.
    if (shouldEmitMessage(sdkMessage)) {
      this.emit({
        type: "message",
        message: { ...sdkMessage, session_id: this._sessionId },
      });
    }

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
   * - plan: Auto-approve read-only tools (Read, Glob, Grep, etc.), prompt for others
   * - bypassPermissions: Auto-approve all tools
   */
  async handleToolApproval(
    toolName: string,
    input: unknown,
    options: { signal: AbortSignal },
  ): Promise<ToolApprovalResult> {
    // Check if aborted
    if (options.signal.aborted) {
      return {
        behavior: "deny",
        message: "Operation aborted",
        interrupt: true,
      };
    }

    // Handle based on permission mode
    switch (this._permissionMode) {
      case "bypassPermissions":
        // Auto-approve all tools
        return { behavior: "allow" };

      case "plan": {
        // Read-only tools are auto-allowed - essential for creating good plans
        const readOnlyTools = [
          "Read",
          "Glob",
          "Grep",
          "LSP",
          "WebFetch",
          "WebSearch",
          "Task", // Subagent exploration
          "TaskOutput", // Reading subagent results
        ];
        if (readOnlyTools.includes(toolName)) {
          return { behavior: "allow" };
        }

        // Allow Write to .claude/plans/ directory for saving plans
        if (toolName === "Write") {
          const filePath = (input as { file_path?: string })?.file_path ?? "";
          if (filePath.includes(".claude/plans/")) {
            return { behavior: "allow" };
          }
        }

        // ExitPlanMode and AskUserQuestion should prompt the user
        // ExitPlanMode: user must approve the plan before exiting plan mode
        // AskUserQuestion: clarifying questions are valid during planning
        if (toolName === "ExitPlanMode" || toolName === "AskUserQuestion") {
          break; // Fall through to ask user for approval
        }

        // Other tools (Bash, Edit, Write to non-plan files, etc.) - prompt user
        // Agent typically won't use these in plan mode, but if they have a good
        // reason (e.g., checking git log, verifying dependencies), let them ask
        break; // Fall through to ask user for approval
      }

      case "acceptEdits": {
        // Auto-approve file editing tools, ask for others
        const editTools = ["Edit", "Write", "NotebookEdit"];
        if (editTools.includes(toolName)) {
          return { behavior: "allow" };
        }
        // Fall through to ask user for non-edit tools
        break;
      }

      default: {
        // Read-only tools are auto-allowed - no need to prompt for reads
        // "Ask before edits" means ask before WRITES, not reads
        const readOnlyTools = [
          "Read",
          "Glob",
          "Grep",
          "LSP",
          "WebFetch",
          "WebSearch",
          "Task", // Subagent exploration
          "TaskOutput", // Reading subagent results
        ];
        if (readOnlyTools.includes(toolName)) {
          return { behavior: "allow" };
        }
        // Fall through to ask user for mutating tools
        break;
      }
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

    // Add to the pending approvals map and queue
    // The first pending approval is shown to the user, others wait in queue
    const isFirstPending = this.pendingToolApprovals.size === 0;

    // Create a promise that will be resolved by respondToInput
    return new Promise<ToolApprovalResult>((resolve) => {
      this.pendingToolApprovals.set(request.id, { request, resolve });
      this.pendingToolApprovalQueue.push(request.id);

      // Handle abort signal
      const onAbort = () => {
        if (this.pendingToolApprovals.has(request.id)) {
          this.pendingToolApprovals.delete(request.id);
          this.pendingToolApprovalQueue = this.pendingToolApprovalQueue.filter(
            (id) => id !== request.id,
          );
          // If this was the current request being shown, emit the next one
          if (isFirstPending) {
            this.emitNextPendingApproval();
          }
          resolve({
            behavior: "deny",
            message: "Operation aborted",
            interrupt: true,
          });
        }
      };

      options.signal.addEventListener("abort", onAbort, { once: true });

      // Only emit state change for the first pending approval
      // Subsequent approvals wait in queue until the first is resolved
      if (isFirstPending) {
        this.setState({ type: "waiting-input", request });
      }
    });
  }

  /**
   * Emit the next pending approval to the client, or transition to running if none left.
   */
  private emitNextPendingApproval(): void {
    const nextId = this.pendingToolApprovalQueue[0];
    if (nextId !== undefined) {
      const next = this.pendingToolApprovals.get(nextId);
      if (next) {
        this.setState({ type: "waiting-input", request: next.request });
        return;
      }
    }
    // No more pending approvals
    this.setState({ type: "running" });
  }

  /**
   * Respond to a pending input request (tool approval).
   * Called from the API when user approves/denies a tool.
   * For AskUserQuestion, answers can be passed to update the tool input.
   * For deny with feedback, the feedback message is passed to the SDK.
   * Works for both real SDK (canUseTool callback) and mock SDK (input_request message).
   */
  respondToInput(
    requestId: string,
    response: "approve" | "deny",
    answers?: Record<string, string>,
    feedback?: string,
  ): boolean {
    const pending = this.pendingToolApprovals.get(requestId);

    // For mock SDK: check if requestId matches the state's request
    if (!pending) {
      if (
        this._state.type === "waiting-input" &&
        this._state.request.id === requestId
      ) {
        // Mock SDK case - just transition back to idle/running
        this.setState({ type: "running" });
        return true;
      }
      return false;
    }

    // Build the result with optional updated input for AskUserQuestion
    // If deny has feedback, use that as the message
    const denyMessage = feedback || "User denied permission";
    // If user just clicked "No" without feedback, set interrupt: true to stop retrying.
    // If user provided feedback, set interrupt: false so Claude can incorporate the guidance.
    const shouldInterrupt = response === "deny" && !feedback;
    const result: ToolApprovalResult = {
      behavior: response === "approve" ? "allow" : "deny",
      message: response === "deny" ? denyMessage : undefined,
      interrupt: response === "deny" ? shouldInterrupt : undefined,
    };

    // If answers provided (AskUserQuestion), pass them as updatedInput
    if (answers && response === "approve") {
      const originalInput = pending.request.toolInput as {
        questions?: unknown[];
      };
      result.updatedInput = {
        ...originalInput,
        answers,
      };
    }

    // If EnterPlanMode is approved, switch to plan mode
    if (
      response === "approve" &&
      pending.request.toolName === "EnterPlanMode"
    ) {
      this.setPermissionMode("plan");
    }

    // If ExitPlanMode is approved, switch back to default mode
    if (response === "approve" && pending.request.toolName === "ExitPlanMode") {
      this.setPermissionMode("default");
    }

    // Resolve the promise and remove from tracking
    pending.resolve(result);
    this.pendingToolApprovals.delete(requestId);
    this.pendingToolApprovalQueue = this.pendingToolApprovalQueue.filter(
      (id) => id !== requestId,
    );

    // Emit the next pending approval, or transition to running if none left
    this.emitNextPendingApproval();

    return true;
  }

  /**
   * Get the current pending input request (first in queue), if any.
   * Works for both real SDK (canUseTool callback) and mock SDK (input_request message).
   */
  getPendingInputRequest(): InputRequest | null {
    // Check real SDK pending approvals queue first
    const firstId = this.pendingToolApprovalQueue[0];
    if (firstId !== undefined) {
      return this.pendingToolApprovals.get(firstId)?.request ?? null;
    }
    // For mock SDK, check state directly
    if (this._state.type === "waiting-input") {
      return this._state.request;
    }
    return null;
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
        // Check if held - pause before calling iterator.next()
        if (this._isHeld) {
          await this.waitUntilResumed();
          // After resuming, check if we should continue or if terminated while held
          if (this.iteratorDone || this._state.type === "terminated") {
            break;
          }
        }

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
        // See shouldEmitMessage() for why we never filter messages
        if (shouldEmitMessage(message)) {
          // Check for duplicates before adding to history
          // This handles the case where queueMessage added the optimistic message
          // and now the provider is echoing it back with the same UUID
          const isDuplicate =
            message.type === "user" &&
            message.uuid &&
            this.messageHistory.some((m) => m.uuid === message.uuid);

          if (!isDuplicate) {
            this.messageHistory.push(message);
          }
        }

        // Extract session ID from init message
        if (
          message.type === "system" &&
          message.subtype === "init" &&
          message.session_id
        ) {
          const log = getLogger();
          const oldSessionId = this._sessionId;
          this._sessionId = message.session_id;
          this.sessionIdResolved = true;

          log.info(
            {
              event: "session_id_received",
              sessionId: this._sessionId,
              previousTempId: oldSessionId,
              processId: this.id,
              projectId: this.projectId,
            },
            `Session ID received from SDK: ${this._sessionId}`,
          );

          // Emit session-id-changed event so Supervisor can update its mapping
          // This is critical for ExternalSessionTracker to correctly identify owned sessions
          if (oldSessionId !== this._sessionId) {
            this.emit({
              type: "session-id-changed",
              oldSessionId,
              newSessionId: this._sessionId,
            });
          }

          // Resolve any waiters
          for (const resolve of this.sessionIdResolvers) {
            resolve(this._sessionId);
          }
          this.sessionIdResolvers = [];
        }

        // Emit to SSE subscribers
        // See shouldEmitMessage() for why we never filter messages
        if (shouldEmitMessage(message)) {
          this.emit({ type: "message", message });
        }

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
      const log = getLogger();

      log.error(
        {
          event: "process_error",
          sessionId: this._sessionId,
          processId: this.id,
          projectId: this.projectId,
          errorMessage: err.message,
          errorStack: err.stack,
          currentState: this._state.type,
        },
        `Process error: ${this._sessionId} - ${err.message}`,
      );

      this.emit({ type: "error", error: err });

      // Detect process termination errors - set flag synchronously BEFORE markTerminated
      // to prevent race where queueMessage is called before state changes to terminated
      if (this.isProcessTerminationError(err)) {
        this.transportFailed = true;
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
