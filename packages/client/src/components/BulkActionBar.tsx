import { useI18n } from "../i18n";
import styles from "./BulkActionBar.module.css";
import { Button, IconButton } from "./ui/Button";

interface BulkActionBarProps {
  selectedCount: number;
  onArchive: () => Promise<void>;
  onUnarchive: () => Promise<void>;
  onStar: () => Promise<void>;
  onUnstar: () => Promise<void>;
  onMarkRead: () => Promise<void>;
  onMarkUnread: () => Promise<void>;
  onClearSelection: () => void;
  isPending?: boolean;
  /** True if any selected item can be archived (is not archived) */
  canArchive?: boolean;
  /** True if any selected item can be unarchived (is archived) */
  canUnarchive?: boolean;
  /** True if any selected item can be starred (is not starred) */
  canStar?: boolean;
  /** True if any selected item can be unstarred (is starred) */
  canUnstar?: boolean;
  /** True if any selected item can be marked as read (has unread) */
  canMarkRead?: boolean;
  /** True if any selected item can be marked as unread (is read) */
  canMarkUnread?: boolean;
  /** Select all filtered sessions (shown when filters active, no selection) */
  onSelectAllFiltered?: () => void;
  /** Number of sessions in filtered results */
  filteredCount?: number;
}

/**
 * Fixed bottom bar for bulk session actions.
 * Slides up when sessions are selected, slides down when cleared.
 */
export function BulkActionBar({
  selectedCount,
  onArchive,
  onUnarchive,
  onStar,
  onUnstar,
  onMarkRead,
  onMarkUnread,
  onClearSelection,
  isPending = false,
  canArchive = true,
  canUnarchive = true,
  canStar = true,
  canUnstar = true,
  canMarkRead = true,
  canMarkUnread = true,
  onSelectAllFiltered,
  filteredCount = 0,
}: BulkActionBarProps) {
  const { t } = useI18n();
  // Show a filtered select-all shortcut when filters are active but no manual selection.
  if (selectedCount === 0) {
    if (!onSelectAllFiltered || filteredCount === 0) {
      return null;
    }

    return (
      <div className={`${styles.bar} ${styles.filtered}`}>
        <div className={styles.actions}>
          <Button
            variant="primary"
            className={styles.actionButton}
            onClick={onSelectAllFiltered}
            disabled={isPending}
            title={t("bulkSelectAllFilteredTitle", {
              count: filteredCount,
            })}
          >
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
              <polyline points="9 11 12 14 22 4" />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
            <span>{t("bulkSelectAllFiltered", { count: filteredCount })}</span>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.bar}>
      <div className={styles.info}>
        <span className={styles.count}>
          {t("bulkSelectedCount", { count: selectedCount })}
        </span>
        <IconButton
          size="small"
          label={t("bulkClearSelection")}
          onClick={onClearSelection}
          disabled={isPending}
        >
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
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </IconButton>
      </div>

      <div className={styles.actions}>
        {canArchive && (
          <Button
            className={styles.actionButton}
            onClick={onArchive}
            disabled={isPending}
            title={t("bulkArchiveSelected")}
          >
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
              <polyline points="21 8 21 21 3 21 3 8" />
              <rect x="1" y="3" width="22" height="5" />
              <line x1="10" y1="12" x2="14" y2="12" />
            </svg>
            <span>{t("bulkArchive")}</span>
          </Button>
        )}

        {canUnarchive && (
          <Button
            className={styles.actionButton}
            onClick={onUnarchive}
            disabled={isPending}
            title={t("bulkUnarchiveSelected")}
          >
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
              <polyline points="21 8 21 21 3 21 3 8" />
              <rect x="1" y="3" width="22" height="5" />
              <polyline points="12 11 12 17" />
              <polyline points="9 14 12 11 15 14" />
            </svg>
            <span>{t("bulkUnarchive")}</span>
          </Button>
        )}

        {canStar && (
          <Button
            className={styles.actionButton}
            onClick={onStar}
            disabled={isPending}
            title={t("bulkStarSelected")}
          >
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
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
            <span>{t("bulkStar")}</span>
          </Button>
        )}

        {canUnstar && (
          <Button
            className={styles.actionButton}
            onClick={onUnstar}
            disabled={isPending}
            title={t("bulkUnstarSelected")}
          >
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
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              <line x1="4" y1="4" x2="20" y2="20" />
            </svg>
            <span>{t("bulkUnstar")}</span>
          </Button>
        )}

        {canMarkRead && (
          <Button
            className={styles.actionButton}
            onClick={onMarkRead}
            disabled={isPending}
            title={t("bulkMarkReadTitle")}
          >
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
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            <span>{t("bulkMarkRead")}</span>
          </Button>
        )}

        {canMarkUnread && (
          <Button
            className={styles.actionButton}
            onClick={onMarkUnread}
            disabled={isPending}
            title={t("bulkMarkUnreadTitle")}
          >
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
              <circle cx="12" cy="12" r="4" fill="currentColor" />
            </svg>
            <span>{t("bulkMarkUnread")}</span>
          </Button>
        )}
      </div>
    </div>
  );
}
