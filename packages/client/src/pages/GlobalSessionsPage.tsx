import { ALL_PROVIDERS, type ProviderName } from "@yep-anywhere/shared";
import { useCallback, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { type GlobalSessionItem, api } from "../api/client";
import { BulkActionBar } from "../components/BulkActionBar";
import {
  FilterDropdown,
  type FilterOption,
} from "../components/FilterDropdown";
import { PageHeader } from "../components/PageHeader";
import { SessionListItem } from "../components/SessionListItem";
import { useGlobalSessions } from "../hooks/useGlobalSessions";
import { useNavigationLayout } from "../layouts";
import { getSessionDisplayTitle, toUrlProjectId } from "../utils";

// Long-press threshold for entering selection mode on mobile
const LONG_PRESS_MS = 500;

// Status filter options
type StatusFilter = "all" | "unread" | "starred" | "archived";

// Provider colors for filter dropdown (matching ProviderBadge)
const PROVIDER_COLORS: Record<ProviderName, string> = {
  claude: "var(--app-yep-green)",
  codex: "#10a37f",
  "codex-oss": "#f97316",
  gemini: "#4285f4",
  opencode: "#9333ea", // Purple for OpenCode
};

/**
 * Global sessions page showing all sessions across all projects.
 * Supports filtering by project, status, provider, and search query.
 * Includes multi-select mode with bulk actions.
 */
export function GlobalSessionsPage() {
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();
  const [searchParams, setSearchParams] = useSearchParams();

  // Get filter params from URL
  const searchQuery = searchParams.get("q") || "";
  const projectFilter = searchParams.get("project") || undefined;

  // Local state for search input (instant feedback)
  const [searchInput, setSearchInput] = useState(searchQuery);

  // Status and provider filters from URL
  const statusFilters = useMemo(() => {
    const param = searchParams.get("status");
    if (!param) return [];
    return param
      .split(",")
      .filter((s): s is StatusFilter =>
        ["all", "unread", "starred", "archived"].includes(s),
      );
  }, [searchParams]);

  const providerFilters = useMemo(() => {
    const param = searchParams.get("provider");
    if (!param) return [];
    const knownProviders = Object.keys(PROVIDER_COLORS);
    return param
      .split(",")
      .filter((p): p is ProviderName => knownProviders.includes(p));
  }, [searchParams]);

  const setStatusFilters = useCallback(
    (filters: StatusFilter[]) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (filters.length > 0) {
          next.set("status", filters.join(","));
        } else {
          next.delete("status");
        }
        return next;
      });
    },
    [setSearchParams],
  );

  const setProviderFilters = useCallback(
    (filters: ProviderName[]) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (filters.length > 0) {
          next.set("provider", filters.join(","));
        } else {
          next.delete("provider");
        }
        return next;
      });
    },
    [setSearchParams],
  );

  // Include archived sessions when archived filter is selected
  const includeArchived = statusFilters.includes("archived");

  const { sessions, stats, projects, loading, error, hasMore, loadMore } =
    useGlobalSessions({
      projectId: projectFilter,
      searchQuery,
      includeArchived,
    });

  // Filter sessions based on status and provider filters (client-side)
  const filteredSessions = useMemo(() => {
    return sessions.filter((session) => {
      // Status filtering (empty = show all non-archived)
      if (statusFilters.length === 0) {
        // Default: show non-archived
        if (session.isArchived) return false;
      } else {
        // Check if session matches any selected status filter
        let matchesStatus = false;
        for (const status of statusFilters) {
          switch (status) {
            case "all":
              if (!session.isArchived) matchesStatus = true;
              break;
            case "unread":
              if (session.hasUnread && !session.isArchived)
                matchesStatus = true;
              break;
            case "starred":
              if (session.isStarred) matchesStatus = true;
              break;
            case "archived":
              if (session.isArchived) matchesStatus = true;
              break;
          }
        }
        if (!matchesStatus) return false;
      }

      // Provider filtering (empty = show all providers)
      if (providerFilters.length > 0) {
        if (!session.provider || !providerFilters.includes(session.provider)) {
          return false;
        }
      }

      return true;
    });
  }, [sessions, statusFilters, providerFilters]);

  // Build status filter options with global counts from server
  // When filtering by project, we don't have global stats, so omit counts
  const statusOptions = useMemo((): FilterOption<StatusFilter>[] => {
    // Only show counts when not filtering by project (global view)
    const showCounts = !projectFilter;

    return [
      {
        value: "all",
        label: "All",
        count: showCounts ? stats.totalCount : undefined,
      },
      {
        value: "unread",
        label: "Unread",
        count: showCounts ? stats.unreadCount : undefined,
      },
      {
        value: "starred",
        label: "Starred",
        count: showCounts ? stats.starredCount : undefined,
      },
      {
        value: "archived",
        label: "Archived",
        count: showCounts ? stats.archivedCount : undefined,
      },
    ];
  }, [stats, projectFilter]);

  // Build provider filter options with global counts from server
  // When filtering by project, we don't have global stats, so omit counts
  const providerOptions = useMemo((): FilterOption<ProviderName>[] => {
    const showCounts = !projectFilter;
    const providerCounts = stats.providerCounts;

    // Only show providers that have sessions
    const options: FilterOption<ProviderName>[] = [];
    for (const provider of ALL_PROVIDERS) {
      const count = providerCounts[provider];
      if (count && count > 0) {
        options.push({
          value: provider,
          label: provider.charAt(0).toUpperCase() + provider.slice(1),
          count: showCounts ? count : undefined,
          color: PROVIDER_COLORS[provider],
        });
      }
    }
    return options;
  }, [stats.providerCounts, projectFilter]);

  // Selection state for multi-select mode
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [isBulkActionPending, setIsBulkActionPending] = useState(false);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressSessionRef = useRef<string | null>(null);
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);

  // Selection handlers
  const handleSelect = useCallback((sessionId: string, selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (selected) {
        next.add(sessionId);
      } else {
        next.delete(sessionId);
      }
      // Exit selection mode when nothing is selected
      if (next.size === 0) {
        setIsSelectionMode(false);
      }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedIds(new Set(filteredSessions.map((s) => s.id)));
    setIsSelectionMode(true);
  }, [filteredSessions]);

  const handleClearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setIsSelectionMode(false);
  }, []);

  // Long-press handlers for mobile selection mode
  const handleLongPressStart = useCallback(
    (sessionId: string, e: React.TouchEvent | React.MouseEvent) => {
      // Already in selection mode or on desktop - don't start long-press
      if (isSelectionMode || isWideScreen) return;

      // Record starting position to detect movement (scrolling)
      if ("touches" in e) {
        const touch = e.touches[0];
        if (touch) {
          touchStartPosRef.current = { x: touch.clientX, y: touch.clientY };
        }
      } else if ("clientX" in e) {
        touchStartPosRef.current = { x: e.clientX, y: e.clientY };
      }

      longPressSessionRef.current = sessionId;
      longPressTimerRef.current = setTimeout(() => {
        // Enter selection mode and select this session
        setIsSelectionMode(true);
        setSelectedIds(new Set([sessionId]));
        longPressSessionRef.current = null;
        touchStartPosRef.current = null;
      }, LONG_PRESS_MS);
    },
    [isSelectionMode, isWideScreen],
  );

  const handleLongPressEnd = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressSessionRef.current = null;
    touchStartPosRef.current = null;
  }, []);

  // Cancel long press if user moves finger (scrolling)
  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchStartPosRef.current || !longPressTimerRef.current) return;

    const touch = e.touches[0];
    if (!touch) return;

    const dx = touch.clientX - touchStartPosRef.current.x;
    const dy = touch.clientY - touchStartPosRef.current.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Cancel if moved more than 10px (scrolling threshold)
    if (distance > 10) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
      longPressSessionRef.current = null;
      touchStartPosRef.current = null;
    }
  }, []);

  // Prevent native context menu during long press
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      // Suppress context menu if long press is active or in selection mode
      if (longPressTimerRef.current || isSelectionMode) {
        e.preventDefault();
      }
    },
    [isSelectionMode],
  );

  // Bulk action handlers
  const handleBulkArchive = useCallback(async () => {
    if (isBulkActionPending) return;
    setIsBulkActionPending(true);
    try {
      await Promise.all(
        Array.from(selectedIds).map((id) =>
          api.updateSessionMetadata(id, { archived: true }),
        ),
      );
      handleClearSelection();
    } finally {
      setIsBulkActionPending(false);
    }
  }, [selectedIds, isBulkActionPending, handleClearSelection]);

  const handleBulkUnarchive = useCallback(async () => {
    if (isBulkActionPending) return;
    setIsBulkActionPending(true);
    try {
      await Promise.all(
        Array.from(selectedIds).map((id) =>
          api.updateSessionMetadata(id, { archived: false }),
        ),
      );
      handleClearSelection();
    } finally {
      setIsBulkActionPending(false);
    }
  }, [selectedIds, isBulkActionPending, handleClearSelection]);

  const handleBulkStar = useCallback(async () => {
    if (isBulkActionPending) return;
    setIsBulkActionPending(true);
    try {
      await Promise.all(
        Array.from(selectedIds).map((id) =>
          api.updateSessionMetadata(id, { starred: true }),
        ),
      );
      handleClearSelection();
    } finally {
      setIsBulkActionPending(false);
    }
  }, [selectedIds, isBulkActionPending, handleClearSelection]);

  const handleBulkUnstar = useCallback(async () => {
    if (isBulkActionPending) return;
    setIsBulkActionPending(true);
    try {
      await Promise.all(
        Array.from(selectedIds).map((id) =>
          api.updateSessionMetadata(id, { starred: false }),
        ),
      );
      handleClearSelection();
    } finally {
      setIsBulkActionPending(false);
    }
  }, [selectedIds, isBulkActionPending, handleClearSelection]);

  const handleBulkMarkRead = useCallback(async () => {
    if (isBulkActionPending) return;
    setIsBulkActionPending(true);
    try {
      await Promise.all(
        Array.from(selectedIds).map((id) => api.markSessionSeen(id)),
      );
      handleClearSelection();
    } finally {
      setIsBulkActionPending(false);
    }
  }, [selectedIds, isBulkActionPending, handleClearSelection]);

  const handleBulkMarkUnread = useCallback(async () => {
    if (isBulkActionPending) return;
    setIsBulkActionPending(true);
    try {
      await Promise.all(
        Array.from(selectedIds).map((id) => api.markSessionUnread(id)),
      );
      handleClearSelection();
    } finally {
      setIsBulkActionPending(false);
    }
  }, [selectedIds, isBulkActionPending, handleClearSelection]);

  // Compute which bulk actions are applicable based on selection
  const bulkActionState = useMemo(() => {
    const selectedSessions = sessions.filter((s) => selectedIds.has(s.id));
    return {
      canArchive: selectedSessions.some((s) => !s.isArchived),
      canUnarchive: selectedSessions.some((s) => s.isArchived),
      canStar: selectedSessions.some((s) => !s.isStarred),
      canUnstar: selectedSessions.some((s) => s.isStarred),
      canMarkRead: selectedSessions.some((s) => s.hasUnread),
      canMarkUnread: selectedSessions.some((s) => !s.hasUnread),
    };
  }, [sessions, selectedIds]);

  // Handle search form submit
  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const newParams = new URLSearchParams(searchParams);
    if (searchInput.trim()) {
      newParams.set("q", searchInput.trim());
    } else {
      newParams.delete("q");
    }
    setSearchParams(newParams);
  };

  // Handle project filter change
  const handleProjectFilter = useCallback(
    (selected: string[]) => {
      const newParams = new URLSearchParams(searchParams);
      if (selected.length > 0 && selected[0]) {
        newParams.set("project", selected[0]);
      } else {
        newParams.delete("project");
      }
      setSearchParams(newParams);
    },
    [searchParams, setSearchParams],
  );

  // Build project filter options
  const projectOptions = useMemo((): FilterOption<string>[] => {
    return projects.map((project) => ({
      value: project.id,
      label: project.name,
    }));
  }, [projects]);

  // Clear all filters
  const clearFilters = () => {
    setSearchInput("");
    setSearchParams(new URLSearchParams());
  };

  const isEmpty = filteredSessions.length === 0;
  const hasFilters =
    searchQuery ||
    projectFilter ||
    statusFilters.length > 0 ||
    providerFilters.length > 0;

  return (
    <div
      className={isWideScreen ? "main-content-wrapper" : "main-content-mobile"}
    >
      <div
        className={
          isWideScreen
            ? "main-content-constrained"
            : "main-content-mobile-inner"
        }
      >
        <PageHeader
          title="All Sessions"
          onOpenSidebar={openSidebar}
          onToggleSidebar={toggleSidebar}
          isWideScreen={isWideScreen}
          isSidebarCollapsed={isSidebarCollapsed}
        />

        <main className="page-scroll-container">
          <div className="page-content-inner">
            {/* Filter bar */}
            <div className="filter-bar">
              <form onSubmit={handleSearch} className="filter-search-form">
                <input
                  type="text"
                  className="filter-search"
                  placeholder="Search sessions..."
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                />
                <button type="submit" className="filter-search-button">
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
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                </button>
              </form>
              <div className="filter-dropdowns">
                {projectOptions.length > 0 && (
                  <FilterDropdown
                    label="Project"
                    options={projectOptions}
                    selected={projectFilter ? [projectFilter] : []}
                    onChange={handleProjectFilter}
                    multiSelect={false}
                    placeholder="All projects"
                  />
                )}
                <FilterDropdown
                  label="Status"
                  options={statusOptions}
                  selected={statusFilters}
                  onChange={setStatusFilters}
                  placeholder="All statuses"
                />
                {providerOptions.length > 1 && (
                  <FilterDropdown
                    label="Provider"
                    options={providerOptions}
                    selected={providerFilters}
                    onChange={setProviderFilters}
                    placeholder="All providers"
                  />
                )}
              </div>
              {hasFilters && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="filter-clear-button"
                >
                  Clear filters
                </button>
              )}
            </div>

            {loading && sessions.length === 0 && (
              <p className="loading">Loading sessions...</p>
            )}

            {error && (
              <p className="error">Error loading sessions: {error.message}</p>
            )}

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
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                <h3>No sessions found</h3>
                <p>
                  {hasFilters
                    ? "Try adjusting your search or filters."
                    : "Start a new session to get started."}
                </p>
              </div>
            )}

            {!error && !isEmpty && (
              <>
                {/* Select all header (desktop or when in selection mode) */}
                {(isWideScreen || isSelectionMode) &&
                  filteredSessions.length > 0 && (
                    <div className="session-list-header">
                      <label className="session-list-header__select-all">
                        <input
                          type="checkbox"
                          checked={
                            selectedIds.size === filteredSessions.length &&
                            filteredSessions.length > 0
                          }
                          onChange={(e) =>
                            e.target.checked
                              ? handleSelectAll()
                              : handleClearSelection()
                          }
                        />
                        <span>
                          {selectedIds.size > 0
                            ? `${selectedIds.size} selected`
                            : "Select all"}
                        </span>
                      </label>
                    </div>
                  )}

                <ul
                  className={`session-list ${isSelectionMode ? "session-list--selection-mode" : ""}`}
                >
                  {filteredSessions.map((session) => (
                    <div
                      key={session.id}
                      onTouchStart={(e) => handleLongPressStart(session.id, e)}
                      onTouchMove={handleTouchMove}
                      onTouchEnd={handleLongPressEnd}
                      onTouchCancel={handleLongPressEnd}
                      onMouseDown={(e) =>
                        !isWideScreen && handleLongPressStart(session.id, e)
                      }
                      onMouseUp={handleLongPressEnd}
                      onMouseLeave={handleLongPressEnd}
                      onContextMenu={handleContextMenu}
                    >
                      <SessionListItem
                        sessionId={session.id}
                        projectId={session.projectId}
                        title={getSessionDisplayTitle(session)}
                        fullTitle={getSessionDisplayTitle(session)}
                        updatedAt={session.updatedAt}
                        hasUnread={session.hasUnread}
                        processState={session.processState}
                        pendingInputType={session.pendingInputType}
                        status={session.status}
                        provider={session.provider}
                        isStarred={session.isStarred}
                        isArchived={session.isArchived}
                        mode="card"
                        showContextUsage={false}
                        isSelected={selectedIds.has(session.id)}
                        isSelectionMode={isSelectionMode && !isWideScreen}
                        onNavigate={() => {
                          // In selection mode on mobile, tap toggles selection
                          if (isSelectionMode && !isWideScreen) {
                            handleSelect(
                              session.id,
                              !selectedIds.has(session.id),
                            );
                          }
                        }}
                        onSelect={
                          isWideScreen || isSelectionMode
                            ? handleSelect
                            : undefined
                        }
                        showProjectName={!projectFilter}
                        projectName={session.projectName}
                      />
                    </div>
                  ))}
                </ul>

                {hasMore && (
                  <div className="global-sessions-load-more">
                    <button
                      type="button"
                      onClick={loadMore}
                      className="global-sessions-load-more-button"
                      disabled={loading}
                    >
                      {loading ? "Loading..." : "Load more"}
                    </button>
                  </div>
                )}
              </>
            )}

            {/* Bulk action bar */}
            <BulkActionBar
              selectedCount={selectedIds.size}
              onArchive={handleBulkArchive}
              onUnarchive={handleBulkUnarchive}
              onStar={handleBulkStar}
              onUnstar={handleBulkUnstar}
              onMarkRead={handleBulkMarkRead}
              onMarkUnread={handleBulkMarkUnread}
              onClearSelection={handleClearSelection}
              isPending={isBulkActionPending}
              canArchive={bulkActionState.canArchive}
              canUnarchive={bulkActionState.canUnarchive}
              canStar={bulkActionState.canStar}
              canUnstar={bulkActionState.canUnstar}
              canMarkRead={bulkActionState.canMarkRead}
              canMarkUnread={bulkActionState.canMarkUnread}
            />
          </div>
        </main>
      </div>
    </div>
  );
}
