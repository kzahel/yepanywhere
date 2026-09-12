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
