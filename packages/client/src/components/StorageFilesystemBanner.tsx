import { useCallback, useEffect, useState } from "react";
import type { SqliteStatus } from "@yep-anywhere/shared";
import { useVersion } from "../hooks/useVersion";
import { useI18n } from "../i18n";
import styles from "./StorageFilesystemBanner.module.css";
import { Banner } from "./ui/Banner";
import { Button } from "./ui/Button";

/**
 * Dismissal is remembered per named filesystem rather than per server, so
 * moving the data directory to local disk and then back onto a share shows the
 * advice again, while a user who has read it once is not nagged every load.
 */
export function storageFilesystemDismissKey(filesystem: string): string {
  return `yep-anywhere-storage-filesystem-dismissed:${filesystem}`;
}

/**
 * The name of the network filesystem the server refused to put its database
 * on, or null when there is nothing to warn about. Older servers omit the
 * field entirely and are treated as healthy.
 */
export function storageNetworkFilesystem(
  version: { sqlite?: SqliteStatus } | null | undefined,
): string | null {
  return version?.sqlite?.networkFilesystem || null;
}

function readDismissed(filesystem: string | null): boolean {
  if (!filesystem) return false;
  try {
    return (
      window.localStorage.getItem(storageFilesystemDismissKey(filesystem)) ===
      "dismissed"
    );
  } catch {
    // Storage denied or unavailable: the warning stays visible.
    return false;
  }
}

export function StorageFilesystemBanner() {
  const { t } = useI18n();
  const { version } = useVersion();
  const filesystem = storageNetworkFilesystem(version);
  const [dismissed, setDismissed] = useState(() => readDismissed(filesystem));

  useEffect(() => {
    setDismissed(readDismissed(filesystem));
  }, [filesystem]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    if (!filesystem) return;
    try {
      window.localStorage.setItem(
        storageFilesystemDismissKey(filesystem),
        "dismissed",
      );
    } catch {
      // Keep the dismissal for this page even when it cannot be persisted.
    }
  }, [filesystem]);

  if (!filesystem || dismissed) return null;

  return (
    <Banner
      tone="warning"
      role="alert"
      className={styles.root}
      title={t("storageNetworkFilesystemTitle", { filesystem })}
      actions={
        <Button onClick={dismiss}>
          {t("storageNetworkFilesystemDismiss")}
        </Button>
      }
      data-storage-filesystem="network"
    >
      <p className={styles.body}>
        {t("storageNetworkFilesystemDescription", { filesystem })}
      </p>
      <code className={styles.command}>
        YEP_DATA_DIR=/path/on/local/disk/.yep-anywhere
      </code>
    </Banner>
  );
}
