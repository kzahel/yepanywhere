import { useI18n } from "../i18n";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";

export type LongContextEffortWarningChoice = "apply" | "fork" | "cancel";

interface LongContextEffortWarningModalProps {
  contextTokens: number;
  currentEffortLabel: string;
  nextEffortLabel: string;
  /** Whether a fork is offered; false while the session cannot be forked. */
  canFork: boolean;
  busy: boolean;
  onChoose: (choice: LongContextEffortWarningChoice) => void;
}

/**
 * Confirmation shown before a mid-session effort change on a long-context
 * session: the provider caches the prompt per effort, so the next request
 * re-reads the whole context, and a fork at the new effort does too.
 * Contract: topics/mid-session-effort-change.md.
 */
export function LongContextEffortWarningModal({
  contextTokens,
  currentEffortLabel,
  nextEffortLabel,
  canFork,
  busy,
  onChoose,
}: LongContextEffortWarningModalProps) {
  const { t } = useI18n();
  const tokens = contextTokens.toLocaleString();
  return (
    <Modal
      title={t("longContextEffortWarningTitle")}
      onClose={() => onChoose("cancel")}
    >
      <div className="long-context-effort-warning">
        <p>
          {t("longContextEffortWarningBody", {
            tokens,
            from: currentEffortLabel,
            to: nextEffortLabel,
          })}
        </p>
        {canFork && (
          <p className="settings-hint">
            {t("longContextEffortWarningForkHint")}
          </p>
        )}
        <div className="model-switch-actions">
          <Button
            className="model-switch-action-button"
            onClick={() => onChoose("cancel")}
            disabled={busy}
          >
            {t("modalCancel")}
          </Button>
          {canFork && (
            <Button
              className="model-switch-action-button"
              onClick={() => onChoose("fork")}
              disabled={busy}
            >
              {t("longContextEffortWarningFork", { to: nextEffortLabel })}
            </Button>
          )}
          <Button
            variant="primary"
            className="model-switch-action-button"
            onClick={() => onChoose("apply")}
            disabled={busy}
          >
            {t("longContextEffortWarningApply")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
