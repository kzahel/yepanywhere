import { useMemo } from "react";
import type { VersionInfo } from "../api/client";
import { useRemoteCompatibilityNoticeDismissals } from "../hooks/useRemoteCompatibilityNoticeDismissals";
import {
  type RemoteCompatibilityNotice,
  type RemoteCompatibilityInput,
  type RemoteNoticeSeverity,
  getRemoteCompatibilityNotices,
} from "../lib/remoteCompatibilityNotices";
import { Button, buttonClassName } from "./ui/Button";
import { CopyTextButton } from "./ui/CopyTextButton";
import styles from "./RemoteCompatibilityNotices.module.css";

const placementClassNames: Record<
  RemoteCompatibilityNoticeCardProps["placement"],
  string
> = {
  floating: styles.floating!,
  inline: styles.inline!,
};

const severityClassNames: Record<RemoteNoticeSeverity, string | undefined> = {
  info: undefined,
  recommended: undefined,
  security: styles.critical!,
  blocking: styles.critical!,
};

interface RemoteCompatibilityNoticesProps {
  runtimeNotice?: RemoteCompatibilityInput["runtimeNotice"];
  versionInfo: VersionInfo | null;
  relayUsername: string | null;
  installId?: string | null;
}

export function RemoteCompatibilityNotices({
  runtimeNotice,
  versionInfo,
  relayUsername,
  installId,
}: RemoteCompatibilityNoticesProps) {
  const notices = useMemo(() => {
    if (!versionInfo) return [];

    return getRemoteCompatibilityNotices({
      runtimeNotice,
      currentVersion: versionInfo?.current ?? null,
      latestVersion: versionInfo?.latest ?? null,
      updateAvailable: versionInfo?.updateAvailable ?? false,
      installSource: versionInfo?.installSource,
      desktopRuntime: versionInfo?.desktopRuntime,
      resumeProtocolVersion: versionInfo?.resumeProtocolVersion,
      remoteCompatibilityLevel: versionInfo?.remoteCompatibilityLevel,
      capabilities: versionInfo?.capabilities,
      relayUsername,
      installId,
    });
  }, [installId, relayUsername, versionInfo, runtimeNotice]);
  const { dismissNotice, snoozeNotice, visibleNotices } =
    useRemoteCompatibilityNoticeDismissals(notices);

  const notice = visibleNotices[0];
  if (!notice) return null;

  return (
    <RemoteCompatibilityNoticeCard
      notice={notice}
      noticeCount={visibleNotices.length}
      placement="floating"
      onDismiss={() => dismissNotice(notice)}
      onSnooze={() => snoozeNotice(notice)}
    />
  );
}

interface RemoteCompatibilityNoticeCardProps {
  notice: RemoteCompatibilityNotice;
  noticeCount?: number;
  placement: "floating" | "inline";
  onDismiss?: () => void;
  onRestore?: () => void;
  onSnooze?: () => void;
}

export function RemoteCompatibilityNoticeCard({
  notice,
  noticeCount = 1,
  placement,
  onDismiss,
  onRestore,
  onSnooze,
}: RemoteCompatibilityNoticeCardProps) {
  const action = notice.action;
  const commandField = action?.command
    ? {
        command: action.command,
        label: action.label,
        lines: action.command.split("\n").length,
      }
    : null;

  return (
    <section
      className={[
        styles.root!,
        placementClassNames[placement],
        placement === "floating" &&
          notice.floatingPlacement === "below-header" &&
          styles.belowHeader,
        severityClassNames[notice.severity],
      ]
        .filter(Boolean)
        .join(" ")}
      role={
        notice.severity === "security" || notice.severity === "blocking"
          ? "alert"
          : "status"
      }
      data-testid="remote-compatibility-notice"
    >
      <div className={styles.content!}>
        <div className={styles.headline!}>
          <strong className={styles.title!}>{notice.title}</strong>
          {notice.versionSummary && (
            <span className={styles.meta!}>{notice.versionSummary}</span>
          )}
          {noticeCount > 1 && (
            <span className={styles.count!}>{noticeCount} notices</span>
          )}
        </div>
        <span className={styles.body!}>{notice.body}</span>
        {notice.guidance && (
          <span className={styles.guidance!}>{notice.guidance}</span>
        )}
        {commandField && (
          <div className={styles.commandField!}>
            {commandField.lines > 1 ? (
              <textarea
                className={`${styles.commandInput!} ${styles.commandInputMulti!}`}
                value={commandField.command}
                readOnly
                rows={Math.min(commandField.lines, 4)}
                aria-label={`${commandField.label} text`}
                onFocus={(event) => event.currentTarget.select()}
              />
            ) : (
              <input
                className={styles.commandInput!}
                value={commandField.command}
                readOnly
                aria-label={`${commandField.label} text`}
                onFocus={(event) => event.currentTarget.select()}
              />
            )}
            <CopyTextButton
              text={commandField.command}
              label={commandField.label}
              copiedLabel="Copied"
              className={styles.copyButton!}
              copiedClassName={styles.copied!}
            />
          </div>
        )}
      </div>
      <div className={styles.actions!}>
        {notice.action?.href && (
          <a
            className={buttonClassName({ variant: "primary", size: "small" })}
            href={notice.action.href}
          >
            {notice.action.label}
          </a>
        )}
        {onRestore && (
          <Button variant="primary" size="small" onClick={onRestore}>
            Show reminder
          </Button>
        )}
        {onDismiss && notice.dismissal === "dismiss" && (
          <Button size="small" onClick={onDismiss}>
            Dismiss
          </Button>
        )}
        {onSnooze && notice.severity !== "info" && (
          <Button size="small" onClick={onSnooze}>
            Remind me later
          </Button>
        )}
      </div>
    </section>
  );
}
