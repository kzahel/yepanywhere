import styles from "./ExternalSessionWarning.module.css";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { RiskAffordance } from "./RiskAffordance";
import { Banner } from "./ui/Banner";

/**
 * Warning shown while another process (a terminal Claude session, an IDE
 * extension, another tool) owns the live session and is writing its transcript.
 *
 * Behavior the product wants:
 * - Not dismissible. It fades on its own when the external activity stops.
 * - It must not fade while the window is unfocused/hidden, so a warning that
 *   appears and decays while the user is away is still seen on return.
 * - Shows how long ago the external activity was detected; that elapsed
 *   text is the affordance that reveals the likely ill effects on hover
 *   (tooltip) and on click (modal).
 */
export function ExternalSessionWarning({ active }: { active: boolean }) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(active);
  const [nowTick, setNowTick] = useState(() => Date.now());
  // When the external warning first appeared (the precipitating event).
  const detectedAtRef = useRef<number | null>(active ? Date.now() : null);

  // Drive visibility: appear immediately when external; fade only once focused.
  useEffect(() => {
    if (active) {
      if (!visible) {
        detectedAtRef.current = Date.now();
        setNowTick(Date.now());
        setVisible(true);
      }
      return;
    }
    if (!visible) return;
    // External activity ended, but hold the banner until the window is focused
    // so the user actually sees it before it disappears.
    const fadeWhenFocused = () => {
      if (isWindowFocused()) {
        detectedAtRef.current = null;
        setVisible(false);
      }
    };
    fadeWhenFocused();
    window.addEventListener("focus", fadeWhenFocused);
    document.addEventListener("visibilitychange", fadeWhenFocused);
    return () => {
      window.removeEventListener("focus", fadeWhenFocused);
      document.removeEventListener("visibilitychange", fadeWhenFocused);
    };
  }, [active, visible]);

  // Tick the elapsed counter while visible. Recompute on focus/visibility so a
  // throttled background tab snaps to the right value when the user returns.
  useEffect(() => {
    if (!visible) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    const resync = () => setNowTick(Date.now());
    document.addEventListener("visibilitychange", resync);
    window.addEventListener("focus", resync);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", resync);
      window.removeEventListener("focus", resync);
    };
  }, [visible]);

  if (!visible) return null;

  const detectedAt = detectedAtRef.current;
  const elapsedSeconds = detectedAt
    ? Math.max(0, Math.floor((nowTick - detectedAt) / 1000))
    : 0;

  return (
    <Banner tone="warning" compact>
      {t("sessionExternalWarning")}{" "}
      <RiskAffordance
        label={t("sessionExternalWarningElapsed", {
          duration: formatDuration(elapsedSeconds),
        })}
        modalTitle={t("sessionExternalWarningExplainTitle")}
        explanation={<ExternalSessionRiskExplanation />}
      />
    </Banner>
  );
}

/**
 * The likely-ill-effects explanation, shared by the hover tooltip and the modal.
 * Deliberately scoped to *likely* effects and hedged: the real consequences
 * depend on which kind of external process is involved, and others are possible.
 */
function ExternalSessionRiskExplanation() {
  const { t } = useI18n();
  return (
    <div
      className={styles["external-session-risk-explanation"]}
      data-external-session-risk-explanation
    >
      <p>{t("sessionExternalRiskIntro")}</p>
      <ul>
        <li>
          <strong>{t("sessionExternalRiskUnseenLead")}</strong>
          {t("sessionExternalRiskUnseenBody")}
        </li>
        <li>
          <strong>{t("sessionExternalRiskForkLead")}</strong>
          {t("sessionExternalRiskForkBody")}
        </li>
        <li>
          <strong>{t("sessionExternalRiskLostLead")}</strong>
          {t("sessionExternalRiskLostBody")}
        </li>
      </ul>
      <p
        className={styles["external-session-risk-caveat"]}
        data-external-session-risk-caveat
      >
        {t("sessionExternalRiskCaveat")}
      </p>
    </div>
  );
}

function isWindowFocused(): boolean {
  if (typeof document === "undefined") return true;
  const visible = document.visibilityState === "visible";
  const focused =
    typeof document.hasFocus === "function" ? document.hasFocus() : true;
  return visible && focused;
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
