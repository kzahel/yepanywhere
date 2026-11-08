// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionRouterAccountChip } from "../SessionRouterAccountChip";

const POOL = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const { mockSwitch, mockShowToast } = vi.hoisted(() => ({
  mockSwitch: vi.fn(),
  mockShowToast: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: {
    switchSessionRouterAccount: mockSwitch,
    routerStatus: async () => ({ state: "connected", routerId: "r" }),
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

const item = (name: string) =>
  screen.getByRole("menuitemradio", { name }) as HTMLButtonElement;

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

describe("SessionRouterAccountChip", () => {
  it("switches to another pool account and reports it", async () => {
    mockSwitch.mockResolvedValue({ routerBinding: null });
    const onSwitched = vi.fn();
    render(
      <SessionRouterAccountChip
        sessionId="s"
        binding={binding}
        provider="claude"
        canSwitch
        onDetails={vi.fn()}
        onSwitched={onSwitched}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /routerChipTooltip/ }));
    // Focus enters the menu on its first enabled item; arrows move it.
    await waitFor(() => expect(document.activeElement).toBe(item("Account b")));
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(document.activeElement).toBe(item("routerSwitchDirect"));
    expect(item("Account a").disabled).toBe(true);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Account b" }));
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
      <SessionRouterAccountChip
        sessionId="s"
        binding={undefined}
        provider="claude"
        canSwitch
        onDetails={vi.fn()}
        onSwitched={onSwitched}
      />,
    );
    fireEvent.click(await screen.findByText("routerSwitchDirect"));
    expect(item("routerSwitchDirect").disabled).toBe(true);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Account a" }));
    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith("routerSwitchFailed", "error"),
    );
    expect(onSwitched).not.toHaveBeenCalled();
  });

  it("stays a session-info shortcut without the switch capability", () => {
    const onDetails = vi.fn();
    render(
      <SessionRouterAccountChip
        sessionId="s"
        binding={binding}
        provider="claude"
        canSwitch={false}
        onDetails={onDetails}
        onSwitched={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onDetails).toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
