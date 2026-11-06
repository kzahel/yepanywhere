import {
  CAPABILITY_ID_ENCODING_INTRODUCED_IN,
  CAPABILITY_ID_ENCODING_VERSION,
  type CapabilityBitset,
  capabilityBitIsSet,
  encodeCapabilityIds,
} from "./capability-ids.js";
import { DEVICE_BRIDGE_SERVER_CAPABILITIES } from "./server-capabilities-device-bridge.js";
import { GIT_STATUS_SERVER_CAPABILITIES } from "./server-capabilities-git-status.js";
import { LOCAL_ACCESS_SERVER_CAPABILITIES } from "./server-capabilities-local-access.js";
import { PROJECT_QUEUE_SERVER_CAPABILITIES } from "./server-capabilities-project-queue.js";
import { PROVIDERS_SERVER_CAPABILITIES } from "./server-capabilities-providers.js";
import { REMOTE_ACCESS_SERVER_CAPABILITIES } from "./server-capabilities-remote-access.js";
import { RENDERING_SERVER_CAPABILITIES } from "./server-capabilities-rendering.js";
import { SECURITY_SERVER_CAPABILITIES } from "./server-capabilities-security.js";
import { SESSIONS_SERVER_CAPABILITIES } from "./server-capabilities-sessions.js";
import { SETTINGS_SERVER_CAPABILITIES } from "./server-capabilities-settings.js";
import { SPEECH_SERVER_CAPABILITIES } from "./server-capabilities-speech.js";
import type { ServerCapabilityDefinition } from "./server-capability-definition.js";

export interface VersionedServerCapabilityAdvertisement {
  capabilityEncoding: typeof CAPABILITY_ID_ENCODING_VERSION;
  capabilityBits: CapabilityBitset;
  deniedCapabilityBits?: CapabilityBitset;
}

export interface ServerCapabilitySource {
  current?: string;
  capabilities?: readonly string[];
  capabilityEncoding?: number;
  capabilityBits?: CapabilityBitset;
  deniedCapabilityBits?: CapabilityBitset;
}

export const SERVER_CAPABILITIES = {
  ...DEVICE_BRIDGE_SERVER_CAPABILITIES,
  ...GIT_STATUS_SERVER_CAPABILITIES,
  ...LOCAL_ACCESS_SERVER_CAPABILITIES,
  ...PROJECT_QUEUE_SERVER_CAPABILITIES,
  ...PROVIDERS_SERVER_CAPABILITIES,
  ...REMOTE_ACCESS_SERVER_CAPABILITIES,
  ...RENDERING_SERVER_CAPABILITIES,
  ...SECURITY_SERVER_CAPABILITIES,
  ...SESSIONS_SERVER_CAPABILITIES,
  ...SETTINGS_SERVER_CAPABILITIES,
  ...SPEECH_SERVER_CAPABILITIES,
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
export const PATIENT_TOPIC_SHIFT_CAPABILITY =
  SERVER_CAPABILITIES.patientTopicShift.name;
export const RENDEZ_UPLOADS_CAPABILITY = SERVER_CAPABILITIES.rendezUploads.name;
export const RENDEZ_PROJECT_STATUS_CAPABILITY =
  SERVER_CAPABILITIES.rendezProjectStatus.name;
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
  if (source?.capabilities?.includes(name)) {
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
    return capabilityBitIsSet(
      source?.capabilityBits,
      definition.advertisement.index,
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
    source?.deniedCapabilityBits !== undefined
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

/** Keep the provider-specific acceptance gates explicit at every entry point. */
export function getSessionTextCreationCapability(
  provider: string | null | undefined,
) {
  if (provider === "claude") return SERVER_CAPABILITIES.claudeTextCreation;
  if (provider === "codex") return SERVER_CAPABILITIES.codexTextCreation;
  if (provider === "pi") return SERVER_CAPABILITIES.piTextCreation;
  if (provider === "opencode") return SERVER_CAPABILITIES.opencodeTextCreation;
  return undefined;
}
