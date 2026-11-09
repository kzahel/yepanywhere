import type {
  PublicShareLinkedFileMode,
  PublicSessionShareMode,
  PublicSessionShareSessionStatusResponse,
  PublicSessionShareViewerSummary,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useI18n } from "../i18n";
import { writeClipboardTextLater } from "../lib/clipboard";
import {
  PublicShareManagerModal,
  type PublicShareCreationIdentity,
} from "./PublicShareManagerModal";
import { Banner } from "./ui/Banner";
import { Button, ButtonBase, IconButton } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { Field, TextInput } from "./ui/Field";
import type { ModalAnchorRect } from "./ui/Modal";
import { Spinner } from "./ui/Spinner";
import { ViewerCountIndicator } from "./ViewerCountIndicator";

export interface SessionShareModalProps {
  anchorRect?: ModalAnchorRect | null;
  initialPrompt?: string | null;
  projectId?: string;
  sessionId?: string;
  title?: string | null;
  canCreateShares?: boolean;
  onStatusChange?: (status: PublicSessionShareSessionStatusResponse) => void;
  onClose: () => void;
  initialView?: "manage" | "session";
  managementAvailable?: boolean;
  managementFreezeAvailable?: boolean;
}

type ShareWorkingState =
  | PublicSessionShareMode
  | "freeze-all"
  | "revoke"
  | `disconnect:${string}`
  | `freeze:${string}`;

interface LegacySessionShareModalProps
  extends Omit<
    SessionShareModalProps,
    "initialView" | "managementAvailable" | "managementFreezeAvailable"
  > {
  onManage?: () => void;
}

export function LegacySessionShareModal({
  anchorRect,
  initialPrompt,
  projectId,
  sessionId,
  title,
  canCreateShares = true,
  onStatusChange,
  onClose,
  onManage,
}: LegacySessionShareModalProps) {
  const { t } = useI18n();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] =
    useState<PublicSessionShareSessionStatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [isWorking, setIsWorking] = useState<ShareWorkingState | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [createdLinkedFileMode, setCreatedLinkedFileMode] =
    useState<PublicShareLinkedFileMode | null>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (status) onStatusChange?.(status);
  }, [onStatusChange, status]);

  useEffect(() => {
    if (!projectId || !sessionId) return;
    let cancelled = false;

    const refreshStatus = async () => {
      setStatusLoading(true);
      setStatusError(null);
      try {
        const nextStatus = await api.getPublicSessionShareStatus(
          projectId,
          sessionId,
        );
        if (!cancelled) setStatus(nextStatus);
      } catch (loadError) {
        if (!cancelled) {
          setStatus(null);
          setStatusError(
            loadError instanceof Error
              ? loadError.message
              : t("publicShareManagementLoadFailed"),
          );
        }
      } finally {
        if (!cancelled) setStatusLoading(false);
      }
    };

    void refreshStatus();
    return () => {
      cancelled = true;
    };
  }, [projectId, sessionId, t]);

  const createAndCopyShare = async (mode: PublicSessionShareMode) => {
    if (!projectId || !sessionId) return;
    setIsWorking(mode);
    setError(null);
    setResult(null);
    const sharePromise = api.createPublicSessionShare({
      projectId: projectId as UrlProjectId,
      sessionId,
      mode,
      initialPrompt: initialPrompt ?? undefined,
      title: title ?? undefined,
    });
    const copyPromise = writeClipboardTextLater(
      sharePromise.then((created) => created.url),
    );
    try {
      const created = await sharePromise;
      setUrl(created.url);
      setCreatedLinkedFileMode(created.linkedFileMode ?? null);
      if (await copyPromise) {
        setResult(t("sessionShareCopiedReadOnly"));
      } else {
        window.setTimeout(() => {
          urlInputRef.current?.focus();
          urlInputRef.current?.select();
        }, 0);
        setResult(t("sessionShareManualCopy"));
      }
      setStatus((current) => ({
        activeCount: (current?.activeCount ?? 0) + 1,
        frozenCount: (current?.frozenCount ?? 0) + (mode === "frozen" ? 1 : 0),
        liveCount: (current?.liveCount ?? 0) + (mode === "live" ? 1 : 0),
        activeViewerCount: current?.activeViewerCount ?? 0,
        viewers: current?.viewers ?? [],
      }));
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : t("sessionShareFailed"),
      );
    } finally {
      setIsWorking(null);
    }
  };

  const revokeAll = async () => {
    if (!projectId || !sessionId) return;
    setIsWorking("revoke");
    setError(null);
    setResult(null);
    try {
      const response = await api.revokePublicSessionShares(
        projectId,
        sessionId,
      );
      setStatus(response);
      setUrl(null);
      setResult(t("sessionShareRevoked", { count: response.revokedCount }));
    } catch (revokeError) {
      setError(
        revokeError instanceof Error
          ? revokeError.message
          : t("sessionShareRevokeFailed"),
      );
    } finally {
      setIsWorking(null);
    }
  };

  const freezeAllLive = async () => {
    if (!projectId || !sessionId) return;
    setIsWorking("freeze-all");
    setError(null);
    setResult(null);
    try {
      const response = await api.freezePublicSessionLiveShares(
        projectId,
        sessionId,
      );
      setStatus(response);
      setResult(
        t("sessionShareFrozenLiveLinks", { count: response.convertedCount }),
      );
    } catch (freezeError) {
      setError(
        freezeError instanceof Error
          ? freezeError.message
          : t("sessionShareFreezeFailed"),
      );
    } finally {
      setIsWorking(null);
    }
  };

  const freezeViewerToken = async (viewer: PublicSessionShareViewerSummary) => {
    if (!projectId || !sessionId) return;
    setIsWorking(`freeze:${viewer.viewerId}`);
    setError(null);
    setResult(null);
    try {
      const response = await api.freezePublicSessionViewerToken(
        projectId,
        sessionId,
        viewer.viewerId,
      );
      setStatus(response);
      setResult(t("sessionShareViewerFrozen", { token: viewer.shortId }));
    } catch (freezeError) {
      setError(
        freezeError instanceof Error
          ? freezeError.message
          : t("sessionShareFreezeFailed"),
      );
    } finally {
      setIsWorking(null);
    }
  };

  const disconnectViewerToken = async (
    viewer: PublicSessionShareViewerSummary,
  ) => {
    if (!projectId || !sessionId) return;
    setIsWorking(`disconnect:${viewer.viewerId}`);
    setError(null);
    setResult(null);
    try {
      const response = await api.disconnectPublicSessionViewerToken(
        projectId,
        sessionId,
        viewer.viewerId,
      );
      setStatus(response);
      setResult(t("sessionShareViewerDisconnected", { token: viewer.shortId }));
    } catch (disconnectError) {
      setError(
        disconnectError instanceof Error
          ? disconnectError.message
          : t("sessionShareRevokeFailed"),
      );
    } finally {
      setIsWorking(null);
    }
  };

  const hasActiveShares = (status?.activeCount ?? 0) > 0;
  const activeViewerCount = status?.activeViewerCount ?? 0;
  const viewers = status?.viewers ?? [];
  const viewerSummary = t("sessionShareViewerSummary", {
    active: activeViewerCount,
    total: viewers.length,
    live: status?.liveCount ?? 0,
    frozen: status?.frozenCount ?? 0,
  });

  return (
    <Dialog
      anchorRect={anchorRect}
      title={t("sessionShareTitle")}
      description={t("sessionShareReadOnlyNote")}
      onClose={onClose}
    >
      {canCreateShares ? (
        <div className="session-share-actions">
          <ButtonBase
            className="session-share-action"
            onClick={() => void createAndCopyShare("frozen")}
            disabled={isWorking !== null}
          >
            <span className="session-share-option-title">
              {isWorking === "frozen"
                ? t("sessionShareCopying")
                : t("sessionShareCopyFrozenReadOnly")}
            </span>
            <span className="session-share-option-description">
              {t("sessionShareFrozenDescription")}
            </span>
          </ButtonBase>
          <ButtonBase
            className="session-share-action"
            onClick={() => void createAndCopyShare("live")}
            disabled={isWorking !== null}
          >
            <span className="session-share-option-title">
              {isWorking === "live"
                ? t("sessionShareCopying")
                : t("sessionShareCopyLiveReadOnly")}
            </span>
            <span className="session-share-option-description">
              {t("sessionShareLiveDescription")}
            </span>
          </ButtonBase>
        </div>
      ) : (
        <p className="session-share-readonly-note">
          {t("sessionShareDisabledInSettings")}
        </p>
      )}

      {url && (
        <Field label={t("sessionShareUrlLabel")}>
          <TextInput
            ref={urlInputRef}
            mono
            readOnly
            value={url}
            onFocus={(event) => event.currentTarget.select()}
          />
        </Field>
      )}

      {error && <Banner tone="error">{error}</Banner>}
      {result && <Banner tone="success">{result}</Banner>}
      {createdLinkedFileMode === "live" && (
        <Banner tone="warning" role="none">
          {t("publicShareFrozenLinkedFilesLiveWarning")}
        </Banner>
      )}

      {statusLoading && (
        <div role="status">
          <Spinner size="small" /> {t("publicShareManagementLoadingExisting")}
        </div>
      )}
      {statusError && <Banner tone="error">{statusError}</Banner>}
      {onManage && (
        <Button size="small" onClick={onManage}>
          {t("publicShareManagementManageSession")}
        </Button>
      )}

      {hasActiveShares && (
        <div className="session-share-management">
          <div className="session-share-management-header">
            <ViewerCountIndicator
              className="session-share-viewer-count"
              count={activeViewerCount}
              label={viewerSummary}
            />
            <div className="session-share-global-controls">
              <Button
                size="small"
                onClick={() => void freezeAllLive()}
                disabled={isWorking !== null || (status?.liveCount ?? 0) === 0}
                title={t("sessionShareFreezeLiveTitle")}
              >
                {isWorking === "freeze-all"
                  ? t("sessionShareFreezing")
                  : t("sessionShareFreezeLive")}
              </Button>
              <Button
                variant="danger-outline"
                size="small"
                onClick={() => void revokeAll()}
                disabled={isWorking !== null}
                title={t("sessionShareRevokeAllTitle")}
              >
                {isWorking === "revoke"
                  ? t("sessionShareRevoking")
                  : t("sessionShareRevokeAll")}
              </Button>
            </div>
          </div>
          {viewers.length > 0 && (
            <>
              <p className="session-share-readonly-note">
                {t("sessionShareViewerOperationalWarning")}
              </p>
              <div
                className="session-share-viewer-list"
                role="list"
                aria-label={t("sessionShareViewerList")}
              >
                {viewers.map((viewer) => (
                  <div
                    className="session-share-viewer-row"
                    key={viewer.viewerId}
                  >
                    <div className="session-share-viewer-main">
                      <span className="session-share-viewer-token">
                        {viewer.shortId}
                      </span>
                      <span className="session-share-viewer-meta">
                        {t("sessionShareViewerMeta", {
                          count: viewer.accessCount,
                          time: new Date(viewer.lastSeenAt).toLocaleString(),
                        })}
                      </span>
                    </div>
                    <div className="session-share-viewer-state">
                      {viewer.disconnected
                        ? t("sessionShareViewerDisconnectedState")
                        : viewer.frozen
                          ? t("sessionShareViewerFrozenState")
                          : viewer.active
                            ? t("sessionShareViewerActiveState")
                            : t("sessionShareViewerInactiveState")}
                    </div>
                    <div className="session-share-viewer-actions">
                      <IconButton
                        label={t("sessionShareFreezeViewerTitle", {
                          token: viewer.shortId,
                        })}
                        variant="secondary"
                        size="small"
                        onClick={() => void freezeViewerToken(viewer)}
                        disabled={
                          isWorking !== null ||
                          viewer.disconnected ||
                          viewer.frozen ||
                          (status?.liveCount ?? 0) === 0
                        }
                      >
                        |||
                      </IconButton>
                      <IconButton
                        label={t("sessionShareDisconnectViewerTitle", {
                          token: viewer.shortId,
                        })}
                        variant="danger-outline"
                        size="small"
                        onClick={() => void disconnectViewerToken(viewer)}
                        disabled={isWorking !== null || viewer.disconnected}
                      >
                        x
                      </IconButton>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}

export function SessionShareModal({
  initialView = "session",
  managementAvailable = false,
  ...props
}: SessionShareModalProps) {
  const [view, setView] = useState(initialView);
  const creationIdentity: PublicShareCreationIdentity | undefined =
    props.projectId && props.sessionId
      ? {
          projectId: props.projectId,
          sessionId: props.sessionId,
          title: props.title,
          initialPrompt: props.initialPrompt,
        }
      : undefined;

  if (managementAvailable && view === "manage") {
    return (
      <PublicShareManagerModal
        anchorRect={props.anchorRect}
        creationIdentity={creationIdentity}
        creationReady={props.canCreateShares ?? true}
        selectiveFreezeAvailable={props.managementFreezeAvailable}
        onClose={props.onClose}
      />
    );
  }

  return (
    <LegacySessionShareModal
      {...props}
      onManage={managementAvailable ? () => setView("manage") : undefined}
    />
  );
}
