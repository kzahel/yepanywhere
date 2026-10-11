/**
 * pi provider — Plan A: subprocess RPC mode (`pi --mode rpc`).
 *
 * pi (Mario Zechner's provider-agnostic coding agent, @earendil-works/pi) ships
 * a headless JSON-RPC front-door that is a peer of its TUI on one shared
 * AgentSessionRuntime — so this is "pi as shipped, headless", not TUI driving.
 * See topics/pi-provider.md for the full plan (Plan A here; Plan B = in-process
 * SDK; PiSessionReader / steering / permission-bridge are documented follow-ups).
 *
 * One `pi --mode rpc` child runs per YA session. Commands go to stdin as
 * LF-JSONL; stdout interleaves command responses, agent events, and extension
 * UI requests (see pi-rpc-client.ts). Each YA user turn sends `prompt` and
 * streams agent events until `agent_settled`, normalizing them to YA
 * SDKMessages.
 */

import { type ChildProcess, exec, execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  EFFORT_LEVEL_ORDER,
  nearestGatewayEffortLevel,
  parseGatewayTemplateEffortRejection,
  type EffortLevel,
  type ModelCatalogStatus,
  type ModelInfo,
} from "@yep-anywhere/shared";
import { getLogger } from "../../logging/logger.js";
import {
  fallbackModelCatalog,
  liveModelCatalog,
  modelCatalogError,
} from "./model-catalog-status.js";
import { whichCommand } from "../which-command.js";
import { MessageQueue } from "../messageQueue.js";
import { forkPiSessionFile } from "../../sessions/pi-fork.js";
import { PiSessionReader } from "../../sessions/pi-reader.js";
import type {
  ContentBlock,
  ProviderCommandResult,
  ProviderLivenessProbeResult,
  SDKMessage,
} from "../types.js";
import {
  PI_EFFORT_RETRY_COMMAND,
  type PiEffortRetryRecord,
  piEffortRetryNoticeText,
  yepAnywherePiExtensionPath,
} from "./pi-effort-retry.js";
import { PiRpcClient } from "./pi-rpc-client.js";
import { stripYaControlPlaneCredentials } from "./env-filter.js";
import {
  buildPiLaunchArgs,
  type PiLaunchTarget,
  resolvePiLaunchTarget,
  selectPiLaunchTarget,
} from "./pi-launch-target.js";
import {
  attachPiResultDetailToToolInput,
  normalizePiTool,
  normalizePiToolResult,
  stringifyPiToolResult,
  type PiToolState,
} from "./pi-tools.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  ProviderForkBoundary,
  StartSessionOptions,
} from "./types.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const PI_AGENT_SETTLED_MIN_VERSION = [0, 80, 4] as const;
/**
 * Pi answers `prompt` once it accepts, queues, or handles it; a handled
 * extension command answers only after its handler finishes. The response is
 * advisory (see `runSession`), so this bounds how long YA listens for it.
 */
const PI_PROMPT_RESPONSE_TIMEOUT_MS = 120_000;

/** pi image content block, as accepted by the RPC `prompt`/`steer` commands. */
interface PiImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

/** Subset of pi's `Model` we read from get_available_models / get_state. */
interface PiModel {
  provider: string;
  id: string;
  name?: string;
}

/** Subset of pi's `RpcSessionState` we read from get_state. */
interface PiSessionState {
  sessionId: string;
  sessionFile?: string;
  isStreaming?: boolean;
  model?: PiModel | null;
}

interface PiModelSelection {
  provider: string;
  modelId: string;
}

interface PiRuntimeState {
  lastRawProviderEventAt: Date | null;
  lastRawProviderEventSource: string | null;
}

/** Per-turn streaming state for the in-flight assistant message. */
interface PiStreamState {
  /** Stable base id; text uses it, thinking uses `${id}-thinking`. */
  currentAssistantId: string | null;
  /** Cumulative assistant text so far (emitted whole each update). */
  text: string;
  /** Cumulative assistant thinking so far (emitted whole each update). */
  thinking: string;
  /**
   * Every model request of this YA turn, summed. One pi run makes a request per
   * tool round, plus any retry, and each is charged; the `result` reports the
   * total, as Claude's and OpenCode's do.
   */
  runUsage: SdkUsage | null;
  runCostUsd: number | null;
  /** Version-selected event that ends one YA provider turn. */
  terminalEvent: "agent_end" | "agent_settled";
  /**
   * What the model server said when this turn failed.
   *
   * pi reports a failed turn as an ordinary assistant `message_end` carrying
   * `stopReason: "error"` and an `errorMessage`, not as an event of its own.
   * Reading only the terminal event therefore ended the turn silently, which is
   * how an unusable thinking level looked like nothing happening at all.
   */
  turnError: string | null;
  /** Canonical tool inputs by pi toolCallId, updated by live partial/final events. */
  toolStates: Map<string, PiToolState>;
}

/** Stable per-message id for streamed assistant content. */
function mintAssistantId(): string {
  return `pi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface SdkUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface PiProviderConfig {
  /** Path to the pi binary (auto-detected if not specified). */
  piPath?: string;
  /** Override for testing (defaults to ~/.pi/agent/sessions). */
  sessionsDir?: string;
}

export function piVersionUsesAgentSettled(rawVersion: string): boolean | null {
  const match = rawVersion.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  const version = match.slice(1, 4).map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < PI_AGENT_SETTLED_MIN_VERSION.length; i++) {
    const actual = version[i] ?? 0;
    const minimum = PI_AGENT_SETTLED_MIN_VERSION[i] ?? 0;
    if (actual !== minimum) return actual > minimum;
  }
  return true;
}

/**
 * YA EffortLevel → pi ThinkingLevel.
 *
 * Every level YA names is one of pi's own: its `THINKING_LEVELS` are off,
 * minimal, low, medium, high, xhigh and max (verified against installed Pi
 * 0.85.1, whose `--thinking` help states the same set), so each passes through
 * unchanged.
 */
function effortToThinkingLevel(effort: EffortLevel): string {
  return effort;
}

/**
 * How many times one turn may be retried at a lower thinking level.
 *
 * A rejection normally names the whole accepted set, so the first retry lands
 * on a usable level; the cap is there for a server that refuses one level at a
 * time, and it stops well short of resending the same prompt indefinitely.
 */
const MAX_EFFORT_RETRIES_PER_TURN = 3;

/**
 * The level to retry at after a model server refused the current one.
 *
 * vLLM names the whole accepted set — "Supported types are xhigh (default),
 * medium, and low." — so the answer is the highest of those at or below what
 * was asked for. A server that only says the level is unusable gets one step
 * down YA's own order. Returns undefined when the failure is about something
 * else entirely, or when there is nothing lower left to try.
 */
export function loweredEffortForRejection(
  errorMessage: string,
  current: EffortLevel | undefined,
): EffortLevel | undefined {
  if (!current) return undefined;
  const narrowed = parseGatewayTemplateEffortRejection(errorMessage);
  if (narrowed) {
    const next = nearestGatewayEffortLevel(
      { levels: narrowed.levels },
      current,
    );
    return next && next !== current ? next : undefined;
  }
  if (!/reasoning[_ ]?effort|thinking level/iu.test(errorMessage)) {
    return undefined;
  }
  const below = EFFORT_LEVEL_ORDER.indexOf(current) - 1;
  return below >= 0 ? EFFORT_LEVEL_ORDER[below] : undefined;
}

function parsePiModelSelection(
  model: string | undefined,
): PiModelSelection | undefined {
  if (!model || model === "default" || model === "auto") {
    return undefined;
  }
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    return undefined;
  }
  return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
}

function isProcessStillAlive(proc: ChildProcess): boolean {
  return !proc.killed && proc.exitCode === null && proc.signalCode === null;
}

function mapPiUsage(usage: unknown): {
  usage: SdkUsage;
  costUsd: number | null;
} | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
  };
  return {
    usage: {
      input_tokens: u.input ?? 0,
      output_tokens: u.output ?? 0,
      cache_read_input_tokens: u.cacheRead ?? 0,
      cache_creation_input_tokens: u.cacheWrite ?? 0,
    },
    costUsd: typeof u.cost?.total === "number" ? u.cost.total : null,
  };
}

/**
 * pi provider (RPC subprocess mode).
 */
export class PiProvider implements AgentProvider {
  readonly name = "pi" as const;
  readonly displayName = "pi";
  // pi runs tools autonomously; the YA approval bridge (tool_execution_start
  // "can block" hook over extension_ui_request) is a documented follow-up, so
  // YA permission modes do not yet gate pi tools.
  readonly supportsPermissionMode = false;
  readonly supportsThinkingToggle = true;
  // Native /compact etc. exist, but the command inventory isn't surfaced yet.
  readonly supportsSlashCommands = false;
  // True steering exists in pi (steer lands before the next LLM call); wiring
  // it to YA's steer dispatch is a follow-up, so start conservative (queue).
  readonly supportsSteering = false;

  private readonly configuredPath?: string;
  private readonly sessionsDir?: string;
  private cachedModels: { at: number; models: ModelInfo[] } | null = null;
  private modelCatalogStatus: ModelCatalogStatus | undefined;
  private readonly cachedTerminalEvents = new Map<
    string,
    "agent_end" | "agent_settled"
  >();

  constructor(config: PiProviderConfig = {}) {
    this.configuredPath = config.piPath;
    this.sessionsDir = config.sessionsDir;
  }

  async isInstalled(): Promise<boolean> {
    return (await this.findPiLaunchTarget()) !== null;
  }

  async isAuthenticated(): Promise<boolean> {
    // pi resolves credentials per-model (auth.json / env keys). Treat "installed"
    // as usable; a missing key surfaces as a turn error, like opencode.
    return this.isInstalled();
  }

  async getAuthStatus(): Promise<AuthStatus> {
    const installed = await this.isInstalled();
    return {
      installed,
      authenticated: installed,
      enabled: installed,
      loginCommand: installed ? undefined : "pi",
    };
  }

  getModelCatalogStatus(): ModelCatalogStatus | undefined {
    return this.modelCatalogStatus;
  }

  /**
   * List models by briefly running an ephemeral `pi --mode rpc --no-session`
   * and querying get_available_models. Cached for 5 minutes or until
   * `forceRefresh`; falls back to a single "default" entry on any failure so
   * the provider still appears.
   */
  async getAvailableModels(options?: {
    forceRefresh?: boolean;
  }): Promise<ModelInfo[]> {
    const fresh =
      options?.forceRefresh !== true &&
      this.cachedModels &&
      Date.now() - this.cachedModels.at < 5 * 60_000;
    if (fresh && this.cachedModels) {
      return this.cachedModels.models;
    }

    const defaultModel: ModelInfo = {
      id: "default",
      name: "Default",
      description: "pi default model",
    };
    const fallback: ModelInfo[] = [defaultModel];

    const piTarget = await this.findPiLaunchTarget();
    if (!piTarget) {
      this.modelCatalogStatus = fallbackModelCatalog("pi is not installed");
      return fallback;
    }

    let proc: ChildProcess | undefined;
    try {
      proc = spawn(
        piTarget.command,
        buildPiLaunchArgs(piTarget, ["--mode", "rpc", "--no-session"]),
        {
          cwd: homedir(),
          stdio: ["pipe", "pipe", "pipe"],
          env: stripYaControlPlaneCredentials(process.env),
        },
      );
      const client = new PiRpcClient(proc);
      const response = await client.request(
        { type: "get_available_models" },
        10000,
      );
      const models =
        response.success && response.data
          ? this.mapModels(
              (response.data as { models?: PiModel[] }).models ?? [],
            )
          : [];
      const result = models.length > 0 ? [defaultModel, ...models] : fallback;
      this.cachedModels = { at: Date.now(), models: result };
      this.modelCatalogStatus =
        models.length > 0
          ? liveModelCatalog()
          : fallbackModelCatalog("pi returned no models");
      return result;
    } catch (error) {
      getLogger().debug({ error }, "pi: model listing failed; using fallback");
      this.modelCatalogStatus = fallbackModelCatalog(modelCatalogError(error));
      return fallback;
    } finally {
      proc?.kill("SIGTERM");
    }
  }

  private mapModels(models: PiModel[]): ModelInfo[] {
    return models.map((m) => ({
      id: `${m.provider}/${m.id}`,
      name: m.name ?? `${m.provider}/${m.id}`,
    }));
  }

  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const log = getLogger();
    const piTarget = await this.findPiLaunchTarget();
    if (!piTarget) {
      return this.errorSession("pi CLI not found");
    }
    const terminalEvent = await this.getPiTerminalEvent(piTarget);
    if (!terminalEvent) {
      return this.errorSession(
        "Unable to determine pi RPC lifecycle support from `pi --version`",
      );
    }

    const args = ["--mode", "rpc", "--extension", yepAnywherePiExtensionPath()];
    if (options.model && options.model !== "default") {
      args.push("--model", options.model);
    }
    if (options.resumeSessionId) {
      args.push("--session", options.resumeSessionId);
    }

    let proc: ChildProcess;
    try {
      proc = spawn(piTarget.command, buildPiLaunchArgs(piTarget, args), {
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: stripYaControlPlaneCredentials({
          ...process.env,
          ...options.remoteEnv,
        }),
      });
    } catch (error) {
      return this.errorSession(
        `Failed to spawn pi: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    proc.stderr?.on("data", (chunk: Buffer) => {
      log.debug({ line: chunk.toString().trim() }, "pi stderr");
    });

    const client = new PiRpcClient(proc);

    // Resolve the pi session id synchronously (relative to Supervisor startup)
    // so waitForSessionId() resolves on the first init yield.
    let sessionId: string;
    try {
      const state = await client.request({ type: "get_state" }, 10000);
      if (!state.success) {
        throw new Error(state.error ?? "get_state failed");
      }
      sessionId = (state.data as PiSessionState).sessionId;
    } catch (error) {
      proc.kill("SIGTERM");
      return this.errorSession(
        `pi session did not start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    log.info({ sessionId, cwd: options.cwd }, "pi RPC session ready");

    // Best-effort thinking level (effort wins; else leave pi's model default).
    if (options.effort) {
      void client
        .request({
          type: "set_thinking_level",
          level: effortToThinkingLevel(options.effort),
        })
        .catch(() => {});
    }

    const queue = new MessageQueue();
    const abortController = new AbortController();
    const runtime: PiRuntimeState = {
      lastRawProviderEventAt: null,
      lastRawProviderEventSource: null,
    };
    if (options.initialMessage) {
      queue.push(options.initialMessage);
    }

    const iterator = this.runSession(
      client,
      proc,
      sessionId,
      queue,
      abortController.signal,
      options,
      runtime,
      terminalEvent,
    );

    return {
      iterator,
      queue,
      abort: () => abortController.abort(),
      // Graceful turn interrupt: stop the in-flight turn but keep the process.
      interrupt: async () => {
        try {
          const r = await client.request({ type: "abort" }, 5000);
          return r.success;
        } catch {
          return false;
        }
      },
      isProcessAlive: () => isProcessStillAlive(proc),
      probeLiveness: () => this.probeLiveness(client, proc),
      getProviderActivity: () => ({
        lastRawProviderEventAt: runtime.lastRawProviderEventAt,
        lastRawProviderEventSource: runtime.lastRawProviderEventSource,
      }),
      supportedModels: () => this.getAvailableModels(),
      setModel: async (model?: string) => {
        const sel = parsePiModelSelection(model);
        if (!sel) return;
        await client
          .request({
            type: "set_model",
            provider: sel.provider,
            modelId: sel.modelId,
          })
          .catch(() => {});
      },
      runProviderCommand: (command, argument) =>
        this.runProviderCommand(client, command, argument),
      sessionId,
      get pid() {
        return proc.pid;
      },
    };
  }

  async forkSession(options: {
    sessionId: string;
    cwd: string;
    upToMessageId?: string;
    boundary?: ProviderForkBoundary;
    title?: string;
  }): Promise<{ sessionId: string; filePath: string }> {
    if (options.boundary && options.boundary.kind !== "entry") {
      throw new Error("Pi fork requires an entry boundary");
    }
    const reader = new PiSessionReader({
      sessionsDir: this.sessionsDir,
      projectPath: options.cwd,
    });
    const sourcePath = await reader.getSessionFilePath(options.sessionId);
    if (!sourcePath) {
      throw new Error(`Pi session ${options.sessionId} was not found`);
    }
    const fork = await forkPiSessionFile({
      sourcePath,
      cwd: options.cwd,
      upToMessageId:
        options.boundary?.kind === "entry"
          ? options.boundary.entryId
          : options.upToMessageId,
    });
    return fork;
  }

  /**
   * Native command dispatch. pi owns /compact (RPC `compact`); everything else
   * falls back to normal turn delivery.
   */
  private async runProviderCommand(
    client: PiRpcClient,
    command: string,
    argument?: string,
  ): Promise<ProviderCommandResult> {
    const normalized = command.replace(/^\//, "").trim().toLowerCase();
    if (normalized !== "compact") {
      return { handled: false };
    }
    try {
      const r = await client.request(
        {
          type: "compact",
          ...(argument ? { customInstructions: argument } : {}),
        },
        120000,
      );
      return r.success
        ? { handled: true }
        : { handled: true, error: r.error ?? "compact failed" };
    } catch (error) {
      return {
        handled: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async probeLiveness(
    client: PiRpcClient,
    proc: ChildProcess,
  ): Promise<ProviderLivenessProbeResult> {
    const checkedAt = new Date();
    if (!isProcessStillAlive(proc)) {
      return {
        status: "unavailable",
        source: "pi:process",
        detail: "pi process is not alive",
        checkedAt,
      };
    }
    try {
      const r = await client.request({ type: "get_state" }, 5000);
      if (!r.success) {
        return {
          status: "error",
          source: "pi:get_state",
          detail: r.error ?? "get_state failed",
          checkedAt,
        };
      }
      const streaming = (r.data as PiSessionState).isStreaming === true;
      return {
        status: streaming ? "active" : "idle",
        source: "pi:get_state",
        detail: streaming ? "pi is streaming" : "pi is idle",
        checkedAt,
      };
    } catch (error) {
      return {
        status: "error",
        source: "pi:get_state",
        detail: error instanceof Error ? error.message : String(error),
        checkedAt,
      };
    }
  }

  /**
   * Session loop. Process + RPC client are already up and the session id is
   * known. Yields an init message first, then per queued user turn sends a
   * `prompt` and streams agent events until `agent_settled`.
   */
  private async *runSession(
    client: PiRpcClient,
    proc: ChildProcess,
    sessionId: string,
    queue: MessageQueue,
    signal: AbortSignal,
    options: StartSessionOptions,
    runtime: PiRuntimeState,
    terminalEvent: PiStreamState["terminalEvent"],
  ): AsyncIterableIterator<SDKMessage> {
    const log = getLogger();

    // Shared event buffer fed by the single stdout subscription, drained per
    // turn. `wake` lets the per-turn drain block until the next event/exit.
    const events: SDKMessage[] = [];
    let wake: (() => void) | null = null;
    let processExited = false;
    /** Whether a run started since the current turn's latest prompt send. */
    let runStartedSinceSend = false;

    const stream: PiStreamState = {
      currentAssistantId: null,
      text: "",
      thinking: "",
      runUsage: null,
      runCostUsd: null,
      terminalEvent,
      turnError: null,
      toolStates: new Map(),
    };

    /**
     * The thinking level this session is currently asking for.
     *
     * Kept here rather than read from `options` because a turn rejected for an
     * unusable effort lowers it, and the next turn must start from the level
     * that worked instead of walking back up into the same rejection.
     */
    let effort = options.effort;

    /** Whether this pi loaded YA's extension command; asked on first need. */
    let effortRetryCommandLoaded: Promise<boolean> | undefined;

    const unsubscribe = client.subscribe((event) => {
      runtime.lastRawProviderEventAt = new Date();
      runtime.lastRawProviderEventSource = `pi:event:${event.type}`;
      if (event.type === "agent_start") runStartedSinceSend = true;
      for (const sdk of this.mapEvent(event, sessionId, stream)) {
        events.push(sdk);
      }
      wake?.();
    });
    const onExit = () => {
      processExited = true;
      wake?.();
    };
    proc.once("exit", onExit);

    const abortHandler = () => {
      log.info({ sessionId }, "Aborting pi process");
      proc.kill("SIGTERM");
    };
    signal.addEventListener("abort", abortHandler);

    // Init message — resolves waitForSessionId().
    yield {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      cwd: options.cwd,
    } as SDKMessage;

    try {
      let isFirst = true;
      for await (const message of queue) {
        if (signal.aborted) break;

        let text = this.extractText(message);
        const images = this.extractImages(message);
        if (isFirst && options.globalInstructions) {
          text = `[Global context]\n${options.globalInstructions}\n\n---\n\n${text}`;
        }
        isFirst = false;

        yield {
          type: "user",
          uuid: message.uuid,
          session_id: sessionId,
          message: { role: "user", content: text },
        } as SDKMessage;

        // `agent_settled` flips this true after retries, compaction, and queued
        // continuations finish; the drain loop stops only at that boundary.
        let turnComplete = false;
        let effortRetries = 0;
        stream.currentAssistantId = null;
        stream.text = "";
        stream.thinking = "";
        stream.toolStates.clear();
        // A prompt that starts no run never reaches `agent_settled`: an
        // extension command or input handler consumed it (Pi 0.99+ reports
        // `disposition: "handled"`), or Pi rejected it before acceptance. Its
        // response ends the turn instead. A handled command may still start
        // its own run, so the turn ends only when none started and Pi reports
        // itself idle. Older Pi omits the disposition, and only the settled
        // event ends the turn there.
        let promptEnd: SDKMessage | null = null;
        let promptSends = 0;
        const sendPrompt = () => {
          const send = ++promptSends;
          runStartedSinceSend = false;
          const endTurn = (error?: string) => {
            if (send !== promptSends) return;
            promptEnd = {
              type: "result",
              session_id: sessionId,
              ...(error ? { error } : {}),
            } as SDKMessage;
            wake?.();
          };
          client
            .request(
              {
                type: "prompt",
                message: text,
                ...(images.length > 0 ? { images } : {}),
              },
              PI_PROMPT_RESPONSE_TIMEOUT_MS,
            )
            .then(async (response) => {
              if (send !== promptSends) return;
              if (!response.success) {
                endTurn(response.error ?? "pi rejected the prompt");
                return;
              }
              const disposition = (
                response.data as { disposition?: unknown } | undefined
              )?.disposition;
              if (disposition !== "handled" || runStartedSinceSend) return;
              const state = await client.request({ type: "get_state" }, 5000);
              if (
                runStartedSinceSend ||
                !state.success ||
                (state.data as PiSessionState).isStreaming === true
              ) {
                return;
              }
              endTurn();
            })
            .catch((error: unknown) => {
              log.debug(
                { sessionId, err: error },
                "pi prompt response unavailable; waiting for agent_settled",
              );
            });
        };
        sendPrompt();

        while (!turnComplete && !signal.aborted) {
          if (promptEnd && events.length === 0) {
            yield promptEnd;
            break;
          }
          while (events.length > 0) {
            const sdk = events.shift();
            if (!sdk) continue;
            if (sdk.type === "result") {
              // A turn the model server refused because of the thinking level
              // is retried lower rather than handed back as a failure: the
              // level came from a picker that offered it, so the user has no
              // way to know which of the offered levels this model takes.
              const lowered =
                sdk.error && effortRetries < MAX_EFFORT_RETRIES_PER_TURN
                  ? loweredEffortForRejection(String(sdk.error), effort)
                  : undefined;
              if (effort && lowered) {
                effortRetries += 1;
                const record: PiEffortRetryRecord = {
                  refusedLevel: effort,
                  retryLevel: lowered,
                  error: String(sdk.error),
                };
                effortRetryCommandLoaded ??= this.hasEffortRetryCommand(client);
                // Set aside before changing the level: pi records the level
                // change on its active branch, which the set-aside moves.
                const setAside =
                  (await effortRetryCommandLoaded) &&
                  (await this.setAsideRefusedTurn(client, record, sessionId));
                effort = lowered;
                await client
                  .request({ type: "set_thinking_level", level: lowered })
                  .catch(() => {});
                yield this.effortRetryNotice(sessionId, record, setAside);
                if (setAside) {
                  stream.currentAssistantId = null;
                  stream.text = "";
                  stream.thinking = "";
                  sendPrompt();
                  continue;
                }
              }
              turnComplete = true;
            }
            yield sdk;
          }
          if (turnComplete) break;
          if (processExited) {
            yield {
              type: "result",
              session_id: sessionId,
              error: "pi process exited mid-turn",
            } as SDKMessage;
            break;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, 200);
          });
          wake = null;
        }
      }
    } finally {
      unsubscribe();
      proc.off("exit", onExit);
      signal.removeEventListener("abort", abortHandler);
      if (!proc.killed) {
        proc.kill("SIGTERM");
      }
    }
  }

  /**
   * Map one pi AgentSessionEvent to zero or more YA SDKMessages.
   *
   * Streaming text/thinking are emitted as delta slices under a stable per-
   * message uuid (YA appends same-uuid assistant content). `agent_settled`
   * becomes a `result` carrying the run's summed usage — the drain loop's turn
   * boundary. `agent_end` only ends one low-level run and may precede automatic
   * retry, compaction, or queued continuation.
   */
  private mapEvent(
    event: { type: string; [key: string]: unknown },
    sessionId: string,
    stream: PiStreamState,
  ): SDKMessage[] {
    switch (event.type) {
      case "message_start": {
        // A fresh assistant message: mint a stable id and reset accumulators.
        const message = event.message as { role?: string } | undefined;
        if (message?.role === "assistant") {
          stream.currentAssistantId = mintAssistantId();
          stream.text = "";
          stream.thinking = "";
        }
        return [];
      }

      case "message_update": {
        const ame = event.assistantMessageEvent as
          | { type?: string; delta?: string }
          | undefined;
        if (!ame?.delta) return [];
        // YA merges same-uuid assistant messages by replacement (mergeMessage:
        // both-SDK -> keep newer), not by appending — so each emission must carry
        // the *cumulative* content, like codex-oss/gemini/grok. Emitting bare
        // deltas drops all but the final chunk (text appears truncated at the
        // start). Text and thinking get distinct stable uuids so their string vs
        // block-array content shapes don't clobber one another.
        if (!stream.currentAssistantId) {
          stream.currentAssistantId = mintAssistantId();
        }
        const baseId = stream.currentAssistantId;
        if (ame.type === "text_delta") {
          stream.text += ame.delta;
          return [
            {
              type: "assistant",
              session_id: sessionId,
              uuid: baseId,
              message: { role: "assistant", content: stream.text },
            } as SDKMessage,
          ];
        }
        if (ame.type === "thinking_delta") {
          stream.thinking += ame.delta;
          return [
            {
              type: "assistant",
              session_id: sessionId,
              uuid: `${baseId}-thinking`,
              message: {
                role: "assistant",
                content: [
                  { type: "thinking", thinking: stream.thinking },
                ] satisfies ContentBlock[],
              },
            } as SDKMessage,
          ];
        }
        return [];
      }

      case "message_end": {
        const message = event.message as
          | { stopReason?: unknown; errorMessage?: unknown }
          | undefined;
        if (message?.stopReason === "error") {
          stream.turnError =
            typeof message.errorMessage === "string" && message.errorMessage
              ? message.errorMessage
              : "pi reported a failed turn";
        }
        stream.currentAssistantId = null;
        stream.text = "";
        stream.thinking = "";
        return [];
      }

      case "turn_end": {
        const message = event.message as { usage?: unknown } | undefined;
        const mapped = mapPiUsage(message?.usage);
        if (mapped) {
          const run = stream.runUsage;
          stream.runUsage = run
            ? {
                input_tokens: run.input_tokens + mapped.usage.input_tokens,
                output_tokens: run.output_tokens + mapped.usage.output_tokens,
                cache_read_input_tokens:
                  run.cache_read_input_tokens +
                  mapped.usage.cache_read_input_tokens,
                cache_creation_input_tokens:
                  run.cache_creation_input_tokens +
                  mapped.usage.cache_creation_input_tokens,
              }
            : mapped.usage;
          if (mapped.costUsd !== null) {
            stream.runCostUsd = (stream.runCostUsd ?? 0) + mapped.costUsd;
          }
        }
        return [];
      }

      case "tool_execution_start": {
        const toolName = String(event.toolName ?? "tool");
        const id = String(event.toolCallId ?? "");
        const { name, input } = normalizePiTool(toolName, event.args ?? {});
        stream.toolStates.set(id, { name, input });
        return [this.makeToolUseMessage(sessionId, id, name, input)];
      }

      case "tool_execution_update": {
        const id = String(event.toolCallId ?? "");
        const state = stream.toolStates.get(id);
        if (state?.name !== "Bash") return [];
        const preview = normalizePiToolResult(
          state.name,
          event.partialResult,
          state.input,
          false,
        );
        if (preview === undefined) return [];
        state.input = { ...state.input, _previewResult: preview };
        stream.toolStates.set(id, state);
        return [
          this.makeToolUseMessage(sessionId, id, state.name, state.input),
        ];
      }

      case "tool_execution_end": {
        const id = String(event.toolCallId ?? "");
        const state =
          stream.toolStates.get(id) ??
          (() => {
            const normalized = normalizePiTool(
              String(event.toolName ?? "tool"),
              event.args ?? {},
            );
            return { name: normalized.name, input: normalized.input };
          })();
        const isError = event.isError === true;
        attachPiResultDetailToToolInput(state.name, state.input, event.result);
        const structured = normalizePiToolResult(
          state.name,
          event.result,
          state.input,
          isError,
        );
        const resultMessage: SDKMessage = {
          type: "user",
          session_id: sessionId,
          ...(structured !== undefined ? { toolUseResult: structured } : {}),
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: id,
                content: stringifyPiToolResult(event.result),
                is_error: isError,
              },
            ],
          },
        } as SDKMessage;
        const messages: SDKMessage[] = [resultMessage];
        if (state.input._rawPatch || state.input._previewResult) {
          messages.unshift(
            this.makeToolUseMessage(sessionId, id, state.name, state.input),
          );
        }
        stream.toolStates.delete(id);
        return messages;
      }

      case "agent_end":
      case "agent_settled": {
        if (event.type !== stream.terminalEvent) return [];
        const result: SDKMessage = {
          type: "result",
          session_id: sessionId,
          ...(stream.turnError ? { error: stream.turnError } : {}),
        } as SDKMessage;
        stream.turnError = null;
        if (stream.runUsage) {
          result.usage = stream.runUsage;
        }
        if (stream.runCostUsd !== null) {
          result.total_cost_usd = stream.runCostUsd;
        }
        stream.runUsage = null;
        stream.runCostUsd = null;
        return [result];
      }

      default:
        return [];
    }
  }

  /** Whether pi loaded YA's extension, so its command will not reach the model. */
  private async hasEffortRetryCommand(client: PiRpcClient): Promise<boolean> {
    try {
      const response = await client.request({ type: "get_commands" });
      const commands =
        (response.data as { commands?: { name?: unknown; source?: unknown }[] })
          ?.commands ?? [];
      return (
        response.success &&
        commands.some(
          (command) =>
            command.name === PI_EFFORT_RETRY_COMMAND &&
            command.source === "extension",
        )
      );
    } catch {
      return false;
    }
  }

  /**
   * Move pi's session back to before the refused prompt, recording the refusal.
   *
   * Sending the prompt again without this leaves it in the model context and
   * the session file twice: pi keeps the refused prompt and drops only its
   * error reply from what it sends. True only when the extension command ran
   * without an `extension_error`.
   */
  private async setAsideRefusedTurn(
    client: PiRpcClient,
    record: PiEffortRetryRecord,
    sessionId: string,
  ): Promise<boolean> {
    const failures: string[] = [];
    const stopObserving = client.onExtensionError((event) => {
      if (event.extensionPath === `command:${PI_EFFORT_RETRY_COMMAND}`) {
        failures.push(event.error ?? "unknown error");
      }
    });
    try {
      const response = await client.request({
        type: "prompt",
        message: `/${PI_EFFORT_RETRY_COMMAND} ${JSON.stringify(record)}`,
      });
      if (response.success && failures.length === 0) return true;
      getLogger().warn(
        { sessionId, failures, error: response.error },
        "pi: refused turn could not be set aside; not resending it",
      );
      return false;
    } catch (error) {
      getLogger().warn(
        { sessionId, error },
        "pi: refused turn could not be set aside; not resending it",
      );
      return false;
    } finally {
      stopObserving();
    }
  }

  /**
   * Say that the model refused the thinking level, and what happens next.
   *
   * An assistant message rather than a transient status: the user chose a level
   * the picker offered, and the record of the model refusing it belongs in the
   * transcript beside the answer that level did not produce. When the turn was
   * set aside, pi's session also holds the record, and the reader shows the
   * same text from it.
   */
  private effortRetryNotice(
    sessionId: string,
    record: PiEffortRetryRecord,
    resent: boolean,
  ): SDKMessage {
    return {
      type: "assistant",
      session_id: sessionId,
      uuid: `pi-effort-retry-${Date.now()}`,
      message: {
        role: "assistant",
        content: piEffortRetryNoticeText(record, resent),
      },
    } as SDKMessage;
  }

  private makeToolUseMessage(
    sessionId: string,
    id: string,
    name: string,
    input: Record<string, unknown>,
  ): SDKMessage {
    return {
      type: "assistant",
      session_id: sessionId,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id,
            name,
            input,
          },
        ],
      },
    } as SDKMessage;
  }

  private errorSession(errorMsg: string): AgentSession {
    const queue = new MessageQueue();
    return {
      iterator: (async function* () {
        yield { type: "error", error: errorMsg } as SDKMessage;
      })(),
      queue,
      abort: () => {},
    };
  }

  private extractText(message: SDKUserMessage): string {
    const content = message.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter(
          (block): block is { type: "text"; text: string } =>
            typeof block === "object" &&
            block !== null &&
            (block as { type?: unknown }).type === "text",
        )
        .map((block) => block.text)
        .join("\n");
    }
    return "";
  }

  private extractImages(message: SDKUserMessage): PiImageContent[] {
    const content = message.message?.content;
    if (!Array.isArray(content)) return [];
    const images: PiImageContent[] = [];
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as {
        type?: string;
        source?: { type?: string; media_type?: string; data?: string };
      };
      if (b.type === "image" && b.source?.type === "base64" && b.source.data) {
        images.push({
          type: "image",
          data: b.source.data,
          mimeType: b.source.media_type || "image/png",
        });
      }
    }
    return images;
  }

  private async findPiLaunchTarget(): Promise<PiLaunchTarget | null> {
    const envExecutable = process.env.PI_EXECUTABLE ?? process.env.PI_PATH;
    const explicitPath = envExecutable ?? this.configuredPath;
    if (explicitPath) {
      return resolvePiLaunchTarget(explicitPath);
    }
    const commonPaths = [
      join(homedir(), ".local", "bin", "pi"),
      "/usr/local/bin/pi",
      join(homedir(), "bin", "pi"),
      join(homedir(), ".bun", "bin", "pi"),
    ];
    for (const path of commonPaths) {
      const target = resolvePiLaunchTarget(path);
      if (target) return target;
    }
    try {
      const { stdout } = await execAsync(whichCommand("pi"), {
        encoding: "utf-8",
      });
      return selectPiLaunchTarget(stdout);
    } catch {
      // Not in PATH.
    }
    return null;
  }

  private async getPiTerminalEvent(
    piTarget: PiLaunchTarget,
  ): Promise<"agent_end" | "agent_settled" | null> {
    const cacheKey = `${piTarget.command}\0${piTarget.argsPrefix.join("\0")}`;
    const cached = this.cachedTerminalEvents.get(cacheKey);
    if (cached) return cached;
    try {
      const { stdout } = await execFileAsync(
        piTarget.command,
        buildPiLaunchArgs(piTarget, ["--version"]),
        { encoding: "utf-8" },
      );
      const usesAgentSettled = piVersionUsesAgentSettled(stdout);
      if (usesAgentSettled === null) return null;
      const terminalEvent = usesAgentSettled ? "agent_settled" : "agent_end";
      this.cachedTerminalEvents.set(cacheKey, terminalEvent);
      return terminalEvent;
    } catch (error) {
      getLogger().debug(
        { error, piPath: piTarget.sourcePath },
        "pi: version probe failed",
      );
      return null;
    }
  }
}

/** Default pi provider instance. */
export const piProvider = new PiProvider();
