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
import { Spinner } from "./ui/Spinner";
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

/** Order shorter windows (e.g. 5h) before longer windows (e.g. 7d) so window rows stay in a predictable position. */
function compareWindowsByDuration(
  left: ProviderSubscriptionUsageWindow,
  right: ProviderSubscriptionUsageWindow,
): number {
  const leftMinutes = left.windowDurationMinutes ?? Number.POSITIVE_INFINITY;
  const rightMinutes = right.windowDurationMinutes ?? Number.POSITIVE_INFINITY;
  if (leftMinutes !== rightMinutes) return leftMinutes - rightMinutes;
  return left.id.localeCompare(right.id);
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

function SubscriptionUsageWindowRow({
  window,
  isBinding,
}: {
  window: ProviderSubscriptionUsageWindow;
  isBinding: boolean;
}) {
  const { locale, t } = useI18n();
  const clampedPercent = Math.min(100, Math.max(0, window.usedPercent));
  return (
    <div className={styles.subscriptionUsageWindow}>
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
        <span
          className={
            isBinding ? styles.subscriptionUsageMeterBinding : undefined
          }
          style={{ width: `${clampedPercent}%` }}
        />
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
  );
}

function SubscriptionUsageSection({
  usage,
  modelId,
  refreshing,
  onRefresh,
  showAllProviderWindows,
}: {
  usage: ProviderSubscriptionUsage;
  modelId?: string;
  refreshing: boolean;
  onRefresh: () => void;
  showAllProviderWindows: boolean;
}) {
  const { t } = useI18n();
  const applicable = getApplicableSubscriptionUsageWindows(usage, modelId).sort(
    compareWindowsByDuration,
  );
  const binding = getMostUsedSubscriptionUsageWindow(usage, modelId);
  const applicableIds = new Set(applicable.map((window) => window.id));
  const other = showAllProviderWindows
    ? usage.windows
        .filter((window) => !applicableIds.has(window.id))
        .sort((left, right) => {
          const leftLabel = scopeLabel(
            left,
            t("subscriptionUsageAllModels"),
            t("subscriptionUsageClaudeApps"),
          );
          const rightLabel = scopeLabel(
            right,
            t("subscriptionUsageAllModels"),
            t("subscriptionUsageClaudeApps"),
          );
          if (leftLabel !== rightLabel) {
            return leftLabel.localeCompare(rightLabel);
          }
          return compareWindowsByDuration(left, right);
        })
    : [];
  const primaryWindows =
    applicable.length > 0 || !showAllProviderWindows ? applicable : other;
  const secondaryWindows = applicable.length > 0 ? other : [];

  return (
    <>
      <div
        className={styles.subscriptionUsageHeader}
        data-subscription-usage-header
      >
        <div>
          <div className={styles.contextThresholdPopoverTitle}>
            {t("subscriptionUsageTitle")}
          </div>
          {usage.accountLabel && (
            <div className={styles.subscriptionUsageAccount}>
              {usage.accountLabel}
            </div>
          )}
          {binding && (
            <div className={styles.subscriptionUsageSummary}>
              {usage.ordinaryUsageAllowed === true && binding.usedPercent >= 100
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
      {primaryWindows.length > 0 && (
        <div className={styles.subscriptionUsageWindows}>
          {primaryWindows.map((window) => (
            <SubscriptionUsageWindowRow
              key={window.id}
              window={window}
              isBinding={binding?.id === window.id}
            />
          ))}
        </div>
      )}
      {secondaryWindows.length > 0 && (
        <div className={styles.subscriptionUsageOtherGroup}>
          <div className={styles.subscriptionUsageGroupHeading}>
            {t("subscriptionUsageOtherModels")}
          </div>
          <div className={styles.subscriptionUsageWindows}>
            {secondaryWindows.map((window) => (
              <SubscriptionUsageWindowRow
                key={window.id}
                window={window}
                isBinding={false}
              />
            ))}
          </div>
        </div>
      )}
    </>
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
  const { t } = useI18n();
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
        <SubscriptionUsageSection
          usage={usage}
          modelId={modelId}
          refreshing={refreshing}
          onRefresh={onRefresh}
          showAllProviderWindows={false}
        />
      )}
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

/**
 * Full-width usage pane for the session model modal's Usage tab. Shows the
 * current model's subscription quota windows first, any other model buckets on
 * the same provider below, and the session's context/token details underneath.
 */
export function SessionUsagePane({
  usage,
  contextUsage,
  breakdown,
  modelId,
  refreshing,
  onRefresh,
}: {
  usage?: ProviderSubscriptionUsage;
  contextUsage?: ContextUsage;
  breakdown?: ContextBreakdownState | null;
  modelId?: string;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const showTokens = hasContextTokenDetails(contextUsage);
  const showBreakdown =
    breakdown !== null &&
    breakdown !== undefined &&
    breakdown.status !== "absent";

  return (
    <div className={styles.usagePane} aria-busy={refreshing}>
      {usage ? (
        <SubscriptionUsageSection
          usage={usage}
          modelId={modelId}
          refreshing={refreshing}
          onRefresh={onRefresh}
          showAllProviderWindows={true}
        />
      ) : refreshing ? (
        <div className={styles.usagePaneStatus}>
          <Spinner size="small" />
          <span>{t("subscriptionUsageLoading")}</span>
        </div>
      ) : (
        !showTokens &&
        !showBreakdown && (
          <div className={styles.subscriptionUsageHeader}>
            <span className={styles.usagePaneEmpty}>
              {t("subscriptionUsageUnavailable")}
            </span>
            <IconButton
              size="small"
              label={t("subscriptionUsageRefresh")}
              onClick={onRefresh}
              disabled={refreshing}
            >
              ↻
            </IconButton>
          </div>
        )
      )}
      {showBreakdown && (
        <div className={usage ? styles.usagePaneSection : undefined}>
          <ContextBreakdownSection state={breakdown} />
        </div>
      )}
      {showTokens && contextUsage && <ContextTokenRows usage={contextUsage} />}
    </div>
  );
}
