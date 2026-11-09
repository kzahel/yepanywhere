/**
 * HostOfflineModal - Shows when auto-resume fails because host is unreachable.
 *
 * Displays a user-friendly error when the remote host cannot be reached during
 * session resumption, with options to retry or go to the login page.
 */

import {
  canRetryResume,
  requiresResumeLogin,
} from "../lib/connection/remoteErrors";
import type {
  AutoResumeError,
  AutoResumeErrorReason,
} from "../contexts/RemoteConnectionContext";
import { useI18n } from "../i18n";
import styles from "./HostOfflineModal.module.css";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";

type Translate = ReturnType<typeof useI18n>["t"];

interface HostOfflineModalProps {
  error: AutoResumeError;
  onDismiss: () => void;
  onRetry: () => void;
  onGoToLogin: () => void;
}

function getErrorTitle(reason: AutoResumeErrorReason, t: Translate): string {
  switch (reason) {
    case "auth_failed":
      return t("hostOfflineTitleResumeRejected");
    case "resume_timeout":
      return t("hostOfflineTitleResumeTimeout");
    case "resume_verification":
      return t("hostOfflineTitleResumeVerification");
    case "server_offline":
      return t("hostOfflineTitleServerOffline");
    case "unknown_username":
      return t("hostOfflineTitleUnknownUsername");
    case "relay_timeout":
      return t("hostOfflineTitleRelayTimeout");
    case "relay_unreachable":
      return t("hostOfflineTitleRelayUnreachable");
    case "direct_unreachable":
      return t("hostOfflineTitleDirectUnreachable");
    case "resume_incompatible":
      return t("hostOfflineTitleResumeIncompatible");
    default:
      return t("hostOfflineTitleDefault");
  }
}

function getErrorMessage(error: AutoResumeError, t: Translate): string {
  const { reason, mode, relayUsername } = error;

  switch (reason) {
    case "auth_failed":
      return t("hostOfflineMessageResumeRejected");
    case "resume_timeout":
      return t("hostOfflineMessageResumeTimeout");
    case "resume_verification":
      return t("hostOfflineMessageResumeVerification");
    case "server_offline":
      return relayUsername
        ? t("hostOfflineMessageServerOfflineNamed", { relayUsername })
        : t("hostOfflineMessageServerOffline");

    case "unknown_username":
      return relayUsername
        ? t("hostOfflineMessageUnknownUsernameNamed", { relayUsername })
        : t("hostOfflineMessageUnknownUsername");

    case "relay_timeout":
      return relayUsername
        ? t("hostOfflineMessageRelayTimeoutNamed", { relayUsername })
        : t("hostOfflineMessageRelayTimeout");

    case "relay_unreachable":
      return t("hostOfflineMessageRelayUnreachable");

    case "direct_unreachable":
      return mode === "direct"
        ? t("hostOfflineMessageDirectUnreachableDirect")
        : t("hostOfflineMessageDirectUnreachable");

    case "resume_incompatible":
      return t("hostOfflineMessageResumeIncompatible");

    default:
      return t("hostOfflineMessageDefault");
  }
}

export function HostOfflineModal({
  error,
  onDismiss,
  onRetry,
  onGoToLogin,
}: HostOfflineModalProps) {
  const { t } = useI18n();
  const title = getErrorTitle(error.reason, t);
  const message = getErrorMessage(error, t);

  return (
    <Dialog
      title={title}
      description={message}
      size="medium"
      onClose={onDismiss}
      footer={
        <>
          <Button onClick={onGoToLogin}>{t("hostOfflineGoToLogin")}</Button>
          {canRetryResume(error.reason) && (
            <Button variant="primary" onClick={onRetry}>
              {t("hostOfflineRetry")}
            </Button>
          )}
        </>
      }
    >
      {(requiresResumeLogin(error.reason) ||
        error.reason === "resume_verification") && (
        <p className={styles.detail}>{error.message}</p>
      )}

      {error.relayUsername && (
        <p className={styles.detail}>
          <strong>{t("relayLoginServerName")}:</strong> {error.relayUsername}
        </p>
      )}

      {error.serverUrl && (
        <p className={styles.detail}>
          <strong>{t("relayLoginCustomRelayUrl")}:</strong> {error.serverUrl}
        </p>
      )}

      <p className={styles.hint}>
        {error.reason === "auth_failed"
          ? t("hostOfflineHintResumeRejected")
          : error.reason === "resume_incompatible"
            ? t("hostOfflineHintResumeIncompatible")
            : error.reason === "resume_verification"
              ? t("hostOfflineHintResumeVerification")
              : error.mode === "relay"
                ? t("hostOfflineHintRelay")
                : t("hostOfflineHintDirect")}
      </p>
    </Dialog>
  );
}
