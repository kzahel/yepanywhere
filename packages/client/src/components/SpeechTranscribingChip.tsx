import { useI18n } from "../i18n";
import { IconButton } from "./ui/Button";
import { Spinner } from "./ui/Spinner";
import type { SpeechPendingKind } from "./VoiceInputButton";

interface Props {
  /** Which post-capture wait this is: a batch transcribe or a streaming flush. */
  kind: SpeechPendingKind;
  /** Cancel the in-flight speech. A late result must become a no-op. */
  onCancel: () => void;
}

/**
 * Sibling status chip shown while speech is in progress and cancellable —
 * active capture (`listening`), a batch transcription (`transcribing`), or a
 * streaming flush (`finalizing`). The pending speech is never characters in the
 * textarea value, so no keystroke or backspace can disturb it; the explicit ✕
 * is the only pointer way to abandon it. Cancel keeps already-committed text and
 * drops only the in-progress portion.
 * See topics/mic-button-speech-ui.md (Batch Behavior, Cancel contract).
 */
export function SpeechTranscribingChip({ kind, onCancel }: Props) {
  const { t } = useI18n();
  const label =
    kind === "listening"
      ? t("speechListeningPlaceholder" as never)
      : kind === "finalizing"
        ? t("speechFinalizingPlaceholder" as never)
        : t("speechTranscribingPlaceholder" as never);
  return (
    <div className="speech-transcribing-chip" role="status" aria-live="polite">
      <Spinner size="small" />
      <span className="speech-transcribing-label">{label}</span>
      <IconButton
        size="small"
        label={t("speechTranscribingCancel" as never)}
        className="speech-transcribing-cancel"
        onClick={onCancel}
      >
        ×
      </IconButton>
    </div>
  );
}
