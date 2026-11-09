import {
  getMostUsedSubscriptionUsageWindow,
  type ProviderSubscriptionUsage,
} from "@yep-anywhere/shared";
import { useI18n } from "../i18n";
import { Badge } from "./ui/Badge";

export function ModelSubscriptionUsage({
  usage,
  modelId,
}: {
  usage: ProviderSubscriptionUsage | null | undefined;
  modelId: string;
}) {
  const { t } = useI18n();
  const bindingWindow = getMostUsedSubscriptionUsageWindow(usage, modelId);
  if (!bindingWindow) return null;
  const percent = Math.round(bindingWindow.usedPercent);
  if (usage?.ordinaryUsageAllowed === true && percent >= 100) {
    return (
      <Badge tooltip={t("subscriptionUsageAllowed")}>
        {t("subscriptionUsageAvailable")}
      </Badge>
    );
  }
  const tone = percent >= 90 ? "danger" : percent >= 75 ? "warning" : "neutral";
  return (
    <Badge
      tone={tone}
      tooltip={t("subscriptionUsageCompactTitle", { percent })}
    >
      {t("subscriptionUsageCompact", { percent })}
    </Badge>
  );
}
