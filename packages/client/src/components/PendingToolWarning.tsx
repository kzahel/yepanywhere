import chromeExternalSessionWarningStyles from "./ExternalSessionWarning.module.css";
import styles from "./PendingToolWarning.module.css";
import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { useTheme } from "../hooks/useTheme";
import { toolRegistry } from "./renderers/tools";
import { RiskAffordance } from "./RiskAffordance";
import { Banner } from "./ui/Banner";

/**
 * Blue "unfinished tool call" banner: shown when a session has no detected
 * owner yet its latest turn ends on a tool_use with no recorded result. That
 * dangling call is all YA actually knows — it can't tell a live program parked
 * mid-call from one that exited and left the call behind — so the banner stays
 * a short, non-committal flag. The hedged detail (and the actual tool call)
 * lives in the hover/click explanation, not the banner line.
 *
 * Sibling of ExternalSessionWarning (the amber live-concurrent-writer banner);
 * both hang the risk explanation off their elapsed "… ago" text via the shared
 * RiskAffordance, and share a common fork/branch/silent-loss vocabulary.
 */
export function PendingToolWarning({
  toolName,
  toolInput,
  pendingSinceMs,
  onDismiss,
}: {
  toolName: string;
  toolInput: unknown;
  pendingSinceMs: number | null;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const { theme } = useTheme();
  const [nowTick, setNowTick] = useState(() => Date.now());

  // Tick the elapsed counter each second; resync on focus/visibility so a
  // throttled background tab snaps to the right value when the user returns.
  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    const resync = () => setNowTick(Date.now());
    document.addEventListener("visibilitychange", resync);
    window.addEventListener("focus", resync);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", resync);
      window.removeEventListener("focus", resync);
    };
  }, []);

  const elapsedSeconds =
    pendingSinceMs != null && Number.isFinite(pendingSinceMs)
      ? Math.max(0, Math.floor((nowTick - pendingSinceMs) / 1000))
      : null;
  // Past this, a parked prompt is less likely than an abandoned call, so the
  // copy switches from "waiting" to the "may have been discarded" framing.
  const isStale =
    elapsedSeconds != null && elapsedSeconds >= STALE_AFTER_SECONDS;
  const message = isStale
    ? t("pendingToolWarningStale", { tool: toolName })
    : t("pendingToolWarningWaiting", { tool: toolName });

  return (
    <Banner
      tone="info"
      compact
      onDismiss={onDismiss}
      dismissLabel={t("sessionPendingElsewhereDismiss")}
    >
      <div
        className={styles["pending-tool-warning-copy"]}
        data-pending-tool-warning-copy
      >
        <svg
          className={styles["pending-tool-warning-icon"]}
          data-pending-tool-warning-icon
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 8v4" />
          <path d="M12 16h.01" />
        </svg>
        <span>
          {message}{" "}
          {elapsedSeconds != null && (
            <RiskAffordance
              label={t("pendingToolWarningElapsed", {
                duration: formatDuration(elapsedSeconds),
              })}
              modalTitle={t("pendingToolWarningExplainTitle")}
              explanation={
                <PendingToolRiskExplanation
                  toolName={toolName}
                  toolInput={toolInput}
                  theme={theme === "light" ? "light" : "dark"}
                />
              }
            />
          )}
        </span>
      </div>
    </Banner>
  );
}

/**
 * Likely-ill-effects explanation, shown in the hover tooltip and the modal.
 * Leads with the concrete unfinished tool call (rendered with the same
 * per-tool renderers the transcript uses) so "which call?" is answered, then
 * the deliberately hedged effects: YA cannot tell a parked program from an
 * exited one.
 */
function PendingToolRiskExplanation({
  toolName,
  toolInput,
  theme,
}: {
  toolName: string;
  toolInput: unknown;
  theme: "light" | "dark";
}) {
  const { t } = useI18n();
  return (
    <div
      className={
        chromeExternalSessionWarningStyles["external-session-risk-explanation"]
      }
      data-external-session-risk-explanation
    >
      <div
        className={styles["pending-tool-warning-call"]}
        data-pending-tool-warning-call
      >
        <span
          className={styles["pending-tool-warning-call-label"]}
          data-pending-tool-warning-call-label
        >
          {toolRegistry.getDisplayName(toolName, "pending")}
        </span>
        {toolRegistry.renderToolUse(toolName, toolInput, {
          isStreaming: false,
          theme,
        })}
      </div>
      <p>{t("pendingToolRiskIntro")}</p>
      <ul>
        <li>
          <strong>{t("pendingToolRiskUnblockLead")}</strong>
          {t("pendingToolRiskUnblockBody")}
        </li>
        <li>
          <strong>{t("pendingToolRiskForkLead")}</strong>
          {t("pendingToolRiskForkBody")}
        </li>
        <li>
          <strong>{t("pendingToolRiskDiscardLead")}</strong>
          {t("pendingToolRiskDiscardBody")}
        </li>
      </ul>
      <p
        className={
          chromeExternalSessionWarningStyles["external-session-risk-caveat"]
        }
        data-external-session-risk-caveat
      >
        {t("pendingToolRiskCaveat")}
      </p>
    </div>
  );
}

const STALE_AFTER_SECONDS = 10 * 60;

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
