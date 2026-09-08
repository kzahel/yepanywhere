export type {
  ArtifactViewerConfig,
  ArtifactViewerStatus,
  ArtifactViewerGrant,
} from "./artifact-viewer.js";
export type {
  RetainedSessionCollectionState,
  SessionCatalogUpdatedEvent,
} from "./retained-session-collections.js";

export {
  ACLI_COMMENTARY_MAX_TEXTS,
  ACLI_COMMENTARY_MAX_BODY_BYTES,
  AcliRecordFramer,
  acliCommentaryFormat,
  decodeAcliCommentaryLine,
  decodeAcliRecord,
  declaresAcliCommentary,
  getAcliContext,
  type AcliRecord,
  type AcliCommentaryItem,
} from "./acli-commentary.js";
export {
  AcliStreamDecoder,
  initialAcliFormat,
  acliRecordFragments,
  type AcliDecodedRecord,
  type AcliOutputFragment,
} from "./acli-output.js";
export {
  formatConversationContextTurn,
  type ConversationContextTurn,
  type ConversationContextRequest,
  type ConversationContextReceipt,
} from "./conversation-context.js";

export {
  EFFORT_LEVEL_ORDER,
  getModelEffortLevels,
  nativeModelEffort,
  resolveTurnEffort,
  isTurnEffort,
  type TurnEffort,
} from "./turn-effort.js";

export type {
  ProjectFileCompletionEntry,
  ProjectFileCompletionResult,
} from "./project-file-completion.js";

export {
  isIdeMetadata,
  stripIdeMetadata,
  extractOpenedFilePath,
  parseOpenedFiles,
  getFilename,
} from "./ideMetadata.js";

export {
  AndroidSecurityClientDescriptorSchema,
  CheckInSecurityClientRequestSchema,
  DesktopSecurityClientDescriptorSchema,
  IosSecurityClientDescriptorSchema,
  NATIVE_PUSH_SUBSCRIPTIONS_CAPABILITY,
  PatchSecurityClientRequestSchema,
  PutNativePushSubscriptionRequestSchema,
  RegisterSecurityClientRequestSchema,
  SECURITY_CLIENT_AUDIT_CAPABILITY,
  SECURITY_CLIENT_DESCRIPTOR_VERSION,
  SECURITY_CLIENT_EVENTS_ROUTE,
  SECURITY_CLIENT_KEY_PROTOCOL,
  SECURITY_CLIENT_MAX_BODY_BYTES,
  SECURITY_CLIENT_MAX_OBSERVATIONS,
  SECURITY_CLIENT_PROOF_DOMAIN,
  SECURITY_CLIENT_REGISTER_ROUTE,
  SECURITY_EVENT_ALERT_SUPPRESSION_MS,
  SECURITY_EVENT_ANCHOR_RETENTION_MS,
  SECURITY_EVENT_MAX_ENTRIES,
  SECURITY_EVENT_MAX_FAILURE_ENTRIES,
  SecurityClientAssuranceSchema,
  SecurityClientDescriptorSchema,
  SecurityClientDeviceClassSchema,
  SecurityClientKeyRegistrationSchema,
  SecurityClientKindSchema,
  SecurityClientSupportedProofSchema,
  WebSecurityClientDescriptorSchema,
  buildSecurityClientProofTranscript,
  canonicalizeSecurityClientProofBody,
  p256P1363SignatureToDer,
  securityClientCheckInRoute,
  securityClientCheckInProofBody,
  securityClientRegisterProofBody,
  type CheckInSecurityClientRequest,
  type LegacyWebSecurityClientDescriptor,
  type NativePushVersionInfo,
  type PatchSecurityClientRequest,
  type PutNativePushSubscriptionRequest,
  type RegisterSecurityClientRequest,
  type SecurityClientAssurance,
  type SecurityClientAuditEvent,
  type SecurityClientAuditEventType,
  type SecurityClientAuthenticationMethod,
  type SecurityClientDescriptor,
  type SecurityClientDeviceClass,
  type SecurityClientErrorCode,
  type SecurityClientEventsResponse,
  type SecurityClientKind,
  type SecurityClientProofOperation,
  type SecurityClientProofSummary,
  type SecurityClientProofTranscriptInput,
  type SecurityClientProofType,
  type SecurityClientPublicPushState,
  type SecurityClientResponse,
  type SecurityClientSessionSummary,
  type SecurityClientSupportedProof,
  type SecurityClientsResponse,
  type SecurityClientSummary,
  type SecurityClientTransport,
  type SecurityEvent,
  type SecurityEventClientSnapshot,
  type SecurityEventsResponse,
  type SecurityEventType,
} from "./security-clients.js";

export type { AgentContextHints } from "./agent-context.js";
export {
  buildEffectiveAgentContext,
  LATEX_MATH_RENDERING_CLIENT_CAPABILITY,
} from "./agent-context.js";

export {
  DEFAULT_CLAUDE_STEER_BACKGROUND_BASH,
  MAX_CLAUDE_STEER_BACKGROUND_BASH_REGEX_LENGTH,
  createClaudeSteerBackgroundBashMatcher,
  parseClaudeSteerBackgroundBashSettings,
  type ClaudeSteerBackgroundBashSettings,
} from "./claude-steering.js";

export {
  MAX_CLAUDE_ADDITIONAL_MODELS,
  MAX_CLAUDE_ADDITIONAL_MODEL_ID_LENGTH,
  MAX_CLAUDE_ADDITIONAL_MODEL_LABEL_LENGTH,
  isValidClaudeAdditionalModelId,
  isValidClaudeAdditionalModelLabel,
  parseClaudeAdditionalModelSelections,
  type ClaudeAdditionalModelOrigin,
  type ClaudeAdditionalModelSelection,
} from "./claude-additional-models.js";

export {
  DEFAULT_SNIPPET_CONTEXT_RADIUS,
  MAX_REVIEW_BATCHES,
  MAX_REVIEW_COMMENT_TEXT_LENGTH,
  MAX_REVIEW_COMMENTS,
  MAX_REVIEW_PATH_LENGTH,
  MAX_REVIEW_SNIPPET_LENGTH,
  MAX_REVIEW_SUBMISSION_ID_LENGTH,
  MAX_REVIEW_SUBMISSION_NAME_LENGTH,
  MAX_REVIEW_RESPONSE_FILE_BYTES,
  REVIEW_COMMENTS_FILE_VERSION,
  REVIEW_STORE_FILE_VERSION,
  REVIEW_SUBMISSION_REQUEST_VERSION,
  REVIEW_SUBMISSION_RESPONSE_VERSION,
  anchorFromPatch,
  emptyReviewCommentsFile,
  emptyReviewStoreFile,
  deriveReviewSubmissionName,
  isReviewSubmissionId,
  migrateLegacyReviewCommentsFile,
  parseReviewCommentAnchor,
  parseReviewCommentsFile,
  parseReviewSourceProjection,
  parseReviewStoreFile,
  parseReviewSubmissionRequest,
  parseReviewSubmissionResponse,
  patchLineCount,
  projectLegacyReviewComments,
  type PatchLineLocation,
  type ReviewBatch,
  type ReviewCapture,
  type ReviewCapturedSource,
  type ReviewComment,
  type ReviewCommentAnchor,
  type ReviewCommentRevision,
  type ReviewCommentSide,
  type ReviewCommentStatus,
  type ReviewCommentsFile,
  type ReviewDraft,
  type ReviewEntryRef,
  type ReviewEntryCapturedSource,
  type ReviewInboxItem,
  type ReviewInboxOutcome,
  type ReviewNewSessionOptions,
  type ReviewOutcome,
  type ReviewOutcomeDisposition,
  type ReviewReviewerEntry,
  type ReviewSite,
  type ReviewSiteStateSummary,
  type ReviewSourceChangeStatus,
  type ReviewSourceProjection,
  type ReviewStoreFile,
  type ReviewSubmissionStatus,
  type ReviewSubmissionSummary,
  type ReviewSubmissionDetail,
  type ReviewSubmissionRelocation,
  type ReviewSubmissionRequest,
  type ReviewSubmissionRequestEntry,
  type ReviewSubmissionResponse,
  type ReviewSubmissionResponseOutcome,
} from "./review-comments.js";

export type { HostIdentity } from "./host-identity.js";
export {
  MAX_HOST_IDENTITY_ICON_CODE_UNITS,
  normalizeHostIdentityIcon,
} from "./host-identity.js";
export type {
  HostAgentProcessObservation,
  HostAgentProcessesResponse,
  HostAgentProcessSupervision,
} from "./host-agent-processes.js";

// File path detection (shared between server and client)
export type { DetectedFilePath, TextSegment } from "./filePathDetection.js";
export {
  isLikelyFilePath,
  parseLineColumn,
  detectFilePaths,
  splitTextWithFilePaths,
  transformFilePathsToHtml,
} from "./filePathDetection.js";

export {
  isMarkdownLikeFile,
  isQuartoMarkdownFile,
  MARKDOWN_LIKE_FILE_EXTENSIONS,
} from "./markdown-files.js";

export type {
  LocalResourceAttributes,
  LocalResourceKind,
  LocalResourceMediaType,
  LocalResourceRef,
  ParseLocalResourceOptions,
} from "./local-resource.js";
export {
  normalizeWindowsDrivePathname,
  parseLocalResourceAttributes,
  parseLocalResourceHref,
  parseLocalResourceLink,
} from "./local-resource.js";

export {
  TOOL_RESULT_MEDIA_REJECTION_REASONS,
  type RejectedToolResultMedia,
  type StoredToolResultMedia,
  type ToolResultMedia,
  type ToolResultMediaRejectionReason,
} from "./tool-result-media.js";

export {
  decodeCodeModeOutput,
  type CodeModeOutputPart,
  type DecodedCodeModeOutput,
  type DecodeCodeModeOutputOptions,
} from "./code-mode-output.js";

// ANSI escape rendering (shared between server and client)
export { hasAnsiEscapes, renderAnsiToHtml } from "./ansi-renderer.js";
export {
  looksLikeToon,
  parseToonDocument,
  toonDocumentToMarkdown,
  type ToonTable,
} from "./toon.js";
export {
  jsonlTablesToMarkdown,
  type JsonlTablesResult,
} from "./jsonlTable.js";

export type {
  ClaudeProviderName,
  CodexReasoningSummary,
  ProviderName,
  ProviderInfo,
  ProviderImageSizing,
  ModelInfo,
  RecapMode,
  CacheMissBillingReason,
  CacheMissBillingOutcome,
  CacheMissBillingRecord,
  CacheMissBillingSettings,
  CacheMissBillingUsage,
  ExpectedInputCostState,
  PromptCacheKeepaliveMode,
  PromptCacheKeepaliveProviderInfo,
  PromptCacheKeepaliveProviderSetting,
  PromptCacheKeepaliveSettings,
  PromptSuggestionMode,
  HelperTargetConfig,
  SlashCommand,
  SlashCommandArgumentCompletion,
  SlashCommandInvocation,
  SlashCommandInvocationKind,
  SlashCommandInvocationPrefix,
  SlashCommandInventoryState,
  PermissionMode,
  SessionSandboxLevel,
  SessionSandboxEnforcement,
  SessionSandboxAvailability,
  SessionSandboxAvailabilityState,
  ProviderSessionDefaults,
  NewSessionDefaults,
  BusyComposerDefaultAction,
  ClientDefaults,
  CollapsedComposerButtonPreference,
  GrokSpeechAudioClientDefault,
  SessionToolbarPresenceClientDefaults,
  ToolbarControlPresence,
  ToolbarNarrowingPriority,
  SpeechClientDefaults,
  SpeechSmartTurnClientDefault,
  ModelOption,
  ThinkingMode,
  ThinkingOption,
  ThinkingConfig,
  ThinkingDisplay,
  ShowThinking,
  EffortLevel,
  FileMetadata,
  FileContentResponse,
  PatchHunk,
  EditAugment,
  MarkdownAugment,
  PermissionRules,
} from "./types.js";
export {
  canonicalInvocationName,
  canonicalizeSkillInvocations,
  commandMatchesInvocationQuery,
  findInvocationCandidates,
  findSkillInvocations,
  findUnrecognizedInvocations,
  getCanonicalInvocationNames,
  getCanonicalInvocationToken,
  getInvocationCompletionQuery,
  getInvocationNames,
  getLeadingSlashCommandName,
  hasInvocationCandidate,
  normalizeInvocationName,
  startsWithSlashCommand,
  type InvocationCompletionQuery,
  type InvocationCandidate,
  type SkillInvocationMatch,
} from "./skill-invocations.js";
export {
  detectNestedHarnessLaunch,
  type NestedHarnessLaunch,
  type NestedHarnessName,
} from "./nested-harness-launch.js";
export {
  ALL_PROVIDERS,
  ALL_PERMISSION_MODES,
  CODEX_REASONING_SUMMARIES,
  DEFAULT_CODEX_REASONING_SUMMARY,
  SESSION_SANDBOX_LEVELS,
  isClaudeProviderName,
  isCodexReasoningSummary,
  HELPER_SIDE_MODEL_CHEAPEST,
  HELPER_SIDE_MODEL_SAME_AS_MAIN,
  HELPER_SIDE_MODEL_TARGET_PREFIX,
  DEFAULT_PROMPT_CACHE_KEEPALIVE_INACTIVITY_MINUTES,
  PROMPT_CACHE_KEEPALIVE_MODES,
  PROMPT_SUGGESTION_MODES,
  RECAP_MODES,
  DEFAULT_RECAP_AFTER_SECONDS,
  MAX_RECAP_AFTER_SECONDS,
  MIN_RECAP_AFTER_SECONDS,
  clampRecapAfterSeconds,
  normalizeRecapAfterSeconds,
  thinkingOptionToConfig,
  resolveModel,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_CACHE_MISS_BILLING_FRESH_WINDOW_MINUTES,
  DEFAULT_CACHE_MISS_BILLING_PROVIDER_FRESH_WINDOW_MINUTES,
  DEFAULT_CACHE_MISS_BILLING_MINIMUM_WASTED_TOKENS,
  DEFAULT_CACHE_MISS_BILLING_IGNORE_AFTER_MINUTES,
  DEFAULT_CACHE_MISS_BILLING_RECENT_ACTIVITY_MINUTES,
  DEFAULT_CACHE_MISS_BILLING_SETTINGS,
  DEFAULT_PROJECT_QUEUE_CTRL_ENTER_ENABLED,
  DEFAULT_STEER_NOW_ENABLED,
} from "./types.js";

export type {
  GitBlameLine,
  GitBlameResult,
  GitCommitDetail,
  GitCommitListResult,
  GitCommitSearchManifest,
  GitCommitSearchRecord,
  GitCommitSearchRecordsResult,
  GitFileListResult,
  GitSearchResult,
  GitDiffPreviewSkipped,
  GitDiffPreviewSkippedReason,
  GitDiffResult,
  GitFileEditor,
  GitFileChange,
  GitFileDiffMode,
  GitFileProjectionManifest,
  GitFileRevision,
  GitFileRevisionCommit,
  GitIncomingCommitListResult,
  GitInclusiveRevisionComparison,
  GitWorkingTreeChange,
  GitWorkingTreeFile,
  GitWorkingTreeFileListResult,
  GitWorkingTreePathKind,
  GitWorktreeCoverage,
  GitWorktreeDeltaEvent,
  GitWorktreeDirectory,
  GitWorktreeDirectoryChange,
  GitWorktreeGeneration,
  GitWorktreePathChange,
  GitWorktreePathChangeType,
  GitWorktreeSnapshotEvent,
  GitWorktreeSubscriptionEvent,
  GitIntegrationOptionReason,
  GitIntegrationOptionsResult,
  GitIntegrationOptionsStatus,
  GitPullResult,
  GitPullStatus,
  GitPushResult,
  GitPushStatus,
  GitRecentCommit,
  GitRevisionComparison,
  GitRemoteCheckResult,
  GitRemoteCheckStatus,
  GitStatusInfo,
  GitUntrackedFileListResult,
  GitUntrackedFolderInfo,
  GitUntrackedFolderSummary,
} from "./git-status.js";

export type {
  SafeRestartBlocker,
  SafeRestartBlockerType,
  SafeRestartChangedEvent,
  SafeRestartPreservedWork,
  SafeRestartPreservedWorkType,
  SafeRestartState,
  SafeRestartStatus,
} from "./safe-restart.js";
export {
  GIT_DIRTY_FILE_EDITOR_CAPABILITY,
  GIT_FILE_REVISION_CAPABILITY,
  GIT_INCLUSIVE_TO_HEAD_CAPABILITY,
  GIT_SOURCE_REVIEW_CAPABILITY,
  GIT_SOURCE_REVIEW_PROJECTIONS_CAPABILITY,
  GIT_SOURCE_REVIEW_SUBMISSIONS_CAPABILITY,
  GIT_STATUS_CAPABILITY,
  GIT_STATUS_ENHANCED_CAPABILITY,
  GIT_STATUS_INTEGRATION_OPTIONS_CAPABILITY,
  GIT_STATUS_PULL_CAPABILITY,
  GIT_STATUS_PUSH_CAPABILITY,
  GIT_STATUS_REMOTE_CHECK_CAPABILITY,
} from "./git-status.js";

export type {
  SessionActiveWorkKind,
  SessionLivenessDerivedStatus,
  SessionLivenessProbeStatus,
  SessionLivenessSnapshot,
  SessionProviderRetentionSnapshot,
  SessionWakeReason,
  SessionWakeReasonSnapshot,
} from "./session-liveness.js";

export type {
  UserMessageCompositionMetadata,
  UserMessageDeliveryIntent,
  UserMessageMetadata,
  UserMessageSpeechMetadata,
} from "./user-message-metadata.js";
export {
  DEFAULT_PATIENT_QUEUE_PATIENCE_SECONDS,
  MAX_PATIENT_QUEUE_PATIENCE_SECONDS,
  PATIENT_QUEUE_PREFIX,
  PATIENT_QUEUE_PREFIXES,
  applyPatientQueuePrefix,
  clampPatientPatienceSeconds,
  hasPatientQueuePrefix,
  stripPatientQueuePrefix,
} from "./user-message-metadata.js";

export {
  orderByParentChain,
  needsReorder,
  type DagOrderable,
} from "./dag.js";

export {
  THUMBNAIL_HEIGHT_PX,
  THUMBNAIL_MAX_ASPECT_RATIO,
  THUMBNAIL_MIME_TYPE,
  type ThumbnailPlan,
  planThumbnail,
} from "./attachment-thumbnail.js";

export { DEFAULT_RELAY_URL, normalizeRelayUrl } from "./relay-url.js";

export {
  DEFAULT_YA_CLIENT_BASE_URL,
  buildYaClientPublicShareBaseUrl,
  buildYaClientPublicShareUrl,
  buildYaClientRelayLoginUrl,
  normalizeYaClientBaseUrl,
  normalizeYaClientBaseUrlFromShareViewerUrl,
} from "./ya-client-url.js";

export {
  type UrlProjectId,
  type DirProjectId,
  isUrlProjectId,
  isDirProjectId,
  toUrlProjectId,
  fromUrlProjectId,
  assertUrlProjectId,
  asDirProjectId,
} from "./projectId.js";

export type {
  CreateProjectQueueItemRequest,
  ProjectQueueChangedEvent,
  ProjectQueueClientSource,
  ProjectQueueCreatedFrom,
  ProjectQueueDispatchPauseReason,
  ProjectQueueDispatchState,
  ProjectQueueItem,
  ProjectQueueItemStatus,
  ProjectQueueItemSummary,
  ProjectQueueListResponse,
  ProjectQueueMessage,
  ProjectQueueProjectState,
  ProjectQueueProjectStatus,
  ProjectQueuePromoteNowRequest,
  ProjectQueuePromoteNowResponse,
  ProjectQueuePromoteNowResult,
  ProjectQueueRecoveredSessionQueueSummary,
  ProjectQueueResponse,
  ProjectQueueStagedAttachments,
  ProjectQueueTarget,
  UpdateProjectQueueItemRequest,
} from "./project-queue.js";
export {
  type ProjectQueueReadinessCommand,
  isProjectQueueReadinessCommand,
} from "./project-queue-readiness.js";
export {
  DEFAULT_PROJECT_QUEUE_QUIET_SECONDS,
  MAX_PROJECT_QUEUE_QUIET_SECONDS,
  clampProjectQueueQuietSeconds,
} from "./project-queue.js";
export {
  DEFAULT_HEARTBEAT_TURN_TEXT,
  DEFAULT_HEARTBEAT_TURNS_AFTER_MINUTES,
  MAX_HEARTBEAT_TURN_TEXT_LENGTH,
  MAX_PROJECT_HEARTBEAT_RECENT_TEXTS,
  type ProjectSessionDefaultOverrides,
  type ProjectSessionDefaultsResponse,
  type UpdateProjectSessionDefaultsRequest,
} from "./heartbeat.js";
export {
  MAX_PROJECT_CODE_NAME_LENGTH,
  allocateProjectCodeName,
  normalizeProjectCodeName,
  projectCodeNameKey,
  projectCodeNamePrefixesProjectName,
  type ProjectCodeNameAssignment,
  type ProjectCodeNameChangedEvent,
} from "./project-code-names.js";
export {
  getApplicableSubscriptionUsageWindows,
  getMostUsedSubscriptionUsageWindow,
  type ProviderSubscriptionUsage,
  type ProviderSubscriptionUsageScope,
  type ProviderSubscriptionUsageWindow,
} from "./provider-subscription-usage.js";
export {
  CODEX_PLAN_TOOL_MODES,
  isCodexPlanToolMode,
  type CodexPlanToolMode,
} from "./codex-plan-tool.js";
export {
  APPROVAL_AUDIT_LOG_CAPABILITY,
  ACLI_COMMENTARY_RENDERING_CAPABILITY,
  BANG_COMMANDS_CAPABILITY,
  BROWSER_SETTINGS_BACKUP_CAPABILITY,
  CACHE_MISS_BILLING_EXPECTED_EXPIRY_CAPABILITY,
  CACHE_MISS_BILLING_IGNORE_AFTER_CAPABILITY,
  CLAUDE_ADDITIONAL_MODELS_CAPABILITY,
  CLAUDE_GATEWAY_AUTOSTART_CAPABILITY,
  CODEX_REASONING_SUMMARY_SETTING_CAPABILITY,
  CODEX_PAGINATED_ROLLOUT_LINEAGE_CAPABILITY,
  CODEX_STREAM_DURABLE_ID_ALIGNMENT_CAPABILITY,
  CLAUDE_GATEWAY_CAPABILITY,
  CLAUDE_GATEWAY_DISABLE_AGENT_CAPABILITY,
  CLAUDE_GATEWAY_DISABLE_PLAN_MODE_CAPABILITY,
  CODEX_PLAN_TOOL_SETTING_CAPABILITY,
  DEVICE_BRIDGE_AVAILABLE_CAPABILITY,
  DEVICE_BRIDGE_CAPABILITY,
  DEVICE_BRIDGE_DOWNLOAD_CAPABILITY,
  DEVICE_BRIDGE_UPDATE_CAPABILITY,
  GIT_FILE_DIFF_PROJECTIONS_CAPABILITY,
  GIT_INCOMING_COMMITS_CAPABILITY,
  GIT_LIVE_WORKTREE_SETTING_CAPABILITY,
  GIT_WORKING_TREE_FILES_CAPABILITY,
  PROJECT_FILE_COMPLETION_CAPABILITY,
  SESSION_CONVERSATION_CONTEXT_CAPABILITY,
  SESSION_ASYNC_QUESTIONS_CAPABILITY,
  GIT_WORKING_TREE_SECTIONS_CAPABILITY,
  GIT_WORKING_TREE_COMPLETE_SCAN_CAPABILITY,
  GLOSSARY_TOOLTIPS_CAPABILITY,
  HOST_IDENTITY_CAPABILITY,
  IDLE_REAP_HOURS_SETTING_CAPABILITY,
  HOST_AWAKE_CONTROL_CAPABILITY,
  HOST_AGENT_PROCESS_OBSERVABILITY_CAPABILITY,
  SESSION_SANDBOXING_CAPABILITY,
  SESSION_SANDBOXING_STATUS_CAPABILITY,
  SESSION_SANDBOX_NETWORK_FIREWALL_CAPABILITY,
  SESSION_FORK_TURN_INTENTS_CAPABILITY,
  PROGRESSIVE_SESSION_CATALOG_CAPABILITY,
  RETAINED_SESSION_COLLECTIONS_CAPABILITY,
  PROJECT_QUEUE_CAPABILITY,
  PROJECT_QUEUE_ATTACHMENT_EDITING_CAPABILITY,
  PROJECT_QUEUE_READINESS_CHECK_CAPABILITY,
  ATTACHMENT_ONLY_SESSION_MESSAGES_CAPABILITY,
  PROJECT_QUEUE_NEW_SESSION_SHORTCUT_SETTING_CAPABILITY,
  PROJECT_CODE_NAMES_CAPABILITY,
  PROJECT_SESSION_DEFAULTS_CAPABILITY,
  SIDEBAR_SESSION_RESUME_CAPABILITY,
  SYNTHETIC_ARCHIVE_COMMAND_CAPABILITY,
  SYNTHETIC_DONE_COMMAND_CAPABILITY,
  SYNTHETIC_TERMINATE_COMMAND_CAPABILITY,
  SUBAGENT_MAX_DEPTH_SETTING_CAPABILITY,
  PROJECT_DIRECTORY_STORAGE_POLICY_CAPABILITY,
  PUBLIC_FILE_SHARES_CAPABILITY,
  PUBLIC_SHARE_MANAGEMENT_CAPABILITY,
  PUBLIC_SHARE_MANAGEMENT_FREEZE_CAPABILITY,
  PROVIDER_SUBSCRIPTION_USAGE_CAPABILITY,
  PROVIDER_HOST_CONTROL_CAPABILITY,
  REMOTE_BROWSER_DIAGNOSTICS_CAPABILITY,
  RELOAD_SAFE_CODEX_RUNTIME_CAPABILITY,
  RELOAD_SAFE_CODEX_RUNTIME_SETTINGS_CAPABILITY,
  SERVER_CAPABILITIES,
  OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS,
  TOOL_RESULT_MEDIA_PRESERVATION_POLICY_CAPABILITY,
  VOICE_INPUT_CAPABILITY,
  encodeCompactServerCapabilities,
  encodeOptionalServerCapabilityBits,
  encodeVersionedServerCapabilities,
  hasServerCapabilityAdvertisement,
  negotiateServerCapabilityEncoding,
  serverHasCapability,
  type CompactServerCapabilityAdvertisement,
  type OptionalServerCapabilityBitset,
  type ServerCapabilityAdvertisement,
  type ServerCapabilityDefinition,
  type ServerCapabilityKey,
  type ServerCapabilityKind,
  type ServerCapabilityName,
  type ServerCapabilitySource,
  type VersionedServerCapabilityAdvertisement,
} from "./server-capabilities.js";

export {
  CAPABILITY_ID_ALLOCATIONS,
  CAPABILITY_ID_ENCODING_INTRODUCED_IN,
  CAPABILITY_ID_ENCODING_VERSION,
  capabilityBitIsSet,
  encodeCapabilityIds,
  isCapabilityBitset,
  type CapabilityBitset,
  type CapabilityDirection,
  type CapabilityIdAllocation,
} from "./capability-ids.js";

export {
  DEFAULT_SUBAGENT_MAX_DEPTH,
  MAX_SUBAGENT_MAX_DEPTH,
  MIN_SUBAGENT_MAX_DEPTH,
  isSubagentMaxDepth,
  type SubagentMaxDepth,
} from "./subagent-depth.js";

export {
  DEFAULT_IDLE_REAP_HOURS,
  MAX_IDLE_REAP_HOURS,
  NEVER_IDLE_REAP_HOURS,
  idleReapHoursToMs,
  idleReapMsToHours,
  isIdleReapHours,
  normalizeIdleReapHours,
} from "./idle-reap.js";

export {
  DEFAULT_HOST_AWAKE_BATTERY_FLOOR_PERCENT,
  HOST_AWAKE_MODES,
  MAX_HOST_AWAKE_BATTERY_FLOOR_PERCENT,
  MIN_HOST_AWAKE_BATTERY_FLOOR_PERCENT,
  isHostAwakeBatteryFloorPercent,
  isHostAwakeMode,
  type HostAwakeFeatureSupport,
  type HostAwakeMode,
  type HostAwakePowerSource,
  type HostAwakeState,
  type HostAwakeStatus,
} from "./host-awake.js";

export {
  BROWSER_SETTINGS_BACKUP_VERSION,
  type BrowserSettingsBackup,
  type BrowserSettingsBackupResponse,
  type BrowserSettingsBackupValues,
} from "./browser-settings-backup.js";

export type {
  CreateProjectWorkstreamRequest,
  CreateProjectWorkstreamResponse,
  ProjectWorkstreamsResponse,
  StoredWorkstream,
  Workstream,
  WorkstreamCheckoutPreviewResponse,
  WorkstreamId,
  WorkstreamKind,
  WorkstreamStatus,
  WorkstreamsChangedEvent,
  WorkstreamsChangedReason,
} from "./workstreams.js";
export { isWorkstreamId, mainWorkstreamId } from "./workstreams.js";

export type {
  StagedAttachmentRef,
  UploadedFile,
  UploadStartMessage,
  UploadEndMessage,
  UploadCancelMessage,
  UploadProgressMessage,
  UploadCompleteMessage,
  UploadErrorMessage,
  UploadClientMessage,
  UploadServerMessage,
} from "./upload.js";

// SDK schema types (type-only, no Zod runtime)
export type {
  // Entry types (JSONL line types)
  AssistantEntry,
  UserEntry,
  SystemEntry,
  SummaryEntry,
  FileHistorySnapshotEntry,
  QueueOperationEntry,
  SessionEntry,
  SidechainEntry,
  ClaudeSessionEntry,
  ClaudeSidechainEntry,
  BaseEntry,
  // Message types
  AssistantMessage,
  AssistantMessageContent,
  UserMessage,
  UserMessageContent,
  // Content block types
  TextContent,
  ThinkingContent,
  ToolUseContent,
  ToolResultContent,
  ImageContent,
  DocumentContent,
  // Tool types
  StructuredPatch,
  ToolUseResult,
} from "./claude-sdk-schema/types.js";

// SDK schema guards (type guards for session entries)
export {
  isCompactBoundary,
  getLogicalParentUuid,
  isConversationEntry,
  isInjectedContinuationPrompt,
  isSyntheticNoResponseTurn,
  getMessageContent,
} from "./claude-sdk-schema/guards.js";

// App-specific types (extend SDK types with runtime fields)
export type {
  // Content block
  AppContentBlock,
  // Message extensions
  AppMessageExtensions,
  CodexUserTurnMessageProvenance,
  AppUserMessage,
  AppAssistantMessage,
  AppSystemMessage,
  AppSummaryMessage,
  AppMessage,
  AppConversationMessage,
  // Session types
  PendingInputType,
  AgentActivity,
  ProviderRuntimeRetryReason,
  ProviderRuntimeStatus,
  ContextUsage,
  SessionOwnership,
  SessionSandboxPolicy,
  DurableRecapMessage,
  DurableLocalCommandMessage,
  DurableSyntheticDoneMessage,
  SyntheticSessionBoundaryCommand,
  BangCommandTranscriptDisplayObject,
  ForkSummaryTranscriptDisplayObject,
  TranscriptDisplayObject,
  AppSessionSummary,
  AppSession,
  SessionEffectiveModelSettings,
  SessionMetadataPayload,
  SessionMetadataResponse,
  SessionQueuedMessageKind,
  SessionQueuedMessageStatus,
  SessionQueuedMessageSummary,
  SessionQueuedYaCommand,
  // Agent session types
  AgentStatus,
  AgentSession,
  ProviderChildSessionSummary,
  // Input request types
  UserQuestionAnswer,
  UserQuestionAnswers,
  InputRequest,
  // Recents types
  EnrichedRecentEntry,
  // Connected browser types
  ConnectionInfo,
  ConnectionsResponse,
  // Browser profile types
  BrowserProfileOrigin,
  BrowserProfileInfo,
  BrowserProfilesResponse,
} from "./app-types.js";

export type {
  ToolDisplayAction,
  ToolDisplayListAction,
  ToolDisplayReadAction,
  ToolDisplaySearchAction,
} from "./tool-display-actions.js";
export {
  findProjectPathTokens,
  type ProjectPathLinkTarget,
  type ProjectPathToken,
} from "./project-path-links.js";
export type {
  CodexWebRunLine,
  CodexWebRunPage,
  CodexWebRunResult,
} from "./codex-web-run.js";
export type {
  CodexToolCorrelationMetadata,
  CodexToolCorrelationOrigin,
} from "./codex-tool-correlation.js";
export {
  CODEX_TOOL_CORRELATION_FIELD,
  createCodexToolCorrelation,
  getCodexResponseItemTurnId,
  getCodexToolCorrelation,
} from "./codex-tool-correlation.js";
export {
  isUserMessage,
  isAssistantMessage,
  isSystemMessage,
  isSummaryMessage,
  isConversationMessage,
  isAppMessage,
  isAppSession,
  // Context window utilities
  DEFAULT_CONTEXT_WINDOW,
  CODEX_DEFAULT_CONTEXT_WINDOW,
  CODEX_GPT56_CONTEXT_WINDOW,
  CODEX_GPT6_ASTRA_CONTEXT_WINDOW,
  getModelContextWindow,
} from "./app-types.js";

// Session utilities
export {
  SessionView,
  getSessionDisplayTitle,
  SESSION_TITLE_MAX_LENGTH,
  sanitizeSessionTitle,
  truncateSessionTitle,
} from "./session/index.js";

export type {
  UnifiedSession,
  ClaudeSessionFile,
  CodexSessionContent,
} from "./session/index.js";

export {
  PUBLIC_SHARE_MANAGEMENT_FREEZE_CONFIRMATION,
  PUBLIC_SHARE_SESSION_CHUNKS_CAPABILITY,
  PUBLIC_SHARE_TITLE_MAX_LENGTH,
  PUBLIC_SHARE_INITIAL_PROMPT_MAX_LENGTH,
  PUBLIC_SHARE_LEGACY_RELAY_BODY_MAX_BYTES,
  PUBLIC_SHARE_LEGACY_RELAY_FRAME_MAX_BYTES,
  PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES,
  PUBLIC_SHARE_SESSION_COMPRESSED_MAX_BYTES,
  PUBLIC_SHARE_SESSION_DECOMPRESSED_MAX_BYTES,
  PUBLIC_SHARE_SESSION_MAX_CHUNK_COUNT,
  isPublicShareSessionChunksMetadata,
  isPublicShareSessionTransferSizeWithinLimits,
  isPublicSessionShareMetadata,
  isPublicSessionSharePublicMetadata,
  isPublicSessionShareResponse,
} from "./public-shares.js";

export type {
  CreatePublicFileShareRequest,
  CreatePublicFileShareResponse,
  CreatePublicSessionShareRequest,
  CreatePublicSessionShareResponse,
  FreezePublicSharesResponse,
  FreezePublicSessionLiveSharesResponse,
  PublicFileShareListResponse,
  PublicFileShareManagementItem,
  PublicSessionShareMetadata,
  PublicShareLinkedFileMode,
  PublicShareSessionChunksMetadata,
  PublicShareManagementItem,
  PublicShareManagementListResponse,
  PublicShareStorageState,
  PublicSessionSharePublicMetadata,
  PublicSessionShareMode,
  PublicSessionShareSessionStatusResponse,
  PublicSessionShareViewerActionResponse,
  PublicSessionShareViewerSummary,
  PublicSessionShareResponse,
  RevokePublicSessionSharesResponse,
  RevokeAllPublicSharesResponse,
  RevokePublicShareResponse,
} from "./public-shares.js";

// Tool result schemas (for runtime validation)
export {
  TaskResultSchema,
  BashResultSchema,
  ReadResultSchema,
  EditResultSchema,
  WriteResultSchema,
  GlobResultSchema,
  GrepResultSchema,
  TodoWriteResultSchema,
  WebSearchResultSchema,
  WebFetchResultSchema,
  AskUserQuestionResultSchema,
  BashOutputResultSchema,
  TaskOutputResultSchema,
  KillShellResultSchema,
} from "./claude-sdk-schema/tool/ToolResultSchemas.js";

// Codex session file types (for reading ~/.codex/sessions/).
// Live app-server events are normalized by the Codex provider.
export type {
  // Content types
  CodexTextContent,
  CodexToolUseContent,
  CodexToolResultContent,
  CodexReasoningContent,
  CodexContentBlock,
  CodexMessageContent,
  // Session file entry types
  CodexHistoryPosition,
  CodexSessionMetaPayload,
  CodexSessionMetaEntry,
  CodexMessagePayload,
  CodexReasoningPayload,
  CodexFunctionCallPayload,
  CodexFunctionCallOutputPayload,
  CodexCustomToolCallPayload,
  CodexCustomToolCallOutputPayload,
  CodexWebSearchCallPayload,
  CodexGhostSnapshotPayload,
  CodexResponseItemPayload,
  CodexResponseItemEntry,
  CodexAsyncUserInputQuestion,
  CodexEventMsgPayload,
  CodexTurnAbortedEvent,
  CodexEventMsgEntry,
  CodexCompactedPayload,
  CodexCompactedEntry,
  CodexTurnContextPayload,
  CodexTurnContextEntry,
  CodexResponseTokenUsage,
  CodexTokenUsageRecordEntry,
  CodexSessionEntry,
} from "./codex-schema/types.js";
export {
  normalizeCodexAsyncUserInputQuestions,
  parseCodexSessionEntry,
} from "./codex-schema/session.js";

// Gemini SDK schema types
export type {
  GeminiStats,
  GeminiInitEvent,
  GeminiMessageEvent,
  GeminiToolUseEvent,
  GeminiToolResultEvent,
  GeminiResultEvent,
  GeminiErrorEvent,
  GeminiEvent,
} from "./gemini-schema/types.js";
export { parseGeminiEvent } from "./gemini-schema/events.js";

// Gemini session file types (for reading ~/.gemini/tmp/<hash>/chats/)
export type {
  GeminiFunctionResponse,
  GeminiToolCallResult,
  GeminiToolCall,
  GeminiThought,
  GeminiTokens,
  GeminiUserMessage,
  GeminiAssistantMessage,
  GeminiSessionMessage,
  GeminiSessionFile,
} from "./gemini-schema/session.js";
export {
  getGeminiUserMessageText,
  parseGeminiSessionFile,
} from "./gemini-schema/session.js";

// OpenCode SDK schema types (for opencode serve SSE events and session storage)
export type {
  // SSE event types
  OpenCodeSessionStatus,
  OpenCodeTokens,
  OpenCodeTime,
  OpenCodePart,
  OpenCodeMessageInfo,
  OpenCodeSessionInfo,
  OpenCodeServerConnectedEvent,
  OpenCodeSessionStatusEvent,
  OpenCodeSessionUpdatedEvent,
  OpenCodeSessionIdleEvent,
  OpenCodeSessionDiffEvent,
  OpenCodeMessageUpdatedEvent,
  OpenCodeMessagePartDeltaEvent,
  OpenCodeMessagePartUpdatedEvent,
  OpenCodePermissionRequest,
  OpenCodePermissionAskedEvent,
  OpenCodeQuestionInfo,
  OpenCodeQuestionAskedEvent,
  OpenCodeSSEEvent,
  // Session storage types
  OpenCodeProject,
  OpenCodeSession,
  OpenCodeMessage,
  OpenCodeStoredPart,
  OpenCodeSessionEntry,
  OpenCodeSessionContent,
} from "./opencode-schema/types.js";
export { parseOpenCodeSSEEvent } from "./opencode-schema/events.js";

// Device bridge streaming types (for device bridge remote control)
export type {
  DeviceAction,
  DeviceInfo,
  DeviceState,
  DeviceType,
  DeviceStreamStart,
  DeviceStreamStop,
  DeviceWebRTCAnswer,
  DeviceICECandidate,
  DeviceClientMessage,
  DeviceWebRTCOffer,
  DeviceICECandidateEvent,
  DeviceSessionState,
  DeviceStreamProfileEvent,
  DeviceServerMessage,
  RTCIceCandidateInit,
} from "./devices.js";

// Relay protocol types (for remote access via WebSocket)
export type {
  RelayHttpMethod,
  RelayRequest,
  RelayResponse,
  RelaySubscriptionChannel,
  RelaySubscribe,
  RelayUnsubscribe,
  RelayEvent,
  RelayUploadStart,
  RelayStagedUploadStart,
  RelayUploadChunk,
  RelayUploadEnd,
  RelayUploadProgress,
  RelayUploadComplete,
  RelayUploadError,
  RelaySpeechControl,
  RelaySpeechEvent,
  RemoteClientMessage,
  YepMessage,
  RelayMessage,
  // Connection metadata types
  OriginMetadata,
  // SRP authentication types (re-exported from relay.ts)
  SrpClientHello,
  SrpServerChallenge,
  SrpClientProof,
  SrpServerVerify,
  SrpError,
  SrpErrorCode,
  SrpClientMessage,
  SrpServerMessage,
  SrpMessage,
  // Session resumption types
  SrpSessionResumeInit,
  SrpSessionResumeChallenge,
  SrpSessionResume,
  SrpSessionResumed,
  SrpSessionInvalid,
  SrpSessionInvalidReason,
  // Encryption types
  EncryptedEnvelope,
  SequencedEncryptedPayload,
  // Connection state
  SecureConnectionState,
  // Client capabilities (Phase 3)
  ClientCapabilities,
  // Keepalive ping/pong
  ClientPing,
  ServerPong,
} from "./relay.js";

export {
  // SRP type guards
  isSrpClientHello,
  isSrpClientProof,
  isSrpServerChallenge,
  isSrpServerVerify,
  isSrpError,
  // Session resumption type guards
  isSrpSessionResumeInit,
  isSrpSessionResumeChallenge,
  isSrpSessionResume,
  isSrpSessionResumed,
  isSrpSessionInvalid,
  // Encryption type guard
  isEncryptedEnvelope,
  isSequencedEncryptedPayload,
  // Client capabilities type guard
  isClientCapabilities,
} from "./relay.js";

// Binary framing utilities (Phase 0/1/2/3 of binary WebSocket protocol)
export {
  // Phase 0: Unencrypted binary frames
  BinaryFormat,
  type BinaryFormatValue,
  BinaryFrameError,
  encodeJsonBytesFrame,
  encodeJsonFrame,
  decodeBinaryFrame,
  decodeJsonFrame,
  isBinaryData,
  // Phase 1: Binary encrypted envelope
  BinaryEnvelopeVersion,
  type BinaryEnvelopeVersionValue,
  BinaryEnvelopeError,
  type BinaryEnvelopeComponents,
  NONCE_LENGTH,
  VERSION_LENGTH,
  MIN_BINARY_ENVELOPE_LENGTH,
  parseBinaryEnvelope,
  createBinaryEnvelope,
  prependFormatByte,
  extractFormatAndPayload,
  // Phase 2: Binary upload chunks
  UUID_BYTE_LENGTH,
  OFFSET_BYTE_LENGTH,
  UPLOAD_CHUNK_HEADER_SIZE,
  UploadChunkError,
  type UploadChunkData,
  uuidToBytes,
  bytesToUuid,
  offsetToBytes,
  bytesToOffset,
  encodeUploadChunkFrame,
  decodeUploadChunkFrame,
  encodeUploadChunkPayload,
  decodeUploadChunkPayload,
  // Phase 3: Compressed JSON
  encodeCompressedJsonFrame,
  decodeCompressedJsonFrame,
  // Phase 4: Bounded transport chunks
  TRANSPORT_CHUNK_HEADER_SIZE,
  TRANSPORT_CHUNK_PAYLOAD_MAX_BYTES,
  TRANSPORT_REASSEMBLY_MAX_BYTES,
  TransportChunkError,
  type TransportChunkData,
  encodeTransportChunkFrame,
  decodeTransportChunkFrame,
  encodeTransportChunkFrames,
  TransportChunkReassembler,
} from "./binary-framing.js";

// Compression utilities (Phase 3)
export {
  COMPRESSION_THRESHOLD,
  isCompressionSupported,
  shouldCompress,
  isGzipCompressed,
  compressString,
  compressBytes,
  decompressToString,
  decompressBytes,
  compressJsonIfBeneficial,
} from "./compression.js";

// Relay server routing protocol (for relay server <-> yepanywhere/phone)
export type {
  RelayChannel,
  RelayNonDefaultChannel,
  RelayServerCompatibilityMetadata,
  RelayServerRegister,
  RelayServerChannelRegister,
  RelayServerRegistered,
  RelayServerRejectedReason,
  RelayServerRejected,
  RelayClientConnect,
  RelayClientChannelConnect,
  RelayClientConnected,
  RelayClientErrorReason,
  RelayClientError,
  RelayServerMessage,
  RelayServerResponse,
  RelayClientMessage,
  RelayClientResponse,
  RelayRoutingMessage,
} from "./relay-protocol.js";

export {
  DEFAULT_RELAY_CHANNEL,
  SPEECH_RELAY_CHANNEL,
  isRelayServerRegister,
  isRelayServerChannelRegister,
  isRelayServerRegistered,
  isRelayServerRejected,
  isRelayClientConnect,
  isRelayClientChannelConnect,
  isRelayClientConnected,
  isRelayClientError,
  USERNAME_REGEX,
  isValidRelayUsername,
} from "./relay-protocol.js";

export type {
  RelayMuxReady,
  RelayMuxOpen,
  RelayMuxOpened,
  RelayMuxErrorReason,
  RelayMuxError,
  RelayMuxClose,
  RelayMuxClosedReason,
  RelayMuxClosed,
  RelayMuxClientControl,
  RelayMuxServerControl,
  RelayMuxDataFrame,
} from "./relay-mux.js";

export {
  RELAY_CLIENT_MUX_V1_CAPABILITY,
  RELAY_MUX_PROTOCOL_VERSION,
  RELAY_MUX_HEADER_BYTES,
  RELAY_MUX_BINARY_FLAG,
  RelayMuxFrameError,
  isRelayMuxCircuitId,
  isRelayMuxReady,
  isRelayMuxOpen,
  isRelayMuxOpened,
  isRelayMuxError,
  isRelayMuxClose,
  isRelayMuxClosed,
  encodeRelayMuxDataFrame,
  decodeRelayMuxDataFrame,
} from "./relay-mux.js";

export * from "./glossary/index.js";

export type { SqliteStatus } from "./sqlite-status.js";
