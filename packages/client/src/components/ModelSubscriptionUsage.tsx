import {
  getMostUsedSubscriptionUsageWindow,
  type ProviderSubscriptionUsage,
} from "@yep-anywhere/shared";
import { useI18n } from "../i18n";

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
      <span
        className="subscription-usage-badge tone-neutral"
        title={t("subscriptionUsageAllowed")}
      >
        {t("subscriptionUsageAvailable")}
      </span>
    );
  }
  const tone = percent >= 90 ? "danger" : percent >= 75 ? "warning" : "neutral";
  return (
    <span
      className={`subscription-usage-badge tone-${tone}`}
      title={t("subscriptionUsageCompactTitle", { percent })}
    >
      {t("subscriptionUsageCompact", { percent })}
    </span>
  );
}
