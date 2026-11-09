import {
  deriveReviewSubmissionName,
  type ReviewCapturedSource,
  type ReviewEntryCapturedSource,
  type ReviewSite,
  type ReviewSourceChangeStatus,
  type ReviewSubmissionDetail,
  type ReviewSubmissionSummary,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { Button, ButtonBase } from "../components/ui/Button";
import { Field, Select, Textarea } from "../components/ui/Field";
import type { TranslationFn } from "../i18n";
import { notifyReviewCommentsChanged } from "../lib/reviewCommentsBus";
import styles from "./ReviewSubmissionsPanel.module.css";

/** Canonical submission/site browser for captured source-review history. */
export function ReviewSubmissionsPanel({
  projectId,
  initialSubmissionId,
  sessionHref,
  t,
}: {
  projectId: string;
  initialSubmissionId?: string;
  sessionHref: (sessionId: string) => string;
  t: TranslationFn;
}) {
  const [submissions, setSubmissions] = useState<ReviewSubmissionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReviewSubmissionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadSubmissions = useCallback(
    async (cursor?: string) => {
      const result = await api.listReviewSubmissions(projectId, {
        cursor,
        limit: 50,
      });
      setSubmissions((current) =>
        cursor ? [...current, ...result.submissions] : result.submissions,
      );
      setNextCursor(result.nextCursor);
      if (!cursor) {
        setSelectedId((current) =>
          initialSubmissionId
            ? initialSubmissionId
            : result.submissions.some((item) => item.id === current)
              ? current
              : (result.submissions[0]?.id ?? null),
        );
      }
    },
    [initialSubmissionId, projectId],
  );

  const loadDetail = useCallback(
    async (submissionId: string) => {
      const result = await api.getReviewSubmission(projectId, submissionId);
      setDetail(result);
      setSubmissions((current) =>
        current.some((item) => item.id === result.submission.id)
          ? current
          : [result.submission, ...current],
      );
    },
    [projectId],
  );

  // Effects run only after the selected detail has committed to the visible
  // tree; list and detail prefetches therefore never acknowledge outcomes.
  useEffect(() => {
    if (
      !detail ||
      detail.submission.id !== selectedId ||
      detail.submission.responseRevision <=
        detail.submission.acknowledgedRevision
    ) {
      return;
    }
    let cancelled = false;
    void api
      .acknowledgeReviewSubmission(projectId, detail.submission.id)
      .then(({ submission }) => {
        if (cancelled) return;
        setSubmissions((current) =>
          current.map((item) =>
            item.id === submission.id ? submission : item,
          ),
        );
        setDetail((current) =>
          current?.submission.id === submission.id
            ? { ...current, submission }
            : current,
        );
      })
      .catch(() => {
        // Keep the outcome unread when acknowledgement cannot be persisted.
      });
    return () => {
      cancelled = true;
    };
  }, [detail, projectId, selectedId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadSubmissions()
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : t("sourceReviewSubmissionsLoadFailed"),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadSubmissions, t]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setError(null);
    loadDetail(selectedId).catch((cause: unknown) => {
      if (!cancelled) {
        setError(
          cause instanceof Error
            ? cause.message
            : t("sourceReviewSubmissionLoadFailed"),
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadDetail, selectedId, t]);

  const refresh = useCallback(async () => {
    await loadSubmissions();
    if (selectedId) await loadDetail(selectedId);
  }, [loadDetail, loadSubmissions, selectedId]);

  if (loading)
    return <section className={styles.empty}>{t("loading")}</section>;
  if (submissions.length === 0) {
    return (
      <section className={styles.empty}>
        {t("sourceReviewNoSubmissions")}
      </section>
    );
  }

  const selected =
    submissions.find((submission) => submission.id === selectedId) ??
    submissions[0]!;

  return (
    <section className={styles.panel}>
      <ul className={styles.submissionList}>
        {submissions.map((submission) => (
          <li key={submission.id}>
            <ButtonBase
              className={`${styles.submissionButton} ${
                submission.id === selected.id ? styles.active : ""
              }`.trimEnd()}
              onClick={() => setSelectedId(submission.id)}
            >
              <span>{submissionLabel(submission, t)}</span>
              {submission.responseRevision >
                submission.acknowledgedRevision && (
                <span
                  className={styles.unread}
                  role="img"
                  aria-label={t("sourceReviewUnread")}
                />
              )}
            </ButtonBase>
          </li>
        ))}
        {nextCursor && (
          <li>
            <Button
              variant="ghost"
              size="small"
              className={styles.loadMore}
              onClick={() => void loadSubmissions(nextCursor)}
            >
              {t("sourceReviewLoadOlder")}
            </Button>
          </li>
        )}
      </ul>

      <div className={styles.mobileSelector}>
        <Field label={t("sourceReviewSelectSubmission")}>
          <Select
            value={selected.id}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {submissions.map((submission) => (
              <option key={submission.id} value={submission.id}>
                {submissionLabel(submission, t)}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <article className={styles.detail}>
        {error && <div className={styles.error}>{error}</div>}
        {detail?.submission.id === selected.id ? (
          <SubmissionDetail
            detail={detail}
            projectId={projectId}
            sessionHref={sessionHref}
            refresh={refresh}
            t={t}
          />
        ) : (
          <div className={styles.empty}>{t("loading")}</div>
        )}
      </article>
    </section>
  );
}

function SubmissionDetail({
  detail,
  projectId,
  sessionHref,
  refresh,
  t,
}: {
  detail: ReviewSubmissionDetail;
  projectId: string;
  sessionHref: (sessionId: string) => string;
  refresh: () => Promise<void>;
  t: TranslationFn;
}) {
  const [refreshingResponse, setRefreshingResponse] = useState(false);
  const [responseNotice, setResponseNotice] = useState<string | null>(null);
  const sourceByEntry = useMemo(
    () =>
      new Map(
        detail.capturedSources.map((captured) => [
          `${captured.siteId}\0${captured.entryId}`,
          captured,
        ]),
      ),
    [detail.capturedSources],
  );
  const firstEntry = detail.sites
    .flatMap((site) => site.entries)
    .find((entry) => entry.submissionId === detail.submission.id);
  const title =
    detail.submission.name ??
    deriveReviewSubmissionName(firstEntry?.text ?? "");

  const refreshResponse = async () => {
    setRefreshingResponse(true);
    setResponseNotice(null);
    try {
      const result = await api.refreshReviewSubmissionResponse(
        projectId,
        detail.submission.id,
      );
      setResponseNotice(responseStatusLabel(result.responseStatus, t));
      notifyReviewCommentsChanged(projectId);
      await refresh();
    } catch (cause) {
      setResponseNotice(
        cause instanceof Error
          ? cause.message
          : t("sourceReviewResponseRefreshFailed"),
      );
    } finally {
      setRefreshingResponse(false);
    }
  };

  return (
    <>
      <header className={styles.detailHeader}>
        <div>
          <h2>{title}</h2>
          <div className={styles.submittedAt}>
            {submissionDate(detail.submission)}
          </div>
        </div>
        <div className={styles.detailActions}>
          <Button
            size="small"
            disabled={refreshingResponse}
            onClick={() => void refreshResponse()}
          >
            {refreshingResponse
              ? t("sourceReviewRefreshingResponse")
              : t("sourceReviewRefreshResponse")}
          </Button>
          {detail.submission.targetSessionId ? (
            <Link
              className={styles.sessionLink}
              to={sessionHref(detail.submission.targetSessionId)}
            >
              {t("sourceReviewOpenSession")}
            </Link>
          ) : (
            <span className={styles.awaitingSession}>
              {t("sourceReviewAwaitingSession")}
            </span>
          )}
        </div>
      </header>
      {responseNotice && (
        <div className={styles.responseNotice}>{responseNotice}</div>
      )}
      <ul className={styles.siteList}>
        {detail.sites.map((site) => (
          <ReviewSiteCard
            key={site.id}
            site={site}
            sourceFor={(entryId) =>
              sourceByEntry.get(`${site.id}\0${entryId}`) ?? {
                siteId: site.id,
                entryId,
                source: { status: "legacy-missing" },
                changeStatus: "unavailable",
              }
            }
            projectId={projectId}
            refresh={refresh}
            sessionHref={sessionHref}
            t={t}
          />
        ))}
      </ul>
    </>
  );
}

function ReviewSiteCard({
  site,
  sourceFor,
  projectId,
  refresh,
  sessionHref,
  t,
}: {
  site: ReviewSite;
  sourceFor: (entryId: string) => ReviewEntryCapturedSource;
  projectId: string;
  refresh: () => Promise<void>;
  sessionHref: (sessionId: string) => string;
  t: TranslationFn;
}) {
  const [followUp, setFollowUp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = site.entries.at(-1);
  const hasPending = latest?.submittedAt === undefined;
  const latestSource = latest ? sourceFor(latest.id) : null;
  const state = siteState(site, latestSource?.changeStatus ?? "unavailable");

  const addFollowUp = async () => {
    const text = followUp.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      await api.addReviewFollowUp(projectId, site.id, text);
      setFollowUp("");
      notifyReviewCommentsChanged(projectId);
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("sourceReviewFollowUpFailed"),
      );
    } finally {
      setBusy(false);
    }
  };

  const resolve = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.resolveReviewSite(projectId, site.id);
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("sourceReviewResolveFailed"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={styles.site}>
      <header className={styles.siteHeader}>
        <span className={styles.location}>{site.path}</span>
        <span className={styles.stateGroup}>
          <span className={`${styles.state} ${siteStateClass(state)}`}>
            {siteStateLabel(state, t)}
          </span>
          <span
            className={`${styles.state} ${sourceChangeClass(
              latestSource?.changeStatus ?? "unavailable",
            )}`}
          >
            {sourceChangeLabel(latestSource?.changeStatus ?? "unavailable", t)}
          </span>
        </span>
      </header>
      <ol className={styles.entryList}>
        {site.entries.map((entry) => {
          const outcomes = site.outcomes.filter(
            (outcome) => outcome.entryId === entry.id,
          );
          return (
            <li key={entry.id} className={styles.entry}>
              <div className={styles.entryHead}>
                <span>
                  {entry.submittedAt
                    ? t("sourceReviewSubmittedEntry")
                    : t("sourceReviewPendingFollowUp")}
                </span>
              </div>
              <div className={styles.commentTextRow}>
                <span
                  className={styles.commentLine}
                  title={commentLocation(entry.anchor)}
                >
                  {commentLine(entry.anchor)}
                </span>
                <div className={styles.text}>{entry.text}</div>
              </div>
              <CapturedSource source={sourceFor(entry.id).source} t={t} />
              {outcomes.map((outcome) => (
                <div key={outcome.responseHash} className={styles.outcome}>
                  <div className={styles.outcomeHead}>
                    <span>{dispositionLabel(outcome.disposition, t)}</span>
                    {outcome.sessionId && (
                      <Link to={sessionHref(outcome.sessionId)}>
                        {t("sourceReviewOutcomeSession")}
                      </Link>
                    )}
                  </div>
                  <div>{outcome.text}</div>
                </div>
              ))}
            </li>
          );
        })}
      </ol>
      {error && <div className={styles.error}>{error}</div>}
      {!hasPending && (
        <div className={styles.followUp}>
          <Textarea
            aria-label={t("sourceReviewFollowUp")}
            value={followUp}
            maxLength={20_000}
            placeholder={t("sourceReviewFollowUpPlaceholder")}
            onChange={(event) => setFollowUp(event.target.value)}
          />
          <div className={styles.siteActions}>
            {!site.resolvedAt && (
              <Button disabled={busy} onClick={() => void resolve()}>
                {t("sourceReviewResolve")}
              </Button>
            )}
            <Button
              variant="primary"
              disabled={busy || !followUp.trim()}
              onClick={() => void addFollowUp()}
            >
              {t("sourceReviewAddFollowUp")}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

function CapturedSource({
  source,
  t,
}: {
  source: ReviewCapturedSource;
  t: TranslationFn;
}) {
  if (source.status === "legacy-missing") {
    return (
      <div className={styles.captureMissing}>
        {t("sourceReviewLegacyCaptureMissing")}
      </div>
    );
  }
  if (source.status === "unavailable") {
    return (
      <div className={styles.captureMissing}>
        {captureUnavailableLabel(source.reason, t)}
      </div>
    );
  }
  return (
    <div className={styles.source}>
      <div className={styles.captureId}>
        {t("sourceReviewCapturedSource")} · {source.captureBlobId.slice(0, 12)}
      </div>
      <pre>
        {source.content.split("\n").map((line, index) => {
          const lineNumber = source.startLine + index;
          return (
            <span
              key={lineNumber}
              className={
                lineNumber === source.highlightLine ? styles.highlight : ""
              }
            >
              <span className={styles.lineNumber}>{lineNumber}</span>
              <span>{line || " "}</span>
              {"\n"}
            </span>
          );
        })}
      </pre>
    </div>
  );
}

function siteState(
  site: ReviewSite,
  changeStatus: ReviewSourceChangeStatus,
): "open" | "addressed" | "resolved" {
  if (site.resolvedAt) return "resolved";
  if (site.entries.at(-1)?.submittedAt === undefined) return "open";
  const latestSubmitted = [...site.entries]
    .reverse()
    .find((entry) => entry.submittedAt);
  return latestSubmitted &&
    (site.outcomes.some((outcome) => outcome.entryId === latestSubmitted.id) ||
      changeStatus === "changed")
    ? "addressed"
    : "open";
}

function submissionLabel(
  submission: ReviewSubmissionSummary,
  t: TranslationFn,
): string {
  return (
    submission.name ??
    t("sourceReviewSubmission", { date: submissionDate(submission) })
  );
}

function submissionDate(submission: ReviewSubmissionSummary): string {
  const timestamp = new Date(submission.submittedAt);
  return Number.isNaN(timestamp.getTime())
    ? submission.submittedAt
    : timestamp.toLocaleString();
}

function commentLocation(
  anchor: ReviewSite["entries"][number]["anchor"],
): string {
  const line = anchor.side === "old" ? anchor.oldLine : anchor.newLine;
  const oldSide = anchor.side === "old" ? " (old)" : "";
  return `${anchor.path}:${line ?? "?"}${oldSide}`;
}

function commentLine(anchor: ReviewSite["entries"][number]["anchor"]): string {
  const line = anchor.side === "old" ? anchor.oldLine : anchor.newLine;
  return String(line ?? "?");
}

function dispositionLabel(
  disposition: ReviewSite["outcomes"][number]["disposition"],
  t: TranslationFn,
): string {
  if (disposition === "wont_fix") return t("sourceReviewOutcomeNoChange");
  if (disposition === "question") return t("sourceReviewOutcomeQuestion");
  return t("sourceReviewOutcomeDone");
}

function siteStateLabel(
  state: "open" | "addressed" | "resolved",
  t: TranslationFn,
): string {
  if (state === "addressed") return t("sourceReviewStateAddressed");
  if (state === "resolved") return t("sourceReviewStateResolved");
  return t("sourceReviewStateOpen");
}

function siteStateClass(state: "open" | "addressed" | "resolved"): string {
  if (state === "addressed") return styles.addressed!;
  if (state === "resolved") return styles.resolved!;
  return styles.open!;
}

function sourceChangeLabel(
  status: ReviewSourceChangeStatus,
  t: TranslationFn,
): string {
  if (status === "changed") return t("sourceReviewSourceChanged");
  if (status === "unchanged") return t("sourceReviewSourceUnchanged");
  return t("sourceReviewSourceUnavailable");
}

function sourceChangeClass(status: ReviewSourceChangeStatus): string {
  if (status === "changed") return styles.changed!;
  if (status === "unchanged") return styles.unchanged!;
  return styles.unavailable!;
}

function responseStatusLabel(
  status: "missing" | "invalid" | "unchanged" | "ingested",
  t: TranslationFn,
): string {
  if (status === "ingested") return t("sourceReviewResponseIngested");
  if (status === "unchanged") return t("sourceReviewResponseUnchanged");
  if (status === "invalid") return t("sourceReviewResponseInvalid");
  return t("sourceReviewResponseMissing");
}

function captureUnavailableLabel(
  reason: "binary" | "too-large" | "missing",
  t: TranslationFn,
): string {
  if (reason === "binary") return t("sourceReviewCaptureUnavailableBinary");
  if (reason === "too-large") {
    return t("sourceReviewCaptureUnavailableTooLarge");
  }
  return t("sourceReviewCaptureUnavailableMissing");
}
