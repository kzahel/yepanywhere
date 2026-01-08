import { useState } from "react";
import { Link } from "react-router-dom";
import { type InboxItem, useInboxContext } from "../contexts/InboxContext";
import type { Project } from "../types";
import { FilterDropdown, type FilterOption } from "./FilterDropdown";
import { ThinkingIndicator } from "./ThinkingIndicator";

/**
 * Format relative time from a timestamp to now.
 */
function formatRelativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/**
 * Tier configuration for visual styling.
 */
interface TierConfig {
  key: string;
  title: string;
  colorClass: string;
  getBadge?: (item: InboxItem) => { label: string; className: string } | null;
}

const TIER_CONFIGS: TierConfig[] = [
  {
    key: "needsAttention",
    title: "Needs Attention",
    colorClass: "inbox-tier-attention",
    getBadge: (item) => {
      if (item.pendingInputType === "tool-approval") {
        return { label: "Approval", className: "inbox-badge-approval" };
      }
      if (item.pendingInputType === "user-question") {
        return { label: "Question", className: "inbox-badge-question" };
      }
      return null;
    },
  },
  {
    key: "active",
    title: "Active",
    colorClass: "inbox-tier-active",
    // Active items show a pulsing dot instead of a text badge
  },
  {
    key: "recentActivity",
    title: "Recent Activity",
    colorClass: "inbox-tier-recent",
  },
  {
    key: "unread8h",
    title: "Unread (8h)",
    colorClass: "inbox-tier-unread8h",
  },
  {
    key: "unread24h",
    title: "Unread (24h)",
    colorClass: "inbox-tier-unread24h",
  },
];

interface InboxSectionProps {
  config: TierConfig;
  items: InboxItem[];
  /** When true, hides project name (for single-project inbox) */
  hideProjectName?: boolean;
}

function InboxSection({ config, items, hideProjectName }: InboxSectionProps) {
  const isEmpty = items.length === 0;

  return (
    <section
      className={`inbox-section ${config.colorClass} ${isEmpty ? "inbox-section-empty" : ""}`}
    >
      <h2 className="inbox-section-header">
        {config.title}
        <span className="inbox-section-count">{items.length}</span>
      </h2>
      {isEmpty ? (
        <p className="inbox-section-empty-message">No sessions</p>
      ) : (
        <ul className="inbox-list">
          {items.map((item) => {
            const badge = config.getBadge?.(item);
            const liClassName = item.hasUnread ? "unread" : undefined;
            return (
              <li key={item.sessionId} className={liClassName}>
                <Link
                  to={`/projects/${item.projectId}/sessions/${item.sessionId}`}
                >
                  <div className="inbox-item-main">
                    <span className="inbox-item-title">
                      {item.sessionTitle ?? "Untitled"}
                    </span>
                    {badge && (
                      <span className={`inbox-item-badge ${badge.className}`}>
                        {badge.label}
                      </span>
                    )}
                    {config.key === "active" && <ThinkingIndicator />}
                  </div>
                  <div className="inbox-item-meta">
                    {!hideProjectName && (
                      <span className="inbox-item-project">
                        {item.projectName}
                      </span>
                    )}
                    <span className="inbox-item-time">
                      {formatRelativeTime(item.updatedAt)}
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
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
 * Filter inbox items by project ID.
 */
function filterByProject(
  items: InboxItem[],
  projectId: string | undefined,
): InboxItem[] {
  if (!projectId) return items;
  return items.filter((item) => item.projectId === projectId);
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

  // Filter by project if specified
  const needsAttention = filterByProject(allNeedsAttention, projectId);
  const active = filterByProject(allActive, projectId);
  const recentActivity = filterByProject(allRecentActivity, projectId);
  const unread8h = filterByProject(allUnread8h, projectId);
  const unread24h = filterByProject(allUnread24h, projectId);

  const totalItems =
    needsAttention.length +
    active.length +
    recentActivity.length +
    unread8h.length +
    unread24h.length;

  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  };

  // Map tier keys to their data
  const tierData: Record<string, InboxItem[]> = {
    needsAttention,
    active,
    recentActivity,
    unread8h,
    unread24h,
  };

  const isEmpty = totalItems === 0 && !loading;

  // Build project options for FilterDropdown
  const projectOptions: FilterOption<string>[] = projects
    ? [
        { value: "", label: "All Projects" },
        ...projects.map((p) => ({ value: p.id, label: p.name })),
      ]
    : [];

  const handleProjectSelect = (selected: string[]) => {
    const value = selected[0] ?? "";
    onProjectChange?.(value === "" ? undefined : value);
  };

  return (
    <main className="page-scroll-container">
      <div className="page-content-inner inbox-content">
        {/* Toolbar with project filter and refresh button */}
        <div className="inbox-toolbar">
          {projects && projects.length > 0 && (
            <FilterDropdown
              label="Project"
              options={projectOptions}
              selected={[projectId ?? ""]}
              onChange={handleProjectSelect}
              multiSelect={false}
              placeholder="All Projects"
            />
          )}
          <button
            type="button"
            className="inbox-refresh-button"
            onClick={handleRefresh}
            disabled={refreshing || loading}
            title="Refresh inbox"
          >
            <svg
              className={refreshing ? "spinning" : ""}
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
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        {loading && <p className="loading">Loading inbox...</p>}

        {error && <p className="error">Error loading inbox: {error.message}</p>}

        {!loading && !error && isEmpty && (
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
            <h3>All caught up!</h3>
            <p>
              {projectId
                ? "No sessions need attention in this project."
                : "No sessions need attention."}
            </p>
          </div>
        )}

        {!loading && !error && !isEmpty && (
          <div className="inbox-tiers">
            {TIER_CONFIGS.map((config) => (
              <InboxSection
                key={config.key}
                config={config}
                items={tierData[config.key] ?? []}
                hideProjectName={!!projectId}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
