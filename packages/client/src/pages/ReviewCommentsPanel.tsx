import type { ReviewComment } from "@yep-anywhere/shared";
import { useState } from "react";
import { api } from "../api/client";
import { Banner } from "../components/ui/Banner";
import { Button } from "../components/ui/Button";
import { Textarea } from "../components/ui/Field";
import { notifyReviewCommentsChanged } from "../lib/reviewCommentsBus";
import type { TranslationFn } from "../i18n";
import styles from "./ReviewCommentsPanel.module.css";

/**
 * The pending-review list (topic: source-review-to-session, stage 2): every
 * not-yet-submitted comment across files and revisions, with its anchor
 * location, revision, and text. A mode of the source-control surface beside
 * changes/commits/files — it reads the same server-owned accumulator, deletes
 * through the same routes, and hands off to the same submit modal, so it can
 * never drift from what a submit would drain. Deletion is two-click (the
 * button becomes a confirm) since a draft can hold real writing.
 */
export function ReviewCommentsPanel({
  projectId,
  pending,
  onOpenFile,
  onSubmit,
  t,
}: {
  projectId: string;
  pending: ReviewComment[];
  /** Jump to the file's blame view (the files tab seeded with this path). */
  onOpenFile: (path: string) => void;
  /** Open the submit-review modal (the same one as the tray button). */
  onSubmit: () => void;
  t: TranslationFn;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async (id: string) => {
    if (confirmId !== id) {
      setConfirmId(id);
      return;
    }
    setBusyId(id);
    setError(null);
    try {
      await api.deleteReviewComment(projectId, id);
      notifyReviewCommentsChanged(projectId);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("sourceReviewDeleteFailed"),
      );
    } finally {
      setBusyId(null);
      setConfirmId(null);
    }
  };

  const handleSave = async (id: string) => {
    const text = editText.trim();
    if (!text) return;
    setBusyId(id);
    setError(null);
    try {
      await api.updateReviewComment(projectId, id, { text });
      notifyReviewCommentsChanged(projectId);
      setEditId(null);
      setEditText("");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("sourceReviewEditFailed"),
      );
    } finally {
      setBusyId(null);
    }
  };

  if (pending.length === 0) {
    return (
      <section className={styles.panel}>
        <div className={styles.empty}>
          <div>{t("sourceReviewNoPending")}</div>
          <div className={styles.hint}>{t("sourceReviewCommentsHint")}</div>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.panel}>
      {error && <Banner tone="error">{error}</Banner>}
      <ul className={styles.list}>
        {pending.map((comment) => (
          <li key={comment.id} className={styles.row}>
            <div className={styles.rowHead}>
              <Button
                variant="link"
                textFlow="wrap"
                mono
                className={styles.location}
                title={t("sourceReviewOpenInFiles")}
                onClick={() => onOpenFile(comment.anchor.path)}
              >
                {commentLocation(comment)}
              </Button>
              <span className={styles.revision}>
                {revisionLabel(comment, t)}
              </span>
              <div className={styles.rowActions}>
                <Button
                  size="small"
                  disabled={busyId === comment.id}
                  onClick={() => {
                    setEditId(comment.id);
                    setEditText(comment.text);
                    setConfirmId(null);
                  }}
                >
                  {t("sourceReviewEdit")}
                </Button>
                <Button
                  variant="danger-outline"
                  size="small"
                  disabled={busyId === comment.id}
                  onClick={() => void handleDelete(comment.id)}
                >
                  {confirmId === comment.id
                    ? t("sourceReviewDeleteConfirm")
                    : t("sourceReviewDelete")}
                </Button>
              </div>
            </div>
            {editId === comment.id ? (
              <div className={styles.editor}>
                <Textarea
                  aria-label={t("sourceReviewEditComment")}
                  rows={4}
                  value={editText}
                  maxLength={20_000}
                  onChange={(event) => setEditText(event.target.value)}
                />
                <div className={styles.editorActions}>
                  <Button
                    onClick={() => {
                      setEditId(null);
                      setEditText("");
                    }}
                  >
                    {t("cancel")}
                  </Button>
                  <Button
                    variant="primary"
                    disabled={busyId === comment.id || !editText.trim()}
                    onClick={() => void handleSave(comment.id)}
                  >
                    {t("sourceReviewSaveEdit")}
                  </Button>
                </div>
              </div>
            ) : (
              <div className={styles.text}>{comment.text}</div>
            )}
          </li>
        ))}
      </ul>
      <div className={styles.actions}>
        <Button variant="primary" onClick={onSubmit}>
          {t("sourceReviewOpenSubmit")}
        </Button>
      </div>
    </section>
  );
}

function commentLocation(comment: ReviewComment): string {
  const { anchor } = comment;
  const line = anchor.side === "old" ? anchor.oldLine : anchor.newLine;
  const oldSide = anchor.side === "old" ? " (old)" : "";
  return `${anchor.path}:${line ?? "?"}${oldSide}`;
}

function revisionLabel(comment: ReviewComment, t: TranslationFn): string {
  const { revision } = comment.anchor;
  return revision.kind === "sha"
    ? revision.sha.slice(0, 7)
    : t("sourceBlameNotCommitted");
}
