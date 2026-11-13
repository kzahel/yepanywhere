import {
  type AgentAuthRouterOverview,
  type EffortLevel,
  resolveRouterModel,
  type ThinkingConfig,
  type ThinkingOption,
} from "@yep-anywhere/shared";
import { useRef, useState } from "react";
import { api } from "../api/client";
import { useToastContext } from "../contexts/ToastContext";
import { useActingPrincipal } from "../hooks/useActingPrincipal";
import { useRouterDiscovery } from "../hooks/useRouterDiscovery";
import { useI18n } from "../i18n";
import { useClientSummarySourceKey } from "../lib/clientSummarySourceKey";
import { FilterDropdown } from "./FilterDropdown";
import {
  bestRemaining,
  poolReason,
  type RouterBinding,
  RouterDropdownSection,
  routedModels,
  routerAccountIssue,
  routerAccountOption,
  routerBindingChip,
  routerDirectOption,
  routerHeldOption,
  routerPoolAccounts,
  routerPoolOption,
} from "./RouterPoolSelector";
import styles from "./SessionRouterAccountPane.module.css";
import { Banner } from "./ui/Banner";
import { Button } from "./ui/Button";
import { Spinner } from "./ui/Spinner";

type OverviewAccount = AgentAuthRouterOverview["accounts"][number];

/** The session settings the switch route checks a new account against. */
export interface SessionRouterLaunch {
  /** Model ids, preferred first: the live resolved model, then the saved one. */
  models: (string | null | undefined)[];
  thinking?: ThinkingConfig | null;
  effort?: EffortLevel | null;
  serviceTier?: string | null;
}

/** The switch route's reading of saved thinking settings. */
function launchThinking(launch: SessionRouterLaunch): ThinkingOption {
  return launch.thinking?.type === "disabled"
    ? "off"
    : launch.effort
      ? `on:${launch.effort}`
      : "auto";
}

/** Catalog ids the switch tries; `[1m]` variants and "default" are not ids. */
function modelCandidates(launch: SessionRouterLaunch): string[] {
  return [
    ...new Set(
      launch.models
        .map((id) => id?.replace(/\[1m\]$/, ""))
        .filter((id): id is string => !!id && id !== "default"),
    ),
  ];
}

/** The single account-switching surface for an existing session. */
export function SessionRouterAccountPane({
  sessionId,
  binding,
  provider,
  launch,
  canSwitch: eligible,
  onSwitched,
}: {
  sessionId: string;
  binding: RouterBinding | undefined;
  provider: string;
  launch: SessionRouterLaunch;
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
  const data = discovery.data ?? null;
  const pools = (data?.pools ?? []).filter(
    (item) => item.provider === provider,
  );
  const pool = pools.find((item) => item.id === selection.poolId);
  const thinking = launchThinking(launch);
  const candidates = modelCandidates(launch);
  const model = candidates[0] ?? null;
  const serviceTier = launch.serviceTier;
  // As the switch route does: the first session model the account's own
  // catalog resolves.
  const accountModel = (account: OverviewAccount) =>
    candidates
      .map((id) => resolveRouterModel(id, account.models))
      .find(Boolean);
  // With no known model only a disabled account is ruled out; the route
  // falls back to the current pin's model and decides.
  const issueFor = (account: OverviewAccount) => {
    if (!model)
      return account.enabled
        ? null
        : { blocking: true, text: t("routerReasonDisabled") };
    const concrete = accountModel(account);
    return routerAccountIssue(
      t,
      account,
      model,
      account.models.find((m) => m.id === concrete)?.name ?? model,
      concrete,
      thinking,
      serviceTier,
    );
  };
  const accounts = routerPoolAccounts(data, selection.poolId, provider);
  const changed =
    selection.poolId !== currentPoolId ||
    selection.accountId !== (binding?.accountId ?? "");
  const valid =
    !selection.poolId ||
    Boolean(
      pool &&
        !discovery.error &&
        accounts.some(
          (item) =>
            item.id === selection.accountId && !issueFor(item)?.blocking,
        ),
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
  const poolLabel = t("sessionAccountPool");
  const accountLabel = t("routerAccount");
  const heldPoolLabel =
    selection.poolId === "unpooled"
      ? t("sessionAccountUnpooled")
      : binding?.poolId === selection.poolId
        ? (binding.poolName ?? selection.poolId)
        : selection.poolId;
  const heldAccountLabel =
    binding?.accountId === selection.accountId
      ? (binding.accountDisplayName ?? selection.accountId)
      : selection.accountId;
  const accountHeld =
    !!selection.accountId &&
    !accounts.some((item) => item.id === selection.accountId);
  const poolOptions = pools.map((item) => {
    const members = routerPoolAccounts(data, item.id, provider);
    const compatible = members.filter((a) => !issueFor(a)?.blocking);
    const poolModels = routedModels(data, provider, item.id);
    const concrete = resolveRouterModel(model, poolModels);
    const modelLabel =
      poolModels.find((m) => m.id === concrete)?.name ?? model ?? "";
    return routerPoolOption(t, item, {
      compatible: compatible.length,
      modelLabel,
      reason: poolReason(
        t,
        members,
        model,
        modelLabel,
        concrete,
        thinking,
        serviceTier,
      ),
      best: bestRemaining(compatible, accountModel),
      disabled: busy,
    });
  });
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
            <RouterDropdownSection label={poolLabel}>
              <FilterDropdown<string>
                label={poolLabel}
                options={[
                  routerDirectOption(t, busy, t("sessionAccountDirectLogin")),
                  ...(selection.poolId && !pool
                    ? [routerHeldOption(selection.poolId, heldPoolLabel)]
                    : []),
                  ...poolOptions,
                ]}
                selected={[selection.poolId]}
                onChange={([poolId]) => {
                  if (busy || poolId === undefined) return;
                  choose(poolId, "");
                }}
                multiSelect={false}
                fullWidth
                triggerClassName={styles.trigger}
              />
            </RouterDropdownSection>
            {selection.poolId && (
              <RouterDropdownSection label={accountLabel}>
                <FilterDropdown<string>
                  label={accountLabel}
                  options={[
                    ...(accountHeld
                      ? [
                          routerHeldOption(
                            selection.accountId,
                            heldAccountLabel,
                          ),
                        ]
                      : []),
                    ...accounts.map((account, index) =>
                      routerAccountOption(
                        t,
                        account,
                        index,
                        issueFor(account),
                        busy || !pool || discovery.error,
                        binding?.accountId === account.id &&
                          binding.poolId === selection.poolId
                          ? t("sessionAccountCurrentOption")
                          : undefined,
                      ),
                    ),
                  ]}
                  selected={selection.accountId ? [selection.accountId] : []}
                  onChange={([accountId]) => {
                    if (busy || accountId === undefined) return;
                    choose(selection.poolId, accountId);
                  }}
                  multiSelect={false}
                  placeholder={t("sessionAccountChooseAccount")}
                  fullWidth
                  triggerClassName={styles.trigger}
                />
              </RouterDropdownSection>
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
