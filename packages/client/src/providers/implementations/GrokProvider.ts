import type {
  Provider,
  ProviderCapabilities,
  ProviderMetadata,
} from "../types";

export class GrokProvider implements Provider {
  readonly id = "grok";
  readonly displayName = "Grok Build";

  readonly capabilities: ProviderCapabilities = {
    supportsDag: false,
    usesDurableOrderAnchors: true,
    supportsCloning: false,
    // Assistant, thinking, plan and tool rows align deterministically across
    // the live ACP stream and the durable `updates.jsonl` replay (event id and
    // tool-call id), so no content/timestamp backstop is needed. User turns
    // cannot: Grok mints their durable identity and accepts none from YA.
    needsApproxMessageDedup: false,
    dedupSelfSendUserEchoes: true,
  };

  readonly metadata: ProviderMetadata = {
    description:
      "xAI Grok Build via Agent Client Protocol. Experimental integration with structured tool and thinking updates.",
    limitations: [
      "Requires the grok CLI to be installed and logged in",
      "Session history replay is currently summary-only",
    ],
    website: "https://docs.x.ai/build",
    cliName: "grok",
  };
}
