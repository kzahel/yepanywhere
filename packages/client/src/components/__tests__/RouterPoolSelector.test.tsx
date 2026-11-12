// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { AgentAuthRouterOverview } from "@yep-anywhere/shared";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  RouterPoolSelector,
  formatReset,
  observationAge,
  routerAccountIssue,
  routerBindingChip,
  routerPoolMembers,
  restoreRouterSelection,
  routedModels,
  tightestRemaining,
} from "../RouterPoolSelector";
import { useRouterDiscovery } from "../../hooks/useRouterDiscovery";
const fixture = vi.hoisted(() => ({ source: "local", selection: vi.fn() }));
vi.mock("../../api/client", () => ({
  api: { routerSelection: fixture.selection },
}));
vi.mock("../../lib/clientSummaryStore", () => ({
  useClientSummarySourceKey: () => fixture.source,
}));
vi.mock("../../i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("../FilterDropdown", () => ({
  FilterDropdown: ({
    label,
    options,
    selected,
    onChange,
  }: {
    label: string;
    options: Array<{
      value: string;
      label: string;
      description?: string;
      disabled?: boolean;
      meta?: ReactNode;
    }>;
    selected: string[];
    onChange: (selected: string[]) => void;
  }) => (
    <div data-testid={`filter-${label}`}>
      <span data-testid="filter-selected">{selected[0] ?? ""}</span>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          disabled={option.disabled}
          title={option.description}
          onClick={() => onChange([option.value])}
        >
          {option.label}
          {option.meta && <span data-testid="meta">{option.meta}</span>}
        </button>
      ))}
    </div>
  ),
}));
function dropdown(label: string) {
  return within(screen.getByTestId(`filter-${label}`));
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  fixture.source = "local";
});
const model = {
  id: "claude-opus-4-8",
  name: "Opus",
  supportsEffort: true,
  supportsAdaptiveThinking: true,
  supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }],
};
const POLICIES = [
  { id: "manual", label: "Manual" },
  { id: "round-robin", label: "Round robin" },
  { id: "most-remaining", label: "Most remaining" },
  { id: "weekly-pace", label: "Weekly pace" },
];
it("restores only usable pool, account and policy preferences", () => {
  const data = overview();
  const preference = {
    sourceKey: "local",
    poolId: "work",
    accountId: "",
    policy: "weekly-pace",
  };
  const restore = (
    value = preference,
    snapshot: AgentAuthRouterOverview | null = data,
    provider = "claude",
    selectedModel = "opus",
    thinking: import("@yep-anywhere/shared").ThinkingOption = "on:high",
  ) =>
    restoreRouterSelection(value, snapshot, provider, selectedModel, thinking);
  expect(restore()).toEqual(preference);
  expect(restore(preference, null)).toBeNull();
  expect(restore({ ...preference, poolId: "deleted" })).toBeNull();
  expect(restore(preference, data, "codex")).toBeNull();
  expect(restore(preference, data, "claude", "unavailable")).toBeNull();
  expect(restore(preference, data, "claude", "opus", "on:low")).toBeNull();
  expect(restore({ ...preference, policy: "removed" })).toBeNull();
  expect(restore({ ...preference, accountId: "deleted" })).toBeNull();
  const accountId = data.pools[0]!.accountIds[0]!;
  expect(restore({ ...preference, accountId })).toMatchObject({ accountId });
  const disabled = structuredClone(data);
  disabled.accounts.forEach((account) => {
    account.enabled = false;
  });
  expect(restore(preference, disabled)).toBeNull();
});
function overview(): AgentAuthRouterOverview {
  return {
    observedAt: "now",
    quotaFreshSeconds: 120,
    supportedPolicies: POLICIES.map((p) => p.id),
    policies: POLICIES,
    pools: [
      {
        id: "work",
        name: "Work",
        provider: "claude",
        policy: "most-remaining",
        revision: 1,
        bindings: [],
        accountIds: ["a", "b"],
      },
    ],
    accounts: ["a", "b"].map((id) => ({
      id,
      provider: "claude",
      enabled: true,
      renewal: "manual",
      freshness: "unknown",
      models: [model],
      catalogAt: null,
      attemptedAt: null,
      error: null,
      quota: null,
      windows: [],
    })),
  };
}
it("resolves a family alias once and only includes accounts supporting its concrete model and effort", () => {
  const data = overview();
  data.accounts[1]!.models = [{ ...model, id: "claude-opus-4-7" }];
  expect(
    routerPoolMembers(data, "work", "claude", "opus", "on:high").map(
      (a) => a.id,
    ),
  ).toEqual(["a"]);
  expect(routerPoolMembers(data, "work", "claude", "opus", "on:max")).toEqual(
    [],
  );
  expect(routerPoolMembers(data, "work", "codex", "opus", "auto")).toEqual([]);
  data.accounts[0]!.enabled = false;
  expect(routedModels(data, "claude", "work").map((m) => m.id)).toEqual([
    "claude-opus-4-7",
  ]);
});
it("resolves an alias to the target the members' CLIs report, not the newest family member", () => {
  const data = overview();
  data.accounts[1]!.models = [{ ...model, id: "claude-opus-4-7" }];
  for (const account of data.accounts)
    account.cliModels = [
      { id: "opus", name: "Opus", resolvedModel: "claude-opus-4-7[1m]" },
    ];
  expect(
    routerPoolMembers(data, "work", "claude", "opus", "on:high").map(
      (a) => a.id,
    ),
  ).toEqual(["b"]);
  data.accounts[0]!.cliModels = [
    { id: "opus", name: "Opus", resolvedModel: "claude-opus-4-8" },
  ];
  expect(
    routerPoolMembers(data, "work", "claude", "opus", "on:high"),
    "members disagree",
  ).toEqual([]);
});
it("lists Direct first and every pool with its policy and compatible count, disabling pools no account can serve", () => {
  const data = overview(),
    change = vi.fn();
  data.pools.push({
    ...data.pools[0]!,
    id: "spare",
    name: "Spare",
    policy: "round-robin",
    accountIds: ["b"],
  });
  data.accounts[1]!.models = [];
  render(
    <RouterPoolSelector
      data={data}
      provider="claude"
      model="opus"
      thinking="on:high"
      value={null}
      onChange={change}
      sourceKey="local"
      busy={false}
      error={false}
      retry={vi.fn()}
      disabled={false}
    />,
  );
  const options = dropdown("routerPool").getAllByRole("button");
  expect(options.map((o) => o.textContent)).toEqual([
    "routerDirect",
    "Work",
    "Spare",
  ]);
  expect(options.map((o) => o.title)).toEqual([
    "routerDirectDescription",
    "Most remaining · routerPoolCompatibleAccounts",
    "Round robin · routerReasonNoAccountOffers",
  ]);
  expect(options.map((o) => (o as HTMLButtonElement).disabled)).toEqual([
    false,
    false,
    true,
  ]);
  expect(
    dropdown("routerPool").getByTestId("filter-selected").textContent,
  ).toBe("");
  expect(screen.queryByRole("status")).toBeNull();
  fireEvent.click(options[1]!);
  expect(change).toHaveBeenLastCalledWith({
    sourceKey: "local",
    poolId: "work",
    accountId: "",
  });
  fireEvent.click(options[0]!);
  expect(change).toHaveBeenLastCalledWith(null);
});
it("offers the pool default, the router's other policies and each account in any pool, and keeps an unavailable selection", () => {
  const data = overview(),
    change = vi.fn();
  const props = {
    data,
    provider: "claude",
    model: "opus",
    thinking: "on:high" as const,
    value: { sourceKey: "local", poolId: "work", accountId: "" },
    onChange: change,
    sourceKey: "local",
    busy: false,
    error: false,
    retry: vi.fn(),
    disabled: false,
  };
  const view = render(<RouterPoolSelector {...props} />);
  expect(
    dropdown("routerPool").getByTestId("filter-selected").textContent,
  ).toBe("work");
  // An automatic pool: its default first, then other policies, then accounts.
  const choices = () => dropdown("routerAccount").getAllByRole("button");
  expect(choices().map((o) => [o.textContent, o.title])).toEqual([
    ["Most remaining", "routerPolicyPoolDefault"],
    ["Round robin", ""],
    ["Weekly pace", ""],
    ["routerAccountNumberrouterQuotaNotObserved", ""],
    ["routerAccountNumberrouterQuotaNotObserved", ""],
  ]);
  expect(
    dropdown("routerAccount").getByTestId("filter-selected").textContent,
  ).toBe("policy:most-remaining");
  fireEvent.click(choices()[2]!);
  expect(change).toHaveBeenLastCalledWith({
    ...props.value,
    accountId: "",
    policy: "weekly-pace",
  });
  fireEvent.click(choices()[4]!);
  expect(change).toHaveBeenLastCalledWith({
    ...props.value,
    accountId: "b",
    policy: undefined,
  });
  fireEvent.click(choices()[0]!);
  expect(change).toHaveBeenLastCalledWith({
    ...props.value,
    accountId: "",
    policy: undefined,
  });
  // A Manual default needs a pick unless only one account fits.
  data.pools[0]!.policy = "manual";
  view.rerender(<RouterPoolSelector {...props} />);
  expect(choices().map((o) => o.textContent)).toEqual([
    "Round robin",
    "Most remaining",
    "Weekly pace",
    "routerAccountNumberrouterQuotaNotObserved",
    "routerAccountNumberrouterQuotaNotObserved",
  ]);
  expect(
    dropdown("routerAccount").getByTestId("filter-selected").textContent,
  ).toBe("");
  data.accounts[1]!.enabled = false;
  view.rerender(<RouterPoolSelector {...props} />);
  expect(
    choices()
      .slice(3)
      .map((o) => [o.title, (o as HTMLButtonElement).disabled]),
  ).toEqual([
    ["", false],
    ["routerReasonDisabled", true],
  ]);
  expect(
    dropdown("routerAccount").getByTestId("filter-selected").textContent,
  ).toBe("a");
  view.rerender(
    <RouterPoolSelector {...props} data={{ ...data, pools: [] }} />,
  );
  expect(
    dropdown("routerPool").getByTestId("filter-selected").textContent,
  ).toBe("work");
  expect(
    dropdown("routerPool").getByRole("button", {
      name: "routerPoolUnavailable",
    }),
  ).toHaveProperty("disabled", true);
  expect(screen.getByRole("status").textContent).toBe(
    "routerSelectionUnavailable",
  );
  expect(change).toHaveBeenCalledTimes(3);
});
it("shows discovery failure with Retry, and progress while checking", () => {
  const retry = vi.fn();
  const props = {
    data: null,
    provider: "claude",
    model: "opus",
    thinking: "on:high" as const,
    value: null,
    onChange: vi.fn(),
    sourceKey: "local",
    busy: true,
    error: true,
    retry,
    disabled: false,
  };
  const view = render(<RouterPoolSelector {...props} />);
  expect(screen.getByRole("alert").textContent).toContain(
    "routerDiscoveryFailed",
  );
  fireEvent.click(screen.getByRole("button", { name: "routerRetry" }));
  expect(retry).toHaveBeenCalledTimes(1);
  view.rerender(
    <RouterPoolSelector {...props} error={false} data={overview()} />,
  );
  expect(screen.getByRole("status").textContent).toBe("routerChecking");
  view.rerender(<RouterPoolSelector {...props} error={false} busy={false} />);
  expect(view.container.textContent).toBe("");
  // No pool granted for this provider: nothing to route, so no control.
  view.rerender(
    <RouterPoolSelector
      {...props}
      provider="codex"
      error={false}
      busy={false}
      data={overview()}
    />,
  );
  expect(view.container.textContent).toBe("");
});
function Discovery({
  provider = "claude",
  enabled = true,
}: {
  provider?: string;
  enabled?: boolean;
}) {
  const state = useRouterDiscovery(provider, enabled);
  return (
    <output data-loaded={state.loaded}>
      {state.data?.pools[0]?.name ?? (state.error ? "error" : "empty")}
    </output>
  );
}
it("coalesces mount and focus, discards old-provider responses, and refreshes on connection changes", async () => {
  let resolve!: (data: AgentAuthRouterOverview) => void;
  fixture.selection.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const view = render(
    <>
      <Discovery />
      <Discovery />
    </>,
  );
  fireEvent.focus(window);
  expect(fixture.selection).toHaveBeenCalledTimes(1);
  expect(
    screen
      .getAllByText("empty")
      .every((element) => element.dataset.loaded === "false"),
  ).toBe(true);
  fixture.selection.mockResolvedValue({
    ...overview(),
    pools: [{ ...overview().pools[0]!, name: "Codex" }],
  });
  view.rerender(<Discovery provider="codex" />);
  await screen.findByText("Codex");
  expect(screen.getByText("Codex").dataset.loaded).toBe("true");
  await act(async () => resolve(overview()));
  expect(screen.queryByText("Work")).toBeNull();
  fireEvent(window, new Event("router-connection-changed"));
  await waitFor(() => expect(fixture.selection).toHaveBeenCalledTimes(3));
});
it("does not discover without the overall feature and hides data immediately on source changes", async () => {
  const view = render(<Discovery enabled={false} />);
  expect(fixture.selection).not.toHaveBeenCalled();
  fixture.selection.mockResolvedValueOnce(overview());
  view.rerender(<Discovery />);
  await screen.findByText("Work");
  fixture.source = "remote";
  fixture.selection.mockRejectedValueOnce(new Error("offline"));
  view.rerender(<Discovery />);
  expect(screen.queryByText("Work")).toBeNull();
  await screen.findByText("error");
  expect(screen.getByText("error").dataset.loaded).toBe("true");
});
it("derives account reasons from the overview, blocking only on catalog facts", () => {
  const t = ((key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${Object.values(params).join(",")}` : key) as Parameters<
    typeof routerAccountIssue
  >[0];
  const account = overview().accounts[0]!;
  const issue = (
    patch: Partial<typeof account>,
    model: string | null = "opus",
    thinking: "on:high" | "on:max" | "auto" = "on:high",
  ) =>
    routerAccountIssue(
      t,
      { ...account, ...patch },
      model,
      "Opus",
      "claude-opus-4-8",
      thinking,
    );
  expect(issue({})).toBeNull();
  expect(issue({ enabled: false })).toEqual({
    blocking: true,
    text: "routerReasonDisabled",
  });
  expect(issue({}, null)).toEqual({
    blocking: true,
    text: "routerReasonChooseModel",
  });
  expect(issue({ models: [] })).toEqual({
    blocking: true,
    text: "routerReasonModelUnavailable:Opus",
  });
  expect(issue({}, "opus", "on:max")).toEqual({
    blocking: true,
    text: "routerReasonEffortUnsupported:effortLevelMaxLabel",
  });
  expect(issue({ blocked: "auth-unavailable" })).toEqual({
    blocking: false,
    text: "routerReasonAuthBlocked",
  });
  expect(issue({ blocked: "cooldown" })).toEqual({
    blocking: false,
    text: "routerReasonCooldown",
  });
  expect(
    issue({
      windows: [
        {
          bucket: "claude:weekly-sonnet",
          windowMinutes: 10080,
          usedPercent: 100,
          remainingPercent: 0,
          resetsAt: null,
          scope: "sonnet",
        },
      ],
    }),
  ).toBeNull();
  expect(
    issue({
      windows: [
        {
          bucket: "claude:five-hour",
          windowMinutes: 300,
          usedPercent: 100,
          remainingPercent: 0,
          resetsAt: null,
          scope: "all",
        },
      ],
    }),
  ).toEqual({ blocking: false, text: "routerReasonExhausted" });
});
it("explains a pool no account can serve", () => {
  const data = overview(),
    change = vi.fn();
  const props = {
    data,
    provider: "claude",
    model: "opus",
    thinking: "on:max" as const,
    value: null,
    onChange: change,
    sourceKey: "local",
    busy: false,
    error: false,
    retry: vi.fn(),
    disabled: false,
  };
  const view = render(<RouterPoolSelector {...props} />);
  const workOption = () =>
    dropdown("routerPool").getByRole("button", { name: "Work" });
  expect(workOption().title).toBe(
    "Most remaining · routerReasonNoAccountSupportsEffort",
  );
  expect(workOption()).toHaveProperty("disabled", true);
  view.rerender(<RouterPoolSelector {...props} model={null} />);
  expect(workOption().title).toBe("Most remaining · routerReasonChooseModel");
  for (const a of data.accounts) a.enabled = false;
  view.rerender(<RouterPoolSelector {...props} />);
  expect(workOption().title).toBe(
    "Most remaining · routerReasonNoEnabledAccounts",
  );
});
const quotaWindow = (
  bucket: string,
  remainingPercent: number | null,
  scope: "all" | "opus" | "sonnet" | "unknown" = "all",
  resetsAt: string | null = "2026-10-05T14:15:00Z",
) => ({
  bucket,
  windowMinutes: bucket === "five_hour" ? 300 : 10080,
  usedPercent: remainingPercent === null ? null : 100 - remainingPercent,
  remainingPercent,
  resetsAt,
  scope,
});
it("does not call an explicitly permitted Codex account exhausted at a displayed zero", () => {
  const account = overview().accounts[0]!;
  account.provider = "codex";
  account.freshness = "fresh";
  account.quota = {
    observedAt: new Date().toISOString(),
    ordinaryUsageAllowed: true,
  };
  account.windows = [quotaWindow("codex:primary", 0)];
  expect(tightestRemaining(account, model.id)).toBeNull();
  expect(
    routerAccountIssue(
      (key) => key,
      account,
      model.id,
      model.name,
      model.id,
      "auto",
    ),
  ).toBeNull();
  account.quota.ordinaryUsageAllowed = false;
  expect(
    routerAccountIssue(
      (key) => key,
      account,
      model.id,
      model.name,
      model.id,
      "auto",
    )?.text,
  ).toBe("routerReasonExhausted");
});

it("shows every cached quota window per account and the best remaining per pool", () => {
  const data = overview();
  data.pools[0]!.policy = "manual";
  data.accounts[0]!.windows = [
    quotaWindow("five_hour", 68),
    quotaWindow("seven_day", 12),
    quotaWindow("seven_day_sonnet", 0, "sonnet"),
  ];
  // Observed just now: recent enough that no age is shown.
  data.accounts[0]!.quota = { observedAt: new Date().toISOString() };
  data.accounts[0]!.freshness = "fresh";
  data.accounts[1]!.windows = [
    quotaWindow("five_hour", 40),
    quotaWindow("seven_day", 90),
  ];
  data.accounts[1]!.freshness = "stale";
  data.accounts[1]!.quota = {
    observedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    source: "inference",
  };
  data.accounts[1]!.error = "Quota refresh unavailable";
  render(
    <RouterPoolSelector
      data={data}
      provider="claude"
      model="opus"
      thinking="on:high"
      value={{ sourceKey: "local", poolId: "work", accountId: "" }}
      onChange={vi.fn()}
      sourceKey="local"
      busy={false}
      error={false}
      retry={vi.fn()}
      disabled={false}
    />,
  );
  // Opus is bounded by the 5h and weekly windows, not the Sonnet one.
  expect(tightestRemaining(data.accounts[0]!, "claude-opus-4-8")).toBe(12);
  expect(tightestRemaining(data.accounts[1]!, "claude-opus-4-8")).toBe(40);
  expect(
    dropdown("routerPool").getByRole("button", { name: "Work" }).title,
  ).toBe("Manual · routerPoolCompatibleAccounts · routerPoolBestRemaining");
  const metas = dropdown("routerAccount").getAllByTestId("meta");
  expect(metas.map((m) => m.textContent)).toEqual([
    "routerQuotaLinerouterQuotaLinerouterQuotaLine",
    "routerQuotaLinerouterQuotaLinerouterQuotaUsedMinutesrouterQuotaRefreshFailed",
  ]);
  expect(metas[0]!.firstElementChild!.getAttribute("title")).toBe(
    "routerQuotaObservedTitle",
  );
});
it("states the observation age only once it is at least ten minutes old", () => {
  const t = ((key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${Object.values(params).join(",")}` : key) as Parameters<
    typeof observationAge
  >[0];
  const now = Date.parse("2026-10-05T10:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  expect(observationAge(t, ago(9 * 60 * 1000), now)).toBeNull();
  expect(observationAge(t, ago(10 * 60 * 1000), now)).toBe(
    "routerQuotaCheckedMinutes:10",
  );
  expect(observationAge(t, ago(3 * 60 * 60 * 1000), now)).toBe(
    "routerQuotaCheckedHours:3",
  );
  // Month and day order follow the runtime locale.
  expect(observationAge(t, ago(2 * 24 * 60 * 60 * 1000), now)).toMatch(
    /^routerQuotaCheckedOn:(Oct 3|3 Oct)$/,
  );
  expect(observationAge(t, "garbage", now)).toBeNull();
  // Header-derived observations are worded as a request, not a check.
  expect(observationAge(t, ago(9 * 60 * 1000), now, "inference")).toBeNull();
  expect(observationAge(t, ago(30 * 60 * 1000), now, "inference")).toBe(
    "routerQuotaUsedMinutes:30",
  );
  expect(observationAge(t, ago(5 * 60 * 60 * 1000), now, "inference")).toBe(
    "routerQuotaUsedHours:5",
  );
  expect(
    observationAge(t, ago(3 * 24 * 60 * 60 * 1000), now, "inference"),
  ).toMatch(/^routerQuotaUsedOn:/);
});
it("formats resets later today as a time and any other day with the date", () => {
  const now = new Date(2026, 9, 5, 21, 0).getTime();
  const local = (day: number, hour: number) =>
    new Date(2026, 9, day, hour, 0).toISOString();
  expect(formatReset(local(5, 23), now)).not.toMatch(/Oct/);
  // 23 hours away, but tomorrow: a bare "8:00 PM" would read as tonight.
  expect(formatReset(local(6, 20), now)).toMatch(/Oct/);
  expect(formatReset(local(8, 12), now)).toMatch(/Oct/);
});
it("labels a session pin by saved names and never shows the account id", () => {
  const t = ((key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${Object.values(params).join(",")}` : key) as Parameters<
    typeof routerBindingChip
  >[0];
  const pin = {
    id: "binding",
    routerId: "router",
    accountId: "b9e7a2a3-d2a2-40b7-b000-000000000000",
    provider: "claude" as const,
    poolId: "pool",
    policy: "round-robin",
    policyLabel: "Round robin",
    reason: "Round robin among eligible accounts",
  };
  const named = routerBindingChip(t, {
    ...pin,
    poolName: "work-claude",
    accountDisplayName: "Alice",
  });
  expect(named.label).toBe("work-claude · Alice");
  expect(named.tooltip.split("\n")).toEqual([
    "routerChipTooltipTitle",
    "routerChipTooltipPool:work-claude",
    "routerChipTooltipAccount:Alice",
    "routerChipTooltipPolicy:Round robin",
    "Round robin among eligible accounts",
    "routerChipTooltipOpen",
  ]);
  // Pins saved before names were kept: the id stays in the tooltip only.
  const legacy = routerBindingChip(t, pin);
  expect(legacy.label).toBe("Round robin");
  // Pins saved before labels were kept show the policy id.
  expect(routerBindingChip(t, { ...pin, policyLabel: undefined }).label).toBe(
    "round-robin",
  );
  expect(legacy.tooltip).toContain(pin.accountId);
  expect(
    routerBindingChip(t, { ...pin, policy: undefined, policyLabel: undefined })
      .label,
  ).toBe("routerChipFallback");
});

it("unions pool tiers but excludes accounts that cannot serve the selected speed", () => {
  const data = overview();
  data.accounts[0]!.models[0] = {
    ...model,
    serviceTiers: [{ id: "priority", name: "Fast", description: "" }],
  };
  data.accounts[1]!.models[0] = {
    ...model,
    serviceTiers: [{ id: "ultrafast", name: "Ultra Fast", description: "" }],
  };
  expect(
    routedModels(data, "claude", "work")[0]?.serviceTiers?.map((t) => t.id),
  ).toEqual(["priority", "ultrafast"]);
  expect(
    routerPoolMembers(
      data,
      "work",
      "claude",
      "opus",
      "on:high",
      "priority",
    ).map((a) => a.id),
  ).toEqual(["a"]);
  const t = (key: string) => key;
  expect(
    routerAccountIssue(
      t as never,
      data.accounts[1]!,
      "opus",
      "Opus",
      data.accounts[1]!.models[0]!.id,
      "on:high",
      "priority",
    )?.text,
  ).toBe("routerReasonSpeedUnsupported");
});
