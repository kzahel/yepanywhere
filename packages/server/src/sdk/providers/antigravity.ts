import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  fromUrlProjectId,
  parseNativeSessionId,
  type EffortLevel,
  type ModelInfo,
  type ModelCatalogStatus,
  type ProviderSubscriptionUsage,
  type SlashCommand,
} from "@yep-anywhere/shared";
import { MessageQueue } from "../messageQueue.js";
import type {
  ProviderCommandResult,
  SDKMessage,
  UserMessage,
} from "../types.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  StartSessionOptions,
} from "./types.js";
import { agentApiEnvironmentFor } from "./types.js";
import { startAgentSelfSession } from "./agent-self.js";
import { nativeStorageScope } from "./native-storage-scope.js";
import { getLogger } from "../../logging/logger.js";
import {
  fallbackModelCatalog,
  liveModelCatalog,
  modelCatalogError,
} from "./model-catalog-status.js";
import { ownAntigravitySession } from "./antigravity-owners.js";
import {
  AntigravityRuntime,
  antigravityRuntimeStoreDir,
  antigravitySessionsDir,
  findAntigravityRuntime,
  pinAntigravityLaunchToScope,
  resolveAntigravityRuntime,
  type AntigravityConfigOption,
  type AntigravitySessionSetup,
  type AntigravityUpdate,
} from "./antigravity-runtime.js";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  buildAntigravityModels,
  isAntigravityEffortLevel,
  splitAntigravityLegacyModel,
  findAntigravityConfigOption,
  resolveAntigravityModelSelection,
  resolveAntigravityTargetEffort,
} from "./antigravity-models.js";
import {
  AntigravitySplitSampler,
  antigravitySplitCheck,
} from "./antigravity-live-advance.js";
import {
  type AntigravityLiveProjection,
  EMPTY_ANTIGRAVITY_LOG,
} from "./antigravity-live-projection.js";
import { AntigravityTranscript } from "./antigravity-transcript.js";
import { AntigravityVersionError } from "./antigravity-version.js";
import { resumeAntigravitySession } from "./antigravity-resume.js";
import { AntigravityBackground } from "./antigravity-background.js";
import {
  canProbeAntigravityUsage,
  normalizeAntigravityUsage,
  probeAntigravityUsage,
} from "./antigravity-usage.js";
import { compactAntigravity } from "./antigravity-compaction.js";
import { AntigravitySubagentTracker } from "./antigravity-subagent-tracker.js";
import { readAntigravityMetadata } from "../../sessions/antigravity-metadata.js";
import type {
  AntigravityTranscriptPosition,
  AntigravityTurnScope,
} from "../../sessions/antigravity-subagent-links.js";

type Steer = (message: UserMessage) => boolean;
interface AntigravityControls {
  id?: string;
  steer?: Steer;
  commands: SlashCommand[];
  models?: ModelInfo[];
  compact?: (argument: string) => Promise<ProviderCommandResult>;
  setModel?: (model?: string) => Promise<void>;
  setEffort?: (effort?: EffortLevel) => Promise<void>;
  inputHeld?: boolean;
  onInputHoldChanged?: () => void;
  reconcileSubagents?: (options?: { silent?: boolean }) => void;
  /** From Stop until the cancelled prompts return, nothing is steered in. */
  stopping?: boolean;
  /** Counts Stops: one during a staged input's start cancels it unsent. */
  interrupts?: number;
  onInterrupt?: () => void;
  onConsumerIdle?: () => void;
}

/**
 * Session updates about state, not work: `agy` writes no log record for
 * them (a title arrives as `session_info_update` after a turn).
 */
const PASSIVE_STATE_UPDATES = new Set([
  "usage_update",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
]);

export class AntigravityProvider implements AgentProvider {
  readonly name = "antigravity" as const;
  readonly displayName = "Antigravity";
  readonly supportsNativeResumeSource = true;
  readonly supportsPermissionMode = true;
  readonly supportsThinkingToggle = true;
  readonly supportsSlashCommands = true;
  readonly supportsSteering = true;
  private catalog?: {
    at: number;
    models: ModelInfo[];
    error?: string;
    unsupportedVersion?: boolean;
  };
  private catalogRead?: Promise<ModelInfo[]>;
  private catalogStatus: ModelCatalogStatus | undefined;
  private usageRead?: {
    command: string;
    result: ReturnType<typeof probeAntigravityUsage>;
  };

  async isInstalled(): Promise<boolean> {
    return (await findAntigravityRuntime()) !== null;
  }
  async isAuthenticated(): Promise<boolean> {
    return (await this.getAuthStatus()).authenticated;
  }
  async getAuthStatus(): Promise<AuthStatus> {
    if (!(await this.isInstalled()))
      return { installed: false, authenticated: false, enabled: false };
    await this.getAvailableModels();
    // An agy below the floor is not a usable runtime; its refusal, naming
    // both versions and the update path, is the catalog error.
    if (this.catalog?.unsupportedVersion)
      return {
        installed: false,
        authenticated: false,
        enabled: false,
        unavailableReason: this.catalog.error,
      };
    const authenticated = !this.catalog?.error;
    return { installed: true, authenticated, enabled: authenticated };
  }
  getModelCatalogStatus(): ModelCatalogStatus | undefined {
    return this.catalogStatus;
  }

  async getSubscriptionUsage(
    models: readonly ModelInfo[],
  ): Promise<ProviderSubscriptionUsage | null> {
    if (!canProbeAntigravityUsage()) return null;
    const runtime = resolveAntigravityRuntime();
    if (runtime?.args.length !== 1) return null;

    if (!this.usageRead) {
      this.usageRead = {
        command: runtime.command,
        result: probeAntigravityUsage(runtime.command)
          .catch(() => null)
          .finally(() => {
            this.usageRead = undefined;
          }),
      };
    }
    if (this.usageRead.command !== runtime.command) return null;
    return normalizeAntigravityUsage(await this.usageRead.result, models);
  }

  async getNewSessionNamespace() {
    return {
      family: "antigravity" as const,
      storageScope: await nativeStorageScope(antigravitySessionsDir()),
    };
  }

  async getAvailableModels(options?: {
    forceRefresh?: boolean;
  }): Promise<ModelInfo[]> {
    // Join a read in progress first, so status and models read in the same
    // refresh describe the same runtime.
    if (this.catalogRead) return this.catalogRead;
    if (
      !options?.forceRefresh &&
      this.catalog &&
      Date.now() - this.catalog.at < 60_000
    )
      return this.catalog.models;
    this.catalogRead = this.readModels();
    try {
      return await this.catalogRead;
    } finally {
      this.catalogRead = undefined;
    }
  }

  private async readModels(): Promise<ModelInfo[]> {
    const runtime = new AntigravityRuntime();
    const cwd = await mkdtemp(join(tmpdir(), "ya-antigravity-models-"));
    let sessionId: string | undefined;
    let probeSessionsDir: string | undefined;
    let models: ModelInfo[] = [ANTIGRAVITY_DEFAULT_MODEL];
    let error: string | undefined;
    let unsupportedVersion = false;
    try {
      const command = await findAntigravityRuntime();
      if (!command)
        throw new Error("Install Google's Antigravity CLI (agy) first");
      probeSessionsDir = antigravityRuntimeStoreDir(command);
      await runtime.connect(command.command, cwd, command.args);
      const setup = await runtime.call<AntigravitySessionSetup>("session/new", {
        cwd,
        mcpServers: [],
      });
      sessionId = setup.sessionId;
      if (!sessionId)
        throw new Error("Antigravity did not return a session ID");
      models = buildAntigravityModels(setup);
      this.catalogStatus = liveModelCatalog();
    } catch (cause) {
      unsupportedVersion = cause instanceof AntigravityVersionError;
      error = modelCatalogError(cause);
      this.catalogStatus = fallbackModelCatalog(error);
    } finally {
      await runtime.close();
      // Reclaim only our blank native probe, after the owning child has exited.
      if (sessionId && probeSessionsDir && /^[0-9a-f-]{36}$/i.test(sessionId)) {
        const sessionsDir = probeSessionsDir;
        const base = join(sessionsDir, sessionId);
        const metadata = await readAntigravityMetadata(
          sessionsDir,
          sessionId,
        ).catch(() => null);
        const probeCwd = await realpath(cwd).catch(() => cwd);
        if (
          metadata &&
          (metadata.cwd === cwd ||
            (await realpath(metadata.cwd).catch(() => null)) === probeCwd)
        ) {
          await rm(join(dirname(sessionsDir), "brain", sessionId), {
            recursive: true,
            force: true,
          });
          for (const suffix of [".db", ".db-wal", ".db-shm", ".db-journal"])
            await rm(`${base}${suffix}`, { force: true });
        }
      }
      await rm(cwd, { recursive: true, force: true });
    }
    this.catalog = { at: Date.now(), models, error, unsupportedVersion };
    return models;
  }

  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    if (options.agentApi && this.supportsSteering)
      return startAgentSelfSession(this.name, options, (resolved) =>
        this.startSessionInternal(resolved),
      );
    return this.startSessionInternal(options);
  }

  private async validateResumeSource(
    options: StartSessionOptions,
    namespace: { family: "antigravity"; storageScope: string },
  ): Promise<void> {
    const source = options.nativeResumeSource;
    if (!source) return;
    if (
      !options.resumeSessionId ||
      source.native.family !== namespace.family ||
      source.native.id !== parseNativeSessionId(options.resumeSessionId) ||
      source.native.storageScope !== namespace.storageScope ||
      !source.filePath ||
      (await realpath(source.filePath)) !==
        join(namespace.storageScope, `${source.native.id}.db`) ||
      (await realpath(fromUrlProjectId(source.projectId))) !==
        (await realpath(options.cwd))
    ) {
      throw new Error(
        "Antigravity continuation requires its original native store and project",
      );
    }
  }

  private async startSessionInternal(
    options: StartSessionOptions,
  ): Promise<AgentSession> {
    if (options.executor || options.sessionSandbox)
      throw new Error("Antigravity supports ordinary local sessions only");
    if (options.permissionMode === "plan")
      throw new Error(
        "Use Antigravity's native /plan command with the default permission mode",
      );
    if (options.nativeResumeSource) {
      await this.validateResumeSource(
        options,
        await this.getNewSessionNamespace(),
      );
    }
    const controls: AntigravityControls = { commands: [] };
    const queue = Object.assign(new MessageQueue(), {
      setConfigurationInputHeld(held: boolean) {
        controls.inputHeld = held;
        controls.onInputHoldChanged?.();
      },
      // The one point where approvals held at a turn's or command's end are
      // put to the user: Process is idle and will show them.
      onConsumerIdle() {
        controls.onConsumerIdle?.();
      },
    });
    if (options.initialMessage) queue.push(options.initialMessage);
    const runtime = new AntigravityRuntime();
    const controller = new AbortController();
    const background = new AntigravityBackground(
      options.onProviderRetentionChange,
    );
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    void ready.catch(() => undefined);
    const supportsThinking = this.supportsThinkingToggle;
    return {
      queue,
      iterator: this.run(
        runtime,
        queue,
        options,
        controller.signal,
        background,
        controls,
        resolveReady,
        rejectReady,
      ),
      ...(this.supportsSteering
        ? {
            steer: async (message: UserMessage) =>
              controls.steer?.(message) ?? false,
            steerConsumptionReported: true,
          }
        : {}),
      supportedModels: async () => controls.models ?? this.getAvailableModels(),
      setModel: async (model?: string) => {
        await ready;
        if (!controls.setModel)
          throw new Error("Antigravity session cannot change models");
        await controls.setModel(model);
      },
      ...(supportsThinking
        ? {
            effortUpdatesActiveTurn: true,
            setEffort: async (effort?: EffortLevel) => {
              await ready;
              if (!controls.setEffort)
                throw new Error(
                  "Antigravity session does not support live effort changes",
                );
              await controls.setEffort(effort);
            },
          }
        : {}),
      supportedCommands: async () => controls.commands,
      runProviderCommand: async (command, argument = "") =>
        command === "compact" && controls.compact
          ? controls.compact(argument)
          : { handled: false },
      getProviderRetention: () => {
        controls.reconcileSubagents?.({ silent: true });
        return background.snapshot();
      },
      retentionReadReconciles: true,
      abort: async () => {
        controller.abort();
        await runtime.close();
      },
      interrupt: async () => {
        if (!controls.id || !runtime.alive) return false;
        controls.interrupts = (controls.interrupts ?? 0) + 1;
        controls.onInterrupt?.();
        // A follow-up sent now falls back to the queue: agy refuses a
        // prompt while it is cancelling the current one.
        if (controls.steer) controls.stopping = true;
        runtime.cancel(controls.id);
        return true;
      },
      get pid() {
        return runtime.pid;
      },
      isProcessAlive: () => runtime.alive,
    };
  }

  /**
   * Asks while both the session and the request are live. The listeners on
   * the long-lived session signal are removed when the answer settles, so a
   * completed approval is not retained for the session's lifetime (as an
   * `AbortSignal.any` composite with a live source would be).
   */
  private async permissionUntil(
    params: Record<string, unknown>,
    options: StartSessionOptions,
    session: AbortSignal,
    request: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (session.aborted || request.aborted) abort();
    session.addEventListener("abort", abort, { once: true });
    request.addEventListener("abort", abort, { once: true });
    try {
      return await this.permission(params, options, controller.signal);
    } finally {
      session.removeEventListener("abort", abort);
      request.removeEventListener("abort", abort);
    }
  }

  private async permission(
    params: Record<string, unknown>,
    options: StartSessionOptions,
    signal: AbortSignal,
  ): Promise<unknown> {
    const cancelled = { outcome: { outcome: "cancelled" } };
    if (signal.aborted || !options.onToolApproval) return cancelled;
    const tool = params.toolCall as {
      toolCallId: string;
      title?: string;
      rawInput?: unknown;
    };
    const choices = params.options as Array<{
      optionId: string;
      name: string;
      kind: string;
    }>;
    if (!tool || !Array.isArray(choices)) return cancelled;
    const question = tool.toolCallId.startsWith("interaction_");
    const prompt = tool.title || "Choose an option";
    const result = await options.onToolApproval(
      question ? "AskUserQuestion" : tool.title || "Antigravity tool",
      question
        ? {
            questions: [
              {
                question: prompt,
                header: "Question",
                multiSelect: false,
                allowCustomAnswer: false,
                options: choices.map((choice) => ({
                  label: choice.name,
                  description: choice.name,
                })),
              },
            ],
          }
        : { ...tool, input: tool.rawInput },
      { signal },
    );
    if (signal.aborted) return cancelled;
    let choice: (typeof choices)[number] | undefined;
    if (question && result.behavior === "allow") {
      const answers = (
        result.updatedInput as
          | { answers?: Record<string, string | string[]> }
          | undefined
      )?.answers;
      const answer = answers?.[prompt];
      const label = Array.isArray(answer) ? answer[0] : answer;
      choice = choices.find(
        (entry) => entry.name === label || entry.optionId === label,
      );
    } else if (!question) {
      // Never invent option IDs or expand Allow once to Allow always.
      choice = choices.find(
        (entry) =>
          entry.kind ===
          (result.behavior === "allow" ? "allow_once" : "reject_once"),
      );
    }
    return choice
      ? { outcome: { outcome: "selected", optionId: choice.optionId } }
      : cancelled;
  }

  private async *run(
    runtime: AntigravityRuntime,
    queue: MessageQueue,
    options: StartSessionOptions,
    signal: AbortSignal,
    background: AntigravityBackground,
    controls: AntigravityControls,
    resolveReady: () => void,
    rejectReady: (error: Error) => void,
  ): AsyncIterableIterator<SDKMessage> {
    let settledReady = false;
    const markReady = () => {
      if (settledReady) return;
      settledReady = true;
      resolveReady();
    };
    const failReady = (error: unknown) => {
      if (settledReady) return;
      settledReady = true;
      rejectReady(
        error instanceof Error ? error : new Error(String(error ?? "closed")),
      );
    };
    const input = queue[Symbol.asyncIterator]();
    let owner: ReturnType<typeof ownAntigravitySession> | undefined;
    let liveWindow: AntigravityLiveProjection | undefined;
    let subagents: AntigravitySubagentTracker | undefined;
    let unobserveSummaries: (() => void) | undefined;
    let wake: (() => void) | undefined;
    const changed = () => {
      wake?.();
      wake = undefined;
    };
    const waitForChange = () =>
      new Promise<void>((resolve) => {
        wake = resolve;
      });
    const stop = () => {
      void input.return?.();
      changed();
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      if (signal.aborted) return;
      const command = await findAntigravityRuntime();
      if (!command)
        throw new Error(
          "Install Google's Antigravity CLI (agy) and sign in with it first",
        );
      const launchEnvironment = agentApiEnvironmentFor(options);
      // Derive the live storage scope from the exact launch command
      // used to spawn ACP, and revalidate the resume source against it before
      // acquiring ownership or launching ACP.
      const namespace = {
        family: "antigravity" as const,
        storageScope: await nativeStorageScope(
          antigravityRuntimeStoreDir(command),
        ),
      };
      await this.validateResumeSource(options, namespace);
      // Held before `agy` starts, so every write it makes is YA's own.
      if (options.resumeSessionId)
        owner = ownAntigravitySession(
          namespace.storageScope,
          options.resumeSessionId,
          options.nativeOwnerHost,
        );
      runtime.onPermission = (params, requestSignal) =>
        this.permissionUntil(params, options, signal, requestSignal);
      // agy offers no bypass mode; that session's server skips permissions.
      const skipPermissions = options.permissionMode === "bypassPermissions";
      // Pin the concrete profile path passed to ACP to the verified physical
      // storage scope so a mutable symlink (including below the profile root)
      // cannot redirect ACP at spawn time. Reject if pinning is impossible.
      const pinned = pinAntigravityLaunchToScope(
        command,
        namespace.storageScope,
        launchEnvironment,
      );
      if (!pinned) {
        throw new Error(
          "Antigravity continuation requires its original native store and project",
        );
      }
      await runtime.connect(
        command.command,
        options.cwd,
        [
          ...pinned.args,
          ...(skipPermissions ? ["--dangerously-skip-permissions"] : []),
        ],
        pinned.env,
      );
      void runtime.closed.then(stop);
      if (options.agentApiInstructions && !runtime.canAppendSystemPrompt)
        throw new Error(
          "This agy runtime does not support native Agent API instructions",
        );
      const observeCommands = (update: AntigravityUpdate) => {
        if (
          update.sessionUpdate !== "available_commands_update" ||
          !Array.isArray(update.availableCommands)
        )
          return false;
        const commands = update.availableCommands
          .slice(0, 128)
          .filter((command) => typeof command?.name === "string")
          .map(({ name, description, input }) => ({
            name: name.slice(0, 128),
            description:
              typeof description === "string" ? description.slice(0, 1000) : "",
            argumentHint:
              typeof input?.hint === "string"
                ? input.hint.slice(0, 500)
                : undefined,
          }));
        if (JSON.stringify(commands) === JSON.stringify(controls.commands))
          return false;
        controls.commands = commands;
        return true;
      };
      const setupParams = {
        cwd: options.cwd,
        mcpServers: [] as [],
        ...(options.agentApiInstructions
          ? {
              _meta: {
                antigravity: {
                  systemPrompt: { append: options.agentApiInstructions },
                },
              },
            }
          : {}),
      };
      runtime.onUpdate = observeCommands;
      const resumeId = options.resumeSessionId;
      // A new session's log is empty.
      const opened = resumeId
        ? await resumeAntigravitySession({
            runtime,
            scope: namespace.storageScope,
            params: { ...setupParams, sessionId: resumeId },
            // An unreadable summaries index counts as prompted.
            neverPrompted: async () =>
              (
                await readAntigravityMetadata(
                  namespace.storageScope,
                  resumeId,
                ).catch(() => null)
              )?.stepCount === 0,
            authorize: () => !signal.aborted,
          })
        : {
            setup: await runtime.call<AntigravitySessionSetup>(
              "session/new",
              setupParams,
            ),
            boundary: EMPTY_ANTIGRAVITY_LOG,
          };
      if (!opened) return;
      const { setup, boundary } = opened;
      // A failed resume is terminal; never create a fresh native conversation.
      const id = parseNativeSessionId(
        options.resumeSessionId || setup.sessionId,
      );
      owner ??= ownAntigravitySession(
        namespace.storageScope,
        id,
        options.nativeOwnerHost,
      );
      controls.id = id;
      controls.models = buildAntigravityModels(setup);
      let configOptions: AntigravityConfigOption[] = setup.configOptions ?? [];
      const initialModel = resolveAntigravityModelSelection(
        configOptions,
        setup.models?.currentModelId,
      );
      let resolvedModel = initialModel;
      const currentThought = () =>
        findAntigravityConfigOption(configOptions, "thought_level");
      let defaultEffort = currentThought()?.currentValue;
      // One observed Auto level per model in this session's native catalog.
      const autoEfforts = new Map<string, string>();
      if (resolvedModel && defaultEffort)
        autoEfforts.set(resolvedModel, defaultEffort);
      let hasExplicitEffortOverride = false;
      let pendingConfigCount = 0;
      const inputHeld = () => controls.inputHeld || pendingConfigCount > 0;
      controls.onInputHoldChanged = changed;
      controls.onInterrupt = changed;
      // After the current call stack, so the approval opens once Process
      // has finished its idle transition.
      controls.onConsumerIdle = () => queueMicrotask(() => runtime.turnEnded());
      let configTail = Promise.resolve();
      const serializeConfig = <T>(operation: () => Promise<T>): Promise<T> => {
        pendingConfigCount++;
        const runOp = async () => {
          try {
            return await operation();
          } finally {
            pendingConfigCount--;
            changed();
          }
        };
        const next = configTail.then(runOp, runOp);
        configTail = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      };
      const applyModelSelection = async (
        requested: string | undefined,
        keepInitialWhenDefault: boolean,
      ) => {
        const explicit =
          requested && requested !== "default" && requested !== "auto"
            ? requested
            : undefined;
        const target =
          explicit ?? (keepInitialWhenDefault ? undefined : initialModel);
        if (!target) return;
        const modelOption = findAntigravityConfigOption(configOptions, "model");
        const legacy = splitAntigravityLegacyModel(target, controls.models);
        const base = legacy?.modelId ?? target;
        const override = hasExplicitEffortOverride
          ? currentThought()?.currentValue
          : undefined;
        if (base !== resolvedModel) {
          if (!modelOption?.options?.some((entry) => entry.value === base)) {
            throw new Error(`Antigravity does not offer model "${target}"`);
          }
          // agy carries a compatible effort across base models. Clear an
          // explicit override first so the target inherits the Auto baseline.
          if (override)
            await applyThinkingSelection(undefined, undefined, true);
          const response = await runtime.call<{
            configOptions?: AntigravityConfigOption[];
          }>("session/set_config_option", {
            sessionId: id,
            configId: modelOption.id,
            value: base,
          });
          if (Array.isArray(response?.configOptions))
            configOptions = response.configOptions;
          resolvedModel = resolveAntigravityModelSelection(configOptions, base);
          const observed = currentThought()?.currentValue;
          defaultEffort =
            (resolvedModel && autoEfforts.get(resolvedModel)) || observed;
          if (resolvedModel && defaultEffort)
            autoEfforts.set(resolvedModel, defaultEffort);
          if (observed !== defaultEffort)
            await applyThinkingSelection(undefined, undefined, true);
        }
        const selectedEffort =
          legacy?.embeddedEffort ??
          (isAntigravityEffortLevel(override) ? override : undefined);
        if (
          selectedEffort &&
          currentThought()?.options?.some(
            (entry) => entry.value === selectedEffort,
          )
        ) {
          await applyThinkingSelection(undefined, selectedEffort, false);
        }
      };
      const applyThinkingSelection = async (
        thinking: StartSessionOptions["thinking"],
        effort: StartSessionOptions["effort"],
        restoreModelDefault: boolean,
      ) => {
        const thoughtOption = currentThought();
        const offered =
          thoughtOption?.options?.map((entry) => entry.value) ?? [];
        let target = resolveAntigravityTargetEffort(thinking, effort, offered);
        if (!thoughtOption) {
          if (effort !== undefined)
            throw new Error(
              `Model "${resolvedModel ?? "current"}" does not support configurable thinking levels`,
            );
          hasExplicitEffortOverride = false;
          return;
        }
        if (!target && restoreModelDefault && effort === undefined) {
          if (!defaultEffort && hasExplicitEffortOverride) {
            throw new Error(
              `Cannot restore default thinking level for model "${resolvedModel ?? "current"}"`,
            );
          }
          target = defaultEffort;
        }
        if (!target) return;
        if (thoughtOption.currentValue !== target) {
          const response = await runtime.call<{
            configOptions?: AntigravityConfigOption[];
          }>("session/set_config_option", {
            sessionId: id,
            configId: thoughtOption.id,
            value: target,
          });
          if (Array.isArray(response?.configOptions)) {
            configOptions = response.configOptions;
            resolvedModel = resolveAntigravityModelSelection(
              configOptions,
              resolvedModel,
            );
          }
        }
        hasExplicitEffortOverride =
          effort !== undefined || thinking?.type === "disabled";
      };
      await applyModelSelection(options.model, true);
      await applyThinkingSelection(options.thinking, options.effort, false);
      controls.setModel = (model) =>
        serializeConfig(() => applyModelSelection(model, false));
      if (findAntigravityConfigOption(configOptions, "model")) {
        controls.setEffort = (effort) =>
          serializeConfig(() =>
            applyThinkingSelection(undefined, effort, true),
          );
      }
      // Use only offered native modes. Bypass already launched with its flag.
      const offered = new Set(
        setup.modes?.availableModes.map((entry) => entry.id) ?? ["default"],
      );
      const wanted =
        options.permissionMode === "acceptEdits"
          ? "accept-edits"
          : options.permissionMode === "auto"
            ? "auto"
            : "default";
      const mode = offered.has(wanted) ? wanted : undefined;
      if (!mode && options.permissionMode)
        throw new Error(
          `Antigravity does not offer the ${options.permissionMode} permission mode`,
        );
      if (mode && options.permissionMode && mode !== setup.modes?.currentModeId)
        await runtime.call("session/set_mode", { sessionId: id, modeId: mode });
      // Rows leave memory only past the soft budget, at a proven split
      // point; a log YA cannot read proves none, and the cap bounds them.
      const live = owner.open(
        boundary,
        antigravitySplitCheck(namespace.storageScope, id),
        "earlier" in opened ? opened.earlier : undefined,
        options.markOutputDelivery,
      );
      liveWindow = live;
      const sampler = new AntigravitySplitSampler(namespace.storageScope, id);
      sampler.prepare();
      // The log as the resume left it, for telling another writer's appends.
      sampler.settle();
      markReady();
      yield {
        type: "system",
        subtype: "init",
        session_id: id,
        cwd: options.cwd,
        model: resolvedModel,
        slash_command_inventory: controls.commands,
      };
      const updates: SDKMessage[] = [];
      const publish = (
        converted: SDKMessage,
        attributionModel = resolvedModel,
      ) => {
        if (
          converted.type === "assistant" &&
          converted.message &&
          attributionModel
        ) {
          converted.message.model = attributionModel;
          converted._selectedProviderModel = resolvedModel;
        }
        // A block still streaming stays marked, so a client that reads it
        // keeps following its stream; its commit replaces it.
        live.record(converted);
        if (updates.at(-1)?.uuid === converted.uuid)
          updates[updates.length - 1] = converted;
        else updates.push(converted);
        changed();
      };
      let foregroundUpdate: ((update: AntigravityUpdate) => void) | undefined;
      let passiveTranscript: AntigravityTranscript | undefined;
      let compacting = false;
      subagents = new AntigravitySubagentTracker({
        sessionId: id,
        storageScope: namespace.storageScope,
        signal,
        background,
        isInTurn: () => !!foregroundUpdate,
        publish,
        onProviderRetentionChange: options.onProviderRetentionChange,
      });
      await subagents.initialize(Boolean(options.resumeSessionId));
      const reconcileRoot = (silent = false) => {
        if (
          foregroundUpdate ||
          compacting ||
          !background.needsSummaryObservation()
        )
          return;
        const changed =
          subagents?.supportsRootSettlement() === false
            ? background.stopTrackingRoot()
            : background.reconcileRoot(() => subagents?.readRootSummary());
        if (!changed) return;
        const notify = () => {
          if (!signal.aborted) options.onProviderRetentionChange?.();
        };
        if (silent) queueMicrotask(notify);
        else notify();
      };
      controls.reconcileSubagents = (opts) => {
        subagents?.reconcile(opts);
        reconcileRoot(opts?.silent);
      };
      unobserveSummaries = options.observeAntigravitySummaries?.(
        namespace.storageScope,
        () => {
          if (
            signal.aborted ||
            !runtime.alive ||
            !background.needsSummaryObservation()
          )
            return;
          subagents?.reconcile();
          reconcileRoot();
        },
      );
      if (unobserveSummaries && subagents.supportsRootSettlement() !== false)
        background.trackRoot();
      controls.compact = async (argument) => {
        if (compacting || foregroundUpdate || inputHeld())
          return {
            handled: true,
            error: "Wait for the active Antigravity turn or queue compaction",
          };
        if (!controls.commands.some((command) => command.name === "compact"))
          return {
            handled: true,
            error: "This Antigravity session does not advertise compaction",
          };
        compacting = true;
        sampler.unsettle();
        try {
          const result = await compactAntigravity(
            runtime,
            namespace.storageScope,
            id,
            argument,
          );
          if (result.completion === "completed") {
            publish({
              type: "system",
              subtype: "compact_boundary",
              uuid: randomUUID(),
              session_id: id,
            });
            await subagents?.onCompacted();
          }
          return result;
        } finally {
          compacting = false;
          sampler.settle();
          runtime.endingTurn();
          reconcileRoot();
          changed();
        }
      };
      runtime.onUpdate = (update, updateSessionId) => {
        if (
          updateSessionId !== id ||
          update.sessionUpdate === "user_message_chunk"
        )
          return;
        if (
          update.sessionUpdate === "config_option_update" &&
          Array.isArray(update.configOptions)
        ) {
          configOptions = update.configOptions;
          const selected = resolveAntigravityModelSelection(
            configOptions,
            resolvedModel,
          );
          if (
            pendingConfigCount === 0 &&
            selected &&
            selected !== resolvedModel
          ) {
            defaultEffort = autoEfforts.get(selected);
            const observed = currentThought()?.currentValue;
            if (!defaultEffort && observed && !hasExplicitEffortOverride) {
              defaultEffort = observed;
              autoEfforts.set(selected, observed);
            }
          }
          resolvedModel = selected;
          return;
        }
        if (observeCommands(update))
          publish({
            type: "system",
            subtype: "command_inventory",
            uuid: randomUUID(),
            session_id: id,
            slash_command_inventory: controls.commands,
          });
        background.observe(update, !!foregroundUpdate || compacting);
        if (foregroundUpdate) {
          foregroundUpdate(update);
        } else if (!compacting) {
          // A detached wake has no prompt result in ACP. Publish each received
          // snapshot without inventing a foreground turn or completion.
          // Detached work (a wake) writes the log: not another writer.
          if (!PASSIVE_STATE_UPDATES.has(update.sessionUpdate))
            sampler.unsettle();
          passiveTranscript ??= new AntigravityTranscript(
            id,
            `${id}:${randomUUID()}`,
          );
          const passiveOut = passiveTranscript.accept(update);
          for (const { _isStreaming: _partial, ...converted } of passiveOut)
            publish({ ...converted, _passiveProviderUpdate: true });
          if (
            update.sessionUpdate === "tool_call_update" &&
            update.status === "completed" &&
            update.toolCallId
          ) {
            subagents?.resolveCall(
              passiveTranscript,
              update.toolCallId,
              resolvedModel,
              false,
              passiveOut,
              undefined,
            );
          }
          subagents?.reconcile({ inTurn: false });
          if (update.sessionUpdate === "usage_update") reconcileRoot();
        }
      };
      let nextInput: Awaited<ReturnType<typeof input.next>> | undefined;
      let inputError: unknown;
      let firstPrompt = !options.resumeSessionId;
      while (!signal.aborted && runtime.alive) {
        void input.next().then(
          (result) => {
            nextInput = result;
            changed();
          },
          (error) => {
            inputError = error;
            changed();
          },
        );
        while (!signal.aborted && runtime.alive) {
          if (updates.length) yield updates.shift()!;
          else if (inputError) throw inputError;
          else if (nextInput && !compacting && !inputHeld()) break;
          else await waitForChange();
        }
        if (signal.aborted || nextInput?.done || !nextInput) break;
        const message = nextInput.value;
        nextInput = undefined;
        passiveTranscript = undefined;
        const uuid = message.uuid || randomUUID();
        const content = message.message.content;
        const text =
          typeof content === "string"
            ? content
            : content
                .map((block) => {
                  if (block.type !== "text")
                    throw new Error(
                      "The experimental Antigravity provider accepts text and file references only",
                    );
                  return block.text;
                })
                .join("\n");
        const interrupts = controls.interrupts;
        const promptStartedAt = new Date();
        let initialStartPosition = await subagents.readStartPosition();
        // A hold or a command that arrived during the read is waited out,
        // under the same Stop, and the position read again.
        while (
          (inputHeld() || compacting) &&
          !signal.aborted &&
          runtime.alive &&
          controls.interrupts === interrupts
        ) {
          if (updates.length) yield updates.shift()!;
          else await waitForChange();
          // Stopped, aborted or gone: leave without reading again.
          if (
            controls.interrupts !== interrupts ||
            signal.aborted ||
            !runtime.alive
          )
            break;
          if (!inputHeld() && !compacting)
            initialStartPosition = await subagents.readStartPosition();
        }
        if (signal.aborted) break;
        // Stopped before it was sent: the input is cancelled, never sent.
        if (controls.interrupts !== interrupts) {
          yield { type: "result", session_id: id };
          continue;
        }
        const transcript = new AntigravityTranscript(id, `${id}:${uuid}`);
        let activePromptScope: AntigravityTurnScope | undefined;
        let activePromptCallIds = new Set<string>();
        const turnPromptScopes: AntigravityTurnScope[] = [];
        const verifiedOnProgress = new Set<AntigravityTurnScope>();
        const callScopes = new Map<
          string,
          { scope: AntigravityTurnScope | undefined; callIds: Set<string> }
        >();
        const creatingSession = firstPrompt;
        firstPrompt = false;
        let observedOriginal = false;
        const acknowledgeOriginal = () => {
          if (observedOriginal || signal.aborted) return;
          observedOriginal = true;
          options.onNativeInputConsumed?.(id, uuid);
        };
        let activeTurnModel = resolvedModel;
        foregroundUpdate = (update) => {
          // A new session's log exists once its first turn has output.
          sampler.prepare();
          // A new owner has no earlier turn that could produce this output.
          // Confirm startup on native progress so the first turn can be steered.
          if (
            creatingSession &&
            (update.sessionUpdate === "agent_message_chunk" ||
              update.sessionUpdate === "agent_thought_chunk" ||
              update.sessionUpdate === "tool_call")
          )
            acknowledgeOriginal();
          // Verify and advance the prompt's USER_INPUT anchor on first native
          // progress (even on ordinary prompts with no subagent calls and >4 MiB
          // of subsequent turn output) so later turns never drift off the tail.
          if (
            activePromptScope &&
            activePromptScope.verifiedUserStep === undefined &&
            !verifiedOnProgress.has(activePromptScope) &&
            (update.sessionUpdate === "agent_message_chunk" ||
              update.sessionUpdate === "agent_thought_chunk" ||
              update.sessionUpdate === "tool_call")
          ) {
            verifiedOnProgress.add(activePromptScope);
            subagents?.schedulePromptAnchorVerification(activePromptScope);
          }
          const emitted = transcript.accept(update);
          for (const converted of emitted) publish(converted, activeTurnModel);
          if (
            update.toolCallId &&
            transcript.getSubagentCall(update.toolCallId) &&
            !callScopes.has(update.toolCallId)
          ) {
            activePromptCallIds.add(update.toolCallId);
            callScopes.set(update.toolCallId, {
              scope: activePromptScope,
              callIds: activePromptCallIds,
            });
          }
          if (
            update.sessionUpdate === "tool_call_update" &&
            update.status === "completed" &&
            update.toolCallId
          ) {
            const binding = callScopes.get(update.toolCallId);
            subagents?.resolveCall(
              transcript,
              update.toolCallId,
              activeTurnModel,
              true,
              emitted,
              binding?.scope ?? activePromptScope,
              binding?.callIds,
            );
          }
          changed();
        };
        let pending = 0;
        let failure: unknown;
        let usage: unknown;
        const prompt = (
          promptText: string,
          inputId: string,
          steer?: UserMessage,
          promptStartPosition?: AntigravityTranscriptPosition,
        ) => {
          if (steer) {
            const previous = transcript.close();
            if (previous) publish(previous, activeTurnModel);
            activeTurnModel = resolvedModel;
          }
          activePromptScope = subagents?.beginPrompt(
            promptText,
            promptStartPosition,
          );
          if (activePromptScope) turnPromptScopes.push(activePromptScope);
          activePromptCallIds = new Set<string>();
          const seq = live.seq;
          publish({
            type: "user",
            uuid: inputId,
            session_id: id,
            timestamp: new Date().toISOString(),
            message: { role: "user", content: promptText },
          });
          // A turn's first prompt is sent only while idle: a split candidate.
          const candidate = !steer
            ? sampler.sample(
                seq,
                background.working ? undefined : runtime.lastActivityMs,
              )
            : undefined;
          if (candidate === "foreign") {
            live.foreignWrite();
            getLogger().warn(
              { event: "antigravity_foreign_write_while_owned", sessionId: id },
              "Another program wrote an Antigravity conversation YA owns; its split candidates were dropped",
            );
          } else if (candidate) live.addCandidate(candidate);
          pending++;
          void runtime
            .call<{ usage?: unknown; stopReason?: string }>(
              "session/prompt",
              { sessionId: id, prompt: [{ type: "text", text: promptText }] },
              0,
            )
            .then((response) => {
              usage = response?.usage ?? usage;
              if (!signal.aborted && response?.stopReason === "end_turn") {
                if (steer) {
                  options.onNativeInputConsumed?.(id, inputId);
                  queue.acknowledgeNativeSteer(steer);
                } else {
                  acknowledgeOriginal();
                }
              }
            })
            .catch((error) => {
              failure ??= error;
            })
            .finally(() => {
              if (--pending === 0) {
                controls.steer = undefined;
                controls.stopping = false;
              }
              changed();
            });
          changed();
        };
        prompt(text, uuid, undefined, initialStartPosition);
        controls.steer = (input) => {
          if (
            signal.aborted ||
            !runtime.alive ||
            controls.stopping ||
            inputHeld() ||
            failure ||
            pending >= 8 ||
            input.images?.length ||
            input.documents?.length
          )
            return false;
          prompt(
            input.text,
            input.uuid ?? randomUUID(),
            input,
            subagents?.readStartPositionSync(),
          );
          return true;
        };
        while (pending || updates.length) {
          if (updates.length) {
            yield updates.shift()!;
            continue;
          }
          await waitForChange();
        }
        foregroundUpdate = undefined;
        await subagents.drainPending();
        // Retry any completed (non-failed) invoke_subagent call whose
        // transcript.jsonl entry had not flushed yet when tool_call_update arrived.
        for (const call of transcript.listSubagentCalls()) {
          if (
            call.completed &&
            !call.failed &&
            !subagents.isCallResolved(call.toolUseId)
          ) {
            const binding = callScopes.get(call.toolUseId);
            subagents.resolveCall(
              transcript,
              call.toolUseId,
              activeTurnModel,
              true,
              [],
              binding?.scope ?? activePromptScope,
              binding?.callIds,
            );
          }
        }
        await subagents.drainPending();
        // Verify and advance the anchor for every prompt submitted in this turn
        // (including ordinary prompts with zero subagent calls) before cleanup.
        for (const promptScope of turnPromptScopes) {
          if (promptScope.verifiedUserStep === undefined) {
            subagents.schedulePromptAnchorVerification(promptScope);
          }
        }
        await subagents.drainPending();
        subagents.releasePromptScopes(turnPromptScopes);
        while (updates.length) yield updates.shift()!;
        background.foregroundSettled(failure ? undefined : promptStartedAt);
        subagents.reconcile({ inTurn: false });
        reconcileRoot();
        const last = transcript.close();
        if (last) {
          publish(last, activeTurnModel);
          yield updates.shift()!;
        }
        if (failure) throw failure;
        runtime.endingTurn();
        sampler.settle();
        yield { type: "result", session_id: id, usage };
      }
    } catch (error) {
      failReady(error);
      if (!signal.aborted)
        yield {
          type: "error",
          error: error instanceof Error ? error.message : String(error),
        };
    } finally {
      liveWindow?.close();
      failReady(new Error("Antigravity session closed before initialization"));
      controls.steer = undefined;
      controls.compact = undefined;
      controls.setModel = undefined;
      controls.setEffort = undefined;
      controls.onInputHoldChanged = undefined;
      controls.onInterrupt = undefined;
      controls.onConsumerIdle = undefined;
      controls.reconcileSubagents = undefined;
      unobserveSummaries?.();
      subagents?.close();
      subagents = undefined;
      background.clear();
      signal.removeEventListener("abort", stop);
      await input.return?.();
      await runtime.close();
      owner?.release();
    }
  }
}

export const antigravityProvider = new AntigravityProvider();
