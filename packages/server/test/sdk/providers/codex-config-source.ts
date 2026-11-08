import {
  type CodexPlanToolMode,
  type CodexReasoningSummary,
  DEFAULT_CODEX_REASONING_SUMMARY,
  DEFAULT_SUBAGENT_MAX_DEPTH,
  type ModelInfo,
  type SubagentMaxDepth,
} from "@yep-anywhere/shared";
import {
  buildThreadConfigOverrides,
  type CodexConfigSource,
  createThreadForkParams,
  createThreadResumeParams,
  createThreadStartParams,
  createTurnStartParams,
  mapEffortToReasoningEffort,
} from "../../../src/sdk/providers/codex-session-config.js";

export interface CodexConfigSettings {
  reasoningSummary?: CodexReasoningSummary;
  planToolMode?: CodexPlanToolMode;
  subagentMaxDepth?: SubagentMaxDepth;
  cachedModels?: readonly ModelInfo[];
}

/**
 * A literal config source. Unset settings take the values a provider with no
 * configured getters reads.
 */
export function codexConfigSource(
  settings: CodexConfigSettings = {},
): CodexConfigSource {
  return {
    reasoningSummary: () =>
      settings.reasoningSummary ?? DEFAULT_CODEX_REASONING_SUMMARY,
    planToolMode: () => settings.planToolMode ?? "provider-default",
    subagentMaxDepth: () =>
      "subagentMaxDepth" in settings
        ? (settings.subagentMaxDepth as SubagentMaxDepth)
        : DEFAULT_SUBAGENT_MAX_DEPTH,
    cachedModels: () => settings.cachedModels,
  };
}

type WithoutSource<F> = F extends (
  source: CodexConfigSource,
  ...args: infer A
) => infer R
  ? (...args: A) => R
  : never;

function bind<
  F extends (source: CodexConfigSource, ...args: never[]) => unknown,
>(fn: F, source: CodexConfigSource): WithoutSource<F> {
  return ((...args: never[]) => fn(source, ...args)) as WithoutSource<F>;
}

/** The session-config builders bound to one literal config source. */
export function codexConfigBuilders(settings: CodexConfigSettings = {}) {
  const source = codexConfigSource(settings);
  return {
    mapEffortToReasoningEffort: bind(mapEffortToReasoningEffort, source),
    buildThreadConfigOverrides: bind(buildThreadConfigOverrides, source),
    createThreadStartParams: bind(createThreadStartParams, source),
    createThreadResumeParams: bind(createThreadResumeParams, source),
    createThreadForkParams: bind(createThreadForkParams, source),
    createTurnStartParams: bind(createTurnStartParams, source),
  };
}
