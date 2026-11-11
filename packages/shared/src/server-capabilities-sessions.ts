import { CAPABILITY_ID_ALLOCATIONS } from "./capability-ids.js";
import type { ServerCapabilityDefinition } from "./server-capability-definition.js";

export const SESSIONS_SERVER_CAPABILITIES = {
  sidebarSessionSnapshot: {
    id: CAPABILITY_ID_ALLOCATIONS.sidebarSessionSnapshot.id,
    name: "sidebar-session-snapshot",
    kind: "transitional",
    area: "sessions",
    introducedIn: "0.12.0",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.sidebarSessionSnapshot.id,
    },
    description:
      "Fresh bounded sidebar windows with archive deadlines; retained session pages accept timestamp/identity cursors.",
    clientFallback:
      "Keep the existing three paged session feeds; send no sidebar snapshot request without this exact support bit.",
    serverContract: {
      routes: ["GET /api/sessions/sidebar", "GET /api/sessions"],
      requestFields: [
        "recentLimit",
        "starredLimit",
        "categorizedLimit",
        "after",
      ],
      responseFields: ["rows", "windows", "catalog", "nextTransitionAt"],
    },
    lifecycle: { kind: "transitional" },
  },
  queuedSessionCompaction: {
    id: CAPABILITY_ID_ALLOCATIONS.queuedSessionCompaction.id,
    name: "queued-session-compaction",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.11.1",
    advertisement: { kind: "version-implied" },
    description:
      "Queue explicit Claude/Codex compaction before later session input.",
    clientFallback:
      "Keep manual Compact. Refuse delayed /compact locally without sending a request.",
    serverContract: {
      routes: ["POST /api/sessions/:sessionId/messages"],
      requestFields: ["message", "deferred"],
      responseFields: ["deferredMessages"],
      events: ["deferred-queue"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Hide delayed compact on servers without scheduling support.",
    },
  },
  sessionCreationAdmission: {
    id: CAPABILITY_ID_ALLOCATIONS.sessionCreationAdmission.id,
    name: "session-creation-admission-v1",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.11.1",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.sessionCreationAdmission.id,
    },
    description:
      "Keyed durable session admission for configured providers, owner and limited principals, sandbox/Machine Control options, staged initial files and explicit empty preparation.",
    clientFallback:
      "Use the isolated established start/create-and-send adapter only when this bit is absent. Never probe an unsupported creation write.",
    serverContract: {
      routes: [
        "POST /api/projects/:projectId/session-creations",
        "POST /api/session-creations",
        "GET /api/session-creations/:requestId",
      ],
      requestFields: [
        "requestId",
        "provider",
        "message",
        "stagedAttachments",
        "intent",
      ],
      responseFields: [
        "requestId",
        "sessionId",
        "projectId",
        "provider",
        "creation",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Admission support is distinct from the stronger unadvertised broad delivery/receipts guarantee.",
    },
  },
  stagedSessionCreation: {
    id: CAPABILITY_ID_ALLOCATIONS.stagedSessionCreation.id,
    name: "session-creation-staged-attachments",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.11.1",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.stagedSessionCreation.id,
    },
    description:
      "Owner Claude/Codex unsandboxed creation retains staged attachment bytes with accepted input before native effects.",
    clientFallback:
      "Without this exact bit, use established create/materialize/send; never send staged references to an unsupported endpoint.",
    serverContract: {
      routes: [
        "POST /api/projects/:projectId/session-creations",
        "POST /api/session-creations",
        "GET /api/session-creations/:requestId",
      ],
      requestFields: ["requestId", "provider", "message", "stagedAttachments"],
      responseFields: [
        "requestId",
        "sessionId",
        "projectId",
        "provider",
        "creation",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Attachment acceptance is separate from the provider text contracts and broad creation receipts.",
    },
  },
  piTextCreation: {
    id: CAPABILITY_ID_ALLOCATIONS.piTextCreation.id,
    name: "session-creation-pi-text",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.11.1",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.piTextCreation.id,
    },
    description:
      "Owner-only Pi text creation saves intent before startup, binds its native RPC session handle without public remap and confirms input only from a successful native prompt preflight response.",
    clientFallback:
      "Use existing process-start endpoints for older servers and unsupported input shapes.",
    serverContract: {
      routes: [
        "POST /api/projects/:projectId/session-creations",
        "POST /api/session-creations",
        "GET /api/session-creations/:requestId",
      ],
      requestFields: ["requestId", "provider", "message"],
      responseFields: [
        "requestId",
        "sessionId",
        "projectId",
        "provider",
        "creation",
        "serverTimestamp",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Durable ordinary text acceptance is separate from the deferred all-provider/attachment receipts contract.",
    },
  },
  opencodeTextCreation: {
    id: CAPABILITY_ID_ALLOCATIONS.opencodeTextCreation.id,
    name: "session-creation-opencode-text",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.11.1",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.opencodeTextCreation.id,
    },
    description:
      "Owner-only OpenCode text creation saves intent before startup, binds its native ses_* handle without public remap and confirms input only from a successful native message POST.",
    clientFallback:
      "Use existing process-start endpoints for older servers and unsupported input shapes.",
    serverContract: {
      routes: [
        "POST /api/projects/:projectId/session-creations",
        "POST /api/session-creations",
        "GET /api/session-creations/:requestId",
      ],
      requestFields: ["requestId", "provider", "message"],
      responseFields: [
        "requestId",
        "sessionId",
        "projectId",
        "provider",
        "creation",
        "serverTimestamp",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Durable ordinary text acceptance is separate from the deferred all-provider/attachment receipts contract.",
    },
  },
  codexTextCreation: {
    id: CAPABILITY_ID_ALLOCATIONS.codexTextCreation.id,
    name: "session-creation-codex-text",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.11.1",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.codexTextCreation.id,
    },
    description:
      "Owner-only Codex text creation saves intent before startup and returns a stable session receipt, with native thread binding and native input acknowledgement.",
    clientFallback:
      "Use existing process-start endpoints for older servers and unsupported input shapes.",
    serverContract: {
      routes: [
        "POST /api/projects/:projectId/session-creations",
        "POST /api/session-creations",
        "GET /api/session-creations/:requestId",
      ],
      requestFields: ["requestId", "provider", "message"],
      responseFields: [
        "requestId",
        "sessionId",
        "projectId",
        "provider",
        "creation",
        "serverTimestamp",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Durable ordinary text acceptance is separate from the deferred all-provider/attachment receipts contract.",
    },
  },
  claudeTextCreation: {
    id: CAPABILITY_ID_ALLOCATIONS.claudeTextCreation.id,
    name: "session-creation-claude-text",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.11.1",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.claudeTextCreation.id,
    },
    description:
      "Owner-only Claude text creation saves intent before startup and returns a stable session receipt, including routed launches.",
    clientFallback:
      "Use existing process-start endpoints for older servers and unsupported input shapes.",
    serverContract: {
      routes: [
        "POST /api/projects/:projectId/session-creations",
        "POST /api/session-creations",
        "GET /api/session-creations/:requestId",
      ],
      requestFields: ["requestId", "provider", "message"],
      responseFields: [
        "requestId",
        "sessionId",
        "projectId",
        "provider",
        "creation",
        "serverTimestamp",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Durable ordinary text acceptance is separate from the deferred all-provider/attachment receipts contract.",
    },
  },
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
  agentAuthRouterServiceTiers: {
    id: CAPABILITY_ID_ALLOCATIONS.agentAuthRouterServiceTiers.id,
    name: "agent-auth-router-service-tiers",
    introducedIn: "0.11.1",
    kind: "permanent",
    retired: true,
    area: "sessions",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.agentAuthRouterServiceTiers.id,
    },
    description:
      "Retired client gate: current clients use scoped serviceTierSelection responses. Still advertised for cached older clients; ID reserved.",
    clientFallback:
      "Current clients use response-level serviceTierSelection; absence or false hides routed Speed and sends no unsupported tier write.",
    serverContract: {
      requestFields: ["serviceTier"],
      responseFields: ["serviceTierSelection", "models.serviceTiers"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "No current client gate remains. Retain the advertisement for older clients; runtime AAR support belongs to scoped responses.",
    },
  },
  agentAuthRouterSessionSwitch: {
    id: CAPABILITY_ID_ALLOCATIONS.agentAuthRouterSessionSwitch.id,
    name: "agent-auth-router-session-switch",
    introducedIn: "0.11.1",
    kind: "permanent",
    area: "sessions",
    lifecycle: {
      kind: "permanent",
      reason: "Optional local router integration.",
    },
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.agentAuthRouterSessionSwitch.id,
    },
    description:
      "Moves an existing Claude or Codex session to another router pool account or to Direct: the new pin is prepared and committed first, then the provider process is killed so the next message resumes on it.",
    clientFallback:
      "Keep the session header's router chip read-only; a session stays on its pin for life.",
    serverContract: {
      routes: ["POST /api/agent-auth-router/sessions/:sessionId/switch"],
      routeModules: [
        "packages/server/src/routes/agent-auth-router-session-switch.ts",
      ],
      requestFields: ["routerPoolId", "routerAccountId", "direct"],
      responseFields: ["routerBinding"],
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
      "Passes AAR's own policy list and labels through, accepts any router policy as a per-session override, and reports admission refresh and policy evidence.",
    clientFallback:
      "Offer the policies the server reports; a server without this bit may refuse an override at launch.",
    serverContract: {
      requestFields: ["routerPolicy"],
      responseFields: [
        "supportedPolicies",
        "policies",
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
    retired: true,
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
  githubStatusControls: {
    id: CAPABILITY_ID_ALLOCATIONS.githubStatusControls.id,
    name: "github-status-controls",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.9.4",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.githubStatusControls.id,
    },
    description:
      "Independent GitHub status checks, gh disable/account controls and durable tracker cache management.",
    clientFallback:
      "Hide GitHub status/CLI/cache controls and send no new settings or cache requests; retain legacy tracker confirmation.",
    serverContract: {
      routes: ["DELETE /api/issues/status"],
      requestFields: ["githubStatusEnabled", "githubCli"],
      routeModules: ["packages/server/src/routes/issue-status.ts"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Experimental issue integration availability is installation-dependent.",
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
  projectCollectionUpdates: {
    id: CAPABILITY_ID_ALLOCATIONS.projectCollectionUpdates.id,
    name: "project-collection-updates",
    kind: "transitional",
    area: "sessions",
    introducedIn: "0.12.0",
    advertisement: { kind: "version-implied" },
    description:
      "Authoritative bounded project and global ProjectQueue query changes over the shared collection stream.",
    clientFallback:
      "Keep existing project/queue REST revalidation and queue deadline backstop; send no project collection stream queries.",
    serverContract: {
      routes: ["GET /api/activity/collections"],
      requestFields: [
        "queries: /projects?summaryMode=retained, /project-queue",
      ],
      responseFields: [
        "groups.projects",
        "groups.items",
        "groups.recoveredSessionQueues",
        "groups.projectStatuses",
      ],
    },
    lifecycle: { kind: "transitional" },
  },
  collectionQueryUpdates: {
    id: CAPABILITY_ID_ALLOCATIONS.collectionQueryUpdates.id,
    name: "collection-query-updates",
    kind: "transitional",
    area: "sessions",
    introducedIn: "0.12.0",
    advertisement: { kind: "version-implied" },
    description:
      "Authoritative bounded session and Inbox query snapshots followed by row and membership changes.",
    clientFallback:
      "Keep existing retained REST reads and event-driven revalidation; send no collection stream request.",
    serverContract: {
      routes: ["GET /api/activity/collections"],
      requestFields: ["queries"],
      responseFields: [
        "query",
        "revision",
        "base",
        "upserts",
        "removed",
        "groups",
        "meta",
      ],
    },
    lifecycle: { kind: "transitional" },
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
  rendezCompose: {
    id: CAPABILITY_ID_ALLOCATIONS.rendezCompose.id,
    name: "rendez-active-compose",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.11.1",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.rendezCompose.id,
    },
    description:
      "Routes active-compose uploads into the server owner's visible new-session draft on POSIX hosts with draft storage.",
    clientFallback:
      "Make no compose claim requests; preserve existing rendez session delivery.",
    serverContract: {
      routes: ["POST /api/rendez/compose"],
      routeModules: ["packages/server/src/routes/rendez-compose.ts"],
      requestFields: ["claimId", "projectId", "acquire"],
      responseFields: ["active"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Draft routing requires an available watcher and draft store.",
    },
  },
  sessionRelationships: {
    id: CAPABILITY_ID_ALLOCATIONS.sessionRelationships.id,
    name: "session-relationships",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.11.1",
    advertisement: { kind: "version-implied" },
    description:
      "Reads durable local session relationships without provider discovery or transcript loading. The provenance page requires operator authority.",
    clientFallback:
      "Omit the new relationship visualization and make no relationship request; ordinary session viewing continues.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/sessions/:sessionId/relationships",
      ],
      routeModules: ["packages/server/src/routes/session-relationships.ts"],
      responseFields: ["relationships", "nextCursor"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Older servers have no durable relationship page route.",
    },
  },
  fileFolderListing: {
    id: CAPABILITY_ID_ALLOCATIONS.fileFolderListing.id,
    name: "file-folder-listing",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.11.1",
    advertisement: { kind: "version-implied" },
    description:
      "Lists the direct children of one folder for the authenticated File Viewer's clickable path segments; host paths outside the project are superuser-only, and public file shares never list.",
    clientFallback:
      "Show the File Viewer path as plain text, with today's file menu on right-click, and make no folder-listing request.",
    serverContract: {
      routes: ["GET /api/projects/:projectId/files/list"],
      requestFields: ["path"],
      responseFields: ["path", "entries", "truncated"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Older servers have no folder-listing route.",
    },
  },
  projectFolderState: {
    id: CAPABILITY_ID_ALLOCATIONS.projectFolderState.id,
    name: "project-folder-state",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.10.3",
    advertisement: { kind: "version-implied" },
    description:
      "Reports whether a path New project would add is missing, an empty folder, a folder with content, or a file, within the paths the principal may add.",
    clientFallback:
      "Show the New project panel without knowing the folder: every starting point and the Git choice, with copy covering both a missing and an existing folder, and make no folder-state request.",
    serverContract: {
      routes: ["GET /api/projects/folder-state"],
      responseFields: ["path", "state"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Older servers cannot report what a typed project path holds.",
    },
  },
  patientTopicShift: {
    id: CAPABILITY_ID_ALLOCATIONS.patientTopicShift.id,
    name: "patient-topic-shift",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.9.4",
    advertisement: { kind: "version-implied" },
    description:
      "Patient queue items carry their source and an optional compact-first threshold; the server compacts before delivery when usage is above it, reports the item's compaction state, and can deliver a failed item without compacting.",
    clientFallback:
      "Hide the Next-topic toolbar setting and action and the compaction thresholds, and send ordinary patient queue items.",
    serverContract: {
      routes: [
        "GET /api/settings",
        "PUT /api/settings",
        "POST /api/sessions/:sessionId/deferred/:tempId/deliver-without-compaction",
      ],
      requestFields: [
        "messageMetadata.patientSource",
        "messageMetadata.compactAboveContextPercent",
        "settings.clientDefaults.patientQueueCompactAtPercent",
        "settings.clientDefaults.topicShiftCompactAtPercent",
        "settings.clientDefaults.sessionToolbarPresence.topicShift",
      ],
      responseFields: [
        "deferredMessages[].compactionGate",
        "settings.clientDefaults.patientQueueCompactAtPercent",
        "settings.clientDefaults.topicShiftCompactAtPercent",
        "settings.clientDefaults.sessionToolbarPresence.topicShift",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Servers through 0.9.2 drop the item's source and threshold, so a hosted client must not offer compact-first delivery there.",
    },
  },
  codexPaginatedRolloutLineage: {
    id: CAPABILITY_ID_ALLOCATIONS.codexPaginatedRolloutLineage.id,
    name: "codex-paginated-rollout-lineage",
    kind: "permanent",
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
      kind: "permanent",
      reason:
        "Hosted clients may reach older servers without reference-backed Codex rollout reads; the client only disables Codex Clone and Fork there.",
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
  sessionForkTurnIntents: {
    id: CAPABILITY_ID_ALLOCATIONS.sessionForkTurnIntents.id,
    name: "session-fork-turn-intents",
    kind: "permanent",
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
      kind: "permanent",
      reason:
        "Hosted clients may reach older servers without server-resolved fork intents; the client only hides Clone and direct Fork there.",
    },
  },
} as const satisfies Record<string, ServerCapabilityDefinition>;
