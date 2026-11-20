import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  fromUrlProjectId,
  parseNativeSessionId,
  type ModelInfo,
  type ModelCatalogStatus,
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
  ownAntigravitySession,
  ownAntigravitySessionAfterReads,
  antigravitySessionsDir,
  findAntigravityRuntime,
  resolveAntigravityRuntime,
  type AntigravitySessionSetup,
  type AntigravityUpdate,
} from "./antigravity-runtime.js";
import { AntigravityTranscript } from "./antigravity-transcript.js";
import { AntigravityBackground } from "./antigravity-background.js";
import { compactAntigravity } from "./antigravity-compaction.js";
import { readAntigravityMetadata } from "../../sessions/antigravity-metadata.js";

const DEFAULT_MODEL: ModelInfo = { id: "default", name: "Antigravity default" };
type Steer = (message: UserMessage) => boolean;
interface AntigravityControls {
  id?: string;
  steer?: Steer;
  commands: SlashCommand[];
  compact?: (argument: string) => Promise<ProviderCommandResult>;
}

export class AntigravityProvider implements AgentProvider {
  readonly name = "antigravity" as const;
  readonly displayName = "Antigravity";
  readonly supportsNativeResumeSource = true;
  readonly supportsPermissionMode = true;
  readonly supportsThinkingToggle = false;
  readonly supportsSlashCommands = true;
  get supportsSteering(): boolean {
    return resolveAntigravityRuntime()?.layout === "cli";
  }
  private catalog?: { at: number; models: ModelInfo[]; error?: string };
  private catalogRead?: Promise<ModelInfo[]>;
  private catalogStatus: ModelCatalogStatus | undefined;

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
    let models = [DEFAULT_MODEL];
    let error: string | undefined;
    try {
      const command = await findAntigravityRuntime();
      if (!command)
        throw new Error("Install Google's Antigravity CLI (agy) first");
      await runtime.connect(command.command, cwd, command.args);
      const setup = await runtime.call<AntigravitySessionSetup>("session/new", {
        cwd,
        mcpServers: [],
      });
      sessionId = setup.sessionId;
      if (!sessionId)
        throw new Error("Antigravity did not return a session ID");
      models = [
        DEFAULT_MODEL,
        ...(setup.models?.availableModels ?? []).map((model) => ({
          id: model.modelId,
          name: model.name,
        })),
      ];
      this.catalogStatus = liveModelCatalog();
    } catch (cause) {
      error = modelCatalogError(cause);
      this.catalogStatus = fallbackModelCatalog(error);
    } finally {
      await runtime.close();
      // Reclaim only our blank native probe, after the owning child has exited.
      if (sessionId && /^[0-9a-f-]{36}$/i.test(sessionId)) {
        const sessionsDir = antigravitySessionsDir();
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

  private async startSessionInternal(
    options: StartSessionOptions,
  ): Promise<AgentSession> {
    if (options.executor || options.sessionSandbox)
      throw new Error("Antigravity supports ordinary local sessions only");
    if (options.permissionMode === "plan")
      throw new Error(
        "Use Antigravity's native /plan command with the default permission mode",
      );
    const source = options.nativeResumeSource;
    if (source) {
      const namespace = await this.getNewSessionNamespace();
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
      )
        throw new Error(
          "Antigravity continuation requires its original native store and project",
        );
    }
    const queue = new MessageQueue();
    if (options.initialMessage) queue.push(options.initialMessage);
    const runtime = new AntigravityRuntime();
    const controller = new AbortController();
    const background = new AntigravityBackground(
      options.onProviderRetentionChange,
    );
    const controls: AntigravityControls = { commands: [] };
    return {
      queue,
      iterator: this.run(
        runtime,
        queue,
        options,
        controller.signal,
        background,
        controls,
      ),
      ...(this.supportsSteering
        ? {
            steer: async (message: UserMessage) =>
              controls.steer?.(message) ?? false,
          }
        : {}),
      supportedCommands: async () => controls.commands,
      runProviderCommand: async (command, argument = "") =>
        command === "compact" && controls.compact
          ? controls.compact(argument)
          : { handled: false },
      getProviderRetention: () => background.snapshot(),
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
  ): AsyncIterableIterator<SDKMessage> {
    const input = queue[Symbol.asyncIterator]();
    let owner: ReturnType<typeof ownAntigravitySession> | undefined;
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
      const namespace = await this.getNewSessionNamespace();
      if (options.resumeSessionId)
        owner = await ownAntigravitySessionAfterReads(
          namespace.storageScope,
          options.resumeSessionId,
          signal,
        );
      const command = await findAntigravityRuntime();
      if (!command)
        throw new Error(
          "Install Google's Antigravity CLI (agy) and sign in with it first",
        );
      runtime.onPermission = (params) =>
        this.permission(params, options, signal);
      const skipPermissions =
        options.permissionMode === "bypassPermissions" &&
        command.layout === "cli";
      await runtime.connect(
        command.command,
        options.cwd,
        [
          ...command.args,
          ...(skipPermissions ? ["--dangerously-skip-permissions"] : []),
        ],
        agentApiEnvironmentFor(options),
      );
      const [major, minor] = runtime.agentVersion?.split(".").map(Number) ?? [];
      const modern =
        command.layout === "cli" && major === 1 && (minor ?? 0) >= 5;
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
      runtime.onUpdate = (update, id) => {
        if (!options.resumeSessionId || id === options.resumeSessionId)
          observeCommands(update);
        if (id === options.resumeSessionId) replay?.accept(update);
      };
      const setup = await runtime.call<AntigravitySessionSetup>(
        options.resumeSessionId ? "session/load" : "session/new",
        {
          cwd: options.cwd,
          mcpServers: [],
          ...(options.agentApiInstructions
            ? {
                _meta: {
                  antigravity: {
                    systemPrompt: { append: options.agentApiInstructions },
                  },
                },
              }
            : {}),
          ...(options.resumeSessionId
            ? { sessionId: options.resumeSessionId }
            : {}),
        },
      );
      // A failed resume is terminal; never create a fresh native conversation.
      const id = parseNativeSessionId(
        options.resumeSessionId || setup.sessionId,
      );
      owner ??= ownAntigravitySession(namespace.storageScope, id);
      for (const message of replay?.messages ?? []) owner.record(message);
      controls.id = id;
      let resolvedModel = setup.models?.currentModelId;
      if (
        options.model &&
        options.model !== "default" &&
        options.model !== "auto"
      ) {
        await runtime.call("session/set_model", {
          sessionId: id,
          modelId: options.model,
        });
        resolvedModel = options.model;
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
      const publish = (converted: SDKMessage) => {
        if (
          converted.type === "assistant" &&
          converted.message &&
          resolvedModel
        )
          converted.message.model = resolvedModel;
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
      if (modern)
        controls.compact = async (argument) => {
          if (compacting || foregroundUpdate)
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
            if (result.completion === "completed")
              publish({
                type: "system",
                subtype: "compact_boundary",
                uuid: randomUUID(),
                session_id: id,
              });
            return result;
          } finally {
            compacting = false;
            changed();
          }
        };
      runtime.onUpdate = (update, updateSessionId) => {
        if (
          updateSessionId !== id ||
          update.sessionUpdate === "user_message_chunk"
        )
          return;
        if (observeCommands(update))
          publish({
            type: "system",
            subtype: "command_inventory",
            uuid: randomUUID(),
            session_id: id,
            slash_command_inventory: controls.commands,
          });
        if (modern) background.observe(update, !!foregroundUpdate);
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
          for (const {
            _isStreaming: _partial,
            ...converted
          } of passiveTranscript.accept(update))
            publish({ ...converted, _passiveProviderUpdate: true });
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
          else if (nextInput && !compacting) break;
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
        const transcript = new AntigravityTranscript(id, `${id}:${uuid}`, true);
        const creatingSession = firstPrompt;
        firstPrompt = false;
        let observedOriginal = false;
        const acknowledgeOriginal = () => {
          if (observedOriginal || signal.aborted) return;
          observedOriginal = true;
          options.onNativeInputConsumed?.(id, uuid);
        };
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
          for (const converted of transcript.accept(update)) publish(converted);
          changed();
        };
        let pending = 0;
        let failure: unknown;
        let usage: unknown;
        const prompt = (text: string, inputId: string, steer?: UserMessage) => {
          if (steer) {
            const previous = transcript.close();
            if (previous) publish(previous);
          }
          publish({
            type: "user",
            uuid: inputId,
            session_id: id,
            timestamp: new Date().toISOString(),
            message: { role: "user", content: text },
          });
          pending++;
          void runtime
            .call<{ usage?: unknown; stopReason?: string }>(
              "session/prompt",
              { sessionId: id, prompt: [{ type: "text", text }] },
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
        prompt(text, uuid);
        if (modern) {
          controls.steer = (input) => {
            if (
              signal.aborted ||
              !runtime.alive ||
              failure ||
              pending >= 8 ||
              input.images?.length ||
              input.documents?.length
            )
              return false;
            prompt(input.text, input.uuid ?? randomUUID(), input);
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
        background.foregroundSettled();
        const last = transcript.close();
        if (last) {
          publish(last);
          yield updates.shift()!;
        }
        if (failure) throw failure;
        yield { type: "result", session_id: id, usage };
      }
    } catch (error) {
      if (!signal.aborted)
        yield {
          type: "error",
          error: error instanceof Error ? error.message : String(error),
        };
    } finally {
      controls.steer = undefined;
      controls.compact = undefined;
      background.clear();
      signal.removeEventListener("abort", stop);
      await input.return?.();
      await runtime.close();
      owner?.release();
    }
  }
}

export const antigravityProvider = new AntigravityProvider();
