import {
  type FocusEventHandler,
  type KeyboardEventHandler,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { SessionHoverCardTarget } from "../components/SessionHoverCardTarget";
import { Banner } from "../components/ui/Banner";
import { Button } from "../components/ui/Button";
import { Field, Select, Textarea } from "../components/ui/Field";
import type { SourceReviewDefaultSession } from "../contexts/SourceReviewDefaultSessionContext";
import { useProjectReviewSessions } from "../hooks/useProjectReviewSessions";
import type { TranslationFn } from "../i18n";
import { reviewSessionLabel } from "../lib/reviewSessions";
import styles from "./ReviewCommentWindow.module.css";

/**
 * The in-place comment popover shared by the diff and blame comment surfaces
 * (topic: source-review-to-session). It renders the clicked line's anchor
 * label + snippet and offers "Add to review" (persist a pending draft) and
 * a recent-session destination picker (drain that one comment immediately).
 * The caller supplies the anchor and owns the review-draft actions (see
 * `useReviewCommentDraft`).
 */
export function ReviewCommentWindow({
  projectId,
  anchorLabel,
  snippet,
  busy,
  error,
  onCancel,
  onAddToReview,
  defaultSession,
  onSubmit,
  t,
}: {
  projectId: string;
  anchorLabel: string;
  snippet: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onAddToReview: (text: string) => void;
  defaultSession: SourceReviewDefaultSession | null;
  onSubmit: (text: string, target: "new" | string) => void;
  t: TranslationFn;
}) {
  const [text, setText] = useState("");
  const { sessions, error: sessionsError } =
    useProjectReviewSessions(projectId);
  const [targetSessionId, setTargetSessionId] = useState(
    defaultSession?.id ?? "new",
  );
  const targetTouchedRef = useRef(false);
  const canSubmit = text.trim().length > 0 && !busy;

  useEffect(() => {
    if (!sessions || defaultSession || targetTouchedRef.current) return;
    setTargetSessionId(sessions[0]?.id ?? "new");
  }, [defaultSession, sessions]);

  const selectedSession =
    sessions?.find((session) => session.id === targetSessionId) ?? null;
  const submitButton = (
    <Button
      variant="primary"
      onClick={() => onSubmit(text, targetSessionId)}
      disabled={!canSubmit}
    >
      {t("sourceReviewSubmitComment")}
    </Button>
  );

  return (
    <ReviewCommentEditor
      anchorLabel={anchorLabel}
      snippet={snippet}
      text={text}
      placeholder={t("sourceReviewCommentPlaceholder")}
      error={error}
      onChange={setText}
      actions={
        <>
          {/* review-comment-window-cancel and -add stay literal: no stylesheet
            declares them, so they are DOM hooks this module does not own. */}
          <Button onClick={onCancel} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button onClick={() => onAddToReview(text)} disabled={!canSubmit}>
            {t("sourceReviewAddToReview")}
          </Button>
          <div className={styles.submitActions}>
            <Field
              label={t("sourceReviewTargetLegend")}
              className={styles.destination}
              error={
                sessionsError ? t("sourceReviewSessionsUnavailable") : undefined
              }
            >
              <Select
                value={targetSessionId}
                onChange={(event) => {
                  targetTouchedRef.current = true;
                  setTargetSessionId(event.target.value);
                }}
              >
                <option value="new">{t("sourceReviewTargetNew")}</option>
                {defaultSession &&
                  !sessions?.some(
                    (session) => session.id === defaultSession.id,
                  ) && (
                    <option value={defaultSession.id}>
                      {defaultSession.title} ·{" "}
                      {defaultSession.newSession.provider}
                      {defaultSession.newSession.model
                        ? `/${defaultSession.newSession.model}`
                        : ""}{" "}
                      · {t("sourceReviewCurrentSuffix")}
                    </option>
                  )}
                {sessions?.map((session) => (
                  <option key={session.id} value={session.id}>
                    {reviewSessionLabel(
                      session,
                      session.id === defaultSession?.id
                        ? t("sourceReviewCurrentSuffix")
                        : undefined,
                    )}
                  </option>
                ))}
              </Select>
            </Field>
            {defaultSession && targetSessionId === defaultSession.id ? (
              <SessionHoverCardTarget
                sessionId={defaultSession.id}
                fallback={{
                  projectId: defaultSession.projectId,
                  title: defaultSession.title,
                  provider: defaultSession.newSession.provider,
                  model: defaultSession.newSession.model,
                }}
                className={styles.defaultSessionTarget}
              >
                {submitButton}
              </SessionHoverCardTarget>
            ) : selectedSession ? (
              <SessionHoverCardTarget
                sessionId={selectedSession.id}
                fallback={{
                  projectId: selectedSession.projectId,
                  title:
                    selectedSession.customTitle ||
                    selectedSession.title ||
                    selectedSession.id.slice(0, 8),
                  provider: selectedSession.provider,
                  model: selectedSession.model,
                }}
                className={styles.defaultSessionTarget}
              >
                {submitButton}
              </SessionHoverCardTarget>
            ) : (
              submitButton
            )}
          </div>
        </>
      }
    />
  );
}

/** Shared inline editor shell for Source Control and session file comments. */
export function ReviewCommentEditor({
  anchorLabel,
  snippet,
  text,
  placeholder,
  autoFocus = true,
  error,
  onChange,
  onBlur,
  onKeyDown,
  actions,
}: {
  anchorLabel: string;
  snippet: string;
  text: string;
  placeholder: string;
  autoFocus?: boolean;
  error?: string | null;
  onChange: (text: string) => void;
  onBlur?: FocusEventHandler<HTMLTextAreaElement>;
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
  actions: ReactNode;
}) {
  return (
    <div className={styles.window} data-markdown-copy-ignore="true">
      <div className={styles.anchor}>{anchorLabel}</div>
      <pre className={styles.snippet}>{snippet}</pre>
      <Textarea
        // autoFocus: the window opens on an explicit click; selection-opened editors opt out to preserve selection actions
        autoFocus={autoFocus}
        rows={3}
        value={text}
        placeholder={placeholder}
        onBlur={onBlur}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {error && <Banner tone="error">{error}</Banner>}
      <div className={styles.actions}>{actions}</div>
    </div>
  );
}
