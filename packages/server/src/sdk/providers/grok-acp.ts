import { nativeStorageScope } from "./native-storage-scope.js";
/**
 * Grok Build ACP Provider implementation using Agent Client Protocol.
 *
 * Phase 1 (live supervision prototype): core startSession -> iterator/queue/abort,
 * ACPClient wiring for `grok agent stdio`, local model-catalog discovery,
 * basic install/auth detection via GROK_HOME (default ~/.grok),
 * normalization of ACP events (agent_thought_chunk, tool_call*,
 * agent_message_chunk, plan) into SDKMessage (thinking blocks + tool_use/tool_result + approvals).
 * Grok's x.ai AskUserQuestion and ExitPlanMode extension requests reuse YA's
 * existing pending-input flow.
 * Mid-turn steer uses Grok's `x.ai/interject` extension (safe-point drain,
 * not a second session/prompt). Continuation uses stable ACP session/load.
 *
 * Effort mapping: YA EffortLevel is passed through to Grok's top-level --effort flag.
 *
 * **STRICT ISOLATION (per topics/grok.md + AGENTS.md + CLAUDE.local.md)**:
 * - No edits to Process.ts, Supervisor.ts, core routing, messageQueue, other providers,
 *   shared hot paths, or any non-registration files.
 * - Gated behind `ENABLED_PROVIDERS=grok` (or equivalent filter); when the env var
 *   does not list "grok", this code is unreachable and other providers are 100% unaffected.
 *
 * Modeled closely on gemini-acp.ts + ACPClient. Grok's live and persisted
 * tool lifecycles share only the provider-specific normalizer in
 * grok-tool-normalization.ts; no other provider or shared hot path depends on
 * Grok's extension metadata.
 *
 * Authoritative references (highest priority):
 * - /local/graehl/yepanywhere/topics/grok.md (full contract, Phase plan, non-goals)
 * - /home/graehl/.grok/docs/user-guide/15-agent-mode.md ("grok agent stdio", ACP events,
 *   stdio transport, extension methods, integration example using spawn("grok", ["agent", "stdio"]))
 * - /home/graehl/.grok/docs/user-guide/17-sessions.md (agent stdio session management via ACP)
 * - /home/graehl/.grok/docs/user-guide/02-authentication.md (auth.json location + semantics)
 * - /home/graehl/.grok/docs/user-guide/03-keyboard-shortcuts.md + 14-headless-mode.md (effort,
 *   permission modes, interject for future phases)
 * - Local ~/.grok/models_cache.json + `grok models` + `~/.grok/bin/grok --help` (model info)
 * Native ACP fork and full /btw remain later phases.
 *
 * Audited through Grok 1.0.60 (2026-10) using the installed binary, a no-token
 * ACP initialize/session/new/session/load probe, and first-party
 * xai-org/grok-build source (package 1.0.45, SOURCE_REV 559751f, which trails
 * the binary). ACP `grok agent --no-leader
 * stdio` remains the official embedding path; there is no Grok-specific Node
 * agent SDK.
 */

import { exec, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate,
  ToolCall,
  ToolCallUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type {
  EffortLevel,
  ModelCatalogStatus,
  ModelInfo,
  SlashCommand,
  SubagentMaxDepth,
} from "@yep-anywhere/shared";
import {
  canonicalizeSkillInvocations,
  DEFAULT_SUBAGENT_MAX_DEPTH,
  fromUrlProjectId,
  parseNativeSessionId,
} from "@yep-anywhere/shared";
import { getLogger } from "../../logging/logger.js";
import {
  fallbackModelCatalog,
  liveModelCatalog,
  modelCatalogError,
} from "./model-catalog-status.js";
import { attachToolResultMediaCandidates } from "../../media/inlineImageData.js";
import { selectCommandLookupTarget } from "../cli-detection.js";
import { whichCommand } from "../which-command.js";
import { MessageQueue } from "../messageQueue.js";
import type {
  PermissionMode,
  SDKMessage,
  ToolApprovalResult,
} from "../types.js";
import {
  ACPClient,
  acpErrorMessage,
  isRequestedACPClosure,
} from "./acp/client.js";
import {
  copyAgentctlBashEnvInto,
  createAgentctlSessionEnvBridge,
  type AgentctlSessionEnvBridge,
} from "./agentctl-session-env.js";
import { grokInterjectAccepted } from "./grok-interject-text.js";
import { grokEventUuid } from "./grok-message-identity.js";
import {
  type NormalizedGrokToolState,
  buildGrokStructuredToolResult,
  formatGrokToolResultContent,
  grokToolResultMediaCandidate,
  hasGrokToolUseMetadata,
  isTerminalGrokToolUpdate,
  normalizeGrokToolUpdate,
} from "./grok-tool-normalization.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  ProviderName,
  StartSessionOptions,
} from "./types.js";
import { assertProviderForkSource } from "./types.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * Env vars the `grok` CLI honors for API-key auth. Older auth docs said the key
 * "takes precedence over browser credentials"; 1.0.60's docs rank an active
 * signed-in session first, with the key as a fallback. Either way, a key in
 * the spawned process's environment can silently switch Grok Build from the
 * user's grok.com subscription to metered pay-as-you-go API billing (always
 * on older CLIs, after a login expires on newer ones). We strip them
 * from the child env so YA's own xAI usage (e.g. a Speech-to-Text key, kept
 * under a YA-private name) can never flip the supervised coding agent's
 * billing. Scoped to this new, not-yet-public provider so existing providers
 * that rely on ambient env passthrough are unaffected.
 */
const GROK_BILLING_ENV_DENYLIST = ["XAI_API_KEY", "GROK_CODE_XAI_API_KEY"];

/**
 * Compatibility fallback for older installations whose model command/cache
 * cannot be read. Current installations are discovered dynamically.
 */
const LEGACY_GROK_MODELS: ModelInfo[] = [
  {
    id: "grok-build",
    name: "Grok Build",
    description: "Best for advanced coding tasks",
    contextWindow: 512000,
    isDefault: true,
  },
];

const GROK_EFFORT_LEVELS = new Set<EffortLevel>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function asRecordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function effortLevel(value: unknown): EffortLevel | undefined {
  const candidate = nonemptyString(value) as EffortLevel | undefined;
  return candidate && GROK_EFFORT_LEVELS.has(candidate) ? candidate : undefined;
}

function parseGrokModelsOutput(output: string | undefined): {
  defaultModelId?: string;
  modelIds: string[];
} {
  const modelIds: string[] = [];
  let defaultModelId: string | undefined;
  for (const line of output?.split(/\r?\n/) ?? []) {
    const declaredDefault = line.match(/^\s*Default model:\s*(\S+)\s*$/i);
    if (declaredDefault) {
      defaultModelId = declaredDefault[1];
      continue;
    }
    const listed = line.match(/^\s*[-*]\s+(\S+)(?:\s+\(default\))?\s*$/i);
    if (!listed) continue;
    const listedId = listed[1];
    if (!listedId) continue;
    modelIds.push(listedId);
    if (/\(default\)\s*$/i.test(line)) {
      defaultModelId = listedId;
    }
  }
  return { defaultModelId, modelIds };
}

/**
 * Normalize the object-keyed model cache shipped by current Grok versions.
 * `grok models` remains authoritative for visibility/order/default selection;
 * cache entries contribute richer names, descriptions, context, and efforts.
 */
export function normalizeGrokModels(
  rawCache: unknown,
  modelsOutput?: string,
): ModelInfo[] {
  const root = asRecordValue(rawCache);
  const rawModels = root?.models;
  const cached = new Map<string, ModelInfo>();

  const entries: Array<[string | undefined, unknown]> = Array.isArray(rawModels)
    ? rawModels.map((value) => [undefined, value])
    : Object.entries(asRecordValue(rawModels) ?? {});

  for (const [cacheKey, value] of entries) {
    const wrapper = asRecordValue(value);
    const info = asRecordValue(wrapper?.info) ?? wrapper;
    if (!info || info.hidden === true) continue;

    const id =
      nonemptyString(info.id) ??
      nonemptyString(info.model) ??
      nonemptyString(cacheKey);
    if (!id) continue;

    const reasoningEfforts = Array.isArray(info.reasoning_efforts)
      ? info.reasoning_efforts
          .map((value) => asRecordValue(value))
          .filter(
            (value): value is Record<string, unknown> => value !== undefined,
          )
      : [];
    const supportedEffortLevels = reasoningEfforts
      .map((value) => effortLevel(value.value ?? value.id))
      .filter((value): value is EffortLevel => value !== undefined);
    // Prefer the first advertised default. Grok 1.0.4's 4.6 marked both xhigh
    // and high as default:true, and the CLI/ACP default was the first row;
    // 1.0.60 marks only high. The cache's info.reasoning_effort can lag the
    // rows.
    const defaultEffortLevel =
      reasoningEfforts
        .filter((value) => value.default === true)
        .map((value) => effortLevel(value.value ?? value.id))
        .find((value): value is EffortLevel => value !== undefined) ??
      effortLevel(info.reasoning_effort);
    const contextWindow =
      typeof info.context_window === "number" ? info.context_window : undefined;
    const supportsEffort =
      info.supports_reasoning_effort === true ||
      supportedEffortLevels.length > 0;

    cached.set(id, {
      id,
      name: nonemptyString(info.name) ?? id,
      ...(nonemptyString(info.description)
        ? { description: nonemptyString(info.description) }
        : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(supportsEffort ? { supportsEffort: true } : {}),
      ...(supportedEffortLevels.length > 0
        ? {
            supportedEffortLevels,
            supportedReasoningEfforts: reasoningEfforts.flatMap((value) => {
              const reasoningEffort = nonemptyString(value.value ?? value.id);
              return reasoningEffort
                ? [
                    {
                      reasoningEffort,
                      ...(nonemptyString(value.description)
                        ? { description: nonemptyString(value.description) }
                        : {}),
                    },
                  ]
                : [];
            }),
          }
        : {}),
      ...(defaultEffortLevel
        ? {
            defaultEffortLevel,
            defaultReasoningEffort: defaultEffortLevel,
          }
        : {}),
    });
  }

  const listing = parseGrokModelsOutput(modelsOutput);
  const ids =
    listing.modelIds.length > 0 ? listing.modelIds : Array.from(cached.keys());
  const models = ids.map(
    (id): ModelInfo =>
      cached.get(id) ?? {
        id,
        name: id,
      },
  );
  const defaultModelId = listing.defaultModelId ?? models[0]?.id;
  return models.map((model) => ({
    ...model,
    ...(model.id === defaultModelId ? { isDefault: true } : {}),
  }));
}

interface GrokAuthProfile {
  access_token?: unknown;
  refresh_token?: unknown;
  session?: unknown;
  key?: unknown;
  api_key?: unknown;
  expires_at?: unknown;
  expiry_date?: unknown;
  email?: unknown;
  name?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  [key: string]: unknown;
}

interface GrokPromptRuntime {
  sessionId?: string;
  activePromptCount: number;
  promptError: unknown;
}

type GrokLiveToolState = NormalizedGrokToolState & {
  resultEmitted: boolean;
};

interface GrokCommandInventory {
  commands: SlashCommand[];
}

/**
 * Configuration for Grok ACP provider (rarely needed; auto-detects preferred ~/.grok/bin/grok).
 */
export interface GrokACPProviderConfig {
  /** Path to grok binary (auto-detected if not specified) */
  grokPath?: string;
  /** Test seam for deterministic ACP client injection. */
  createClient?: () => ACPClient;
  /** Test seam for deterministic install detection. */
  pathExists?: (path: string) => boolean;
}

/**
 * Grok Build ACP Provider (Phase 1).
 *
 * Uses the Grok CLI's `grok agent stdio` subcommand for ACP protocol support
 * (JSON-RPC over stdio). The agent manages its own tool loop + sandbox; we
 * surface thoughts, tool calls (with diffs/locations via protocol), and route
 * permission requests to YA's approval flow.
 */
export class GrokACPProvider implements AgentProvider {
  readonly supportsNativeResumeSource = true;
  readonly name: ProviderName = "grok";
  readonly displayName = "Grok Build";
  readonly supportsPermissionMode = true;
  readonly supportsThinkingToggle = true; // Effort via CLI --effort flag (attempted even if model cache says false)
  readonly supportsSlashCommands = true;
  /**
   * Mid-turn steer is `x.ai/interject`, not a second `session/prompt`.
   * Interjections drain after the current tool batch / next model step and
   * do not cancel the turn (`supportsSteerNow` stays unset).
   */
  readonly supportsSteering = true;
  readonly steering = {
    selection: "per-message",
    modes: ["gentle"],
    defaultMode: "gentle",
  } as const;

  private readonly grokPath?: string;
  private readonly createClient: () => ACPClient;
  private readonly pathExists: (path: string) => boolean;
  private ambientXaiApiKey: string | undefined;
  private useAmbientXaiApiKey = false;
  private modelCache: ModelInfo[] | undefined;
  private modelCatalogStatus: ModelCatalogStatus | undefined;
  private getConfiguredSubagentMaxDepth: () => SubagentMaxDepth = () =>
    DEFAULT_SUBAGENT_MAX_DEPTH;
  private log = getLogger();

  constructor(config: GrokACPProviderConfig = {}) {
    this.grokPath = config.grokPath;
    this.createClient = config.createClient ?? (() => new ACPClient());
    this.pathExists = config.pathExists ?? existsSync;
  }

  setAmbientXaiApiKey(apiKey: string | undefined): void {
    this.ambientXaiApiKey = apiKey || undefined;
  }

  setUseAmbientXaiApiKey(enabled: boolean): void {
    this.useAmbientXaiApiKey = enabled;
  }

  setSubagentMaxDepthGetter(getter: () => SubagentMaxDepth): void {
    this.getConfiguredSubagentMaxDepth = getter;
  }

  /**
   * Grok's documented process knobs are `GROK_SUBAGENTS=0` (disable) and a
   * hard nesting cap of one. Numeric YA depths 1–4 cannot raise that cap, and
   * this never writes `~/.grok/config.toml`.
   */
  private getSubagentDepthEnvironment(): Record<string, string> {
    if (process.env.GROK_SUBAGENTS !== undefined) {
      return {};
    }
    return this.getConfiguredSubagentMaxDepth() === 0
      ? { GROK_SUBAGENTS: "0" }
      : {};
  }

  /**
   * Check if the Grok Build CLI is installed (prefers ~/.grok/bin/grok per local install layout).
   */
  async isInstalled(): Promise<boolean> {
    const path = await this.findGrokPath();
    return path !== null;
  }

  /**
   * Check if Grok is authenticated.
   */
  async isAuthenticated(): Promise<boolean> {
    const authStatus = await this.getAuthStatus();
    return authStatus.authenticated;
  }

  /** Get detailed authentication status using GROK_HOME/auth.json. */
  async getAuthStatus(): Promise<AuthStatus> {
    const installed = await this.isInstalled();
    if (!installed) {
      return {
        installed: false,
        authenticated: false,
        enabled: false,
      };
    }

    const authPath = join(this.getGrokHome(), "auth.json");
    if (!existsSync(authPath)) {
      return {
        installed: true,
        authenticated: false,
        enabled: false,
      };
    }

    try {
      const rawAuth: unknown = JSON.parse(readFileSync(authPath, "utf-8"));
      const profile = this.findAuthenticatedProfile(rawAuth);
      if (!profile) {
        return {
          installed: true,
          authenticated: false,
          enabled: false,
        };
      }

      const expiresAt = this.parseAuthExpiry(profile);
      const hasRefreshToken = this.hasStringCredential(profile, [
        "refresh_token",
      ]);
      const expiredWithoutRefresh =
        expiresAt !== undefined &&
        expiresAt.getTime() <= Date.now() &&
        !hasRefreshToken;
      const authenticated = !expiredWithoutRefresh;

      return {
        installed: true,
        authenticated,
        enabled: authenticated,
        expiresAt,
        user: this.extractAuthUser(profile),
      };
    } catch {
      return {
        installed: true,
        authenticated: false,
        enabled: false,
      };
    }
  }

  getModelCatalogStatus(): ModelCatalogStatus | undefined {
    return this.modelCatalogStatus;
  }

  /**
   * Get the Grok CLI's visible model catalog with local cache metadata.
   * A discovered catalog is kept until `forceRefresh`; the built-in fallback
   * is never cached, so the next read retries discovery.
   */
  async getAvailableModels(options?: {
    forceRefresh?: boolean;
  }): Promise<ModelInfo[]> {
    if (this.modelCache && options?.forceRefresh !== true) {
      return this.modelCache.map((model) => ({ ...model }));
    }

    let rawCache: unknown;
    try {
      rawCache = JSON.parse(
        readFileSync(join(this.getGrokHome(), "models_cache.json"), "utf-8"),
      );
    } catch {
      rawCache = undefined;
    }

    let modelsOutput: string | undefined;
    let listingError = "Grok CLI is not installed";
    const grokPath = await this.findGrokPath();
    if (grokPath) {
      try {
        const { stdout } = await execFileAsync(grokPath, ["models"], {
          encoding: "utf-8",
          env: this.getSubscriptionEnvironment(),
          timeout: 10_000,
        });
        modelsOutput = String(stdout);
      } catch (error) {
        listingError = modelCatalogError(error);
        this.log.debug(
          { error },
          "Failed to query Grok model listing; using local cache",
        );
      }
    }

    const discovered = normalizeGrokModels(rawCache, modelsOutput);
    if (discovered.length === 0) {
      this.modelCatalogStatus = fallbackModelCatalog(listingError);
      return LEGACY_GROK_MODELS.map((model) => ({ ...model }));
    }
    this.modelCache = discovered;
    // Grok's own models_cache.json still counts as live when only the
    // listing command failed; the error records which read was missing.
    this.modelCatalogStatus = liveModelCatalog(
      modelsOutput === undefined ? listingError : undefined,
    );
    return this.modelCache.map((model) => ({ ...model }));
  }

  /**
   * Start a new Grok ACP session.
   */
  async getNewSessionNamespace(cwd: string) {
    return {
      family: "grok" as const,
      storageScope: await nativeStorageScope(
        resolve(
          await realpath(cwd),
          join(process.env.GROK_HOME || join(homedir(), ".grok"), "sessions"),
        ),
      ),
    };
  }

  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const source = options.nativeResumeSource;
    if (source) {
      if (
        !options.resumeSessionId ||
        !source.filePath ||
        options.executor ||
        options.sessionSandbox
      )
        throw new Error(
          "Grok scoped continuation requires its local native source",
        );
      assertProviderForkSource(
        {
          nativeSessionId: parseNativeSessionId(options.resumeSessionId),
          nativeSource: source,
        },
        this.name,
      );
      const home = process.env.GROK_HOME || join(homedir(), ".grok");
      if (!isAbsolute(home))
        throw new Error(
          "Grok scoped continuation requires an absolute native home",
        );
      const scope = await realpath(join(home, "sessions"));
      const path = relative(scope, await realpath(source.filePath));
      if (
        scope !== source.native.storageScope ||
        !path ||
        path === ".." ||
        path.startsWith(".." + sep) ||
        isAbsolute(path)
      )
        throw new Error(
          "Grok continuation is outside the launch session store",
        );
      if (
        (await realpath(fromUrlProjectId(source.projectId))) !==
        (await realpath(options.cwd))
      )
        throw new Error(
          "Grok continuation cannot change its native working project",
        );
    }
    const queue = new MessageQueue();
    const abortController = new AbortController();

    if (options.initialMessage) {
      queue.push(options.initialMessage);
    }

    const client = this.createClient();
    const commandInventory: GrokCommandInventory = { commands: [] };
    const runtime: GrokPromptRuntime = {
      activePromptCount: 0,
      promptError: null,
    };
    const agentctlSessionEnvBridge = createAgentctlSessionEnvBridge(
      options.publicSessionId ?? options.resumeSessionId,
      options.getSessionChildEnv,
    );
    const iterator = this.runSession(
      client,
      options,
      queue,
      abortController.signal,
      runtime,
      commandInventory,
      agentctlSessionEnvBridge,
    );

    return {
      iterator,
      queue,
      abort: () => {
        abortController.abort();
        const closed = client.close();
        agentctlSessionEnvBridge.cleanup();
        return closed;
      },
      get pid() {
        return client.pid;
      },
      isProcessAlive: () => client.isProcessAlive,
      publishAgentctlSessionId: (sessionId, browserDebugEnvironment) => {
        agentctlSessionEnvBridge.publishSessionId(
          sessionId,
          browserDebugEnvironment,
        );
      },
      steer: async (message) =>
        this.steerWithInterject(client, runtime, message),
      supportedCommands: async () => [...commandInventory.commands],
    };
  }

  /**
   * Main session loop using ACP protocol over `grok agent stdio`.
   */
  private async *runSession(
    client: ACPClient,
    options: StartSessionOptions,
    queue: MessageQueue,
    signal: AbortSignal,
    runtime: GrokPromptRuntime,
    commandInventory: GrokCommandInventory,
    agentctlSessionEnvBridge: AgentctlSessionEnvBridge,
  ): AsyncIterableIterator<SDKMessage> {
    if (signal.aborted) return;
    const grokPath = await this.findGrokPath();
    if (!grokPath) {
      agentctlSessionEnvBridge.cleanup();
      yield {
        type: "error",
        error:
          "Grok Build CLI not found. Ensure GROK_HOME/bin/grok (default ~/.grok/bin/grok) exists or grok is in PATH.",
      } as SDKMessage;
      return;
    }

    // Grok 1.0.4: agent options go after `agent` and before the transport
    // (`grok agent --effort … -m … --no-leader stdio`). `--no-leader` keeps
    // this YA process off a shared TUI/leader backend so session updates are
    // not buffered behind another client.
    const args: string[] = ["agent"];
    if (options.effort) {
      args.push("--effort", options.effort);
    }
    const defaultModel = (await this.getAvailableModels()).find(
      (model) => model.isDefault,
    )?.id;
    if (
      options.model &&
      options.model !== "default" &&
      options.model !== defaultModel
    ) {
      args.push("-m", options.model);
    }
    args.push("--no-leader", "stdio");

    // ACP permission routing stays preferred over `--always-approve` / `--yolo`.

    const updateQueue: SessionNotification[] = [];

    client.setSessionUpdateCallback((update) => {
      this.updateCommandInventory(update, commandInventory);
      updateQueue.push(update);
    });

    this.log.debug(
      { hasOnToolApproval: !!options.onToolApproval },
      "Setting up Grok ACP permission handler (Phase 1)",
    );
    client.setPermissionRequestCallback(async (request) => {
      this.log.debug({ request }, "Grok permission callback invoked");
      return this.handlePermissionRequest(request, options, signal);
    });
    client.setExtensionMethodCallback((method, params) =>
      this.handleExtensionMethod(method, params, options, signal),
    );

    const input = queue[Symbol.asyncIterator]();
    const stopInput = () => {
      void input.return();
    };
    signal.addEventListener("abort", stopInput);
    void client.closed?.then(stopInput);
    if (signal.aborted) stopInput();
    try {
      const connectStart = Date.now();
      const xaiApiKey = this.ambientXaiApiKey;
      const passXaiApiKey = this.useAmbientXaiApiKey && xaiApiKey !== undefined;
      const extraEnv: Record<string, string> = {
        ...this.getSubagentDepthEnvironment(),
        ...(passXaiApiKey && xaiApiKey !== undefined
          ? { XAI_API_KEY: xaiApiKey }
          : {}),
      };
      copyAgentctlBashEnvInto(extraEnv, agentctlSessionEnvBridge, {
        sessionId: options.publicSessionId ?? options.resumeSessionId,
      });
      await client.connect({
        command: grokPath,
        args,
        cwd: options.cwd,
        env: extraEnv,
        excludeEnv: passXaiApiKey
          ? GROK_BILLING_ENV_DENYLIST.filter((key) => key !== "XAI_API_KEY")
          : GROK_BILLING_ENV_DENYLIST,
      });
      this.log.info(
        { durationMs: Date.now() - connectStart, args },
        "Grok ACP connected (agent stdio mode)",
      );

      const initStart = Date.now();
      await client.initialize({});
      this.log.debug(
        { durationMs: Date.now() - initStart },
        "Grok ACP initialized",
      );

      // Continue or create. Grok implements the stable `session/load`
      // (`agentCapabilities.loadSession: true` on 0.2.118) and has no
      // `session/resume` at all — the unstable method YA used answers
      // "Method not found", which is why an interrupted session could not be
      // picked back up. `_meta.noReplay` keeps Grok from re-emitting the whole
      // history as fresh notifications; GrokSessionReader already owns the
      // durable transcript, so a replay would only duplicate it.
      let sessionId: string;
      if (options.resumeSessionId) {
        try {
          await client.loadSession(options.resumeSessionId, options.cwd, {
            noReplay: true,
          });
          // The loaded session keeps its native id; never substitute a new one.
          sessionId = options.resumeSessionId;
          this.log.debug({ sessionId }, "Grok ACP session loaded");
        } catch (loadErr) {
          this.log.error(
            { err: loadErr, resumeSessionId: options.resumeSessionId },
            "Failed to load Grok ACP session",
          );
          const detail = acpErrorMessage(loadErr);
          throw new Error(
            `Failed to load Grok session ${options.resumeSessionId}: ${detail}`,
          );
        }
      } else {
        sessionId = await client.newSession(options.cwd);
        this.log.debug({ sessionId }, "Grok ACP session created");
      }
      runtime.sessionId = sessionId;
      agentctlSessionEnvBridge.publishSessionId(
        options.publicSessionId ?? sessionId,
      );

      // Emit init
      yield {
        type: "system",
        subtype: "init",
        session_id: sessionId,
        cwd: options.cwd,
        slash_commands: commandInventory.commands.map(
          (command) => command.name,
        ),
        slash_command_inventory: commandInventory.commands,
      } as SDKMessage;

      // Process messages from the queue (identical pattern to gemini-acp)
      const messageGen = input;
      let isFirstNewMessage = true;
      for await (const message of messageGen) {
        if (signal.aborted) break;

        let userText = this.extractTextFromMessage(message);
        userText = canonicalizeSkillInvocations(
          userText,
          commandInventory.commands,
        ).text;

        if (isFirstNewMessage && options.globalInstructions) {
          userText = `[Global context]\n${options.globalInstructions}\n\n---\n\n${userText}`;
        }
        isFirstNewMessage = false;

        const userUuid = (message as { uuid?: string }).uuid ?? randomUUID();
        yield {
          type: "user",
          uuid: userUuid,
          session_id: sessionId,
          message: {
            role: "user",
            content: userText,
          },
        } as SDKMessage;

        updateQueue.length = 0;

        const promptStart = Date.now();
        this.log.debug(
          { textLength: userText.length },
          "Sending prompt to Grok",
        );
        runtime.promptError = null;
        const promptPromise = this.promptWithTracking(
          client,
          sessionId,
          userText,
          runtime,
          { recordError: true, signal },
        );
        void promptPromise.catch(() => undefined);

        for await (const msg of this.yieldUpdates(
          updateQueue,
          sessionId,
          signal,
          runtime,
          commandInventory,
        )) {
          yield msg;
        }
        await promptPromise;
        if (!signal.aborted)
          options.onNativeInputConsumed?.(sessionId, userUuid);
        this.log.debug(
          { durationMs: Date.now() - promptStart },
          "Grok prompt complete",
        );

        yield {
          type: "result",
          session_id: sessionId,
        } as SDKMessage;
      }
    } catch (err) {
      if (isRequestedACPClosure(err, signal)) return;
      this.log.error({ err }, "Grok ACP session error");
      yield {
        type: "error",
        error: acpErrorMessage(err),
      } as SDKMessage;
    } finally {
      signal.removeEventListener("abort", stopInput);
      await input.return();
      runtime.sessionId = undefined;
      runtime.activePromptCount = 0;
      await client.close();
      agentctlSessionEnvBridge.cleanup();
    }
  }

  private updateCommandInventory(
    notification: SessionNotification,
    inventory: GrokCommandInventory,
  ): void {
    const update = notification.update;
    if (update.sessionUpdate !== "available_commands_update") {
      return;
    }
    inventory.commands = this.grokSlashCommands(update.availableCommands);
  }

  private grokSlashCommands(value: unknown): SlashCommand[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const commands: SlashCommand[] = [];
    const seen = new Set<string>();
    for (const item of value) {
      const command = this.grokSlashCommand(item);
      if (!command || seen.has(command.name)) {
        continue;
      }
      seen.add(command.name);
      commands.push(command);
    }
    return commands;
  }

  private grokSlashCommand(value: unknown): SlashCommand | null {
    const command = this.asRecord(value);
    const rawName = this.stringField(command, "name");
    const name = rawName?.trim().replace(/^\/+/, "");
    if (!name) {
      return null;
    }

    const input = this.asRecord(command?.input);
    const argumentHint = this.stringField(input, "hint");
    const providerDetails = this.grokSlashCommandProviderDetails(
      this.asRecord(command?._meta),
    );
    return {
      name,
      description: this.stringField(command, "description") ?? "",
      ...(argumentHint ? { argumentHint } : {}),
      providerDetails,
      invocation: {
        kind: providerDetails.grok?.source === "skill" ? "skill" : "native",
        prefix: "/",
        ...(providerDetails.grok?.source === "skill"
          ? { inventoryState: "current" as const }
          : {}),
      },
    };
  }

  private grokSlashCommandProviderDetails(
    meta: Record<string, unknown> | undefined,
  ): NonNullable<SlashCommand["providerDetails"]> {
    const scope = this.stringField(meta, "scope");
    const path = this.stringField(meta, "path");
    return {
      grok:
        scope || path
          ? {
              source: "skill",
              ...(scope ? { scope } : {}),
              ...(path ? { path } : {}),
            }
          : { source: "builtin" },
    };
  }

  /**
   * Handle the two blocking xAI extension requests that correspond to YA's
   * existing pending-input surfaces. Unknown methods remain protocol errors
   * rather than receiving a success-shaped empty response.
   */
  private async handleExtensionMethod(
    method: string,
    params: Record<string, unknown>,
    options: StartSessionOptions,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    switch (method) {
      case "x.ai/ask_user_question":
        return this.handleAskUserQuestion(params, options, signal);
      case "x.ai/exit_plan_mode":
        return this.handleExitPlanMode(params, options, signal);
      default:
        throw new Error(`Unsupported Grok ACP extension method: ${method}`);
    }
  }

  private async handleAskUserQuestion(
    params: Record<string, unknown>,
    options: StartSessionOptions,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const questions = this.grokQuestions(params.questions);
    if (signal.aborted || !options.onToolApproval || questions.length === 0) {
      return { outcome: "cancelled" };
    }

    try {
      const result = await options.onToolApproval(
        "AskUserQuestion",
        { questions },
        { signal },
      );
      if (result.behavior !== "allow") {
        return { outcome: "cancelled" };
      }
      return this.grokQuestionResponse(questions, result.updatedInput);
    } catch (error) {
      this.log.warn(
        { error },
        "Grok AskUserQuestion handling failed; cancelling request",
      );
      return { outcome: "cancelled" };
    }
  }

  private grokQuestions(value: unknown): Array<{
    question: string;
    header: string;
    options: Array<{
      label: string;
      description: string;
      preview?: string;
    }>;
    multiSelect: boolean;
  }> {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item, index) => {
      const question = asRecordValue(item);
      const text = nonemptyString(question?.question);
      if (!text) return [];
      const options = Array.isArray(question?.options)
        ? question.options.flatMap((item) => {
            const option = asRecordValue(item);
            const label = nonemptyString(option?.label);
            if (!label) return [];
            const preview = nonemptyString(option?.preview);
            return [
              {
                label,
                description: nonemptyString(option?.description) ?? "",
                ...(preview ? { preview } : {}),
              },
            ];
          })
        : [];
      return [
        {
          question: text,
          header: nonemptyString(question?.header) ?? `Question ${index + 1}`,
          options,
          multiSelect:
            question?.multiSelect === true || question?.multi_select === true,
        },
      ];
    });
  }

  private grokQuestionResponse(
    questions: ReturnType<GrokACPProvider["grokQuestions"]>,
    updatedInput: unknown,
  ): Record<string, unknown> {
    const answers = asRecordValue(asRecordValue(updatedInput)?.answers);
    const accepted: Record<string, string[]> = {};
    const annotations: Record<string, { notes?: string; preview?: string }> =
      {};

    for (const question of questions) {
      const rawAnswer = answers?.[question.question];
      const values = (
        Array.isArray(rawAnswer) ? rawAnswer : [rawAnswer]
      ).filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      );
      if (values.length === 0) continue;

      const optionLabels = new Set(
        question.options.map((option) => option.label),
      );
      const selected = values.filter((value) => optionLabels.has(value));
      const notes = values
        .filter((value) => !optionLabels.has(value))
        .map((value) => value.trim());
      if (selected.length === 0 && notes.length > 0) {
        selected.push("Other");
      }
      if (selected.length > 0) {
        accepted[question.question] = selected;
      }

      const preview =
        question.multiSelect || selected.length !== 1
          ? undefined
          : question.options.find((option) => option.label === selected[0])
              ?.preview;
      if (notes.length > 0 || preview) {
        annotations[question.question] = {
          ...(preview ? { preview } : {}),
          ...(notes.length > 0 ? { notes: notes.join("\n") } : {}),
        };
      }
    }

    return {
      outcome: "accepted",
      answers: accepted,
      ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
    };
  }

  private async handleExitPlanMode(
    params: Record<string, unknown>,
    options: StartSessionOptions,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (signal.aborted || !options.onToolApproval) {
      return { outcome: "cancelled" };
    }

    try {
      const result = await options.onToolApproval(
        "ExitPlanMode",
        { plan: nonemptyString(params.planContent) ?? "" },
        { signal },
      );
      if (result.behavior === "allow") {
        return { outcome: "approved" };
      }
      const feedback = result.message?.trim();
      return {
        outcome: "cancelled",
        ...(feedback && feedback !== "User denied permission"
          ? { feedback }
          : {}),
      };
    } catch (error) {
      this.log.warn(
        { error },
        "Grok ExitPlanMode handling failed; cancelling request",
      );
      return { outcome: "cancelled" };
    }
  }

  /**
   * Handle ACP permission request (identical structure + Grok logging to gemini-acp.ts:453).
   */
  private async handlePermissionRequest(
    request: RequestPermissionRequest,
    options: StartSessionOptions,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    const { onToolApproval, permissionMode } = options;
    const toolCall = request.toolCall;
    const kind = toolCall.kind ?? "other";

    if (this.shouldAutoApprove(kind, permissionMode)) {
      this.log.debug(
        { kind, permissionMode },
        "Auto-approving Grok ACP permission request",
      );
      const allowOnceOption = request.options.find(
        (o) => o.kind === "allow_once",
      );
      return {
        outcome: {
          outcome: "selected",
          optionId: allowOnceOption?.optionId ?? "proceed_once",
        },
      };
    }

    if (!onToolApproval) {
      this.log.warn(
        { kind, permissionMode },
        "No Grok approval callback available; cancelling permission request",
      );
      return { outcome: { outcome: "cancelled" } };
    }

    const toolName = this.mapKindToToolName(kind, toolCall.title ?? undefined);

    const toolInput = {
      kind,
      title: toolCall.title,
      locations: toolCall.locations,
      content: toolCall.content,
      rawInput: toolCall.rawInput,
    };

    this.log.debug(
      { toolName, toolInput },
      "Requesting user approval for Grok ACP permission",
    );

    const result = await onToolApproval(toolName, toolInput, { signal });

    return this.convertApprovalResultToACPResponse(result, request);
  }

  private shouldAutoApprove(
    kind: ToolKind | null | undefined,
    permissionMode?: PermissionMode,
  ): boolean {
    switch (permissionMode) {
      case "bypassPermissions":
        return true;
      case "acceptEdits":
        return kind === "edit" || kind === "read" || kind === "search";
      case "plan":
        return kind === "read" || kind === "search" || kind === "fetch";
      default:
        return false;
    }
  }

  private mapKindToToolName(
    kind: ToolKind | null | undefined,
    title?: string,
  ): string {
    switch (kind) {
      case "edit":
        return "Write";
      case "delete":
        return "Delete";
      case "move":
        return "Move";
      case "execute":
        return "Bash";
      case "read":
        return "Read";
      case "search":
        return "Search";
      case "fetch":
        return "WebFetch";
      case "think":
        return "Think";
      case "switch_mode":
        return "SwitchMode";
      default:
        return title ?? "GrokTool";
    }
  }

  private convertApprovalResultToACPResponse(
    result: ToolApprovalResult,
    request: RequestPermissionRequest,
  ): RequestPermissionResponse {
    if (result.behavior === "allow") {
      const allowOnceOption = request.options.find(
        (o) => o.kind === "allow_once",
      );
      const allowAlwaysOption = request.options.find(
        (o) => o.kind === "allow_always",
      );
      const selectedOption = allowOnceOption ?? allowAlwaysOption;

      if (selectedOption) {
        return {
          outcome: {
            outcome: "selected",
            optionId: selectedOption.optionId,
          },
        };
      }
      return {
        outcome: {
          outcome: "selected",
          optionId: "proceed_once",
        },
      };
    }
    return { outcome: { outcome: "cancelled" } };
  }

  /**
   * Async generator to yield session updates as SDKMessages (adapted for Grok events).
   */
  private async *yieldUpdates(
    updateQueue: SessionNotification[],
    sessionId: string,
    signal: AbortSignal,
    runtime: GrokPromptRuntime,
    commandInventory: GrokCommandInventory,
  ): AsyncIterableIterator<SDKMessage> {
    let assistantTextBuffer = "";
    let assistantMessageId: string | null = null;
    const toolStates = new Map<string, GrokLiveToolState>();

    // Accumulate agent_thought_chunk deltas so we emit growing (not per-token) thinking blocks.
    // Prevents the "Thinking ▸ word Thinking ▸ user ..." cascade seen in live testing.
    let thinkingBuffer = "";
    let thinkingMessageId: string | null = null;

    const buildThinkingMessage = (): SDKMessage =>
      ({
        type: "assistant",
        uuid: thinkingMessageId ?? undefined,
        session_id: sessionId,
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: thinkingBuffer,
            },
          ],
        },
      }) as SDKMessage;

    const buildTextMessage = (): SDKMessage =>
      ({
        type: "assistant",
        uuid: assistantMessageId ?? undefined,
        session_id: sessionId,
        message: {
          role: "assistant",
          content: assistantTextBuffer,
        },
      }) as SDKMessage;

    while (
      !signal.aborted &&
      (runtime.activePromptCount > 0 || updateQueue.length > 0)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));

      while (updateQueue.length > 0) {
        const notification = updateQueue.shift();
        if (!notification) break;

        const sessionUpdate = notification.update;
        const eventUuid = grokEventUuid(notification._meta);

        // Handle both text and thought chunks by accumulating (Grok streams thoughts
        // as many small agent_thought_chunk events, just like message chunks).
        if (
          (sessionUpdate.sessionUpdate === "agent_message_chunk" ||
            sessionUpdate.sessionUpdate === "agent_thought_chunk") &&
          "content" in sessionUpdate
        ) {
          const content = sessionUpdate.content;
          if (
            content &&
            typeof content === "object" &&
            "type" in content &&
            content.type === "text" &&
            "text" in content
          ) {
            // A chunk of the other kind ends the run being buffered. The durable
            // reader groups chunks the same way, so both sides produce the same
            // messages keyed on the same first-chunk event id; buffering the two
            // kinds concurrently would let the two sides disagree on where a
            // message starts and reintroduce duplicate rows.
            if (sessionUpdate.sessionUpdate === "agent_thought_chunk") {
              if (assistantTextBuffer) {
                yield buildTextMessage();
                assistantTextBuffer = "";
                assistantMessageId = null;
              }
              thinkingBuffer += content.text;
              thinkingMessageId ??= eventUuid ?? randomUUID();
              continue; // keep accumulating; flush later with other content or on done
            }
            if (thinkingBuffer) {
              yield buildThinkingMessage();
              thinkingBuffer = "";
              thinkingMessageId = null;
            }
            assistantTextBuffer += content.text;
            assistantMessageId ??= eventUuid ?? randomUUID();
            continue;
          }
        }

        // Flush any pending thinking buffer before yielding non-thought content
        // (e.g. tool calls, final text). This produces one (or few) growing thinking blocks
        // instead of dozens of tiny ones.
        if (thinkingBuffer) {
          yield buildThinkingMessage();
          thinkingBuffer = "";
          thinkingMessageId = null;
        }

        if (assistantTextBuffer) {
          yield buildTextMessage();
          assistantTextBuffer = "";
          assistantMessageId = null;
        }

        const sdkMessage = this.convertUpdateToSDKMessage(
          sessionUpdate,
          sessionId,
          toolStates,
          commandInventory,
          eventUuid,
        );
        if (sdkMessage) {
          yield sdkMessage;
        }
      }
    }

    // Final flush: thinking first (so reasoning appears before any trailing text), then text.
    // Only one of the two can be pending, since a kind switch flushes the other.
    if (thinkingBuffer) {
      yield buildThinkingMessage();
    }
    if (assistantTextBuffer) {
      yield buildTextMessage();
    }

    if (runtime.promptError) {
      throw runtime.promptError;
    }
  }

  private async steerWithInterject(
    client: ACPClient,
    runtime: GrokPromptRuntime,
    message: unknown,
  ): Promise<boolean> {
    const sessionId = runtime.sessionId;
    if (!sessionId || runtime.activePromptCount <= 0) {
      return false;
    }

    const text = this.extractTextFromMessage(message).trim();
    if (!text) {
      return true;
    }

    try {
      const result = await client.extMethod("x.ai/interject", {
        sessionId,
        text,
      });
      return grokInterjectAccepted(result);
    } catch (error) {
      this.log.warn({ error, sessionId }, "Grok x.ai/interject failed");
      return false;
    }
  }

  private async promptWithTracking(
    client: ACPClient,
    sessionId: string,
    text: string,
    runtime: GrokPromptRuntime,
    options: { recordError?: boolean; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    runtime.activePromptCount++;
    try {
      return await client.prompt(sessionId, text);
    } catch (err) {
      if (
        options.recordError &&
        !(options.signal && isRequestedACPClosure(err, options.signal))
      ) {
        runtime.promptError = err;
        this.log.error({ err }, "Grok prompt error");
      }
      throw err;
    } finally {
      runtime.activePromptCount--;
    }
  }

  /**
   * Convert ACP SessionUpdate to SDKMessage (Phase 1 normalization for Grok events).
   * Handles: agent_thought_chunk (thinking), agent_message_chunk, tool_call/tool_call_update,
   * plan. Based on gemini-acp.ts:706 + Grok 15-agent-mode.md table.
   */
  private convertUpdateToSDKMessage(
    update: SessionUpdate,
    sessionId: string,
    toolStates: Map<string, GrokLiveToolState>,
    commandInventory: GrokCommandInventory,
    eventUuid?: string,
  ): SDKMessage | null {
    const updateType = update.sessionUpdate;

    switch (updateType) {
      case "agent_message_chunk": {
        // Streaming text chunks are primarily buffered + emitted from yieldUpdates.
        // This path is a fallback for non-buffered cases.
        if ("content" in update) {
          const contentBlock = update.content;
          if (
            contentBlock &&
            typeof contentBlock === "object" &&
            "type" in contentBlock &&
            contentBlock.type === "text" &&
            "text" in contentBlock
          ) {
            return {
              type: "assistant",
              uuid: eventUuid,
              session_id: sessionId,
              message: {
                role: "assistant",
                content: contentBlock.text as string,
              },
            } as SDKMessage;
          }
        }
        return null;
      }
      case "agent_thought_chunk": {
        // Streaming thoughts are accumulated in yieldUpdates (thinkingBuffer) to avoid
        // emitting a brand-new tiny thinking block per token/chunk (the root cause of the
        // repeated "Thinking ▸ <word>" symptom). We return null here so the buffered
        // growing block is the only one the client sees.
        return null;
      }

      case "tool_call": {
        const toolUpdate = update as ToolCall & { sessionUpdate: "tool_call" };
        return this.buildToolUseMessage(toolUpdate, sessionId, toolStates);
      }

      case "tool_call_update": {
        const toolResultUpdate = update as ToolCallUpdate & {
          sessionUpdate: "tool_call_update";
          error?: string;
        };
        if (isTerminalGrokToolUpdate(toolResultUpdate)) {
          const toolCallId = toolResultUpdate.toolCallId ?? "";
          const previous = toolStates.get(toolCallId);
          const normalized = normalizeGrokToolUpdate(
            toolResultUpdate,
            previous,
          );
          const state: GrokLiveToolState = {
            ...normalized,
            resultEmitted: previous?.resultEmitted ?? false,
          };
          toolStates.set(toolCallId, state);
          if (state.resultEmitted) return null;
          state.resultEmitted = true;

          const message = {
            type: "user",
            uuid: toolCallId ? `${toolCallId}:result` : undefined,
            session_id: sessionId,
            toolUseResult: buildGrokStructuredToolResult(
              toolResultUpdate,
              state,
            ),
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolCallId,
                  is_error:
                    toolResultUpdate.status === "failed" ||
                    !!toolResultUpdate.error,
                  content: formatGrokToolResultContent(toolResultUpdate, state),
                },
              ],
            },
          } as SDKMessage;
          const mediaCandidate = grokToolResultMediaCandidate(toolResultUpdate);
          if (mediaCandidate) {
            attachToolResultMediaCandidates(message, [mediaCandidate]);
          }
          return message;
        }
        if (hasGrokToolUseMetadata(toolResultUpdate)) {
          return this.buildToolUseMessage(
            toolResultUpdate,
            sessionId,
            toolStates,
          );
        }
        return null;
      }

      case "plan": {
        const entries = update.entries ?? [];
        if (entries.length > 0) {
          return {
            type: "assistant",
            uuid: eventUuid,
            session_id: sessionId,
            message: {
              role: "assistant",
              content: [
                {
                  type: "thinking",
                  thinking: entries
                    .map((entry) => `${entry.status}: ${entry.content}`)
                    .join("\n"),
                },
              ],
            },
          } as SDKMessage;
        }
        return null;
      }

      case "available_commands_update":
        return {
          type: "system",
          subtype: "commands_changed",
          session_id: sessionId,
          slash_commands: commandInventory.commands.map(
            (command) => command.name,
          ),
          slash_command_inventory: commandInventory.commands,
        } as SDKMessage;

      default:
        this.log.trace(
          { updateType, update },
          "Unhandled Grok ACP update type (Phase 1 placeholder - extend in later phase)",
        );
        return null;
    }
  }

  /**
   * Extract text content from a user message (identical to gemini-acp.ts:822).
   */
  private extractTextFromMessage(message: unknown): string {
    if (!message || typeof message !== "object") {
      return "";
    }

    const userMsg = message as { text?: string };
    if (typeof userMsg.text === "string") {
      return userMsg.text;
    }

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

  /**
   * Resolve Grok's state directory. The released CLI documents GROK_HOME as
   * the override for binaries, auth, cache, docs, and sessions.
   */
  private getGrokHome(): string {
    return nonemptyString(process.env.GROK_HOME) ?? join(homedir(), ".grok");
  }

  private getSubscriptionEnvironment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of GROK_BILLING_ENV_DENYLIST) {
      delete env[key];
    }
    return env;
  }

  /**
   * Find the Grok CLI path (strongly prefers GROK_HOME/bin/grok).
   */
  private async findGrokPath(): Promise<string | null> {
    if (this.grokPath) {
      return this.pathExists(this.grokPath) ? this.grokPath : null;
    }

    const home = homedir();
    const preferred = join(this.getGrokHome(), "bin", "grok");
    if (this.pathExists(preferred)) {
      return preferred;
    }

    const commonPaths = [
      join(home, ".local", "bin", "grok"),
      "/usr/local/bin/grok",
      join(home, "bin", "grok"),
      join(home, ".grok", "grok"),
    ];

    for (const path of commonPaths) {
      if (this.pathExists(path)) {
        return path;
      }
    }

    try {
      const { stdout } = await execAsync(whichCommand("grok"), {
        encoding: "utf-8",
      });
      const result = selectCommandLookupTarget(
        stdout,
        "direct",
        process.platform,
        (path) => this.pathExists(path),
      );
      if (result) return result;
    } catch {
      // Not in PATH
    }

    return null;
  }

  private findAuthenticatedProfile(rawAuth: unknown): GrokAuthProfile | null {
    const profiles = this.collectAuthProfiles(rawAuth);
    return (
      profiles.find((profile) =>
        this.hasStringCredential(profile, [
          "access_token",
          "refresh_token",
          "session",
          "key",
          "api_key",
        ]),
      ) ?? null
    );
  }

  private collectAuthProfiles(rawAuth: unknown): GrokAuthProfile[] {
    if (!rawAuth || typeof rawAuth !== "object" || Array.isArray(rawAuth)) {
      return [];
    }

    const root = rawAuth as GrokAuthProfile;
    const profiles = [root];
    for (const value of Object.values(root)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        profiles.push(value as GrokAuthProfile);
      }
    }
    return profiles;
  }

  private hasStringCredential(
    profile: GrokAuthProfile,
    fields: string[],
  ): boolean {
    return fields.some((field) => {
      const value = profile[field];
      return typeof value === "string" && value.trim().length > 0;
    });
  }

  private parseAuthExpiry(profile: GrokAuthProfile): Date | undefined {
    const expiresAt = profile.expires_at;
    if (typeof expiresAt === "string") {
      const parsed = new Date(expiresAt);
      return Number.isNaN(parsed.getTime()) ? undefined : parsed;
    }

    const expiryDate = profile.expiry_date;
    if (typeof expiryDate === "number") {
      const parsed = new Date(expiryDate);
      return Number.isNaN(parsed.getTime()) ? undefined : parsed;
    }

    return undefined;
  }

  private extractAuthUser(profile: GrokAuthProfile): AuthStatus["user"] {
    const email = typeof profile.email === "string" ? profile.email : undefined;
    const name =
      typeof profile.name === "string"
        ? profile.name
        : [profile.first_name, profile.last_name]
            .filter(
              (part): part is string =>
                typeof part === "string" && part.length > 0,
            )
            .join(" ") || undefined;

    return email || name ? { email, name } : undefined;
  }

  private buildToolUseMessage(
    toolUpdate: ToolCall | ToolCallUpdate,
    sessionId: string,
    toolStates: Map<string, GrokLiveToolState>,
  ): SDKMessage {
    const toolCallId = toolUpdate.toolCallId ?? randomUUID();
    const previous = toolStates.get(toolCallId);
    const normalized = normalizeGrokToolUpdate(toolUpdate, previous);
    const state: GrokLiveToolState = {
      ...normalized,
      resultEmitted: previous?.resultEmitted ?? false,
    };
    toolStates.set(toolCallId, state);
    return {
      type: "assistant",
      uuid: toolCallId,
      session_id: sessionId,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: toolCallId,
            name: state.name,
            input: state.input,
          },
        ],
      },
    } as SDKMessage;
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private stringField(
    record: Record<string, unknown> | undefined,
    field: string,
  ): string | undefined {
    const value = record?.[field];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }
}

/**
 * Default Grok ACP provider instance.
 */
export const grokACPProvider = new GrokACPProvider();
