import styles from "./ClientLogRecordingBadge.module.css";
import { useEffect } from "react";
import {
  disableClientLogCollection,
  useClientLogCollectionStatus,
} from "../lib/diagnostics";
import { Button } from "./ui/Button";

const RECORDING_FAVICON_ID = "ya-client-log-recording-favicon";
const RECORDING_FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#b91c1c"/><text x="32" y="44" text-anchor="middle" font-family="Georgia,serif" font-size="42" font-weight="700" fill="#fff">Y</text></svg>`,
  );

function getTooltip() {
  return "Browser-tab diagnostics are recording because Remote Log Collection is enabled in Developer Mode. Click to stop collection for this tab.";
}

function useRecordingFavicon(active: boolean): void {
  useEffect(() => {
    if (!active || typeof document === "undefined") return;

    let link = document.getElementById(
      RECORDING_FAVICON_ID,
    ) as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement("link");
      link.id = RECORDING_FAVICON_ID;
      link.rel = "icon";
      link.type = "image/svg+xml";
      document.head.appendChild(link);
    }
    link.href = RECORDING_FAVICON;

    return () => {
      document.getElementById(RECORDING_FAVICON_ID)?.remove();
    };
  }, [active]);
}

interface ClientLogRecordingBadgeProps {
  inline?: boolean;
}

export function ClientLogRecordingBadge({
  inline = false,
}: ClientLogRecordingBadgeProps) {
  const status = useClientLogCollectionStatus();
  useRecordingFavicon(status.active);

  if (!status.active) {
    return null;
  }

  const tooltip = getTooltip();

  return (
    <Button
      variant="danger"
      size="dense"
      className={`${styles.clientLogRecordingBadge} ${inline ? styles.clientLogRecordingBadgeInline : ""}`}
      data-client-log-recording-badge
      data-client-log-recording-badge--inline={inline || undefined}
      title={tooltip}
      aria-label={tooltip}
      onClick={disableClientLogCollection}
    >
      <span
        className={styles.clientLogRecordingBadgeDot}
        data-client-log-recording-badge-dot
        aria-hidden="true"
      />
      <span>REC</span>
    </Button>
  );
}
