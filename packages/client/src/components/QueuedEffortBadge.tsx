import {
  resolveTurnEffort,
  type EffortLevel,
  type ModelInfo,
  type ProviderName,
  type ThinkingOption,
  type TurnEffort,
} from "@yep-anywhere/shared";
import { useI18n } from "../i18n";
import { getEffortLevelLabel } from "../lib/effortLevels";
import { Badge } from "./ui/Badge";

export interface QueuedEffortContext {
  normal: ThinkingOption;
  model: ModelInfo;
  provider?: ProviderName;
}

export function QueuedEffortBadge({
  modifier,
  context,
}: {
  modifier?: TurnEffort;
  context?: QueuedEffortContext;
}) {
  const { t } = useI18n();
  if (!modifier || !context) return null;
  let selected: ThinkingOption;
  try {
    selected = resolveTurnEffort(modifier, context.normal, context.model);
  } catch {
    // Unknown provider defaults cannot supply an honest resolved badge.
    return null;
  }
  const baseline =
    context.normal === "auto"
      ? (context.model.defaultReasoningEffort ??
        context.model.defaultEffortLevel)
      : context.normal.replace(/^on:/, "");
  const normalizedBaseline = baseline === "ultra" ? "max" : baseline;
  const level = selected.replace(/^on:/, "");
  if (level === normalizedBaseline) return null;
  const label =
    level === "off"
      ? t("turnEffortOff")
      : getEffortLevelLabel(level as EffortLevel, context.provider, t);
  return (
    <Badge size="small" tooltip={`/${modifier}`} data-turn-effort={level}>
      {label}
    </Badge>
  );
}
