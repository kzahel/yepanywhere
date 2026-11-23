import { CAPABILITY_ID_ALLOCATIONS } from "./capability-ids.js";
import type { ServerCapabilityDefinition } from "./server-capability-definition.js";

export const ANTIGRAVITY_ROUTER_SERVER_CAPABILITIES = {
  agentAuthRouterAntigravity: {
    id: CAPABILITY_ID_ALLOCATIONS.agentAuthRouterAntigravity.id,
    name: "agent-auth-router-antigravity",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.13.1",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.agentAuthRouterAntigravity.id,
    },
    description:
      "Per-session Agent Auth Router pool discovery and launch routing for Antigravity sessions using a session-scoped loopback bridge.",
    clientFallback:
      "Keep Antigravity direct-only on older servers; omit router discovery and router launch fields for Antigravity.",
    serverContract: {
      routes: ["POST /api/agent-auth-router/selection"],
      requestFields: [
        "provider",
        "routerAccountId",
        "routerPoolId",
        "routerPolicy",
      ],
      responseFields: ["pools", "accounts"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Optional local or hosted router integration for Antigravity.",
    },
  },
} as const satisfies Record<string, ServerCapabilityDefinition>;
