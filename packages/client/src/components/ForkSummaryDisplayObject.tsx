import type { ForkSummaryTranscriptDisplayObject } from "@yep-anywhere/shared";
import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { Button } from "./ui/Button";
import { Checkbox } from "./ui/Checkbox";
import { Spinner } from "./ui/Spinner";

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

export function ForkSummaryDisplayObject({
  object,
  targetHref,
  onCancel,
  onToggleAutoOpen,
  onFollow,
}: {
  object: ForkSummaryTranscriptDisplayObject;
  targetHref?: string;
  onCancel: () => void;
  onToggleAutoOpen: (value: boolean) => void;
  onFollow: () => void;
}) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());

  // Tick the elapsed clock while generating.
  useEffect(() => {
    if (object.status !== "generating") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [object.status]);

  if (object.status === "generating") {
    return (
      <div
        className="fork-summary-display-object fork-summary-display-object-generating"
        role="status"
        aria-live="polite"
      >
        <Spinner size="small" />
        <span className="fork-summary-display-object-label">
          {t("forkSummaryProgress")}
        </span>
        <span className="fork-summary-display-object-elapsed">
          {formatElapsed(now - Date.parse(object.createdAt))}
        </span>
        <Checkbox
          className="fork-summary-display-object-autoopen"
          label={t("forkSummaryAutoOpenToggle")}
          checked={object.autoOpenWhenReady ?? false}
          onCheckedChange={(checked) => onToggleAutoOpen(checked)}
        />
        <Button
          size="small"
          className="fork-summary-display-object-cancel"
          onClick={onCancel}
        >
          {t("forkSummaryCancelInFlight")}
        </Button>
      </div>
    );
  }

  if (object.status === "error") {
    return (
      <div
        className="fork-summary-display-object fork-summary-display-object-error"
        role="alert"
      >
        <span className="fork-summary-display-object-label">
          {object.error
            ? `${t("forkSummaryFailed")}: ${object.error}`
            : t("forkSummaryFailed")}
        </span>
        <Button
          size="small"
          className="fork-summary-display-object-cancel"
          onClick={onCancel}
        >
          {t("forkSummaryDismiss")}
        </Button>
      </div>
    );
  }

  const title = object.title ?? t("forkSummaryReadyFallbackTitle");
  const stateLabel = object.clickedAt
    ? t("forkSummaryClicked")
    : object.openedAt
      ? t("forkSummaryOpenedMarker")
      : undefined;
  return (
    <div
      className="fork-summary-display-object fork-summary-display-object-ready"
      role="status"
      aria-live="polite"
    >
      <span className="fork-summary-display-object-label">
        {t("forkSummaryReadyPrefix")}
      </span>
      <a
        className="fork-summary-display-object-link"
        href={targetHref ?? "#"}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onFollow}
        title={title}
      >
        {title} ↗
      </a>
      {stateLabel && (
        <span className="fork-summary-display-object-state">{stateLabel}</span>
      )}
    </div>
  );
}
