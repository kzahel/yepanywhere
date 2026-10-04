import { routerModelSupportsThinking } from "@yep-anywhere/shared";
import { claudeRouterEnvironment } from "./router-transport.js";
import { startAgentSelfSession } from "./agent-self.js";
import {
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  execFile,
  spawn,
} from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { open as openFile, type FileHandle } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, extname, join, win32 } from "node:path";
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
  type ModelInfo,
  type PromptCacheKeepaliveProviderInfo,
  type ProviderSubscriptionUsage,
  type SlashCommand,
  type SubagentMaxDepth,
  getModelContextWindow,
} from "@yep-anywhere/shared";
import { getLogger } from "../../logging/logger.js";
import { quoteShellWord } from "../../utils/posixShell.js";
import { logSDKMessage } from "../messageLogger.js";
import { MessageQueue } from "../messageQueue.js";
import { ClaudeTurnEffort } from "./claude-turn-effort.js";
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
import {
  checkRemotePath,
  createRemoteSpawn,
  getRemoteHome,
  testSSHConnection,
  translateHomePath,
} from "../remote-spawn.js";
import { getProjectDirFromCwd, syncSessionFile } from "../session-sync.js";
import type {
  ContentBlock,
  ProviderCommandResult,
  ProviderLivenessProbeResult,
  SDKMessage,
} from "../types.js";
import { createLaunchAgentctlSessionEnvBridge } from "./agentctl-session-env.js";
import { filterEnvForChildProcess } from "./env-filter.js";
import { normalizeClaudeSubscriptionUsage } from "./provider-subscription-usage.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  PromptCacheRefreshResult,
  ProviderSessionOptions,
  ProviderSessionOptionsUpdateResult,
  ProviderName,
  ProviderForkBoundary,
  StartSessionOptions,
  SummaryGenerationRequest,
  SummaryGenerationResult,
} from "./types.js";
import {
  PROVIDER_SESSION_OPTION_KEYS,
  agentServerEnvironmentFor,
  resolveProviderSessionOptions,
} from "./types.js";
import type { SessionSandboxRuntime } from "../../session-sandbox.js";
import { withSessionSandboxAgentContext } from "../../session-sandbox-agent-context.js";

type ClaudeSdkModelInfo = Awaited<ReturnType<Query["supportedModels"]>>[number];
type ClaudeSdkSlashCommand = Awaited<
  ReturnType<Query["supportedCommands"]>
>[number];

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
const DEFAULT_CLAUDE_LOGIN_COMMAND = "claude auth login --claudeai";
const PROVIDER_MANAGED_SESSION_TITLE = "Yep Anywhere Session";
const CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE";
const CLAUDE_EFFORT_LEVELS: EffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
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

function createClaudeForkStore(directory: FileHandle): SessionStore {
  const directoryPath = `/proc/self/fd/${directory.fd}`;
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
        return content
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as SessionStoreEntry);
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
      } finally {
        await file.close();
      }
    },
  };
}
const requireFromHere = createRequire(import.meta.url);
const requireFromClaudeSdk = createRequire(
  requireFromHere.resolve("@anthropic-ai/claude-agent-sdk"),
);
let cachedLocalClaudeCodeExecutable: string | null | undefined;

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

function isExecutableFile(filePath: string | undefined): filePath is string {
  if (!filePath) return false;
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

interface ResolvePathExecutableOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  isExecutable?: (filePath: string) => boolean;
}

export function resolvePathExecutable(
  command: string,
  options: ResolvePathExecutableOptions = {},
): string | undefined {
  if (!command.trim()) return undefined;

  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const executable = options.isExecutable ?? isExecutableFile;
  const windows = platform === "win32";
  const pathApi = windows ? win32 : { extname, join };
  const hasPath = command.includes("/") || command.includes("\\");
  const commandExtension = pathApi.extname(command);
  if (
    windows &&
    commandExtension &&
    !/^\.(?:com|exe)$/i.test(commandExtension)
  ) {
    return undefined;
  }
  const commandNames =
    windows && !commandExtension
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((extension) => extension.trim())
          .filter((extension) => /^\.(?:com|exe)$/i.test(extension))
          .map((extension) => `${command}${extension}`)
      : [command];
  const directories = hasPath
    ? [""]
    : (env.PATH ?? "").split(windows ? ";" : delimiter);

  for (const dir of directories) {
    for (const commandName of commandNames) {
      const candidate = dir ? pathApi.join(dir, commandName) : commandName;
      if (executable(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function hasGlibcRuntime(): boolean {
  if (typeof process.report?.getReport !== "function") {
    return false;
  }
  const report = process.report.getReport() as {
    header?: { glibcVersionRuntime?: string };
  };
  return Boolean(report.header?.glibcVersionRuntime);
}

function getClaudeSdkNativePackageNames(): string[] {
  const binaryArch = process.arch;
  if (process.platform === "linux") {
    const glibcPackage = `@anthropic-ai/claude-agent-sdk-linux-${binaryArch}`;
    const muslPackage = `${glibcPackage}-musl`;
    return hasGlibcRuntime()
      ? [glibcPackage, muslPackage]
      : [muslPackage, glibcPackage];
  }

  return [`@anthropic-ai/claude-agent-sdk-${process.platform}-${binaryArch}`];
}

export function resolveClaudeSdkNativeExecutable(): string | undefined {
  const binaryName = process.platform === "win32" ? "claude.exe" : "claude";
  for (const packageName of getClaudeSdkNativePackageNames()) {
    try {
      const executable = requireFromClaudeSdk.resolve(
        `${packageName}/${binaryName}`,
      );
      if (isExecutableFile(executable)) {
        return executable;
      }
    } catch {
      // Optional package not installed for this platform.
    }
  }
  return undefined;
}

function resolveLocalClaudeCodeExecutable(): string | undefined {
  if (cachedLocalClaudeCodeExecutable !== undefined) {
    return cachedLocalClaudeCodeExecutable ?? undefined;
  }

  const envExecutable =
    process.env.CLAUDE_CODE_EXECUTABLE ?? process.env.CLAUDE_CODE_PATH;
  const executable = envExecutable
    ? resolvePathExecutable(envExecutable)
    : (resolveClaudeSdkNativeExecutable() ?? resolvePathExecutable("claude"));

  cachedLocalClaudeCodeExecutable = executable ?? null;
  return executable;
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

function safeMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function quotePowerShellDoubleQuoted(value: string): string {
  return `"${value
    .replace(/`/g, "``")
    .replace(/\$/g, "`$")
    .replace(/"/g, '`"')}"`;
}

export function formatClaudeLoginCommand(
  executablePath?: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const trimmedPath = executablePath?.trim();
  if (!trimmedPath || trimmedPath === "claude") {
    return DEFAULT_CLAUDE_LOGIN_COMMAND;
  }

  const executable =
    platform === "win32"
      ? quotePowerShellDoubleQuoted(trimmedPath)
      : quoteShellWord(trimmedPath);
  const invocation = platform === "win32" ? `& ${executable}` : executable;
  return `${invocation} auth login --claudeai`;
}

function getClaudeDesktopCodeRoots(): string[] {
  if (process.platform !== "win32") return [];

  const localAppData =
    process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  const roots: string[] = [];

  try {
    for (const entry of readdirSync(join(localAppData, "Packages"), {
      withFileTypes: true,
    })) {
      if (entry.isDirectory() && entry.name.startsWith("Claude_")) {
        roots.push(
          join(
            localAppData,
            "Packages",
            entry.name,
            "LocalCache",
            "Roaming",
            "Claude",
            "claude-code",
          ),
        );
      }
    }
  } catch {
    // Claude Desktop may not be installed through the Store package.
  }

  roots.push(join(appData, "Claude", "claude-code"));
  return roots;
}

function findClaudeDesktopExecutables(): string[] {
  const candidates: Array<{ path: string; mtimeMs: number }> = [];

  for (const root of getClaudeDesktopCodeRoots()) {
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;

        const candidateDir = join(root, entry.name);
        const candidate = join(candidateDir, "claude.exe");
        if (existsSync(candidate)) {
          candidates.push({
            path: candidate,
            mtimeMs: safeMtimeMs(candidateDir),
          });
        }
      }
    } catch {
      // This Claude Desktop layout is optional and version-dependent.
    }
  }

  return candidates
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((candidate) => candidate.path);
}

function hasShellClaudeCommand(): boolean {
  return resolvePathExecutable("claude") !== undefined;
}

async function isUsableClaudeExecutable(path: string): Promise<boolean> {
  try {
    await execFileAsync(path, ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

async function findPreferredClaudeLoginExecutable(): Promise<
  string | undefined
> {
  if (hasShellClaudeCommand()) {
    return undefined;
  }

  const sdkExecutable = resolveLocalClaudeCodeExecutable();
  if (sdkExecutable && (await isUsableClaudeExecutable(sdkExecutable))) {
    return sdkExecutable;
  }

  for (const executable of findClaudeDesktopExecutables()) {
    if (await isUsableClaudeExecutable(executable)) {
      return executable;
    }
  }

  return undefined;
}

export async function getClaudeLoginCommand(): Promise<string> {
  return formatClaudeLoginCommand(await findPreferredClaudeLoginExecutable());
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

/**
 * Sonnet's 1M was previously credit-gated (launching `sonnet[1m]` errored with
 * "Usage credits required for 1M context"), so it once kept a separate 200K
 * entry. Sonnet 5 lifted that gate: a live probe on this account runs
 * `--model sonnet` as `claude-sonnet-5[1m]` at a 1,000,000 window on the
 * standard tier with no error. The "Sonnet 5" label is pinned in the
 * description (the name stays the generic "Sonnet") rather than taken from the
 * SDK, because older `supportedModels()` responses reported the `sonnet` alias
 * as "Sonnet 4.6" even when it routed to Sonnet 5 at runtime.
 *
 * Opus deliberately stays bare. SDK 0.3.280 resolves bare `opus` to Opus 5.5
 * with a 1M context window, so rewriting the stable alias adds no capability
 * and couples launch behavior to a historical spelling. See
 * topics/claude-1m-context.md.
 */
const CLAUDE_LAUNCH_MODEL_ALIASES: Record<string, string> = {
  sonnet: "sonnet[1m]",
};

const ALWAYS_EXTENDED_DESCRIPTIONS: Record<string, string> = {
  opus: "Opus 5.5 with the full 1M-token context window",
  sonnet:
    "Sonnet 5 with the full 1M-token context window · newer tokenizer bills ~30% more tokens",
};

/** Normalize only aliases whose launch spelling still changes behavior. */
export function normalizeClaudeLaunchModel(
  model: string | undefined,
): string | undefined {
  return (model && CLAUDE_LAUNCH_MODEL_ALIASES[model]) || model;
}

/** Static fallback list of Claude models (used if probe fails) */
const CLAUDE_MODELS_FALLBACK: ModelInfo[] = [
  {
    id: "default",
    name: "Default",
    description: "Claude Code chooses the recommended model for your account",
    contextWindow: getModelContextWindow("default", "claude"),
  },
  {
    id: "best",
    name: "Best",
    description: "Highest-capability Claude Code alias (full 1M context)",
    contextWindow: getModelContextWindow("opus[1m]", "claude"),
  },
  {
    id: "fable",
    name: "Fable",
    description:
      "Most capable Claude model for demanding reasoning and long-horizon agentic work",
    contextWindow: getModelContextWindow("fable", "claude"),
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
    supportsEffort: true,
    supportsFastMode: false,
    supportedEffortLevels: CLAUDE_EFFORT_LEVELS,
    defaultEffortLevel: "high",
  },
  {
    id: "sonnet",
    name: "Sonnet",
    description: ALWAYS_EXTENDED_DESCRIPTIONS.sonnet,
    contextWindow: getModelContextWindow("sonnet[1m]", "claude"),
  },
  {
    id: "opus",
    name: "Opus",
    description: ALWAYS_EXTENDED_DESCRIPTIONS.opus,
    contextWindow: getModelContextWindow("opus[1m]", "claude"),
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
    supportsEffort: true,
    supportsFastMode: true,
    supportedEffortLevels: CLAUDE_EFFORT_LEVELS,
    defaultEffortLevel: "high",
  },
  {
    id: "haiku",
    name: "Haiku",
    description: "Fastest model for simple tasks",
    contextWindow: getModelContextWindow("haiku", "claude"),
  },
  {
    id: "opusplan",
    name: "Opus Plan",
    description: "Uses Opus for planning, then Sonnet for execution",
    contextWindow: getModelContextWindow("opus[1m]", "claude"),
  },
];

const CLAUDE_GOAL_LOOP_ALIAS_COMMAND: SlashCommand = {
  name: "goal",
  description: "Keep working toward a verifiable end state until it is met",
  argumentHint: "<verifiable end state>",
  emulation: {
    providerText: "/loop wish {{argument}}",
  },
  invocation: { kind: "emulated", prefix: "/" },
};

function isClaudeEffortLevel(value: unknown): value is EffortLevel {
  return (
    typeof value === "string" &&
    (CLAUDE_EFFORT_LEVELS as string[]).includes(value)
  );
}

function mapClaudeSupportedEffortLevels(
  levels: unknown,
): EffortLevel[] | undefined {
  if (!Array.isArray(levels)) return undefined;
  const supported = levels.filter(isClaudeEffortLevel);
  return supported.length > 0 ? supported : undefined;
}

function normalizedSlashCommandNameValue(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}

function normalizedSlashCommandName(command: SlashCommand): string {
  return normalizedSlashCommandNameValue(command.name);
}

export function filterClaudeRemoteSlashCommands(
  commands: string[],
  terminalCommands: unknown,
): string[] {
  if (
    !Array.isArray(terminalCommands) ||
    !terminalCommands.every((command) => typeof command === "string")
  ) {
    return commands;
  }

  const terminalNames = new Set(
    terminalCommands.map(normalizedSlashCommandNameValue),
  );
  return commands.filter(
    (command) => !terminalNames.has(normalizedSlashCommandNameValue(command)),
  );
}

export function withClaudeGoalAlias(commands: SlashCommand[]): SlashCommand[] {
  const normalizedNames = new Set(commands.map(normalizedSlashCommandName));
  if (normalizedNames.has("goal") || !normalizedNames.has("loop")) {
    return commands;
  }
  return [...commands, CLAUDE_GOAL_LOOP_ALIAS_COMMAND];
}

function mapClaudeSlashCommand(command: ClaudeSdkSlashCommand): SlashCommand {
  return {
    name: command.name,
    description: command.description,
    argumentHint: command.argumentHint || undefined,
    invocation: {
      kind: "skill",
      prefix: "/",
      inventoryState: "current",
      ...(command.aliases?.length ? { aliases: command.aliases } : {}),
    },
  };
}

function enrichClaudeModel(model: ModelInfo): ModelInfo {
  return {
    ...model,
    contextWindow:
      model.contextWindow ?? getModelContextWindow(model.id, "claude"),
    supportsEffort: model.supportsEffort ?? true,
    supportedEffortLevels: model.supportedEffortLevels ?? CLAUDE_EFFORT_LEVELS,
  };
}

function mapClaudeSdkModel(model: ClaudeSdkModelInfo): ModelInfo {
  return {
    id: model.value,
    resolvedModel: model.resolvedModel,
    name: model.displayName,
    description: model.description,
    contextWindow: model.resolvedModel
      ? getModelContextWindow(model.resolvedModel, "claude")
      : undefined,
    supportsEffort: model.supportsEffort,
    supportedEffortLevels: mapClaudeSupportedEffortLevels(
      model.supportedEffortLevels,
    ),
    supportsAdaptiveThinking: model.supportsAdaptiveThinking,
    supportsFastMode: model.supportsFastMode,
    supportsAutoMode: model.supportsAutoMode,
  };
}

function claudeModelFamily(
  modelId: string,
): "opus" | "sonnet" | "haiku" | "fable" | undefined {
  const name = modelId.toLowerCase();
  for (const family of ["opus", "sonnet", "haiku", "fable"] as const) {
    if (new RegExp(`(?:^|[-/])${family}(?:[-/]|$)`).test(name)) {
      return family;
    }
  }
  return undefined;
}

export function mergeClaudeModels(models: ModelInfo[]): ModelInfo[] {
  const byId = new Map<string, ModelInfo>();

  for (const model of CLAUDE_MODELS_FALLBACK) {
    byId.set(model.id, enrichClaudeModel(model));
  }

  // The catalog lists the current Fable row before any previous Fable
  // versions (Claude Code 2.1.283 adds `claude-fable-5` after
  // `claude-fable-5-1`). Only that first row speaks for the stable `fable`
  // selection; later ones stay concrete rows like `claude-opus-5`.
  let fableFolded = false;
  for (const model of models) {
    if (model.id === "default") {
      const fallback = byId.get("default");
      byId.set(
        "default",
        enrichClaudeModel({
          ...fallback,
          ...model,
          id: "default",
          name: fallback?.name ?? model.name,
          description: fallback?.description ?? model.description,
        }),
      );
      continue;
    }
    if (!fableFolded && claudeModelFamily(model.id) === "fable") {
      fableFolded = true;
      const fallback = byId.get("fable");
      byId.set(
        "fable",
        enrichClaudeModel({
          ...fallback,
          ...model,
          id: "fable",
          name: fallback?.name ?? model.name,
        }),
      );
      continue;
    }
    byId.set(
      model.id,
      enrichClaudeModel({
        ...byId.get(model.id),
        ...model,
      }),
    );
  }

  const orderedIds = [
    ...CLAUDE_MODELS_FALLBACK.map((model) => model.id),
    ...models.map((model) => model.id),
  ];

  const merged = [...new Set(orderedIds)]
    .map((id) => byId.get(id))
    .filter((model): model is ModelInfo => model !== undefined);

  // Drop the redundant "opus[1m]"/"sonnet[1m]" rows and surface their live
  // capability metadata on the stable family aliases. This catalog projection
  // is independent of launch spelling: bare `opus` already launches the
  // current Opus generation with the same 1M window.
  return merged
    .filter((model) => model.id !== "opus[1m]" && model.id !== "sonnet[1m]")
    .map((model) => {
      if (model.id === "opus") {
        const extended = byId.get("opus[1m]");
        return {
          ...model,
          ...extended,
          id: model.id,
          name: model.name,
          contextWindow: getModelContextWindow("opus[1m]", "claude"),
          description: ALWAYS_EXTENDED_DESCRIPTIONS.opus,
        };
      }
      if (model.id === "sonnet") {
        const extended = byId.get("sonnet[1m]");
        return {
          ...model,
          ...extended,
          id: model.id,
          name: model.name,
          contextWindow: getModelContextWindow("sonnet[1m]", "claude"),
          description: ALWAYS_EXTENDED_DESCRIPTIONS.sonnet,
        };
      }
      return model;
    });
}

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
  readonly supportsPermissionMode = true;
  readonly supportsThinkingToggle: boolean = true;
  readonly supportsSlashCommands = true;
  readonly supportsSteering = true;
  readonly supportsSteerNow = true;
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
  private probePromise: Promise<ModelInfo[]> | null = null;
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
    return resolveLocalClaudeCodeExecutable() !== undefined;
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
   * Fetches dynamically from SDK via a probe session, with caching.
   * Falls back to static list if probe fails or user is not authenticated.
   */
  async getAvailableModels(): Promise<ModelInfo[]> {
    // Return cached models if available
    if (this.cachedModels) {
      return this.projectAdditionalModels(this.cachedModels);
    }

    // Check if user is authenticated before trying to probe
    const authStatus = await this.getAuthStatus();
    if (!authStatus.authenticated) {
      return this.projectAdditionalModels(CLAUDE_MODELS_FALLBACK);
    }

    // If probe is already in progress, wait for it
    if (this.probePromise) {
      return this.projectAdditionalModels(await this.probePromise);
    }

    // Start a new probe
    this.probePromise = this.probeModels();
    try {
      const models = await this.probePromise;
      this.cachedModels = mergeClaudeModels(models);
      return this.projectAdditionalModels(this.cachedModels);
    } catch (error) {
      console.warn("[Claude] Failed to probe models, using fallback:", error);
      return this.projectAdditionalModels(CLAUDE_MODELS_FALLBACK);
    } finally {
      this.probePromise = null;
    }
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
    this.cachedModels = mappedModels;
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

  private async generateForkBackedSummary(
    request: Extract<SummaryGenerationRequest, { strategy: "fork" }>,
  ): Promise<SummaryGenerationResult> {
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
          cwd: request.cwd,
          abortController,
          permissionMode: "default",
          pathToClaudeCodeExecutable: resolveLocalClaudeCodeExecutable(),
          env: this.getEnv(request.model),
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
    remoteEnv?: Record<string, string>;
    pathToClaudeCodeExecutable?: string;
    env: Record<string, string | undefined>;
    sessionSandbox?: SessionSandboxRuntime;
  }): Promise<PromptCacheRefreshResult> {
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

    const spawnClaudeCodeProcess = options.executor
      ? createRemoteSpawn({
          host: options.executor,
          remoteEnv: options.remoteEnv,
        })
      : options.sessionSandbox
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
  async forkSession(options: {
    sessionId: string;
    cwd: string;
    upToMessageId?: string;
    boundary?: ProviderForkBoundary;
    title?: string;
    sessionSandbox?: SessionSandboxRuntime;
  }): Promise<{ sessionId: string }> {
    if (options.boundary && options.boundary.kind !== "message") {
      throw new Error("Claude fork requires a message boundary");
    }
    const upToMessageId =
      options.boundary?.kind === "message"
        ? options.boundary.messageId
        : options.upToMessageId;
    if (!options.sessionSandbox) {
      return sdkForkSession(options.sessionId, {
        dir: options.cwd,
        upToMessageId,
        title: options.title,
      });
    }
    const transcriptDirectory =
      await options.sessionSandbox.openTranscriptDirectory();
    try {
      return await sdkForkSession(options.sessionId, {
        dir: options.cwd,
        upToMessageId,
        title: options.title,
        sessionStore: createClaudeForkStore(transcriptDirectory),
      });
    } finally {
      await transcriptDirectory.close();
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

  private async startSessionInternal(
    options: StartSessionOptions,
  ): Promise<AgentSession> {
    const log = getLogger();
    const queue = new MessageQueue();
    const abortController = new AbortController();
    const providerSessionOptions = getClaudeSessionLaunchOptions(
      options.sessionOptions,
    );
    const launchBridge = options.executor
      ? null
      : createLaunchAgentctlSessionEnvBridge({
          initialSessionId: options.resumeSessionId,
          getSessionEnv: options.getSessionChildEnv,
          sessionSandbox: options.sessionSandbox,
        });
    const agentctlSessionEnvBridge = launchBridge?.bridge ?? null;
    // Spawns must use this runtime: it also mounts the bridge directory.
    const sessionSandbox = launchBridge
      ? launchBridge.sessionSandbox
      : options.sessionSandbox;
    const autoCompactOverrideEnv = getClaudeAutoCompactOverrideEnv(
      options.launchCompactPercentOverride,
    );
    const baseClaudeEnv = {
      ...this.getEnv(options.model),
      ...options.agentEnvironment,
      // The Supervisor never mints one for a sandboxed or remote launch;
      // refusing here too keeps the token out if that ever changes.
      ...agentServerEnvironmentFor(options),
      ...autoCompactOverrideEnv,
    };
    if (options.routerLaunch)
      Object.assign(
        baseClaudeEnv,
        claudeRouterEnvironment(options.routerLaunch),
      );
    const claudeEnv = agentctlSessionEnvBridge
      ? agentctlSessionEnvBridge.extendEnv(baseClaudeEnv)
      : baseClaudeEnv;
    const configuredRemoteEnv = options.executor
      ? {
          ...options.remoteEnv,
          ...autoCompactOverrideEnv,
        }
      : options.remoteEnv;
    const remoteEnv =
      options.executor && options.resumeSessionId
        ? {
            ...configuredRemoteEnv,
            AGENTCTL_SESSION_ID: options.resumeSessionId,
            ...options.getSessionChildEnv?.(options.resumeSessionId),
          }
        : configuredRemoteEnv;

    // Effective cwd for the session (may be translated for remote executors)
    let effectiveCwd = options.cwd;

    // If remote executor specified, test connection first
    if (options.executor) {
      log.info(
        {
          event: "remote_session_start",
          executor: options.executor,
          cwd: options.cwd,
        },
        `Starting remote session on ${options.executor}`,
      );

      const testResult = await testSSHConnection(options.executor);
      if (!testResult.success) {
        throw new Error(
          `SSH connection to ${options.executor} failed: ${testResult.error}`,
        );
      }
      if (!testResult.claudeAvailable) {
        throw new Error(
          `Claude CLI not found on ${options.executor}. Install with: curl -fsSL https://claude.ai/install.sh | bash`,
        );
      }

      // Translate the working directory path for the remote host
      // (e.g., /home/user/... on Linux -> /Users/user/... on macOS)
      if (options.cwd) {
        const remoteHome = await getRemoteHome(options.executor);
        if (remoteHome) {
          const localHome = homedir();
          effectiveCwd = translateHomePath(options.cwd, localHome, remoteHome);
          if (effectiveCwd !== options.cwd) {
            log.info(
              {
                event: "remote_path_translated",
                executor: options.executor,
                localPath: options.cwd,
                remotePath: effectiveCwd,
                localHome,
                remoteHome,
              },
              `Translated path for ${options.executor}: ${options.cwd} -> ${effectiveCwd}`,
            );
          }
        }

        // Check if the (translated) working directory exists on the remote
        const pathCheck = await checkRemotePath(options.executor, effectiveCwd);
        if (!pathCheck.exists) {
          throw new Error(
            `Directory does not exist on ${options.executor}: ${effectiveCwd}`,
          );
        }
      }
    }

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

    // Create spawn function: remote spawn for SSH executors, local wrapper for liveness checks
    let spawnClaudeCodeProcess:
      | ((
          opts: import("@anthropic-ai/claude-agent-sdk").SpawnOptions,
        ) => SpawnedProcess)
      | undefined;
    let capturedProcess: SpawnedProcess | null = null;
    const pathToClaudeCodeExecutable = options.executor
      ? undefined
      : resolveLocalClaudeCodeExecutable();

    if (options.executor) {
      spawnClaudeCodeProcess = createRemoteSpawn({
        host: options.executor,
        remoteEnv,
      });
    } else if (USE_SPAWN_WRAPPER || sessionSandbox) {
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

        // Wire up abort signal → SIGTERM, matching remote-spawn behavior
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
                  disableClaudeAiConnectors: true,
                  env: claudeRouterEnvironment(options.routerLaunch),
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
    // Pass executor info for session sync after result messages
    // Use effectiveCwd (the translated remote path) so sync uses the correct project dir
    const wrappedIterator = this.wrapIterator(sdkQuery, {
      executor: options.executor,
      cwd: effectiveCwd,
      remoteEnv,
      providerRetention,
      goalTracker,
      getCommandInventory: buildCommandInventory,
      onMessage: async (message) => {
        if (message.type === "result") await turnEffort.complete();
        steerBackgroundController.observe(message);
      },
    });
    // A remote executor's task output files live on the remote host.
    const previewedIterator = options.executor
      ? wrappedIterator
      : withClaudeToolOutputPreviews(wrappedIterator, {
          cwd: effectiveCwd,
          tmpRoots: claudeToolOutputTmpRoots(claudeEnv),
        });
    const iterator = agentctlSessionEnvBridge
      ? withCleanup(previewedIterator, () => agentctlSessionEnvBridge.cleanup())
      : previewedIterator;
    const isCapturedProcessAlive =
      USE_SPAWN_WRAPPER && !options.executor
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
          sessionId,
          cwd: effectiveCwd,
          model: normalizeClaudeLaunchModel(options.model),
          thinking: options.thinking,
          effort: options.effort,
          globalInstructions: options.globalInstructions,
          executor: options.executor,
          remoteEnv,
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
   *
   * For remote sessions, syncs session files after each result message.
   */
  private async *wrapIterator(
    iterator: AsyncIterable<AgentSDKMessage>,
    remoteOptions?: {
      executor?: string;
      cwd: string;
      remoteEnv?: Record<string, string>;
      providerRetention?: ClaudeProviderRetentionTracker;
      goalTracker?: ClaudeGoalTracker;
      /** Current inventory, already carrying goal state, for goal updates. */
      getCommandInventory?: () => Promise<SlashCommand[]>;
      onMessage?: (message: SDKMessage) => void | Promise<void>;
    },
  ): AsyncIterableIterator<SDKMessage> {
    const log = getLogger();
    let sessionId = "unknown";

    try {
      for await (const message of iterator) {
        // Log raw SDK message for analysis (if LOG_SDK_MESSAGES=true)
        sessionId =
          (message as { session_id?: string }).session_id ?? sessionId;
        logSDKMessage(sessionId, message, { provider: "claude" });

        const converted = this.convertMessage(
          message,
          remoteOptions?.goalTracker?.snapshot,
        );
        remoteOptions?.providerRetention?.observeMessage(converted);
        await remoteOptions?.onMessage?.(converted);
        yield converted;

        const goalUpdate = await this.observeClaudeGoal(converted, sessionId, {
          tracker: remoteOptions?.goalTracker,
          getCommandInventory: remoteOptions?.getCommandInventory,
        });
        if (goalUpdate) yield goalUpdate;

        // For remote sessions, sync session files after result messages
        // This keeps the local UI up-to-date with remote progress
        if (
          remoteOptions?.executor &&
          converted.type === "result" &&
          sessionId !== "unknown"
        ) {
          const projectDir = getProjectDirFromCwd(remoteOptions.cwd);
          log.debug(
            {
              event: "remote_session_sync",
              executor: remoteOptions.executor,
              sessionId,
              projectDir,
            },
            "Syncing session from remote after turn",
          );

          // Sync in background - don't block the iterator
          syncSessionFile(
            remoteOptions.executor,
            projectDir,
            sessionId,
            undefined,
            remoteOptions.remoteEnv?.CLAUDE_SESSIONS_DIR,
          ).catch((error) => {
            log.warn(
              {
                event: "remote_session_sync_error",
                executor: remoteOptions.executor,
                sessionId,
                error: error instanceof Error ? error.message : String(error),
              },
              `Failed to sync session from remote: ${error}`,
            );
          });
        }
      }
    } catch (error) {
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
    const sdkMessage = message as unknown as SDKMessage;
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
