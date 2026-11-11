import { useRef, useState } from "react";
import { api } from "../api/client";
import { useToastContext } from "../contexts/ToastContext";
import { useActingPrincipal } from "../hooks/useActingPrincipal";
import { useRouterDiscovery } from "../hooks/useRouterDiscovery";
import { useI18n } from "../i18n";
import { useClientSummarySourceKey } from "../lib/clientSummarySourceKey";
import {
  type RouterBinding,
  routedAccounts,
  routerBindingChip,
} from "./RouterPoolSelector";
import styles from "./SessionRouterAccountPane.module.css";
import { Banner } from "./ui/Banner";
import { Button } from "./ui/Button";
import { Field, Select } from "./ui/Field";
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
  const currentPoolId = binding ? (binding.poolId ?? "unpooled") : "";
  const source = useClientSummarySourceKey();
  const scope = `${source}:${sessionId}:${provider}:${binding?.id ?? "direct"}`;
  const [draft, setDraft] = useState<{
    scope: string;
    poolId: string;
    accountId: string;
  } | null>(null);
  const selection =
    draft?.scope === scope
      ? draft
      : {
          poolId: currentPoolId,
          accountId: binding?.accountId ?? "",
        };
  const [busy, setBusy] = useState(false);
  const switching = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const pools = (discovery.data?.pools ?? []).filter(
    (pool) => pool.provider === provider,
  );
  const pool = pools.find((item) => item.id === selection.poolId);
  const accounts = routedAccounts(discovery.data, provider, selection.poolId);
  const changed =
    selection.poolId !== currentPoolId ||
    selection.accountId !== (binding?.accountId ?? "");
  const valid =
    !selection.poolId ||
    Boolean(
      pool &&
        !discovery.error &&
        accounts.some((item) => item.id === selection.accountId),
    );
  const choose = (poolId: string, accountId: string) => {
    setDraft({ scope, poolId, accountId });
    setError(null);
  };
  const apply = async () => {
    if (switching.current || !canSwitch || !changed || !valid) return;
    const target = selection.poolId
      ? {
          routerPoolId: selection.poolId,
          routerAccountId: selection.accountId,
        }
      : null;
    switching.current = true;
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
      switching.current = false;
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
          <div className={styles.fields}>
            <Field label={t("sessionAccountPool")}>
              <Select
                className={styles.select}
                value={selection.poolId}
                disabled={busy}
                onChange={(event) => choose(event.target.value, "")}
              >
                <option value="">{t("sessionAccountDirectLogin")}</option>
                {selection.poolId && !pool && (
                  <option value={selection.poolId} disabled>
                    {selection.poolId === "unpooled"
                      ? t("sessionAccountUnpooled")
                      : binding?.poolId === selection.poolId
                        ? (binding.poolName ?? selection.poolId)
                        : selection.poolId}
                  </option>
                )}
                {pools.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
            </Field>
            {selection.poolId && (
              <Field label={t("routerAccount")}>
                <Select
                  className={styles.select}
                  value={selection.accountId}
                  disabled={
                    busy || !pool || discovery.error || !discovery.loaded
                  }
                  onChange={(event) =>
                    choose(selection.poolId, event.target.value)
                  }
                >
                  <option value="" disabled>
                    {t("sessionAccountChooseAccount")}
                  </option>
                  {selection.accountId &&
                    !accounts.some(
                      (item) => item.id === selection.accountId,
                    ) && (
                      <option value={selection.accountId} disabled>
                        {binding?.accountId === selection.accountId
                          ? (binding.accountDisplayName ?? selection.accountId)
                          : selection.accountId}
                      </option>
                    )}
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.displayName ?? account.id}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
          <p className={styles.hint}>{t("sessionAccountApplyTiming")}</p>
          <div className={styles.actions}>
            <Button
              variant="primary"
              busy={busy}
              disabled={!changed || !valid}
              onClick={() => void apply()}
            >
              {t(busy ? "routerSwitching" : "sessionAccountApply")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
