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
import {
  fallbackModelCatalog,
  liveModelCatalog,
  modelCatalogError,
} from "./model-catalog-status.js";
import {
  AntigravityRuntime,
  antigravityRuntimeStoreDir,
  ownAntigravitySession,
  ownAntigravitySessionAfterReads,
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
import { AntigravityTranscript } from "./antigravity-transcript.js";
import { loadAntigravityReplay } from "./antigravity-replay.js";
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
}

export class AntigravityProvider implements AgentProvider {
  readonly name = "antigravity" as const;
  readonly displayName = "Antigravity";
  readonly supportsNativeResumeSource = true;
  readonly supportsPermissionMode = true;
  get supportsThinkingToggle(): boolean {
    return resolveAntigravityRuntime()?.layout === "cli";
  }
  readonly supportsSlashCommands = true;
  get supportsSteering(): boolean {
    return resolveAntigravityRuntime()?.layout === "cli";
  }
  private catalog?: { at: number; models: ModelInfo[]; error?: string };
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
    if (runtime?.layout !== "cli" || runtime.args.length !== 1) return null;

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
    if (
      !options?.forceRefresh &&
      this.catalog &&
      Date.now() - this.catalog.at < 60_000
    )
      return this.catalog.models;
    if (this.catalogRead) return this.catalogRead;
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
      models = buildAntigravityModels(setup, {
        useConfigOptions: command.layout === "cli",
      });
      this.catalogStatus = liveModelCatalog();
    } catch (cause) {
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
          // The CLI layout also keeps a per-conversation artifact directory.
          await rm(join(dirname(sessionsDir), "brain", sessionId), {
            recursive: true,
            force: true,
          });
          for (const suffix of [
            ".meta",
            ".db",
            ".db-wal",
            ".db-shm",
            ".db-journal",
          ])
            await rm(`${base}${suffix}`, { force: true });
        }
      }
      await rm(cwd, { recursive: true, force: true });
    }
    this.catalog = { at: Date.now(), models, error };
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
      abort: async () => {
        controller.abort();
        await runtime.close();
      },
      interrupt: async () => {
        if (!controls.id || !runtime.alive) return false;
        runtime.cancel(controls.id);
        return true;
      },
      get pid() {
        return runtime.pid;
      },
      isProcessAlive: () => runtime.alive,
    };
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
      // Derive the live storage scope from the exact command and environment
      // used to spawn ACP, and revalidate the resume source against it before
      // acquiring ownership or launching ACP.
      const namespace = {
        family: "antigravity" as const,
        storageScope: await nativeStorageScope(
          antigravityRuntimeStoreDir(command, launchEnvironment),
        ),
      };
      await this.validateResumeSource(options, namespace);
      if (options.resumeSessionId) {
        owner = await ownAntigravitySessionAfterReads(
          namespace.storageScope,
          options.resumeSessionId,
          signal,
        );
        // Revalidate again after waiting on in-progress history reads so a
        // profile or store rebind cannot redirect `session/load`.
        const currentScope = await nativeStorageScope(
          antigravityRuntimeStoreDir(command, launchEnvironment),
        );
        if (currentScope !== namespace.storageScope) {
          throw new Error(
            "Antigravity continuation requires its original native store and project",
          );
        }
        await this.validateResumeSource(options, namespace);
      }
      runtime.onPermission = (params) =>
        this.permission(params, options, signal);
      const skipPermissions =
        options.permissionMode === "bypassPermissions" &&
        command.layout === "cli";
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
      const [major, minor] = runtime.agentVersion?.split(".").map(Number) ?? [];
      const modern =
        command.layout === "cli" &&
        ((major ?? 0) > 1 || (major === 1 && (minor ?? 0) >= 5));
      void runtime.closed.then(stop);
      if (options.agentApiInstructions && !runtime.canAppendSystemPrompt)
        throw new Error(
          "This agy runtime does not support native Agent API instructions",
        );
      const replay = options.resumeSessionId
        ? new AntigravityTranscript(options.resumeSessionId)
        : undefined;
      const observeCommands = (update: AntigravityUpdate) => {
        if (
          update.sessionUpdate !== "available_commands_update" ||
          !Array.isArray(update.availableCommands)
        )
          return false;
        const commands = update.availableCommands
          .slice(0, 128)
          .filter(
            (command) =>
              typeof command?.name === "string" &&
              (modern || command.name !== "compact"),
          )
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
      const setup =
        options.resumeSessionId && replay
          ? (
              await loadAntigravityReplay({
                runtime,
                scope: namespace.storageScope,
                params: { ...setupParams, sessionId: options.resumeSessionId },
                transcript: replay,
                onUpdate: observeCommands,
                authorize: () => !signal.aborted,
              })
            )?.setup
          : await runtime.call<AntigravitySessionSetup>(
              "session/new",
              setupParams,
            );
      if (!setup) return;
      // A failed resume is terminal; never create a fresh native conversation.
      const id = parseNativeSessionId(
        options.resumeSessionId || setup.sessionId,
      );
      owner ??= ownAntigravitySession(namespace.storageScope, id);
      controls.id = id;
      const structuredControls = command.layout === "cli";
      controls.models = buildAntigravityModels(setup, {
        useConfigOptions: structuredControls,
      });
      let configOptions: AntigravityConfigOption[] = structuredControls
        ? (setup.configOptions ?? [])
        : [];
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
        if (modelOption) {
          const legacy = splitAntigravityLegacyModel(target, controls.models);
          const base = legacy?.modelId ?? target;
          const override = hasExplicitEffortOverride
            ? currentThought()?.currentValue
            : undefined;
          if (base !== resolvedModel) {
            if (!modelOption.options?.some((entry) => entry.value === base)) {
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
            resolvedModel = resolveAntigravityModelSelection(
              configOptions,
              base,
            );
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
        } else {
          await runtime.call("session/set_model", {
            sessionId: id,
            modelId: target,
          });
          resolvedModel = target;
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
      // Use only offered native modes: 1.4.x named them auto_edit/yolo,
      // agy 1.5+ offers accept-edits and grants YOLO through a launch flag.
      const offered = new Set(
        setup.modes?.availableModes.map((entry) => entry.id) ?? [
          "default",
          "auto_edit",
          "yolo",
        ],
      );
      const wanted =
        options.permissionMode === "acceptEdits"
          ? ["accept-edits", "auto_edit"]
          : options.permissionMode === "auto"
            ? ["auto"]
            : options.permissionMode === "bypassPermissions" && !skipPermissions
              ? ["yolo"]
              : ["default"];
      const mode = wanted.find((entry) => offered.has(entry));
      if (!mode && options.permissionMode)
        throw new Error(
          `Antigravity does not offer the ${options.permissionMode} permission mode`,
        );
      if (mode && options.permissionMode && mode !== setup.modes?.currentModeId)
        await runtime.call("session/set_mode", { sessionId: id, modeId: mode });
      for (const message of replay?.messages ?? []) owner.record(message);
      markReady();
      yield {
        type: "system",
        subtype: "init",
        session_id: id,
        cwd: options.cwd,
        model: resolvedModel,
        slash_command_inventory: controls.commands,
      };
      for (const message of replay?.messages ?? [])
        yield { ...message, isReplay: true };
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
        const { _isStreaming: _partial, ...committed } = converted;
        owner!.record(committed);
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
        modern,
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
      if (modern)
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
      if (modern)
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
            reconcileRoot();
            changed();
          }
        };
      runtime.onUpdate = (update, updateSessionId, isReplay) => {
        if (
          isReplay ||
          updateSessionId !== id ||
          update.sessionUpdate === "user_message_chunk"
        )
          return;
        if (
          structuredControls &&
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
        if (modern)
          background.observe(update, !!foregroundUpdate || compacting);
        if (foregroundUpdate) {
          foregroundUpdate(update);
        } else if (modern && !compacting) {
          // A detached wake has no prompt result in ACP. Publish each received
          // snapshot without inventing a foreground turn or completion.
          passiveTranscript ??= new AntigravityTranscript(
            id,
            `${id}:${randomUUID()}`,
            true,
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
        const promptStartedAt = new Date();
        const initialStartPosition = await subagents.readStartPosition();
        if (signal.aborted) break;
        const transcript = new AntigravityTranscript(id, `${id}:${uuid}`, true);
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
          publish({
            type: "user",
            uuid: inputId,
            session_id: id,
            timestamp: new Date().toISOString(),
            message: { role: "user", content: promptText },
          });
          pending++;
          void runtime
            .call<{ usage?: unknown; stopReason?: string }>(
              "session/prompt",
              { sessionId: id, prompt: [{ type: "text", text: promptText }] },
              0,
            )
            .then((response) => {
              usage = response.usage ?? usage;
              if (!signal.aborted && response.stopReason === "end_turn") {
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
              if (--pending === 0) controls.steer = undefined;
              changed();
            });
          changed();
        };
        prompt(text, uuid, undefined, initialStartPosition);
        if (modern) {
          controls.steer = (input) => {
            if (
              signal.aborted ||
              !runtime.alive ||
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
        }
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
      failReady(new Error("Antigravity session closed before initialization"));
      controls.steer = undefined;
      controls.compact = undefined;
      controls.setModel = undefined;
      controls.setEffort = undefined;
      controls.onInputHoldChanged = undefined;
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
