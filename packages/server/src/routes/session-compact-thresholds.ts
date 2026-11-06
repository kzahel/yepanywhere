import { type ProviderName, getModelContextWindow } from "@yep-anywhere/shared";
import type { ModelInfoService } from "../services/ModelInfoService.js";
import type { ServerSettingsService } from "../services/ServerSettingsService.js";
import type { ModelSettings } from "../supervisor/Supervisor.js";

/**
 * Per-model compact-early percent (task 029): a direct lookup of the resolved
 * YA model id in the client-defaults map. The id is resolved upstream (the
 * requested launch alias, else the alias persisted at launch, else the
 * provider's reported-to-YA-id helper for sessions YA didn't start), so
 * per-model settings key by the same YA id the slider stored, with no family
 * fallback. "default" is the runtime holdout and never carries a stored
 * threshold. Out-of-range values are ignored by the consumer. See
 * topics/provider-abstraction.md.
 */
export function resolveCompactPercent(
  map: Record<string, number> | undefined,
  yaModelId: string | undefined,
): number | undefined {
  if (!map || !yaModelId || yaModelId === "default") return undefined;
  const value = map[yaModelId];
  return typeof value === "number" ? value : undefined;
}

/**
 * Effective context window for the compaction threshold (task 029): the first
 * candidate identifier with a known window. Provider-specific window quirks
 * (Claude opus is always-1M even when its id resolves to "claude-opus-4-8")
 * now come from `contextWindow` itself; ModelInfoService delegates to the
 * provider's `contextWindowFor`, so this special-cases no model. See
 * topics/provider-abstraction.md.
 */
export function resolveCompactWindow(
  provider: ProviderName | undefined,
  candidates: (string | undefined)[],
  contextWindow: (model: string | undefined, provider?: ProviderName) => number,
): number | undefined {
  for (const m of candidates) {
    if (m && m !== "default") {
      const w = contextWindow(m, provider);
      if (w > 0) return w;
    }
  }
  return undefined;
}

/** What `resolveCompactModelSettings` reads from the sessions route deps. */
export interface CompactModelSettingsDeps {
  serverSettingsService?: ServerSettingsService;
  modelInfoService?: ModelInfoService;
}

export function resolveCompactModelSettings(
  deps: CompactModelSettingsDeps,
  options: {
    provider?: ProviderName;
    yaModelId?: string;
    modelCandidates?: (string | undefined)[];
  },
): Pick<
  ModelSettings,
  | "compactAtContextPercent"
  | "compactAtContextWindow"
  | "forceYaOrchestratedCompaction"
  | "claudeAutoCompactPercentOverride"
> {
  const defaults = deps.serverSettingsService?.getSetting("clientDefaults");
  const compactAtContextPercent = resolveCompactPercent(
    defaults?.compactAtContextPercent,
    options.yaModelId,
  );
  const modelInfoService = deps.modelInfoService;
  const resolveContextWindow = modelInfoService
    ? (model: string | undefined, provider?: ProviderName) =>
        modelInfoService.getContextWindow(model, provider)
    : getModelContextWindow;
  const compactAtContextWindow =
    compactAtContextPercent === undefined
      ? undefined
      : resolveCompactWindow(
          options.provider,
          options.modelCandidates ?? [options.yaModelId],
          resolveContextWindow,
        );
  return {
    compactAtContextPercent,
    compactAtContextWindow,
    forceYaOrchestratedCompaction:
      defaults?.forceYaOrchestratedCompaction === true,
    claudeAutoCompactPercentOverride:
      options.provider === "claude"
        ? deps.serverSettingsService?.getSetting(
            "claudeAutoCompactPercentOverride",
          )
        : undefined,
  };
}
