import { describe, expect, it } from "vitest";
import {
  advertisedGatewayEffortLevels,
  builtInGatewayModelEffort,
  gatewayModelEffort,
  nearestGatewayEffortLevel,
  parseGatewayServices,
  type GatewayEndpointEffortProbe,
  type GatewayModelEffort,
} from "../src/index.js";

/** What a vLLM endpoint answers when asked; see gateway-effort-probe. */
const VLLM_PROBE: GatewayEndpointEffortProbe = {
  levels: ["low", "medium", "high", "xhigh", "max"],
  noThinking: true,
};

describe("advertisedGatewayEffortLevels", () => {
  it("reads a copilot-style row's own claim, in ascending order", () => {
    expect(
      advertisedGatewayEffortLevels({
        capabilities: { supports: { reasoning_effort: ["high", "low"] } },
      }),
    ).toEqual(["low", "high"]);
  });

  it("finds nothing in a vLLM row, which states no reasoning at all", () => {
    expect(
      advertisedGatewayEffortLevels({ capabilities: { supports: {} } }),
    ).toEqual([]);
    expect(advertisedGatewayEffortLevels(undefined)).toEqual([]);
  });

  it("ignores values that are not levels YA names", () => {
    expect(
      advertisedGatewayEffortLevels({
        capabilities: {
          supports: { reasoning_effort: ["none", "minimal", "high"] },
        },
      }),
    ).toEqual(["high"]);
  });
});

describe("gatewayModelEffort with a probed endpoint", () => {
  it("offers what the endpoint answered when nothing else describes the model", () => {
    expect(
      gatewayModelEffort({ modelId: "qwen3-coder-30b", probed: VLLM_PROBE }),
    ).toEqual({
      levels: ["low", "medium", "high", "xhigh", "max"],
      noThinking: true,
    });
  });

  it("keeps a known family's curated levels over the endpoint's raw list", () => {
    // The endpoint accepts five of YA's levels; DeepSeek V4 only behaves
    // differently for three of them, and a menu must not repeat a behavior.
    expect(
      gatewayModelEffort({ modelId: "deepseek-v4-flash", probed: VLLM_PROBE }),
    ).toEqual({
      levels: ["low", "high", "max"],
      defaultLevel: "high",
      noThinking: true,
    });
  });

  it("keeps configuration and per-model claims ahead of the endpoint's list", () => {
    expect(
      gatewayModelEffort({
        modelId: "qwen3-coder-30b",
        configuredLevels: ["low", "high"],
        configuredDefaultLevel: "high",
        probed: VLLM_PROBE,
      }),
    ).toMatchObject({ levels: ["low", "high"], defaultLevel: "high" });
    expect(
      gatewayModelEffort({
        modelId: "qwen3-coder-30b",
        advertisedLevels: ["medium"],
        probed: VLLM_PROBE,
      }),
    ).toMatchObject({ levels: ["medium"] });
  });

  it("still learns thinking-off from the endpoint when levels came elsewhere", () => {
    // Which levels to offer and whether thinking can be switched off are
    // separate questions; a ticked list says nothing about the latter.
    expect(
      gatewayModelEffort({
        modelId: "qwen3-coder-30b",
        configuredLevels: ["low", "high"],
        probed: VLLM_PROBE,
      }),
    ).toMatchObject({ noThinking: true });
  });

  it("offers no control at all when no source describes the model", () => {
    expect(gatewayModelEffort({ modelId: "qwen3-coder-30b" })).toBeUndefined();
    expect(
      gatewayModelEffort({
        modelId: "qwen3-coder-30b",
        probed: { levels: [], noThinking: false },
      }),
    ).toBeUndefined();
  });
});

describe("gatewayModelEffort", () => {
  it("knows the DeepSeek V4 vocabulary a bare catalog cannot state", () => {
    // The chat encoder collapses seven request values onto four behaviors, so
    // only the levels that reach a distinct one are offered.
    expect(builtInGatewayModelEffort("deepseek-v4-flash-0731")).toEqual({
      levels: ["low", "high", "max"],
      defaultLevel: "high",
      noThinking: true,
    });
    expect(builtInGatewayModelEffort("qwen3-coder-30b")).toBeUndefined();
  });

  it("prefers configuration, then the catalog, then the model family", () => {
    expect(
      gatewayModelEffort({
        modelId: "deepseek-v4-flash",
        configuredLevels: ["low", "medium"],
        advertisedLevels: ["low", "high", "xhigh"],
      })?.levels,
    ).toEqual(["low", "medium"]);
    expect(
      gatewayModelEffort({
        modelId: "deepseek-v4-flash",
        advertisedLevels: ["low", "high", "xhigh"],
      })?.levels,
    ).toEqual(["low", "high", "xhigh"]);
    expect(
      gatewayModelEffort({ modelId: "deepseek-v4-flash" })?.levels,
    ).toEqual(["low", "high", "max"]);
    expect(gatewayModelEffort({ modelId: "qwen3-coder-30b" })).toBeUndefined();
  });

  it("keeps what the model family knows that a level list cannot say", () => {
    // Which levels exist is a configuration choice; whether the endpoint
    // accepts "no thinking at all" is a fact about the model.
    const effort = gatewayModelEffort({
      modelId: "deepseek-v4-flash",
      configuredLevels: ["low", "high"],
    });
    expect(effort?.noThinking).toBe(true);
    expect(
      gatewayModelEffort({
        modelId: "some-other-model",
        configuredLevels: ["low", "high"],
      })?.noThinking,
    ).toBeUndefined();
  });

  it("ignores a stated default that is not one of the stated levels", () => {
    expect(
      gatewayModelEffort({
        modelId: "some-model",
        configuredLevels: ["low", "high"],
        configuredDefaultLevel: "max",
      })?.defaultLevel,
    ).toBeUndefined();
  });

  it("orders levels however they were stated", () => {
    expect(
      gatewayModelEffort({
        modelId: "some-model",
        configuredLevels: ["max", "low", "high"],
      })?.levels,
    ).toEqual(["low", "high", "max"]);
  });

  it("snaps an unlisted level down, never up", () => {
    const effort: GatewayModelEffort = { levels: ["low", "high", "max"] };
    expect(nearestGatewayEffortLevel(effort, "medium")).toBe("low");
    expect(nearestGatewayEffortLevel(effort, "xhigh")).toBe("high");
    expect(nearestGatewayEffortLevel(effort, "high")).toBe("high");
    // Nothing sits below the request, so the cheapest listed level stands in.
    expect(nearestGatewayEffortLevel({ levels: ["high"] }, "low")).toBe("high");
  });
});

describe("parseGatewayServices effort levels", () => {
  const base = { id: "vllm", url: "http://127.0.0.1:8001" };

  it("keeps a stated list and its default", () => {
    expect(
      parseGatewayServices([
        { ...base, effortLevels: ["low", "high"], defaultEffortLevel: "high" },
      ])?.[0],
    ).toMatchObject({
      effortLevels: ["low", "high"],
      defaultEffortLevel: "high",
    });
  });

  it("rejects a list that states nothing, repeats itself, or is not a level", () => {
    expect(parseGatewayServices([{ ...base, effortLevels: [] }])).toBeNull();
    expect(
      parseGatewayServices([{ ...base, effortLevels: ["low", "low"] }]),
    ).toBeNull();
    expect(
      parseGatewayServices([{ ...base, effortLevels: ["enormous"] }]),
    ).toBeNull();
    expect(parseGatewayServices([{ ...base, effortLevels: "low" }])).toBeNull();
  });

  it("rejects a default that no stated level backs", () => {
    expect(
      parseGatewayServices([{ ...base, defaultEffortLevel: "high" }]),
    ).toBeNull();
    expect(
      parseGatewayServices([
        { ...base, effortLevels: ["low"], defaultEffortLevel: "high" },
      ]),
    ).toBeNull();
  });

  it("leaves an entry that states none alone", () => {
    const [service] = parseGatewayServices([base]) ?? [];
    expect(service?.effortLevels).toBeUndefined();
    expect(service?.defaultEffortLevel).toBeUndefined();
  });
});
