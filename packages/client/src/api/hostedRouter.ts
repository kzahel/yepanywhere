import type { AgentAuthRouterStatus } from "@yep-anywhere/shared";
import { fetchJSON } from "./sourceApiFetch";

export const hostedRouterApi = {
  connect: (url: string, name: string) =>
    fetchJSON<AgentAuthRouterStatus>("/agent-auth-router/hosted/connect", {
      method: "POST",
      body: JSON.stringify({ url, name }),
    }),
  pairing: () =>
    fetchJSON<AgentAuthRouterStatus>("/agent-auth-router/hosted/pairing"),
  cancel: () =>
    fetchJSON<AgentAuthRouterStatus>("/agent-auth-router/hosted/cancel", {
      method: "POST",
      body: "{}",
    }),
};
