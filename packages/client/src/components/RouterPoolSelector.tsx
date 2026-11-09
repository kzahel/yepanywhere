import {
  resolveRouterModel,
  routerAliasTargets,
  routerModelSupportsThinking,
  routerModelSupportsServiceTier,
  type AgentAuthRouterOverview,
  type AgentAuthRouterPoolPolicy,
  type AppSessionSummary,
  type EffortLevel,
  type ModelInfo,
  type ProviderSessionDefaults,
  type ThinkingOption,
} from "@yep-anywhere/shared";
import { useI18n } from "../i18n";
import { FilterDropdown } from "./FilterDropdown";
import styles from "./RouterPoolSelector.module.css";
import { Banner } from "./ui/Banner";
import { Button } from "./ui/Button";
export interface RouterSelection {
  sourceKey: string;
  poolId: string;
  /** A picked account; the router pins it with policy "manual". */
  accountId: string;
  /** A policy overriding the pool default; absent means the default. */
  policy?: string;
}

export function preferredRouterSelection(
  defaults: ProviderSessionDefaults,
  sourceKey: string,
): RouterSelection | null {
  return defaults.routerPoolId
    ? {
        sourceKey,
        poolId: defaults.routerPoolId,
        accountId: defaults.routerAccountId ?? "",
        ...(defaults.routerPolicy ? { policy: defaults.routerPolicy } : {}),
      }
    : null;
}

/** Restore only currently usable preferences, without changing the saved pick. */
export function restoreRouterSelection(
  preference: RouterSelection | null,
  data: AgentAuthRouterOverview | null,
  provider: string | null,
  model: string | null,
  thinking: ThinkingOption,
): RouterSelection | null {
  if (!preference || !data) return null;
  const pool = data.pools.find(
    (p) => p.id === preference.poolId && p.provider === provider,
  );
  if (!pool) return null;
  const members = routerPoolMembers(data, pool.id, provider, model, thinking);
  if (!members.length) return null;
  if (preference.accountId) {
    return members.some((a) => a.id === preference.accountId)
      ? preference
      : null;
  }
  if (
    preference.policy &&
    !routerPolicies(data).some((p) => p.id === preference.policy)
  )
    return null;
  return (preference.policy ?? pool.policy) === "manual" && members.length !== 1
    ? null
    : preference;
}

const DIRECT = "";

const POLICY_OPTION = "policy:";

/** The router's English name for a policy, or its id. */
export function routerPolicyLabel(
  data: Pick<AgentAuthRouterOverview, "policies"> | null | undefined,
  policy: AgentAuthRouterPoolPolicy,
): string {
  return data?.policies?.find((p) => p.id === policy)?.label ?? policy;
}

/** Policies the router offers, in its order. */
function routerPolicies(data: AgentAuthRouterOverview | null) {
  return (
    data?.policies ??
    data?.supportedPolicies?.map((id) => ({ id, label: id })) ??
    []
  );
}

const EFFORT_KEYS = {
  low: "effortLevelLowLabel",
  medium: "effortLevelMediumLabel",
  high: "effortLevelHighLabel",
  xhigh: "effortLevelExtraHighLabel",
  max: "effortLevelMaxLabel",
} as const satisfies Record<EffortLevel, string>;

const WINDOW_SHORT_KEYS = {
  five_hour: "routerWindowShortFiveHour",
  seven_day: "routerWindowShortWeekly",
  seven_day_opus: "routerWindowShortWeeklyOpus",
  seven_day_sonnet: "routerWindowShortWeeklySonnet",
  seven_day_oauth_apps: "routerWindowShortWeeklyApps",
} as const;

type OverviewAccount = AgentAuthRouterOverview["accounts"][number];
type QuotaWindow = OverviewAccount["windows"][number];
type Translate = ReturnType<typeof useI18n>["t"];
export type RouterBinding = NonNullable<AppSessionSummary["routerBinding"]>;

/**
 * Compact session-header label for a pin: the saved pool and account names,
 * never the raw account id. Pins saved before names were kept fall back to
 * the policy.
 */
export function routerBindingChip(
  t: Translate,
  binding: RouterBinding,
  action:
    | "routerChipTooltipOpen"
    | "routerChipTooltipSwitch" = "routerChipTooltipOpen",
): { label: string; tooltip: string } {
  const policy = binding.policyLabel ?? binding.policy;
  const names = [binding.poolName, binding.accountDisplayName].filter(Boolean);
  return {
    label: names.join(" · ") || policy || t("routerChipFallback"),
    tooltip: [
      t("routerChipTooltipTitle"),
      binding.poolName &&
        t("routerChipTooltipPool", { pool: binding.poolName }),
      t("routerChipTooltipAccount", {
        account: binding.accountDisplayName ?? binding.accountId,
      }),
      policy && t("routerChipTooltipPolicy", { policy }),
      binding.reason,
      t(action),
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/** Enabled accounts whose models a selection can launch: the pool's, or all. */
export function routedAccounts(
  data: AgentAuthRouterOverview | null,
  provider: string | null,
  poolId?: string,
): OverviewAccount[] {
  const pool = data?.pools.find((p) => p.id === poolId);
  return (data?.accounts ?? []).filter(
    (a) =>
      a.enabled &&
      a.provider === provider &&
      (!poolId || pool?.accountIds.includes(a.id)),
  );
}

export function routedModels(
  data: AgentAuthRouterOverview | null,
  provider: string | null,
  poolId?: string,
): ModelInfo[] {
  const result = new Map<string, ModelInfo>();
  for (const a of routedAccounts(data, provider, poolId)) {
    for (const model of a.models) {
      const previous = result.get(model.id);
      result.set(model.id, {
        ...model,
        supportsEffort: model.supportsEffort ?? false,
        ...(previous
          ? {
              supportsEffort: !!(
                previous.supportsEffort || model.supportsEffort
              ),
              supportsAdaptiveThinking:
                previous.supportsAdaptiveThinking ||
                model.supportsAdaptiveThinking,
              serviceTiers: [
                ...new Map(
                  [
                    ...(previous.serviceTiers ?? []),
                    ...(model.serviceTiers ?? []),
                  ].map((t) => [t.id, t]),
                ).values(),
              ],
              supportedReasoningEfforts: [
                ...new Map(
                  [
                    ...(previous.supportedReasoningEfforts ?? []),
                    ...(model.supportedReasoningEfforts ?? []),
                  ].map((e) => [e.reasoningEffort, e]),
                ).values(),
              ],
            }
          : {}),
      });
    }
  }
  return [...result.values()];
}

/** Every overview account the pool names for this provider, enabled or not. */
export function routerPoolAccounts(
  data: AgentAuthRouterOverview | null,
  poolId: string,
  provider: string | null,
): OverviewAccount[] {
  const pool = data?.pools.find(
    (p) => p.id === poolId && p.provider === provider,
  );
  return (
    data?.accounts.filter(
      (a) => a.provider === provider && pool?.accountIds.includes(a.id),
    ) ?? []
  );
}

export function routerPoolMembers(
  data: AgentAuthRouterOverview | null,
  poolId: string,
  provider: string | null,
  model: string | null,
  thinking: ThinkingOption,
  serviceTier?: string | null,
) {
  const concreteModel = resolveRouterModel(
    model,
    routedModels(data, provider, poolId),
    routerAliasTargets(routedAccounts(data, provider, poolId)),
  );
  return routerPoolAccounts(data, poolId, provider).filter(
    (a) =>
      a.enabled &&
      routerModelSupportsThinking(
        a.models.find((m) => m.id === concreteModel),
        thinking,
      ) &&
      routerModelSupportsServiceTier(
        a.models.find((m) => m.id === concreteModel),
        serviceTier,
      ),
  );
}

export interface RouterAccountIssue {
  /** A blocking issue makes the account unselectable; advice does not. */
  blocking: boolean;
  text: string;
}

function effortLabel(t: Translate, thinking: ThinkingOption): string {
  const effort = thinking.replace(/^on:/, "") as EffortLevel;
  return EFFORT_KEYS[effort] ? t(EFFORT_KEYS[effort]) : effort;
}

/** Windows that bound the selected model: provider-wide or the model's family. */
function windowApplies(w: QuotaWindow, concreteModel: string | undefined) {
  return (
    w.scope === "all" ||
    (w.scope !== "unknown" && !!concreteModel?.includes(w.scope))
  );
}

function quotaExhausted(
  account: OverviewAccount,
  concreteModel: string | undefined,
): boolean {
  if (
    account.provider === "codex" &&
    account.quota?.ordinaryUsageAllowed !== undefined
  )
    return !account.quota.ordinaryUsageAllowed;
  return (account.windows ?? []).some(
    (w) => w.remainingPercent === 0 && windowApplies(w, concreteModel),
  );
}

/** Lowest remaining percent among the windows that bound the model. */
export function tightestRemaining(
  account: OverviewAccount,
  concreteModel: string | undefined,
): number | null {
  const percents = (account.windows ?? [])
    .filter(
      (w) => w.remainingPercent !== null && windowApplies(w, concreteModel),
    )
    .map((w) => w.remainingPercent as number);
  const remaining = percents.length ? Math.min(...percents) : null;
  return remaining === 0 && account.quota?.ordinaryUsageAllowed === true
    ? null
    : remaining;
}

/**
 * Why an account cannot, or may not, serve the selection, derived only from
 * the overview YA already holds. Cached quota and auth states are advice:
 * AAR decides at launch, so they never make an account unselectable here.
 */
export function routerAccountIssue(
  t: Translate,
  account: OverviewAccount,
  model: string | null,
  modelLabel: string,
  concreteModel: string | undefined,
  thinking: ThinkingOption,
  serviceTier?: string | null,
): RouterAccountIssue | null {
  if (!account.enabled)
    return { blocking: true, text: t("routerReasonDisabled") };
  if (!model) return { blocking: true, text: t("routerReasonChooseModel") };
  const catalogModel = account.models.find((m) => m.id === concreteModel);
  if (!catalogModel)
    return {
      blocking: true,
      text: t("routerReasonModelUnavailable", { model: modelLabel }),
    };
  if (!routerModelSupportsThinking(catalogModel, thinking))
    return {
      blocking: true,
      text: t("routerReasonEffortUnsupported", {
        effort: effortLabel(t, thinking),
      }),
    };
  if (!routerModelSupportsServiceTier(catalogModel, serviceTier))
    return { blocking: true, text: t("routerReasonSpeedUnsupported") };
  if (account.blocked === "auth-unavailable")
    return { blocking: false, text: t("routerReasonAuthBlocked") };
  if (account.blocked === "cooldown")
    return {
      blocking: false,
      text: account.cooldownUntil
        ? t("routerReasonCooldownUntil", {
            time: new Date(account.cooldownUntil).toLocaleTimeString(),
          })
        : t("routerReasonCooldown"),
    };
  if (quotaExhausted(account, concreteModel))
    return { blocking: false, text: t("routerReasonExhausted") };
  return null;
}

/** Why no account in the pool can serve the selection. */
function poolReason(
  t: Translate,
  accounts: OverviewAccount[],
  model: string | null,
  modelLabel: string,
  concreteModel: string | undefined,
  thinking: ThinkingOption,
  serviceTier?: string | null,
): string {
  const enabled = accounts.filter((a) => a.enabled);
  if (!enabled.length) return t("routerReasonNoEnabledAccounts");
  if (!model) return t("routerReasonChooseModel");
  const offering = enabled.filter((a) =>
    a.models.some((m) => m.id === concreteModel),
  );
  if (!offering.length)
    return t("routerReasonNoAccountOffers", { model: modelLabel });
  if (
    offering.some((a) =>
      routerModelSupportsThinking(
        a.models.find((m) => m.id === concreteModel),
        thinking,
      ),
    ) &&
    serviceTier
  )
    return t("routerReasonSpeedUnsupported");
  return t("routerReasonNoAccountSupportsEffort", {
    effort: effortLabel(t, thinking),
  });
}

function windowShortLabel(t: Translate, w: QuotaWindow): string {
  const key = WINDOW_SHORT_KEYS[w.bucket as keyof typeof WINDOW_SHORT_KEYS];
  if (key) return t(key);
  if (w.windowMinutes === null) return w.bucket;
  return w.windowMinutes < 1440
    ? t("routerWindowShortHours", {
        hours: Math.max(1, Math.round(w.windowMinutes / 60)),
      })
    : t("routerWindowShortDays", {
        days: Math.max(1, Math.round(w.windowMinutes / 1440)),
      });
}

/** A time of day for resets within a day; month and day beyond that. */
export function formatReset(resetsAt: string, now = Date.now()): string {
  const at = new Date(resetsAt);
  const withinDay = Math.abs(at.getTime() - now) < 24 * 60 * 60 * 1000;
  return at.toLocaleString(
    undefined,
    withinDay
      ? { hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
  );
}

function remainingTone(percent: number | null): string {
  if (percent === null) return styles.quotaUnknown ?? "";
  if (percent <= 0) return styles.quotaDanger ?? "";
  if (percent < 25) return styles.quotaWarning ?? "";
  return "";
}

const OBSERVATION_AGE_QUIET_MS = 10 * 60 * 1000;

/**
 * How long ago the quota was observed, or null when recent enough to leave
 * unsaid. AAR's own `freshness` flag turns stale after two minutes because it
 * gates automatic admission; that threshold says nothing useful to a person.
 * An observation AAR took from a proxied response's rate-limit headers is
 * worded as coming from a request, since no check was run.
 */
export function observationAge(
  t: Translate,
  observedAt: string,
  now = Date.now(),
  source: "probe" | "inference" = "probe",
): string | null {
  const age = now - Date.parse(observedAt);
  if (!Number.isFinite(age) || age < OBSERVATION_AGE_QUIET_MS) return null;
  const inference = source === "inference";
  if (age < 60 * 60 * 1000)
    return t(
      inference ? "routerQuotaUsedMinutes" : "routerQuotaCheckedMinutes",
      { minutes: Math.round(age / 60000) },
    );
  if (age < 24 * 60 * 60 * 1000)
    return t(inference ? "routerQuotaUsedHours" : "routerQuotaCheckedHours", {
      hours: Math.round(age / 3600000),
    });
  return t(inference ? "routerQuotaUsedOn" : "routerQuotaCheckedOn", {
    date: new Date(observedAt).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    }),
  });
}

/** Every cached quota window for the account, one short line each. */
function AccountQuota({ account }: { account: OverviewAccount }) {
  const { t } = useI18n();
  const windows = account.windows ?? [];
  if (!account.quota && !windows.length)
    return (
      <span className={`${styles.quota} ${styles.quotaUnknown}`}>
        {t("routerQuotaNotObserved")}
      </span>
    );
  const age = account.quota
    ? observationAge(
        t,
        account.quota.observedAt,
        Date.now(),
        account.quota.source ?? "probe",
      )
    : null;
  return (
    <span
      className={styles.quota}
      title={
        account.quota
          ? t("routerQuotaObservedTitle", {
              time: new Date(account.quota.observedAt).toLocaleString(),
            })
          : undefined
      }
    >
      {windows.map((w) => (
        <span
          key={w.bucket}
          className={remainingTone(
            account.quota?.ordinaryUsageAllowed && w.remainingPercent === 0
              ? null
              : w.remainingPercent,
          )}
        >
          {account.quota?.ordinaryUsageAllowed && w.remainingPercent === 0
            ? t("subscriptionUsageAllowed")
            : w.remainingPercent === null
              ? t("routerQuotaLineUnknown", { window: windowShortLabel(t, w) })
              : w.resetsAt
                ? t("routerQuotaLine", {
                    window: windowShortLabel(t, w),
                    percent: Math.round(w.remainingPercent),
                    reset: formatReset(w.resetsAt),
                  })
                : t("routerQuotaLineNoReset", {
                    window: windowShortLabel(t, w),
                    percent: Math.round(w.remainingPercent),
                  })}
          {w.remainingCapacityUnits != null && (
            <>
              {" "}
              ·{" "}
              {t("subscriptionUsageCapacity", {
                units: w.remainingCapacityUnits,
              })}
            </>
          )}
        </span>
      ))}
      {age && <span className={styles.quotaUnknown}>{age}</span>}
      {account.error && (
        <span className={styles.quotaWarning} title={account.error}>
          {t("routerQuotaRefreshFailed")}
        </span>
      )}
    </span>
  );
}

export function RouterPoolSelector({
  data,
  provider,
  model,
  thinking,
  value,
  onChange,
  sourceKey,
  busy,
  error,
  retry,
  disabled,
  showCaption = false,
  serviceTier,
}: {
  data: AgentAuthRouterOverview | null;
  provider: string;
  model: string | null;
  thinking: ThinkingOption;
  value: RouterSelection | null;
  onChange: (value: RouterSelection | null) => void;
  sourceKey: string;
  busy: boolean;
  error: boolean;
  retry: () => void;
  disabled: boolean;
  showCaption?: boolean;
  serviceTier?: string | null;
}) {
  const { t } = useI18n();
  if (!data && !value && !error) return null;
  const pools = data?.pools.filter((p) => p.provider === provider) ?? [];
  // A router granting no pool for this provider leaves only Direct, so the
  // provider is not routed. A held selection stays visible as unavailable.
  if (data && !error && !value && !pools.length) return null;
  const members = value?.poolId
    ? routerPoolMembers(
        data,
        value.poolId,
        provider,
        model,
        thinking,
        serviceTier,
      )
    : [];
  const pool = pools.find((p) => p.id === value?.poolId);
  const unavailable = !!value && (!pool || !members.length);
  const poolLabel = t("routerPool");
  const accountLabel = t("routerAccount");
  const tones = {
    ready: styles.ready,
    advice: styles.advice,
    blocked: styles.blocked,
  };
  const dot = (tone: keyof typeof tones) => (
    <span className={`${styles.dot} ${tones[tone]}`} />
  );
  const describePool = (poolId: string) => {
    const accounts = routerPoolAccounts(data, poolId, provider);
    const poolModels = routedModels(data, provider, poolId);
    const concreteModel = resolveRouterModel(model, poolModels);
    const modelLabel =
      poolModels.find((m) => m.id === concreteModel)?.name ?? model ?? "";
    return { accounts, concreteModel, modelLabel };
  };
  const poolAccounts = pool ? describePool(pool.id) : null;
  // Any pool offers its default, the router's other automatic policies, and
  // each account. The pool's policy is only a default.
  const listed = routerPolicies(data);
  const automatic = pool
    ? [
        ...(listed.some((p) => p.id === pool.policy)
          ? []
          : [{ id: pool.policy, label: pool.policy }]),
        ...listed,
      ]
        .filter((p) => p.id !== "manual")
        .sort(
          (a, b) => Number(b.id === pool.policy) - Number(a.id === pool.policy),
        )
    : [];
  const chooseAccount =
    pool && poolAccounts?.accounts.length ? (
      <div className={`new-session-helper-section ${styles.section}`}>
        <h3>{accountLabel}</h3>
        <FilterDropdown<string>
          label={accountLabel}
          options={[
            ...automatic.map((p) => ({
              value: `${POLICY_OPTION}${p.id}`,
              label: p.label,
              description:
                p.id === pool.policy ? t("routerPolicyPoolDefault") : undefined,
              icon: dot(members.length ? "ready" : "blocked"),
              disabled: disabled || !members.length,
            })),
            ...poolAccounts.accounts.map((a, index) => {
              const issue = routerAccountIssue(
                t,
                a,
                model,
                poolAccounts.modelLabel,
                poolAccounts.concreteModel,
                thinking,
                serviceTier,
              );
              return {
                value: a.id,
                label:
                  a.displayName ||
                  t("routerAccountNumber", { number: index + 1 }),
                description: issue?.text,
                icon: dot(
                  issue ? (issue.blocking ? "blocked" : "advice") : "ready",
                ),
                meta: <AccountQuota account={a} />,
                disabled: disabled || !!issue?.blocking,
              };
            }),
          ]}
          selected={
            value?.accountId
              ? [value.accountId]
              : value?.policy
                ? [`${POLICY_OPTION}${value.policy}`]
                : pool.policy !== "manual"
                  ? [`${POLICY_OPTION}${pool.policy}`]
                  : members.length === 1 && members[0]
                    ? [members[0].id]
                    : []
          }
          onChange={([choice]) => {
            if (disabled || !value || choice === undefined) return;
            if (!choice.startsWith(POLICY_OPTION))
              return onChange({
                ...value,
                accountId: choice,
                policy: undefined,
              });
            const policy = choice.slice(POLICY_OPTION.length);
            onChange({
              ...value,
              accountId: "",
              policy: policy === pool.policy ? undefined : policy,
            });
          }}
          multiSelect={false}
          placeholder={t("routerPoolChooseAccount")}
          fullWidth
          triggerClassName={styles.leftAlignedTrigger}
        />
        {showCaption && (
          <p className={styles.caption}>{t("routerAccountCaption")}</p>
        )}
      </div>
    ) : null;
  return (
    <>
      <div className={`new-session-helper-section ${styles.section}`}>
        <h3>{poolLabel}</h3>
        <FilterDropdown<string>
          label={poolLabel}
          options={[
            {
              value: DIRECT,
              label: t("routerDirect"),
              description: t("routerDirectDescription"),
              icon: dot("ready"),
              disabled,
            },
            ...(value?.poolId && !pool
              ? [
                  {
                    value: value.poolId,
                    label: t("routerPoolUnavailable"),
                    icon: dot("blocked"),
                    disabled: true,
                  },
                ]
              : []),
            ...pools.map((p) => {
              const { accounts, concreteModel, modelLabel } = describePool(
                p.id,
              );
              const compatible = routerPoolMembers(
                data,
                p.id,
                provider,
                model,
                thinking,
                serviceTier,
              );
              const best = compatible
                .map((a) => tightestRemaining(a, concreteModel))
                .filter((r): r is number => r !== null);
              return {
                value: p.id,
                label: p.name,
                description: [
                  routerPolicyLabel(data, p.policy),
                  compatible.length
                    ? t("routerPoolCompatibleAccounts", {
                        count: compatible.length,
                        total: p.accountIds.length,
                        model: modelLabel,
                      })
                    : poolReason(
                        t,
                        accounts,
                        model,
                        modelLabel,
                        concreteModel,
                        thinking,
                        serviceTier,
                      ),
                  ...(best.length
                    ? [
                        t("routerPoolBestRemaining", {
                          percent: Math.round(Math.max(...best)),
                        }),
                      ]
                    : []),
                ].join(" · "),
                icon: dot(compatible.length ? "ready" : "blocked"),
                disabled: disabled || compatible.length === 0,
              };
            }),
          ]}
          selected={[value?.poolId ?? DIRECT]}
          onChange={([poolId]) => {
            if (disabled || poolId === undefined) return;
            const selected = pools.find((p) => p.id === poolId);
            onChange(
              selected
                ? { sourceKey, poolId: selected.id, accountId: "" }
                : null,
            );
          }}
          multiSelect={false}
          fullWidth
          triggerClassName={styles.leftAlignedTrigger}
        />
        {error ? (
          <Banner
            tone="error"
            compact
            className={styles.message}
            actions={
              <Button variant="ghost" size="small" onClick={retry}>
                {t("routerRetry")}
              </Button>
            }
          >
            {t("routerDiscoveryFailed")}
          </Banner>
        ) : unavailable ? (
          <Banner tone="warning" compact className={styles.message}>
            {t("routerSelectionUnavailable")}
          </Banner>
        ) : busy ? (
          <div className={styles.status} role="status">
            <span>{t("routerChecking")}</span>
          </div>
        ) : null}
        {showCaption && (
          <p className={styles.caption}>{t("routerPoolCaption")}</p>
        )}
      </div>
      {chooseAccount}
    </>
  );
}
