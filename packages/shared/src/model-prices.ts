/**
 * Pricing recorded token usage: what a set of token counts cost, and the same
 * cost as a count of that model's output tokens.
 *
 * Contract: topics/limited-users.md § Delivery v1 — Usage.
 *
 * The two numbers are one calculation. Dollars come from a per-model price
 * table; the output-token equivalent is those dollars divided by the one
 * constant that model charges per output token. So the equivalent is exactly
 * "what this would have cost as plain generation on this model", and the dollar
 * figure is a supplement to it rather than a separate estimate that could
 * disagree.
 *
 * Why the equivalent leads: a model's prices change, and a report that reads in
 * output tokens keeps meaning the same thing when they do. Dollars are what the
 * table happened to say when the report was drawn.
 *
 * Two price sources, in order. `PUBLISHED_MODEL_PRICES` below is read from the
 * providers' own pricing pages on a stated date, and covers the models YA
 * launches that the vendored table does not name. The vendored extract of pi's
 * table backs it up for everything else. Neither is authoritative for long: see
 * gaps/usage-cost-price-table.md.
 */

import type { UsageTokenClasses } from "./user-usage.js";
import {
  VENDORED_MODEL_PRICES,
  type VendoredModelPrices,
} from "./vendor/pi-model-prices/prices.generated.js";

/**
 * Which upstream price list a YA provider reads. `pi` is absent because it
 * proxies whatever model it was pointed at; those resolve by searching every
 * list instead.
 */
const UPSTREAM_PROVIDER_BY_YA_PROVIDER: Readonly<Record<string, string>> = {
  claude: "anthropic",
  "claude-gateway": "anthropic",
  "claude-ollama": "anthropic",
  codex: "openai-codex",
  "codex-oss": "openai",
  opencode: "opencode",
  grok: "xai",
  gemini: "google",
  "gemini-acp": "google",
};

/**
 * Rates YA read from the providers' own pricing pages on **2026-09-21**,
 * because the vendored table does not name these models:
 *
 * - `platform.claude.com/docs/en/about-claude/pricing` — Claude Opus 5,
 *   Sonnet 5, Fable 5.1 and Mythos 5/5.1; Opus 5.5 added on 2026-09-28;
 *   Sonnet 5.5 and Haiku 5.5 on 2026-10-08; Fable and Mythos 5.2 on
 *   2026-11-10.
 *   **Fable 5.1 and Mythos 5.1 break the family's usual 0.1x cache-read ratio
 *   at 0.025x, and Opus 5.5 and Sonnet 5.5 at 0.05x**, which is exactly why
 *   this is a per-model table and not a set of per-provider ratios.
 * - `developers.openai.com/api/docs/pricing` — the GPT-5.6 family, GPT-6
 *   Astra/Sol/Luna (standard short-context rates) and the Daybreak alias. `gpt-daybreak-blue` is an alias of `gpt-5.6-sol`
 *   and carries its rates.
 *
 * Read before the vendored table, so a model both name resolves to whichever
 * of the two is newer — which is this one until the extract is regenerated.
 */
const PUBLISHED_MODEL_PRICES: Readonly<
  Record<string, Readonly<Record<string, VendoredModelPrices>>>
> = {
  anthropic: {
    // Opus 5.5 is cheaper than Opus 5 and caches at 0.05x, not 0.1x (read
    // 2026-09-28). Without its own row it matched Opus 5 by prefix.
    "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    // Sonnet 5.5 keeps Sonnet 5's $2/$10 but caches at 0.05x (read
    // 2026-10-08). Without its own row it matched Sonnet 5 by prefix.
    "claude-sonnet-5-5": {
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 2.5,
    },
    "claude-sonnet-5": {
      input: 2,
      output: 10,
      cacheRead: 0.2,
      cacheWrite: 2.5,
    },
    // Fable/Mythos 5.2 (read 2026-11-10). Without their own rows they
    // matched Fable 5 / Mythos 5 by prefix.
    "claude-fable-5-2": {
      input: 8,
      output: 40,
      cacheRead: 0.2,
      cacheWrite: 10,
    },
    "claude-mythos-5-2": {
      input: 8,
      output: 40,
      cacheRead: 0.2,
      cacheWrite: 10,
    },
    "claude-fable-5-1": {
      input: 10,
      output: 50,
      cacheRead: 0.25,
      cacheWrite: 12.5,
    },
    "claude-mythos-5-1": {
      input: 10,
      output: 50,
      cacheRead: 0.25,
      cacheWrite: 12.5,
    },
    "claude-mythos-5": {
      input: 10,
      output: 50,
      cacheRead: 1,
      cacheWrite: 12.5,
    },
    // The rates for prompts up to 100k tokens; HAIKU_5_5_CONTEXT_TIER
    // reprices longer ones.
    "claude-haiku-5-5": {
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      cacheWrite: 0.125,
    },
  },
  "openai-codex": {
    "gpt-6-astra": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    "gpt-6-sol": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    "gpt-6-luna": {
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      cacheWrite: 0.125,
    },
    "gpt-5.6-sol": { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
    "gpt-5.6-terra": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
    "gpt-5.6-luna": {
      input: 0.2,
      output: 1.2,
      cacheRead: 0.02,
      cacheWrite: 0.25,
    },
    "gpt-daybreak-blue": {
      input: 4,
      output: 20,
      cacheRead: 0.4,
      cacheWrite: 5,
    },
  },
};

/**
 * A provider's long-context tier: above `thresholdTokens` prompt tokens, the
 * **whole request** is repriced by these multipliers, not just the tokens above
 * the threshold. Null means the provider charges one rate at every context
 * length, and a request of any size is priced normally.
 */
export interface ProviderContextTier {
  thresholdTokens: number;
  multipliers: {
    input: number;
    cachedInput: number;
    cacheWrite: number;
    output: number;
  };
}

/**
 * OpenAI's long-context tier, from its pricing page (read 2026-09-21): above
 * 272k prompt tokens every prompt class doubles and output is half again. The
 * listed long-context rates are exactly those multiples of the standard ones —
 * Sol at $4/$20 becomes $8/$30 — so the multipliers are derived, not guessed.
 * GPT-5.4 and GPT-5.5 cap at 272k, so the tier never fires for them.
 */
const OPENAI_CONTEXT_TIER: ProviderContextTier = {
  thresholdTokens: 272_000,
  multipliers: { input: 2, cachedInput: 2, cacheWrite: 2, output: 1.5 },
};

/**
 * Haiku 5.5's prompt-length pricing (read 2026-10-08): above 100k prompt tokens
 * every class, output included, costs five times its short-prompt rate — $0.10
 * input becomes $0.50, $0.50 output becomes $2.50.
 */
const HAIKU_5_5_CONTEXT_TIER: ProviderContextTier = {
  thresholdTokens: 100_000,
  multipliers: { input: 5, cachedInput: 5, cacheWrite: 5, output: 5 },
};

/**
 * Whether a provider charges more for a long prompt, by upstream price list.
 *
 * **Anthropic is deliberately null.** It used to double input and charge half
 * again for output above 200k, but removed that on 2026-03-13: Claude 4.6 and
 * later "include the full 1M token context window at standard pricing". So a
 * `sonnet[1m]` or `fable[1m]` session is priced exactly like a short one, and
 * the premium that used to apply is not modelled for any current model. Haiku
 * 5.5 is the published exception, in `CONTEXT_TIER_BY_MODEL`.
 */
const CONTEXT_TIER_BY_UPSTREAM_PROVIDER: Readonly<
  Record<string, ProviderContextTier | null>
> = {
  anthropic: null,
  "openai-codex": OPENAI_CONTEXT_TIER,
  openai: OPENAI_CONTEXT_TIER,
  opencode: null,
  xai: null,
  google: null,
};

/**
 * Tiers that belong to one model rather than its whole price list, matched by
 * id prefix like the price tables. They override the provider's tier.
 */
const CONTEXT_TIER_BY_MODEL: Readonly<
  Record<string, Readonly<Record<string, ProviderContextTier>>>
> = {
  anthropic: { "claude-haiku-5-5": HAIKU_5_5_CONTEXT_TIER },
};

/**
 * The long-context tier a YA provider's requests are priced under, or null when
 * prompt length does not change its rates. A model with its own tier, such as
 * Haiku 5.5, gets that one. An unknown provider gets null rather than an
 * invented premium.
 */
export function providerContextTier(
  provider: string,
  model?: string,
): ProviderContextTier | null {
  const upstream = UPSTREAM_PROVIDER_BY_YA_PROVIDER[provider];
  if (!upstream) return null;
  const modelTiers = CONTEXT_TIER_BY_MODEL[upstream];
  const modelTier =
    model && modelTiers
      ? longestPrefixMatch(modelTiers, normalizeModelId(model))
      : undefined;
  return modelTier ?? CONTEXT_TIER_BY_UPSTREAM_PROVIDER[upstream] ?? null;
}

/**
 * The prompt length above which a request enters its long-context tier, or
 * null when neither its provider nor its model has one. The recorder asks this
 * per request, because no later reader can recover one request's prompt length
 * from a sum — and the threshold is not the same for every provider or model.
 */
export function longContextThresholdTokens(
  provider: string,
  model?: string,
): number | null {
  return providerContextTier(provider, model)?.thresholdTokens ?? null;
}

/**
 * Strip what YA adds to a model name that a price table never has: the `[1m]`
 * context-window marker and a `provider/` prefix. `fable[1m]` is Fable at
 * Fable's rates — Anthropic prices its 1M window flat.
 */
function normalizeModelId(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/^[a-z-]+\//u, "")
    .replace(/\[1m\]$/u, "")
    .replace(/-1m$/u, "");
}

/** Longest id in `prices` that the model starts with, so a dated id resolves. */
function longestPrefixMatch<T>(
  prices: Readonly<Record<string, T>>,
  model: string,
): T | undefined {
  let best: T | undefined;
  let bestLength = 0;
  for (const [id, entry] of Object.entries(prices)) {
    if (model.startsWith(id) && id.length > bestLength) {
      best = entry;
      bestLength = id.length;
    }
  }
  return best;
}

/**
 * Prices for one model, or undefined when no table names it — a launch alias
 * such as `opus` with no resolved provider id behind it, a self-hosted model,
 * or a model newer than both tables. Undefined is reported as "no price"
 * rather than guessed at.
 *
 * Exact ids win over prefixes, and the published table wins over the vendored
 * one, so a dated variant never outranks its own model's newer rates.
 */
export function findModelPrices(
  provider: string,
  model: string | undefined,
): VendoredModelPrices | undefined {
  if (!model) return undefined;
  const normalized = normalizeModelId(model);
  const upstream = UPSTREAM_PROVIDER_BY_YA_PROVIDER[provider];
  const tables = [PUBLISHED_MODEL_PRICES, VENDORED_MODEL_PRICES];
  const listsOf = (table: (typeof tables)[number]) =>
    upstream ? [table[upstream]] : Object.values(table);
  for (const table of tables) {
    for (const prices of listsOf(table)) {
      const exact = prices?.[normalized];
      if (exact) return exact;
    }
  }
  for (const table of tables) {
    for (const prices of listsOf(table)) {
      const prefixed = prices && longestPrefixMatch(prices, normalized);
      if (prefixed) return prefixed;
    }
  }
  return undefined;
}

/**
 * What one token of each class costs in output tokens of the same model, for a
 * model no table names — a local or self-hosted one, or one newer than both.
 *
 * Midway between the two listed families, checked against both published
 * tables: output runs 5x a fresh prompt token across Anthropic's range and 5–6x
 * across OpenAI's, so 5.5; both price a cache read at a tenth of a fresh token;
 * Anthropic bills a cache write at 1.25 fresh tokens and OpenAI at 1.25 for
 * GPT-5.6 and later but nothing before, so 0.625.
 *
 * These are list-price ratios, which track the real compute asymmetry only
 * roughly — generation is serial while prompt processing batches, and the true
 * ratio moves with how much of the cost is attention over the whole context
 * versus per-token work. For a usage estimate on an unlisted model that is the
 * right precision; it is why this yields an output-token equivalent and never a
 * dollar figure.
 */
const UNLISTED_MODEL_OUTPUT_EQUIVALENTS = {
  freshInput: 1 / 5.5,
  cachedInput: 1 / 55,
  cacheWrite: 0.625 / 5.5,
} as const;

/**
 * An unlisted model's counts in its own output tokens, from the ratios above.
 * No dollars: nothing here knows what that model's output token costs. No
 * long-context premium either — which provider's tier would it be?
 */
export function unlistedEquivalentOutputTokens(
  classes: UsageTokenClasses,
): number {
  return Math.round(
    classes.freshInputTokens * UNLISTED_MODEL_OUTPUT_EQUIVALENTS.freshInput +
      classes.cachedInputTokens *
        UNLISTED_MODEL_OUTPUT_EQUIVALENTS.cachedInput +
      classes.cacheWriteTokens * UNLISTED_MODEL_OUTPUT_EQUIVALENTS.cacheWrite +
      classes.outputTokens,
  );
}

export interface TokenCostOptions {
  /** YA provider name, which selects the long-context tier. */
  provider?: string;
  /** Model id, which selects its own tier where it has one (Haiku 5.5). */
  model?: string;
  /** Whether these counts were in that provider's long-context tier. */
  longContext?: boolean;
}

/** The multipliers to apply, which are all 1 unless a tier actually applies. */
function tierMultipliers(options: TokenCostOptions) {
  const flat = { input: 1, cachedInput: 1, cacheWrite: 1, output: 1 };
  if (!options.longContext || !options.provider) return flat;
  return (
    providerContextTier(options.provider, options.model)?.multipliers ?? flat
  );
}

/** What one set of counts cost in US dollars, at one model's prices. */
export function tokenCostUsd(
  classes: UsageTokenClasses,
  prices: VendoredModelPrices,
  options: TokenCostOptions = {},
): number {
  const tier = tierMultipliers(options);
  return (
    (classes.freshInputTokens * prices.input * tier.input +
      classes.cachedInputTokens * prices.cacheRead * tier.cachedInput +
      classes.cacheWriteTokens * prices.cacheWrite * tier.cacheWrite +
      classes.outputTokens * prices.output * tier.output) /
    1_000_000
  );
}

/**
 * The same cost as a count of that model's standard-tier output tokens: the
 * dollars divided by the model's one dollars-per-output-token constant. A model
 * whose output is free has no such unit, so this reports null rather than
 * dividing by zero.
 */
export function equivalentOutputTokens(
  classes: UsageTokenClasses,
  prices: VendoredModelPrices,
  options: TokenCostOptions = {},
): number | null {
  if (prices.output <= 0) return null;
  const usd = tokenCostUsd(classes, prices, options);
  return Math.round(usd / (prices.output / 1_000_000));
}
