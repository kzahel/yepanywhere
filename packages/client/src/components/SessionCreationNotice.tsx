import { useEffect, useRef, useState } from "react";
import {
  isSessionCreationPending,
  type SessionCreationStatus,
} from "@yep-anywhere/shared";
import { useI18n } from "../i18n";
import styles from "./SessionCreationNotice.module.css";

export function SessionCreationNotice({
  creation,
  prompt,
  onRefresh,
}: {
  creation?: SessionCreationStatus;
  prompt?: string;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useI18n();
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  const [copyFailed, setCopyFailed] = useState(false);
  const active =
    !!creation &&
    ["saved", "queued", "dispatching", "bound"].includes(creation.state) &&
    isSessionCreationPending(creation);
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let checks = 0;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      if (stopped || document.visibilityState === "hidden") return;
      try {
        await refresh.current();
      } catch {
        /* Explicit refresh remains available. */
      }
      // Temporary view-owned startup reconciliation: no idle per-session loop.
      if (!stopped && ++checks < 15) timer = setTimeout(check, 2000);
    };
    timer = setTimeout(check, 500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [active]);
  if (
    !creation ||
    !isSessionCreationPending(creation) ||
    creation.state === "deleted"
  )
    return null;
  const state = creation.state;
  const label =
    state === "failed" && creation.failure === "router-login-required"
      ? "sessionCreationRouterLoginRequired"
      : state === "failed" && creation.failure === "router-refused"
        ? "sessionCreationRouterRefused"
        : state === "failed"
          ? creation.initialInputExpected === false
            ? "sessionPreparationFailed"
            : "sessionCreationFailed"
          : state === "uncertain"
            ? creation.initialInputExpected === false
              ? "sessionPreparationUncertain"
              : "sessionCreationUncertain"
            : state === "queued"
              ? "sessionCreationQueued"
              : "sessionCreationStarting";
  return (
    <section className={styles.notice} aria-label={t("sessionCreationLabel")}>
      <p role="status">{t(label)}</p>
      {prompt && (
        <details>
          <summary>{t("sessionCreationSavedPrompt")}</summary>
          <pre>{prompt}</pre>
        </details>
      )}
      <div className={styles.actions}>
        {prompt && (
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(prompt);
                setCopyFailed(false);
              } catch {
                setCopyFailed(true);
              }
            }}
          >
            {t("sessionCreationCopyPrompt")}
          </button>
        )}
        <button
          type="button"
          onClick={() => void refresh.current().catch(() => {})}
        >
          {t("sessionCreationRefresh")}
        </button>
      </div>
      {copyFailed && <p role="status">{t("sessionCreationCopyFailed")}</p>}
    </section>
  );
}
