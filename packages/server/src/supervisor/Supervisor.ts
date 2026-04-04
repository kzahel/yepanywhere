import { randomUUID } from "node:crypto";
import {
  type EffortLevel,
  type PermissionRules,
  type ProviderName,
  SESSION_TITLE_MAX_LENGTH,
  type ThinkingConfig,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import type { AgentActivity, PendingInputType } from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import { getProvider } from "../sdk/providers/index.js";
import type { AgentProvider } from "../sdk/providers/types.js";
import type {
  ClaudeSDK,
  PermissionMode,
  RealClaudeSDKInterface,
  UserMessage,
} from "../sdk/types.js";
import type {
  EventBus,
  ProcessStateEvent,
  ProcessTerminatedEvent,
  SessionAbortedEvent,
  SessionCreatedEvent,
  SessionStatusEvent,
  SessionUpdatedEvent,
  WorkerActivityEvent,
} from "../watcher/EventBus.js";
import { Process, type ProcessConstructorOptions } from "./Process.js";
import {
  type QueuedRequest,
  type QueuedRequestInfo,
  type QueuedResponse,
  WorkerQueue,
  isQueueFullError,
} from "./WorkerQueue.js";
import {
  DEFAULT_IDLE_PREEMPT_THRESHOLD_MS,
  type ProcessInfo,
  type ProcessOptions,
  type SessionOwnership,
  type SessionSummary,
  encodeProjectId,
} from "./types.js";

/** Maximum number of terminated processes to retain */
const MAX_TERMINATED_PROCESSES = 50;

/** How long to retain terminated process info (10 minutes) */
const TERMINATED_RETENTION_MS = 10 * 60 * 1000;

/** How often to check for stale processes (60 seconds) */
const STALE_CHECK_INTERVAL_MS = 60 * 1000;

/** Default in-turn stale threshold for providers with frequent heartbeat/tool events. */
const DEFAULT_STALE_IN_TURN_THRESHOLD_MS = 5 * 60 * 1000;
/** Codex sessions can be silent for long periods during backend retries/reconnects. */
const CODEX_STALE_IN_TURN_THRESHOLD_MS = 60 * 60 * 1000;

function getStaleInTurnThresholdMs(provider: ProviderName): number {
  return provider === "codex" || provider === "codex-oss"
    ? CODEX_STALE_IN_TURN_THRESHOLD_MS
    : DEFAULT_STALE_IN_TURN_THRESHOLD_MS;
}

/**
 * Model and thinking settings for a session.
 */
export interface ModelSettings {
  /** Model to use (e.g., "sonnet", "opus", "haiku"). undefined = use CLI default */
  model?: string;
  /** Thinking configuration. undefined = thinking disabled */
  thinking?: ThinkingConfig;
  /** Effort level for response quality. undefined = SDK default */
  effort?: EffortLevel;
  /** Provider to use for this session. undefined = use default (Claude) */
  providerName?: ProviderName;
  /** SSH host for remote execution (undefined = local) */
  executor?: string;
  /** Environment variables to set on remote (for testing: CLAUDE_SESSIONS_DIR) */
  remoteEnv?: Record<string, string>;
  /** Global instructions to append to system prompt (from server settings) */
  globalInstructions?: string;
  /** Permission rules for tool filtering (deny/allow patterns) */
  permissions?: PermissionRules;
}

/** Error response when queue is full */
export interface QueueFullResponse {
  error: "queue_full";
  maxQueueSize: number;
}

/** Optional callback to persist executor when session ID is received */
export type OnSessionExecutorCallback = (
  sessionId: string,
  executor: string | undefined,
) => Promise<void>;

/** Optional callback to fetch authoritative session summary for reconciliation */
export type OnSessionSummaryCallback = (
  sessionId: string,
  projectId: UrlProjectId,
) => Promise<SessionSummary | null>;

/** Optional callback invoked when a session process completes/terminates */
export type OnSessionCompleteCallback = (sessionId: string) => Promise<void>;

/** Delays for initial title/messageCount reconciliation after session creation */
const INITIAL_RECONCILE_DELAYS_MS = [1000, 3000] as const;

export interface SupervisorOptions {
  /** Agent provider interface (preferred for new code) */
  provider?: AgentProvider;
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
  /** Maximum queue size. 0 = unlimited (default) */
  maxQueueSize?: number;
  /** Callback to persist executor when session ID is received (for remote execution resume) */
  onSessionExecutor?: OnSessionExecutorCallback;
  /** Callback to fetch session summary for initial metadata reconciliation */
  onSessionSummary?: OnSessionSummaryCallback;
  /** Callback invoked when a session process completes (for worktree cleanup, etc.) */
  onSessionComplete?: OnSessionCompleteCallback;
}

export class Supervisor {
  private processes: Map<string, Process> = new Map();
  private sessionToProcess: Map<string, string> = new Map(); // sessionId -> processId
  private everOwnedSessions: Set<string> = new Set(); // Sessions we've ever owned (for orphan detection)
  private terminatedProcesses: ProcessInfo[] = []; // Recently terminated processes
  private provider: AgentProvider | null;
  private sdk: ClaudeSDK | null;
  private realSdk: RealClaudeSDKInterface | null;
  private idleTimeoutMs?: number;
  private defaultPermissionMode: PermissionMode;
  private eventBus?: EventBus;
  private maxWorkers: number;
  private idlePreemptThresholdMs: number;
  private workerQueue: WorkerQueue;
  private onSessionExecutor?: OnSessionExecutorCallback;
  private onSessionSummary?: OnSessionSummaryCallback;
  private onSessionComplete?: OnSessionCompleteCallback;
  private staleCheckTimer: ReturnType<typeof setInterval>;

  constructor(options: SupervisorOptions) {
    this.provider = options.provider ?? null;
    this.sdk = options.sdk ?? null;
    this.realSdk = options.realSdk ?? null;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.defaultPermissionMode = options.defaultPermissionMode ?? "default";
    this.eventBus = options.eventBus;
    this.maxWorkers = options.maxWorkers ?? 0; // 0 = unlimited
    this.idlePreemptThresholdMs =
      options.idlePreemptThresholdMs ?? DEFAULT_IDLE_PREEMPT_THRESHOLD_MS;
    this.workerQueue = new WorkerQueue({
      eventBus: options.eventBus,
      maxQueueSize: options.maxQueueSize,
    });
    this.onSessionExecutor = options.onSessionExecutor;
    this.onSessionSummary = options.onSessionSummary;
    this.onSessionComplete = options.onSessionComplete;
    this.staleCheckTimer = setInterval(
      () => this.terminateStaleProcesses(),
      STALE_CHECK_INTERVAL_MS,
    );
    this.staleCheckTimer.unref(); // Don't keep process alive for cleanup

    if (!this.provider && !this.sdk && !this.realSdk) {
      throw new Error("Either provider, sdk, or realSdk must be provided");
    }
  }

  async startSession(
    projectPath: string,
    message: UserMessage,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
  ): Promise<Process | QueuedResponse | QueueFullResponse> {
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
        const result = this.workerQueue.enqueue({
          type: "new-session",
          projectPath,
          projectId,
          message,
          permissionMode,
        });
        if (isQueueFullError(result)) {
          return result;
        }
        return {
          queued: true,
          queueId: result.queueId,
          position: result.position,
        };
      }
    }

    // Resolve provider: use specified provider name, or fall back to default provider
    // If executor is specified, we MUST use a provider (Claude) to enable remote execution
    const provider = modelSettings?.providerName
      ? getProvider(modelSettings.providerName)
      : modelSettings?.executor
        ? getProvider("claude") // Force Claude provider when executor is specified
        : this.provider;

    // Use provider if available (preferred)
    if (provider) {
      return this.startProviderSession(
        projectPath,
        projectId,
        message,
        undefined,
        permissionMode,
        modelSettings,
        provider,
      );
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
  ): Promise<Process | QueuedResponse | QueueFullResponse> {
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
        const result = this.workerQueue.enqueue({
          type: "new-session",
          projectPath,
          projectId,
          message: { text: "" }, // Placeholder, will be replaced when first message sent
          permissionMode,
        });
        if (isQueueFullError(result)) {
          return result;
        }
        return {
          queued: true,
          queueId: result.queueId,
          position: result.position,
        };
      }
    }

    // Resolve provider: use specified provider name, or fall back to default provider
    // If executor is specified, we MUST use a provider (Claude) to enable remote execution
    const provider = modelSettings?.providerName
      ? getProvider(modelSettings.providerName)
      : modelSettings?.executor
        ? getProvider("claude") // Force Claude provider when executor is specified
        : this.provider;

    // Use provider if available (preferred)
    if (provider) {
      return this.createProviderSession(
        projectPath,
        projectId,
        permissionMode,
        modelSettings,
        provider,
      );
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
      "createSession requires provider or real SDK - legacy mock SDK not supported",
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
      thinking: modelSettings?.thinking,
      effort: modelSettings?.effort,
      globalInstructions: modelSettings?.globalInstructions,
      onToolApproval: async (toolName, input, opts) => {
        if (!processHolder.process) {
          return { behavior: "deny", message: "Process not ready" };
        }
        return processHolder.process.handleToolApproval(toolName, input, opts);
      },
    });

    const {
      iterator,
      queue,
      abort,
      isProcessAlive,
      setMaxThinkingTokens,
      interrupt,
      supportedModels,
      supportedCommands,
      setModel,
    } = result;

    const tempSessionId = randomUUID();
    const options: ProcessConstructorOptions = {
      projectPath,
      projectId,
      sessionId: tempSessionId,
      idleTimeoutMs: this.idleTimeoutMs,
      queue,
      abortFn: abort,
      isProcessAlive,
      pid: () => {
        const p = result.pid;
        return typeof p === "function" ? p() : p;
      },
      setMaxThinkingTokensFn: setMaxThinkingTokens,
      interruptFn: interrupt,
      supportedModelsFn: supportedModels,
      supportedCommandsFn: supportedCommands,
      setModelFn: setModel,
      permissionMode: effectiveMode,
      provider: "claude", // Real SDK is always Claude
      model: modelSettings?.model,
      thinking: modelSettings?.thinking,
      effort: modelSettings?.effort,
      executor: modelSettings?.executor,
      permissions: modelSettings?.permissions,
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
      thinking: modelSettings?.thinking,
      effort: modelSettings?.effort,
      executor: modelSettings?.executor,
      remoteEnv: modelSettings?.remoteEnv,
      globalInstructions: modelSettings?.globalInstructions,
      onToolApproval: async (toolName, input, opts) => {
        // Delegate to the process's handleToolApproval
        if (!processHolder.process) {
          return { behavior: "deny", message: "Process not ready" };
        }
        return processHolder.process.handleToolApproval(toolName, input, opts);
      },
    });

    const {
      iterator,
      queue,
      abort,
      isProcessAlive,
      setMaxThinkingTokens,
      interrupt,
      supportedModels,
      supportedCommands,
      setModel,
    } = result;

    const options: ProcessConstructorOptions = {
      projectPath,
      projectId,
      sessionId: tempSessionId,
      idleTimeoutMs: this.idleTimeoutMs,
      queue,
      abortFn: abort,
      isProcessAlive,
      pid: () => {
        const p = result.pid;
        return typeof p === "function" ? p() : p;
      },
      setMaxThinkingTokensFn: setMaxThinkingTokens,
      interruptFn: interrupt,
      supportedModelsFn: supportedModels,
      supportedCommandsFn: supportedCommands,
      setModelFn: setModel,
      permissionMode: effectiveMode,
      provider: "claude", // Real SDK is always Claude
      model: modelSettings?.model,
      thinking: modelSettings?.thinking,
      effort: modelSettings?.effort,
      executor: modelSettings?.executor,
      permissions: modelSettings?.permissions,
    };

    const process = new Process(iterator, options);
    processHolder.process = process;

    // Add the initial user message to history with the same UUID we passed to SDK.
    // This ensures SSE replay includes the user message so the client can replace
    // its temp message. The SDK also writes to JSONL with this UUID, so both SSE
    // and JSONL will have matching IDs (no duplicates).
    process.addInitialUserMessage(message.text, messageUuid, message.tempId);

    // Wait for the real session ID from the SDK before registering
    // This ensures the client gets the correct ID to use for persistence
    if (!resumeSessionId) {
      await process.waitForSessionId();
    }

    this.registerProcess(process, !resumeSessionId);

    return process;
  }

  /**
   * Create a session using the provider interface without an initial message.
   * The session is created and waits for a message to be queued.
   */
  private async createProviderSession(
    projectPath: string,
    projectId: UrlProjectId,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
    provider?: AgentProvider,
  ): Promise<Process> {
    const activeProvider = provider ?? this.provider;
    if (!activeProvider) {
      throw new Error("provider is not available");
    }

    const processHolder: { process: Process | null } = { process: null };
    const effectiveMode = permissionMode ?? this.defaultPermissionMode;

    // Start session WITHOUT an initial message - agent will wait
    const result = await activeProvider.startSession({
      cwd: projectPath,
      // No initialMessage - queue will block until one is pushed
      permissionMode: effectiveMode,
      model: modelSettings?.model,
      thinking: modelSettings?.thinking,
      effort: modelSettings?.effort,
      executor: modelSettings?.executor,
      remoteEnv: modelSettings?.remoteEnv,
      globalInstructions: modelSettings?.globalInstructions,
      onToolApproval: async (toolName, input, opts) => {
        if (!processHolder.process) {
          return { behavior: "deny", message: "Process not ready" };
        }
        return processHolder.process.handleToolApproval(toolName, input, opts);
      },
    });

    const {
      iterator,
      queue,
      abort,
      isProcessAlive,
      setMaxThinkingTokens,
      interrupt,
      steer,
      supportedModels,
      supportedCommands,
      setModel,
    } = result;

    const tempSessionId = randomUUID();
    const options: ProcessConstructorOptions = {
      projectPath,
      projectId,
      sessionId: tempSessionId,
      idleTimeoutMs: this.idleTimeoutMs,
      queue,
      abortFn: abort,
      isProcessAlive,
      pid: () => {
        const p = result.pid;
        return typeof p === "function" ? p() : p;
      },
      setMaxThinkingTokensFn: setMaxThinkingTokens,
      interruptFn: interrupt,
      steerFn: steer,
      supportedModelsFn: supportedModels,
      supportedCommandsFn: supportedCommands,
      setModelFn: setModel,
      permissionMode: effectiveMode,
      provider: activeProvider.name,
      model: modelSettings?.model,
      thinking: modelSettings?.thinking,
      effort: modelSettings?.effort,
      executor: modelSettings?.executor,
      permissions: modelSettings?.permissions,
    };

    const process = new Process(iterator, options);
    processHolder.process = process;

    // Wait for the real session ID from the provider
    await process.waitForSessionId();

    // Register as a new session
    this.registerProcess(process, true);

    return process;
  }

  /**
   * Start a session using the provider interface with full features.
   */
  private async startProviderSession(
    projectPath: string,
    projectId: UrlProjectId,
    message: UserMessage,
    resumeSessionId?: string,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
    provider?: AgentProvider,
  ): Promise<Process> {
    const activeProvider = provider ?? this.provider;
    if (!activeProvider) {
      throw new Error("provider is not available");
    }

    const tempSessionId = resumeSessionId ?? randomUUID();

    // We need to reference process in the callback before it's assigned
    const processHolder: { process: Process | null } = { process: null };

    // Use provided mode or fall back to default
    const effectiveMode = permissionMode ?? this.defaultPermissionMode;

    // Generate UUID for the initial message so SDK and SSE use the same ID.
    const messageUuid = randomUUID();
    const messageWithUuid: UserMessage = { ...message, uuid: messageUuid };

    const result = await activeProvider.startSession({
      cwd: projectPath,
      initialMessage: messageWithUuid,
      resumeSessionId,
      permissionMode: effectiveMode,
      model: modelSettings?.model,
      thinking: modelSettings?.thinking,
      effort: modelSettings?.effort,
      executor: modelSettings?.executor,
      remoteEnv: modelSettings?.remoteEnv,
      globalInstructions: modelSettings?.globalInstructions,
      onToolApproval: async (toolName, input, opts) => {
        if (!processHolder.process) {
          return { behavior: "deny", message: "Process not ready" };
        }
        return processHolder.process.handleToolApproval(toolName, input, opts);
      },
    });

    const {
      iterator,
      queue,
      abort,
      isProcessAlive,
      setMaxThinkingTokens,
      interrupt,
      steer,
      supportedModels,
      supportedCommands,
      setModel,
    } = result;

    const options: ProcessConstructorOptions = {
      projectPath,
      projectId,
      sessionId: tempSessionId,
      idleTimeoutMs: this.idleTimeoutMs,
      queue,
      abortFn: abort,
      isProcessAlive,
      pid: () => {
        const p = result.pid;
        return typeof p === "function" ? p() : p;
      },
      setMaxThinkingTokensFn: setMaxThinkingTokens,
      interruptFn: interrupt,
      steerFn: steer,
      supportedModelsFn: supportedModels,
      supportedCommandsFn: supportedCommands,
      setModelFn: setModel,
      permissionMode: effectiveMode,
      provider: activeProvider.name,
      model: modelSettings?.model,
      thinking: modelSettings?.thinking,
      effort: modelSettings?.effort,
      executor: modelSettings?.executor,
      permissions: modelSettings?.permissions,
    };

    const process = new Process(iterator, options);
    processHolder.process = process;

    // Add the initial user message to history with the same UUID we passed to provider.
    process.addInitialUserMessage(message.text, messageUuid, message.tempId);

    // Wait for the real session ID from the provider before registering
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
      provider: "claude", // Legacy mock SDK simulates Claude
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
  ): Promise<Process | QueuedResponse | QueueFullResponse> {
    // Check if already have a process for this session
    const existingProcessId = this.sessionToProcess.get(sessionId);
    if (existingProcessId) {
      const existingProcess = this.processes.get(existingProcessId);
      if (existingProcess) {
        // Check if process is terminated - if so, start a fresh one
        if (existingProcess.isTerminated) {
          this.unregisterProcess(existingProcess);
        } else {
          // Check if thinking/effort settings changed
          const thinkingChanged =
            existingProcess.thinking?.type !==
            (modelSettings?.thinking?.type ?? undefined);
          const effortChanged =
            existingProcess.effort !== modelSettings?.effort;

          if (thinkingChanged || effortChanged) {
            if (
              thinkingChanged &&
              !effortChanged &&
              existingProcess.supportsThinkingModeChange
            ) {
              // Toggle adaptive/disabled dynamically via deprecated API
              const tokens =
                modelSettings?.thinking?.type === "disabled" ? 0 : 1;
              const changed = await existingProcess.setMaxThinkingTokens(
                tokens === 0 ? undefined : tokens,
              );
              if (changed) {
                existingProcess.updateThinkingConfig(
                  modelSettings?.thinking,
                  modelSettings?.effort,
                );
              } else {
                const log = getLogger();
                log.warn(
                  {
                    event: "thinking_mode_change_failed",
                    sessionId,
                    processId: existingProcess.id,
                  },
                  "Failed to change thinking mode dynamically",
                );
              }
            } else {
              // Effort changed or no dynamic support: restart process
              const log = getLogger();
              log.info(
                {
                  event: "thinking_mode_changed_restart",
                  sessionId,
                  processId: existingProcess.id,
                  oldThinking: existingProcess.thinking?.type,
                  oldEffort: existingProcess.effort,
                  newThinking: modelSettings?.thinking?.type,
                  newEffort: modelSettings?.effort,
                },
                "Thinking/effort changed, restarting process",
              );
              await existingProcess.abort();
              this.unregisterProcess(existingProcess);
              // Fall through to start a new session with the updated settings
            }
          }
          // Update permission mode if specified
          if (permissionMode) {
            existingProcess.setPermissionMode(permissionMode);
          }
          // Queue message to existing process (if we didn't fall through to restart)
          if (!existingProcess.isTerminated) {
            const result = existingProcess.queueMessage(message);
            if (result.success) {
              return existingProcess;
            }
            // Failed to queue - process likely terminated, clean up and start fresh
            this.unregisterProcess(existingProcess);
          }
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
        const result = this.workerQueue.enqueue({
          type: "resume-session",
          projectPath,
          projectId,
          sessionId,
          message,
          permissionMode,
        });
        if (isQueueFullError(result)) {
          return result;
        }
        return {
          queued: true,
          queueId: result.queueId,
          position: result.position,
        };
      }
    }

    // Resolve provider: use specified provider name, or fall back to default provider
    // If executor is specified, we MUST use a provider (Claude) to enable remote execution
    const provider = modelSettings?.providerName
      ? getProvider(modelSettings.providerName)
      : modelSettings?.executor
        ? getProvider("claude") // Force Claude provider when executor is specified
        : this.provider;

    // Use provider if available (preferred)
    if (provider) {
      return this.startProviderSession(
        projectPath,
        projectId,
        message,
        sessionId,
        permissionMode,
        modelSettings,
        provider,
      );
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

  /**
   * Queue a message to an existing session, handling thinking mode changes.
   * If the thinking mode differs from the process's current setting, this will:
   * 1. Abort the existing process
   * 2. Start a new process with the new thinking settings
   * 3. Queue the message to the new process
   *
   * @returns The process (possibly new), or an error object
   */
  async queueMessageToSession(
    sessionId: string,
    projectPath: string,
    message: UserMessage,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
  ): Promise<
    | { success: true; process: Process; restarted: boolean }
    | { success: false; error: string }
  > {
    const process = this.getProcessForSession(sessionId);
    if (!process) {
      return { success: false, error: "No active process for session" };
    }

    if (process.isTerminated) {
      return { success: false, error: "Process terminated" };
    }

    // Check if thinking/effort settings changed
    const thinkingChanged =
      process.thinking?.type !== (modelSettings?.thinking?.type ?? undefined);
    const effortChanged = process.effort !== modelSettings?.effort;

    if (thinkingChanged || effortChanged) {
      if (
        thinkingChanged &&
        !effortChanged &&
        process.supportsThinkingModeChange
      ) {
        // Toggle thinking dynamically via deprecated API (works for auto↔off)
        const tokens = modelSettings?.thinking?.type === "disabled" ? 0 : 1;
        const changed = await process.setMaxThinkingTokens(
          tokens === 0 ? undefined : tokens,
        );
        if (changed) {
          process.updateThinkingConfig(
            modelSettings?.thinking,
            modelSettings?.effort,
          );
        } else {
          const log = getLogger();
          log.warn(
            {
              event: "thinking_mode_change_failed_queue",
              sessionId,
              processId: process.id,
            },
            "Failed to change thinking mode dynamically on queue",
          );
        }
      } else {
        // Effort changed or no dynamic support: restart process
        const log = getLogger();
        log.info(
          {
            event: "thinking_mode_changed_queue_restart",
            sessionId,
            processId: process.id,
            oldThinking: process.thinking?.type,
            oldEffort: process.effort,
            newThinking: modelSettings?.thinking?.type,
            newEffort: modelSettings?.effort,
          },
          "Thinking/effort changed on queue, restarting process",
        );

        await process.abort();
        this.unregisterProcess(process);

        const result = await this.resumeSession(
          sessionId,
          projectPath,
          message,
          permissionMode,
          modelSettings,
        );

        if ("id" in result) {
          return { success: true, process: result, restarted: true };
        }
        return { success: false, error: "Request was queued or failed" };
      }
    }

    // Queue to existing process (dynamic thinking change already applied if needed)
    if (permissionMode) {
      process.setPermissionMode(permissionMode);
    }

    const result = process.queueMessage(message);
    if (result.success) {
      return { success: true, process, restarted: false };
    }

    return { success: false, error: result.error ?? "Failed to queue message" };
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

    const log = getLogger();
    log.info(
      {
        event: "session_abort_requested",
        sessionId: process.sessionId,
        processId: process.id,
        projectId: process.projectId,
        currentState: process.state.type,
      },
      `Session abort requested: ${process.sessionId}`,
    );

    // Emit session-aborted event BEFORE aborting, so ExternalSessionTracker
    // can set up the grace period before any file changes arrive
    this.emitSessionAborted(process.sessionId, process.projectId);

    await process.abort();
    this.unregisterProcess(process);
    return true;
  }

  /**
   * Interrupt the current turn of a running process gracefully.
   * Unlike abort, this stops the current turn but keeps the process alive.
   *
   * @returns Object with success status and whether interrupt is supported
   */
  async interruptProcess(
    processId: string,
  ): Promise<{ success: boolean; supported: boolean }> {
    const process = this.processes.get(processId);
    if (!process) return { success: false, supported: false };

    // Check if the process supports interrupt
    if (!process.supportsInterrupt) {
      return { success: false, supported: false };
    }

    const log = getLogger();
    log.info(
      {
        event: "session_interrupt_requested",
        sessionId: process.sessionId,
        processId: process.id,
        projectId: process.projectId,
        currentState: process.state.type,
      },
      `Session interrupt requested: ${process.sessionId}`,
    );

    const interrupted = await process.interrupt();
    return { success: interrupted, supported: true };
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
    const log = getLogger();
    log.info(
      {
        event: "session_registered",
        sessionId: process.sessionId,
        processId: process.id,
        projectId: process.projectId,
        projectPath: process.projectPath,
        isNewSession,
        permissionMode: process.permissionMode,
      },
      `Session registered: ${process.sessionId} (process: ${process.id})`,
    );

    this.processes.set(process.id, process);
    this.sessionToProcess.set(process.sessionId, process.id);
    this.everOwnedSessions.add(process.sessionId);

    const ownership: SessionOwnership = {
      owner: "self",
      processId: process.id,
      permissionMode: process.permissionMode,
      modeVersion: process.modeVersion,
    };

    // Emit session created event for new sessions
    if (isNewSession) {
      this.emitSessionCreated(process, ownership);
      this.scheduleInitialSessionReconciliation(
        process.sessionId,
        process.projectId,
      );
    }

    // Emit ownership change event
    this.emitOwnershipChange(process.sessionId, process.projectId, ownership);

    // Emit initial agent activity (process starts in in-turn state)
    const initialState = process.state;
    if (
      initialState.type === "in-turn" ||
      initialState.type === "waiting-input"
    ) {
      // Convert InputRequest.type to PendingInputType if waiting for input at start
      let pendingInputType: PendingInputType | undefined;
      if (initialState.type === "waiting-input") {
        const requestType = initialState.request.type;
        pendingInputType =
          requestType === "tool-approval" ? "tool-approval" : "user-question";
      }
      this.emitAgentActivityChange(
        process.sessionId,
        process.projectId,
        initialState.type,
        pendingInputType,
      );
    }

    // Emit worker activity after registering (new worker added)
    this.emitWorkerActivity();

    // Listen for completion to auto-cleanup, and state changes for process state events
    process.subscribe((event) => {
      if (event.type === "complete") {
        this.unregisterProcess(process);
      } else if (event.type === "session-id-changed") {
        // Update session→process mapping when temp ID is replaced by real ID from SDK
        // This is critical for ExternalSessionTracker to correctly identify owned sessions
        const log = getLogger();
        log.info(
          {
            event: "session_id_mapping_updated",
            oldSessionId: event.oldSessionId,
            newSessionId: event.newSessionId,
            processId: process.id,
            projectId: process.projectId,
            executor: process.executor,
          },
          `Session ID mapping updated: ${event.oldSessionId} → ${event.newSessionId}`,
        );

        // Keep both temp and real session ID mappings to support lookups by either ID
        // Clients might still be using the temp ID when the real ID arrives
        // The old temp ID mapping is retained (no delete)
        this.sessionToProcess.set(event.newSessionId, process.id);
        this.everOwnedSessions.add(event.newSessionId);

        // Persist executor for remote execution resume support
        // This saves which SSH host was used so resume can reconnect to the same remote
        if (this.onSessionExecutor && process.executor) {
          this.onSessionExecutor(event.newSessionId, process.executor).catch(
            (error) => {
              log.warn(
                {
                  event: "executor_save_failed",
                  sessionId: event.newSessionId,
                  executor: process.executor,
                  error: error instanceof Error ? error.message : String(error),
                },
                `Failed to save executor for session: ${event.newSessionId}`,
              );
            },
          );
        }

        // Emit ownership change for new session ID so clients can update
        const ownership: SessionOwnership = {
          owner: "self",
          processId: process.id,
          permissionMode: process.permissionMode,
          modeVersion: process.modeVersion,
        };
        this.emitOwnershipChange(
          event.newSessionId,
          process.projectId,
          ownership,
        );

        // Retry early metadata reconciliation with authoritative session ID.
        this.scheduleInitialSessionReconciliation(
          event.newSessionId,
          process.projectId,
        );
      } else if (event.type === "state-change") {
        // Emit agent activity change for all states that clients need to track
        // This includes in-turn/waiting-input (active) and idle (inactive)
        if (
          event.state.type === "in-turn" ||
          event.state.type === "waiting-input" ||
          event.state.type === "idle"
        ) {
          // Convert InputRequest.type to PendingInputType when waiting for input
          // "tool-approval" stays as-is, "question" or "choice" becomes "user-question"
          let pendingInputType: PendingInputType | undefined;
          if (event.state.type === "waiting-input") {
            const requestType = event.state.request.type;
            pendingInputType =
              requestType === "tool-approval"
                ? "tool-approval"
                : "user-question";
          }
          this.emitAgentActivityChange(
            process.sessionId,
            process.projectId,
            event.state.type,
            pendingInputType,
          );
        }
        // Emit worker activity on any state change (affects hasActiveWork)
        this.emitWorkerActivity();
      } else if (event.type === "terminated") {
        this.emitProcessTerminated(
          process.sessionId,
          process.projectId,
          process.id,
          process.provider,
          event.reason,
        );
      }
    });
  }

  private unregisterProcess(process: Process): void {
    const log = getLogger();
    const durationMs = Date.now() - process.startedAt.getTime();
    log.info(
      {
        event: "session_unregistered",
        sessionId: process.sessionId,
        processId: process.id,
        projectId: process.projectId,
        durationMs,
        finalState: process.state.type,
        terminationReason: process.terminationReason,
      },
      `Session unregistered: ${process.sessionId} after ${durationMs}ms (reason: ${process.terminationReason ?? process.state.type})`,
    );

    // Capture process info for terminated list before deleting
    const terminatedInfo = process.getInfo();
    terminatedInfo.state = "terminated"; // Override state since process may have been forcefully aborted
    terminatedInfo.terminatedAt = new Date().toISOString();
    if (process.terminationReason) {
      terminatedInfo.terminationReason = process.terminationReason;
    }
    this.addTerminatedProcess(terminatedInfo);

    this.processes.delete(process.id);

    // Delete all session ID mappings that point to this process
    // This handles both temp and real session IDs
    for (const [sessionId, processId] of this.sessionToProcess.entries()) {
      if (processId === process.id) {
        this.sessionToProcess.delete(sessionId);
      }
    }

    // Emit ownership change event (back to none)
    this.emitOwnershipChange(process.sessionId, process.projectId, {
      owner: "none",
    });

    // Emit agent activity change to notify clients that this session is no longer running
    // This is needed for real-time updates (e.g., AgentsNavItem indicator)
    this.emitAgentActivityChange(process.sessionId, process.projectId, "idle");

    // Notify listeners of session completion (e.g., worktree cleanup)
    if (this.onSessionComplete && process.sessionId) {
      this.onSessionComplete(process.sessionId).catch((error) => {
        const log = getLogger();
        log.warn(
          {
            event: "session_complete_callback_error",
            sessionId: process.sessionId,
            error: error instanceof Error ? error.message : String(error),
          },
          "onSessionComplete callback failed",
        );
      });
    }

    // Emit worker activity after unregistering (worker removed)
    this.emitWorkerActivity();

    // Process queue when a worker becomes available
    void this.processQueue();
  }

  /**
   * Add a terminated process to the tracking list.
   * Prunes old entries and caps at MAX_TERMINATED_PROCESSES.
   */
  private addTerminatedProcess(info: ProcessInfo): void {
    this.terminatedProcesses.push(info);

    // Cap at max entries
    if (this.terminatedProcesses.length > MAX_TERMINATED_PROCESSES) {
      this.terminatedProcesses = this.terminatedProcesses.slice(
        -MAX_TERMINATED_PROCESSES,
      );
    }
  }

  /**
   * Get recently terminated processes (within retention window).
   * Prunes expired entries before returning.
   */
  getRecentlyTerminatedProcesses(): ProcessInfo[] {
    const now = Date.now();
    const cutoff = now - TERMINATED_RETENTION_MS;

    // Prune old entries
    this.terminatedProcesses = this.terminatedProcesses.filter((p) => {
      if (!p.terminatedAt) return false;
      return new Date(p.terminatedAt).getTime() > cutoff;
    });

    return [...this.terminatedProcesses];
  }

  private emitOwnershipChange(
    sessionId: string,
    projectId: UrlProjectId,
    ownership: SessionOwnership,
  ): void {
    if (!this.eventBus) return;

    const event: SessionStatusEvent = {
      type: "session-status-changed",
      sessionId,
      projectId,
      ownership,
      timestamp: new Date().toISOString(),
    };
    this.eventBus.emit(event);
  }

  private emitSessionCreated(
    process: Process,
    ownership: SessionOwnership,
  ): void {
    if (!this.eventBus) return;

    const now = new Date().toISOString();
    const optimistic = this.buildOptimisticSessionSeed(process);
    const session: SessionSummary = {
      id: process.sessionId,
      projectId: process.projectId,
      title: optimistic.title,
      fullTitle: optimistic.fullTitle,
      createdAt: now,
      updatedAt: now,
      messageCount: optimistic.messageCount,
      ownership,
      provider: process.provider,
    };

    const event: SessionCreatedEvent = {
      type: "session-created",
      session,
      timestamp: now,
    };
    this.eventBus.emit(event);
  }

  private buildOptimisticSessionSeed(process: Process): {
    title: string | null;
    fullTitle: string | null;
    messageCount: number;
  } {
    const history = process.getMessageHistory();
    const firstUser = history.find(
      (msg) => msg.type === "user" && typeof msg.message?.content === "string",
    );
    const firstContent = firstUser?.message?.content;
    const fullTitle =
      typeof firstContent === "string" ? firstContent.trim() : "";
    if (!fullTitle) {
      return { title: null, fullTitle: null, messageCount: 0 };
    }

    const title =
      fullTitle.length <= SESSION_TITLE_MAX_LENGTH
        ? fullTitle
        : `${fullTitle.slice(0, SESSION_TITLE_MAX_LENGTH - 3)}...`;

    return { title, fullTitle, messageCount: 1 };
  }

  private scheduleInitialSessionReconciliation(
    sessionId: string,
    projectId: UrlProjectId,
  ): void {
    if (!this.eventBus || !this.onSessionSummary) return;

    for (const delayMs of INITIAL_RECONCILE_DELAYS_MS) {
      const timer = setTimeout(() => {
        void this.emitReconciledSessionUpdate(sessionId, projectId);
      }, delayMs);
      timer.unref();
    }
  }

  private async emitReconciledSessionUpdate(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<void> {
    if (!this.eventBus || !this.onSessionSummary) return;

    const summary = await this.onSessionSummary(sessionId, projectId);
    if (!summary) return;

    const event: SessionUpdatedEvent = {
      type: "session-updated",
      sessionId,
      projectId,
      title: summary.title,
      messageCount: summary.messageCount,
      updatedAt: summary.updatedAt,
      contextUsage: summary.contextUsage,
      model: summary.model,
      timestamp: new Date().toISOString(),
    };
    this.eventBus.emit(event);
  }

  private emitAgentActivityChange(
    sessionId: string,
    projectId: UrlProjectId,
    activity: AgentActivity,
    pendingInputType?: PendingInputType,
  ): void {
    if (!this.eventBus) return;

    const event: ProcessStateEvent = {
      type: "process-state-changed",
      sessionId,
      projectId,
      activity,
      pendingInputType,
      timestamp: new Date().toISOString(),
    };
    this.eventBus.emit(event);
  }

  private emitProcessTerminated(
    sessionId: string,
    projectId: UrlProjectId,
    processId: string,
    provider: ProviderName,
    reason: string,
  ): void {
    if (!this.eventBus) return;

    const event: ProcessTerminatedEvent = {
      type: "process-terminated",
      sessionId,
      projectId,
      processId,
      provider,
      reason,
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
      (p) => p.state.type === "in-turn" || p.state.type === "waiting-input",
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

  // ============ Staleness Detection ============

  /**
   * Terminate processes stuck in "in-turn" with no SDK messages for too long.
   * This catches phantom processes where the underlying Claude process died
   * without the SDK iterator returning done or throwing.
   *
   * When process liveness checking is available (via spawn wrapper), we use
   * it to distinguish "process died silently" from "process is busy with a
   * long tool call". Only dead processes are terminated.
   */
  private terminateStaleProcesses(): void {
    const now = Date.now();

    for (const process of this.processes.values()) {
      if (process.state.type !== "in-turn") continue;
      if (process.isHeld) continue;

      const staleThresholdMs = getStaleInTurnThresholdMs(process.provider);
      const silentMs = now - process.lastMessageTime.getTime();
      if (silentMs < staleThresholdMs) continue;

      // If we can check process liveness, only terminate actually-dead processes.
      // A long-running tool call (e.g., CI wait) will be silent but the process
      // is still alive — don't kill it.
      const alive = process.isProcessAlive;
      if (alive === true) {
        // Process is alive but silent — likely executing a long tool call. Skip.
        continue;
      }

      const log = getLogger();

      if (alive === undefined) {
        // Liveness check unavailable — fall back to time-based heuristic
        log.warn(
          {
            event: "stale_process_detected",
            sessionId: process.sessionId,
            processId: process.id,
            projectId: process.projectId,
            provider: process.provider,
            silentMs,
            staleThresholdMs,
            startedAt: process.startedAt.toISOString(),
            lastMessageTime: process.lastMessageTime.toISOString(),
            livenessAvailable: false,
          },
          `Terminating stale process (no liveness check): ${process.sessionId} (no messages for ${Math.round(silentMs / 1000)}s)`,
        );
      } else {
        // alive === false — process is confirmed dead
        log.warn(
          {
            event: "stale_process_dead",
            sessionId: process.sessionId,
            processId: process.id,
            projectId: process.projectId,
            provider: process.provider,
            silentMs,
            staleThresholdMs,
            startedAt: process.startedAt.toISOString(),
            lastMessageTime: process.lastMessageTime.toISOString(),
          },
          `Terminating dead process: ${process.sessionId} (exited, silent for ${Math.round(silentMs / 1000)}s)`,
        );
      }

      process.terminate(
        `stale: no SDK messages for ${Math.round(silentMs / 1000)}s`,
      );
    }
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
    // Use provider if available (preferred)
    if (this.provider) {
      return this.startProviderSession(
        projectPath,
        projectId,
        message,
        resumeSessionId,
        permissionMode,
      );
    }

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
      (p) => p.state.type === "in-turn" || p.state.type === "waiting-input",
    );
    return {
      activeWorkers: this.processes.size,
      queueLength: this.workerQueue.length,
      hasActiveWork,
    };
  }
}
