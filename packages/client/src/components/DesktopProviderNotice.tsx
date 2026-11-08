import type { ProviderInfo } from "@yep-anywhere/shared";
import { useEffect, useState } from "react";
import { useProviders } from "../hooks/useProviders";
import { useVersion } from "../hooks/useVersion";
import { useI18n } from "../i18n";
import { Button, buttonClassName, IconButton } from "./ui/Button";

const CLAUDE_DOWNLOAD_URL = "https://claude.com/download";
const CODEX_DOWNLOAD_URL = "https://openai.com/codex/get-started/";
const DISMISSED_STORAGE_KEY = "desktop-provider-notice-dismissed";

export function readDesktopProviderNoticeDismissed(
  storage: Pick<Storage, "getItem"> = window.localStorage,
): boolean {
  try {
    return storage.getItem(DISMISSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeDesktopProviderNoticeDismissed(
  storage: Pick<Storage, "setItem"> = window.localStorage,
): void {
  try {
    storage.setItem(DISMISSED_STORAGE_KEY, "true");
  } catch {
    // A storage failure leaves the current in-memory dismissal in place.
  }
}

export function hasDesktopProviderRuntime(providers: ProviderInfo[]): boolean {
  return providers.some(
    (provider) =>
      (provider.name === "claude" || provider.name === "codex") &&
      (provider.applicationDetected ?? provider.installed),
  );
}

export function DesktopProviderNotice() {
  const { t } = useI18n();
  const { version } = useVersion();
  const { providers, loading, error, refetch } = useProviders();
  const [dismissed, setDismissed] = useState(() =>
    readDesktopProviderNoticeDismissed(),
  );

  useEffect(() => {
    if (version?.desktopRuntime !== true) return;
    const refresh = () => void refetch();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refetch, version?.desktopRuntime]);

  if (
    dismissed ||
    version?.desktopRuntime !== true ||
    loading ||
    error ||
    hasDesktopProviderRuntime(providers)
  ) {
    return null;
  }

  return (
    <aside className="desktop-provider-notice" aria-live="polite">
      <div className="desktop-provider-notice__copy">
        <strong>{t("desktopProviderNoticeTitle")}</strong>
        <span>{t("desktopProviderNoticeDescription")}</span>
      </div>
      <div className="desktop-provider-notice__actions">
        <a
          href={CLAUDE_DOWNLOAD_URL}
          target="_blank"
          rel="noreferrer"
          className={buttonClassName()}
        >
          {t("desktopProviderNoticeGetClaude")}
        </a>
        <a
          href={CODEX_DOWNLOAD_URL}
          target="_blank"
          rel="noreferrer"
          className={buttonClassName()}
        >
          {t("desktopProviderNoticeGetCodex")}
        </a>
        <Button onClick={() => void refetch()}>
          {t("desktopProviderNoticeRetry")}
        </Button>
        <IconButton
          className="desktop-provider-notice__dismiss"
          label={t("desktopProviderNoticeDismiss")}
          onClick={() => {
            writeDesktopProviderNoticeDismissed();
            setDismissed(true);
          }}
        >
          ×
        </IconButton>
      </div>
    </aside>
  );
}
