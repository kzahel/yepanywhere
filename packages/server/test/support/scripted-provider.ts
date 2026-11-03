import type {
  AgentProvider,
  AgentSession,
  StartSessionOptions,
} from "../../src/sdk/providers/types.js";
import type { SDKMessage } from "../../src/sdk/types.js";
import { MessageQueue } from "../../src/sdk/messageQueue.js";
import { MockServerClaudeProvider } from "../../src/sdk/mock.js";
export interface MockScenario {
  messages: SDKMessage[];
  delayMs?: number;
}
export class ScriptedClaudeProvider extends MockServerClaudeProvider {
  override async startSession(
    options: StartSessionOptions,
  ): Promise<AgentSession> {
    const messages = this.scenarioMessages(options);
    const chosen = options.publicSessionId ? options.newSessionId : undefined;
    async function* iterator() {
      for await (const message of messages)
        yield chosen && message.session_id
          ? { ...message, session_id: chosen }
          : message;
    }
    return {
      iterator: iterator(),
      queue: new MessageQueue(),
      abort: async () => {
        await messages.return?.(undefined);
      },
    };
  }
  private scenarios: MockScenario[] = [];
  private scenarioIndex = 0;

  constructor(scenarios: MockScenario[] = []) {
    super();
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

  private async *scenarioMessages(
    options: StartSessionOptions,
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
      const sessionId = options.resumeSessionId ?? `mock-session-${Date.now()}`;
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

/** Scripted results still run through the production provider lifecycle. */
export function controlledProvider(
  control: Pick<AgentProvider, "startSession">,
): AgentProvider {
  const provider = new MockServerClaudeProvider();
  Object.assign(provider, {
    supportsNativePromptSuggestions: true,
    supportsLaunchCompactPercentOverride: true,
  });
  provider.startSession = (options) => control.startSession(options);
  return provider;
}
