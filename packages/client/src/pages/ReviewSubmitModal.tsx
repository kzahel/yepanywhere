import type {
  ProviderName,
  ReviewNewSessionOptions,
} from "@yep-anywhere/shared";
import { deriveReviewSubmissionName } from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import type { GlobalSessionItem } from "../api/client";
import type { ReviewPreviewItem } from "../api/reviewClient";
import { Modal } from "../components/ui/Modal";
import {
  getAvailableProviders,
  getDefaultProvider,
  useProviders,
} from "../hooks/useProviders";
import { notifyReviewCommentsChanged } from "../lib/reviewCommentsBus";
import { loadProjectSessions, reviewSessionLabel } from "../lib/reviewSessions";
import type { TranslationFn } from "../i18n";
import { generateUUID } from "../lib/uuid";
import styles from "./ReviewSubmitModal.module.css";

/**
 * The accumulating-review submit flow (topic: source-review-to-session, phase
 * P7). "Submit review" opens this: it previews every pending comment
 * (relocated against the current tree), lists stale ones first pre-selected
 * for discard, lets the reviewer pick the survivors and a target session
 * (the recent review session by default, else a fresh one), and drains the
 * chosen comments into one review turn.
 */

export function ReviewSubmitModal({
  projectId,
  recentReviewSessionId,
  submissionsEnabled = false,
  onClose,
  onNavigateSession,
  t,
}: {
  projectId: string;
  recentReviewSessionId: string | null;
  submissionsEnabled?: boolean;
  onClose: () => void;
  onNavigateSession: (sessionId: string) => void;
  t: TranslationFn;
}) {
  const [items, setItems] = useState<ReviewPreviewItem[] | null>(null);
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [targetSessionId, setTargetSessionId] = useState(
    recentReviewSessionId ?? "new",
  );
  const targetTouchedRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  const [name, setName] = useState("");
  const submissionIdRef = useRef<string | null>(null);
  if (submissionsEnabled && !submissionIdRef.current) {
    submissionIdRef.current = generateUUID();
  }
  const [sessions, setSessions] = useState<GlobalSessionItem[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const { providers, loading: providersLoading } = useProviders();
  const availableProviders = useMemo(
    () => getAvailableProviders(providers),
    [providers],
  );
  const [providerName, setProviderName] = useState<ProviderName | "">("");
  const [model, setModel] = useState("");
  const selectedProvider = availableProviders.find(
    (provider) => provider.name === providerName,
  );
  const firstIncluded = items?.find((item) => included.has(item.comment.id));
  const derivedName = deriveReviewSubmissionName(
    firstIncluded?.comment.text ?? "",
  );

  useEffect(() => {
    const preferred = getDefaultProvider(providers);
    if (preferred) setProviderName((current) => current || preferred.name);
  }, [providers]);

  // Load the project's sessions so a review can target any of them, not just a
  // fresh one or the recent review session.
  useEffect(() => {
    let cancelled = false;
    loadProjectSessions(projectId)
      .then((result) => {
        if (cancelled) return;
        setSessions(result);
        if (!targetTouchedRef.current) {
          setTargetSessionId(
            recentReviewSessionId
              ? recentReviewSessionId
              : (result[0]?.id ?? "new"),
          );
        }
      })
      .catch((cause) => {
        if (cancelled) return;
        setSessionsError(
          cause instanceof Error
            ? cause.message
            : t("sourceReviewSessionsUnavailable"),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, recentReviewSessionId, t]);

  useEffect(() => {
    let cancelled = false;
    api
      .previewReview(projectId)
      .then((result) => {
        if (cancelled) return;
        setItems(result.items);
        // Default: include everything the server did not flag for discard.
        setIncluded(
          new Set(
            result.items
              .filter((item) => !item.defaultDiscard)
              .map((item) => item.comment.id),
          ),
        );
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to preview");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const toggle = useCallback((id: string) => {
    setIncluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const submit = useCallback(async () => {
    const include = [...included];
    if (include.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const newSession: ReviewNewSessionOptions | undefined =
        targetSessionId === "new"
          ? {
              provider: providerName || undefined,
              model: model || undefined,
            }
          : undefined;
      const result =
        submissionsEnabled && submissionIdRef.current
          ? await api.submitReview(
              projectId,
              include,
              targetSessionId,
              newSession,
              {
                id: submissionIdRef.current,
                name: name.trim() || undefined,
              },
            )
          : await api.submitReview(
              projectId,
              include,
              targetSessionId,
              newSession,
            );
      notifyReviewCommentsChanged(projectId);
      if (result.sessionId) {
        onNavigateSession(result.sessionId);
        onClose();
        return;
      }
      // Lock this modal after queue acceptance. Legacy drafts stay pending;
      // keyed submissions are already archived and safe to inspect in Reviews.
      setNotice(
        t(
          submissionsEnabled
            ? "sourceReviewSubmissionQueued"
            : "sourceReviewSubmitQueued",
        ),
      );
      setQueued(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit");
    } finally {
      setBusy(false);
    }
  }, [
    included,
    targetSessionId,
    providerName,
    model,
    projectId,
    onNavigateSession,
    onClose,
    t,
    submissionsEnabled,
    name,
  ]);

  return (
    <Modal title={t("sourceReviewSubmitTitle")} onClose={onClose}>
      <div className={styles.modal}>
        {error && <div className={styles.error}>{error}</div>}
        {notice && <div role="status">{notice}</div>}
        {items === null ? (
          <div>{t("loading")}</div>
        ) : items.length === 0 ? (
          <div>{t("sourceReviewNoPending")}</div>
        ) : (
          <ul className={styles.list}>
            {items.map((item) => (
              <ReviewPreviewRow
                key={item.comment.id}
                item={item}
                checked={included.has(item.comment.id)}
                onToggle={() => toggle(item.comment.id)}
                t={t}
              />
            ))}
          </ul>
        )}

        {items && items.length > 0 && (
          <div className={styles.destination}>
            <label className={styles.field}>
              <span>{t("sourceReviewTargetLegend")}</span>
              <select
                value={targetSessionId}
                onChange={(event) => {
                  targetTouchedRef.current = true;
                  setTargetSessionId(event.target.value);
                }}
              >
                <option value="new">{t("sourceReviewTargetNew")}</option>
                {recentReviewSessionId &&
                  !sessions?.some(
                    (session) => session.id === recentReviewSessionId,
                  ) && (
                    <option value={recentReviewSessionId}>
                      {t("sourceReviewTargetRecent")} ·{" "}
                      {recentReviewSessionId.slice(0, 8)}
                    </option>
                  )}
                {sessions?.map((session) => (
                  <option key={session.id} value={session.id}>
                    {reviewSessionLabel(
                      session,
                      session.id === recentReviewSessionId
                        ? t("sourceReviewRecentSuffix")
                        : undefined,
                    )}
                  </option>
                ))}
              </select>
            </label>

            {sessionsError && (
              <div className={styles.targetError}>
                {t("sourceReviewSessionsUnavailable")}: {sessionsError}
              </div>
            )}

            {targetSessionId === "new" && (
              <div className={styles.newSession}>
                <label className={styles.field}>
                  <span>{t("sourceReviewProvider")}</span>
                  <select
                    value={providerName}
                    disabled={
                      providersLoading || availableProviders.length === 0
                    }
                    onChange={(event) => {
                      setProviderName(event.target.value as ProviderName);
                      setModel("");
                    }}
                  >
                    {availableProviders.map((provider) => (
                      <option key={provider.name} value={provider.name}>
                        {provider.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={styles.field}>
                  <span>{t("sourceReviewModel")}</span>
                  <select
                    value={model}
                    disabled={!selectedProvider}
                    onChange={(event) => setModel(event.target.value)}
                  >
                    <option value="">{t("sourceReviewModelDefault")}</option>
                    {selectedProvider?.models?.map((providerModel) => (
                      <option key={providerModel.id} value={providerModel.id}>
                        {providerModel.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
          </div>
        )}

        <div className={styles.actions}>
          {submissionsEnabled && (
            <label className={`${styles.field} ${styles.name}`}>
              <span>{t("sourceReviewSubmissionName")}</span>
              <input
                value={name}
                maxLength={120}
                placeholder={derivedName}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
          )}
          <button type="button" onClick={onClose} disabled={busy}>
            {t("cancel")}
          </button>
          <button
            type="button"
            className={styles.go}
            onClick={submit}
            disabled={busy || queued || included.size === 0}
          >
            {t("sourceReviewSubmitReview", { count: included.size })}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ReviewPreviewRow({
  item,
  checked,
  onToggle,
  t,
}: {
  item: ReviewPreviewItem;
  checked: boolean;
  onToggle: () => void;
  t: TranslationFn;
}) {
  const gone = item.relocation.status === "gone";
  const location = gone
    ? item.relocation.citeSha
      ? `${item.relocation.path} @ ${item.relocation.citeSha.slice(0, 8)}`
      : item.relocation.path
    : `${item.relocation.path}:${item.relocation.line}`;

  return (
    <li className={`${styles.row} ${gone ? styles.stale : ""}`}>
      <label className={styles.rowHead}>
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <span className={styles.location}>{location}</span>
        {gone && (
          <span className={styles.staleLabel}>{t("sourceReviewStale")}</span>
        )}
        {!gone && item.relocation.moved && (
          <span className={styles.movedLabel}>{t("sourceReviewMoved")}</span>
        )}
      </label>
      <div className={styles.rowText}>{item.comment.text}</div>
    </li>
  );
}
