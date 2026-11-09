import { useMemo } from "react";
import type { VersionInfo } from "../api/client";
import { useRemoteCompatibilityNoticeDismissals } from "../hooks/useRemoteCompatibilityNoticeDismissals";
import {
  type RemoteCompatibilityNotice,
  type RemoteCompatibilityInput,
  type RemoteNoticeSeverity,
  getRemoteCompatibilityNotices,
} from "../lib/remoteCompatibilityNotices";
import { Badge } from "./ui/Badge";
import { Banner, type BannerTone } from "./ui/Banner";
import { Button, buttonClassName } from "./ui/Button";
import { CopyTextButton } from "./ui/CopyTextButton";
import { Textarea, TextInput } from "./ui/Field";
import styles from "./RemoteCompatibilityNotices.module.css";

const placementClassNames: Record<
  RemoteCompatibilityNoticeCardProps["placement"],
  string
> = {
  floating: styles.floating!,
  inline: styles.inline!,
};

const severityTones: Record<RemoteNoticeSeverity, BannerTone> = {
  info: "info",
  recommended: "warning",
  security: "error",
  blocking: "error",
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
    <Banner
      tone={severityTones[notice.severity]}
      className={[
        placementClassNames[placement],
        placement === "floating" &&
          notice.floatingPlacement === "below-header" &&
          styles.belowHeader,
      ]
        .filter(Boolean)
        .join(" ")}
      title={
        <span className={styles.headline!}>
          {notice.title}
          {notice.versionSummary && (
            <span className={styles.meta!}>{notice.versionSummary}</span>
          )}
          {noticeCount > 1 && <Badge size="small">{noticeCount} notices</Badge>}
        </span>
      }
      actions={
        <>
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
        </>
      }
      data-testid="remote-compatibility-notice"
    >
      <p className={styles.line!}>{notice.body}</p>
      {notice.guidance && <p className={styles.line!}>{notice.guidance}</p>}
      {commandField && (
        <div className={styles.commandField!}>
          {commandField.lines > 1 ? (
            <Textarea
              className={`${styles.commandInput!} ${styles.commandInputMulti!}`}
              size="small"
              mono
              value={commandField.command}
              readOnly
              rows={Math.min(commandField.lines, 4)}
              aria-label={`${commandField.label} text`}
              onFocus={(event) => event.currentTarget.select()}
            />
          ) : (
            <TextInput
              className={styles.commandInput!}
              size="small"
              mono
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
    </Banner>
  );
}
