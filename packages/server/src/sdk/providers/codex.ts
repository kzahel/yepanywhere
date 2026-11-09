import { nativeStorageScope } from "./native-storage-scope.js";
import { parseNativeSessionId, toUrlProjectId } from "@yep-anywhere/shared";
import { resolveNativeSessionRef } from "../../sessions/SessionIdentityStore.js";
import { assertProviderForkSource } from "./types.js";
import {
  MCP_APP_EXTENSION_ID,
  MCP_APP_EXTENSION_SETTINGS,
} from "@yep-anywhere/shared";
import { startAgentSelfSession } from "./agent-self.js";
/**
 * Codex Provider implementation using codex app-server JSON-RPC.
 *
 * Uses `codex app-server --listen stdio://` for turn execution so we can handle
 * server-initiated permission requests (command/file approval).
 */

import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  type CodexCyberAccessProgram,
  type CodexPlanToolMode,
  DEFAULT_CODEX_CYBER_ACCESS_PROGRAM,
  DEFAULT_CODEX_REASONING_SUMMARY,
  DEFAULT_SUBAGENT_MAX_DEPTH,
  type CodexReasoningSummary,
  type ModelCatalogStatus,
  type ModelInfo,
  type ProviderSubscriptionUsage,
  type SubagentMaxDepth,
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
import { stripYaControlPlaneCredentials } from "./env-filter.js";
import type {
  SkillsListParams,
  SkillsListResponse,
  ThreadForkResponse,
  InitializeCapabilities,
} from "./codex-protocol/index.js";
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
  CodexAppServerClient,
  terminateChildProcess,
} from "./codex-app-server-client.js";
import {
  mapPermissionModeToThreadPolicy,
  resolveCodexForkLastTurnId,
} from "./codex-thread-params.js";
import {
  generateForkBackedSummary,
  generateSideSessionRecap,
  handleForkServerRequest,
} from "./codex-helper-threads.js";
import type { CodexProviderHost } from "./codex-provider-host.js";
import {
  CodexSession,
  type CodexSessionHost,
  resolveCodexSteering,
} from "./codex-session.js";
import {
  type CodexOverloadRetryWait,
  waitForCodexOverloadRetry,
} from "./codex-turn-consumer.js";
import {
  ACCOUNT_RATE_LIMITS_TIMEOUT_MS,
  MODEL_LIST_TIMEOUT_MS,
  type CodexSessionSkillInventory,
  withCodexTimeout,
} from "./codex-session-state.js";
import {
  type CodexConfigSource,
  createThreadForkParams,
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
import type { JsonRpcResponse } from "./codex-json-rpc.js";

const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;
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
    ...this.host,
    configSource: this.configSource,
    refreshCodexSkills: (appServer, cwd, inventory, forceReload) =>
      this.refreshCodexSkills(appServer, cwd, inventory, forceReload),
    cyberAccessProgram: () => this.getConfiguredCyberAccessProgram(),
    cyberAccessDenials: this.cyberAccessDenials,
    overloadRetryWait: (delayMs, signal) =>
      (this.config.overloadRetryWait ?? waitForCodexOverloadRetry)(
        delayMs,
        signal,
      ),
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
}

/**
 * Default Codex provider instance.
 */
export const codexProvider = new CodexProvider();
