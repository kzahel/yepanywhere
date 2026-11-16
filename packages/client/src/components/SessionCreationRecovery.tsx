import { useMemo, useState, useSyncExternalStore } from "react";
import { useI18n } from "../i18n";
import {
  forgetSessionCreation,
  parseSessionCreation,
  pendingSessionCreationPrompt,
  readSessionCreation,
  subscribeSessionCreations,
  type PendingCreation,
} from "../lib/sessionCreation";
import styles from "./SessionCreationRecovery.module.css";
import { Button } from "./ui/Button";

const PROMPT_PREVIEW_LENGTH = 120;

/**
 * The saved-request notice shared by every form that sends through
 * `acceptSessionCreation`. Start fresh is always offered beside the check: a
 * request that can no longer be confirmed must not keep the form from sending
 * independent work.
 */
export function SessionCreationRecovery({
  storageKey,
  hidden = false,
  className,
  checkLabel,
  onCheck,
  onStartFresh,
}: {
  storageKey: string;
  /** True while the form is sending: its own request is not a recovery. */
  hidden?: boolean;
  /** Placement in the owning form; the notice owns its look. */
  className?: string;
  checkLabel: string;
  /** Opens the saved session. A rejection is shown as the reason it could not. */
  onCheck: (pending: PendingCreation) => Promise<void>;
  /** Called after the saved record is forgotten; nothing is resent. */
  onStartFresh: (pending: PendingCreation) => void;
}) {
  const { t } = useI18n();
  const saved = useSyncExternalStore(subscribeSessionCreations, () =>
    readSessionCreation(storageKey),
  );
  const pending = useMemo(() => parseSessionCreation(saved), [saved]);
  const [failure, setFailure] = useState<{
    requestId: string;
    message: string;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  if (!pending || hidden) return null;
  const prompt = pendingSessionCreationPrompt(pending).trim();
  return (
    <div
      role="status"
      className={
        className ? `${styles.recovery} ${className}` : styles.recovery
      }
    >
      <span>
        {t(
          pending.receipt
            ? "sessionCreationSavedWhileAway"
            : "sessionCreationUnconfirmedRequest",
        )}
      </span>
      <span className={styles.detail}>
        {t("sessionCreationEarlierRequest", {
          time: new Date(pending.clientTimestamp).toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          }),
        })}
        {prompt &&
          ` “${prompt.length > PROMPT_PREVIEW_LENGTH ? `${prompt.slice(0, PROMPT_PREVIEW_LENGTH)}…` : prompt}”`}
      </span>
      {failure?.requestId === pending.requestId && (
        <span className={styles.failure}>{failure.message}</span>
      )}
      <div className={styles.actions}>
        <Button
          disabled={checking}
          onClick={async () => {
            setChecking(true);
            setFailure(null);
            try {
              await onCheck(pending);
            } catch (error) {
              const status = (error as { status?: number } | null)?.status;
              setFailure({
                requestId: pending.requestId,
                message:
                  status === 404
                    ? t("sessionCreationNotFound")
                    : status === 410
                      ? t("sessionCreationDeleted")
                      : t("sessionCreationCheckFailed", {
                          error:
                            error instanceof Error
                              ? error.message
                              : String(error),
                        }),
              });
            } finally {
              setChecking(false);
            }
          }}
        >
          {checkLabel}
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            forgetSessionCreation(storageKey);
            onStartFresh(pending);
          }}
        >
          {t("sessionCreationStartFresh")}
        </Button>
      </div>
    </div>
  );
}
