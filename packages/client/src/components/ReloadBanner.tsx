import type {
  SafeRestartBlocker,
  SafeRestartPreservedWork,
  SafeRestartState,
} from "@yep-anywhere/shared";
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { useI18n } from "../i18n";
import { querySessionRouteLayerElement } from "../lib/sessionRouteLayer";
import styles from "./ReloadBanner.module.css";
import { Banner } from "./ui/Banner";
import { Button } from "./ui/Button";

const RELOAD_BANNER_CONTROL_GAP = 4;
const RELOAD_BANNER_COMPOSER_GAP = 8;
const RELOAD_BANNER_DEFAULT_BOTTOM = 12;

function rectsOverlap(first: DOMRect, second: DOMRect, gap: number): boolean {
  return (
    first.left < second.right + gap &&
    first.right > second.left - gap &&
    first.top < second.bottom + gap &&
    first.bottom > second.top - gap
  );
}

interface Props {
  target: "backend" | "frontend";
  onReload: () => void;
  onDismiss: () => void;
  onRestartWhenSafe?: () => void;
  onCancelSafeRestart?: () => void;
  unsafeToRestart?: boolean;
  interruptibleSessionCount?: number;
  queuedSessionMessageCount?: number;
  safeRestartState?: SafeRestartState;
  safeRestartMutating?: boolean;
}

export function ReloadBannerStack({
  children,
  avoidSessionComposer = false,
}: {
  children: ReactNode;
  avoidSessionComposer?: boolean;
}) {
  const stackRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const stack = stackRef.current;
    if (!stack) return;

    let animationFrame: number | null = null;
    const updatePlacement = () => {
      // The empty stack stays mounted for future notices. Measuring it after
      // composer mutations would force page layout on ordinary typing.
      if (!stack.firstElementChild) return;
      stack.style.setProperty("--reload-banner-stack-lift", "0px");

      const stackRect = stack.getBoundingClientRect();
      if (stackRect.width === 0 || stackRect.height === 0) return;

      let lift = 0;
      const composer =
        avoidSessionComposer && window.innerWidth > 600
          ? querySessionRouteLayerElement<HTMLElement>(".session-input")
          : null;
      if (composer) {
        const controls = composer.querySelectorAll<HTMLElement>(
          "button, a[href], [role='button'], input:not([type='hidden']), select",
        );
        const overlapsAControl = Array.from(controls).some((control) => {
          const controlRect = control.getBoundingClientRect();
          return (
            controlRect.width > 0 &&
            controlRect.height > 0 &&
            rectsOverlap(stackRect, controlRect, RELOAD_BANNER_CONTROL_GAP)
          );
        });
        if (overlapsAControl) {
          const composerRect = composer.getBoundingClientRect();
          lift = Math.max(
            lift,
            window.innerHeight -
              composerRect.top +
              RELOAD_BANNER_COMPOSER_GAP -
              RELOAD_BANNER_DEFAULT_BOTTOM,
          );
        }
      }

      stack.style.setProperty(
        "--reload-banner-stack-lift",
        `${Math.max(0, Math.ceil(lift))}px`,
      );
    };
    const schedulePlacement = () => {
      if (!stack.firstElementChild) return;
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = null;
        updatePlacement();
      });
    };

    updatePlacement();
    window.addEventListener("resize", schedulePlacement);

    const composer = avoidSessionComposer
      ? querySessionRouteLayerElement<HTMLElement>(".session-input")
      : null;
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedulePlacement);
    resizeObserver?.observe(stack);
    if (composer) resizeObserver?.observe(composer);

    const mutationObserver = composer
      ? new MutationObserver(schedulePlacement)
      : null;
    if (composer && mutationObserver) {
      mutationObserver.observe(composer, {
        attributes: true,
        childList: true,
        subtree: true,
      });
    }

    return () => {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
      window.removeEventListener("resize", schedulePlacement);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [avoidSessionComposer]);

  return (
    // `reload-banner-stack` stays literal: the placement effect above and
    // the focused test both find this element by class to stub geometry.
    <div ref={stackRef} className={`reload-banner-stack ${styles.stack}`}>
      {children}
    </div>
  );
}

function blockerCount(
  blockers: SafeRestartBlocker[],
  type: SafeRestartBlocker["type"],
): number {
  return blockers.find((blocker) => blocker.type === type)?.count ?? 0;
}

function preservedCount(
  preserved: SafeRestartPreservedWork[] | undefined,
  type: SafeRestartPreservedWork["type"],
): number {
  return preserved?.find((item) => item.type === type)?.count ?? 0;
}

export function ReloadBanner({
  target,
  onReload,
  onDismiss,
  onRestartWhenSafe,
  onCancelSafeRestart,
  unsafeToRestart,
  interruptibleSessionCount = 0,
  queuedSessionMessageCount = 0,
  safeRestartState,
  safeRestartMutating = false,
}: Props) {
  const { t } = useI18n();
  const label =
    target === "backend"
      ? t("reloadBannerTargetServer")
      : t("reloadBannerTargetFrontend");
  const hasScheduledRestart =
    target === "backend" &&
    safeRestartState !== undefined &&
    safeRestartState.status !== "idle";
  const showWarning =
    (unsafeToRestart && target === "backend") || hasScheduledRestart;
  const canScheduleSafeRestart =
    target === "backend" &&
    onRestartWhenSafe &&
    unsafeToRestart &&
    !hasScheduledRestart;
  const activeBlockers = safeRestartState
    ? blockerCount(safeRestartState.blockers, "active-sessions")
    : 0;
  const queuedBlockers = safeRestartState
    ? blockerCount(safeRestartState.blockers, "session-queue")
    : 0;
  const recoveredQueuePreserved = safeRestartState
    ? preservedCount(safeRestartState.preserved, "recovered-session-queue")
    : 0;
  const safeRestartStatus =
    safeRestartState?.status === "restarting"
      ? t("reloadBannerSafeRestartRestarting")
      : hasScheduledRestart
        ? activeBlockers > 0 && queuedBlockers > 0
          ? t("reloadBannerSafeRestartWaitingActiveAndQueued", {
              activeCount: activeBlockers,
              activeSuffix: activeBlockers !== 1 ? "s" : "",
              queuedCount: queuedBlockers,
              queuedSuffix: queuedBlockers !== 1 ? "s" : "",
            })
          : activeBlockers > 0
            ? t("reloadBannerSafeRestartWaitingActive", {
                count: activeBlockers,
                suffix: activeBlockers !== 1 ? "s" : "",
              })
            : queuedBlockers > 0
              ? t("reloadBannerSafeRestartWaitingQueued", {
                  count: queuedBlockers,
                  suffix: queuedBlockers !== 1 ? "s" : "",
                })
              : t("reloadBannerSafeRestartReady")
        : null;
  const safeRestartPreservedStatus =
    hasScheduledRestart && recoveredQueuePreserved > 0
      ? t("reloadBannerSafeRestartPreservedRecoveredQueue", {
          count: recoveredQueuePreserved,
          suffix: recoveredQueuePreserved !== 1 ? "s" : "",
        })
      : null;
  const immediateRestartWarning =
    interruptibleSessionCount > 0 && queuedSessionMessageCount > 0
      ? t("developmentInterruptedWarningActiveAndQueued", {
          activeCount: interruptibleSessionCount,
          activeSuffix: interruptibleSessionCount !== 1 ? "s" : "",
          queuedCount: queuedSessionMessageCount,
          queuedSuffix: queuedSessionMessageCount !== 1 ? "s" : "",
        })
      : queuedSessionMessageCount > 0
        ? t("developmentInterruptedWarningQueued", {
            count: queuedSessionMessageCount,
            suffix: queuedSessionMessageCount !== 1 ? "s" : "",
          })
        : t("developmentInterruptedWarning", {
            count: interruptibleSessionCount,
            suffix: interruptibleSessionCount !== 1 ? "s " : " ",
          });
  const compactBlockerStatus =
    activeBlockers > 0 && queuedBlockers > 0
      ? t("reloadBannerStatusActiveAndQueuedCompact", {
          activeCount: activeBlockers,
          queuedCount: queuedBlockers,
        })
      : activeBlockers > 0
        ? t("reloadBannerStatusActiveCompact", { count: activeBlockers })
        : queuedBlockers > 0
          ? t("reloadBannerStatusQueuedCompact", { count: queuedBlockers })
          : null;
  const compactImmediateRestartWarning =
    interruptibleSessionCount > 0 && queuedSessionMessageCount > 0
      ? t("reloadBannerStatusActiveAndQueuedCompact", {
          activeCount: interruptibleSessionCount,
          queuedCount: queuedSessionMessageCount,
        })
      : queuedSessionMessageCount > 0
        ? t("reloadBannerStatusQueuedCompact", {
            count: queuedSessionMessageCount,
          })
        : t("reloadBannerStatusActiveCompact", {
            count: interruptibleSessionCount,
          });
  const compactWarningStatus =
    safeRestartState?.status === "restarting"
      ? t("reloadBannerSafeRestartRestartingCompact")
      : hasScheduledRestart
        ? (compactBlockerStatus ?? t("reloadBannerSafeRestartReadyCompact"))
        : compactImmediateRestartWarning;
  const warningStatus = safeRestartStatus ?? immediateRestartWarning;
  const warningDetail = safeRestartPreservedStatus
    ? `${warningStatus} ${safeRestartPreservedStatus}`
    : warningStatus;
  const primaryReloadLabel = showWarning
    ? t("reloadBannerReloadNow")
    : t("reloadBannerReloadTarget", { target: label });

  const handleImmediateReloadClick = () => {
    onDismiss();
    onReload();
  };
  const handleRestartWhenSafeClick = () => {
    onDismiss();
    onRestartWhenSafe?.();
  };
  const handleCancelSafeRestartClick = () => {
    onDismiss();
    onCancelSafeRestart?.();
  };
  const handleDismissClick = () => {
    onDismiss();
  };

  return (
    // `reload-banner` stays literal: the global transcript-selection rule in
    // styles/index.css and the transcript artifact smoke script name it.
    <Banner
      tone={showWarning ? "error" : "warning"}
      role="status"
      className={`reload-banner ${styles.banner}`}
      onDismiss={handleDismissClick}
      dismissLabel={t("reloadBannerDismiss")}
      actions={
        <>
          <Button
            variant={showWarning ? "secondary" : "primary"}
            className={`${styles.button} ${styles.buttonPrimary}`}
            onClick={handleImmediateReloadClick}
            aria-label={primaryReloadLabel}
            title={primaryReloadLabel}
          >
            <span className={styles.buttonLabel}>
              {t("reloadBannerReloadTargetCompact")}
            </span>
          </Button>
          {canScheduleSafeRestart && (
            <Button
              className={`${styles.button} ${styles.buttonSafe}`}
              onClick={handleRestartWhenSafeClick}
              disabled={safeRestartMutating}
              aria-label={t("reloadBannerRestartWhenSafe")}
              title={t("reloadBannerRestartWhenSafe")}
            >
              <span className={styles.buttonLabel}>
                {t("reloadBannerRestartWhenSafeCompact")}
              </span>
            </Button>
          )}
          {hasScheduledRestart && onCancelSafeRestart && (
            <Button
              className={styles.button}
              onClick={handleCancelSafeRestartClick}
              disabled={safeRestartMutating}
              aria-label={t("reloadBannerCancelSafeRestart")}
              title={t("reloadBannerCancelSafeRestart")}
            >
              <span className={styles.buttonLabel}>
                {t("reloadBannerCancelSafeRestartCompact")}
              </span>
            </Button>
          )}
        </>
      }
    >
      <span className={styles.content}>
        <span className={styles.message}>
          {t("reloadBannerCodeChangedCompact", { target: label })}
        </span>
        {showWarning && (
          <span
            className={styles.warningText}
            aria-hidden="true"
            title={warningDetail}
          >
            {" · "}
            {compactWarningStatus}
          </span>
        )}
        {showWarning && (
          <span className={styles.warningDetail}>{warningDetail}</span>
        )}
      </span>
    </Banner>
  );
}
