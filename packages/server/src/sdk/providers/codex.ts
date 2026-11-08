import { nativeStorageScope } from "./native-storage-scope.js";
import { parseNativeSessionId, toUrlProjectId } from "@yep-anywhere/shared";
import { resolveNativeSessionRef } from "../../sessions/SessionIdentityStore.js";
import { assertProviderForkSource } from "./types.js";
import {
  MCP_APP_EXTENSION_ID,
  MCP_APP_EXTENSION_SETTINGS,
  type McpAppProviderRequest,
  formatMcpAppModelContext,
  PROVIDER_WORK_ITEM_LIMIT,
  routerModelSupportsThinking,
} from "@yep-anywhere/shared";
import {
  codexRouterArguments,
  codexRouterEnvironment,
} from "./router-transport.js";
import { startAgentSelfSession } from "./agent-self.js";
/**
 * Codex Provider implementation using codex app-server JSON-RPC.
 *
 * Uses `codex app-server --listen stdio://` for turn execution so we can handle
 * server-initiated permission requests (command/file approval).
 */

import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  getCodexToolCorrelation,
  type CodexCyberAccessProgram,
  type CodexPlanToolMode,
  DEFAULT_CODEX_CYBER_ACCESS_PROGRAM,
  DEFAULT_CODEX_REASONING_SUMMARY,
  DEFAULT_SUBAGENT_MAX_DEPTH,
  codexCyberAccessProgramWireValue,
  type CodexReasoningSummary,
  type EffortLevel,
  type EffectiveSessionLaunchSettings,
  hasInvocationCandidate,
  type ModelCatalogStatus,
  type ModelInfo,
  type PermissionMode,
  type ProviderSubscriptionUsage,
  type SubagentMaxDepth,
  nativeModelEffort,
  resolveTurnEffort,
  thinkingOptionToConfig,
  type ThinkingOption,
} from "@yep-anywhere/shared";
import { isCodexBackgroundProcessOutput } from "../../codex/normalization.js";
import { log } from "./codex-log.js";
import { formatExecutableInvocation } from "../../utils/executableInvocation.js";
import {
  CODEX_INSTALLATION_FAMILY,
  type ProviderInstallationCoordinator,
  providerInstallationCoordinator,
} from "../../services/ProviderInstallationCoordinator.js";
import {
  findCodexCliPath,
  getCodexCliVersion,
  isCodexCliAuthenticated,
} from "../cli-detection.js";
import { logSDKMessage } from "../messageLogger.js";
import { MessageQueue } from "../messageQueue.js";
import { stripYaControlPlaneCredentials } from "./env-filter.js";
import type {
  ProviderCommandResult,
  ProviderLivenessProbeResult,
  SDKMessage,
  UserMessage,
} from "../types.js";
import type {
  SkillMetadata,
  SkillsListParams,
  SkillsListResponse,
  ThreadForkParams,
  ThreadForkResponse,
  ThreadGoalClearParams,
  ThreadGoalClearResponse,
  ThreadGoalGetParams,
  ThreadGoalGetResponse,
  ThreadGoalSetParams,
  ThreadGoalSetResponse,
  InitializeCapabilities,
  ListMcpServerStatusParams,
  ListMcpServerStatusResponse,
  McpResourceReadParams,
  McpResourceReadResponse,
  McpServerToolCallParams,
  McpServerToolCallResponse,
  ThreadReadParams,
  ThreadReadResponse,
  ThreadCompactStartParams,
  ThreadCompactStartResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  TurnInterruptParams,
  TurnInterruptResponse,
  TurnSettingsUpdateParams,
  TurnSettingsUpdateResponse,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerParams,
  TurnSteerResponse,
  UserInput,
} from "./codex-protocol/index.js";
import type { CyberAccessProgram } from "./codex-protocol/generated/v2/CyberAccessProgram.js";
import type { TurnError } from "./codex-protocol/generated/v2/TurnError.js";
import type { SandboxPolicy as CodexSandboxPolicy } from "./codex-protocol/generated/v2/SandboxPolicy.js";
import {
  createLaunchAgentctlSessionEnvBridge,
  type AgentctlSessionEnvBridge,
} from "./agentctl-session-env.js";
import {
  formatCodexStatusCommand,
  formatCodexUsageCommand,
  isCodexChatGptAccount,
  parseCodexUsageView,
} from "./codex-account-commands.js";
import {
  type AppServerModel,
  getFallbackCodexModelsForCliVersion,
  normalizeCodexModelList,
  normalizeSemver,
} from "./codex-model-catalog.js";
import { normalizeCodexSubscriptionUsage } from "./provider-subscription-usage.js";
import {
  fallbackModelCatalog,
  liveModelCatalog,
  modelCatalogError,
} from "./model-catalog-status.js";
import {
  asCodexErrorNotification,
  asCodexItemCompletedNotification,
  asCodexItemStartedNotification,
  asCodexRawResponseItemCompletedNotification,
  asCodexTurnCompletedNotification,
  isCodexLiveDeltaNotificationMethod,
  isCodexLiveDeltaSuppressionEnabled,
  readCodexTurnErrorDetail,
} from "./codex-notification-guards.js";
import { handleServerRequestApproval } from "./codex-approvals.js";
import {
  CodexAppServerClient,
  terminateChildProcess,
} from "./codex-app-server-client.js";
import {
  buildThreadPermissionParams,
  buildTurnPermissionParams,
  CODEX_POLICY_OVERRIDES,
  type CodexThreadPolicy,
  type CodexThreadTurn,
  limitedUserThreadInstructions,
  mapPermissionModeToThreadPolicy,
  normalizePermissionMode,
  resolveCodexForkLastTurnId,
} from "./codex-thread-params.js";
import {
  CODEX_DESKTOP_BROWSER_SKILL_NAME,
  createCodexSlashCommands,
  createCodexUserInputs,
} from "./codex-skill-inputs.js";
import {
  type CodexFailureTrace,
  describeNotificationForFailureTrace,
  describeSDKMessageForFailureTrace,
  formatCodexFailureTrace,
  recordCodexFailureTraceEvent,
  snapshotCodexFailureTrace,
} from "./codex-failure-trace.js";
import { CodexProviderWorkTracker } from "./codex-provider-work.js";
import {
  generateForkBackedSummary,
  generateSideSessionRecap,
  handleForkServerRequest,
} from "./codex-helper-threads.js";
import type { CodexProviderHost } from "./codex-provider-host.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  ProviderForkOptions,
  ProviderForkResult,
  ProviderLoginLaunch,
  StartSessionOptions,
  SummaryGenerationRequest,
  SummaryGenerationResult,
} from "./types.js";
import {
  agentServerEnvironmentFor,
  agentApiEnvironmentFor,
  inactiveProviderSessionOptionsResult,
} from "./types.js";
import {
  getOptionalString,
  isResultBackedThreadItem,
  logSdkCorrelationDebug,
  normalizeThreadItem,
  withCodexTimestamp,
} from "./codex-item-conversion.js";
import {
  type TokenUsageSnapshot,
  convertNotificationToSDKMessages,
  createLiveEventState,
  extractOpenAIRequestId,
  extractTurnUsage,
} from "./codex-live-event-conversion.js";
import type { JsonRpcNotification, JsonRpcResponse } from "./codex-json-rpc.js";
import type { SessionSandboxRuntime } from "../../session-sandbox.js";
import { withSessionSandboxAgentContext } from "../../session-sandbox-agent-context.js";

function formatCodexGoalStatus(
  status: ThreadGoalSetResponse["goal"]["status"],
): string {
  switch (status) {
    case "usageLimited":
      return "Goal usage limited";
    case "budgetLimited":
      return "Goal budget limited";
    default:
      return `Goal ${status}`;
  }
}

const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;
const MODEL_LIST_TIMEOUT_MS = 8000;
const ACCOUNT_RATE_LIMITS_TIMEOUT_MS = 8000;
const APP_SERVER_INIT_REQUEST_ID = 1;
const APP_SERVER_MODEL_LIST_REQUEST_ID = 2;
const CODEX_SERVER_OVERLOAD_RETRY_LIMIT = 16;
const CODEX_SERVER_OVERLOAD_RETRY_SCALE_MS = 5000;
const CODEX_SERVER_OVERLOAD_RETRY_MAX_DELAY_MS = 180_000;
const CODEX_THINKING_OFF_MIN_REASONING_EFFORT_PREFIXES = [
  "gpt-5.3-codex-spark",
] as const;

type CodexOverloadRetryWait = (
  delayMs: number,
  signal: AbortSignal,
) => Promise<boolean>;

function getCodexOverloadRetryDelayMs(attempt: number): number {
  return Math.min(
    (attempt + 1) ** 2 * CODEX_SERVER_OVERLOAD_RETRY_SCALE_MS,
    CODEX_SERVER_OVERLOAD_RETRY_MAX_DELAY_MS,
  );
}

async function waitForCodexOverloadRetry(
  delayMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false;

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (elapsed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve(elapsed);
    };
    const onAbort = (): void => finish(false);
    const timeout = setTimeout(() => finish(true), delayMs);
    timeout.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Codex 0.164 enables `instant_interrupt` by default, which makes
 * `turn/steer` cancel the in-flight model response, including a tool call
 * still being generated, instead of landing after the current tool call.
 * YA's steer is the after-tool-call lane, so session launches disable the
 * flag unless the user's own Codex config names it. `-c` rather than
 * `--disable`: a CLI that lacks the feature rejects `--disable` but ignores
 * an unknown `features.*` key.
 */
export async function codexSteerLaneArguments(
  env: NodeJS.ProcessEnv,
  mode?: import("@yep-anywhere/shared").SteeringMode,
): Promise<string[]> {
  return (await resolveCodexSteering(env, mode)).args;
}

async function resolveCodexSteering(
  env: NodeJS.ProcessEnv,
  mode?: import("@yep-anywhere/shared").SteeringMode,
): Promise<{
  args: string[];
  state: import("@yep-anywhere/shared").ProviderSteeringState;
}> {
  const configPath = join(
    env.CODEX_HOME ?? join(homedir(), ".codex"),
    "config.toml",
  );
  try {
    const config = await readFile(configPath, "utf8");
    if (/\binstant_interrupt\b/.test(config))
      return {
        args: [],
        state: { mode: "native-config", source: "native-config" },
      };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    args: ["-c", `features.instant_interrupt=${mode === "immediate"}`],
    state: {
      mode: mode ?? "gentle",
      source: mode ? "ya-setting" : "ya-default",
    },
  };
}

async function withCodexTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timeout.unref?.();
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

type CodexThreadResumeParamsForRequest = ThreadResumeParams;
type CodexThreadForkParamsForRequest = ThreadForkParams;

/**
 * When enabled, declare Codex session originator as "Codex Desktop" when
 * initializing app-server sessions. Disabled by default so we report
 * "yep-anywhere" as the originator, making Yep Anywhere usage visible in the
 * Codex/ChatGPT token-usage UI.
 */
const DECLARE_CODEX_ORIGINATOR = false;
const DECLARED_CODEX_ORIGINATOR = "Codex Desktop";

export function formatCodexLoginCommand(
  executablePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const trimmedPath = executablePath.trim();
  if (!trimmedPath || trimmedPath === "codex") return "codex login";
  return formatExecutableInvocation(trimmedPath, "login", platform);
}
const YEP_ANYWHERE_ORIGINATOR = "yep-anywhere";

interface CodexTurnRuntimeState {
  steeringMode?: import("@yep-anywhere/shared").SteeringMode;
  threadId: string;
  goalObjective?: string | null;
  goalStatus?: ThreadGoalSetResponse["goal"]["status"] | null;
  resolvedModel: string;
  turnModelOverride: string | null;
  latestTokenUsage?: TokenUsageSnapshot;
  activeTurnId: string | null;
  pendingTurnStart: Promise<string | null> | null;
  pendingCompaction?: {
    retryAttempt: number;
    requestAccepted: Promise<boolean>;
  };
  overloadRetryController?: AbortController;
  /** Signed-in account identity that scopes cyber access denials. */
  cyberAccessAccountKey?: string;
  activePermissionMode: PermissionMode;
  turnEffortOverride: EffortLevel | null | undefined;
  activeTurnHasEffortOverride?: boolean;
  /** Launch tier, or the live selection; null is an explicit Standard. */
  serviceTier: string | null | undefined;
  workspaceWriteSandboxPolicy: CodexSandboxPolicy | null;
  activeToolCallIds: Set<string>;
  backgroundToolCallIds: Set<string>;
  /** MCP App hosting as configured when this session's app-server started. */
  mcpAppViews: boolean;
  /** Latest `ui/update-model-context` per MCP App view, sent before the next turn. */
  mcpAppModelContext: Map<
    string,
    { server: string; tool: string; text: string }
  >;
}

type CodexRetryableTurnErrorKind = "capacityUnavailable" | "cyberAccessDenied";

interface CodexRetryableTurnError {
  kind: CodexRetryableTurnErrorKind;
  message: SDKMessage;
}

type CodexTurnErrorText = Pick<TurnError, "message" | "codexErrorInfo"> &
  Partial<Pick<TurnError, "additionalDetails">>;

function codexTurnErrorHttpStatus(error: CodexTurnErrorText): number | null {
  // Codex 0.162 declares `codexErrorInfo` open to future variants, so a known
  // variant key no longer narrows its body; read the status defensively.
  const info = error.codexErrorInfo;
  if (info && typeof info === "object") {
    for (const variant of [
      "httpConnectionFailed",
      "responseStreamDisconnected",
    ]) {
      if (!(variant in info)) continue;
      const body = (info as Record<string, unknown>)[variant];
      const status =
        body && typeof body === "object"
          ? (body as { httpStatusCode?: unknown }).httpStatusCode
          : null;
      return typeof status === "number" ? status : null;
    }
  }
  // Codex's error text carries the status even when the structured info
  // does not, for example `unexpected status 403 Forbidden: {...}`.
  const match = /\bunexpected status (\d{3})\b/.exec(
    `${error.message}\n${error.additionalDetails ?? ""}`,
  );
  return match ? Number(match[1]) : null;
}

/**
 * On a turn that requested a cyber access program, any HTTP 403 is treated as
 * the backend refusing that program. The refusal wording varies (`The
 * requested Cyber access program is not authorized for this model.`,
 * `Daybreak isn't available for this model.`) and enrollment can also hinge
 * on how the account signed in, so the body is not matched: a turn without
 * the program always beats a failed one.
 */
export function isCodexCyberAccessDenial(error: CodexTurnErrorText): boolean {
  return codexTurnErrorHttpStatus(error) === 403;
}

function classifyCodexTurnError(
  error: CodexTurnErrorText,
  cyberAccessRequested: boolean,
): CodexRetryableTurnErrorKind | null {
  // Codex 0.166 split policy-restricted capacity out of `serverOverloaded`
  // with the same retry advice, so both take YA's same-model overload retry.
  if (
    error.codexErrorInfo === "serverOverloaded" ||
    error.codexErrorInfo === "policyCapacityUnavailable"
  ) {
    return "capacityUnavailable";
  }
  if (cyberAccessRequested && isCodexCyberAccessDenial(error)) {
    return "cyberAccessDenied";
  }
  return null;
}

function getCodexNotificationThreadId(
  notification: JsonRpcNotification,
): string | null {
  if (!notification.params || typeof notification.params !== "object")
    return null;
  const params = notification.params as Record<string, unknown>;
  if (typeof params.threadId === "string") return params.threadId;
  if (notification.method !== "thread/started") return null;
  const thread = params.thread as { id?: unknown } | null | undefined;
  return typeof thread?.id === "string" ? thread.id : null;
}

function getCodexNotificationTurnId(
  notification: JsonRpcNotification,
  threadId: string,
): string | null {
  if (!notification.params || typeof notification.params !== "object") {
    return null;
  }
  const params = notification.params as Record<string, unknown>;
  if (params.threadId !== threadId) return null;

  if (
    notification.method === "turn/started" ||
    notification.method === "turn/completed"
  ) {
    const turn =
      params.turn && typeof params.turn === "object"
        ? (params.turn as Record<string, unknown>)
        : null;
    return typeof turn?.id === "string" ? turn.id : null;
  }

  // Any same-thread app-server notification carrying a top-level turnId was
  // produced for that live turn. Keeping this structural avoids silently
  // missing a newly added item/delta notification method.
  return typeof params.turnId === "string" ? params.turnId : null;
}

function getCodexNotificationTurnStartedAt(
  notification: JsonRpcNotification,
): number | null {
  if (
    (notification.method !== "turn/started" &&
      notification.method !== "turn/completed") ||
    !notification.params ||
    typeof notification.params !== "object"
  ) {
    return null;
  }
  const turn = (notification.params as Record<string, unknown>).turn;
  if (!turn || typeof turn !== "object") return null;
  const startedAt = (turn as Record<string, unknown>).startedAt;
  return typeof startedAt === "number" && Number.isFinite(startedAt)
    ? startedAt
    : null;
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

interface CodexSessionSkillInventory {
  skills: SkillMetadata[];
  stale: boolean;
}

/**
 * Configuration for Codex provider.
 */
export interface CodexProviderConfig {
  /** Path to codex binary (auto-detected if not specified) */
  codexPath?: string;
  /** API base URL override */
  baseUrl?: string;
  /** API key override (normally read from ~/.codex/auth.json) */
  apiKey?: string;
  /** Shared installation owner (injectable for deterministic tests). */
  installationCoordinator?: ProviderInstallationCoordinator;
  /** Overload retry timer (injectable for deterministic tests). */
  overloadRetryWait?: CodexOverloadRetryWait;
  /** Optional local Codex state root, including its config and credentials. */
  codexHome?: string;
}

/**
 * Codex Provider implementation using app-server JSON-RPC.
 */
export class CodexProvider implements AgentProvider {
  readonly name = "codex" as const;
  private readonly host: CodexProviderHost = {
    name: this.name,
    resolveCodexCommand: () => this.resolveCodexCommand(),
    getCodexEnv: () => this.getCodexEnv(),
    initializeAppServer: (appServer, clientName, mcpAppViews) =>
      this.initializeAppServer(appServer, clientName, mcpAppViews),
    getAvailableModels: () => this.getAvailableModels(),
  };
  readonly displayName = "Codex";
  readonly supportsNativeResumeSource = true;
  readonly supportsInlineImages = true;
  readonly supportsPermissionMode = true;
  readonly supportsThinkingToggle = true;
  readonly supportsSlashCommands = true;
  readonly supportsSteering = true;
  readonly steering = {
    selection: "launch" as const,
    modes: ["gentle", "immediate"] as const,
    defaultMode: "gentle" as const,
  };
  readonly supportsRecaps = true;
  readonly supportsNativePromptSuggestions = false;
  readonly supportsNativeCompactThreshold = true;

  private readonly config: CodexProviderConfig;
  private readonly installationCoordinator: ProviderInstallationCoordinator;
  private modelCache: {
    models: ModelInfo[];
    status: ModelCatalogStatus;
    expiresAt: number;
    installationSourceVersion: string;
  } | null = null;
  private modelCacheReadGeneration = 0;
  private getConfiguredReasoningSummary: () => CodexReasoningSummary = () =>
    DEFAULT_CODEX_REASONING_SUMMARY;
  private getConfiguredPlanToolMode: () => CodexPlanToolMode = () =>
    "provider-default";
  private getConfiguredCyberAccessProgram: () => CodexCyberAccessProgram = () =>
    DEFAULT_CODEX_CYBER_ACCESS_PROGRAM;
  /** Account, model and program scopes whose program request was refused. */
  private readonly cyberAccessDenials = new Set<string>();
  private getConfiguredSubagentMaxDepth: () => SubagentMaxDepth = () =>
    DEFAULT_SUBAGENT_MAX_DEPTH;
  private getMcpAppViews: () => boolean = () => false;
  private getSteeringMode: () =>
    | import("@yep-anywhere/shared").SteeringMode
    | undefined = () => undefined;

  constructor(config: CodexProviderConfig = {}) {
    this.config = config;
    this.installationCoordinator =
      config.installationCoordinator ?? providerInstallationCoordinator;
  }

  setCodexPath(codexPath: string | undefined): void {
    this.config.codexPath = codexPath;
    this.modelCache = null;
    this.modelCacheReadGeneration += 1;
  }

  setMcpAppViewsGetter(getter: () => boolean): void {
    this.getMcpAppViews = getter;
  }

  setSteeringModeGetter(
    getter: () => import("@yep-anywhere/shared").SteeringMode | undefined,
  ): void {
    this.getSteeringMode = getter;
  }

  setReasoningSummaryGetter(getter: () => CodexReasoningSummary): void {
    this.getConfiguredReasoningSummary = getter;
  }

  setPlanToolModeGetter(getter: () => CodexPlanToolMode): void {
    this.getConfiguredPlanToolMode = getter;
  }

  setCyberAccessProgramGetter(getter: () => CodexCyberAccessProgram): void {
    this.getConfiguredCyberAccessProgram = getter;
  }

  setSubagentMaxDepthGetter(getter: () => SubagentMaxDepth): void {
    this.getConfiguredSubagentMaxDepth = getter;
  }

  getModelCatalogCacheKey(): string {
    return this.installationCoordinator.getSourceVersion(
      CODEX_INSTALLATION_FAMILY,
    );
  }

  /**
   * Check if the Codex CLI is installed.
   */
  async isInstalled(): Promise<boolean> {
    return this.isCodexCliInstalled();
  }

  /**
   * Check if Codex CLI is installed by looking in PATH and common locations.
   */
  private async isCodexCliInstalled(): Promise<boolean> {
    return (
      (await findCodexCliPath(
        this.config.codexPath,
        this.installationCoordinator,
      )) !== null
    );
  }

  /**
   * Resolve the codex command: explicit config, PATH, or common install locations.
   */
  private async resolveCodexCommand(): Promise<string> {
    if (this.config.codexPath) return this.config.codexPath;
    return (
      (await findCodexCliPath(undefined, this.installationCoordinator)) ??
      "codex"
    );
  }

  async getNewSessionNamespace(
    cwd: string,
    sandbox?: Pick<
      import("../../session-sandbox.js").SessionSandboxRuntime,
      "transcriptDir"
    >,
  ) {
    if (sandbox)
      return {
        family: "codex" as const,
        storageScope: await nativeStorageScope(sandbox.transcriptDir),
      };
    const physicalCwd = await realpath(cwd);
    const env = this.getCodexEnv();
    let root = resolve(
      physicalCwd,
      env.CODEX_HOME ?? join(homedir(), ".codex"),
      "sessions",
    );
    const missing: string[] = [];
    for (;;) {
      try {
        root = join(await realpath(root), ...missing.reverse());
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = dirname(root);
        if (parent === root) throw error;
        missing.push(basename(root));
        root = parent;
      }
    }
    return { family: "codex" as const, storageScope: root };
  }

  private getCodexClientName(overrideClientName?: string): string {
    const normalizedClientName =
      typeof overrideClientName === "string" ? overrideClientName.trim() : "";
    if (normalizedClientName.length > 0) {
      return normalizedClientName;
    }
    return DECLARE_CODEX_ORIGINATOR
      ? DECLARED_CODEX_ORIGINATOR
      : YEP_ANYWHERE_ORIGINATOR;
  }

  /**
   * Build environment overrides for Codex subprocesses.
   */
  private getCodexEnv(): NodeJS.ProcessEnv {
    const env = stripYaControlPlaneCredentials(process.env);
    delete env.YEP_SESSION_WAKE_TOKEN;
    delete env.YEP_SESSION_WAKE_URL;
    if (this.config.baseUrl) {
      env.OPENAI_BASE_URL = this.config.baseUrl;
    }
    if (this.config.apiKey) {
      env.OPENAI_API_KEY = this.config.apiKey;
    }
    if (this.config.codexHome) {
      env.CODEX_HOME = this.config.codexHome;
    }
    // The pinned CLI treats an empty CODEX_HOME as unset. Keep admission,
    // auth/config reads and the native subprocess on that same namespace.
    if (env.CODEX_HOME === "") delete env.CODEX_HOME;
    return env;
  }

  /**
   * Check if Codex is authenticated.
   */
  async isAuthenticated(): Promise<boolean> {
    const authStatus = await this.getAuthStatus();
    return authStatus.authenticated;
  }

  /** Get detailed launchability and authentication status. */
  async getAuthStatus(): Promise<AuthStatus> {
    const codexPath = await findCodexCliPath(
      this.config.codexPath,
      this.installationCoordinator,
    );
    const installed = codexPath !== null;
    const codexEnv = this.getCodexEnv();
    const hasEnvironmentAuth = Boolean(
      ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"].some((name) =>
        codexEnv[name]?.trim(),
      ),
    );
    const authenticated = Boolean(
      codexPath &&
        (hasEnvironmentAuth ||
          (await isCodexCliAuthenticated(
            codexPath,
            codexEnv,
            this.installationCoordinator,
          ))),
    );
    return {
      installed,
      authenticated,
      enabled: authenticated,
      ...(codexPath && !authenticated
        ? { loginCommand: formatCodexLoginCommand(codexPath) }
        : {}),
    };
  }

  /** Sign in with the same CLI and CODEX_HOME that sessions use. */
  async getLoginLaunch(): Promise<ProviderLoginLaunch | null> {
    const codexPath = await findCodexCliPath(
      this.config.codexPath,
      this.installationCoordinator,
    );
    if (!codexPath) return null;
    return {
      executable: codexPath,
      env: this.getCodexEnv(),
      // Device-code sign-in completes from a browser on any device; the
      // default browser sign-in needs a callback on this host's localhost.
      relayedArgs: ["login", "--device-auth"],
      terminalArgs: ["login"],
      acceptsCode: false,
    };
  }

  /**
   * Get available models for Codex cloud.
   * Queries Codex app-server's model/list endpoint with a static fallback.
   */
  async getAvailableModels(options?: {
    forceRefresh?: boolean;
  }): Promise<ModelInfo[]> {
    return this.installationCoordinator.withReadLease(
      CODEX_INSTALLATION_FAMILY,
      () => this.getAvailableModelsWithLease(options?.forceRefresh === true),
    );
  }

  private async getAvailableModelsWithLease(
    forceRefresh: boolean,
  ): Promise<ModelInfo[]> {
    const now = Date.now();
    const installationSourceVersion = this.getModelCatalogCacheKey();
    if (forceRefresh) this.modelCache = null;
    if (
      this.modelCache &&
      this.modelCache.expiresAt > now &&
      this.modelCache.installationSourceVersion === installationSourceVersion
    ) {
      return this.modelCache.models;
    }
    const readGeneration = ++this.modelCacheReadGeneration;

    let models: ModelInfo[] = [];
    let error = "Codex CLI is not installed";
    if (await this.isCodexCliInstalled()) {
      const read = await this.getModelsFromAppServer();
      models = read.models;
      error = read.error ?? "Codex returned no models";
    }

    let status = liveModelCatalog();
    if (models.length === 0) {
      models = await this.getFallbackCodexModels();
      status = fallbackModelCatalog(error);
    }

    if (readGeneration === this.modelCacheReadGeneration) {
      this.modelCache = {
        models,
        status,
        expiresAt: Date.now() + MODEL_CACHE_TTL_MS,
        installationSourceVersion,
      };
    }

    return models;
  }

  async getSubscriptionUsage(
    models: readonly ModelInfo[],
  ): Promise<ProviderSubscriptionUsage | null> {
    return this.installationCoordinator.withReadLease(
      CODEX_INSTALLATION_FAMILY,
      () => this.getSubscriptionUsageWithLease(models),
    );
  }

  private async getSubscriptionUsageWithLease(
    models: readonly ModelInfo[],
  ): Promise<ProviderSubscriptionUsage | null> {
    if (!(await this.isCodexCliInstalled())) return null;
    try {
      const rawUsage = await this.requestAppServerRateLimits();
      return normalizeCodexSubscriptionUsage(rawUsage, models);
    } catch (error) {
      log.debug({ error }, "Codex account rate limits are unavailable");
      return null;
    }
  }

  getModelCatalogStatus(): ModelCatalogStatus | undefined {
    return this.modelCache?.status;
  }

  private async getModelsFromAppServer(): Promise<{
    models: ModelInfo[];
    error?: string;
  }> {
    try {
      const appServerModels = await this.requestAppServerModelList();
      return { models: normalizeCodexModelList(appServerModels) };
    } catch (error) {
      log.debug(
        { error },
        "Failed to query Codex app-server model list, using fallback models",
      );
      return { models: [], error: modelCatalogError(error) };
    }
  }

  private async requestAppServerModelList(): Promise<AppServerModel[]> {
    const codexCommand = await this.resolveCodexCommand();
    return new Promise((resolve, reject) => {
      const child = spawn(
        codexCommand,
        ["app-server", "--listen", "stdio://"],
        {
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
          env: this.getCodexEnv(),
          shell:
            process.platform === "win32" &&
            !codexCommand.toLowerCase().endsWith(".exe"),
        },
      );

      let settled = false;
      let stdoutBuffer = "";
      const stderrChunks: string[] = [];

      const finish = (handler: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        // Keep the discovery lease until the process releases its profile.
        // In particular, Windows cannot remove a still-open SQLite database.
        void terminateChildProcess(child).then(handler, reject);
      };

      const parseAndHandleLine = (line: string) => {
        let message: JsonRpcResponse;
        try {
          message = JSON.parse(line) as JsonRpcResponse;
        } catch {
          return;
        }

        if (message.id === APP_SERVER_INIT_REQUEST_ID) {
          if (message.error) {
            const errorMessage =
              message.error.message ?? "Codex app-server initialize failed";
            finish(() => reject(new Error(errorMessage)));
            return;
          }

          child.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`,
          );
          child.stdin.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: APP_SERVER_MODEL_LIST_REQUEST_ID,
              method: "model/list",
              params: { limit: 100 },
            })}\n`,
          );
          return;
        }

        if (message.id !== APP_SERVER_MODEL_LIST_REQUEST_ID) {
          return;
        }

        if (message.error) {
          const errorMessage =
            message.error.message ?? "Codex app-server model/list failed";
          finish(() => reject(new Error(errorMessage)));
          return;
        }

        const result = message.result as { data?: unknown[] } | undefined;
        const data = Array.isArray(result?.data) ? result.data : [];
        const models: AppServerModel[] = [];

        for (const item of data) {
          if (!item || typeof item !== "object") continue;
          const model = item as AppServerModel;
          if (typeof model.id !== "string") continue;
          models.push(model);
        }

        finish(() => resolve(models));
      };

      const timeoutHandle = setTimeout(() => {
        const stderr = stderrChunks.join("").trim();
        finish(() =>
          reject(
            new Error(
              stderr
                ? `Timed out querying Codex app-server model list: ${stderr}`
                : "Timed out querying Codex app-server model list",
            ),
          ),
        );
      }, MODEL_LIST_TIMEOUT_MS);

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuffer += chunk.toString("utf-8");
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.trim();
          if (!line) continue;
          parseAndHandleLine(line);
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk.toString("utf-8"));
      });

      child.on("error", (error) => {
        finish(() => reject(error));
      });

      child.on("exit", (code, signal) => {
        if (settled) return;
        const stderr = stderrChunks.join("").trim();
        const details = stderr ? ` stderr: ${stderr}` : "";
        finish(() =>
          reject(
            new Error(
              `Codex app-server exited before model/list response (code=${code ?? "null"}, signal=${signal ?? "null"}).${details}`,
            ),
          ),
        );
      });

      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: APP_SERVER_INIT_REQUEST_ID,
          method: "initialize",
          params: {
            clientInfo: {
              name: this.getCodexClientName(),
              version: "dev",
            },
            capabilities: null,
          },
        })}\n`,
      );
    });
  }

  private async requestAppServerRateLimits(): Promise<unknown> {
    const appServer = new CodexAppServerClient(
      await this.resolveCodexCommand(),
      homedir(),
      this.getCodexEnv(),
    );
    try {
      return await withCodexTimeout(
        (async () => {
          await appServer.connect();
          await appServer.request<{ userAgent: string }>(
            "initialize",
            this.createInitializeParams(false),
          );
          appServer.notify("initialized");
          return await appServer.request<unknown>("account/rateLimits/read");
        })(),
        ACCOUNT_RATE_LIMITS_TIMEOUT_MS,
        "Codex account rate-limit probe",
      );
    } finally {
      await appServer.close().catch((error) => {
        log.debug({ error }, "Failed to close Codex rate-limit app-server");
      });
    }
  }

  private async getFallbackCodexModels(): Promise<ModelInfo[]> {
    const version = await this.getInstalledCodexCliVersion();
    return getFallbackCodexModelsForCliVersion(version);
  }

  private async getInstalledCodexCliVersion(): Promise<string | null> {
    try {
      const codexCommand = await this.resolveCodexCommand();
      const version = await getCodexCliVersion(
        codexCommand,
        this.installationCoordinator,
      );
      return normalizeSemver(version);
    } catch {
      return null;
    }
  }

  private mapEffortToReasoningEffort(
    effort?: import("@yep-anywhere/shared").EffortLevel,
    thinking?: import("@yep-anywhere/shared").ThinkingConfig,
    model?: StartSessionOptions["model"],
    accountModels?: readonly ModelInfo[],
  ): NonNullable<TurnStartParams["effort"]> | undefined {
    if (
      accountModels &&
      effort &&
      !routerModelSupportsThinking(
        accountModels.find((m) => m.id === model),
        `on:${effort}`,
      )
    )
      throw new Error("Thinking level unavailable for the pinned account");
    if (thinking?.type === "disabled") {
      const supported = (accountModels ?? this.modelCache?.models)?.find(
        (candidate) => candidate.id === model,
      )?.supportedReasoningEfforts;
      if (
        supported?.length &&
        !supported.some((item) => item.reasoningEffort === "none")
      ) {
        const minimum = [
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
          "ultra",
        ].find((level) =>
          supported.some((item) => item.reasoningEffort === level),
        );
        if (minimum) return minimum;
      }
      const normalizedModel = model?.trim().toLowerCase();
      const hasSparkModelPrefix =
        CODEX_THINKING_OFF_MIN_REASONING_EFFORT_PREFIXES.some((prefix) =>
          normalizedModel?.startsWith(prefix),
        );
      if (hasSparkModelPrefix) {
        return "low";
      }
      return "none";
    }
    if (!effort) {
      return undefined;
    }
    switch (effort) {
      case "low":
        return "low";
      case "medium":
        return "medium";
      case "high":
        return "high";
      case "xhigh":
        return "xhigh";
      case "max": {
        const selectedModel = (accountModels ?? this.modelCache?.models)?.find(
          (candidate) =>
            candidate.id === model || (!model && candidate.isDefault),
        );
        return selectedModel
          ? nativeModelEffort("max", selectedModel)
          : "xhigh";
      }
    }
  }

  /**
   * Start a new Codex session.
   */
  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    return startAgentSelfSession(this.name, options, (resolved) =>
      this.startSessionInternal(resolved),
    );
  }

  private async startSessionInternal(
    options: StartSessionOptions,
  ): Promise<AgentSession> {
    if (options.nativeResumeSource) {
      if (!options.resumeSessionId)
        throw new Error("Native resume source requires a continuation id");
      if (!options.nativeResumeSource.filePath)
        throw new Error("Codex continuation requires its native rollout path");
      assertProviderForkSource(
        {
          nativeSessionId: parseNativeSessionId(options.resumeSessionId),
          nativeSource: options.nativeResumeSource,
        },
        this.name,
      );
      const env = this.getCodexEnv();
      const root =
        options.sessionSandbox?.transcriptDir ??
        join(env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
      if (
        (await realpath(root).catch(() => undefined)) !==
        options.nativeResumeSource.native.storageScope
      )
        throw new Error(
          "Codex continuation is outside the launch transcript store",
        );
    }
    const steeringMode = this.getSteeringMode();
    if (steeringMode === "immediate") {
      const version = await this.getInstalledCodexCliVersion();
      const parts = version?.split(".").map(Number);
      if (!parts || !((parts[0] ?? 0) > 0 || (parts[1] ?? 0) >= 164))
        throw new Error(
          `Immediate steering requires Codex 0.164.0 or newer (installed: ${version ?? "unknown"}). Update Codex or choose Gentle.`,
        );
    }
    // These effort mappings read the model's supported efforts, which a fresh
    // session worker has not loaded yet.
    if (
      !options.routerLaunch &&
      (options.effort === "max" ||
        options.thinking?.type === "disabled" ||
        options.initialMessage?.metadata?.turnEffort)
    )
      await this.getAvailableModels();
    const installationLease =
      await this.installationCoordinator.acquireRuntimeLease(
        CODEX_INSTALLATION_FAMILY,
      );
    const queue = new MessageQueue();
    const abortController = new AbortController();
    const runtimeState: CodexTurnRuntimeState = {
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
      mcpAppViews: this.getMcpAppViews(),
      mcpAppModelContext: new Map(),
    };

    // Push initial message if provided
    if (options.initialMessage) {
      queue.push(options.initialMessage);
    }

    let activeClient: CodexAppServerClient | null = null;
    const providerWork = new CodexProviderWorkTracker(
      () => options.onProviderRetentionChange?.(),
      async () => {
        const client = activeClient;
        const threadId = runtimeState.threadId;
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
    let goalCommandTail: Promise<void> = Promise.resolve();
    let resolveInitialActiveClient:
      | ((client: CodexAppServerClient | null) => void)
      | null = null;
    const initialActiveClient = new Promise<CodexAppServerClient | null>(
      (resolve) => {
        resolveInitialActiveClient = resolve;
      },
    );
    const settleInitialActiveClient = (
      client: CodexAppServerClient | null,
    ): void => {
      resolveInitialActiveClient?.(client);
      resolveInitialActiveClient = null;
    };
    let agentctlSessionEnvBridge: AgentctlSessionEnvBridge | null = null;
    const skillInventory: CodexSessionSkillInventory = {
      skills: [],
      stale: true,
    };
    const sessionIterator = this.runSession(
      options,
      queue,
      abortController.signal,
      runtimeState,
      (client) => {
        if (client !== activeClient) {
          activeClient?.setNotificationObserver(null);
          providerWork.reset();
          client.setNotificationObserver((notification) =>
            providerWork.observe(notification, runtimeState.threadId),
          );
        }
        activeClient = client;
        settleInitialActiveClient(client);
      },
      (bridge) => {
        agentctlSessionEnvBridge = bridge;
      },
      skillInventory,
    );
    const iterator = (async function* () {
      try {
        yield* sessionIterator;
      } finally {
        settleInitialActiveClient(null);
        await installationLease.release();
      }
    })();

    const updateActiveTurnSettings = async (
      settings: Pick<TurnSettingsUpdateParams, "model" | "effort">,
    ): Promise<void> => {
      const client = activeClient;
      let turnId = runtimeState.activeTurnId;
      if (!turnId && runtimeState.pendingTurnStart) {
        turnId = await runtimeState.pendingTurnStart;
      }
      const threadId = runtimeState.threadId;
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
    };

    return {
      iterator,
      queue,
      abort: async () => {
        settleInitialActiveClient(null);
        if (
          activeClient &&
          runtimeState.threadId &&
          runtimeState.activeTurnId
        ) {
          await withCodexTimeout(
            activeClient.request<TurnInterruptResponse>("turn/interrupt", {
              threadId: runtimeState.threadId,
              turnId: runtimeState.activeTurnId,
            } satisfies TurnInterruptParams),
            750,
            "Codex turn interrupt during shutdown",
          ).catch((error) => {
            log.debug(
              { error, sessionId: runtimeState.threadId },
              "Codex turn interrupt did not complete before shutdown",
            );
          });
        }
        abortController.abort();
        await activeClient?.close();
        await installationLease.release();
      },
      isProcessAlive: () => activeClient?.isAlive() ?? false,
      getProviderRetention: () => providerWork.getSnapshot(),
      getProviderActivity: () =>
        activeClient?.getProviderActivity() ?? {
          lastRawProviderEventAt: null,
          lastRawProviderEventSource: null,
        },
      get pid() {
        return activeClient?.pid;
      },
      probeLiveness: async () =>
        this.probeCodexLiveness(activeClient, runtimeState),
      publishAgentctlSessionId: (sessionId, browserDebugEnvironment) => {
        agentctlSessionEnvBridge?.publishSessionId(
          sessionId,
          browserDebugEnvironment,
        );
      },
      setEffort: async (effort) => {
        if (effort === "max" && !options.routerLaunch)
          await this.getAvailableModels();
        if (runtimeState.activeTurnHasEffortOverride) {
          runtimeState.turnEffortOverride = effort ?? null;
          const model = (
            options.routerLaunch
              ? (options.routerLaunch.models ?? [])
              : await this.getAvailableModels()
          ).find((candidate) => candidate.id === runtimeState.resolvedModel);
          await activeClient?.request("thread/settings/update", {
            threadId: runtimeState.threadId,
            effort:
              this.mapEffortToReasoningEffort(
                effort,
                options.thinking,
                runtimeState.resolvedModel,
                options.routerLaunch?.models,
              ) ?? model?.defaultReasoningEffort,
          });
          return;
        }
        if (effort !== undefined) {
          try {
            await updateActiveTurnSettings({
              effort: this.mapEffortToReasoningEffort(
                effort,
                options.thinking,
                runtimeState.turnModelOverride ?? runtimeState.resolvedModel,
                options.routerLaunch?.models,
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
                threadId: runtimeState.threadId,
                effort,
                reason: error.message,
              },
              "Codex refused live effort update; retaining selection for the next turn",
            );
          }
        }
        runtimeState.turnEffortOverride = effort ?? null;
      },
      supportedModels: async () =>
        options.routerLaunch
          ? (options.routerLaunch.models ?? [])
          : this.getAvailableModels(),
      effortUpdatesActiveTurn: true,
      setServiceTier: async (serviceTier) => {
        const next = serviceTier || null;
        // Thread settings apply from the next turn. Resume restores them only
        // from Codex 0.164.0, so later turn/start requests carry the
        // selection too.
        if (activeClient && runtimeState.threadId) {
          await activeClient.request("thread/settings/update", {
            threadId: runtimeState.threadId,
            serviceTier: next,
          });
        }
        runtimeState.serviceTier = next;
      },
      setModel: async (model) => {
        if (
          options.routerLaunch?.models &&
          !routerModelSupportsThinking(
            options.routerLaunch.models.find((m) => m.id === model),
            runtimeState.turnEffortOverride
              ? `on:${runtimeState.turnEffortOverride}`
              : "auto",
          )
        )
          throw new Error("Model unavailable for the pinned account");
        if (model !== undefined) {
          await updateActiveTurnSettings({ model });
        }
        runtimeState.turnModelOverride = model ?? null;
      },
      setSessionOptions: async (requested) =>
        inactiveProviderSessionOptionsResult(
          requested,
          "Codex app-server exposes explicit thread names but no automatic title, recap, progress-summary, or prompt-suggestion generator",
        ),
      supportedCommands: async () => {
        if (activeClient) {
          await this.refreshCodexSkills(
            activeClient,
            options.cwd,
            skillInventory,
            skillInventory.stale,
          );
          if (runtimeState.threadId) {
            try {
              const { goal } =
                await activeClient.request<ThreadGoalGetResponse>(
                  "thread/goal/get",
                  {
                    threadId: runtimeState.threadId,
                  } satisfies ThreadGoalGetParams,
                );
              runtimeState.goalObjective = goal?.objective ?? null;
              runtimeState.goalStatus = goal?.status ?? null;
            } catch (error) {
              log.debug({ error }, "Codex goal completion is unavailable");
            }
          }
        }
        return createCodexSlashCommands(
          skillInventory.skills,
          skillInventory.stale ? "stale" : "current",
          runtimeState.goalObjective,
          runtimeState.goalStatus,
        );
      },
      appendConversationContext: async (turns) => {
        if (!activeClient || !runtimeState.threadId) {
          throw new Error("Codex session is not ready for history insertion");
        }
        try {
          await activeClient.request("thread/inject_items", {
            threadId: runtimeState.threadId,
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
      },
      ...(runtimeState.mcpAppViews
        ? {
            mcpAppRequest: async (request: McpAppProviderRequest) => {
              const threadId = runtimeState.threadId;
              if (!activeClient || !threadId) {
                throw new Error("Codex session is not ready for MCP Apps");
              }
              switch (request.kind) {
                case "readResource":
                  return activeClient.request<McpResourceReadResponse>(
                    "mcpServer/resource/read",
                    {
                      threadId,
                      server: request.server,
                      uri: request.uri,
                      originCallId: request.originCallId ?? null,
                    } satisfies McpResourceReadParams,
                  );
                case "callTool":
                  return activeClient.request<McpServerToolCallResponse>(
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
                  const status =
                    await activeClient.request<ListMcpServerStatusResponse>(
                      "mcpServerStatus/list",
                      {
                        threadId,
                        serverName: request.server,
                        detail: "toolsAndAuthOnly",
                      } satisfies ListMcpServerStatusParams,
                    );
                  return (
                    status.data.find((entry) => entry.name === request.server)
                      ?.tools ?? {}
                  );
                }
                case "updateModelContext":
                  if (request.text === null) {
                    runtimeState.mcpAppModelContext.delete(request.key);
                  } else {
                    runtimeState.mcpAppModelContext.set(request.key, {
                      server: request.server,
                      tool: request.tool,
                      text: request.text,
                    });
                  }
                  return true;
              }
            },
          }
        : {}),
      steer: async (message) => {
        if (!activeClient) return false;
        if (!runtimeState.threadId || !runtimeState.activeTurnId) return false;

        let userPrompt = this.extractTextFromMessage(message);
        if (!userPrompt) return true;

        try {
          if (hasInvocationCandidate(userPrompt)) {
            await this.refreshCodexSkills(
              activeClient,
              options.cwd,
              skillInventory,
              true,
            );
          }
          const prepared = createCodexUserInputs(
            userPrompt,
            skillInventory.skills,
            skillInventory.stale ? "stale" : "current",
          );
          userPrompt = prepared.text;
          let expectedTurnId = runtimeState.activeTurnId;
          let retriedAfterMismatch = false;
          let steerResult: TurnSteerResponse;
          while (true) {
            try {
              steerResult = await activeClient.request<TurnSteerResponse>(
                "turn/steer",
                {
                  threadId: runtimeState.threadId,
                  clientUserMessageId: message.uuid ?? null,
                  input: prepared.input,
                  expectedTurnId,
                } satisfies TurnSteerParams,
              );
              break;
            } catch (error) {
              const actualTurnId = getCodexActiveTurnMismatchId(error);
              if (actualTurnId && actualTurnId !== expectedTurnId) {
                runtimeState.activeTurnId = actualTurnId;
                if (!retriedAfterMismatch) {
                  log.warn(
                    {
                      threadId: runtimeState.threadId,
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
            runtimeState.activeTurnId = steerResult.turnId;
          }
          return true;
        } catch (error) {
          log.warn(
            {
              threadId: runtimeState.threadId,
              turnId: runtimeState.activeTurnId,
              error: error instanceof Error ? error.message : String(error),
            },
            "Codex turn/steer failed; caller should queue message instead",
          );
          return false;
        }
      },
      interrupt: async () => {
        if (runtimeState.overloadRetryController) {
          runtimeState.overloadRetryController.abort();
          return true;
        }
        if (!activeClient) return false;
        if (!runtimeState.threadId || !runtimeState.activeTurnId) return false;
        let turnId = runtimeState.activeTurnId;
        let retriedAfterMismatch = false;
        while (true) {
          try {
            await activeClient.request<TurnInterruptResponse>(
              "turn/interrupt",
              {
                threadId: runtimeState.threadId,
                turnId,
              } satisfies TurnInterruptParams,
            );
            break;
          } catch (error) {
            const actualTurnId = getCodexActiveTurnMismatchId(error);
            if (actualTurnId && actualTurnId !== turnId) {
              runtimeState.activeTurnId = actualTurnId;
              if (!retriedAfterMismatch) {
                log.warn(
                  {
                    threadId: runtimeState.threadId,
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
      },
      runProviderCommand: async (
        command,
        argument,
      ): Promise<ProviderCommandResult> => {
        const name = command.trim().replace(/^\/+/, "").toLowerCase();
        if (name === "goal") {
          const operation = goalCommandTail.then(
            async (): Promise<ProviderCommandResult> => {
              const client = activeClient ?? (await initialActiveClient);
              const threadId = runtimeState.threadId;
              if (!client || !threadId) {
                return {
                  handled: true,
                  error: "Codex session is not ready for goal commands yet",
                };
              }

              const goalArgument = argument?.trim() ?? "";
              const goalControl = goalArgument.toLowerCase();
              try {
                if (!goalArgument) {
                  const response = await client.request<ThreadGoalGetResponse>(
                    "thread/goal/get",
                    { threadId } satisfies ThreadGoalGetParams,
                  );
                  return {
                    handled: true,
                    output: response.goal
                      ? {
                          summary: "/goal",
                          details: [
                            response.goal.objective,
                            formatCodexGoalStatus(response.goal.status),
                            `${response.goal.tokensUsed.toLocaleString()} tokens used`,
                          ],
                        }
                      : { summary: "/goal", details: ["No goal set"] },
                  };
                }

                // Every mutation below is a user-typed /goal. Codex 0.161+
                // records only `origin: "user"` edits in model history as user
                // instructions; older app-servers ignore the field.
                if (goalControl === "clear") {
                  const response =
                    await client.request<ThreadGoalClearResponse>(
                      "thread/goal/clear",
                      {
                        threadId,
                        origin: "user",
                      } satisfies ThreadGoalClearParams,
                    );
                  return {
                    handled: true,
                    output: {
                      summary: "/goal",
                      details: [
                        response.cleared ? "Goal cleared" : "No goal to clear",
                      ],
                    },
                  };
                }

                if (goalControl === "pause" || goalControl === "resume") {
                  const requestedStatus =
                    goalControl === "pause" ? "paused" : "active";
                  const response = await client.request<ThreadGoalSetResponse>(
                    "thread/goal/set",
                    {
                      threadId,
                      status: requestedStatus,
                      origin: "user",
                    } satisfies ThreadGoalSetParams,
                  );
                  return {
                    handled: true,
                    output: {
                      summary: "/goal",
                      details: [
                        response.goal.objective,
                        response.goal.status === requestedStatus
                          ? goalControl === "pause"
                            ? "Goal paused"
                            : "Goal resumed"
                          : formatCodexGoalStatus(response.goal.status),
                      ],
                    },
                  };
                }

                if (goalControl === "edit") {
                  return {
                    handled: true,
                    error:
                      "Interactive /goal edit is unavailable in YA. Set the revised objective with /goal <objective>.",
                  };
                }

                const current = await client.request<ThreadGoalGetResponse>(
                  "thread/goal/get",
                  { threadId } satisfies ThreadGoalGetParams,
                );
                if (current.goal?.objective === goalArgument) {
                  return {
                    handled: true,
                    output: {
                      summary: "/goal",
                      details: [
                        current.goal.objective,
                        formatCodexGoalStatus(current.goal.status),
                      ],
                    },
                  };
                }
                if (current.goal) {
                  await client.request<ThreadGoalClearResponse>(
                    "thread/goal/clear",
                    {
                      threadId,
                      origin: "user",
                    } satisfies ThreadGoalClearParams,
                  );
                }
                const response = await client.request<ThreadGoalSetResponse>(
                  "thread/goal/set",
                  {
                    threadId,
                    objective: goalArgument,
                    status: "active",
                    origin: "user",
                  } satisfies ThreadGoalSetParams,
                );
                return {
                  handled: true,
                  output: {
                    summary: "/goal",
                    details: [response.goal.objective, "Goal set"],
                  },
                };
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : String(error);
                log.warn(
                  { threadId, argument: goalArgument, error: message },
                  "Codex goal command failed",
                );
                return { handled: true, error: message };
              }
            },
          );
          // Serialize clear-and-set transactions; callers still receive failures.
          goalCommandTail = operation.then(
            () => {},
            () => {},
          );
          return operation;
        }

        if (name === "status" || name === "usage") {
          if (options.routerLaunch)
            return {
              handled: true,
              output: {
                summary:
                  "Account usage is available in the router account controls.",
              },
            };
          const client = activeClient ?? (await initialActiveClient);
          if (!client) {
            return {
              handled: true,
              output: {
                summary: `/${name}`,
                details: ["Codex session is not ready yet"],
              },
            };
          }

          if (name === "status") {
            const [accountResult, rateLimitsResult] = await Promise.allSettled([
              withCodexTimeout(
                client.request<unknown>("account/read", {
                  refreshToken: false,
                }),
                ACCOUNT_RATE_LIMITS_TIMEOUT_MS,
                "Codex account status",
              ),
              withCodexTimeout(
                client.request<unknown>("account/rateLimits/read"),
                ACCOUNT_RATE_LIMITS_TIMEOUT_MS,
                "Codex account rate limits",
              ),
            ]);
            return {
              handled: true,
              output: formatCodexStatusCommand({
                model: runtimeState.resolvedModel,
                cwd: options.cwd,
                permissionMode: runtimeState.activePermissionMode,
                threadId: runtimeState.threadId,
                tokenUsage: runtimeState.latestTokenUsage,
                accountResponse:
                  accountResult.status === "fulfilled"
                    ? accountResult.value
                    : undefined,
                rateLimitsResponse:
                  rateLimitsResult.status === "fulfilled"
                    ? rateLimitsResult.value
                    : undefined,
              }),
            };
          }

          const view = parseCodexUsageView(argument);
          if (!view) {
            return {
              handled: true,
              output: {
                summary: "Usage: /usage [daily|weekly|cumulative]",
              },
            };
          }
          try {
            const account = await withCodexTimeout(
              client.request<unknown>("account/read", {
                refreshToken: false,
              }),
              ACCOUNT_RATE_LIMITS_TIMEOUT_MS,
              "Codex account status",
            );
            if (!isCodexChatGptAccount(account)) {
              return {
                handled: true,
                output: {
                  summary: "Sign in with ChatGPT to use /usage.",
                },
              };
            }
            const usage = await withCodexTimeout(
              client.request<unknown>("account/usage/read"),
              ACCOUNT_RATE_LIMITS_TIMEOUT_MS,
              "Codex account token usage",
            );
            return {
              handled: true,
              output: formatCodexUsageCommand(usage, view),
            };
          } catch (error) {
            log.debug(
              { error, threadId: runtimeState.threadId },
              "Codex account token usage is unavailable",
            );
            return {
              handled: true,
              output: { summary: "Token activity unavailable" },
            };
          }
        }

        if (name !== "compact") {
          return { handled: false };
        }
        // Codex compaction takes no instructions, so any trailing argument is
        // intentionally dropped here — there is no app-server surface for it.
        if (!activeClient || !runtimeState.threadId) {
          return {
            handled: true,
            error: "Codex session is not ready for compaction yet",
          };
        }
        // A compact runs as its own (non-steerable) turn; refuse mid-turn so we
        // do not collide with active work or send `/compact` as plain text.
        if (
          runtimeState.activeTurnId ||
          runtimeState.pendingTurnStart ||
          runtimeState.pendingCompaction ||
          runtimeState.overloadRetryController
        ) {
          return {
            handled: true,
            error: "Cannot compact while a turn is in progress",
          };
        }
        const request = activeClient.request<ThreadCompactStartResponse>(
          "thread/compact/start",
          {
            threadId: runtimeState.threadId,
          } satisfies ThreadCompactStartParams,
        );
        runtimeState.pendingCompaction = {
          retryAttempt: 0,
          // The command reports RPC failures; queued input only needs to know
          // whether a compaction turn will follow the request.
          requestAccepted: request.then(
            () => true,
            () => false,
          ),
        };
        try {
          await request;
          return {
            handled: true,
            output: { summary: "Compaction requested" },
          };
        } catch (error) {
          runtimeState.pendingCompaction = undefined;
          const message =
            error instanceof Error ? error.message : String(error);
          log.warn(
            { threadId: runtimeState.threadId, error: message },
            "Codex thread/compact/start failed",
          );
          // The pinned compact RPC has no effects on a JSON-RPC refusal.
          // A broken transport can lose an accepted reply; never call that a refusal.
          const definitive =
            typeof (error as { jsonRpcCode?: unknown })?.jsonRpcCode ===
            "number";
          return {
            handled: true,
            error: message,
            ...(!definitive ? { uncertain: true as const } : {}),
          };
        }
      },
    };
  }

  async forkSession(options: ProviderForkOptions): Promise<ProviderForkResult> {
    return this.installationCoordinator.withReadLease(
      CODEX_INSTALLATION_FAMILY,
      () => this.forkSessionWithLease(options),
    );
  }

  private async forkSessionWithLease(
    options: ProviderForkOptions,
  ): Promise<ProviderForkResult> {
    assertProviderForkSource(options, this.name);
    const forkEnv = this.getCodexEnv();
    const sourceRoot = options.nativeSource?.native.storageScope;
    if (sourceRoot) {
      const launchRoot =
        options.sessionSandbox?.transcriptDir ??
        join(forkEnv.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
      if ((await realpath(launchRoot).catch(() => undefined)) !== sourceRoot)
        throw new Error(
          "Codex copy source is outside the launch transcript store; scoped resume is not qualified",
        );
    }
    if (options.boundary && options.boundary.kind !== "turn") {
      throw new Error("Codex fork requires a turn boundary");
    }
    if (
      options.launchSettings?.effort === "max" ||
      options.launchSettings?.thinking?.type === "disabled"
    ) {
      await this.getAvailableModels();
    }
    const codexCommand = await this.resolveCodexCommand();
    const appServer = new CodexAppServerClient(
      codexCommand,
      options.cwd,
      forkEnv,
      undefined,
      options.sessionSandbox,
    );
    appServer.setServerRequestHandler((request) =>
      handleForkServerRequest(request),
    );

    try {
      await appServer.connect();
      const experimentalApiEnabled = await this.initializeAppServer(appServer);
      appServer.notify("initialized");

      const lastTurnId =
        options.boundary?.kind === "turn"
          ? options.boundary.turnId
          : options.upToMessageId
            ? await resolveCodexForkLastTurnId(
                appServer,
                options.nativeSessionId,
                options.upToMessageId,
              )
            : undefined;
      const policy = mapPermissionModeToThreadPolicy(
        options.launchSettings?.permissionMode,
      );
      const fork = await appServer.request<ThreadForkResponse>(
        "thread/fork",
        this.createThreadForkParams(
          { ...options, lastTurnId },
          policy,
          experimentalApiEnabled,
        ),
      );
      const forkSessionId = fork.thread?.id;
      if (!forkSessionId) {
        throw new Error("Codex thread/fork did not return a thread id");
      }

      log.info(
        {
          sourceNativeSessionId: options.nativeSessionId,
          nativeForkSessionId: forkSessionId,
          lastTurnId: lastTurnId ?? null,
          upToMessageId: options.upToMessageId ?? null,
        },
        "Forked Codex app-server thread",
      );
      return {
        nativeSessionId: parseNativeSessionId(forkSessionId),
        ...(options.nativeSource || options.sessionSandbox
          ? {
              native: await resolveNativeSessionRef(
                this.name,
                options.sessionSandbox?.transcriptDir ??
                  join(
                    forkEnv.CODEX_HOME ?? join(homedir(), ".codex"),
                    "sessions",
                  ),
                parseNativeSessionId(forkSessionId),
              ),
              transcriptProjectId: toUrlProjectId(
                fork.thread.cwd ?? options.cwd,
              ),
            }
          : {}),
        ...(fork.thread.path ? { filePath: fork.thread.path } : {}),
      };
    } finally {
      await appServer.close();
    }
  }

  private async probeCodexLiveness(
    activeClient: CodexAppServerClient | null,
    runtimeState: CodexTurnRuntimeState,
  ): Promise<ProviderLivenessProbeResult> {
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
    if (!runtimeState.threadId) {
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
          threadId: runtimeState.threadId,
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
      const mappedStatus = this.mapCodexThreadStatusToLiveness(
        statusType,
        activeFlags,
      );

      if (mappedStatus === "idle" && runtimeState.activeTurnId) {
        activeClient.injectNotification({
          method: "turn/completed",
          params: {
            threadId: runtimeState.threadId,
            turn: {
              id: runtimeState.activeTurnId,
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
        detail: this.formatCodexThreadStatusProbeDetail(
          statusType,
          activeFlags,
        ),
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

  private mapCodexThreadStatusToLiveness(
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

  private formatCodexThreadStatusProbeDetail(
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

  /**
   * Main session loop using codex app-server.
   */
  private async *runSession(
    options: StartSessionOptions,
    queue: MessageQueue,
    signal: AbortSignal,
    runtimeState: CodexTurnRuntimeState,
    setActiveClient: (client: CodexAppServerClient) => void,
    setAgentctlSessionEnvBridge: (
      bridge: AgentctlSessionEnvBridge | null,
    ) => void,
    skillInventory: CodexSessionSkillInventory,
  ): AsyncIterableIterator<SDKMessage> {
    const codexCommand = await this.resolveCodexCommand();
    const {
      bridge: agentctlSessionEnvBridge,
      // Spawns must use this runtime: it also mounts the bridge directory.
      sessionSandbox,
    } = createLaunchAgentctlSessionEnvBridge({
      initialSessionId: options.publicSessionId ?? options.resumeSessionId,
      getSessionEnv: options.getSessionChildEnv,
      sessionSandbox: options.sessionSandbox,
    });
    setAgentctlSessionEnvBridge(agentctlSessionEnvBridge);
    const codexEnv = agentctlSessionEnvBridge.extendEnv({
      ...this.getCodexEnv(),
      ...options.agentEnvironment,
      // Never minted for a sandboxed launch; refuse here too.
      ...agentServerEnvironmentFor(options),
      ...agentApiEnvironmentFor(options),
    });
    const publicSessionId = options.publicSessionId ?? options.resumeSessionId;
    if (publicSessionId) {
      // The bridge only reaches bash tool shells that source BASH_ENV, which
      // codex's sandbox may strip. For resume the id is known at spawn, so set
      // it directly in the app-server env too; every shell codex launches
      // inherits it regardless of BASH_ENV. New sessions (id unknown until
      // thread/start) stay on the bridge alone.
      codexEnv.AGENTCTL_SESSION_ID = publicSessionId;
      Object.assign(codexEnv, options.getSessionChildEnv?.(publicSessionId));
    }
    const steering = await resolveCodexSteering(
      codexEnv,
      runtimeState.steeringMode,
    );
    const appServer = new CodexAppServerClient(
      codexCommand,
      options.cwd,
      options.routerLaunch
        ? codexRouterEnvironment(codexEnv, options.routerLaunch)
        : codexEnv,
      (notification) =>
        this.shouldSuppressLiveDeltaNotification(notification, options),
      sessionSandbox,
      [
        ...(options.routerLaunch
          ? codexRouterArguments(options.routerLaunch)
          : []),
        ...steering.args,
      ],
    );
    setActiveClient(appServer);

    let sessionId = options.resumeSessionId ?? "";
    const usageByTurnId = new Map<string, TokenUsageSnapshot>();
    const failureTrace: CodexFailureTrace = {
      sessionId: sessionId || undefined,
      activeTurnId: null,
      recentNotifications: [],
    };
    const logRawNotification = (notification: JsonRpcNotification): void => {
      this.logRawCodexNotification(sessionId || "unknown", notification);
    };

    appServer.setServerRequestHandler(async (request) => {
      return await handleServerRequestApproval(
        request,
        options,
        signal,
        runtimeState.activePermissionMode,
      );
    });

    try {
      await appServer.connect();

      const experimentalApiEnabled = await this.initializeAppServer(
        appServer,
        options.clientName,
        runtimeState.mcpAppViews,
      );
      appServer.notify("initialized");
      await this.refreshCodexSkills(
        appServer,
        options.cwd,
        skillInventory,
        false,
      );

      const initialPermissionMode = normalizePermissionMode(
        options.permissionMode,
      );
      const policy = mapPermissionModeToThreadPolicy(initialPermissionMode);

      if (options.nativeResumeSource && !experimentalApiEnabled)
        throw new Error(
          "Codex continuation requires native rollout path support",
        );
      const threadResumeParams = this.createThreadResumeParams(
        options,
        sessionId,
        policy,
        experimentalApiEnabled,
      );
      const threadStartParams = this.createThreadStartParams(options, policy);
      const threadResult = await this.startOrResumeThread(
        appServer,
        options,
        threadStartParams,
        threadResumeParams,
      );
      options.onPermissionModeApplied?.(initialPermissionMode);

      if (
        options.nativeResumeSource &&
        threadResult.thread.id !== options.nativeResumeSource.native.id
      )
        throw new Error("Codex resumed a different native thread");
      sessionId = threadResult.thread.id;
      agentctlSessionEnvBridge.publishSessionId(
        options.publicSessionId ?? sessionId,
      );
      runtimeState.threadId = sessionId;
      runtimeState.resolvedModel = threadResult.model;
      if (threadResult.sandbox?.type === "workspaceWrite") {
        runtimeState.workspaceWriteSandboxPolicy = threadResult.sandbox;
      }
      failureTrace.sessionId = sessionId;
      log.info(
        {
          sessionId,
          permissionMode: initialPermissionMode,
          approvalPolicy: policy.approvalPolicy,
          sandbox: policy.sandbox,
          policyOverrides: {
            approvalPolicy: CODEX_POLICY_OVERRIDES.approvalPolicy,
            sandbox: CODEX_POLICY_OVERRIDES.sandbox,
          },
          model: options.model ?? null,
          ...(options.routerLaunch ? { modelProvider: "aar" } : {}),
        },
        "Started Codex app-server session thread",
      );

      // Emit init immediately with the real session ID.
      yield withCodexTimestamp({
        type: "system",
        subtype: "init",
        steering: steering.state,
        session_id: sessionId,
        cwd: options.cwd,
        slash_command_inventory: createCodexSlashCommands(
          skillInventory.skills,
          skillInventory.stale ? "stale" : "current",
        ),
      } as SDKMessage);

      const requestedReasoningEffort = this.mapEffortToReasoningEffort(
        options.effort,
        options.thinking,
        options.model,
        options.routerLaunch?.models,
      );
      const sessionConfigAck = this.createSessionConfigAckMessage(
        sessionId,
        threadResult.model,
        options.model,
        threadResult.reasoningEffort,
        requestedReasoningEffort,
      );
      if (sessionConfigAck) {
        yield withCodexTimestamp(sessionConfigAck);
      }

      const liveEventState = createLiveEventState();
      const observeCommands = async (
        notification: JsonRpcNotification,
      ): Promise<SDKMessage | null> => {
        if (notification.method === "skills/changed") {
          skillInventory.stale = true;
          await this.refreshCodexSkills(
            appServer,
            options.cwd,
            skillInventory,
            true,
          );
          return withCodexTimestamp({
            type: "system",
            subtype: "commands_changed",
            session_id: sessionId,
            slash_command_inventory: createCodexSlashCommands(
              skillInventory.skills,
              skillInventory.stale ? "stale" : "current",
              runtimeState.goalObjective,
              runtimeState.goalStatus,
            ),
          } as SDKMessage);
        }
        const params = notification.params as
          | {
              threadId?: string;
              goal?: ThreadGoalSetResponse["goal"];
            }
          | undefined;
        if (
          params?.threadId !== sessionId ||
          (notification.method !== "thread/goal/updated" &&
            notification.method !== "thread/goal/cleared")
        )
          return null;
        const objective =
          notification.method === "thread/goal/cleared"
            ? null
            : params.goal?.objective;
        if (objective !== null && typeof objective !== "string") return null;
        const goalStatus =
          notification.method === "thread/goal/cleared"
            ? null
            : params.goal?.status;
        if (
          objective === runtimeState.goalObjective &&
          goalStatus === runtimeState.goalStatus
        )
          return null;
        runtimeState.goalObjective = objective;
        runtimeState.goalStatus = goalStatus;
        return withCodexTimestamp({
          type: "system",
          subtype: "commands_changed",
          session_id: sessionId,
          slash_command_inventory: createCodexSlashCommands(
            skillInventory.skills,
            skillInventory.stale ? "stale" : "current",
            objective,
            goalStatus,
          ),
        } as SDKMessage);
      };
      let pendingNotification: Promise<JsonRpcNotification> | null = null;
      const peekNotification = () => {
        if (!pendingNotification) {
          pendingNotification = appServer.nextNotification(signal);
          // A turn-start RPC can fail before the prefetched notification is read.
          void pendingNotification.catch(() => {});
        }
        return pendingNotification;
      };
      const readNotification = async () => {
        const notification = await peekNotification();
        pendingNotification = null;
        return notification;
      };
      const consumeTurn = async function* (
        provider: CodexProvider,
        turn: CodexThreadTurn,
        notificationBarrierSequence: number,
        cyberAccessRequested = false,
      ): AsyncGenerator<
        SDKMessage,
        { retryableError: CodexRetryableTurnError | null },
        void
      > {
        const activeTurnId = turn.id;
        runtimeState.activeTurnId = activeTurnId;
        runtimeState.activeToolCallIds.clear();
        runtimeState.backgroundToolCallIds.clear();
        failureTrace.activeTurnId = activeTurnId;
        let turnComplete = turn.status !== "inProgress";
        if (!turnComplete) {
          yield {
            type: "system",
            subtype: "session_state_changed",
            state: "running",
            session_id: sessionId,
          };
        }
        let emittedTurnError = false;
        let retryableError: CodexRetryableTurnError | null = null;
        let suppressedPreTurnNotifications: {
          count: number;
          firstSequence: number;
          lastSequence: number;
          firstTurnId: string;
          lastTurnId: string;
          firstMethod: string;
          lastMethod: string;
          firstStartedAt: number | null;
          lastStartedAt: number | null;
          maxQueueAgeMs: number;
          maxQueuedAhead: number;
        } | null = null;

        const logSuppressedPreTurnNotifications = (reason: string): void => {
          if (!suppressedPreTurnNotifications) return;
          log.warn(
            {
              sessionId,
              expectedTurnId: runtimeState.activeTurnId ?? activeTurnId,
              expectedTurnStartedAt: turn.startedAt,
              notificationBarrierSequence,
              ...suppressedPreTurnNotifications,
              reason,
            },
            "Suppressed stale Codex notifications queued before turn start",
          );
          suppressedPreTurnNotifications = null;
        };

        while (!turnComplete && !signal.aborted) {
          const notification = await readNotification();
          if (
            provider.shouldSuppressLiveDeltaNotification(notification, options)
          ) {
            continue;
          }
          const observedThreadId = getCodexNotificationThreadId(notification);
          if (
            observedThreadId !== null &&
            observedThreadId !== runtimeState.threadId
          ) {
            // Native subagents share this transport. Keep their raw diagnostics,
            // but never treat their tools, usage or completion as the parent's.
            logRawNotification(notification);
            continue;
          }
          const notificationReceipt =
            appServer.getNotificationReceipt(notification);
          const currentActiveTurnId: string =
            runtimeState.activeTurnId ?? activeTurnId;
          const observedTurnId = getCodexNotificationTurnId(
            notification,
            runtimeState.threadId,
          );
          const queuedBeforeTurnStart =
            notificationReceipt !== null &&
            notificationReceipt.sequence <= notificationBarrierSequence;
          if (
            observedTurnId &&
            observedTurnId !== currentActiveTurnId &&
            queuedBeforeTurnStart
          ) {
            // thread/resume normally replays the last turn's usage. It is not
            // stale live activity and needs no warning or active-id repair.
            if (notification.method === "thread/tokenUsage/updated") continue;
            const queueAgeMs = Math.max(
              0,
              Date.now() - notificationReceipt.receivedAtMs,
            );
            const startedAt = getCodexNotificationTurnStartedAt(notification);
            if (suppressedPreTurnNotifications) {
              suppressedPreTurnNotifications.count += 1;
              suppressedPreTurnNotifications.lastSequence =
                notificationReceipt.sequence;
              suppressedPreTurnNotifications.lastTurnId = observedTurnId;
              suppressedPreTurnNotifications.lastMethod = notification.method;
              suppressedPreTurnNotifications.lastStartedAt = startedAt;
              suppressedPreTurnNotifications.maxQueueAgeMs = Math.max(
                suppressedPreTurnNotifications.maxQueueAgeMs,
                queueAgeMs,
              );
              suppressedPreTurnNotifications.maxQueuedAhead = Math.max(
                suppressedPreTurnNotifications.maxQueuedAhead,
                notificationReceipt.queuedAhead,
              );
            } else {
              suppressedPreTurnNotifications = {
                count: 1,
                firstSequence: notificationReceipt.sequence,
                lastSequence: notificationReceipt.sequence,
                firstTurnId: observedTurnId,
                lastTurnId: observedTurnId,
                firstMethod: notification.method,
                lastMethod: notification.method,
                firstStartedAt: startedAt,
                lastStartedAt: startedAt,
                maxQueueAgeMs: queueAgeMs,
                maxQueuedAhead: notificationReceipt.queuedAhead,
              };
            }
            continue;
          }
          if (observedTurnId) {
            logSuppressedPreTurnNotifications(
              "turn-scoped notification reached",
            );
          }

          logRawNotification(notification);
          const goalCommands = await observeCommands(notification);
          if (goalCommands) yield goalCommands;
          if (notification.method === "skills/changed") {
            continue;
          }
          failureTrace.activeTurnId = currentActiveTurnId;

          if (notification.method === "thread/tokenUsage/updated") {
            const usage = extractTurnUsage(notification.params);
            if (usage) {
              usageByTurnId.set(usage.turnId, usage.snapshot);
              runtimeState.latestTokenUsage = usage.total;
            }
          }
          provider.updateBackgroundProcessTracking(notification, runtimeState);
          recordCodexFailureTraceEvent(
            failureTrace,
            describeNotificationForFailureTrace(notification),
          );

          // Resume replays token usage for the last persisted turn, possibly
          // after turn/start's receipt barrier. Usage attribution is not an
          // active-turn announcement; adopting its id retargets live controls.
          if (
            observedTurnId &&
            observedTurnId !== runtimeState.activeTurnId &&
            notification.method !== "thread/tokenUsage/updated"
          ) {
            log.warn(
              {
                sessionId,
                expectedTurnId: runtimeState.activeTurnId,
                actualTurnId: observedTurnId,
                notificationMethod: notification.method,
                notificationBarrierSequence,
                notificationReceiptSequence:
                  notificationReceipt?.sequence ?? null,
                notificationQueueAgeMs: notificationReceipt
                  ? Math.max(0, Date.now() - notificationReceipt.receivedAtMs)
                  : null,
                notificationQueuedAhead:
                  notificationReceipt?.queuedAhead ?? null,
                notificationSource: notificationReceipt?.source ?? null,
                notificationTurnStartedAt:
                  getCodexNotificationTurnStartedAt(notification),
              },
              "Resynchronized Codex turn id from provider notification",
            );
            runtimeState.activeTurnId = observedTurnId;
          }
          const effectiveActiveTurnId =
            runtimeState.activeTurnId ?? currentActiveTurnId;

          const messages = convertNotificationToSDKMessages(
            notification,
            sessionId,
            usageByTurnId,
            liveEventState,
          );
          const retryableKind = provider.classifyRetryableTurnError(
            notification,
            effectiveActiveTurnId,
            cyberAccessRequested,
          );
          const interruptCyberAccessRetry =
            retryableKind === "cyberAccessDenied" &&
            retryableError === null &&
            asCodexErrorNotification(notification.params)?.willRetry === true;
          const suppressFailedRetryableCompletion =
            retryableError !== null &&
            notification.method === "turn/completed" &&
            provider.isTurnTerminalNotification(
              notification,
              effectiveActiveTurnId,
            );
          for (const rawMsg of messages) {
            const msg =
              rawMsg.type === "error"
                ? ({
                    ...rawMsg,
                    codexFailureTrace: snapshotCodexFailureTrace(failureTrace),
                    codexFailureSummary: formatCodexFailureTrace(failureTrace),
                  } as SDKMessage)
                : rawMsg;
            if (retryableKind && msg.type === "error") {
              retryableError = { kind: retryableKind, message: msg };
              continue;
            }
            if (suppressFailedRetryableCompletion) {
              continue;
            }
            if (
              observedThreadId === runtimeState.threadId &&
              getCodexToolCorrelation(msg)?.origin === "command_execution"
            ) {
              // Private acquisition evidence, absent on older hosted workers.
              // A current native thread match is stronger than presentation ids.
              msg._codexOwnedCommand = true;
            }
            failureTrace.lastEmittedMessage =
              describeSDKMessageForFailureTrace(msg);
            yield msg;
          }

          if (retryableKind) {
            if (interruptCyberAccessRetry) {
              await appServer.request("turn/interrupt", {
                threadId: runtimeState.threadId,
                turnId: effectiveActiveTurnId,
              });
            }
            continue;
          }
          if (
            provider.isTurnTerminalNotification(
              notification,
              effectiveActiveTurnId,
            )
          ) {
            if (notification.method === "error") emittedTurnError = true;
            // A turn error precedes its completion; do not release queued work
            // while the provider still owns the failed turn.
            turnComplete =
              notification.method !== "error" || appServer.isClosed;
          }
        }
        logSuppressedPreTurnNotifications("turn consumption ended");
        runtimeState.activeTurnId = null;
        failureTrace.activeTurnId = null;

        if (signal.aborted) {
          return { retryableError: null };
        }

        if (
          !emittedTurnError &&
          turn.status === "failed" &&
          turn.error?.message
        ) {
          const fallbackError = {
            type: "error",
            uuid: `codex-error-${turn.id}`,
            session_id: sessionId,
            error: turn.error.message,
            codexErrorInfo: turn.error.codexErrorInfo ?? null,
            codexAdditionalDetails: readCodexTurnErrorDetail(turn.error),
            codexWillRetry: false,
            codexTurnId: turn.id,
            codexFailureTrace: snapshotCodexFailureTrace(failureTrace),
            codexFailureSummary: formatCodexFailureTrace(failureTrace),
            codexRequestId: extractOpenAIRequestId(
              turn.error,
              turn.error.additionalDetails,
              turn.error.message,
            ),
          } as SDKMessage;
          const kind = classifyCodexTurnError(turn.error, cyberAccessRequested);
          if (kind) {
            return { retryableError: { kind, message: fallbackError } };
          }
          yield fallbackError;
        }

        if (retryableError) {
          return { retryableError };
        }

        runtimeState.pendingCompaction = undefined;
        yield {
          type: "result",
          session_id: sessionId,
        } as SDKMessage;
        return { retryableError: null };
      };

      const overloadRetryWait =
        this.config.overloadRetryWait ?? waitForCodexOverloadRetry;
      const prepareOverloadRetry = async function* (
        overloadError: SDKMessage,
        attempt: number,
      ): AsyncGenerator<SDKMessage, boolean, void> {
        if (attempt > CODEX_SERVER_OVERLOAD_RETRY_LIMIT) {
          yield {
            ...overloadError,
            codexWillRetry: false,
            codexOverloadRetryExhausted: true,
            codexRetryAttempt: CODEX_SERVER_OVERLOAD_RETRY_LIMIT,
            codexRetryMaxRetries: CODEX_SERVER_OVERLOAD_RETRY_LIMIT,
          } as SDKMessage;
          return false;
        }

        const retryDelayMs = getCodexOverloadRetryDelayMs(attempt);
        const controller = new AbortController();
        const retrySignal = AbortSignal.any([signal, controller.signal]);
        runtimeState.overloadRetryController = controller;
        try {
          yield {
            ...overloadError,
            codexWillRetry: true,
            codexOverloadRetry: true,
            codexRetryDelayMs: retryDelayMs,
            codexRetryAttempt: attempt,
            codexRetryMaxRetries: CODEX_SERVER_OVERLOAD_RETRY_LIMIT,
          } as SDKMessage;
          log.info(
            {
              sessionId,
              turnId: overloadError.codexTurnId,
              model:
                runtimeState.turnModelOverride ?? runtimeState.resolvedModel,
              retryAttempt: attempt,
              retryDelayMs,
            },
            "Codex model is overloaded; waiting to retry the operation",
          );
          return (
            !retrySignal.aborted &&
            (await overloadRetryWait(retryDelayMs, retrySignal)) &&
            !retrySignal.aborted
          );
        } finally {
          runtimeState.overloadRetryController = undefined;
        }
      };

      const messageGen = queue[Symbol.asyncIterator]();
      const stopMessageWait = () => {
        void messageGen.return?.();
      };
      signal.addEventListener("abort", stopMessageWait, { once: true });
      let isFirstMessage = !options.resumeSessionId;
      let agentApiInstructions = options.agentApiInstructions;
      const globalContext = withSessionSandboxAgentContext(
        options.sessionSandbox?.instructions?.startFromDefault === false
          ? undefined
          : options.globalInstructions,
        options.sessionSandbox,
      );

      try {
        while (!signal.aborted) {
          let releaseQueueListener = () => {};
          const inputReady = new Promise<"input">((resolve) => {
            releaseQueueListener = queue.subscribeDepth((depth) => {
              if (depth > 0) resolve("input");
            });
          });
          let next: "input" | JsonRpcNotification;
          try {
            next = await Promise.race([peekNotification(), inputReady]);
            if (
              next === "input" &&
              runtimeState.pendingCompaction &&
              (await runtimeState.pendingCompaction.requestAccepted)
            ) {
              next = await peekNotification();
            }
          } finally {
            releaseQueueListener();
          }
          if (next !== "input") {
            pendingNotification = null;
            logRawNotification(next);
            const goalCommands = await observeCommands(next);
            if (goalCommands) yield goalCommands;
            if (next.method === "turn/started") {
              const params = asCodexTurnCompletedNotification(next.params);
              if (params?.threadId === sessionId) {
                // A turn YA did not start requested no cyber access program,
                // so only an overload can come back as retryable here.
                const { retryableError } = yield* consumeTurn(
                  this,
                  params.turn,
                  0,
                );
                const overloadError = retryableError?.message;
                if (overloadError) {
                  const compaction = runtimeState.pendingCompaction;
                  if (compaction) {
                    const retryReady = yield* prepareOverloadRetry(
                      overloadError,
                      ++compaction.retryAttempt,
                    );
                    if (retryReady) {
                      await appServer.request<ThreadCompactStartResponse>(
                        "thread/compact/start",
                        {
                          threadId: sessionId,
                        } satisfies ThreadCompactStartParams,
                      );
                      continue;
                    }
                    runtimeState.pendingCompaction = undefined;
                  } else {
                    yield overloadError;
                  }
                  yield { type: "result", session_id: sessionId } as SDKMessage;
                }
              }
            } else if (appServer.isClosed) {
              throw new Error("Codex app-server closed while awaiting work");
            }
            continue;
          }
          const queued = await messageGen.next();
          if (queued.done) break;
          const message = queued.value;
          if (signal.aborted) {
            break;
          }

          let userPrompt = this.extractTextFromMessage(message);
          if (!userPrompt) {
            continue;
          }

          // Prepend global instructions to the first message of new sessions
          if (agentApiInstructions) {
            userPrompt = `${agentApiInstructions}\n\n${userPrompt}`;
            agentApiInstructions = undefined;
          }
          if (isFirstMessage && globalContext) {
            userPrompt = `[Global context]\n${globalContext}\n\n---\n\n${userPrompt}`;
            isFirstMessage = false;
          } else {
            isFirstMessage = false;
          }

          if (hasInvocationCandidate(userPrompt)) {
            await this.refreshCodexSkills(
              appServer,
              options.cwd,
              skillInventory,
              true,
            );
          }
          const preparedInput = createCodexUserInputs(
            userPrompt,
            skillInventory.skills,
            skillInventory.stale ? "stale" : "current",
          );
          userPrompt = preparedInput.text;

          // Emit user message with UUID from queue to enable deduplication.
          const userMessage = withCodexTimestamp({
            type: "user",
            uuid: message.uuid,
            session_id: sessionId,
            message: {
              role: "user",
              content: userPrompt,
            },
          } as SDKMessage);
          logSdkCorrelationDebug(sessionId, userMessage, {
            eventKind: "user_message",
            phase: "submitted",
            sourceEvent: "queued_input",
          });
          failureTrace.lastUserMessage = {
            uuid: message.uuid,
            chars: userPrompt.length,
          };
          yield userMessage;

          const turnPermissionMode = normalizePermissionMode(
            this.getPermissionModeFromMessage(message) ??
              options.permissionMode,
          );
          const turnPolicy =
            mapPermissionModeToThreadPolicy(turnPermissionMode);
          runtimeState.activePermissionMode = turnPermissionMode;
          const cyberAccess = await this.resolveTurnCyberAccess(
            appServer,
            runtimeState,
            sessionId,
            runtimeState.turnModelOverride ?? runtimeState.resolvedModel,
          );
          const turnStartParams = this.createTurnStartParams(
            sessionId,
            preparedInput.input,
            options,
            turnPolicy,
            runtimeState.workspaceWriteSandboxPolicy,
            runtimeState.turnModelOverride,
            runtimeState.turnEffortOverride,
            message.uuid,
            cyberAccess.program,
            runtimeState.serviceTier,
          );
          let restoreThreadEffort: (() => Promise<unknown>) | undefined;
          if (message.turnEffort) {
            const modelId =
              runtimeState.turnModelOverride ?? runtimeState.resolvedModel;
            const model = (
              options.routerLaunch
                ? (options.routerLaunch.models ?? [])
                : await this.getAvailableModels()
            ).find((candidate) => candidate.id === modelId);
            if (!model)
              throw new Error(`No effort catalog for model ${modelId}`);
            const normal: ThinkingOption =
              options.thinking?.type === "disabled"
                ? "off"
                : runtimeState.turnEffortOverride
                  ? `on:${runtimeState.turnEffortOverride}`
                  : "auto";
            const selected = thinkingOptionToConfig(
              resolveTurnEffort(message.turnEffort, normal, model),
            );
            const baseline =
              turnStartParams.effort ??
              model.defaultReasoningEffort ??
              threadResult.reasoningEffort;
            if (!baseline)
              throw new Error(
                "Cannot restore the model's unknown normal effort",
              );
            turnStartParams.effort = this.mapEffortToReasoningEffort(
              selected.effort,
              selected.thinking,
              modelId,
              options.routerLaunch?.models,
            );
            runtimeState.activeTurnHasEffortOverride = true;
            restoreThreadEffort = () =>
              appServer.request("thread/settings/update", {
                threadId: sessionId,
                effort:
                  this.mapEffortToReasoningEffort(
                    runtimeState.turnEffortOverride ?? undefined,
                    options.thinking,
                    modelId,
                    options.routerLaunch?.models,
                  ) ??
                  model.defaultReasoningEffort ??
                  threadResult.reasoningEffort ??
                  baseline,
              });
          }
          await this.flushMcpAppModelContext(
            appServer,
            runtimeState,
            sessionId,
          );
          let notificationBarrierSequence =
            appServer.lastNotificationReceiptSequence;
          let settlePendingTurnStart: (turnId: string | null) => void =
            () => {};
          const pendingTurnStart = new Promise<string | null>((resolve) => {
            settlePendingTurnStart = resolve;
          });
          runtimeState.pendingTurnStart = pendingTurnStart;
          let turnResult: TurnStartResponse;
          try {
            turnResult = await appServer.request<TurnStartResponse>(
              "turn/start",
              turnStartParams,
            );
            runtimeState.activeTurnId = turnResult.turn.id;
            if (message.uuid)
              options.onNativeInputConsumed?.(sessionId, message.uuid);
            await restoreThreadEffort?.();
            settlePendingTurnStart(turnResult.turn.id);
          } catch (error) {
            settlePendingTurnStart(null);
            throw error;
          } finally {
            if (runtimeState.pendingTurnStart === pendingTurnStart) {
              runtimeState.pendingTurnStart = null;
            }
          }
          options.onPermissionModeApplied?.(turnPermissionMode);

          log.info(
            {
              sessionId,
              turnId: turnResult.turn.id,
              turnStatus: turnResult.turn.status,
              permissionMode: turnPermissionMode,
              approvalPolicy: turnPolicy.approvalPolicy,
              sandboxPolicy: turnStartParams.sandboxPolicy,
            },
            "Started Codex app-server turn",
          );
          let overloadRetryAttempt = 0;
          let cyberAccessProgram = cyberAccess.program;
          while (!signal.aborted) {
            const { retryableError } = yield* consumeTurn(
              this,
              turnResult.turn,
              notificationBarrierSequence,
              cyberAccessProgram !== null,
            );
            if (!retryableError) break;

            if (retryableError.kind === "cyberAccessDenied") {
              // The refusal happens before any model output, so the turn
              // reruns at once without the program. Later turns for this
              // account and model omit it from the start.
              if (cyberAccess.scope) {
                this.cyberAccessDenials.add(cyberAccess.scope);
              }
              cyberAccessProgram = null;
              yield {
                ...retryableError.message,
                codexWillRetry: true,
                codexCyberAccessRetry: true,
              } as SDKMessage;
              log.info(
                {
                  sessionId,
                  turnId: retryableError.message.codexTurnId,
                  model:
                    runtimeState.turnModelOverride ??
                    runtimeState.resolvedModel,
                  cyberAccessProgram: cyberAccess.program,
                },
                "Codex account is not authorized for the cyber access program; retrying without it",
              );
            } else {
              overloadRetryAttempt += 1;
              const retryReady = yield* prepareOverloadRetry(
                retryableError.message,
                overloadRetryAttempt,
              );
              if (!retryReady) {
                yield {
                  type: "result",
                  session_id: sessionId,
                } as SDKMessage;
                break;
              }
            }

            const retryTurnStartParams = this.createTurnStartParams(
              sessionId,
              [],
              options,
              turnPolicy,
              runtimeState.workspaceWriteSandboxPolicy,
              runtimeState.turnModelOverride,
              runtimeState.turnEffortOverride,
              undefined,
              cyberAccessProgram,
              runtimeState.serviceTier,
            );
            if (message.turnEffort)
              retryTurnStartParams.effort = turnStartParams.effort;
            notificationBarrierSequence =
              appServer.lastNotificationReceiptSequence;
            turnResult = await appServer.request<TurnStartResponse>(
              "turn/start",
              retryTurnStartParams,
            );
            await restoreThreadEffort?.();
            log.info(
              {
                sessionId,
                turnId: turnResult.turn.id,
                turnStatus: turnResult.turn.status,
                model: retryTurnStartParams.model ?? runtimeState.resolvedModel,
                retryAttempt: overloadRetryAttempt,
                approvalPolicy: turnPolicy.approvalPolicy,
                sandboxPolicy: retryTurnStartParams.sandboxPolicy,
              },
              "Retried failed Codex turn without resending user input",
            );
          }
          runtimeState.activeTurnHasEffortOverride = false;
        }
      } finally {
        signal.removeEventListener("abort", stopMessageWait);
        await messageGen.return?.();
      }
    } catch (error) {
      const codexFailureTrace = snapshotCodexFailureTrace(failureTrace);
      if (!signal.aborted) {
        log.error(
          { error, codexFailureTrace },
          "Error in codex app-server session",
        );
        yield {
          type: "error",
          // This catch exits the session loop and closes app-server below,
          // including a rejected thread/start while the RPC process is alive.
          uuid: `codex-error-${sessionId || "unknown"}-process-exit`,
          codexWillRetry: false,
          codexErrorScope: "app_server_process",
          session_id: sessionId,
          error: error instanceof Error ? error.message : String(error),
          codexFailureTrace,
          codexFailureSummary: formatCodexFailureTrace(codexFailureTrace),
        } as SDKMessage;
      }
    } finally {
      runtimeState.activeTurnId = null;
      try {
        await appServer.close();
      } finally {
        agentctlSessionEnvBridge.cleanup();
        setAgentctlSessionEnvBridge(null);
      }
    }

    yield {
      type: "result",
      session_id: sessionId,
    } as SDKMessage;
  }

  private logRawCodexNotification(
    sessionId: string,
    notification: JsonRpcNotification,
  ): void {
    logSDKMessage(
      sessionId || "unknown",
      {
        _rawSource: "codex_app_server_notification",
        ...notification,
      },
      { provider: "codex" },
    );
  }

  private shouldSuppressLiveDeltaNotification(
    notification: JsonRpcNotification,
    options: StartSessionOptions,
  ): boolean {
    if (!isCodexLiveDeltaNotificationMethod(notification.method)) {
      return false;
    }
    if (isCodexLiveDeltaSuppressionEnabled()) {
      return true;
    }
    return options.shouldEmitLiveDeltas?.() === false;
  }

  private isTurnTerminalNotification(
    notification: JsonRpcNotification,
    turnId: string,
  ): boolean {
    if (notification.method === "turn/completed") {
      const params = asCodexTurnCompletedNotification(notification.params);
      return params?.turn.id === turnId;
    }

    if (notification.method === "error") {
      const params = asCodexErrorNotification(notification.params);
      if (params) {
        return params.turnId === turnId && !params.willRetry;
      }
      const rawParams =
        notification.params && typeof notification.params === "object"
          ? (notification.params as Record<string, unknown>)
          : null;
      return (
        rawParams?.codexProcessExit === true && rawParams.willRetry === false
      );
    }

    return false;
  }

  /**
   * Classify a turn error that YA retries itself. A cyber access
   * denial counts only when this turn requested a program; the same 403 on a
   * turn that sent none has nothing to drop.
   */
  private classifyRetryableTurnError(
    notification: JsonRpcNotification,
    turnId: string,
    cyberAccessRequested: boolean,
  ): CodexRetryableTurnErrorKind | null {
    if (notification.method !== "error") return null;
    const params = asCodexErrorNotification(notification.params);
    if (params?.turnId !== turnId) return null;
    const kind = classifyCodexTurnError(params.error, cyberAccessRequested);
    return params.willRetry && kind !== "cyberAccessDenied" ? null : kind;
  }

  private updateBackgroundProcessTracking(
    notification: JsonRpcNotification,
    runtimeState: CodexTurnRuntimeState,
  ): void {
    if (notification.method === "rawResponseItem/completed") {
      const params = asCodexRawResponseItemCompletedNotification(
        notification.params,
      );
      const item =
        params?.item && typeof params.item === "object"
          ? (params.item as Record<string, unknown>)
          : null;
      const itemType = getOptionalString(item?.type);
      if (itemType === "function_call" || itemType === "custom_tool_call") {
        const callId = getOptionalString(item?.call_id);
        if (callId) {
          runtimeState.activeToolCallIds.add(callId);
        }
        return;
      }
      if (
        itemType === "function_call_output" ||
        itemType === "custom_tool_call_output"
      ) {
        const callId = getOptionalString(item?.call_id);
        if (!callId) return;
        if (isCodexBackgroundProcessOutput(item?.output)) {
          runtimeState.backgroundToolCallIds.add(callId);
        } else {
          runtimeState.activeToolCallIds.delete(callId);
          runtimeState.backgroundToolCallIds.delete(callId);
        }
      }
      return;
    }

    if (notification.method === "item/completed") {
      const params = asCodexItemCompletedNotification(notification.params);
      if (!params) return;
      const normalized = normalizeThreadItem(params.item);
      if (normalized?.type === "command_execution") {
        runtimeState.activeToolCallIds.delete(normalized.id);
        runtimeState.backgroundToolCallIds.delete(normalized.id);
      }
      return;
    }

    if (notification.method === "item/started") {
      const params = asCodexItemStartedNotification(notification.params);
      if (!params) return;
      const normalized = normalizeThreadItem(params.item);
      if (normalized && isResultBackedThreadItem(normalized)) {
        runtimeState.activeToolCallIds.add(normalized.id);
      }
    }
  }

  /**
   * Deliver each MCP App view's latest model context as hidden history ahead
   * of the user turn it informs. A failed insertion is logged and the context
   * stays held for the next turn.
   */
  private async flushMcpAppModelContext(
    appServer: CodexAppServerClient,
    runtimeState: CodexTurnRuntimeState,
    threadId: string,
  ): Promise<void> {
    if (runtimeState.mcpAppModelContext.size === 0) return;
    const held = [...runtimeState.mcpAppModelContext.values()];
    try {
      await appServer.request("thread/inject_items", {
        threadId,
        items: held.map(({ server, tool, text }) => ({
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: formatMcpAppModelContext(server, tool, text),
            },
          ],
        })),
      });
      runtimeState.mcpAppModelContext.clear();
    } catch (error) {
      log.warn(
        {
          event: "codex_mcp_app_context_inject_failed",
          threadId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Could not deliver MCP App model context before the turn",
      );
    }
  }

  private createInitializeParams(
    experimentalApiEnabled: boolean,
    clientName?: string,
    mcpAppViews = false,
  ): {
    clientInfo: { name: string; title: null; version: string };
    capabilities: Pick<
      InitializeCapabilities,
      "experimentalApi" | "extensions"
    > | null;
  } {
    return {
      clientInfo: {
        name: this.getCodexClientName(clientName),
        title: null,
        version: "dev",
      },
      capabilities: experimentalApiEnabled
        ? {
            experimentalApi: true,
            // Codex forwards these to every MCP server it connects, which is
            // how a server learns it may offer UI-bearing tools.
            ...(mcpAppViews
              ? {
                  extensions: {
                    [MCP_APP_EXTENSION_ID]: MCP_APP_EXTENSION_SETTINGS,
                  },
                }
              : {}),
          }
        : null,
    };
  }

  private async initializeAppServer(
    appServer: CodexAppServerClient,
    clientName?: string,
    mcpAppViews = false,
  ): Promise<boolean> {
    try {
      await appServer.request<{ userAgent: string }>(
        "initialize",
        this.createInitializeParams(true, clientName, mcpAppViews),
      );
      return true;
    } catch (error) {
      log.info(
        {
          event: "codex_experimental_api_unavailable",
          error: error instanceof Error ? error.message : String(error),
        },
        "Codex initialize with experimentalApi failed; retrying without capabilities",
      );
      await appServer.request<{ userAgent: string }>(
        "initialize",
        this.createInitializeParams(false, clientName),
      );
      return false;
    }
  }

  private async startOrResumeThread(
    appServer: CodexAppServerClient,
    options: StartSessionOptions,
    threadStartParams: ThreadStartParams,
    threadResumeParams: CodexThreadResumeParamsForRequest,
  ): Promise<ThreadStartResponse | ThreadResumeResponse> {
    return options.resumeSessionId
      ? await appServer.request<ThreadResumeResponse>(
          "thread/resume",
          threadResumeParams,
        )
      : await appServer.request<ThreadStartResponse>(
          "thread/start",
          threadStartParams,
        );
  }

  private createThreadStartParams(
    options: StartSessionOptions,
    policy: CodexThreadPolicy,
  ): ThreadStartParams {
    return {
      model: options.model ?? null,
      ...(options.routerLaunch ? { modelProvider: "aar" } : {}),
      ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
      cwd: options.cwd,
      ...buildThreadPermissionParams(policy),
      config: this.buildThreadConfigOverrides(options),
      ...limitedUserThreadInstructions(options.sessionSandbox),
      experimentalRawEvents: false,
      ...(options.sessionSandbox?.instructions?.startFromDefault === false
        ? { baseInstructions: "" }
        : {}),
    };
  }

  private createThreadResumeParams(
    options: StartSessionOptions,
    sessionId: string,
    policy: CodexThreadPolicy,
    experimentalApiEnabled = false,
    includeTurns = false,
  ): CodexThreadResumeParamsForRequest {
    const params: CodexThreadResumeParamsForRequest = {
      threadId: options.resumeSessionId ?? sessionId,
      ...(options.nativeResumeSource
        ? { path: options.nativeResumeSource.filePath }
        : {}),
      model: options.model ?? null,
      ...(options.routerLaunch ? { modelProvider: "aar" } : {}),
      ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
      cwd: options.cwd,
      ...buildThreadPermissionParams(policy),
      config: this.buildThreadConfigOverrides(options),
      ...limitedUserThreadInstructions(options.sessionSandbox),
    };
    if (experimentalApiEnabled && !includeTurns) {
      params.excludeTurns = true;
    }
    return params;
  }

  private createThreadForkParams(
    options: {
      nativeSessionId: ProviderForkOptions["nativeSessionId"];
      nativeSource?: ProviderForkOptions["nativeSource"];
      cwd: string;
      lastTurnId?: string;
      sessionSandbox?: SessionSandboxRuntime;
      launchSettings?: Omit<
        EffectiveSessionLaunchSettings,
        "schemaVersion" | "revision"
      >;
    },
    policy: CodexThreadPolicy,
    experimentalApiEnabled = false,
  ): CodexThreadForkParamsForRequest {
    const settings = options.launchSettings;
    const model =
      settings?.requestedModel && settings.requestedModel !== "default"
        ? settings.requestedModel
        : undefined;
    const params: CodexThreadForkParamsForRequest = {
      ...(model ? { model } : {}),
      ...(settings ? { serviceTier: settings.serviceTier } : {}),
      threadId: options.nativeSessionId,
      ...(options.nativeSource ? { path: options.nativeSource.filePath } : {}),
      ...(options.lastTurnId ? { lastTurnId: options.lastTurnId } : {}),
      cwd: options.cwd,
      ...buildThreadPermissionParams(policy),
      config: this.buildThreadConfigOverrides({
        model,
        thinking: settings?.thinking ?? undefined,
        effort: settings?.effort ?? undefined,
      }),
      ...limitedUserThreadInstructions(options.sessionSandbox),
    };
    if (experimentalApiEnabled) {
      params.excludeTurns = true;
    }
    return params;
  }

  private buildThreadConfigOverrides(
    options: Pick<
      StartSessionOptions,
      | "compactAtContextTokenLimit"
      | "effort"
      | "thinking"
      | "model"
      | "routerLaunch"
      | "agentApiEnvironment"
    >,
  ): NonNullable<ThreadStartParams["config"]> {
    // The OpenAI browser plugin controls a desktop-owned browser backend that
    // YA's Codex app-server host does not provide. Suppress the unavailable
    // skill at thread scope so Codex follows YA's Playwright fallback instead
    // of advertising a browser that fails during backend discovery.
    const config: NonNullable<ThreadStartParams["config"]> = {
      model_reasoning_summary: this.getConfiguredReasoningSummary(),
      skills: {
        config: [
          {
            name: CODEX_DESKTOP_BROWSER_SKILL_NAME,
            enabled: false,
          },
        ],
      },
    };
    if (options.agentApiEnvironment) {
      // A policy-admitted Authorization value must not enter Codex shell
      // snapshot files. This affects only the explicit YA API opt-in.
      config.features = { shell_snapshot: false, shell_snapshot_v2: false };
    }
    const planToolMode = this.getConfiguredPlanToolMode();
    if (planToolMode !== "provider-default") {
      config.tools = {
        update_plan: {
          enabled: planToolMode === "enabled",
        },
      };
    }
    const subagentMaxDepth = this.getConfiguredSubagentMaxDepth();
    if (subagentMaxDepth !== null) {
      config.agents = { max_depth: subagentMaxDepth };
    }
    const reasoningEffort = this.mapEffortToReasoningEffort(
      options.effort,
      options.thinking,
      options.model,
      options.routerLaunch?.models,
    );
    if (reasoningEffort) {
      config.model_reasoning_effort = reasoningEffort;
    }
    if (
      options.compactAtContextTokenLimit !== undefined &&
      Number.isFinite(options.compactAtContextTokenLimit) &&
      options.compactAtContextTokenLimit > 0
    ) {
      config.model_auto_compact_token_limit = Math.round(
        options.compactAtContextTokenLimit,
      );
      // The YA setting is explicitly a percentage of the full active context.
      // Pin the scope so a user's Codex config cannot reinterpret it as growth
      // after the carried compaction prefix.
      config.model_auto_compact_token_limit_scope = "total";
    }
    return config;
  }

  private async refreshCodexSkills(
    appServer: CodexAppServerClient,
    cwd: string,
    inventory: CodexSessionSkillInventory,
    forceReload: boolean,
  ): Promise<void> {
    try {
      const result = await appServer.request<SkillsListResponse>(
        "skills/list",
        {
          cwds: [cwd],
          forceReload,
        } satisfies SkillsListParams,
      );
      inventory.skills = result.data.flatMap((entry) => entry.skills);
      inventory.stale = false;
    } catch (error) {
      inventory.stale = true;
      log.debug(
        {
          error: error instanceof Error ? error.message : String(error),
          cwd,
        },
        "Codex skill inventory is unavailable",
      );
    }
  }

  private createTurnStartParams(
    threadId: string,
    input: UserInput[],
    options: StartSessionOptions,
    turnPolicy: CodexThreadPolicy | null = null,
    workspaceWriteSandboxPolicy: CodexSandboxPolicy | null = null,
    modelOverride: string | null = options.model ?? null,
    effortOverride: EffortLevel | null | undefined = options.effort,
    clientUserMessageId?: string,
    cyberAccessProgram: CyberAccessProgram | null = null,
    serviceTier: string | null | undefined = options.serviceTier,
  ): TurnStartParams {
    return {
      threadId,
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
      model: modelOverride,
      ...(serviceTier || serviceTier === null ? { serviceTier } : {}),
      input,
      effort:
        effortOverride === null
          ? null
          : this.mapEffortToReasoningEffort(
              effortOverride,
              options.thinking,
              modelOverride ?? undefined,
              options.routerLaunch?.models,
            ),
      ...buildTurnPermissionParams(turnPolicy, workspaceWriteSandboxPolicy),
      ...(cyberAccessProgram ? { cyberAccessProgram } : {}),
    };
  }

  /**
   * Codex resolves the access program per turn and forgets it afterward, so
   * every user turn carries the current selection. Omitting the field keeps
   * Codex's automatic choice, which is what the default does. YA-internal
   * helper turns such as the recap thread never send it.
   *
   * Enrollment belongs to the ChatGPT account and model, not to YA's
   * server-wide setting, so a selection the backend already refused for this
   * account and model is omitted rather than failing every turn. `scope` is
   * null when no program is configured; it names the denial to record if the
   * backend refuses the requested one.
   */
  private async resolveTurnCyberAccess(
    appServer: CodexAppServerClient,
    runtimeState: CodexTurnRuntimeState,
    sessionId: string,
    model: string | null,
  ): Promise<{ program: CyberAccessProgram | null; scope: string | null }> {
    const program = codexCyberAccessProgramWireValue(
      this.getConfiguredCyberAccessProgram(),
    );
    if (!program) return { program: null, scope: null };
    if (model) {
      let cursor: string | null | undefined;
      do {
        const page = await withCodexTimeout(
          appServer.request<{
            data: AppServerModel[];
            nextCursor?: string | null;
          }>("model/list", { limit: 100, includeHidden: true, cursor }),
          MODEL_LIST_TIMEOUT_MS,
          "Codex model access programs",
        );
        const entry = page.data.find(
          (entry) => (entry.model || entry.id) === model,
        );
        if (entry) {
          const programs = entry.availableAccessPrograms?.cyber;
          if (programs?.length && !programs.includes(program)) {
            return { program: null, scope: null };
          }
          break;
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    runtimeState.cyberAccessAccountKey ??= await this.readCyberAccessAccountKey(
      appServer,
      sessionId,
    );
    const scope = JSON.stringify([
      runtimeState.cyberAccessAccountKey,
      model,
      program,
    ]);
    return {
      program: this.cyberAccessDenials.has(scope) ? null : program,
      scope,
    };
  }

  /**
   * Identify the signed-in account for cyber access denials. An account
   * switch replaces the app-server process, so one read per session suffices.
   * When the account cannot be read, a denial stays confined to this session.
   */
  private async readCyberAccessAccountKey(
    appServer: CodexAppServerClient,
    sessionId: string,
  ): Promise<string> {
    try {
      const response = await withCodexTimeout(
        appServer.request<unknown>("account/read", { refreshToken: false }),
        ACCOUNT_RATE_LIMITS_TIMEOUT_MS,
        "Codex account status",
      );
      const account =
        response && typeof response === "object"
          ? (response as { account?: { type?: unknown; email?: unknown } })
              .account
          : undefined;
      if (typeof account?.type === "string") {
        return typeof account.email === "string" && account.email
          ? `${account.type}:${account.email}`
          : account.type;
      }
    } catch (error) {
      log.warn(
        { sessionId, error },
        "Could not read Codex account for cyber access program scoping",
      );
    }
    return `session:${sessionId}`;
  }

  /**
   * Synthesize a short on-return recap through a separate ephemeral Codex
   * thread. This is intentionally separate from prompt suggestions: Codex does
   * not natively emit prompt_suggestion messages, but it can still run the YA
   * simulated recap helper without mutating the parent session transcript.
   */
  async generateSummary(
    request: SummaryGenerationRequest,
  ): Promise<SummaryGenerationResult> {
    return this.installationCoordinator.withReadLease(
      CODEX_INSTALLATION_FAMILY,
      async () => {
        switch (request.strategy) {
          case "side-session": {
            const text = await generateSideSessionRecap(
              this.host,
              request.recentAssistantText,
              request.model,
            );
            return { text };
          }
          case "fork":
            return await generateForkBackedSummary(this.host, request);
        }
      },
    );
  }

  private createSessionConfigAckMessage(
    sessionId: string,
    model?: string | null,
    requestedModel?: string | null,
    reasoningEffort?: string | null,
    requestedReasoningEffort?: string,
  ): SDKMessage | null {
    const parts: string[] = [];
    const normalizedModel = typeof model === "string" ? model.trim() : "";
    const normalizedRequestedModel =
      typeof requestedModel === "string" ? requestedModel.trim() : "";
    if (normalizedModel) {
      parts.push(normalizedModel);
    }
    const effortLabel =
      this.describeAcknowledgedSessionReasoningEffort(reasoningEffort);
    const configMismatch =
      (normalizedRequestedModel.length > 0 &&
        normalizedRequestedModel !== normalizedModel) ||
      (requestedReasoningEffort !== undefined &&
        requestedReasoningEffort !== reasoningEffort);
    if (effortLabel) {
      parts.push(effortLabel);
    }
    if (parts.length === 0) {
      return null;
    }
    return {
      type: "system",
      subtype: "config_ack",
      session_id: sessionId,
      content: `Codex acknowledged config: ${parts.join(" · ")}`,
      isSynthetic: true,
      configScope: "session",
      configMismatch,
      ...(normalizedModel ? { configModel: normalizedModel } : {}),
      ...(effortLabel ? { configThinking: effortLabel } : {}),
    } as SDKMessage;
  }

  private describeAcknowledgedSessionReasoningEffort(
    effort: string | null | undefined,
  ): string | null {
    return effort ? `effort ${effort}` : null;
  }

  private getPermissionModeFromMessage(
    message: unknown,
  ): StartSessionOptions["permissionMode"] | undefined {
    if (!message || typeof message !== "object") return undefined;
    const mode = (message as { mode?: unknown }).mode;
    switch (mode) {
      case "default":
      case "acceptEdits":
      case "plan":
      case "bypassPermissions":
      case "auto":
        return mode;
      default:
        return undefined;
    }
  }

  /**
   * Extract text content from a user message.
   */
  private extractTextFromMessage(message: unknown): string {
    if (!message || typeof message !== "object") {
      return "";
    }

    // Handle UserMessage format
    const userMsg = message as UserMessage;
    if (typeof userMsg.text === "string") {
      return userMsg.text;
    }

    // Handle SDK message format
    const sdkMsg = message as {
      message?: { content?: string | unknown[] };
    };
    const content = sdkMsg.message?.content;

    if (typeof content === "string") {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .map((block: unknown) => {
          if (typeof block === "string") return block;
          if (
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            (block as { type: string }).type === "text" &&
            "text" in block
          ) {
            return (block as { text: string }).text;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }

    return "";
  }
}

/**
 * Default Codex provider instance.
 */
export const codexProvider = new CodexProvider();
