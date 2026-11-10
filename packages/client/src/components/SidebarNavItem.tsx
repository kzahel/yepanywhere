import { IssueIcon } from "./IssueIcon";
import { type ReactNode, useRef } from "react";
import { useLongPress } from "../hooks/useLongPress";
import { Link, useLocation } from "react-router-dom";
import { ThinkingIndicator } from "./ThinkingIndicator";
import styles from "./SidebarNavItem.module.css";
import { Badge } from "./ui/Badge";
import { ButtonBase } from "./ui/Button";

/**
 * Common SVG icons used in sidebar navigation.
 * Extracted to avoid duplication across components.
 */
export const SidebarIcons = {
  issues: <IssueIcon />,
  bang: (
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
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <polyline points="6 9 9 12 6 15" />
      <line x1="12" y1="15" x2="17" y2="15" />
    </svg>
  ),
  inbox: (
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
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  ),
  projects: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  ),
  agents: (
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
      <rect x="3" y="11" width="18" height="10" rx="2" />
      <circle cx="12" cy="5" r="3" />
      <path d="M12 8v3" />
      <circle cx="8" cy="16" r="1" />
      <circle cx="16" cy="16" r="1" />
    </svg>
  ),
  settings: (
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
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  allSessions: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="9" y1="21" x2="9" y2="9" />
    </svg>
  ),
  newSession: (
    <svg
      className="sidebar-new-session-icon"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="12" fill="var(--app-yep-green)" />
      <line
        x1="12"
        y1="7"
        x2="12"
        y2="17"
        stroke="white"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <line
        x1="7"
        y1="12"
        x2="17"
        y2="12"
        stroke="white"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  ),
  sourceControl: (
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
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  ),
  recents: (
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
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  emulator: (
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
      <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
      <line x1="12" y1="18" x2="12" y2="18" />
    </svg>
  ),
};

export interface SidebarNavItemProps {
  accessory?: ReactNode;
  /** Route path to navigate to */
  to: string;
  /** Icon to display (use SidebarIcons or custom ReactNode) */
  icon: ReactNode;
  /** Label text */
  label: string;
  /** Optional badge count (displays if > 0) */
  badge?: number;
  /** Badge visual variant */
  badgeVariant?: "default" | "projectQueue";
  /** Optional badge tooltip */
  badgeTitle?: string;
  /** Called when item is clicked (e.g., to close mobile sidebar) */
  onClick?: () => void;
  /** Title tooltip */
  title?: string;
  /** Whether this item has an unsent draft */
  hasDraft?: boolean;
  /** Show pulsing activity indicator (e.g., for active agents) */
  hasActivityIndicator?: boolean;
  /** Base path prefix for relay mode (e.g., "/remote/my-server") */
  basePath?: string;
}

/**
 * Unified sidebar navigation item component.
 * Provides consistent styling across NavigationSidebar and Sidebar.
 */
export function SidebarNavItem({
  accessory,
  to,
  icon,
  label,
  badge,
  badgeVariant = "default",
  badgeTitle,
  onClick,
  title,
  hasDraft,
  hasActivityIndicator,
  basePath = "",
}: SidebarNavItemProps) {
  const location = useLocation();
  const fullPath = `${basePath}${to}`;
  const fullPathname = fullPath.split(/[?#]/)[0] || fullPath;
  const targetPathname = to.split(/[?#]/)[0] || to;
  // Check if current path matches (with or without basePath prefix)
  const isActive =
    location.pathname === fullPathname || location.pathname === targetPathname;

  const link = (
    <Link
      to={fullPath}
      data-sidebar-active={isActive || undefined}
      className={`${styles.sidebarNavItem} ${isActive ? styles.active : ""}`}
      data-sidebar-nav-item
      onClick={onClick}
      title={title ?? label}
    >
      {icon}
      <span className={styles.sidebarNavText} data-sidebar-nav-text>
        {label}
      </span>
      {hasDraft && (
        <Badge tone="warning" size="small">
          Draft
        </Badge>
      )}
      {hasActivityIndicator && <ThinkingIndicator />}
      {badge !== undefined && badge > 0 && (
        <Badge
          shape="count"
          size="small"
          tone={badgeVariant === "projectQueue" ? "neutral" : "accent"}
          emphasis={badgeVariant === "projectQueue" ? "soft" : "solid"}
          role={badgeTitle ? "img" : undefined}
          aria-label={badgeTitle}
          tooltip={badgeTitle}
          className={styles.badge}
          data-testid={`sidebar-nav-badge-${badgeVariant}`}
        >
          {badge}
        </Badge>
      )}
    </Link>
  );
  return accessory ? (
    <div className={styles.row}>
      {link}
      <span className={styles.accessory}>{accessory}</span>
    </div>
  ) : (
    link
  );
}

export interface SidebarNavButtonProps {
  /** Icon to display (use SidebarIcons or custom ReactNode) */
  icon: ReactNode;
  /** Label text (also the accessible name) */
  label: string;
  /** Action invoked on click */
  onClick: () => void;
  /** Title tooltip (defaults to label) */
  title?: string;
  /** Extra class names appended to sidebar-nav-item */
  className?: string;
  /** Secondary action on right-click or a held press, given the button's rect */
  onLongPress?: (anchor: HTMLElement) => void;
}

/**
 * Action variant of {@link SidebarNavItem}: emits the identical markup
 * (the `data-sidebar-nav-item` boundary, icon and `data-sidebar-nav-text`
 * label) as a <button> instead of a <Link>. Both share the module-owned
 * collapsed-rail icon-only presentation through `data-sidebar-collapsed`.
 */
export function SidebarNavButton({
  icon,
  label,
  onClick,
  title,
  className = "",
  onLongPress,
  ...buttonProps
}: SidebarNavButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const press = useLongPress(() => {
    const button = buttonRef.current;
    if (button) onLongPress?.(button);
  });
  return (
    <ButtonBase
      {...buttonProps}
      ref={buttonRef}
      className={`${styles.sidebarNavItem} ${className}`.trim()}
      data-sidebar-nav-item
      {...(onLongPress ? press.handlers : {})}
      onClick={onLongPress ? press.click(onClick) : onClick}
      aria-label={label}
      title={title ?? label}
    >
      {icon}
      <span className={styles.sidebarNavText} data-sidebar-nav-text>
        {label}
      </span>
    </ButtonBase>
  );
}

export interface SidebarNavSectionProps {
  children: ReactNode;
}

/**
 * Container for sidebar navigation items.
 * Provides consistent spacing between items.
 */
export function SidebarNavSection({ children }: SidebarNavSectionProps) {
  return (
    <nav className={styles.sidebarNavSection} data-sidebar-nav-section>
      {children}
    </nav>
  );
}
