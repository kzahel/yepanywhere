import type { ProviderName } from "@yep-anywhere/shared";
import { useCallback, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { BulkActionBar } from "../components/BulkActionBar";
import {
  FilterDropdown,
  type FilterOption,
} from "../components/FilterDropdown";
import { NewSessionForm } from "../components/NewSessionForm";
import { PageHeader } from "../components/PageHeader";
import { SessionListItem } from "../components/SessionListItem";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useProjectLayout } from "../layouts";
import { getSessionDisplayTitle } from "../types";

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
};

export function SessionsPage() {
  const {
    projectId,
    project,
    sessions,
    loading,
    error,
    processStates,
    openSidebar,
    isWideScreen,
    toggleSidebar,
    isSidebarCollapsed,
    addOptimisticSession,
  } = useProjectLayout();

  // Filter state managed by URL query parameters
  const [searchParams, setSearchParams] = useSearchParams();

  // Search state managed locally
  const [searchQuery, setSearchQuery] = useState("");

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

    // We can't easily validate ProviderName at runtime without the list available at runtime
    // but assuming it's safe enough to cast for UI filters.
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

  // Selection state for multi-select mode
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [isBulkActionPending, setIsBulkActionPending] = useState(false);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressSessionRef = useRef<string | null>(null);
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);

  // Filter sessions based on search, status, and provider filters
  // Use the localSearchQuery for immediate feedback, or urlQuery?
  // If we use localSearchQuery, filtering happens instantly while typing (good).
  // If we use urlQuery, it lags (bad).
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

      // Filter by search query
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const title = getSessionDisplayTitle(session).toLowerCase();
        const fullTitle = (session.fullTitle ?? "").toLowerCase();
        if (!title.includes(query) && !fullTitle.includes(query)) {
          return false;
        }
      }

      return true;
    });
  }, [sessions, searchQuery, statusFilters, providerFilters]);

  // Build status filter options with counts
  const statusOptions = useMemo((): FilterOption<StatusFilter>[] => {
    const allCount = sessions.filter((s) => !s.isArchived).length;
    const unreadCount = sessions.filter(
      (s) => s.hasUnread && !s.isArchived,
    ).length;
    const starredCount = sessions.filter((s) => s.isStarred).length;
    const archivedCount = sessions.filter((s) => s.isArchived).length;

    return [
      { value: "all", label: "All", count: allCount },
      { value: "unread", label: "Unread", count: unreadCount },
      { value: "starred", label: "Starred", count: starredCount },
      { value: "archived", label: "Archived", count: archivedCount },
    ];
  }, [sessions]);

  // Build provider filter options with counts and colors
  const providerOptions = useMemo((): FilterOption<ProviderName>[] => {
    // Count sessions per provider
    const providerCounts: Partial<Record<ProviderName, number>> = {};
    for (const s of sessions) {
      if (s.provider && !s.isArchived) {
        providerCounts[s.provider] = (providerCounts[s.provider] ?? 0) + 1;
      }
    }

    // Only show providers that have sessions
    const options: FilterOption<ProviderName>[] = [];
    const providerOrder: ProviderName[] = [
      "claude",
      "codex",
      "codex-oss",
      "gemini",
    ];
    for (const provider of providerOrder) {
      const count = providerCounts[provider];
      if (count && count > 0) {
        options.push({
          value: provider,
          label: provider.charAt(0).toUpperCase() + provider.slice(1),
          count,
          color: PROVIDER_COLORS[provider],
        });
      }
    }
    return options;
  }, [sessions]);

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

  // Update browser tab title (project name only, no session)
  useDocumentTitle(project?.name);

  if (loading) return <div className="loading">Loading sessions...</div>;
  if (error) return <div className="error">Error: {error.message}</div>;

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
          title={project?.name ?? "Sessions"}
          onOpenSidebar={openSidebar}
          onToggleSidebar={toggleSidebar}
          isWideScreen={isWideScreen}
          isSidebarCollapsed={isSidebarCollapsed}
        />

        <main className="page-scroll-container">
          <div className="page-content-inner">
            <NewSessionForm
              projectId={projectId}
              onOptimisticSession={addOptimisticSession}
              compact
              rows={3}
              placeholder="Start a new session..."
              autoFocus={false}
            />

            <h2>Sessions</h2>

            {/* Filter bar */}
            <div className="filter-bar">
              <input
                type="text"
                className="filter-search"
                placeholder="Search sessions..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <div className="filter-dropdowns">
                <FilterDropdown
                  label="Status"
                  options={statusOptions}
                  selected={statusFilters}
                  onChange={setStatusFilters}
                  placeholder="All"
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
            </div>

            {sessions.length === 0 ? (
              <p>No sessions yet</p>
            ) : filteredSessions.length === 0 ? (
              <p className="no-results">No sessions match your filters</p>
            ) : (
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
                        session={session}
                        projectId={projectId}
                        mode="card"
                        processState={processStates[session.id]}
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
                      />
                    </div>
                  ))}
                </ul>
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
