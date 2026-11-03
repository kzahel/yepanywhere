import { describe, expect, it } from "vitest";
import {
  getModelIndicatorModelLabel,
  getModelIndicatorModelParts,
} from "../modelIndicatorText";

describe("getModelIndicatorModelLabel", () => {
  it.each([
    ["gemini-3.8-flash-high", "Gem 3.8F"],
    ["gemini-3.8-flash-medium", "Gem 3.8F"],
    ["gemini-3.1-pro", "Gem 3.1P"],
    ["gemini-3.8-flash-lite-low", "Gem 3.8FL"],
    ["claude-opus-5-5", "Cl ◐ 5.5"],
    ["gpt-6.1-sol", "Cd So 6.1"],
    ["future-model", "Agy future-model"],
  ])("shows Antigravity's actual model family for %s", (model, label) => {
    expect(getModelIndicatorModelLabel("antigravity", model)).toBe(label);
  });
  describe("claude models", () => {
    it("sonnet", () => {
      expect(getModelIndicatorModelLabel("claude", "claude-sonnet-4-6")).toBe(
        "Cl ♪ 4.6",
      );
    });
    it("opus", () => {
      expect(getModelIndicatorModelLabel("claude", "claude-opus-4-8")).toBe(
        "Cl ◐ 4.8",
      );
    });
    it("fable", () => {
      expect(getModelIndicatorModelLabel("claude", "claude-fable-5")).toBe(
        "Cl Fb 5",
      );
    });
    it("fable alias", () => {
      expect(getModelIndicatorModelLabel("claude", "fable")).toBe("Cl Fb");
    });
    it("opus alias", () => {
      expect(getModelIndicatorModelLabel("claude", "opus")).toBe("Cl ◐");
    });
    it("opus 1m alias", () => {
      expect(getModelIndicatorModelLabel("claude", "opus[1m]")).toBe("Cl ◐ 1m");
    });
    it("opus plan alias", () => {
      expect(getModelIndicatorModelLabel("claude", "opusplan")).toBe(
        "Cl ◐ Plan",
      );
    });
    it("haiku", () => {
      expect(getModelIndicatorModelLabel("claude", "claude-haiku-3-5")).toBe(
        "Cl ✎ 3.5",
      );
    });
    it("sonnet 1m extended context", () => {
      const label = getModelIndicatorModelLabel(
        "claude",
        "claude-sonnet-4-6[1m]",
      );
      expect(label).toMatch(/^Cl ♪/);
    });
  });

  describe("codex models", () => {
    it("abbreviates Daybreak and gives it an independent accent", () => {
      expect(
        getModelIndicatorModelLabel("codex", "gpt-daybreak-blue-latest"),
      ).toBe("Cd Db");
      expect(
        getModelIndicatorModelParts("codex", "gpt-daybreak-blue-latest"),
      ).toMatchObject({ modelLabel: "Db", modelAccent: "daybreak" });
    });

    it.each([
      ["gpt-6-astra", "Cd As"],
      ["gpt-6-sol", "Cd So"],
      ["gpt-6-luna", "Cd Lu"],
      ["gpt-6.1-sol", "Cd So 6.1"],
      ["gpt-6.1-astra", "Cd As 6.1"],
      ["gpt-6.1-terra", "Cd Te 6.1"],
      ["gpt-6.2-luna", "Cd Lu 6.2"],
      ["gpt-7.1-sol", "Cd So 7.1"],
      ["gpt-6.1-sol-preview", "Cd So 6.1-preview"],
      ["gpt-6.1-solar", "Cd gpt-6.1-solar"],
      ["gpt-5.6-sol", "Cd ☀"],
      ["gpt-5.6-terra", "Cd ♁"],
      ["gpt-5.6-luna", "Cd ☾"],
    ])("%s uses its semantic short glyph", (model, expected) => {
      expect(getModelIndicatorModelLabel("codex", model)).toBe(expected);
    });
    it.each([
      ["codex", "openai/gpt-6.1-sol", "Cd So 6.1"],
      ["codex", "gpt-6.1-codex-sol", "Cd So 6.1"],
      ["codex-oss", "gpt-6.1-sol", "Cd↓ So 6.1"],
      ["opencode", "github-copilot/gpt-6.1-sol", "OC copilot So 6.1"],
    ])("%s abbreviates versioned named model %s", (provider, model, label) => {
      expect(getModelIndicatorModelLabel(provider, model)).toBe(label);
    });
    it("gpt-5.4-mini", () => {
      expect(getModelIndicatorModelLabel("codex", "gpt-5.4-mini")).toBe(
        "Cd ◇ 5.4-mini",
      );
    });
    it("gpt-5.4-spark", () => {
      expect(getModelIndicatorModelLabel("codex", "gpt-5.4-spark")).toBe(
        "Cd ⚡",
      );
    });
    it("gpt-5.4-codex-spark", () => {
      expect(getModelIndicatorModelLabel("codex", "gpt-5.4-codex-spark")).toBe(
        "Cd ⚡",
      );
    });
    it("gpt-5.3-codex-spark", () => {
      expect(getModelIndicatorModelLabel("codex", "gpt-5.3-codex-spark")).toBe(
        "Cd ⚡",
      );
    });
    it("gpt-5.4 generic", () => {
      expect(getModelIndicatorModelLabel("codex", "gpt-5.4")).toBe("Cd ◇ 5.4");
    });
    it("gpt-5.4-codex generic", () => {
      expect(getModelIndicatorModelLabel("codex", "gpt-5.4-codex")).toBe(
        "Cd ◇ 5.4",
      );
    });
    it("gpt-5.5-codex generic", () => {
      expect(getModelIndicatorModelLabel("codex", "gpt-5.5-codex")).toBe(
        "Cd ◆ 5.5",
      );
    });
    it("gpt-4", () => {
      expect(getModelIndicatorModelLabel("codex", "gpt-4")).toBe("Cd ⧉ 4");
    });
    it("openai/ prefix stripped", () => {
      expect(getModelIndicatorModelLabel("codex", "openai/gpt-5.4-mini")).toBe(
        "Cd ◇ 5.4-mini",
      );
    });
  });

  describe("gemini models", () => {
    it("2.5-flash", () => {
      expect(getModelIndicatorModelLabel("gemini", "gemini-2.5-flash")).toBe(
        "✦ ⚡",
      );
    });
    it("2.5-pro", () => {
      expect(getModelIndicatorModelLabel("gemini", "gemini-2.5-pro")).toBe(
        "✦ ✹",
      );
    });
    it("1.5-pro", () => {
      expect(getModelIndicatorModelLabel("gemini", "gemini-1.5-pro")).toBe(
        "✦ ✹",
      );
    });
  });

  describe("sub-provider namespaced models (opencode routing)", () => {
    it("github-copilot/claude-opus renders OC + copilot + native opus glyph", () => {
      expect(
        getModelIndicatorModelLabel(
          "opencode",
          "github-copilot/claude-opus-4.8",
        ),
      ).toBe("OC copilot ◐ 4.8");
    });
    it("github-copilot/gpt routes to codex glyph rules", () => {
      expect(
        getModelIndicatorModelLabel("opencode", "github-copilot/gpt-5.4"),
      ).toBe("OC copilot ◇ 5.4");
    });
    it("keeps a routed Daybreak model's abbreviation and accent", () => {
      expect(
        getModelIndicatorModelParts(
          "opencode",
          "github-copilot/gpt-daybreak-blue-latest",
        ),
      ).toMatchObject({
        providerGlyph: "OC",
        subProvider: "copilot",
        modelLabel: "Db",
        modelAccent: "daybreak",
      });
    });
    it("unknown sub-provider falls back to the cleaned path segment", () => {
      expect(
        getModelIndicatorModelLabel("opencode", "openrouter/claude-sonnet-4-6"),
      ).toBe("OC openrouter ♪ 4.6");
    });
    it("unrecognized inner model keeps its bare name as the third part", () => {
      expect(
        getModelIndicatorModelLabel("opencode", "github-copilot/whatever-1"),
      ).toBe("OC copilot whatever-1");
    });
    it("huggingface renders as HF and drops the org/dirname", () => {
      expect(
        getModelIndicatorModelLabel("pi", "huggingface/minimaxai/minimax-m2.1"),
      ).toBe("pi HF minimax-m2.1");
    });
    it("huggingface org-namespaced model keeps a verbatim basename (no glyph, no stray slash)", () => {
      expect(
        getModelIndicatorModelLabel("pi", "huggingface/qwen/qwen3-coder-next"),
      ).toBe("pi HF qwen3-coder-next");
      expect(
        getModelIndicatorModelLabel(
          "pi",
          "huggingface/qwen/qwen3-235b-a22b-thinking-2507",
        ),
      ).toBe("pi HF qwen3-235b-a22b-thinking-2507");
    });
  });

  describe("fallbacks", () => {
    it("unknown model falls back to provider abbrev + raw model", () => {
      expect(
        getModelIndicatorModelLabel("claude", "some-novel-model-xyz"),
      ).toBe("Cl some-novel-model-xyz");
    });
    it("unknown provider uses fallback glyph", () => {
      expect(
        getModelIndicatorModelLabel("unknown-provider", "some-model"),
      ).toBe("◌ some-model");
    });
    it("empty model returns empty string", () => {
      expect(getModelIndicatorModelLabel("claude", "")).toBe("");
    });
    it("undefined model returns empty string", () => {
      expect(getModelIndicatorModelLabel("claude", undefined)).toBe("");
    });
  });

  describe("provider abbreviations", () => {
    it.each([
      ["claude", "Cl"],
      ["claude-gateway", "Cl↗"],
      ["claude-ollama", "Cl↓"],
      ["codex", "Cd"],
      ["codex-oss", "Cd↓"],
      ["gemini", "✦"],
      ["gemini-acp", "✦"],
      ["grok", "Gk"],
      ["opencode", "OC"],
    ])("provider %s uses abbrev %s", (provider, abbrev) => {
      const label = getModelIndicatorModelLabel(provider, "unknown-model-zzz");
      expect(label.startsWith(abbrev)).toBe(true);
    });
  });

  describe("variant provider model rules fall back to base provider", () => {
    it("claude-gateway uses claude model rules", () => {
      expect(
        getModelIndicatorModelLabel("claude-gateway", "claude-sonnet-4.6"),
      ).toBe("Cl↗ ♪ 4.6");
    });

    it("claude-ollama uses claude model rules", () => {
      expect(
        getModelIndicatorModelLabel("claude-ollama", "claude-sonnet-4-6"),
      ).toBe("Cl↓ ♪ 4.6");
    });
    it("grok-4.6 and grok-4.5 use the Grok abbrev plus version", () => {
      expect(getModelIndicatorModelLabel("grok", "grok-4.6")).toBe("Gk 4.6");
      expect(getModelIndicatorModelLabel("grok", "grok-4.5")).toBe("Gk 4.5");
      expect(getModelIndicatorModelLabel("grok", "grok-build")).toBe("Gk");
    });

    it("gemini-acp uses gemini model rules", () => {
      expect(
        getModelIndicatorModelLabel("gemini-acp", "gemini-2.5-flash"),
      ).toBe("✦ ⚡");
    });
    it("codex-oss uses its own explicit rules (not codex fallback)", () => {
      expect(getModelIndicatorModelLabel("codex-oss", "gpt-5.4-mini")).toBe(
        "Cd↓ ◇ 5.4-mini",
      );
    });
    it("codex-oss maps 5.3-codex-spark to spark icon", () => {
      expect(
        getModelIndicatorModelLabel("codex-oss", "gpt-5.3-codex-spark"),
      ).toBe("Cd↓ ⚡");
    });
    it("codex-oss maps 5.4-codex-spark to spark icon", () => {
      expect(
        getModelIndicatorModelLabel("codex-oss", "gpt-5.4-codex-spark"),
      ).toBe("Cd↓ ⚡");
    });
  });
});
