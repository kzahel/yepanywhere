import { CAPABILITY_ID_ALLOCATIONS } from "./capability-ids.js";
import {
  PUBLIC_SHARE_LIVE_SESSION_CHUNKS_CAPABILITY,
  PUBLIC_SHARE_SESSION_CHUNKS_CAPABILITY,
} from "./public-shares.js";
import type { ServerCapabilityDefinition } from "./server-capability-definition.js";

export const REMOTE_ACCESS_SERVER_CAPABILITIES = {
  peerAuthenticationRefresh: {
    id: CAPABILITY_ID_ALLOCATIONS.peerAuthenticationRefresh.id,
    name: "peer-authentication-refresh",
    kind: "permanent",
    area: "remoteAccess",
    introducedIn: "0.11.1",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.peerAuthenticationRefresh.id,
    },
    description:
      "Automatic peer sign-in with short-lived access and sliding inactivity expiry.",
    clientFallback:
      "Keep existing directions visible; disable new pairing with update guidance. Do not silently create a fixed-expiry connection.",
    serverContract: {
      routes: [
        "GET /api/peers/connections",
        "POST /api/peers/connections/connect",
      ],
      requestFields: ["automaticSignIn"],
      responseFields: [
        "peers.outgoing.authentication",
        "peers.incoming.authentication",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Requires peer-v1 authentication and server-owned refresh scheduling.",
    },
  },
  peerConnections: {
    id: CAPABILITY_ID_ALLOCATIONS.peerConnections.id,
    name: "peer-connections",
    kind: "permanent",
    area: "remoteAccess",
    introducedIn: "0.11.1",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.peerConnections.id,
    },
    description:
      "Owner-only Server Connections settings, server-side SRP pairing, authenticated host identity and directional audit.",
    clientFallback:
      "Hide Server Connections and send no peer requests; typed URLs show update guidance.",
    serverContract: {
      routes: [
        "GET /api/peers/connections",
        "POST /api/peers/connections/connect",
      ],
      requestFields: [],
      responseFields: ["identity", "enabled", "peers", "audit"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Requires dedicated peer credentials and live owner setup authorization.",
    },
  },
  artifactRelayPreview: {
    id: CAPABILITY_ID_ALLOCATIONS.artifactRelayPreview.id,
    name: "artifact-relay-preview",
    kind: "permanent",
    area: "remoteAccess",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Authenticated read-only preview leases independent of artifact listener configuration.",
    clientFallback:
      "Keep configured artifact serving or scriptless/source preview; make no preview lease requests.",
    serverContract: {
      routes: [
        "POST /api/artifact-previews",
        "GET /api/artifact-previews/:id/file",
        "DELETE /api/artifact-previews/:id",
        "POST /api/sessions/:sessionId/artifact-previews",
        "GET /api/sessions/:sessionId/artifact-previews/:id/file",
        "DELETE /api/sessions/:sessionId/artifact-previews/:id",
      ],
      routeModules: ["packages/server/src/routes/artifact-previews.ts"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted viewers must never forward arbitrary authenticated file reads to untrusted content.",
    },
  },
  artifactViewer: {
    id: CAPABILITY_ID_ALLOCATIONS.artifactViewer.id,
    name: "artifact-viewer",
    kind: "permanent",
    area: "remoteAccess",
    introducedIn: "0.8.2",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.artifactViewer.id,
    },
    description:
      "An explicitly configured isolated listener serves authorized interactive HTML directories.",
    clientFallback:
      "Retain source and scriptless preview; make no artifact grant request. Configuration is separately gated by version.artifactViewer metadata.",
    serverContract: {
      routes: [
        "POST /api/artifacts",
        "DELETE /api/artifacts/:id",
        "PUT /api/artifacts/config",
      ],
      routeModules: ["packages/server/src/routes/artifacts.ts"],
      responseFields: ["version.artifactViewer"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Artifact listener availability depends on explicit operator configuration.",
    },
  },
  vhostBearerAccess: {
    id: CAPABILITY_ID_ALLOCATIONS.vhostBearerAccess.id,
    name: "vhost-bearer-access",
    kind: "permanent",
    area: "remoteAccess",
    introducedIn: "0.8.2",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.vhostBearerAccess.id,
    },
    description:
      "Durable app-scoped bearer access with explicit public visibility and revocation.",
    clientFallback:
      "Show protection unavailable; omit public/revoke controls and make no app-link management request.",
    serverContract: {
      routes: [
        "GET /api/artifacts/vhosts/links",
        "POST /api/artifacts/vhosts/:name/revoke",
      ],
      routeModules: ["packages/server/src/routes/vhostAccess.ts"],
      responseFields: ["version.artifactViewer.vhosts[].public"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Bearer enforcement and management must roll out together.",
    },
  },
  vhostOauthAccess: {
    id: CAPABILITY_ID_ALLOCATIONS.vhostOauthAccess.id,
    name: "vhost-oauth-access",
    kind: "permanent",
    area: "remoteAccess",
    introducedIn: "0.9.4",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.vhostOauthAccess.id,
    },
    description:
      "Public vhost OAuth admission with one shared provider, email allowlists and access logs.",
    clientFallback:
      "Hide OAuth controls and logs; make no OAuth management requests.",
    serverContract: {
      routes: [
        "GET /api/artifacts/vhosts/oauth",
        "PUT /api/artifacts/vhosts/oauth",
        "PUT /api/artifacts/vhosts/oauth/enabled",
        "PUT /api/artifacts/vhosts/:name/oauth",
        "GET /api/artifacts/vhosts/oauth/log",
      ],
      routeModules: ["packages/server/src/routes/vhostOauth.ts"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Sign-in enforcement and its settings must be available together.",
    },
  },
  vhostOauthProviders: {
    id: CAPABILITY_ID_ALLOCATIONS.vhostOauthProviders.id,
    name: "vhost-oauth-providers",
    kind: "permanent",
    area: "remoteAccess",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Independently managed hosted sign-in providers and visitor provider selection.",
    clientFallback:
      "Keep the single-provider form and make no provider-list management requests.",
    serverContract: {
      routes: [
        "PUT /api/artifacts/vhosts/oauth/providers/:id",
        "PUT /api/artifacts/vhosts/oauth/providers/:id/enabled",
        "DELETE /api/artifacts/vhosts/oauth/providers/:id",
      ],
      routeModules: ["packages/server/src/routes/vhostOauthProviders.ts"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Provider configuration and selection must be supported together.",
    },
  },
  vhostAppControl: {
    id: CAPABILITY_ID_ALLOCATIONS.vhostAppControl.id,
    name: "vhost-app-control",
    kind: "permanent",
    area: "remoteAccess",
    introducedIn: "0.8.2",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.vhostAppControl.id,
    },
    description:
      "Identify and stop a configured local app listener on supported hosts.",
    clientFallback:
      "Hide Kill; keep viewer dismissal and links; make no listener or stop requests.",
    serverContract: {
      routes: [
        "GET /api/artifacts/vhosts/:name/listener",
        "POST /api/artifacts/vhosts/:name/stop",
      ],
      routeModules: ["packages/server/src/routes/vhostApps.ts"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Local listener identification varies by host support.",
    },
  },
  publicShareSessionChunks: {
    name: PUBLIC_SHARE_SESSION_CHUNKS_CAPABILITY,
    kind: "permanent",
    area: "remoteAccess",
    introducedIn: "0.7.1",
    advertisement: { kind: "scoped" },
    description:
      "Secret-authorized metadata selects sequential pull transfer for one immutable frozen session: at most 256 chunks of 256 KiB, with 64 MiB compressed and decompressed ceilings.",
    clientFallback:
      "Use the existing one-response raw-json transfer through its 8 MiB relay cap for marked links, make no chunk request, and keep the combined response for unmarked links.",
    serverContract: {
      routes: [
        "GET /public-api/shares/:secret/metadata",
        "GET /public-api/shares/:secret/session-chunks",
      ],
      responseFields: [
        "publicShareMetadata.capabilities",
        "publicShareMetadata.sessionChunks",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted public viewers can outpace installed servers, and frozen sessions need a bounded relay path without changing legacy response semantics.",
    },
  },
  publicShareLiveSessionChunks: {
    name: PUBLIC_SHARE_LIVE_SESSION_CHUNKS_CAPABILITY,
    kind: "permanent",
    area: "remoteAccess",
    introducedIn: "0.9.4",
    advertisement: { kind: "scoped" },
    description:
      "Secret-authorized metadata for a live share selects the same sequential pull transfer for a transient per-viewer snapshot of the current session; later updates keep the incremental live response.",
    clientFallback:
      "Use the existing one-response raw-json transfer through its 8 MiB relay cap and make no chunk request.",
    serverContract: {
      routes: [
        "GET /public-api/shares/:secret/metadata",
        "GET /public-api/shares/:secret/session-chunks",
      ],
      responseFields: [
        "publicShareMetadata.capabilities",
        "publicShareMetadata.sessionChunks",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted public viewers can outpace installed servers, and live sessions outgrow the one-response relay cap; a separate name keeps older viewers from treating a live share as frozen.",
    },
  },
  publicShareManagement: {
    id: CAPABILITY_ID_ALLOCATIONS.publicShareManagement.id,
    name: "public-share-management",
    kind: "permanent",
    area: "remoteAccess",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server exposes compact authenticated inventory and bearer-link revocation independently from public-share creation readiness.",
    clientFallback:
      "Hide global and direct management entries, preserve the browser context menu, and make no management request.",
    serverContract: {
      routes: [
        "GET /api/public-shares",
        "DELETE /api/public-shares/:shareId",
        "POST /api/public-shares/revoke-all",
      ],
      routeModules: ["packages/server/src/routes/public-share-management.ts"],
      responseFields: [
        "publicShares.items",
        "publicShares.nextCursor",
        "publicShares.totalCount",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients can outpace installed servers that lack compact inventory and one-link revocation routes.",
    },
  },
  publicShareManagementFreeze: {
    id: CAPABILITY_ID_ALLOCATIONS.publicShareManagementFreeze.id,
    name: "public-share-management-freeze",
    kind: "permanent",
    area: "remoteAccess",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server selectively converts an exact reviewed set of live public-link grants to frozen snapshots.",
    clientFallback:
      "Hide management freeze controls, retain inventory/copy/revocation, and make no selective-freeze request.",
    serverContract: {
      routes: ["POST /api/public-shares/freeze-live"],
      routeModules: [
        "packages/server/src/routes/public-share-management-freeze.ts",
      ],
      requestFields: [
        "publicShareManagementFreeze.shareIds",
        "publicShareManagementFreeze.confirmation",
      ],
      responseFields: [
        "publicShareManagementFreeze.convertedCount",
        "publicShareManagementFreeze.cleanupPending",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients can outpace source and installed servers whose management surface supports revocation but not exact live-link freezing.",
    },
  },
  publicFileShares: {
    id: CAPABILITY_ID_ALLOCATIONS.publicFileShares.id,
    name: "public-file-shares",
    kind: "permanent",
    area: "remoteAccess",
    introducedIn: "0.7.2",
    advertisement: { kind: "version-implied" },
    description:
      "Server creates, lists, and revokes live bearer-link grants for one project file and its bounded render assets.",
    clientFallback:
      "Hide file-share controls and make no public-file-share request.",
    serverContract: {
      routes: [
        "GET /api/public-file-shares",
        "POST /api/public-file-shares",
        "DELETE /api/public-file-shares/:shareId",
      ],
      routeModules: ["packages/server/src/routes/public-file-shares.ts"],
      requestFields: [
        "publicFileShare.projectId",
        "publicFileShare.path",
        "publicFileShare.title",
      ],
      responseFields: [
        "publicFileShares.items",
        "publicFileShare.url",
        "publicFileShare.shareId",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients can outpace installed servers that have session shares but no standalone file-grant registry.",
    },
  },
  hostIdentity: {
    name: "host-identity",
    kind: "permanent",
    area: "remoteAccess",
    introducedIn: "0.6.3",
    advertisement: { kind: "version-implied" },
    description:
      "Server persists an optional visual marker identifying the current YA host.",
    clientFallback:
      "Show the configured host marker when its optional icon is set; no fixed-version gate remains in current clients.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings"],
      responseFields: ["settings.hostIdentity"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "The fixed contract remains advertised for older clients; current clients use the supported v0.8.0 baseline.",
    },
  },
  hostAwakeControl: {
    name: "host-awake-control",
    kind: "permanent",
    area: "remoteAccess",
    introducedIn: "0.6.3",
    advertisement: { kind: "version-implied" },
    description:
      "Server supports process-lifetime host-awake settings and status discovery.",
    clientFallback:
      "Use host-awake status on the current v0.8.0 client baseline; actual platform support still controls availability.",
    serverContract: {
      routes: [
        "GET /api/settings",
        "PUT /api/settings",
        "GET /api/settings/host-awake/status",
      ],
      responseFields: [
        "settings.hostAwakeMode",
        "settings.hostAwakeBatteryFloorPercent",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "The fixed contract remains advertised for older clients; current clients use the supported v0.8.0 baseline.",
    },
  },
} as const satisfies Record<string, ServerCapabilityDefinition>;
