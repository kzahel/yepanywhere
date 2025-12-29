import type { ClaudeSDK, SDKMessage, SDKSessionOptions } from "./types.js";

export interface MockScenario {
  messages: SDKMessage[];
  delayMs?: number; // delay between messages
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
        },
      },
    ],
    delayMs: 5,
  };
}
