import { describe, expect, it } from "vitest";
import {
  CODEX_CLI_GPT55_MIN_VERSION,
  CODEX_CLI_GPT56_MIN_VERSION,
  CODEX_CLI_GPT56_REDUCED_CATALOG_MIN_VERSION,
  CODEX_CLI_GPT56_RESTORED_CATALOG_MIN_VERSION,
  compareSemver,
  getFallbackCodexModelsForCliVersion,
  normalizeCodexModelList,
  normalizeSemver,
} from "../../../src/sdk/providers/codex-model-catalog.js";

describe("Codex model catalog", () => {
  it("normalizes Codex CLI version output and compares prereleases", () => {
    expect(normalizeSemver("codex-cli 0.123.9")).toBe("0.123.9");
    expect(normalizeSemver("0.124.0-beta.1")).toBe("0.124.0-beta.1");
    expect(normalizeSemver("not a version")).toBeNull();

    expect(compareSemver("0.123.9", CODEX_CLI_GPT55_MIN_VERSION)).toBeLessThan(
      0,
    );
    expect(compareSemver("0.124.0-beta.1", "0.124.0")).toBeLessThan(0);
    expect(compareSemver("0.124.0", "0.124.0-beta.1")).toBeGreaterThan(0);
    expect(compareSemver("0.124.0", CODEX_CLI_GPT55_MIN_VERSION)).toBe(0);
  });

  it("selects fallback models supported by the installed CLI generation", () => {
    expect(
      getFallbackCodexModelsForCliVersion("0.123.9").map((model) => model.id),
    ).toEqual([
      "gpt-5.3-codex",
      "gpt-5.2-codex",
      "gpt-5.1-codex-max",
      "gpt-5.2",
      "gpt-5.1-codex-mini",
    ]);
    const gpt55Models = ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.2"];
    expect(
      getFallbackCodexModelsForCliVersion(CODEX_CLI_GPT55_MIN_VERSION).map(
        (model) => model.id,
      ),
    ).toEqual(gpt55Models);
    expect(
      getFallbackCodexModelsForCliVersion("0.143.99").map((model) => model.id),
    ).toEqual(gpt55Models);

    const gpt56Models = getFallbackCodexModelsForCliVersion(
      CODEX_CLI_GPT56_MIN_VERSION,
    );
    expect(gpt56Models.map((model) => model.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex",
      "gpt-5.2",
    ]);
    expect(
      gpt56Models.filter((model) => model.isDefault).map((model) => model.id),
    ).toEqual(["gpt-5.6-sol"]);
    expect(
      getFallbackCodexModelsForCliVersion(
        CODEX_CLI_GPT56_REDUCED_CATALOG_MIN_VERSION,
      ).map((model) => model.id),
    ).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    expect(
      getFallbackCodexModelsForCliVersion(
        CODEX_CLI_GPT56_RESTORED_CATALOG_MIN_VERSION,
      ).map((model) => model.id),
    ).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.4",
      "gpt-5.4-mini",
    ]);
    expect(getFallbackCodexModelsForCliVersion(null)[0]).toMatchObject({
      id: "gpt-5.6-sol",
      isDefault: true,
      defaultReasoningEffort: "low",
    });
  });

  it("places the provider default before YA's preferred model order", () => {
    const models = normalizeCodexModelList([
      {
        id: "gpt-6-astra",
        model: "gpt-6-astra",
        displayName: "GPT-6-Astra",
        description: "Our most capable model for complex, demanding work.",
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          {
            reasoningEffort: "ultra",
            description: "Maximum reasoning with automatic task delegation",
          },
        ],
        inputModalities: ["text", "image"],
        supportsPersonality: false,
        serviceTiers: [
          {
            id: "priority",
            name: "Fast",
            description: "2x speed, increased usage",
          },
        ],
      },
      {
        id: "gpt-5.4",
        model: "gpt-5.4",
        displayName: "gpt-5.4",
        description: "Strong model for everyday coding.",
        isDefault: false,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          {
            reasoningEffort: "low",
            description: "Fast responses with lighter reasoning",
          },
          {
            reasoningEffort: "medium",
            description: "Balanced speed and reasoning",
          },
        ],
        inputModalities: ["text", "image"],
        supportsPersonality: true,
        serviceTiers: [
          {
            id: "priority",
            name: "Fast",
            description: "1.5x speed, increased usage",
          },
        ],
      },
      {
        id: "gpt-5.6-sol",
        model: "gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
        description: "Latest frontier agentic coding model.",
        isDefault: false,
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: [
          {
            reasoningEffort: "ultra",
            description: "Maximum reasoning with automatic task delegation",
          },
        ],
        inputModalities: ["text", "image"],
        supportsPersonality: false,
        serviceTiers: [
          {
            id: "priority",
            name: "Fast",
            description: "1.5x speed, increased usage",
          },
        ],
      },
      {
        id: "gpt-5.5",
        model: "gpt-5.5",
        displayName: "GPT-5.5",
        description: "Frontier model.",
        isDefault: false,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          {
            reasoningEffort: "high",
            description: "Greater reasoning depth",
          },
        ],
        inputModalities: ["text", "image"],
        supportsPersonality: true,
        serviceTiers: [
          {
            id: "priority",
            name: "Fast",
            description: "1.5x speed, increased usage",
          },
        ],
      },
      {
        id: "gpt-daybreak-blue-latest",
        model: "gpt-daybreak-blue-latest",
        displayName: "Daybreak Blue",
        description: "Defensive cybersecurity model.",
        isDefault: false,
      },
      {
        id: "gpt-5.3-codex",
        model: "gpt-5.3-codex",
        upgrade: "gpt-5.4",
        hidden: false,
      },
      {
        id: "gpt-5.2",
        model: "gpt-5.2",
        upgrade: "gpt-5.3-codex-spark",
      },
      {
        id: "internal-hidden",
        model: "internal-hidden",
        hidden: true,
      },
    ]);

    // Withdrawn models are dropped whether listed live or named as an upgrade.
    expect(models.map((model) => model.id)).toEqual([
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-daybreak-blue-latest",
      "gpt-5.4",
      "gpt-5.3-codex",
      "gpt-5.2",
    ]);
    expect(models[0]).toMatchObject({
      name: "GPT-6-Astra",
      isDefault: true,
      defaultReasoningEffort: "medium",
      contextWindow: 272_000,
      supportsPersonality: false,
      serviceTiers: [
        {
          id: "priority",
          name: "Fast",
          description: "2x speed, increased usage",
        },
      ],
    });
    expect(models[1]).toMatchObject({
      name: "GPT-5.6-Sol",
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: [
        {
          reasoningEffort: "ultra",
          description: "Maximum reasoning with automatic task delegation",
        },
      ],
      inputModalities: ["text", "image"],
      contextWindow: 272_000,
      supportsPersonality: false,
      serviceTiers: [
        {
          id: "priority",
          name: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
    });
    expect(models[3]).toMatchObject({ inputModalities: ["text", "image"] });
    expect(models[2]).toMatchObject({
      name: "Daybreak Blue",
      description: "Defensive cybersecurity model.",
    });
  });

  it("ranks the GPT-6 family together with the bundled 272K window", () => {
    const models = normalizeCodexModelList([
      { id: "gpt-5.6-sol", model: "gpt-5.6-sol" },
      { id: "gpt-6-luna", model: "gpt-6-luna" },
      { id: "gpt-6-sol", model: "gpt-6-sol" },
      { id: "gpt-6-astra", model: "gpt-6-astra" },
      { id: "gpt-6.1-terra", model: "gpt-6.1-terra" },
      { id: "gpt-6.1-sol", model: "gpt-6.1-sol", isDefault: true },
    ]);

    expect(models.map((model) => model.id)).toEqual([
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6.1-terra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
    ]);
    for (const model of models) {
      expect(model.contextWindow).toBe(272_000);
    }
  });

  it("uses the installed Codex catalog's Sol window when metadata is absent", () => {
    const models = [
      { id: "gpt-6.1-sol" },
      { id: "gpt-6.2-astra" },
      { id: "gpt-6.2-sol", isDefault: true },
    ];
    expect(normalizeCodexModelList(models, "0.170.0")).toEqual([
      expect.objectContaining({ id: "gpt-6.2-sol", contextWindow: 500_000 }),
      expect.objectContaining({ id: "gpt-6.2-astra", contextWindow: 272_000 }),
      expect.objectContaining({ id: "gpt-6.1-sol", contextWindow: 500_000 }),
    ]);
    expect(
      normalizeCodexModelList(models.slice(0, 1), "0.169.0")[0],
    ).toMatchObject({
      contextWindow: 272_000,
    });
  });

  it("honors a provider default even when a preferred model is available", () => {
    const models = normalizeCodexModelList([
      { id: "gpt-5.4", model: "gpt-5.4", isDefault: true },
      { id: "gpt-5.6-terra", model: "gpt-5.6-terra", isDefault: false },
    ]);

    expect(models.map((model) => model.id)).toEqual([
      "gpt-5.4",
      "gpt-5.6-terra",
    ]);
  });

  it("uses YA's preferred order when the provider marks no default", () => {
    const models = normalizeCodexModelList([
      { id: "gpt-5.4", model: "gpt-5.4", isDefault: false },
      { id: "gpt-5.6-terra", model: "gpt-5.6-terra", isDefault: false },
    ]);

    expect(models.map((model) => model.id)).toEqual([
      "gpt-5.6-terra",
      "gpt-5.4",
    ]);
  });
});
