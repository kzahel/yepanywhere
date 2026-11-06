import { CAPABILITY_ID_ALLOCATIONS } from "./capability-ids.js";
import { SECURITY_CLIENT_AUDIT_CAPABILITY } from "./security-clients.js";
import { OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS } from "./server-capability-optional-bits.js";
import type { ServerCapabilityDefinition } from "./server-capability-definition.js";

export const SECURITY_SERVER_CAPABILITIES = {
  nativePushSubscriptions: {
    id: CAPABILITY_ID_ALLOCATIONS.nativePushSubscriptions.id,
    name: "native-push-subscriptions-v1",
    kind: "permanent",
    area: "security",
    introducedIn: "0.9.4",
    advertisement: {
      kind: "optional-bit",
      index:
        OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS.nativePushSubscriptions
          .index,
    },
    description:
      "Key-verified native clients can enroll, disable and test their own broker push subscription.",
    clientFallback:
      "Native push needs a server update; retain ordinary SRP and web use without enrollment requests.",
    serverContract: {
      routes: [
        "PUT /api/security/clients/:clientId/native-push-subscription",
        "DELETE /api/security/clients/:clientId/native-push-subscription",
        "POST /api/security/clients/:clientId/native-push-subscription/test",
        "GET /api/security/clients/:clientId/native-push-subscription/destination",
      ],
      routeModules: ["packages/server/src/routes/native-push.ts"],
      responseFields: ["nativePush"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Native enrollment requires explicitly mounted delivery support independently of server version.",
    },
  },
  limitedUsers: {
    id: CAPABILITY_ID_ALLOCATIONS.limitedUsers.id,
    name: "limited-users",
    kind: "permanent",
    area: "security",
    introducedIn: "0.9.0",
    advertisement: { kind: "version-implied" },
    description:
      "Enable limited users with the limitedUsersEnabled setting and manage their accounts, grants, logins, and usage.",
    clientFallback:
      "Hide Users settings and send no users request or limitedUsersEnabled write.",
    serverContract: {
      routes: [
        "GET /api/users/me",
        "POST /api/users/logout",
        "POST /api/users/switch",
        "GET /api/users",
        "POST /api/users",
        "PATCH /api/users/:username",
        "GET /api/users/usage",
        "DELETE /api/users/:username",
      ],
      requestFields: ["limitedUsersEnabled"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Servers before 0.9.0 have no limited users.",
    },
  },
  securityClientAudit: {
    id: CAPABILITY_ID_ALLOCATIONS.securityClientAudit.id,
    name: SECURITY_CLIENT_AUDIT_CAPABILITY,
    kind: "permanent",
    area: "security",
    introducedIn: "0.7.1",
    advertisement: {
      kind: "optional-bit",
      index:
        OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS.securityClientAudit.index,
    },
    description:
      "Server supports signed security-client continuity, bounded audit history, and revocation.",
    clientFallback:
      "Do not call security-client routes; native clients may still use ordinary SRP but cannot establish registered-device continuity.",
    serverContract: {
      routes: [
        "POST /api/security/clients/register",
        "POST /api/security/clients/:clientId/check-in",
        "GET /api/security/clients",
        "GET /api/security/events",
        "GET /api/security/clients/:clientId",
        "GET /api/security/clients/:clientId/events",
        "PATCH /api/security/clients/:clientId",
        "DELETE /api/security/clients/:clientId",
      ],
      routeModules: ["packages/server/src/routes/security-clients.ts"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Installed servers may permanently predate the registered-client audit surface, and clients must never probe proof-bearing routes without an exact gate.",
    },
  },
  remoteBrowserDiagnostics: {
    id: CAPABILITY_ID_ALLOCATIONS.remoteBrowserDiagnostics.id,
    name: "remote-browser-diagnostics-v1",
    kind: "permanent",
    area: "security",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server brokers one short-lived, per-tab full-JavaScript diagnostic lease between an explicitly enabled browser tab and a YA-launched agent shell.",
    clientFallback:
      "Hide the toolbar setting and control, create no lease, and make no browser-diagnostics request.",
    serverContract: {
      routes: [
        "POST /api/browser-debug/leases",
        "POST /api/browser-debug/leases/:leaseId/poll",
        "POST /api/browser-debug/leases/:leaseId/results",
        "POST /api/browser-debug/leases/:leaseId/events",
        "DELETE /api/browser-debug/leases/:leaseId",
        "GET /browser-debug/v1/leases/:leaseId",
        "GET /browser-debug/v1/leases/:leaseId/events",
        "POST /browser-debug/v1/leases/:leaseId/eval",
      ],
      routeModules: ["packages/server/src/routes/browser-debug.ts"],
      requestFields: [
        "browserDebugLease.sessionId",
        "browserDebugLease.tabId",
        "browserDebugEval.code",
      ],
      responseFields: [
        "browserDebugLease.leaseId",
        "browserDebugLease.controllerToken",
        "browserDebugLease.grantUrl",
        "browserDebugLease.expiresAt",
        "browserDebugEvents.events",
        "browserDebugEval.result",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients can outpace installed servers, and the privileged broker routes must never be probed without an explicit compatibility contract.",
    },
  },
} as const satisfies Record<string, ServerCapabilityDefinition>;
