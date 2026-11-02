import { randomUUID } from "node:crypto";
import {
  agentCatalogRequest,
  AGENT_CATALOG_TIMEOUT_MS,
} from "../../agent-api/controller-protocol.js";
import { CoreApiError, type ApiReadPort } from "../../core-api/service.js";
import { operations } from "../../core-api/contracts.js";
import type {
  PermissionMode,
  SessionSandboxEnforcement,
} from "@yep-anywhere/shared";
import type { MessageQueue } from "../messageQueue.js";
import type {
  CanUseTool,
  ProviderActivitySnapshot,
  ProviderRetentionSnapshot,
  SDKMessage,
  ToolApprovalResult,
  UserMessage,
} from "../types.js";
import {
  pickStaticAgentEnvironment,
  type AgentctlSessionEnvBridge,
} from "./agentctl-session-env.js";
import { coalesceStreamingSnapshots } from "./streaming-snapshot-coalescing.js";
import {
  parseCreationRuntimeIdentity,
  sameCreationRuntimeIdentity,
  observeProviderInputIds,
  type CreationRuntimeIdentity,
  type CreationRuntimeEvidence,
} from "./creation-runtime-identity.js";
import { parseNativeSessionId } from "@yep-anywhere/shared";
import type {
  AgentSession,
  ProviderSessionOptions,
  ProviderSessionOptionsUpdateResult,
} from "./types.js";
import {
  PROVIDER_SESSION_OPTION_KEYS,
  resolveProviderSessionOptions,
  unknownProviderSessionOptionsResult,
} from "./types.js";

export const PROVIDER_SESSION_PROTOCOL_VERSION = 1;
export const MAX_UNACKNOWLEDGED_PROVIDER_EVENTS = 10_000;
export const MAX_UNACKNOWLEDGED_PROVIDER_BYTES = 64 * 1024 * 1024;

function snapshotKey(message: SDKMessage): string | null {
  return typeof message.uuid === "string" && message.uuid
    ? `${message.type}:${message.uuid}`
    : null;
}

interface BufferedEvent {
  sequence: number;
  message: SDKMessage;
  bytes: number;
  providerActivity: ProviderActivitySnapshot;
  providerRetention: ProviderRetentionSnapshot;
}

interface PendingApproval {
  requestId: string;
  toolName: string;
  input: unknown;
  permissionMode?: PermissionMode;
  resolve: (result: ToolApprovalResult) => void;
  removeAbortListener: () => void;
}

interface AuxiliarySubmission {
  submissionId: string;
  messageUuid: string;
  tempId: string;
  started: boolean;
  terminalOutcome?: string;
  lastProviderEventSequence?: number;
}

interface DeferredSubmission {
  submissionId: string;
  userMessage: UserMessage;
  sessionOptions: Required<ProviderSessionOptions>;
}

interface AttachedController {
  id: string;
  generation: string;
  write: (message: unknown) => void;
  isActive?: () => boolean;
}

export interface ProviderSessionSandboxMetadata {
  enforcement: SessionSandboxEnforcement;
  stateKey: string;
  projectPath: string;
}

export interface ProviderSessionReadyMetadata {
  creation?: CreationRuntimeEvidence;
  sessionId?: string;
  queueDepth: number;
  providerActivity: ProviderActivitySnapshot;
  providerRetention: ProviderRetentionSnapshot;
  capabilities: {
    agentApi?: boolean;
    peerAgentApi?: boolean;
    publishAgentSelfSelection?: boolean;
    publishAgentSessionViews?: boolean;
    probeLiveness: boolean;
    getProviderActivity: boolean;
    getProviderRetention: boolean;
    refreshPromptCache: boolean;
    publishAgentctlSessionId: boolean;
    steer: boolean;
    steerUsesMessageQueue?: boolean;
    appendConversationContext?: boolean;
    mcpAppRequest?: boolean;
    instructionRestoration?: boolean;
    setMaxThinkingTokens: boolean;
    setEffort: boolean;
    effortUpdatesActiveTurn?: boolean;
    setServiceTier?: boolean;
    setSessionOptions: boolean;
    interrupt: boolean;
    supportedModels: boolean;
    supportedCommands: boolean;
    getContextBreakdown?: boolean;
    setModel: boolean;
    runProviderCommand: boolean;
  };
  sandbox?: ProviderSessionSandboxMetadata;
  diagnostics?: Record<string, unknown>;
}

export interface ProviderSessionStartHooks {
  onAgentApiRead: ApiReadPort;
  onToolApproval: CanUseTool;
  onPermissionModeApplied: (mode: PermissionMode) => void;
  onProviderRetentionChange: () => void;
  shouldEmitLiveDeltas: () => boolean;
  getBrowserDebugEnvironment: () => Record<string, string>;
}

export interface ProviderSessionStartResult {
  session: AgentSession;
  sandbox?: ProviderSessionSandboxMetadata;
  diagnostics?: Record<string, unknown>;
  /**
   * Host-owned Bash bridge so every hosted provider publishes
   * `AGENTCTL_SESSION_ID`, including adapters that have no session method.
   */
  agentctlSessionEnvBridge?: AgentctlSessionEnvBridge;
}

export type StartOwnedProviderSession = (
  hooks: ProviderSessionStartHooks,
) => Promise<ProviderSessionStartResult>;

export interface ProviderSessionOwnerOptions {
  runtimeId: string;
  peerGrantId?: string;
  emitSupervisor?: (message: unknown) => void;
  onTerminal?: (reason: string, exitCode: number) => void | Promise<void>;
}

export interface ProviderSessionAttachedState {
  type: "attached";
  protocolVersion: number;
  runtimeId: string;
  acknowledgedSequence: number;
  activeProviderTurn: boolean;
  queueDepth: number;
  providerAlive: boolean;
  providerActivity: ProviderActivitySnapshot;
  providerRetention: ProviderRetentionSnapshot;
  appliedPermissionMode?: PermissionMode;
  /**
   * Canonical id the provider reported in its init message. A controller
   * attaching after that event was acknowledged never sees it replayed.
   */
  providerSessionId?: string;
  creation?: CreationRuntimeEvidence;
}

export function providerSessionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolvedPid(session: AgentSession): number | undefined {
  return typeof session.pid === "function" ? session.pid() : session.pid;
}

export class ProviderSessionOwner {
  private agentApiRevoked = false;
  private peerAgentApiRevoked = false;
  private attachedController: AttachedController | null = null;
  private session: AgentSession | null = null;
  private sequence = 0;
  private acknowledgedSequence = 0;
  private bufferedBytes = 0;
  private events: BufferedEvent[] = [];
  private snapshotEvents = new Map<string, BufferedEvent>();
  private pendingApprovals = new Map<string, PendingApproval>();
  /** At most 16 finite catalog requests per active controller attachment. */
  private pendingAgentReads = new Map<
    string,
    { controllerId: string; finish: (error?: Error, result?: unknown) => void }
  >();
  private queueDepth = 0;
  private providerAlive = true;
  private providerActivity: ProviderActivitySnapshot = {};
  private providerRetention: ProviderRetentionSnapshot = {
    retained: false,
    reasons: [],
  };
  private appliedPermissionMode: PermissionMode | undefined;
  private providerSessionId: string | undefined;
  private shuttingDown: Promise<void> | null = null;
  private unsubscribeQueueDepth: (() => void) | null = null;
  private unsubscribeQueueRemoved: (() => void) | null = null;
  private unsubscribeQueueYielded: (() => void) | null = null;
  private lastProviderPid: number | undefined;
  private observesQueueYield = false;
  private activeProviderTurn = false;
  private auxiliarySubmission: AuxiliarySubmission | null = null;
  private deferredSubmissions: DeferredSubmission[] = [];
  private browserDebugEnvironment: Record<string, string> = {};
  private iteratorStarted = false;
  private terminalSignalled = false;
  private sandboxMetadata: ProviderSessionSandboxMetadata | undefined;
  private diagnostics: Record<string, unknown> | undefined;
  private agentctlSessionEnvBridge: AgentctlSessionEnvBridge | null = null;
  private creationIdentity: CreationRuntimeIdentity | undefined;
  private creationInputConsumed = false;

  constructor(private readonly options: ProviderSessionOwnerOptions) {}

  setCreationIdentity(value: unknown): void {
    if (this.session || this.creationIdentity)
      throw new Error("Creation launch identity already bound");
    this.creationIdentity = parseCreationRuntimeIdentity(value);
  }

  protocolVersion(): number {
    return this.creationIdentity ? 2 : PROVIDER_SESSION_PROTOCOL_VERSION;
  }

  assertCreationIdentity(value: unknown): void {
    if (
      this.creationIdentity
        ? !sameCreationRuntimeIdentity(this.creationIdentity, value)
        : value !== undefined
    )
      throw new Error("Provider worker creation identity does not match");
  }

  creationEvidence(): CreationRuntimeEvidence | undefined {
    if (!this.creationIdentity) return undefined;
    return {
      identity: this.creationIdentity,
      nativeSessionId: this.providerSessionId
        ? parseNativeSessionId(this.providerSessionId)
        : undefined,
      initialInputConsumed: this.creationInputConsumed,
    };
  }

  private publishCreationEvidence(): void {
    const message = {
      type: "creationEvidence",
      creation: this.creationEvidence(),
    };
    this.emitSupervisor(message);
    this.emitController(message);
  }

  private bindCreationNativeId(id: string): void {
    const nativeId = parseNativeSessionId(id);
    if (
      (this.creationIdentity?.nativeSessionId &&
        this.creationIdentity.nativeSessionId !== nativeId) ||
      (this.providerSessionId && this.providerSessionId !== nativeId)
    )
      throw new Error(
        "Provider output conflicts with creation native identity",
      );
    if (this.providerSessionId === nativeId) return;
    this.providerSessionId = nativeId;
    this.publishCreationEvidence();
  }

  /** Set once from the immutable launch recipe, before a session exists. */
  setIssuedPeerGrantId(grantId: string | undefined) {
    if (this.session || this.options.peerGrantId)
      throw new Error("Peer launch grant already bound");
    this.options.peerGrantId = grantId;
  }

  async start(
    startSession: StartOwnedProviderSession,
    initialBrowserDebugEnvironment?: Record<string, string>,
  ): Promise<ProviderSessionReadyMetadata> {
    if (this.session) throw new Error("Provider session owner already started");
    this.browserDebugEnvironment = pickStaticAgentEnvironment(
      initialBrowserDebugEnvironment,
    );
    const result = await startSession({
      onAgentApiRead: (operation, _caller, input = {}) =>
        this.requestAgentApiRead(operation, input),
      onToolApproval: (toolName, input, approvalOptions) =>
        this.requestApproval(
          toolName,
          input,
          approvalOptions.permissionMode,
          approvalOptions.signal,
        ),
      onPermissionModeApplied: (mode) => {
        this.appliedPermissionMode = mode;
        this.emitController({ type: "permissionMode", mode });
      },
      onProviderRetentionChange: () => this.refreshRetention(),
      shouldEmitLiveDeltas: () => true,
      getBrowserDebugEnvironment: () => ({ ...this.browserDebugEnvironment }),
    });
    this.session = result.session;
    if (this.agentApiRevoked)
      void Promise.resolve(this.session.revokeAgentApiAccess?.()).catch(
        () => {},
      );
    if (this.peerAgentApiRevoked)
      void Promise.resolve(this.session.revokePeerAgentApiAccess?.()).catch(
        () => {},
      );
    this.sandboxMetadata = result.sandbox;
    this.diagnostics = result.diagnostics;
    this.agentctlSessionEnvBridge = result.agentctlSessionEnvBridge ?? null;
    try {
      if (this.creationIdentity) {
        this.agentctlSessionEnvBridge?.publishSessionId(
          this.creationIdentity.sessionId,
          this.browserDebugEnvironment,
        );
        await result.session.publishAgentctlSessionId?.(
          this.creationIdentity.sessionId,
          this.browserDebugEnvironment,
        );
      }
      if (this.creationIdentity && result.session.sessionId)
        this.bindCreationNativeId(result.session.sessionId);
    } catch (error) {
      // Keep the actual session for startup cleanup, but admit no more work.
      if (this.creationIdentity) this.providerAlive = false;
      throw error;
    }
    this.reportProviderPid();
    this.providerActivity = result.session.getProviderActivity?.() ?? {};
    this.providerRetention = result.session.getProviderRetention?.() ?? {
      retained: false,
      reasons: [],
    };
    this.queueDepth = result.session.queue.depth;
    this.observeQueueDepth(result.session.queue);
    return this.readyMetadata();
  }

  begin(): void {
    if (this.iteratorStarted) return;
    const session = this.requireSession();
    this.iteratorStarted = true;
    void this.drainProviderIterator(session);
    this.reportProviderPid();
  }

  readyMetadata(): ProviderSessionReadyMetadata {
    const session = this.requireSession();
    return {
      ...(this.creationIdentity ? { creation: this.creationEvidence() } : {}),
      sessionId: session.sessionId,
      queueDepth: this.queueDepth,
      providerActivity: this.providerActivity,
      providerRetention: this.providerRetention,
      capabilities: {
        agentApi: Boolean(session.revokeAgentApiAccess),
        peerAgentApi: Boolean(session.revokePeerAgentApiAccess),
        publishAgentSelfSelection: Boolean(session.publishAgentSelfSelection),
        publishAgentSessionViews: Boolean(session.publishAgentSessionViews),
        probeLiveness: Boolean(session.probeLiveness),
        getProviderActivity: Boolean(session.getProviderActivity),
        getProviderRetention: Boolean(session.getProviderRetention),
        refreshPromptCache: Boolean(session.refreshPromptCache),
        publishAgentctlSessionId: Boolean(
          session.publishAgentctlSessionId || this.agentctlSessionEnvBridge,
        ),
        steer: Boolean(session.steer),
        steerUsesMessageQueue: session.steerUsesMessageQueue,
        appendConversationContext: Boolean(session.appendConversationContext),
        mcpAppRequest: Boolean(session.mcpAppRequest),
        instructionRestoration: Boolean(
          session.configureInstructionRestoration &&
            session.forceReadInstructions,
        ),
        setMaxThinkingTokens: Boolean(session.setMaxThinkingTokens),
        setEffort: Boolean(session.setEffort),
        effortUpdatesActiveTurn: session.effortUpdatesActiveTurn === true,
        setServiceTier: Boolean(session.setServiceTier),
        setSessionOptions: Boolean(session.setSessionOptions),
        interrupt: Boolean(session.interrupt),
        supportedModels: Boolean(session.supportedModels),
        supportedCommands: Boolean(session.supportedCommands),
        getContextBreakdown: Boolean(session.getContextBreakdown),
        setModel: Boolean(session.setModel),
        runProviderCommand: Boolean(session.runProviderCommand),
      },
      sandbox: this.sandboxMetadata,
      diagnostics: this.diagnostics,
    };
  }

  providerPid(): number | undefined {
    return this.lastProviderPid;
  }

  attach(
    controllerId: string,
    generation: string,
    write: (message: unknown) => void,
    options: {
      emitAttached?: boolean;
      isActive?: () => boolean;
      agentApiAllowed?: boolean;
      agentApiPeersAllowed?: boolean;
      agentApiPeerGrantId?: string;
      creation?: unknown;
    } = {},
  ): ProviderSessionAttachedState {
    this.assertCreationIdentity(options.creation);
    if (!generation) throw new Error("Missing server generation");
    if (
      this.attachedController &&
      this.attachedController.isActive?.() !== false
    ) {
      throw new Error(
        `Provider worker is already attached to ${this.attachedController.generation}`,
      );
    }
    if (this.attachedController) this.detach(this.attachedController.id);
    this.attachedController = {
      id: controllerId,
      generation,
      write,
      isActive: options.isActive,
    };
    this.session?.setAgentApiControllerAttached?.(true);
    if (options.agentApiAllowed !== true) {
      this.agentApiRevoked = true;
      void Promise.resolve(this.session?.revokeAgentApiAccess?.()).catch(
        () => {},
      );
    }
    if (
      options.agentApiPeersAllowed !== true ||
      options.agentApiPeerGrantId !== this.options.peerGrantId
    ) {
      this.peerAgentApiRevoked = true;
      void Promise.resolve(this.session?.revokePeerAgentApiAccess?.()).catch(
        () => {},
      );
    }
    const state = this.attachedState();
    if (options.emitAttached !== false) write(state);
    for (const event of this.events) {
      write({
        type: "event",
        sequence: event.sequence,
        message: event.message,
        providerActivity: event.providerActivity,
        providerRetention: event.providerRetention,
      });
    }
    for (const approval of this.pendingApprovals.values()) {
      this.writeApproval(write, approval);
    }
    if (!this.providerAlive) write({ type: "complete" });
    return state;
  }

  detach(controllerId: string): void {
    if (this.attachedController?.id !== controllerId) return;
    const generation = this.attachedController.generation;
    this.session?.setAgentApiControllerAttached?.(false);
    for (const pending of [...this.pendingAgentReads.values()])
      pending.finish(
        new CoreApiError(
          "controller_unavailable",
          "Catalog controller detached",
          503,
        ),
      );
    this.attachedController = null;
    this.emitSupervisor({ type: "controllerDetached", generation });
  }

  handleSupervisorMessage(message: unknown): void {
    if (!message || typeof message !== "object" || !("type" in message)) return;
    if (message.type === "revokePeerAgentApi") {
      this.peerAgentApiRevoked = true;
      void Promise.resolve(this.session?.revokePeerAgentApiAccess?.()).catch(
        () => {},
      );
      return;
    }
    if (message.type === "revokeAgentApi") {
      this.agentApiRevoked = true;
      void Promise.resolve(this.session?.revokeAgentApiAccess?.()).catch(
        () => {},
      );
      return;
    }
    if (message.type === "sessionTurn") {
      void this.acceptAuxiliarySubmission(message as Record<string, unknown>);
      return;
    }
    if (message.type === "interruptSessionTurn") {
      void this.interruptAuxiliarySubmission(
        String((message as Record<string, unknown>).submissionId ?? ""),
      );
    }
  }

  async handleControllerRequest(
    controllerId: string,
    request: Record<string, unknown>,
  ): Promise<void> {
    if (this.attachedController?.id !== controllerId) {
      throw new Error("Stale provider worker controller");
    }
    if (request.type === "ack") {
      this.acknowledge(Number(request.sequence));
      return;
    }
    if (request.type === "queuePush") {
      if (this.auxiliarySubmission) {
        throw new Error("A provider-host session turn is already active");
      }
      this.requireSession().queue.push(request.message as UserMessage);
      return;
    }
    if (request.type === "removeQueued") {
      const queue = this.requireSession().queue as MessageQueue;
      queue.removeByTempId(String(request.tempId));
      return;
    }
    if (request.type === "approvalResult") {
      const pending = this.pendingApprovals.get(String(request.requestId));
      if (!pending) return;
      this.pendingApprovals.delete(pending.requestId);
      pending.removeAbortListener();
      pending.resolve(request.result as ToolApprovalResult);
      return;
    }
    if (request.type === "agentApiResult") {
      const pending = this.pendingAgentReads.get(String(request.requestId));
      if (pending?.controllerId === controllerId) {
        if (request.ok === true) pending.finish(undefined, request.result);
        else {
          pending.finish(
            CoreApiError.restore(request.error) ??
              new Error("API operation failed"),
          );
        }
      }
      return;
    }
    if (request.type !== "rpc" || typeof request.id !== "number") {
      throw new Error("Unknown provider worker request");
    }
    const result = await this.call(String(request.method), request.args);
    this.emitController({
      type: "rpcResult",
      id: request.id,
      ok: true,
      result,
    });
  }

  emitControllerError(request: Record<string, unknown>, error: unknown): void {
    const id = typeof request.id === "number" ? request.id : undefined;
    this.emitController({
      type: "rpcResult",
      id,
      ok: false,
      error: providerSessionErrorMessage(error),
    });
  }

  private attachedState(): ProviderSessionAttachedState {
    return {
      type: "attached",
      protocolVersion: this.protocolVersion(),
      runtimeId: this.options.runtimeId,
      acknowledgedSequence: this.acknowledgedSequence,
      activeProviderTurn: this.activeProviderTurn,
      queueDepth: this.queueDepth,
      providerAlive: this.providerAlive,
      providerActivity: this.providerActivity,
      providerRetention: this.providerRetention,
      appliedPermissionMode: this.appliedPermissionMode,
      providerSessionId: this.providerSessionId,
      ...(this.creationIdentity ? { creation: this.creationEvidence() } : {}),
    };
  }

  private async drainProviderIterator(session: AgentSession): Promise<void> {
    try {
      for await (const message of coalesceStreamingSnapshots(
        session.iterator,
      )) {
        if (this.shuttingDown) return;
        this.providerActivity = session.getProviderActivity?.() ?? {};
        this.providerRetention = session.getProviderRetention?.() ?? {
          retained: false,
          reasons: [],
        };
        this.reportProviderPid();
        this.bufferEvent(message);
        if (message.type === "result") {
          this.activeProviderTurn = false;
          this.drainDeferredSubmissions();
        }
      }
      if (this.shuttingDown) return;
      this.providerAlive = false;
      this.emitController({ type: "complete" });
      this.signalTerminal("provider iterator completed", 0);
    } catch (error) {
      if (this.shuttingDown) return;
      this.providerAlive = false;
      try {
        this.emitController({
          type: "failed",
          error: providerSessionErrorMessage(error),
        });
      } catch {
        // A failed transport cannot receive the terminal provider frame, but
        // it must not prevent the shared owner from tearing the session down.
      }
      this.signalTerminal("provider iterator failed", 1);
    }
  }

  private bufferEvent(message: SDKMessage): void {
    if (this.creationIdentity) {
      if (message.session_id) this.bindCreationNativeId(message.session_id);
      if (message.type === "user" && !this.providerSessionId)
        throw new Error("Provider input arrived before native binding");
      if (this.providerSessionId && !this.creationInputConsumed) {
        observeProviderInputIds(
          message,
          this.creationIdentity.nativeNamespace.family === "claude",
          (id) => {
            if (
              id !== this.creationIdentity!.initialInputId ||
              this.creationInputConsumed
            )
              return;
            this.creationInputConsumed = true;
            this.publishCreationEvidence();
          },
        );
      }
      if (
        this.creationIdentity.nativeNamespace.family === "claude" &&
        message.type === "assistant" &&
        message.isApiErrorMessage === true
      ) {
        this.providerAlive = false;
        this.signalTerminal("provider native API failure", 1);
      }
    }
    if (
      !this.creationIdentity &&
      message.type === "system" &&
      message.subtype === "init" &&
      typeof message.session_id === "string"
    ) {
      this.providerSessionId = message.session_id;
      this.agentctlSessionEnvBridge?.publishSessionId(
        message.session_id,
        this.browserDebugEnvironment,
      );
    }
    const sequence = ++this.sequence;
    const bytes = Buffer.byteLength(JSON.stringify(message));
    const event: BufferedEvent = {
      sequence,
      message,
      bytes,
      providerActivity: this.providerActivity,
      providerRetention: this.providerRetention,
    };
    this.pruneSupersededSnapshot(message, event);
    this.events.push(event);
    this.bufferedBytes += bytes;
    if (
      this.events.length > MAX_UNACKNOWLEDGED_PROVIDER_EVENTS ||
      this.bufferedBytes > MAX_UNACKNOWLEDGED_PROVIDER_BYTES
    ) {
      this.emitController({
        type: "failed",
        error: `Provider reload replay buffer exceeded its bound (${this.events.length} unacknowledged events, ${this.bufferedBytes} bytes)`,
      });
      this.signalTerminal("replay buffer exceeded", 1);
      return;
    }
    this.emitController({
      type: "event",
      sequence,
      message,
      providerActivity: this.providerActivity,
      providerRetention: this.providerRetention,
    });
    const auxiliary = this.auxiliarySubmission;
    if (!auxiliary?.started) return;
    auxiliary.lastProviderEventSequence = sequence;
    this.emitSupervisor({
      type: "sessionTurnEvent",
      submissionId: auxiliary.submissionId,
      sequence,
      message,
    });
    if (message.type === "result") {
      const providerFailed =
        Boolean(message.error) ||
        /error|fail/i.test(String(message.subtype ?? ""));
      this.finishAuxiliarySubmission(
        auxiliary.terminalOutcome ??
          (providerFailed ? "provider-failed" : "completed"),
        providerFailed
          ? providerSessionErrorMessage(message.error ?? message.subtype)
          : undefined,
      );
    }
  }

  private observeQueueDepth(queue: AgentSession["queue"]): void {
    const concrete = queue as MessageQueue;
    if (typeof concrete.subscribeDepth !== "function") return;
    this.unsubscribeQueueDepth = concrete.subscribeDepth((depth) => {
      this.queueDepth = depth;
      this.emitController({ type: "queueDepth", depth });
      queueMicrotask(() => this.drainDeferredSubmissions());
    });
    if (typeof concrete.subscribeRemoved === "function") {
      this.unsubscribeQueueRemoved = concrete.subscribeRemoved((messages) => {
        this.emitController({
          type: "queueRemoved",
          uuids: messages.flatMap((message) =>
            message.uuid ? [message.uuid] : [],
          ),
        });
        const auxiliary = this.auxiliarySubmission;
        if (
          auxiliary &&
          !auxiliary.started &&
          messages.some((message) => message.uuid === auxiliary.messageUuid)
        ) {
          this.finishAuxiliarySubmission("interrupted");
        }
      });
    }
    if (typeof concrete.subscribeYielded === "function") {
      this.observesQueueYield = true;
      this.unsubscribeQueueYielded = concrete.subscribeYielded((messages) => {
        this.activeProviderTurn = true;
        this.emitController({
          type: "queueYielded",
          uuids: messages.flatMap((message) =>
            message.uuid ? [message.uuid] : [],
          ),
        });
        const auxiliary = this.auxiliarySubmission;
        if (
          !auxiliary ||
          !messages.some((message) => message.uuid === auxiliary.messageUuid)
        ) {
          return;
        }
        auxiliary.started = true;
        if (messages.length > 1) {
          auxiliary.terminalOutcome = "uncertain-after-acceptance";
        }
        this.emitSupervisor({
          type: "sessionTurnStarted",
          submissionId: auxiliary.submissionId,
        });
      });
    }
  }

  private async acceptAuxiliarySubmission(
    message: Record<string, unknown>,
  ): Promise<void> {
    const submissionId = String(message.submissionId ?? "");
    const userMessage = message.message as UserMessage | undefined;
    const reject = (outcome: string, error: string) =>
      this.emitSupervisor({
        type: "sessionTurnRejected",
        submissionId,
        outcome,
        error,
      });
    if (!submissionId || !userMessage || typeof userMessage.text !== "string") {
      reject("rejected", "Invalid session-turn submission");
      return;
    }
    if (!userMessage.text.trim()) {
      reject("rejected", "Session-turn text is empty");
      return;
    }
    let requestedSessionOptions: Required<ProviderSessionOptions>;
    try {
      const rawSessionOptions = message.sessionOptions;
      if (
        rawSessionOptions !== undefined &&
        (!rawSessionOptions || typeof rawSessionOptions !== "object")
      ) {
        throw new Error("sessionOptions must be an object");
      }
      const candidate = (rawSessionOptions ?? {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(candidate)) {
        if (
          !PROVIDER_SESSION_OPTION_KEYS.includes(
            key as (typeof PROVIDER_SESSION_OPTION_KEYS)[number],
          ) ||
          typeof value !== "boolean"
        ) {
          throw new Error(`Invalid provider session option ${key}`);
        }
      }
      requestedSessionOptions = resolveProviderSessionOptions(
        candidate as ProviderSessionOptions,
      );
    } catch (error) {
      reject("rejected", providerSessionErrorMessage(error));
      return;
    }
    if (
      !this.providerAlive ||
      !this.session ||
      this.shuttingDown ||
      this.terminalSignalled
    ) {
      reject(
        message.eventual === true || message.liveOnly === true
          ? "not-alive"
          : "unavailable",
        "Provider session is not alive",
      );
      return;
    }
    if (!this.observesQueueYield) {
      reject(
        "unavailable",
        "Provider queue cannot prove the session-turn start boundary",
      );
      return;
    }
    if (message.eventual === true) {
      if (this.deferredSubmissions.length >= 1000) {
        reject("busy", "Provider deferred submission queue is full");
        return;
      }
      this.deferredSubmissions.push({
        submissionId,
        userMessage,
        sessionOptions: requestedSessionOptions,
      });
      this.emitSupervisor({
        type: "sessionTurnAccepted",
        submissionId,
        delivery: "queued",
      });
      this.drainDeferredSubmissions();
      return;
    }
    if (
      this.auxiliarySubmission ||
      this.deferredSubmissions.length > 0 ||
      this.activeProviderTurn ||
      this.queueDepth > 0
    ) {
      reject("busy", "Provider session is not idle");
      return;
    }
    if (this.pendingApprovals.size > 0) {
      reject(
        "provider-approval-required",
        "Provider approval is already pending",
      );
      return;
    }
    await this.startAuxiliarySubmission(
      submissionId,
      userMessage,
      requestedSessionOptions,
      false,
    );
  }

  private drainDeferredSubmissions(): void {
    if (
      this.shuttingDown ||
      this.terminalSignalled ||
      !this.providerAlive ||
      this.auxiliarySubmission ||
      this.activeProviderTurn ||
      this.queueDepth > 0 ||
      this.pendingApprovals.size > 0
    )
      return;
    const next = this.deferredSubmissions.shift();
    if (next)
      void this.startAuxiliarySubmission(
        next.submissionId,
        next.userMessage,
        next.sessionOptions,
        true,
      );
  }

  private async startAuxiliarySubmission(
    submissionId: string,
    userMessage: UserMessage,
    requestedSessionOptions: Required<ProviderSessionOptions>,
    alreadyAccepted: boolean,
  ): Promise<void> {
    const session = this.requireSession();
    const messageUuid = randomUUID();
    const tempId = `provider-host:${submissionId}`;
    const auxiliarySubmission: AuxiliarySubmission = {
      submissionId,
      messageUuid,
      tempId,
      started: false,
    };
    this.auxiliarySubmission = auxiliarySubmission;
    let sessionOptionsResult: ProviderSessionOptionsUpdateResult;
    try {
      sessionOptionsResult = session.setSessionOptions
        ? await session.setSessionOptions(requestedSessionOptions)
        : unknownProviderSessionOptionsResult(
            requestedSessionOptions,
            "This provider adapter has no session-option control implementation",
          );
    } catch (error) {
      if (this.auxiliarySubmission !== auxiliarySubmission) return;
      const detail = `Provider session options failed: ${providerSessionErrorMessage(error)}`;
      if (alreadyAccepted)
        this.finishAuxiliarySubmission("provider-failed", detail);
      else {
        this.auxiliarySubmission = null;
        this.emitSupervisor({
          type: "sessionTurnRejected",
          submissionId,
          outcome: "rejected",
          error: detail,
        });
      }
      this.drainDeferredSubmissions();
      return;
    }
    if (this.auxiliarySubmission !== auxiliarySubmission) return;
    this.requireSession().queue.push({
      ...userMessage,
      uuid: messageUuid,
      tempId,
    });
    this.emitSupervisor({
      type: alreadyAccepted ? "sessionTurnReady" : "sessionTurnAccepted",
      submissionId,
      sessionOptionsResult,
    });
  }

  private async interruptAuxiliarySubmission(
    submissionId: string,
  ): Promise<void> {
    const deferredIndex = this.deferredSubmissions.findIndex(
      (item) => item.submissionId === submissionId,
    );
    if (deferredIndex >= 0) {
      this.deferredSubmissions.splice(deferredIndex, 1);
      this.emitSupervisor({
        type: "sessionTurnTerminal",
        submissionId,
        outcome: "interrupted",
      });
      return;
    }
    const auxiliary = this.auxiliarySubmission;
    if (!auxiliary || auxiliary.submissionId !== submissionId) return;
    if (!auxiliary.started) {
      const queue = this.requireSession().queue as MessageQueue;
      queue.removeByTempId(auxiliary.tempId);
      if (this.auxiliarySubmission === auxiliary) {
        this.finishAuxiliarySubmission("interrupted");
      }
      return;
    }
    if (!this.session?.interrupt) {
      auxiliary.terminalOutcome = "uncertain-after-acceptance";
      return;
    }
    auxiliary.terminalOutcome = "interrupted";
    try {
      await this.session.interrupt();
    } catch {
      auxiliary.terminalOutcome = "uncertain-after-acceptance";
    }
  }

  private finishAuxiliarySubmission(outcome: string, error?: string): void {
    const auxiliary = this.auxiliarySubmission;
    if (!auxiliary) return;
    this.auxiliarySubmission = null;
    this.emitSupervisor({
      type: "sessionTurnTerminal",
      submissionId: auxiliary.submissionId,
      outcome,
      error,
      providerSessionId: this.session?.sessionId,
      lastProviderEventSequence: auxiliary.lastProviderEventSequence,
    });
    queueMicrotask(() => this.drainDeferredSubmissions());
  }

  /**
   * A streaming snapshot (`_isStreaming` with a `uuid`) is replaced wholesale
   * by the next same-id message, so replay after a reload needs only the
   * latest one. Dropping the unacknowledged predecessors keeps a long
   * streamed output from filling the replay bound while Hono is merely slow
   * to consume; the live controller already received every snapshot.
   */
  private pruneSupersededSnapshot(
    message: SDKMessage,
    event: BufferedEvent,
  ): void {
    const key = snapshotKey(message);
    if (!key) return;
    const previous = this.snapshotEvents.get(key);
    if (previous) {
      const index = this.events.lastIndexOf(previous);
      if (index >= 0) {
        this.events.splice(index, 1);
        this.bufferedBytes -= previous.bytes;
      }
    }
    if (message._isStreaming === true) this.snapshotEvents.set(key, event);
    else this.snapshotEvents.delete(key);
  }

  private acknowledge(sequence: number): void {
    if (!Number.isInteger(sequence) || sequence <= this.acknowledgedSequence) {
      return;
    }
    if (sequence > this.sequence) {
      throw new Error(
        "Provider worker received an invalid event acknowledgement",
      );
    }
    this.acknowledgedSequence = sequence;
    let removeCount = 0;
    let removeBytes = 0;
    for (const event of this.events) {
      if (event.sequence > sequence) break;
      removeCount += 1;
      removeBytes += event.bytes;
      const key = snapshotKey(event.message);
      if (key && this.snapshotEvents.get(key) === event) {
        this.snapshotEvents.delete(key);
      }
    }
    if (removeCount > 0) {
      this.events.splice(0, removeCount);
      this.bufferedBytes -= removeBytes;
    }
  }

  private async call(method: string, rawArgs: unknown): Promise<unknown> {
    const session = this.requireSession();
    const args = Array.isArray(rawArgs) ? rawArgs : [];
    switch (method) {
      case "publishAgentSelfSelection":
        return await session.publishAgentSelfSelection?.(
          args[0] as import("../../agent-tools/protocol.js").AgentSelfSelection,
        );
      case "revokePeerAgentApiAccess": {
        const grantId = typeof args[0] === "string" ? args[0] : undefined;
        if (grantId && grantId !== this.options.peerGrantId) return;
        this.peerAgentApiRevoked = true;
        return await session.revokePeerAgentApiAccess?.(grantId);
      }
      case "revokeAgentApiAccess":
        return await session.revokeAgentApiAccess?.();
      case "publishAgentSessionViews":
        return await session.publishAgentSessionViews?.(
          args[0] as import("@yep-anywhere/shared").SessionClientView[],
        );
      case "drainQueue":
        return session.queue.drain();
      case "probeLiveness":
        return await session.probeLiveness?.();
      case "refreshPromptCache":
        return await session.refreshPromptCache?.(
          args[0] as { sessionId: string },
        );
      case "publishAgentctlSessionId": {
        const sessionId = String(args[0]);
        if (
          this.creationIdentity &&
          sessionId !== this.creationIdentity.sessionId
        )
          throw new Error("Agent child identity must use the YA session id");
        const requestedEnvironment = args[1];
        if (
          requestedEnvironment &&
          typeof requestedEnvironment === "object" &&
          !Array.isArray(requestedEnvironment)
        ) {
          this.browserDebugEnvironment = pickStaticAgentEnvironment(
            requestedEnvironment as Record<string, string>,
          );
        }
        this.agentctlSessionEnvBridge?.publishSessionId(
          sessionId,
          this.browserDebugEnvironment,
        );
        await session.publishAgentctlSessionId?.(
          sessionId,
          this.browserDebugEnvironment,
        );
        if (!this.creationIdentity)
          this.emitSupervisor({ type: "bound", sessionId });
        return undefined;
      }
      case "steer":
        if (this.auxiliarySubmission) {
          throw new Error("A provider-host session turn is already active");
        }
        return await session.steer?.(args[0] as UserMessage);
      case "appendConversationContext":
        return session.appendConversationContext
          ? await session.appendConversationContext(
              args[0] as Parameters<
                NonNullable<AgentSession["appendConversationContext"]>
              >[0],
            )
          : false;
      case "mcpAppRequest":
        if (!session.mcpAppRequest)
          throw new Error("MCP App hosting is unavailable for this session");
        return session.mcpAppRequest(
          args[0] as Parameters<NonNullable<AgentSession["mcpAppRequest"]>>[0],
        );
      case "hydrateInstructionReadHistory":
        if (!session.hydrateInstructionReadHistory)
          throw new Error("Instruction history hydration is unavailable");
        return session.hydrateInstructionReadHistory(
          args[0] as SDKMessage[],
          args[1] === true,
        );
      case "configureInstructionRestoration":
        if (!session.configureInstructionRestoration)
          throw new Error("Instruction restoration is unavailable");
        return session.configureInstructionRestoration(
          args[0] as import("./instruction-restoration.js").InstructionRestorationControl,
        );
      case "forceReadInstructions":
        if (!session.forceReadInstructions)
          throw new Error("Instruction force read is unavailable");
        return session.forceReadInstructions(args[0] as string[]);
      case "setMaxThinkingTokens":
        return await session.setMaxThinkingTokens?.(args[0] as number | null);
      case "setEffort":
        return await session.setEffort?.(
          (args[0] ?? undefined) as Parameters<
            NonNullable<AgentSession["setEffort"]>
          >[0],
        );
      case "setServiceTier":
        if (!session.setServiceTier)
          throw new Error("Service tier change is unavailable");
        return await session.setServiceTier(
          typeof args[0] === "string" ? args[0] : undefined,
        );
      case "setSessionOptions":
        return session.setSessionOptions
          ? await session.setSessionOptions(args[0] as ProviderSessionOptions)
          : unknownProviderSessionOptionsResult(
              args[0] as ProviderSessionOptions,
              "This provider adapter has no session-option control implementation",
            );
      case "interrupt":
        return await session.interrupt?.();
      case "supportedModels":
        return await session.supportedModels?.();
      case "supportedCommands":
        return await session.supportedCommands?.();
      case "getContextBreakdown":
        return await session.getContextBreakdown?.();
      case "setModel":
        return await session.setModel?.(
          (args[0] ?? undefined) as string | undefined,
        );
      case "runProviderCommand":
        if (this.auxiliarySubmission) {
          throw new Error("A provider-host session turn is already active");
        }
        return await session.runProviderCommand?.(
          String(args[0]),
          (args[1] ?? undefined) as string | undefined,
        );
      default:
        throw new Error(`Unknown provider session method ${method}`);
    }
  }

  private requireSession(): AgentSession {
    if (!this.session) throw new Error("Provider session is not ready");
    if (
      this.creationIdentity &&
      (!this.providerAlive || this.terminalSignalled || this.shuttingDown)
    )
      throw new Error("Provider creation owner has ended");
    return this.session;
  }

  private requestApproval(
    toolName: string,
    input: unknown,
    permissionMode: PermissionMode | undefined,
    signal: AbortSignal,
  ): Promise<ToolApprovalResult> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const auxiliary = this.auxiliarySubmission;
      if (auxiliary?.started) {
        this.emitSupervisor({
          type: "sessionTurnApproval",
          submissionId: auxiliary.submissionId,
          requestId,
          toolName,
          controlledBy: this.attachedController ? "hono" : null,
        });
        if (!this.attachedController) {
          auxiliary.terminalOutcome = "provider-approval-required";
          resolve({
            behavior: "deny",
            message: "No Hono approval controller is attached",
            interrupt: true,
          });
          return;
        }
      }
      const onAbort = () => {
        if (!this.pendingApprovals.delete(requestId)) return;
        this.emitController({ type: "approvalCancelled", requestId });
        resolve({
          behavior: "deny",
          message: "Operation interrupted",
          interrupt: true,
        });
      };
      const pending: PendingApproval = {
        requestId,
        toolName,
        input,
        permissionMode,
        resolve,
        removeAbortListener: () => signal.removeEventListener("abort", onAbort),
      };
      this.pendingApprovals.set(requestId, pending);
      signal.addEventListener("abort", onAbort, { once: true });
      this.writeApproval(this.attachedController?.write, pending);
    });
  }

  private writeApproval(
    write: ((message: unknown) => void) | undefined,
    pending: PendingApproval,
  ): void {
    write?.({
      type: "approval",
      requestId: pending.requestId,
      toolName: pending.toolName,
      input: pending.input,
      permissionMode: pending.permissionMode,
    });
  }

  private requestAgentApiRead(
    operation: Parameters<ApiReadPort>[0],
    input: NonNullable<Parameters<ApiReadPort>[2]>,
  ): ReturnType<ApiReadPort> {
    const parsed = agentCatalogRequest.safeParse({
      operation,
      input: {
        serverId: input.serverId,
        sessionId: input.sessionId,
        receiptId: input.receiptId,
        body: input.body,
        launch: input.launch,
        query: input.query,
      },
    });
    if (!parsed.success)
      return Promise.reject(
        new CoreApiError(
          "invalid_request",
          "Invalid API request parameters",
          400,
        ),
      );
    const attached = this.attachedController;
    if (!attached || this.pendingAgentReads.size >= 16)
      return Promise.reject(
        new CoreApiError(
          "controller_unavailable",
          "Catalog controller is unavailable or busy",
          503,
        ),
      );
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => abort(), AGENT_CATALOG_TIMEOUT_MS);
      const abort = () => {
        try {
          if (this.attachedController?.id === attached.id)
            attached.write({ type: "agentApiCancel", requestId });
        } catch {
          /* The detach error below remains authoritative. */
        }
        finish(
          new CoreApiError(
            "controller_unavailable",
            "Catalog read cancelled",
            503,
          ),
        );
      };
      const finish = (error?: Error, result?: unknown) => {
        if (!this.pendingAgentReads.delete(requestId)) return;
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else {
          const response = operations
            .find((item) => item.id === parsed.data.operation)!
            .response.safeParse(result);
          if (!response.success) reject(new Error("Invalid catalog response"));
          else resolve(response.data as Awaited<ReturnType<ApiReadPort>>);
        }
      };
      this.pendingAgentReads.set(requestId, {
        controllerId: attached.id,
        finish,
      });
      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted) {
        abort();
        return;
      }
      try {
        attached.write({ type: "agentApiRead", requestId, ...parsed.data });
      } catch {
        finish(
          new CoreApiError(
            "controller_unavailable",
            "Catalog controller write failed",
            503,
          ),
        );
      }
    });
  }

  private refreshRetention(): void {
    const session = this.session;
    if (!session) return;
    this.providerRetention = session.getProviderRetention?.() ?? {
      retained: false,
      reasons: [],
    };
    this.emitController({
      type: "providerRetention",
      value: this.providerRetention,
    });
  }

  private reportProviderPid(): void {
    const session = this.session;
    if (!session) return;
    const pid = resolvedPid(session);
    if (!pid || pid === this.lastProviderPid) return;
    this.lastProviderPid = pid;
    this.emitSupervisor({ type: "providerPid", pid });
  }

  private emitController(message: unknown): void {
    this.attachedController?.write(message);
  }

  private emitSupervisor(message: unknown): void {
    this.options.emitSupervisor?.(message);
  }

  private signalTerminal(reason: string, exitCode: number): void {
    if (this.terminalSignalled) return;
    this.terminalSignalled = true;
    void this.shutdown(reason).finally(() => {
      void this.options.onTerminal?.(reason, exitCode);
    });
  }

  async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return await this.shuttingDown;
    this.providerAlive = false;
    this.shuttingDown = (async () => {
      this.session?.setAgentApiControllerAttached?.(false);
      for (const pending of [...this.pendingAgentReads.values()])
        pending.finish(
          new CoreApiError(
            "controller_unavailable",
            "Provider owner ended",
            503,
          ),
        );
      for (const pending of this.pendingApprovals.values()) {
        pending.removeAbortListener();
        pending.resolve({
          behavior: "deny",
          message: `Provider runtime ended: ${reason}`,
          interrupt: true,
        });
      }
      this.pendingApprovals.clear();
      this.unsubscribeQueueDepth?.();
      this.unsubscribeQueueDepth = null;
      this.unsubscribeQueueRemoved?.();
      this.unsubscribeQueueRemoved = null;
      this.unsubscribeQueueYielded?.();
      this.unsubscribeQueueYielded = null;
      this.finishAuxiliarySubmission("interrupted");
      for (const deferred of this.deferredSubmissions.splice(0)) {
        this.emitSupervisor({
          type: "sessionTurnTerminal",
          submissionId: deferred.submissionId,
          outcome: "not-alive",
          error: "Provider runtime ended before the queued turn started",
        });
      }
      await Promise.resolve(this.session?.abort()).catch(() => {});
      this.agentctlSessionEnvBridge?.cleanup();
      this.agentctlSessionEnvBridge = null;
      this.attachedController = null;
    })();
    return await this.shuttingDown;
  }
}
