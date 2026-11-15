import { CAPABILITY_ID_ALLOCATIONS } from "./capability-ids.js";
import type { ServerCapabilityDefinition } from "./server-capability-definition.js";

export const HOSTED_ROUTER_SERVER_CAPABILITIES = {
  agentAuthRouterHosted: {
    id: CAPABILITY_ID_ALLOCATIONS.agentAuthRouterHosted.id,
    name: "agent-auth-router-hosted",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.12.1",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.agentAuthRouterHosted.id,
    },
    description:
      "Owner-selected HTTPS router connections with durable server-side code pairing.",
    clientFallback:
      "Keep local socket controls; hide Hosted and send no hosted pairing requests.",
    serverContract: {
      routes: [
        "POST /api/agent-auth-router/hosted/connect",
        "GET /api/agent-auth-router/hosted/pairing",
        "POST /api/agent-auth-router/hosted/cancel",
      ],
      routeModules: ["packages/server/src/routes/agent-auth-router-hosted.ts"],
      requestFields: ["url", "name"],
      responseFields: [
        "connectionKind",
        "host",
        "origin",
        "pairing",
        "pairingExpired",
        "defaultPairingName",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Optional router transport; the owner must opt in to pairing.",
    },
  },
} as const satisfies Record<string, ServerCapabilityDefinition>;
