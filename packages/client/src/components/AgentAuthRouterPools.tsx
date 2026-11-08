import { useCallback, useEffect, useRef, useState } from "react";
import {
  SERVER_CAPABILITIES,
  serverHasCapability,
  type AgentAuthRouterOverview,
  type AgentAuthRouterPoolInput,
} from "@yep-anywhere/shared";
import { api } from "../api/client";
import { useVersion } from "../hooks/useVersion";
import { useI18n } from "../i18n";
import { generateUUID } from "../lib/uuid";
import styles from "./AgentAuthRouterPools.module.css";
import { routerPolicyLabel } from "./RouterPoolSelector";
import { Button } from "./ui/Button";

const reasonKeys = {
  eligible: "routerPoolEligible",
  disabled: "routerAccountDisabledLabel",
  "model-required": "routerChooseModel",
  "catalog-unknown": "routerPoolCatalogUnknown",
  "catalog-stale": "routerPoolCatalogStale",
  "model-unavailable": "routerPoolModelUnavailable",
  "quota-unknown": "routerPoolQuotaUnknown",
  "quota-stale": "routerPoolQuotaStale",
  "scope-unknown": "routerPoolScopeUnknown",
  exhausted: "routerPoolExhausted",
  "reset-unverified": "routerPoolResetUnverified",
  cooldown: "routerPoolCooldown",
  "auth-unavailable": "routerPoolAuthUnavailable",
} as const;

function useOverview(
  reloadToken: number,
  poolId?: string,
  model?: string,
  policy?: string,
) {
  const { t } = useI18n();
  const [data, setData] = useState<AgentAuthRouterOverview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const run = useCallback(
    async (action?: () => Promise<unknown>, clearSelection = false) => {
      const id = ++request.current;
      setBusy(true);
      setError("");
      try {
        if (action) await action();
        if (request.current !== id) return;
        const result = await api.routerOverview(
          clearSelection
            ? {}
            : {
                poolId: poolId || undefined,
                model: model || undefined,
                policy,
              },
        );
        if (request.current === id) {
          setData(result);
          return true;
        }
      } catch (e) {
        if (request.current === id)
          setError(e instanceof Error ? e.message : t("routerUnavailable"));
      } finally {
        if (request.current === id) setBusy(false);
      }
    },
    [poolId, model, policy, t],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadToken asks for a reread.
  useEffect(() => {
    void run();
    return () => {
      request.current++;
    };
  }, [run, reloadToken]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  /**
   * An account refresh starts the provider CLI and takes seconds, so it runs
   * outside `busy`; the overview rereads once it settles. A refresh that
   * outlives this panel (for example a YA host switch) starts no reread.
   */
  const refreshAccount = useCallback(
    async (accountId: string) => {
      let failure: unknown;
      try {
        await api.routerRefreshOverview({ accountId });
      } catch (e) {
        failure = e;
      }
      if (!mounted.current) return;
      await run(failure ? () => Promise.reject(failure) : undefined);
    },
    [run],
  );
  return { data, error, busy, run, refreshAccount };
}

/**
 * Cached, owner-only overview. The editor is separate from observation
 * refresh. A changed `reloadToken` (each router status check) rereads it, so
 * newly granted pools appear without a separate reload.
 */
export function AgentAuthRouterPools({
  reloadToken = 0,
}: {
  reloadToken?: number;
}) {
  const { t } = useI18n();
  const [poolId, setPoolId] = useState("");
  const [model, setModel] = useState("");
  const [draft, setDraft] = useState<AgentAuthRouterPoolInput | null>(null);
  // Account refreshes start Codex/Claude and take seconds; each locks only
  // its own button while the rest of the overview stays usable.
  const [refreshing, setRefreshing] = useState<ReadonlySet<string>>(new Set());
  const { data, error, busy, run, refreshAccount } = useOverview(
    reloadToken,
    poolId,
    model,
  );
  const { version } = useVersion();
  const ownerAware = serverHasCapability(
    version,
    SERVER_CAPABILITIES.agentAuthRouterOwnedPools.name,
  );
  // An explicit denial is authoritative even through an older proxy server.
  const canManage =
    data !== null &&
    data.canManagePools !== false &&
    (!ownerAware || data.canManagePools === true);
  const pool = data?.pools.find((p) => p.id === poolId);
  const accounts =
    data?.accounts.filter((a) => !pool || pool.accountIds.includes(a.id)) ?? [];
  const models = [
    ...new Map(
      accounts.flatMap((a) => a.models).map((m) => [m.id, m]),
    ).values(),
  ];
  const decision = (id: string) =>
    data?.selection?.decisions.find((d) => d.accountId === id)?.reason;
  return (
    <section
      className={styles.panel}
      aria-label={t("routerPoolsTitle")}
      aria-busy={busy}
    >
      <div className={styles.toolbar}>
        <h3>{t("routerPoolsTitle")}</h3>
        <Button disabled={busy} onClick={() => void run()}>
          {t("routerPoolReload")}
        </Button>
      </div>
      <p className={styles.muted}>{t("routerPoolOverviewHelp")}</p>
      {error && <p role="alert">{error}</p>}
      {data && !canManage && <p>{t("routerPoolManagedByRouter")}</p>}
      <div className={styles.toolbar}>
        <label>
          {t("routerPool")}
          <select
            value={poolId}
            disabled={busy}
            onChange={(e) => {
              setPoolId(e.target.value);
              setModel("");
            }}
          >
            <option value="">{t("routerPoolAllAccounts")}</option>
            {data?.pools.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.provider}
              </option>
            ))}
          </select>
        </label>
        {pool && (
          <label>
            {t("routerModel")}
            <select
              value={model}
              disabled={busy}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="">{t("routerChooseModel")}</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {pool && (
        <p>
          {routerPolicyLabel(data, pool.policy)}
          {model
            ? ` · ${t("routerPoolReadyCount", { count: data?.selection?.decisions.filter((d) => d.reason === "eligible").length ?? 0, total: pool.accountIds.length })}`
            : ""}
        </p>
      )}
      {canManage && (
        <div className={styles.toolbar}>
          <Button
            disabled={busy || !!draft}
            onClick={() =>
              setDraft({
                id: generateUUID(),
                name: "",
                provider: "codex",
                accountIds: [],
                policy: "round-robin",
                revision: 0,
              })
            }
          >
            {t("routerPoolCreate")}
          </Button>
          {pool && (
            <Button
              disabled={busy || !!draft}
              onClick={() =>
                setDraft({
                  id: pool.id,
                  name: pool.name,
                  provider: pool.provider,
                  accountIds: [...pool.accountIds],
                  policy: pool.policy,
                  revision: pool.revision,
                })
              }
            >
              {t("routerPoolEdit")}
            </Button>
          )}
        </div>
      )}
      {canManage && draft && (
        <div className={styles.editor}>
          <label>
            {t("routerPoolName")}
            <input
              value={draft.name}
              maxLength={80}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label>
            {t("routerPoolProvider")}
            <select
              value={draft.provider}
              disabled={draft.revision > 0 || busy}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  provider: e.target.value as "codex" | "claude",
                  accountIds: [],
                })
              }
            >
              <option value="codex">Codex</option>
              <option value="claude">Claude</option>
            </select>
          </label>
          <label>
            {t("routerPoolPolicy")}
            <select
              value={draft.policy}
              disabled={busy}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  policy: e.target.value,
                })
              }
            >
              {(data?.supportedPolicies ?? ["manual", "round-robin"]).map(
                (id) => (
                  <option key={id} value={id}>
                    {routerPolicyLabel(data, id)}
                  </option>
                ),
              )}
            </select>
          </label>
          <fieldset disabled={busy}>
            <legend>{t("routerPoolMembers")}</legend>
            {data?.accounts
              .filter((a) => a.provider === draft.provider)
              .map((a) => (
                <label className={styles.member} key={a.id}>
                  <input
                    type="checkbox"
                    checked={draft.accountIds.includes(a.id)}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        accountIds: e.target.checked
                          ? [...draft.accountIds, a.id]
                          : draft.accountIds.filter((id) => id !== a.id),
                      })
                    }
                  />
                  {a.id}
                  {!a.enabled ? ` · ${t("routerAccountDisabledLabel")}` : ""}
                </label>
              ))}
          </fieldset>
          <p>{t("routerPoolEditWarning")}</p>
          {draft.revision > 0 && (
            <p>
              {t("routerPoolBindingCount", {
                count:
                  data?.pools
                    .find((p) => p.id === draft.id)
                    ?.bindings.reduce((n, b) => n + b.count, 0) ?? 0,
              })}
            </p>
          )}
          <div className={styles.toolbar}>
            <Button
              variant="primary"
              disabled={
                busy ||
                !draft.name.trim() ||
                draft.accountIds.length < 1 ||
                draft.accountIds.length > 16
              }
              onClick={() => {
                const saved = { ...draft };
                void run(() => api.routerSavePool(saved)).then((ok) => {
                  if (ok) setDraft(null);
                });
              }}
            >
              {t("routerPoolSave")}
            </Button>
            <Button disabled={busy} onClick={() => setDraft(null)}>
              {t("routerPoolCloseEditor")}
            </Button>
            {draft.revision > 0 && (
              <Button
                variant="danger-outline"
                disabled={busy}
                onClick={() => {
                  const removed = { id: draft.id, revision: draft.revision };
                  void run(() => api.routerRemovePool(removed), true).then(
                    (ok) => {
                      if (ok) {
                        setPoolId("");
                        setModel("");
                        setDraft(null);
                      }
                    },
                  );
                }}
              >
                {t("routerPoolDelete")}
              </Button>
            )}
          </div>
          <p className={styles.muted}>{t("routerPoolRevisionHelp")}</p>
        </div>
      )}
      {data && !data.pools.length && (
        <p>{t(canManage ? "routerPoolEmpty" : "routerPoolEmptyGranted")}</p>
      )}
      <div className={styles.grid}>
        {accounts.map((account) => (
          <article className={styles.account} key={account.id}>
            <div className={styles.toolbar}>
              <strong>{account.id}</strong>
              <span>{account.provider}</span>
            </div>
            <p className={styles.muted}>
              {t(
                account.freshness === "fresh"
                  ? "routerPoolFresh"
                  : account.freshness === "stale"
                    ? "routerPoolStale"
                    : "routerPoolUnknown",
              )}
              {account.quota
                ? ` · ${t("routerUsageObserved", { time: new Date(account.quota.observedAt).toLocaleString() })}`
                : ""}
            </p>
            {decision(account.id) && (
              <p>
                {t(
                  reasonKeys[decision(account.id) as keyof typeof reasonKeys] ??
                    "routerPoolQuotaUnknown",
                )}
              </p>
            )}
            {!account.enabled && <p>{t("routerAccountDisabledLabel")}</p>}
            {account.error && (
              <p role="status">
                {t("routerPoolRefreshFailed")}
                {/* AAR's reason, already scrubbed of secrets and paths. */}
                <span className={styles.muted}> ({account.error})</span>
              </p>
            )}
            {account.blocked && (
              <p>
                {t(
                  account.blocked === "cooldown"
                    ? "routerPoolCooldown"
                    : "routerPoolAuthUnavailable",
                )}
              </p>
            )}
            {account.windows.map((window) => (
              <div key={window.bucket} className={styles.window}>
                <div className={styles.toolbar}>
                  <span>
                    {t(
                      (
                        {
                          five_hour: "routerPoolFiveHour",
                          seven_day: "routerPoolWeekly",
                          seven_day_opus: "routerPoolWeeklyOpus",
                          seven_day_sonnet: "routerPoolWeeklySonnet",
                          seven_day_oauth_apps: "routerPoolWeeklyApps",
                          "codex:primary": "routerPoolPrimary",
                          "codex:secondary": "routerPoolSecondary",
                        } as const
                      )[window.bucket as "five_hour"] ?? window.bucket,
                    )}
                  </span>
                  <strong>
                    {window.remainingPercent === null
                      ? t("routerPoolUnknown")
                      : t("routerPoolRemaining", {
                          percent: Math.round(window.remainingPercent),
                        })}
                  </strong>
                </div>
                {window.remainingPercent !== null && (
                  <progress
                    aria-label={`${account.id} ${window.bucket}`}
                    max={100}
                    value={Math.min(100, window.remainingPercent!)}
                  />
                )}
                <span className={styles.muted}>
                  {window.resetsAt
                    ? t("routerPoolResets", {
                        time: new Date(window.resetsAt).toLocaleString(),
                      })
                    : t("routerPoolResetUnknown")}
                </span>
              </div>
            ))}
            <Button
              disabled={refreshing.has(account.id) || !account.enabled}
              onClick={() => {
                const id = account.id;
                setRefreshing((s) => new Set(s).add(id));
                void refreshAccount(id).finally(() =>
                  setRefreshing((s) => {
                    const next = new Set(s);
                    next.delete(id);
                    return next;
                  }),
                );
              }}
            >
              {t(
                refreshing.has(account.id)
                  ? "routerRefreshingUsage"
                  : "routerRefreshUsage",
              )}
            </Button>
          </article>
        ))}
      </div>
    </section>
  );
}
