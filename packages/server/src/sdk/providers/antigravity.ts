import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fromUrlProjectId,
  parseNativeSessionId,
  type ModelInfo,
  type ModelCatalogStatus,
} from "@yep-anywhere/shared";
import { MessageQueue } from "../messageQueue.js";
import type { SDKMessage } from "../types.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  StartSessionOptions,
} from "./types.js";
import { nativeStorageScope } from "./native-storage-scope.js";
import {
  fallbackModelCatalog,
  liveModelCatalog,
  modelCatalogError,
} from "./model-catalog-status.js";
import {
  AntigravityRuntime,
  ownAntigravitySession,
  antigravitySessionsDir,
  findAntigravityRuntime,
  type AntigravitySessionSetup,
} from "./antigravity-runtime.js";
import { AntigravityTranscript } from "./antigravity-transcript.js";

const DEFAULT_MODEL: ModelInfo = { id: "default", name: "Antigravity default" };

export class AntigravityProvider implements AgentProvider {
  readonly name = "antigravity" as const;
  readonly displayName = "Antigravity";
  readonly supportsNativeResumeSource = true;
  readonly supportsPermissionMode = true;
  readonly supportsThinkingToggle = false;
  readonly supportsSlashCommands = false;
  readonly supportsSteering = false;
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
        throw new Error(
          "Install Google's official Antigravity ACP runtime first",
        );
      await runtime.connect(command, cwd);
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
        const base = join(antigravitySessionsDir(), sessionId);
        const metadata = await readFile(`${base}.meta`, "utf8")
          .then((text) => JSON.parse(text) as { cwd?: string })
          .catch(() => null);
        if (metadata?.cwd === cwd) {
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
    let sessionId: string | undefined;
    return {
      queue,
      iterator: this.run(runtime, queue, options, controller.signal, (id) => {
        sessionId = id;
      }),
      abort: async () => {
        controller.abort();
        await runtime.close();
      },
      interrupt: async () => {
        if (!sessionId || !runtime.alive) return false;
        runtime.cancel(sessionId);
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
    bind: (id: string) => void,
  ): AsyncIterableIterator<SDKMessage> {
    const input = queue[Symbol.asyncIterator]();
    let owner: ReturnType<typeof ownAntigravitySession> | undefined;
    const stop = () => {
      void input.return?.();
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      if (signal.aborted) return;
      const namespace = await this.getNewSessionNamespace();
      if (options.resumeSessionId)
        owner = ownAntigravitySession(
          namespace.storageScope,
          options.resumeSessionId,
        );
      const command = await findAntigravityRuntime();
      if (!command)
        throw new Error(
          "Install Google's official Antigravity ACP runtime and sign in externally first",
        );
      runtime.onPermission = (params) =>
        this.permission(params, options, signal);
      await runtime.connect(command, options.cwd);
      void runtime.closed.then(stop);
      const replay = options.resumeSessionId
        ? new AntigravityTranscript(options.resumeSessionId)
        : undefined;
      if (replay)
        runtime.onUpdate = (update, id) => {
          if (id === options.resumeSessionId) replay.accept(update);
        };
      const setup = await runtime.call<AntigravitySessionSetup>(
        options.resumeSessionId ? "session/load" : "session/new",
        {
          cwd: options.cwd,
          mcpServers: [],
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
      runtime.onUpdate = undefined;
      bind(id);
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
      const mode =
        options.permissionMode === "acceptEdits"
          ? "auto_edit"
          : options.permissionMode === "bypassPermissions"
            ? "yolo"
            : "default";
      if (options.permissionMode)
        await runtime.call("session/set_mode", { sessionId: id, modeId: mode });
      yield {
        type: "system",
        subtype: "init",
        session_id: id,
        cwd: options.cwd,
        model: resolvedModel,
      };
      for (const message of replay?.messages ?? [])
        yield { ...message, isReplay: true };
      for await (const message of input) {
        if (signal.aborted) break;
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
        const prompt = [{ type: "text", text }];
        const echo: SDKMessage = {
          type: "user",
          uuid,
          session_id: id,
          message: { role: "user", content: text },
        };
        owner.record(echo);
        yield echo;
        const transcript = new AntigravityTranscript(id, `${id}:${uuid}`);
        const updates: SDKMessage[] = [];
        let wake: (() => void) | undefined;
        let done = false;
        runtime.onUpdate = (update, updateSessionId) => {
          if (updateSessionId !== id) return;
          const converted = transcript.accept(update);
          if (converted) {
            if (
              converted.type === "assistant" &&
              converted.message &&
              resolvedModel
            )
              converted.message.model = resolvedModel;
            owner!.record(converted);
            if (updates.at(-1)?.uuid === converted.uuid)
              updates[updates.length - 1] = converted;
            else updates.push(converted);
          }
          wake?.();
          wake = undefined;
        };
        const request = runtime.call<{ usage?: unknown; stopReason?: string }>(
          "session/prompt",
          { sessionId: id, prompt },
          0,
        );
        // Observe rejection immediately, including while yielding streamed output.
        let failure: unknown;
        void request
          .catch((error) => {
            failure = error;
          })
          .finally(() => {
            done = true;
            wake?.();
            wake = undefined;
          });
        while (!done || updates.length) {
          if (updates.length) {
            yield updates.shift()!;
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        if (failure) throw failure;
        const response = await request;
        if (!signal.aborted && response.stopReason === "end_turn")
          options.onNativeInputConsumed?.(id, uuid);
        yield { type: "result", session_id: id, usage: response.usage };
        runtime.onUpdate = undefined;
      }
    } catch (error) {
      if (!signal.aborted)
        yield {
          type: "error",
          error: error instanceof Error ? error.message : String(error),
        };
    } finally {
      signal.removeEventListener("abort", stop);
      await input.return?.();
      await runtime.close();
      owner?.release();
    }
  }
}

export const antigravityProvider = new AntigravityProvider();
