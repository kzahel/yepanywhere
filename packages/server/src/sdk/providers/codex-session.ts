/**
 * A live Codex session: the state a running thread shares between the
 * session loop and the `AgentSession` controls, the client latch, and the
 * controls themselves.
 */

import {
  type ConversationContextTurn,
  type EffortLevel,
  hasInvocationCandidate,
  type McpAppProviderRequest,
  type ModelInfo,
  PROVIDER_WORK_ITEM_LIMIT,
  routerModelSupportsThinking,
  type SlashCommand,
} from "@yep-anywhere/shared";
import type { ProviderInstallationLease } from "../../services/ProviderInstallationCoordinator.js";
import { MessageQueue } from "../messageQueue.js";
import type {
  ProviderActivitySnapshot,
  ProviderCommandResult,
  ProviderLivenessProbeResult,
  SDKMessage,
  UserMessage,
} from "../types.js";
import type { AgentctlSessionEnvBridge } from "./agentctl-session-env.js";
import type { CodexAppServerClient } from "./codex-app-server-client.js";
import { log } from "./codex-log.js";
import type {
  ListMcpServerStatusParams,
  ListMcpServerStatusResponse,
  McpResourceReadParams,
  McpResourceReadResponse,
  McpServerToolCallParams,
  McpServerToolCallResponse,
  ThreadGoalGetParams,
  ThreadGoalGetResponse,
  ThreadReadParams,
  ThreadReadResponse,
  TurnInterruptParams,
  TurnInterruptResponse,
  TurnSettingsUpdateParams,
  TurnSettingsUpdateResponse,
  TurnSteerParams,
  TurnSteerResponse,
} from "./codex-protocol/index.js";
import { CodexProviderWorkTracker } from "./codex-provider-work.js";
import {
  type CodexConfigSource,
  mapEffortToReasoningEffort,
} from "./codex-session-config.js";
import {
  runCodexAccountCommand,
  runCodexGoalCommand,
  startCodexCompaction,
} from "./codex-session-commands.js";
import {
  type CodexSessionSkillInventory,
  type CodexTurnRuntimeState,
  withCodexTimeout,
} from "./codex-session-state.js";
import {
  createCodexSlashCommands,
  createCodexUserInputs,
} from "./codex-skill-inputs.js";
import { normalizePermissionMode } from "./codex-thread-params.js";
import {
  type AgentSession,
  inactiveProviderSessionOptionsResult,
  type StartSessionOptions,
} from "./types.js";

/**
 * Provider services a session uses. The provider builds these as arrow
 * functions that call its own methods when invoked, so a setter or a test
 * spy applied after construction still takes effect.
 */
export interface CodexSessionHost {
  readonly configSource: CodexConfigSource;
  getAvailableModels(): Promise<ModelInfo[]>;
  refreshCodexSkills(
    appServer: CodexAppServerClient,
    cwd: string,
    inventory: CodexSessionSkillInventory,
    forceReload: boolean,
  ): Promise<void>;
  extractTextFromMessage(message: unknown): string;
  /** The provider's session loop, which publishes the client it connects. */
  runSession(
    options: StartSessionOptions,
    queue: MessageQueue,
    signal: AbortSignal,
    runtimeState: CodexTurnRuntimeState,
    setActiveClient: (client: CodexAppServerClient) => void,
    setAgentctlSessionEnvBridge: (
      bridge: AgentctlSessionEnvBridge | null,
    ) => void,
    skillInventory: CodexSessionSkillInventory,
  ): AsyncIterableIterator<SDKMessage>;
}

export interface CodexSessionInit {
  host: CodexSessionHost;
  options: StartSessionOptions;
  /** Steering mode as configured when the session starts. */
  steeringMode: import("@yep-anywhere/shared").SteeringMode | undefined;
  /** MCP App hosting as configured when the session starts. */
  mcpAppViews: boolean;
  /** Held until the session ends or is aborted. */
  installationLease: ProviderInstallationLease;
}

export class CodexSession {
  readonly options: StartSessionOptions;
  readonly runtimeState: CodexTurnRuntimeState;
  readonly queue: MessageQueue;
  /** Resolves with the first published client, or null if the session ends first. */
  readonly initialActiveClient: Promise<CodexAppServerClient | null>;
  private readonly host: CodexSessionHost;
  private readonly installationLease: ProviderInstallationLease;
  private readonly abortController: AbortController;
  private readonly providerWork: CodexProviderWorkTracker;
  private readonly iterator: AsyncIterableIterator<SDKMessage>;
  private client: CodexAppServerClient | null = null;
  private goalCommandTail: Promise<void> = Promise.resolve();
  private resolveInitialActiveClient:
    | ((client: CodexAppServerClient | null) => void)
    | null = null;
  private agentctlSessionEnvBridge: AgentctlSessionEnvBridge | null = null;
  private readonly skillInventory: CodexSessionSkillInventory = {
    skills: [],
    stale: true,
  };

  constructor({
    host,
    options,
    steeringMode,
    mcpAppViews,
    installationLease,
  }: CodexSessionInit) {
    this.host = host;
    this.options = options;
    this.installationLease = installationLease;
    this.queue = new MessageQueue();
    this.abortController = new AbortController();
    this.runtimeState = {
      steeringMode,
      ...(options.routerLaunch
        ? { cyberAccessAccountKey: `aar:${options.routerLaunch.accountId}` }
        : {}),
      threadId: options.resumeSessionId ?? "",
      resolvedModel: options.model ?? "default",
      turnModelOverride: options.model ?? null,
      activeTurnId: null,
      pendingTurnStart: null,
      activePermissionMode: normalizePermissionMode(options.permissionMode),
      turnEffortOverride: options.effort,
      serviceTier: options.serviceTier || undefined,
      workspaceWriteSandboxPolicy: null,
      activeToolCallIds: new Set(),
      backgroundToolCallIds: new Set(),
      mcpAppViews,
      mcpAppModelContext: new Map(),
    };

    // Push initial message if provided
    if (options.initialMessage) {
      this.queue.push(options.initialMessage);
    }

    this.providerWork = new CodexProviderWorkTracker(
      () => this.options.onProviderRetentionChange?.(),
      async () => {
        const client = this.client;
        const threadId = this.runtimeState.threadId;
        if (!client || !threadId) return null;
        return await withCodexTimeout(
          client.request("thread/backgroundTerminals/list", {
            threadId,
            limit: PROVIDER_WORK_ITEM_LIMIT,
          }),
          5_000,
          "Codex background terminal list",
        );
      },
    );
    this.initialActiveClient = new Promise<CodexAppServerClient | null>(
      (resolve) => {
        this.resolveInitialActiveClient = resolve;
      },
    );
    const sessionIterator = host.runSession(
      options,
      this.queue,
      this.abortController.signal,
      this.runtimeState,
      (client) => this.publishClient(client),
      (bridge) => {
        this.agentctlSessionEnvBridge = bridge;
      },
      this.skillInventory,
    );
    this.iterator = this.releaseAfter(sessionIterator);
  }

  /** The connected client, or null before connect and after close. */
  get activeClient(): CodexAppServerClient | null {
    return this.client;
  }

  /** The `AgentSession` the provider returns for this session. */
  toAgentSession(): AgentSession {
    const session = this;
    return {
      iterator: this.iterator,
      queue: this.queue,
      abort: () => this.abort(),
      isProcessAlive: () => this.isProcessAlive(),
      getProviderRetention: () => this.providerWork.getSnapshot(),
      getProviderActivity: () => this.getProviderActivity(),
      get pid() {
        return session.client?.pid;
      },
      probeLiveness: () => this.probeLiveness(),
      publishAgentctlSessionId: (sessionId, browserDebugEnvironment) =>
        this.publishAgentctlSessionId(sessionId, browserDebugEnvironment),
      setEffort: (effort) => this.setEffort(effort),
      supportedModels: () => this.supportedModels(),
      effortUpdatesActiveTurn: true,
      setServiceTier: (serviceTier) => this.setServiceTier(serviceTier),
      setModel: (model) => this.setModel(model),
      setSessionOptions: async (requested) =>
        inactiveProviderSessionOptionsResult(
          requested,
          "Codex app-server exposes explicit thread names but no automatic title, recap, progress-summary, or prompt-suggestion generator",
        ),
      supportedCommands: () => this.supportedCommands(),
      appendConversationContext: (turns) =>
        this.appendConversationContext(turns),
      ...(this.runtimeState.mcpAppViews
        ? {
            mcpAppRequest: (request: McpAppProviderRequest) =>
              this.mcpAppRequest(request),
          }
        : {}),
      steer: (message) => this.steer(message),
      interrupt: () => this.interrupt(),
      runProviderCommand: (command, argument) =>
        this.runProviderCommand(command, argument),
    };
  }

  private settleInitialActiveClient(client: CodexAppServerClient | null): void {
    this.resolveInitialActiveClient?.(client);
    this.resolveInitialActiveClient = null;
  }

  /**
   * Adopt the client the session loop connected. A replacement client takes
   * over provider-work observation from the previous one.
   */
  private publishClient(client: CodexAppServerClient): void {
    if (client !== this.client) {
      this.client?.setNotificationObserver(null);
      this.providerWork.reset();
      client.setNotificationObserver((notification) =>
        this.providerWork.observe(notification, this.runtimeState.threadId),
      );
    }
    this.client = client;
    this.settleInitialActiveClient(client);
  }

  private async *releaseAfter(
    sessionIterator: AsyncIterableIterator<SDKMessage>,
  ): AsyncIterableIterator<SDKMessage> {
    try {
      yield* sessionIterator;
    } finally {
      this.settleInitialActiveClient(null);
      await this.installationLease.release();
    }
  }

  private async updateActiveTurnSettings(
    settings: Pick<TurnSettingsUpdateParams, "model" | "effort">,
  ): Promise<void> {
    const client = this.client;
    let turnId = this.runtimeState.activeTurnId;
    if (!turnId && this.runtimeState.pendingTurnStart) {
      turnId = await this.runtimeState.pendingTurnStart;
    }
    const threadId = this.runtimeState.threadId;
    if (!client || !threadId || !turnId) return;

    const response = await client.request<TurnSettingsUpdateResponse>(
      "turn/settings/update",
      {
        threadId,
        turnId,
        ...settings,
      } satisfies TurnSettingsUpdateParams,
    );
    if (response.status === "targetUnavailable") {
      log.debug(
        { threadId, turnId, settings },
        "Codex active turn ended before its settings update; retaining the selection for the next turn",
      );
    }
  }

  async abort(): Promise<void> {
    this.settleInitialActiveClient(null);
    if (
      this.client &&
      this.runtimeState.threadId &&
      this.runtimeState.activeTurnId
    ) {
      await withCodexTimeout(
        this.client.request<TurnInterruptResponse>("turn/interrupt", {
          threadId: this.runtimeState.threadId,
          turnId: this.runtimeState.activeTurnId,
        } satisfies TurnInterruptParams),
        750,
        "Codex turn interrupt during shutdown",
      ).catch((error) => {
        log.debug(
          { error, sessionId: this.runtimeState.threadId },
          "Codex turn interrupt did not complete before shutdown",
        );
      });
    }
    this.abortController.abort();
    await this.client?.close();
    await this.installationLease.release();
  }

  isProcessAlive(): boolean {
    return this.client?.isAlive() ?? false;
  }

  getProviderActivity(): ProviderActivitySnapshot {
    return (
      this.client?.getProviderActivity() ?? {
        lastRawProviderEventAt: null,
        lastRawProviderEventSource: null,
      }
    );
  }

  async probeLiveness(): Promise<ProviderLivenessProbeResult> {
    const activeClient = this.client;
    const checkedAt = new Date();
    const source = "codex:thread/read";

    if (!activeClient?.isAlive()) {
      return {
        status: "unavailable",
        source,
        checkedAt,
        detail: "Codex app-server is not alive",
      };
    }
    if (!this.runtimeState.threadId) {
      return {
        status: "unavailable",
        source,
        checkedAt,
        detail: "No Codex thread id is available",
      };
    }

    try {
      const response = await activeClient.request<ThreadReadResponse>(
        "thread/read",
        {
          threadId: this.runtimeState.threadId,
          includeTurns: false,
        } satisfies ThreadReadParams,
      );
      const status =
        response.thread?.status && typeof response.thread.status === "object"
          ? (response.thread.status as {
              type?: string;
              activeFlags?: unknown;
            })
          : null;
      const statusType = status?.type;
      const activeFlags = Array.isArray(status?.activeFlags)
        ? status.activeFlags.filter(
            (flag): flag is string => typeof flag === "string",
          )
        : [];
      const mappedStatus = mapCodexThreadStatusToLiveness(
        statusType,
        activeFlags,
      );

      if (mappedStatus === "idle" && this.runtimeState.activeTurnId) {
        activeClient.injectNotification({
          method: "turn/completed",
          params: {
            threadId: this.runtimeState.threadId,
            turn: {
              id: this.runtimeState.activeTurnId,
              items: [],
              status: "completed",
              error: null,
              startedAt: null,
              completedAt: null,
              durationMs: null,
            },
          },
        });
      }

      return {
        status: mappedStatus,
        source,
        checkedAt,
        detail: formatCodexThreadStatusProbeDetail(statusType, activeFlags),
      };
    } catch (error) {
      return {
        status: "error",
        source,
        checkedAt,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  publishAgentctlSessionId(
    sessionId: string,
    browserDebugEnvironment?: Record<string, string>,
  ): void {
    this.agentctlSessionEnvBridge?.publishSessionId(
      sessionId,
      browserDebugEnvironment,
    );
  }

  async setEffort(effort?: EffortLevel): Promise<void> {
    if (effort === "max" && !this.options.routerLaunch)
      await this.host.getAvailableModels();
    if (this.runtimeState.activeTurnHasEffortOverride) {
      this.runtimeState.turnEffortOverride = effort ?? null;
      const model = (
        this.options.routerLaunch
          ? (this.options.routerLaunch.models ?? [])
          : await this.host.getAvailableModels()
      ).find((candidate) => candidate.id === this.runtimeState.resolvedModel);
      await this.client?.request("thread/settings/update", {
        threadId: this.runtimeState.threadId,
        effort:
          mapEffortToReasoningEffort(
            this.host.configSource,
            effort,
            this.options.thinking,
            this.runtimeState.resolvedModel,
            this.options.routerLaunch?.models,
          ) ?? model?.defaultReasoningEffort,
      });
      return;
    }
    if (effort !== undefined) {
      try {
        await this.updateActiveTurnSettings({
          effort: mapEffortToReasoningEffort(
            this.host.configSource,
            effort,
            this.options.thinking,
            this.runtimeState.turnModelOverride ??
              this.runtimeState.resolvedModel,
            this.options.routerLaunch?.models,
          ),
        });
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("jsonRpcCode" in error) ||
          error.jsonRpcCode !== -32600
        ) {
          throw error;
        }
        // Live-turn restrictions do not reject the next turn's selection.
        log.info(
          {
            threadId: this.runtimeState.threadId,
            effort,
            reason: error.message,
          },
          "Codex refused live effort update; retaining selection for the next turn",
        );
      }
    }
    this.runtimeState.turnEffortOverride = effort ?? null;
  }

  async supportedModels(): Promise<ModelInfo[]> {
    return this.options.routerLaunch
      ? (this.options.routerLaunch.models ?? [])
      : this.host.getAvailableModels();
  }

  async setServiceTier(serviceTier?: string): Promise<void> {
    const next = serviceTier || null;
    // Thread settings apply from the next turn. Resume restores them only
    // from Codex 0.164.0, so later turn/start requests carry the
    // selection too.
    if (this.client && this.runtimeState.threadId) {
      await this.client.request("thread/settings/update", {
        threadId: this.runtimeState.threadId,
        serviceTier: next,
      });
    }
    this.runtimeState.serviceTier = next;
  }

  async setModel(model?: string): Promise<void> {
    if (
      this.options.routerLaunch?.models &&
      !routerModelSupportsThinking(
        this.options.routerLaunch.models.find((m) => m.id === model),
        this.runtimeState.turnEffortOverride
          ? `on:${this.runtimeState.turnEffortOverride}`
          : "auto",
      )
    )
      throw new Error("Model unavailable for the pinned account");
    if (model !== undefined) {
      await this.updateActiveTurnSettings({ model });
    }
    this.runtimeState.turnModelOverride = model ?? null;
  }

  async supportedCommands(): Promise<SlashCommand[]> {
    if (this.client) {
      await this.host.refreshCodexSkills(
        this.client,
        this.options.cwd,
        this.skillInventory,
        this.skillInventory.stale,
      );
      if (this.runtimeState.threadId) {
        try {
          const { goal } = await this.client.request<ThreadGoalGetResponse>(
            "thread/goal/get",
            {
              threadId: this.runtimeState.threadId,
            } satisfies ThreadGoalGetParams,
          );
          this.runtimeState.goalObjective = goal?.objective ?? null;
          this.runtimeState.goalStatus = goal?.status ?? null;
        } catch (error) {
          log.debug({ error }, "Codex goal completion is unavailable");
        }
      }
    }
    return createCodexSlashCommands(
      this.skillInventory.skills,
      this.skillInventory.stale ? "stale" : "current",
      this.runtimeState.goalObjective,
      this.runtimeState.goalStatus,
    );
  }

  async appendConversationContext(
    turns: ConversationContextTurn[],
  ): Promise<boolean> {
    if (!this.client || !this.runtimeState.threadId) {
      throw new Error("Codex session is not ready for history insertion");
    }
    try {
      await this.client.request("thread/inject_items", {
        threadId: this.runtimeState.threadId,
        items: turns.map(({ role, text }) => ({
          type: "message",
          role,
          content: [
            {
              type: role === "assistant" ? "output_text" : "input_text",
              text,
            },
          ],
        })),
      });
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        "jsonRpcCode" in error &&
        error.jsonRpcCode === -32601
      ) {
        return false;
      }
      throw error;
    }
  }

  async mcpAppRequest(request: McpAppProviderRequest): Promise<unknown> {
    const threadId = this.runtimeState.threadId;
    if (!this.client || !threadId) {
      throw new Error("Codex session is not ready for MCP Apps");
    }
    switch (request.kind) {
      case "readResource":
        return this.client.request<McpResourceReadResponse>(
          "mcpServer/resource/read",
          {
            threadId,
            server: request.server,
            uri: request.uri,
            originCallId: request.originCallId ?? null,
          } satisfies McpResourceReadParams,
        );
      case "callTool":
        return this.client.request<McpServerToolCallResponse>(
          "mcpServer/tool/call",
          {
            threadId,
            server: request.server,
            tool: request.tool,
            arguments: (request.arguments ??
              {}) as McpServerToolCallParams["arguments"],
          } satisfies McpServerToolCallParams,
        );
      case "listTools": {
        const status = await this.client.request<ListMcpServerStatusResponse>(
          "mcpServerStatus/list",
          {
            threadId,
            serverName: request.server,
            detail: "toolsAndAuthOnly",
          } satisfies ListMcpServerStatusParams,
        );
        return (
          status.data.find((entry) => entry.name === request.server)?.tools ??
          {}
        );
      }
      case "updateModelContext":
        if (request.text === null) {
          this.runtimeState.mcpAppModelContext.delete(request.key);
        } else {
          this.runtimeState.mcpAppModelContext.set(request.key, {
            server: request.server,
            tool: request.tool,
            text: request.text,
          });
        }
        return true;
    }
  }

  async steer(message: UserMessage): Promise<boolean> {
    if (!this.client) return false;
    if (!this.runtimeState.threadId || !this.runtimeState.activeTurnId)
      return false;

    let userPrompt = this.host.extractTextFromMessage(message);
    if (!userPrompt) return true;

    try {
      if (hasInvocationCandidate(userPrompt)) {
        await this.host.refreshCodexSkills(
          this.client,
          this.options.cwd,
          this.skillInventory,
          true,
        );
      }
      const prepared = createCodexUserInputs(
        userPrompt,
        this.skillInventory.skills,
        this.skillInventory.stale ? "stale" : "current",
      );
      userPrompt = prepared.text;
      let expectedTurnId = this.runtimeState.activeTurnId;
      let retriedAfterMismatch = false;
      let steerResult: TurnSteerResponse;
      while (true) {
        try {
          steerResult = await this.client.request<TurnSteerResponse>(
            "turn/steer",
            {
              threadId: this.runtimeState.threadId,
              clientUserMessageId: message.uuid ?? null,
              input: prepared.input,
              expectedTurnId,
            } satisfies TurnSteerParams,
          );
          break;
        } catch (error) {
          const actualTurnId = getCodexActiveTurnMismatchId(error);
          if (actualTurnId && actualTurnId !== expectedTurnId) {
            this.runtimeState.activeTurnId = actualTurnId;
            if (!retriedAfterMismatch) {
              log.warn(
                {
                  threadId: this.runtimeState.threadId,
                  expectedTurnId,
                  actualTurnId,
                },
                "Resynchronized Codex turn id after steer mismatch",
              );
              expectedTurnId = actualTurnId;
              retriedAfterMismatch = true;
              continue;
            }
          }
          throw error;
        }
      }
      if (steerResult.turnId) {
        this.runtimeState.activeTurnId = steerResult.turnId;
      }
      return true;
    } catch (error) {
      log.warn(
        {
          threadId: this.runtimeState.threadId,
          turnId: this.runtimeState.activeTurnId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Codex turn/steer failed; caller should queue message instead",
      );
      return false;
    }
  }

  async interrupt(): Promise<boolean> {
    if (this.runtimeState.overloadRetryController) {
      this.runtimeState.overloadRetryController.abort();
      return true;
    }
    if (!this.client) return false;
    if (!this.runtimeState.threadId || !this.runtimeState.activeTurnId)
      return false;
    let turnId = this.runtimeState.activeTurnId;
    let retriedAfterMismatch = false;
    while (true) {
      try {
        await this.client.request<TurnInterruptResponse>("turn/interrupt", {
          threadId: this.runtimeState.threadId,
          turnId,
        } satisfies TurnInterruptParams);
        break;
      } catch (error) {
        const actualTurnId = getCodexActiveTurnMismatchId(error);
        if (actualTurnId && actualTurnId !== turnId) {
          this.runtimeState.activeTurnId = actualTurnId;
          if (!retriedAfterMismatch) {
            log.warn(
              {
                threadId: this.runtimeState.threadId,
                expectedTurnId: turnId,
                actualTurnId,
              },
              "Resynchronized Codex turn id after interrupt mismatch",
            );
            turnId = actualTurnId;
            retriedAfterMismatch = true;
            continue;
          }
        }
        throw error;
      }
    }
    return true;
  }

  async runProviderCommand(
    command: string,
    argument?: string,
  ): Promise<ProviderCommandResult> {
    const name = command.trim().replace(/^\/+/, "").toLowerCase();
    if (name === "goal") {
      const operation = this.goalCommandTail.then(() =>
        runCodexGoalCommand(this, argument),
      );
      // Serialize clear-and-set transactions; callers still receive failures.
      this.goalCommandTail = operation.then(
        () => {},
        () => {},
      );
      return operation;
    }

    if (name === "status" || name === "usage") {
      return runCodexAccountCommand(this, name, argument);
    }

    if (name !== "compact") {
      return { handled: false };
    }
    // Codex compaction takes no instructions, so any trailing argument is
    // intentionally dropped here — there is no app-server surface for it.
    return startCodexCompaction(this);
  }
}

function getCodexActiveTurnMismatchId(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const quotedPrefix = "expected active turn id `";
  const quotedSeparator = "` but found `";
  if (message.startsWith(quotedPrefix)) {
    const found = message.slice(quotedPrefix.length).split(quotedSeparator)[1];
    if (found?.endsWith("`")) return found.slice(0, -1) || null;
  }

  const plainPrefix = "expected active turn id ";
  const plainSeparator = " but found ";
  if (message.startsWith(plainPrefix)) {
    return message.slice(plainPrefix.length).split(plainSeparator)[1] || null;
  }
  return null;
}

function mapCodexThreadStatusToLiveness(
  statusType: string | undefined,
  activeFlags: string[],
): ProviderLivenessProbeResult["status"] {
  switch (statusType) {
    case "active":
      return activeFlags.includes("waitingOnApproval") ||
        activeFlags.includes("waitingOnUserInput")
        ? "waiting-input"
        : "active";
    case "idle":
      return "idle";
    case "notLoaded":
      return "not-loaded";
    case "systemError":
      return "system-error";
    default:
      return "error";
  }
}

function formatCodexThreadStatusProbeDetail(
  statusType: string | undefined,
  activeFlags: string[],
): string {
  if (!statusType) {
    return "thread.status:missing";
  }
  return activeFlags.length > 0
    ? `thread.status:${statusType} flags:${activeFlags.join(",")}`
    : `thread.status:${statusType}`;
}
