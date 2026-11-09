import {
  captureClaudeCopyBoundary,
  type ClaudeCopyBoundary,
} from "../../sessions/claude-copy-boundary.js";
import { claudeCwdProjectDirectory } from "../../projects/claude-project-directory.js";
import { nativeStorageScope } from "./native-storage-scope.js";
import {
  prepareClaudeInput,
  claudeInputMessageIds,
} from "./claude-delivery.js";
import { fromUrlProjectId, parseNativeSessionId } from "@yep-anywhere/shared";
import { assertClaudeCopyRoot } from "../../sessions/fork.js";
import { resolveNativeSessionRef } from "../../sessions/SessionIdentityStore.js";
import { routerModelSupportsThinking } from "@yep-anywhere/shared";
import { claudeRouterEnvironment } from "./router-transport.js";
import { startAgentSelfSession } from "./agent-self.js";
import {
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  execFile,
  spawn,
} from "node:child_process";
import { constants, existsSync, readFileSync } from "node:fs";
import { open as openFile, realpath, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  type SDKMessage as AgentSDKMessage,
  type Query,
  type CanUseTool as SDKCanUseTool,
  type Options,
  type SessionStore,
  type SessionStoreEntry,
  type Settings,
  type SpawnedProcess,
  forkSession as sdkForkSession,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import {
  DEFAULT_CLAUDE_STEER_BACKGROUND_BASH,
  DEFAULT_PROMPT_CACHE_KEEPALIVE_INACTIVITY_MINUTES,
  DEFAULT_SUBAGENT_MAX_DEPTH,
  GOAL_COMMAND_NAME,
  HELPER_SIDE_MODEL_CHEAPEST,
  type ClaudeAdditionalModelSelection,
  type EffortLevel,
  type ModelCatalogStatus,
  type ModelInfo,
  type PromptCacheKeepaliveProviderInfo,
  type ProviderSubscriptionUsage,
  type SlashCommand,
  type SubagentMaxDepth,
} from "@yep-anywhere/shared";
import { getLogger } from "../../logging/logger.js";
import { logSDKMessage } from "../messageLogger.js";
import { MessageQueue } from "../messageQueue.js";
import { ClaudeTurnEffort } from "./claude-turn-effort.js";
import {
  CLAUDE_MODELS_FALLBACK,
  type ClaudeSdkModelInfo,
  type ClaudeSdkSlashCommand,
  claudeModelFamily,
  filterClaudeRemoteSlashCommands,
  mapClaudeSdkModel,
  mapClaudeSlashCommand,
  mergeClaudeModels,
  normalizeClaudeLaunchModel,
  normalizedSlashCommandNameValue,
  withClaudeGoalAlias,
} from "./claude-model-catalog.js";
import {
  CLAUDE_LOGIN_ARGS,
  getClaudeLoginCommand,
  resolveClaudeLoginExecutable,
  resolveLocalClaudeCodeExecutable,
  resolvePathExecutable,
} from "./claude-executable.js";
import {
  fallbackModelCatalog,
  modelCatalogError,
} from "./model-catalog-status.js";
import { normalizeClaudeContextUsage } from "./claude-context-breakdown.js";
import {
  getClaudeAdditionalModelOptions,
  getClaudeModelCatalogCacheKey,
  projectClaudeAdditionalModels,
} from "./claude-additional-models.js";
import {
  type ClaudeGoalSnapshot,
  ClaudeGoalTracker,
  runClaudeGoalCommand,
  withClaudeGoalDetails,
} from "./claude-goal.js";
import { ClaudeProviderRetentionTracker } from "./claude-retention.js";
import { ClaudeSteerBackgroundController } from "./claude-steer-background.js";
import {
  claudeToolOutputTmpRoots,
  withClaudeToolOutputPreviews,
} from "./claude-tool-output-preview.js";
import type {
  ContentBlock,
  ProviderCommandResult,
  ProviderLivenessProbeResult,
  SDKMessage,
} from "../types.js";
import { createLaunchAgentctlSessionEnvBridge } from "./agentctl-session-env.js";
import {
  filterEnvForChildProcess,
  stripYaControlPlaneCredentials,
} from "./env-filter.js";
import { normalizeClaudeSubscriptionUsage } from "./provider-subscription-usage.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  PromptCacheRefreshResult,
  ProviderSessionOptions,
  ProviderSessionOptionsUpdateResult,
  ProviderName,
  ProviderForkOptions,
  ProviderSessionSource,
  ProviderForkResult,
  ProviderLoginLaunch,
  StartSessionOptions,
  SummaryGenerationRequest,
  SummaryGenerationResult,
} from "./types.js";
import {
  assertProviderForkSource,
  PROVIDER_SESSION_OPTION_KEYS,
  agentServerEnvironmentFor,
  agentApiEnvironmentFor,
  resolveProviderSessionOptions,
} from "./types.js";
import type { SessionSandboxRuntime } from "../../session-sandbox.js";
import { withSessionSandboxAgentContext } from "../../session-sandbox-agent-context.js";

/**
 * Use a spawn wrapper to capture the child process reference for liveness checks.
 * When true, stale detection can distinguish "process died silently" from
 * "process is busy with a long tool call". Set to false to revert to the
 * old time-only heuristic if the wrapper causes issues.
 */
const USE_SPAWN_WRAPPER = true;
const CLAUDE_LIVENESS_PROBE_TIMEOUT_MS = 5000;
const CLAUDE_LIVENESS_PROBE_SOURCE = "claude:control/mcp_status";
const CLAUDE_PROMPT_CACHE_KEEPALIVE_TIMEOUT_MS = 60_000;
const CLAUDE_PROMPT_CACHE_KEEPALIVE_MAX_BUDGET_USD = 0.02;
const PROVIDER_MANAGED_SESSION_TITLE = "Yep Anywhere Session";
const CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE";
const execFileAsync = promisify(execFile);
const SESSION_ID_PATTERN = /^[0-9a-f-]{36}$/i;

export function getClaudeSessionLaunchOptions(
  options?: ProviderSessionOptions,
): {
  resolved: Required<ProviderSessionOptions>;
  sdk: {
    title: string | undefined;
    promptSuggestions: boolean;
    agentProgressSummaries: boolean;
  };
} {
  const resolved = resolveProviderSessionOptions(options);
  if (resolved.automaticRecaps) {
    throw new Error(
      "Claude Agent SDK does not support provider-native automatic recaps",
    );
  }
  return {
    resolved,
    sdk: {
      title: resolved.automaticTitle
        ? undefined
        : PROVIDER_MANAGED_SESSION_TITLE,
      promptSuggestions: resolved.promptSuggestions,
      agentProgressSummaries: resolved.agentProgressSummaries,
    },
  };
}

export function evaluateClaudeSessionOptionsUpdate(
  launched: Required<ProviderSessionOptions>,
  requested: ProviderSessionOptions,
): ProviderSessionOptionsUpdateResult {
  const result: ProviderSessionOptionsUpdateResult = {};
  for (const key of PROVIDER_SESSION_OPTION_KEYS) {
    const value = requested[key];
    if (value === undefined) continue;
    if (key === "automaticRecaps") {
      result[key] = {
        requested: value,
        status: value ? "unsupported" : "inactive",
        detail: "Claude Agent SDK does not emit provider-native recap turns",
      };
      continue;
    }
    result[key] = {
      requested: value,
      status: value === launched[key] ? "applied" : "restart-required",
      detail:
        value === launched[key]
          ? "The Claude session was launched with this option"
          : "Claude exposes this option only during session initialization",
    };
  }
  return result;
}

const DEFAULT_CLAUDE_PROVIDER_GENERATION_OPTIONS =
  getClaudeSessionLaunchOptions().sdk;

function waitForMessageYield(
  queue: MessageQueue,
  message: import("../types.js").UserMessage,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (yielded: boolean) => {
      unsubscribeYielded();
      unsubscribeRemoved();
      signal.removeEventListener("abort", onAbort);
      resolve(yielded);
    };
    const onAbort = () => finish(false);
    const unsubscribeYielded = queue.subscribeYielded((messages) => {
      if (messages.includes(message)) finish(true);
    });
    const unsubscribeRemoved = queue.subscribeRemoved((messages) => {
      if (messages.includes(message)) finish(false);
    });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function nextEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function getClaudeAutoCompactOverrideEnv(
  percent: number | undefined,
): Record<string, string> | undefined {
  if (percent === undefined) return undefined;
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
    throw new Error(
      "Claude auto-compaction percentage must be an integer from 1 to 100",
    );
  }
  return { [CLAUDE_AUTOCOMPACT_PCT_OVERRIDE]: String(percent) };
}

function createSandboxedClaudeSpawn(
  sessionSandbox: SessionSandboxRuntime,
): (
  options: import("@anthropic-ai/claude-agent-sdk").SpawnOptions,
) => SpawnedProcess {
  return (options) => {
    const sandboxed = sessionSandbox.wrapSpawn(
      options.command,
      options.args,
      options.env as NodeJS.ProcessEnv,
    );
    const child = (() => {
      try {
        return spawn(sandboxed.command, sandboxed.args, {
          cwd: sandboxed.cwd,
          env: sandboxed.env,
          stdio: sandboxed.stdio,
          shell: false,
        }) as ChildProcessWithoutNullStreams;
      } finally {
        sandboxed.release();
      }
    })();
    const abort = () => child.kill("SIGTERM");
    options.signal.addEventListener("abort", abort, { once: true });
    child.once("exit", () => {
      options.signal.removeEventListener("abort", abort);
    });
    return child;
  };
}

function assertClaudeForkSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error("Invalid Claude fork session id");
  }
}

function createClaudeForkStore(
  directory: FileHandle | string,
  copied?: (boundary: ClaudeCopyBoundary | undefined) => void,
): SessionStore {
  const directoryPath =
    typeof directory === "string" ? directory : `/proc/self/fd/${directory.fd}`;
  return {
    async load(key): Promise<SessionStoreEntry[] | null> {
      if (key.subpath) {
        throw new Error("Claude fork source subpaths are not supported");
      }
      assertClaudeForkSessionId(key.sessionId);
      let file: FileHandle;
      try {
        file = await openFile(
          join(directoryPath, `${key.sessionId}.jsonl`),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return null;
        }
        throw error;
      }
      try {
        const content = await file.readFile("utf8");
        const entries: SessionStoreEntry[] = [];
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          try {
            entries.push(JSON.parse(line) as SessionStoreEntry);
          } catch {
            /* Match the native SDK's malformed/torn-row tolerance. */
          }
        }
        return entries;
      } finally {
        await file.close();
      }
    },
    async append(key, entries): Promise<void> {
      if (key.subpath) {
        throw new Error("Claude fork target subpaths are not supported");
      }
      assertClaudeForkSessionId(key.sessionId);
      const file = await openFile(
        join(directoryPath, `${key.sessionId}.jsonl`),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(
          `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
          "utf8",
        );
        copied?.(captureClaudeCopyBoundary(entries));
      } finally {
        await file.close();
      }
    },
  };
}

function extractClaudeAssistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  let text = "";
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: string }).type === "text" &&
      typeof (block as { text?: string }).text === "string"
    ) {
      text += (block as { text: string }).text;
    }
  }
  return text;
}

function numericField(source: unknown, field: string): number | undefined {
  if (!source || typeof source !== "object") {
    return undefined;
  }
  const value = (source as Record<string, unknown>)[field];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function extractPromptCacheRefreshUsage(
  message: AgentSDKMessage,
): PromptCacheRefreshResult["usage"] | undefined {
  const record = message as {
    usage?: unknown;
    modelUsage?: unknown;
    message?: { usage?: unknown };
  };
  const usage =
    record.usage ?? record.modelUsage ?? record.message?.usage ?? null;
  if (!usage) {
    return undefined;
  }

  const result: NonNullable<PromptCacheRefreshResult["usage"]> = {};
  const inputTokens =
    numericField(usage, "input_tokens") ?? numericField(usage, "inputTokens");
  const outputTokens =
    numericField(usage, "output_tokens") ?? numericField(usage, "outputTokens");
  const cacheReadTokens =
    numericField(usage, "cache_read_input_tokens") ??
    numericField(usage, "cached_input_tokens") ??
    numericField(usage, "cacheReadTokens");
  const cacheCreationTokens =
    numericField(usage, "cache_creation_input_tokens") ??
    numericField(usage, "cacheCreationTokens");

  if (inputTokens !== undefined) result.inputTokens = inputTokens;
  if (outputTokens !== undefined) result.outputTokens = outputTokens;
  if (cacheReadTokens !== undefined) result.cacheReadTokens = cacheReadTokens;
  if (cacheCreationTokens !== undefined) {
    result.cacheCreationTokens = cacheCreationTokens;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

async function* withCleanup<T>(
  iterator: AsyncIterableIterator<T>,
  cleanup: () => void,
): AsyncIterableIterator<T> {
  try {
    yield* iterator;
  } finally {
    cleanup();
  }
}

/** Re-probe the live catalog after this long; aliases move between releases. */
const CLAUDE_MODEL_CACHE_TTL_MS = 60 * 60_000;

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref?.();
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function probeClaudeControlLiveness(
  control: Pick<Query, "mcpServerStatus">,
  options?: {
    checkedAt?: Date;
    timeoutMs?: number;
    isProcessAlive?: () => boolean | undefined;
  },
): Promise<ProviderLivenessProbeResult> {
  const checkedAt = options?.checkedAt ?? new Date();
  const processAlive = options?.isProcessAlive?.();

  if (processAlive === false) {
    return {
      status: "unavailable",
      source: CLAUDE_LIVENESS_PROBE_SOURCE,
      checkedAt,
      detail: "Claude CLI process is not alive",
    };
  }

  try {
    await withTimeout(
      control.mcpServerStatus(),
      options?.timeoutMs ?? CLAUDE_LIVENESS_PROBE_TIMEOUT_MS,
      "Claude SDK control liveness probe",
    );
    return {
      status: "active",
      source: CLAUDE_LIVENESS_PROBE_SOURCE,
      checkedAt,
      detail:
        "Claude SDK control channel responded; direct turn status is not exposed",
    };
  } catch (error) {
    return {
      status: "error",
      source: CLAUDE_LIVENESS_PROBE_SOURCE,
      checkedAt,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Claude provider implementation using @anthropic-ai/claude-agent-sdk.
 *
 * This class wraps the SDK's query() function and provides:
 * - MessageQueue for queuing user messages
 * - AbortController for cancellation
 * - Tool approval callbacks
 */
export class ClaudeProvider implements AgentProvider {
  readonly name: ProviderName = "claude";
  readonly displayName: string = "Claude";
  readonly supportsNativeResumeSource = true;
  readonly supportsInlineImages = true;
  readonly acceptsChosenSessionId = true;
  readonly supportsPermissionMode = true;
  readonly supportsThinkingToggle: boolean = true;
  readonly supportsSlashCommands = true;
  readonly supportsSteering = true;
  readonly supportsSteerNow = true;
  readonly steering = {
    selection: "per-message" as const,
    modes: ["gentle", "immediate"] as const,
    defaultMode: "immediate" as const,
  };
  readonly supportsRecaps = true;
  // Intentionally false. Claude emits native away_summary recaps only in the
  // interactive TUI (entrypoint:cli), which writes them to the session JSONL
  // after idle; YA reads and shows those regardless of recap mode. YA drives
  // Claude via the TS SDK (entrypoint:sdk-ts), and there is no known way to
  // make an SDK/YA-owned session emit native recaps, so a "native" choice here
  // is a no-op (and would make fork/tailed wait a pointless native grace
  // window). Do not re-enable on the basis of seeing CLI recaps in the JSONL.
  readonly supportsNativeRecaps = false;
  readonly supportsNativePromptSuggestions: boolean = true;
  readonly supportsLaunchCompactPercentOverride: boolean = true;
  // Claude Code streams nothing until it has a prompt: the SDK emits its init
  // message when the first turn starts, so the session id only exists once YA
  // has delivered a message.
  readonly initializesOnFirstMessage = true;
  readonly promptCacheKeepalive?: PromptCacheKeepaliveProviderInfo = {
    supportsNoContextPollutionNudge: true,
    defaultMode: "auto" as const,
    defaultInactivityMinutes: DEFAULT_PROMPT_CACHE_KEEPALIVE_INACTIVITY_MINUTES,
  };
  private cachedModels: ModelInfo[] | null = null;
  private cachedModelsAt = 0;
  private modelCacheGeneration = 0;
  private probePromise: Promise<ModelInfo[]> | null = null;
  private cliAuthPromise: Promise<AuthStatus | null> | null = null;
  protected modelCatalogStatus: ModelCatalogStatus | undefined;
  private getAdditionalModelSelections: () =>
    | readonly ClaudeAdditionalModelSelection[]
    | undefined = () => [];
  private getConfiguredSubagentMaxDepth: () => SubagentMaxDepth = () =>
    DEFAULT_SUBAGENT_MAX_DEPTH;

  setSubagentMaxDepthGetter(getter: () => SubagentMaxDepth): void {
    this.getConfiguredSubagentMaxDepth = getter;
  }

  setAdditionalModelsGetter(
    getter: () => readonly ClaudeAdditionalModelSelection[] | undefined,
  ): void {
    this.getAdditionalModelSelections = getter;
  }

  getAdditionalModelOptions(): ModelInfo[] {
    return getClaudeAdditionalModelOptions();
  }

  getModelCatalogCacheKey(): string {
    return getClaudeModelCatalogCacheKey(this.getAdditionalModelSelections());
  }

  resolveLaunchModel(model: string | undefined): string | undefined {
    const resolved = this.cachedModels?.find(
      (entry) => entry.id === model,
    )?.resolvedModel;
    // "[1m]" selects a context window, not a different model; drop it so the
    // id matches the one the provider records on each response.
    return resolved?.replace(/\[[^\]]*\]$/u, "") || undefined;
  }

  protected invalidateModelCache(): void {
    this.cachedModels = null;
    this.probePromise = null;
    this.modelCacheGeneration += 1;
  }

  getModelCatalogStatus(): ModelCatalogStatus | undefined {
    return this.modelCatalogStatus;
  }

  /** Publish a live catalog unless a newer read has already started. */
  private acceptLiveModels(models: ModelInfo[], generation: number): void {
    if (generation !== this.modelCacheGeneration) return;
    this.cachedModels = models;
    this.cachedModelsAt = Date.now();
    this.modelCatalogStatus = {
      source: "live",
      fetchedAt: new Date(this.cachedModelsAt).toISOString(),
    };
  }

  private projectAdditionalModels(models: readonly ModelInfo[]): ModelInfo[] {
    return projectClaudeAdditionalModels(
      models,
      this.getAdditionalModelSelections(),
    );
  }

  /** Check whether the bundled or explicitly configured Claude runtime exists. */
  async isInstalled(): Promise<boolean> {
    return this.isClaudeCliInstalled();
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
        family: "claude" as const,
        storageScope: await nativeStorageScope(sandbox.transcriptDir),
      };
    // The CLI resolves cwd before selecting its conventional project key.
    const physicalCwd = await realpath(cwd);
    const project = claudeCwdProjectDirectory(physicalCwd);
    let root = resolve(
      physicalCwd,
      process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
      "projects",
      project,
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
    return { family: "claude" as const, storageScope: root };
  }

  /**
   * Check if Claude is authenticated.
   * Returns true if ANTHROPIC_API_KEY is set or OAuth credentials exist.
   */
  async isAuthenticated(): Promise<boolean> {
    const authStatus = await this.getAuthStatus();
    return authStatus.authenticated;
  }

  /**
   * Get detailed authentication status.
   * Uses environment/API-key and local Claude credentials heuristics.
   * This is still only a local signal; upstream tokens can expire or be revoked.
   */
  async getAuthStatus(): Promise<AuthStatus> {
    const installed = await this.isClaudeCliInstalled();
    if (!installed) {
      return this.withLoginCommand({
        installed: false,
        authenticated: false,
        enabled: false,
      });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (apiKey) {
      return {
        installed: true,
        authenticated: true,
        enabled: true,
      };
    }

    const cliAuthStatus = await this.getCliAuthStatus();
    if (cliAuthStatus) {
      return this.withLoginCommand(cliAuthStatus);
    }

    const credentialsPath = join(homedir(), ".claude", ".credentials.json");
    if (!existsSync(credentialsPath)) {
      return this.withLoginCommand({
        installed: true,
        authenticated: false,
        enabled: false,
      });
    }

    try {
      const parsed = JSON.parse(readFileSync(credentialsPath, "utf-8")) as {
        claudeAiOauth?: {
          accessToken?: string;
          refreshToken?: string;
          expiresAt?: number;
        };
      };

      const oauth = parsed.claudeAiOauth;
      const hasTokens = Boolean(oauth?.accessToken || oauth?.refreshToken);
      if (!hasTokens) {
        return this.withLoginCommand({
          installed: true,
          authenticated: false,
          enabled: false,
        });
      }

      const expiresAt =
        typeof oauth?.expiresAt === "number"
          ? new Date(oauth.expiresAt)
          : undefined;
      const authenticated =
        !expiresAt || expiresAt >= new Date() || Boolean(oauth?.refreshToken);

      return this.withLoginCommand({
        installed: true,
        authenticated,
        enabled: authenticated,
        expiresAt,
      });
    } catch {
      return this.withLoginCommand({
        installed: true,
        authenticated: false,
        enabled: false,
      });
    }
  }

  async getLoginLaunch(): Promise<ProviderLoginLaunch | null> {
    // Gateway and Ollama variants authenticate through their own services.
    if (this.name !== "claude") return null;
    const executable = await resolveClaudeLoginExecutable();
    if (!executable) return null;
    return {
      executable,
      env: stripYaControlPlaneCredentials(process.env),
      // Without a terminal the CLI prints its sign-in link and waits for the
      // code the authorization page shows, read from stdin.
      relayedArgs: CLAUDE_LOGIN_ARGS,
      terminalArgs: CLAUDE_LOGIN_ARGS,
      acceptsCode: true,
    };
  }

  private async withLoginCommand(status: AuthStatus): Promise<AuthStatus> {
    if (status.authenticated || status.loginCommand) {
      return status;
    }

    return {
      ...status,
      loginCommand: await getClaudeLoginCommand(),
    };
  }

  private async getCliAuthStatus(): Promise<AuthStatus | null> {
    if (this.cliAuthPromise) return this.cliAuthPromise;
    const pending = this.readCliAuthStatus();
    this.cliAuthPromise = pending;
    try {
      return await pending;
    } finally {
      this.cliAuthPromise = null;
    }
  }

  private async readCliAuthStatus(): Promise<AuthStatus | null> {
    try {
      const claudePath = resolveLocalClaudeCodeExecutable();
      if (!claudePath) return null;
      const { stdout } = await execFileAsync(claudePath, ["auth", "status"], {
        encoding: "utf-8",
        timeout: 5000,
      });

      const parsed = JSON.parse(stdout) as {
        loggedIn?: boolean;
        email?: string;
      };

      if (typeof parsed.loggedIn !== "boolean") {
        return null;
      }

      return {
        installed: true,
        authenticated: parsed.loggedIn,
        enabled: parsed.loggedIn,
        user: parsed.email ? { email: parsed.email } : undefined,
      };
    } catch {
      return null;
    }
  }

  /** Check whether YA has an executable Claude Code runtime to launch. */
  private async isClaudeCliInstalled(): Promise<boolean> {
    const executable = resolveLocalClaudeCodeExecutable();
    // Installation can change after this module resolved the executable.
    // Recheck the captured path before admitting a saved startup attempt.
    return (
      executable !== undefined &&
      resolvePathExecutable(executable) !== undefined
    );
  }

  /**
   * Reported Claude model id → canonical YA alias, matched by family component.
   * Anthropic has shipped both "{family}-{version}" (claude-opus-4-8) and
   * "{version}-{family}" (claude-3-5-sonnet), so we look for the family anywhere
   * in the name. One-to-(zero or more): we return the plain alias ("sonnet",
   * not "sonnet[1m]"/"best") because the reported id can't say which the user
   * actually launched. Used only to recover a keying id for non-YA-started
   * sessions. See topics/provider-abstraction.md § Per-model settings keying.
   */
  yaModelIdForReported(reported: string | undefined): string | undefined {
    if (!reported) return undefined;
    return claudeModelFamily(reported);
  }

  /**
   * Get available Claude models.
   * Fetches dynamically from SDK via a probe session, cached for an hour or
   * until `forceRefresh`. A failed re-probe keeps the last live list; with
   * none, or without authentication, it returns the built-in fallback.
   */
  async getAvailableModels(options?: {
    forceRefresh?: boolean;
  }): Promise<ModelInfo[]> {
    const forceRefresh = options?.forceRefresh === true;
    if (
      !forceRefresh &&
      this.cachedModels &&
      Date.now() - this.cachedModelsAt < CLAUDE_MODEL_CACHE_TTL_MS
    ) {
      return this.projectAdditionalModels(this.cachedModels);
    }

    // Check if user is authenticated before trying to probe
    const authStatus = await this.getAuthStatus();
    if (!authStatus.authenticated) {
      return this.useFallbackModels("Claude is not signed in");
    }

    // Join a probe already in progress unless the caller asked for a new one.
    let probe = forceRefresh ? null : this.probePromise;
    let generation = this.modelCacheGeneration;
    if (!probe) {
      generation = ++this.modelCacheGeneration;
      probe = this.probeModels();
      this.probePromise = probe;
    }
    try {
      const models = mergeClaudeModels(await probe);
      this.acceptLiveModels(models, generation);
      return this.projectAdditionalModels(models);
    } catch (error) {
      console.warn("[Claude] Failed to probe models:", error);
      if (this.cachedModels) {
        if (
          generation === this.modelCacheGeneration &&
          this.modelCatalogStatus
        ) {
          this.modelCatalogStatus = {
            ...this.modelCatalogStatus,
            error: modelCatalogError(error),
          };
        }
        return this.projectAdditionalModels(this.cachedModels);
      }
      return this.useFallbackModels(modelCatalogError(error));
    } finally {
      if (this.probePromise === probe) this.probePromise = null;
    }
  }

  private useFallbackModels(error: string): ModelInfo[] {
    this.modelCatalogStatus = fallbackModelCatalog(error);
    return this.projectAdditionalModels(CLAUDE_MODELS_FALLBACK);
  }

  async getSubscriptionUsage(
    models: readonly ModelInfo[],
  ): Promise<ProviderSubscriptionUsage | null> {
    // Gateway and Ollama subclasses use Claude's SDK transport without a
    // claude.ai subscription account behind it.
    if (this.name !== "claude") return null;
    const authStatus = await this.getAuthStatus();
    if (!authStatus.authenticated) return null;

    try {
      const rawUsage = await this.runControlProbe(
        "Claude subscription usage probe",
        (sdkQuery) =>
          sdkQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
      );
      return normalizeClaudeSubscriptionUsage(rawUsage, models);
    } catch (error) {
      getLogger().debug(
        { error },
        "Claude subscription usage probe is unavailable",
      );
      return null;
    }
  }

  /**
   * Get filtered environment variables for child processes.
   * Subclasses can override to inject custom env vars (e.g., ANTHROPIC_BASE_URL).
   */
  protected getSubagentDepthEnvironment(): Record<string, string> {
    const operatorValue = process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH;
    if (operatorValue !== undefined) {
      return { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: operatorValue };
    }
    const configuredValue = this.getConfiguredSubagentMaxDepth();
    return configuredValue === null
      ? {}
      : {
          CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: String(configuredValue),
        };
  }

  protected getEnv(_model?: string): Record<string, string | undefined> {
    return {
      ...filterEnvForChildProcess(),
      ...this.getSubagentDepthEnvironment(),
    };
  }

  /**
   * Supplementary flag-layer settings for this Claude launch. These merge over
   * user/project/local settings without replacing the lower layers.
   */
  protected getSettings(_model?: string): Settings | undefined {
    return undefined;
  }

  /** Built-in tools removed from this Claude launch before model context. */
  protected getDisallowedTools(_model?: string): string[] | undefined {
    return undefined;
  }

  protected getDisallowedToolOptions(
    model?: string,
  ): Pick<Options, "disallowedTools"> {
    const disallowedTools = this.getDisallowedTools(model);
    return disallowedTools ? { disallowedTools } : {};
  }

  /** Apply at every confined query, including resumes and helper forks. */
  private getSessionToolOptions(
    model: string | undefined,
    sandbox: SessionSandboxRuntime | undefined,
  ): Pick<
    Options,
    "settings" | "disallowedTools" | "strictMcpConfig" | "mcpServers"
  > {
    const settings = this.getSettings(model);
    if (!sandbox) {
      return { settings, ...this.getDisallowedToolOptions(model) };
    }
    return {
      settings: {
        ...settings,
        disableClaudeAiConnectors: true,
        allowedMcpServers: [],
        deniedMcpServers: [{ serverUrl: "*" }],
      },
      strictMcpConfig: true,
      mcpServers: {},
      disallowedTools: [...(this.getDisallowedTools(model) ?? []), "mcp__*"],
    };
  }

  /**
   * Normalize a live SDK model catalog and update this provider instance only.
   * Gateway subclasses may replace the SDK's built-in-plus-gateway catalog
   * with an authoritative gateway-only catalog.
   */
  protected async normalizeSupportedModels(
    models: ClaudeSdkModelInfo[],
  ): Promise<ModelInfo[]> {
    const mappedModels = mergeClaudeModels(
      models.map((model) => mapClaudeSdkModel(model)),
    );
    this.acceptLiveModels(mappedModels, ++this.modelCacheGeneration);
    return this.projectAdditionalModels(mappedModels);
  }

  /**
   * Build the systemPrompt option for the SDK query.
   * Default: use the full claude_code preset. Subclasses (e.g., Ollama) can
   * override to provide a simpler prompt that smaller models can follow.
   */
  protected getSystemPrompt(
    globalInstructions?: string,
  ):
    | string
    | { type: "preset"; preset: "claude_code"; append?: string }
    | undefined {
    return globalInstructions
      ? {
          type: "preset" as const,
          preset: "claude_code" as const,
          append: globalInstructions,
        }
      : { type: "preset" as const, preset: "claude_code" as const };
  }

  private getSessionSystemPrompt(
    globalInstructions: string | undefined,
    sandbox: SessionSandboxRuntime | undefined,
  ): Options["systemPrompt"] {
    const instructions = sandbox?.instructions;
    if (instructions && !instructions.startFromDefault) {
      return {
        type: "custom",
        prompt:
          withSessionSandboxAgentContext(instructions.text, sandbox) ?? "",
        snapshot: false,
      };
    }
    const append = [globalInstructions, instructions?.text]
      .filter(Boolean)
      .join("\n\n");
    const prompt = this.getSystemPrompt(
      withSessionSandboxAgentContext(append, sandbox),
    );
    if (!instructions || !prompt) return prompt;
    return typeof prompt === "string"
      ? { type: "custom", prompt, snapshot: false }
      : { ...prompt, snapshot: false };
  }

  private async runControlProbe<T>(
    label: string,
    request: (sdkQuery: Query) => Promise<T>,
  ): Promise<T> {
    const abortController = new AbortController();

    // Keep the SDK process alive while the read-only control request completes.
    // Resolves (rather than rejects) on abort to avoid unhandled rejections.
    async function* waitForever(): AsyncGenerator<never> {
      await new Promise<void>((resolve) => {
        abortController.signal.addEventListener("abort", () => resolve());
      });
      yield* [];
    }

    try {
      const sdkQuery = query({
        prompt: waitForever(),
        options: {
          ...DEFAULT_CLAUDE_PROVIDER_GENERATION_OPTIONS,
          cwd: homedir(),
          abortController,
          permissionMode: "default",
          persistSession: false,
          pathToClaudeCodeExecutable: resolveLocalClaudeCodeExecutable(),
          env: this.getEnv(),
          settings: this.getSettings(),
          ...this.getDisallowedToolOptions(),
        },
      });

      // The SDK's internal readMessages loop must be running for
      // the initialize control_response to be processed. Start
      // consuming the async iterator in the background.
      void (async () => {
        try {
          for await (const _ of sdkQuery) {
            // drain
          }
        } catch {
          // Expected — abort causes an error
        }
      })();

      return await withTimeout(request(sdkQuery), 15_000, label);
    } finally {
      abortController.abort();
    }
  }

  /**
   * Probe for available models by starting a minimal session.
   * The session doesn't send any messages - it just calls supportedModels()
   * on the SDK query and then aborts.
   */
  private async probeModels(): Promise<ModelInfo[]> {
    const models = await this.runControlProbe(
      "Claude model probe",
      (sdkQuery) => sdkQuery.supportedModels(),
    );
    return mergeClaudeModels(models.map((model) => mapClaudeSdkModel(model)));
  }

  /**
   * Synthesize a short on-return recap from recent assistant text. See
   * topics/recaps.md for the design rationale (SDK does not auto-emit
   * recaps in --print mode, so YA generates one ephemerally).
   *
   * Runs a non-persisted helper query so nothing lands in the underlying
   * session's JSONL. The `cheapest` helper token maps to Haiku for Claude.
   * The recap text is bounded by the
   * system prompt to roughly the Claude TUI's recap shape (≤40 words,
   * 1–2 plain sentences). The trailing "(disable recaps in /config)"
   * hint the TUI sometimes appends is a TUI affordance only — we do not
   * generate it here, so consumers do not need to strip it from YA-side
   * recaps; the renderer should still strip defensively in case the SDK
   * later forwards a TUI-shaped recap unchanged.
   */
  async generateSummary(
    request: SummaryGenerationRequest,
  ): Promise<SummaryGenerationResult> {
    switch (request.strategy) {
      case "side-session":
        return {
          text: await this.generateSideSessionRecap(
            request.recentAssistantText,
            request.model,
          ),
        };
      case "fork":
        return await this.generateForkBackedSummary(request);
    }
  }

  private async generateSideSessionRecap(
    recentAssistantText: string[],
    model?: string,
  ): Promise<string> {
    const trimmed = recentAssistantText
      .map((text) => text.trim())
      .filter((text) => text.length > 0);
    if (trimmed.length === 0) {
      throw new Error("No recent assistant text to summarize");
    }

    // Bound the input. The recent buffer is already small per entry, but
    // cap total to keep the ephemeral query cheap and well within the
    // helper context window even on long sessions.
    const MAX_TOTAL_CHARS = 6000;
    let total = 0;
    const tail: string[] = [];
    for (let i = trimmed.length - 1; i >= 0; i--) {
      const entry = trimmed[i] ?? "";
      if (total + entry.length > MAX_TOTAL_CHARS) {
        break;
      }
      tail.unshift(entry);
      total += entry.length;
    }
    if (tail.length === 0) {
      // The most recent entry alone exceeded the cap; take its tail.
      const last = trimmed[trimmed.length - 1] ?? "";
      tail.push(last.slice(-MAX_TOTAL_CHARS));
    }

    const transcript = tail
      .map((text, idx) => `--- Assistant turn ${idx + 1} ---\n${text}`)
      .join("\n\n");
    const userPrompt = [
      "The user stepped away and is coming back. Recap in under 40 words,",
      "1-2 plain sentences, no markdown. Lead with the overall thrust of what",
      "the assistant did or is doing; mention any pending next action.",
      "Do not greet, do not ask a question, do not add a sign-off.",
      "",
      "Recent assistant output:",
      transcript,
    ].join("\n");

    const abortController = new AbortController();
    const RECAP_TIMEOUT_MS = 20_000;
    const timeout = setTimeout(() => abortController.abort(), RECAP_TIMEOUT_MS);
    timeout.unref?.();

    async function* singlePrompt(): AsyncGenerator<{
      type: "user";
      message: { role: "user"; content: string };
      parent_tool_use_id: null;
      session_id: string;
    }> {
      yield {
        type: "user",
        message: { role: "user", content: userPrompt },
        parent_tool_use_id: null,
        session_id: "",
      };
    }

    const helperModel = model === HELPER_SIDE_MODEL_CHEAPEST ? "haiku" : model;

    try {
      const sdkQuery = query({
        prompt: singlePrompt(),
        options: {
          ...DEFAULT_CLAUDE_PROVIDER_GENERATION_OPTIONS,
          cwd: homedir(),
          abortController,
          permissionMode: "default",
          persistSession: false,
          pathToClaudeCodeExecutable: resolveLocalClaudeCodeExecutable(),
          env: this.getEnv(helperModel),
          settings: this.getSettings(helperModel),
          ...this.getDisallowedToolOptions(helperModel),
          model: helperModel,
          maxTurns: 1,
          systemPrompt:
            "You are a recap helper. Reply with the recap text only, no preamble.",
        },
      });

      let text = "";
      for await (const message of sdkQuery as AsyncIterable<AgentSDKMessage>) {
        if (
          message.type === "assistant" &&
          typeof message.message?.content !== "undefined"
        ) {
          text += extractClaudeAssistantText(message.message.content);
        }
        if (message.type === "result") {
          break;
        }
      }
      const cleaned = text
        .replace(/\s*\(disable recaps in \/config\)\s*$/u, "")
        .trim();
      if (!cleaned) {
        throw new Error("Recap generation returned empty text");
      }
      return cleaned;
    } finally {
      clearTimeout(timeout);
      abortController.abort();
    }
  }

  /** Keep account-home selection unchanged while addressing one captured root. */
  private async nativeSourceEnvironment(
    source: ProviderSessionSource,
    cwd: string,
    sessionSandbox: SessionSandboxRuntime | undefined,
    env: NodeJS.ProcessEnv,
  ): Promise<string> {
    let nativeCwd = cwd;
    const scope = source.native.storageScope;
    if (sessionSandbox) {
      if ((await realpath(sessionSandbox.transcriptDir)) !== scope)
        throw new Error(
          "Claude native source does not match the inherited private transcript root",
        );
    } else {
      // A child runs in the physical directory, including when its supplied
      // cwd is a symlink. Resolve that before interpreting a relative home.
      const physicalCwd = await realpath(nativeCwd).catch(() => null);
      if (!physicalCwd)
        throw new Error(
          "Claude native source has no available native project cwd",
        );
      nativeCwd = physicalCwd;
      // Do not change the home spelling: it can select the operator's account.
      const projects = await realpath(
        resolve(
          nativeCwd,
          env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
          "projects",
        ),
      ).catch(() => null);
      if (projects !== dirname(scope))
        throw new Error(
          "Claude native source is outside the launch transcript store; scoped resume is not qualified",
        );
      const name = basename(scope);
      if (
        env.CLAUDE_CONFIG_DIR &&
        /^[A-Za-z0-9_-]{1,64}$/.test(name) &&
        !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(name)
      ) {
        env.CLAUDE_CODE_PROJECT_DIR_NAME = name;
      } else {
        // Clearing an unusable selector is safe only when cwd addresses the
        // same captured native directory. Never try a competing same-id file.
        env.CLAUDE_CODE_PROJECT_DIR_NAME = undefined;
        if (claudeCwdProjectDirectory(nativeCwd) !== name)
          throw new Error(
            "Claude native source cannot be addressed by the native project selector or cwd",
          );
      }
    }
    return nativeCwd;
  }

  private async generateForkBackedSummary(
    request: Extract<SummaryGenerationRequest, { strategy: "fork" }>,
  ): Promise<SummaryGenerationResult> {
    assertProviderForkSource(
      {
        nativeSessionId: request.generatorSessionId,
        nativeSource: request.nativeSource,
      },
      this.name,
    );
    const summaryEnv = this.getEnv(request.model);
    let nativeCwd = request.nativeSource
      ? fromUrlProjectId(request.nativeSource.projectId)
      : request.cwd;
    if (request.nativeSource)
      nativeCwd = await this.nativeSourceEnvironment(
        request.nativeSource,
        nativeCwd,
        request.sessionSandbox,
        summaryEnv,
      );
    if (request.signal?.aborted)
      throw new DOMException("Summary generation cancelled", "AbortError");
    const userPrompt =
      request.purpose === "session-retitle"
        ? this.createSessionRetitlePrompt(request)
        : request.purpose === "recap"
          ? this.createForkedRecapPrompt()
          : this.createForkAfterSummaryPrompt(request);
    const abortController = new AbortController();
    const abortFromJob = () => abortController.abort();
    if (request.signal?.aborted) {
      abortController.abort();
    } else {
      request.signal?.addEventListener("abort", abortFromJob, { once: true });
    }
    const SUMMARY_TIMEOUT_MS = 60_000;
    const timeout = setTimeout(
      () => abortController.abort(),
      SUMMARY_TIMEOUT_MS,
    );
    timeout.unref?.();

    async function* singlePrompt(): AsyncGenerator<{
      type: "user";
      message: { role: "user"; content: string };
      parent_tool_use_id: null;
      session_id: string;
    }> {
      yield {
        type: "user",
        message: { role: "user", content: userPrompt },
        parent_tool_use_id: null,
        session_id: request.generatorSessionId,
      };
    }

    try {
      const sdkQuery = query({
        prompt: singlePrompt(),
        options: {
          ...DEFAULT_CLAUDE_PROVIDER_GENERATION_OPTIONS,
          cwd: nativeCwd,
          abortController,
          permissionMode: "default",
          pathToClaudeCodeExecutable: resolveLocalClaudeCodeExecutable(),
          env: summaryEnv,
          ...this.getSessionToolOptions(request.model, request.sessionSandbox),
          model: normalizeClaudeLaunchModel(request.model),
          resume: request.generatorSessionId,
          maxTurns: 1,
          spawnClaudeCodeProcess: request.sessionSandbox
            ? createSandboxedClaudeSpawn(request.sessionSandbox)
            : undefined,
          systemPrompt: {
            type: "custom",
            snapshot: false,
            prompt: [
              request.sessionSandbox?.instructions?.text,
              request.purpose === "session-retitle"
                ? "You are a title helper. Reply with the session title only, no preamble."
                : request.purpose === "recap"
                  ? "You are a recap helper. Reply with the recap text only, no preamble."
                  : "You are a handoff summary helper. Reply with the summary text only, no preamble.",
            ]
              .filter(Boolean)
              .join("\n\n"),
          },
        },
      });

      let text = "";
      for await (const message of sdkQuery as AsyncIterable<AgentSDKMessage>) {
        if (
          message.type === "assistant" &&
          typeof message.message?.content !== "undefined"
        ) {
          text += extractClaudeAssistantText(message.message.content);
        }
        if (message.type === "result") {
          break;
        }
      }
      const cleaned = text.trim();
      if (!cleaned) {
        throw new Error("Summary generation returned empty text");
      }
      return { text: cleaned };
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abortFromJob);
      abortController.abort();
    }
  }

  private createForkAfterSummaryPrompt(
    request: Extract<
      SummaryGenerationRequest,
      { purpose: "fork-after-summary" }
    >,
  ): string {
    const instructions = request.instructions?.trim();
    const boundaryContext = request.afterTurnContext?.trim();
    return [
      "The first non-empty line must be a concise title of at most 120 characters, with no trailing period.",
      "Write it as: Title: <title>",
      "Then leave one blank line before the handoff summary.",
      "",
      "Summarize the useful state after the retained fork boundary for a peer-agent handoff.",
      `The target fork retains the conversation through completed-turn message id ${request.afterTurnMessageId}.`,
      boundaryContext
        ? `The retained boundary is the completed turn ending with this excerpt:\n${boundaryContext}`
        : undefined,
      "The target fork already includes the original request and the assistant/tool work through that selected completed turn.",
      "Do not repeat setup, instruction loading, initial repository orientation, or investigation already present in that retained prefix.",
      "Preserve decisions, constraints, current state, changed files, verification evidence, open risks, and the next useful action.",
      "Do not continue the task. Write text that can be submitted as the next user turn in the target fork.",
      instructions ? "" : undefined,
      instructions ? "Additional user instructions:" : undefined,
      instructions || undefined,
    ]
      .filter((part): part is string => part !== undefined)
      .join("\n");
  }

  private createForkedRecapPrompt(): string {
    return [
      "The user stepped away and is coming back.",
      "Recap the current session state in under 40 words, 1-2 plain sentences, no markdown.",
      "Lead with what the assistant did or is doing; mention any pending next action.",
      "Do not greet, do not ask a question, do not add a sign-off.",
    ].join("\n");
  }

  private createSessionRetitlePrompt(
    request: Extract<SummaryGenerationRequest, { purpose: "session-retitle" }>,
  ): string {
    const lengthTarget = request.lengthTarget ?? 80;
    const currentTitle = request.currentTitle?.trim();
    return [
      "What is a good new title for this session?",
      "",
      `Target length: under ${lengthTarget} characters.`,
      currentTitle ? `Current title: ${currentTitle}` : undefined,
      "Prefer a concrete task/result phrase over a generic chat title.",
      "Return only the title. Do not quote it. Do not add a trailing period.",
    ]
      .filter((part): part is string => part !== undefined)
      .join("\n");
  }

  async refreshPromptCache(options: {
    sessionId: string;
    cwd: string;
    model?: string;
    thinking?: StartSessionOptions["thinking"];
    effort?: StartSessionOptions["effort"];
    globalInstructions?: string;
    executor?: string;
    pathToClaudeCodeExecutable?: string;
    env: Record<string, string | undefined>;
    sessionSandbox?: SessionSandboxRuntime;
  }): Promise<PromptCacheRefreshResult> {
    if (options.executor) throw new Error("SSH executors have been removed");
    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      CLAUDE_PROMPT_CACHE_KEEPALIVE_TIMEOUT_MS,
    );
    timeout.unref?.();

    async function* singlePrompt(): AsyncGenerator<{
      type: "user";
      message: { role: "user"; content: string };
      parent_tool_use_id: null;
      session_id: string;
    }> {
      yield {
        type: "user",
        message: {
          role: "user",
          content: "Prompt-cache keepalive only. Reply exactly: OK.",
        },
        parent_tool_use_id: null,
        session_id: options.sessionId,
      };
    }

    const spawnClaudeCodeProcess = options.sessionSandbox
      ? createSandboxedClaudeSpawn(options.sessionSandbox)
      : undefined;

    try {
      const sdkQuery = query({
        prompt: singlePrompt(),
        options: {
          ...DEFAULT_CLAUDE_PROVIDER_GENERATION_OPTIONS,
          cwd: options.cwd,
          resume: options.sessionId,
          abortController,
          permissionMode: "default",
          canUseTool: async () => ({
            behavior: "deny" as const,
            message: "Prompt-cache keepalive does not run tools",
            interrupt: true,
          }),
          // Must match the session's own system prompt to reuse its cache.
          systemPrompt: this.getSessionSystemPrompt(
            options.globalInstructions,
            options.sessionSandbox,
          ),
          settingSources: ["user", "project", "local"],
          includePartialMessages: false,
          persistSession: false,
          maxTurns: 1,
          maxBudgetUsd: CLAUDE_PROMPT_CACHE_KEEPALIVE_MAX_BUDGET_USD,
          model: normalizeClaudeLaunchModel(options.model),
          thinking: options.thinking,
          effort: options.effort,
          pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
          env: options.env,
          ...this.getSessionToolOptions(options.model, options.sessionSandbox),
          spawnClaudeCodeProcess,
        },
      });

      let usage: PromptCacheRefreshResult["usage"];
      for await (const message of sdkQuery as AsyncIterable<AgentSDKMessage>) {
        usage = extractPromptCacheRefreshUsage(message) ?? usage;
        if (message.type === "result") {
          break;
        }
      }

      return {
        mode: "no-context-pollution-nudge",
        refreshed: true,
        usage,
      };
    } finally {
      clearTimeout(timeout);
      abortController.abort();
    }
  }

  /**
   * Fork a session's transcript into a new resumable session via the Agent
   * SDK (`forkSession`): copies the jsonl with remapped UUIDs, optionally
   * sliced at `upToMessageId`. The kept prefix is byte-identical to the
   * source, so provider prompt-cache warmth carries over on resume.
   */
  async forkSession(options: ProviderForkOptions): Promise<ProviderForkResult> {
    assertProviderForkSource(options, this.name);
    if (options.boundary && options.boundary.kind !== "message") {
      throw new Error("Claude fork requires a message boundary");
    }
    let copyBoundary: ClaudeCopyBoundary | undefined;
    const copied = (boundary: ClaudeCopyBoundary | undefined) => {
      copyBoundary = boundary;
    };
    const upToMessageId =
      options.boundary?.kind === "message"
        ? options.boundary.messageId
        : options.upToMessageId;
    if (!options.sessionSandbox) {
      if (options.nativeSource)
        await assertClaudeCopyRoot(
          options.nativeSource.native.storageScope,
          this.getEnv().CLAUDE_CONFIG_DIR,
        );
      const result = await sdkForkSession(options.nativeSessionId, {
        dir: options.cwd,
        upToMessageId,
        title: options.title,
        ...(options.nativeSource
          ? {
              sessionStore: createClaudeForkStore(
                options.nativeSource.native.storageScope,
                copied,
              ),
            }
          : {}),
      });
      const nativeChildId = parseNativeSessionId(result.sessionId);
      return options.nativeSource
        ? {
            nativeSessionId: nativeChildId,
            ...(copyBoundary ? { copyBoundary } : {}),
            filePath: join(
              options.nativeSource.native.storageScope,
              nativeChildId + ".jsonl",
            ),
            native: await resolveNativeSessionRef(
              this.name,
              options.nativeSource.native.storageScope,
              nativeChildId,
            ),
            transcriptProjectId: options.nativeSource.projectId,
          }
        : { nativeSessionId: nativeChildId };
    }
    const directory = await options.sessionSandbox.openTranscriptDirectory();
    try {
      if (
        options.nativeSource &&
        (await realpath(options.sessionSandbox.transcriptDir)) !==
          options.nativeSource.native.storageScope
      ) {
        throw new Error(
          "Claude fork source does not match the inherited private transcript root",
        );
      }
      const result = await sdkForkSession(options.nativeSessionId, {
        dir: options.cwd,
        upToMessageId,
        title: options.title,
        sessionStore: createClaudeForkStore(directory, copied),
      });
      const nativeChildId = parseNativeSessionId(result.sessionId);
      return {
        nativeSessionId: nativeChildId,
        ...(copyBoundary ? { copyBoundary } : {}),
        filePath: join(
          options.sessionSandbox.transcriptDir,
          nativeChildId + ".jsonl",
        ),
        native: await resolveNativeSessionRef(
          this.name,
          options.sessionSandbox.transcriptDir,
          nativeChildId,
        ),
        ...(options.nativeSource
          ? { transcriptProjectId: options.nativeSource.projectId }
          : {}),
      };
    } finally {
      await directory.close();
    }
  }

  /**
   * Start a new Claude session.
   */
  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    return startAgentSelfSession(this.name, options, (resolved) =>
      this.startSessionInternal(resolved),
    );
  }

  /** Resolve and validate the actual native environment before readiness effects. */
  async validateNativeResumeSource(
    options: StartSessionOptions,
  ): Promise<void> {
    if (options.nativeResumeSource) await this.sessionEnvironment(options);
  }

  protected async sessionEnvironment(options: StartSessionOptions) {
    if (options.executor) throw new Error("SSH executors have been removed");
    const autoCompactOverrideEnv = getClaudeAutoCompactOverrideEnv(
      options.launchCompactPercentOverride,
    );
    const baseClaudeEnv = {
      ...this.getEnv(options.model),
      ...options.agentEnvironment,
      // The Supervisor never mints one for a sandboxed or remote launch;
      // refusing here too keeps the token out if that ever changes.
      ...agentServerEnvironmentFor(options),
      ...agentApiEnvironmentFor(options),
      ...autoCompactOverrideEnv,
    };
    if (options.routerLaunch)
      Object.assign(
        baseClaudeEnv,
        claudeRouterEnvironment(
          options.routerLaunch,
          baseClaudeEnv.ANTHROPIC_CUSTOM_HEADERS,
        ),
      );
    if (options.nativeResumeSource) {
      if (!options.resumeSessionId)
        throw new Error("Native resume source requires a continuation id");
      assertProviderForkSource(
        {
          nativeSessionId: parseNativeSessionId(options.resumeSessionId),
          nativeSource: options.nativeResumeSource,
        },
        this.name,
      );
      await this.nativeSourceEnvironment(
        options.nativeResumeSource,
        options.cwd,
        options.sessionSandbox,
        baseClaudeEnv,
      );
    }
    return baseClaudeEnv;
  }

  private async startSessionInternal(
    options: StartSessionOptions,
  ): Promise<AgentSession> {
    if (options.executor) throw new Error("SSH executors have been removed");
    const log = getLogger();
    const queue = new MessageQueue(prepareClaudeInput);
    const abortController = new AbortController();
    const providerSessionOptions = getClaudeSessionLaunchOptions(
      options.sessionOptions,
    );
    const baseClaudeEnv = await this.sessionEnvironment(options);
    const launchBridge = createLaunchAgentctlSessionEnvBridge({
      initialSessionId: options.publicSessionId ?? options.resumeSessionId,
      getSessionEnv: options.getSessionChildEnv,
      sessionSandbox: options.sessionSandbox,
    });
    const agentctlSessionEnvBridge = launchBridge?.bridge ?? null;
    // Spawns must use this runtime: it also mounts the bridge directory.
    const sessionSandbox = launchBridge
      ? launchBridge.sessionSandbox
      : options.sessionSandbox;
    const claudeEnv = agentctlSessionEnvBridge
      ? agentctlSessionEnvBridge.extendEnv(baseClaudeEnv)
      : baseClaudeEnv;
    const effectiveCwd = options.cwd;

    // Push the initial message into the queue (if provided)
    // If no message, the agent will wait until one is pushed
    if (options.initialMessage) {
      queue.push(options.initialMessage);
    }

    // Wrap our canUseTool to match SDK's expected type
    const onToolApproval = options.onToolApproval;
    const canUseTool: SDKCanUseTool | undefined = onToolApproval
      ? async (toolName, input, opts) => {
          console.log(`[canUseTool] Called for tool: ${toolName}`);
          const result = await onToolApproval(toolName, input, opts);
          console.log(
            `[canUseTool] Result for ${toolName}: ${result.behavior}`,
          );
          // Convert our result to SDK's PermissionResult format
          if (result.behavior === "allow") {
            return {
              behavior: "allow" as const,
              updatedInput: (result.updatedInput ?? input) as Record<
                string,
                unknown
              >,
            };
          }
          return {
            behavior: "deny" as const,
            message: result.message ?? "Permission denied",
            interrupt: result.interrupt,
          };
        }
      : undefined;

    // Capture the local provider process for liveness checks.
    let spawnClaudeCodeProcess:
      | ((
          opts: import("@anthropic-ai/claude-agent-sdk").SpawnOptions,
        ) => SpawnedProcess)
      | undefined;
    let capturedProcess: SpawnedProcess | null = null;
    const pathToClaudeCodeExecutable = resolveLocalClaudeCodeExecutable();

    if (USE_SPAWN_WRAPPER || sessionSandbox) {
      // Local spawn wrapper: delegates to child_process.spawn but captures the
      // SpawnedProcess reference so we can check liveness (exitCode) later.
      spawnClaudeCodeProcess = (spawnOpts) => {
        const stderrTail: string[] = [];
        const sandboxed = sessionSandbox?.wrapSpawn(
          spawnOpts.command,
          spawnOpts.args,
          spawnOpts.env as NodeJS.ProcessEnv,
        );
        const proc = (() => {
          try {
            return spawn(
              sandboxed?.command ?? spawnOpts.command,
              sandboxed?.args ?? spawnOpts.args,
              {
                cwd: sandboxed?.cwd ?? spawnOpts.cwd,
                env: sandboxed?.env ?? (spawnOpts.env as NodeJS.ProcessEnv),
                stdio: sandboxed?.stdio ?? ["pipe", "pipe", "pipe"],
                shell: sandboxed ? false : process.platform === "win32",
              },
            ) as ChildProcessWithoutNullStreams;
          } finally {
            sandboxed?.release();
          }
        })();

        log.info(
          {
            event: "claude_child_spawn_start",
            command: spawnOpts.command,
            args:
              sandboxed || options.routerLaunch ? undefined : spawnOpts.args,
            cwd: spawnOpts.cwd,
            shell: process.platform === "win32",
            resolvedExecutable: pathToClaudeCodeExecutable,
            sandboxed: Boolean(sandboxed),
          },
          "Starting Claude child process",
        );

        proc.once("spawn", () => {
          log.info(
            {
              event: "claude_child_spawned",
              pid: proc.pid,
              command: spawnOpts.command,
              cwd: spawnOpts.cwd,
              resolvedExecutable: pathToClaudeCodeExecutable,
            },
            "Claude child process spawned",
          );
        });

        proc.once("error", (error) => {
          log.error(
            {
              event: "claude_child_spawn_error",
              error: error instanceof Error ? error.message : String(error),
              command: spawnOpts.command,
              cwd: spawnOpts.cwd,
              resolvedExecutable: pathToClaudeCodeExecutable,
            },
            "Claude child process spawn error",
          );
        });

        proc.stdin?.on("error", (error) => {
          log.error(
            {
              event: "claude_child_stdin_error",
              pid: proc.pid,
              error: error instanceof Error ? error.message : String(error),
              code:
                error && typeof error === "object" && "code" in error
                  ? (error as { code?: unknown }).code
                  : undefined,
            },
            "Claude child stdin error",
          );
        });

        proc.stderr?.on("data", (chunk: Buffer) => {
          const stderr = chunk.toString("utf-8");
          stderrTail.push(stderr);
          while (stderrTail.join("").length > 8000) {
            stderrTail.shift();
          }
          const trimmed = stderr.trim();
          if (trimmed) {
            log.debug(
              {
                event: "claude_child_stderr",
                pid: proc.pid,
                stderr: options.routerLaunch
                  ? "[routed provider stderr omitted]"
                  : trimmed.slice(0, 2000),
              },
              "Claude child stderr",
            );
          }
        });

        proc.once("exit", (code, signal) => {
          const stderr = stderrTail.join("").trim();
          log.info(
            {
              event: "claude_child_exit",
              pid: proc.pid,
              code,
              signal,
              command: spawnOpts.command,
              cwd: spawnOpts.cwd,
              resolvedExecutable: pathToClaudeCodeExecutable,
              stderrTail: options.routerLaunch
                ? undefined
                : stderr
                  ? stderr.slice(-4000)
                  : undefined,
            },
            "Claude child process exited",
          );
        });

        // Forward abort to the owned local provider process.
        const abortHandler = () => {
          proc.kill("SIGTERM");
        };
        spawnOpts.signal.addEventListener("abort", abortHandler);
        proc.on("exit", () => {
          spawnOpts.signal.removeEventListener("abort", abortHandler);
        });

        capturedProcess = proc;
        return proc;
      };
    }

    const providerRetention = new ClaudeProviderRetentionTracker(
      options.onProviderRetentionChange,
    );

    // Create the SDK query with our message generator
    let sdkQuery: Query;
    let selectedModel = options.model;
    const turnEffort = new ClaudeTurnEffort(
      () => sdkQuery,
      async () => {
        const models = options.routerLaunch
          ? (options.routerLaunch.models ?? [])
          : await this.getAvailableModels();
        const model = models.find(
          (candidate) => candidate.id === (selectedModel ?? "default"),
        );
        if (!model)
          throw new Error(
            `No effort catalog for model ${selectedModel ?? "default"}`,
          );
        return model;
      },
      options.thinking,
      options.effort,
    );
    try {
      sdkQuery = query({
        prompt: turnEffort.input(queue),
        options: {
          cwd: effectiveCwd,
          resume: options.resumeSessionId,
          // Claude writes a new session under YA's id (plan 150 step 4).
          sessionId: options.resumeSessionId ? undefined : options.newSessionId,
          resumeSessionAt: options.resumeSessionAt,
          ...(options.resumeSessionAt && options.resumeDropsTurn
            ? { resumeDropsTurn: options.resumeDropsTurn }
            : {}),
          abortController,
          // Pass permission mode to SDK for system prompt configuration.
          // However, for "bypassPermissions" we pass "default" to the SDK so it always
          // calls our canUseTool callback - we handle the bypass logic ourselves so
          // user questions still surface instead of being silently answered.
          permissionMode:
            options.permissionMode === "bypassPermissions"
              ? "default"
              : (options.permissionMode ?? "default"),
          canUseTool,
          systemPrompt: this.getSessionSystemPrompt(
            options.globalInstructions,
            sessionSandbox,
          ),
          settingSources: ["user", "project", "local"],
          includePartialMessages: true,
          title: providerSessionOptions.sdk.title,
          promptSuggestions: providerSessionOptions.sdk.promptSuggestions,
          agentProgressSummaries:
            providerSessionOptions.sdk.agentProgressSummaries,
          // Model, thinking, and effort options
          model: normalizeClaudeLaunchModel(options.model),
          thinking: options.thinking,
          effort: options.effort,
          pathToClaudeCodeExecutable,
          // Filter env to exclude npm_*, yep-anywhere specific, and other irrelevant vars
          env: claudeEnv,
          ...this.getSessionToolOptions(options.model, sessionSandbox),
          ...(options.routerLaunch
            ? {
                settings: {
                  ...this.getSettings(options.model),
                  apiKeyHelper: "",
                  ...(options.routerLaunch.claudeAiConnectors
                    ? {}
                    : { disableClaudeAiConnectors: true }),
                  env: claudeRouterEnvironment(
                    options.routerLaunch,
                    claudeEnv.ANTHROPIC_CUSTOM_HEADERS,
                  ),
                },
              }
            : {}),
          hooks: {
            Stop: [
              {
                hooks: [
                  async (input) => {
                    providerRetention.observeStopHook(input);
                    return { continue: true };
                  },
                ],
              },
            ],
          },
          // Remote execution via SSH
          spawnClaudeCodeProcess,
        },
      });
    } catch (error) {
      agentctlSessionEnvBridge?.cleanup();
      // Handle common SDK initialization errors
      if (error instanceof Error) {
        if (error.message.includes("Claude Code executable not found")) {
          throw new Error(
            "Claude CLI not installed. Run: curl -fsSL https://claude.ai/install.sh | bash",
          );
        }
        if (
          error.message.includes("SPAWN") ||
          error.message.includes("spawn")
        ) {
          throw new Error(
            `Failed to spawn Claude CLI process: ${error.message}`,
          );
        }
      }
      throw error;
    }

    // Claude keeps `/goal` in a session-scoped Stop hook with no query for it,
    // so YA reads the transcript rows the CLI writes for every transition and
    // owns the paused state itself (topics/emulated-slash-commands.md).
    const goalTracker = new ClaudeGoalTracker(
      effectiveCwd,
      options.restoredGoal,
    );
    let goalCommandTail: Promise<void> = Promise.resolve();
    const buildCommandInventory = async (): Promise<SlashCommand[]> =>
      withClaudeGoalDetails(
        withClaudeGoalAlias(
          (await sdkQuery.supportedCommands()).map(mapClaudeSlashCommand),
        ),
        goalTracker.snapshot,
      );

    const steerBackgroundController = new ClaudeSteerBackgroundController({
      settings:
        options.claudeSteerBackgroundBash ??
        DEFAULT_CLAUDE_STEER_BACKGROUND_BASH,
      backgroundTask: (toolUseId) => sdkQuery.backgroundTasks(toolUseId),
      signal: abortController.signal,
    });

    // Wrap the iterator to convert SDK message types to our internal types
    const wrappedIterator = this.wrapIterator(sdkQuery, {
      signal: abortController.signal,
      providerRetention,
      goalTracker,
      getCommandInventory: buildCommandInventory,
      onMessage: async (message) => {
        if (message.type === "result") await turnEffort.complete();
        steerBackgroundController.observe(message);
      },
    });
    const previewedIterator = withClaudeToolOutputPreviews(wrappedIterator, {
      cwd: effectiveCwd,
      tmpRoots: claudeToolOutputTmpRoots(claudeEnv),
    });
    const iterator = agentctlSessionEnvBridge
      ? withCleanup(previewedIterator, () => agentctlSessionEnvBridge.cleanup())
      : previewedIterator;
    const isCapturedProcessAlive = USE_SPAWN_WRAPPER
      ? () =>
          capturedProcess !== null &&
          capturedProcess.exitCode === null &&
          !capturedProcess.killed
      : undefined;

    return {
      iterator,
      queue,
      abort: () => {
        abortController.abort();
        agentctlSessionEnvBridge?.cleanup();
      },
      steerUsesMessageQueue: true,
      steer: async (message) => {
        const yielded = waitForMessageYield(
          queue,
          message,
          abortController.signal,
        );
        queue.push(message);
        void yielded
          .then(async (wasYielded) => {
            if (!wasYielded) return;
            // MessageQueue resolves the SDK's pending next() first. One event
            // loop turn lets the SDK write that steer before the control call.
            await nextEventLoopTurn();
            await steerBackgroundController.backgroundEligible();
          })
          .catch((error) => {
            log.warn(
              {
                event: "claude_steer_background_bash_failed",
                error: error instanceof Error ? error.message : String(error),
              },
              "Failed to background a foreground Claude Bash after steering",
            );
          });
        return true;
      },
      isProcessAlive: isCapturedProcessAlive,
      probeLiveness: () =>
        probeClaudeControlLiveness(sdkQuery, {
          isProcessAlive: isCapturedProcessAlive,
        }),
      get pid() {
        return (capturedProcess as ChildProcess | null)?.pid;
      },
      getProviderRetention: () => providerRetention.getSnapshot(),
      refreshPromptCache: ({ sessionId }) =>
        this.refreshPromptCache({
          sessionId: options.nativeResumeSource?.native.id ?? sessionId,
          cwd: effectiveCwd,
          model: normalizeClaudeLaunchModel(options.model),
          thinking: options.thinking,
          effort: options.effort,
          globalInstructions: options.globalInstructions,
          pathToClaudeCodeExecutable,
          env: claudeEnv,
          sessionSandbox,
        }),
      publishAgentctlSessionId: (
        sessionId: string,
        browserDebugEnvironment?: Record<string, string>,
      ) => {
        agentctlSessionEnvBridge?.publishSessionId(
          sessionId,
          browserDebugEnvironment,
        );
      },
      setMaxThinkingTokens: (tokens: number | null) =>
        turnEffort.setThinking(tokens),
      setEffort: (effort?: EffortLevel) => {
        if (
          options.routerLaunch?.models &&
          !routerModelSupportsThinking(
            options.routerLaunch.models.find((m) => m.id === selectedModel),
            effort ? `on:${effort}` : "auto",
          )
        )
          throw new Error("Thinking level unavailable for the pinned account");
        return turnEffort.setEffort(effort);
      },
      setSessionOptions: (requested) =>
        Promise.resolve(
          evaluateClaudeSessionOptionsUpdate(
            providerSessionOptions.resolved,
            requested,
          ),
        ),
      interrupt: async () => {
        await sdkQuery.interrupt();
        return true;
      },
      supportedModels: async (): Promise<ModelInfo[]> => {
        if (options.routerLaunch) return options.routerLaunch.models ?? [];
        const models = await sdkQuery.supportedModels();
        return this.normalizeSupportedModels(models);
      },
      supportedCommands: buildCommandInventory,
      // 'full' counts each category with the token-count API (~0.3 s); the
      // 'summary' estimate measured 15% high with a near-zero Messages row.
      getContextBreakdown: async () =>
        normalizeClaudeContextUsage(
          await sdkQuery.getContextUsage({ detail: "full" }),
        ),
      runProviderCommand: async (
        command,
        argument,
      ): Promise<ProviderCommandResult> => {
        if (normalizedSlashCommandNameValue(command) !== GOAL_COMMAND_NAME) {
          return { handled: false };
        }
        // A Claude build without a native `/goal` gets YA's `/loop wish` alias
        // instead; that emulation owns the text and there is no goal to track.
        const commands = await sdkQuery.supportedCommands().catch(() => []);
        const native = commands.some(
          (entry) =>
            normalizedSlashCommandNameValue(entry.name) === GOAL_COMMAND_NAME,
        );
        if (!native) return { handled: false };
        // One goal command at a time: pause and resume each read the state
        // they are about to change.
        const operation = goalCommandTail.then(() =>
          runClaudeGoalCommand(argument, {
            tracker: goalTracker,
            // Goal text is a Claude local command, not a visible user turn. It
            // takes the most urgent lane because the lower lanes wait for a
            // boundary a goal loop never reaches: releasing the Stop hook is
            // what ends the turn, and that release is the message itself.
            send: (text) => {
              queue.push({ text, priority: "now", metadata: { hidden: true } });
            },
          }),
        );
        goalCommandTail = operation.then(
          () => {},
          () => {},
        );
        return operation;
      },
      setModel: async (model?: string) => {
        if (
          options.routerLaunch?.models &&
          !options.routerLaunch.models.some((m) => m.id === model)
        )
          throw new Error("Model unavailable for the pinned account");
        await sdkQuery.setModel(normalizeClaudeLaunchModel(model));
        selectedModel = model;
      },
    };
  }

  /**
   * Wrap the SDK iterator to convert message types.
   * The SDK emits its own message types which we convert to our SDKMessage type.
   */
  private async *wrapIterator(
    iterator: AsyncIterable<AgentSDKMessage>,
    observation?: {
      signal?: AbortSignal;
      providerRetention?: ClaudeProviderRetentionTracker;
      goalTracker?: ClaudeGoalTracker;
      /** Current inventory, already carrying goal state, for goal updates. */
      getCommandInventory?: () => Promise<SlashCommand[]>;
      onMessage?: (message: SDKMessage) => void | Promise<void>;
    },
  ): AsyncIterableIterator<SDKMessage> {
    let sessionId = "unknown";

    try {
      for await (const message of iterator) {
        // Log raw SDK message for analysis (if LOG_SDK_MESSAGES=true)
        sessionId =
          (message as { session_id?: string }).session_id ?? sessionId;
        logSDKMessage(sessionId, message, { provider: "claude" });

        const converted = this.convertMessage(
          message,
          observation?.goalTracker?.snapshot,
        );
        observation?.providerRetention?.observeMessage(converted);
        await observation?.onMessage?.(converted);
        yield converted;

        const goalUpdate = await this.observeClaudeGoal(converted, sessionId, {
          tracker: observation?.goalTracker,
          getCommandInventory: observation?.getCommandInventory,
        });
        if (goalUpdate) yield goalUpdate;
      }
    } catch (error) {
      // The native SDK can classify requested cancellation without naming it AbortError.
      if (
        observation?.signal?.aborted &&
        error instanceof Error &&
        "errorClass" in error &&
        error.errorClass === "aborted"
      )
        return;
      // Handle abort errors gracefully
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      // Re-throw process termination errors for Process to handle
      // These include: "ProcessTransport is not ready for writing"
      throw error;
    }
  }

  /**
   * Claude records goal transitions only in its session transcript, so refresh
   * that state at turn boundaries and while a dispatched goal command is still
   * unconfirmed. Returns an inventory update when the goal changed — including
   * the auto-clear after Claude judges a goal met or impossible — so the
   * session header's flag follows the provider rather than YA's intent.
   */
  private async observeClaudeGoal(
    message: SDKMessage,
    sessionId: string,
    goal: {
      tracker?: ClaudeGoalTracker;
      getCommandInventory?: () => Promise<SlashCommand[]>;
    },
  ): Promise<SDKMessage | null> {
    const tracker = goal.tracker;
    if (!tracker || message.type === "stream_event") return null;
    if (sessionId !== "unknown") tracker.attachSession(sessionId);
    const force =
      message.type === "result" ||
      (message.type === "system" && message.subtype === "init");
    try {
      if (!(await tracker.refreshIfDue(force))) return null;
      const commands = await goal.getCommandInventory?.();
      if (!commands) return null;
      return {
        type: "system",
        subtype: "commands_changed",
        session_id: sessionId,
        slash_command_inventory: commands,
      } as SDKMessage;
    } catch (error) {
      getLogger().warn(
        {
          event: "claude_goal_refresh_failed",
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to read Claude goal state from the session transcript",
      );
      return null;
    }
  }

  /**
   * Convert an SDK message to our internal SDKMessage format.
   *
   * We pass through all fields from the SDK without stripping.
   * This preserves debugging info, DAG structure, and metadata.
   */
  private convertMessage(
    message: AgentSDKMessage,
    goal?: ClaudeGoalSnapshot,
  ): SDKMessage {
    // Pass through all fields, only normalize content blocks
    const rawMessage = message as unknown as SDKMessage;
    const sdkMessage =
      rawMessage.type === "user"
        ? { ...rawMessage, inputMessageIds: claudeInputMessageIds(rawMessage) }
        : rawMessage;
    const withGoal = (commands: SlashCommand[]): SlashCommand[] =>
      goal ? withClaudeGoalDetails(commands, goal) : commands;
    if (
      sdkMessage.type === "system" &&
      sdkMessage.subtype === "commands_changed" &&
      Array.isArray(sdkMessage.commands)
    ) {
      return {
        ...sdkMessage,
        slash_command_inventory: withGoal(
          withClaudeGoalAlias(
            (sdkMessage.commands as ClaudeSdkSlashCommand[]).map(
              mapClaudeSlashCommand,
            ),
          ),
        ),
      };
    }
    if (
      sdkMessage.type === "system" &&
      sdkMessage.subtype === "init" &&
      Array.isArray(sdkMessage.slash_commands)
    ) {
      const skillNames = new Set(
        Array.isArray(sdkMessage.skills)
          ? (sdkMessage.skills as string[]).map((name) => name.toLowerCase())
          : [],
      );
      return {
        ...sdkMessage,
        slash_command_inventory: withGoal(
          filterClaudeRemoteSlashCommands(
            sdkMessage.slash_commands as string[],
            sdkMessage.terminal_slash_commands,
          ).map(
            (name): SlashCommand => ({
              name,
              description: "",
              ...(skillNames.has(name.toLowerCase())
                ? {
                    invocation: {
                      kind: "skill",
                      prefix: "/",
                      inventoryState: "current",
                    },
                  }
                : {}),
            }),
          ),
        ),
      };
    }

    // For messages with content, normalize the content blocks
    if (sdkMessage.message?.content) {
      return {
        ...sdkMessage,
        message: {
          ...sdkMessage.message,
          content: this.normalizeContent(sdkMessage.message.content),
        },
      };
    }

    // Pass through as-is for messages without content
    return sdkMessage;
  }

  /**
   * Normalize content to ensure consistent format.
   * Preserves all fields, only converts strings to text blocks.
   */
  private normalizeContent(
    content: string | ContentBlock[] | unknown,
  ): string | ContentBlock[] {
    // String content stays as string
    if (typeof content === "string") {
      return content;
    }

    // Array content - normalize each block
    if (Array.isArray(content)) {
      return content.map((block): ContentBlock => {
        if (typeof block === "string") {
          return { type: "text", text: block };
        }
        // Pass through all block fields - don't strip anything
        return block as ContentBlock;
      });
    }

    // Unknown content type - stringify for safety
    return String(content);
  }
}

/**
 * Default Claude provider instance.
 * Can be imported for convenience or instantiated directly.
 */
export const claudeProvider = new ClaudeProvider();
