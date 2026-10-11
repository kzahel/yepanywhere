import type {
  ReviewComment,
  ReviewCommentAnchor,
  ReviewNewSessionOptions,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useSourceReviewDefaultSession } from "../contexts/SourceReviewDefaultSessionContext";
import {
  notifyReviewCommentsChanged,
  subscribeReviewComments,
} from "../lib/reviewCommentsBus";
import { generateUUID } from "../lib/uuid";
import { useRemoteBasePath } from "./useRemoteBasePath";

export type SubmitNowOutcome = "navigated" | "queued" | "error";

/**
 * Shared review-draft actions for the diff and blame comment surfaces (topic:
 * source-review-to-session). Tracks this file's pending comments (for the
 * tint), "add to review" (persist a pending draft), and "submit now" (drain one
 * comment into the tab's default session or a fresh session and navigate).
 * Extracted so the two comment layers never duplicate the
 * add/submit/navigate logic — the anchor is the only thing each surface builds
 * differently.
 */
export function useReviewCommentDraft(
  projectId: string,
  filePath: string,
  submissionsEnabled = false,
) {
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();
  const defaultSession = useSourceReviewDefaultSession();
  const [pending, setPending] = useState<ReviewComment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const immediateAttemptRef = useRef<{
    key: string;
    commentId: string;
    submissionId: string;
  } | null>(null);

  const refreshPending = useCallback(async () => {
    try {
      const result = await api.listReviewComments(projectId);
      setPending(
        result.comments.filter(
          (comment) =>
            comment.status === "pending" && comment.anchor.path === filePath,
        ),
      );
    } catch {
      // Tint is best-effort; a failed load just means no tint.
    }
  }, [projectId, filePath]);

  // Refresh on mount and whenever any surface mutates the accumulator (a
  // tray submit, a Comments-tab delete), so this file's tint never goes stale.
  useEffect(() => {
    void refreshPending();
    return subscribeReviewComments(projectId, () => {
      void refreshPending();
    });
  }, [projectId, refreshPending]);

  const addToReview = useCallback(
    async (anchor: ReviewCommentAnchor, text: string): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        const { comment } = await api.addReviewComment(projectId, anchor, text);
        setPending((prev) => [...prev, comment]);
        notifyReviewCommentsChanged(projectId);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to add comment");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [projectId],
  );

  const submitNow = useCallback(
    async (
      anchor: ReviewCommentAnchor,
      text: string,
      target: "new" | string,
      queuedMessage: string,
      newSession?: ReviewNewSessionOptions,
    ): Promise<SubmitNowOutcome> => {
      setBusy(true);
      setError(null);
      try {
        const attemptKey = JSON.stringify({ anchor, text, target });
        const prior =
          submissionsEnabled && immediateAttemptRef.current?.key === attemptKey
            ? immediateAttemptRef.current
            : null;
        const commentId = prior
          ? prior.commentId
          : (await api.addReviewComment(projectId, anchor, text)).comment.id;
        const submissionId = prior?.submissionId ?? generateUUID();
        if (submissionsEnabled && !prior) {
          immediateAttemptRef.current = {
            key: attemptKey,
            commentId,
            submissionId,
          };
        }
        const submission = submissionsEnabled
          ? { id: submissionId }
          : undefined;
        const result = submission
          ? await api.submitReview(
              projectId,
              [commentId],
              target,
              target === "new" ? newSession : undefined,
              submission,
            )
          : target === "new" && newSession
            ? await api.submitReview(projectId, [commentId], target, newSession)
            : await api.submitReview(projectId, [commentId], target);
        notifyReviewCommentsChanged(projectId);
        if (result.sessionId) {
          immediateAttemptRef.current = null;
          navigate(
            `${basePath}/projects/${projectId}/sessions/${result.sessionId}`,
          );
          return "navigated";
        }
        if (submissionsEnabled) immediateAttemptRef.current = null;
        setError(queuedMessage);
        void refreshPending();
        return "queued";
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to submit");
        return "error";
      } finally {
        setBusy(false);
      }
    },
    [projectId, navigate, basePath, refreshPending, submissionsEnabled],
  );

  return {
    pending,
    defaultSession,
    busy,
    error,
    setError,
    refreshPending,
    addToReview,
    submitNow,
  };
}
