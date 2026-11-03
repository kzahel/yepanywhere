import { agentApiEligible } from "../../agent-api/eligibility.js";
import { agentSelfEnabled } from "./agent-self.js";
import {
  agentCatalogRequest,
  AGENT_CATALOG_MAX_BYTES,
} from "../../agent-api/controller-protocol.js";
import { CoreApiError } from "../../core-api/service.js";
import { SUPERUSER } from "../../auth/principal.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { getLogger } from "../../logging/logger.js";
import { getModuleEnv, harvestYaModuleEnv } from "../../yaModuleEnv.js";
import { setProviderHostDegraded } from "./provider-host-status.js";
import {
  normalizeProviderWorkItems,
  nativeSessionFamily,
} from "@yep-anywhere/shared";
import type {
  PermissionMode,
  ThinkingConfig,
  EffortLevel,
  ImagePreparationProfile,
} from "@yep-anywhere/shared";
import { apiInputIds, type AgentMessageQueue } from "../messageQueue.js";
import type {
  ProviderActivitySnapshot,
  ProviderRetentionSnapshot,
  SDKMessage,
  ToolApprovalResult,
  UserMessage,
} from "../types.js";
import { pickStaticAgentEnvironment } from "./agentctl-session-env.js";
import type {
  AgentSession,
  ProviderName,
  ProviderSessionOptions,
  ProviderSessionOptionsUpdateResult,
  StartSessionOptions,
} from "./types.js";
import { resolveProviderSessionOptions } from "./types.js";
import type { ProviderRuntimeSnapshot } from "./index.js";
import {
  parseCreationRuntimeEvidence,
  sameCreationRuntimeIdentity,
  type CreationRuntimeEvidence,
} from "./creation-runtime-identity.js";
import {
  BOUND_RUNTIME_FEATURE,
  BOUND_RUNTIME_PROTOCOL_VERSION,
  parseBoundRuntimeIdentity,
  sameBoundRuntimeIdentity,
  type BoundRuntimeIdentity,
} from "./bound-runtime-identity.mjs";

const HOST_REQUEST_TIMEOUT_MS = 15_000;
const WORKER_RPC_TIMEOUT_MS = 30_000;
const HOST_PROTOCOL_VERSION = 3;
const WORKER_PROTOCOL_VERSION = 1;
// The host's default attach deadline is 30 seconds. Keep launch routing pinned
// until that owner has either been reclaimed or reaped.
const RUNTIME_OWNER_LOSS_GRACE_MS = 31_000;

interface HostResponse<T> {
  id?: number;
  ok: boolean;
  result?: T;
  error?: string;
}

interface WorkerCapabilities {
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
  instructionRestoration?: boolean;
  setMaxThinkingTokens: boolean;
  setEffort: boolean;
  effortUpdatesActiveTurn?: boolean;
  setServiceTier?: boolean;
  setSessionOptions: boolean;
  interrupt: boolean;
  supportedModels: boolean;
  supportedCommands: boolean;
  /** Absent from hosts started before the context breakdown existed. */
  getContextBreakdown?: boolean;
  setModel: boolean;
  runProviderCommand: boolean;
}

interface WorkerMetadata {
  creation?: CreationRuntimeEvidence;
  binding?: BoundRuntimeIdentity;
  sessionId?: string;
  queueDepth: number;
  providerActivity?: ProviderActivitySnapshot;
  providerRetention?: ProviderRetentionSnapshot;
  capabilities: WorkerCapabilities;
}

export interface HostedProviderReattachSpec {
  /** Public binding identity only; credentials remain on the private launch channel. */
  routerBindingId?: string;
  permissionMode?: PermissionMode;
  model?: string;
  serviceTier?: string;
  thinking?: ThinkingConfig;
  effort?: EffortLevel;
  clientName?: string;
  executor?: string;
  sandboxLevel?: StartSessionOptions["sessionSandboxOptions"] extends infer T
    ? T extends { level: infer L }
      ? L
      : never
    : never;
  sandboxNetworkFirewall?: boolean;
  sandboxStateKey?: string;
  /**
   * Configured model endpoint the worker was launched against. Kept here so a
   * replacement server still knows it after a reload; a host that predates the
   * field returns no value, and usage falls back to resolving the model.
   */
  gatewayServiceId?: string;
}

export interface HostedProviderRuntimeInfo {
  binding?: BoundRuntimeIdentity;
  creation?: CreationRuntimeEvidence;
  workerProtocolVersion?: number;
  hostProtocolVersion: number;
  runtimeId: string;
  sessionId?: string;
  harness: string;
  providerSessionId?: string;
  yaSessionId?: string;
  providerName: ProviderName;
  projectPath: string;
  socketPath: string;
  pid: number;
  processGroupId: number;
  providerProcessGroupIds: number[];
  state: "starting" | "attached" | "detached" | "closing";
  attachedServerGeneration?: string;
  startedAt: string;
  unviewedSince?: string;
  lifecycleCapabilities?: { viewerPresence?: boolean };
  detachedAt?: string;
  reattach: HostedProviderReattachSpec;
  worker: WorkerMetadata;
  /** Preparation profile for files delivered to this session; inventory only. */
  imagePreparationProfile?: ImagePreparationProfile;
  acceptsSessionTurns: boolean;
}

interface RuntimeHostEnvironment {
  socketPath: string;
  token: string;
  generation: string;
}

export interface ProviderHostTurnTarget {
  harness: string;
  providerSessionId: string;
  yaSessionId?: string;
}

export interface ProviderHostSessionTurnRequest {
  submissionId: string;
  target: ProviderHostTurnTarget;
  message: Pick<UserMessage, "text" | "mode" | "metadata">;
  /** Omission is normalized to every provider-owned generation option off. */
  sessionOptions?: ProviderSessionOptions;
  timeoutMs?: number;
  /** Queue behind active work instead of refusing a busy runtime. */
  eventual?: boolean;
  /** Never revive an inactive target to accept the turn. */
  liveOnly?: boolean;
}

export interface ProviderHostSessionTurnRecord {
  id?: string | number;
  type:
    | "accepted"
    | "providerEvent"
    | "approvalRequired"
    | "terminal"
    | "error";
  submissionId?: string;
  outcome?: string;
  accepted?: boolean;
  error?: string;
  [key: string]: unknown;
}

let registrationSocket: Socket | null = null;
let registrationPromise: Promise<boolean> | null = null;
let registered = false;
let nextRequestId = 1;
const hostedSessionIds = new Map<string, string>();
const hostedRuntimeForgetTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether a shared provider host is supported for this platform and this
 * server's launch. `providerHostCapability()` in
 * `scripts/provider-process-identity.mjs` owns the platform and runtime rule
 * for the scripts that start and discover the host; this narrows it by how
 * the server itself was launched, because macOS hosting is verified only for
 * a Node source checkout running this module from TypeScript source.
 */
export function supportsProviderHostRuntimeAsLaunched(): boolean {
  return (
    process.platform === "linux" ||
    (process.platform === "darwin" &&
      !process.versions.bun &&
      fileURLToPath(import.meta.url).endsWith(
        "/src/sdk/providers/provider-runtime-host.ts",
      ))
  );
}

function getEnvironment(): RuntimeHostEnvironment | null {
  if (!supportsProviderHostRuntimeAsLaunched()) return null;
  const runtimeEnv = getModuleEnv("provider-runtime");
  const socketPath = runtimeEnv.SOCKET?.trim();
  const token = runtimeEnv.TOKEN?.trim();
  const generation = process.env.YEP_SERVER_GENERATION?.trim();
  if (!socketPath || !token || !generation) return null;
  return { socketPath, token, generation };
}

export function isProviderRuntimeHostAvailable(): boolean {
  return getEnvironment() !== null && registered;
}

/**
 * The checkout whose `scripts/` start and discover the provider host, or
 * null for a distribution that ships none, such as the npm bundle.
 */
function resolveProviderHostProjectRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "scripts/provider-runtime-host.mjs"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function importProviderHostScript<T>(
  projectRoot: string,
  script: string,
): Promise<T> {
  return (await import(
    pathToFileURL(join(projectRoot, "scripts", script)).href
  )) as T;
}

function applyProviderHostConnection(connection: {
  paths: {
    runtimeDir: string;
    controlSocketPath: string;
    descriptorPath: string;
    tokenPath: string;
    receiptPath: string;
  };
  discovery: { token?: string; descriptor?: { controlSocketPath?: string } };
}): void {
  const socketPath =
    connection.discovery.descriptor?.controlSocketPath ??
    connection.paths.controlSocketPath;
  process.env.YEP_PROVIDER_RUNTIME_DIR = connection.paths.runtimeDir;
  process.env.YEP_PROVIDER_RUNTIME_SOCKET = socketPath;
  if (connection.discovery.token) {
    process.env.YEP_PROVIDER_RUNTIME_TOKEN = connection.discovery.token;
  }
  process.env.YEP_PROVIDER_RUNTIME_DESCRIPTOR = connection.paths.descriptorPath;
  process.env.YEP_PROVIDER_RUNTIME_TOKEN_FILE = connection.paths.tokenPath;
  process.env.YEP_PROVIDER_RUNTIME_RECEIPTS = connection.paths.receiptPath;
  if (!process.env.YEP_SERVER_GENERATION?.trim()) {
    process.env.YEP_SERVER_GENERATION = `${process.pid}-1`;
  }
  harvestYaModuleEnv();
}

/**
 * When enabled, attach to a live provider host or start one when absent.
 * SSH execution is retired. A failed ensure continues in-process and sets the
 * provider-host degraded notice. A distribution without the host scripts
 * cannot run a host, so it stays in-process without that notice. Whether
 * hosting is enabled is `providerHostEnabled` in those scripts, the rule the
 * dev wrapper also applies when it decides to start a host.
 */
export async function ensureProviderRuntimeHost(
  projectRoot = resolveProviderHostProjectRoot(),
): Promise<boolean> {
  if (!projectRoot) return false;
  const { providerHostEnabled } = await importProviderHostScript<{
    providerHostEnabled: () => boolean;
  }>(projectRoot, "provider-process-identity.mjs");
  if (!providerHostEnabled()) {
    setProviderHostDegraded(false);
    return false;
  }
  if (isProviderRuntimeHostAvailable()) {
    setProviderHostDegraded(false);
    return true;
  }
  if (!supportsProviderHostRuntimeAsLaunched()) return false;
  // Mock servers must not discover or bootstrap an ambient real-provider host.
  // A wrapper may still supply an explicit simulated host for lifecycle tests.
  if (process.env.VITEST || process.env.USE_MOCK_SDK === "true") {
    return await initializeProviderRuntimeHost();
  }
  if (!process.env.YEP_SERVER_GENERATION?.trim()) {
    process.env.YEP_SERVER_GENERATION = `${process.pid}-1`;
  }
  if (await initializeProviderRuntimeHost()) {
    setProviderHostDegraded(false);
    return true;
  }

  try {
    const { attachOrStartProviderHost } = await importProviderHostScript<{
      attachOrStartProviderHost: (options: {
        env?: NodeJS.ProcessEnv;
        projectRoot?: string;
      }) => Promise<{
        state: string;
        paths?: {
          runtimeDir: string;
          controlSocketPath: string;
          descriptorPath: string;
          tokenPath: string;
          receiptPath: string;
        };
        discovery?: {
          token?: string;
          descriptor?: { controlSocketPath?: string };
        };
        error?: string;
      }>;
    }>(projectRoot, "attach-or-start-provider-host.mjs");
    const result = await attachOrStartProviderHost({
      env: process.env,
      projectRoot,
    });
    if (
      (result.state === "attached" || result.state === "started") &&
      result.paths &&
      result.discovery
    ) {
      applyProviderHostConnection({
        paths: result.paths,
        discovery: result.discovery,
      });
      if (await initializeProviderRuntimeHost()) {
        setProviderHostDegraded(false);
        return true;
      }
    }
    getLogger().error(
      {
        event: "provider_host_ensure_failed",
        state: result.state,
        error: result.error,
      },
      "YA could not attach or start the provider host",
    );
  } catch (error) {
    getLogger().error(
      {
        event: "provider_host_ensure_failed",
        error: error instanceof Error ? error.message : String(error),
      },
      "YA could not attach or start the provider host",
    );
  }
  setProviderHostDegraded(true);
  return false;
}

export function hasHostedProviderRuntime(sessionId: string): boolean {
  for (const knownSessionId of hostedSessionIds.values()) {
    if (knownSessionId === sessionId) return true;
  }
  return false;
}

function rememberRuntime(runtime: HostedProviderRuntimeInfo): void {
  const pendingForget = hostedRuntimeForgetTimers.get(runtime.runtimeId);
  if (pendingForget) clearTimeout(pendingForget);
  hostedRuntimeForgetTimers.delete(runtime.runtimeId);
  if (runtime.sessionId) {
    hostedSessionIds.set(runtime.runtimeId, runtime.sessionId);
  }
}

function forgetRuntime(runtimeId: string): void {
  const pendingForget = hostedRuntimeForgetTimers.get(runtimeId);
  if (pendingForget) clearTimeout(pendingForget);
  hostedRuntimeForgetTimers.delete(runtimeId);
  hostedSessionIds.delete(runtimeId);
}

function forgetRuntimeAfterOwnerLoss(runtimeId: string): void {
  if (hostedRuntimeForgetTimers.has(runtimeId)) return;
  const timer = setTimeout(
    () => forgetRuntime(runtimeId),
    RUNTIME_OWNER_LOSS_GRACE_MS,
  );
  timer.unref?.();
  hostedRuntimeForgetTimers.set(runtimeId, timer);
}

function requestHost<T>(
  op: string,
  payload: Record<string, unknown> = {},
  options: { timeoutMs?: number; authorize?: () => Promise<void> } = {},
): Promise<T> {
  const environment = getEnvironment();
  if (!environment) {
    return Promise.reject(new Error("Provider runtime host is unavailable"));
  }
  const id = nextRequestId++;
  return new Promise<T>((resolve, reject) => {
    const socket = createConnection(environment.socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      fn();
    };
    const timeout = setTimeout(
      () =>
        finish(() =>
          reject(new Error(`Provider runtime host ${op} timed out`)),
        ),
      options.timeoutMs ?? HOST_REQUEST_TIMEOUT_MS,
    );
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          id,
          token: environment.token,
          generation: environment.generation,
          protocolVersion: HOST_PROTOCOL_VERSION,
          op,
          ...payload,
        })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (op === "projectService" && Buffer.byteLength(buffer) > 1024 * 1024) {
        finish(() => reject(new Error("Provider host response exceeds 1 MiB")));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(
          buffer.slice(0, newline),
        ) as HostResponse<T> & { type?: string; authorizationId?: string };
        buffer = buffer.slice(newline + 1);
        if (response.type === "authorize" && response.id === id) {
          const authorize =
            options.authorize ??
            (() => Promise.reject(new Error("No app execution authority")));
          void authorize().then(
            () => {
              if (!socket.destroyed)
                socket.write(
                  `${JSON.stringify({ op: "projectServiceAuthorization", authorizationId: response.authorizationId })}\n`,
                );
            },
            (error: unknown) => {
              if (!socket.destroyed)
                socket.write(
                  `${JSON.stringify({ op: "projectServiceAuthorization", authorizationId: response.authorizationId, error: errorMessage(error) })}\n`,
                );
            },
          );
          return;
        }
        if (!response.ok) {
          finish(() => reject(new Error(response.error ?? `${op} failed`)));
          return;
        }
        finish(() => resolve(response.result as T));
      } catch (error) {
        finish(() => reject(error));
      }
    });
    socket.on("error", (error) => finish(() => reject(error)));
    socket.on("close", () => {
      if (!settled) finish(() => reject(new Error(`Host closed during ${op}`)));
    });
  });
}

export async function initializeProviderRuntimeHost(): Promise<boolean> {
  if (registered) return true;
  if (registrationPromise) return await registrationPromise;
  const environment = getEnvironment();
  if (!environment) return false;
  registrationPromise = new Promise<boolean>((resolve) => {
    const socket = createConnection(environment.socketPath);
    registrationSocket = socket;
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => {
      socket.destroy();
      finish(false);
    }, HOST_REQUEST_TIMEOUT_MS);
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          id: nextRequestId++,
          token: environment.token,
          generation: environment.generation,
          protocolVersion: HOST_PROTOCOL_VERSION,
          op: "registerServer",
        })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as HostResponse<{
          protocolVersion?: number;
        }>;
        registered =
          response.ok &&
          response.result?.protocolVersion === HOST_PROTOCOL_VERSION;
        if (!registered) socket.destroy();
        finish(registered);
      } catch {
        socket.destroy();
        finish(false);
      }
    });
    socket.on("error", () => finish(false));
    socket.on("close", () => {
      registered = false;
      registrationSocket = null;
      if (!settled) finish(false);
    });
  }).finally(() => {
    registrationPromise = null;
  });
  return await registrationPromise;
}

export function closeProviderRuntimeHostRegistration(): void {
  registered = false;
  registrationSocket?.destroy();
  registrationSocket = null;
}

export async function listHostedProviderRuntimes(): Promise<
  HostedProviderRuntimeInfo[]
> {
  if (!isProviderRuntimeHostAvailable()) return [];
  const runtimes = await requestHost<HostedProviderRuntimeInfo[]>("list");
  for (const runtime of runtimes) rememberRuntime(runtime);
  return runtimes;
}

export function getProviderHostStatus(): Promise<Record<string, unknown>> {
  return requestHost("status");
}

/**
 * Features the provider host process advertises in its `status` reply
 * (scripts/provider-runtime-host.mjs). These describe the running host
 * build, not server capabilities, though some names coincide.
 */
const PROVIDER_HOST_FEATURE = {
  creationOwner: "session-creation-owner-v1",
  codexCreation: "session-creation-codex-v1",
  opencodeCreation: "session-creation-opencode-v1",
  piCreation: "session-creation-pi-v1",
  adaptersCreation: "session-creation-adapters-v1",
  sandboxCreation: "session-creation-sandbox-v1",
  nativeBinding: BOUND_RUNTIME_FEATURE,
  agentApiRevocation: "agent-api-revocation",
  agentApiManagement: "agent-api-management",
  agentApiPeers: "agent-api-peers",
} as const;

function providerHostHasFeature(
  status: Record<string, unknown>,
  feature: (typeof PROVIDER_HOST_FEATURE)[keyof typeof PROVIDER_HOST_FEATURE],
): boolean {
  return Array.isArray(status.features) && status.features.includes(feature);
}

export async function assertHostedCreationSupport(
  providerName = "claude",
  options: { sandbox?: boolean } = {},
): Promise<void> {
  const status = isProviderRuntimeHostAvailable()
    ? await getProviderHostStatus()
    : undefined;
  if (
    !status ||
    !providerHostHasFeature(status, PROVIDER_HOST_FEATURE.creationOwner) ||
    (options.sandbox &&
      !providerHostHasFeature(status, PROVIDER_HOST_FEATURE.sandboxCreation)) ||
    (!["claude", "codex", "opencode", "pi"].includes(providerName) &&
      !providerHostHasFeature(
        status,
        PROVIDER_HOST_FEATURE.adaptersCreation,
      )) ||
    (providerName === "codex" &&
      !providerHostHasFeature(status, PROVIDER_HOST_FEATURE.codexCreation)) ||
    (providerName === "opencode" &&
      !providerHostHasFeature(
        status,
        PROVIDER_HOST_FEATURE.opencodeCreation,
      )) ||
    (providerName === "pi" &&
      !providerHostHasFeature(status, PROVIDER_HOST_FEATURE.piCreation))
  )
    throw new Error(
      "This provider host cannot own saved creation; update the host before starting this session",
    );
}

function boundRuntimeIdentity(
  options: StartSessionOptions,
): BoundRuntimeIdentity | undefined {
  if (!options.nativeResumeSource) return undefined;
  if (options.creationRuntime)
    throw new Error("A native continuation cannot create a new attempt");
  const binding = parseBoundRuntimeIdentity({
    version: 1,
    sessionId: options.publicSessionId,
    native: options.nativeResumeSource.native,
  });
  if (binding.native.id !== options.resumeSessionId)
    throw new Error("Native continuation id does not match its source");
  return binding;
}

function runtimeControllerFields(
  options: StartSessionOptions,
): Record<string, unknown> {
  const binding = boundRuntimeIdentity(options);
  return binding
    ? { binding, workerProtocolVersion: BOUND_RUNTIME_PROTOCOL_VERSION }
    : options.creationRuntime
      ? { creation: options.creationRuntime.identity, workerProtocolVersion: 2 }
      : {};
}

export async function revokeHostedAgentApiAccess(
  serverId: string,
): Promise<void> {
  if (!isProviderRuntimeHostAvailable()) return;
  const status = await getProviderHostStatus();
  if (providerHostHasFeature(status, PROVIDER_HOST_FEATURE.agentApiRevocation))
    await requestHost("revokeAgentApi", { serverId });
}

export async function revokeHostedPeerAgentApiAccess(
  serverId: string,
  grantId: string,
): Promise<void> {
  if (!isProviderRuntimeHostAvailable()) return;
  const status = await getProviderHostStatus();
  if (providerHostHasFeature(status, PROVIDER_HOST_FEATURE.agentApiPeers))
    await requestHost("revokePeerAgentApi", { serverId, grantId });
}

export function requestHostedProjectService(
  service: Record<string, unknown>,
  authorize?: () => Promise<void>,
): Promise<unknown> {
  return requestHost(
    "projectService",
    { service },
    { timeoutMs: 185_000, authorize },
  );
}

export async function getProviderHostInventory(): Promise<
  HostedProviderRuntimeInfo[]
> {
  const runtimes = await requestHost<HostedProviderRuntimeInfo[]>("inventory");
  return runtimes.map(({ binding: _binding, worker, ...runtime }) => {
    // Native storage scope is a private controller fact. The existing native
    // id remains available for explicit provider-host turn targeting.
    if (!worker) return { ...runtime, worker };
    const { binding: _workerBinding, ...publicWorker } = worker;
    return { ...runtime, worker: publicWorker };
  });
}

export function getProviderHostSessionTurnStatus(
  submissionId: string,
): Promise<Record<string, unknown> | null> {
  return requestHost("sessionTurnStatus", { submissionId });
}

export function interruptProviderHostSessionTurn(
  submissionId: string,
): Promise<Record<string, unknown>> {
  return requestHost("interruptSessionTurn", { submissionId });
}

export async function* streamProviderHostSessionTurn(
  request: ProviderHostSessionTurnRequest,
  signal?: AbortSignal,
): AsyncGenerator<ProviderHostSessionTurnRecord> {
  const environment = getEnvironment();
  if (!environment || !registered) {
    throw new Error("Provider runtime host is unavailable");
  }
  const requestId = randomUUID();
  const socket = createConnection(environment.socketPath);
  socket.setEncoding("utf8");
  const abort = () => socket.destroy(new Error("Session-turn request aborted"));
  signal?.addEventListener("abort", abort, { once: true });
  let buffer = "";
  let terminal = false;
  try {
    socket.write(
      `${JSON.stringify({
        id: requestId,
        token: environment.token,
        generation: environment.generation,
        protocolVersion: HOST_PROTOCOL_VERSION,
        op: "sessionTurn",
        ...request,
        sessionOptions: resolveProviderSessionOptions(request.sessionOptions),
      })}\n`,
    );
    for await (const chunk of socket) {
      buffer += String(chunk);
      if (Buffer.byteLength(buffer) > 64 * 1024 * 1024) {
        throw new Error("Provider host session-turn record is too large");
      }
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const record = JSON.parse(line) as ProviderHostSessionTurnRecord;
        if (record.id !== requestId) {
          throw new Error("Provider host session-turn response id mismatch");
        }
        yield record;
        if (record.type === "terminal" || record.type === "error") {
          terminal = true;
          return;
        }
      }
    }
    if (!terminal) {
      throw new Error("Provider host closed before a terminal turn record");
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    socket.destroy();
  }
}

export async function retainProviderRuntimeProcessGroup(
  processGroupId: number,
): Promise<void> {
  await requestHost("retainProcessGroup", { processGroupId });
}

function cloneableOptions(
  options: StartSessionOptions,
): Record<string, unknown> {
  const {
    creationRuntime: _creationRuntime,
    onNativeInputConsumed: _onNativeInputConsumed,
    retainedRuntimeOnly: _retainedRuntimeOnly,
    assertResumeAdmission: _assertResumeAdmission,
    onToolApproval: _onToolApproval,
    onAgentApiRead: _onAgentApiRead,
    onPermissionModeApplied: _onPermissionModeApplied,
    shouldEmitLiveDeltas: _shouldEmitLiveDeltas,
    onProviderRetentionChange: _onProviderRetentionChange,
    sessionSandbox: _sessionSandbox,
    instructionReadHistory: _instructionReadHistory,
    getSessionChildEnv,
    ...cloneable
  } = options;
  const sessionChildEnv = getSessionChildEnv?.(
    options.creationRuntime?.identity.sessionId ??
      options.publicSessionId ??
      options.resumeSessionId ??
      "",
    options.executor,
  );
  return {
    ...cloneable,
    agentSelf: options.agentSelf ?? agentSelfEnabled(),
    staticAgentEnvironment: pickStaticAgentEnvironment(sessionChildEnv),
  };
}

function reattachSpec(
  options: StartSessionOptions,
): HostedProviderReattachSpec {
  const sandboxLevel = options.sessionSandboxOptions?.level;
  return {
    routerBindingId: options.routerLaunch?.bindingId,
    permissionMode: options.permissionMode,
    model: options.model,
    serviceTier: options.serviceTier,
    thinking: options.thinking,
    effort: options.effort,
    clientName: options.clientName,
    executor: options.executor,
    sandboxLevel,
    sandboxNetworkFirewall:
      sandboxLevel === "project-write"
        ? options.sessionSandboxOptions?.networkFirewall !== false
        : undefined,
    sandboxStateKey: options.sessionSandboxOptions?.stateKey,
    ...(options.gatewayRoute
      ? { gatewayServiceId: options.gatewayRoute.serviceId }
      : {}),
  };
}

export async function startHostedProviderSession(
  providerName: ProviderName,
  options: StartSessionOptions,
  runtimeConfig: ProviderRuntimeSnapshot,
): Promise<AgentSession> {
  if (!isProviderRuntimeHostAvailable()) {
    throw new Error("Provider runtime host is unavailable");
  }
  if (options.nativeResumeSource) {
    options = {
      ...options,
      nativeResumeSource: Object.freeze({
        ...options.nativeResumeSource,
        native: Object.freeze({ ...options.nativeResumeSource.native }),
      }),
    };
  }
  const creation = options.creationRuntime;
  const binding = boundRuntimeIdentity(options);
  if (binding) {
    if (nativeSessionFamily(providerName) !== binding.native.family)
      throw new Error("Native binding has the wrong provider family");
    options.assertResumeAdmission?.();
    if (
      !providerHostHasFeature(
        await getProviderHostStatus(),
        PROVIDER_HOST_FEATURE.nativeBinding,
      )
    )
      throw new Error(
        "Update the provider host before starting a scoped native continuation",
      );
    options.assertResumeAdmission?.();
  }
  if (creation) {
    await assertHostedCreationSupport(providerName, {
      sandbox: options.sessionSandboxOptions?.level === "project-write",
    });
    await creation.authorize();
  }
  if (options.agentApi && !agentApiEligible(providerName, options))
    options = { ...options, agentApi: undefined, onAgentApiRead: undefined };
  if (options.agentApi) {
    const status = await getProviderHostStatus();
    if (
      !providerHostHasFeature(status, PROVIDER_HOST_FEATURE.agentApiRevocation)
    )
      throw new Error(
        "Restart the provider host before enabling agent API discovery for this launch",
      );
    if (!providerHostHasFeature(status, PROVIDER_HOST_FEATURE.agentApiPeers))
      options = {
        ...options,
        agentApi: {
          ...options.agentApi,
          peerAccess: false,
          peerGrantId: undefined,
        },
      };
    if (
      options.agentApi!.management &&
      !providerHostHasFeature(status, PROVIDER_HOST_FEATURE.agentApiManagement)
    )
      throw new Error(
        "Restart the provider host before enabling agent API session commands for this launch",
      );
  }
  await creation?.authorize();
  options.assertResumeAdmission?.();
  let runtime = options.resumeSessionId
    ? await requestHost<HostedProviderRuntimeInfo | null>("claim", {
        sessionId:
          creation?.identity.sessionId ??
          binding?.sessionId ??
          options.resumeSessionId,
        ...runtimeControllerFields(options),
      })
    : null;
  if (options.retainedRuntimeOnly && !runtime)
    throw new Error(
      "Retained provider owner is unavailable; hosted cold continuation is not qualified",
    );
  if (creation && options.resumeSessionId && !runtime)
    throw new Error(
      "Saved creation owner is unavailable; do not relaunch its initial input",
    );
  if (
    runtime &&
    binding &&
    (runtime.workerProtocolVersion !== BOUND_RUNTIME_PROTOCOL_VERSION ||
      runtime.sessionId !== binding.sessionId ||
      runtime.providerSessionId !== binding.native.id ||
      !sameBoundRuntimeIdentity(binding, runtime.binding))
  )
    throw new Error("Retained worker does not match the native binding");
  if (
    runtime &&
    creation &&
    (runtime.workerProtocolVersion !== 2 ||
      runtime.sessionId !== creation.identity.sessionId ||
      !sameCreationRuntimeIdentity(
        creation.identity,
        runtime.creation?.identity,
      ))
  )
    throw new Error("Retained worker does not match saved creation");
  if (runtime && runtime.providerName !== providerName) {
    throw new Error(
      `Retained runtime provider ${runtime.providerName} does not match ${providerName}`,
    );
  }
  const requestedReattach = reattachSpec(options);
  if (
    runtime &&
    runtime.reattach.routerBindingId !== requestedReattach.routerBindingId
  ) {
    throw new Error(
      "Retained runtime router binding does not match this session",
    );
  }
  if (
    runtime &&
    ((runtime.reattach.sandboxLevel ?? "none") !==
      (requestedReattach.sandboxLevel ?? "none") ||
      (requestedReattach.sandboxLevel === "project-write" &&
        runtime.reattach.sandboxNetworkFirewall !==
          requestedReattach.sandboxNetworkFirewall))
  ) {
    if (creation || binding || options.retainedRuntimeOnly)
      throw new Error(
        "Retained continuation cannot replace a worker with different sandbox settings",
      );
    await requestHost("terminate", { runtimeId: runtime.runtimeId });
    runtime = null;
  }
  const hydrateHistory = !runtime && Boolean(options.instructionReadHistory);
  if (!runtime) {
    await creation?.authorize();
    options.assertResumeAdmission?.();
    runtime = await requestHost<HostedProviderRuntimeInfo>("launch", {
      providerName,
      projectPath: options.cwd,
      sessionId:
        creation?.identity.sessionId ??
        binding?.sessionId ??
        options.resumeSessionId,
      ...runtimeControllerFields(options),
      options: {
        ...cloneableOptions(options),
        deferInstructionHistory: hydrateHistory,
      },
      runtimeConfig,
      reattach: reattachSpec(options),
    });
  }
  if (
    binding &&
    (runtime.workerProtocolVersion !== BOUND_RUNTIME_PROTOCOL_VERSION ||
      runtime.sessionId !== binding.sessionId ||
      runtime.providerSessionId !== binding.native.id ||
      !sameBoundRuntimeIdentity(binding, runtime.binding))
  )
    throw new Error("Provider host did not preserve the native binding");
  options.assertResumeAdmission?.();
  if (creation) {
    if (
      runtime.workerProtocolVersion !== 2 ||
      runtime.sessionId !== creation.identity.sessionId
    )
      throw new Error(
        "Provider host did not preserve saved creation ownership",
      );
    const evidence = parseCreationRuntimeEvidence(runtime.creation);
    if (!sameCreationRuntimeIdentity(creation.identity, evidence.identity))
      throw new Error("Provider host returned another creation attempt");
    creation.observe(evidence);
  }
  rememberRuntime(runtime);
  return await HostedAgentSession.connect(runtime, options, hydrateHistory);
}

class HostedMessageQueue implements AgentMessageQueue {
  private pending: UserMessage[] = [];
  private remoteDepth: number;
  private yieldedListeners = new Set<(messages: UserMessage[]) => void>();
  private readonly apiInputs = new Set<string>();

  constructor(
    initialDepth: number,
    private readonly send: (message: unknown) => void,
    private readonly rpc: <T>(method: string, args?: unknown[]) => Promise<T>,
    private readonly assertAdmission?: () => void,
  ) {
    this.remoteDepth = initialDepth;
  }

  push(message: UserMessage): number {
    this.trackSteer(message);
    this.remoteDepth = Math.max(this.remoteDepth, this.pending.length);
    this.send({ type: "queuePush", message });
    return this.remoteDepth;
  }

  trackSteer(message: UserMessage): void {
    this.assertAdmission?.();
    this.pending.push(message);
  }

  drain(): UserMessage[] {
    const drained = this.pending.splice(0);
    this.remoteDepth = 0;
    void this.rpc<UserMessage[]>("drainQueue").catch(() => {});
    return drained;
  }

  async drainAsync(): Promise<UserMessage[]> {
    const remote = await this.rpc<UserMessage[]>("drainQueue");
    this.pending = [];
    this.remoteDepth = 0;
    return remote;
  }

  removeByTempId(tempId: string): UserMessage[] {
    const removed = this.pending.filter(
      (message) =>
        message.tempId === tempId || message.tempIds?.includes(tempId) === true,
    );
    this.pending = this.pending.filter((message) => !removed.includes(message));
    this.send({ type: "removeQueued", tempId });
    return removed;
  }

  updateDepth(depth: number): void {
    this.remoteDepth = Math.max(0, depth);
  }

  removeAccepted(uuids: string[]): void {
    const removed = new Set(uuids);
    this.pending = this.pending.filter(
      (message) => !message.uuid || !removed.has(message.uuid),
    );
  }

  notifyYielded(uuids: string[]): void {
    const yielded = new Set(uuids);
    const messages = this.pending.filter(
      (message) => message.uuid && yielded.has(message.uuid),
    );
    if (messages.length === 0) return;
    for (const message of messages) {
      for (const id of apiInputIds(message)) {
        this.apiInputs.add(id);
        while (this.apiInputs.size > 512)
          this.apiInputs.delete(this.apiInputs.values().next().value!);
      }
    }
    for (const listener of this.yieldedListeners) listener(messages);
  }

  hasYieldedApiInput(id: string) {
    return this.apiInputs.has(id);
  }
  subscribeYielded(listener: (messages: UserMessage[]) => void): () => void {
    this.yieldedListeners.add(listener);
    return () => this.yieldedListeners.delete(listener);
  }

  get depth(): number {
    return this.remoteDepth;
  }
}

class HostedAgentSession {
  private socket: Socket;
  private eventQueue: Array<{ sequence: number; message: SDKMessage }> = [];
  private iteratorWaiters: Array<{
    resolve: (result: IteratorResult<SDKMessage>) => void;
    reject: (error: Error) => void;
  }> = [];
  private pendingRpc = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private nextRpcId = 1;
  private lastYieldedSequence: number | null = null;
  private done = false;
  private failure: Error | null = null;
  private detaching = false;
  private providerAlive = true;
  private activeProviderTurn = false;
  private providerActivity: ProviderActivitySnapshot;
  private providerRetention: ProviderRetentionSnapshot;
  private handledApprovals = new Set<string>();
  private queuedApprovals = new Map<string, Record<string, unknown>>();
  private approvalControllers = new Map<string, AbortController>();
  /** Bound by the worker's 16-request agent catalog window. */
  private agentApiControllers = new Map<string, AbortController>();
  private callbacksActive = false;
  private pendingAppliedPermissionMode: PermissionMode | undefined;
  private initializedSessionId: string | undefined;
  readonly queue: HostedMessageQueue;

  private constructor(
    private readonly runtime: HostedProviderRuntimeInfo,
    private readonly options: StartSessionOptions,
    socket: Socket,
  ) {
    this.socket = socket;
    this.providerActivity = reviveActivity(runtime.worker.providerActivity);
    this.providerRetention = reviveRetention(runtime.worker.providerRetention);
    this.queue = new HostedMessageQueue(
      runtime.worker.queueDepth,
      (message) => this.send(message),
      <T>(method: string, args?: unknown[]) => this.rpc<T>(method, args),
      options.assertResumeAdmission,
    );
  }

  static async connect(
    runtime: HostedProviderRuntimeInfo,
    options: StartSessionOptions,
    hydrateHistory = false,
  ): Promise<AgentSession> {
    const environment = getEnvironment();
    if (!environment) throw new Error("Provider runtime host is unavailable");
    await options.creationRuntime?.authorize();
    options.assertResumeAdmission?.();
    if (!runtime.worker)
      throw new Error("Provider worker is not ready to attach");
    const socket = createConnection(runtime.socketPath);
    // Keep construction failures exception-safe before attach installs the
    // request/lifetime listeners (a failed connect may report asynchronously).
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    try {
      const proxy = new HostedAgentSession(runtime, options, socket);
      await proxy.attach(environment);
      options.assertResumeAdmission?.();
      const publicSessionId =
        options.creationRuntime?.identity.sessionId ??
        options.publicSessionId ??
        options.resumeSessionId;
      if (publicSessionId && options.getSessionChildEnv) {
        await proxy.rpc("publishAgentctlSessionId", [
          publicSessionId,
          pickStaticAgentEnvironment(
            options.getSessionChildEnv(publicSessionId, options.executor),
          ),
        ]);
      }
      await requestHost("confirmAttach", {
        runtimeId: runtime.runtimeId,
        ...runtimeControllerFields(options),
      });
      if (hydrateHistory) {
        const history = options.instructionReadHistory ?? [];
        for (let offset = 0; offset < history.length; offset += 32) {
          await proxy.rpc("hydrateInstructionReadHistory", [
            history.slice(offset, offset + 32),
            false,
          ]);
        }
        await proxy.rpc("hydrateInstructionReadHistory", [[], true]);
      }
      return proxy.toAgentSession();
    } catch (error) {
      socket.destroy();
      forgetRuntimeAfterOwnerLoss(runtime.runtimeId);
      throw error;
    }
  }

  private attach(environment: RuntimeHostEnvironment): Promise<void> {
    return new Promise((resolve, reject) => {
      let buffer = "";
      let attached = false;
      const timeout = setTimeout(() => {
        if (!attached) reject(new Error("Provider worker attach timed out"));
        this.socket.destroy();
      }, HOST_REQUEST_TIMEOUT_MS);
      this.socket.on("connect", () => {
        this.send({
          type: "attach",
          token: environment.token,
          generation: environment.generation,
          protocolVersion: boundRuntimeIdentity(this.options)
            ? BOUND_RUNTIME_PROTOCOL_VERSION
            : this.options.creationRuntime
              ? 2
              : WORKER_PROTOCOL_VERSION,
          ...(this.options.creationRuntime
            ? { creation: this.options.creationRuntime.identity }
            : {}),
          ...(boundRuntimeIdentity(this.options)
            ? { binding: boundRuntimeIdentity(this.options) }
            : {}),
          agentApiPeerGrantId: this.options.agentApi?.peerGrantId,
          agentApiPeersAllowed: Boolean(
            this.options.agentApi?.peerAccess &&
              this.options.agentApi?.peerGrantId &&
              this.options.onAgentApiRead,
          ),
          agentApiAllowed: Boolean(
            this.options.agentApi && this.options.onAgentApiRead,
          ),
        });
      });
      this.socket.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const rawLine of lines) {
          if (!rawLine.trim()) continue;
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(rawLine) as Record<string, unknown>;
          } catch {
            this.fail(new Error("Provider worker sent invalid JSON"));
            continue;
          }
          if (!attached) {
            if (message.type === "attached") {
              if (
                message.protocolVersion !==
                (boundRuntimeIdentity(this.options)
                  ? BOUND_RUNTIME_PROTOCOL_VERSION
                  : this.options.creationRuntime
                    ? 2
                    : WORKER_PROTOCOL_VERSION)
              ) {
                clearTimeout(timeout);
                reject(new Error("Provider worker protocol is incompatible"));
                this.socket.destroy();
                continue;
              }
              try {
                this.applyAttachedState(message);
              } catch (error) {
                clearTimeout(timeout);
                reject(error);
                this.socket.destroy();
                continue;
              }
              attached = true;
              clearTimeout(timeout);
              resolve();
              continue;
            }
            if (message.type === "error") {
              clearTimeout(timeout);
              reject(new Error(String(message.error)));
              this.socket.destroy();
              continue;
            }
          }
          try {
            this.handleMessage(message);
          } catch (error) {
            this.fail(
              error instanceof Error ? error : new Error(String(error)),
            );
            this.socket.destroy();
          }
        }
      });
      this.socket.on("error", (error) => {
        if (!attached) {
          clearTimeout(timeout);
          reject(error);
        } else {
          this.providerAlive = false;
          forgetRuntimeAfterOwnerLoss(this.runtime.runtimeId);
          this.fail(
            new Error(
              `Provider worker process exited or connection failed: ${error.message}`,
            ),
          );
        }
      });
      this.socket.on("close", () => {
        clearTimeout(timeout);
        if (!attached)
          reject(new Error("Provider worker closed during attach"));
        if (!this.done && !this.detaching) {
          this.providerAlive = false;
          forgetRuntimeAfterOwnerLoss(this.runtime.runtimeId);
          this.fail(
            new Error("Provider worker process exited or connection closed"),
          );
        }
        this.finishIterator();
      });
    });
  }

  private applyAttachedState(message: Record<string, unknown>): void {
    if (this.options.creationRuntime) {
      const evidence = this.observeCreationEvidence(message.creation);
      this.initializedSessionId = evidence.nativeSessionId;
    }
    this.providerAlive = message.providerAlive !== false;
    this.activeProviderTurn = message.activeProviderTurn === true;
    this.queue.updateDepth(Number(message.queueDepth ?? 0));
    this.providerActivity = reviveActivity(
      message.providerActivity as ProviderActivitySnapshot | undefined,
    );
    this.providerRetention = reviveRetention(
      message.providerRetention as ProviderRetentionSnapshot | undefined,
    );
    if (message.appliedPermissionMode) {
      this.pendingAppliedPermissionMode =
        message.appliedPermissionMode as PermissionMode;
    }
    // Every provider reports init as its first event, so an owner that has
    // already acknowledged an event will never replay init to this
    // controller. Workers predating the explicit field fall back to the
    // runtime's bound session id.
    if (this.options.creationRuntime) return;
    const binding = boundRuntimeIdentity(this.options);
    if (binding) {
      if (
        !sameBoundRuntimeIdentity(binding, message.binding) ||
        (message.providerSessionId !== undefined &&
          message.providerSessionId !== binding.native.id) ||
        (Number(message.acknowledgedSequence ?? 0) > 0 &&
          !message.providerSessionId)
      )
        throw new Error(
          "Attached worker has conflicting native binding evidence",
        );
      this.initializedSessionId =
        typeof message.providerSessionId === "string"
          ? message.providerSessionId
          : undefined;
      return;
    }
    const providerSessionId = message.providerSessionId;
    this.initializedSessionId =
      typeof providerSessionId === "string" && providerSessionId
        ? providerSessionId
        : Number(message.acknowledgedSequence ?? 0) > 0
          ? (this.runtime.sessionId ?? this.options.resumeSessionId)
          : undefined;
  }

  private handleMessage(message: Record<string, unknown>): void {
    switch (message.type) {
      case "creationEvidence":
        this.observeCreationEvidence(message.creation);
        return;
      case "event":
        this.providerActivity = reviveActivity(
          message.providerActivity as ProviderActivitySnapshot | undefined,
        );
        this.providerRetention = reviveRetention(
          message.providerRetention as ProviderRetentionSnapshot | undefined,
        );
        this.enqueueEvent({
          sequence: Number(message.sequence),
          message: message.message as SDKMessage,
        });
        return;
      case "queueDepth":
        this.queue.updateDepth(Number(message.depth));
        return;
      case "queueRemoved":
        this.queue.removeAccepted(
          Array.isArray(message.uuids)
            ? message.uuids.map((value) => String(value))
            : [],
        );
        return;
      case "queueYielded":
        this.queue.notifyYielded(
          Array.isArray(message.uuids)
            ? message.uuids.map((value) => String(value))
            : [],
        );
        return;
      case "permissionMode":
        this.pendingAppliedPermissionMode = message.mode as PermissionMode;
        if (this.callbacksActive) {
          this.options.onPermissionModeApplied?.(
            this.pendingAppliedPermissionMode,
          );
        }
        return;
      case "providerRetention":
        this.providerRetention = reviveRetention(
          message.value as ProviderRetentionSnapshot,
        );
        if (this.callbacksActive) {
          this.options.onProviderRetentionChange?.();
        }
        return;
      case "approval":
        void this.handleApproval(message);
        return;
      case "agentApiRead":
        void this.handleAgentApiRead(message);
        return;
      case "agentApiCancel":
        this.agentApiControllers.get(String(message.requestId))?.abort();
        this.agentApiControllers.delete(String(message.requestId));
        return;
      case "approvalCancelled":
        this.cancelApproval(String(message.requestId));
        return;
      case "rpcResult":
        this.resolveRpc(message);
        return;
      case "complete":
        this.providerAlive = false;
        forgetRuntime(this.runtime.runtimeId);
        this.done = true;
        this.finishIterator();
        return;
      case "failed":
        this.providerAlive = false;
        forgetRuntime(this.runtime.runtimeId);
        this.fail(
          new Error(
            `Provider worker process exited: ${String(
              message.error ?? "unknown failure",
            )}`,
          ),
        );
        return;
    }
  }

  private enqueueEvent(event: { sequence: number; message: SDKMessage }): void {
    const waiter = this.iteratorWaiters.shift();
    if (waiter) {
      this.lastYieldedSequence = event.sequence;
      waiter.resolve({ done: false, value: event.message });
      return;
    }
    this.eventQueue.push(event);
  }

  private iteratorNext(): Promise<IteratorResult<SDKMessage>> {
    if (this.lastYieldedSequence !== null) {
      this.send({ type: "ack", sequence: this.lastYieldedSequence });
      this.lastYieldedSequence = null;
    }
    const event = this.eventQueue.shift();
    if (event) {
      this.lastYieldedSequence = event.sequence;
      return Promise.resolve({ done: false, value: event.message });
    }
    if (this.failure) return Promise.reject(this.failure);
    if (this.done) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => {
      this.iteratorWaiters.push({ resolve, reject });
    });
  }

  private finishIterator(): void {
    const waiters = this.iteratorWaiters.splice(0);
    for (const waiter of waiters) {
      if (this.failure) waiter.reject(this.failure);
      else waiter.resolve({ done: true, value: undefined });
    }
  }

  private fail(error: Error): void {
    if (!this.failure) this.failure = error;
    this.done = true;
    for (const pending of this.pendingRpc.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRpc.clear();
    this.cancelApprovals();
    this.finishIterator();
  }

  private send(message: unknown): void {
    if (
      message &&
      typeof message === "object" &&
      "type" in message &&
      message.type === "queuePush"
    )
      this.options.assertResumeAdmission?.();
    if (this.socket.destroyed)
      throw new Error("Provider worker is disconnected");
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  private rpc<T>(method: string, args: unknown[] = []): Promise<T> {
    // Cleanup and publication must remain possible after deletion. Only
    // methods capable of submitting new provider input cross this fence.
    if (
      method === "steer" ||
      method === "appendConversationContext" ||
      method === "forceReadInstructions" ||
      method === "refreshPromptCache" ||
      method === "runProviderCommand"
    )
      this.options.assertResumeAdmission?.();
    const id = this.nextRpcId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(new Error(`Provider worker ${method} timed out`));
      }, WORKER_RPC_TIMEOUT_MS);
      this.pendingRpc.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      try {
        this.send({ type: "rpc", id, method, args });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRpc.delete(id);
        reject(error);
      }
    });
  }

  private resolveRpc(message: Record<string, unknown>): void {
    const id = Number(message.id);
    const pending = this.pendingRpc.get(id);
    if (!pending) return;
    this.pendingRpc.delete(id);
    clearTimeout(pending.timeout);
    if (message.ok === false) {
      pending.reject(
        new Error(String(message.error ?? "Provider worker RPC failed")),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  private async handleApproval(
    message: Record<string, unknown>,
  ): Promise<void> {
    const requestId = String(message.requestId);
    if (this.handledApprovals.has(requestId)) return;
    if (!this.callbacksActive) {
      this.queuedApprovals.set(requestId, message);
      return;
    }
    this.handledApprovals.add(requestId);
    this.queuedApprovals.delete(requestId);
    const approval = this.options.onToolApproval;
    const controller = new AbortController();
    this.approvalControllers.set(requestId, controller);
    let result: ToolApprovalResult;
    try {
      result = approval
        ? await approval(String(message.toolName), message.input, {
            signal: controller.signal,
            permissionMode: message.permissionMode as
              | PermissionMode
              | undefined,
          })
        : { behavior: "deny", message: "No approval handler is attached" };
    } catch (error) {
      result = {
        behavior: "deny",
        message: `Approval handler failed: ${errorMessage(error)}`,
      };
    } finally {
      this.approvalControllers.delete(requestId);
    }
    if (!this.detaching && !this.socket.destroyed) {
      this.send({ type: "approvalResult", requestId, result });
    }
  }

  private cancelApproval(requestId: string): void {
    this.queuedApprovals.delete(requestId);
    this.approvalControllers.get(requestId)?.abort();
  }

  private cancelApprovals(): void {
    for (const controller of this.agentApiControllers.values())
      controller.abort();
    this.agentApiControllers.clear();
    this.queuedApprovals.clear();
    for (const controller of this.approvalControllers.values()) {
      controller.abort();
    }
    this.approvalControllers.clear();
  }

  private async detach(): Promise<void> {
    this.detaching = true;
    this.cancelApprovals();
    await requestHost("release", {
      runtimeId: this.runtime.runtimeId,
      ...runtimeControllerFields(this.options),
    });
    this.done = true;
    this.socket.end();
    this.finishIterator();
  }

  private observeCreationEvidence(value: unknown): CreationRuntimeEvidence {
    const creation = this.options.creationRuntime;
    if (!creation)
      throw new Error("Legacy worker sent managed creation evidence");
    const evidence = parseCreationRuntimeEvidence(value);
    if (!sameCreationRuntimeIdentity(creation.identity, evidence.identity))
      throw new Error(
        "Worker creation evidence does not match current attempt",
      );
    creation.observe(evidence);
    return evidence;
  }

  private async handleAgentApiRead(
    message: Record<string, unknown>,
  ): Promise<void> {
    const requestId = String(message.requestId);
    const parsed = agentCatalogRequest.safeParse({
      operation: message.operation,
      input: message.input,
    });
    const controller = new AbortController();
    if (
      this.agentApiControllers.has(requestId) ||
      this.agentApiControllers.size >= 16
    )
      return;
    this.agentApiControllers.set(requestId, controller);
    let reply: Record<string, unknown>;
    try {
      if (!parsed.success)
        throw new CoreApiError(
          "invalid_request",
          "Invalid catalog request",
          400,
        );
      if (!this.options.agentApi || !this.options.onAgentApiRead)
        throw new CoreApiError(
          "controller_unavailable",
          "Agent API access is disabled",
          503,
        );
      if (
        parsed.data.input.launch &&
        (!this.options.agentApi.peerAccess ||
          parsed.data.input.launch.peerGrantId !==
            this.options.agentApi.peerGrantId)
      ) {
        delete parsed.data.input.launch.peerAccess;
        delete parsed.data.input.launch.peerGrantId;
      }
      let cancel!: () => void;
      const cancelled = new Promise<never>((_, reject) => {
        cancel = () =>
          reject(
            new CoreApiError(
              "controller_unavailable",
              "Catalog read cancelled",
              503,
            ),
          );
      });
      controller.signal.addEventListener("abort", cancel, { once: true });
      let result: Awaited<
        ReturnType<NonNullable<StartSessionOptions["onAgentApiRead"]>>
      >;
      try {
        if (controller.signal.aborted) cancel();
        result = await Promise.race([
          this.options.onAgentApiRead(parsed.data.operation, SUPERUSER, {
            ...parsed.data.input,
            signal: controller.signal,
          }),
          cancelled,
        ]);
      } finally {
        controller.signal.removeEventListener("abort", cancel);
      }
      if (Buffer.byteLength(JSON.stringify(result)) > AGENT_CATALOG_MAX_BYTES)
        throw new CoreApiError(
          "invalid_request",
          "Catalog response exceeds the transport limit; reduce page size",
          400,
        );
      reply = { type: "agentApiResult", requestId, ok: true, result };
    } catch (error) {
      reply = {
        type: "agentApiResult",
        requestId,
        ok: false,
        error:
          error instanceof CoreApiError
            ? { code: error.code, message: error.message, status: error.status }
            : {
                code: "internal_error",
                message: "Catalog read failed",
                status: 500,
              },
      };
    } finally {
      if (this.agentApiControllers.get(requestId) === controller)
        this.agentApiControllers.delete(requestId);
    }
    if (
      !this.detaching &&
      !this.socket.destroyed &&
      !controller.signal.aborted
    ) {
      try {
        this.send(reply);
      } catch {
        // The controller socket may close between the guard and the write.
      }
    }
  }

  private activateCallbacks(): void {
    if (this.callbacksActive) return;
    this.callbacksActive = true;
    if (this.pendingAppliedPermissionMode) {
      this.options.onPermissionModeApplied?.(this.pendingAppliedPermissionMode);
    }
    for (const approval of this.queuedApprovals.values()) {
      void this.handleApproval(approval);
    }
  }

  private async abort(): Promise<void> {
    try {
      // The host owns the bounded cooperative/TERM/KILL ladder. Going through
      // it directly prevents a hung provider abort RPC from delaying cleanup.
      await requestHost("terminate", { runtimeId: this.runtime.runtimeId });
    } finally {
      forgetRuntime(this.runtime.runtimeId);
      this.cancelApprovals();
      this.providerAlive = false;
      this.done = true;
      this.socket.destroy();
      this.finishIterator();
    }
  }

  private getRuntimeUnviewedSince(): Date | undefined {
    return this.runtime.unviewedSince
      ? new Date(this.runtime.unviewedSince)
      : undefined;
  }

  private async setRuntimeViewerPresence(hasViewers: boolean): Promise<void> {
    const runtime = await requestHost<HostedProviderRuntimeInfo>(
      "setViewerPresence",
      {
        runtimeId: this.runtime.runtimeId,
        hasViewers,
      },
    );
    this.runtime.unviewedSince = runtime.unviewedSince;
  }

  private toAgentSession(): AgentSession {
    const iterator: AsyncIterableIterator<SDKMessage> = {
      [Symbol.asyncIterator]: () => iterator,
      next: () => this.iteratorNext(),
      return: async () => {
        this.done = true;
        this.finishIterator();
        return { done: true, value: undefined };
      },
    };
    const capabilities = this.runtime.worker.capabilities;
    return {
      iterator,
      queue: this.queue,
      abort: () => this.abort(),
      detachForServerReload: () => this.detach(),
      activateCallbacks: () => this.activateCallbacks(),
      isProcessAlive: () => this.providerAlive,
      pid: this.runtime.pid,
      sessionId: this.runtime.worker.sessionId,
      ...(this.runtime.reattach.gatewayServiceId
        ? { gatewayServiceId: this.runtime.reattach.gatewayServiceId }
        : {}),
      initializedSessionId: this.initializedSessionId,
      initialTurnState: this.activeProviderTurn ? "in-turn" : "idle",
      ...(capabilities.probeLiveness
        ? {
            probeLiveness: async () => {
              const result = await this.rpc<{
                status: import("@yep-anywhere/shared").SessionLivenessProbeStatus;
                source: string;
                detail?: string;
                checkedAt?: string | Date;
              }>("probeLiveness");
              return {
                ...result,
                checkedAt: result.checkedAt
                  ? new Date(result.checkedAt)
                  : undefined,
              };
            },
          }
        : {}),
      ...(capabilities.getProviderActivity
        ? { getProviderActivity: () => this.providerActivity }
        : {}),
      ...(capabilities.getProviderRetention
        ? { getProviderRetention: () => this.providerRetention }
        : {}),
      ...(this.runtime.lifecycleCapabilities?.viewerPresence
        ? {
            getRuntimeUnviewedSince: () => this.getRuntimeUnviewedSince(),
            setRuntimeViewerPresence: (hasViewers: boolean) =>
              this.setRuntimeViewerPresence(hasViewers),
          }
        : {}),
      ...(capabilities.refreshPromptCache
        ? { refreshPromptCache: (arg) => this.rpc("refreshPromptCache", [arg]) }
        : {}),
      ...(capabilities.publishAgentSelfSelection
        ? {
            publishAgentSelfSelection: (selection) =>
              this.rpc<void>("publishAgentSelfSelection", [selection]),
          }
        : {}),
      ...(capabilities.publishAgentSessionViews
        ? {
            publishAgentSessionViews: (views) =>
              this.rpc<void>("publishAgentSessionViews", [views]),
          }
        : {}),
      ...(capabilities.peerAgentApi
        ? {
            revokePeerAgentApiAccess: (grantId?: string) =>
              this.rpc<void>("revokePeerAgentApiAccess", [grantId]),
          }
        : {}),
      ...(capabilities.agentApi
        ? { revokeAgentApiAccess: () => this.rpc<void>("revokeAgentApiAccess") }
        : {}),
      publishAgentctlSessionId: async (sessionId, browserDebugEnvironment) => {
        const binding = boundRuntimeIdentity(this.options);
        if (binding && sessionId !== binding.sessionId)
          throw new Error(
            "Continuation child publication must use the YA identity",
          );
        if (
          this.options.creationRuntime &&
          sessionId !== this.options.creationRuntime.identity.sessionId
        )
          throw new Error("Managed child publication must use the YA identity");
        // Make the routing decision synchronous with Process learning the YA
        // session id. A SIGHUP can arrive while the two remote binds await.
        hostedSessionIds.set(this.runtime.runtimeId, sessionId);
        await this.rpc(
          "publishAgentctlSessionId",
          browserDebugEnvironment === undefined
            ? [sessionId]
            : [sessionId, pickStaticAgentEnvironment(browserDebugEnvironment)],
        );
        // The managed host already claimed P before startup; only the worker's
        // scoped evidence may establish N. Public publication is not a bind.
        if (this.options.creationRuntime || binding) return;
        const bound = await requestHost<HostedProviderRuntimeInfo>("bind", {
          runtimeId: this.runtime.runtimeId,
          sessionId,
        });
        rememberRuntime(bound);
      },
      ...(capabilities.steer
        ? {
            steerUsesMessageQueue: capabilities.steerUsesMessageQueue,
            steer: async (message) => {
              if (capabilities.steerUsesMessageQueue)
                this.queue.trackSteer(message);
              try {
                const steered = await this.rpc<boolean>("steer", [message]);
                if (!steered && message.uuid)
                  this.queue.removeAccepted([message.uuid]);
                return steered;
              } catch (error) {
                if (message.uuid) this.queue.removeAccepted([message.uuid]);
                throw error;
              }
            },
          }
        : {}),
      ...(capabilities.appendConversationContext
        ? {
            appendConversationContext: (turns) =>
              this.rpc<boolean>("appendConversationContext", [turns]),
          }
        : {}),
      ...(capabilities.instructionRestoration
        ? {
            configureInstructionRestoration: (
              control: import("./instruction-restoration.js").InstructionRestorationControl,
            ) => this.rpc<void>("configureInstructionRestoration", [control]),
            forceReadInstructions: (paths: readonly string[]) =>
              this.rpc<"native-history" | "user-turn">(
                "forceReadInstructions",
                [paths],
              ),
          }
        : {}),
      ...(capabilities.setMaxThinkingTokens
        ? {
            setMaxThinkingTokens: (tokens) =>
              this.rpc("setMaxThinkingTokens", [tokens]),
          }
        : {}),
      ...(capabilities.setEffort
        ? { setEffort: (effort) => this.rpc("setEffort", [effort]) }
        : {}),
      ...(capabilities.effortUpdatesActiveTurn
        ? { effortUpdatesActiveTurn: true }
        : {}),
      ...(capabilities.setServiceTier
        ? {
            setServiceTier: (serviceTier) =>
              this.rpc("setServiceTier", [serviceTier ?? null]),
          }
        : {}),
      ...(capabilities.setSessionOptions
        ? {
            setSessionOptions: (options) =>
              this.rpc<ProviderSessionOptionsUpdateResult>(
                "setSessionOptions",
                [options],
              ),
          }
        : {}),
      ...(capabilities.interrupt
        ? { interrupt: () => this.rpc("interrupt") }
        : {}),
      ...(capabilities.supportedModels
        ? { supportedModels: () => this.rpc("supportedModels") }
        : {}),
      ...(capabilities.supportedCommands
        ? { supportedCommands: () => this.rpc("supportedCommands") }
        : {}),
      ...(capabilities.getContextBreakdown
        ? { getContextBreakdown: () => this.rpc("getContextBreakdown") }
        : {}),
      ...(capabilities.setModel
        ? { setModel: (model) => this.rpc("setModel", [model]) }
        : {}),
      ...(capabilities.runProviderCommand
        ? {
            runProviderCommand: (command, argument) =>
              this.rpc("runProviderCommand", [command, argument]),
          }
        : {}),
    };
  }
}

function reviveActivity(
  value: ProviderActivitySnapshot | undefined,
): ProviderActivitySnapshot {
  return {
    lastRawProviderEventAt: value?.lastRawProviderEventAt
      ? new Date(value.lastRawProviderEventAt)
      : null,
    lastRawProviderEventSource: value?.lastRawProviderEventSource ?? null,
  };
}

function reviveRetention(
  value: ProviderRetentionSnapshot | undefined,
): ProviderRetentionSnapshot {
  return {
    retained: value?.retained ?? false,
    reasons: value?.reasons ?? [],
    backgroundTaskCount: value?.backgroundTaskCount,
    sessionCronCount: value?.sessionCronCount,
    liveTaskCount: value?.liveTaskCount,
    lastUpdatedAt: value?.lastUpdatedAt ? new Date(value.lastUpdatedAt) : null,
    backgroundWork: normalizeProviderWorkItems(value?.backgroundWork),
    foregroundWaits: normalizeProviderWorkItems(value?.foregroundWaits),
  };
}

export function providerRuntimeErrorMessage(error: unknown): string {
  return errorMessage(error);
}
