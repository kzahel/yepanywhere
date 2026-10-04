import {
  resolveRouterModel,
  routerModelSupportsThinking,
  type AgentAuthRouterOverview,
  type ModelInfo,
  type ThinkingOption,
} from "@yep-anywhere/shared";
import { useI18n } from "../i18n";
export interface RouterSelection {
  sourceKey: string;
  poolId: string;
  accountId: string;
}
import styles from "./RouterPoolSelector.module.css";

export function routedModels(
  data: AgentAuthRouterOverview | null,
  provider: string | null,
  poolId?: string,
): ModelInfo[] {
  const pool = data?.pools.find((p) => p.id === poolId);
  const result = new Map<string, ModelInfo>();
  for (const a of data?.accounts ?? []) {
    if (
      !a.enabled ||
      a.provider !== provider ||
      (poolId && !pool?.accountIds.includes(a.id))
    )
      continue;
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

export function routerPoolMembers(
  data: AgentAuthRouterOverview | null,
  poolId: string,
  provider: string | null,
  model: string | null,
  thinking: ThinkingOption,
) {
  const pool = data?.pools.find(
    (p) => p.id === poolId && p.provider === provider,
  );
  const concreteModel = resolveRouterModel(
    model,
    routedModels(data, provider, poolId),
  );
  return (
    data?.accounts.filter(
      (a) =>
        a.enabled &&
        pool?.accountIds.includes(a.id) &&
        routerModelSupportsThinking(
          a.models.find((m) => m.id === concreteModel),
          thinking,
        ),
    ) ?? []
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
}) {
  const { t } = useI18n();
  if (!data && !value && !error) return null;
  const pools = data?.pools.filter((p) => p.provider === provider) ?? [];
  const members = value?.poolId
    ? routerPoolMembers(data, value.poolId, provider, model, thinking)
    : [];
  const pool = pools.find((p) => p.id === value?.poolId);
  const unavailable = !!value && (!pool || !members.length);
  return (
    <div className={styles.control}>
      <label>
        {t("routerPool")}
        <select
          aria-label={t("routerPool")}
          value={value?.poolId ?? ""}
          disabled={disabled}
          onChange={(event) => {
            const selected = pools.find((p) => p.id === event.target.value);
            onChange(
              selected
                ? { sourceKey, poolId: selected.id, accountId: "" }
                : null,
            );
          }}
        >
          <option value="">{t("routerDirect")}</option>
          {value?.poolId && !pool && (
            <option value={value.poolId} disabled>
              {t("routerPoolUnavailable")}
            </option>
          )}
          {pools.map((p) => (
            <option
              key={p.id}
              value={p.id}
              disabled={
                !routerPoolMembers(data, p.id, provider, model, thinking).length
              }
            >
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {pool?.policy === "manual" && members.length > 1 && (
        <label>
          {t("routerAccount")}
          <select
            aria-label={t("routerAccount")}
            value={value?.accountId ?? ""}
            disabled={disabled}
            onChange={(event) =>
              value && onChange({ ...value, accountId: event.target.value })
            }
          >
            <option value="">{t("routerPoolChooseAccount")}</option>
            {members.map((a, index) => (
              <option key={a.id} value={a.id}>
                {a.displayName ||
                  t("routerAccountNumber", { number: index + 1 })}
              </option>
            ))}
          </select>
        </label>
      )}
      {error ? (
        <span role="alert">
          {t("routerDiscoveryFailed")}{" "}
          <button type="button" onClick={retry}>
            {t("routerRetry")}
          </button>
        </span>
      ) : unavailable ? (
        <span role="status">{t("routerSelectionUnavailable")}</span>
      ) : busy ? (
        <span role="status">{t("routerChecking")}</span>
      ) : null}
    </div>
  );
}
