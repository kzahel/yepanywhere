import { claudeProvider } from "./providers/claude.js";
import type { ModelInfo } from "@yep-anywhere/shared";
import { MessageQueue } from "./messageQueue.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  StartSessionOptions as ProviderStartSessionOptions,
} from "./providers/types.js";
import type {
  ClaudeSDK,
  RealClaudeSDKInterface,
  SDKMessage,
  SDKSessionOptions,
  StartSessionOptions,
  StartSessionResult,
} from "./types.js";

export interface MockScenario {
  messages: SDKMessage[];
  delayMs?: number; // delay between messages
}

/**
 * In-process stand-in for the real SDK contract used by the server entrypoint.
 * It stays alive between turns so create-only and reactivation flows exercise
 * the same Process lifecycle as a provider-backed session.
 */
export class MockRealClaudeSDK implements RealClaudeSDKInterface {
  async startSession(
    options: StartSessionOptions,
    onInput?: (nativeId: string, inputId: string) => void,
  ): Promise<StartSessionResult> {
    const queue = new MessageQueue();
    const input = queue[Symbol.asyncIterator]();
    const sessionId = options.resumeSessionId ?? `mock-session-${Date.now()}`;
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
        if (next.value.uuid) onInput?.(sessionId, next.value.uuid);
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
    const session = await new MockRealClaudeSDK().startSession(
      {
        ...options,
        resumeSessionId: options.resumeSessionId ?? options.newSessionId,
      },
      options.onNativeInputConsumed,
    );
    return {
      ...session,
      sessionId: options.resumeSessionId,
    };
  }
}

export class MockClaudeSDK implements ClaudeSDK {
  private scenarios: MockScenario[] = [];
  private scenarioIndex = 0;

  constructor(scenarios: MockScenario[] = []) {
    this.scenarios = [...scenarios];
  }

  // Add a scenario for the next session
  addScenario(scenario: MockScenario): void {
    this.scenarios.push(scenario);
  }

  // Reset for fresh tests
  reset(): void {
    this.scenarioIndex = 0;
    this.scenarios = [];
  }

  async *startSession(
    options: SDKSessionOptions,
  ): AsyncIterableIterator<SDKMessage> {
    // Use scenario from list, or cycle through if exhausted
    let scenario = this.scenarios[this.scenarioIndex];
    if (scenario) {
      this.scenarioIndex++;
    } else if (this.scenarios.length > 0) {
      // Cycle back to first scenario when exhausted
      this.scenarioIndex = 0;
      scenario = this.scenarios[this.scenarioIndex++];
    }

    if (!scenario) {
      // No scenarios at all - return minimal response with assistant message
      const sessionId = options.resume ?? `mock-session-${Date.now()}`;
      yield { type: "system", subtype: "init", session_id: sessionId };
      await new Promise((resolve) => setTimeout(resolve, 200));
      yield {
        type: "assistant",
        message: { content: "Mock response (no scenario)", role: "assistant" },
      };
      await new Promise((resolve) => setTimeout(resolve, 200));
      yield { type: "result", session_id: sessionId };
      return;
    }

    const delayMs = scenario.delayMs ?? 10;

    for (const message of scenario.messages) {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      yield message;
    }
  }
}

// Helper to create common test scenarios
export function createMockScenario(
  sessionId: string,
  assistantResponse: string,
): MockScenario {
  return {
    messages: [
      { type: "system", subtype: "init", session_id: sessionId },
      {
        type: "assistant",
        message: { content: assistantResponse, role: "assistant" },
      },
      { type: "result", session_id: sessionId },
    ],
    delayMs: 5,
  };
}

// Scenario with input request (tool approval)
export function createToolApprovalScenario(
  sessionId: string,
  toolName: string,
): MockScenario {
  return {
    messages: [
      { type: "system", subtype: "init", session_id: sessionId },
      {
        type: "system",
        subtype: "input_request",
        input_request: {
          id: `req-${Date.now()}`,
          type: "tool-approval",
          prompt: `Allow ${toolName}?`,
          toolName,
        },
      },
    ],
    delayMs: 5,
  };
}
