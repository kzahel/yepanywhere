/**
 * The Claude model and slash-command catalog: launch aliases, the fallback
 * model list, mapping the SDK's model and command rows, and merging live
 * rows over the fallback by family. The provider's model cache and probes
 * stay in `claude.ts`.
 */

import type { Query } from "@anthropic-ai/claude-agent-sdk";
import {
  type AgentAuthRouterCliModel,
  type EffortLevel,
  getModelContextWindow,
  type ModelInfo,
  type SlashCommand,
} from "@yep-anywhere/shared";

export type ClaudeSdkModelInfo = Awaited<
  ReturnType<Query["supportedModels"]>
>[number];
export type ClaudeSdkSlashCommand = Awaited<
  ReturnType<Query["supportedCommands"]>
>[number];

const CLAUDE_EFFORT_LEVELS: EffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * Sonnet's 1M was previously credit-gated (launching `sonnet[1m]` errored with
 * "Usage credits required for 1M context"), so it once kept a separate 200K
 * entry. Sonnet 5 lifted that gate: a live probe on this account runs
 * `--model sonnet` as `claude-sonnet-5[1m]` at a 1,000,000 window on the
 * standard tier with no error. The "Sonnet 5.5" label is pinned in the
 * description (the name stays the generic "Sonnet") rather than taken from the
 * SDK, because older `supportedModels()` responses reported the `sonnet` alias
 * as "Sonnet 4.6" even when it routed to Sonnet 5 at runtime.
 *
 * SDK 0.3.293 resolves `sonnet` to Sonnet 5.5, and a live probe ran both
 * `sonnet` and `sonnet[1m]` at a 1,000,000 window, so the rewrite no longer
 * adds capability. It stays because removing it changes the launch spelling
 * existing sessions resume with, which is a separate decision.
 *
 * Opus deliberately stays bare. SDK 0.3.280 resolves bare `opus` to Opus 5.5
 * with a 1M context window, so rewriting the stable alias adds no capability
 * and couples launch behavior to a historical spelling. See
 * topics/claude-1m-context.md.
 */
const CLAUDE_LAUNCH_MODEL_ALIASES: Record<string, string> = {
  sonnet: "sonnet[1m]",
};

const ALWAYS_EXTENDED_DESCRIPTIONS: Record<string, string> = {
  opus: "Opus 5.5 with the full 1M-token context window",
  sonnet:
    "Sonnet 5.5 with the full 1M-token context window · newer tokenizer bills ~30% more tokens",
};

/** Normalize only aliases whose launch spelling still changes behavior. */
export function normalizeClaudeLaunchModel(
  model: string | undefined,
): string | undefined {
  return (model && CLAUDE_LAUNCH_MODEL_ALIASES[model]) || model;
}

/** Static fallback list of Claude models (used if probe fails) */
export const CLAUDE_MODELS_FALLBACK: ModelInfo[] = [
  {
    id: "default",
    name: "Default",
    description: "Claude Code chooses the recommended model for your account",
    contextWindow: getModelContextWindow("default", "claude"),
  },
  {
    id: "best",
    name: "Best",
    description: "Highest-capability Claude Code alias (full 1M context)",
    contextWindow: getModelContextWindow("opus[1m]", "claude"),
  },
  {
    id: "fable",
    name: "Fable",
    description:
      "Most capable Claude model for demanding reasoning and long-horizon agentic work",
    contextWindow: getModelContextWindow("fable", "claude"),
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
    supportsEffort: true,
    supportsFastMode: false,
    supportedEffortLevels: CLAUDE_EFFORT_LEVELS,
    defaultEffortLevel: "high",
  },
  {
    id: "sonnet",
    name: "Sonnet",
    description: ALWAYS_EXTENDED_DESCRIPTIONS.sonnet,
    contextWindow: getModelContextWindow("sonnet[1m]", "claude"),
  },
  {
    id: "opus",
    name: "Opus",
    description: ALWAYS_EXTENDED_DESCRIPTIONS.opus,
    contextWindow: getModelContextWindow("opus[1m]", "claude"),
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
    supportsEffort: true,
    supportsFastMode: true,
    supportedEffortLevels: CLAUDE_EFFORT_LEVELS,
    defaultEffortLevel: "high",
  },
  {
    id: "haiku",
    name: "Haiku",
    description: "Fastest model for simple tasks",
    // SDK 0.3.293 resolves `haiku` to Haiku 5.5, which runs at 1M.
    contextWindow: getModelContextWindow("claude-haiku-5-5", "claude"),
  },
  {
    id: "opusplan",
    name: "Opus Plan",
    description: "Uses Opus for planning, then Sonnet for execution",
    contextWindow: getModelContextWindow("opus[1m]", "claude"),
  },
];

const CLAUDE_GOAL_LOOP_ALIAS_COMMAND: SlashCommand = {
  name: "goal",
  description: "Keep working toward a verifiable end state until it is met",
  argumentHint: "<verifiable end state>",
  emulation: {
    providerText: "/loop wish {{argument}}",
  },
  invocation: { kind: "emulated", prefix: "/" },
};

function isClaudeEffortLevel(value: unknown): value is EffortLevel {
  return (
    typeof value === "string" &&
    (CLAUDE_EFFORT_LEVELS as string[]).includes(value)
  );
}

function mapClaudeSupportedEffortLevels(
  levels: unknown,
): EffortLevel[] | undefined {
  if (!Array.isArray(levels)) return undefined;
  const supported = levels.filter(isClaudeEffortLevel);
  return supported.length > 0 ? supported : undefined;
}

export function normalizedSlashCommandNameValue(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}

function normalizedSlashCommandName(command: SlashCommand): string {
  return normalizedSlashCommandNameValue(command.name);
}

export function filterClaudeRemoteSlashCommands(
  commands: string[],
  terminalCommands: unknown,
): string[] {
  if (
    !Array.isArray(terminalCommands) ||
    !terminalCommands.every((command) => typeof command === "string")
  ) {
    return commands;
  }

  const terminalNames = new Set(
    terminalCommands.map(normalizedSlashCommandNameValue),
  );
  return commands.filter(
    (command) => !terminalNames.has(normalizedSlashCommandNameValue(command)),
  );
}

export function withClaudeGoalAlias(commands: SlashCommand[]): SlashCommand[] {
  const normalizedNames = new Set(commands.map(normalizedSlashCommandName));
  if (normalizedNames.has("goal") || !normalizedNames.has("loop")) {
    return commands;
  }
  return [...commands, CLAUDE_GOAL_LOOP_ALIAS_COMMAND];
}

export function mapClaudeSlashCommand(
  command: ClaudeSdkSlashCommand,
): SlashCommand {
  return {
    name: command.name,
    description: command.description,
    argumentHint: command.argumentHint || undefined,
    invocation: {
      kind: "skill",
      prefix: "/",
      inventoryState: "current",
      ...(command.aliases?.length ? { aliases: command.aliases } : {}),
    },
  };
}

function enrichClaudeModel(model: ModelInfo): ModelInfo {
  return {
    ...model,
    contextWindow:
      model.contextWindow ?? getModelContextWindow(model.id, "claude"),
    supportsEffort: model.supportsEffort ?? true,
    supportedEffortLevels: model.supportedEffortLevels ?? CLAUDE_EFFORT_LEVELS,
  };
}

export function mapClaudeSdkModel(model: ClaudeSdkModelInfo): ModelInfo {
  return {
    id: model.value,
    resolvedModel: model.resolvedModel,
    name: model.displayName,
    description: model.description,
    contextWindow: model.resolvedModel
      ? getModelContextWindow(model.resolvedModel, "claude")
      : undefined,
    supportsEffort: model.supportsEffort,
    supportedEffortLevels: mapClaudeSupportedEffortLevels(
      model.supportedEffortLevels,
    ),
    supportsAdaptiveThinking: model.supportsAdaptiveThinking,
    supportsFastMode: model.supportsFastMode,
    supportsAutoMode: model.supportsAutoMode,
  };
}

/**
 * Map an agent-auth-router account's CLI rows exactly as the direct probe's
 * rows, so pool and direct pickers show the same names and descriptions.
 */
export function mapClaudeCliModels(
  rows: readonly AgentAuthRouterCliModel[],
): ModelInfo[] {
  return mergeClaudeModels(
    rows.map((row) =>
      mapClaudeSdkModel({
        ...row,
        description: row.description ?? "",
      } as ClaudeSdkModelInfo),
    ),
  );
}

export function claudeModelFamily(
  modelId: string,
): "opus" | "sonnet" | "haiku" | "fable" | undefined {
  const name = modelId.toLowerCase();
  for (const family of ["opus", "sonnet", "haiku", "fable"] as const) {
    if (new RegExp(`(?:^|[-/])${family}(?:[-/]|$)`).test(name)) {
      return family;
    }
  }
  return undefined;
}

export function mergeClaudeModels(models: ModelInfo[]): ModelInfo[] {
  const byId = new Map<string, ModelInfo>();

  for (const model of CLAUDE_MODELS_FALLBACK) {
    byId.set(model.id, enrichClaudeModel(model));
  }

  // The catalog lists the current Fable row before any previous Fable
  // versions (Claude Code 2.1.283 adds `claude-fable-5` after
  // `claude-fable-5-1`). Only that first row speaks for the stable `fable`
  // selection; later ones stay concrete rows like `claude-opus-5`.
  let fableFolded = false;
  for (const model of models) {
    if (model.id === "default") {
      const fallback = byId.get("default");
      byId.set(
        "default",
        enrichClaudeModel({
          ...fallback,
          ...model,
          id: "default",
          name: fallback?.name ?? model.name,
          description: fallback?.description ?? model.description,
        }),
      );
      continue;
    }
    if (!fableFolded && claudeModelFamily(model.id) === "fable") {
      fableFolded = true;
      const fallback = byId.get("fable");
      byId.set(
        "fable",
        enrichClaudeModel({
          ...fallback,
          ...model,
          id: "fable",
          name: fallback?.name ?? model.name,
        }),
      );
      continue;
    }
    byId.set(
      model.id,
      enrichClaudeModel({
        ...byId.get(model.id),
        ...model,
      }),
    );
  }

  const orderedIds = [
    ...CLAUDE_MODELS_FALLBACK.map((model) => model.id),
    ...models.map((model) => model.id),
  ];

  const merged = [...new Set(orderedIds)]
    .map((id) => byId.get(id))
    .filter((model): model is ModelInfo => model !== undefined);

  // Drop the redundant "opus[1m]"/"sonnet[1m]" rows and surface their live
  // capability metadata on the stable family aliases. This catalog projection
  // is independent of launch spelling: bare `opus` already launches the
  // current Opus generation with the same 1M window.
  const folded = merged
    .filter((model) => model.id !== "opus[1m]" && model.id !== "sonnet[1m]")
    .map((model) => {
      if (model.id === "opus") {
        const extended = byId.get("opus[1m]");
        return {
          ...model,
          ...extended,
          id: model.id,
          name: model.name,
          contextWindow: getModelContextWindow("opus[1m]", "claude"),
          description: ALWAYS_EXTENDED_DESCRIPTIONS.opus,
        };
      }
      if (model.id === "sonnet") {
        const extended = byId.get("sonnet[1m]");
        return {
          ...model,
          ...extended,
          id: model.id,
          name: model.name,
          contextWindow: getModelContextWindow("sonnet[1m]", "claude"),
          description: ALWAYS_EXTENDED_DESCRIPTIONS.sonnet,
        };
      }
      return model;
    });

  // Since Claude Code 2.1.283 the catalog also lists concrete previous
  // versions (`claude-opus-4-8`, `claude-sonnet-5`, ...). The stable aliases
  // speak for the current ones, so these rows are previous models: marked
  // additional and moved last, for the opt-in projection to show only when
  // selected. They stay in the list so a selected one keeps its live
  // capabilities.
  const isPrevious = (model: ModelInfo) => model.id.startsWith("claude-");
  return [
    ...folded.filter((model) => !isPrevious(model)),
    ...folded
      .filter(isPrevious)
      .map((model) => ({ ...model, catalogGroup: "additional" as const })),
  ];
}
