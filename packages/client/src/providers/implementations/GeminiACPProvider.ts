import type {
  Provider,
  ProviderCapabilities,
  ProviderMetadata,
} from "../types";

/**
 * Client-side provider for Gemini via Agent Client Protocol.
 *
 * Unlike the regular Gemini provider which is read-only, the ACP version
 * executes tools on our side, enabling full agentic capabilities.
 */
export class GeminiACPProvider implements Provider {
  readonly id = "gemini-acp";
  readonly displayName = "Gemini (ACP)";

  readonly capabilities: ProviderCapabilities = {
    supportsDag: false,
    supportsCloning: false,
    supportsPermissionMode: true,
    supportsThinkingToggle: false,
    supportsSlashCommands: false,
  };

  readonly metadata: ProviderMetadata = {
    description:
      "Google's Gemini CLI via Agent Client Protocol. Full agentic capabilities with server-side tool execution.",
    limitations: [
      "Requires gemini CLI with --experimental-acp support",
      "Tool execution happens on server",
    ],
    website: "https://github.com/google-gemini/gemini-cli",
    cliName: "gemini",
  };
}
