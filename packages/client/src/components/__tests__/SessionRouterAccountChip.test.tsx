// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionRouterAccountPane } from "../SessionRouterAccountPane";
import { SessionRouterAccountChip } from "../SessionRouterAccountChip";

const OTHER_POOL = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
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
              accountIds: ["a", "b"],
            },
            {
              id: OTHER_POOL,
              name: "Personal",
              provider: "claude",
              accountIds: ["b"],
            },
          ],
          accounts: ["a", "b"].map((id) => ({
            id,
            displayName: `Account ${id}`,
            provider: "claude",
            enabled: true,
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

const item = (name: string) => screen.getByRole("button", { name });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
        canSwitch
        onSwitched={onSwitched}
      />,
    );
    const pool = screen.getByRole("combobox", { name: "sessionAccountPool" });
    const account = screen.getByRole("combobox", { name: "routerAccount" });
    const apply = item("sessionAccountApply") as HTMLButtonElement;
    expect((account as HTMLSelectElement).value).toBe("a");
    expect(apply.disabled).toBe(true);
    fireEvent.change(pool, { target: { value: OTHER_POOL } });
    expect((account as HTMLSelectElement).value).toBe("");
    expect(apply.disabled).toBe(true);
    fireEvent.change(account, { target: { value: "b" } });
    expect(apply.disabled).toBe(false);
    expect(mockSwitch).not.toHaveBeenCalled();
    fireEvent.click(apply);
    fireEvent.click(apply);
    expect(mockSwitch).toHaveBeenCalledTimes(1);
    expect((pool as HTMLSelectElement).disabled).toBe(true);
    expect(mockSwitch).toHaveBeenCalledWith("s", {
      routerPoolId: OTHER_POOL,
      routerAccountId: "b",
    });
    finish({ routerBinding: null });
    await waitFor(() => expect(onSwitched).toHaveBeenCalledTimes(1));
  });

  it("keeps a refused selection for retry and can explicitly apply direct login", async () => {
    mockSwitch.mockRejectedValueOnce(new Error("account exhausted"));
    const onSwitched = vi.fn();
    render(
      <SessionRouterAccountPane
        sessionId="s"
        binding={binding}
        provider="claude"
        canSwitch
        onSwitched={onSwitched}
      />,
    );
    fireEvent.change(screen.getByRole("combobox", { name: "routerAccount" }), {
      target: { value: "b" },
    });
    fireEvent.click(item("sessionAccountApply"));
    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith("routerSwitchFailed", "error"),
    );
    expect(onSwitched).not.toHaveBeenCalled();
    expect(
      (
        screen.getByRole("combobox", {
          name: "routerAccount",
        }) as HTMLSelectElement
      ).value,
    ).toBe("b");
    mockSwitch.mockResolvedValue({ routerBinding: null });
    fireEvent.change(
      screen.getByRole("combobox", { name: "sessionAccountPool" }),
      {
        target: { value: "" },
      },
    );
    expect(
      screen.queryByRole("combobox", { name: "routerAccount" }),
    ).toBeNull();
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
        canSwitch
        onSwitched={onSwitched}
      />,
    );
    expect((item("sessionAccountApply") as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(
      screen.getByRole("combobox", { name: "sessionAccountPool" }),
      {
        target: { value: "" },
      },
    );
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
