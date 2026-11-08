import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { loadSavedHosts, type SavedHost } from "../lib/hostStorage";
import styles from "./SwitchHostMenu.module.css";
import { ButtonBase } from "./ui/Button";

/** A saved relay host the menu can switch to by route. */
export type SwitchableRelayHost = SavedHost & { relayUsername: string };

/**
 * Saved relay hosts other than the current one, most recently connected
 * first, so the previous host is always the top entry.
 */
export function recentRelayHosts(
  currentRelayUsername: string | null,
): SwitchableRelayHost[] {
  return loadSavedHosts()
    .hosts.filter(
      (host): host is SwitchableRelayHost =>
        host.mode === "relay" &&
        !!host.relayUsername &&
        host.relayUsername !== currentRelayUsername,
    )
    .sort((a, b) =>
      (b.lastConnected ?? "").localeCompare(a.lastConnected ?? ""),
    );
}

const MENU_WIDTH = 220;
const ITEM_HEIGHT = 44;

/**
 * Recent-hosts menu for the sidebar Switch Host button. Picking a host only
 * reports it; the caller navigates to that host's relay route and the relay
 * gate reconnects with the saved session, falling back to its login form.
 */
export function SwitchHostMenu({
  anchor,
  hosts,
  onPick,
  onShowAll,
  onClose,
}: {
  anchor: DOMRect;
  hosts: SwitchableRelayHost[];
  onPick: (host: SwitchableRelayHost) => void;
  onShowAll: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  const select = (action: () => void) => {
    onClose();
    action();
  };

  // Open beside the button; the sidebar sits at the left edge.
  const left = Math.max(
    8,
    Math.min(anchor.right + 4, window.innerWidth - MENU_WIDTH - 8),
  );
  const height = 56 + (hosts.length + 1) * ITEM_HEIGHT;
  const top = Math.max(8, Math.min(anchor.top, window.innerHeight - height));

  return createPortal(
    <>
      <ButtonBase
        className={styles.overlay}
        aria-label={t("sidebarSwitchHostMenuDismiss")}
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div
        className={styles.menu}
        role="menu"
        aria-label={t("sidebarSwitchHostMenuLabel")}
        style={{ left, top }}
      >
        <div className={styles.heading}>{t("sidebarSwitchHostMenuLabel")}</div>
        {hosts.map((host) => (
          <button
            key={host.id}
            type="button"
            role="menuitem"
            className={styles.hostItem}
            onClick={() => select(() => onPick(host))}
          >
            <span>{host.displayName}</span>
            {host.displayName !== host.relayUsername && (
              <span className={styles.hostDetail}>{host.relayUsername}</span>
            )}
          </button>
        ))}
        {hosts.length > 0 && <div className={styles.separator} />}
        <button type="button" role="menuitem" onClick={() => select(onShowAll)}>
          {t("sidebarSwitchHostMenuAllHosts")}
        </button>
      </div>
    </>,
    document.body,
  );
}
