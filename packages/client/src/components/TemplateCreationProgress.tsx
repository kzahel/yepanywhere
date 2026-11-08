import { useEffect, useId, useRef, useState } from "react";
import type { TemplateCreationOperation } from "../api/projectTemplatesClient";
import { useI18n } from "../i18n";
import styles from "./TemplateCreationProgress.module.css";
import { Button } from "./ui/Button";

/** Progress remains mounted while operation snapshots arrive; disclosure state
 * and elapsed time belong to this view, not individual polling responses. */
export function TemplateCreationProgress({
  operation,
}: {
  operation: TemplateCreationOperation | null;
}) {
  const { t } = useI18n();
  const logId = useId();
  const began = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);
  const [expanded, setExpanded] = useState(true);
  const active =
    !operation ||
    !["started", "failed", "interrupted"].includes(operation.phase);
  const phase = operation
    ? t(`templatePhase_${operation.phase}`)
    : t("templateSubmitting");
  const output = operation?.log.trim();
  const latest = output
    ?.split("\n")
    .filter((line) => line.trim())
    .at(-1);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - began.current) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [active]);
  return (
    <div className={styles.progress}>
      <div className={styles.heading}>
        <strong role="status">{phase}</strong>
        <small aria-live="off" title={t("templateElapsedHint")}>
          {t("templateElapsed", { seconds: elapsed })}
        </small>
      </div>
      {active && <progress className={styles.activity} aria-label={phase} />}
      {operation?.error && <p role="alert">{operation.error}</p>}
      <Button
        className={styles.toggle}
        aria-expanded={expanded}
        aria-controls={logId}
        onClick={() => setExpanded((value) => !value)}
      >
        {t(expanded ? "templateHideLog" : "templateShowLog")}
      </Button>
      <pre id={logId} className={styles.log} hidden={!expanded}>
        {output || t("templateWaitingOutput")}
      </pre>
      {!expanded && (
        <p className={styles.latest}>{latest || t("templateWaitingOutput")}</p>
      )}
    </div>
  );
}
