/**
 * Base mock provider implementation.
 *
 * Provides common functionality for all mock providers:
 * - Scenario management
 * - Message iteration with delays
 * - Configurable auth status
 */

import type { ModelInfo } from "@yep-anywhere/shared";
import { MessageQueue } from "../../messageQueue.js";
import type { SDKMessage } from "../../types.js";
import type {
  AgentSession,
  AuthStatus,
  ProviderName,
  StartSessionOptions,
} from "../types.js";
import type {
  MockAgentProvider,
  MockProviderConfig,
  MockScenario,
} from "./types.js";

/**
 * Base class for mock providers.
 * Extend this class to create mock implementations for each provider.
 */
export abstract class BaseMockProvider implements MockAgentProvider {
  abstract readonly name: ProviderName;
  abstract readonly displayName: string;
  // Mock providers default to Claude-like behavior (supports all)
  readonly supportsPermissionMode = true;
  readonly supportsThinkingToggle = true;
  readonly supportsSlashCommands = true;

  protected scenarios: MockScenario[] = [];
  protected _scenarioIndex = 0;
  protected _sessionCount = 0;
  protected _installed: boolean;
  protected _authenticated: boolean;
  protected _authStatus?: AuthStatus;

  constructor(config: MockProviderConfig = {}) {
    this.scenarios = [...(config.scenarios ?? [])];
    this._installed = config.installed ?? true;
    this._authenticated = config.authenticated ?? true;
    this._authStatus = config.authStatus;
  }

  /**
   * Add a scenario for the next session.
   */
  addScenario(scenario: MockScenario): void {
    this.scenarios.push(scenario);
  }

  /**
   * Set multiple scenarios.
   */
  setScenarios(scenarios: MockScenario[]): void {
    this.scenarios = [...scenarios];
    this._scenarioIndex = 0;
  }

  /**
   * Reset all scenarios and state.
   */
  reset(): void {
    this.scenarios = [];
    this._scenarioIndex = 0;
    this._sessionCount = 0;
  }

  /**
   * Get the current scenario index.
   */
  get scenarioIndex(): number {
    return this._scenarioIndex;
  }

  /**
   * Get total number of sessions started.
   */
  get sessionCount(): number {
    return this._sessionCount;
  }

  /**
   * Check if provider is installed.
   */
  async isInstalled(): Promise<boolean> {
    return this._installed;
  }

  /**
   * Check if provider is authenticated.
   */
  async isAuthenticated(): Promise<boolean> {
    return this._authenticated;
  }

  /**
   * Get detailed auth status.
   */
  async getAuthStatus(): Promise<AuthStatus> {
    if (this._authStatus) {
      return this._authStatus;
    }

    return {
      installed: this._installed,
      authenticated: this._authenticated,
      enabled: this._authenticated,
    };
  }

  /**
   * Get available models (mock implementation).
   */
  async getAvailableModels(): Promise<ModelInfo[]> {
    return [{ id: "mock-model", name: "Mock Model" }];
  }

  /**
   * Start a mock session.
   */
  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    this._sessionCount++;

    const queue = new MessageQueue();
    let aborted = false;

    // Push initial message if provided
    if (options.initialMessage) {
      queue.push(options.initialMessage);
    }

    // Get scenario
    let scenario = this.scenarios[this._scenarioIndex];
    if (scenario) {
      this._scenarioIndex++;
    } else if (this.scenarios.length > 0) {
      // Cycle back to first scenario when exhausted
      this._scenarioIndex = 0;
      scenario = this.scenarios[this._scenarioIndex++];
    }

    const iterator = this.createIterator(scenario, options, () => aborted);

    return {
      iterator,
      queue,
      abort: () => {
        aborted = true;
      },
      sessionId: scenario?.sessionId,
    };
  }

  /**
   * Create an async iterator that emits scenario messages.
   */
  protected async *createIterator(
    scenario: MockScenario | undefined,
    options: StartSessionOptions,
    isAborted: () => boolean,
  ): AsyncIterableIterator<SDKMessage> {
    // Generate a default session ID if not provided
    const defaultSessionId =
      options.resumeSessionId ??
      `mock-${this.name}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    if (!scenario) {
      // No scenario - return minimal response
      yield {
        type: "system",
        subtype: "init",
        session_id: defaultSessionId,
        cwd: options.cwd,
      };

      await this.sleep(50);

      if (isAborted()) return;

      yield {
        type: "assistant",
        session_id: defaultSessionId,
        message: {
          role: "assistant",
          content: `Mock ${this.displayName} response (no scenario)`,
        },
      };

      await this.sleep(50);

      if (isAborted()) return;

      yield {
        type: "result",
        session_id: defaultSessionId,
      };
      return;
    }

    const delayMs = scenario.delayMs ?? 10;
    const sessionId = scenario.sessionId ?? defaultSessionId;

    for (const message of scenario.messages) {
      if (isAborted()) return;

      if (delayMs > 0) {
        await this.sleep(delayMs);
      }

      if (isAborted()) return;

      // Inject session_id if not present
      const msgWithSession = {
        ...message,
        session_id: message.session_id ?? sessionId,
      };

      yield msgWithSession;
    }
  }

  /**
   * Sleep for the specified duration.
   */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
