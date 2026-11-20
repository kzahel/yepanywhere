import { describe, expect, it } from "vitest";
import {
  equivalentOutputTokens,
  findModelPrices,
  longContextThresholdTokens,
  providerContextTier,
  tokenCostUsd,
  unlistedEquivalentOutputTokens,
} from "../model-prices.js";

/** Contract: topics/limited-users.md § Delivery v1 — Usage. */

const noTokens = {
  freshInputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
};

describe("findModelPrices", () => {
  it("resolves a provider model id under that provider's price list", () => {
    expect(findModelPrices("claude", "claude-opus-4-5")).toMatchObject({
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25,
    });
  });

  it("resolves a dated id by its longest listed prefix", () => {
    // The table lists both, but a model dated past the table still resolves.
    expect(findModelPrices("claude", "claude-opus-4-5-20991231")).toMatchObject(
      { output: 25 },
    );
  });

  it("ignores the 1m context marker YA adds to an alias", () => {
    expect(findModelPrices("claude", "claude-sonnet-4-5[1m]")).toMatchObject({
      output: 15,
    });
  });

  it("reads a Codex model under OpenAI's list, where cache writes are free", () => {
    expect(findModelPrices("codex", "gpt-5.5")).toMatchObject({
      input: 5,
      output: 30,
      cacheWrite: 0,
    });
  });

  it("reads the models only the published table names", () => {
    // From the providers' own pricing pages, 2026-09-21.
    expect(findModelPrices("claude", "claude-opus-5")).toMatchObject({
      input: 5,
      output: 25,
    });
    expect(findModelPrices("claude", "claude-sonnet-5")).toMatchObject({
      input: 2,
      output: 10,
    });
    expect(findModelPrices("codex", "gpt-5.6-sol")).toMatchObject({
      input: 4,
      output: 20,
      cacheRead: 0.4,
      cacheWrite: 5,
    });
    expect(findModelPrices("codex", "gpt-5.6-terra")).toMatchObject({
      input: 2,
      output: 12,
    });
    expect(findModelPrices("codex", "gpt-6-astra")).toMatchObject({
      input: 10,
      output: 50,
    });
    expect(findModelPrices("codex", "gpt-6.2-astra")).toMatchObject({
      input: 8,
      output: 40,
      cacheRead: 0.4,
      cacheWrite: 10,
    });
    expect(findModelPrices("codex", "gpt-6.2-sol")).toMatchObject({
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 2.5,
    });
    expect(findModelPrices("codex", "gpt-6-sol")).toMatchObject({
      input: 2,
      output: 10,
      cacheRead: 0.2,
      cacheWrite: 2.5,
    });
    expect(findModelPrices("codex", "gpt-6-luna")).toMatchObject({
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      cacheWrite: 0.125,
    });
  });

  it("prices the Daybreak alias as Sol, which is what it is", () => {
    expect(findModelPrices("codex", "gpt-daybreak-blue-latest")).toEqual(
      findModelPrices("codex", "gpt-5.6-sol"),
    );
  });

  it("keeps Fable 5.1's cheaper cache read, which breaks the family ratio", () => {
    // 0.025x base input, where every other Claude model is 0.1x. A per-provider
    // ratio table would price this model's cache reads four times too high.
    expect(findModelPrices("claude", "claude-fable-5-1")).toMatchObject({
      input: 10,
      cacheRead: 0.25,
    });
    expect(findModelPrices("claude", "claude-fable-5")).toMatchObject({
      input: 10,
      cacheRead: 1,
    });
  });

  it("prices Opus 5.5 at its own rates, not Opus 5's by prefix", () => {
    // Cheaper than Opus 5 and caching at 0.05x; before its own row the
    // prefix match charged it Opus 5's $5/$25 and 0.1x cache reads.
    expect(findModelPrices("claude", "claude-opus-5-5")).toEqual({
      input: 4,
      output: 20,
      cacheRead: 0.2,
      cacheWrite: 5,
    });
    expect(findModelPrices("claude", "claude-opus-5")).toMatchObject({
      input: 5,
      cacheRead: 0.5,
    });
  });

  it("prices Sonnet 5.5 and Haiku 5.5 at their own rates", () => {
    // Sonnet 5.5 shares Sonnet 5's $2/$10 but caches at 0.05x; by prefix it
    // would read Sonnet 5's 0.1x. Haiku 5.5 matches no other row at all.
    expect(findModelPrices("claude", "claude-sonnet-5-5")).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 2.5,
    });
    expect(findModelPrices("claude", "claude-haiku-5-5[1m]")).toEqual({
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      cacheWrite: 0.125,
    });
  });

  it("prices a 1m alias as the plain model, Anthropic charging flat", () => {
    expect(findModelPrices("claude", "claude-fable-5[1m]")).toEqual(
      findModelPrices("claude", "claude-fable-5"),
    );
  });

  it("has no price for an unlisted or unnamed model", () => {
    expect(findModelPrices("claude", "qwen3-coder-local")).toBe(undefined);
    expect(findModelPrices("claude", undefined)).toBe(undefined);
    // A bare launch alias is not a provider model id and is not guessed at.
    expect(findModelPrices("claude", "opus")).toBe(undefined);
  });
});

describe("tokenCostUsd", () => {
  const prices = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

  it("charges each class at its own rate", () => {
    const usd = tokenCostUsd(
      {
        freshInputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
        outputTokens: 1_000_000,
      },
      prices,
    );
    expect(usd).toBeCloseTo(5 + 0.5 + 6.25 + 25, 9);
  });

  it("does not charge a Claude prompt more for being long", () => {
    // Anthropic removed the over-200k premium on 2026-03-13: Claude 4.6 and
    // later price the whole 1M window flat.
    const classes = {
      ...noTokens,
      freshInputTokens: 1_000_000,
      outputTokens: 1_000_000,
    };
    expect(
      tokenCostUsd(classes, prices, { provider: "claude", longContext: true }),
    ).toBe(tokenCostUsd(classes, prices, { provider: "claude" }));
  });

  it("doubles an OpenAI prompt and charges output half again past the tier", () => {
    const sol = { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 };
    const classes = {
      freshInputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      outputTokens: 1_000_000,
    };
    // The published long-context rates for Sol are exactly these multiples of
    // its standard ones: $8 / $0.80 / $10 input side, $30 output.
    expect(
      tokenCostUsd(classes, sol, { provider: "codex", longContext: true }),
    ).toBeCloseTo(8 + 0.8 + 10 + 30, 9);
  });

  it("charges a long Haiku 5.5 prompt five times over, output included", () => {
    const haiku = findModelPrices("claude", "claude-haiku-5-5");
    if (!haiku) throw new Error("Haiku 5.5 is priced");
    const classes = {
      freshInputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      outputTokens: 1_000_000,
    };
    // The published over-100k rates: $0.50 / $0.05 / $0.625 input side,
    // $2.50 output.
    expect(
      tokenCostUsd(classes, haiku, {
        provider: "claude",
        model: "claude-haiku-5-5",
        longContext: true,
      }),
    ).toBeCloseTo(0.5 + 0.05 + 0.625 + 2.5, 9);
    expect(
      tokenCostUsd(classes, haiku, {
        provider: "claude",
        model: "claude-haiku-5-5",
      }),
    ).toBeCloseTo(0.1 + 0.01 + 0.125 + 0.5, 9);
  });

  it("ignores a long-context flag for a provider with no tier", () => {
    const classes = { ...noTokens, freshInputTokens: 1_000_000 };
    expect(
      tokenCostUsd(classes, prices, { provider: "gemini", longContext: true }),
    ).toBe(tokenCostUsd(classes, prices, { provider: "gemini" }));
  });
});

describe("providerContextTier", () => {
  it("has no tier for Anthropic, which prices its 1M window flat", () => {
    expect(providerContextTier("claude")).toBeNull();
    expect(longContextThresholdTokens("claude")).toBeNull();
  });

  it("puts OpenAI's tier at 272k, not Anthropic's old 200k", () => {
    expect(longContextThresholdTokens("codex")).toBe(272_000);
    expect(providerContextTier("codex")?.multipliers).toEqual({
      input: 2,
      cachedInput: 2,
      cacheWrite: 2,
      output: 1.5,
    });
  });

  it("gives Haiku 5.5 its own 100k tier and no other Claude model one", () => {
    expect(longContextThresholdTokens("claude", "claude-haiku-5-5")).toBe(
      100_000,
    );
    expect(longContextThresholdTokens("claude", "claude-haiku-5-5[1m]")).toBe(
      100_000,
    );
    expect(longContextThresholdTokens("claude", "claude-haiku-4-5")).toBeNull();
    expect(longContextThresholdTokens("claude", "claude-opus-5-5")).toBeNull();
    // A model's tier overrides its provider's, here OpenAI's 272k.
    expect(longContextThresholdTokens("codex", "gpt-6-sol")).toBe(272_000);
  });

  it("invents no tier for a provider it does not know", () => {
    expect(longContextThresholdTokens("some-local-thing")).toBeNull();
  });
});

describe("equivalentOutputTokens", () => {
  const prices = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

  it("is the dollars divided by the model's output price, exactly", () => {
    const classes = {
      freshInputTokens: 1000,
      cachedInputTokens: 9000,
      cacheWriteTokens: 500,
      outputTokens: 2000,
    };
    const usd = tokenCostUsd(classes, prices);
    expect(equivalentOutputTokens(classes, prices)).toBe(
      Math.round(usd / (prices.output / 1_000_000)),
    );
  });

  it("counts a pure generation charge as itself", () => {
    expect(
      equivalentOutputTokens({ ...noTokens, outputTokens: 1234 }, prices),
    ).toBe(1234);
  });

  it("prices a cache read at a fiftieth of an output token", () => {
    expect(
      equivalentOutputTokens({ ...noTokens, cachedInputTokens: 5000 }, prices),
    ).toBe(100);
  });

  it("has no unit for a model whose output is free", () => {
    expect(
      equivalentOutputTokens(
        { ...noTokens, outputTokens: 10 },
        {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      ),
    ).toBeNull();
  });
});

describe("unlistedEquivalentOutputTokens", () => {
  it("prices a fresh prompt token midway between the listed families", () => {
    // Output runs 5x a fresh prompt token on Anthropic and 5-6x on OpenAI.
    expect(
      unlistedEquivalentOutputTokens({ ...noTokens, freshInputTokens: 5500 }),
    ).toBe(1000);
  });

  it("counts generation as itself", () => {
    expect(
      unlistedEquivalentOutputTokens({ ...noTokens, outputTokens: 42 }),
    ).toBe(42);
  });

  it("prices a cache read at a tenth of a fresh prompt token", () => {
    expect(
      unlistedEquivalentOutputTokens({
        ...noTokens,
        cachedInputTokens: 55_000,
      }),
    ).toBe(1000);
  });
});
