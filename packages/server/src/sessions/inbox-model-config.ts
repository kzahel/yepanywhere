import type {
  EffortLevel,
  ProviderName,
  ThinkingConfig,
} from "@yep-anywhere/shared";
import type { SessionMetadata } from "../metadata/SessionMetadataService.js";
import type { Process } from "../supervisor/Process.js";

/** Optional, already-known settings; reading Inbox must not scan transcripts. */
export interface InboxModelConfig {
  provider: ProviderName;
  model?: string;
  thinking?: ThinkingConfig;
  effort?: EffortLevel;
}

export function inboxModelConfig(
  provider: ProviderName,
  process: Process | undefined,
  metadata: SessionMetadata | undefined,
): InboxModelConfig | undefined {
  const saved = metadata?.effectiveLaunchSettings;
  const model = process
    ? process.resolvedModel
    : saved
      ? saved.requestedModel
      : metadata?.requestedModel;
  const knownModel = model && model !== "default" ? model : undefined;
  const thinking = process
    ? (process.thinking ?? { type: "disabled" as const })
    : (saved?.thinking ?? undefined);
  const effort = process ? process.appliedEffort : (saved?.effort ?? undefined);
  if (!knownModel && !thinking && !effort) return undefined;
  return {
    provider: process?.provider ?? provider,
    model: knownModel,
    thinking,
    effort,
  };
}
