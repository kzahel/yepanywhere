import type { SessionProviderPhase } from "@yep-anywhere/shared";
import { useI18n } from "../i18n";
import { formatBriefAge } from "../lib/sessionAge";
import styles from "./SessionProviderPhase.module.css";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { Badge } from "./ui/Badge";

function formatClock(iso: string): string | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms)
    ? new Date(ms).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })
    : null;
}

/**
 * The row mark before an active session's title: the pulsing dot while the
 * provider generates, an orange ring while its turn waits on recorded work,
 * and a gray ring while background work holds an ended turn.
 */
export function SessionProviderPhaseMark({
  phase,
}: {
  phase: SessionProviderPhase["phase"] | undefined;
}) {
  const { t } = useI18n();
  if (phase !== "waiting" && phase !== "background") {
    return <ThinkingIndicator />;
  }
  return (
    <span
      className={styles.ring}
      data-phase={phase}
      role="img"
      aria-label={t(
        phase === "waiting"
          ? "sessionProviderPhaseWaiting"
          : "sessionProviderPhaseBackground",
      )}
    />
  );
}

/**
 * The meta-line pill naming what a waiting or background session holds.
 * Times lead so truncation removes the label, not the timer; ages are as of
 * the last row refresh, like the row's own timestamp.
 */
export function SessionProviderPhasePill({
  providerPhase,
}: {
  providerPhase: SessionProviderPhase;
}) {
  const { t } = useI18n();
  if (providerPhase.phase === "generating") return null;
  const [first] = providerPhase.work ?? [];
  const count = providerPhase.workCount ?? providerPhase.work?.length ?? 0;
  let text: string;
  if (!first) {
    text = t("sessionProviderPhaseBackgroundWork");
  } else {
    const wake = first.until ? formatClock(first.until) : null;
    // Ages do not tick, so a sub-minute age would only mislead.
    const brief = first.startedAt ? formatBriefAge(first.startedAt) : null;
    const age = brief === "0m" ? null : brief;
    const parts =
      first.kind === "sleep" && wake
        ? [t("sessionProviderPhaseSleepingUntil", { time: wake })]
        : [
            wake ? t("sessionProviderPhaseWakesAt", { time: wake }) : age,
            count > 1 ? t("sessionProviderPhaseTaskCount", { count }) : null,
            first.label,
          ];
    text = parts.filter(Boolean).join(" · ");
  }
  return (
    <Badge
      palette={
        providerPhase.phase === "waiting"
          ? {
              color: "var(--thinking-color)",
              soft: "color-mix(in srgb, var(--thinking-color) 12%, transparent)",
            }
          : undefined
      }
      tone={providerPhase.phase === "waiting" ? "info" : "neutral"}
      size="small"
      className={styles.pill}
      data-phase={providerPhase.phase}
      data-provider-phase-pill=""
      tooltip={first?.command ? `${text}\n${first.command}` : text}
    >
      <span className={styles.pillText}>{text}</span>
    </Badge>
  );
}
