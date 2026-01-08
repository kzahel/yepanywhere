import type { ReactNode } from "react";
import { truncateText } from "../lib/text";

interface PageHeaderProps {
  title: string;
  /** Optional custom element to render instead of the default title */
  titleElement?: ReactNode;
  /** Mobile: opens the sidebar overlay */
  onOpenSidebar?: () => void;
  /** Desktop: toggles sidebar expanded/collapsed */
  onToggleSidebar?: () => void;
  /** Whether we're in desktop mode (wide screen) */
  isWideScreen?: boolean;
  /** Whether the sidebar is currently collapsed (desktop only) */
  isSidebarCollapsed?: boolean;
}

const SidebarToggleIcon = () => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="9" y1="3" x2="9" y2="21" />
  </svg>
);

export function PageHeader({
  title,
  titleElement,
  onOpenSidebar,
  onToggleSidebar,
  isWideScreen = false,
  isSidebarCollapsed = false,
}: PageHeaderProps) {
  // On desktop: toggle sidebar collapse. On mobile: open sidebar overlay
  // Hide the toggle on desktop when sidebar is collapsed (sidebar has its own toggle)
  const handleToggle = isWideScreen
    ? isSidebarCollapsed
      ? undefined
      : onToggleSidebar
    : onOpenSidebar;
  const toggleTitle = isWideScreen ? "Toggle sidebar" : "Open sidebar";

  return (
    <header className="session-header">
      <div className="session-header-inner">
        <div className="session-header-left">
          {handleToggle && (
            <button
              type="button"
              className="sidebar-toggle"
              onClick={handleToggle}
              title={toggleTitle}
              aria-label={toggleTitle}
            >
              <SidebarToggleIcon />
            </button>
          )}
          {titleElement ?? (
            <span
              className="session-title"
              title={title.length > 60 ? title : undefined}
            >
              {truncateText(title)}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
