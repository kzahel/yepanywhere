import type {
  Provider,
  ProviderCapabilities,
  ProviderMetadata,
} from "../types";

export class CodexProvider implements Provider {
  readonly id = "codex";
  readonly displayName = "Codex";

  readonly capabilities: ProviderCapabilities = {
    supportsDag: false, // Linear history
    usesDurableOrderAnchors: true,
    usesDurableReplayIdentity: true,
    supportsCloning: true,
    needsApproxMessageDedup: false,
  };

  readonly metadata: ProviderMetadata = {
    description:
      "OpenAI's Codex CLI. Full editing capabilities with cloud-based reasoning.",
    limitations: [
      "Edit details not visible (black box)",
      "Best for fire-and-forget tasks",
    ],
    website: "https://openai.com/index/introducing-codex/",
    cliName: "codex",
  };
}

export class CodexOssProvider implements Provider {
  readonly id = "codex-oss";
  readonly displayName = "Codex OSS";

  readonly capabilities: ProviderCapabilities = {
    supportsDag: false, // Linear history
    supportsCloning: true,
    needsApproxMessageDedup: true,
    // Native tools dedup by call_id; code-mode inner commandExecution messages
    // use their scoped exact reconciler. Keep the general approximate backstop
    // away from legitimately repeated tools. See stream-durable-id-dedup.md.
    approxDedupExcludesTools: true,
  };

  readonly metadata: ProviderMetadata = {
    description:
      "Codex with local models via Ollama. All operations visible through shell commands.",
    limitations: [
      "Requires Ollama running locally",
      "Model quality varies",
      "More verbose output",
    ],
    website: "https://github.com/openai/codex",
    cliName: "codex",
  };
}
