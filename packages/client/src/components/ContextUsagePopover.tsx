import {
  getApplicableSubscriptionUsageWindows,
  getMostUsedSubscriptionUsageWindow,
  type ProviderSubscriptionUsage,
  type ProviderSubscriptionUsageWindow,
} from "@yep-anywhere/shared";
import type { ContextBreakdownState } from "../hooks/useContextBreakdown";
import { useI18n } from "../i18n";
import type { ContextUsage } from "../types";
import { ContextBreakdownSection } from "./ContextBreakdownSection";
import { Button, IconButton } from "./ui/Button";
import styles from "./ContextUsagePopover.module.css";

function formatDuration(minutes: number | undefined): string {
  if (!minutes) return "—";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function scopeLabel(
  window: ProviderSubscriptionUsageWindow,
  allModels: string,
  oauthApps: string,
): string {
  if (window.scope.type === "models") {
    return window.scope.label ?? window.scope.modelIds.join(", ");
  }
  return window.scope.category === "oauthApps" ? oauthApps : allModels;
}

/**
 * True when the last turn's usage carries provider-reported cache/output
 * counts worth showing. Plain `inputTokens` alone is already on the pie
 * indicator and its tooltip, so it does not by itself earn a popover.
 */
export function hasContextTokenDetails(
  usage: ContextUsage | undefined,
): boolean {
  return (
    !!usage &&
    (usage.cacheReadTokens !== undefined ||
      usage.cacheCreationTokens !== undefined ||
      usage.outputTokens !== undefined)
  );
}

function ContextTokenRows({ usage }: { usage: ContextUsage }) {
  const { locale, t } = useI18n();
  const format = (tokens: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(tokens);

  return (
    <div className={styles.tokenUsage}>
      <div className={styles.contextThresholdPopoverTitle}>
        {t("contextTokenUsageTitle")}
      </div>
      <dl className={styles.rows}>
        <div className={styles.row}>
          <dt>{t("contextTokenUsageContext")}</dt>
          <dd>{format(usage.inputTokens)}</dd>
        </div>
        {usage.cacheReadTokens !== undefined && (
          <div className={styles.row}>
            <dt>{t("contextTokenUsageCacheRead")}</dt>
            <dd>{format(usage.cacheReadTokens)}</dd>
          </div>
        )}
        {usage.cacheCreationTokens !== undefined && (
          <div className={styles.row}>
            <dt>{t("contextTokenUsageCacheWrite")}</dt>
            <dd>{format(usage.cacheCreationTokens)}</dd>
          </div>
        )}
        {usage.outputTokens !== undefined && (
          <div className={styles.row}>
            <dt>{t("contextTokenUsageOutput")}</dt>
            <dd>{format(usage.outputTokens)}</dd>
          </div>
        )}
      </dl>
      <div className={styles.hint}>{t("contextTokenUsageHint")}</div>
    </div>
  );
}

/**
 * The left-click popover behind the context-usage pie. It shows the last
 * turn's provider-reported token accounting (including cache read/write, so
 * cache reuse is visible per turn) and, for providers that report one, the
 * subscription quota windows. Either half may be absent: Claude sessions
 * always have token counts, while quota windows exist only for providers
 * whose account API reports them. Above both, a live session whose provider
 * can report it shows what fills the context window, by category.
 */
export function ContextUsagePopover({
  usage,
  contextUsage,
  breakdown,
  modelId,
  refreshing,
  onRefresh,
  onEditCompactThreshold,
}: {
  usage?: ProviderSubscriptionUsage;
  contextUsage?: ContextUsage;
  breakdown?: ContextBreakdownState | null;
  modelId?: string;
  refreshing: boolean;
  onRefresh: () => void;
  onEditCompactThreshold?: () => void;
}) {
  const { locale, t } = useI18n();
  const windows = usage
    ? getApplicableSubscriptionUsageWindows(usage, modelId).sort(
        (left, right) => right.usedPercent - left.usedPercent,
      )
    : [];
  const binding = usage
    ? getMostUsedSubscriptionUsageWindow(usage, modelId)
    : null;
  const showTokens = hasContextTokenDetails(contextUsage);

  return (
    <div
      className={styles.contextSubscriptionPopover}
      role="dialog"
      aria-label={
        usage ? t("subscriptionUsageTitle") : t("contextTokenUsageTitle")
      }
      aria-busy={refreshing}
    >
      {breakdown && <ContextBreakdownSection state={breakdown} />}
      {usage && (
        <div
          className={styles.subscriptionUsageHeader}
          data-subscription-usage-header
        >
          <div>
            <div className={styles.contextThresholdPopoverTitle}>
              {t("subscriptionUsageTitle")}
            </div>
            {usage.accountLabel && <div>{usage.accountLabel}</div>}
            {binding && (
              <div className={styles.subscriptionUsageSummary}>
                {usage.ordinaryUsageAllowed === true &&
                binding.usedPercent >= 100
                  ? t("subscriptionUsageAllowed")
                  : t("subscriptionUsageCompact", {
                      percent: Math.round(binding.usedPercent),
                    })}
              </div>
            )}
          </div>
          <IconButton
            size="small"
            label={t("subscriptionUsageRefresh")}
            onClick={onRefresh}
            disabled={refreshing}
          >
            ↻
          </IconButton>
        </div>
      )}
      <div className={styles.subscriptionUsageWindows}>
        {windows.map((window) => (
          <div className={styles.subscriptionUsageWindow} key={window.id}>
            <div className={styles.subscriptionUsageWindowHeading}>
              <span>
                {scopeLabel(
                  window,
                  t("subscriptionUsageAllModels"),
                  t("subscriptionUsageClaudeApps"),
                )}
                {" · "}
                {t("subscriptionUsageWindow", {
                  duration: formatDuration(window.windowDurationMinutes),
                })}
              </span>
              <strong>
                {t("subscriptionUsagePercent", {
                  percent: Math.round(window.usedPercent),
                })}
              </strong>
            </div>
            <div className={styles.subscriptionUsageMeter} aria-hidden="true">
              <span style={{ width: `${window.usedPercent}%` }} />
            </div>
            {window.remainingCapacityUnits !== undefined && (
              <div className={styles.subscriptionUsageReset}>
                {window.remainingCapacityUnits === null
                  ? t("subscriptionUsageCapacityUnknown")
                  : t("subscriptionUsageCapacity", {
                      units: window.remainingCapacityUnits,
                    })}
              </div>
            )}
            {window.resetsAt && (
              <div className={styles.subscriptionUsageReset}>
                {t("subscriptionUsageResets", {
                  time: new Intl.DateTimeFormat(locale, {
                    dateStyle: "short",
                    timeStyle: "short",
                  }).format(new Date(window.resetsAt)),
                })}
              </div>
            )}
          </div>
        ))}
      </div>
      {showTokens && contextUsage && <ContextTokenRows usage={contextUsage} />}
      {onEditCompactThreshold && (
        <Button
          variant="ghost"
          size="small"
          className={styles.compactAction}
          onClick={onEditCompactThreshold}
        >
          {t("subscriptionUsageEditCompact")}
        </Button>
      )}
    </div>
  );
}
