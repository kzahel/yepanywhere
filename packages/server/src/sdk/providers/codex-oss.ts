import { nativeStorageScope } from "./native-storage-scope.js";
/**
 * CodexOSS Provider - Local models via Codex CLI with --oss flag.
 *
 * Spawns `codex exec --oss` for local model support (Ollama/LMStudio).
 * Uses the same session format as the SDK-based Codex provider.
 *
 * Multi-turn conversations use `codex exec resume <session_id>` to continue
 * sessions. This requires models with sufficient context window (32K+ recommended)
 * since Codex's system prompt is ~5-6K tokens.
 *
 * See docs/research/codex-local-models.md for background.
 */

import { type ChildProcess, exec, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import {
  DEFAULT_GATEWAY_SERVICE_MODEL_LIMIT,
  advertisedGatewayEffortLevels,
  codexProviderKey,
  gatewayModelEffort,
  gatewayServiceDisplayName,
  nearestGatewayEffortLevel,
  parseGatewayModelId,
  qualifiedGatewayModelId,
  tomlString,
  unionModelCatalogs,
  fromUrlProjectId,
  parseNativeSessionId,
  type EffortLevel,
  type GatewayEndpointEffortProbe,
  type GatewayModelEffort,
  type GatewayService,
  type ModelCatalogRoute,
  type ModelInfo,
} from "@yep-anywhere/shared";
import {
  type CodexToolCallContext,
  normalizeCodexCommandExecutionOutput,
  normalizeCodexToolInvocation,
} from "../../codex/normalization.js";
import { getLogger } from "../../logging/logger.js";
import {
  CODEX_INSTALLATION_FAMILY,
  type ProviderInstallationCoordinator,
  providerInstallationCoordinator,
} from "../../services/ProviderInstallationCoordinator.js";
import { probeServiceEffort } from "../../services/GatewayEffortProbe.js";
import { findCodexCliPath } from "../cli-detection.js";
import { MessageQueue, type QueuedSDKUserMessage } from "../messageQueue.js";
import { readFirstLine } from "../../utils/jsonl.js";
import type { SDKMessage } from "../types.js";
import { stripYaControlPlaneCredentials } from "./env-filter.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  StartSessionOptions,
} from "./types.js";
import {
  assertProviderForkSource,
  inactiveProviderSessionOptionsResult,
} from "./types.js";

const log = getLogger().child({ component: "codex-oss-provider" });

/** Where a chosen model lives: a configured endpoint, or Ollama when absent. */
type CodexModelRoute = ModelCatalogRoute<string | undefined>;
const execAsync = promisify(exec);

/**
 * Configuration for CodexOSS provider.
 */
export interface CodexOSSProviderConfig {
  /** Path to codex binary (auto-detected if not specified) */
  codexPath?: string;
  /** Local provider: "ollama" or "lmstudio" */
  localProvider?: "ollama" | "lmstudio";
  /** Request timeout in ms (default: 300000 = 5 minutes) */
  timeout?: number;
  /** Shared installation owner (injectable for deterministic tests). */
  installationCoordinator?: ProviderInstallationCoordinator;
}

/**
 * Codex CLI JSON event types (from --experimental-json output).
 */
interface CodexThreadStarted {
  type: "thread.started";
  thread_id: string;
}

interface CodexTurnStarted {
  type: "turn.started";
}

interface CodexTurnCompleted {
  type: "turn.completed";
  usage: {
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens?: number;
  };
}

interface CodexTurnFailed {
  type: "turn.failed";
  error: { message: string };
}

interface CodexItemEvent {
  type: "item.started" | "item.updated" | "item.completed";
  item: CodexItem;
}

interface CodexErrorEvent {
  type: "error";
  message: string;
}

type CodexEvent =
  | CodexThreadStarted
  | CodexTurnStarted
  | CodexTurnCompleted
  | CodexTurnFailed
  | CodexItemEvent
  | CodexErrorEvent;

interface CodexAgentMessage {
  id: string;
  type: "agent_message";
  text: string;
}

interface CodexReasoning {
  id: string;
  type: "reasoning";
  text: string;
}

interface CodexCommandExecution {
  id: string;
  type: "command_execution";
  command: string;
  aggregated_output: string;
  exit_code?: number;
  status: "in_progress" | "completed" | "failed";
}

interface CodexFileChange {
  id: string;
  type: "file_change";
  changes: Array<{
    path: string;
    kind: "add" | "delete" | "update";
    diff?: string;
  }>;
  status: "completed" | "failed";
}

interface CodexMcpToolCall {
  id: string;
  type: "mcp_tool_call";
  server: string;
  tool: string;
  arguments: unknown;
  result?: unknown;
  error?: { message: string };
  status: "in_progress" | "completed" | "failed";
}

interface CodexWebSearch {
  id: string;
  type: "web_search";
  query: string;
}

interface CodexTodoList {
  id: string;
  type: "todo_list";
  items: Array<{ text: string; completed: boolean }>;
}

interface CodexErrorItem {
  id: string;
  type: "error";
  message: string;
}

type CodexItem =
  | CodexAgentMessage
  | CodexReasoning
  | CodexCommandExecution
  | CodexFileChange
  | CodexMcpToolCall
  | CodexWebSearch
  | CodexTodoList
  | CodexErrorItem;

/**
 * CodexOSS Provider - spawns Codex CLI with --oss for local models.
 */
export class CodexOSSProvider implements AgentProvider {
  readonly supportsNativeResumeSource = true;
  readonly initializesOnFirstMessage = true;
  readonly name = "codex-oss" as const;
  readonly displayName = "CodexOSS";
  readonly supportsPermissionMode = false;
  /**
   * A configured endpoint's model can carry thinking effort, so the control
   * exists at the provider level and each model decides whether it appears.
   * A model nothing describes — every Ollama one, and any endpoint that states
   * nothing — says `supportsAdaptiveThinking: false` and shows no control,
   * which is what this flag being false used to achieve for all of them.
   */
  readonly supportsThinkingToggle = true;
  readonly supportsSlashCommands = false;
  readonly supportsSteering = false;

  private codexPath?: string;
  private getServices: () => readonly GatewayService[] = () => [];
  private modelRoutes = new Map<string, CodexModelRoute>();
  /**
   * What each service-qualified model offered when its catalog was last read.
   *
   * A launch cannot re-derive this: the per-model and per-endpoint sources live
   * in the catalog response, so resolving from configuration alone at launch
   * time would drop a selected effort for exactly the models whose levels came
   * from the endpoint rather than from the settings form.
   */
  private modelEfforts = new Map<string, GatewayModelEffort>();
  private readonly installationCoordinator: ProviderInstallationCoordinator;
  private readonly localProvider: "ollama" | "lmstudio";
  private readonly timeout: number;

  constructor(config: CodexOSSProviderConfig = {}) {
    this.codexPath = config.codexPath;
    this.installationCoordinator =
      config.installationCoordinator ?? providerInstallationCoordinator;
    this.localProvider = config.localProvider ?? "ollama";
    this.timeout = config.timeout ?? 300000;
  }

  setCodexPath(codexPath: string | undefined): void {
    this.codexPath = codexPath;
  }

  getModelCatalogCacheKey(): string {
    return this.installationCoordinator.getSourceVersion(
      CODEX_INSTALLATION_FAMILY,
    );
  }

  /**
   * Check if Codex CLI is installed.
   */
  async isInstalled(): Promise<boolean> {
    return (await this.findCodexPath()) !== null;
  }

  /**
   * Configured endpoints this provider may launch against.
   *
   * CodexOSS started as "Ollama, through Codex". A host that serves models
   * some other way — vLLM, llama.cpp, anything OpenAI-compatible — is reachable
   * by Codex through a model provider entry, so YA passes one at launch rather
   * than requiring Ollama to exist.
   */
  setGatewayServices(services: readonly GatewayService[]): void {
    this.setGatewayServicesGetter(() => services);
  }

  /**
   * Read the configured endpoints at each use rather than at configuration
   * time, so a settings change reaches the next launch without reconfiguring
   * the provider registry.
   */
  setGatewayServicesGetter(getServices: () => readonly GatewayService[]): void {
    this.getServices = getServices;
  }

  /**
   * The endpoints this provider may launch against, in the configured order.
   *
   * The catalog below follows this order, and so does the model picker. Keep it
   * the settings list's own order: Claude Gateway reaches the same endpoints
   * and shows them the same way, and a hoist here — of the default entry or of
   * anything else — would make one provider's picker disagree with the other's
   * for one set of services.
   */
  private codexServices(): readonly GatewayService[] {
    return this.getServices().filter(
      (service) => service.enabled && service.codexEnabled,
    );
  }

  /**
   * Check that something can serve a model: a configured endpoint, or Ollama.
   */
  async isAuthenticated(): Promise<boolean> {
    if (this.codexServices().length > 0) return true;
    // For OSS mode, we just need Ollama running
    if (this.localProvider === "ollama") {
      try {
        await execAsync("ollama list", { timeout: 5000 });
        return true;
      } catch {
        return false;
      }
    }
    // TODO: LMStudio check
    return false;
  }

  /**
   * Get authentication status.
   */
  async getAuthStatus(): Promise<AuthStatus> {
    const installed = await this.isInstalled();
    if (!installed) {
      return { installed: false, authenticated: false, enabled: false };
    }

    const authenticated = await this.isAuthenticated();
    return {
      installed: true,
      authenticated,
      enabled: authenticated,
    };
  }

  /**
   * Models from every configured endpoint, plus Ollama's when it is in use.
   *
   * `unionModelCatalogs` owns how colliding ids are qualified, so a CodexOSS
   * launch and a Claude Gateway launch name their source the same way.
   */
  async getAvailableModels(): Promise<ModelInfo[]> {
    const services = this.codexServices();
    const perSource = await Promise.all([
      ...services.map(async (service) => ({
        serviceId: service.id,
        models: await this.readServiceModels(service),
      })),
      ...(services.length === 0
        ? [
            {
              serviceId: undefined,
              models: await this.getOllamaModels(),
            },
          ]
        : []),
    ]);

    const read = perSource.filter(
      (
        source,
      ): source is { serviceId: string | undefined; models: ModelInfo[] } =>
        source.models !== undefined,
    );
    const { models, routes } = unionModelCatalogs(read);

    // An endpoint that could not be read this time keeps its last good routes,
    // as it does for Claude Gateway: a slow or restarting server must not send
    // a live session's next turn to the local provider, or leave it counted
    // against no endpoint so auto-stop kills the one it is using. Only a
    // successful read publishes a change.
    const refreshed = new Set(read.map((source) => source.serviceId));
    for (const [exposedId, route] of this.modelRoutes) {
      if (
        route.serviceId !== undefined &&
        !refreshed.has(route.serviceId) &&
        services.some((service) => service.id === route.serviceId) &&
        !routes.has(exposedId)
      ) {
        routes.set(exposedId, route);
      }
    }
    this.modelRoutes = routes;
    return models;
  }

  /**
   * Read one endpoint's OpenAI-compatible catalog, or undefined when it cannot
   * be read now. An empty list is a real answer: the endpoint serves nothing.
   */
  private async readServiceModels(
    service: GatewayService,
  ): Promise<ModelInfo[] | undefined> {
    try {
      const response = await fetch(`${service.url}/v1/models`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return undefined;
      const payload = (await response.json()) as {
        data?: {
          id?: unknown;
          max_model_len?: unknown;
          /** copilot-api states a model's reasoning support here. */
          capabilities?: { supports?: { reasoning_effort?: unknown } };
        }[];
      };
      if (!Array.isArray(payload.data)) return undefined;
      // The same sources Claude Gateway resolves from. A model reached over
      // the Responses API offers the same thinking effort it offers over the
      // Anthropic wire; only "none" differs, and that is expressed below.
      const probed = await probeServiceEffort(service, service.url, payload);
      const limit = service.maxModels ?? DEFAULT_GATEWAY_SERVICE_MODEL_LIMIT;
      const models: ModelInfo[] = [];
      for (const row of payload.data) {
        if (models.length >= limit) break;
        const id = typeof row?.id === "string" ? row.id.trim() : "";
        if (!id) continue;
        const contextWindow =
          service.contextWindowTokens ??
          (typeof row.max_model_len === "number" && row.max_model_len > 0
            ? row.max_model_len
            : undefined);
        const modelProbe = probed.get(id);
        const effort = this.serviceModelEffort(service, id, {
          advertisedLevels: advertisedGatewayEffortLevels(row),
          ...(modelProbe ? { probed: modelProbe } : {}),
        });
        models.push({
          id,
          name: id,
          ...(contextWindow === undefined ? {} : { contextWindow }),
          ...(effort
            ? {
                supportsEffort: true,
                supportedEffortLevels: effort.levels,
                // Codex reaches these endpoints over the Responses API, whose
                // `reasoning.effort` does carry "none", so a model that can
                // stop thinking can say so here — unlike the Anthropic wire
                // Claude Gateway speaks.
                supportedReasoningEfforts: [
                  ...(effort.noThinking ? [{ reasoningEffort: "none" }] : []),
                  ...effort.levels.map((reasoningEffort) => ({
                    reasoningEffort,
                  })),
                ],
                ...(effort.defaultLevel
                  ? {
                      defaultEffortLevel: effort.defaultLevel,
                      defaultReasoningEffort: effort.defaultLevel,
                    }
                  : {}),
                supportsAdaptiveThinking: true,
              }
            : {
                // Nothing describes this model's reasoning, so it offers no
                // thinking control rather than a guessed one. Said explicitly
                // because the client's default for an unstated model is to
                // offer the control.
                supportsEffort: false,
                supportsAdaptiveThinking: false,
              }),
        });
        const effortKey = qualifiedGatewayModelId(service.id, id);
        // Overwritten rather than rebuilt per read, so a launch racing a
        // refresh still finds the previous answer. A model that stopped
        // offering effort is removed, or a narrowed configuration would leave
        // a launch snapping onto levels no longer offered.
        if (effort) this.modelEfforts.set(effortKey, effort);
        else this.modelEfforts.delete(effortKey);
      }
      return models;
    } catch (error) {
      log.debug(
        { error, serviceId: service.id, url: service.url },
        "Failed to read CodexOSS service models",
      );
      return undefined;
    }
  }

  /**
   * Which configured endpoint a launch with this model would use now.
   *
   * Public so that auto-stop can attribute a live CodexOSS process that carries
   * no launch-bound endpoint — `gatewayServiceUsage` asks this the way it asks
   * `ClaudeGatewayProvider.resolveServiceForModel`. Nothing comes back for a
   * model no configured endpoint serves, which is the honest answer: that
   * launch went to the local provider and holds no service open.
   */
  resolveServiceForModel(
    model: string | undefined,
  ): { serviceId: string; modelId: string } | undefined {
    const route = this.resolveModelRoute(model);
    const service = this.serviceById(route.serviceId);
    return service
      ? { serviceId: service.id, modelId: route.modelId }
      : undefined;
  }

  /**
   * The endpoint a launch of this model is bound to for the session's life.
   *
   * Every turn of a CodexOSS session is a separate `codex exec`, so a route
   * looked up per turn would follow whatever the latest catalog read said. It
   * is decided here once instead, reading the catalog first when this process
   * has not seen the model: nothing has read it yet after a server restart,
   * and a provider-host worker never reads it at all.
   */
  async resolveLaunchGatewayRoute(
    model: string | undefined,
  ): Promise<ModelCatalogRoute | null> {
    if (
      model &&
      this.codexServices().length > 0 &&
      !this.modelRoutes.has(model) &&
      !this.qualifiedModelRoute(model)
    ) {
      await this.getAvailableModels();
    }
    return this.resolveServiceForModel(model) ?? null;
  }

  /** Which configured endpoint serves a model, if any. */
  private resolveModelRoute(model: string | undefined): CodexModelRoute {
    if (!model) return { serviceId: undefined, modelId: model ?? "" };
    const known = this.modelRoutes.get(model);
    if (known) return known;
    return (
      this.qualifiedModelRoute(model) ?? {
        serviceId: undefined,
        modelId: model,
      }
    );
  }

  /** A `<serviceId>::<model>` id naming a configured endpoint. */
  private qualifiedModelRoute(model: string): ModelCatalogRoute | null {
    return parseGatewayModelId(model, (serviceId) =>
      this.codexServices().some((service) => service.id === serviceId),
    );
  }

  private serviceById(serviceId: string | undefined) {
    return serviceId
      ? this.codexServices().find((service) => service.id === serviceId)
      : undefined;
  }

  /**
   * What one of a service's models offers by way of thinking effort.
   *
   * `catalog` carries the per-model and per-endpoint sources, which are only
   * available while a catalog is being read. A launch resolving effort for an
   * already-chosen model passes none and gets the configured levels or the
   * built-in family — enough to place the selected level, since a launch never
   * needs to decide which levels to offer.
   */
  private serviceModelEffort(
    service: GatewayService,
    modelId: string,
    catalog: {
      advertisedLevels?: readonly EffortLevel[];
      probed?: GatewayEndpointEffortProbe;
    } = {},
  ): GatewayModelEffort | undefined {
    return gatewayModelEffort({
      modelId,
      ...(service.effortLevels === undefined
        ? {}
        : { configuredLevels: service.effortLevels }),
      ...(service.defaultEffortLevel === undefined
        ? {}
        : { configuredDefaultLevel: service.defaultEffortLevel }),
      ...(catalog.advertisedLevels?.length
        ? { advertisedLevels: catalog.advertisedLevels }
        : {}),
      ...(catalog.probed ? { probed: catalog.probed } : {}),
    });
  }

  /**
   * The config override that carries the selected effort to the endpoint.
   *
   * Codex turns `model_reasoning_effort` into the Responses API's
   * `reasoning.effort`, which an OpenAI-compatible server passes to the model's
   * own chat encoder. Nothing is sent when no effort was selected, so a vanilla
   * turn keeps whatever the endpoint does by default; an unlisted level snaps
   * down to a listed one rather than asking for thinking the model has no
   * distinct behavior for.
   */
  private reasoningEffortArgs(
    options: StartSessionOptions,
    route: CodexModelRoute,
  ): string[] {
    const service = this.serviceById(route.serviceId);
    if (!service) return [];
    const effort =
      this.modelEfforts.get(
        qualifiedGatewayModelId(service.id, route.modelId),
      ) ?? this.serviceModelEffort(service, route.modelId);
    if (!effort) return [];
    if (options.thinking?.type === "disabled") {
      const level = effort.noThinking ? "none" : effort.levels[0];
      return level ? ["-c", `model_reasoning_effort=${tomlString(level)}`] : [];
    }
    if (!options.effort) return [];
    const level = nearestGatewayEffortLevel(effort, options.effort);
    return level ? ["-c", `model_reasoning_effort=${tomlString(level)}`] : [];
  }

  /**
   * Codex config overrides that point a launch at a configured endpoint.
   *
   * These are command-line overrides rather than edits to the user's
   * `~/.codex/config.toml`: YA never rewrites a CLI's own settings files.
   *
   * Each value is a TOML string, so a display name carrying a quote or a
   * backslash reaches Codex as the name the user typed instead of breaking
   * the override.
   */
  private serviceLaunchArgs(service: GatewayService): string[] {
    const key = codexProviderKey(service);
    return [
      "-c",
      `model_providers.${key}.name=${tomlString(gatewayServiceDisplayName(service))}`,
      "-c",
      `model_providers.${key}.base_url=${tomlString(`${service.url}/v1`)}`,
      "-c",
      `model_providers.${key}.wire_api=${tomlString(service.codexWireApi)}`,
      "-c",
      `model_provider=${tomlString(key)}`,
    ];
  }

  private async getOllamaModels(): Promise<ModelInfo[]> {
    if (this.localProvider !== "ollama") {
      return [];
    }

    try {
      const { stdout } = await execAsync("ollama list", { timeout: 5000 });
      const lines = stdout.trim().split("\n");

      if (lines.length < 2) {
        return [];
      }

      const models: ModelInfo[] = [];
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;

        // Parse: NAME ID SIZE MODIFIED
        const parts = line.split(/\s+/);
        if (parts.length >= 3) {
          const name = parts[0] ?? "";
          const sizeNum = Number.parseFloat(parts[2] ?? "0");
          const sizeUnit = parts[3]?.toUpperCase() ?? "";
          let sizeBytes: number | undefined;
          if (sizeUnit === "GB") {
            sizeBytes = Math.round(sizeNum * 1024 * 1024 * 1024);
          } else if (sizeUnit === "MB") {
            sizeBytes = Math.round(sizeNum * 1024 * 1024);
          }

          models.push({
            id: name,
            name: name,
            size: sizeBytes,
            // `ollama list` states a name and a size. Nothing describes the
            // model's reasoning, so it gets no thinking control — the same
            // answer a configured endpoint that describes nothing gets.
            supportsEffort: false,
            supportsAdaptiveThinking: false,
          });
        }
      }

      return models;
    } catch (error) {
      log.debug({ error }, "Failed to get Ollama models");
      return [];
    }
  }

  /**
   * Start a new CodexOSS session.
   */
  async getNewSessionNamespace(cwd: string) {
    return {
      family: "codex" as const,
      storageScope: await nativeStorageScope(
        resolve(
          await realpath(cwd),
          join(
            process.env.CODEX_HOME ||
              join(
                process.platform === "win32" ? userInfo().homedir : homedir(),
                ".codex",
              ),
            "sessions",
          ),
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
          "Codex OSS scoped continuation requires its local native source",
        );
      assertProviderForkSource(
        {
          nativeSessionId: parseNativeSessionId(options.resumeSessionId),
          nativeSource: source,
        },
        this.name,
      );
      // UUIDs select thread/resume directly in pinned Codex. A name can miss
      // lookup and fall back to thread/start; it cannot address a scoped owner.
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          options.resumeSessionId,
        )
      )
        throw new Error("Codex OSS scoped continuation requires a native UUID");
      const home =
        process.env.CODEX_HOME ||
        join(
          process.platform === "win32" ? userInfo().homedir : homedir(),
          ".codex",
        );
      if (!isAbsolute(home))
        throw new Error(
          "Codex OSS scoped continuation requires an absolute native home",
        );
      const scope = await realpath(join(home, "sessions"));
      const file = await realpath(source.filePath);
      const path = relative(scope, file);
      if (
        scope !== source.native.storageScope ||
        !path ||
        path === ".." ||
        path.startsWith(".." + sep) ||
        isAbsolute(path)
      )
        throw new Error(
          "Codex OSS continuation is outside the launch session store",
        );
      const line = await readFirstLine(file, 1024 * 1024);
      const header = line ? JSON.parse(line) : null;
      if (
        header?.type !== "session_meta" ||
        header.payload?.id !== source.native.id ||
        typeof header.payload.cwd !== "string" ||
        !isAbsolute(header.payload.cwd) ||
        (await realpath(header.payload.cwd)) !==
          (await realpath(fromUrlProjectId(source.projectId)))
      )
        throw new Error(
          "Codex OSS continuation header does not match its native source",
        );
    }
    const gatewayRoute = await this.launchGatewayRoute(options);
    const installationLease =
      await this.installationCoordinator.acquireRuntimeLease(
        CODEX_INSTALLATION_FAMILY,
      );
    const queue = new MessageQueue();
    const abortController = new AbortController();
    const runtime: { process?: ChildProcess; exit: Promise<number | null> } = {
      exit: Promise.resolve(null),
    };
    const input = queue[Symbol.asyncIterator]();

    if (options.initialMessage) {
      queue.push(options.initialMessage);
    }

    const sessionIterator = this.runSession(
      options,
      gatewayRoute,
      input,
      abortController.signal,
      runtime,
    );
    const iterator = (async function* () {
      try {
        yield* sessionIterator;
      } finally {
        await input.return();
        if (
          runtime.process?.exitCode === null &&
          runtime.process.signalCode === null
        )
          runtime.process.kill("SIGTERM");
        await runtime.exit;
        await installationLease.release();
      }
    })();

    return {
      iterator,
      queue,
      abort: async () => {
        abortController.abort();
        await input.return();
        if (
          runtime.process?.exitCode === null &&
          runtime.process.signalCode === null
        )
          runtime.process.kill("SIGTERM");
        await runtime.exit;
        await installationLease.release();
      },
      ...(gatewayRoute ? { gatewayServiceId: gatewayRoute.serviceId } : {}),
      setSessionOptions: async (requested) =>
        inactiveProviderSessionOptionsResult(
          requested,
          "The Codex OSS CLI adapter exposes no automatic title, recap, progress-summary, or prompt-suggestion generator",
        ),
      get pid() {
        return runtime.process?.pid;
      },
    };
  }

  /**
   * The route a launch was handed by the server process, else the one this
   * process resolves now. Either way it is decided once, for every turn.
   */
  private launchGatewayRoute(
    options: StartSessionOptions,
  ): Promise<ModelCatalogRoute | null> {
    return options.gatewayRoute !== undefined
      ? Promise.resolve(options.gatewayRoute)
      : this.resolveLaunchGatewayRoute(options.model);
  }

  /**
   * Main session loop - uses `codex exec` for first turn, then `codex exec resume`
   * for subsequent turns.
   *
   * Important: Models must have sufficient context window (32K+ recommended) since
   * Codex's system prompt is ~5-6K tokens. With default 4K context, Ollama truncates
   * the prompt and loses conversation history.
   *
   * Create models with larger context via Modelfile:
   *   FROM qwen2.5-coder:32b-instruct-q4_K_M
   *   PARAMETER num_ctx 32768
   */
  private async *runSession(
    options: StartSessionOptions,
    gatewayRoute: ModelCatalogRoute | null,
    input: AsyncIterable<QueuedSDKUserMessage>,
    signal: AbortSignal,
    runtime: { process?: ChildProcess; exit: Promise<number | null> },
  ): AsyncIterableIterator<SDKMessage> {
    if (signal.aborted) return;
    const codexPath = await this.findCodexPath();
    if (signal.aborted) return;
    if (!codexPath) {
      yield {
        type: "error",
        error: "Codex CLI not found",
      } as SDKMessage;
      return;
    }
    const route: CodexModelRoute = gatewayRoute ?? {
      serviceId: undefined,
      modelId: options.model ?? "",
    };

    let currentSessionId = options.resumeSessionId ?? "";
    let initEmitted = !!options.resumeSessionId;

    // Turn counter for generating unique UUIDs per turn
    let turnNumber = 0;

    // Accumulator for streaming tokens within a turn
    // Codex-oss emits each token as a separate item with incrementing IDs,
    // but we want to merge them into a single message per response
    let accumulatedText = "";
    let accumulatedThinking = "";

    // If resuming, emit init immediately
    if (options.resumeSessionId) {
      yield {
        type: "system",
        subtype: "init",
        session_id: currentSessionId,
        cwd: options.cwd,
      } as SDKMessage;
    }

    const messageGen = input;
    let isFirstNewMessage = !options.resumeSessionId;
    for await (const message of messageGen) {
      if (signal.aborted) break;

      let userPrompt = this.extractTextFromMessage(message);
      if (!userPrompt) continue;

      // Prepend global instructions to the first message of new sessions
      if (isFirstNewMessage && options.globalInstructions) {
        userPrompt = `[Global context]\n${options.globalInstructions}\n\n---\n\n${userPrompt}`;
      }
      isFirstNewMessage = false;

      // A first exec turn has no native identity until thread.started. Never
      // expose a fabricated pending id to the identity owner.
      const userMessage = {
        type: "user",
        uuid: message.uuid,
        message: { role: "user", content: userPrompt },
      };
      if (currentSessionId)
        yield { ...userMessage, session_id: currentSessionId } as SDKMessage;

      if (signal.aborted) break;

      // Increment turn number and reset accumulators for this new turn
      turnNumber++;
      accumulatedText = "";
      accumulatedThinking = "";

      // Build CLI arguments - use resume for subsequent turns
      const isFirstTurn = turnNumber === 1 && !options.resumeSessionId;
      if (route.serviceId !== undefined && !this.serviceById(route.serviceId)) {
        // The endpoint this session is bound to was removed or stopped offering
        // CodexOSS. Its turns must not quietly move to the local provider.
        yield {
          type: "error",
          session_id: currentSessionId,
          error: `CodexOSS endpoint ${route.serviceId} is no longer configured`,
        } as SDKMessage;
        return;
      }
      const args = isFirstTurn
        ? this.buildFirstTurnArgs(options, route)
        : this.buildResumeTurnArgs(
            options,
            route,
            currentSessionId,
            userPrompt,
          );

      // Spawn codex process
      let codexProcess: ChildProcess;
      let processError: Error | undefined;
      try {
        log.debug(
          {
            args,
            cwd: options.cwd,
            turnNumber,
            isFirstTurn,
            sessionId: currentSessionId,
          },
          isFirstTurn
            ? "Spawning codex exec --oss"
            : "Spawning codex exec resume",
        );
        codexProcess = spawn(codexPath, args, {
          cwd: options.cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: stripYaControlPlaneCredentials(process.env),
          shell: process.platform === "win32",
        });
        runtime.process = codexProcess;
        runtime.exit = new Promise((resolve) =>
          codexProcess.once("close", resolve),
        );
        codexProcess.once("error", (error) => {
          processError = error;
        });
        codexProcess.stdin?.on("error", (error) => {
          processError = error;
          codexProcess.kill("SIGTERM");
        });

        // For first turn, send prompt via stdin
        // For resume, prompt is passed as argument
        if (isFirstTurn && codexProcess.stdin) {
          codexProcess.stdin.write(userPrompt);
          codexProcess.stdin.end();
        } else if (codexProcess.stdin) {
          codexProcess.stdin.end();
        }
      } catch (error) {
        yield {
          type: "error",
          session_id: currentSessionId,
          error: `Failed to spawn Codex: ${error instanceof Error ? error.message : String(error)}`,
        } as SDKMessage;
        return;
      }

      // Handle abort
      const abortHandler = () => codexProcess.kill("SIGTERM");
      signal.addEventListener("abort", abortHandler);

      const timeoutId = setTimeout(() => {
        codexProcess.kill("SIGTERM");
      }, this.timeout);

      try {
        if (!codexProcess.stdout) {
          yield {
            type: "error",
            session_id: currentSessionId,
            error: "Codex process has no stdout",
          } as SDKMessage;
          return;
        }

        const rl = createInterface({
          input: codexProcess.stdout,
          crlfDelay: Number.POSITIVE_INFINITY,
        });

        // Collect stderr for debugging
        let stderr = "";
        codexProcess.stderr?.on("data", (chunk) => {
          stderr += chunk.toString();
        });

        // For resume turns (no JSON), we need to parse text output
        // The format is: header lines, then "codex" line, then response text
        let inCodexResponse = false;
        const textResponseLines: string[] = [];

        for await (const line of rl) {
          if (signal.aborted) break;

          // First try JSON parsing (works for first turn with --json)
          const event = this.parseEvent(line);
          if (event) {
            // Update session ID from thread.started (only on first turn)
            if (event.type === "thread.started") {
              if (
                options.nativeResumeSource &&
                event.thread_id !== options.resumeSessionId
              ) {
                throw new Error(
                  "Codex OSS continuation opened a different native thread",
                );
              }
              log.debug(
                { threadId: event.thread_id, turnNumber },
                "Captured thread_id from thread.started",
              );
              currentSessionId = event.thread_id;
              if (!initEmitted) {
                initEmitted = true;
                yield {
                  type: "system",
                  subtype: "init",
                  session_id: currentSessionId,
                  cwd: options.cwd,
                } as SDKMessage;
              }
              if (isFirstTurn)
                yield {
                  ...userMessage,
                  session_id: currentSessionId,
                } as SDKMessage;
              continue;
            }

            // Exec owns one immutable prompt per child. Its native turn-start
            // event proves acceptance; our earlier user echo does not.
            if (
              event.type === "turn.started" &&
              currentSessionId &&
              message.uuid
            ) {
              options.onNativeInputConsumed?.(currentSessionId, message.uuid);
            }

            // Handle item events specially to accumulate streaming tokens
            // Codex-oss emits each token as a separate item with incrementing IDs,
            // but we want to merge agent_message tokens into a single message
            if (
              event.type === "item.started" ||
              event.type === "item.updated" ||
              event.type === "item.completed"
            ) {
              const item = event.item;

              // For agent_message, accumulate text and emit with stable UUID
              if (item.type === "agent_message") {
                accumulatedText += item.text;
                yield {
                  type: "assistant",
                  session_id: currentSessionId,
                  uuid: `response-turn${turnNumber}`,
                  message: { role: "assistant", content: accumulatedText },
                } as SDKMessage;
                continue;
              }

              // For reasoning, accumulate thinking and emit with stable UUID
              if (item.type === "reasoning") {
                accumulatedThinking += item.text;
                yield {
                  type: "assistant",
                  session_id: currentSessionId,
                  uuid: `thinking-turn${turnNumber}`,
                  message: {
                    role: "assistant",
                    content: [
                      { type: "thinking", thinking: accumulatedThinking },
                    ],
                  },
                } as SDKMessage;
                continue;
              }

              // For other item types (tool calls, etc.), use per-turn unique UUID
              const messages = this.convertItemToSDKMessages(
                item,
                currentSessionId,
                `${item.id}-turn${turnNumber}`,
                event.type === "item.completed",
              );
              for (const msg of messages) {
                yield msg;
              }
              continue;
            }

            // Convert other events to SDKMessages
            const messages = this.convertEventToSDKMessages(
              event,
              currentSessionId,
            );
            for (const msg of messages) {
              yield msg;
            }
            continue;
          }

          // Text output parsing for resume turns (no JSON)
          // Format: header, "codex", response lines, duplicate of response
          if (line === "codex") {
            inCodexResponse = true;
            continue;
          }

          if (inCodexResponse) {
            // Accumulate response lines
            textResponseLines.push(line);
            // Emit progressive updates
            accumulatedText = textResponseLines.join("\n");
            yield {
              type: "assistant",
              session_id: currentSessionId,
              uuid: `response-turn${turnNumber}`,
              message: { role: "assistant", content: accumulatedText },
            } as SDKMessage;
          }
        }

        // For text output, deduplicate the response (it appears twice)
        if (!isFirstTurn && textResponseLines.length > 0) {
          // The response is duplicated, so take first half
          const halfLen = Math.floor(textResponseLines.length / 2);
          if (
            halfLen > 0 &&
            textResponseLines.slice(0, halfLen).join("\n") ===
              textResponseLines.slice(halfLen).join("\n")
          ) {
            accumulatedText = textResponseLines.slice(0, halfLen).join("\n");
            yield {
              type: "assistant",
              session_id: currentSessionId,
              uuid: `response-turn${turnNumber}`,
              message: { role: "assistant", content: accumulatedText },
            } as SDKMessage;
          }
        }

        // Wait for exit
        const exitCode = await runtime.exit;

        if (exitCode !== 0 && stderr) {
          log.warn(
            { exitCode, stderr: stderr.slice(0, 500) },
            "Codex exited with error",
          );
        }

        // Emit result
        yield {
          type: "result",
          session_id: currentSessionId,
          ...(exitCode !== 0 || processError
            ? {
                error:
                  processError?.message ??
                  (stderr.trim().slice(0, 2000) ||
                    `Codex exited with status ${exitCode}`),
              }
            : {}),
        } as SDKMessage;
      } finally {
        clearTimeout(timeoutId);
        signal.removeEventListener("abort", abortHandler);
        if (!codexProcess.killed) {
          codexProcess.kill("SIGTERM");
        }
      }
    }
  }

  /**
   * Build CLI arguments for first turn: `codex exec --oss --json ...`
   */
  private buildFirstTurnArgs(
    options: StartSessionOptions,
    route: CodexModelRoute,
  ): string[] {
    const service = this.serviceById(route.serviceId);
    const args: string[] = service
      ? // A configured endpoint replaces `--oss`, which only ever meant
        // "whichever local provider Codex is configured for".
        ["exec", ...this.serviceLaunchArgs(service), "--json"]
      : ["exec", "--oss", "--local-provider", this.localProvider, "--json"];

    if (options.model) {
      args.push("--model", route.modelId);
    }
    args.push(...this.reasoningEffortArgs(options, route));

    // Sandbox mode
    if (options.permissionMode === "bypassPermissions") {
      args.push("-s", "danger-full-access");
    } else {
      args.push("-s", "workspace-write");
    }

    return args;
  }

  /**
   * Build CLI arguments for subsequent turns: `codex exec resume <session_id> <prompt> -c ...`
   *
   * Note: The resume subcommand doesn't support --oss or --json flags directly.
   * We must use -c config overrides to specify the model provider and model.
   */
  private buildResumeTurnArgs(
    options: StartSessionOptions,
    route: CodexModelRoute,
    sessionId: string,
    prompt: string,
  ): string[] {
    const service = this.serviceById(route.serviceId);
    const args: string[] = [
      "exec",
      "resume",
      sessionId,
      prompt,
      ...(service
        ? this.serviceLaunchArgs(service)
        : ["-c", `model_provider=${tomlString(this.localProvider)}`]),
    ];

    if (options.model) {
      args.push("-c", `model=${tomlString(route.modelId)}`);
    }
    args.push(...this.reasoningEffortArgs(options, route));

    return args;
  }

  /**
   * Parse a JSON line from CLI output.
   */
  private parseEvent(line: string): CodexEvent | null {
    const trimmed = line.trim();
    if (!trimmed?.startsWith("{")) {
      return null;
    }

    try {
      return JSON.parse(trimmed) as CodexEvent;
    } catch {
      log.debug({ line: trimmed.slice(0, 100) }, "Failed to parse event");
      return null;
    }
  }

  /**
   * Convert Codex event to SDKMessage(s).
   */
  private convertEventToSDKMessages(
    event: CodexEvent,
    sessionId: string,
  ): SDKMessage[] {
    switch (event.type) {
      case "turn.started":
        return [];

      case "turn.completed":
        return [
          {
            type: "system",
            subtype: "turn_complete",
            session_id: sessionId,
            usage: {
              input_tokens: event.usage.input_tokens,
              output_tokens: event.usage.output_tokens,
              cached_input_tokens: event.usage.cached_input_tokens,
            },
          } as SDKMessage,
        ];

      case "turn.failed":
        return [
          {
            type: "error",
            session_id: sessionId,
            error: event.error.message,
          } as SDKMessage,
        ];

      // item.started, item.updated, item.completed are handled in runSession
      // to support token accumulation with stable UUIDs

      case "error":
        return [
          {
            type: "error",
            session_id: sessionId,
            error: event.message,
          } as SDKMessage,
        ];

      default:
        return [];
    }
  }

  /**
   * Convert a Codex item to SDKMessage(s).
   * UUID is passed in to ensure uniqueness across turns.
   */
  private convertItemToSDKMessages(
    item: CodexItem,
    sessionId: string,
    uuid: string,
    isComplete: boolean,
  ): SDKMessage[] {
    switch (item.type) {
      // reasoning and agent_message are handled by accumulator in runSession
      case "reasoning":
        return [
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: {
              role: "assistant",
              content: [{ type: "thinking", thinking: item.text }],
            },
          } as SDKMessage,
        ];

      case "agent_message":
        return [
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: { role: "assistant", content: item.text },
          } as SDKMessage,
        ];

      case "command_execution": {
        const normalizedInvocation = normalizeCodexToolInvocation("Bash", {
          command: item.command,
        });
        const toolContext: CodexToolCallContext = {
          toolName: normalizedInvocation.toolName,
          input: normalizedInvocation.input,
          readShellInfo: normalizedInvocation.readShellInfo,
          writeShellInfo: normalizedInvocation.writeShellInfo,
        };
        const messages: SDKMessage[] = [
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: item.id,
                  name: normalizedInvocation.toolName,
                  input: normalizedInvocation.input,
                  ...(normalizedInvocation.displayActions
                    ? { _displayActions: normalizedInvocation.displayActions }
                    : {}),
                },
              ],
            },
          } as SDKMessage,
        ];

        if (isComplete && item.status !== "in_progress") {
          const normalizedResult = normalizeCodexCommandExecutionOutput(
            {
              aggregatedOutput: item.aggregated_output,
              exitCode: item.exit_code,
              status: item.status,
            },
            toolContext,
          );
          const toolResultBlock: {
            type: "tool_result";
            tool_use_id: string;
            content: string;
            is_error?: boolean;
          } = {
            type: "tool_result",
            tool_use_id: item.id,
            content: normalizedResult.content,
          };
          if (normalizedResult.isError) {
            toolResultBlock.is_error = true;
          }

          messages.push({
            type: "user",
            session_id: sessionId,
            message: {
              role: "user",
              content: [toolResultBlock],
            },
            ...(normalizedResult.structured !== undefined
              ? { toolUseResult: normalizedResult.structured }
              : {}),
          } as SDKMessage);
        }

        return messages;
      }

      case "file_change": {
        const changesSummary = item.changes
          .map((c) => `${c.kind}: ${c.path}`)
          .join("\n");
        const editInput: Record<string, unknown> = {
          changes: item.changes,
        };
        const singlePath = item.changes[0]?.path;
        if (singlePath && item.changes.length === 1) {
          editInput.file_path = singlePath;
        }

        return [
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: item.id,
                  name: "Edit",
                  input: editInput,
                },
              ],
            },
          } as SDKMessage,
          ...(isComplete
            ? [
                {
                  type: "user",
                  session_id: sessionId,
                  message: {
                    role: "user",
                    content: [
                      {
                        type: "tool_result",
                        tool_use_id: item.id,
                        ...(item.status !== "completed"
                          ? { is_error: true }
                          : {}),
                        content:
                          item.status === "completed"
                            ? `File changes applied:\n${changesSummary}`
                            : `File changes failed:\n${changesSummary}`,
                      },
                    ],
                  },
                } as SDKMessage,
              ]
            : []),
        ];
      }

      case "mcp_tool_call": {
        const messages: SDKMessage[] = [
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: item.id,
                  name: `${item.server}:${item.tool}`,
                  input: item.arguments,
                },
              ],
            },
          } as SDKMessage,
        ];

        if (isComplete && item.status !== "in_progress") {
          messages.push({
            type: "user",
            session_id: sessionId,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: item.id,
                  content:
                    item.status === "completed"
                      ? JSON.stringify(item.result)
                      : item.error?.message || "MCP tool call failed",
                },
              ],
            },
          } as SDKMessage);
        }

        return messages;
      }

      case "web_search":
        return [
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: item.id,
                  name: "WebSearch",
                  input: { query: item.query },
                },
              ],
            },
          } as SDKMessage,
        ];

      case "todo_list":
        return [
          {
            type: "system",
            subtype: "todo_list",
            session_id: sessionId,
            uuid,
            items: item.items,
          } as SDKMessage,
        ];

      case "error":
        return [
          {
            type: "error",
            session_id: sessionId,
            uuid,
            error: item.message,
          } as SDKMessage,
        ];

      default:
        return [];
    }
  }

  /**
   * Extract text from user message.
   */
  private extractTextFromMessage(message: unknown): string {
    if (!message || typeof message !== "object") return "";

    const userMsg = message as { text?: string };
    if (typeof userMsg.text === "string") return userMsg.text;

    const sdkMsg = message as { message?: { content?: string | unknown[] } };
    const content = sdkMsg.message?.content;

    if (typeof content === "string") return content;

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
   * Find codex binary path.
   */
  private async findCodexPath(): Promise<string | null> {
    return findCodexCliPath(this.codexPath, this.installationCoordinator);
  }
}

/**
 * Default CodexOSS provider instance.
 */
export const codexOSSProvider = new CodexOSSProvider();
