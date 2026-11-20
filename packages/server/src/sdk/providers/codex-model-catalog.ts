import {
  CODEX_GPT6_CONTEXT_WINDOW,
  CODEX_GPT56_CONTEXT_WINDOW,
  CODEX_SOL_500K_CONTEXT_WINDOW,
  isWithdrawnCodexModel,
  type ModelInfo,
} from "@yep-anywhere/shared";
import type { CyberAccessProgram } from "./codex-protocol/generated/v2/CyberAccessProgram.js";

export const CODEX_CLI_GPT55_MIN_VERSION = "0.124.0";
export const CODEX_CLI_GPT56_MIN_VERSION = "0.144.0";
export const CODEX_CLI_GPT56_REDUCED_CATALOG_MIN_VERSION = "0.144.6";
export const CODEX_CLI_GPT56_RESTORED_CATALOG_MIN_VERSION = "0.145.0";

// Withdrawn models (`CODEX_WITHDRAWN_MODEL_IDS`) are absent here and from
// every fallback list below, and are dropped from the live catalog.
const PREFERRED_MODEL_ORDER = [
  "gpt-6.2-sol",
  "gpt-6.2-astra",
  "gpt-6.1-sol",
  "gpt-6-astra",
  "gpt-6.1-terra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-daybreak-blue-latest",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.1-codex-max",
  "gpt-5.2",
  "gpt-5.1-codex-mini",
] as const;

const GPT54_FALLBACK_CODEX_MODEL: ModelInfo = {
  id: "gpt-5.4",
  name: "GPT-5.4",
  description: "Strong model for everyday coding.",
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [
    {
      reasoningEffort: "low",
      description: "Fast responses with lighter reasoning",
    },
    {
      reasoningEffort: "medium",
      description: "Balances speed and reasoning depth for everyday tasks",
    },
    {
      reasoningEffort: "high",
      description: "Greater reasoning depth for complex problems",
    },
    {
      reasoningEffort: "xhigh",
      description: "Extra high reasoning depth for complex problems",
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
};

const GPT54_MINI_FALLBACK_CODEX_MODEL: ModelInfo = {
  id: "gpt-5.4-mini",
  name: "GPT-5.4-Mini",
  description:
    "Small, fast, and cost-efficient model for simpler coding tasks.",
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [
    {
      reasoningEffort: "low",
      description: "Fast responses with lighter reasoning",
    },
    {
      reasoningEffort: "medium",
      description: "Balances speed and reasoning depth for everyday tasks",
    },
    {
      reasoningEffort: "high",
      description: "Greater reasoning depth for complex problems",
    },
    {
      reasoningEffort: "xhigh",
      description: "Extra high reasoning depth for complex problems",
    },
  ],
  inputModalities: ["text", "image"],
  supportsPersonality: true,
};

const GPT54_FALLBACK_CODEX_MODELS: ModelInfo[] = [
  GPT54_FALLBACK_CODEX_MODEL,
  GPT54_MINI_FALLBACK_CODEX_MODEL,
];

const GPT54_AND_OLDER_FALLBACK_CODEX_MODELS: ModelInfo[] = [
  ...GPT54_FALLBACK_CODEX_MODELS,
  { id: "gpt-5.3-codex", name: "GPT-5.3-Codex" },
  { id: "gpt-5.2", name: "GPT-5.2" },
];

const GPT56_REASONING_EFFORTS: NonNullable<
  ModelInfo["supportedReasoningEfforts"]
> = [
  {
    reasoningEffort: "low",
    description: "Fast responses with lighter reasoning",
  },
  {
    reasoningEffort: "medium",
    description: "Balances speed and reasoning depth for everyday tasks",
  },
  {
    reasoningEffort: "high",
    description: "Greater reasoning depth for complex problems",
  },
  {
    reasoningEffort: "xhigh",
    description: "Extra high reasoning depth for complex problems",
  },
  {
    reasoningEffort: "max",
    description: "Maximum reasoning depth for the hardest problems",
  },
];

const GPT56_ULTRA_REASONING_EFFORT = {
  reasoningEffort: "ultra",
  description: "Maximum reasoning with automatic task delegation",
};

const GPT56_SERVICE_TIERS: NonNullable<ModelInfo["serviceTiers"]> = [
  {
    id: "priority",
    name: "Fast",
    description: "1.5x speed, increased usage",
  },
];

const GPT56_SOL_FALLBACK_CODEX_MODEL: ModelInfo = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6-Sol",
  description: "Latest frontier agentic coding model.",
  isDefault: true,
  defaultReasoningEffort: "low",
  supportedReasoningEfforts: [
    ...GPT56_REASONING_EFFORTS,
    GPT56_ULTRA_REASONING_EFFORT,
  ],
  inputModalities: ["text", "image"],
  contextWindow: CODEX_GPT56_CONTEXT_WINDOW,
  supportsPersonality: false,
  serviceTiers: GPT56_SERVICE_TIERS,
};

const GPT56_TERRA_FALLBACK_CODEX_MODEL: ModelInfo = {
  id: "gpt-5.6-terra",
  name: "GPT-5.6-Terra",
  description: "Balanced agentic coding model for everyday work.",
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [
    ...GPT56_REASONING_EFFORTS,
    GPT56_ULTRA_REASONING_EFFORT,
  ],
  inputModalities: ["text", "image"],
  contextWindow: CODEX_GPT56_CONTEXT_WINDOW,
  supportsPersonality: false,
  serviceTiers: GPT56_SERVICE_TIERS,
};

const GPT56_LUNA_FALLBACK_CODEX_MODEL: ModelInfo = {
  id: "gpt-5.6-luna",
  name: "GPT-5.6-Luna",
  description: "Fast and affordable agentic coding model.",
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: GPT56_REASONING_EFFORTS,
  inputModalities: ["text", "image"],
  contextWindow: CODEX_GPT56_CONTEXT_WINDOW,
  supportsPersonality: false,
  serviceTiers: GPT56_SERVICE_TIERS,
};

const GPT56_INITIAL_FALLBACK_CODEX_MODELS: ModelInfo[] = [
  GPT56_SOL_FALLBACK_CODEX_MODEL,
  GPT56_TERRA_FALLBACK_CODEX_MODEL,
  GPT56_LUNA_FALLBACK_CODEX_MODEL,
  ...GPT54_AND_OLDER_FALLBACK_CODEX_MODELS,
];

const GPT56_REDUCED_FALLBACK_CODEX_MODELS: ModelInfo[] = [
  GPT56_SOL_FALLBACK_CODEX_MODEL,
  GPT56_TERRA_FALLBACK_CODEX_MODEL,
  GPT56_LUNA_FALLBACK_CODEX_MODEL,
];

export const FALLBACK_CODEX_MODELS: ModelInfo[] = [
  GPT56_SOL_FALLBACK_CODEX_MODEL,
  GPT56_TERRA_FALLBACK_CODEX_MODEL,
  GPT56_LUNA_FALLBACK_CODEX_MODEL,
  ...GPT54_FALLBACK_CODEX_MODELS,
];

export const LEGACY_FALLBACK_CODEX_MODELS: ModelInfo[] = [
  { id: "gpt-5.3-codex", name: "GPT-5.3-Codex" },
  { id: "gpt-5.2-codex", name: "GPT-5.2-Codex" },
  { id: "gpt-5.1-codex-max", name: "GPT-5.1-Codex-Max" },
  { id: "gpt-5.2", name: "GPT-5.2" },
  { id: "gpt-5.1-codex-mini", name: "GPT-5.1-Codex-Mini" },
];

export interface AppServerModel {
  id: string;
  availableAccessPrograms?: { cyber: CyberAccessProgram[] } | null;
  model?: string;
  displayName?: string;
  description?: string;
  upgrade?: string | null;
  upgradeInfo?: { model?: string | null } | null;
  hidden?: boolean | null;
  isDefault?: boolean | null;
  defaultReasoningEffort?: string | null;
  supportedReasoningEfforts?: Array<{
    reasoningEffort?: string | null;
    description?: string | null;
  }> | null;
  inputModalities?: string[] | null;
  contextWindow?: number | null;
  supportsPersonality?: boolean | null;
  serviceTiers?: Array<{
    id?: string | null;
    name?: string | null;
    description?: string | null;
  }> | null;
}

export function normalizeSemver(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?/);
  if (!match) return null;
  const [, major, minor, patch, pre] = match;
  return pre
    ? `${major}.${minor}.${patch}-${pre}`
    : `${major}.${minor}.${patch}`;
}

export function compareSemver(a: string, b: string): number {
  const parsedA = splitSemver(a);
  const parsedB = splitSemver(b);
  for (let i = 0; i < 3; i++) {
    const partA = parsedA.parts[i] ?? 0;
    const partB = parsedB.parts[i] ?? 0;
    if (partA !== partB) return partA < partB ? -1 : 1;
  }
  if (parsedA.pre === null && parsedB.pre === null) return 0;
  if (parsedA.pre === null) return 1;
  if (parsedB.pre === null) return -1;
  return parsedA.pre < parsedB.pre ? -1 : parsedA.pre > parsedB.pre ? 1 : 0;
}

function splitSemver(version: string): { parts: number[]; pre: string | null } {
  const dashIndex = version.indexOf("-");
  const core = dashIndex === -1 ? version : version.slice(0, dashIndex);
  const pre = dashIndex === -1 ? null : version.slice(dashIndex + 1);
  return {
    parts: core.split(".").map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    }),
    pre,
  };
}

export function getFallbackCodexModelsForCliVersion(
  version: string | null,
): ModelInfo[] {
  if (version && compareSemver(version, CODEX_CLI_GPT55_MIN_VERSION) < 0) {
    return LEGACY_FALLBACK_CODEX_MODELS;
  }
  if (version && compareSemver(version, CODEX_CLI_GPT56_MIN_VERSION) < 0) {
    return GPT54_AND_OLDER_FALLBACK_CODEX_MODELS;
  }
  if (
    version &&
    compareSemver(version, CODEX_CLI_GPT56_REDUCED_CATALOG_MIN_VERSION) < 0
  ) {
    return GPT56_INITIAL_FALLBACK_CODEX_MODELS;
  }
  if (
    version &&
    compareSemver(version, CODEX_CLI_GPT56_RESTORED_CATALOG_MIN_VERSION) < 0
  ) {
    return GPT56_REDUCED_FALLBACK_CODEX_MODELS;
  }
  return FALLBACK_CODEX_MODELS;
}

export function normalizeCodexModelList(
  models: AppServerModel[],
  cliVersion: string | null = null,
): ModelInfo[] {
  const orderLookup = new Map<string, number>(
    PREFERRED_MODEL_ORDER.map((id, idx) => [id, idx]),
  );
  const deduped = new Map<string, { model: ModelInfo; serverIndex: number }>();

  for (const [serverIndex, model] of models.entries()) {
    if (model.hidden === true) continue;

    const modelId = (model.model || model.id || "").trim();
    if (!modelId || isWithdrawnCodexModel(modelId)) continue;

    deduped.set(modelId, {
      model: {
        id: modelId,
        name: formatModelName(model.displayName || modelId),
        description: model.description,
        ...(model.isDefault === true ? { isDefault: true } : {}),
        ...normalizeModelReasoningMetadata(model),
        ...(Array.isArray(model.inputModalities)
          ? { inputModalities: model.inputModalities }
          : {}),
        ...(typeof model.contextWindow === "number"
          ? { contextWindow: model.contextWindow }
          : modelId.startsWith("gpt-5.6-")
            ? { contextWindow: CODEX_GPT56_CONTEXT_WINDOW }
            : /^gpt-6(?:\.\d+)?-/u.test(modelId)
              ? { contextWindow: inferGpt6ContextWindow(modelId, cliVersion) }
              : {}),
        ...(typeof model.supportsPersonality === "boolean"
          ? { supportsPersonality: model.supportsPersonality }
          : {}),
        ...normalizeModelServiceTierMetadata(model),
      },
      serverIndex,
    });

    const upgradeId =
      model.upgrade?.trim() ||
      (typeof model.upgradeInfo?.model === "string"
        ? model.upgradeInfo.model.trim()
        : "");
    if (
      upgradeId &&
      !deduped.has(upgradeId) &&
      !isWithdrawnCodexModel(upgradeId)
    ) {
      deduped.set(upgradeId, {
        model: {
          id: upgradeId,
          name: formatModelName(upgradeId),
        },
        serverIndex,
      });
    }
  }

  return [...deduped.values()]
    .map((entry, index) => ({
      model: entry.model,
      index,
      rank: getModelSortRank(entry.model, entry.serverIndex, orderLookup),
    }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.model);
}

function inferGpt6ContextWindow(modelId: string, cliVersion: string | null) {
  // The bundled 0.170.0 catalog raises GPT-6.1 Sol from 272K to 500K.
  if (
    modelId === "gpt-6.2-sol" ||
    (modelId === "gpt-6.1-sol" &&
      cliVersion &&
      compareSemver(cliVersion, "0.170.0") >= 0)
  ) {
    return CODEX_SOL_500K_CONTEXT_WINDOW;
  }
  return CODEX_GPT6_CONTEXT_WINDOW;
}

function normalizeModelReasoningMetadata(
  model: AppServerModel,
): Pick<ModelInfo, "defaultReasoningEffort" | "supportedReasoningEfforts"> {
  const metadata: Pick<
    ModelInfo,
    "defaultReasoningEffort" | "supportedReasoningEfforts"
  > = {};
  if (typeof model.defaultReasoningEffort === "string") {
    metadata.defaultReasoningEffort = model.defaultReasoningEffort;
  }
  if (Array.isArray(model.supportedReasoningEfforts)) {
    const efforts = model.supportedReasoningEfforts
      .map((effort) => {
        if (typeof effort.reasoningEffort !== "string") return null;
        return {
          reasoningEffort: effort.reasoningEffort,
          ...(typeof effort.description === "string"
            ? { description: effort.description }
            : {}),
        };
      })
      .filter(
        (
          effort,
        ): effort is {
          reasoningEffort: string;
          description?: string;
        } => effort !== null,
      );
    if (efforts.length > 0) {
      metadata.supportedReasoningEfforts = efforts;
    }
  }
  return metadata;
}

function normalizeModelServiceTierMetadata(
  model: AppServerModel,
): Pick<ModelInfo, "serviceTiers"> {
  if (!Array.isArray(model.serviceTiers)) {
    return {};
  }
  const serviceTiers = model.serviceTiers
    .map((tier) => {
      const id = typeof tier.id === "string" ? tier.id.trim() : "";
      const name = typeof tier.name === "string" ? tier.name.trim() : "";
      if (!id || !name) return null;
      return {
        id,
        name,
        ...(typeof tier.description === "string"
          ? { description: tier.description }
          : {}),
      };
    })
    .filter((tier): tier is NonNullable<typeof tier> => tier !== null);

  return serviceTiers.length > 0 ? { serviceTiers } : {};
}

function getModelSortRank(
  model: ModelInfo,
  serverIndex: number,
  orderLookup: Map<string, number>,
): number {
  if (model.isDefault) {
    return 0;
  }
  const preferredRank = orderLookup.get(model.id);
  if (preferredRank !== undefined) {
    return 1 + preferredRank;
  }
  return 1 + PREFERRED_MODEL_ORDER.length + serverIndex;
}

function formatModelName(value: string): string {
  return value
    .trim()
    .split(/([-\s]+)/u)
    .map((part) => {
      if (/^[-\s]+$/u.test(part)) return part;
      const lower = part.toLowerCase();
      if (lower === "gpt") return "GPT";
      if (lower === "codex") return "Codex";
      if (lower === "mini") return "Mini";
      if (lower === "max") return "Max";
      if (lower.length === 0) return "";
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");
}
