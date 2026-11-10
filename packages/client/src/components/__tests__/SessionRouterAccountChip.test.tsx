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
  it("switches to another pool account and reports it", async () => {
    mockSwitch.mockResolvedValue({ routerBinding: null });
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
    expect(item("Account a").getAttribute("aria-pressed")).toBe("true");
    expect((item("Account a") as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByRole("region", { name: "Work" }).contains(item("Account b")),
    ).toBe(true);
    fireEvent.click(item("Account b"));
    await waitFor(() => expect(onSwitched).toHaveBeenCalled());
    expect(mockSwitch).toHaveBeenCalledWith("s", {
      routerPoolId: POOL,
      routerAccountId: "b",
    });
  });

  it("offers a direct session the router and shows a refusal", async () => {
    mockSwitch.mockRejectedValue(new Error("account exhausted"));
    const onSwitched = vi.fn();
    render(
      <SessionRouterAccountPane
        sessionId="s"
        binding={undefined}
        provider="claude"
        canSwitch
        onSwitched={onSwitched}
      />,
    );
    expect((item("routerSwitchDirect") as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(item("Account a"));
    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith("routerSwitchFailed", "error"),
    );
    expect(onSwitched).not.toHaveBeenCalled();
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
