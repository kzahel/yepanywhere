import {
  CAPABILITY_ID_ALLOCATIONS,
  CAPABILITY_ID_ENCODING_INTRODUCED_IN,
  CAPABILITY_ID_ENCODING_VERSION,
  type CapabilityBitset,
  capabilityBitIsSet,
  encodeCapabilityIds,
} from "./capability-ids.js";
import { PUBLIC_SHARE_SESSION_CHUNKS_CAPABILITY } from "./public-shares.js";
import { SECURITY_CLIENT_AUDIT_CAPABILITY } from "./security-clients.js";

export type ServerCapabilityKind = "permanent" | "transitional";

export const OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS = {
  agentAuthRouterMostRemaining: {
    name: "agent-auth-router-most-remaining",
    index: CAPABILITY_ID_ALLOCATIONS.agentAuthRouterMostRemaining.id,
    introducedIn: "0.9.4",
  },
  agentAuthRouterOwnedPools: {
    name: "agent-auth-router-owned-pools",
    index: CAPABILITY_ID_ALLOCATIONS.agentAuthRouterOwnedPools.id,
    introducedIn: "0.9.4",
  },
  agentAuthRouterPools: {
    name: "agent-auth-router-pools",
    index: CAPABILITY_ID_ALLOCATIONS.agentAuthRouterPools.id,
    introducedIn: "0.9.4",
  },
  agentAuthRouterRecovery: {
    name: "agent-auth-router-recovery",
    index: CAPABILITY_ID_ALLOCATIONS.agentAuthRouterRecovery.id,
    introducedIn: "0.9.4",
  },
  agentAuthRouter: {
    name: "agent-auth-router",
    index: CAPABILITY_ID_ALLOCATIONS.agentAuthRouter.id,
    introducedIn: "0.9.4",
  },
  agentSessionView: {
    name: "agent-session-view",
    index: CAPABILITY_ID_ALLOCATIONS.agentSessionView.id,
    introducedIn: "0.9.4",
  },
  installedMachineControl: {
    name: "installed-machine-control",
    index: CAPABILITY_ID_ALLOCATIONS.installedMachineControl.id,
    introducedIn: "0.9.4",
  },
  nativePushSubscriptions: {
    name: "native-push-subscriptions-v1",
    index: CAPABILITY_ID_ALLOCATIONS.nativePushSubscriptions.id,
    introducedIn: "0.9.4",
  },
  projectAppDeletion: {
    name: "project-app-deletion",
    index: CAPABILITY_ID_ALLOCATIONS.projectAppDeletion.id,
    introducedIn: "0.9.4",
  },
  vhostFileSiteReplacement: {
    name: "vhost-file-site-replacement",
    index: CAPABILITY_ID_ALLOCATIONS.vhostFileSiteReplacement.id,
    introducedIn: "0.9.4",
  },
  draftSync: {
    name: "draft-sync-v1",
    index: CAPABILITY_ID_ALLOCATIONS.draftSync.id,
    introducedIn: "0.9.4",
  },
  vhostBearerAccess: {
    name: "vhost-bearer-access",
    index: CAPABILITY_ID_ALLOCATIONS.vhostBearerAccess.id,
    introducedIn: "0.8.2",
  },
  vhostOauthAccess: {
    name: "vhost-oauth-access",
    index: CAPABILITY_ID_ALLOCATIONS.vhostOauthAccess.id,
    introducedIn: "0.9.4",
  },
  vhostAppControl: {
    name: "vhost-app-control",
    index: CAPABILITY_ID_ALLOCATIONS.vhostAppControl.id,
    introducedIn: "0.8.2",
  },
  computerControlReleases: {
    name: "computer-control-releases",
    index: CAPABILITY_ID_ALLOCATIONS.computerControlReleases.id,
    introducedIn: "0.8.2",
  },
  claudeGatewayServices: {
    name: "claude-gateway-services",
    index: CAPABILITY_ID_ALLOCATIONS.claudeGatewayServices.id,
    introducedIn: "0.8.2",
  },
  computerControl: {
    name: "optional-computer-control",
    index: CAPABILITY_ID_ALLOCATIONS.computerControl.id,
    introducedIn: "0.8.2",
  },
  experimentalConversation: {
    name: "experimental-simple-client-conversation",
    index: CAPABILITY_ID_ALLOCATIONS.experimentalConversation.id,
    introducedIn: "0.8.2",
  },
  issueSessionAssociations: {
    name: "issue-session-associations-v1",
    index: CAPABILITY_ID_ALLOCATIONS.issueSessionAssociations.id,
    introducedIn: "0.8.2",
  },
  speechVocabularySessionTerms: {
    name: "speech-vocabulary-session-terms",
    index: CAPABILITY_ID_ALLOCATIONS.speechVocabularySessionTerms.id,
    introducedIn: "0.8.2",
  },
  speechVocabulary: {
    name: "speech-vocabulary",
    index: CAPABILITY_ID_ALLOCATIONS.speechVocabulary.id,
    introducedIn: "0.8.2",
  },
  artifactViewer: {
    name: "artifact-viewer",
    index: CAPABILITY_ID_ALLOCATIONS.artifactViewer.id,
    introducedIn: "0.8.2",
  },
  voiceInput: {
    name: "voiceInput",
    index: CAPABILITY_ID_ALLOCATIONS.voiceInput.id,
    introducedIn: "0.6.0",
  },
  deviceBridgeAvailable: {
    name: "deviceBridge-available",
    index: CAPABILITY_ID_ALLOCATIONS.deviceBridgeAvailable.id,
    introducedIn: "0.6.0",
  },
  deviceBridge: {
    name: "deviceBridge",
    index: CAPABILITY_ID_ALLOCATIONS.deviceBridge.id,
    introducedIn: "0.6.0",
  },
  deviceBridgeDownload: {
    name: "deviceBridge-download",
    index: CAPABILITY_ID_ALLOCATIONS.deviceBridgeDownload.id,
    introducedIn: "0.6.0",
  },
  deviceBridgeUpdate: {
    name: "deviceBridge-update",
    index: CAPABILITY_ID_ALLOCATIONS.deviceBridgeUpdate.id,
    introducedIn: "0.6.0",
  },
  browserSettingsBackup: {
    name: "browser-settings-backup",
    index: CAPABILITY_ID_ALLOCATIONS.browserSettingsBackup.id,
    introducedIn: "0.6.3",
  },
  securityClientAudit: {
    name: SECURITY_CLIENT_AUDIT_CAPABILITY,
    index: CAPABILITY_ID_ALLOCATIONS.securityClientAudit.id,
    introducedIn: "0.7.1",
  },
  reloadSafeCodexRuntime: {
    name: "reload-safe-codex-runtime",
    index: CAPABILITY_ID_ALLOCATIONS.reloadSafeCodexRuntime.id,
    introducedIn: "0.7.1",
  },
  sessionSandboxing: {
    name: "session-sandboxing",
    index: CAPABILITY_ID_ALLOCATIONS.sessionSandboxing.id,
    introducedIn: "0.7.1",
  },
  providerHostControl: {
    name: "provider-host-control",
    index: CAPABILITY_ID_ALLOCATIONS.providerHostControl.id,
    introducedIn: "0.7.1",
  },
  gitWorkingTreeSections: {
    name: "git-working-tree-sections",
    index: CAPABILITY_ID_ALLOCATIONS.gitWorkingTreeSections.id,
    introducedIn: "0.7.2",
  },
  gitWorkingTreeCompleteScan: {
    name: "git-working-tree-complete-scan",
    index: CAPABILITY_ID_ALLOCATIONS.gitWorkingTreeCompleteScan.id,
    introducedIn: "0.7.2",
  },
} as const;

export type OptionalServerCapabilityBitset = CapabilityBitset;

export interface VersionedServerCapabilityAdvertisement {
  capabilityEncoding: typeof CAPABILITY_ID_ENCODING_VERSION;
  capabilityBits: CapabilityBitset;
  deniedCapabilityBits?: CapabilityBitset;
}

export interface CompactServerCapabilityAdvertisement {
  optionalCapabilityBits: OptionalServerCapabilityBitset;
  capabilityExtensions?: readonly string[];
  deniedCapabilityBits?: CapabilityBitset;
}

export type ServerCapabilityAdvertisement =
  | { kind: "version-implied" }
  | { kind: "optional-bit"; index: number }
  | { kind: "scoped" };

export interface ServerCapabilitySource {
  current?: string;
  capabilities?: readonly string[];
  capabilityEncoding?: number;
  capabilityBits?: CapabilityBitset;
  deniedCapabilityBits?: CapabilityBitset;
  optionalCapabilityBits?: OptionalServerCapabilityBitset;
  capabilityExtensions?: readonly string[];
}

export interface ServerCapabilityPermanentLifecycle {
  kind: "permanent";
  reason: string;
}

export interface ServerCapabilityTransitionalLifecycle {
  kind: "transitional";
  reviewAfter: string;
  removeClientGateWhen: string;
  removeServerAdvertisementWhen?: string;
}

export interface ServerCapabilityDefinition {
  /** Stable global ID. Required for global capabilities introduced in 0.7.1+. */
  id?: number;
  name: string;
  kind: ServerCapabilityKind;
  area:
    | "deviceBridge"
    | "gitStatus"
    | "localAccess"
    | "projectQueue"
    | "providers"
    | "rendering"
    | "remoteAccess"
    | "security"
    | "sessions"
    | "settings"
    | "speech";
  description: string;
  introducedIn: string;
  advertisement: ServerCapabilityAdvertisement;
  clientFallback: string;
  serverContract?: {
    routes?: readonly string[];
    /**
     * Repository-relative server route modules wholly owned by this
     * capability. `pnpm capabilities:audit` requires every route declared in
     * these modules to appear in `routes`, and rejects stale route entries.
     */
    routeModules?: readonly string[];
    requestFields?: readonly string[];
    responseFields?: readonly string[];
    events?: readonly string[];
  };
  lifecycle:
    | ServerCapabilityPermanentLifecycle
    | ServerCapabilityTransitionalLifecycle;
}

export const SERVER_CAPABILITIES = {
  agentSessionView: {
    id: CAPABILITY_ID_ALLOCATIONS.agentSessionView.id,
    name: "agent-session-view",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.9.4",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.agentSessionView.id,
    },
    description:
      "Accepts each tab's report of the app, artifact or file it shows beside a session, so `ya-agent view` can tell the session's agent what the user has open.",
    clientFallback:
      "Publish nothing; the agent's `ya-agent view` stays unavailable or reports no clients.",
    serverContract: {
      routeModules: ["packages/server/src/routes/session-view.ts"],
      routes: [
        "PUT /api/sessions/:sessionId/view",
        "DELETE /api/sessions/:sessionId/view/:clientId",
      ],
      requestFields: ["clientId", "device", "focused", "viewers"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Advertised only while the operator enables agent self inspection, so clients publish nowhere it is not collected.",
    },
  },
  agentAuthRouterMostRemaining: {
    id: CAPABILITY_ID_ALLOCATIONS.agentAuthRouterMostRemaining.id,
    name: "agent-auth-router-most-remaining",
    introducedIn: "0.9.4",
    kind: "permanent",
    area: "sessions",
    lifecycle: {
      kind: "permanent",
      reason: "Opt-in quota-aware router selection.",
    },
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.agentAuthRouterMostRemaining.id,
    },
    description:
      "Negotiates Most remaining with AAR and reports admission refresh and policy evidence.",
    clientFallback:
      "Keep Manual and Round robin; hide Most remaining and refuse unsupported pool defaults with upgrade guidance.",
    serverContract: {
      requestFields: ["routerPolicy: most-remaining"],
      responseFields: [
        "supportedPolicies",
        "admissionRefresh",
        "selection.decisions.evidence",
      ],
    },
  },
  agentAuthRouterOwnedPools: {
    id: CAPABILITY_ID_ALLOCATIONS.agentAuthRouterOwnedPools.id,
    name: "agent-auth-router-owned-pools",
    introducedIn: "0.9.4",
    kind: "permanent",
    area: "sessions",
    lifecycle: {
      kind: "permanent",
      reason: "Explicit router owner/use authority boundary.",
    },
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.agentAuthRouterOwnedPools.id,
    },
    description:
      "Reports whether the connected router permits integration pool editing; router-owned pools remain read-only in YA.",
    clientFallback:
      "Use the existing pool UI on older servers; honor explicit read-only metadata when present. Router rejects unauthorized writes.",
    serverContract: {
      responseFields: ["canManagePools", "directAccountAccess"],
    },
  },
  agentAuthRouterPools: {
    id: CAPABILITY_ID_ALLOCATIONS.agentAuthRouterPools.id,
    name: "agent-auth-router-pools",
    introducedIn: "0.9.4",
    kind: "permanent",
    area: "sessions",
    lifecycle: {
      kind: "permanent",
      reason: "Optional local router pool controls.",
    },
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.agentAuthRouterPools.id,
    },
    description:
      "Owner-only router pools, cached quota overview and Manual/Round robin session allocation.",
    clientFallback:
      "Keep manual account controls; hide pool controls and omit pool launch fields.",
    serverContract: {
      routes: [
        "POST /api/agent-auth-router/overview",
        "POST /api/agent-auth-router/overview/refresh",
        "POST /api/agent-auth-router/pools/save",
        "POST /api/agent-auth-router/pools/remove",
      ],
      routeModules: ["packages/server/src/routes/agent-auth-router-pools.ts"],
      requestFields: ["routerPoolId", "routerPolicy"],
      responseFields: ["pools", "accounts", "selection"],
    },
  },
  agentAuthRouterRecovery: {
    id: CAPABILITY_ID_ALLOCATIONS.agentAuthRouterRecovery.id,
    name: "agent-auth-router-recovery",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.9.4",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.agentAuthRouterRecovery.id,
    },
    description:
      "On-demand router health and explicit failed-launch cleanup retry.",
    clientFallback:
      "Keep existing router controls; omit recovery requests and cleanup retry.",
    serverContract: {
      routes: [
        "GET /api/agent-auth-router/recovery",
        "POST /api/agent-auth-router/retry-cancellations",
      ],
      routeModules: [
        "packages/server/src/routes/agent-auth-router-recovery.ts",
      ],
      responseFields: [
        "checkedAt",
        "reachable",
        "pendingCancellations",
        "issue",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Optional local router recovery controls.",
    },
  },
  agentAuthRouter: {
    id: CAPABILITY_ID_ALLOCATIONS.agentAuthRouter.id,
    name: "agent-auth-router",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.9.4",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.agentAuthRouter.id,
    },
    description:
      "Local router pairing, automatic compatible-pool discovery, unified model/thinking selection and pinned native provider sessions.",
    clientFallback:
      "Hide router controls and omit router launch fields when absent.",
    serverContract: {
      routes: [
        "GET /api/agent-auth-router",
        "POST /api/agent-auth-router/selection",
        "POST /api/agent-auth-router/connect",
        "POST /api/agent-auth-router/disconnect",
        "GET /api/agent-auth-router/accounts",
        "GET /api/agent-auth-router/accounts/:id/catalog",
        "GET /api/agent-auth-router/accounts/:id/quotas",
      ],
      routeModules: ["packages/server/src/routes/agent-auth-router.ts"],
      requestFields: ["routerAccountId", "routerPoolId", "thinking"],
      responseFields: ["routerId", "state", "accounts"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Optional local router integration.",
    },
  },
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

  contextUsageBreakdown: {
    id: CAPABILITY_ID_ALLOCATIONS.contextUsageBreakdown.id,
    name: "context-usage-breakdown",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Reports what fills a live session's context window by category (prompt, tool definitions, instruction files, skills, conversation), with per-file and per-skill rows, for the context-usage popover.",
    clientFallback:
      "The context-usage popover shows only its existing token and quota rows and makes no breakdown request.",
    serverContract: {
      routeModules: ["packages/server/src/routes/context-breakdown.ts"],
      routes: ["GET /api/sessions/:sessionId/context-breakdown"],
      responseFields: ["breakdown"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Servers before 0.9.4 have no breakdown route; the client must not request it from them.",
    },
  },
  processServiceTierChange: {
    id: CAPABILITY_ID_ALLOCATIONS.processServiceTierChange.id,
    name: "process-service-tier-change",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Changes a live session's provider service tier (Codex Fast or Standard) through the process config route, live when the provider supports it and by restart otherwise.",
    clientFallback:
      "Show the current tier read-only in Session Info and make no service-tier process-config request.",
    serverContract: {
      routes: ["POST /api/processes/:processId/config"],
      requestFields: ["serviceTier"],
      responseFields: ["serviceTier"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Servers before 0.9.4 ignore serviceTier on the process config route, so the client must not offer the control there.",
    },
  },
  mcpAppViews: {
    id: CAPABILITY_ID_ALLOCATIONS.mcpAppViews.id,
    name: "mcp-app-views",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Persists the default-off MCP App views setting, records a Codex tool call's declared view on its tool_use block, serves the sandbox proxy on the artifact origin, and answers a live session's view requests.",
    clientFallback:
      "Hide the setting and every view launcher, and make no MCP App request; tool rows show only their static result.",
    serverContract: {
      routes: [
        "GET /api/settings",
        "PUT /api/settings",
        "POST /api/projects/:projectId/sessions/:sessionId/mcp-apps",
      ],
      requestFields: ["settings.mcpAppViews"],
      responseFields: ["settings.mcpAppViews", "tool_use._mcpApp"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Servers through 0.9.2 have no view route or proxy, so a hosted client must not offer views there.",
    },
  },
  projectCreationGitChoice: {
    id: CAPABILITY_ID_ALLOCATIONS.projectCreationGitChoice.id,
    name: "project-creation-git-choice",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Server honors gitInit: false when adding a project creates its folder, leaving the new folder without a repository.",
    clientFallback:
      "Show Git initialization as always on for a new folder and send no gitInit field.",
    serverContract: {
      routes: ["POST /api/projects"],
      requestFields: ["gitInit"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Servers through 0.9.2 always initialize Git in a folder they create and ignore the field, so a hosted client must not offer the choice there.",
    },
  },
  unicodeProseMath: {
    id: CAPABILITY_ID_ALLOCATIONS.unicodeProseMath.id,
    name: "unicode-prose-math",
    kind: "permanent",
    area: "rendering",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Rendered Markdown marks undelimited math in prose with a hidden KaTeX alternative that the client can reveal.",
    clientFallback:
      "Hide the Unicode math Appearance setting; prose math stays as written.",
    lifecycle: {
      kind: "permanent",
      reason:
        "Servers through 0.9.2 emit no math markers, so the setting would have no effect there.",
    },
  },
  projectFileViewCommand: {
    id: CAPABILITY_ID_ALLOCATIONS.projectFileViewCommand.id,
    name: "project-file-view-command",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Resolves /v and /view path parts to project files, tracked first, then untracked, then (on submit) ignored, and to exact or outside-project absolute paths, so the composer can open the file viewer without an agent turn.",
    clientFallback:
      "Neither advertise nor intercept /v or /view; the typed text reaches the provider unchanged and no search request is made.",
    serverContract: {
      routeModules: ["packages/server/src/routes/project-file-view-search.ts"],
      routes: ["GET /api/projects/:projectId/file-view-search"],
      requestFields: ["part", "recent", "ignored"],
      responseFields: ["entries", "pending", "truncated"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers have no multi-part, tracked-first search; the client must not send /v text it cannot resolve as a command.",
    },
  },
  fileOwnerProject: {
    id: CAPABILITY_ID_ALLOCATIONS.fileOwnerProject.id,
    name: "file-owner-project",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Resolves an allowed absolute or ~/ file to the registered project that owns it, following symlinked project roots, so New Session from a file link opens in that project.",
    clientFallback:
      "Start the session in the linked-from project with the path as written, as before.",
    serverContract: {
      routeModules: ["packages/server/src/routes/file-owner.ts"],
      routes: ["GET /api/projects/:projectId/file-owner"],
      requestFields: ["path"],
      responseFields: ["owner"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers have no owner lookup; the client must not guess ownership from path spelling.",
    },
  },
  vhostFileSites: {
    id: CAPABILITY_ID_ALLOCATIONS.vhostFileSites.id,
    name: "vhost-file-sites",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Vhost rows can serve one file or directory at name.localhost and name.<public root>, managed from Settings and the File Viewer share dialog.",
    clientFallback:
      "Hide the vhost Serves selector and the share dialog's address section; send no vhostSites field and no vhost-site requests.",
    serverContract: {
      routeModules: ["packages/server/src/routes/vhostSites.ts"],
      routes: [
        "GET /api/artifacts/vhost-sites",
        "POST /api/artifacts/vhost-sites",
        "DELETE /api/artifacts/vhost-sites/:name",
      ],
      requestFields: ["vhostSites"],
      responseFields: ["artifactViewer.vhostSites", "sites[].linkedFiles"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers drop vhostSites on save and have no route to claim or serve a file address.",
    },
  },
  vhostFileSiteReplacement: {
    id: CAPABILITY_ID_ALLOCATIONS.vhostFileSiteReplacement.id,
    name: "vhost-file-site-replacement",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.vhostFileSiteReplacement.id,
    },
    description:
      "Explicit replacement of file vhosts, with creator ownership and project confinement for limited users.",
    clientFallback: "Hide replacement and keep file vhosts administrator-only.",
    serverContract: {
      routes: [
        "GET /api/artifacts/vhost-sites",
        "POST /api/artifacts/vhost-sites",
        "DELETE /api/artifacts/vhost-sites/:name",
      ],
      requestFields: ["replace", "projectId"],
      responseFields: ["sites[].ownerUsername"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers reject collisions and do not support limited-user file vhosts.",
    },
  },
  localSourceBrowse: {
    id: CAPABILITY_ID_ALLOCATIONS.localSourceBrowse.id,
    name: "local-source-browse",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "The working-tree file inventory accepts an allowed absolute path outside the project and browses a snapshot of its checkout or directory.",
    clientFallback:
      "Hide Open in Source Control on paths outside the project and send no root request.",
    serverContract: {
      routes: ["GET /api/projects/:projectId/git/working-tree-files"],
      requestFields: ["root"],
      responseFields: ["root"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers ignore root and would list the session project instead of the requested directory.",
    },
  },
  projectLivePreview: {
    id: CAPABILITY_ID_ALLOCATIONS.projectLivePreview.id,
    name: "project-live-preview",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Template-declared sandboxed live preview and authorized app WebSockets.",
    clientFallback:
      "Hide Live preview and send no live-preview start requests; retain built app and Reload.",
    serverContract: {
      routes: ["POST /api/projects/:projectId/app/start"],
      responseFields: ["projectApp.livePreview", "projectApp.mode"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older app servers have neither a dev-service mode nor app WebSocket forwarding.",
    },
  },
  projectAppInventory: {
    id: CAPABILITY_ID_ALLOCATIONS.projectAppInventory.id,
    name: "project-app-inventory",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Administrator inventory of project apps and retained addresses.",
    clientFallback:
      "Keep port forwards and show an update note without inventory requests.",
    serverContract: {
      routes: [
        "GET /api/project-apps",
        "POST /api/project-apps/address/release",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers lack global app inventory and orphan reservation release.",
    },
  },
  projectAppDeletion: {
    id: CAPABILITY_ID_ALLOCATIONS.projectAppDeletion.id,
    name: "project-app-deletion",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.projectAppDeletion.id,
    },
    description:
      "Administrator deletion of app declarations, with service stop and address release.",
    clientFallback: "Hide app deletion and offer an update notice.",
    serverContract: { routes: ["DELETE /api/projects/:projectId/app"] },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers cannot delete app declarations or clean up their addresses.",
    },
  },
  projectService: {
    id: CAPABILITY_ID_ALLOCATIONS.projectService.id,
    name: "project-service",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Project App resolution, isolated delivery and sandboxed service lifecycle.",
    clientFallback: "Hide project App and send no project App requests.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/app",
        "POST /api/projects/:projectId/app/open",
        "POST /api/projects/:projectId/app/start",
        "POST /api/projects/:projectId/app/stop",
        "POST /api/projects/:projectId/app/restore",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Older servers lack project-owned app services.",
    },
  },
  projectAppReservations: {
    id: CAPABILITY_ID_ALLOCATIONS.projectAppReservations.id,
    name: "project-app-reservations",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Retained first-claim project app addresses with separate administrator publication.",
    clientFallback:
      "Hide project address settings and send no reservation requests.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/app/address",
        "POST /api/projects/:projectId/app/address/reserve",
        "POST /api/projects/:projectId/app/address/serve",
        "POST /api/projects/:projectId/app/address/release",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Older servers lack persistent project app addresses.",
    },
  },
  personalProjectHiding: {
    id: CAPABILITY_ID_ALLOCATIONS.personalProjectHiding.id,
    name: "personal-project-hiding",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Limited-user project removal hides the project only from that user's lists, retaining canonical metadata, files and audit history.",
    clientFallback:
      "Keep the existing project removal label and confirmation without promising personal-only removal; send no new request.",
    serverContract: {
      routes: ["DELETE /api/projects/:projectId", "GET /api/projects"],
      responseFields: ["personal"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Older servers hide a limited user's project globally.",
    },
  },
  agentServerAccess: {
    id: CAPABILITY_ID_ALLOCATIONS.agentServerAccess.id,
    name: "agent-server-access",
    kind: "permanent",
    area: "localAccess",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Optionally give unsandboxed superuser agent sessions an in-memory bearer token (AGENT_SERVER_TOKEN) for this server's API.",
    clientFallback:
      "Hide the Local Access toggle and send no agentServerAccessEnabled.",
    serverContract: {
      routes: ["GET /api/settings", "PATCH /api/settings"],
      requestFields: ["agentServerAccessEnabled"],
      responseFields: ["settings.agentServerAccessEnabled"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers neither store the setting nor accept agent bearer tokens.",
    },
  },
  sessionScopedLocalFiles: {
    id: CAPABILITY_ID_ALLOCATIONS.sessionScopedLocalFiles.id,
    name: "session-scoped-local-files",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Read a file, and grant an interactive preview of it, as a session names it: a sandboxed session's /tmp is its private one, and a limited user reaches only that session's project and sandbox temp.",
    clientFallback:
      "Open session-named files through the host-wide local-file, local-image and artifact routes, as before.",
    serverContract: {
      routes: [
        "GET /api/sessions/:sessionId/local-file",
        "GET /api/sessions/:sessionId/local-image",
        "POST /api/sessions/:sessionId/artifacts",
      ],
      routeModules: ["packages/server/src/routes/session-local-files.ts"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers read every path host-wide and refuse limited users those reads.",
    },
  },
  sidebarSessionCategories: {
    id: CAPABILITY_ID_ALLOCATIONS.sidebarSessionCategories.id,
    name: "sidebar-session-categories",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Store a user-named sidebar category per session and return it, with the limited user who started each session, in session lists.",
    clientFallback:
      "Hide the Move to category menu and per-user sidebar sections; send no sidebarCategory.",
    serverContract: {
      routes: ["PUT /api/sessions/:sessionId/metadata", "GET /api/sessions"],
      requestFields: ["sidebarCategory", "categorized"],
      responseFields: [
        "sessions[].sidebarCategory",
        "sessions[].createdByUser",
      ],
      events: ["session-metadata-changed"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers neither store categories nor report session creators in lists.",
    },
  },
  sessionCreationProvenance: {
    id: CAPABILITY_ID_ALLOCATIONS.sessionCreationProvenance.id,
    name: "session-creation-provenance",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.9.3",
    advertisement: { kind: "version-implied" },
    description:
      "Persist client-declared web or desktop creation provenance and return it in session summaries.",
    clientFallback:
      "Omit creationProvenance from create requests and hide creation-source filters.",
    serverContract: {
      routes: [
        "POST /api/projects/:projectId/sessions",
        "POST /api/projects/:projectId/sessions/create",
        "POST /api/sessions",
        "POST /api/sessions/create",
        "POST /api/projects/:projectId/sessions/:sessionId/restart",
        "POST /api/projects/:projectId/sessions/:sessionId/fork",
        "GET /api/sessions",
        "GET /api/projects/:projectId/sessions",
        "GET /api/projects/:projectId/sessions/:sessionId",
        "GET /api/projects/:projectId/sessions/:sessionId/metadata",
        "GET /api/inbox",
      ],
      requestFields: ["creationProvenance"],
      responseFields: [
        "sessions[].creationProvenance",
        "session.creationProvenance",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers accept but discard unknown create fields and do not return provenance.",
    },
  },
  fileSourceEditing: {
    id: CAPABILITY_ID_ALLOCATIONS.fileSourceEditing.id,
    name: "file-source-editing",
    kind: "permanent",
    area: "localAccess",
    introducedIn: "0.9.1",
    advertisement: { kind: "version-implied" },
    description:
      "Read bounded original sources, save explicit revision-checked edits, including artifact source references, and run an artifact's approved rebuild hook.",
    clientFallback:
      "Hide Edit and make no file-edit requests; retain read and comment views.",
    serverContract: {
      routes: [
        "GET /api/file-edit",
        "PUT /api/file-edit",
        "POST /api/file-edit/rebuild",
      ],
      routeModules: ["packages/server/src/routes/file-edit.ts"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Older servers do not provide conditional source writes.",
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
  projectTemplateSources: {
    id: CAPABILITY_ID_ALLOCATIONS.projectTemplateSources.id,
    name: "project-template-sources",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.8.2",
    advertisement: { kind: "version-implied" },
    description:
      "Configure ordered GitHub and local template sources, retrieve pinned content, and inspect combined inventory without running setup.",
    clientFallback:
      "Hide Project templates settings and send no template-source requests.",
    serverContract: {
      routes: [
        "GET /api/project-template-source",
        "PUT /api/project-template-source",
      ],
      routeModules: ["packages/server/src/routes/project-template-source.ts"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers have no template source retrieval or configuration surface.",
    },
  },
  projectTemplateCreation: {
    id: CAPABILITY_ID_ALLOCATIONS.projectTemplateCreation.id,
    name: "project-template-creation",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Superuser creation from ready templates with retained operation status and preparation dispatch.",
    clientFallback:
      "Keep directory creation and send no template choice or creation requests.",
    serverContract: {
      routes: [
        "GET /api/project-templates/choices",
        "GET /api/project-templates/operations/:id",
        "POST /api/project-templates/operations",
      ],
      routeModules: ["packages/server/src/routes/project-templates.ts"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Older servers cannot create template projects.",
    },
  },
  limitedUserProjectTemplates: {
    id: CAPABILITY_ID_ALLOCATIONS.limitedUserProjectTemplates.id,
    name: "limited-user-project-templates",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Per-user template creation grants, filtered choices, owned operations and sandboxed setup.",
    clientFallback:
      "Hide template grants and limited-user template creation; preserve older directory behavior.",
    serverContract: {
      routes: [
        "GET /api/project-templates/choices",
        "POST /api/project-templates/operations",
        "GET /api/project-templates/operations/:id",
      ],
      routeModules: ["packages/server/src/routes/project-templates.ts"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Superuser template creation does not imply limited-user authorization or confinement.",
    },
  },
  limitedUserInstructions: {
    id: CAPABILITY_ID_ALLOCATIONS.limitedUserInstructions.id,
    name: "limited-user-instructions",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Shared append/replace instructions and per-user appended blocks for limited-user launches.",
    clientFallback:
      "Hide instruction controls and omit limitedUserInstructions and instructionBlocks from requests.",
    serverContract: {
      routes: [
        "GET /api/settings",
        "PUT /api/settings",
        "GET /api/users",
        "POST /api/users",
        "PATCH /api/users/:username",
      ],
      requestFields: ["limitedUserInstructions", "instructionBlocks"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Older servers do not apply limited-user prompt instructions.",
    },
  },
  limitedUserBrowserDefaults: {
    id: CAPABILITY_ID_ALLOCATIONS.limitedUserBrowserDefaults.id,
    name: "limited-user-browser-defaults",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Server stores browser settings the superuser publishes for limited users' clients to apply once per revision.",
    clientFallback:
      "Hide the Users browser-defaults panel; limited users' clients fetch and apply nothing.",
    serverContract: {
      routes: [
        "GET /api/settings/limited-user-defaults",
        "PUT /api/settings/limited-user-defaults",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers have no limited-user defaults slot to read or publish.",
    },
  },
  limitedUserPathGrants: {
    id: CAPABILITY_ID_ALLOCATIONS.limitedUserPathGrants.id,
    name: "limited-user-path-grants",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Limited users carry directory grants giving an access level to every project at or beneath a path.",
    clientFallback:
      "Hide the Users directory-access editor and send no pathGrants field.",
    serverContract: {
      routes: ["POST /api/users", "PATCH /api/users/:username"],
      requestFields: ["pathGrants"],
      responseFields: ["users[].pathGrants"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers ignore pathGrants, so a directory grant would appear saved and grant nothing.",
    },
  },
  projectAccessSharing: {
    id: CAPABILITY_ID_ALLOCATIONS.projectAccessSharing.id,
    name: "project-access-sharing",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "A project's settings let the superuser or the limited user who created it grant other limited users access to that project.",
    clientFallback:
      "Hide the project's sharing section; the superuser grants access in Settings → Users.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/access",
        "PUT /api/projects/:projectId/access",
      ],
      routeModules: ["packages/server/src/routes/project-access.ts"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Older servers have no per-project sharing route.",
    },
  },
  projectCopy: {
    id: CAPABILITY_ID_ALLOCATIONS.projectCopy.id,
    name: "project-copy",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Anyone who can see a project may copy its working tree into their own project directory as a new project.",
    clientFallback: "Hide the Copy action on project cards.",
    serverContract: {
      routes: ["POST /api/projects/:projectId/copy"],
      routeModules: ["packages/server/src/routes/project-copy.ts"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Older servers have no copy route.",
    },
  },
  limitedUserNoProjectSessions: {
    id: CAPABILITY_ID_ALLOCATIONS.limitedUserNoProjectSessions.id,
    name: "limited-user-no-project-sessions",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Per-user permission to create sandboxed sessions in a private No project workspace.",
    clientFallback:
      "Hide the checkbox, omit allowNoProjectSessions, and prevent limited-user detached creation.",
    serverContract: {
      routes: [
        "POST /api/users",
        "PATCH /api/users/:username",
        "POST /api/sessions",
        "POST /api/sessions/create",
      ],
      requestFields: ["allowNoProjectSessions"],
      responseFields: ["allowNoProjectSessions"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Older servers admit detached creation only for the superuser.",
    },
  },
  projectAppAddressLinks: {
    id: CAPABILITY_ID_ALLOCATIONS.projectAppAddressLinks.id,
    name: "project-app-address-links",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Authorized transferable address URLs and per-user public-app/private-link permissions.",
    clientFallback:
      "Omit the address URL row and the optional user permission fields on older servers.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/app/address",
        "GET /api/projects/:projectId/app",
        "POST /api/projects/:projectId/app/address/serve",
        "POST /api/users",
        "PATCH /api/users/:username",
      ],
      requestFields: ["allowPublicApps", "allowPrivateAppLinks"],
      responseFields: [
        "reservations[].url",
        "canRelease",
        "canCopyLink",
        "updatedAt",
        "allowPublicApps",
        "allowPrivateAppLinks",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers do not expose address links or these user permissions.",
    },
  },
  templatePreparationAttachments: {
    id: CAPABILITY_ID_ALLOCATIONS.templatePreparationAttachments.id,
    name: "template-preparation-attachments",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Account-owned draft uploads and attachments in template preparation.",
    clientFallback:
      "Disable attachments for template creation on older servers.",
    serverContract: {
      routes: [
        "POST /api/project-templates/operations",
        "GET /api/attachments/staging/drafts/upload/ws",
      ],
      // These modules also serve earlier capabilities; only the listed
      // attachment semantics belong to this capability.
      requestFields: ["stagedAttachments"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Template creation alone does not imply attachment preparation support.",
    },
  },
  speechBackendSetup: {
    id: CAPABILITY_ID_ALLOCATIONS.speechBackendSetup.id,
    name: "speech-backend-setup",
    kind: "permanent",
    area: "speech",
    introducedIn: "0.8.2",
    advertisement: { kind: "version-implied" },
    description:
      "Persist local STT backends in server settings, install pixi runtimes and model weights, and request a safe YA restart.",
    clientFallback:
      "Hide the Speech backends enable/install table and make no setup, install, or speech-restart requests.",
    serverContract: {
      routes: [
        "GET /api/settings",
        "PUT /api/settings",
        "GET /api/speech/backends",
        "POST /api/speech/backends/:id/install",
        "POST /api/speech/backends/restart",
      ],
      // Both route modules are shared with older capabilities, not wholly owned.
      requestFields: ["speechVoiceBackends"],
      responseFields: ["settings.speechVoiceBackends"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers only enable local STT from YEP_VOICE_BACKENDS and have no install or settings-union routes.",
    },
  },
  sessionContentSearch: {
    id: CAPABILITY_ID_ALLOCATIONS.sessionContentSearch.id,
    name: "session-content-search",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.8.2",
    advertisement: { kind: "version-implied" },
    description: "Bounded, progressive search of visible session turn text.",
    clientFallback:
      "Keep title-only search; disable turn fields with upgrade guidance and send no content-search requests.",
    serverContract: {
      routes: ["POST /api/sessions/content-search"],
      routeModules: ["packages/server/src/routes/session-content-search.ts"],
      requestFields: [
        "sessionId",
        "query",
        "roles",
        "after",
        "before",
        "cursor",
      ],
      responseFields: [
        "matches",
        "cursor",
        "done",
        "partial",
        "unavailable",
        "bytesRead",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Older servers have no bounded transcript-search endpoint.",
    },
  },
  computerControlReleases: {
    id: CAPABILITY_ID_ALLOCATIONS.computerControlReleases.id,
    name: "computer-control-releases",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.8.2",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.computerControlReleases.id,
    },
    description:
      "Retired in 0.9.4: YA-managed Windows release downloads and updates. ID reserved.",
    clientFallback:
      "Show server-update guidance; send no release-management requests.",
    lifecycle: {
      kind: "permanent",
      reason: "Optional managed Windows component.",
    },
  },
  installedMachineControl: {
    id: CAPABILITY_ID_ALLOCATIONS.installedMachineControl.id,
    name: "installed-machine-control",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.9.4",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.installedMachineControl.id,
    },
    description:
      "Verified installed Machine Control CLI readiness and explicit local session advertisement.",
    clientFallback:
      "Hide the installed MC picker and send neither its readiness request nor machineControl launch field.",
    serverContract: {
      routes: ["GET /api/machine-control"],
      routeModules: ["packages/server/src/routes/machine-control.ts"],
      requestFields: ["machineControl"],
      responseFields: ["available", "version", "reason"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Optional independently installed desktop product.",
    },
  },
  computerControl: {
    id: CAPABILITY_ID_ALLOCATIONS.computerControl.id,
    name: "optional-computer-control",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.8.2",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.computerControl.id,
    },
    description:
      "Retired in 0.9.4: YA-managed Windows component and local Codex grants. ID reserved.",
    clientFallback:
      "Hide computer controls and send no computer-control requests or launch fields.",
    lifecycle: {
      kind: "permanent",
      reason: "Experimental Windows-only optional component.",
    },
  },
  experimentalConversation: {
    id: CAPABILITY_ID_ALLOCATIONS.experimentalConversation.id,
    name: "experimental-simple-client-conversation",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.8.2",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.experimentalConversation.id,
    },
    description:
      "Experimental bounded Conversation reads and snapshot subscriptions with an exact schema revision.",
    clientFallback:
      "Show this source as update-required and offer its existing full client; send no experimental requests.",
    serverContract: {
      routes: [
        "GET /api/experimental/conversation",
        "GET /api/experimental/conversation/subscribe",
      ],
      requestFields: [
        "apiRevision",
        "subscriptionId",
        "sessionId",
        "maxMessages",
        "anchorMessageId",
        "query",
      ],
      responseFields: ["experimentalSimpleClientApiRevision"],
      events: ["snapshot", "closed"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "The allocation remains reserved when the experimental API is promoted or retired.",
    },
  },
  draftSync: {
    id: CAPABILITY_ID_ALLOCATIONS.draftSync.id,
    name: "draft-sync-v1",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.9.4",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.draftSync.id,
    },
    description:
      "Account-owned local-first drafts with conditional saves, clears and protected staged attachments.",
    clientFallback:
      "Keep local drafts and existing uploads; send no draft synchronization requests.",
    serverContract: {
      routes: [
        "POST /api/drafts/read",
        "POST /api/drafts/write",
        "POST /api/drafts/clear",
        "GET /api/drafts/index",
        "GET /api/drafts/changes",
      ],
      routeModules: ["packages/server/src/routes/drafts.ts"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Requires ready SQLite draft storage.",
    },
  },
  issueSessionAssociations: {
    id: CAPABILITY_ID_ALLOCATIONS.issueSessionAssociations.id,
    name: "issue-session-associations-v1",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.8.2",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.issueSessionAssociations.id,
    },
    description:
      "Opt-in automatic issue/PR discovery, scoped search, durable evidence and corrections with ready SQLite.",
    clientFallback: "Hide issue controls and send no issue requests.",
    serverContract: {
      routes: [
        "GET /api/issues",
        "GET /api/issues/settings",
        "PUT /api/issues/settings",
        "GET /api/issues/credentials",
        "PUT /api/issues/credentials",
        "GET /api/issues/evidence",
        "GET /api/issues/sessions",
        "POST /api/issues/confirm",
        "POST /api/issues/decision",
        "POST /api/issues/resolve",
        "PATCH /api/issues/item",
        "DELETE /api/issues/item",
      ],
      routeModules: ["packages/server/src/routes/issues.ts"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Experimental feature depends on optional SQLite availability.",
    },
  },
  speechVocabularySessionTerms: {
    id: CAPABILITY_ID_ALLOCATIONS.speechVocabularySessionTerms.id,
    name: "speech-vocabulary-session-terms",
    kind: "permanent",
    area: "speech",
    introducedIn: "0.8.2",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.speechVocabularySessionTerms.id,
    },
    description:
      "Bias learned speech keyterms toward a supplied active-session term set when SQLite is ready.",
    clientFallback:
      "Omit context.sessionTerms and preserve existing speech recognition.",
    serverContract: {
      routes: ["POST /api/speech/transcribe", "GET /api/speech/ws"],
      // Extends requests on shared speech routes; it does not own the module.
      requestFields: ["context.sessionTerms"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Learned vocabulary depends on ready SQLite storage.",
    },
  },
  speechVocabulary: {
    id: CAPABILITY_ID_ALLOCATIONS.speechVocabulary.id,
    name: "speech-vocabulary",
    kind: "permanent",
    area: "speech",
    introducedIn: "0.8.2",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.speechVocabulary.id,
    },
    description:
      "Persistent opt-in speech vocabulary learning and Grok biasing when SQLite is ready.",
    clientFallback: "Hide vocabulary controls and make no vocabulary requests.",
    serverContract: {
      routes: [
        "GET /api/speech/vocabulary",
        "PUT /api/speech/vocabulary",
        "POST /api/speech/vocabulary/scan",
        "POST /api/speech/vocabulary/reset",
      ],
      routeModules: ["packages/server/src/routes/speech-vocabulary.ts"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Vocabulary availability depends on server storage configuration and readiness.",
    },
  },
  localSpeechModelSelection: {
    id: CAPABILITY_ID_ALLOCATIONS.localSpeechModelSelection.id,
    name: "local-speech-model-selection",
    kind: "permanent",
    area: "speech",
    introducedIn: "0.8.2",
    advertisement: { kind: "version-implied" },
    description:
      "Per-request Whisper model selection and unified English Parakeet on NeMo.",
    clientFallback:
      "Hide Whisper and recent Parakeet choices; retain older Parakeet requests without modifying saved preferences.",
    serverContract: {
      requestFields: ["model"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers ignore Whisper model overrides and lack the recent NeMo runtime.",
    },
  },
  acliCommentaryRendering: {
    id: CAPABILITY_ID_ALLOCATIONS.acliCommentaryRendering.id,
    name: "acli-commentary-rendering",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.8.2",
    advertisement: { kind: "version-implied" },
    description:
      "Bounded tool commentary rendering through the assistant Markdown path.",
    clientFallback:
      "Keep ordinary raw tool output and make no commentary rendering request.",
    serverContract: {
      routes: ["POST /api/projects/:projectId/tool-commentary/render"],
      routeModules: ["packages/server/src/routes/tool-commentary.ts"],
      requestFields: ["texts"],
      responseFields: ["html"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Older servers lack the commentary rendering endpoint.",
    },
  },
  nonHumanUserTurn: {
    id: CAPABILITY_ID_ALLOCATIONS.nonHumanUserTurn.id,
    name: "non-human-user-turn",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.8.2",
    advertisement: { kind: "version-implied" },
    description:
      "Durable cross-session user-turn attention and exact-turn acknowledgement.",
    clientFallback:
      "Hide delivery flags and make no delivery acknowledgement request.",
    serverContract: {
      requestFields: [
        "messageMetadata.sourceSessionId",
        "nonHumanUserTurnMessageId",
      ],
      responseFields: [
        "session.nonHumanUserTurn",
        "inboxItem.nonHumanUserTurn",
      ],
      events: ["session-metadata-changed"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Older servers do not retain cross-session delivery provenance.",
    },
  },
  sessionRewind: {
    id: CAPABILITY_ID_ALLOCATIONS.sessionRewind.id,
    name: "session-rewind",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.8.2",
    advertisement: { kind: "version-implied" },
    description:
      "Same-session rewind (/clear N), turn-menu Clear entries, rewound-group history, /clearloop with its patience controls, and queued /clear and /clearloop Project Queue items.",
    clientFallback:
      "Hide the Clear menu entries, mark /clear N, /fork N, and /clearloop unavailable, make no rewind or clearloop request, and queue no YA-command Project Queue item.",
    serverContract: {
      routes: [
        "POST /api/projects/:projectId/sessions/:sessionId/rewind",
        "POST /api/projects/:projectId/sessions/:sessionId/clearloop",
        "PATCH /api/projects/:projectId/sessions/:sessionId/clearloop",
        "DELETE /api/projects/:projectId/sessions/:sessionId/clearloop",
      ],
      responseFields: [
        "deferredMessages[].clearloop",
        "message.rewoundGroupId",
        "settings.clearloopInactivitySeconds",
        "projectQueue.items[].message.yaCommand",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "In-place rewind is a server-owned provider operation with durable rewind records.",
    },
  },
  sessionAsyncQuestions: {
    id: CAPABILITY_ID_ALLOCATIONS.sessionAsyncQuestions.id,
    name: "session-async-questions",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.8.2",
    advertisement: { kind: "version-implied" },
    description:
      "Bounded recent async question previews on session collections and activity updates.",
    clientFallback:
      "Keep transcript question controls; omit cross-session counts and menus and make no new request.",
    serverContract: {
      responseFields: ["session.asyncQuestions", "inboxItem.asyncQuestions"],
      events: ["session-updated"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Question discovery across sessions requires server-owned previews without loading every transcript in the browser.",
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
  glossaryTooltips: {
    id: CAPABILITY_ID_ALLOCATIONS.glossaryTooltips.id,
    name: "glossary-tooltips",
    kind: "permanent",
    area: "rendering",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server resolves governing project glossaries, returns compiled phrase automata, and streams project glossary-path changes.",
    clientFallback:
      "Hide Glossary hints, make no artifact request or subscription, and render ordinary Markdown.",
    serverContract: {
      routes: ["GET /api/projects/:projectId/glossary-artifact"],
      routeModules: ["packages/server/src/routes/glossary-artifacts.ts"],
      requestFields: ["glossaryArtifact.sourcePath"],
      responseFields: [
        "glossaryArtifact.status",
        "glossaryArtifact.governingPath",
        "glossaryArtifact.sourceVersion",
        "glossaryArtifact.dependencies",
        "glossaryArtifact.artifact",
        "glossaryArtifact.diagnostics",
      ],
      events: ["glossary-paths-snapshot", "glossary-path-changed"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients may outpace installed servers, and glossary discovery must remain server-owned.",
    },
  },
  progressiveSessionCatalog: {
    id: CAPABILITY_ID_ALLOCATIONS.progressiveSessionCatalog.id,
    name: "progressive-session-catalog",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server reports a session-collection generation and answers a conditional global session read with no-change instead of re-walking every project.",
    clientFallback:
      "Send no known generation, ignore any reported one, and keep the complete-request enumeration.",
    serverContract: {
      // No `routeModules`: this capability adds an optional request field and
      // two response fields to a route that predates it, rather than owning a
      // module. `global-sessions.ts` also serves `GET /api/sessions/stats`,
      // which this capability has nothing to do with.
      routes: ["GET /api/sessions"],
      requestFields: ["knownGeneration"],
      responseFields: ["generation", "unchanged"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "YA is self-hosted with no forced upgrade, so the population of servers without the conditional read never converges and the client's enumeration fallback never becomes removable.",
    },
  },
  retainedSessionCollections: {
    id: CAPABILITY_ID_ALLOCATIONS.retainedSessionCollections.id,
    name: "retained-session-collections",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.8.2",
    advertisement: { kind: "version-implied" },
    description:
      "Session collections serve durable compact rows while catalog and optional badges refresh independently.",
    clientFallback:
      "Omit summaryMode and use the existing complete-request collection paths.",
    serverContract: {
      routes: ["GET /api/sessions", "GET /api/inbox"],
      requestFields: ["summaryMode"],
      responseFields: ["catalog"],
      events: ["session-catalog-updated"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Independently updated clients and servers retain the complete-list fallback.",
    },
  },
  retainedRecents: {
    id: CAPABILITY_ID_ALLOCATIONS.retainedRecents.id,
    name: "retained-recents",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Recent visits read the retained session catalog without foreground provider discovery.",
    clientFallback: "Omit summaryMode and use the complete recents response.",
    serverContract: {
      routes: ["GET /api/recents"],
      requestFields: ["summaryMode"],
      responseFields: ["catalog", "visits"],
      events: ["session-catalog-updated", "recents-changed"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Older servers retain the complete-request recents path.",
    },
  },
  retainedProjects: {
    id: CAPABILITY_ID_ALLOCATIONS.retainedProjects.id,
    name: "retained-projects",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Project collections return retained discovery without foreground transcript scans.",
    clientFallback: "Omit summaryMode and use complete project enumeration.",
    serverContract: {
      routes: ["GET /api/projects"],
      requestFields: ["summaryMode"],
      responseFields: ["catalog"],
      events: ["projects-changed"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Older servers retain the complete-request project path.",
    },
  },
  providerDescriptors: {
    id: CAPABILITY_ID_ALLOCATIONS.providerDescriptors.id,
    name: "provider-descriptors",
    kind: "transitional",
    area: "providers",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Enumerates exposed provider identities without installation, authentication or model discovery.",
    clientFallback:
      "Use the complete providers response and make no descriptor request.",
    serverContract: {
      routes: ["GET /api/providers/descriptors"],
      responseFields: ["providers.name", "providers.displayName"],
    },
    lifecycle: {
      kind: "transitional",
      reviewAfter: "2026-12-09",
      removeClientGateWhen:
        "The core 60-day stable support corpus provides descriptors and the Maintainer approves removal.",
      removeServerAdvertisementWhen:
        "No maintained client branches on provider-descriptors.",
    },
  },
  projectDirectoryStoragePolicy: {
    id: CAPABILITY_ID_ALLOCATIONS.projectDirectoryStoragePolicy.id,
    name: "project-directory-storage-policy",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server defaults project-scoped YA state to its data directory, supports explicit project-local opt-in, and reconciles revisioned mutable state before changing modes.",
    clientFallback:
      "Show the storage location as unavailable and make no unsupported settings write.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings"],
      requestFields: ["settings.projectDirectoryStorage"],
      responseFields: ["settings.projectDirectoryStorage"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers may write YA-managed state into project directories without an opt-in.",
    },
  },
  idleReapHoursSetting: {
    id: CAPABILITY_ID_ALLOCATIONS.idleReapHoursSetting.id,
    name: "idle-reap-hours-setting",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server exposes a live-configurable best-effort grace before unviewed, verified-idle provider processes may be reaped.",
    clientFallback:
      "Hide the idle-reap control and make no unsupported settings write.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings"],
      requestFields: ["settings.idleReapHours"],
      responseFields: ["settings.idleReapHours"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients may outpace installed servers, and older servers do not expose a persisted idle-reap policy.",
    },
  },
  subagentMaxDepthSetting: {
    id: CAPABILITY_ID_ALLOCATIONS.subagentMaxDepthSetting.id,
    name: "subagent-max-depth-setting",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server persists a process-launch limit for supported providers' native subagent nesting depth.",
    clientFallback:
      "Hide the subagent-depth control and make no unsupported settings write.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings"],
      requestFields: ["settings.subagentMaxDepth"],
      responseFields: ["settings.subagentMaxDepth"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients may outpace installed servers, and older servers do not expose a process-launch subagent-depth policy.",
    },
  },
  codexReasoningSummarySetting: {
    id: CAPABILITY_ID_ALLOCATIONS.codexReasoningSummarySetting.id,
    name: "codex-reasoning-summary-setting",
    kind: "permanent",
    area: "providers",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server persists the reasoning-summary mode applied when Codex app-server sessions start, resume, or fork.",
    clientFallback:
      "Hide the Codex reasoning-summary control and make no unsupported settings write.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings"],
      requestFields: ["settings.codexReasoningSummary"],
      responseFields: ["settings.codexReasoningSummary"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients may outpace installed servers, and older servers do not expose the Codex reasoning-summary policy.",
    },
  },
  codexPlanToolSetting: {
    id: CAPABILITY_ID_ALLOCATIONS.codexPlanToolSetting.id,
    name: "codex-plan-tool-setting",
    kind: "permanent",
    area: "providers",
    introducedIn: "0.8.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server persists the Codex plan-tool mode applied when app-server sessions start, resume, or fork.",
    clientFallback:
      "Hide the Codex plan-tool control and make no unsupported settings write.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings"],
      requestFields: ["settings.codexPlanToolMode"],
      responseFields: ["settings.codexPlanToolMode"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients may outpace installed servers, and older servers do not expose the Codex plan-tool policy.",
    },
  },
  codexCyberAccessProgramSetting: {
    id: CAPABILITY_ID_ALLOCATIONS.codexCyberAccessProgramSetting.id,
    name: "codex-cyber-access-program-setting",
    kind: "permanent",
    area: "providers",
    introducedIn: "0.8.2",
    advertisement: { kind: "version-implied" },
    description:
      "Server persists the Codex cyber access program requested on each app-server turn.",
    clientFallback:
      "Hide the Codex cyber access program control and make no unsupported settings write.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings"],
      requestFields: ["settings.codexCyberAccessProgram"],
      responseFields: ["settings.codexCyberAccessProgram"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients may outpace installed servers, and older servers do not expose the Codex cyber access program policy.",
    },
  },
  codexStreamDurableIdAlignment: {
    id: CAPABILITY_ID_ALLOCATIONS.codexStreamDurableIdAlignment.id,
    name: "codex-stream-durable-id-alignment",
    kind: "permanent",
    area: "providers",
    introducedIn: "0.7.2",
    advertisement: { kind: "version-implied" },
    description:
      "Server aligns Codex live and durable transcript rows on provider or client message identity when that identity exists.",
    clientFallback:
      "Use the legacy Codex non-tool content/timestamp reconciliation, steer pairing, and timestamp-watermark replay suppression.",
    serverContract: {
      responseFields: [
        "sessionDetail.messages[].uuid",
        "sessionMessage.message.uuid",
      ],
      events: ["session-message"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients can outpace installed servers whose Codex stream and durable transcript ids do not align.",
    },
  },
  codexPaginatedRolloutLineage: {
    id: CAPABILITY_ID_ALLOCATIONS.codexPaginatedRolloutLineage.id,
    name: "codex-paginated-rollout-lineage",
    kind: "transitional",
    area: "sessions",
    introducedIn: "0.8.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server reconstructs reference-backed paginated Codex rollout history for session reads and native fork products.",
    clientFallback:
      "Disable Codex Clone and Fork with update guidance and make no fork request; other providers remain available.",
    serverContract: {
      routes: [
        "GET /api/sessions",
        "GET /api/projects/:projectId/sessions/:sessionId",
        "POST /api/projects/:projectId/sessions/:sessionId/fork",
      ],
      responseFields: [
        "sessionDetail.messages",
        "sessionSummary.messageCount",
        "sessionSummary.forkedFromSessionId",
      ],
    },
    lifecycle: {
      kind: "transitional",
      reviewAfter: "2026-10-01",
      removeClientGateWhen:
        "The optional hosted-client support corpus contains no server without reference-backed Codex rollout reads and the Maintainer approves removal.",
      removeServerAdvertisementWhen:
        "No maintained client still branches on codex-paginated-rollout-lineage.",
    },
  },
  toolResultMediaPreservationPolicy: {
    id: CAPABILITY_ID_ALLOCATIONS.toolResultMediaPreservationPolicy.id,
    name: "tool-result-media-preservation-policy",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server loads tool-result images on demand by default and can preserve new live results when explicitly enabled.",
    clientFallback:
      "Show media preservation as unavailable and make no unsupported settings write.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings"],
      requestFields: ["settings.toolResultMediaPreservation"],
      responseFields: ["settings.toolResultMediaPreservation"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older and development servers may use different tool-media storage semantics.",
    },
  },
  gitStatus: {
    name: "git-status",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.6.0",
    advertisement: { kind: "version-implied" },
    description:
      "Server supports project source-control status summaries for the Source Control page and sidebar entry.",
    clientFallback: "Hide Source Control entry points.",
    serverContract: {
      routes: ["GET /api/projects/:projectId/git"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Source Control availability is a server feature boundary for older servers and environments without the route.",
    },
  },
  gitStatusEnhanced: {
    name: "git-status-enhanced",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.6.0",
    advertisement: { kind: "version-implied" },
    description:
      "Server supports the enhanced Source Control page, including file summaries, branch metadata, and recent commits.",
    clientFallback: "Show the Source Control upgrade/unsupported state.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/git",
        "GET /api/projects/:projectId/git/untracked-folder",
        "POST /api/projects/:projectId/git/diff",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "The enhanced Source Control UI must stay hidden against older servers with only legacy status support.",
    },
  },
  gitStatusRemoteCheck: {
    name: "git-status-remote-check",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.6.0",
    advertisement: { kind: "version-implied" },
    description:
      "Server supports explicit remote fetch/check for Source Control status.",
    clientFallback: "Hide remote-check controls.",
    serverContract: {
      routes: ["POST /api/projects/:projectId/git/check-remote"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Remote checking depends on a server-side git operation endpoint and may be unavailable on older servers.",
    },
  },
  gitStatusPull: {
    name: "git-status-pull",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.6.0",
    advertisement: { kind: "version-implied" },
    description: "Server supports Source Control pull actions.",
    clientFallback: "Hide pull controls.",
    serverContract: {
      routes: ["POST /api/projects/:projectId/git/pull"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Pull is a mutating server-side git operation and must only be offered when the server advertises it.",
    },
  },
  gitStatusPush: {
    name: "git-status-push",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.6.0",
    advertisement: { kind: "version-implied" },
    description: "Server supports Source Control push/publish actions.",
    clientFallback: "Hide push controls.",
    serverContract: {
      routes: ["POST /api/projects/:projectId/git/push"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Push is a mutating server-side git operation and must only be offered when the server advertises it.",
    },
  },
  gitStatusIntegrationOptions: {
    name: "git-status-integration-options",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.6.0",
    advertisement: { kind: "version-implied" },
    description:
      "Server supports read-only Source Control integration-option analysis for diverged branches.",
    clientFallback: "Hide automatic integration-option controls.",
    serverContract: {
      routes: ["GET /api/projects/:projectId/git/integration-options"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Integration-option analysis depends on server-side route behavior older servers may not expose.",
    },
  },
  gitDirtyFileEditor: {
    id: CAPABILITY_ID_ALLOCATIONS.gitDirtyFileEditor.id,
    name: "git-dirty-file-editor",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server reports the last YA session observed editing each still-dirty Source Control path.",
    clientFallback:
      "Hide dirty-file session links and make no additional request.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/git",
        "GET /api/projects/:projectId/git/untracked-folder",
      ],
      responseFields: ["files[].lastEditor", "lastEditors"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients can outpace installed servers, and older status responses do not carry editor attribution.",
    },
  },
  gitSourceReview: {
    id: CAPABILITY_ID_ALLOCATIONS.gitSourceReview.id,
    name: "git-source-review",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server supports the commit/file browser and server-owned source-review workflow.",
    clientFallback:
      "Keep basic Source Control status and individually capability-gated remote actions; explain that browsing and review require a server update.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/git/commits",
        "GET /api/projects/:projectId/git/commit-search-manifest",
        "POST /api/projects/:projectId/git/commit-search-records",
        "GET /api/projects/:projectId/git/commit/:sha",
        "POST /api/projects/:projectId/git/commit-diff",
        "GET /api/projects/:projectId/git/blame",
        "GET /api/projects/:projectId/git/files",
        "GET /api/projects/:projectId/git/search",
        "GET /api/projects/:projectId/review/comments",
        "POST /api/projects/:projectId/review/comments",
        "PATCH /api/projects/:projectId/review/comments/:commentId",
        "DELETE /api/projects/:projectId/review/comments/:commentId",
        "POST /api/projects/:projectId/review/preview",
        "POST /api/projects/:projectId/review/submit",
      ],
      routeModules: [
        "packages/server/src/routes/git-browse.ts",
        "packages/server/src/routes/review-comments.ts",
      ],
      requestFields: ["gitDiff.againstHead", "gitDiff.origPath"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients can outpace installed servers, while Source Control must retain its released basic status and synchronization path.",
    },
  },
  gitSourceReviewSubmissions: {
    id: CAPABILITY_ID_ALLOCATIONS.gitSourceReviewSubmissions.id,
    name: "git-source-review-submissions",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server supports captured source-review sites, durable submissions, outcomes, and unread review responses.",
    clientFallback:
      "Retain the version-1 source-review comments and submit flow; hide Reviews and make no capture, submission, site, response, or acknowledgement request.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/review/submissions",
        "GET /api/projects/:projectId/review/submissions/:submissionId",
        "POST /api/projects/:projectId/review/submissions/:submissionId/acknowledge",
        "POST /api/projects/:projectId/review/submissions/:submissionId/refresh-response",
        "POST /api/projects/:projectId/review/sites/:siteId/follow-ups",
        "POST /api/projects/:projectId/review/sites/:siteId/resolve",
        "GET /api/review/inbox",
      ],
      routeModules: [
        "packages/server/src/routes/review-submissions.ts",
        "packages/server/src/routes/review-inbox.ts",
      ],
      requestFields: [
        "reviewComment.anchor.projection",
        "reviewSubmit.submissionId",
        "reviewSubmit.name",
        "settings.sourceReviewSubmissionsEnabled",
        "settings.sourceReviewResponseTurns",
      ],
      responseFields: [
        "gitDiff.reviewProjections",
        "settings.sourceReviewSubmissionsEnabled",
        "settings.sourceReviewResponseTurns",
      ],
      events: ["review-response-changed"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "The hosted client may outpace servers that expose version-1 source review but cannot preserve captures, submissions, sites, or response state.",
    },
  },
  gitSourceReviewProjections: {
    id: CAPABILITY_ID_ALLOCATIONS.gitSourceReviewProjections.id,
    name: "git-source-review-projections",
    kind: "transitional",
    area: "gitStatus",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server supports ignore-whitespace rendering and direct selected-revision-to-HEAD comparisons in Source Control.",
    clientFallback:
      "Keep ordinary working-tree and commit review available; make no projection request and explain that the server must be updated or restarted.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/git/compare/:sha",
        "POST /api/projects/:projectId/git/compare-diff",
      ],
      routeModules: ["packages/server/src/routes/git-projections.ts"],
      requestFields: [
        "gitDiff.ignoreWhitespace",
        "gitCommitDiff.ignoreWhitespace",
        "gitCompareDiff.baseSha",
        "gitCompareDiff.headSha",
        "gitCompareDiff.ignoreWhitespace",
      ],
      responseFields: [
        "gitRevisionComparison.baseSha",
        "gitRevisionComparison.headSha",
        "gitRevisionComparison.files",
      ],
    },
    lifecycle: {
      kind: "transitional",
      reviewAfter: "2026-10-28",
      removeClientGateWhen:
        "The hosted-client compatibility floor excludes servers older than the Source Control projection contract.",
      removeServerAdvertisementWhen:
        "No maintained client still branches on git-source-review-projections.",
    },
  },
  gitInclusiveToHead: {
    id: CAPABILITY_ID_ALLOCATIONS.gitInclusiveToHead.id,
    name: "git-inclusive-to-head",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server compares an inclusive selected-commit range from the selected commit's first parent, or the empty tree for a root commit, through pinned HEAD.",
    clientFallback:
      "Hide inclusive To HEAD and make no range request; retain separately gated direct per-file selected-tree-to-HEAD comparison.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/git/range-to-head/:sha",
        "POST /api/projects/:projectId/git/range-to-head-diff",
      ],
      routeModules: ["packages/server/src/routes/git-inclusive-to-head.ts"],
      requestFields: [
        "gitInclusiveComparisonDiff.baseSha",
        "gitInclusiveComparisonDiff.headSha",
        "gitInclusiveComparisonDiff.path",
        "gitInclusiveComparisonDiff.status",
        "gitInclusiveComparisonDiff.origPath",
        "gitInclusiveComparisonDiff.fullContext",
        "gitInclusiveComparisonDiff.ignoreWhitespace",
      ],
      responseFields: [
        "gitInclusiveRevisionComparison.selectedSha",
        "gitInclusiveRevisionComparison.baseSha",
        "gitInclusiveRevisionComparison.headSha",
        "gitInclusiveRevisionComparison.files",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "The existing projection capability permanently means direct selected-tree-to-HEAD comparison, and older servers have no inclusive-range route.",
    },
  },
  gitFileDiffProjections: {
    id: CAPABILITY_ID_ALLOCATIONS.gitFileDiffProjections.id,
    name: "git-file-diff-projections",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server exposes exact per-file HEAD-to-worktree and first-parent-to-worktree diff projections for the shared file viewer.",
    clientFallback:
      "Hide file-viewer diff selectors, retain ordinary file viewing and Source Control, and make no file-projection request.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/git/file-projections",
        "POST /api/projects/:projectId/git/file-projection-diff",
      ],
      routeModules: ["packages/server/src/routes/git-file-projections.ts"],
      requestFields: [
        "gitFileProjectionDiff.mode",
        "gitFileProjectionDiff.path",
        "gitFileProjectionDiff.fullContext",
      ],
      responseFields: [
        "gitFileProjections.headSha",
        "gitFileProjections.baseSha",
        "gitFileProjections.worktreeFiles",
        "gitFileProjections.cumulativeFiles",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients can outpace self-hosted servers, and the exact cumulative projection has no safe older-server request fallback.",
    },
  },
  gitFileRevision: {
    id: CAPABILITY_ID_ALLOCATIONS.gitFileRevision.id,
    name: "git-file-revision",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.7.2",
    advertisement: { kind: "version-implied" },
    description:
      "Server resolves a file's last content revision and whether live filesystem content differs from the committed blob.",
    clientFallback:
      "Omit file-revision provenance and make no metadata request.",
    serverContract: {
      routes: ["GET /api/projects/:projectId/git/file-revision"],
      routeModules: ["packages/server/src/routes/git-file-revision.ts"],
      requestFields: [
        "gitFileRevision.path",
        "gitFileRevision.rev",
        "gitFileRevision.origPath",
      ],
      responseFields: [
        "gitFileRevision.isGitRepo",
        "gitFileRevision.commit",
        "gitFileRevision.dirty",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients can outpace installed servers, and older servers have no per-file revision metadata route.",
    },
  },
  sessionConversationContext: {
    id: CAPABILITY_ID_ALLOCATIONS.sessionConversationContext.id,
    name: "session-conversation-context",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.8.2",
    advertisement: { kind: "version-implied" },
    description:
      "Deliver ordered user/assistant text turns through native history insertion or an attributed user message.",
    clientFallback:
      "Use existing fork/send/read routes for question cards and send imported context as a normal user message; never call the missing context route.",
    serverContract: {
      routes: [
        "POST /api/projects/:projectId/sessions/:sessionId/conversation-context",
      ],
      routeModules: ["packages/server/src/routes/conversation-context.ts"],
      requestFields: [
        "conversationContext.requestId",
        "conversationContext.turns",
      ],
      responseFields: ["conversationContext.delivery"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers cannot append role-preserving history without a new turn.",
    },
  },
  turnEffortModifiers: {
    id: CAPABILITY_ID_ALLOCATIONS.turnEffortModifiers.id,
    name: "turn-effort-modifiers",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.8.2",
    advertisement: { kind: "version-implied" },
    description:
      "Apply model-aware effort modifiers to one turn without changing normal session settings.",
    clientFallback:
      "Hide modifier commands and reject typed modifiers with update guidance; send no turnEffort metadata.",
    serverContract: {
      requestFields: ["messageMetadata.turnEffort"],
      responseFields: ["deferredMessages.metadata.turnEffort"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers cannot preserve one-turn effort through queue delivery.",
    },
  },
  projectFileCompletion: {
    id: CAPABILITY_ID_ALLOCATIONS.projectFileCompletion.id,
    name: "project-file-completion",
    kind: "permanent",
    area: "localAccess",
    introducedIn: "0.8.2",
    advertisement: { kind: "version-implied" },
    description:
      "Requested project path completion with progressive, ignore-filtered inventory and mention ordering.",
    clientFallback:
      "Leave @ text literal and make no completion request when the server cannot verify path eligibility.",
    serverContract: {
      routes: ["GET /api/projects/:projectId/file-completion"],
      routeModules: ["packages/server/src/routes/project-file-completion.ts"],
      responseFields: [
        "fileCompletion.entries",
        "fileCompletion.pending",
        "fileCompletion.truncated",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers lack ignore-filtered completion for filesystem-only projects.",
    },
  },
  gitWorkingTreeFiles: {
    id: CAPABILITY_ID_ALLOCATIONS.gitWorkingTreeFiles.id,
    name: "git-working-tree-files",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server exposes current-content inventory plus a persistent, searchable non-ignored untracked cache outside the project.",
    clientFallback:
      "Keep the tracked-only Files browser and legacy compact untracked expansion, making no working-tree or cache request.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/git/working-tree-files",
        "GET /api/projects/:projectId/git/untracked-files",
      ],
      routeModules: ["packages/server/src/routes/git-working-tree-files.ts"],
      responseFields: [
        "gitWorkingTreeFiles.files[].path",
        "gitWorkingTreeFiles.files[].tracked",
        "gitWorkingTreeFiles.truncated",
        "gitWorkingTreeFiles.limit",
        "gitUntrackedFiles.files",
        "gitUntrackedFiles.folders",
        "gitUntrackedFiles.total",
        "gitUntrackedFiles.refreshedAt",
        "gitUntrackedFiles.truncated",
        "gitUntrackedFiles.limit",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers expose only tracked paths, so the hosted client must not infer an incomplete current-content inventory from that route.",
    },
  },
  gitWorkingTreeSections: {
    id: CAPABILITY_ID_ALLOCATIONS.gitWorkingTreeSections.id,
    name: "git-working-tree-sections",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.7.2",
    advertisement: {
      kind: "optional-bit",
      index:
        OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS.gitWorkingTreeSections.index,
    },
    description:
      "Server maintains one project-keyed, lease-owned Working Tree snapshot with requested tracked, untracked, ignored, and filesystem-directory coverage, lazy filesystem-only inventory outside Git repositories, embedded Git facts when available, and sequenced live deltas.",
    clientFallback:
      "Use the released static working-tree inventory and cache-backed status paths without section controls, ignored enumeration, or a worktree subscription.",
    serverContract: {
      routes: ["GET /api/projects/:projectId/git/working-tree-files"],
      requestFields: [
        "gitWorkingTreeFiles.tracked",
        "gitWorkingTreeFiles.untracked",
        "gitWorkingTreeFiles.ignored",
        "relaySubscribe.channel=worktree",
        "relaySubscribe.projectId",
        "relaySubscribe.coverage",
        "relaySubscribe.coverage.expandedPrefixes",
      ],
      responseFields: [
        "gitWorkingTreeFiles.files[].kind",
        "gitWorktreeSnapshot.generation",
        "gitWorktreeSnapshot.coverage",
        "gitWorktreeSnapshot.headSha",
        "gitWorktreeSnapshot.baseSha",
        "gitWorktreeSnapshot.files[].tracked",
        "gitWorktreeSnapshot.files[].kind",
        "gitWorktreeSnapshot.files[].present",
        "gitWorktreeSnapshot.files[].worktreeChanges",
        "gitWorktreeSnapshot.files[].cumulativeChange",
        "gitWorktreeSnapshot.directories[].path",
        "gitWorktreeSnapshot.directories[].pending",
        "gitWorktreeSnapshot.directories[].truncated",
        "gitWorktreeDelta.generation",
        "gitWorktreeDelta.changes",
        "gitWorktreeDelta.directoryChanges",
        "gitWorktreeDelta.truncated",
      ],
      events: ["git-worktree-snapshot", "git-worktree-delta"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients can outpace self-hosted servers, and the released inventory route provides neither sectioned ignored coverage nor a resident live snapshot and delta contract.",
    },
  },
  gitWorkingTreeCompleteScan: {
    id: CAPABILITY_ID_ALLOCATIONS.gitWorkingTreeCompleteScan.id,
    name: "git-working-tree-complete-scan",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.7.2",
    advertisement: {
      kind: "optional-bit",
      index:
        OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS.gitWorkingTreeCompleteScan
          .index,
    },
    description:
      "Server reports total filesystem inventory sizes and accepts an explicit complete-scan worktree lease that removes the bounded client projection.",
    clientFallback:
      "Keep the bounded filesystem inventory and truncation notice without sending a complete-scan request or showing a Show all action.",
    serverContract: {
      requestFields: ["relaySubscribe.coverage.filesystemScan"],
      responseFields: [
        "gitWorktreeSnapshot.totalFiles",
        "gitWorktreeSnapshot.directories[].totalFiles",
        "gitWorktreeDelta.totalFiles",
        "gitWorktreeDelta.directoryChanges[].directory.totalFiles",
      ],
      events: ["git-worktree-snapshot", "git-worktree-delta"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers ignore the new request field and cannot honor a visible request to replace a bounded filesystem listing with its complete contents.",
    },
  },
  cacheMissBillingIgnoreAfter: {
    id: CAPABILITY_ID_ALLOCATIONS.cacheMissBillingIgnoreAfter.id,
    name: "cache-miss-billing-ignore-after",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.7.2",
    advertisement: { kind: "version-implied" },
    description:
      "Server separates the cache-billing upper idle cutoff from the legacy recent-activity no-alert window.",
    clientFallback:
      "Keep the legacy recent-activity control and omit the ignore-after field and control.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings"],
      requestFields: ["settings.cacheMissBilling.ignoreAfterMinutes"],
      responseFields: ["settings.cacheMissBilling.ignoreAfterMinutes"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers interpret recentActivityMinutes as a lower no-alert window, so the upper cutoff requires an additive field and permanent client gate.",
    },
  },
  cacheMissBillingExpectedExpiry: {
    id: CAPABILITY_ID_ALLOCATIONS.cacheMissBillingExpectedExpiry.id,
    name: "cache-miss-billing-expected-expiry",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.7.2",
    advertisement: { kind: "version-implied" },
    description:
      "Server records post-freshness cache reads and input costs as expected expiry evidence behind an opt-in query and live event.",
    clientFallback:
      "Hide the expected-expiry evidence toggle, omit the query field, and listen only for ordinary cache-billing events.",
    serverContract: {
      routes: ["GET /api/settings/cache-miss-billing/events"],
      requestFields: ["includeExpectedExpiry"],
      responseFields: [
        "events[].expectedInputCost.freshEnough",
        "events[].outcome",
      ],
      events: ["cache-miss-billing-expected-expiry"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older clients must not receive expected long-idle evidence through the legacy response or alert-oriented live event.",
    },
  },
  attachmentOnlySessionMessages: {
    id: CAPABILITY_ID_ALLOCATIONS.attachmentOnlySessionMessages.id,
    name: "attachment-only-session-messages",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.7.2",
    advertisement: { kind: "version-implied" },
    description:
      "Direct session start, resume, and queue routes accept an empty text field when the submitted message contains an uploaded attachment.",
    clientFallback:
      "Keep the attachment draft and require text instead of sending an empty-message request to an older server.",
    serverContract: {
      routes: [
        "POST /api/projects/:projectId/sessions",
        "POST /api/sessions",
        "POST /api/projects/:projectId/sessions/:sessionId/resume",
        "POST /api/sessions/:sessionId/messages",
      ],
      requestFields: ["message", "attachments"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers reject an empty message before inspecting attachments, so current clients need a permanent gate for attachment-only submission.",
    },
  },
  gitLiveWorktreeSetting: {
    id: CAPABILITY_ID_ALLOCATIONS.gitLiveWorktreeSetting.id,
    name: "git-live-worktree-setting",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.7.2",
    advertisement: { kind: "version-implied" },
    description:
      "Server persists the default-off live worktree monitoring setting independently of whether the live protocol is active.",
    clientFallback:
      "Hide and omit the setting, use static working-tree paths, and do not activate a worktree subscription.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings"],
      requestFields: ["settings.liveWorktreeMonitoringEnabled"],
      responseFields: ["settings.liveWorktreeMonitoringEnabled"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers lack the safety setting, so a current client must not interpret their source-ahead live capability as operator opt-in.",
    },
  },
  gitIncomingCommits: {
    id: CAPABILITY_ID_ALLOCATIONS.gitIncomingCommits.id,
    name: "git-incoming-commits",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server lists commits on the configured upstream tracking ref but not local HEAD without contacting the remote.",
    clientFallback:
      "Keep the upstream name as inert status text and make no incoming-commit request.",
    serverContract: {
      routes: ["GET /api/projects/:projectId/git/incoming-commits"],
      routeModules: ["packages/server/src/routes/git-incoming-commits.ts"],
      responseFields: [
        "gitIncomingCommits.upstream",
        "gitIncomingCommits.headSha",
        "gitIncomingCommits.upstreamSha",
        "gitIncomingCommits.commits",
        "gitIncomingCommits.truncated",
        "gitIncomingCommits.limit",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers have no read-only incoming-commit preview, and the client must not trigger an unsupported request or hidden fetch.",
    },
  },
  approvalAuditLog: {
    name: "approvalAuditLog",
    kind: "permanent",
    area: "localAccess",
    introducedIn: "0.6.0",
    advertisement: { kind: "version-implied" },
    description:
      "Server supports configuring approval audit-log persistence from Local Access settings.",
    clientFallback:
      "Treat approval audit logging as a legacy read-only enabled setting.",
    serverContract: {
      routes: ["GET /api/settings", "PATCH /api/settings"],
      responseFields: ["settings.approvalAuditLogEnabled"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers lack the configurable approval audit-log setting and should not receive writes for it.",
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
  browserSettingsBackup: {
    id: CAPABILITY_ID_ALLOCATIONS.browserSettingsBackup.id,
    name: "browser-settings-backup",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.6.3",
    advertisement: {
      kind: "optional-bit",
      index:
        OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS.browserSettingsBackup.index,
    },
    description:
      "Server stores one explicit backup of portable browser settings for save/load controls.",
    clientFallback: "Hide browser settings save/load controls.",
    serverContract: {
      routes: [
        "GET /api/settings/browser-backup",
        "PUT /api/settings/browser-backup",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients must not offer server-backed browser settings controls to older servers without the storage route.",
    },
  },
  claudeAdditionalModels: {
    name: "claude-additional-models",
    kind: "transitional",
    area: "providers",
    introducedIn: "0.6.3",
    advertisement: { kind: "version-implied" },
    description:
      "Server persists opt-in previous/custom Claude model ids and exposes the maintained optional catalog.",
    clientFallback: "Hide the Additional models provider setting.",
    serverContract: {
      routes: [
        "GET /api/settings",
        "PUT /api/settings",
        "GET /api/providers",
        "GET /api/processes/:processId/models",
      ],
      responseFields: [
        "settings.claudeAdditionalModels",
        "providers[].additionalModelOptions",
        "providers[].models[].catalogGroup",
      ],
    },
    lifecycle: {
      kind: "transitional",
      reviewAfter: "2026-10-25",
      removeClientGateWhen:
        "The hosted-client compatibility floor excludes servers older than the additional-model settings/catalog API.",
      removeServerAdvertisementWhen:
        "No maintained client still branches on claude-additional-models.",
    },
  },
  claudeGateway: {
    id: CAPABILITY_ID_ALLOCATIONS.claudeGateway.id,
    name: "claude-gateway",
    kind: "transitional",
    area: "providers",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server can persist a Claude LLM-gateway URL and expose its models as an isolated Claude Gateway provider.",
    clientFallback:
      "Hide Claude Gateway configuration and make no unsupported settings write.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings", "GET /api/providers"],
      requestFields: ["settings.claudeGatewayUrl"],
      responseFields: ["settings.claudeGatewayUrl", "providers[].name"],
    },
    lifecycle: {
      kind: "transitional",
      reviewAfter: "2026-10-27",
      removeClientGateWhen:
        "The hosted-client compatibility floor excludes servers older than the Claude Gateway settings/provider contract.",
      removeServerAdvertisementWhen:
        "No maintained client still branches on claude-gateway.",
    },
  },
  claudeGatewayServices: {
    id: CAPABILITY_ID_ALLOCATIONS.claudeGatewayServices.id,
    name: "claude-gateway-services",
    kind: "transitional",
    area: "providers",
    introducedIn: "0.8.2",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.claudeGatewayServices.id,
    },
    description:
      "Server stores a list of model-serving endpoints with per-entry lifecycle commands, declared context and output sizes, harness-narrowing overrides, and CodexOSS opt-in, and mirrors its default entry through the older single-gateway settings.",
    clientFallback:
      "Show the single Claude Gateway URL and start-command form, writing only the older claudeGateway* settings.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings", "GET /api/providers"],
      requestFields: [
        "settings.gatewayServices",
        "settings.defaultGatewayServiceId",
      ],
      responseFields: [
        "settings.gatewayServices",
        "settings.defaultGatewayServiceId",
      ],
    },
    lifecycle: {
      kind: "transitional",
      reviewAfter: "2027-03-16",
      removeClientGateWhen:
        "The hosted-client compatibility floor excludes servers older than the gateway services list.",
      removeServerAdvertisementWhen:
        "No maintained client still branches on claude-gateway-services.",
    },
  },
  claudeGatewayAutostart: {
    id: CAPABILITY_ID_ALLOCATIONS.claudeGatewayAutostart.id,
    name: "claude-gateway-autostart",
    kind: "transitional",
    area: "providers",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server can persist and run an explicit shell command when a configured loopback Claude Gateway has no TCP listener.",
    clientFallback:
      "Hide the Gateway start-command field and make no unsupported settings write.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings", "GET /api/providers"],
      requestFields: ["settings.claudeGatewayStartCommand"],
      responseFields: ["settings.claudeGatewayStartCommand"],
    },
    lifecycle: {
      kind: "transitional",
      reviewAfter: "2026-10-28",
      removeClientGateWhen:
        "The hosted-client compatibility floor excludes servers older than the Gateway autostart setting and provider-refresh behavior.",
      removeServerAdvertisementWhen:
        "No maintained client still branches on claude-gateway-autostart.",
    },
  },
  claudeGatewayDisableAgent: {
    id: CAPABILITY_ID_ALLOCATIONS.claudeGatewayDisableAgent.id,
    name: "claude-gateway-disable-agent",
    kind: "transitional",
    area: "providers",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server can persist whether Claude Gateway launches deny Claude Code's Agent tool.",
    clientFallback:
      "Hide the Gateway Agent-tool setting and make no unsupported settings write.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings"],
      requestFields: ["settings.claudeGatewayDisableAgent"],
      responseFields: ["settings.claudeGatewayDisableAgent"],
    },
    lifecycle: {
      kind: "transitional",
      reviewAfter: "2026-11-09",
      removeClientGateWhen:
        "The hosted-client compatibility floor excludes servers older than the Gateway Agent-tool setting.",
      removeServerAdvertisementWhen:
        "No maintained client still branches on claude-gateway-disable-agent.",
    },
  },
  claudeGatewayDisablePlanMode: {
    id: CAPABILITY_ID_ALLOCATIONS.claudeGatewayDisablePlanMode.id,
    name: "claude-gateway-disable-plan-mode",
    kind: "transitional",
    area: "providers",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server can persist whether Claude Gateway launches remove Claude Code's plan-mode tools from model context.",
    clientFallback:
      "Hide the Gateway plan-mode setting and make no unsupported settings write.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings"],
      requestFields: ["settings.claudeGatewayDisablePlanMode"],
      responseFields: ["settings.claudeGatewayDisablePlanMode"],
    },
    lifecycle: {
      kind: "transitional",
      reviewAfter: "2026-11-17",
      removeClientGateWhen:
        "The hosted-client compatibility floor excludes servers older than the Gateway plan-mode setting.",
      removeServerAdvertisementWhen:
        "No maintained client still branches on claude-gateway-disable-plan-mode.",
    },
  },
  providerSubscriptionUsage: {
    id: CAPABILITY_ID_ALLOCATIONS.providerSubscriptionUsage.id,
    name: "provider-subscription-usage",
    kind: "transitional",
    area: "providers",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server exposes normalized read-only provider subscription and rate-limit windows.",
    clientFallback:
      "Make no subscription-usage request and hide model usage badges and context usage detail.",
    serverContract: {
      routes: ["GET /api/providers/:name/subscription-usage"],
      responseFields: ["usage"],
    },
    lifecycle: {
      kind: "transitional",
      reviewAfter: "2026-10-29",
      removeClientGateWhen:
        "The hosted-client compatibility floor excludes servers older than the subscription-usage route.",
      removeServerAdvertisementWhen:
        "No maintained client still branches on provider-subscription-usage.",
    },
  },
  providerHostControl: {
    id: CAPABILITY_ID_ALLOCATIONS.providerHostControl.id,
    name: "provider-host-control",
    kind: "permanent",
    area: "providers",
    introducedIn: "0.7.1",
    advertisement: {
      kind: "optional-bit",
      index:
        OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS.providerHostControl.index,
    },
    description:
      "Server adapts authenticated remote session-turn requests to an incumbent same-user provider host without becoming a second provider owner.",
    clientFallback:
      "Hide provider-host control and make no status, inventory, turn, receipt, or interruption request.",
    serverContract: {
      routes: [
        "GET /api/provider-host/status",
        "GET /api/provider-host/runtimes",
        "POST /api/provider-host/session-turn",
        "GET /api/provider-host/session-turn/:submissionId",
        "POST /api/provider-host/session-turn/:submissionId/interrupt",
      ],
      routeModules: ["packages/server/src/routes/provider-host.ts"],
      requestFields: [
        "providerHostTurn.submissionId",
        "providerHostTurn.target",
        "providerHostTurn.message",
        "providerHostTurn.timeoutMs",
      ],
      responseFields: [
        "providerHostStatus.available",
        "providerHostInventory.runtimes",
        "providerHostTurnStatus",
      ],
      events: [
        "providerHostTurn.accepted",
        "providerHostTurn.providerEvent",
        "providerHostTurn.approvalRequired",
        "providerHostTurn.terminal",
        "providerHostTurn.error",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Host availability is launch- and platform-dependent, while hosted clients can outpace installed servers that lack the adapter routes.",
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
  reloadSafeCodexRuntimeSettings: {
    id: CAPABILITY_ID_ALLOCATIONS.reloadSafeCodexRuntimeSettings.id,
    name: "reload-safe-codex-runtime-settings",
    kind: "permanent",
    area: "providers",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server persists the default-off Codex reload-safe-session setting and exposes the restart action used to apply it.",
    clientFallback:
      "Hide the setting, omit its field from writes, and retain ordinary restart behavior.",
    serverContract: {
      routes: [
        "GET /api/settings",
        "PUT /api/settings",
        "POST /api/server/restart",
      ],
      requestFields: ["settings.codexReloadSafeSessions"],
      responseFields: ["settings.codexReloadSafeSessions"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients can outpace installed servers that do not understand the setting or reload-safe restart contract.",
    },
  },
  reloadSafeCodexRuntime: {
    id: CAPABILITY_ID_ALLOCATIONS.reloadSafeCodexRuntime.id,
    name: "reload-safe-codex-runtime",
    kind: "permanent",
    area: "providers",
    introducedIn: "0.7.1",
    advertisement: {
      kind: "optional-bit",
      index:
        OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS.reloadSafeCodexRuntime.index,
    },
    description:
      "This Linux server is running under a usable lifecycle host that can retain eligible Codex runtimes across a Hono reload.",
    clientFallback:
      "Show the supported setting as unavailable and keep Codex runtimes under ordinary server ownership.",
    serverContract: {
      routes: ["GET /api/version"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Runtime support depends on the current host, launch mode, and successful lifecycle-host registration.",
    },
  },
  bangCommands: {
    name: "bang-commands",
    kind: "permanent",
    area: "localAccess",
    introducedIn: "0.6.3",
    advertisement: { kind: "version-implied" },
    description:
      "Server supports always-on local `!!` shell commands, completions, and persisted bang-command history; the top-level history view stays behind an explicit default-off setting.",
    clientFallback: "Hide bang-command entry points and composer routing.",
    serverContract: {
      routes: [
        "GET /api/settings",
        "PUT /api/settings",
        "POST /api/projects/:projectId/sessions/:sessionId/bang-commands",
        "POST /api/projects/:projectId/sessions/:sessionId/bang-commands/:objectId/kill",
        "GET /api/projects/:projectId/sessions/:sessionId/bang-commands/:objectId/output",
        "DELETE /api/projects/:projectId/sessions/:sessionId/bang-commands/:objectId",
        "GET /api/projects/:projectId/bang-completions",
        "GET /api/bang-commands",
      ],
      responseFields: ["settings.clientDefaults.bangCommandsEnabled"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Local command execution is an explicit server security boundary and older servers may not expose the routes or setting.",
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
    clientFallback: "Hide host identity settings and render no host marker.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings"],
      responseFields: ["settings.hostIdentity"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients may remain compatible with older servers that cannot persist host identity.",
    },
  },
  hostAwakeControl: {
    name: "host-awake-control",
    kind: "transitional",
    area: "remoteAccess",
    introducedIn: "0.6.3",
    advertisement: { kind: "version-implied" },
    description:
      "Server supports process-lifetime host-awake settings and status discovery.",
    clientFallback: "Hide host-awake settings.",
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
      kind: "transitional",
      reviewAfter: "2026-10-21",
      removeClientGateWhen:
        "The hosted-client compatibility floor excludes servers older than the host-awake settings/status API.",
      removeServerAdvertisementWhen:
        "No maintained client still branches on host-awake-control.",
    },
  },
  hostAgentProcessObservability: {
    id: CAPABILITY_ID_ALLOCATIONS.hostAgentProcessObservability.id,
    name: "host-agent-process-observability",
    kind: "permanent",
    area: "localAccess",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server can report minimized host metrics for YA-owned and independently launched provider process trees.",
    clientFallback:
      "Keep the existing Agents inventory, hide host metrics and external rows, and make no host-process request.",
    serverContract: {
      routes: [
        "GET /api/host-agent-processes",
        "GET /api/settings",
        "PUT /api/settings",
      ],
      requestFields: ["settings.hostProcessObservabilityEnabled"],
      responseFields: [
        "settings.hostProcessObservabilityEnabled",
        "hostAgentProcesses.enabled",
        "hostAgentProcesses.supported",
        "hostAgentProcesses.sampledAt",
        "hostAgentProcesses.observations",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients can outpace installed servers, and older servers do not expose the minimized host process route or setting.",
    },
  },
  sessionSandboxing: {
    id: CAPABILITY_ID_ALLOCATIONS.sessionSandboxing.id,
    name: "session-sandboxing",
    kind: "permanent",
    area: "localAccess",
    introducedIn: "0.7.1",
    advertisement: {
      kind: "optional-bit",
      index: OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS.sessionSandboxing.index,
    },
    description:
      "Server currently has a usable local backend for accepting, persisting, enforcing, and reporting the default-off YA session filesystem sandbox selection.",
    clientFallback:
      "Hide session sandbox controls, omit sandbox fields, and preserve unsandboxed session behavior.",
    serverContract: {
      routes: [
        "GET /api/settings",
        "PUT /api/settings",
        "POST /api/projects/:projectId/sessions",
        "POST /api/projects/:projectId/sessions/create",
        "POST /api/projects/:projectId/queue",
        "POST /api/projects/:projectId/sessions/:sessionId/resume",
        "POST /api/projects/:projectId/sessions/:sessionId/reactivate",
        "POST /api/projects/:projectId/sessions/:sessionId/recap",
        "POST /api/projects/:projectId/sessions/:sessionId/restart",
        "POST /api/projects/:projectId/sessions/:sessionId/fork",
        "POST /api/projects/:projectId/sessions/:sessionId/retitle",
        "POST /api/projects/:projectId/sessions/:sessionId/fork-summary",
        "POST /api/sessions",
        "POST /api/sessions/create",
      ],
      requestFields: [
        "settings.newSessionDefaults.sandboxLevel",
        "sessionStart.sandboxLevel",
        "sessionCreate.sandboxLevel",
        "projectQueue.target.sandboxLevel",
        "sessionRestart.sandboxLevel",
      ],
      responseFields: [
        "settings.newSessionDefaults.sandboxLevel",
        "sessionStart.sandboxEnforcement",
        "sessionResume.sandboxEnforcement",
        "sessionReactivate.sandboxEnforcement",
        "sessionRestart.sandboxEnforcement",
        "process.sandboxEnforcement",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers and unsupported hosts cannot preserve and enforce the launch boundary, so clients must never imply or request it without a dynamically advertised usable backend.",
    },
  },
  sessionSandboxingStatus: {
    id: CAPABILITY_ID_ALLOCATIONS.sessionSandboxingStatus.id,
    name: "session-sandboxing-status",
    kind: "permanent",
    area: "localAccess",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server reports the local session-sandbox backend preflight state independently from launch-time enforcement.",
    clientFallback:
      "Hide session sandbox controls and make no unsupported sandbox requests.",
    serverContract: {
      routes: ["GET /api/version"],
      responseFields: ["version.sessionSandboxing"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients need to distinguish protocol-aware but unsupported hosts and intermediate development servers from hosts with a verified usable backend.",
    },
  },
  sessionSandboxNetworkFirewall: {
    id: CAPABILITY_ID_ALLOCATIONS.sessionSandboxNetworkFirewall.id,
    name: "session-sandbox-network-firewall",
    kind: "permanent",
    area: "localAccess",
    introducedIn: "0.7.2",
    advertisement: { kind: "version-implied" },
    description:
      "Server accepts, persists, inherits, enforces, and reports the project-write session network firewall selection.",
    clientFallback:
      "Hide all session sandbox controls and omit both sandbox launch fields.",
    serverContract: {
      routes: [
        "GET /api/settings",
        "PUT /api/settings",
        "POST /api/projects/:projectId/sessions",
        "POST /api/projects/:projectId/sessions/create",
        "POST /api/projects/:projectId/queue",
        "POST /api/projects/:projectId/sessions/:sessionId/resume",
        "POST /api/projects/:projectId/sessions/:sessionId/reactivate",
        "POST /api/projects/:projectId/sessions/:sessionId/recap",
        "POST /api/projects/:projectId/sessions/:sessionId/restart",
        "POST /api/projects/:projectId/sessions/:sessionId/fork",
        "POST /api/projects/:projectId/sessions/:sessionId/retitle",
        "POST /api/projects/:projectId/sessions/:sessionId/fork-summary",
        "POST /api/sessions",
        "POST /api/sessions/create",
      ],
      requestFields: [
        "settings.newSessionDefaults.sandboxNetworkFirewall",
        "sessionStart.sandboxNetworkFirewall",
        "sessionCreate.sandboxNetworkFirewall",
        "projectQueue.target.sandboxNetworkFirewall",
        "sessionRestart.sandboxNetworkFirewall",
      ],
      responseFields: [
        "settings.newSessionDefaults.sandboxNetworkFirewall",
        "sessionStart.sandboxEnforcement.networkFirewall",
        "sessionResume.sandboxEnforcement.networkFirewall",
        "sessionReactivate.sandboxEnforcement.networkFirewall",
        "sessionRestart.sandboxEnforcement.networkFirewall",
        "process.sandboxEnforcement.networkFirewall",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Self-hosted clients and servers can remain version-skewed indefinitely, and omission on older servers cannot prove this security boundary.",
    },
  },
  projectQueue: {
    name: "projectQueue",
    kind: "permanent",
    area: "projectQueue",
    introducedIn: "0.5.0",
    advertisement: { kind: "version-implied" },
    description:
      "Server supports durable project-scoped queue creation, listing, mutation, dispatch pause/resume, and promotion.",
    clientFallback: "Hide Project Queue entry points.",
    serverContract: {
      routes: [
        "GET /api/project-queue",
        "POST /api/project-queue/pause",
        "POST /api/project-queue/resume",
        "POST /api/project-queue/:projectId/promote-now",
        "GET /api/projects/:projectId/queue",
        "POST /api/projects/:projectId/queue",
        "PATCH /api/projects/:projectId/queue/:itemId",
        "DELETE /api/projects/:projectId/queue/:itemId",
        "POST /api/projects/:projectId/queue/:itemId/retry",
        "POST /api/projects/:projectId/queue/:itemId/move-to-top",
      ],
      events: ["project-queue-changed"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Project Queue availability remains a server feature boundary for older servers and hosted remote clients.",
    },
  },
  projectQueueReadinessCheck: {
    id: CAPABILITY_ID_ALLOCATIONS.projectQueueReadinessCheck.id,
    name: "project-queue-readiness-check",
    kind: "permanent",
    area: "projectQueue",
    introducedIn: "0.8.2",
    advertisement: { kind: "version-implied" },
    description:
      "Server persists an optional global executable that gates Project Queue readiness, with bounded polling and Force start bypass.",
    clientFallback:
      "Hide the readiness executable setting and omit its field from settings updates.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings"],
      requestFields: ["settings.projectQueueReadinessCheck"],
      responseFields: ["settings.projectQueueReadinessCheck"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers cannot persist or execute an external Project Queue readiness command.",
    },
  },
  projectQueueAttachmentEditing: {
    id: CAPABILITY_ID_ALLOCATIONS.projectQueueAttachmentEditing.id,
    name: "project-queue-attachment-editing",
    kind: "permanent",
    area: "projectQueue",
    introducedIn: "0.8.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server atomically updates queued-message attachment sets containing retained queue-owned refs and newly uploaded draft refs.",
    clientFallback:
      "Keep Project Queue inline editing text-only and make no attachment upload or attachment mutation request.",
    serverContract: {
      routes: ["PATCH /api/projects/:projectId/queue/:itemId"],
      requestFields: [
        "projectQueue.message.attachments",
        "projectQueue.message.stagedAttachments",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients may outpace installed servers that cannot combine queue-owned and draft-owned attachment refs in one update.",
    },
  },
  projectSessionDefaults: {
    id: CAPABILITY_ID_ALLOCATIONS.projectSessionDefaults.id,
    name: "project-session-defaults",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server persists project-scoped heartbeat defaults and recent heartbeat messages, then seeds new session metadata from the effective project-to-global values.",
    clientFallback:
      "Hide Project Settings heartbeat entry points, make no project-default requests, and retain global plus per-session heartbeat behavior.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/session-defaults",
        "PATCH /api/projects/:projectId/session-defaults",
      ],
      routeModules: ["packages/server/src/routes/project-session-defaults.ts"],
      requestFields: [
        "projectSessionDefaults.heartbeatTurnsAfterMinutes",
        "projectSessionDefaults.heartbeatTurnText",
      ],
      responseFields: [
        "projectSessionDefaults.projectId",
        "projectSessionDefaults.overrides",
        "projectSessionDefaults.recentHeartbeatTurnTexts",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients can outpace installed servers, and project settings must never issue unsupported reads or writes to older servers.",
    },
  },
  projectCodeNames: {
    id: CAPABILITY_ID_ALLOCATIONS.projectCodeNames.id,
    name: "project-code-names",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.7.2",
    advertisement: { kind: "version-implied" },
    description:
      "Server allocates, persists, and atomically edits unique project code names for compact project identity in browser titles and session lists.",
    clientFallback:
      "Use full project names, keep legacy tab-title activity frames, hide code-name editing, and make no code-name request.",
    serverContract: {
      routes: [
        "GET /api/projects",
        "GET /api/projects/:projectId",
        "POST /api/projects",
        "PATCH /api/projects/:projectId/code-name",
      ],
      requestFields: ["projectCodeName.codeName"],
      responseFields: [
        "projects[].codeName",
        "project.codeName",
        "projectCodeName.assignments",
      ],
      events: ["project-code-names-changed"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients can outpace installed servers, which neither return durable code names nor support conflict-safe edits.",
    },
  },
  projectCaptions: {
    id: CAPABILITY_ID_ALLOCATIONS.projectCaptions.id,
    name: "project-captions",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.8.2",
    advertisement: { kind: "version-implied" },
    description:
      "Server derives a short project caption from README or manifest text, accepts a per-project override in app data, and reports the caption with its source on project responses.",
    clientFallback:
      "Show no caption on project cards or the session breadcrumb tooltip, hide caption editing, and make no caption request.",
    serverContract: {
      routes: [
        "GET /api/projects",
        "GET /api/projects/:projectId",
        "POST /api/projects",
        "PATCH /api/projects/:projectId/caption",
      ],
      requestFields: ["projectCaption.caption"],
      responseFields: [
        "projects[].caption",
        "project.caption",
        "projectCaption.caption",
      ],
      events: ["project-captions-changed"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients can outpace installed servers, which neither derive captions nor accept caption overrides.",
    },
  },
  projectNames: {
    id: CAPABILITY_ID_ALLOCATIONS.projectNames.id,
    name: "project-names",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.8.2",
    advertisement: { kind: "version-implied" },
    description:
      "Server accepts a chosen project name and code name when a project is added, stores a name override in app data, applies it wherever the project is named, and announces project list changes.",
    clientFallback:
      "Add projects by path alone, show the path's last component as the name, and make no name request.",
    serverContract: {
      routes: [
        "GET /api/projects",
        "GET /api/projects/:projectId",
        "POST /api/projects",
        "PATCH /api/projects/:projectId/name",
      ],
      requestFields: [
        "addProject.name",
        "addProject.codeName",
        "projectName.name",
      ],
      responseFields: ["projects[].name", "project.name"],
      events: ["projects-changed"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients can outpace installed servers, which ignore a chosen name and would silently add the project under its path name.",
    },
  },
  sidebarSessionResume: {
    id: CAPABILITY_ID_ALLOCATIONS.sidebarSessionResume.id,
    name: "sidebar-session-resume",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server session summaries identify manual resume exemptions so recent interrupted sessions can expose a safe message-less Resume action.",
    clientFallback:
      "Hide sidebar Resume controls and make no reactivate request.",
    serverContract: {
      routes: [
        "GET /api/sessions",
        "POST /api/projects/:projectId/sessions/:sessionId/reactivate",
        "POST /api/processes/:processId/abort",
      ],
      requestFields: ["processAbort.blockResume"],
      responseFields: ["globalSessions.sessions[].autoResumeDisabled"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers do not expose the durable manual-termination marker in sidebar session summaries.",
    },
  },
  syntheticDoneCommand: {
    id: CAPABILITY_ID_ALLOCATIONS.syntheticDoneCommand.id,
    name: "synthetic-done-command",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server persists a YA-only /done transcript row, pauses automatic session-waking work until the next real user turn, and verifies that the owned provider process stopped.",
    clientFallback:
      "Hide the toolbar setting and action, treat typed /done as an ordinary provider command, and make no done request.",
    serverContract: {
      routes: ["POST /api/sessions/:sessionId/done"],
      routeModules: ["packages/server/src/routes/session-done.ts"],
      responseFields: [
        "message",
        "paused",
        "termination",
        "settings.clientDefaults.sessionToolbarPresence.syntheticDone",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients can outpace installed servers, and older servers neither persist the overlay nor enforce the automation pause.",
    },
  },
  syntheticArchiveCommand: {
    id: CAPABILITY_ID_ALLOCATIONS.syntheticArchiveCommand.id,
    name: "synthetic-archive-command",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server archives a session, applies the same durable stop boundary as /done, and preserves /archive in the queued and transcript projections.",
    clientFallback:
      "Translate typed /archive to the established synthetic /done operation before queue projection and make no archive request.",
    serverContract: {
      routes: ["POST /api/sessions/:sessionId/archive"],
      routeModules: ["packages/server/src/routes/session-archive.ts"],
      responseFields: ["message", "paused", "termination"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers cannot atomically archive with the durable session boundary, but can preserve the user's done intent through the established /done route.",
    },
  },
  syntheticTerminateCommand: {
    id: CAPABILITY_ID_ALLOCATIONS.syntheticTerminateCommand.id,
    name: "synthetic-terminate-command",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.7.2",
    advertisement: { kind: "version-implied" },
    description:
      "Server archives a session, persists a /terminate boundary, blocks automatic resume, and verifies that the owned provider process stopped.",
    clientFallback:
      "Hide the command, treat typed /terminate as an ordinary provider command, and make no terminate request.",
    serverContract: {
      routes: ["POST /api/sessions/:sessionId/terminate"],
      routeModules: ["packages/server/src/routes/session-terminate.ts"],
      responseFields: ["message", "paused", "termination", "resumeExemption"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers do not combine archival, durable resume exemption, and verified process termination.",
    },
  },
  projectQueueNewSessionShortcutSetting: {
    name: "project-queue-new-session-shortcut-setting",
    kind: "permanent",
    area: "projectQueue",
    introducedIn: "0.6.3",
    advertisement: { kind: "version-implied" },
    description:
      "Server accepts and persists the active-composer new-session Project Queue shortcut presence setting.",
    clientFallback:
      "Hide the active-composer new-session shortcut and its Toolbar setting.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings"],
      responseFields: [
        "settings.clientDefaults.sessionToolbarPresence.projectQueueNewSessionShortcut",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients must not save the new toolbar presence key to older servers that reject it.",
    },
  },
  voiceInput: {
    id: CAPABILITY_ID_ALLOCATIONS.voiceInput.id,
    name: "voiceInput",
    kind: "permanent",
    area: "speech",
    introducedIn: "0.6.0",
    advertisement: {
      kind: "optional-bit",
      index: OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS.voiceInput.index,
    },
    description:
      "Server permits voice input features and may expose server-routed speech backends.",
    clientFallback:
      "When absent from a capabilities-bearing response, hide or disable voice input controls.",
    serverContract: {
      routes: [
        "POST /api/speech/transcribe",
        "POST /api/speech/prewarm",
        "GET /api/speech/ws",
        "POST /api/speech/xai-client-key",
        "POST /api/speech/xai-client-secret",
      ],
      responseFields: [
        "voiceBackends",
        "voiceBackendStatuses",
        "voiceBackendCapabilities",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Voice input can be disabled by server configuration and older clients preserve fallback behavior when version data is absent.",
    },
  },
  deviceBridgeAvailable: {
    id: CAPABILITY_ID_ALLOCATIONS.deviceBridgeAvailable.id,
    name: "deviceBridge-available",
    kind: "permanent",
    area: "deviceBridge",
    introducedIn: "0.6.0",
    advertisement: {
      kind: "optional-bit",
      index:
        OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS.deviceBridgeAvailable.index,
    },
    description:
      "Server recognizes the device bridge feature and can surface device settings or setup state.",
    clientFallback: "Hide device bridge settings and navigation.",
    serverContract: {
      responseFields: ["deviceBridgeState"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Device bridge availability varies by server environment and installation state.",
    },
  },
  deviceBridge: {
    id: CAPABILITY_ID_ALLOCATIONS.deviceBridge.id,
    name: "deviceBridge",
    kind: "permanent",
    area: "deviceBridge",
    introducedIn: "0.6.0",
    advertisement: {
      kind: "optional-bit",
      index: OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS.deviceBridge.index,
    },
    description:
      "Server has an installed device bridge runtime and device routes can be used.",
    clientFallback: "Hide live device controls.",
    serverContract: {
      routes: [
        "GET /api/devices",
        "POST /api/devices/:id/start",
        "POST /api/devices/:id/stop",
        "GET /api/devices/:id/screenshot",
      ],
      responseFields: ["deviceBridgeState"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "The installed bridge runtime is environment-dependent and can change without a protocol-version change.",
    },
  },
  deviceBridgeDownload: {
    id: CAPABILITY_ID_ALLOCATIONS.deviceBridgeDownload.id,
    name: "deviceBridge-download",
    kind: "permanent",
    area: "deviceBridge",
    introducedIn: "0.6.0",
    advertisement: {
      kind: "optional-bit",
      index:
        OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS.deviceBridgeDownload.index,
    },
    description:
      "Server can download or update managed device bridge runtime dependencies.",
    clientFallback: "Hide device bridge download/update prompts.",
    serverContract: {
      routes: ["POST /api/devices/bridge/download"],
      responseFields: ["deviceBridgeState"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Download support depends on server environment and is advertised separately from installed runtime availability.",
    },
  },
  deviceBridgeUpdate: {
    id: CAPABILITY_ID_ALLOCATIONS.deviceBridgeUpdate.id,
    name: "deviceBridge-update",
    kind: "permanent",
    area: "deviceBridge",
    introducedIn: "0.6.0",
    advertisement: {
      kind: "optional-bit",
      index:
        OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS.deviceBridgeUpdate.index,
    },
    description:
      "Server reports an available update for managed device bridge runtime dependencies.",
    clientFallback:
      "Show download/setup state without an update-specific prompt.",
    serverContract: {
      routes: ["POST /api/devices/bridge/download"],
      responseFields: ["deviceBridgeState", "latestDeviceBridgeVersion"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Update availability is dynamic state advertised for older clients that branch on capability strings.",
    },
  },
  sessionForkTurnIntents: {
    id: CAPABILITY_ID_ALLOCATIONS.sessionForkTurnIntents.id,
    name: "session-fork-turn-intents",
    kind: "transitional",
    area: "sessions",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server resolves Clone and direct Fork requests at real completed user-turn boundaries.",
    clientFallback:
      "Hide unified Clone and direct Fork actions and make no fork request.",
    serverContract: {
      routes: ["POST /api/projects/:projectId/sessions/:sessionId/fork"],
      requestFields: ["forkKind", "sourceMessageId"],
    },
    lifecycle: {
      kind: "transitional",
      reviewAfter: "2026-10-01",
      removeClientGateWhen:
        "The optional hosted-client support corpus contains no server without server-resolved fork intents and the Maintainer approves removal.",
      removeServerAdvertisementWhen:
        "No maintained client still branches on session-fork-turn-intents.",
    },
  },
} as const satisfies Record<string, ServerCapabilityDefinition>;

export type ServerCapabilityKey = keyof typeof SERVER_CAPABILITIES;
export type ServerCapabilityName =
  (typeof SERVER_CAPABILITIES)[ServerCapabilityKey]["name"];

export const PROJECT_DIRECTORY_STORAGE_POLICY_CAPABILITY =
  SERVER_CAPABILITIES.projectDirectoryStoragePolicy.name;
export const PUBLIC_SHARE_MANAGEMENT_CAPABILITY =
  SERVER_CAPABILITIES.publicShareManagement.name;
export const PUBLIC_SHARE_MANAGEMENT_FREEZE_CAPABILITY =
  SERVER_CAPABILITIES.publicShareManagementFreeze.name;
export const PUBLIC_FILE_SHARES_CAPABILITY =
  SERVER_CAPABILITIES.publicFileShares.name;
export const IDLE_REAP_HOURS_SETTING_CAPABILITY =
  SERVER_CAPABILITIES.idleReapHoursSetting.name;
export const SUBAGENT_MAX_DEPTH_SETTING_CAPABILITY =
  SERVER_CAPABILITIES.subagentMaxDepthSetting.name;
export const CODEX_REASONING_SUMMARY_SETTING_CAPABILITY =
  SERVER_CAPABILITIES.codexReasoningSummarySetting.name;
export const CODEX_PLAN_TOOL_SETTING_CAPABILITY =
  SERVER_CAPABILITIES.codexPlanToolSetting.name;
export const CODEX_CYBER_ACCESS_PROGRAM_SETTING_CAPABILITY =
  SERVER_CAPABILITIES.codexCyberAccessProgramSetting.name;
export const CODEX_STREAM_DURABLE_ID_ALIGNMENT_CAPABILITY =
  SERVER_CAPABILITIES.codexStreamDurableIdAlignment.name;
export const CODEX_PAGINATED_ROLLOUT_LINEAGE_CAPABILITY =
  SERVER_CAPABILITIES.codexPaginatedRolloutLineage.name;
export const GLOSSARY_TOOLTIPS_CAPABILITY =
  SERVER_CAPABILITIES.glossaryTooltips.name;
export const TOOL_RESULT_MEDIA_PRESERVATION_POLICY_CAPABILITY =
  SERVER_CAPABILITIES.toolResultMediaPreservationPolicy.name;
export const PROGRESSIVE_SESSION_CATALOG_CAPABILITY =
  SERVER_CAPABILITIES.progressiveSessionCatalog.name;
export const RETAINED_SESSION_COLLECTIONS_CAPABILITY =
  SERVER_CAPABILITIES.retainedSessionCollections.name;
export const SESSION_ASYNC_QUESTIONS_CAPABILITY =
  SERVER_CAPABILITIES.sessionAsyncQuestions.name;
export const SESSION_REWIND_CAPABILITY = SERVER_CAPABILITIES.sessionRewind.name;
export const NON_HUMAN_USER_TURN_CAPABILITY =
  SERVER_CAPABILITIES.nonHumanUserTurn.name;
export const SESSION_CONTENT_SEARCH_CAPABILITY =
  SERVER_CAPABILITIES.sessionContentSearch.name;
export const AGENT_SERVER_ACCESS_CAPABILITY =
  SERVER_CAPABILITIES.agentServerAccess.name;
export const SIDEBAR_SESSION_CATEGORIES_CAPABILITY =
  SERVER_CAPABILITIES.sidebarSessionCategories.name;
export const SESSION_SCOPED_LOCAL_FILES_CAPABILITY =
  SERVER_CAPABILITIES.sessionScopedLocalFiles.name;
export const SESSION_CREATION_PROVENANCE_CAPABILITY =
  SERVER_CAPABILITIES.sessionCreationProvenance.name;
export const ACLI_COMMENTARY_RENDERING_CAPABILITY =
  SERVER_CAPABILITIES.acliCommentaryRendering.name;
export const PROJECT_QUEUE_CAPABILITY = SERVER_CAPABILITIES.projectQueue.name;
export const PROJECT_QUEUE_READINESS_CHECK_CAPABILITY =
  SERVER_CAPABILITIES.projectQueueReadinessCheck.name;
export const PROJECT_QUEUE_ATTACHMENT_EDITING_CAPABILITY =
  SERVER_CAPABILITIES.projectQueueAttachmentEditing.name;

export const PROJECT_SESSION_DEFAULTS_CAPABILITY =
  SERVER_CAPABILITIES.projectSessionDefaults.name;
export const PROJECT_CODE_NAMES_CAPABILITY =
  SERVER_CAPABILITIES.projectCodeNames.name;
export const PROJECT_CAPTIONS_CAPABILITY =
  SERVER_CAPABILITIES.projectCaptions.name;
export const PROJECT_NAMES_CAPABILITY = SERVER_CAPABILITIES.projectNames.name;
export const SIDEBAR_SESSION_RESUME_CAPABILITY =
  SERVER_CAPABILITIES.sidebarSessionResume.name;
export const SYNTHETIC_DONE_COMMAND_CAPABILITY =
  SERVER_CAPABILITIES.syntheticDoneCommand.name;
export const SYNTHETIC_ARCHIVE_COMMAND_CAPABILITY =
  SERVER_CAPABILITIES.syntheticArchiveCommand.name;
export const SYNTHETIC_TERMINATE_COMMAND_CAPABILITY =
  SERVER_CAPABILITIES.syntheticTerminateCommand.name;
export const PROJECT_QUEUE_NEW_SESSION_SHORTCUT_SETTING_CAPABILITY =
  SERVER_CAPABILITIES.projectQueueNewSessionShortcutSetting.name;

export const GIT_STATUS_CAPABILITY = SERVER_CAPABILITIES.gitStatus.name;
export const GIT_STATUS_ENHANCED_CAPABILITY =
  SERVER_CAPABILITIES.gitStatusEnhanced.name;
export const GIT_STATUS_REMOTE_CHECK_CAPABILITY =
  SERVER_CAPABILITIES.gitStatusRemoteCheck.name;
export const GIT_STATUS_PULL_CAPABILITY =
  SERVER_CAPABILITIES.gitStatusPull.name;
export const GIT_STATUS_PUSH_CAPABILITY =
  SERVER_CAPABILITIES.gitStatusPush.name;
export const GIT_STATUS_INTEGRATION_OPTIONS_CAPABILITY =
  SERVER_CAPABILITIES.gitStatusIntegrationOptions.name;
export const GIT_DIRTY_FILE_EDITOR_CAPABILITY =
  SERVER_CAPABILITIES.gitDirtyFileEditor.name;
export const GIT_FILE_DIFF_PROJECTIONS_CAPABILITY =
  SERVER_CAPABILITIES.gitFileDiffProjections.name;
export const GIT_FILE_REVISION_CAPABILITY =
  SERVER_CAPABILITIES.gitFileRevision.name;
export const GIT_WORKING_TREE_FILES_CAPABILITY =
  SERVER_CAPABILITIES.gitWorkingTreeFiles.name;
export const PROJECT_FILE_COMPLETION_CAPABILITY =
  SERVER_CAPABILITIES.projectFileCompletion.name;
export const SESSION_CONVERSATION_CONTEXT_CAPABILITY =
  SERVER_CAPABILITIES.sessionConversationContext.name;
export const GIT_WORKING_TREE_SECTIONS_CAPABILITY =
  SERVER_CAPABILITIES.gitWorkingTreeSections.name;
export const GIT_WORKING_TREE_COMPLETE_SCAN_CAPABILITY =
  SERVER_CAPABILITIES.gitWorkingTreeCompleteScan.name;
export const GIT_LIVE_WORKTREE_SETTING_CAPABILITY =
  SERVER_CAPABILITIES.gitLiveWorktreeSetting.name;
export const CACHE_MISS_BILLING_IGNORE_AFTER_CAPABILITY =
  SERVER_CAPABILITIES.cacheMissBillingIgnoreAfter.name;
export const CACHE_MISS_BILLING_EXPECTED_EXPIRY_CAPABILITY =
  SERVER_CAPABILITIES.cacheMissBillingExpectedExpiry.name;
export const ATTACHMENT_ONLY_SESSION_MESSAGES_CAPABILITY =
  SERVER_CAPABILITIES.attachmentOnlySessionMessages.name;
export const GIT_INCOMING_COMMITS_CAPABILITY =
  SERVER_CAPABILITIES.gitIncomingCommits.name;
export const GIT_SOURCE_REVIEW_CAPABILITY =
  SERVER_CAPABILITIES.gitSourceReview.name;
export const GIT_SOURCE_REVIEW_SUBMISSIONS_CAPABILITY =
  SERVER_CAPABILITIES.gitSourceReviewSubmissions.name;
export const GIT_SOURCE_REVIEW_PROJECTIONS_CAPABILITY =
  SERVER_CAPABILITIES.gitSourceReviewProjections.name;
export const GIT_INCLUSIVE_TO_HEAD_CAPABILITY =
  SERVER_CAPABILITIES.gitInclusiveToHead.name;

export const APPROVAL_AUDIT_LOG_CAPABILITY =
  SERVER_CAPABILITIES.approvalAuditLog.name;

export const BROWSER_SETTINGS_BACKUP_CAPABILITY =
  SERVER_CAPABILITIES.browserSettingsBackup.name;

export const CLAUDE_ADDITIONAL_MODELS_CAPABILITY =
  SERVER_CAPABILITIES.claudeAdditionalModels.name;

export const CLAUDE_GATEWAY_CAPABILITY = SERVER_CAPABILITIES.claudeGateway.name;
export const CLAUDE_GATEWAY_SERVICES_CAPABILITY =
  SERVER_CAPABILITIES.claudeGatewayServices.name;

export const CLAUDE_GATEWAY_AUTOSTART_CAPABILITY =
  SERVER_CAPABILITIES.claudeGatewayAutostart.name;

export const CLAUDE_GATEWAY_DISABLE_AGENT_CAPABILITY =
  SERVER_CAPABILITIES.claudeGatewayDisableAgent.name;

export const CLAUDE_GATEWAY_DISABLE_PLAN_MODE_CAPABILITY =
  SERVER_CAPABILITIES.claudeGatewayDisablePlanMode.name;

export const PROVIDER_SUBSCRIPTION_USAGE_CAPABILITY =
  SERVER_CAPABILITIES.providerSubscriptionUsage.name;

export const PROVIDER_HOST_CONTROL_CAPABILITY =
  SERVER_CAPABILITIES.providerHostControl.name;

export const REMOTE_BROWSER_DIAGNOSTICS_CAPABILITY =
  SERVER_CAPABILITIES.remoteBrowserDiagnostics.name;

export const RELOAD_SAFE_CODEX_RUNTIME_SETTINGS_CAPABILITY =
  SERVER_CAPABILITIES.reloadSafeCodexRuntimeSettings.name;

export const RELOAD_SAFE_CODEX_RUNTIME_CAPABILITY =
  SERVER_CAPABILITIES.reloadSafeCodexRuntime.name;

export const BANG_COMMANDS_CAPABILITY = SERVER_CAPABILITIES.bangCommands.name;

export const HOST_IDENTITY_CAPABILITY = SERVER_CAPABILITIES.hostIdentity.name;

export const HOST_AWAKE_CONTROL_CAPABILITY =
  SERVER_CAPABILITIES.hostAwakeControl.name;

export const HOST_AGENT_PROCESS_OBSERVABILITY_CAPABILITY =
  SERVER_CAPABILITIES.hostAgentProcessObservability.name;

export const SESSION_SANDBOXING_CAPABILITY =
  SERVER_CAPABILITIES.sessionSandboxing.name;

export const SESSION_SANDBOXING_STATUS_CAPABILITY =
  SERVER_CAPABILITIES.sessionSandboxingStatus.name;

export const SESSION_SANDBOX_NETWORK_FIREWALL_CAPABILITY =
  SERVER_CAPABILITIES.sessionSandboxNetworkFirewall.name;

export const SESSION_FORK_TURN_INTENTS_CAPABILITY =
  SERVER_CAPABILITIES.sessionForkTurnIntents.name;

export const VOICE_INPUT_CAPABILITY = SERVER_CAPABILITIES.voiceInput.name;
export const SPEECH_BACKEND_SETUP_CAPABILITY =
  SERVER_CAPABILITIES.speechBackendSetup.name;

export const DEVICE_BRIDGE_AVAILABLE_CAPABILITY =
  SERVER_CAPABILITIES.deviceBridgeAvailable.name;
export const DEVICE_BRIDGE_CAPABILITY = SERVER_CAPABILITIES.deviceBridge.name;
export const DEVICE_BRIDGE_DOWNLOAD_CAPABILITY =
  SERVER_CAPABILITIES.deviceBridgeDownload.name;
export const DEVICE_BRIDGE_UPDATE_CAPABILITY =
  SERVER_CAPABILITIES.deviceBridgeUpdate.name;

const SERVER_CAPABILITY_DEFINITIONS_BY_NAME = new Map<
  string,
  ServerCapabilityDefinition
>(
  Object.values(SERVER_CAPABILITIES).map((definition) => [
    definition.name,
    definition,
  ]),
);

export function encodeOptionalServerCapabilityBits(
  capabilities: readonly string[],
): OptionalServerCapabilityBitset {
  const ids: number[] = [];
  for (const name of capabilities) {
    const advertisement =
      SERVER_CAPABILITY_DEFINITIONS_BY_NAME.get(name)?.advertisement;
    if (advertisement?.kind !== "optional-bit") continue;
    ids.push(advertisement.index);
  }
  return encodeCapabilityIds(ids);
}

export function encodeCompactServerCapabilities(
  capabilities: readonly string[],
  currentVersion: string,
  deniedCapabilities: readonly string[] = [],
): CompactServerCapabilityAdvertisement {
  const capabilityExtensions = capabilities.filter((name) => {
    const definition = SERVER_CAPABILITY_DEFINITIONS_BY_NAME.get(name);
    return (
      !definition ||
      (definition.advertisement.kind === "version-implied" &&
        !isVersionAtLeast(currentVersion, definition.introducedIn)) ||
      definition.advertisement.kind === "scoped"
    );
  });
  return {
    optionalCapabilityBits: encodeOptionalServerCapabilityBits(capabilities),
    ...(capabilityExtensions.length > 0 ? { capabilityExtensions } : {}),
    ...encodeDeniedServerCapabilities(deniedCapabilities, currentVersion),
  };
}

function encodeDeniedServerCapabilities(
  deniedCapabilities: readonly string[],
  currentVersion: string,
): { deniedCapabilityBits?: CapabilityBitset } {
  const ids: number[] = [];
  for (const name of deniedCapabilities) {
    const definition = SERVER_CAPABILITY_DEFINITIONS_BY_NAME.get(name);
    if (definition?.advertisement.kind !== "version-implied") {
      throw new Error(
        `Only version-implied server capabilities can be denied: ${name}`,
      );
    }
    if (
      definition.id !== undefined &&
      isVersionAtLeast(currentVersion, definition.introducedIn)
    ) {
      ids.push(definition.id);
    }
  }
  return ids.length > 0
    ? { deniedCapabilityBits: encodeCapabilityIds(ids) }
    : {};
}

/**
 * Choose the newest server-capability encoding understood by both peers.
 *
 * Stable/prerelease clients use the 0.7.1 cutover. A git-describe source build
 * may still name the preceding tag; the presence of the version field proves
 * that this source client implements encoding 1.
 */
export function negotiateServerCapabilityEncoding(
  clientVersion: string | null | undefined,
  serverVersion: string | null | undefined,
): typeof CAPABILITY_ID_ENCODING_VERSION | null {
  if (!parseCapabilityVersion(serverVersion)) return null;
  const client = parseCapabilityVersion(clientVersion);
  const introduced = parseCapabilityVersion(
    CAPABILITY_ID_ENCODING_INTRODUCED_IN,
  );
  if (!client || !introduced) return null;

  for (const index of [0, 1, 2] as const) {
    if (client.parts[index] !== introduced.parts[index]) {
      return client.parts[index] > introduced.parts[index]
        ? CAPABILITY_ID_ENCODING_VERSION
        : isGitDescribeSourceVersion(clientVersion)
          ? CAPABILITY_ID_ENCODING_VERSION
          : null;
    }
  }
  return CAPABILITY_ID_ENCODING_VERSION;
}

export function encodeVersionedServerCapabilities(
  capabilities: readonly string[],
  currentVersion: string,
  deniedCapabilities: readonly string[] = [],
): VersionedServerCapabilityAdvertisement {
  const explicitIds: number[] = [];
  for (const name of capabilities) {
    const definition = SERVER_CAPABILITY_DEFINITIONS_BY_NAME.get(name);
    if (!definition || definition.advertisement.kind === "scoped") {
      throw new Error(
        `Global server capability has no ID-encoding contract: ${name}`,
      );
    }
    if (
      definition.advertisement.kind === "version-implied" &&
      isVersionAtLeast(currentVersion, definition.introducedIn)
    ) {
      continue;
    }
    if (definition.id === undefined) {
      throw new Error(`Server capability has no allocated ID: ${name}`);
    }
    explicitIds.push(definition.id);
  }
  return {
    capabilityEncoding: CAPABILITY_ID_ENCODING_VERSION,
    capabilityBits: encodeCapabilityIds(explicitIds),
    ...encodeDeniedServerCapabilities(deniedCapabilities, currentVersion),
  };
}

export function serverHasCapability(
  source: ServerCapabilitySource | null | undefined,
  capability: ServerCapabilityDefinition | ServerCapabilityName | string,
): boolean {
  const name = typeof capability === "string" ? capability : capability.name;
  const definition =
    typeof capability === "string"
      ? SERVER_CAPABILITY_DEFINITIONS_BY_NAME.get(name)
      : capability;
  if (
    definition?.advertisement.kind === "version-implied" &&
    definition.id !== undefined &&
    capabilityBitIsSet(source?.deniedCapabilityBits, definition.id)
  ) {
    return false;
  }
  if (
    source?.capabilities?.includes(name) ||
    source?.capabilityExtensions?.includes(name)
  ) {
    return true;
  }

  if (!definition) return false;

  if (definition.advertisement.kind === "version-implied") {
    return (
      isVersionAtLeast(source?.current, definition.introducedIn) ||
      (definition.id !== undefined &&
        capabilityBitIsSet(source?.capabilityBits, definition.id))
    );
  }
  if (definition.advertisement.kind === "optional-bit") {
    return (
      capabilityBitIsSet(
        source?.capabilityBits,
        definition.advertisement.index,
      ) ||
      capabilityBitIsSet(
        source?.optionalCapabilityBits,
        definition.advertisement.index,
      )
    );
  }
  return false;
}

export function hasServerCapabilityAdvertisement(
  source: ServerCapabilitySource | null | undefined,
): boolean {
  return (
    source?.capabilities !== undefined ||
    source?.capabilityEncoding !== undefined ||
    source?.capabilityBits !== undefined ||
    source?.deniedCapabilityBits !== undefined ||
    source?.optionalCapabilityBits !== undefined ||
    source?.capabilityExtensions !== undefined
  );
}

function isGitDescribeSourceVersion(
  version: string | null | undefined,
): boolean {
  return /^v?\d+\.\d+\.\d+-\d+-g[0-9a-f]+(?:-dirty)?$/iu.test(
    version?.trim() ?? "",
  );
}

function isVersionAtLeast(
  current: string | null | undefined,
  introducedIn: string,
): boolean {
  const candidate = parseCapabilityVersion(current);
  const baseline = parseCapabilityVersion(introducedIn);
  if (!candidate || !baseline) return false;

  for (const index of [0, 1, 2] as const) {
    if (candidate.parts[index] !== baseline.parts[index]) {
      return candidate.parts[index] > baseline.parts[index];
    }
  }

  if (candidate.prerelease === null) return true;
  return /^\d+-g[0-9a-f]+(?:-dirty)?$/iu.test(candidate.prerelease);
}

function parseCapabilityVersion(version: string | null | undefined): {
  parts: readonly [number, number, number];
  prerelease: string | null;
} | null {
  const match = version
    ?.trim()
    .match(
      /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
    );
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return {
    parts: [
      Number.parseInt(match[1], 10),
      Number.parseInt(match[2], 10),
      Number.parseInt(match[3], 10),
    ],
    prerelease: match[4] ?? null,
  };
}
