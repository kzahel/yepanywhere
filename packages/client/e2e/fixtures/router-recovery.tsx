import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { AgentAuthRouterRecovery } from "@yep-anywhere/shared";
import { api, type VersionInfo } from "../../src/api/client";
import { AgentAuthRouterSettings } from "../../src/components/AgentAuthRouterControls";
import { I18nProvider } from "../../src/i18n";
import "../../src/styles/purposeGlobals";

// Browser-only component fixture. Real control/credential boundaries are covered
// by server tests and AAR's cross-repository suite, not by these API substitutes.
const state: AgentAuthRouterRecovery = {
  state: "connected",
  routerId: "synthetic-router",
  customSocket: false,
  reachable: true,
  checkedAt: "2026-10-03T08:00:00Z",
  pendingCancellations: 2,
  accounts: Array.from({ length: 48 }, (_, index) => ({
    id: `workspace-${index + 1}`,
    provider: index % 2 ? "claude" : "codex",
    enabled: index !== 0,
    renewal: "manual",
  })),
};
api.getVersion = async () =>
  ({
    current: "0.9.2",
    capabilities: ["agent-auth-router", "agent-auth-router-recovery"],
  }) as VersionInfo;
api.routerRecovery = async () => {
  await new Promise((resolve) => setTimeout(resolve, 150));
  return structuredClone(state);
};
api.routerStatus = async () => ({
  state: state.state,
  routerId: state.routerId,
});
api.routerAccounts = async () => ({ accounts: state.accounts });
api.routerRetryCancellations = async () => {
  state.pendingCancellations = 0;
  return api.routerStatus();
};
api.routerDisconnect = async () => {
  if (state.state === "revocation-pending") {
    state.state = "disconnected";
    state.pendingCancellations = 0;
    state.reachable = null;
    delete state.issue;
  } else {
    state.state = "revocation-pending";
    state.reachable = false;
    state.accounts = [];
    state.issue = {
      code: "unavailable",
      message:
        "Router unavailable. Start AAR on the YA server, then finish disconnecting.",
    };
    throw new Error(state.issue.message);
  }
  return api.routerStatus();
};
function Fixture() {
  const [updates, setUpdates] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setUpdates((value) => value + 1), 25);
    return () => clearInterval(timer);
  }, []);
  return (
    <main
      style={{ padding: 12, maxWidth: 850, margin: "auto" }}
      data-updates={updates}
    >
      <AgentAuthRouterSettings />
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
