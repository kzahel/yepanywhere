import { CAPABILITY_ID_ALLOCATIONS } from "./capability-ids.js";
import { OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS } from "./server-capability-optional-bits.js";
import type { ServerCapabilityDefinition } from "./server-capability-definition.js";

export const PROVIDERS_SERVER_CAPABILITIES = {
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
      "Current clients assume this v0.8.0 baseline contract; older servers should update or use their bundled client. User preferences and runtime availability still apply.",
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
      "Current clients require aligned Codex transcript IDs from the v0.8.0 server baseline; older servers require an update.",
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
        "The identity remains advertised for older clients; current clients use aligned IDs unconditionally.",
    },
  },
  claudeAdditionalModels: {
    name: "claude-additional-models",
    kind: "permanent",
    area: "providers",
    introducedIn: "0.6.3",
    advertisement: { kind: "version-implied" },
    description:
      "Server persists opt-in previous/custom Claude model ids and exposes the maintained optional catalog.",
    clientFallback:
      "Additional Claude models are available on the current v0.8.0 client baseline without a separate fixed gate.",
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
      kind: "permanent",
      reason:
        "The fixed contract remains advertised for older clients; current clients use the supported v0.8.0 baseline.",
    },
  },
  claudeGateway: {
    id: CAPABILITY_ID_ALLOCATIONS.claudeGateway.id,
    name: "claude-gateway",
    kind: "permanent",
    area: "providers",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server can persist a Claude LLM-gateway URL and expose its models as an isolated Claude Gateway provider.",
    clientFallback:
      "Current clients assume this v0.8.0 baseline contract; older servers should update or use their bundled client. User preferences and runtime availability still apply.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings", "GET /api/providers"],
      requestFields: ["settings.claudeGatewayUrl"],
      responseFields: ["settings.claudeGatewayUrl", "providers[].name"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients may reach older servers without the Claude Gateway settings/provider contract; the client only hides Gateway configuration there.",
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
    },
  },
  claudeGatewayAutostart: {
    id: CAPABILITY_ID_ALLOCATIONS.claudeGatewayAutostart.id,
    name: "claude-gateway-autostart",
    kind: "permanent",
    area: "providers",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server can persist and run an explicit shell command when a configured loopback Claude Gateway has no TCP listener.",
    clientFallback:
      "Current clients assume this v0.8.0 baseline contract; older servers should update or use their bundled client. User preferences and runtime availability still apply.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings", "GET /api/providers"],
      requestFields: ["settings.claudeGatewayStartCommand"],
      responseFields: ["settings.claudeGatewayStartCommand"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients may reach older servers without the Gateway autostart setting; the client only hides the start-command field there.",
    },
  },
  claudeGatewayDisableAgent: {
    id: CAPABILITY_ID_ALLOCATIONS.claudeGatewayDisableAgent.id,
    name: "claude-gateway-disable-agent",
    kind: "permanent",
    area: "providers",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server can persist whether Claude Gateway launches deny Claude Code's Agent tool.",
    clientFallback:
      "Current clients assume this v0.8.0 baseline contract; older servers should update or use their bundled client. User preferences and runtime availability still apply.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings"],
      requestFields: ["settings.claudeGatewayDisableAgent"],
      responseFields: ["settings.claudeGatewayDisableAgent"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients may reach older servers without the Gateway Agent-tool setting; the client only hides the setting there.",
    },
  },
  claudeGatewayDisablePlanMode: {
    id: CAPABILITY_ID_ALLOCATIONS.claudeGatewayDisablePlanMode.id,
    name: "claude-gateway-disable-plan-mode",
    kind: "permanent",
    area: "providers",
    introducedIn: "0.7.1",
    advertisement: { kind: "version-implied" },
    description:
      "Server can persist whether Claude Gateway launches remove Claude Code's plan-mode tools from model context.",
    clientFallback:
      "Current clients assume this v0.8.0 baseline contract; older servers should update or use their bundled client. User preferences and runtime availability still apply.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings"],
      requestFields: ["settings.claudeGatewayDisablePlanMode"],
      responseFields: ["settings.claudeGatewayDisablePlanMode"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients may reach older servers without the Gateway plan-mode setting; the client only hides the setting there.",
    },
  },
  providerSubscriptionUsage: {
    id: CAPABILITY_ID_ALLOCATIONS.providerSubscriptionUsage.id,
    name: "provider-subscription-usage",
    kind: "permanent",
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
      kind: "permanent",
      reason:
        "Hosted clients may reach older servers without the subscription-usage route; the client only hides usage badges and detail there.",
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
} as const satisfies Record<string, ServerCapabilityDefinition>;
