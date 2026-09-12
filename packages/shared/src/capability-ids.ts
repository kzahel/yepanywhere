export const CAPABILITY_ID_ENCODING_VERSION = 1;
export const CAPABILITY_ID_ENCODING_INTRODUCED_IN = "0.7.1";

export type CapabilityDirection = "client" | "server";

export interface CapabilityIdAllocation {
  id: number;
  direction: CapabilityDirection;
  name: string;
  introducedIn: string;
}

/**
 * Permanent capability identity ledger.
 *
 * IDs are global across both directions, append-only, and never reused. The
 * first six entries preserve the optional server-bit assignments shipped
 * before the general 0.7.1 ID contract.
 */
export const CAPABILITY_ID_ALLOCATIONS = {
  voiceInput: {
    id: 0,
    direction: "server",
    name: "voiceInput",
    introducedIn: "0.6.0",
  },
  deviceBridgeAvailable: {
    id: 1,
    direction: "server",
    name: "deviceBridge-available",
    introducedIn: "0.6.0",
  },
  deviceBridge: {
    id: 2,
    direction: "server",
    name: "deviceBridge",
    introducedIn: "0.6.0",
  },
  deviceBridgeDownload: {
    id: 3,
    direction: "server",
    name: "deviceBridge-download",
    introducedIn: "0.6.0",
  },
  deviceBridgeUpdate: {
    id: 4,
    direction: "server",
    name: "deviceBridge-update",
    introducedIn: "0.6.0",
  },
  browserSettingsBackup: {
    id: 5,
    direction: "server",
    name: "browser-settings-backup",
    introducedIn: "0.6.3",
  },
  securityClientAudit: {
    id: 6,
    direction: "server",
    name: "security-client-audit-v1",
    introducedIn: "0.7.1",
  },
  reloadSafeCodexRuntime: {
    id: 7,
    direction: "server",
    name: "reload-safe-codex-runtime",
    introducedIn: "0.7.1",
  },
  sessionSandboxing: {
    id: 8,
    direction: "server",
    name: "session-sandboxing",
    introducedIn: "0.7.1",
  },
  publicShareManagement: {
    id: 9,
    direction: "server",
    name: "public-share-management",
    introducedIn: "0.7.1",
  },
  glossaryTooltips: {
    id: 10,
    direction: "server",
    name: "glossary-tooltips",
    introducedIn: "0.7.1",
  },
  progressiveSessionCatalog: {
    id: 11,
    direction: "server",
    name: "progressive-session-catalog",
    introducedIn: "0.7.1",
  },
  projectDirectoryStoragePolicy: {
    id: 12,
    direction: "server",
    name: "project-directory-storage-policy",
    introducedIn: "0.7.1",
  },
  idleReapHoursSetting: {
    id: 13,
    direction: "server",
    name: "idle-reap-hours-setting",
    introducedIn: "0.7.1",
  },
  toolResultMediaPreservationPolicy: {
    id: 14,
    direction: "server",
    name: "tool-result-media-preservation-policy",
    introducedIn: "0.7.1",
  },
  gitDirtyFileEditor: {
    id: 15,
    direction: "server",
    name: "git-dirty-file-editor",
    introducedIn: "0.7.1",
  },
  gitSourceReview: {
    id: 16,
    direction: "server",
    name: "git-source-review",
    introducedIn: "0.7.1",
  },
  gitSourceReviewSubmissions: {
    id: 17,
    direction: "server",
    name: "git-source-review-submissions",
    introducedIn: "0.7.1",
  },
  gitSourceReviewProjections: {
    id: 18,
    direction: "server",
    name: "git-source-review-projections",
    introducedIn: "0.7.1",
  },
  claudeGateway: {
    id: 19,
    direction: "server",
    name: "claude-gateway",
    introducedIn: "0.7.1",
  },
  claudeGatewayAutostart: {
    id: 20,
    direction: "server",
    name: "claude-gateway-autostart",
    introducedIn: "0.7.1",
  },
  claudeGatewayDisableAgent: {
    id: 21,
    direction: "server",
    name: "claude-gateway-disable-agent",
    introducedIn: "0.7.1",
  },
  providerSubscriptionUsage: {
    id: 22,
    direction: "server",
    name: "provider-subscription-usage",
    introducedIn: "0.7.1",
  },
  reloadSafeCodexRuntimeSettings: {
    id: 23,
    direction: "server",
    name: "reload-safe-codex-runtime-settings",
    introducedIn: "0.7.1",
  },
  hostAgentProcessObservability: {
    id: 24,
    direction: "server",
    name: "host-agent-process-observability",
    introducedIn: "0.7.1",
  },
  sessionSandboxingStatus: {
    id: 25,
    direction: "server",
    name: "session-sandboxing-status",
    introducedIn: "0.7.1",
  },
  projectSessionDefaults: {
    id: 26,
    direction: "server",
    name: "project-session-defaults",
    introducedIn: "0.7.1",
  },
  sidebarSessionResume: {
    id: 27,
    direction: "server",
    name: "sidebar-session-resume",
    introducedIn: "0.7.1",
  },
  sessionForkTurnIntents: {
    id: 28,
    direction: "server",
    name: "session-fork-turn-intents",
    introducedIn: "0.7.1",
  },
  gitFileDiffProjections: {
    id: 29,
    direction: "server",
    name: "git-file-diff-projections",
    introducedIn: "0.7.1",
  },
  providerHostControl: {
    id: 30,
    direction: "server",
    name: "provider-host-control",
    introducedIn: "0.7.1",
  },
  remoteBrowserDiagnostics: {
    id: 31,
    direction: "server",
    name: "remote-browser-diagnostics-v1",
    introducedIn: "0.7.1",
  },
  publicShareManagementFreeze: {
    id: 32,
    direction: "server",
    name: "public-share-management-freeze",
    introducedIn: "0.7.1",
  },
  syntheticDoneCommand: {
    id: 33,
    direction: "server",
    name: "synthetic-done-command",
    introducedIn: "0.7.1",
  },
  subagentMaxDepthSetting: {
    id: 34,
    direction: "server",
    name: "subagent-max-depth-setting",
    introducedIn: "0.7.1",
  },
  codexReasoningSummarySetting: {
    id: 35,
    direction: "server",
    name: "codex-reasoning-summary-setting",
    introducedIn: "0.7.1",
  },
  claudeGatewayDisablePlanMode: {
    id: 36,
    direction: "server",
    name: "claude-gateway-disable-plan-mode",
    introducedIn: "0.7.1",
  },
  syntheticArchiveCommand: {
    id: 37,
    direction: "server",
    name: "synthetic-archive-command",
    introducedIn: "0.7.1",
  },
  gitWorkingTreeFiles: {
    id: 38,
    direction: "server",
    name: "git-working-tree-files",
    introducedIn: "0.7.1",
  },
  gitIncomingCommits: {
    id: 39,
    direction: "server",
    name: "git-incoming-commits",
    introducedIn: "0.7.1",
  },
  gitInclusiveToHead: {
    id: 40,
    direction: "server",
    name: "git-inclusive-to-head",
    introducedIn: "0.7.1",
  },
  gitWorkingTreeSections: {
    id: 41,
    direction: "server",
    name: "git-working-tree-sections",
    introducedIn: "0.7.2",
  },
  gitWorkingTreeCompleteScan: {
    id: 42,
    direction: "server",
    name: "git-working-tree-complete-scan",
    introducedIn: "0.7.2",
  },
  cacheMissBillingIgnoreAfter: {
    id: 43,
    direction: "server",
    name: "cache-miss-billing-ignore-after",
    introducedIn: "0.7.2",
  },
  gitLiveWorktreeSetting: {
    id: 44,
    direction: "server",
    name: "git-live-worktree-setting",
    introducedIn: "0.7.2",
  },
  syntheticTerminateCommand: {
    id: 45,
    direction: "server",
    name: "synthetic-terminate-command",
    introducedIn: "0.7.2",
  },
  projectCodeNames: {
    id: 46,
    direction: "server",
    name: "project-code-names",
    introducedIn: "0.7.2",
  },
  gitFileRevision: {
    id: 47,
    direction: "server",
    name: "git-file-revision",
    introducedIn: "0.7.2",
  },
  codexStreamDurableIdAlignment: {
    id: 48,
    direction: "server",
    name: "codex-stream-durable-id-alignment",
    introducedIn: "0.7.2",
  },
  cacheMissBillingExpectedExpiry: {
    id: 49,
    direction: "server",
    name: "cache-miss-billing-expected-expiry",
    introducedIn: "0.7.2",
  },
  attachmentOnlySessionMessages: {
    id: 50,
    direction: "server",
    name: "attachment-only-session-messages",
    introducedIn: "0.7.2",
  },
  publicFileShares: {
    id: 51,
    direction: "server",
    name: "public-file-shares",
    introducedIn: "0.7.2",
  },
  sessionSandboxNetworkFirewall: {
    id: 52,
    direction: "server",
    name: "session-sandbox-network-firewall",
    introducedIn: "0.7.2",
  },
  codexPlanToolSetting: {
    id: 53,
    direction: "server",
    name: "codex-plan-tool-setting",
    introducedIn: "0.8.1",
  },
  codexPaginatedRolloutLineage: {
    id: 54,
    direction: "server",
    name: "codex-paginated-rollout-lineage",
    introducedIn: "0.8.1",
  },
  projectQueueAttachmentEditing: {
    id: 55,
    direction: "server",
    name: "project-queue-attachment-editing",
    introducedIn: "0.8.1",
  },
  projectFileCompletion: {
    id: 56,
    direction: "server",
    name: "project-file-completion",
    introducedIn: "0.8.2",
  },
  sessionConversationContext: {
    id: 57,
    direction: "server",
    name: "session-conversation-context",
    introducedIn: "0.8.2",
  },
  turnEffortModifiers: {
    id: 58,
    direction: "server",
    name: "turn-effort-modifiers",
    introducedIn: "0.8.2",
  },
  artifactViewer: {
    id: 59,
    direction: "server",
    name: "artifact-viewer",
    introducedIn: "0.8.2",
  },
  sessionAsyncQuestions: {
    id: 60,
    direction: "server",
    name: "session-async-questions",
    introducedIn: "0.8.2",
  },
  projectQueueReadinessCheck: {
    id: 61,
    direction: "server",
    name: "project-queue-readiness-check",
    introducedIn: "0.8.2",
  },
  acliCommentaryRendering: {
    id: 62,
    direction: "server",
    name: "acli-commentary-rendering",
    introducedIn: "0.8.2",
  },
  retainedSessionCollections: {
    id: 63,
    direction: "server",
    name: "retained-session-collections",
    introducedIn: "0.8.2",
  },
  localSpeechModelSelection: {
    id: 64,
    direction: "server",
    name: "local-speech-model-selection",
    introducedIn: "0.8.2",
  },
  speechVocabulary: {
    id: 65,
    direction: "server",
    name: "speech-vocabulary",
    introducedIn: "0.8.2",
  },
  speechVocabularySessionTerms: {
    id: 66,
    direction: "server",
    name: "speech-vocabulary-session-terms",
    introducedIn: "0.8.2",
  },
  experimentalConversation: {
    id: 69,
    direction: "server",
    name: "experimental-simple-client-conversation",
    introducedIn: "0.8.2",
  },
  issueSessionAssociations: {
    id: 68,
    direction: "server",
    name: "issue-session-associations-v1",
    introducedIn: "0.8.2",
  },
  computerControl: {
    id: 70,
    direction: "server",
    name: "optional-computer-control",
    introducedIn: "0.8.2",
  },
  codexCyberAccessProgramSetting: {
    id: 67,
    direction: "server",
    name: "codex-cyber-access-program-setting",
    introducedIn: "0.8.2",
  },
} as const satisfies Record<string, CapabilityIdAllocation>;

export type CapabilityBitset = readonly (readonly [
  wordIndex: number,
  bits: number,
])[];

export function encodeCapabilityIds(ids: Iterable<number>): CapabilityBitset {
  const words = new Map<number, number>();
  for (const id of ids) {
    if (!Number.isInteger(id) || id < 0) {
      throw new Error(`Invalid capability ID: ${id}`);
    }
    const wordIndex = Math.floor(id / 32);
    const mask = 2 ** (id % 32);
    const current = words.get(wordIndex) ?? 0;
    if (Math.floor(current / mask) % 2 === 0) {
      words.set(wordIndex, current + mask);
    }
  }
  return [...words.entries()].sort(([left], [right]) => left - right);
}

export function capabilityBitIsSet(
  bitset: CapabilityBitset | undefined,
  id: number,
): boolean {
  const wordIndex = Math.floor(id / 32);
  const mask = 2 ** (id % 32);
  for (const [candidateWordIndex, bits] of bitset ?? []) {
    if (
      candidateWordIndex === wordIndex &&
      Number.isSafeInteger(bits) &&
      bits >= 0 &&
      bits <= 0xffff_ffff
    ) {
      return Math.floor(bits / mask) % 2 === 1;
    }
  }
  return false;
}

export function isCapabilityBitset(value: unknown): value is CapabilityBitset {
  return (
    Array.isArray(value) &&
    value.every(
      (word) =>
        Array.isArray(word) &&
        word.length === 2 &&
        Number.isSafeInteger(word[0]) &&
        word[0] >= 0 &&
        Number.isSafeInteger(word[1]) &&
        word[1] >= 0 &&
        word[1] <= 0xffff_ffff,
    )
  );
}
