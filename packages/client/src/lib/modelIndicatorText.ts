const DEFAULT_PROVIDER_GLYPH = "◌";

const providerGlyphMap: Record<string, string> = {
  claude: "Cl",
  "claude-gateway": "Cl↗",
  "claude-ollama": "Cl↓",
  codex: "Cd",
  "codex-oss": "Cd↓",
  gemini: "✦",
  "gemini-acp": "✦",
  antigravity: "Agy",
  grok: "Gk",
  opencode: "OC",
  pi: "pi",
};

type ModelGlyphMatch = {
  glyph: string;
  suffix: string;
  accent?: "daybreak";
};

type ModelGlyphRule = {
  patterns: string[];
  glyph: string;
  fixedSuffix?: string;
  match?: "contains" | "exact";
  accent?: "daybreak";
};

const codexModelGlyphRules: ReadonlyArray<ModelGlyphRule> = [
  {
    patterns: ["gpt-daybreak-blue-latest"],
    glyph: "Db",
    fixedSuffix: "",
    accent: "daybreak",
  },
  { patterns: ["gpt-5.6-sol"], glyph: "☀", fixedSuffix: "" },
  { patterns: ["gpt-5.6-terra"], glyph: "♁", fixedSuffix: "" },
  { patterns: ["gpt-5.6-luna"], glyph: "☾", fixedSuffix: "" },
  {
    patterns: [
      "gpt-5.4-codex-spark",
      "gpt-5.4-spark",
      "gpt-5.3-codex-spark",
      "gpt-5.3-spark",
    ],
    glyph: "⚡",
    fixedSuffix: "",
  },
  { patterns: ["gpt-5.5"], glyph: "◆" },
  { patterns: ["gpt-5.4-mini"], glyph: "◇" },
  { patterns: ["gpt-5.4-nano"], glyph: "◇" },
  { patterns: ["gpt-5.4"], glyph: "◇" },
  { patterns: ["gpt-5.3"], glyph: "◆" },
  { patterns: ["gpt-5"], glyph: "◆" },
  { patterns: ["gpt-4"], glyph: "⧉" },
];

const modelGlyphRulesByProvider: Readonly<
  Record<string, ReadonlyArray<ModelGlyphRule>>
> = {
  claude: [
    {
      patterns: ["opus[1m]", "opus-1m"],
      glyph: "◐",
      fixedSuffix: "1m",
      match: "exact",
    },
    {
      patterns: ["opusplan"],
      glyph: "◐",
      fixedSuffix: "Plan",
      match: "exact",
    },
    { patterns: ["opus"], glyph: "◐", fixedSuffix: "", match: "exact" },
    { patterns: ["fable"], glyph: "Fb", fixedSuffix: "", match: "exact" },
    {
      patterns: ["sonnet[1m]", "sonnet-1m"],
      glyph: "♪",
      fixedSuffix: "1m",
    },
    { patterns: ["fable"], glyph: "Fb" },
    { patterns: ["opus"], glyph: "◐" },
    { patterns: ["sonnet"], glyph: "♪" },
    { patterns: ["haiku"], glyph: "✎" },
  ],
  codex: codexModelGlyphRules,
  "codex-oss": codexModelGlyphRules,
  gemini: [
    { patterns: ["2.5-pro"], glyph: "✹" },
    { patterns: ["2.5-flash"], glyph: "⚡" },
    { patterns: ["1.5-pro"], glyph: "✹" },
    { patterns: ["gemini"], glyph: "◗" },
  ],
  grok: [
    { patterns: ["grok-build"], glyph: "", fixedSuffix: "" },
    { patterns: ["grok-"], glyph: "" },
  ],
  opencode: [
    { patterns: ["gpt-5"], glyph: "◆" },
    { patterns: ["gpt-4"], glyph: "⧉" },
    { patterns: ["qwen"], glyph: "◌" },
    { patterns: ["llama"], glyph: "◥" },
    { patterns: ["mistral"], glyph: "◰" },
  ],
};

const anyProviderModelRules: ReadonlyArray<ModelGlyphRule> = [
  { patterns: ["thinking"], glyph: "∴" },
];

export function normalizeProviderKey(provider?: string): string {
  return provider?.trim().toLowerCase() ?? "unknown";
}

export function normalizeForModelGlyphMatching(value: string): string {
  let normalized = value.trim().toLowerCase();
  normalized = normalized.replace(/^openai\//u, "");
  normalized = normalized.replace(/^opencode\//u, "");
  normalized = normalized.replace(/^gemini-/u, "");
  return normalized;
}

function normalizeForCodexModelAliasMatching(
  normalizedModel: string,
  providerKey: string,
): string {
  if (!["codex", "codex-oss"].includes(providerKey)) {
    return normalizedModel;
  }

  // Some Codex model identifiers now include `-codex-` as a transport/alias
  // marker; remove it so stable rendering rules can still map to the same icon
  // buckets.
  return normalizedModel.replace(/-codex(?=-|$)/gu, "");
}

function normalizeModelSuffixTail(raw: string): string {
  const suffix = raw.replace(/^[-._\s]+/u, "");
  if (!suffix) {
    return "";
  }

  const versionWithExtendedContext = suffix.match(
    /^(\d+(?:-\d+)+(?:\.\d+)?)(\[1m\])?$/u,
  );
  if (versionWithExtendedContext) {
    const version = versionWithExtendedContext[1]?.replace(/-/gu, ".");
    return `${version}${versionWithExtendedContext[2] ? " 1m" : ""}`;
  }

  return suffix;
}

function deriveModelGlyphMatch(
  providerKey: string,
  normalizedModel: string,
): ModelGlyphMatch | null {
  const baseProviderKey = providerKey.replace(
    /-(?:gateway|ollama|oss|acp)$/u,
    "",
  );
  // Match named GPT families across releases instead of falling back to the
  // full identifier whenever a minor version is added. Keep the original
  // GPT-6 shorthand and distinguish newer versions and qualified variants.
  if (baseProviderKey === "codex") {
    const namedModel = normalizedModel.match(
      /^gpt-(\d+(?:\.\d+)*)-(astra|sol|terra|luna)(?:-(.+))?$/u,
    );
    if (namedModel && Number(namedModel[1]?.split(".")[0]) >= 6) {
      const [, version, family, qualifier] = namedModel;
      return {
        glyph:
          family === "astra"
            ? "As"
            : family === "sol"
              ? "So"
              : family === "terra"
                ? "Te"
                : "Lu",
        suffix: [version === "6" ? "" : version, qualifier]
          .filter(Boolean)
          .join("-"),
      };
    }
  }
  const providerRules =
    modelGlyphRulesByProvider[providerKey] ??
    modelGlyphRulesByProvider[baseProviderKey] ??
    [];
  const findMatch = (ruleList: ReadonlyArray<ModelGlyphRule>) => {
    for (const rule of ruleList) {
      const patterns = [...rule.patterns].sort((a, b) => b.length - a.length);
      for (const pattern of patterns) {
        const matchStart =
          rule.match === "exact"
            ? normalizedModel === pattern
              ? 0
              : -1
            : normalizedModel.indexOf(pattern);
        if (matchStart === -1) {
          continue;
        }

        const suffix = normalizeModelSuffixTail(
          normalizedModel.slice(matchStart + pattern.length),
        );

        if (rule.fixedSuffix !== undefined) {
          return {
            glyph: rule.glyph,
            suffix: rule.fixedSuffix,
            accent: rule.accent,
          };
        }

        if (pattern.startsWith("gpt-")) {
          const base = pattern.slice(4);
          return {
            glyph: rule.glyph,
            suffix: suffix ? `${base}-${suffix}` : base,
            accent: rule.accent,
          };
        }

        if (suffix) {
          return { glyph: rule.glyph, suffix, accent: rule.accent };
        }

        return { glyph: rule.glyph, suffix: "", accent: rule.accent };
      }
    }

    return null;
  };

  return findMatch(providerRules) ?? findMatch(anyProviderModelRules);
}

const subProviderAbbrevMap: Record<string, string> = {
  "github-copilot": "copilot",
  "github-models": "copilot",
  huggingface: "HF",
};

/**
 * Brief, provider-style abbreviation for a namespaced model's leading path
 * segment (the sub-provider / router), e.g. "github-copilot" -> "copilot".
 */
function getSubProviderAbbrev(pathPart: string): string {
  const key = pathPart.trim().toLowerCase();
  const mapped = subProviderAbbrevMap[key];
  if (mapped) {
    return mapped;
  }
  const cleaned = key.replace(/^github-/u, "");
  return cleaned.length > 12 ? cleaned.slice(0, 12) : cleaned;
}

/**
 * Guess the model family (the provider whose glyph rules apply) from a bare
 * model name, so a sub-provider-routed model such as "claude-opus-4.8" renders
 * with its native glyph regardless of which provider is doing the routing.
 */
function inferModelFamilyProviderKey(modelPart: string): string | null {
  const m = modelPart.toLowerCase();
  if (/(?:claude|opus|sonnet|haiku|fable)/u.test(m)) return "claude";
  if (/(?:gpt|codex|davinci|\bo[1-9])/u.test(m)) return "codex";
  if (/gemini/u.test(m)) return "gemini";
  if (/grok/u.test(m)) return "grok";
  if (/(?:qwen|llama|mistral|deepseek|gemma|phi)/u.test(m)) return "opencode";
  return null;
}

function formatGlyphAndSuffix(match: ModelGlyphMatch): string {
  if (!match.glyph) return match.suffix;
  return match.suffix ? `${match.glyph} ${match.suffix}` : match.glyph;
}

/** Model glyph + suffix only (no provider abbrev prefix). */
function formatModelGlyphOnly(
  familyKey: string,
  modelPart: string,
): { label: string; accent?: "daybreak" } {
  const normalized = normalizeForModelGlyphMatching(modelPart);
  const normalizedForMatching = normalizeForCodexModelAliasMatching(
    normalized,
    familyKey,
  );
  const match = deriveModelGlyphMatch(familyKey, normalizedForMatching);
  if (!match) {
    return { label: normalizedForMatching };
  }
  return { label: formatGlyphAndSuffix(match), accent: match.accent };
}

export interface ModelIndicatorParts {
  /** Provider abbrev for the running provider, e.g. "OC". */
  providerGlyph: string;
  /** Sub-provider/router abbrev for a namespaced model, e.g. "copilot". */
  subProvider?: string;
  /** Model glyph + version, e.g. "◐ 4.8" (may be a bare name on no match). */
  modelLabel: string;
  /** Model-specific accent independent of the running provider's badge hue. */
  modelAccent?: "daybreak";
  /**
   * Provider key whose color cues the model — the sub-badge the model implies
   * (e.g. "claude" for a copilot-routed claude-opus). Lets renderers color the
   * model glyph/version by its real family rather than the routing provider.
   */
  modelFamilyKey: string;
}

export function getModelIndicatorModelParts(
  provider?: string,
  model?: string,
): ModelIndicatorParts | null {
  const trimmedModel = model?.trim();
  if (!trimmedModel) {
    return null;
  }

  const providerKey = normalizeProviderKey(provider);
  const providerGlyph = providerGlyphMap[providerKey] ?? DEFAULT_PROVIDER_GLYPH;
  const normalizedModel = normalizeForModelGlyphMatching(trimmedModel);

  // Antigravity is the agent runtime; its header identifies the model family.
  // Keep legacy Gemini providers' frozen presentation unchanged.
  if (providerKey === "antigravity" && !trimmedModel.includes("/")) {
    const familyKey = inferModelFamilyProviderKey(trimmedModel) ?? providerKey;
    const gemini = trimmedModel.match(
      /^gemini-(\d+(?:\.\d+)*)-(flash-lite|flash|pro)(?:-(?:low|medium|high|extra|max))?$/iu,
    );
    const model = formatModelGlyphOnly(familyKey, trimmedModel);
    return {
      providerGlyph:
        familyKey === "gemini" ? "Gem" : (providerGlyphMap[familyKey] ?? "Agy"),
      modelLabel: gemini
        ? `${gemini[1]}${gemini[2]?.toLowerCase() === "pro" ? "P" : gemini[2]?.toLowerCase() === "flash-lite" ? "FL" : "F"}`
        : model.label,
      modelAccent: model.accent,
      modelFamilyKey: familyKey,
    };
  }

  // Sub-provider namespaced model (e.g. "github-copilot/claude-opus-4.8"):
  // three parts — provider abbrev (OC), sub-provider abbrev (copilot), and the
  // inner model through its own family's glyph rules (◐ 4.8). The family key
  // lets the badge color the model by the sub-badge it implies (claude).
  const slashIndex = normalizedModel.indexOf("/");
  if (slashIndex > 0) {
    const pathPart = normalizedModel.slice(0, slashIndex);
    const innerModel = normalizedModel.slice(slashIndex + 1);
    const subProvider = getSubProviderAbbrev(pathPart);
    // A model that is itself org-namespaced under the sub-provider
    // (huggingface ids: "minimaxai/minimax-m2.1", "qwen/qwen3-coder-next")
    // reads best as its bare basename: drop the org/dirname and render it
    // verbatim. Skip glyph substitution here, which mangles community names
    // (e.g. "qwen3-coder-next" -> "◌ 3-coder-next") and, when the org segment
    // matched a glyph rule, left a stray leading slash ("◌ /qwen3-...").
    // Family inference is kept for color cues only.
    const orgSlash = innerModel.lastIndexOf("/");
    if (orgSlash >= 0) {
      const modelPart = innerModel.slice(orgSlash + 1);
      const familyKey = inferModelFamilyProviderKey(modelPart) ?? providerKey;
      return {
        providerGlyph,
        subProvider,
        modelLabel: modelPart,
        modelFamilyKey: familyKey,
      };
    }
    const familyKey = inferModelFamilyProviderKey(innerModel) ?? providerKey;
    const modelGlyph = formatModelGlyphOnly(familyKey, innerModel);
    return {
      providerGlyph,
      subProvider,
      modelLabel: modelGlyph.label,
      modelAccent: modelGlyph.accent,
      modelFamilyKey: familyKey,
    };
  }

  const normalizedForMatching = normalizeForCodexModelAliasMatching(
    normalizedModel,
    providerKey,
  );
  const match = deriveModelGlyphMatch(providerKey, normalizedForMatching);

  if (!match) {
    return {
      providerGlyph,
      modelLabel: normalizedForMatching,
      modelFamilyKey: providerKey,
    };
  }

  return {
    providerGlyph,
    modelLabel: formatGlyphAndSuffix(match),
    modelAccent: match.accent,
    modelFamilyKey: providerKey,
  };
}

export function getModelIndicatorModelLabel(
  provider?: string,
  model?: string,
): string {
  const parts = getModelIndicatorModelParts(provider, model);
  if (!parts) {
    return "";
  }
  return [parts.providerGlyph, parts.subProvider, parts.modelLabel]
    .filter((part): part is string => !!part && part.length > 0)
    .join(" ");
}
