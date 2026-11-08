import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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

const MENU_WIDTH = 240;

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
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [routerConnected, setRouterConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const discovery = useRouterDiscovery(provider ?? null, anchor !== null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = () => {
    setAnchor(null);
    chipRef.current?.focus();
  };

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

  // Keyboard: focus enters the menu, arrows move, Escape returns to the chip.
  const items = () =>
    Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        "[role^=menuitem]:not(:disabled)",
      ) ?? [],
    );
  // biome-ignore lint/correctness/useExhaustiveDependencies: refocus once the accounts load
  useEffect(() => {
    if (anchor && !menuRef.current?.contains(document.activeElement))
      items()[0]?.focus();
  }, [anchor, discovery.loaded]);
  useEffect(() => {
    if (!anchor) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setAnchor(null);
        chipRef.current?.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const list = items();
      const at = list.indexOf(document.activeElement as HTMLButtonElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      list[(at + step + list.length) % list.length]?.focus();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [anchor]);

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
    close();
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
  const left = anchor
    ? Math.max(8, Math.min(anchor.left, window.innerWidth - MENU_WIDTH - 8))
    : 0;

  return (
    <>
      <ButtonBase
        ref={chipRef}
        className={className}
        title={chip.tooltip}
        aria-label={chip.tooltip}
        aria-haspopup={canSwitch ? "menu" : undefined}
        aria-expanded={canSwitch ? anchor !== null : undefined}
        disabled={busy}
        onClick={(event) => {
          if (!canSwitch) onDetails();
          else setAnchor(event.currentTarget.getBoundingClientRect());
        }}
      >
        {busy ? t("routerSwitching") : chip.label}
      </ButtonBase>
      {anchor &&
        createPortal(
          <>
            <ButtonBase
              className={styles.overlay}
              aria-label={t("routerSwitchMenuDismiss")}
              tabIndex={-1}
              onClick={close}
            />
            <div
              ref={menuRef}
              className={styles.menu}
              role="menu"
              aria-label={t("routerSwitchMenuLabel")}
              style={{ left, top: anchor.bottom + 4 }}
            >
              {!discovery.loaded && (
                <div className={styles.heading}>{t("routerSwitchLoading")}</div>
              )}
              {discovery.loaded && !pools.length && (
                <div className={styles.heading}>
                  {discovery.error
                    ? t("routerSwitchUnavailable")
                    : t("routerSwitchNoPools")}
                </div>
              )}
              {pools.map((pool) => (
                <div key={pool.id} role="group" aria-label={pool.name}>
                  <div className={styles.heading}>{pool.name}</div>
                  {routedAccounts(
                    discovery.data,
                    provider ?? null,
                    pool.id,
                  ).map((account) => {
                    const current =
                      binding?.poolId === pool.id &&
                      binding.accountId === account.id;
                    return (
                      <ButtonBase
                        key={account.id}
                        role="menuitemradio"
                        aria-checked={current}
                        disabled={current}
                        onClick={() =>
                          void pick({
                            routerPoolId: pool.id,
                            routerAccountId: account.id,
                          })
                        }
                      >
                        {account.displayName ?? account.id}
                      </ButtonBase>
                    );
                  })}
                </div>
              ))}
              <div className={styles.separator} />
              <ButtonBase
                role="menuitemradio"
                aria-checked={!binding}
                disabled={!binding}
                onClick={() => void pick(null)}
              >
                {t("routerSwitchDirect")}
              </ButtonBase>
              <div className={styles.separator} />
              <ButtonBase
                role="menuitem"
                onClick={() => {
                  close();
                  onDetails();
                }}
              >
                {t("routerSwitchDetails")}
              </ButtonBase>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
