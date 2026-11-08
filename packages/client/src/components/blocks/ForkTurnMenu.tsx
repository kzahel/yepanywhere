import { type CSSProperties, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSessionRewind } from "../../contexts/SessionRewindContext";
import { useI18n } from "../../i18n";
import { ButtonBase } from "../ui/Button";
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

const MENU_ITEM_HEIGHT = 40;

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
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, right: 8 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!isOpen) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setIsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setIsOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isOpen]);

  const openMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const itemCount =
        Number(Boolean(onForkBefore)) +
        Number(Boolean(onForkAfter)) +
        Number(Boolean(onForkAfterSummary)) +
        Number(Boolean(onClearAfter)) +
        Number(Boolean(onClearReplacing));
      const menuHeight = Math.max(1, itemCount) * MENU_ITEM_HEIGHT + 12;
      const top =
        rect.bottom + 8 + menuHeight <= window.innerHeight
          ? rect.bottom + 8
          : Math.max(8, rect.top - menuHeight - 8);
      setPosition({
        top,
        right: Math.max(8, window.innerWidth - rect.right),
      });
    }
    setIsOpen(true);
  };

  const run = (action: () => void) => {
    setIsOpen(false);
    action();
  };

  const triggerLabel =
    turnIndex !== undefined
      ? t("forkTurnMenuLabelIndexed", { index: String(turnIndex) })
      : t("forkTurnMenuLabel");

  const menu = (
    <div
      ref={menuRef}
      className={styles.menu}
      role="menu"
      style={
        {
          "--fork-turn-menu-top": `${position.top}px`,
          "--fork-turn-menu-right": `${position.right}px`,
        } as CSSProperties
      }
      aria-label={triggerLabel}
    >
      {unavailableMessage ? (
        <button type="button" role="menuitem" disabled>
          {unavailableMessage}
        </button>
      ) : null}
      {!unavailableMessage && onForkBefore && (
        <button type="button" role="menuitem" onClick={() => run(onForkBefore)}>
          {t("forkTurnBefore")}
        </button>
      )}
      {!unavailableMessage && onForkAfter && (
        <button
          type="button"
          role="menuitem"
          disabled={afterDisabled}
          title={afterDisabled ? t("forkTurnAfterDisabled") : undefined}
          onClick={() => run(onForkAfter)}
        >
          {t("forkTurnAfter")}
        </button>
      )}
      {!unavailableMessage && onForkAfterSummary && (
        <button
          type="button"
          role="menuitem"
          className={styles.secondary}
          disabled={afterDisabled}
          title={afterDisabled ? t("forkTurnAfterDisabled") : undefined}
          onClick={() => run(onForkAfterSummary)}
        >
          {t("forkTurnAfterSummary")}
        </button>
      )}
      {onClearAfter && (
        <button
          type="button"
          role="menuitem"
          className={styles.rewind}
          disabled={afterDisabled}
          title={
            afterDisabled
              ? t("forkTurnAfterDisabled")
              : t("rewindClearAfterTurnTooltip", {
                  index: String(turnIndex ?? ""),
                })
          }
          onClick={() => run(onClearAfter)}
        >
          {t("rewindClearAfterTurn")}
        </button>
      )}
      {onClearReplacing && (
        <button
          type="button"
          role="menuitem"
          className={styles.rewind}
          disabled={afterDisabled}
          title={
            afterDisabled
              ? t("forkTurnAfterDisabled")
              : t("rewindClearReplacingTurnTooltip")
          }
          onClick={() => run(onClearReplacing)}
        >
          {t("rewindClearReplacingTurn")}
        </button>
      )}
    </div>
  );

  return (
    <div className={styles.wrapper}>
      <ButtonBase
        ref={triggerRef}
        className="user-prompt-action"
        onClick={() => (isOpen ? setIsOpen(false) : openMenu())}
        aria-label={triggerLabel}
        title={unavailableMessage ?? triggerLabel}
        aria-haspopup="menu"
        aria-expanded={isOpen}
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
      </ButtonBase>
      {isOpen && createPortal(menu, document.body)}
    </div>
  );
}
