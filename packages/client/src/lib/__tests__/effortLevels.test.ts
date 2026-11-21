import type { ProviderInfo } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  getEffortLevelLabel,
  getEffortLevelOptions,
  getNextToggledThinkingMode,
  getThinkingModeOptions,
  normalizeEffortLevelForProvider,
  resolveSupportedEffortLevel,
  resolveSupportedThinkingMode,
} from "../effortLevels";

const claudeProvider: ProviderInfo = {
  name: "claude",
  displayName: "Claude",
  installed: true,
  authenticated: true,
  enabled: true,
};

const codexProvider: ProviderInfo = {
  name: "codex",
  displayName: "Codex",
  installed: true,
  authenticated: true,
  enabled: true,
};

const claudeGatewayProvider: ProviderInfo = {
  name: "claude-gateway",
  displayName: "Claude Gateway",
  installed: true,
  authenticated: true,
  enabled: true,
};

const piProvider: ProviderInfo = {
  name: "pi",
  displayName: "pi",
  installed: true,
  authenticated: true,
  enabled: true,
};

/** A provider with no effort vocabulary of its own, on the generic levels. */
const genericProvider: ProviderInfo = {
  name: "opencode",
  displayName: "OpenCode",
  installed: true,
  authenticated: true,
  enabled: true,
};

describe("effort level options", () => {
  it("defaults Claude to all five SDK effort levels", () => {
    expect(getEffortLevelOptions({ provider: claudeProvider })).toEqual([
      expect.objectContaining({ value: "low", label: "Low" }),
      expect.objectContaining({ value: "medium", label: "Medium" }),
      expect.objectContaining({ value: "high", label: "High" }),
      expect.objectContaining({ value: "xhigh", label: "Extra" }),
      expect.objectContaining({ value: "max", label: "Max" }),
    ]);
  });

  it("uses provider/model reported levels when present", () => {
    expect(
      getEffortLevelOptions({
        provider: claudeProvider,
        model: {
          id: "sonnet",
          name: "Sonnet",
          supportedEffortLevels: ["low", "medium", "high", "xhigh"],
        },
      }).map((option) => option.value),
    ).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("does not invent gateway effort levels without model metadata", () => {
    expect(
      getEffortLevelOptions({
        provider: claudeGatewayProvider,
        model: "unlisted-model",
      }),
    ).toEqual([]);
    expect(
      getThinkingModeOptions({
        provider: claudeGatewayProvider,
        model: "unlisted-model",
      }),
    ).toEqual(["off"]);
  });

  it("uses Codex reasoning metadata and does not invent max", () => {
    const options = getEffortLevelOptions({
      provider: codexProvider,
      model: {
        id: "gpt-5.4",
        name: "GPT-5.4",
        supportedReasoningEfforts: [
          { reasoningEffort: "low" },
          { reasoningEffort: "medium" },
          { reasoningEffort: "high" },
          { reasoningEffort: "xhigh" },
        ],
      },
    });

    expect(options.map((option) => option.value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(getEffortLevelLabel("xhigh", codexProvider)).toBe("Extra High");
  });

  it("preserves Max and normalizes native ultra to the same UI level", () => {
    const options = getEffortLevelOptions({ provider: codexProvider });

    expect(normalizeEffortLevelForProvider("max", codexProvider)).toBe("max");
    expect(normalizeEffortLevelForProvider("ultra", codexProvider)).toBe("max");
    expect(resolveSupportedEffortLevel("max", options)).toBe("xhigh");
  });

  it("offers pi every level pi itself names, Extra included", () => {
    expect(
      getEffortLevelOptions({ provider: piProvider }).map(
        (option) => option.value,
      ),
    ).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("snaps an unoffered level down, never up to the top one", () => {
    // A picker offering Low/Medium/High/Max could not be moved off Max while a
    // stored Extra was in play: every attempt resolved to the highest offered
    // level, which was Max again.
    const options = getEffortLevelOptions({ provider: genericProvider });

    expect(options.map((option) => option.value)).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(resolveSupportedEffortLevel("xhigh", options)).toBe("high");
    // Nothing is offered below the requested level, so the lowest one stands
    // in rather than the request being answered with more thinking.
    expect(resolveSupportedEffortLevel("low", [options[1]!, options[2]!])).toBe(
      "medium",
    );
  });

  it("gates thinking modes from model adaptive and effort flags", () => {
    expect(
      getThinkingModeOptions({
        provider: claudeProvider,
        model: {
          id: "adaptive-only",
          name: "Adaptive only",
          supportsAdaptiveThinking: true,
          supportsEffort: false,
        },
      }),
    ).toEqual(["off", "auto"]);

    expect(
      getThinkingModeOptions({
        provider: claudeProvider,
        model: {
          id: "no-thinking",
          name: "No thinking",
          supportsAdaptiveThinking: false,
        },
      }),
    ).toEqual(["off"]);
  });

  it("normalizes unsupported thinking modes to the closest available mode", () => {
    expect(resolveSupportedThinkingMode("on", ["off", "auto"])).toBe("auto");
    expect(resolveSupportedThinkingMode("auto", ["off"])).toBe("off");
  });

  it("exposes Auto/On with per-model efforts for Antigravity and hides controls on fixed-effort models", () => {
    const agyProvider: ProviderInfo = {
      name: "antigravity",
      displayName: "Antigravity",
      installed: true,
      authenticated: true,
      enabled: true,
    };
    const neonModel = {
      id: "gemini-4-neon",
      name: "Gemini 4 Neon",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh"] as const,
      supportedReasoningEfforts: [
        { reasoningEffort: "low" },
        { reasoningEffort: "medium" },
        { reasoningEffort: "high" },
        { reasoningEffort: "xhigh" },
      ],
    };
    const fixedModel = {
      id: "gemini-pro-orchestrator-neon",
      name: "Orchestrator (Neon)",
      supportsEffort: false,
      supportsAdaptiveThinking: false,
    };

    const neonEfforts = getEffortLevelOptions({
      provider: agyProvider,
      model: {
        ...neonModel,
        supportedEffortLevels: [...neonModel.supportedEffortLevels],
      },
    });
    expect(neonEfforts.map((o) => o.value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(
      getThinkingModeOptions({
        provider: agyProvider,
        model: {
          ...neonModel,
          supportedEffortLevels: [...neonModel.supportedEffortLevels],
        },
        effortOptions: neonEfforts,
      }),
    ).toEqual(["auto", "on"]);
    expect(
      getThinkingModeOptions({
        provider: agyProvider,
        model: fixedModel,
        effortOptions: [],
      }),
    ).toEqual(["off"]);
    // Older servers without supportsEffort metadata must not fabricate controls.
    expect(
      getEffortLevelOptions({
        provider: agyProvider,
        model: { id: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
      }),
    ).toEqual([]);
    expect(
      getThinkingModeOptions({
        provider: agyProvider,
        model: { id: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
      }),
    ).toEqual(["off"]);
    expect(getNextToggledThinkingMode("auto", "auto", ["auto", "on"])).toBe(
      "on",
    );
    expect(getNextToggledThinkingMode("on", "on", ["auto", "on"])).toBe("auto");
  });
});
