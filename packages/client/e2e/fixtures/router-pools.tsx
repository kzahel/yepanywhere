import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { AgentAuthRouterOverview } from "@yep-anywhere/shared";
import { api, type VersionInfo } from "../../src/api/client";
import { AgentAuthRouterPools } from "../../src/components/AgentAuthRouterPools";
import {
  RouterPoolSelector,
  type RouterSelection,
} from "../../src/components/RouterPoolSelector";
import { useRouterDiscovery } from "../../src/hooks/useRouterDiscovery";
import { I18nProvider } from "../../src/i18n";
import "../../src/styles/index.css";

// Browser-only service substitutes; AAR's pinned integration suite proves the
// real control/native boundaries. This fixture never contacts a provider.
const modern = !new URLSearchParams(location.search).has("legacy");
const ownerManaged = new URLSearchParams(location.search).has("owner");
api.getVersion = async () =>
  ({
    current: "0.9.4",
    capabilities: [
      ...(ownerManaged ? ["agent-auth-router-owned-pools"] : []),
      ...(modern ? ["agent-auth-router-most-remaining"] : []),
    ],
  }) as VersionInfo;
const state: AgentAuthRouterOverview = {
  supportedPolicies: modern
    ? ["manual", "round-robin", "most-remaining"]
    : ["manual", "round-robin"],
  admissionRefresh: modern,
  ...(ownerManaged ? { canManagePools: false } : {}),
  observedAt: "2026-10-03T08:00:00Z",
  quotaFreshSeconds: 120,
  pools: [
    {
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      name: "Personal Codex",
      provider: "codex",
      accountIds: Array.from({ length: 16 }, (_, i) => `account-${i + 1}`),
      policy: "round-robin",
      revision: 1,
      bindings: [{ accountId: "account-1", count: 3 }],
    },
  ],
  accounts: Array.from({ length: 48 }, (_, i) => ({
    id: `account-${i + 1}`,
    provider: i < 24 ? "codex" : "claude",
    enabled: i !== 2,
    renewal: "manual",
    freshness: i === 1 ? "stale" : i === 3 ? "unknown" : "fresh",
    error: i === 1 ? "Quota refresh unavailable" : null,
    models: [
      {
        id: "fixture-model",
        name: "Fixture model",
        supportsEffort: true,
        supportedReasoningEfforts: [
          { reasoningEffort: "high", description: "High" },
        ],
      },
    ],
    catalogAt: "2026-10-03T08:00:00Z",
    attemptedAt: "2026-10-03T08:00:00Z",
    quota: i === 3 ? null : { observedAt: "2026-10-03T08:00:00Z" },
    windows:
      i === 3
        ? []
        : [
            {
              bucket: "codex:primary",
              windowMinutes: 300,
              usedPercent: i === 0 ? 100 : 32,
              remainingPercent: i === 0 ? 0 : 68,
              resetsAt: "2026-10-03T10:15:00Z",
              scope: "all",
            },
            {
              bucket: "codex:secondary",
              windowMinutes: 10080,
              usedPercent: 55,
              remainingPercent: 45,
              resetsAt: "2026-10-08T12:00:00Z",
              scope: "all",
            },
          ],
  })),
};
api.routerSelection = async () => {
  await new Promise((resolve) => setTimeout(resolve, 150));
  return structuredClone(state);
};
api.routerOverview = async (body = {}) => {
  await new Promise((resolve) => setTimeout(resolve, 150));
  const result = structuredClone(state),
    pool = state.pools.find((p) => p.id === body.poolId);
  if (pool)
    result.selection = {
      poolId: pool.id,
      model: body.model ?? null,
      decisions: pool.accountIds.map((accountId, i) => ({
        accountId,
        evidence: {
          headroomPercent: 45,
          limitingBuckets: ["codex:secondary"],
          reservations: 0,
          catalogAt: state.observedAt,
          quotaAt: state.observedAt,
        },
        reason: !body.model
          ? "model-required"
          : i === 0
            ? "exhausted"
            : i === 1
              ? "quota-stale"
              : i === 2
                ? "disabled"
                : i === 3
                  ? "quota-unknown"
                  : "eligible",
      })),
    };
  return result;
};
api.routerRefreshOverview = async () => {
  state.accounts[1]!.freshness = "fresh";
  state.accounts[1]!.error = null;
  return structuredClone(state);
};
api.routerSavePool = async (body) => {
  const existing = state.pools.find((p) => p.id === body.id);
  if (existing && existing.revision !== body.revision)
    throw new Error("Pool changed; reload before editing");
  const next = {
    ...body,
    revision: body.revision + 1,
    bindings: existing?.bindings ?? [],
  };
  state.pools = [...state.pools.filter((p) => p.id !== body.id), next];
  return {};
};
api.routerRemovePool = async (body) => {
  state.pools = state.pools.filter((p) => p.id !== body.id);
  return {};
};
function Fixture() {
  const discovery = useRouterDiscovery("codex", true);
  const [prompt, setPrompt] = useState("");
  const [updates, setUpdates] = useState(0),
    [selection, setSelection] = useState<RouterSelection | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setUpdates((n) => n + 1), 25);
    return () => clearInterval(timer);
  }, []);
  return (
    <main
      style={{ padding: 12, maxWidth: 950, margin: "auto" }}
      data-updates={updates}
    >
      <AgentAuthRouterPools />
      <section aria-label="New session">
        <label>
          Prompt
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        <RouterPoolSelector
          data={discovery.data}
          model="fixture-model"
          thinking="on:high"
          sourceKey="fixture"
          busy={discovery.busy}
          error={discovery.error}
          retry={() => void discovery.reload()}
          provider="codex"
          value={selection}
          onChange={setSelection}
          disabled={false}
        />
        <output aria-label="Selected route">{JSON.stringify(selection)}</output>
      </section>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <I18nProvider>
    <MemoryRouter>
      <Fixture />
    </MemoryRouter>
  </I18nProvider>,
);
