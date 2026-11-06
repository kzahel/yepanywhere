import { CAPABILITY_ID_ALLOCATIONS } from "./capability-ids.js";
import { OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS } from "./server-capability-optional-bits.js";
import type { ServerCapabilityDefinition } from "./server-capability-definition.js";

export const LOCAL_ACCESS_SERVER_CAPABILITIES = {
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
  agentApiManagement: {
    id: CAPABILITY_ID_ALLOCATIONS.agentApiManagement.id,
    name: "agent-api-management",
    kind: "permanent",
    area: "localAccess",
    introducedIn: "0.11.1",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.agentApiManagement.id,
    },
    description:
      "Separate default-off native v0 session-command enablement, durable retry receipts and trusted creation provenance for qualified operator launches. Existing read leases remain read-only.",
    clientFallback:
      "Hide the session-command setting and send no agentApiManagementEnabled. Keep read-only discovery independent.",
    serverContract: {
      routes: [
        "GET /api/settings",
        "PUT /api/settings",
        "POST /v0/servers/:serverId/sessions",
        "GET /v0/servers/:serverId/receipts/:receiptId",
        "GET /v0/servers/:serverId/sessions/:sessionId/relationships",
      ],
      requestFields: ["agentApiManagementEnabled"],
      responseFields: ["settings.agentApiManagementEnabled"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older API adapters and provider hosts cannot issue or enforce management grants.",
    },
  },
  agentApiBootstrap: {
    id: CAPABILITY_ID_ALLOCATIONS.agentApiBootstrap.id,
    name: "agent-api-bootstrap",
    kind: "permanent",
    area: "localAccess",
    introducedIn: "0.11.1",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.agentApiBootstrap.id,
    },
    description:
      "Opt-in read-only v0 connection and launch identity advertised to eligible local unrestricted Claude/Codex sessions over Unix HTTP or Windows loopback.",
    clientFallback:
      "Hide the agent API discovery setting and do not send agentApiEnabled; retain existing operator token behavior.",
    serverContract: {
      routes: [
        "GET /api/settings",
        "PATCH /api/settings",
        "GET /v0/help",
        "GET /v0/me",
        "GET /v0/schema",
      ],
      requestFields: ["agentApiEnabled"],
      responseFields: ["settings.agentApiEnabled"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "The local adapter and trusted launch propagation must exist before advertising this connection.",
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
  approvalAuditLog: {
    name: "approvalAuditLog",
    kind: "permanent",
    area: "localAccess",
    introducedIn: "0.6.0",
    advertisement: { kind: "version-implied" },
    description:
      "Server supports configuring approval audit-log persistence from Local Access settings.",
    clientFallback:
      "Approval logging is editable on the current v0.8.0 client baseline; no legacy read-only branch remains.",
    serverContract: {
      routes: ["GET /api/settings", "PATCH /api/settings"],
      responseFields: ["settings.approvalAuditLogEnabled"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "The fixed contract remains advertised for older clients; current clients use the supported v0.8.0 baseline.",
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
    clientFallback:
      "Explicit bang execution is baseline; only the opt-in history view remains hidden by default.",
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
        "The fixed contract remains advertised for older clients; current clients use the supported v0.8.0 baseline.",
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
} as const satisfies Record<string, ServerCapabilityDefinition>;
