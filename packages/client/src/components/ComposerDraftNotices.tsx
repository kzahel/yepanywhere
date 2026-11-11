import { useI18n } from "../i18n";
import styles from "./MessageInput.module.css";

export function ForkSummaryDraftNotice({
  mode,
}: {
  mode: { title: string; description: string; onCancel: () => void };
}) {
  const { t } = useI18n();
  return (
    <div className={styles.forkSummaryDraft}>
      <div className={styles.forkSummaryDraftCopy}>
        <span className={styles.forkSummaryDraftLabel}>{mode.title}</span>
        <span className={styles.forkSummaryDraftDescription}>
          {mode.description}
        </span>
      </div>
      <button
        type="button"
        className={styles.forkSummaryDraftCancel}
        onClick={mode.onCancel}
        aria-label={t("forkSummaryCancel")}
        title={t("forkSummaryCancel")}
      >
        ×
      </button>
    </div>
  );
}

export function ComposerPromptSuggestion({
  suggestion,
  onAccept,
  onDismiss,
}: {
  suggestion: string;
  onAccept: () => void;
  onDismiss?: () => void;
}) {
  return (
    <div className={styles.promptSuggestion}>
      <button
        type="button"
        className={styles.promptSuggestionText}
        onClick={onAccept}
        title="Send this suggestion"
      >
        {suggestion}
      </button>
      <button
        type="button"
        className={styles.promptSuggestionDismiss}
        onClick={onDismiss}
        aria-label="Dismiss suggestion"
        title="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
