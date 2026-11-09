import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useToastContext } from "../contexts/ToastContext";
import { useActingPrincipal } from "../hooks/useActingPrincipal";
import { useRouterDiscovery } from "../hooks/useRouterDiscovery";
import { useI18n } from "../i18n";
import {
  type RouterBinding,
  routedAccounts,
  routerBindingChip,
} from "./RouterPoolSelector";
import styles from "./SessionRouterAccountChip.module.css";
import { ButtonBase } from "./ui/Button";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuSeparator,
  useMenuTrigger,
} from "./ui/Menu";

/**
 * The session header's router account chip. With the switch capability it
 * opens a menu of the provider's pool accounts and Direct; picking one moves
 * the session there (its process is killed, the next message resumes on the
 * new account). Otherwise it opens session info, as before
 * (docs/tactical/185-switch-session-router-account.md).
 */
export function SessionRouterAccountChip({
  sessionId,
  binding,
  provider,
  canSwitch: serverCanSwitch,
  className,
  onDetails,
  onSwitched,
}: {
  sessionId: string;
  binding: RouterBinding | undefined;
  provider: string | undefined;
  /** The server can switch, and this session could be routed. */
  canSwitch: boolean;
  className?: string;
  onDetails: () => void;
  onSwitched: () => void;
}) {
  const { t } = useI18n();
  const { showToast } = useToastContext();
  // The switch route is owner-only; a limited user keeps the info shortcut.
  const { principal } = useActingPrincipal();
  const canSwitch = serverCanSwitch && principal.username === null;
  const menu = useMenuTrigger();
  const [routerConnected, setRouterConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const discovery = useRouterDiscovery(provider ?? null, menu.open);

  // A direct session shows the chip only while a router is connected.
  useEffect(() => {
    if (binding || !canSwitch) return;
    let live = true;
    api
      .routerStatus()
      .then((status) => {
        if (live) setRouterConnected(status.state === "connected");
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [binding, canSwitch]);

  if (!binding && !(canSwitch && routerConnected)) return null;
  const chip = binding
    ? routerBindingChip(
        t,
        binding,
        canSwitch ? "routerChipTooltipSwitch" : "routerChipTooltipOpen",
      )
    : { label: t("routerSwitchDirect"), tooltip: t("routerSwitchDirectTitle") };

  const pick = async (
    target: { routerPoolId: string; routerAccountId: string } | null,
  ) => {
    menu.close();
    setBusy(true);
    try {
      await api.switchSessionRouterAccount(sessionId, target);
      onSwitched();
    } catch (error) {
      showToast(
        t("routerSwitchFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  const pools = (discovery.data?.pools ?? []).filter(
    (pool) => pool.provider === provider,
  );

  return (
    <>
      <ButtonBase
        ref={menu.anchorRef}
        className={className}
        title={chip.tooltip}
        aria-label={chip.tooltip}
        aria-haspopup={canSwitch ? "menu" : undefined}
        aria-expanded={canSwitch ? menu.open : undefined}
        disabled={busy}
        onClick={() => {
          if (!canSwitch) onDetails();
          else menu.setOpen(!menu.open);
        }}
        onKeyDown={canSwitch ? menu.triggerProps.onKeyDown : undefined}
      >
        {busy ? t("routerSwitching") : chip.label}
      </ButtonBase>
      {canSwitch && (
        <Menu
          open={menu.open}
          onClose={menu.close}
          anchorRef={menu.anchorRef}
          placement="bottom-start"
          aria-label={t("routerSwitchMenuLabel")}
          className={styles.menu}
        >
          {!discovery.loaded && (
            <MenuItem disabled>{t("routerSwitchLoading")}</MenuItem>
          )}
          {discovery.loaded && !pools.length && (
            <MenuItem disabled>
              {discovery.error
                ? t("routerSwitchUnavailable")
                : t("routerSwitchNoPools")}
            </MenuItem>
          )}
          {pools.map((pool) => (
            <MenuGroup key={pool.id} label={pool.name}>
              {routedAccounts(discovery.data, provider ?? null, pool.id).map(
                (account) => {
                  const current =
                    binding?.poolId === pool.id &&
                    binding.accountId === account.id;
                  return (
                    <MenuItem
                      key={account.id}
                      kind="radio"
                      checked={current}
                      disabled={current}
                      onSelect={() =>
                        void pick({
                          routerPoolId: pool.id,
                          routerAccountId: account.id,
                        })
                      }
                    >
                      {account.displayName ?? account.id}
                    </MenuItem>
                  );
                },
              )}
            </MenuGroup>
          ))}
          <MenuSeparator />
          <MenuItem
            kind="radio"
            checked={!binding}
            disabled={!binding}
            onSelect={() => void pick(null)}
          >
            {t("routerSwitchDirect")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            onSelect={() => {
              menu.close();
              onDetails();
            }}
          >
            {t("routerSwitchDetails")}
          </MenuItem>
        </Menu>
      )}
    </>
  );
}
