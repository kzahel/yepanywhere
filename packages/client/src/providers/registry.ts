import { ClaudeOllamaProvider } from "./implementations/ClaudeOllamaProvider";
import { AntigravityProvider } from "./implementations/AntigravityProvider";
import { ClaudeProvider } from "./implementations/ClaudeProvider";
import { ClaudeGatewayProvider } from "./implementations/ClaudeGatewayProvider";
import {
  CodexOssProvider,
  CodexProvider,
} from "./implementations/CodexProvider";
import { GeminiACPProvider } from "./implementations/GeminiACPProvider";
import { GeminiProvider } from "./implementations/GeminiProvider";
import { GrokProvider } from "./implementations/GrokProvider";
import { OpenCodeProvider } from "./implementations/OpenCodeProvider";
import { PiProvider } from "./implementations/PiProvider";
import type { Provider, ProviderMetadata } from "./types";

const providers: Record<string, Provider> = {
  // Insertion order is the user-visible order in Settings > Providers.
  codex: new CodexProvider(),
  claude: new ClaudeProvider(),
  "claude-gateway": new ClaudeGatewayProvider(),
  "claude-ollama": new ClaudeOllamaProvider(),
  gemini: new GeminiProvider(),
  "gemini-acp": new GeminiACPProvider(),
  antigravity: new AntigravityProvider(),
  grok: new GrokProvider(),
  "codex-oss": new CodexOssProvider(),
  opencode: new OpenCodeProvider(),
  pi: new PiProvider(),
};

/**
 * Get all registered providers for settings display.
 */
export function getAllProviders(): Provider[] {
  return Object.values(providers);
}

/**
 * Fallback provider for unknown IDs.
 * Assumes minimal capabilities (no DAG, no cloning).
 */
class GenericProvider implements Provider {
  readonly capabilities = {
    supportsDag: false,
    supportsCloning: false,
    needsApproxMessageDedup: false,
  };

  readonly metadata: ProviderMetadata;

  constructor(readonly id: string) {
    this.metadata = {
      description: "Unknown provider",
      limitations: [],
      website: "",
      cliName: id,
    };
  }

  get displayName(): string {
    return this.id;
  }
}

/**
 * Get a provider instance by ID.
 * Returns a generic provider with safe defaults if ID is unknown.
 */
export function getProvider(id: string | undefined): Provider {
  if (!id) {
    return new GenericProvider("unknown");
  }
  return providers[id] ?? new GenericProvider(id);
}
