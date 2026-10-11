/**
 * Session file schemas for Codex CLI.
 *
 * Codex persists sessions to ~/.codex/sessions/ as JSONL files.
 * Each line is a JSON object with timestamp, type, and payload.
 *
 * This is DIFFERENT from the streaming output format (events.ts).
 * Session files use a wrapper format with explicit payload nesting.
 *
 * Event types in session files:
 * - session_meta: Session initialization metadata
 * - response_item: Message content (user, assistant, reasoning, function calls)
 * - event_msg: Event notifications (user_message, agent_message, token_count, etc.)
 * - turn_context: Per-turn context (cwd, approval policy, model, etc.)
 * - token_usage_record: Per-response, turn, and thread token usage
 */

import { z } from "zod";

// =============================================================================
// Session Metadata
// =============================================================================

const CodexPersistedEntryIdentityShape = {
  ordinal: z.number().int().nonnegative().optional(),
};

export const CodexThreadHistoryModeSchema = z.enum(["legacy", "paginated"]);

export const CodexHistoryPositionSchema = z.object({
  thread_id: z.string(),
  end_ordinal_exclusive: z.number().int().nonnegative(),
  end_byte_offset: z.number().int().nonnegative(),
});

export type CodexHistoryPosition = z.infer<typeof CodexHistoryPositionSchema>;

/**
 * Session metadata payload - first entry in session file.
 */
export const CodexSessionSourceSchema = z.union([
  z.string(),
  z
    .object({
      subagent: z
        .object({
          thread_spawn: z
            .object({
              parent_thread_id: z.string().optional(),
              depth: z.number().optional(),
              agent_path: z.string().nullable().optional(),
              agent_nickname: z.string().nullable().optional(),
              agent_role: z.string().nullable().optional(),
            })
            .passthrough()
            .optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough(),
]);

export const CodexSessionMetaPayloadSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  cwd: z.string(),
  forked_from_id: z.string().optional(),
  forked_from_ordinal_exclusive: z.number().int().nonnegative().optional(),
  history_mode: CodexThreadHistoryModeSchema.optional(),
  history_base: CodexHistoryPositionSchema.optional(),
  session_id: z.string().optional(),
  parent_thread_id: z.string().optional(),
  originator: z.string().optional(), // e.g. "codex_exec"
  cli_version: z.string().optional(),
  instructions: z.string().optional(),
  source: CodexSessionSourceSchema.optional(), // e.g. "exec"
  thread_source: z.string().optional(),
  agent_nickname: z.string().optional(),
  agent_role: z.string().optional(),
  agent_path: z.string().optional(),
  multi_agent_version: z.string().optional(),
  model_provider: z.string().optional(), // e.g. "openai"
});

export type CodexSessionMetaPayload = z.infer<
  typeof CodexSessionMetaPayloadSchema
>;

export const CodexSessionMetaEntrySchema = z.object({
  ...CodexPersistedEntryIdentityShape,
  timestamp: z.string(),
  type: z.literal("session_meta"),
  payload: CodexSessionMetaPayloadSchema,
});

export type CodexSessionMetaEntry = z.infer<typeof CodexSessionMetaEntrySchema>;

// =============================================================================
// Response Item - Messages and Content
// =============================================================================

/**
 * Input text content block in user messages.
 */
export const CodexInputTextContentSchema = z.object({
  type: z.literal("input_text"),
  text: z.string(),
});

/**
 * Output text content block in assistant messages.
 */
export const CodexOutputTextContentSchema = z.object({
  type: z.literal("output_text"),
  text: z.string(),
});

/**
 * Input image content block in user/developer messages.
 * Persisted shape can vary, so we keep this permissive.
 */
export const CodexInputImageContentSchema = z
  .object({
    type: z.literal("input_image"),
    image_url: z.string().optional(),
    file_path: z.string().optional(),
    mime_type: z.string().optional(),
  })
  .passthrough();

const CodexResponseItemIdentityShape = {
  id: z.string().optional(),
  internal_chat_message_metadata_passthrough: z
    .object({ turn_id: z.string().optional() })
    .passthrough()
    .optional(),
};

/**
 * User or assistant message payload.
 */
export const CodexMessagePayloadSchema = z.object({
  ...CodexResponseItemIdentityShape,
  type: z.literal("message"),
  role: z.enum(["user", "assistant", "developer"]),
  content: z.array(
    z.union([
      CodexInputTextContentSchema,
      CodexOutputTextContentSchema,
      CodexInputImageContentSchema,
    ]),
  ),
});

export type CodexMessagePayload = z.infer<typeof CodexMessagePayloadSchema>;

/**
 * Reasoning summary block.
 */
export const CodexSummaryTextSchema = z.object({
  type: z.literal("summary_text"),
  text: z.string(),
});

/**
 * Reasoning payload (chain-of-thought, may be encrypted).
 */
export const CodexReasoningPayloadSchema = z.object({
  ...CodexResponseItemIdentityShape,
  type: z.literal("reasoning"),
  summary: z.array(CodexSummaryTextSchema).optional(),
  content: z.unknown().nullable().optional(), // Raw content if available
  encrypted_content: z.string().optional(), // Encrypted reasoning
});

export type CodexReasoningPayload = z.infer<typeof CodexReasoningPayloadSchema>;

export const CodexAgentMessagePayloadSchema = z
  .object({
    type: z.literal("agent_message"),
    author: z.string().optional(),
    recipient: z.string().optional(),
    content: z.unknown().optional(),
  })
  .passthrough();

export type CodexAgentMessagePayload = z.infer<
  typeof CodexAgentMessagePayloadSchema
>;

/**
 * Function call payload.
 */
export const CodexFunctionCallPayloadSchema = z.object({
  ...CodexResponseItemIdentityShape,
  type: z.literal("function_call"),
  name: z.string(),
  arguments: z.string(), // JSON string
  call_id: z.string(),
});

export type CodexFunctionCallPayload = z.infer<
  typeof CodexFunctionCallPayloadSchema
>;

/**
 * Audio content block a tool call can return.
 */
export const CodexInputAudioContentSchema = z
  .object({
    type: z.literal("input_audio"),
    audio_url: z.string().optional(),
  })
  .passthrough();

/**
 * Opaque encrypted content block a tool call can return.
 */
export const CodexEncryptedContentSchema = z
  .object({
    type: z.literal("encrypted_content"),
    encrypted_content: z.string().optional(),
  })
  .passthrough();

/**
 * Content items a tool call can return. Codex 0.151 always converts an MCP
 * result into these items, so a plain-text result now persists as a single
 * `input_text` item rather than a serialized JSON string, and the audio and
 * encrypted variants reach durable transcripts too.
 */
export const CodexFunctionCallOutputContentItemSchema = z.union([
  CodexInputTextContentSchema,
  CodexInputImageContentSchema,
  CodexInputAudioContentSchema,
  CodexEncryptedContentSchema,
]);

export type CodexFunctionCallOutputContentItem = z.infer<
  typeof CodexFunctionCallOutputContentItemSchema
>;

/**
 * Function call output payload.
 */
export const CodexFunctionCallOutputPayloadSchema = z.object({
  ...CodexResponseItemIdentityShape,
  type: z.literal("function_call_output"),
  call_id: z.string().optional(),
  name: z.string().optional(),
  namespace: z.string().optional(),
  output: z.union([
    z.string(),
    z.array(CodexFunctionCallOutputContentItemSchema),
  ]),
});

export type CodexFunctionCallOutputPayload = z.infer<
  typeof CodexFunctionCallOutputPayloadSchema
>;

/**
 * Custom tool call payload (Codex-specific persisted format).
 */
export const CodexCustomToolCallPayloadSchema = z
  .object({
    type: z.literal("custom_tool_call"),
    call_id: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    arguments: z.string().optional(),
    input: z.unknown().optional(),
  })
  .passthrough();

export type CodexCustomToolCallPayload = z.infer<
  typeof CodexCustomToolCallPayloadSchema
>;

/**
 * Custom tool call output payload (Codex-specific persisted format).
 */
export const CodexCustomToolCallOutputPayloadSchema = z
  .object({
    type: z.literal("custom_tool_call_output"),
    call_id: z.string().optional(),
    output: z.unknown().optional(),
  })
  .passthrough();

export type CodexCustomToolCallOutputPayload = z.infer<
  typeof CodexCustomToolCallOutputPayloadSchema
>;

/** Code-mode tool discovery request persisted by newer Codex builds. */
export const CodexToolSearchCallPayloadSchema = z
  .object({
    type: z.literal("tool_search_call"),
    call_id: z.string().nullable().optional(),
    status: z.string().optional(),
    execution: z.string().optional(),
    arguments: z.unknown().optional(),
  })
  .passthrough();

/** Code-mode tool discovery result persisted by newer Codex builds. */
export const CodexToolSearchOutputPayloadSchema = z
  .object({
    type: z.literal("tool_search_output"),
    call_id: z.string().nullable().optional(),
    status: z.string().optional(),
    execution: z.string().optional(),
    tools: z.array(z.unknown()).optional(),
  })
  .passthrough();

/**
 * Web search call payload.
 */
export const CodexWebSearchCallPayloadSchema = z
  .object({
    type: z.literal("web_search_call"),
    call_id: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    query: z.string().optional(),
    arguments: z.string().optional(),
    input: z.unknown().optional(),
    action: z.unknown().optional(),
  })
  .passthrough();

export type CodexWebSearchCallPayload = z.infer<
  typeof CodexWebSearchCallPayloadSchema
>;

/**
 * Durable reasoning-effort control Codex 0.154 records in thread history when
 * the effort changes mid-thread. It carries no user-visible content, so YA
 * parses it as a known type and renders nothing for it.
 */
export const CodexConfigurationUpdatePayloadSchema = z
  .object({
    type: z.literal("configuration_update"),
    reasoning: z
      .object({ effort: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type CodexConfigurationUpdatePayload = z.infer<
  typeof CodexConfigurationUpdatePayloadSchema
>;

/**
 * Tool declarations Codex 0.162 adds to model context mid-thread. Like
 * `configuration_update`, it carries no user-visible content, so YA parses it
 * as a known type and renders nothing for it.
 */
export const CodexAdditionalToolsPayloadSchema = z
  .object({
    type: z.literal("additional_tools"),
    id: z.string().optional(),
    role: z.string(),
    tools: z.array(z.unknown()),
  })
  .passthrough();

export type CodexAdditionalToolsPayload = z.infer<
  typeof CodexAdditionalToolsPayloadSchema
>;

/**
 * Ghost commit snapshot for git state tracking.
 */
export const CodexGhostSnapshotPayloadSchema = z.object({
  type: z.literal("ghost_snapshot"),
  ghost_commit: z.object({
    id: z.string(),
    parent: z.string(),
    preexisting_untracked_files: z.array(z.string()).optional(),
    preexisting_untracked_dirs: z.array(z.string()).optional(),
  }),
});

export type CodexGhostSnapshotPayload = z.infer<
  typeof CodexGhostSnapshotPayloadSchema
>;

/**
 * Union of all response item payload types.
 */
export const CodexResponseItemPayloadSchema = z.discriminatedUnion("type", [
  CodexMessagePayloadSchema,
  CodexAgentMessagePayloadSchema,
  CodexReasoningPayloadSchema,
  CodexFunctionCallPayloadSchema,
  CodexFunctionCallOutputPayloadSchema,
  CodexCustomToolCallPayloadSchema,
  CodexCustomToolCallOutputPayloadSchema,
  CodexToolSearchCallPayloadSchema,
  CodexToolSearchOutputPayloadSchema,
  CodexWebSearchCallPayloadSchema,
  CodexConfigurationUpdatePayloadSchema,
  CodexAdditionalToolsPayloadSchema,
  CodexGhostSnapshotPayloadSchema,
]);

export type CodexResponseItemPayload = z.infer<
  typeof CodexResponseItemPayloadSchema
>;

export const CodexResponseItemEntrySchema = z.object({
  ...CodexPersistedEntryIdentityShape,
  timestamp: z.string(),
  type: z.literal("response_item"),
  payload: CodexResponseItemPayloadSchema,
});

export type CodexResponseItemEntry = z.infer<
  typeof CodexResponseItemEntrySchema
>;

// =============================================================================
// Event Messages
// =============================================================================

/**
 * Rate limit info.
 */
export const CodexRateLimitsSchema = z.object({
  primary: z
    .object({
      used_percent: z.number(),
      window_minutes: z.number(),
      resets_at: z.number(),
    })
    .nullable()
    .optional(),
  secondary: z
    .object({
      used_percent: z.number(),
      window_minutes: z.number(),
      resets_at: z.number(),
    })
    .nullable()
    .optional(),
  credits: z
    .object({
      has_credits: z.boolean(),
      unlimited: z.boolean(),
      balance: z.unknown().nullable(),
    })
    .nullable()
    .optional(),
  plan_type: z.string().nullable().optional(),
});

/**
 * Token usage info.
 */
export const CodexTokenUsageInfoSchema = z.object({
  total_token_usage: z
    .object({
      input_tokens: z.number(),
      cached_input_tokens: z.number().optional(),
      cache_write_input_tokens: z.number().optional(),
      output_tokens: z.number(),
      reasoning_output_tokens: z.number().optional(),
      total_tokens: z.number(),
    })
    .optional(),
  last_token_usage: z
    .object({
      input_tokens: z.number(),
      cached_input_tokens: z.number().optional(),
      cache_write_input_tokens: z.number().optional(),
      output_tokens: z.number(),
      reasoning_output_tokens: z.number().optional(),
      total_tokens: z.number(),
    })
    .optional(),
  model_context_window: z.number().optional(),
});

/**
 * User message event.
 */
export const CodexUserMessageEventSchema = z.object({
  type: z.literal("user_message"),
  message: z.string(),
  client_id: z.string().nullable().optional(),
  images: z.array(z.unknown()).optional(),
});

/**
 * Agent message event.
 */
export const CodexAsyncUserInputQuestionSchema = z
  .object({
    title: z.string(),
    options: z.array(z.string()).nullable(),
  })
  .passthrough();

export type CodexAsyncUserInputQuestion = z.infer<
  typeof CodexAsyncUserInputQuestionSchema
>;

/** Validate and clone the shared live/durable async-question shape. */
export function normalizeCodexAsyncUserInputQuestions(
  value: unknown,
): CodexAsyncUserInputQuestion[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const questions: CodexAsyncUserInputQuestion[] = [];
  for (const question of value) {
    if (!question || typeof question !== "object") return undefined;
    const record = question as Record<string, unknown>;
    if (typeof record.title !== "string") return undefined;
    if (
      record.options !== null &&
      (!Array.isArray(record.options) ||
        record.options.some((option) => typeof option !== "string"))
    ) {
      return undefined;
    }
    questions.push({
      ...record,
      title: record.title,
      options:
        record.options === null ? null : (record.options as string[]).slice(),
    });
  }
  return questions;
}

export const CodexAgentMessageEventSchema = z
  .object({
    type: z.literal("agent_message"),
    message: z.string(),
    phase: z.string().nullable().optional(),
    memory_citation: z.unknown().nullable().optional(),
    delivery: z.string().optional(),
    questions: z.array(CodexAsyncUserInputQuestionSchema).optional(),
  })
  .passthrough();

/**
 * Agent reasoning event (summary of thinking).
 */
export const CodexAgentReasoningEventSchema = z.object({
  type: z.literal("agent_reasoning"),
  text: z.string(),
});

/**
 * Token count event.
 */
export const CodexTokenCountEventSchema = z.object({
  type: z.literal("token_count"),
  info: CodexTokenUsageInfoSchema.nullable(),
  rate_limits: CodexRateLimitsSchema.nullable().optional(),
});

/**
 * Context compacted event.
 */
export const CodexContextCompactedEventSchema = z.object({
  type: z.literal("context_compacted"),
});

/**
 * Generic item completion event.
 */
export const CodexItemCompletedEventSchema = z
  .object({
    type: z.literal("item_completed"),
    thread_id: z.string().optional(),
    turn_id: z.string().optional(),
    item: z.unknown().optional(),
  })
  .passthrough();

const CodexPersistedErrorEventSchema = z
  .object({
    message: z.string(),
    codex_error_info: z.unknown().optional(),
  })
  .passthrough();

/**
 * Turn aborted event.
 */
export const CodexTurnAbortedEventSchema = z
  .object({
    type: z.literal("turn_aborted"),
    reason: z.string().optional(),
    message: z.string().optional(),
    error: CodexPersistedErrorEventSchema.optional(),
  })
  .passthrough();

export type CodexTurnAbortedEvent = z.infer<typeof CodexTurnAbortedEventSchema>;

/**
 * Task started event - emitted at the beginning of an agent turn.
 */
export const CodexTaskStartedEventSchema = z.object({
  type: z.literal("task_started"),
  turn_id: z.string(),
  model_context_window: z.number(),
  collaboration_mode_kind: z.string(),
});

/**
 * Task complete event - emitted when an agent turn finishes.
 */
export const CodexTaskCompleteEventSchema = z
  .object({
    type: z.literal("task_complete"),
    turn_id: z.string(),
    last_agent_message: z.string().nullable(),
    error: CodexPersistedErrorEventSchema.optional(),
  })
  .passthrough();

/** Completed apply_patch event, including provider-native structured changes. */
export const CodexPatchApplyEndEventSchema = z
  .object({
    type: z.literal("patch_apply_end"),
    call_id: z.string(),
    turn_id: z.string().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    success: z.boolean(),
    changes: z.record(z.string(), z.unknown()).optional(),
    status: z.string().optional(),
  })
  .passthrough();

/** Snapshot notification emitted after Codex thread settings change. */
export const CodexThreadSettingsAppliedEventSchema = z
  .object({
    type: z.literal("thread_settings_applied"),
    thread_settings: z.unknown(),
  })
  .passthrough();

// Persisted operational events are retained for schema fidelity even when YA
// does not currently turn them into transcript rows.
const CodexExecCommandEndEventSchema = z
  .object({ type: z.literal("exec_command_end"), call_id: z.string() })
  .passthrough();
const CodexWebSearchEndEventSchema = z
  .object({ type: z.literal("web_search_end") })
  .passthrough();
const CodexThreadGoalUpdatedEventSchema = z
  .object({ type: z.literal("thread_goal_updated") })
  .passthrough();
const CodexMcpToolCallEndEventSchema = z
  .object({ type: z.literal("mcp_tool_call_end") })
  .passthrough();
const CodexThreadNameUpdatedEventSchema = z
  .object({ type: z.literal("thread_name_updated") })
  .passthrough();
const CodexThreadRolledBackEventSchema = z
  .object({ type: z.literal("thread_rolled_back"), num_turns: z.number() })
  .passthrough();
const CodexErrorEventSchema = z
  .object({ type: z.literal("error") })
  .passthrough();
const CodexViewImageToolCallEventSchema = z
  .object({ type: z.literal("view_image_tool_call") })
  .passthrough();
const CodexSubAgentActivityEventSchema = z
  .object({
    type: z.literal("sub_agent_activity"),
    event_id: z.string(),
    occurred_at_ms: z.number().optional(),
    agent_thread_id: z.string(),
    agent_path: z.string(),
    kind: z.enum(["started", "interacted", "interrupted"]),
  })
  .passthrough();

/**
 * Union of event message types.
 */
export const CodexEventMsgPayloadSchema = z.discriminatedUnion("type", [
  CodexUserMessageEventSchema,
  CodexAgentMessageEventSchema,
  CodexAgentReasoningEventSchema,
  CodexTokenCountEventSchema,
  CodexContextCompactedEventSchema,
  CodexItemCompletedEventSchema,
  CodexTurnAbortedEventSchema,
  CodexTaskStartedEventSchema,
  CodexTaskCompleteEventSchema,
  CodexPatchApplyEndEventSchema,
  CodexThreadSettingsAppliedEventSchema,
  CodexExecCommandEndEventSchema,
  CodexWebSearchEndEventSchema,
  CodexThreadGoalUpdatedEventSchema,
  CodexMcpToolCallEndEventSchema,
  CodexThreadNameUpdatedEventSchema,
  CodexThreadRolledBackEventSchema,
  CodexErrorEventSchema,
  CodexViewImageToolCallEventSchema,
  CodexSubAgentActivityEventSchema,
]);

export type CodexEventMsgPayload = z.infer<typeof CodexEventMsgPayloadSchema>;

export const CodexEventMsgEntrySchema = z.object({
  ...CodexPersistedEntryIdentityShape,
  timestamp: z.string(),
  type: z.literal("event_msg"),
  payload: CodexEventMsgPayloadSchema,
});

export type CodexEventMsgEntry = z.infer<typeof CodexEventMsgEntrySchema>;

// =============================================================================
// Response Token Usage
// =============================================================================

/** Token counts persisted for one response and their cumulative rollups. */
export const CodexResponseTokenUsageSchema = z
  .object({
    input_tokens: z.number(),
    cached_input_tokens: z.number(),
    cache_write_input_tokens: z.number(),
    output_tokens: z.number(),
    reasoning_output_tokens: z.number(),
    total_tokens: z.number(),
  })
  .passthrough();

export type CodexResponseTokenUsage = z.infer<
  typeof CodexResponseTokenUsageSchema
>;

export const CodexTokenUsageRecordEntrySchema = z
  .object({
    ...CodexPersistedEntryIdentityShape,
    timestamp: z.string(),
    type: z.literal("token_usage_record"),
    payload: z
      .object({
        thread_id: z.string(),
        turn_id: z.string(),
        session_id: z.string(),
        root_turn_id: z.string(),
        response_id: z.string(),
        usage: CodexResponseTokenUsageSchema,
        turn_token_usage: CodexResponseTokenUsageSchema,
        thread_token_usage: CodexResponseTokenUsageSchema,
      })
      .passthrough(),
  })
  .passthrough();

export type CodexTokenUsageRecordEntry = z.infer<
  typeof CodexTokenUsageRecordEntrySchema
>;

// =============================================================================
// Compaction Entries
// =============================================================================

/**
 * Compaction payload for persisted replacement history snapshots.
 */
export const CodexCompactedPayloadSchema = z
  .object({
    message: z.string().optional(),
    replacement_history: z.array(z.unknown()).optional(),
  })
  .passthrough();

export type CodexCompactedPayload = z.infer<typeof CodexCompactedPayloadSchema>;

export const CodexCompactedEntrySchema = z.object({
  ...CodexPersistedEntryIdentityShape,
  timestamp: z.string(),
  type: z.literal("compacted"),
  payload: CodexCompactedPayloadSchema,
});

export type CodexCompactedEntry = z.infer<typeof CodexCompactedEntrySchema>;

// =============================================================================
// Turn Context
// =============================================================================

/**
 * Sandbox policy configuration.
 */
export const CodexSandboxPolicySchema = z.object({
  type: z.string(),
  network_access: z.boolean().optional(),
  exclude_tmpdir_env_var: z.boolean().optional(),
  exclude_slash_tmp: z.boolean().optional(),
});

/**
 * Turn context payload - sent at the start/end of turns.
 */
export const CodexTurnContextPayloadSchema = z
  .object({
    cwd: z.string(),
    approval_policy: z.string(),
    sandbox_policy: CodexSandboxPolicySchema.optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    summary: z.string().optional(),
    turn_id: z.string().optional(),
    root_turn_id: z.string().optional(),
  })
  .passthrough();

export type CodexTurnContextPayload = z.infer<
  typeof CodexTurnContextPayloadSchema
>;

export const CodexTurnContextEntrySchema = z.object({
  ...CodexPersistedEntryIdentityShape,
  timestamp: z.string(),
  type: z.literal("turn_context"),
  payload: CodexTurnContextPayloadSchema,
});

export type CodexTurnContextEntry = z.infer<typeof CodexTurnContextEntrySchema>;

/** Codex Desktop workspace snapshot; retained but not rendered as conversation. */
export const CodexWorldStateEntrySchema = z
  .object({
    ...CodexPersistedEntryIdentityShape,
    timestamp: z.string(),
    type: z.literal("world_state"),
    payload: z
      .object({
        full: z.boolean().optional(),
        state: z.unknown(),
      })
      .passthrough(),
  })
  .passthrough();

/** Local delivery metadata for provider-internal agent communication. */
export const CodexInterAgentCommunicationMetadataEntrySchema = z
  .object({
    ...CodexPersistedEntryIdentityShape,
    timestamp: z.string(),
    type: z.literal("inter_agent_communication_metadata"),
    payload: z.object({ trigger_turn: z.boolean() }).passthrough(),
  })
  .passthrough();

// =============================================================================
// Session Entry Union
// =============================================================================

/**
 * Union of all session file entry types.
 * Use this for parsing individual JSONL lines from ~/.codex/sessions/.
 */
export const CodexSessionEntrySchema = z.discriminatedUnion("type", [
  CodexSessionMetaEntrySchema,
  CodexResponseItemEntrySchema,
  CodexEventMsgEntrySchema,
  CodexCompactedEntrySchema,
  CodexTurnContextEntrySchema,
  CodexWorldStateEntrySchema,
  CodexInterAgentCommunicationMetadataEntrySchema,
  CodexTokenUsageRecordEntrySchema,
]);

export type CodexSessionEntry = z.infer<typeof CodexSessionEntrySchema>;

/**
 * Parse a JSONL line from a Codex session file.
 * Returns null if parsing fails.
 */
export function parseCodexSessionEntry(line: string): CodexSessionEntry | null {
  try {
    const json = JSON.parse(line);
    const result = CodexSessionEntrySchema.safeParse(json);
    if (result.success) {
      return result.data;
    }
    // Return raw JSON for forward compatibility with unknown types
    if (json && typeof json === "object" && "type" in json) {
      return json as CodexSessionEntry;
    }
    return null;
  } catch {
    return null;
  }
}
