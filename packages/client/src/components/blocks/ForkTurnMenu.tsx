import { useSessionRewind } from "../../contexts/SessionRewindContext";
import { useI18n } from "../../i18n";
import { IconButton } from "../ui/Button";
import { Menu, MenuItem, MenuSeparator, useMenuTrigger } from "../ui/Menu";
import styles from "./ForkTurnMenu.module.css";

interface ForkTurnMenuProps {
  /** Render id of the turn; enables the index tooltip and Clear entries. */
  messageId?: string;
  onForkBefore?: () => void;
  onForkAfter?: () => void;
  onForkAfterSummary?: () => void;
  afterDisabled?: boolean;
  /** Keep the fork affordance visible while explaining a server upgrade gate. */
  unavailableMessage?: string;
}

export function ForkTurnMenu({
  messageId,
  onForkBefore,
  onForkAfter,
  onForkAfterSummary,
  afterDisabled = false,
  unavailableMessage,
}: ForkTurnMenuProps) {
  const { t } = useI18n();
  const rewind = useSessionRewind();
  const menu = useMenuTrigger();

  const turnIndex = messageId ? rewind.turnIndexById.get(messageId) : undefined;
  // Same-session Clear entries (topics/session-rewind.md § Turn menu). They
  // exist only where the session can be rewound in place, which the context
  // signals by supplying handlers.
  const onClearAfter =
    messageId && rewind.onClearAfter && !unavailableMessage
      ? () => rewind.onClearAfter?.(messageId)
      : undefined;
  const onClearReplacing =
    messageId && rewind.onClearReplacing && !unavailableMessage
      ? () => rewind.onClearReplacing?.(messageId)
      : undefined;

  const triggerLabel =
    turnIndex !== undefined
      ? t("forkTurnMenuLabelIndexed", { index: String(turnIndex) })
      : t("forkTurnMenuLabel");

  const forkGroup = !unavailableMessage && (onForkBefore || onForkAfter);
  return (
    <div className={styles.wrapper}>
      <IconButton
        variant="secondary"
        size="small"
        {...menu.triggerProps}
        className="user-prompt-action"
        label={triggerLabel}
        title={unavailableMessage ?? triggerLabel}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="6" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="12" r="3" />
          <path d="M6 9v6" />
          <path d="M8.5 7.5 15 11" />
        </svg>
      </IconButton>
      <Menu
        open={menu.open}
        onClose={menu.close}
        anchorRef={menu.anchorRef}
        placement="bottom-end"
        aria-label={triggerLabel}
      >
        {unavailableMessage ? (
          <MenuItem disabled>{unavailableMessage}</MenuItem>
        ) : null}
        {!unavailableMessage && onForkBefore && (
          <MenuItem onSelect={onForkBefore}>{t("forkTurnBefore")}</MenuItem>
        )}
        {!unavailableMessage && onForkAfter && (
          <MenuItem
            disabled={afterDisabled}
            tooltip={afterDisabled ? t("forkTurnAfterDisabled") : undefined}
            onSelect={onForkAfter}
          >
            {t("forkTurnAfter")}
          </MenuItem>
        )}
        {!unavailableMessage && onForkAfterSummary && (
          <>
            {forkGroup ? <MenuSeparator /> : null}
            <MenuItem
              disabled={afterDisabled}
              tooltip={afterDisabled ? t("forkTurnAfterDisabled") : undefined}
              onSelect={onForkAfterSummary}
            >
              {t("forkTurnAfterSummary")}
            </MenuItem>
          </>
        )}
        {(onClearAfter || onClearReplacing) &&
        (forkGroup || onForkAfterSummary) ? (
          <MenuSeparator />
        ) : null}
        {onClearAfter && (
          <MenuItem
            disabled={afterDisabled}
            tooltip={
              afterDisabled
                ? t("forkTurnAfterDisabled")
                : t("rewindClearAfterTurnTooltip", {
                    index: String(turnIndex ?? ""),
                  })
            }
            onSelect={onClearAfter}
          >
            {t("rewindClearAfterTurn")}
          </MenuItem>
        )}
        {onClearReplacing && (
          <MenuItem
            disabled={afterDisabled}
            tooltip={
              afterDisabled
                ? t("forkTurnAfterDisabled")
                : t("rewindClearReplacingTurnTooltip")
            }
            onSelect={onClearReplacing}
          >
            {t("rewindClearReplacingTurn")}
          </MenuItem>
        )}
      </Menu>
    </div>
  );
}
