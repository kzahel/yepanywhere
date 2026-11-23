import { MessageQueue } from "../messageQueue.js";
import type {
  ProviderActivitySnapshot,
  ProviderLivenessProbeResult,
  ProviderRetentionSnapshot,
  SDKMessage,
  UserMessage,
} from "../types.js";
import type { AgentSession, ProviderSessionOptions } from "./types.js";
import {
  resolveProviderSessionOptions,
  type ProviderSessionOptionsUpdateResult,
} from "./types.js";
import type { ProviderSessionStartHooks } from "./provider-session-protocol.js";

function userText(message: {
  message: { content: string | Array<{ type: string; text?: string }> };
}): string {
  const content = message.message.content;
  if (typeof content === "string") return content;
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

export interface FakeProviderSessionOptions {
  sessionId?: string;
  initialMessage?: UserMessage;
  failOnStart?: boolean;
}

export async function startFakeProviderSession(
  options: FakeProviderSessionOptions,
  hooks: ProviderSessionStartHooks,
): Promise<AgentSession> {
  if (options.failOnStart) throw new Error("Fake provider rejected launch");
  const sessionId = options.sessionId ?? "fake-provider-session";
  const queue = new MessageQueue();
  const input = queue[Symbol.asyncIterator]();
  let aborted = false;
  let activeTurnAbort: AbortController | null = null;
  let releaseHeldTurn: (() => void) | null = null;
  let lastActivityAt = new Date();
  let retention: ProviderRetentionSnapshot = {
    retained: false,
    reasons: [],
  };
  let sessionOptions = resolveProviderSessionOptions();

  const iterator = (async function* (): AsyncIterableIterator<SDKMessage> {
    yield {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      model: "fake-provider",
    };
    while (!aborted) {
      const next = await input.next();
      if (next.done || aborted) return;
      lastActivityAt = new Date();
      const text = userText(next.value);
      activeTurnAbort = new AbortController();
      if (text.startsWith("approval:")) {
        const toolName = text.slice("approval:".length).trim() || "fake_tool";
        const result = await hooks.onToolApproval(
          toolName,
          { text },
          {
            signal: activeTurnAbort.signal,
            permissionMode: "default",
          },
        );
        if (aborted) return;
        yield {
          type: "assistant",
          session_id: sessionId,
          message: {
            role: "assistant",
            content: `approval:${result.behavior}`,
          },
        };
      } else if (text === "hold") {
        retention = { retained: true, reasons: ["activeTurn"] };
        hooks.onProviderRetentionChange();
        await new Promise<void>((resolve) => {
          releaseHeldTurn = resolve;
          activeTurnAbort?.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        releaseHeldTurn = null;
        retention = { retained: false, reasons: [] };
        hooks.onProviderRetentionChange();
        if (aborted) return;
        yield {
          type: "assistant",
          session_id: sessionId,
          message: { role: "assistant", content: "interrupted" },
        };
      } else if (text === "fail") {
        throw new Error("Fake provider turn failed");
      } else {
        yield {
          type: "assistant",
          session_id: sessionId,
          message: { role: "assistant", content: `echo:${text}` },
        };
      }
      activeTurnAbort = null;
      lastActivityAt = new Date();
      yield {
        type: "result",
        session_id: sessionId,
        subtype: "success",
      };
    }
  })();

  if (options.initialMessage) queue.push(options.initialMessage);

  return {
    iterator,
    queue,
    abort: async () => {
      aborted = true;
      activeTurnAbort?.abort();
      releaseHeldTurn?.();
      await input.return?.();
    },
    sessionId,
    isProcessAlive: () => !aborted,
    probeLiveness: async (): Promise<ProviderLivenessProbeResult> => ({
      status: aborted ? "not-loaded" : "idle",
      source: "fake-provider",
      checkedAt: new Date(),
      detail: aborted ? "fake provider stopped" : "fake provider ready",
    }),
    getProviderActivity: (): ProviderActivitySnapshot => ({
      lastRawProviderEventAt: lastActivityAt,
      lastRawProviderEventSource: "fake-provider",
    }),
    getProviderRetention: () => retention,
    interrupt: async () => {
      activeTurnAbort?.abort();
      releaseHeldTurn?.();
      return true;
    },
    setSessionOptions: async (
      next: ProviderSessionOptions,
    ): Promise<ProviderSessionOptionsUpdateResult> => {
      sessionOptions = resolveProviderSessionOptions(next);
      return {
        automaticTitle: {
          requested: sessionOptions.automaticTitle,
          status: "applied",
        },
        automaticRecaps: {
          requested: sessionOptions.automaticRecaps,
          status: "applied",
        },
        agentProgressSummaries: {
          requested: sessionOptions.agentProgressSummaries,
          status: "applied",
        },
        promptSuggestions: {
          requested: sessionOptions.promptSuggestions,
          status: "applied",
        },
      };
    },
    supportedModels: async () => [
      { id: "fake-provider", name: "Fake provider" },
    ],
    supportedCommands: async () => [],
    getContextBreakdown: async () => ({
      model: "fake-provider",
      totalTokens: 10,
      maxTokens: 100,
      categories: [
        { key: "messages", name: "Messages", tokens: 10, kind: "used" },
        { key: "free", name: "Free space", tokens: 90, kind: "free" },
      ],
    }),
    setModel: async () => {},
  };
}
