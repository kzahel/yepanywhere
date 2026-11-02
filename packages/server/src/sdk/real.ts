import { ClaudeProvider } from "./providers/claude.js";
import type {
  RealClaudeSDKInterface,
  StartSessionOptions,
  StartSessionResult,
} from "./types.js";

/**
 * Real Claude SDK implementation.
 *
 * This is a thin wrapper around ClaudeProvider for backward compatibility.
 * New code should use ClaudeProvider directly or via the AgentProvider interface.
 *
 * @deprecated Use ClaudeProvider from ./providers/claude.js instead
 */
export class RealClaudeSDK implements RealClaudeSDKInterface {
  readonly providerName = "claude";
  private provider = new ClaudeProvider();

  /**
   * Start a new Claude session.
   *
   * @param options - Session configuration
   * @returns Iterator, message queue, and abort function
   */
  async startSession(
    options: StartSessionOptions,
  ): Promise<StartSessionResult> {
    return this.provider.startSession(options);
  }
}
