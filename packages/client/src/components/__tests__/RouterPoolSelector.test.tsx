// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AgentAuthRouterOverview } from "@yep-anywhere/shared";
import { afterEach, expect, it, vi } from "vitest";
import {
  RouterPoolSelector,
  routerPoolMembers,
  routedModels,
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
function overview(): AgentAuthRouterOverview {
  return {
    observedAt: "now",
    quotaFreshSeconds: 120,
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
it("keeps an unavailable selection and offers manual account choice only for multiple compatible members", () => {
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
  expect(screen.getAllByRole("combobox")).toHaveLength(1);
  data.pools[0]!.policy = "manual";
  view.rerender(<RouterPoolSelector {...props} />);
  expect(screen.getAllByRole("combobox")).toHaveLength(2);
  data.accounts[1]!.enabled = false;
  view.rerender(<RouterPoolSelector {...props} />);
  expect(screen.getAllByRole("combobox")).toHaveLength(1);
  view.rerender(
    <RouterPoolSelector {...props} data={{ ...data, pools: [] }} />,
  );
  expect((screen.getByLabelText("routerPool") as HTMLSelectElement).value).toBe(
    "work",
  );
  expect(screen.getByRole("status").textContent).toBe(
    "routerSelectionUnavailable",
  );
  expect(change).not.toHaveBeenCalled();
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
    <output>
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
  fixture.selection.mockResolvedValue({
    ...overview(),
    pools: [{ ...overview().pools[0]!, name: "Codex" }],
  });
  view.rerender(<Discovery provider="codex" />);
  await screen.findByText("Codex");
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
});
