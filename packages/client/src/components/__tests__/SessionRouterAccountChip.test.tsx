// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionRouterAccountPane } from "../SessionRouterAccountPane";
import { SessionRouterAccountChip } from "../SessionRouterAccountChip";

const OTHER_POOL = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const OPUS = {
  id: "claude-opus-5-5",
  name: "Opus 5.5",
  supportsEffort: true,
  supportsAdaptiveThinking: true,
  supportedReasoningEfforts: [
    { reasoningEffort: "high", description: "High" },
    { reasoningEffort: "max", description: "Max" },
  ],
};
const HAIKU = { ...OPUS, id: "claude-haiku-5-5", name: "Haiku 5.5" };
const POOL = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const { mockSwitch, mockShowToast } = vi.hoisted(() => ({
  mockSwitch: vi.fn(),
  mockShowToast: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: {
    switchSessionRouterAccount: mockSwitch,
  },
}));
vi.mock("../../contexts/ToastContext", () => ({
  useToastContext: () => ({ showToast: mockShowToast }),
}));
vi.mock("../../hooks/useRouterDiscovery", () => ({
  useRouterDiscovery: (_provider: string, enabled: boolean) => ({
    loaded: enabled,
    error: false,
    data: enabled
      ? {
          pools: [
            {
              id: POOL,
              name: "Work",
              provider: "claude",
              accountIds: ["a", "b", "c"],
            },
            {
              id: OTHER_POOL,
              name: "Personal",
              provider: "claude",
              accountIds: ["b"],
            },
          ],
          accounts: ["a", "b", "c"].map((id) => ({
            id,
            displayName: `Account ${id}`,
            provider: "claude",
            enabled: true,
            models: [id === "c" ? HAIKU : OPUS],
            windows:
              id === "b"
                ? [
                    {
                      bucket: "five_hour",
                      scope: "all",
                      remainingPercent: 40,
                      resetsAt: null,
                      windowMinutes: 300,
                    },
                  ]
                : [],
          })),
        }
      : null,
  }),
}));
vi.mock("../../hooks/useActingPrincipal", () => ({
  useActingPrincipal: () => ({ principal: { username: null } }),
}));
vi.mock("../../i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
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
      <span data-testid="selected">{selected[0] ?? ""}</span>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          disabled={option.disabled}
          title={option.description}
          onClick={() => onChange([option.value])}
        >
          {option.label}
          {option.meta}
        </button>
      ))}
    </div>
  ),
}));

const item = (name: string) => screen.getByRole("button", { name });
const dropdown = (label: string) =>
  within(screen.getByTestId(`filter-${label}`));
const chosen = (label: string) =>
  dropdown(label).getByTestId("selected").textContent;
const pick = (label: string, option: string | RegExp) =>
  fireEvent.click(dropdown(label).getByRole("button", { name: option }));
const launch = {
  models: ["claude-opus-5-5", "opus"],
  thinking: { type: "adaptive" as const },
  effort: "high" as const,
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const binding = {
  id: "binding",
  routerId: "r",
  accountId: "a",
  provider: "claude" as const,
  poolId: POOL,
  poolName: "Work",
  accountDisplayName: "Account a",
};

describe("Session router account controls", () => {
  it("stages pool/account changes until Apply and prevents incomplete or duplicate switches", async () => {
    let finish!: (value: { routerBinding: null }) => void;
    mockSwitch.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const onSwitched = vi.fn();
    render(
      <SessionRouterAccountPane
        sessionId="s"
        binding={binding}
        provider="claude"
        launch={launch}
        canSwitch
        onSwitched={onSwitched}
      />,
    );
    const apply = item("sessionAccountApply") as HTMLButtonElement;
    expect(chosen("routerAccount")).toBe("a");
    expect(apply.disabled).toBe(true);
    pick("sessionAccountPool", "Personal");
    expect(chosen("routerAccount")).toBe("");
    expect(apply.disabled).toBe(true);
    pick("routerAccount", /^Account b/);
    expect(apply.disabled).toBe(false);
    expect(mockSwitch).not.toHaveBeenCalled();
    fireEvent.click(apply);
    fireEvent.click(apply);
    expect(mockSwitch).toHaveBeenCalledTimes(1);
    // Every choice locks while applying.
    expect(
      dropdown("sessionAccountPool")
        .getAllByRole("button")
        .every((b) => (b as HTMLButtonElement).disabled),
    ).toBe(true);
    expect(mockSwitch).toHaveBeenCalledWith("s", {
      routerPoolId: OTHER_POOL,
      routerAccountId: "b",
    });
    finish({ routerBinding: null });
    await waitFor(() => expect(onSwitched).toHaveBeenCalledTimes(1));
  });

  it("shows each account's quota and refuses accounts that cannot serve the session's model and effort", () => {
    const view = render(
      <SessionRouterAccountPane
        sessionId="s"
        binding={binding}
        provider="claude"
        launch={launch}
        canSwitch
        onSwitched={vi.fn()}
      />,
    );
    const rows = () =>
      dropdown("routerAccount")
        .getAllByRole("button")
        .map((b) => [
          b.textContent,
          b.title,
          (b as HTMLButtonElement).disabled,
        ]);
    expect(rows()).toEqual([
      ["Account arouterQuotaNotObserved", "sessionAccountCurrentOption", false],
      ["Account brouterQuotaLineNoReset", "", false],
      ["Account crouterQuotaNotObserved", "routerReasonModelUnavailable", true],
    ]);
    expect(
      dropdown("sessionAccountPool").getByRole("button", { name: "Work" })
        .title,
    ).toBe("routerPoolCompatibleAccounts · routerPoolBestRemaining");
    // An effort the catalog lacks rules out every account, and the pool.
    view.rerender(
      <SessionRouterAccountPane
        sessionId="s"
        binding={binding}
        provider="claude"
        launch={{ ...launch, effort: "low" }}
        canSwitch
        onSwitched={vi.fn()}
      />,
    );
    expect(rows().map((row) => row[2])).toEqual([true, true, true]);
    expect(
      (
        dropdown("sessionAccountPool").getByRole("button", {
          name: "Personal",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("keeps a refused selection for retry and can explicitly apply direct login", async () => {
    mockSwitch.mockRejectedValueOnce(new Error("account exhausted"));
    const onSwitched = vi.fn();
    render(
      <SessionRouterAccountPane
        sessionId="s"
        binding={binding}
        provider="claude"
        launch={launch}
        canSwitch
        onSwitched={onSwitched}
      />,
    );
    pick("routerAccount", /^Account b/);
    fireEvent.click(item("sessionAccountApply"));
    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith("routerSwitchFailed", "error"),
    );
    expect(onSwitched).not.toHaveBeenCalled();
    expect(chosen("routerAccount")).toBe("b");
    mockSwitch.mockResolvedValue({ routerBinding: null });
    pick("sessionAccountPool", "sessionAccountDirectLogin");
    expect(screen.queryByTestId("filter-routerAccount")).toBeNull();
    expect(mockSwitch).toHaveBeenCalledTimes(1);
    fireEvent.click(item("sessionAccountApply"));
    await waitFor(() => expect(onSwitched).toHaveBeenCalledTimes(1));
    expect(mockSwitch).toHaveBeenLastCalledWith("s", null);
  });

  it("can leave a legacy router binding without a pool for direct login", async () => {
    mockSwitch.mockResolvedValue({ routerBinding: null });
    const onSwitched = vi.fn();
    render(
      <SessionRouterAccountPane
        sessionId="s"
        binding={{ ...binding, poolId: undefined, poolName: undefined }}
        provider="claude"
        launch={launch}
        canSwitch
        onSwitched={onSwitched}
      />,
    );
    expect(chosen("sessionAccountPool")).toBe("unpooled");
    expect((item("sessionAccountApply") as HTMLButtonElement).disabled).toBe(
      true,
    );
    pick("sessionAccountPool", "sessionAccountDirectLogin");
    fireEvent.click(item("sessionAccountApply"));
    await waitFor(() => expect(onSwitched).toHaveBeenCalledTimes(1));
    expect(mockSwitch).toHaveBeenCalledWith("s", null);
  });

  it("offers Direct only when a router pool serves the provider", async () => {
    const { rerender } = render(
      <SessionRouterAccountChip
        binding={undefined}
        provider="codex"
        canSwitch
        onDetails={() => {}}
      />,
    );
    // The connected router's only pool is Claude's.
    expect(screen.queryByRole("button")).toBeNull();
    rerender(
      <SessionRouterAccountChip
        binding={undefined}
        provider="claude"
        canSwitch
        onDetails={() => {}}
      />,
    );
    expect((await screen.findByRole("button")).getAttribute("aria-label")).toBe(
      "routerSwitchDirectTitle",
    );
  });

  it("opens the shared account tab without a dropdown", () => {
    const onDetails = vi.fn();
    render(
      <SessionRouterAccountChip
        binding={binding}
        provider="claude"
        canSwitch={false}
        onDetails={onDetails}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onDetails).toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
