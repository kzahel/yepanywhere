import { useI18n } from "../i18n";
import { loadSavedHosts, type SavedHost } from "../lib/hostStorage";
import { Menu, MenuGroup, MenuItem, MenuSeparator } from "./ui/Menu";

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

  return (
    <Menu
      open
      onClose={onClose}
      anchorRect={anchor}
      // Open beside the button; the sidebar sits at the left edge.
      placement="right-start"
      aria-label={t("sidebarSwitchHostMenuLabel")}
    >
      <MenuGroup label={t("sidebarSwitchHostMenuLabel")}>
        {hosts.map((host) => (
          <MenuItem
            key={host.id}
            onSelect={() => onPick(host)}
            description={
              host.displayName !== host.relayUsername
                ? host.relayUsername
                : undefined
            }
          >
            {host.displayName}
          </MenuItem>
        ))}
      </MenuGroup>
      {hosts.length > 0 && <MenuSeparator />}
      <MenuItem onSelect={onShowAll}>
        {t("sidebarSwitchHostMenuAllHosts")}
      </MenuItem>
    </Menu>
  );
}
