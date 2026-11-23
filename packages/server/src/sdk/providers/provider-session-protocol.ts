import type {
  PermissionMode,
  SessionSandboxEnforcement,
} from "@yep-anywhere/shared";
import type { ApiReadPort } from "../../core-api/service.js";
import type {
  CanUseTool,
  ProviderActivitySnapshot,
  ProviderRetentionSnapshot,
} from "../types.js";
import type { AgentctlSessionEnvBridge } from "./agentctl-session-env.js";
import type { BoundRuntimeIdentity } from "./bound-runtime-identity.mjs";
import type { CreationRuntimeEvidence } from "./creation-runtime-identity.js";
import type { AgentSession, NativeOwnerHost } from "./types.js";

/**
 * What a Provider Host worker's session owner and its Hono controller
 * exchange about a session: its ready metadata, start hooks and the state a
 * controller receives on attach.
 */

export interface ProviderSessionSandboxMetadata {
  enforcement: SessionSandboxEnforcement;
  stateKey: string;
  projectPath: string;
}

export interface ProviderSessionReadyMetadata {
  steering?: import("@yep-anywhere/shared").ProviderSteeringState;
  binding?: BoundRuntimeIdentity;
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
    retentionReadReconciles?: boolean;
    refreshPromptCache: boolean;
    publishAgentctlSessionId: boolean;
    steer: boolean;
    steerUsesMessageQueue?: boolean;
    /** The queue pauses native delivery during a configuration change. */
    queueHold?: boolean;
    /** The queue's provider waits for Process to report it is idle. */
    consumerIdle?: boolean;
    /** An accepted steer is reported consumed through the queue's yield. */
    steerConsumptionReported?: boolean;
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
  onNativeInputConsumed(nativeSessionId: string, inputId: string): void;
  /** The attached backend's view of the provider's native owner. */
  nativeOwnerHost: NativeOwnerHost;
  /** Native store changes the attached backend observes for this session. */
  observeNativeStore: (listener: () => void) => () => void;
  /** See `StartSessionOptions.markOutputDelivery`. */
  markOutputDelivery: () => () => number | undefined;
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
  steering?: import("@yep-anywhere/shared").ProviderSteeringState;
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
  /** The provider's native owner as the backend copies it (plan 195 step 9). */
  nativeOwner?: unknown;
  /**
   * Canonical id the provider reported in its init message. A controller
   * attaching after that event was acknowledged never sees it replayed.
   */
  providerSessionId?: string;
  binding?: BoundRuntimeIdentity;
  creation?: CreationRuntimeEvidence;
}
