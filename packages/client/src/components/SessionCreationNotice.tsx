import { useEffect, useRef, useState } from "react";
import {
  isSessionCreationPending,
  type SessionCreationStatus,
} from "@yep-anywhere/shared";
import { useI18n } from "../i18n";
import type { SourceTransportStatus } from "../lib/transport/types";
import styles from "./SessionCreationNotice.module.css";

export function SessionCreationNotice({
  creation,
  prompt,
  onRefresh,
  paused = false,
  transportStatus,
}: {
  creation?: SessionCreationStatus;
  prompt?: string;
  onRefresh: () => Promise<void>;
  paused?: boolean;
  transportStatus?: SourceTransportStatus;
}) {
  const { t } = useI18n();
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  const [copyFailed, setCopyFailed] = useState(false);
  const [checksExhausted, setChecksExhausted] = useState(false);
  const attemptId = creation?.attemptId;
  const currentAttempt = useRef(attemptId);
  currentAttempt.current = attemptId;
  const pending =
    !!creation &&
    isSessionCreationPending(creation) &&
    creation.state !== "deleted";
  const active =
    !!creation &&
    ["saved", "queued", "dispatching", "bound"].includes(creation.state) &&
    isSessionCreationPending(creation);
  const [visibleAttempt, setVisibleAttempt] = useState(
    pending ? attemptId : undefined,
  );
  useEffect(() => {
    if (pending) {
      setVisibleAttempt(attemptId);
      return;
    }
    const timer = setTimeout(() => setVisibleAttempt(undefined), 250);
    return () => clearTimeout(timer);
  }, [pending, attemptId]);
  useEffect(() => {
    setChecksExhausted(false);
    if (!pending || paused) return;
    let stopped = false;
    let running = false;
    let resumeRequested = false;
    let checks = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      if (
        stopped ||
        currentAttempt.current !== attemptId ||
        document.visibilityState === "hidden"
      )
        return;
      if (running) {
        resumeRequested = true;
        return;
      }
      running = true;
      try {
        await refresh.current();
      } catch {
        /* Explicit refresh remains available. */
      }
      running = false;
      if (stopped || currentAttempt.current !== attemptId) return;
      if (resumeRequested) {
        resumeRequested = false;
        void check();
      } else if (active && ++checks < 15) {
        timer = setTimeout(check, 2000);
      } else if (active) {
        setChecksExhausted(true);
      }
    };
    const resume = () => {
      if (document.visibilityState === "hidden") return;
      clearTimeout(timer);
      checks = 0;
      setChecksExhausted(false);
      void check();
    };
    // A suspended check has no timer. Foregrounding explicitly renews its
    // bounded budget; closed/parked views retain neither listeners nor polls.
    document.addEventListener("visibilitychange", resume);
    let previous = transportStatus?.getSnapshot();
    const unsubscribe = transportStatus?.subscribe(() => {
      const next = transportStatus.getSnapshot();
      const restored =
        next.state === "ready" &&
        (previous?.state !== "ready" ||
          next.channels.some(
            (channel) =>
              channel.state === "connected" &&
              previous?.channels.find((old) => old.name === channel.name)
                ?.state !== "connected",
          ));
      previous = next;
      if (restored) resume();
    });
    if (active) timer = setTimeout(check, 500);
    return () => {
      stopped = true;
      clearTimeout(timer);
      unsubscribe?.();
      document.removeEventListener("visibilitychange", resume);
    };
  }, [active, pending, paused, transportStatus, attemptId]);
  if (!creation || paused) return null;
  if (!pending)
    return (
      visibleAttempt === attemptId &&
      creation.state !== "deleted" && (
        <section
          className={`${styles.progress} ${styles.departing}`}
          aria-hidden="true"
        >
          {t("sessionCreationProgress")}
        </section>
      )
    );
  const state = creation.state;
  const label =
    state === "failed" && creation.failure === "router-login-required"
      ? "sessionCreationRouterLoginRequired"
      : state === "failed" && creation.failure === "router-refused"
        ? "sessionCreationRouterRefused"
        : state === "failed" && creation.failure === "provider-host-outdated"
          ? "sessionCreationProviderHostOutdated"
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
      <p role="status">
        {t(
          active && !checksExhausted
            ? creation.state === "queued"
              ? "sessionCreationQueueProgress"
              : "sessionCreationProgress"
            : label,
        )}
      </p>
      {prompt && (
        <pre role="region" aria-label={t("sessionCreationSavedPrompt")}>
          {prompt}
        </pre>
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
        {(!active || checksExhausted) && (
          <button
            type="button"
            onClick={() => void refresh.current().catch(() => {})}
          >
            {t("sessionCreationRefresh")}
          </button>
        )}
      </div>
      {copyFailed && <p role="status">{t("sessionCreationCopyFailed")}</p>}
    </section>
  );
}
