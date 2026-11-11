import { useInertPreview } from "./InertPreviewContext";
import popoverStyles from "./ContextUsagePopover.module.css";
import thresholdStyles from "./ContextThresholdQuickEdit.module.css";
import {
  getModelContextWindow,
  getMostUsedSubscriptionUsageWindow,
  type ProviderName,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useContextBreakdown } from "../hooks/useContextBreakdown";
import { useProviderSubscriptionUsage } from "../hooks/useProviderSubscriptionUsage";
import { useProviders } from "../hooks/useProviders";
import { useServerSettings } from "../hooks/useServerSettings";
import { useI18n } from "../i18n";
import type { ContextUsage } from "../types";
import { ContextUsageIndicator } from "./ContextUsageIndicator";
import {
  ContextUsagePopover,
  hasContextTokenDetails,
} from "./ContextUsagePopover";
import { CommittedRangeInput } from "./ui/CommittedRangeInput";

interface ContextThresholdQuickEditProps {
  usage?: ContextUsage;
  /**
   * YA model id (launch alias, e.g. "opus") — the key the Settings slider and
   * server threshold lookup use. The toolbar resolves this from the session's
   * requested model, not the reported one. See topics/provider-abstraction.md.
   */
  model?: string;
  /** Provider account whose subscription windows apply to this model. */
  provider?: ProviderName;
  /** Model context window, for the token preview. */
  contextWindow?: number;
  /** Session whose live context breakdown the usage popover shows. */
  sessionId?: string;
  size?: number;
}

const LONG_PRESS_MS = 450;
/** Keeps a viewport-clamped popover clear of the screen edge. */
const VIEWPORT_MARGIN_PX = 8;
const POPOVER_SHIFT_VAR = "--context-popover-shift";

/**
 * Effective window for the token preview: prefer the model's reported window,
 * then the static heuristic for the id, then the live usage window. Context
 * windows are observation-driven (the server learns the real window from the
 * SDK's modelUsage), so this no longer hardcodes any always-1M model.
 */
function effectiveContextWindow(
  model: string | undefined,
  passed: number | undefined,
  usageWindow: number | undefined,
): number | undefined {
  if (passed && passed > 0) return passed;
  if (model) {
    const resolved = getModelContextWindow(model);
    if (resolved > 0) return resolved;
  }
  return usageWindow && usageWindow > 0 ? usageWindow : undefined;
}

export function ContextThresholdQuickEdit(
  props: ContextThresholdQuickEditProps,
) {
  const preview = useInertPreview();
  return preview ? (
    <div className={thresholdStyles.contextThresholdQuickedit}>
      <span className={thresholdStyles.contextThresholdQuickeditTrigger}>
        <ContextUsageIndicator usage={props.usage} size={props.size} />
      </span>
    </div>
  ) : (
    <InteractiveContextThresholdQuickEdit {...props} />
  );
}

/**
 * Wraps the context-usage indicator with a long-press (touch) / right-click
 * (desktop) affordance that opens a one-control popover for *this model's*
 * "compact context early" threshold — a quick way to dial in (or off) the
 * preemptive-compaction point without opening Settings. It edits the SAME
 * `clientDefaults.compactAtContextPercent` map the Model Settings slider does
 * (a second access point, not a second mechanism). See task 029 /
 * topics/resume-compaction.md.
 */
function InteractiveContextThresholdQuickEdit({
  usage,
  model,
  provider,
  contextWindow,
  sessionId,
  size = 16,
}: ContextThresholdQuickEditProps) {
  const { t } = useI18n();
  const { settings, updateSetting } = useServerSettings();
  const { providers } = useProviders();
  const {
    usage: subscriptionUsage,
    loading: subscriptionUsageLoading,
    refresh: refreshSubscriptionUsage,
  } = useProviderSubscriptionUsage(provider);
  const [open, setOpen] = useState<"usage" | "threshold" | null>(null);
  const breakdown = useContextBreakdown(sessionId, open === "usage");
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClickRef = useRef(false);

  const canEdit = !!usage && !!model && model !== "default";
  const bindingUsageWindow = getMostUsedSubscriptionUsageWindow(
    subscriptionUsage,
    model,
  );
  const canInspectUsage = bindingUsageWindow !== null;
  /**
   * Providers without subscription-quota windows (and Claude before its quota
   * probe answers) still report per-turn cache accounting, so the popover is
   * worth opening on those too.
   */
  const canInspectTokens = hasContextTokenDetails(usage);
  const canInspect = canInspectUsage || canInspectTokens;
  const supportsNativeCompactThreshold =
    providers.find((candidate) => candidate.name === provider)
      ?.supportsNativeCompactThreshold === true;
  const forceYaOrchestratedCompaction =
    settings?.clientDefaults?.forceYaOrchestratedCompaction === true;
  const stored =
    (model
      ? settings?.clientDefaults?.compactAtContextPercent?.[model]
      : undefined) ?? 0;
  const [draft, setDraft] = useState(stored);
  useEffect(() => {
    setDraft(stored);
  }, [stored]);

  const commit = useCallback(
    (pct: number) => {
      if (!model) return;
      const next: Record<string, number> = {
        ...settings?.clientDefaults?.compactAtContextPercent,
      };
      if (pct > 0 && pct < 100) next[model] = Math.round(pct);
      else delete next[model];
      void updateSetting("clientDefaults", {
        compactAtContextPercent: next,
      }).catch(() => {
        // surfaced via the hook's error state
      });
    },
    [model, settings?.clientDefaults?.compactAtContextPercent, updateSetting],
  );

  const clearLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  /**
   * The popover is centred on the indicator, which sits near the right end of
   * the composer toolbar — at phone widths that centring pushes its right edge
   * (and the token counts) past the viewport. Nudge it back inside once it is
   * laid out, so the numbers it exists to show are readable.
   *
   * It grows upward from its anchor, so its bottom edge is fixed: capping its
   * height to the space above that edge keeps a tall popover (an expanded
   * context breakdown) scrollable instead of running off the top.
   */
  useEffect(() => {
    if (!open) return;
    const popover =
      wrapRef.current?.querySelector<HTMLElement>('[role="dialog"]');
    if (!popover) return;
    popover.style.setProperty(POPOVER_SHIFT_VAR, "0px");
    const rect = popover.getBoundingClientRect();
    popover.style.maxHeight = `${Math.max(0, Math.floor(rect.bottom - VIEWPORT_MARGIN_PX))}px`;
    popover.style.overflowY = "auto";
    const overflowRight = rect.right - (window.innerWidth - VIEWPORT_MARGIN_PX);
    const overflowLeft = VIEWPORT_MARGIN_PX - rect.left;
    const shift =
      overflowRight > 0 ? -overflowRight : overflowLeft > 0 ? overflowLeft : 0;
    if (shift !== 0) {
      popover.style.setProperty(POPOVER_SHIFT_VAR, `${Math.round(shift)}px`);
    }
  }, [open]);

  if (!usage) return null;

  const effWindow = effectiveContextWindow(
    model,
    contextWindow,
    usage.contextWindow,
  );
  const tokenPreview =
    effWindow && draft > 0
      ? `${Math.round((effWindow * draft) / 100 / 1024)}K`
      : null;

  // No quota detail, token detail, or editable model → passive indicator.
  if (!canEdit && !canInspect) {
    return <ContextUsageIndicator usage={usage} size={size} />;
  }

  const ariaLabel =
    canInspectUsage && bindingUsageWindow
      ? t("subscriptionUsageContextAria", {
          contextPercent: Math.round(usage.percentage),
          usagePercent: Math.round(bindingUsageWindow.usedPercent),
        })
      : canInspectTokens
        ? t("contextTokenUsageAria", {
            contextPercent: Math.round(usage.percentage),
          })
        : t("compactThresholdQuickTitle");

  return (
    <div ref={wrapRef} className={thresholdStyles.contextThresholdQuickedit}>
      <span
        className={thresholdStyles.contextThresholdQuickeditTrigger}
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        aria-expanded={open !== null}
        aria-label={ariaLabel}
        onClick={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          if (canInspect) {
            setOpen((current) => (current === "usage" ? null : "usage"));
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (canInspect) {
              setOpen((current) => (current === "usage" ? null : "usage"));
            } else if (canEdit) {
              setOpen((current) =>
                current === "threshold" ? null : "threshold",
              );
            }
          }
        }}
        onContextMenu={(e) => {
          if (!canEdit) return;
          e.preventDefault();
          setOpen((current) => (current === "threshold" ? null : "threshold"));
        }}
        onTouchStart={() => {
          if (!canEdit) return;
          clearLongPress();
          longPressTimer.current = setTimeout(() => {
            longPressTimer.current = null;
            suppressClickRef.current = true;
            setOpen("threshold");
          }, LONG_PRESS_MS);
        }}
        onTouchEnd={clearLongPress}
        onTouchMove={clearLongPress}
      >
        <ContextUsageIndicator usage={usage} size={size} />
      </span>
      {open === "usage" && (subscriptionUsage || canInspectTokens) && (
        <ContextUsagePopover
          usage={subscriptionUsage ?? undefined}
          contextUsage={usage}
          breakdown={breakdown}
          modelId={model}
          refreshing={subscriptionUsageLoading}
          onRefresh={() => void refreshSubscriptionUsage()}
          onEditCompactThreshold={
            canEdit ? () => setOpen("threshold") : undefined
          }
        />
      )}
      {open === "threshold" && (
        <div className={popoverStyles.contextThresholdPopover} role="dialog">
          <div className={popoverStyles.contextThresholdPopoverTitle}>
            {t("compactThresholdQuickTitle")}
          </div>
          <CommittedRangeInput
            min={0}
            max={99}
            step={1}
            value={draft}
            aria-label={t("compactThresholdQuickTitle")}
            onDraftChange={setDraft}
            onCommit={commit}
          />
          <div className={popoverStyles.contextThresholdPopoverHint}>
            {draft > 0
              ? t("compactThresholdQuickOn", {
                  percent: String(draft),
                  tokens: tokenPreview ?? "—",
                })
              : t("compactThresholdQuickOff")}
          </div>
          {supportsNativeCompactThreshold && (
            <label className={popoverStyles.contextThresholdPopoverForce}>
              <input
                type="checkbox"
                checked={forceYaOrchestratedCompaction}
                onChange={(event) => {
                  void updateSetting("clientDefaults", {
                    forceYaOrchestratedCompaction: event.currentTarget.checked,
                  }).catch(() => {
                    // surfaced via the hook's error state
                  });
                }}
              />
              <span>{t("compactThresholdQuickForceYa")}</span>
            </label>
          )}
        </div>
      )}
    </div>
  );
}
