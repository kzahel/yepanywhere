import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useToastContext } from "../contexts/ToastContext";
import { useI18n } from "../i18n";
import type { LastComposerSubmission } from "../lib/composerRecall";
import {
  type ComposerAttachment,
  revokeAttachmentPreviewUrls,
} from "../lib/sessionComposerAttachments";
import type { DeferredMessage } from "./useSession";
import type { useSessionComposerAttachments } from "./useSessionComposerAttachments";
import type { DraftControls } from "./useDraftPersistence";

type ComposerAttachments = ReturnType<typeof useSessionComposerAttachments>;

/**
 * One session page's correction draft: correcting the latest message from
 * its Edit action or by recalling the last submission, the draft and
 * attachments set aside while correcting, and Cancel, which brings them
 * back. Moved verbatim from `SessionPage.tsx`
 * (docs/tactical/187-session-page-draft-hooks.md slice 2).
 */
export function useSessionCorrectionDraft({
  attachmentsRef,
  deferredMessages,
  draftControlsRef,
  isDomLingerParked,
  lastComposerSubmissionRef,
  sessionId,
  setComposerAttachments,
}: {
  attachmentsRef: ComposerAttachments["attachmentsRef"];
  deferredMessages: DeferredMessage[];
  draftControlsRef: RefObject<DraftControls | null>;
  isDomLingerParked: boolean;
  lastComposerSubmissionRef: RefObject<LastComposerSubmission | null>;
  sessionId: string;
  setComposerAttachments: ComposerAttachments["setComposerAttachments"];
}) {
  const { t } = useI18n();
  const { showToast } = useToastContext();
  const [correctionDraft, setCorrectionDraft] = useState<{
    messageId: string;
    originalText: string;
    recalled?: boolean;
  } | null>(null);
  const preCorrectionDraftRef = useRef<{
    text: string;
    attachments: ComposerAttachment[];
  } | null>(null);

  useEffect(() => {
    return () => {
      revokeAttachmentPreviewUrls(
        preCorrectionDraftRef.current?.attachments ?? [],
      );
    };
  }, []);

  useEffect(() => {
    void sessionId;
    setCorrectionDraft(null);
  }, [sessionId]);

  const handleCancelCorrection = useCallback(() => {
    const previous = preCorrectionDraftRef.current;
    preCorrectionDraftRef.current = null;
    setCorrectionDraft(null);
    draftControlsRef.current?.setDraft(previous?.text ?? "");
    setComposerAttachments(previous?.attachments ?? [], {
      revokeRemovedPreviewUrls: true,
    });
  }, [setComposerAttachments, draftControlsRef]);

  useEffect(() => {
    if (!correctionDraft && preCorrectionDraftRef.current) {
      revokeAttachmentPreviewUrls(preCorrectionDraftRef.current.attachments);
      preCorrectionDraftRef.current = null;
    }
  }, [correctionDraft]);

  useEffect(() => {
    if (
      isDomLingerParked &&
      correctionDraft?.recalled &&
      draftControlsRef.current?.getDraft() === correctionDraft.originalText &&
      attachmentsRef.current.length === 0
    ) {
      handleCancelCorrection();
    }
  }, [
    isDomLingerParked,
    correctionDraft,
    handleCancelCorrection,
    draftControlsRef,
    attachmentsRef,
  ]);

  // Opens a correction with `text` in the composer. The first correction
  // sets the draft and its attachments aside for Cancel, keeping their
  // previews. A later one, while a correction is open, keeps that draft
  // and discards the composer's attachments, so it revokes their previews.
  const beginCorrection = useCallback(
    (
      draftControls: DraftControls,
      correction: { messageId: string; originalText: string; recalled?: true },
    ) => {
      const keepsEarlierDraft = preCorrectionDraftRef.current !== null;
      preCorrectionDraftRef.current ??= {
        text: draftControls.getDraft(),
        attachments: [...attachmentsRef.current],
      };
      draftControls.setDraft(correction.originalText);
      setComposerAttachments([], {
        revokeRemovedPreviewUrls: keepsEarlierDraft,
      });
      setCorrectionDraft(correction);
    },
    [setComposerAttachments, attachmentsRef],
  );

  const handleCorrectLatestUserMessage = useCallback(
    (messageId: string, content: string) => {
      const draftControls = draftControlsRef.current;
      if (!draftControls) {
        showToast(
          t("sessionCorrectionEditFailed", {
            message: "Composer is not available",
          }),
          "error",
        );
        return;
      }

      beginCorrection(draftControls, { messageId, originalText: content });
    },
    [beginCorrection, showToast, t, draftControlsRef],
  );

  const handleRecallLastSubmission = useCallback((): boolean => {
    const lastSubmission = lastComposerSubmissionRef.current;
    if (!lastSubmission?.text.trim()) {
      return false;
    }

    const draftControls = draftControlsRef.current;
    if (!draftControls) {
      return false;
    }

    // A still-queued message is left alone. Submitting leaves focus in the
    // empty composer, so ↑ meant to scroll would otherwise unqueue it; the
    // chip's Edit and cancel controls are the explicit ways to change it
    // (topics/queued-messages.md).
    if (
      lastSubmission.kind === "queued" &&
      deferredMessages.some(
        (message) => message.tempId === lastSubmission.tempId,
      )
    ) {
      return false;
    }

    beginCorrection(draftControls, {
      messageId:
        lastSubmission.kind === "sent"
          ? lastSubmission.id
          : lastSubmission.tempId,
      originalText: lastSubmission.text,
      recalled: true,
    });
    return true;
  }, [
    beginCorrection,
    deferredMessages,
    lastComposerSubmissionRef,
    draftControlsRef,
  ]);

  return {
    correctionDraft,
    setCorrectionDraft,
    handleCancelCorrection,
    handleCorrectLatestUserMessage,
    handleRecallLastSubmission,
  };
}
