import { ALL_PROVIDERS, agentHarness } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import { agentHarness as hostAgentHarness } from "../../../../../scripts/provider-runtime-host.mjs";

describe("agentHarness", () => {
  it("answers the harness family for every provider variant", () => {
    expect(agentHarness("claude-gateway")).toBe("claude");
    expect(agentHarness("claude-ollama")).toBe("claude");
    expect(agentHarness("codex-oss")).toBe("codex");
    expect(agentHarness("gemini-acp")).toBe("gemini");
  });

  it("leaves a name that is already a harness alone", () => {
    expect(agentHarness("gemini")).toBe("gemini");
    expect(agentHarness("grok")).toBe("grok");
    expect(agentHarness("opencode")).toBe("opencode");
    expect(agentHarness("pi")).toBe("pi");
  });

  // The provider runtime host publishes AGENT_LAUNCH_HARNESS from its own copy
  // (it runs under plain `node`), so a session launched through the host and
  // one launched in-process must not disagree about what started it.
  it("agrees with the provider runtime host for every provider", () => {
    for (const provider of ALL_PROVIDERS) {
      expect([provider, hostAgentHarness(provider)]).toEqual([
        provider,
        agentHarness(provider),
      ]);
    }
  });
});
