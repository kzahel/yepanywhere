import { claudeProvider } from "./providers/claude.js";
import type { ModelInfo } from "@yep-anywhere/shared";
import { MessageQueue } from "./messageQueue.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  StartSessionOptions as ProviderStartSessionOptions,
} from "./providers/types.js";
import type { SDKMessage } from "./types.js";

export class MockServerClaudeProvider implements AgentProvider {
  readonly acceptsChosenSessionId = true;
  getNewSessionNamespace(cwd: string) {
    return claudeProvider.getNewSessionNamespace(cwd);
  }
  readonly name = "claude";
  readonly displayName = "Claude";
  readonly supportsPermissionMode = true;
  readonly supportsThinkingToggle = true;
  readonly supportsSlashCommands = true;
  readonly supportsSteering = false;

  async isInstalled(): Promise<boolean> {
    return true;
  }

  async isAuthenticated(): Promise<boolean> {
    return true;
  }

  async getAuthStatus(): Promise<AuthStatus> {
    return { installed: true, authenticated: true, enabled: true };
  }

  async getAvailableModels(): Promise<ModelInfo[]> {
    return [{ id: "mock-model", name: "Mock Model" }];
  }

  async startSession(
    options: ProviderStartSessionOptions,
  ): Promise<AgentSession> {
    const queue = new MessageQueue();
    const input = queue[Symbol.asyncIterator]();
    const sessionId =
      options.resumeSessionId ??
      options.newSessionId ??
      `mock-session-${Date.now()}`;
    let running = true;

    async function* messages(): AsyncIterableIterator<SDKMessage> {
      yield { type: "system", subtype: "init", session_id: sessionId };
      if (options.initialMessage) {
        queue.push(options.initialMessage);
      }
      while (running) {
        const next = await input.next();
        if (next.done || !running) break;
        // This is the explicit fake backend itself, not SDK queue evidence
        // used to qualify a real external provider.
        if (next.value.uuid)
          options.onNativeInputConsumed?.(sessionId, next.value.uuid);
        yield {
          type: "assistant",
          session_id: sessionId,
          message: {
            content: "Mock response (no scenario)",
            role: "assistant",
          },
        };
        yield { type: "result", session_id: sessionId };
      }
    }

    return {
      iterator: messages(),
      queue,
      abort: async () => {
        running = false;
        await input.return();
      },
      isProcessAlive: () => running,
    };
  }
}
