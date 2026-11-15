import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { AgentAuthRouterRecovery } from "@yep-anywhere/shared";
import { api, type VersionInfo } from "../../src/api/client";
import { hostedRouterApi } from "../../src/api/hostedRouter";
import { AgentAuthRouterSettings } from "../../src/components/AgentAuthRouterControls";
import { I18nProvider } from "../../src/i18n";
import "../../src/styles/purposeGlobals";

const accounts = Array.from({ length: 48 }, (_, index) => ({
  id: `workspace-${index + 1}`,
  provider: index % 2 ? ("claude" as const) : ("codex" as const),
  enabled: true,
  renewal: "manual",
}));
const state: AgentAuthRouterRecovery = {
  state: "disconnected",
  routerId: null,
  defaultPairingName: "Yep Anywhere on test-host",
  reachable: null,
  checkedAt: new Date().toISOString(),
  accounts: [],
  pendingCancellations: 0,
};
api.getVersion = async () =>
  ({
    current: "0.12.0",
    capabilities: [
      "agent-auth-router",
      "agent-auth-router-recovery",
      "agent-auth-router-hosted",
      "agent-auth-router-pools",
    ],
  }) as VersionInfo;
api.routerRecovery = async () => {
  await new Promise((resolve) => setTimeout(resolve, 80));
  return structuredClone(state);
};
api.routerStatus = async () => structuredClone(state);
api.routerOverview = async () => ({
  observedAt: new Date().toISOString(),
  quotaFreshSeconds: 120,
  pools: [],
  accounts: [],
  canManagePools: false,
});
hostedRouterApi.connect = async (url, name) => {
  Object.assign(state, {
    state: "pairing",
    routerId: "synthetic-router",
    connectionKind: "hosted",
    origin: url,
    host: new URL(url).host,
    pairingName: name,
    pairing: {
      userCode: "ABCD-EFGH",
      verificationUri: `${url}/#pair`,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      interval: 1,
    },
  });
  return structuredClone(state);
};
hostedRouterApi.cancel = async () => {
  state.state = "disconnected";
  delete state.pairing;
  return structuredClone(state);
};
(window as unknown as { approveHostedRouter: () => void }).approveHostedRouter =
  () => {
    state.state = "connected";
    state.reachable = true;
    state.accounts = accounts;
    delete state.pairing;
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
