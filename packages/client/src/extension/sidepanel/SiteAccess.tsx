import { useEffect, useId, useState } from "react";
import { YepAnywhereGlyph } from "../../components/YepAnywhereLogo";
import { Button, ButtonBase } from "../../components/ui/Button";
import { useI18n } from "../../i18n";
import { getChrome } from "../chrome";
import styles from "./SidePanel.module.css";
import type { CurrentTab } from "./useCurrentTab";

/** Site permission is independent of issue recognition and host sign-in. */
export function SiteAccess({ tab }: { tab: CurrentTab }) {
  let origin: string | undefined;
  if (tab.url) {
    try {
      const url = new URL(tab.url);
      // Chrome cannot grant access to its own pages or other extensions.
      if (url.protocol !== "https:" && url.protocol !== "http:") return null;
      origin = url.origin;
    } catch {
      return null;
    }
  }
  if (!getChrome() || (!origin && tab.tabId === undefined)) return null;
  return <SiteAccessDisclosure key={tab.tabId} origin={origin} />;
}

function SiteAccessDisclosure({ origin }: { origin?: string }) {
  const [disclosure, setDisclosure] = useState({ origin, expanded: false });
  if (disclosure.origin !== origin) {
    // Learning the address keeps help open; browsing to another site closes it.
    setDisclosure({
      origin,
      expanded: disclosure.origin === undefined && disclosure.expanded,
    });
  }
  return (
    <SiteAccessRequest
      key={origin}
      origin={origin}
      expanded={disclosure.expanded}
      onToggle={() =>
        setDisclosure((value) => ({ ...value, expanded: !value.expanded }))
      }
    />
  );
}

function SiteAccessRequest({
  origin,
  expanded,
  onToggle,
}: {
  origin?: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const contentId = useId();
  const [granted, setGranted] = useState<boolean | null>(null);
  const [request, setRequest] = useState<
    "idle" | "waiting" | "denied" | "error"
  >("idle");
  const chrome = getChrome();

  useEffect(() => {
    if (!chrome || !origin) return;
    let disposed = false;
    let revision = 0;
    const check = () => {
      const current = ++revision;
      void chrome.permissions.contains({ origins: [`${origin}/*`] }).then(
        (value) => {
          if (!disposed && current === revision) setGranted(value);
        },
        () => {
          if (!disposed && current === revision) setGranted(false);
        },
      );
    };
    check();
    chrome.permissions.onAdded.addListener(check);
    chrome.permissions.onRemoved.addListener(check);
    return () => {
      disposed = true;
      chrome.permissions.onAdded.removeListener(check);
      chrome.permissions.onRemoved.removeListener(check);
    };
  }, [chrome, origin]);

  if (!chrome || (origin && granted !== false)) return null;
  const site = origin ? new URL(origin).host : undefined;
  const requestSite = () => {
    if (!origin) return;
    setRequest("waiting");
    // Keep permissions.request in the click's gesture; no preceding await.
    void chrome.permissions.request({ origins: [`${origin}/*`] }).then(
      (accepted) => {
        if (accepted) setGranted(true);
        setRequest(accepted ? "idle" : "denied");
      },
      () => setRequest("error"),
    );
  };

  return (
    <section className={`${styles.context} ${styles.siteAccess}`}>
      <ButtonBase
        className={styles.siteAccessToggle}
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={onToggle}
      >
        {t("extensionPanelSiteAccessExpand")}
        <svg
          className={styles.chevron}
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="m6 3 5 5-5 5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </ButtonBase>
      <div
        id={contentId}
        className={styles.siteAccessContent}
        hidden={!expanded}
      >
        <h2>{t("extensionPanelSiteAccessTitle")}</h2>
        <p>
          {site
            ? t("extensionPanelSiteAccessKnownHint", { site })
            : t("extensionPanelSiteAccessUnknownHint")}
        </p>
        {!site ? (
          <SiteAccessInstructions />
        ) : (
          <Button
            variant="primary"
            onClick={requestSite}
            disabled={request === "waiting"}
          >
            {t("extensionPanelAllowNamedSite", { site })}
          </Button>
        )}
        {(request === "error" || request === "denied") && (
          <p role="alert">
            {t(
              request === "denied"
                ? "extensionPanelSiteAccessDenied"
                : "extensionPanelSiteAccessFailed",
            )}
          </p>
        )}
      </div>
    </section>
  );
}

function ExtensionsIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M9 3H5a2 2 0 0 0-2 2v4h2a3 3 0 0 1 0 6H3v4a2 2 0 0 0 2 2h4v-2a3 3 0 0 1 6 0v2h4a2 2 0 0 0 2-2v-4h-2a3 3 0 0 1 0-6h2V5a2 2 0 0 0-2-2h-4V2a3 3 0 0 0-6 0v1Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SiteAccessInstructions() {
  const { t } = useI18n();
  return (
    <>
      <div className={styles.toolbarIllustration} aria-hidden="true">
        <div className={styles.browserToolbar}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="m13 5-7 7 7 7M6 12h14"
              stroke="currentColor"
              strokeWidth="2"
            />
          </svg>
          <div className={styles.addressBar}>https://…</div>
          <div className={styles.highlightedIcon}>
            <YepAnywhereGlyph size={26} />
            <svg
              className={styles.iconPointer}
              width="24"
              height="28"
              viewBox="0 0 24 28"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="m4 2 16 14-8 1-4 8L4 2Z"
                fill="var(--text-primary)"
                stroke="var(--bg-surface)"
                strokeWidth="2"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <ExtensionsIcon />
          <span>⋮</span>
        </div>
      </div>
      <ol className={styles.accessSteps}>
        <li>
          <strong>{t("extensionPanelSiteAccessClickIcon")}</strong>
          <p>{t("extensionPanelSiteAccessIconLocation")}</p>
        </li>
        <li>
          <strong>{t("extensionPanelSiteAccessThenAllow")}</strong>
          <p>{t("extensionPanelSiteAccessApprovePrompt")}</p>
        </li>
      </ol>
      <p className={styles.hiddenIconHint}>
        <ExtensionsIcon />
        <span>{t("extensionPanelSiteAccessHiddenIcon")}</span>
      </p>
    </>
  );
}
