/**
 * Claude SDK provider routed through an Anthropic-compatible LLM gateway.
 *
 * Transport settings are supplied in Claude's supplementary flag-settings
 * layer for each spawned process. This outranks user/project/local settings
 * without editing any settings file or affecting concurrently running TUIs.
 */

import type { Settings } from "@anthropic-ai/claude-agent-sdk";
import {
  DEFAULT_GATEWAY_SERVICE_ID,
  DEFAULT_GATEWAY_SERVICE_MODEL_LIMIT,
  advertisedGatewayEffortLevels,
  gatewayModelEffort,
  legacyGatewayServiceEntry,
  parseGatewayModelId,
  unionModelCatalogs,
  type EffortLevel,
  type GatewayEndpointEffortProbe,
  type GatewayService,
  type ModelCatalogRoute,
  type ModelInfo,
  type PromptCacheKeepaliveProviderInfo,
} from "@yep-anywhere/shared";
import { getLogger } from "../../logging/logger.js";
import { refreshPiModelExport } from "./piModelExport.js";
import {
  gatewayEffortProbeCache,
  probeServiceEffort,
} from "../../services/GatewayEffortProbe.js";
import {
  ClaudeGatewayLauncher,
  claudeGatewayLauncher,
} from "./claude-gateway-launcher.js";
import { ClaudeProvider } from "./claude.js";
import { liveModelCatalog } from "./model-catalog-status.js";
import type { AuthStatus } from "./types.js";

interface GatewayModel {
  id?: unknown;
  display_name?: unknown;
  name?: unknown;
  model_picker_enabled?: unknown;
  supported_endpoints?: unknown;
  /** vLLM names itself here, and states the model's window below. */
  owned_by?: unknown;
  max_model_len?: unknown;
  capabilities?: {
    type?: unknown;
    limits?: {
      max_context_window_tokens?: unknown;
      max_prompt_tokens?: unknown;
    };
    supports?: {
      reasoning_effort?: unknown;
    };
  };
  policy?: {
    state?: unknown;
  };
}

interface GatewayModelsResponse {
  data?: GatewayModel[];
}

interface GatewayModelWindows {
  contextWindow: number;
  promptWindow: number;
}

interface GatewayModelLaunchMetadata {
  windows?: GatewayModelWindows;
}

/** What one configured service most recently advertised. */
interface GatewayServiceCatalog {
  serviceId: string;
  /** The endpoint the catalog actually came from, pinned to its address. */
  baseUrl: string;
  isCopilotApi: boolean;
  isVllm: boolean;
  disableAgent: boolean;
  disablePlanMode: boolean;
  launchMetadata: Map<string, GatewayModelLaunchMetadata>;
  /**
   * What this service advertised, as this service names it.
   *
   * Retained rather than only unioned because an export to another CLI's model
   * registry has to say which endpoint serves which model, and the union
   * deliberately loses that by qualifying ids only when two services collide.
   */
  models: ModelInfo[];
}

/** Which service serves an exposed model id, and under what name it knows it. */
type GatewayModelRoute = ModelCatalogRoute;

interface GatewayCatalogSnapshot {
  configurationGeneration: number;
  services: Map<string, GatewayServiceCatalog>;
  routes: Map<string, GatewayModelRoute>;
}

/**
 * Claude Code resolves a gateway model's effective context window separately
 * from its automatic-compaction window. The total catalog window becomes the
 * former; the prompt-only ceiling bounds the latter. Automatic windows below
 * 100K cannot be expressed, so omit them rather than rounding above a model's
 * advertised hard limit.
 */
const AUTO_COMPACT_WINDOW_MIN = 100_000;
const AUTO_COMPACT_WINDOW_MAX = 1_000_000;
const COPILOT_API_IDENTITY_HEADER = "x-copilot-api";
const CLAUDE_GATEWAY_PLAN_MODE_TOOLS = ["EnterPlanMode", "ExitPlanMode"];

export function gatewayAutoCompactWindow(
  promptWindow: number | undefined,
): number | undefined {
  if (
    typeof promptWindow !== "number" ||
    !Number.isFinite(promptWindow) ||
    promptWindow < AUTO_COMPACT_WINDOW_MIN
  ) {
    return undefined;
  }
  return Math.min(AUTO_COMPACT_WINDOW_MAX, Math.round(promptWindow));
}

function gatewayMaxContextTokens(
  contextWindow: number | undefined,
): number | undefined {
  return typeof contextWindow === "number" &&
    Number.isFinite(contextWindow) &&
    contextWindow > 0
    ? Math.round(contextWindow)
    : undefined;
}

/**
 * Which implementation answered this service's catalog.
 *
 * Observed from the response — copilot-api's explicit header, vLLM naming
 * itself in `owned_by` — and never configured, so a port, model name, or
 * vendor guess can never produce one.
 */
function gatewayBackendEnvironment(backend: {
  isCopilotApi: boolean;
  isVllm: boolean;
}): Record<string, string> {
  if (backend.isCopilotApi) {
    // The legacy marker has out-of-repo readers; publish both names.
    return { YEP_COPILOT_API: "1", AGENT_LAUNCH_BACKEND: "copilot-api" };
  }
  return backend.isVllm ? { AGENT_LAUNCH_BACKEND: "vllm" } : {};
}

function gatewayEnvironment(
  baseUrl: string,
  model?: string,
  metadata?: GatewayModelLaunchMetadata,
  isCopilotApi = false,
  isVllm = false,
): Record<string, string> {
  const maxContextTokens = gatewayMaxContextTokens(
    metadata?.windows?.contextWindow,
  );
  const autoCompactWindow = gatewayAutoCompactWindow(
    metadata?.windows?.promptWindow,
  );
  return {
    YEP_CLAUDE_GATEWAY: "1",
    ...gatewayBackendEnvironment({ isCopilotApi, isVllm }),
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: "dummy",
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    // DISABLE_NON_ESSENTIAL_MODEL_CALLS is no longer read by Claude Code
    // (absent from 2.1.220's env registry); it is kept for older CLIs.
    DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
    // This one is a privacy/traffic choice, not a token or quota saver, and it
    // is not free: it puts the CLI in essential-traffic mode, which disables
    // GrowthBook, so every feature flag falls back to its compiled default and
    // the session loses flag-gated features — the Monitor tool and hosted push
    // among them. Retained deliberately; see topics/claude.md.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ...(model
      ? {
          ANTHROPIC_MODEL: model,
          ANTHROPIC_DEFAULT_OPUS_MODEL: model,
          ANTHROPIC_DEFAULT_SONNET_MODEL: model,
          ANTHROPIC_SMALL_FAST_MODEL: model,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
        }
      : {}),
    ...(maxContextTokens !== undefined
      ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(maxContextTokens) }
      : {}),
    ...(autoCompactWindow !== undefined
      ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(autoCompactWindow) }
      : {}),
    ...(metadata && !metadata.windows
      ? { CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1" }
      : {}),
  };
}

const CLAUDE_GATEWAY_ENDPOINTS = new Set([
  "/v1/messages",
  "/responses",
  "/chat/completions",
]);

function isGatewayModelVisible(item: GatewayModel, id: string): boolean {
  if (item.model_picker_enabled === false) return false;
  if (item.policy?.state && item.policy.state !== "enabled") return false;
  if (item.capabilities?.type && item.capabilities.type !== "chat")
    return false;
  if (id.startsWith("text-embedding-") || id === "trajectory-compaction") {
    return false;
  }

  if (!Array.isArray(item.supported_endpoints)) return true;
  return item.supported_endpoints.some(
    (endpoint) =>
      typeof endpoint === "string" && CLAUDE_GATEWAY_ENDPOINTS.has(endpoint),
  );
}

function positiveLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/**
 * The windows a launch should enforce for one model.
 *
 * Declared service configuration wins: a harness needs a stated context and
 * output size, and an endpoint's own numbers are advice about a server that
 * can be reconfigured without YA noticing. Copilot-style catalog limits come
 * next, then vLLM's `max_model_len`, which is the whole window rather than a
 * prompt-only ceiling.
 */
function modelWindows(
  item: GatewayModel,
  declared?: DeclaredGatewayWindows,
): GatewayModelWindows | undefined {
  if (declared?.contextWindowTokens !== undefined) {
    const contextWindow = declared.contextWindowTokens;
    const output = declared.maxOutputTokens;
    return {
      contextWindow,
      promptWindow:
        output !== undefined && output < contextWindow
          ? contextWindow - output
          : contextWindow,
    };
  }

  const limits = item.capabilities?.limits;
  const contextWindow =
    positiveLimit(limits?.max_context_window_tokens) ??
    positiveLimit(item.max_model_len);
  if (contextWindow === undefined) return undefined;

  const advertisedPromptWindow = positiveLimit(limits?.max_prompt_tokens);
  return {
    contextWindow,
    promptWindow: Math.min(
      advertisedPromptWindow ?? contextWindow,
      contextWindow,
    ),
  };
}

/** Context and output sizes stated in a service's own configuration. */
export interface DeclaredGatewayWindows {
  contextWindowTokens?: number;
  maxOutputTokens?: number;
}

/** Thinking-effort levels stated in a service's own configuration. */
export interface DeclaredGatewayEffort {
  levels?: readonly EffortLevel[];
  defaultLevel?: EffortLevel;
}

export interface ParseGatewayCatalogOptions {
  declared?: DeclaredGatewayWindows;
  declaredEffort?: DeclaredGatewayEffort;
  /** What the endpoint answered for each model about the efforts it accepts. */
  probedEffort?: ReadonlyMap<string, GatewayEndpointEffortProbe>;
  /** Keep at most this many advertised models, in catalog order. */
  maxModels?: number;
}

interface ParsedGatewayCatalog {
  models: ModelInfo[];
  launchMetadata: Map<string, GatewayModelLaunchMetadata>;
  /**
   * Whether the catalog identifies itself as vLLM. Observed from the response,
   * never configured — the same rule the copilot-api header follows.
   */
  isVllm: boolean;
}

function parseClaudeGatewayCatalog(
  value: unknown,
  options: ParseGatewayCatalogOptions = {},
): ParsedGatewayCatalog {
  const data = (value as GatewayModelsResponse | null)?.data;
  if (!Array.isArray(data)) {
    return { models: [], launchMetadata: new Map(), isVllm: false };
  }

  const isVllm = data.some(
    (item) => item && typeof item === "object" && item.owned_by === "vllm",
  );
  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  const launchMetadata = new Map<string, GatewayModelLaunchMetadata>();
  const limit = options.maxModels ?? DEFAULT_GATEWAY_SERVICE_MODEL_LIMIT;
  for (const item of data) {
    if (models.length >= limit) break;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id || seen.has(id) || !isGatewayModelVisible(item, id)) continue;
    seen.add(id);
    const displayName =
      typeof item.display_name === "string"
        ? item.display_name.trim()
        : typeof item.name === "string"
          ? item.name.trim()
          : "";
    // Configuration first, then the row, then the model family, then whatever
    // the endpoint itself answered: a vLLM catalog states nothing about
    // reasoning, so an endpoint that accepts effort is indistinguishable from
    // one that does not until something says otherwise.
    const probedEffort = options.probedEffort?.get(id);
    const effort = gatewayModelEffort({
      modelId: id,
      ...(options.declaredEffort?.levels
        ? { configuredLevels: options.declaredEffort.levels }
        : {}),
      ...(options.declaredEffort?.defaultLevel
        ? { configuredDefaultLevel: options.declaredEffort.defaultLevel }
        : {}),
      advertisedLevels: advertisedGatewayEffortLevels(item),
      ...(probedEffort ? { probed: probedEffort } : {}),
    });
    const supportedEffortLevels = effort?.levels ?? [];
    const advertisedWindows = modelWindows(item, options.declared);
    launchMetadata.set(
      id,
      advertisedWindows ? { windows: advertisedWindows } : {},
    );
    models.push({
      id,
      name: displayName || id,
      ...(advertisedWindows
        ? { contextWindow: advertisedWindows.contextWindow }
        : {}),
      supportsEffort: supportedEffortLevels.length > 0,
      ...(supportedEffortLevels.length > 0
        ? {
            supportedEffortLevels,
            // The Anthropic wire carries effort as `output_config.effort`,
            // whose values stop at the named levels: there is no "none", so
            // thinking-off is not one of the efforts this transport can ask
            // for even when the model itself accepts it.
            supportedReasoningEfforts: supportedEffortLevels.map(
              (reasoningEffort) => ({ reasoningEffort }),
            ),
          }
        : {}),
      ...(effort?.defaultLevel
        ? {
            defaultEffortLevel: effort.defaultLevel,
            defaultReasoningEffort: effort.defaultLevel,
          }
        : {}),
      supportsAdaptiveThinking: supportedEffortLevels.length > 0,
    });
  }
  return { models, launchMetadata, isVllm };
}

export function parseClaudeGatewayModels(
  value: unknown,
  options?: ParseGatewayCatalogOptions,
): ModelInfo[] {
  return parseClaudeGatewayCatalog(value, options).models;
}

interface ServiceCatalogRead {
  models: ModelInfo[];
  catalog: GatewayServiceCatalog;
}

/**
 * Identity of the configured list, for change detection and cache keys.
 *
 * Every field that changes what a read publishes belongs here, including the
 * stated effort levels: they are resolved while parsing a catalog, so a saved
 * edit that this key ignored would leave the client holding a model list whose
 * effort control no longer matches the configuration.
 */
function gatewayServicesKey(services: readonly GatewayService[]): string {
  return JSON.stringify(
    services.map((service) => [
      service.id,
      service.url,
      service.serviceCommand ?? "",
      service.enabled,
      service.contextWindowTokens ?? null,
      service.maxOutputTokens ?? null,
      service.maxModels ?? null,
      service.disableAgent ?? null,
      service.disablePlanMode ?? null,
      service.effortLevels ?? null,
      service.defaultEffortLevel ?? null,
    ]),
  );
}

/**
 * One launcher per configured service.
 *
 * Each owns its own readiness attempt, foreground child, and stop schedule, so
 * reconfiguring or removing one service never disturbs another's process.
 */
const serviceLaunchers = new Map<string, ClaudeGatewayLauncher>();

function gatewayServiceLauncher(serviceId: string): ClaudeGatewayLauncher {
  const existing = serviceLaunchers.get(serviceId);
  if (existing) return existing;
  const launcher =
    serviceId === DEFAULT_GATEWAY_SERVICE_ID
      ? claudeGatewayLauncher
      : new ClaudeGatewayLauncher();
  serviceLaunchers.set(serviceId, launcher);
  return launcher;
}

async function configureGatewayServiceLaunchers(
  services: readonly GatewayService[],
): Promise<void> {
  const configured = new Set(services.map((service) => service.id));
  const removed = [...serviceLaunchers.entries()].filter(
    ([serviceId]) => !configured.has(serviceId),
  );
  await Promise.all(
    removed.map(async ([serviceId, launcher]) => {
      serviceLaunchers.delete(serviceId);
      await launcher.shutdown();
    }),
  );
  await Promise.all(
    services.map((service) =>
      gatewayServiceLauncher(service.id).configure({
        url: service.url,
        ...(service.serviceCommand
          ? { startCommand: service.serviceCommand }
          : {}),
      }),
    ),
  );
}

async function shutdownGatewayServiceLaunchers(): Promise<void> {
  const launchers = [...serviceLaunchers.values()];
  serviceLaunchers.clear();
  await Promise.all(launchers.map((launcher) => launcher.shutdown()));
  await claudeGatewayLauncher.shutdown();
}

function ownedGatewayProcessGroupIds(): number[] {
  const ids: number[] = [];
  for (const launcher of serviceLaunchers.values()) {
    const pid = launcher.getOwnedProcessGroupId();
    if (pid !== undefined) ids.push(pid);
  }
  return ids;
}

function relinquishGatewayProcessGroup(processGroupId: number): boolean {
  for (const launcher of serviceLaunchers.values()) {
    if (launcher.relinquishOwnedProcessGroup(processGroupId)) return true;
  }
  return false;
}

/** What became of one owned service child during a handoff. */
export interface GatewayProcessGroupRetention {
  processGroupId: number;
  /** Whatever the handoff threw; the launcher still owns this child. */
  error?: unknown;
  /** True once the launcher handed this child to the retainer. */
  relinquished: boolean;
}

/**
 * Ask a service to stop once nothing uses it.
 *
 * Called with the live session count per service; an entry that opted into
 * auto-stop and has reached zero gets its idle countdown, and any later use
 * cancels it.
 */
export function noteGatewayServiceUsage(
  liveSessionsByService: ReadonlyMap<string, number>,
): void {
  for (const service of ClaudeGatewayProvider.getServices()) {
    const timer = autoStopTimers.get(service.id);
    const live = liveSessionsByService.get(service.id) ?? 0;
    if (!service.autoStop || !service.serviceCommand || live > 0) {
      if (timer) {
        clearTimeout(timer);
        autoStopTimers.delete(service.id);
      }
      continue;
    }
    if (timer) continue;
    const delayMs = Math.max(0, service.autoStopAfterSeconds) * 1000;
    const scheduled = setTimeout(() => {
      autoStopTimers.delete(service.id);
      void gatewayServiceLauncher(service.id)
        .stopService()
        .catch((error: unknown) => {
          getLogger().warn(
            { error, serviceId: service.id },
            "Failed to stop an idle gateway service",
          );
        });
    }, delayMs);
    scheduled.unref();
    autoStopTimers.set(service.id, scheduled);
  }
}

const autoStopTimers = new Map<string, ReturnType<typeof setTimeout>>();

export class ClaudeGatewayProvider extends ClaudeProvider {
  override readonly name = "claude-gateway" as const;
  override readonly displayName = "Claude Gateway";
  override readonly supportsThinkingToggle = true;
  override readonly supportsNativePromptSuggestions = false;
  override readonly supportsLaunchCompactPercentOverride = false;
  override readonly promptCacheKeepalive:
    | PromptCacheKeepaliveProviderInfo
    | undefined = undefined;

  private static services: GatewayService[] = [];
  private static defaultServiceId: string | undefined;
  private static gatewayDisableAgent = true;
  private static gatewayDisablePlanMode = true;
  private static configurationGeneration = 0;
  /**
   * The last successful catalog per service, the exact endpoints they came
   * from, and which service serves each exposed model id. Configuration
   * changes invalidate every one of those facts as a single generation.
   */
  private static catalogSnapshot: GatewayCatalogSnapshot | undefined;

  constructor(
    /**
     * Injectable readiness owner. A test supplies one for the single service it
     * configures; the runtime resolves a launcher per service instead, so each
     * endpoint owns its own child process and stop schedule.
     */
    private readonly gatewayLauncher?: Pick<
      ClaudeGatewayLauncher,
      "ensureReady"
    >,
  ) {
    super();
  }

  private launcherFor(
    serviceId: string,
  ): Pick<ClaudeGatewayLauncher, "ensureReady"> {
    return this.gatewayLauncher ?? gatewayServiceLauncher(serviceId);
  }

  /** Replace the whole list with one entry, preserving the other fields. */
  private static setSingleService(
    changes: { url?: string; startCommand?: string },
    keep: "url" | "startCommand",
  ): void {
    const existing = ClaudeGatewayProvider.services[0];
    const url = keep === "url" ? (existing?.url ?? "") : (changes.url ?? "");
    const startCommand =
      keep === "startCommand" ? existing?.serviceCommand : changes.startCommand;
    if (!url) {
      ClaudeGatewayProvider.services = [];
      ClaudeGatewayProvider.defaultServiceId = undefined;
      ClaudeGatewayProvider.forgetGatewayCatalog();
      return;
    }
    ClaudeGatewayProvider.services = [
      legacyGatewayServiceEntry(url, startCommand, existing),
    ];
    ClaudeGatewayProvider.defaultServiceId =
      ClaudeGatewayProvider.services[0]!.id;
    ClaudeGatewayProvider.forgetGatewayCatalog();
  }

  static setGatewayUrl(url: string | undefined): void {
    if (ClaudeGatewayProvider.getGatewayUrl() === url) return;
    ClaudeGatewayProvider.setSingleService({ url }, "startCommand");
  }

  static setGatewayStartCommand(command: string | undefined): void {
    const current = ClaudeGatewayProvider.defaultService()?.serviceCommand;
    if (current === command) return;
    ClaudeGatewayProvider.setSingleService({ startCommand: command }, "url");
  }

  static setGatewayDisableAgent(disableAgent: boolean): void {
    ClaudeGatewayProvider.gatewayDisableAgent = disableAgent;
  }

  static setGatewayDisablePlanMode(disablePlanMode: boolean): void {
    ClaudeGatewayProvider.gatewayDisablePlanMode = disablePlanMode;
  }

  static async configureGateway(options: {
    url?: string;
    startCommand?: string;
    disableAgent?: boolean;
    disablePlanMode?: boolean;
  }): Promise<void> {
    await ClaudeGatewayProvider.configureGatewayServices({
      services: options.url
        ? [legacyGatewayServiceEntry(options.url, options.startCommand)]
        : [],
      defaultServiceId: DEFAULT_GATEWAY_SERVICE_ID,
      ...(options.disableAgent === undefined
        ? {}
        : { disableAgent: options.disableAgent }),
      ...(options.disablePlanMode === undefined
        ? {}
        : { disablePlanMode: options.disablePlanMode }),
    });
  }

  /**
   * Apply the configured services list.
   *
   * Every launcher whose entry disappeared or changed is shut down here, so a
   * removed service cannot leave an owned child or a pending stop check behind.
   */
  static async configureGatewayServices(options: {
    services: readonly GatewayService[];
    defaultServiceId?: string;
    disableAgent?: boolean;
    disablePlanMode?: boolean;
  }): Promise<void> {
    const services = options.services.filter((service) => service.url);
    const changed =
      gatewayServicesKey(services) !==
      gatewayServicesKey(ClaudeGatewayProvider.services);
    ClaudeGatewayProvider.services = [...services];
    ClaudeGatewayProvider.defaultServiceId = options.defaultServiceId;
    ClaudeGatewayProvider.gatewayDisableAgent = options.disableAgent ?? true;
    ClaudeGatewayProvider.gatewayDisablePlanMode =
      options.disablePlanMode ?? true;
    if (changed) {
      ClaudeGatewayProvider.forgetGatewayCatalog();
      // A reconfigured entry may point at a different server on the same
      // address, whose effort vocabulary is its own.
      gatewayEffortProbeCache.forget();
    }
    await configureGatewayServiceLaunchers(services);
  }

  /**
   * Every enabled entry, in the configured order.
   *
   * That order is what the model picker shows, since the catalog union follows
   * it, so it belongs to the user: moving an entry up in the services editor
   * moves its models up the list. The default entry is deliberately not
   * hoisted. It used to be, on the reasoning that it is read and started
   * first, but the reads run concurrently and a read's authority to start a
   * service is decided by comparing its id against the default — never by its
   * position — so hoisting only ever reordered the picker.
   */
  static enabledServices(): GatewayService[] {
    return ClaudeGatewayProvider.services.filter((service) => service.enabled);
  }

  static getServices(): GatewayService[] {
    return [...ClaudeGatewayProvider.services];
  }

  static defaultService(): GatewayService | undefined {
    const services = ClaudeGatewayProvider.services.filter(
      (service) => service.enabled,
    );
    if (services.length === 0) return undefined;
    return (
      services.find(
        (service) => service.id === ClaudeGatewayProvider.defaultServiceId,
      ) ??
      services.find((service) => service.id === DEFAULT_GATEWAY_SERVICE_ID) ??
      services[0]
    );
  }

  static async shutdownGateway(): Promise<void> {
    await shutdownGatewayServiceLaunchers();
  }

  /**
   * Hand every owned service child to something that outlives this process.
   *
   * Each configured service owns its own foreground child, so a restart has to
   * walk all of them: handing over only the first left every other service's
   * child to die with the server that spawned it. `retain` runs before the
   * launcher gives a child up, so a child whose `retain` throws stays owned
   * here and the caller's ordinary stop path still reaches it. One service's
   * failure does not end the walk — a caller that treats a failure as fatal
   * reports it from the returned records, once the remaining children are
   * safe.
   */
  static async retainOwnedGatewayProcessGroups(
    retain: (processGroupId: number) => void | Promise<void>,
  ): Promise<GatewayProcessGroupRetention[]> {
    const retentions: GatewayProcessGroupRetention[] = [];
    for (const processGroupId of ownedGatewayProcessGroupIds()) {
      try {
        await retain(processGroupId);
      } catch (error) {
        retentions.push({ processGroupId, error, relinquished: false });
        continue;
      }
      retentions.push({
        processGroupId,
        relinquished: relinquishGatewayProcessGroup(processGroupId),
      });
    }
    return retentions;
  }

  static getGatewayUrl(): string | undefined {
    return ClaudeGatewayProvider.defaultService()?.url;
  }

  private static rememberGatewayCatalog(
    configurationGeneration: number,
    catalogs: GatewayServiceCatalog[],
    routes: Map<string, GatewayModelRoute>,
  ): boolean {
    if (
      configurationGeneration !== ClaudeGatewayProvider.configurationGeneration
    ) {
      return false;
    }
    ClaudeGatewayProvider.catalogSnapshot = {
      configurationGeneration,
      services: new Map(
        catalogs.map((catalog) => [catalog.serviceId, catalog]),
      ),
      routes,
    };
    return true;
  }

  static forgetGatewayCatalog(): void {
    ClaudeGatewayProvider.configurationGeneration += 1;
    ClaudeGatewayProvider.catalogSnapshot = undefined;
  }

  static isConfigured(): boolean {
    return ClaudeGatewayProvider.enabledServices().length > 0;
  }

  override getModelCatalogCacheKey(): string {
    return gatewayServicesKey(ClaudeGatewayProvider.enabledServices());
  }

  override async isInstalled(): Promise<boolean> {
    return ClaudeGatewayProvider.isConfigured();
  }

  override async isAuthenticated(): Promise<boolean> {
    return ClaudeGatewayProvider.isConfigured();
  }

  override async getAuthStatus(): Promise<AuthStatus> {
    const configured = ClaudeGatewayProvider.isConfigured();
    return {
      installed: configured,
      authenticated: configured,
      enabled: configured,
    };
  }

  /**
   * Read every enabled service and return their models as one catalog.
   *
   * Each service's own `/v1/models` is authoritative for that service: no
   * Claude built-in aliases, no borrowing another service's rows. Only the
   * default service may be started by a catalog read — otherwise opening New
   * Session would boot every configured model server. A non-default service
   * that is not already listening simply contributes nothing until one of its
   * models is actually selected, and that selection authorizes its start.
   */
  override async getAvailableModels(): Promise<ModelInfo[]> {
    const services = ClaudeGatewayProvider.enabledServices();
    if (services.length === 0) return [];
    const configurationGeneration =
      ClaudeGatewayProvider.configurationGeneration;
    const defaultServiceId = ClaudeGatewayProvider.defaultService()?.id;

    const results = await Promise.all(
      services.map((service) =>
        this.readServiceCatalog(service, {
          allowStart: service.id === defaultServiceId,
        }),
      ),
    );
    if (
      configurationGeneration !== ClaudeGatewayProvider.configurationGeneration
    ) {
      return [];
    }

    const read = results.filter(
      (result): result is ServiceCatalogRead => result !== undefined,
    );
    const unread = services.length - read.length;
    this.modelCatalogStatus = liveModelCatalog(
      unread > 0
        ? `${unread} of ${services.length} gateway services could not be read`
        : undefined,
    );
    const { models, routes } = unionModelCatalogs(
      read.map((entry) => ({
        serviceId: entry.catalog.serviceId,
        models: entry.models,
      })),
    );

    // A service that could not be read this time keeps its last good catalog:
    // an unavailable endpoint must not strip the launch windows and routing of
    // sessions already using it. Only a successful read publishes a change.
    const refreshed = new Set(read.map((entry) => entry.catalog.serviceId));
    const previous = ClaudeGatewayProvider.currentSnapshot();
    const catalogs = read.map((entry) => entry.catalog);
    if (previous) {
      for (const [serviceId, catalog] of previous.services) {
        if (!refreshed.has(serviceId)) catalogs.push(catalog);
      }
      for (const [exposedId, route] of previous.routes) {
        if (!refreshed.has(route.serviceId) && !routes.has(exposedId)) {
          routes.set(exposedId, route);
        }
      }
    }

    if (
      !ClaudeGatewayProvider.rememberGatewayCatalog(
        configurationGeneration,
        catalogs,
        routes,
      )
    ) {
      return [];
    }
    // pi's registry can only name models an endpoint has actually advertised,
    // which is known here and nowhere earlier.
    void refreshPiModelExport(
      ClaudeGatewayProvider.advertisedModelsByService(),
    ).catch((error: unknown) => {
      getLogger().warn(
        { error },
        "Could not refresh pi's model registry after a catalog read",
      );
    });
    return models;
  }

  /** Fetch one service's catalog, or undefined when it cannot be read now. */
  private async readServiceCatalog(
    service: GatewayService,
    options: { allowStart: boolean },
  ): Promise<ServiceCatalogRead | undefined> {
    try {
      // Read from the address readiness was proven against, not from a second
      // resolution of the configured hostname: `localhost` can front one
      // gateway on 127.0.0.1 and another on ::1.
      const listeningUrl = await this.launcherFor(service.id).ensureReady({
        url: service.url,
        ...(options.allowStart && service.serviceCommand
          ? { startCommand: service.serviceCommand }
          : {}),
      });
      const baseUrl = listeningUrl ?? service.url;
      const response = await fetch(`${baseUrl}/v1/models`, {
        headers: { Authorization: "Bearer dummy" },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return undefined;
      const payload = await response.json();
      const probedEffort = await probeServiceEffort(
        service,
        baseUrl,
        payload,
        (row, id) => isGatewayModelVisible(row as GatewayModel, id),
      );
      const parsed = parseClaudeGatewayCatalog(payload, {
        probedEffort,
        declared: {
          ...(service.contextWindowTokens === undefined
            ? {}
            : { contextWindowTokens: service.contextWindowTokens }),
          ...(service.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: service.maxOutputTokens }),
        },
        declaredEffort: {
          ...(service.effortLevels === undefined
            ? {}
            : { levels: service.effortLevels }),
          ...(service.defaultEffortLevel === undefined
            ? {}
            : { defaultLevel: service.defaultEffortLevel }),
        },
        ...(service.maxModels === undefined
          ? {}
          : { maxModels: service.maxModels }),
      });
      return {
        models: parsed.models,
        catalog: {
          serviceId: service.id,
          baseUrl,
          isCopilotApi:
            response.headers.get(COPILOT_API_IDENTITY_HEADER) === "1",
          isVllm: parsed.isVllm,
          disableAgent:
            service.disableAgent ?? ClaudeGatewayProvider.gatewayDisableAgent,
          disablePlanMode:
            service.disablePlanMode ??
            ClaudeGatewayProvider.gatewayDisablePlanMode,
          launchMetadata: parsed.launchMetadata,
          models: parsed.models,
        },
      };
    } catch (error) {
      getLogger().debug(
        { error, serviceId: service.id, gatewayUrl: service.url },
        "Failed to fetch Claude gateway models",
      );
      return undefined;
    }
  }

  protected override async normalizeSupportedModels(): Promise<ModelInfo[]> {
    return this.getAvailableModels();
  }

  /**
   * Make sure the service behind a chosen model is running before launching.
   *
   * This is where a non-default service earns its start: the user picked one of
   * its models, which is a stronger signal than a catalog refresh.
   */
  override async startSession(
    options: Parameters<ClaudeProvider["startSession"]>[0],
  ): ReturnType<ClaudeProvider["startSession"]> {
    if (options.nativeResumeSource) await this.sessionEnvironment(options);
    await this.ensureServiceReadyForModel(options.model);
    return super.startSession(options);
  }

  private async ensureServiceReadyForModel(model?: string): Promise<void> {
    const route = ClaudeGatewayProvider.resolveServiceForModel(model);
    const service = route
      ? ClaudeGatewayProvider.services.find(
          (entry) => entry.id === route.serviceId,
        )
      : ClaudeGatewayProvider.defaultService();
    if (!service?.serviceCommand) return;
    const listeningUrl = await this.launcherFor(service.id).ensureReady({
      url: service.url,
      startCommand: service.serviceCommand,
    });
    if (!listeningUrl) return;
    // The catalog's recorded endpoint can predate this start; keep the launch
    // pointed at the address readiness was just proven against.
    const snapshot = ClaudeGatewayProvider.currentSnapshot();
    const catalog = snapshot?.services.get(service.id);
    if (catalog) catalog.baseUrl = listeningUrl;
  }

  /**
   * What each configured service most recently advertised, by service id.
   *
   * For exports to other CLIs' registries, which need the endpoint-by-endpoint
   * view rather than the union YA's own picker shows.
   */
  static advertisedModelsByService(): Map<string, ModelInfo[]> {
    const snapshot = ClaudeGatewayProvider.currentSnapshot();
    const byService = new Map<string, ModelInfo[]>();
    for (const [serviceId, catalog] of snapshot?.services ?? []) {
      byService.set(serviceId, catalog.models);
    }
    return byService;
  }

  private static currentSnapshot(): GatewayCatalogSnapshot | undefined {
    const snapshot = ClaudeGatewayProvider.catalogSnapshot;
    return snapshot?.configurationGeneration ===
      ClaudeGatewayProvider.configurationGeneration
      ? snapshot
      : undefined;
  }

  /**
   * Which configured service serves a model id.
   *
   * A bare id belongs to whichever service advertised it; an id qualified with
   * a service prefix belongs to that service, which is how two services that
   * advertise the same model stay distinguishable.
   */
  static resolveServiceForModel(
    model: string | undefined,
  ): GatewayModelRoute | undefined {
    if (!model) return undefined;
    const snapshot = ClaudeGatewayProvider.currentSnapshot();
    const route = snapshot?.routes.get(model);
    if (route) return route;
    const qualified = parseGatewayModelId(model, (serviceId) =>
      ClaudeGatewayProvider.services.some((entry) => entry.id === serviceId),
    );
    return qualified ?? undefined;
  }

  private static launchContext(model?: string):
    | {
        baseUrl: string;
        isCopilotApi: boolean;
        isVllm: boolean;
        metadata: GatewayModelLaunchMetadata | undefined;
        disableAgent: boolean;
        disablePlanMode: boolean;
      }
    | undefined {
    const snapshot = ClaudeGatewayProvider.currentSnapshot();
    const route = ClaudeGatewayProvider.resolveServiceForModel(model);
    const service = route
      ? ClaudeGatewayProvider.services.find(
          (entry) => entry.id === route.serviceId,
        )
      : ClaudeGatewayProvider.defaultService();
    if (!service) return undefined;
    const catalog = snapshot?.services.get(service.id);
    return {
      baseUrl: catalog?.baseUrl ?? service.url,
      isCopilotApi: catalog?.isCopilotApi ?? false,
      isVllm: catalog?.isVllm ?? false,
      metadata: route ? catalog?.launchMetadata.get(route.modelId) : undefined,
      disableAgent:
        service.disableAgent ?? ClaudeGatewayProvider.gatewayDisableAgent,
      disablePlanMode:
        service.disablePlanMode ?? ClaudeGatewayProvider.gatewayDisablePlanMode,
    };
  }

  protected override getDisallowedTools(model?: string): string[] | undefined {
    const launch = ClaudeGatewayProvider.launchContext(model);
    const disablePlanMode =
      launch?.disablePlanMode ?? ClaudeGatewayProvider.gatewayDisablePlanMode;
    return disablePlanMode ? [...CLAUDE_GATEWAY_PLAN_MODE_TOOLS] : undefined;
  }

  protected override getSettings(model?: string): Settings | undefined {
    const launch = ClaudeGatewayProvider.launchContext(model);
    if (!launch) return undefined;
    const route = ClaudeGatewayProvider.resolveServiceForModel(model);
    return {
      env: {
        ...this.getSubagentDepthEnvironment(),
        ...gatewayEnvironment(
          launch.baseUrl,
          // The gateway knows the model by its own id, not by the qualified
          // one YA shows when two services advertise the same name.
          route?.modelId ?? model,
          launch.metadata,
          launch.isCopilotApi,
          launch.isVllm,
        ),
      },
      ...(launch.disableAgent ? { permissions: { deny: ["Agent"] } } : {}),
    };
  }

  protected override getEnv(
    model?: string,
  ): Record<string, string | undefined> {
    const launch = ClaudeGatewayProvider.launchContext(model);
    const route = ClaudeGatewayProvider.resolveServiceForModel(model);
    return launch
      ? {
          ...super.getEnv(model),
          ...gatewayEnvironment(
            launch.baseUrl,
            route?.modelId ?? model,
            launch.metadata,
            launch.isCopilotApi,
            launch.isVllm,
          ),
        }
      : super.getEnv(model);
  }
}

export const claudeGatewayProvider = new ClaudeGatewayProvider();
