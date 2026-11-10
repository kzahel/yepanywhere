import { useState } from "react";
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
import styles from "./SessionRouterAccountPane.module.css";
import { Banner } from "./ui/Banner";
import { Button } from "./ui/Button";
import { Spinner } from "./ui/Spinner";

/** The single account-switching surface for an existing session. */
export function SessionRouterAccountPane({
  sessionId,
  binding,
  provider,
  canSwitch: eligible,
  onSwitched,
}: {
  sessionId: string;
  binding: RouterBinding | undefined;
  provider: string;
  canSwitch: boolean;
  onSwitched: () => void;
}) {
  const { t } = useI18n();
  const { showToast } = useToastContext();
  const { principal } = useActingPrincipal();
  const canSwitch = eligible && principal.username === null;
  const discovery = useRouterDiscovery(provider, canSwitch);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pools = (discovery.data?.pools ?? []).filter(
    (pool) => pool.provider === provider,
  );
  const pick = async (
    target: { routerPoolId: string; routerAccountId: string } | null,
  ) => {
    if (busy || !canSwitch) return;
    setBusy(true);
    setError(null);
    try {
      await api.switchSessionRouterAccount(sessionId, target);
      onSwitched();
    } catch (error) {
      const message = t("routerSwitchFailed", {
        message: error instanceof Error ? error.message : String(error),
      });
      setError(message);
      showToast(message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.root}>
      <p className={styles.current}>
        {t("sessionAccountCurrent", {
          account: binding
            ? routerBindingChip(t, binding).label
            : t("routerSwitchDirect"),
        })}
      </p>
      <p className={styles.hint}>
        {t(canSwitch ? "sessionAccountSwitchHint" : "sessionAccountReadOnly")}
      </p>
      {error && <Banner tone="error">{error}</Banner>}
      {canSwitch && (
        <>
          {!discovery.loaded && (
            <span>
              <Spinner size="small" /> {t("routerSwitchLoading")}
            </span>
          )}
          {discovery.loaded && discovery.error && (
            <Banner tone="warning">{t("routerSwitchUnavailable")}</Banner>
          )}
          {discovery.loaded && !discovery.error && !pools.length && (
            <p>{t("routerSwitchNoPools")}</p>
          )}
          {pools.map((pool) => (
            <section
              key={pool.id}
              className={styles.pool}
              aria-label={pool.name}
            >
              <h3 className={styles.poolName}>{pool.name}</h3>
              <div className={styles.choices}>
                {routedAccounts(discovery.data, provider, pool.id).map(
                  (account) => {
                    const current =
                      binding?.poolId === pool.id &&
                      binding.accountId === account.id;
                    return (
                      <Button
                        key={account.id}
                        aria-pressed={current}
                        disabled={busy || current}
                        onClick={() =>
                          void pick({
                            routerPoolId: pool.id,
                            routerAccountId: account.id,
                          })
                        }
                      >
                        {account.displayName ?? account.id}
                        {current && <span aria-hidden="true"> ✓</span>}
                      </Button>
                    );
                  },
                )}
              </div>
            </section>
          ))}
          <section className={styles.pool} aria-label={t("routerSwitchDirect")}>
            <h3 className={styles.poolName}>
              {t("sessionAccountDirectHeading")}
            </h3>
            <div className={styles.choices}>
              <Button
                aria-pressed={!binding}
                disabled={busy || !binding}
                onClick={() => void pick(null)}
              >
                {t("routerSwitchDirect")}
                {!binding && <span aria-hidden="true"> ✓</span>}
              </Button>
            </div>
          </section>
          {busy && (
            <span role="status">
              <Spinner size="small" /> {t("routerSwitching")}
            </span>
          )}
        </>
      )}
    </div>
  );
}
