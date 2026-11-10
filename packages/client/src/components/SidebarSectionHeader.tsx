import sidebarStyles from "./Sidebar.module.css";
import { ButtonBase } from "./ui/Button";

interface SidebarSectionHeaderProps {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  controlsId: string;
  expandLabel: string;
  collapseLabel: string;
  /** Rows in the section, shown only while it is collapsed. */
  count?: number;
  /** More rows exist than are loaded, so `count` is a lower bound. */
  countIsPartial?: boolean;
  /** A limited user's section: marked with a person glyph, name as typed. */
  isPerson?: boolean;
}

/**
 * The whole header row toggles its section. A chevron after the name points
 * down while open and right while closed; a closed section shows its count.
 * Rows below are never indented, so every section keeps the same left edge.
 */
export function SidebarSectionHeader({
  title,
  expanded,
  onToggle,
  controlsId,
  expandLabel,
  collapseLabel,
  count,
  countIsPartial = false,
  isPerson = false,
}: SidebarSectionHeaderProps) {
  const actionLabel = expanded ? collapseLabel : expandLabel;

  return (
    <h3 className={sidebarStyles.sectionHeading}>
      <ButtonBase
        className={sidebarStyles.sectionToggle}
        onClick={onToggle}
        data-expanded={expanded}
        aria-expanded={expanded}
        aria-controls={controlsId}
        aria-label={`${actionLabel}: ${title}`}
      >
        <span
          className={isPerson ? sidebarStyles.sectionTitleAsTyped : undefined}
        >
          {title}
        </span>
        {isPerson && (
          <svg
            className={sidebarStyles.sectionPersonGlyph}
            viewBox="0 0 10 10"
            aria-hidden="true"
          >
            <circle cx="5" cy="3.2" r="2" />
            <path d="M1.2 9.3C1.6 6.8 3.2 6 5 6s3.4.8 3.8 3.3" />
          </svg>
        )}
        <svg
          className={sidebarStyles.sectionChevron}
          viewBox="0 0 8 8"
          aria-hidden="true"
        >
          <path d="M1 2.5 4 5.5 7 2.5" />
        </svg>
        {!expanded && count !== undefined && (
          <span className={sidebarStyles.sectionCount} aria-hidden="true">
            {count}
            {countIsPartial ? "+" : ""}
          </span>
        )}
      </ButtonBase>
    </h3>
  );
}
