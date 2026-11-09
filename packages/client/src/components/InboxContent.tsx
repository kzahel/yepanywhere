import {
  PUBLIC_SHARE_MANAGEMENT_CAPABILITY,
  SESSION_CREATION_PROVENANCE_CAPABILITY,
  type ProjectQueueItemStatus,
  type ProjectQueueItemSummary,
  type ReviewInboxItem,
  serverHasCapability,
} from "@yep-anywhere/shared";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { type InboxItem, useInboxContext } from "../contexts/InboxContext";
import {
  type InboxCreationFilter,
  useInboxCreationFilter,
} from "../hooks/useInboxCreationFilter";
import { useProjectQueues } from "../hooks/useProjectQueues";
import { usePublicShareStatus } from "../hooks/usePublicShareStatus";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useServerSettings } from "../hooks/useServerSettings";
import { useVersion } from "../hooks/useVersion";
import { useI18n } from "../i18n";
import {
  useDraftSessionIds,
  useProjectQueuedSessionIds,
} from "../lib/clientSummaryStore";
import { activityBus } from "../lib/activityBus";
import {
  type InboxSection as InboxSectionKey,
  splitInboxSections,
} from "../lib/inboxSections";

import type { Project } from "../types";
import { getSessionDisplayTitle } from "../utils";
import { FilterDropdown, type FilterOption } from "./FilterDropdown";
import styles from "./InboxContent.module.css";
import { SessionListItem } from "./SessionListItem";
import { SessionAsyncQuestionsButton } from "./SessionAsyncQuestionsButton";
import { Badge, type BadgeTone } from "./ui/Badge";
import { Banner } from "./ui/Banner";
import { Button, IconButton } from "./ui/Button";
import { Popover } from "./ui/Popover";

/**
 * Tier configuration for visual styling.
 */
interface TierConfig {
  key: InboxSectionKey;
  titleKey: string;
  colorClass: string;
  /** Rows come from the server's Active tier and show phase indicators. */
  activityTier?: boolean;
  /** A tier the user only needs while it has rows. */
  hideWhenEmpty?: boolean;
  /** A "?" beside the title that opens this explanation. */
  helpKey?: string;
  getBadge?: (item: InboxItem) => { label: string; tone: BadgeTone } | null;
}

const TIER_CONFIGS: TierConfig[] = [
  {
    key: "needsAttention",
    titleKey: "inboxTierNeedsAttention",
    colorClass: styles.tierAttention ?? "",
    getBadge: (item) => {
      if (item.pendingInputType === "tool-approval") {
        return { label: "inboxBadgeApproval", tone: "info" };
      }
      if (item.pendingInputType === "user-question") {
        return { label: "inboxBadgeQuestion", tone: "info" };
      }
      return null;
    },
  },
  {
    key: "active",
    titleKey: "inboxTierActive",
    colorClass: styles.tierActive ?? "",
    activityTier: true,
    // Active items show a pulsing dot instead of a text badge
  },
  {
    // Active sessions whose turn ended while background work holds them.
    key: "background",
    titleKey: "inboxTierBackground",
    colorClass: styles.tierBackground ?? "",
    activityTier: true,
    hideWhenEmpty: true,
    helpKey: "inboxTierBackgroundHelp",
  },
  {
    key: "recentActivity",
    titleKey: "inboxTierRecentActivity",
    colorClass: styles.tierRecent ?? "",
  },
  {
    key: "unread8h",
    titleKey: "inboxTierUnread8h",
    colorClass: styles.tierUnread8h ?? "",
  },
  {
    key: "unread24h",
    titleKey: "inboxTierUnread24h",
    colorClass: styles.tierUnread24h ?? "",
  },
];

/**
 * Explicit module classes for the closed Project Queue status union.
 * Only the statuses with a rule get a class; `queued` styles the base
 * item and status pill alone, matching the legacy stylesheet.
 */
const QUEUE_ITEM_STATUS_CLASSES: Record<ProjectQueueItemStatus, string> = {
  queued: "",
  dispatching: "",
  failed: styles.queueItemFailed ?? "",
};

const QUEUE_STATUS_CLASSES: Record<ProjectQueueItemStatus, string> = {
  queued: "",
  dispatching: styles.queueItemStatusDispatching ?? "",
  failed: styles.queueItemStatusFailed ?? "",
};

type Translate = ReturnType<typeof useI18n>["t"];

type PendingNewSessionProjectQueueItem = ProjectQueueItemSummary & {
  target: Extract<ProjectQueueItemSummary["target"], { type: "new-session" }>;
};

function isPendingNewSessionProjectQueueItem(
  item: ProjectQueueItemSummary,
): item is PendingNewSessionProjectQueueItem {
  return (
    item.target.type === "new-session" &&
    (item.status === "queued" ||
      item.status === "dispatching" ||
      item.status === "failed")
  );
}

function projectQueueStatusLabel(
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

function formatProjectQueueAge(timestamp: string, t: Translate): string {
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

interface InboxSectionProps {
  config: TierConfig;
  items: InboxItem[];
  projectQueueItems?: PendingNewSessionProjectQueueItem[];
  projectNameById: ReadonlyMap<string, string>;
  /** When true, hides project name (for single-project inbox) */
  hideProjectName?: boolean;
  /** Base path prefix for relay mode (e.g., "/remote/my-server") */
  basePath?: string;
  /** Set of session IDs that have unsent drafts */
  drafts: ReadonlySet<string>;
  /** Set of session IDs targeted by Project Queue items */
  projectQueuedSessionIds: ReadonlySet<string>;
  /** Whether public share creation controls should be exposed. */
  publicShareCreationReady: boolean;
  /** Whether direct public-share management is supported. */
  publicShareManagementAvailable: boolean;
}

interface InboxProjectQueueItemProps {
  item: PendingNewSessionProjectQueueItem;
  projectName: string;
  basePath?: string;
  hideProjectName?: boolean;
}

function InboxProjectQueueItem({
  item,
  projectName,
  basePath = "",
  hideProjectName = false,
}: InboxProjectQueueItemProps) {
  const { t } = useI18n();
  const prompt = item.messagePreview.trim() || t("projectQueueAttachmentOnly");
  const targetTitle = item.target.title?.trim();
  const title = targetTitle || prompt;
  const showPromptPreview = !!targetTitle && targetTitle !== prompt;
  const age = formatProjectQueueAge(item.createdAt, t);
  const href = `${basePath}/projects?queueItem=${encodeURIComponent(item.id)}`;

  return (
    <li
      className={`${styles.queueItem} ${QUEUE_ITEM_STATUS_CLASSES[item.status]}`}
      data-inbox-project-queue-item-id={item.id}
    >
      <Link className={styles.queueItemLink} to={href}>
        <span className={styles.queueItemTitleRow}>
          <strong className={styles.queueItemTitle}>{title}</strong>
          <Badge size="small" className={styles.queueItemBadge}>
            {t("projectQueueTargetNewSession")}
          </Badge>
          <Badge
            size="small"
            role="img"
            aria-label={t("projectQueueSidebarBadge")}
            tooltip={t("projectQueueSidebarBadge")}
            className={styles.queueItemBadge}
          >
            Q
          </Badge>
        </span>
        {showPromptPreview && (
          <span className={styles.queueItemPreview}>{prompt}</span>
        )}
        <span className={styles.queueItemMeta}>
          {!hideProjectName && (
            <span className={styles.queueItemProject}>{projectName}</span>
          )}
          {age && <span>{age}</span>}
          <span
            className={`${styles.queueItemStatus} ${QUEUE_STATUS_CLASSES[item.status]}`}
          >
            {projectQueueStatusLabel(item.status, t)}
          </span>
        </span>
      </Link>
    </li>
  );
}

function getInboxRowActivity(
  item: InboxItem,
  config: TierConfig,
): InboxItem["activity"] {
  if (config.activityTier && item.activityInferredFromInboxTier) {
    return undefined;
  }
  return item.activity;
}

/** A tap-to-open explanation of a section, so it works without hover. */
function InboxSectionHelp({ title, text }: { title: string; text: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const label = t("inboxSectionHelpLabel", { section: title });
  return (
    <>
      <IconButton
        ref={triggerRef}
        size="dense"
        className={styles.sectionHelp}
        label={label}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={() => setOpen((shown) => !shown)}
      >
        <span aria-hidden="true" className={styles.sectionHelpMark}>
          ?
        </span>
      </IconButton>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={triggerRef}
        id={popoverId}
        surface="card"
        role="tooltip"
        className={styles.sectionHelpContent}
      >
        {text}
      </Popover>
    </>
  );
}

function InboxSection({
  config,
  items,
  projectQueueItems = [],
  projectNameById,
  hideProjectName,
  basePath = "",
  drafts,
  projectQueuedSessionIds,
  publicShareCreationReady,
  publicShareManagementAvailable,
}: InboxSectionProps) {
  const { t } = useI18n();
  const sectionCount = items.length + projectQueueItems.length;
  const isEmpty = sectionCount === 0;
  if (isEmpty && config.hideWhenEmpty) return null;

  return (
    <section
      className={`${styles.section} ${config.colorClass} ${isEmpty ? styles.sectionEmpty : ""}`}
    >
      <h2 className={styles.sectionHeader}>
        {t(config.titleKey as never)}
        <Badge shape="count" size="small" className={styles.sectionCount}>
          {sectionCount}
        </Badge>
        {config.helpKey && (
          <InboxSectionHelp
            title={t(config.titleKey as never)}
            text={t(config.helpKey as never)}
          />
        )}
      </h2>
      {isEmpty ? (
        <p className={styles.sectionEmptyMessage}>{t("inboxNoSessions")}</p>
      ) : (
        <ul className="sessions-list">
          {projectQueueItems.map((item) => (
            <InboxProjectQueueItem
              key={item.id}
              item={item}
              projectName={
                projectNameById.get(item.projectId) ??
                t("projectQueueUnknownProject")
              }
              hideProjectName={hideProjectName}
              basePath={basePath}
            />
          ))}
          {items.map((item) => {
            const badge = config.getBadge?.(item);
            const activity = getInboxRowActivity(item, config);
            return (
              <SessionListItem
                key={item.sessionId}
                sessionId={item.sessionId}
                projectId={item.projectId}
                title={getSessionDisplayTitle({
                  customTitle: item.customTitle,
                  title: item.sessionTitle,
                })}
                hasCustomTitle={!!item.customTitle}
                projectName={item.projectName}
                updatedAt={item.updatedAt}
                hasUnread={item.hasUnread}
                isStarred={item.isStarred}
                activity={activity}
                providerPhase={item.providerPhase}
                pendingInputType={item.pendingInputType}
                mode="card"
                openNonHumanUserTurn
                showProjectName={!hideProjectName}
                showTimestamp
                showContextUsage={false}
                showStatusBadge={false}
                showActivityIndicator={config.activityTier === true}
                customBadge={
                  badge ? { ...badge, label: t(badge.label as never) } : null
                }
                basePath={basePath}
                hasDraft={drafts.has(item.sessionId)}
                hasProjectQueue={projectQueuedSessionIds.has(item.sessionId)}
                publicShareCreationReady={publicShareCreationReady}
                publicShareManagementAvailable={publicShareManagementAvailable}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ReviewOutcomeSection({
  items,
  basePath,
  hideProjectName,
}: {
  items: ReviewInboxItem[];
  basePath: string;
  hideProjectName: boolean;
}) {
  const { t } = useI18n();
  const outcomes = items.flatMap((item) =>
    item.outcomes.map((outcome) => ({ item, outcome })),
  );
  return (
    <section className={`${styles.section} ${styles.tierReviews}`}>
      <h2 className={styles.sectionHeader}>
        {t("inboxTierReviewOutcomes")}
        <Badge shape="count" size="small" className={styles.sectionCount}>
          {outcomes.length}
        </Badge>
      </h2>
      <ul className={styles.reviewOutcomeList}>
        {outcomes.map(({ item, outcome }) => {
          const reviewParams = new URLSearchParams({
            projectId: item.projectId,
            tab: "reviews",
            submission: item.submissionId,
          });
          return (
            <li
              key={`${item.submissionId}\0${outcome.siteId}\0${outcome.entryId}`}
              className={styles.reviewOutcomeCard}
            >
              <div className={styles.reviewOutcomeHead}>
                <Link to={`${basePath}/git-status?${reviewParams}`}>
                  {item.name ?? t("sourceReviewUnreadSubmission")}
                </Link>
                <span>{reviewDispositionLabel(outcome.disposition, t)}</span>
              </div>
              <div className={styles.reviewOutcomeText}>{outcome.text}</div>
              <div className={styles.reviewOutcomeMeta}>
                {!hideProjectName && <span>{item.projectName}</span>}
                <span>{outcome.path}</span>
                {outcome.sessionId && (
                  <Link
                    to={`${basePath}/projects/${encodeURIComponent(
                      item.projectId,
                    )}/sessions/${encodeURIComponent(outcome.sessionId)}`}
                  >
                    {t("sourceReviewOutcomeSession")}
                  </Link>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function reviewDispositionLabel(
  disposition: ReviewInboxItem["outcomes"][number]["disposition"],
  t: Translate,
): string {
  if (disposition === "wont_fix") return t("sourceReviewOutcomeNoChange");
  if (disposition === "question") return t("sourceReviewOutcomeQuestion");
  return t("sourceReviewOutcomeDone");
}

export interface InboxContentProps {
  /** Optional projectId to filter inbox to a single project */
  projectId?: string;
  /** List of projects for the filter dropdown */
  projects?: Project[];
  /** Callback when project filter changes */
  onProjectChange?: (projectId: string | undefined) => void;
}

/**
 * Apply the two Inbox view filters without changing shared attention state.
 */
function filterSessions(
  items: InboxItem[],
  projectId: string | undefined,
  createdVia: InboxCreationFilter,
): InboxItem[] {
  return items.filter((item) => {
    if (projectId && item.projectId !== projectId) return false;
    const surface = item.creationProvenance?.surface;
    switch (createdVia) {
      case "ui":
        return surface === "web" || surface === "desktop";
      case "api":
        return surface === "api";
      case "unspecified":
        return !surface;
      default:
        return true;
    }
  });
}

/**
 * Shared inbox content component.
 * Displays inbox tiers, refresh button, and empty/loading/error states.
 * Uses InboxContext for data - filtering is done client-side.
 */
export function InboxContent({
  projectId,
  projects,
  onProjectChange,
}: InboxContentProps) {
  const { t } = useI18n();
  const basePath = useRemoteBasePath();
  const { settings: serverSettings } = useServerSettings();
  const { version } = useVersion();
  const [savedCreatedVia, setCreatedVia] = useInboxCreationFilter();
  const creationProvenanceAvailable = serverHasCapability(
    version,
    SESSION_CREATION_PROVENANCE_CAPABILITY,
  );
  const createdVia = creationProvenanceAvailable ? savedCreatedVia : "all";

  const publicShareManagementAvailable = serverHasCapability(
    version,
    PUBLIC_SHARE_MANAGEMENT_CAPABILITY,
  );
  const sourceReviewInboxEnabled =
    serverSettings?.sourceReviewSubmissionsEnabled ?? false;
  const [reviewInbox, setReviewInbox] = useState<ReviewInboxItem[]>([]);
  const [reviewInboxLoading, setReviewInboxLoading] = useState(false);
  const publicSharesEnabled = serverSettings?.publicSharesEnabled ?? false;
  const { status: publicShareStatus } = usePublicShareStatus({
    poll: publicSharesEnabled,
  });
  const publicShareCreationReady = publicShareStatus?.canCreate ?? false;
  const {
    needsAttention: allNeedsAttention,
    active: allActive,
    recentActivity: allRecentActivity,
    unread8h: allUnread8h,
    unread24h: allUnread24h,
    loading,
    error,
    refresh,
  } = useInboxContext();

  const needsAttention = filterSessions(
    allNeedsAttention,
    projectId,
    createdVia,
  );
  const active = filterSessions(allActive, projectId, createdVia);
  const recentActivity = filterSessions(
    allRecentActivity,
    projectId,
    createdVia,
  );
  const unread8h = filterSessions(allUnread8h, projectId, createdVia);
  const unread24h = filterSessions(allUnread24h, projectId, createdVia);

  const totalSessionItems =
    needsAttention.length +
    active.length +
    recentActivity.length +
    unread8h.length +
    unread24h.length;

  const [refreshing, setRefreshing] = useState(false);

  const loadReviewInbox = useCallback(async () => {
    if (!sourceReviewInboxEnabled) {
      setReviewInbox([]);
      setReviewInboxLoading(false);
      return;
    }
    setReviewInboxLoading(true);
    try {
      const result = await api.listReviewInbox();
      setReviewInbox(result.items);
    } finally {
      setReviewInboxLoading(false);
    }
  }, [sourceReviewInboxEnabled]);

  useEffect(() => {
    void loadReviewInbox().catch(() => {
      // The ordinary Inbox remains usable if the optional feed fails.
    });
    if (!sourceReviewInboxEnabled) return;
    return activityBus.on("review-response-changed", () => {
      void loadReviewInbox().catch(() => {
        // Preserve the last accepted outcome cards on transient failures.
      });
    });
  }, [loadReviewInbox, sourceReviewInboxEnabled]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        refresh(),
        loadReviewInbox().catch(() => {
          // The review feed is optional; retain its last accepted cards.
        }),
      ]);
    } finally {
      setRefreshing(false);
    }
  };

  // Background-held sessions leave Active for their own section; every other
  // count and lookup keeps treating them as Active rows.
  const tierData = splitInboxSections({
    needsAttention,
    active,
    recentActivity,
    unread8h,
    unread24h,
  });

  const visibleSessionProjectIds = useMemo(
    () => [
      ...new Set(
        [
          ...needsAttention,
          ...active,
          ...recentActivity,
          ...unread8h,
          ...unread24h,
        ]
          .map((item) => item.projectId)
          .filter(Boolean),
      ),
    ],
    [needsAttention, active, recentActivity, unread8h, unread24h],
  );
  const queueFeedProjectIds = useMemo(() => {
    if (projectId) return [projectId];
    if (projects && projects.length > 0) {
      return [...new Set(projects.map((project) => project.id))];
    }
    return visibleSessionProjectIds;
  }, [projectId, projects, visibleSessionProjectIds]);
  const projectNameById = useMemo(() => {
    const names = new Map(
      (projects ?? []).map((project) => [project.id, project.name]),
    );
    for (const item of [
      ...needsAttention,
      ...active,
      ...recentActivity,
      ...unread8h,
      ...unread24h,
    ]) {
      if (!names.has(item.projectId)) {
        names.set(item.projectId, item.projectName);
      }
    }
    return names;
  }, [projects, needsAttention, active, recentActivity, unread8h, unread24h]);
  // Keep the queue feed mounted for known inbox projects. Badge rendering
  // reads from the shared client summary store selector below, while new-session
  // queue items render as pending Active rows because they have no session yet.
  const projectQueues = useProjectQueues(queueFeedProjectIds);
  const rawProjectQueuedSessionIds = useProjectQueuedSessionIds(
    visibleSessionProjectIds,
  );
  const projectQueuedSessionIds = rawProjectQueuedSessionIds;
  const pendingNewSessionQueueItems = useMemo(
    () => projectQueues.items.filter(isPendingNewSessionProjectQueueItem),
    [projectQueues.items],
  );
  const filteredReviewInbox = useMemo(
    () =>
      projectId
        ? reviewInbox.filter((item) => item.projectId === projectId)
        : reviewInbox,
    [projectId, reviewInbox],
  );
  const reviewOutcomeCount = filteredReviewInbox.reduce(
    (count, item) => count + item.outcomes.length,
    0,
  );
  const totalItems =
    totalSessionItems + pendingNewSessionQueueItems.length + reviewOutcomeCount;

  const pageLoading =
    loading ||
    reviewInboxLoading ||
    (totalSessionItems === 0 &&
      pendingNewSessionQueueItems.length === 0 &&
      projectQueues.loading);
  const isEmpty = totalItems === 0 && !pageLoading;

  const drafts = useDraftSessionIds();

  // Build project options for FilterDropdown
  const projectOptions: FilterOption<string>[] = projects
    ? [
        { value: "", label: t("inboxAllProjects") },
        ...projects.map((p) => ({ value: p.id, label: p.name })),
      ]
    : [];

  const handleProjectSelect = (selected: string[]) => {
    const value = selected[0] ?? "";
    onProjectChange?.(value === "" ? undefined : value);
  };

  return (
    <main className="page-scroll-container">
      <div className={`page-content-inner ${styles.root}`}>
        <div className={`inbox-toolbar ${styles.toolbar}`}>
          <SessionAsyncQuestionsButton
            projectId={projectId}
            basePath={basePath}
          />
          {projects && projects.length > 0 && (
            <FilterDropdown
              label={t("inboxFilterProject")}
              options={projectOptions}
              selected={[projectId ?? ""]}
              onChange={handleProjectSelect}
              multiSelect={false}
              placeholder={t("inboxAllProjects")}
            />
          )}
          {creationProvenanceAvailable && (
            <FilterDropdown<InboxCreationFilter>
              label={t("inboxStartedVia")}
              placeholder={t("inboxAllSessions")}
              options={[
                {
                  value: "all",
                  label: t("inboxAllSessions"),
                  clearSelection: true,
                },
                { value: "ui", label: t("inboxStartedViaUi") },
                { value: "api", label: t("inboxStartedViaApi") },
                {
                  value: "unspecified",
                  label: t("inboxStartedViaUnspecified"),
                },
              ]}
              selected={createdVia === "all" ? [] : [createdVia]}
              onChange={(selected) => setCreatedVia(selected[0] ?? "all")}
              multiSelect={false}
            />
          )}
          <Button
            onClick={handleRefresh}
            disabled={refreshing || loading}
            busy={refreshing}
          >
            {!refreshing && (
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            )}
            {refreshing ? t("inboxRefreshing") : t("inboxRefresh")}
          </Button>
        </div>

        {pageLoading && <p className="loading">{t("inboxLoading")}</p>}

        {error && (
          <Banner tone="error">
            {t("inboxError", { message: error.message })}
          </Banner>
        )}

        {!pageLoading && !error && isEmpty && (
          <div className="inbox-empty">
            <svg
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            <h3>
              {t(
                createdVia === "all"
                  ? "inboxEmptyTitle"
                  : "inboxFilteredEmptyTitle",
              )}
            </h3>
            <p>
              {createdVia !== "all"
                ? t("inboxFilteredEmptyDescription")
                : projectId
                  ? t("inboxEmptyDescriptionProject")
                  : t("inboxEmptyDescription")}
            </p>
          </div>
        )}

        {!pageLoading && !error && !isEmpty && (
          <div className={styles.tiers}>
            {filteredReviewInbox.length > 0 && (
              <ReviewOutcomeSection
                items={filteredReviewInbox}
                basePath={basePath}
                hideProjectName={!!projectId}
              />
            )}
            {TIER_CONFIGS.map((config) => (
              <InboxSection
                key={config.key}
                config={config}
                items={tierData[config.key]}
                projectQueueItems={
                  config.key === "active" ? pendingNewSessionQueueItems : []
                }
                projectNameById={projectNameById}
                hideProjectName={!!projectId}
                basePath={basePath}
                drafts={drafts}
                projectQueuedSessionIds={projectQueuedSessionIds}
                publicShareCreationReady={publicShareCreationReady}
                publicShareManagementAvailable={publicShareManagementAvailable}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
