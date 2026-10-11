/**
 * Type-only exports for Codex schema.
 * Import from here to avoid pulling in Zod runtime.
 */

// Content types (used by session files)
export type {
  CodexTextContent,
  CodexToolUseContent,
  CodexToolResultContent,
  CodexReasoningContent,
  CodexContentBlock,
  CodexMessageContent,
} from "./content.js";

// Session file types (persisted format in ~/.codex/sessions/)
export type {
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
  CodexConfigurationUpdatePayload,
  CodexAdditionalToolsPayload,
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
} from "./session.js";
