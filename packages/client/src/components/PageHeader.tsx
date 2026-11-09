import type { ReactNode } from "react";
import { useI18n } from "../i18n";
import { useNavigationLayout } from "../layouts";
import { truncateText } from "../lib/text";
import { HostIdentityMarker } from "./HostIdentityMarker";
import sessionHeaderStyles from "./SessionHeader.module.css";
import { SidebarLauncher } from "./SidebarLauncher";
import { ButtonBase, IconButton } from "./ui/Button";

interface PageHeaderProps {
  title: string;
  /** Optional custom element to render instead of the default title */
  titleElement?: ReactNode;
  /** Optional action for clicking the default title text */
  onTitleClick?: () => void;
  /** Show a back button instead of sidebar toggle */
  showBack?: boolean;
  /** Callback when back button is clicked */
  onBack?: () => void;
  /** Right-aligned header actions (same row as the title) */
  actions?: ReactNode;
}

const BackIcon = () => (
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
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

export function PageHeader({
  title,
  titleElement,
  onTitleClick,
  showBack = false,
  onBack,
  actions,
}: PageHeaderProps) {
  const { t } = useI18n();
  // Desktop keeps the toggle inside the sidebar itself in every display mode.
  // Read the layout here rather than trusting each page to pass it, so a page
  // header can never duplicate the sidebar's own toggle.
  const { isWideScreen, openSidebar } = useNavigationLayout();
  const handleToggle = isWideScreen ? undefined : openSidebar;
  const toggleTitle = t("actionOpenSidebar");
  const hasLeadingControl = Boolean((showBack && onBack) || handleToggle);

  return (
    <header className="session-header">
      <div
        className={`session-header-inner ${sessionHeaderStyles.row}${hasLeadingControl ? "" : ` ${sessionHeaderStyles.noLeadingControl}`}`}
      >
        <div className="session-header-left">
          {showBack && onBack ? (
            <IconButton
              label={t("actionBack")}
              className="sidebar-toggle"
              onClick={onBack}
            >
              <BackIcon />
            </IconButton>
          ) : (
            handleToggle && (
              <SidebarLauncher
                label={toggleTitle}
                newSessionLabel={t("sidebarNewSession")}
                onActivate={handleToggle}
              />
            )
          )}
          <HostIdentityMarker />
          {titleElement ??
            (onTitleClick ? (
              <ButtonBase
                className="session-title"
                onClick={onTitleClick}
                title={title.length > 60 ? title : undefined}
              >
                {truncateText(title)}
              </ButtonBase>
            ) : (
              <span
                className="session-title"
                title={title.length > 60 ? title : undefined}
              >
                {truncateText(title)}
              </span>
            ))}
        </div>
        {actions && <div className="session-header-actions">{actions}</div>}
      </div>
    </header>
  );
}
