import { nativeStorageScope } from "./native-storage-scope.js";
import { parseNativeSessionId, toUrlProjectId } from "@yep-anywhere/shared";
import { resolveNativeSessionRef } from "../../sessions/SessionIdentityStore.js";
import { assertProviderForkSource } from "./types.js";
import {
  MCP_APP_EXTENSION_ID,
  MCP_APP_EXTENSION_SETTINGS,
  formatMcpAppModelContext,
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
  type CodexCyberAccessProgram,
  type CodexPlanToolMode,
  DEFAULT_CODEX_CYBER_ACCESS_PROGRAM,
  DEFAULT_CODEX_REASONING_SUMMARY,
  DEFAULT_SUBAGENT_MAX_DEPTH,
  codexCyberAccessProgramWireValue,
  type CodexReasoningSummary,
  hasInvocationCandidate,
  type ModelCatalogStatus,
  type ModelInfo,
  type ProviderSubscriptionUsage,
  type SubagentMaxDepth,
  resolveTurnEffort,
  thinkingOptionToConfig,
  type ThinkingOption,
} from "@yep-anywhere/shared";
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
import type { MessageQueue } from "../messageQueue.js";
import { stripYaControlPlaneCredentials } from "./env-filter.js";
import type { SDKMessage, UserMessage } from "../types.js";
import type {
  SkillsListParams,
  SkillsListResponse,
  ThreadForkResponse,
  ThreadGoalSetResponse,
  InitializeCapabilities,
  ThreadCompactStartParams,
  ThreadCompactStartResponse,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  TurnStartResponse,
} from "./codex-protocol/index.js";
import type { CyberAccessProgram } from "./codex-protocol/generated/v2/CyberAccessProgram.js";
import {
  createLaunchAgentctlSessionEnvBridge,
  type AgentctlSessionEnvBridge,
} from "./agentctl-session-env.js";
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
import { asCodexTurnCompletedNotification } from "./codex-notification-guards.js";
import { handleServerRequestApproval } from "./codex-approvals.js";
import {
  CodexAppServerClient,
  terminateChildProcess,
} from "./codex-app-server-client.js";
import {
  CODEX_POLICY_OVERRIDES,
  mapPermissionModeToThreadPolicy,
  normalizePermissionMode,
  resolveCodexForkLastTurnId,
} from "./codex-thread-params.js";
import {
  createCodexSlashCommands,
  createCodexUserInputs,
} from "./codex-skill-inputs.js";
import {
  type CodexFailureTrace,
  formatCodexFailureTrace,
  snapshotCodexFailureTrace,
} from "./codex-failure-trace.js";
import {
  generateForkBackedSummary,
  generateSideSessionRecap,
  handleForkServerRequest,
} from "./codex-helper-threads.js";
import type { CodexProviderHost } from "./codex-provider-host.js";
import { CodexSession, type CodexSessionHost } from "./codex-session.js";
import {
  type CodexOverloadRetryWait,
  CodexNotificationReader,
  type CodexTurnContext,
  consumeCodexTurn,
  logRawCodexNotification,
  prepareCodexOverloadRetry,
  shouldSuppressLiveDeltaNotification,
  waitForCodexOverloadRetry,
} from "./codex-turn-consumer.js";
import {
  ACCOUNT_RATE_LIMITS_TIMEOUT_MS,
  type CodexSessionSkillInventory,
  type CodexTurnRuntimeState,
  withCodexTimeout,
} from "./codex-session-state.js";
import {
  type CodexConfigSource,
  type CodexThreadResumeParamsForRequest,
  createThreadForkParams,
  createThreadResumeParams,
  createThreadStartParams,
  createTurnStartParams,
  mapEffortToReasoningEffort,
} from "./codex-session-config.js";
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
import { agentServerEnvironmentFor, agentApiEnvironmentFor } from "./types.js";
import {
  logSdkCorrelationDebug,
  withCodexTimestamp,
} from "./codex-item-conversion.js";
import {
  type TokenUsageSnapshot,
  createLiveEventState,
} from "./codex-live-event-conversion.js";
import type { JsonRpcNotification, JsonRpcResponse } from "./codex-json-rpc.js";
import { withSessionSandboxAgentContext } from "../../session-sandbox-agent-context.js";

const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;
const MODEL_LIST_TIMEOUT_MS = 8000;
const APP_SERVER_INIT_REQUEST_ID = 1;
const APP_SERVER_MODEL_LIST_REQUEST_ID = 2;

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
  /**
   * Settings for the thread and turn builders. Each method reads the getter
   * field when called, so a setter applied later still takes effect.
   */
  private readonly configSource: CodexConfigSource = {
    reasoningSummary: () => this.getConfiguredReasoningSummary(),
    planToolMode: () => this.getConfiguredPlanToolMode(),
    subagentMaxDepth: () => this.getConfiguredSubagentMaxDepth(),
    cachedModels: () => this.modelCache?.models,
  };
  /**
   * Provider services for sessions, called through at call time so the
   * settings setters and test spies still take effect.
   */
  private readonly sessionHost: CodexSessionHost = {
    configSource: this.configSource,
    getAvailableModels: () => this.getAvailableModels(),
    refreshCodexSkills: (appServer, cwd, inventory, forceReload) =>
      this.refreshCodexSkills(appServer, cwd, inventory, forceReload),
    extractTextFromMessage: (message) => this.extractTextFromMessage(message),
    runSession: (...args) => this.runSession(...args),
  };

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
    const session = new CodexSession({
      host: this.sessionHost,
      options,
      steeringMode,
      mcpAppViews: this.getMcpAppViews(),
      installationLease,
    });
    return session.toAgentSession();
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
        createThreadForkParams(
          this.configSource,
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
    markThreadReady: () => void,
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
        shouldSuppressLiveDeltaNotification(notification, options),
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
      logRawCodexNotification(sessionId || "unknown", notification);
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
      const threadResumeParams = createThreadResumeParams(
        this.configSource,
        options,
        sessionId,
        policy,
        experimentalApiEnabled,
      );
      const threadStartParams = createThreadStartParams(
        this.configSource,
        options,
        policy,
      );
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
      // Codex refuses requests before initialize; controls wait for this.
      markThreadReady();
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

      const requestedReasoningEffort = mapEffortToReasoningEffort(
        this.configSource,
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
      const reader = new CodexNotificationReader(appServer, signal);
      const turnContext: CodexTurnContext = {
        appServer,
        reader,
        options,
        signal,
        sessionId,
        runtimeState,
        failureTrace,
        usageByTurnId,
        liveEventState,
        observeCommands,
        logRawNotification,
        overloadRetryWait:
          this.config.overloadRetryWait ?? waitForCodexOverloadRetry,
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
            next = await Promise.race([reader.peek(), inputReady]);
            if (
              next === "input" &&
              runtimeState.pendingCompaction &&
              (await runtimeState.pendingCompaction.requestAccepted)
            ) {
              next = await reader.peek();
            }
          } finally {
            releaseQueueListener();
          }
          if (next !== "input") {
            reader.takePeeked();
            logRawNotification(next);
            const goalCommands = await observeCommands(next);
            if (goalCommands) yield goalCommands;
            if (next.method === "turn/started") {
              const params = asCodexTurnCompletedNotification(next.params);
              if (params?.threadId === sessionId) {
                // A turn YA did not start requested no cyber access program,
                // so only an overload can come back as retryable here.
                const { retryableError } = yield* consumeCodexTurn(
                  turnContext,
                  params.turn,
                  0,
                );
                const overloadError = retryableError?.message;
                if (overloadError) {
                  const compaction = runtimeState.pendingCompaction;
                  if (compaction) {
                    const retryReady = yield* prepareCodexOverloadRetry(
                      turnContext,
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
          const turnStartParams = createTurnStartParams(
            this.configSource,
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
            turnStartParams.effort = mapEffortToReasoningEffort(
              this.configSource,
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
                  mapEffortToReasoningEffort(
                    this.configSource,
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
            const { retryableError } = yield* consumeCodexTurn(
              turnContext,
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
              const retryReady = yield* prepareCodexOverloadRetry(
                turnContext,
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

            const retryTurnStartParams = createTurnStartParams(
              this.configSource,
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
