import { getModelContextWindow } from "@yep-anywhere/shared";
import type { SessionSummary } from "../supervisor/types.js";
import {
  buildSummaryFromState,
  type ClaudeSummaryParseState,
  type ReadClaudeSessionSummaryOptions,
} from "./claude-summary.js";

type Options = ReadClaudeSessionSummaryOptions;
interface Projection {
  resolver: Options["resolveContextWindow"];
  window: number;
  summary: SessionSummary | null;
}
// Parse-state lifetime owns this cache. At most four request/context variants,
// reset together on each committed parse version; no per-file owner or timer.
const summaries = new WeakMap<
  ClaudeSummaryParseState,
  { version: number; variants: Map<string, Projection> }
>();
export function projectClaudeSummary(
  state: ClaudeSummaryParseState,
  options: Options,
): SessionSummary | null {
  const version = state.metrics.parsedEntries;
  let owner = summaries.get(state);
  if (!owner || owner.version !== version) {
    owner = { version, variants: new Map() };
    summaries.set(state, owner);
  }
  const key = JSON.stringify([
    options.sessionId,
    options.projectId,
    options.stats.dev,
    options.stats.ino,
    options.stats.size,
    options.stats.mtimeMs,
    options.stats.ctimeMs,
    options.stats.birthtimeMs,
    options.includeCompactionSafetyMargin,
  ]);
  const known = owner.variants.get(key);
  const resolver = options.resolveContextWindow ?? getModelContextWindow;
  if (
    known &&
    known.resolver === options.resolveContextWindow &&
    known.window === resolver(known.summary?.model, known.summary?.provider)
  )
    return structuredClone(known.summary);
  const summary = buildSummaryFromState(state, options);
  owner.variants.delete(key);
  owner.variants.set(key, {
    resolver: options.resolveContextWindow,
    window: resolver(summary?.model, summary?.provider),
    summary,
  });
  while (owner.variants.size > 4)
    owner.variants.delete(owner.variants.keys().next().value!);
  return structuredClone(summary);
}
