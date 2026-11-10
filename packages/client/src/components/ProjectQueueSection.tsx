import {
  PROJECT_QUEUE_NAMED_BLOCKER_COUNT,
  type ProjectQueueBlocker,
  type ProjectQueueDispatchState,
  type ProjectQueueItemSummary,
  type ProjectQueueMessage,
  type ProjectQueueProjectStatus,
  type ProjectQueueRecoveredSessionQueueSummary,
  type ProjectQueueSessionBlockerReason,
  parseProjectQueueBlocker,
} from "@yep-anywhere/shared";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import { type MessageKey, useI18n } from "../i18n";
import type { Project } from "../types";
import { ProjectQueueAttachmentEditor } from "./ProjectQueueAttachmentEditor";
import { ProviderBadge } from "./ProviderBadge";
import styles from "./ProjectQueueSection.module.css";
import { Badge, type BadgeTone } from "./ui/Badge";
import { Banner } from "./ui/Banner";
import { Button } from "./ui/Button";
import { Textarea } from "./ui/Field";
import { projectQueueRouterLabel } from "../lib/projectQueueRouterLabel";

type Translate = ReturnType<typeof useI18n>["t"];

type ItemStatus = ProjectQueueItemSummary["status"];

const ITEM_STATUS_CLASS: Record<ItemStatus, string | undefined> = {
  queued: "",
  dispatching: styles.itemDispatching,
  failed: styles.itemFailed,
};

const ITEM_STATUS_TONE: Record<ItemStatus, BadgeTone> = {
  queued: "neutral",
  dispatching: "info",
  failed: "danger",
};

function cx(...classNames: (string | false | undefined)[]): string {
  return classNames.filter(Boolean).join(" ");
}

interface ProjectQueueSectionProps {
  projects: Project[];
  items: readonly ProjectQueueItemSummary[];
  recoveredSessionQueues?: ProjectQueueRecoveredSessionQueueSummary[];
  loading: boolean;
  error: Error | null;
  mutatingItemId: string | null;
  mutatingRecoveredQueueId: string | null;
  mutatingDispatchState: boolean;
  mutatingPromoteItemId: string | null;
  dispatchState: ProjectQueueDispatchState;
  projectStatusesByProject?: Record<string, ProjectQueueProjectStatus>;
  highlightedItemId?: string | null;
  basePath?: string;
  attachmentEditingEnabled?: boolean;
  onPauseDispatch: () => void;
  onResumeDispatch: () => void;
  onPromoteNow: (
    projectId: string,
    itemId: string,
    options?: { force?: boolean },
  ) => void;
  onDeleteItem: (projectId: string, itemId: string) => void;
  onResumeRecoveredItem: (sessionId: string, queueId: string) => void;
  onDeleteRecoveredItem: (sessionId: string, queueId: string) => void;
  onRetryItem: (projectId: string, itemId: string) => void;
  onMoveItemToTop: (projectId: string, itemId: string) => void;
  onUpdateItem: (
    projectId: string,
    itemId: string,
    message: ProjectQueueMessage,
  ) => Promise<void> | void;
}

function formatRelativeTime(timestamp: string, t: Translate): string {
  const then = new Date(timestamp).getTime();
  if (!Number.isFinite(then)) return "";
  const diffMs = Math.max(0, Date.now() - then);
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return t("projectQueueAgeJustNow");
  if (diffMins < 60) return t("projectQueueAgeMinutes", { count: diffMins });
  if (diffHours < 24) return t("projectQueueAgeHours", { count: diffHours });
  if (diffDays < 7) return t("projectQueueAgeDays", { count: diffDays });
  return new Date(timestamp).toLocaleDateString();
}

function targetLabel(item: ProjectQueueItemSummary, t: Translate): string {
  const targetTitle = item.targetTitle?.trim();
  if (targetTitle) return targetTitle;
  return item.target.type === "new-session"
    ? t("projectQueueTargetNewSession")
    : t("projectQueueTargetSession", {
        sessionId: item.target.sessionId.slice(0, 8),
      });
}

function statusLabel(
  status: ProjectQueueItemSummary["status"],
  t: Translate,
): string {
  switch (status) {
    case "dispatching":
      return t("projectQueueStatusDispatching");
    case "failed":
      return t("projectQueueStatusFailed");
    case "queued":
      return t("projectQueueStatusQueued");
  }
}

function formatDurationSeconds(ms: number, t: Translate): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return t("projectQueueReadinessSeconds", { seconds });
}

function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

/**
 * Copy for each session blocker reason: with the session named, and alone
 * after a session already named. Exhaustive, so a reason the server adds
 * fails the build here rather than rendering its raw token.
 */
const SESSION_BLOCKER_COPY: Record<
  ProjectQueueSessionBlockerReason,
  { withSession: MessageKey; alone: MessageKey }
> = {
  "in-turn": {
    withSession: "projectQueueBlockerInTurn",
    alone: "projectQueueBlockerReasonInTurn",
  },
  "waiting-input": {
    withSession: "projectQueueBlockerWaitingInput",
    alone: "projectQueueBlockerReasonWaitingInput",
  },
  "provider-retained": {
    withSession: "projectQueueBlockerProviderRetained",
    alone: "projectQueueBlockerReasonProviderRetained",
  },
  "direct-queue": {
    withSession: "projectQueueBlockerDirectQueue",
    alone: "projectQueueBlockerReasonDirectQueue",
  },
  "deferred-queue": {
    withSession: "projectQueueBlockerDeferredQueue",
    alone: "projectQueueBlockerReasonDeferredQueue",
  },
  "pending-input": {
    withSession: "projectQueueBlockerPendingInput",
    alone: "projectQueueBlockerReasonPendingInput",
  },
  "user-starting": {
    withSession: "projectQueueBlockerUserStarting",
    alone: "projectQueueBlockerReasonUserStarting",
  },
  "automation-paused": {
    withSession: "projectQueueBlockerAutomationPaused",
    alone: "projectQueueBlockerReasonAutomationPaused",
  },
  external: {
    withSession: "projectQueueBlockerExternal",
    alone: "projectQueueBlockerReasonExternal",
  },
};

type SessionBlocker = Extract<
  ProjectQueueBlocker,
  { kind: "session" | "session-liveness" }
>;

function isSessionBlocker(
  blocker: ProjectQueueBlocker,
): blocker is SessionBlocker {
  return blocker.kind === "session" || blocker.kind === "session-liveness";
}

/** A session blocker's reason, for a session already named beside it. */
function sessionBlockerReason(blocker: SessionBlocker, t: Translate): string {
  return blocker.kind === "session-liveness"
    ? t("projectQueueBlockerReasonLiveness", { status: blocker.status })
    : t(SESSION_BLOCKER_COPY[blocker.reason].alone);
}

function formatProjectQueueBlocker(
  blocker: ProjectQueueBlocker,
  t: Translate,
): string {
  switch (blocker.kind) {
    case "readiness":
      return blocker.detail;
    case "worker-queue":
      return t("projectQueueBlockerWorkerQueue");
    case "first-item-failed":
      return t("projectQueueBlockerFirstFailed");
    case "recovered-session-queue":
      return t("projectQueueBlockerRecoveredSessionQueue", {
        count: blocker.count,
      });
    case "session":
      return t(SESSION_BLOCKER_COPY[blocker.reason].withSession, {
        session: shortSessionId(blocker.sessionId),
      });
    case "session-liveness":
      return t("projectQueueBlockerLiveness", {
        session: shortSessionId(blocker.sessionId),
        status: blocker.status,
      });
    case "other":
      return t("projectQueueBlockerUnknown", { blocker: blocker.blocker });
  }
}

function namedBlockers(blockers: readonly string[]): ProjectQueueBlocker[] {
  return blockers
    .slice(0, PROJECT_QUEUE_NAMED_BLOCKER_COUNT)
    .map(parseProjectQueueBlocker);
}

function summarizeBlockers(blockers: readonly string[], t: Translate): string {
  const formatted = namedBlockers(blockers).map((blocker) =>
    formatProjectQueueBlocker(blocker, t),
  );
  if (blockers.length > formatted.length) {
    formatted.push(
      t("projectQueueBlockerMore", {
        count: blockers.length - formatted.length,
      }),
    );
  }
  return formatted.join("; ");
}

function blockerNodes(
  status: ProjectQueueProjectStatus,
  basePath: string,
  t: Translate,
): ReactNode[] {
  const result: ReactNode[] = [];
  const sessions = new Map<string, SessionBlocker[]>();
  for (const blocker of namedBlockers(status.blockers)) {
    if (isSessionBlocker(blocker)) {
      const held = sessions.get(blocker.sessionId) ?? [];
      held.push(blocker);
      sessions.set(blocker.sessionId, held);
    } else {
      result.push(formatProjectQueueBlocker(blocker, t));
    }
  }
  for (const [sessionId, held] of sessions) {
    const title = status.blockerSessionTitles?.[sessionId];
    const [only] = held;
    if (held.length === 1 && only && !title) {
      result.push(formatProjectQueueBlocker(only, t));
      continue;
    }
    result.push(
      <span key={sessionId}>
        {shortSessionId(sessionId)}{" "}
        {held.map((blocker) => sessionBlockerReason(blocker, t)).join("; ")}
        {title && (
          <>
            {"; "}
            <Link
              to={`${basePath}/projects/${status.projectId}/sessions/${sessionId}`}
            >
              {title}
            </Link>
          </>
        )}
      </span>,
    );
  }
  if (status.blockers.length > PROJECT_QUEUE_NAMED_BLOCKER_COUNT) {
    result.push(
      t("projectQueueBlockerMore", {
        count: status.blockers.length - PROJECT_QUEUE_NAMED_BLOCKER_COUNT,
      }),
    );
  }
  return result;
}

function readinessLabel(
  status: ProjectQueueProjectStatus | undefined,
  nowMs: number,
  basePath: string,
  t: Translate,
): ReactNode {
  if (!status) return null;
  switch (status.state) {
    case "paused":
      return t("projectQueueReadinessPaused");
    case "blocked":
      return (
        <>
          {t("projectQueueReadinessBlockedPrefix")}{" "}
          {blockerNodes(status, basePath, t).map((blocker, index) => (
            <span key={typeof blocker === "string" ? blocker : index}>
              {index > 0 && "; "}
              {blocker}
            </span>
          ))}
        </>
      );
    case "waiting-quiet": {
      const eligibleAt = status.quietEligibleAt
        ? new Date(status.quietEligibleAt).getTime()
        : Number.NaN;
      const waitMs = Number.isFinite(eligibleAt)
        ? Math.max(0, eligibleAt - nowMs)
        : status.quietWindowMs;
      return t("projectQueueReadinessWaitingQuiet", {
        duration: formatDurationSeconds(waitMs, t),
      });
    }
    case "ready":
      return t("projectQueueReadinessReady");
    case "dispatching":
      return t("projectQueueReadinessDispatching");
    case "empty":
      return t("projectQueueReadinessEmpty");
  }
}

function maxResumeQuietWindowMs(
  items: readonly ProjectQueueItemSummary[],
  projectStatusesByProject: Record<string, ProjectQueueProjectStatus>,
): number | null {
  let maxQuietWindowMs: number | null = null;
  const projectIds = new Set(items.map((item) => item.projectId));
  for (const projectId of projectIds) {
    const quietWindowMs = projectStatusesByProject[projectId]?.quietWindowMs;
    if (
      typeof quietWindowMs !== "number" ||
      !Number.isFinite(quietWindowMs) ||
      quietWindowMs <= 0
    ) {
      continue;
    }
    maxQuietWindowMs =
      maxQuietWindowMs === null
        ? quietWindowMs
        : Math.max(maxQuietWindowMs, quietWindowMs);
  }
  return maxQuietWindowMs;
}

function pausedNotice(
  pausedState: Extract<ProjectQueueDispatchState, { status: "paused" }>,
  items: readonly ProjectQueueItemSummary[],
  projectStatusesByProject: Record<string, ProjectQueueProjectStatus>,
  t: Translate,
): string {
  const quietWindowMs = maxResumeQuietWindowMs(items, projectStatusesByProject);
  if (quietWindowMs !== null) {
    return pausedState.reason === "restart"
      ? t("projectQueuePausedAfterRestartNoticeWithDelay", {
          duration: formatDurationSeconds(quietWindowMs, t),
        })
      : t("projectQueuePausedNoticeWithDelay", {
          duration: formatDurationSeconds(quietWindowMs, t),
        });
  }

  return pausedState.reason === "restart"
    ? t("projectQueuePausedAfterRestartNotice")
    : t("projectQueuePausedNotice");
}

function sessionLabel(
  item: ProjectQueueRecoveredSessionQueueSummary,
  t: Translate,
): string {
  return (
    item.sessionTitle?.trim() ||
    t("projectQueueTargetSession", {
      sessionId: item.sessionId.slice(0, 8),
    })
  );
}

interface RecoveredSessionQueueGroup {
  key: string;
  projectId: string;
  sessionId: string;
  sessionTitle?: string;
  items: ProjectQueueRecoveredSessionQueueSummary[];
}

interface ProjectQueueDisplayGroup {
  projectId: string;
  projectName: string;
  items: ProjectQueueItemSummary[];
}

function groupRecoveredSessionQueues(
  items: readonly ProjectQueueRecoveredSessionQueueSummary[],
): RecoveredSessionQueueGroup[] {
  const groups = new Map<string, RecoveredSessionQueueGroup>();
  for (const item of items) {
    const key = `${item.projectId}:${item.sessionId}`;
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
    } else {
      groups.set(key, {
        key,
        projectId: item.projectId,
        sessionId: item.sessionId,
        ...(item.sessionTitle ? { sessionTitle: item.sessionTitle } : {}),
        items: [item],
      });
    }
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      items: [...group.items].sort((left, right) => {
        const queued = (left.queuedAt ?? left.timestamp).localeCompare(
          right.queuedAt ?? right.timestamp,
        );
        return queued !== 0 ? queued : left.id.localeCompare(right.id);
      }),
    }))
    .sort((left, right) => {
      const project = left.projectId.localeCompare(right.projectId);
      if (project !== 0) return project;
      const leftQueued =
        left.items[0]?.queuedAt ?? left.items[0]?.timestamp ?? "";
      const rightQueued =
        right.items[0]?.queuedAt ?? right.items[0]?.timestamp ?? "";
      const queued = leftQueued.localeCompare(rightQueued);
      return queued !== 0
        ? queued
        : left.sessionId.localeCompare(right.sessionId);
    });
}

function compareDisplayNames(left: string, right: string): number {
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function groupProjectQueueItems(
  items: readonly ProjectQueueItemSummary[],
  projectById: Map<string, Project>,
  t: Translate,
): ProjectQueueDisplayGroup[] {
  const groups = new Map<string, ProjectQueueDisplayGroup>();
  for (const item of items) {
    const existing = groups.get(item.projectId);
    if (existing) {
      existing.items.push(item);
      continue;
    }
    groups.set(item.projectId, {
      projectId: item.projectId,
      projectName:
        projectById.get(item.projectId)?.name ??
        t("projectQueueUnknownProject"),
      items: [item],
    });
  }

  return [...groups.values()].sort((left, right) => {
    const name = compareDisplayNames(left.projectName, right.projectName);
    return name !== 0 ? name : left.projectId.localeCompare(right.projectId);
  });
}

function isFirstMovableProjectQueueItem(
  item: ProjectQueueItemSummary,
  items: readonly ProjectQueueItemSummary[],
): boolean {
  const firstMovable = items.find(
    (candidate) =>
      candidate.projectId === item.projectId &&
      candidate.status !== "dispatching",
  );
  return firstMovable?.id === item.id;
}

export function ProjectQueueSection({
  projects,
  items,
  recoveredSessionQueues = [],
  loading,
  error,
  mutatingItemId,
  mutatingRecoveredQueueId,
  mutatingDispatchState,
  mutatingPromoteItemId,
  dispatchState,
  projectStatusesByProject = {},
  highlightedItemId,
  basePath = "",
  attachmentEditingEnabled = false,
  onPauseDispatch,
  onResumeDispatch,
  onPromoteNow,
  onDeleteItem,
  onResumeRecoveredItem,
  onDeleteRecoveredItem,
  onRetryItem,
  onMoveItemToTop,
  onUpdateItem,
}: ProjectQueueSectionProps) {
  const { t } = useI18n();
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const highlightedItemRef = useRef<HTMLLIElement | null>(null);
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const itemGroups = groupProjectQueueItems(items, projectById, t);
  const recoveredGroups = groupRecoveredSessionQueues(recoveredSessionQueues);
  const recoveredCount = recoveredSessionQueues.length;
  const hasProjectQueueItems = items.length > 0;
  const hasContent = hasProjectQueueItems || recoveredCount > 0;
  const highlightedItemIndex = highlightedItemId
    ? items.findIndex((item) => item.id === highlightedItemId)
    : -1;
  const pausedState =
    dispatchState.status === "paused" ? dispatchState : undefined;
  const description = pausedState
    ? pausedState.reason === "restart"
      ? t("projectQueuePausedAfterRestartDescription")
      : t("projectQueuePausedDescription")
    : t("projectQueueDescription");

  useEffect(() => {
    if (!editingItemId) return;
    if (items.some((item) => item.id === editingItemId)) return;
    setEditingItemId(null);
    setEditText("");
  }, [editingItemId, items]);

  useEffect(() => {
    if (!highlightedItemId || highlightedItemIndex < 0) return;
    highlightedItemRef.current?.scrollIntoView?.({
      block: "center",
      behavior: "smooth",
    });
  }, [highlightedItemId, highlightedItemIndex]);

  useEffect(() => {
    if (!hasProjectQueueItems) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasProjectQueueItems]);

  if (!hasContent && !error) return null;

  return (
    <section className={styles.section} aria-labelledby="project-queue-title">
      <div className={styles.header}>
        <div>
          <h2 id="project-queue-title">{t("projectQueueTitle")}</h2>
          <p>{description}</p>
        </div>
        <div className={styles.headerActions}>
          {hasProjectQueueItems && (
            <span className={styles.count}>
              {loading
                ? t("projectQueueRefreshing")
                : t("projectQueueCount", { count: items.length })}
            </span>
          )}
          {hasProjectQueueItems && (
            <Button
              variant="outline"
              size="small"
              className={styles.dispatchButton}
              onClick={pausedState ? onResumeDispatch : onPauseDispatch}
              disabled={mutatingDispatchState}
            >
              {pausedState ? t("projectQueueResume") : t("projectQueuePause")}
            </Button>
          )}
        </div>
      </div>

      {pausedState && hasProjectQueueItems && (
        <Banner tone="warning">
          {pausedNotice(pausedState, items, projectStatusesByProject, t)}
        </Banner>
      )}

      {error && (
        <Banner tone="error">
          {t("projectQueueLoadError", { message: error.message })}
        </Banner>
      )}

      {recoveredGroups.length > 0 && (
        <div className={styles.recovered}>
          <div className={styles.recoveredHeader}>
            <h3>{t("projectQueueRecoveredTitle")}</h3>
            <Badge
              tone="warning"
              size="small"
              shape="count"
              className={styles.recoveredBadge}
            >
              {t("projectQueueRecoveredCount", { count: recoveredCount })}
            </Badge>
          </div>
          <ul className={styles.recoveredGroups}>
            {recoveredGroups.map((group) => {
              const project = projectById.get(group.projectId);
              const firstItem = group.items[0];
              const label = firstItem
                ? sessionLabel(firstItem, t)
                : t("projectQueueTargetSession", {
                    sessionId: group.sessionId.slice(0, 8),
                  });
              return (
                <li className={styles.recoveredGroup} key={group.key}>
                  <div className={styles.recoveredGroupHeader}>
                    <span className={styles.recoveredProject}>
                      {project?.name ?? t("projectQueueUnknownProject")}
                    </span>
                    <Link
                      className={styles.recoveredSession}
                      to={`${basePath}/projects/${group.projectId}/sessions/${group.sessionId}`}
                    >
                      {label}
                    </Link>
                    <Badge
                      tone="warning"
                      size="small"
                      className={styles.recoveredBadge}
                    >
                      {t("sessionRecoveredQueuedPaused")}
                    </Badge>
                  </div>
                  <ul className={styles.recoveredMessages}>
                    {group.items.map((item) => {
                      const isMutatingRecovered =
                        mutatingRecoveredQueueId === item.id;
                      const recoveredMutationPending =
                        mutatingRecoveredQueueId !== null;
                      return (
                        <li
                          className={styles.recoveredMessage}
                          key={item.id}
                          data-recovered-queue-id={item.id}
                          aria-busy={isMutatingRecovered || undefined}
                        >
                          <div className={styles.recoveredMessageContent}>
                            <span className={styles.recoveredPreview}>
                              {item.content || t("projectQueueAttachmentOnly")}
                            </span>
                            <span className={styles.recoveredAge}>
                              {formatRelativeTime(
                                item.queuedAt ?? item.timestamp,
                                t,
                              )}
                            </span>
                          </div>
                          <div className={styles.recoveredMessageActions}>
                            <Button
                              size="small"
                              onClick={() =>
                                onResumeRecoveredItem(item.sessionId, item.id)
                              }
                              disabled={recoveredMutationPending}
                              aria-label={t("sessionRecoveredQueuedResume")}
                              title={t("sessionRecoveredQueuedResume")}
                            >
                              {t("projectQueueResume")}
                            </Button>
                            <Button
                              variant="danger-outline"
                              size="small"
                              onClick={() =>
                                onDeleteRecoveredItem(item.sessionId, item.id)
                              }
                              disabled={recoveredMutationPending}
                              aria-label={t("sessionRecoveredQueuedDelete")}
                              title={t("sessionRecoveredQueuedDelete")}
                            >
                              {t("projectQueueDelete")}
                            </Button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {hasProjectQueueItems && (
        <ul className={styles.groups}>
          {itemGroups.map((group) => (
            <li className={styles.group} key={group.projectId}>
              <h3 className={styles.groupTitle}>{group.projectName}</h3>
              <ul className={styles.list}>
                {group.items.map((item) => {
                  const isMutating = mutatingItemId === item.id;
                  const isPromoting = mutatingPromoteItemId === item.id;
                  const isDispatching = item.status === "dispatching";
                  const isEditing = editingItemId === item.id;
                  const routerLabel = projectQueueRouterLabel(item.target, t);
                  const isHighlighted = highlightedItemId === item.id;
                  const canEdit =
                    !item.creationSessionId &&
                    (item.status === "queued" || item.status === "failed");
                  const projectStatus =
                    projectStatusesByProject[item.projectId];
                  const readiness = readinessLabel(
                    projectStatus,
                    nowMs,
                    basePath,
                    t,
                  );
                  const blockerSummary = projectStatus
                    ? summarizeBlockers(projectStatus.blockers, t)
                    : "";
                  const forceStart =
                    item.status === "queued" &&
                    (projectStatus?.state === "blocked" ||
                      (pausedState !== undefined &&
                        projectStatus !== undefined &&
                        projectStatus.blockers.length > 0));
                  const canPromote =
                    item.status === "queued" &&
                    projectStatus?.state !== "dispatching";
                  const canMoveToTop =
                    canEdit && !isFirstMovableProjectQueueItem(item, items);
                  const canSaveEdit =
                    !isMutating &&
                    (editText.trim().length > 0 ||
                      (item.message.attachments?.length ?? 0) > 0 ||
                      (item.message.stagedAttachments?.refs.length ?? 0) > 0);
                  const handleEditSubmit = async (
                    event: FormEvent<HTMLFormElement>,
                  ) => {
                    event.preventDefault();
                    if (!canSaveEdit) return;
                    try {
                      await onUpdateItem(item.projectId, item.id, {
                        ...item.message,
                        text: editText,
                      });
                      setEditingItemId(null);
                      setEditText("");
                    } catch {
                      // The queue hook exposes the mutation error in this section.
                    }
                  };
                  return (
                    <li
                      key={item.id}
                      ref={isHighlighted ? highlightedItemRef : undefined}
                      className={cx(
                        styles.item,
                        ITEM_STATUS_CLASS[item.status],
                        isHighlighted && styles.itemHighlighted,
                      )}
                      data-project-queue-item-id={item.id}
                    >
                      <div className={styles.itemMain}>
                        <div className={styles.itemMeta}>
                          <span className={styles.itemTarget}>
                            {item.target.type === "existing-session" ? (
                              <Link
                                to={`${basePath}/projects/${item.projectId}/sessions/${item.target.sessionId}`}
                              >
                                {targetLabel(item, t)}
                              </Link>
                            ) : item.creationSessionId ? (
                              <Link
                                className={styles.savedSessionLink}
                                to={`${basePath}/projects/${item.projectId}/sessions/${item.creationSessionId}`}
                              >
                                {t("sessionCreationOpenSaved")}
                              </Link>
                            ) : (
                              targetLabel(item, t)
                            )}
                          </span>
                          {item.target.provider && (
                            <ProviderBadge
                              provider={item.target.provider}
                              model={item.target.model}
                              className={styles.itemProvider}
                            />
                          )}
                          {routerLabel && (
                            <span
                              className={styles.itemProvider}
                              title={routerLabel.title}
                            >
                              {routerLabel.label}
                            </span>
                          )}
                          <span className={styles.itemAge}>
                            {formatRelativeTime(item.createdAt, t)}
                          </span>
                        </div>
                        {isEditing && attachmentEditingEnabled ? (
                          <ProjectQueueAttachmentEditor
                            item={item}
                            disabled={isMutating}
                            onSave={(message) =>
                              onUpdateItem(item.projectId, item.id, message)
                            }
                            onDiscard={() => {
                              setEditingItemId(null);
                              setEditText("");
                            }}
                          />
                        ) : isEditing ? (
                          <form
                            className={styles.itemEdit}
                            onSubmit={handleEditSubmit}
                          >
                            <Textarea
                              value={editText}
                              onChange={(event) =>
                                setEditText(event.target.value)
                              }
                              aria-label={t("projectQueueEditMessageLabel")}
                              disabled={isMutating}
                              rows={3}
                            />
                            <div className={styles.itemEditActions}>
                              <Button
                                variant="primary"
                                size="small"
                                type="submit"
                                disabled={!canSaveEdit}
                              >
                                {t("projectQueueSave")}
                              </Button>
                              <Button
                                size="small"
                                disabled={isMutating}
                                onClick={() => {
                                  setEditingItemId(null);
                                  setEditText("");
                                }}
                              >
                                {t("projectQueueDiscard")}
                              </Button>
                            </div>
                          </form>
                        ) : (
                          <div className={styles.itemPreview}>
                            {item.messagePreview ||
                              t("projectQueueAttachmentOnly")}
                          </div>
                        )}
                        {item.lastError && (
                          <Banner tone="error" compact>
                            {item.lastError}
                          </Banner>
                        )}
                        {readiness && (
                          <div className={styles.itemReadiness}>
                            {readiness}
                          </div>
                        )}
                      </div>

                      <div className={styles.itemSide}>
                        <Badge
                          size="small"
                          tone={ITEM_STATUS_TONE[item.status]}
                          className={styles.itemStatus}
                        >
                          {statusLabel(item.status, t)}
                        </Badge>
                        <div className={styles.itemActions}>
                          {pausedState && !isEditing && (
                            <Button
                              size="small"
                              onClick={onResumeDispatch}
                              disabled={mutatingDispatchState}
                            >
                              {t("projectQueueResume")}
                            </Button>
                          )}
                          {canPromote && !isEditing && (
                            <Button
                              variant={
                                forceStart ? "attention-outline" : "secondary"
                              }
                              size="small"
                              onClick={() =>
                                onPromoteNow(item.projectId, item.id, {
                                  force: forceStart,
                                })
                              }
                              disabled={isMutating || isPromoting}
                              title={
                                forceStart
                                  ? t("projectQueueForceStartTitle", {
                                      blockers: blockerSummary,
                                    })
                                  : t("projectQueueStartNowTitle")
                              }
                            >
                              {isPromoting
                                ? t("projectQueuePromoting")
                                : forceStart
                                  ? t("projectQueueForceStart")
                                  : t("projectQueueStartNow")}
                            </Button>
                          )}
                          {item.status === "failed" && !isEditing && (
                            <Button
                              size="small"
                              onClick={() =>
                                onRetryItem(item.projectId, item.id)
                              }
                              disabled={isMutating}
                            >
                              {t("projectQueueRetry")}
                            </Button>
                          )}
                          {canEdit && editingItemId === null && (
                            <Button
                              size="small"
                              onClick={() => {
                                setEditingItemId(item.id);
                                setEditText(item.message.text);
                              }}
                              disabled={isMutating}
                            >
                              {t("projectQueueEdit")}
                            </Button>
                          )}
                          {canMoveToTop && !isEditing && (
                            <Button
                              size="small"
                              onClick={() =>
                                onMoveItemToTop(item.projectId, item.id)
                              }
                              disabled={isMutating}
                            >
                              {t("projectQueueMoveToTop")}
                            </Button>
                          )}
                          <Button
                            variant="danger-outline"
                            size="small"
                            onClick={() =>
                              onDeleteItem(item.projectId, item.id)
                            }
                            disabled={isMutating || isDispatching}
                          >
                            {t("projectQueueDelete")}
                          </Button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
