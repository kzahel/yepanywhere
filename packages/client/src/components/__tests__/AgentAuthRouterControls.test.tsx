// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AgentAuthRouterRecovery } from "@yep-anywhere/shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import english from "../../i18n/en.json";
import { AgentAuthRouterSettings } from "../AgentAuthRouterControls";

const fixture = vi.hoisted(() => ({
  source: "host:first",
  capabilities: ["agent-auth-router", "agent-auth-router-recovery"],
  api: {
    routerStatus: vi.fn(),
    routerRecovery: vi.fn(),
    routerConnect: vi.fn(),
    routerDisconnect: vi.fn(),
    routerRetryCancellations: vi.fn(),
    routerAccounts: vi.fn(),
    routerCatalog: vi.fn(),
    routerQuotas: vi.fn(),
    routerOverview: vi.fn(),
    routerRefreshOverview: vi.fn(),
    routerSavePool: vi.fn(),
    routerRemovePool: vi.fn(),
  },
}));
const translate = (key: string, params?: Record<string, unknown>) => {
  let value = (english as Record<string, string>)[key] ?? key;
  for (const [name, replacement] of Object.entries(params ?? {}))
    value = value.replace(`{${name}}`, String(replacement));
  return value;
};
vi.mock("../../api/client", () => ({ api: fixture.api }));
vi.mock("../../hooks/useVersion", () => ({
  useVersion: () => ({ version: { capabilities: fixture.capabilities } }),
}));
vi.mock("../../lib/clientSummaryStore", () => ({
  useClientSummarySourceKey: () => fixture.source,
}));
vi.mock("../../i18n", () => ({ useI18n: () => ({ t: translate }) }));
let recovery: AgentAuthRouterRecovery;
beforeEach(() => {
  vi.resetAllMocks();
  fixture.source = "host:first";
  fixture.capabilities = ["agent-auth-router", "agent-auth-router-recovery"];
  recovery = {
    state: "connected",
    routerId: "router",
    reachable: true,
    checkedAt: "2026-10-03T08:00:00Z",
    pendingCancellations: 0,
    accounts: [
      { id: "work", provider: "codex", enabled: true, renewal: "manual" },
    ],
  };
  fixture.api.routerRecovery.mockImplementation(async () =>
    structuredClone(recovery),
  );
  fixture.api.routerStatus.mockResolvedValue({
    state: "connected",
    routerId: "router",
  });
  fixture.api.routerAccounts.mockResolvedValue({ accounts: recovery.accounts });
  fixture.api.routerCatalog.mockResolvedValue({
    models: [{ id: "model", name: "Model" }],
  });
});
afterEach(cleanup);

it("distinguishes saved pairing from reachability and refreshes disabled accounts explicitly", async () => {
  recovery.reachable = false;
  recovery.accounts = [];
  recovery.issue = {
    code: "unavailable",
    message: "Start AAR on the YA server, then retry.",
  };
  render(<AgentAuthRouterSettings />);
  await screen.findByText("Start AAR on the YA server, then retry.");
  expect(screen.getByText("Paired with local router")).toBeTruthy();
  expect(screen.queryByText(english.routerReady)).toBeNull();
  expect(fixture.api.routerRetryCancellations).not.toHaveBeenCalled();
  recovery.reachable = true;
  delete recovery.issue;
  recovery.accounts = [
    { id: "work", provider: "codex", enabled: false, renewal: "manual" },
  ];
  fireEvent.click(screen.getByRole("button", { name: "Check status" }));
  await screen.findByText(english.routerAccountDisabled);
  expect(
    (screen.getByRole("button", { name: "Refresh usage" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(fixture.api.routerRecovery).toHaveBeenCalledTimes(2);
});

it("retries only requested failed-launch cleanup, retaining a failed retry until acknowledgement", async () => {
  recovery.pendingCancellations = 2;
  render(<AgentAuthRouterSettings />);
  const retry = await screen.findByRole("button", {
    name: "Retry failed-launch cleanup",
  });
  fixture.api.routerRetryCancellations.mockRejectedValueOnce(
    new Error("Router unavailable; retry after starting AAR."),
  );
  fireEvent.click(retry);
  await screen.findByRole("alert");
  expect(screen.getByText("Failed-launch cleanup pending: 2")).toBeTruthy();
  fixture.api.routerRetryCancellations.mockImplementationOnce(async () => {
    recovery.pendingCancellations = 0;
    return { state: "connected", routerId: "router" };
  });
  await waitFor(() =>
    expect((retry as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(retry);
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Retry failed-launch cleanup" }),
    ).toBeNull(),
  );
  expect(fixture.api.routerRetryCancellations).toHaveBeenCalledTimes(2);
  expect(fixture.api.routerConnect).not.toHaveBeenCalled();
});

it("shows durable pending revocation after a disconnect fails, and offers only finishing it", async () => {
  render(<AgentAuthRouterSettings />);
  const disconnect = await screen.findByRole("button", {
    name: "Disconnect router",
  });
  fixture.api.routerDisconnect.mockImplementationOnce(async () => {
    recovery.state = "revocation-pending";
    recovery.reachable = false;
    recovery.accounts = [];
    throw new Error("Router unavailable");
  });
  fireEvent.click(disconnect);
  const finish = await screen.findByRole("button", {
    name: "Finish disconnecting",
  });
  expect(screen.getByText(english.routerRevocationHelp)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry connection" })).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
  fixture.api.routerDisconnect.mockImplementationOnce(async () => {
    recovery.state = "disconnected";
    return { state: "disconnected", routerId: "router" };
  });
  await waitFor(() =>
    expect((finish as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(finish);
  await screen.findByRole("button", { name: "Connect local router" });
});

it("makes no recovery request on an older capable server", async () => {
  fixture.capabilities = ["agent-auth-router"];
  render(<AgentAuthRouterSettings />);
  await screen.findByText("codex · work");
  expect(screen.getByText(english.routerLegacyStatus)).toBeTruthy();
  expect(fixture.api.routerRecovery).not.toHaveBeenCalled();
  expect(fixture.api.routerRetryCancellations).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Check status" }));
  await waitFor(() =>
    expect(fixture.api.routerAccounts).toHaveBeenCalledTimes(2),
  );
  expect(fixture.api.routerRecovery).not.toHaveBeenCalled();
});

it("discards old-source mutation results without starting follow-up requests on the next source", async () => {
  let finish!: () => void;
  fixture.api.routerConnect.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<AgentAuthRouterSettings />);
  await screen.findByText("codex · work");
  fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
  fixture.source = "host:second";
  recovery.accounts = [];
  recovery.state = "disconnected";
  view.rerender(<AgentAuthRouterSettings />);
  await screen.findByRole("button", { name: "Connect local router" });
  const reads = fixture.api.routerRecovery.mock.calls.length;
  await act(async () => {
    finish();
  });
  expect(fixture.api.routerRecovery).toHaveBeenCalledTimes(reads);
  expect(screen.queryByText("codex · work")).toBeNull();
});

it("does not request pool APIs from a server without the exact pool capability", async () => {
  render(<AgentAuthRouterSettings />);
  await screen.findByText("Paired with local router");
  expect(fixture.api.routerOverview).not.toHaveBeenCalled();
  expect(screen.queryByText("Pools and usage")).toBeNull();
});

it("reads cached pool usage and refreshes only after an explicit action", async () => {
  fixture.capabilities.push("agent-auth-router-pools");
  fixture.api.routerOverview.mockResolvedValue({
    pools: [],
    accounts: [
      {
        ...recovery.accounts[0],
        freshness: "stale",
        models: [],
        catalogAt: null,
        quota: { observedAt: recovery.checkedAt },
        windows: [
          {
            bucket: "codex:primary",
            remainingPercent: 75,
            usedPercent: 25,
            resetsAt: null,
            scope: "all",
          },
        ],
        attemptedAt: null,
        error: null,
      },
    ],
  });
  render(<AgentAuthRouterSettings />);
  await screen.findByText("75% remaining");
  expect(fixture.api.routerRefreshOverview).not.toHaveBeenCalled();
  expect(screen.getByText(/Stale observation/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
  await waitFor(() =>
    expect(fixture.api.routerRefreshOverview).toHaveBeenCalledWith({
      accountId: "work",
    }),
  );
});

it("does not follow an old source's pool refresh with a request to the new source", async () => {
  fixture.capabilities.push("agent-auth-router-pools");
  fixture.api.routerOverview.mockResolvedValue({
    pools: [],
    accounts: [
      {
        ...recovery.accounts[0],
        freshness: "unknown",
        models: [],
        catalogAt: null,
        quota: null,
        windows: [],
        attemptedAt: null,
        error: null,
      },
    ],
  });
  let resolve!: () => void;
  fixture.api.routerRefreshOverview.mockImplementation(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const view = render(<AgentAuthRouterSettings />);
  await screen.findByText("Pools and usage");
  fireEvent.click(await screen.findByRole("button", { name: "Refresh usage" }));
  fixture.source = "host:second";
  view.rerender(<AgentAuthRouterSettings />);
  await waitFor(() =>
    expect(fixture.api.routerOverview).toHaveBeenCalledTimes(2),
  );
  await act(async () => resolve());
  expect(fixture.api.routerOverview).toHaveBeenCalledTimes(2);
});
