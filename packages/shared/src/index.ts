export {
  isIdeMetadata,
  stripIdeMetadata,
  extractOpenedFilePath,
  parseOpenedFiles,
  getFilename,
} from "./ideMetadata.js";

// File path detection (shared between server and client)
export type { DetectedFilePath, TextSegment } from "./filePathDetection.js";
export {
  isLikelyFilePath,
  parseLineColumn,
  detectFilePaths,
  splitTextWithFilePaths,
  transformFilePathsToHtml,
} from "./filePathDetection.js";

export type {
  ProviderName,
  ProviderInfo,
  ModelInfo,
  PermissionMode,
  SessionStatus,
  ModelOption,
  ThinkingOption,
  FileMetadata,
  FileContentResponse,
  PatchHunk,
  EditAugment,
  MarkdownAugment,
} from "./types.js";
export {
  ALL_PROVIDERS,
  thinkingOptionToTokens,
  resolveModel,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
} from "./types.js";

export {
  orderByParentChain,
  needsReorder,
  type DagOrderable,
} from "./dag.js";

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
  getMessageContent,
} from "./claude-sdk-schema/guards.js";

// App-specific types (extend SDK types with runtime fields)
export type {
  // Content block
  AppContentBlock,
  // Message extensions
  AppMessageExtensions,
  AppUserMessage,
  AppAssistantMessage,
  AppSystemMessage,
  AppSummaryMessage,
  AppMessage,
  AppConversationMessage,
  // Session types
  PendingInputType,
  ProcessStateType,
  ContextUsage,
  AppSessionStatus,
  AppSessionSummary,
  AppSession,
  // Agent session types
  AgentStatus,
  AgentSession,
  // Input request types
  InputRequest,
  // Recents types
  EnrichedRecentEntry,
} from "./app-types.js";
export {
  isUserMessage,
  isAssistantMessage,
  isSystemMessage,
  isSummaryMessage,
  isConversationMessage,
} from "./app-types.js";

// Session utilities
export {
  SessionView,
  getSessionDisplayTitle,
  SESSION_TITLE_MAX_LENGTH,
} from "./session/index.js";

export type {
  UnifiedSession,
  ClaudeSessionFile,
  CodexSessionContent,
} from "./session/index.js";

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

// Codex session file types (for reading ~/.codex/sessions/)
// Note: Streaming events are handled by @openai/codex-sdk directly
export type {
  // Content types
  CodexTextContent,
  CodexToolUseContent,
  CodexToolResultContent,
  CodexReasoningContent,
  CodexContentBlock,
  CodexMessageContent,
  // Session file entry types
  CodexSessionMetaPayload,
  CodexSessionMetaEntry,
  CodexMessagePayload,
  CodexReasoningPayload,
  CodexFunctionCallPayload,
  CodexFunctionCallOutputPayload,
  CodexGhostSnapshotPayload,
  CodexResponseItemPayload,
  CodexResponseItemEntry,
  CodexEventMsgPayload,
  CodexEventMsgEntry,
  CodexTurnContextPayload,
  CodexTurnContextEntry,
  CodexSessionEntry,
} from "./codex-schema/types.js";
export { parseCodexSessionEntry } from "./codex-schema/session.js";

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
export { parseGeminiSessionFile } from "./gemini-schema/session.js";

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
  OpenCodeMessagePartUpdatedEvent,
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
