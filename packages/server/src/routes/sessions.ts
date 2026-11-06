import type { NestedHarnessRelationshipService } from "../sessions/NestedHarnessRelationshipService.js";
import type { ProviderChildRelationshipService } from "../sessions/ProviderChildRelationshipService.js";
import { creationStatusForSession } from "../sessions/session-creation-view.js";
import { sessionCreationReceipt } from "../sessions/session-creation-acceptance.js";
import { readLimitedJsonObject } from "./limited-json-body.js";
import { desktopControlOrigin } from "../desktop/machine-control.js";
import { RETIRED_COMPUTER_CONTROL_ERROR } from "../machine-control/legacy-retirement.js";
import {
  ALL_PERMISSION_MODES,
  type PermissionRules,
  type PromptSuggestionMode,
  type ProviderName,
  type SessionSandboxLevel,
  type ThinkingOption,
  type TranscriptDisplayObject,
  type UploadedFile,
  type UserQuestionAnswers,
  type UrlProjectId,
  agentHarness,
  isThinkingOption,
  isUrlProjectId,
  isYaSessionId,
  truncateSessionTitle,
  readQueuedYaCommand,
  type SessionRewindReason,
  type SessionRewindRecord,
  type UpdateClearloopRequest,
} from "@yep-anywhere/shared";
import { isRealUserTurn } from "@yep-anywhere/shared/transcript/messageProjection";
import { randomUUID } from "node:crypto";
import {
  ClearloopConflictError,
  type ClearloopService,
} from "../services/ClearloopService.js";
import { turnIndexOf } from "../sessions/turn-index.js";
import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { type Context, Hono } from "hono";
import type { ISessionIndexService } from "../indexes/types.js";
import { getLogger } from "../logging/logger.js";
import type { ToolResultMediaStore } from "../media/ToolResultMediaStore.js";
import type { SessionMetadataService } from "../metadata/index.js";
import type { ProjectMetadataService } from "../metadata/index.js";
import type { ForkOrdinalClaim } from "../metadata/SessionMetadataService.js";
import type { NotificationService } from "../notifications/index.js";
import type { CodexSessionScanner } from "../projects/codex-scanner.js";
import type { GeminiSessionScanner } from "../projects/gemini-scanner.js";
import {
  DETACHED_PROJECT_PATH,
  limitedDetachedProjectPath,
} from "../projects/paths.js";
import type { ProjectScanner } from "../projects/scanner.js";
import { createSessionProjectRouting } from "./session-project-routing.js";
import { createSessionCreationRequests } from "./session-creation-requests.js";
import {
  type CreateSessionBody,
  type StartSessionBody,
  hasSessionMessageContent,
  parseOptionalJsonObjectBody,
  permissionModeError,
} from "./session-launch-request.js";
import {
  isQueueFullResponse,
  isQueuedResponse,
} from "./session-launch-results.js";
import { createSessionLaunchSettings } from "./session-launch-settings.js";
import {
  inheritedSandboxSettings,
  parseSessionSandboxLevel,
  persistedSandboxNetworkFirewall,
} from "./session-sandbox-settings.js";
import { parseSlashCommandSubmission } from "../sdk/slashCommandEmulation.js";
import { dispatchProviderCommand } from "../supervisor/provider-command.js";
import { tryRestartCompact } from "../supervisor/restart-compaction.js";
import type { PermissionMode, SDKMessage, UserMessage } from "../sdk/types.js";
import { appendApprovalAuditLog } from "../security/approvalAuditLog.js";
import { getSessionSandboxSettingsError } from "../session-sandbox.js";
import type { ModelInfoService } from "../services/ModelInfoService.js";
import type { ProjectQueueScheduler } from "../services/ProjectQueueScheduler.js";
import { describeQueuedYaCommandProblem } from "../services/ProjectQueueService.js";
import type { ServerSettingsService } from "../services/ServerSettingsService.js";
import type { SessionQueuePersistenceService } from "../services/SessionQueuePersistenceService.js";
import { CodexSessionReader } from "../sessions/codex-reader.js";
import type { GeminiSessionReader } from "../sessions/gemini-reader.js";
import type { GrokSessionReader } from "../sessions/grok-reader.js";
import type { PiSessionReader } from "../sessions/pi-reader.js";
import { extractLastAgentExcerpt } from "../sessions/agent-excerpt.js";
import { lastRewindableClaudeRowId } from "../sessions/claude-messages.js";
import {
  getCodexProviderForkTurnId,
  normalizeSession,
} from "../sessions/normalization.js";
import { applyRecapOverlayToSummary } from "../sessions/recap-overlays.js";
import { sessionOwnershipFromProcess } from "../sessions/session-runtime-overlay.js";
import { isAutomaticSessionResumeAllowed } from "../sessions/resume-exemption.js";
import {
  boundSessionSource,
  resolveLegacySessionSource,
  findSessionListSummaryAcrossProviders,
  findSessionSummaryAcrossProviders,
} from "../sessions/provider-resolution.js";
import { getProvider } from "../sdk/providers/index.js";
import type { ExternalSessionTracker } from "../supervisor/ExternalSessionTracker.js";
import {
  type ProviderForkBoundary,
  resolveInheritedForkModel,
} from "../sdk/providers/types.js";
import type { Process } from "../supervisor/Process.js";
import type {
  ModelSettings,
  SessionReactivationOverrides,
  Supervisor,
} from "../supervisor/Supervisor.js";
import {
  ForkSettingsPersistenceError,
  ResumeCompactionError,
  routedSessionUnsupportedMessage,
  RetryableSessionLaunchError,
  SessionConfigurationConflictError,
  SessionMessageRejectedError,
} from "../supervisor/Supervisor.js";
import { RouterUnavailable } from "../services/AgentAuthRouter.js";
import type {
  ContentBlock,
  Message,
  Project,
  Session,
} from "../supervisor/types.js";
import {
  buildUserMessageMetadata,
  normalizeOptionalServiceTier,
  parseHelperSettings,
  parseOptionalExecutor,
  parseOptionalResumeMode,
} from "./session-request-helpers.js";
import { resolveCompactModelSettings } from "./session-compact-thresholds.js";
import {
  type ClaudeResumeApiErrorBlocker,
  getClaudeResumeBlockerFromReader,
} from "./session-claude-resume-guard.js";
import {
  isClaudeSdkProviderName,
  isCodexProviderName,
  providerResolutionDeps,
  resolveSessionReader,
} from "./session-provider-resolution.js";
import { messageId } from "./session-message-id.js";
import { sdkMessagesToClientMessages } from "./session-sdk-history.js";
import { registerSessionDetailRoute } from "./session-detail-routes.js";
import { registerSessionDetailSubresourceRoutes } from "./session-detail-subresource-routes.js";
import { registerSessionMetadataRoutes } from "./session-metadata-routes.js";
import { sessionQueueSummaries } from "./session-queue-summaries.js";
import {
  reportableProcessState,
  resolveRecoveredGroupForDelivery,
  resumeRecoveredGroup,
} from "./session-recovered-queue.js";
import { inheritSuccessorLaunchSettings } from "../supervisor/sessionLaunchInheritance.js";
import { buildThinkingOptions } from "./session-thinking-options.js";
import {
  actingUsername,
  principalFor,
  applyLimitedLaunchPolicy,
  applyLimitedResumePolicy,
  type LimitedLaunchBody,
} from "../auth/limitedLaunchPolicy.js";
import type { UserUsageService } from "../auth/UserUsageService.js";
import type { EventBus } from "../watcher/index.js";
import { resolveExistingSessionIdentity } from "./session-existing-identity.js";
import type { SessionIdentityLookup } from "../sessions/SessionIdentityStore.js";
import type { SessionReaderFactory } from "../sessions/types.js";

export interface SessionsDeps {
  providerChildRelationships?: ProviderChildRelationshipService;
  harnessRelationships?: Pick<
    NestedHarnessRelationshipService,
    "observeTranscript"
  >;
  getLimitedUserGrants?: (
    username: string,
  ) => import("@yep-anywhere/shared").LimitedUserGrants | null;
  signal?: AbortSignal;
  onIssueWindow?: (
    source: { sessionId: string; projectId: string },
    messages: readonly Message[],
  ) => void;
  supervisor: Supervisor;
  scanner: ProjectScanner;
  readerFactory: SessionReaderFactory;
  externalTracker?: ExternalSessionTracker;
  notificationService?: NotificationService;
  sessionIndexService?: ISessionIndexService;
  sessionMetadataService?: SessionMetadataService;
  /** Records who started each session and who sent each turn. */
  userUsageService?: UserUsageService;
  projectMetadataService?: ProjectMetadataService;
  projectQueueScheduler?: Pick<
    ProjectQueueScheduler,
    "reserveUserSessionStart" | "sessionProjectChanged" | "setYaCommandRunner"
  >;
  eventBus?: EventBus;
  codexScanner?: CodexSessionScanner;
  codexSessionsDir?: string;
  /** Optional shared Codex reader factory for cross-provider session lookups */
  codexReaderFactory?: (projectPath: string) => CodexSessionReader;
  geminiScanner?: GeminiSessionScanner;
  geminiSessionsDir?: string;
  /** Optional shared Gemini reader factory for cross-provider session lookups */
  geminiReaderFactory?: (projectPath: string) => GeminiSessionReader;
  /** Grok sessions directory (defaults to ~/.grok/sessions) */
  grokSessionsDir?: string;
  /** Optional shared Grok reader factory for cross-provider session lookups */
  grokReaderFactory?: (projectPath: string) => GrokSessionReader;
  /** pi sessions directory (defaults to ~/.pi/agent/sessions) */
  piSessionsDir?: string;
  /** Optional shared pi reader factory for cross-provider session lookups */
  piReaderFactory?: (projectPath: string) => PiSessionReader;
  /** ServerSettingsService for reading global instructions */
  serverSettingsService?: ServerSettingsService;
  /** ModelInfoService for context window lookups */
  modelInfoService?: ModelInfoService;
  /** Durable store for recovered patient queued messages */
  sessionQueuePersistenceService?: SessionQueuePersistenceService;
  /** Same-session `/clearloop` jobs; this module supplies its runner. */
  clearloopService?: ClearloopService;
  /** Materializes image-bearing tool results for authenticated session reads. */
  toolResultMediaStore?: ToolResultMediaStore;
  /** Data directory for local security/audit logs */
  dataDir?: string;
  /** Test-only session-detail augmentation delay for performance clock probes. */
  persistedAugmentDelayMs?: number;
  /** Authenticated exact probes for bare absolute-path viewer links. */
  resolveAbsoluteFilePaths?: (
    paths: readonly string[],
  ) => Promise<ReadonlySet<string>>;
}

function isApprovalAuditLogEnabled(deps: SessionsDeps): boolean {
  return (
    deps.serverSettingsService?.getSetting("approvalAuditLogEnabled") === true
  );
}

interface InputResponseBody {
  requestId: string;
  response: "approve" | "approve_accept_edits" | "deny" | string;
  answers?: UserQuestionAnswers;
  feedback?: string;
}

interface RestartSessionBody extends CreateSessionBody {
  reason?: string;
  /**
   * "handoff" (default): start a fresh session seeded with a bounded
   * transcript summary. "fork": copy the provider transcript into a new
   * session (real prefix fork; provider must support it — Claude today)
   * and continue there.
   */
  restartMode?: "handoff" | "fork";
  /**
   * Fork slice point: transcript message UUID (inclusive). Omit for a
   * full-transcript fork. Only meaningful with restartMode "fork".
   */
  forkUpToMessageId?: string;
  /**
   * The client URL the user was viewing when they triggered the handoff.
   * Surfaced in the handoff's Source Session block as a self-documenting,
   * clickable pointer back to the source session. Validated server-side.
   */
  sourceUrl?: string;
  /**
   * The handoff message to seed the successor with, replacing the text this
   * route would otherwise build. Set when the user edited the draft the
   * preview route returned. Ignored by "fork", which copies the real
   * transcript instead of sending a message.
   */
  handoffText?: string;
}

const REACTIVATE_SHOW_THINKING_OPTIONS: ReadonlySet<unknown> = new Set([
  "default",
  "on",
  "off",
]);

function isPermissionRules(value: unknown): value is PermissionRules {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const rules = value as Record<string, unknown>;
  return ["allow", "deny"].every((field) => {
    const patterns = rules[field];
    return (
      patterns === undefined ||
      (Array.isArray(patterns) &&
        patterns.every((pattern) => typeof pattern === "string"))
    );
  });
}

function parseOptionalReactivateSessionBody(
  rawBody: string,
): { body: CreateSessionBody } | { error: string } {
  const parsed = parseOptionalJsonObjectBody(rawBody);
  if ("error" in parsed) return parsed;
  const body = parsed.body;

  if (Object.hasOwn(body, "model") && typeof body.model !== "string") {
    return { error: "model must be a string" };
  }
  if (
    Object.hasOwn(body, "provider") &&
    (typeof body.provider !== "string" ||
      !getProvider(body.provider as ProviderName))
  ) {
    return { error: "Invalid provider" };
  }
  if (
    Object.hasOwn(body, "serviceTier") &&
    body.serviceTier !== undefined &&
    body.serviceTier !== null &&
    body.serviceTier !== "" &&
    normalizeOptionalServiceTier(body.serviceTier) === undefined
  ) {
    return { error: "serviceTier must be a valid tier name" };
  }
  if (Object.hasOwn(body, "thinking") && !isThinkingOption(body.thinking)) {
    return { error: "Invalid thinking option" };
  }
  if (
    Object.hasOwn(body, "showThinking") &&
    !REACTIVATE_SHOW_THINKING_OPTIONS.has(body.showThinking)
  ) {
    return { error: "Invalid showThinking option" };
  }
  if (
    Object.hasOwn(body, "permissions") &&
    body.permissions !== undefined &&
    body.permissions !== null &&
    !isPermissionRules(body.permissions)
  ) {
    return { error: "permissions must contain string allow/deny arrays" };
  }

  return { body: body as unknown as CreateSessionBody };
}

function parseOptionalRestartSessionBody(
  rawBody: string,
): { body: RestartSessionBody } | { error: string } {
  const parsed = parseOptionalJsonObjectBody(rawBody);
  if ("error" in parsed) return parsed;
  const body = parsed.body;
  if (
    body.restartMode !== undefined &&
    body.restartMode !== "handoff" &&
    body.restartMode !== "fork"
  ) {
    return { error: 'restartMode must be "handoff" or "fork"' };
  }
  for (const [field, label] of [
    ["reason", "reason"],
    ["forkUpToMessageId", "forkUpToMessageId"],
    ["sourceUrl", "sourceUrl"],
    ["model", "model"],
  ] as const) {
    if (body[field] !== undefined && typeof body[field] !== "string") {
      return { error: `${label} must be a string` };
    }
  }
  if (
    body.provider !== undefined &&
    (typeof body.provider !== "string" ||
      !getProvider(body.provider as ProviderName))
  ) {
    return { error: "Invalid provider" };
  }

  return { body: body as RestartSessionBody };
}

const RESTART_HANDOFF_MAX_CHARS = 40_000;
const RESTART_HANDOFF_JSON_MAX_CHARS = 2_000;
const RESTART_HANDOFF_COMPACT_MAX_CHARS = 10_000;
const RESTART_HANDOFF_USER_TURNS_MAX_CHARS = 28_000;
const RESTART_HANDOFF_ACTIVITY_MAX_CHARS = 14_000;
const RESTART_HANDOFF_USER_TURN_MAX_CHARS = 4_000;
const RESTART_HANDOFF_ACTIVITY_ITEM_MAX_CHARS = 900;
const RESTART_HANDOFF_QUEUED_MAX_CHARS = 4_000;
const RESTART_HANDOFF_RECENT_USER_TURNS = 10;
const RESTART_HANDOFF_RECENT_ACTIVITY_ITEMS = 24;

function parseRestartHandoffText(
  value: unknown,
): { handoffText?: string } | { error: string } {
  if (value === undefined) return { handoffText: undefined };
  if (typeof value !== "string") {
    return { error: "handoffText must be a string" };
  }
  if (value.length > RESTART_HANDOFF_MAX_CHARS) {
    return {
      error: `handoffText must be at most ${RESTART_HANDOFF_MAX_CHARS} characters`,
    };
  }
  return { handoffText: value };
}

function truncateForRestart(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars).trimEnd()}\n[truncated ${omitted} chars]`;
}

function formatRestartBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}\u202fb`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}\u202fkb`;
  if (bytes < 1024 * 1024 * 1024)
    return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}\u202fmb`;
  return `${Math.round((bytes / (1024 * 1024 * 1024)) * 10) / 10}\u202fgb`;
}

function stringifyForRestart(value: unknown, maxChars: number): string {
  if (typeof value === "string") {
    return truncateForRestart(value, maxChars);
  }
  try {
    return truncateForRestart(JSON.stringify(value, null, 2), maxChars);
  } catch {
    return "[unserializable content]";
  }
}

function renderRestartContent(content: unknown): string {
  if (content === undefined || content === null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return stringifyForRestart(content, RESTART_HANDOFF_JSON_MAX_CHARS);
  }

  return content
    .map((block) => {
      if (typeof block === "string") {
        return block;
      }
      if (!block || typeof block !== "object") {
        return "";
      }

      const typed = block as ContentBlock;
      switch (typed.type) {
        case "text":
          return typed.text ?? "";
        case "thinking":
          return typed.thinking
            ? `[thinking]\n${typed.thinking}`
            : "[thinking]";
        case "tool_use":
          return `[tool_use ${typed.name ?? "unknown"}]\n${stringifyForRestart(
            typed.input,
            RESTART_HANDOFF_JSON_MAX_CHARS,
          )}`;
        case "tool_result":
          return `[tool_result${typed.is_error ? " error" : ""} ${
            typed.tool_use_id ?? ""
          }]\n${renderRestartContent(typed.content)}`;
        case "image":
        case "input_image":
          return "[image]";
        case "document":
          return "[document]";
        default:
          return `[${typed.type}]\n${stringifyForRestart(
            typed,
            RESTART_HANDOFF_JSON_MAX_CHARS,
          )}`;
      }
    })
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

function compactRestartLine(text: string, maxChars: number): string {
  return truncateForRestart(text.replace(/\s+/g, " ").trim(), maxChars);
}

function messageRole(message: Message): string {
  const nested = message.message as { role?: unknown } | undefined;
  return (
    (typeof nested?.role === "string" && nested.role) ||
    (typeof message.role === "string" && message.role) ||
    message.type ||
    "message"
  );
}

function messageContent(message: Message): unknown {
  const nested = message.message as { content?: unknown } | undefined;
  return nested?.content ?? (message as { content?: unknown }).content;
}

function messageHasToolResult(message: Message): boolean {
  if (message.toolUseResult !== undefined) {
    return true;
  }
  const content = messageContent(message);
  return (
    Array.isArray(content) &&
    content.some(
      (block) =>
        !!block &&
        typeof block === "object" &&
        (block as ContentBlock).type === "tool_result",
    )
  );
}

function isRestartInternalCompactCommand(message: Message): boolean {
  if (messageRole(message) !== "user" || messageHasToolResult(message)) {
    return false;
  }
  const content = renderRestartContent(messageContent(message)).trim();
  return /^\/(?:compact|compress)\b/i.test(content);
}

function toolInputSummary(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return compactRestartLine(stringifyForRestart(input, 400), 400);
  }

  const record = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of [
    "file_path",
    "path",
    "command",
    "query",
    "pattern",
    "old_string",
    "new_string",
  ]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      parts.push(`${key}=${compactRestartLine(value, 180)}`);
    }
  }

  return parts.length > 0
    ? parts.join("; ")
    : compactRestartLine(stringifyForRestart(input, 400), 400);
}

function shellCommandFromInput(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return "";
  }
  const command = (input as Record<string, unknown>).command;
  if (typeof command === "string") {
    return command.trim();
  }
  if (Array.isArray(command)) {
    return command
      .filter((part): part is string => typeof part === "string")
      .join(" ")
      .trim();
  }
  return "";
}

// Only shell/bash commands survive in the activity log: they are the one tool
// class whose intent is legible without the (dropped) output, and the source
// session's jsonl holds everything else for grep. Non-shell tool calls, tool
// results, and thinking are omitted entirely.
// See topics/restart-handoff-template.md.
function summarizeToolUse(name: string | undefined, input: unknown): string {
  if (!/bash|shell/i.test(name ?? "")) {
    return "";
  }
  const command = shellCommandFromInput(input) || toolInputSummary(input);
  return command ? `$ ${compactRestartLine(command, 800)}` : "";
}

function renderRestartActivityContent(message: Message): string {
  if (message.toolUse) {
    return summarizeToolUse(message.toolUse.name, message.toolUse.input);
  }
  if (message.toolUseResult !== undefined) {
    // Tool output is recovered from the source jsonl, not carried here.
    return "";
  }

  const content = messageContent(message);
  if (!Array.isArray(content)) {
    return renderRestartContent(content);
  }

  return content
    .map((block) => {
      if (typeof block === "string") {
        return block;
      }
      if (!block || typeof block !== "object") {
        return "";
      }

      const typed = block as ContentBlock;
      switch (typed.type) {
        case "tool_use":
          return summarizeToolUse(typed.name, typed.input);
        case "tool_result":
        case "thinking":
          return "";
        default:
          return renderRestartContent([typed]);
      }
    })
    .filter((part) => part.trim().length > 0)
    .join("\n");
}

function formatRestartMessage(message: Message): string | null {
  if (isRestartInternalCompactCommand(message)) {
    return null;
  }

  const isUser = isHumanUserMessage(message);
  const content = isUser
    ? renderRestartContent(messageContent(message))
    : renderRestartActivityContent(message);
  const trimmed = content.trim();

  if (!trimmed) {
    return null;
  }

  const body = truncateForRestart(
    trimmed,
    isUser
      ? RESTART_HANDOFF_USER_TURN_MAX_CHARS
      : RESTART_HANDOFF_ACTIVITY_ITEM_MAX_CHARS,
  );
  // User directions retain a divider. Assistant prose and shell commands are
  // self-delimiting within the activity section.
  return isUser ? `### user\n\n${body}` : body;
}

function formatRestartQueuedMessage(
  message: {
    tempId?: string;
    content: string;
    timestamp: string;
    attachments?: UploadedFile[];
    attachmentCount?: number;
  },
  index: number,
): string {
  const attachmentLines =
    message.attachments?.length && message.attachments.length > 0
      ? `\n\nUser uploaded files:\n${message.attachments
          .map(
            (file) =>
              `- [${file.originalName.replaceAll("[", "\\[").replaceAll("]", "\\]")}](<${file.path}>) (${formatRestartBytes(file.size)}, ${file.mimeType}${file.width && file.height ? `, ${file.width}x${file.height}` : ""})`,
          )
          .join("\n")}`
      : message.attachmentCount && message.attachmentCount > 0
        ? `\nAttachments queued: ${message.attachmentCount}`
        : "";
  const tempIdLine = message.tempId ? `\nTemp ID: ${message.tempId}` : "";
  return `### queued user ${index + 1}\n\n${truncateForRestart(
    message.content.trim() || "[empty queued turn]",
    RESTART_HANDOFF_QUEUED_MAX_CHARS,
  )}${attachmentLines}${tempIdLine}`;
}

type RestartQueuedMessage = {
  tempId?: string;
  content: string;
  timestamp: string;
  attachments?: UploadedFile[];
  attachmentCount?: number;
};

function getRestartQueuedMessages(
  process: Process | undefined,
): RestartQueuedMessage[] {
  return process?.getDeferredQueueSummary?.() ?? [];
}

function latestCompactSummary(messages: Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.type !== "system" ||
      (message as { subtype?: unknown }).subtype !== "compact_boundary"
    ) {
      continue;
    }

    const summary = renderRestartContent(messageContent(message)).trim();
    if (summary && !/^context compacted\.?$/i.test(summary)) {
      return truncateForRestart(summary, RESTART_HANDOFF_COMPACT_MAX_CHARS);
    }
  }
  return null;
}

function selectRestartMessages(params: {
  messages: Message[];
  maxItems: number;
  maxChars: number;
  predicate: (message: Message) => boolean;
  selectedIndexes: Set<number>;
}): string[] {
  const selected: string[] = [];
  let used = 0;

  for (let index = params.messages.length - 1; index >= 0; index -= 1) {
    const message = params.messages[index];
    if (!message || !params.predicate(message)) {
      continue;
    }
    const formatted = formatRestartMessage(message);
    if (!formatted) {
      continue;
    }
    const nextSize = formatted.length + 2;
    if (
      selected.length >= params.maxItems ||
      (selected.length > 0 && used + nextSize > params.maxChars)
    ) {
      break;
    }
    selected.push(formatted);
    params.selectedIndexes.add(index);
    used += nextSize;
  }

  return selected.reverse();
}

function buildRestartTranscript(messages: Message[]): {
  transcript: string;
  omittedCount: number;
} {
  const selectedIndexes = new Set<number>();
  const compactSummary = latestCompactSummary(messages);
  const userTurns = selectRestartMessages({
    messages,
    maxItems: RESTART_HANDOFF_RECENT_USER_TURNS,
    maxChars: RESTART_HANDOFF_USER_TURNS_MAX_CHARS,
    predicate: isHumanUserMessage,
    selectedIndexes,
  });
  const activity = selectRestartMessages({
    messages,
    maxItems: RESTART_HANDOFF_RECENT_ACTIVITY_ITEMS,
    maxChars: RESTART_HANDOFF_ACTIVITY_MAX_CHARS,
    predicate: (message) =>
      !isHumanUserMessage(message) &&
      !(
        message.type === "system" &&
        (message as { subtype?: unknown }).subtype === "compact_boundary" &&
        compactSummary
      ),
    selectedIndexes,
  });

  const sections = [
    compactSummary
      ? `## Provider-Native Compact Summary\n\n${compactSummary}`
      : undefined,
    userTurns.length > 0
      ? `## Recent User Turns\n\n${userTurns.join("\n\n")}`
      : undefined,
    activity.length > 0
      ? `## Recent Agent and Tool Activity\n\n${activity.join("\n\n")}`
      : undefined,
  ].filter((section): section is string => Boolean(section));

  return {
    transcript: truncateForRestart(
      sections.join("\n\n"),
      RESTART_HANDOFF_MAX_CHARS,
    ),
    omittedCount: Math.max(0, messages.length - selectedIndexes.size),
  };
}

function compactRestartTitleText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stripMarkdownHeading(text: string): string {
  return text.replace(/^#+\s*/, "");
}

function isGeneratedRestartHandoffTitle(text: string): boolean {
  const title = stripMarkdownHeading(compactRestartTitleText(text));
  return (
    /^Restart Handoff\b/i.test(title) ||
    /^Handoff:\s*Restart Handoff\b/i.test(title) ||
    /^Handoff:\s*Yep Anywhere is starting this as a fresh agent session\b/i.test(
      title,
    ) ||
    /^Yep Anywhere is starting this as a fresh agent session\b/i.test(title)
  );
}

function normalizeRestartTitleCandidate(
  title: string | null | undefined,
): string | undefined {
  if (!title) {
    return undefined;
  }
  const candidate = stripMarkdownHeading(compactRestartTitleText(title));
  if (!candidate || isGeneratedRestartHandoffTitle(candidate)) {
    return undefined;
  }
  return candidate;
}

function isHumanUserMessage(message: Message): boolean {
  const nested = message.message as { role?: unknown } | undefined;
  const role =
    (typeof nested?.role === "string" && nested.role) ||
    (typeof message.role === "string" && message.role) ||
    message.type;
  return role === "user" && !messageHasToolResult(message);
}

type SessionForkKind =
  | "clone-latest-complete"
  | "before-user-turn"
  | "after-user-turn";

function providerForkBoundaryForMessage(
  providerName: ProviderName,
  message: Message,
): ProviderForkBoundary | null {
  const retainedThroughMessageId = messageId(message);
  if (!retainedThroughMessageId) return null;

  if (isClaudeSdkProviderName(providerName)) {
    return {
      kind: "message",
      provider: providerName,
      messageId: retainedThroughMessageId,
    };
  }
  if (isCodexProviderName(providerName)) {
    const turnId = getCodexProviderForkTurnId(message);
    return turnId ? { kind: "turn", provider: providerName, turnId } : null;
  }
  if (providerName === "pi") {
    return {
      kind: "entry",
      provider: "pi",
      entryId: retainedThroughMessageId,
    };
  }
  return null;
}

function resolveForkAfterBoundary(
  messages: Message[],
  sourceMessageId: string,
  sourceIsBusy: boolean,
  providerName?: ProviderName,
):
  | {
      placementAfterMessageId: string;
      retainedThroughMessageId: string;
      retainedThroughContext?: string;
      providerBoundary?: ProviderForkBoundary;
    }
  | { error: string; status: 400 | 404 | 409 } {
  const sourceIndex = messages.findIndex(
    (message) => messageId(message) === sourceMessageId,
  );
  const sourceMessage = messages[sourceIndex];
  if (sourceIndex < 0 || !sourceMessage) {
    return { error: "Selected source message was not found", status: 404 };
  }
  if (!isRealUserTurn(sourceMessage)) {
    return {
      error: "sourceMessageId must identify a user-authored request",
      status: 400,
    };
  }

  const chain = sourceChainMessages(messages, sourceMessage);
  const chainIndex = chain.indexOf(sourceMessage);
  let nextUserIndex = -1;
  for (let index = chainIndex + 1; index < chain.length; index += 1) {
    const candidate = chain[index];
    if (candidate && isRealUserTurn(candidate)) {
      nextUserIndex = index;
      break;
    }
  }
  if (nextUserIndex < 0 && sourceIsBusy) {
    return {
      error: "The selected turn is still in progress",
      status: 409,
    };
  }

  const searchEnd = nextUserIndex >= 0 ? nextUserIndex - 1 : chain.length - 1;
  let hasAssistantResponse = false;
  for (let index = chainIndex + 1; index <= searchEnd; index += 1) {
    const candidate = chain[index];
    if (candidate && messageRole(candidate) === "assistant") {
      hasAssistantResponse = true;
      break;
    }
  }
  if (!hasAssistantResponse) {
    return {
      error: "The selected request has no completed assistant response",
      status: 409,
    };
  }

  let boundary: Message | undefined;
  for (let index = searchEnd; index > chainIndex; index -= 1) {
    const candidate = chain[index];
    const role = candidate ? messageRole(candidate) : undefined;
    if (
      candidate &&
      messageId(candidate) &&
      (role === "user" || role === "assistant")
    ) {
      boundary = candidate;
      break;
    }
  }
  const retainedThroughMessageId = messageId(boundary);
  if (!boundary || !retainedThroughMessageId) {
    return { error: "Completed turn boundary has no message id", status: 409 };
  }

  const placementAfterMessageId =
    [...messages].reverse().map(messageId).find(Boolean) ??
    retainedThroughMessageId;
  const rendered = renderRestartContent(messageContent(boundary)).trim();
  const providerBoundary = providerName
    ? providerForkBoundaryForMessage(providerName, boundary)
    : undefined;
  if (
    providerName &&
    (isClaudeSdkProviderName(providerName) ||
      isCodexProviderName(providerName) ||
      providerName === "pi") &&
    !providerBoundary
  ) {
    return {
      error:
        "The selected completed turn cannot be addressed safely. No new session was created and the source is unchanged.",
      status: 409,
    };
  }
  return {
    placementAfterMessageId,
    retainedThroughMessageId,
    retainedThroughContext: rendered
      ? truncateForRestart(rendered, 1200)
      : undefined,
    ...(providerBoundary ? { providerBoundary } : {}),
  };
}

/**
 * The rows on a source turn's own provider chain. A cleared span is a dead
 * branch: a live turn neither continues from nor is answered by its rows,
 * while a cleared turn's chain is its own span, the spans enclosing it, and
 * the live prefix before them (topics/session-rewind.md § Vocabulary).
 */
function sourceChainMessages(messages: Message[], source: Message): Message[] {
  const groupOf = (message: Message): string | undefined =>
    typeof message.rewoundGroupId === "string"
      ? message.rewoundGroupId
      : undefined;
  const enclosingGroup = new Map<string, string>();
  for (const message of messages) {
    const group = groupOf(message);
    const parent = message.rewoundParentGroupId;
    if (group && typeof parent === "string") enclosingGroup.set(group, parent);
  }
  const chainGroups = new Set<string>();
  for (
    let group = groupOf(source);
    group && !chainGroups.has(group);
    group = enclosingGroup.get(group)
  ) {
    chainGroups.add(group);
  }
  return messages.filter((message) => {
    const group = groupOf(message);
    return !group || chainGroups.has(group);
  });
}

/**
 * The turn a "before this turn" cut keeps: the previous real turn on the
 * source's chain, which is turn N−1 only when no clear dropped the turns
 * between.
 */
function precedingChainTurn(
  messages: Message[],
  source: Message,
): Message | undefined {
  const chain = sourceChainMessages(messages, source);
  for (let index = chain.indexOf(source) - 1; index >= 0; index -= 1) {
    const candidate = chain[index];
    if (candidate && messageId(candidate) && isRealUserTurn(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function resolveForkBeforeBoundary(
  messages: Message[],
  sourceMessageId: string,
  providerName: ProviderName,
): ReturnType<typeof resolveForkAfterBoundary> {
  const sourceMessage = messages.find(
    (message) => messageId(message) === sourceMessageId,
  );
  if (!sourceMessage) {
    return { error: "Selected source message was not found", status: 404 };
  }
  if (!isRealUserTurn(sourceMessage)) {
    return {
      error: "sourceMessageId must identify a user-authored request",
      status: 400,
    };
  }

  const keptTurnId = messageId(precedingChainTurn(messages, sourceMessage));
  if (!keptTurnId) {
    return {
      error: "There is no completed turn before the selected request",
      status: 409,
    };
  }
  return resolveForkAfterBoundary(messages, keptTurnId, false, providerName);
}

function forkSummaryTitleCandidate(summary: string): string | undefined {
  const firstLine = summary
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const candidate = firstLine
    ?.replace(/^#{1,6}\s*/u, "")
    .replace(/^title:\s*/iu, "")
    .trim()
    .replace(/[.!?]+$/u, "");
  return candidate || undefined;
}

/** An existing fork/clone prefix is replaced by the new one, never stacked. */
const FORK_TITLE_PREFIX_PATTERN = /^(?:fork|clone)(?:\s+\d+)?:\s*/iu;

/**
 * Title a fork so repeated forks of one session are told apart: the first is
 * `Fork: <source>`, the next `Fork 2: <source>`. `ordinal` is the source
 * session's fork count from `nextForkOrdinal`, which counts forks created, so
 * deleting a fork does not hand its number to a later one.
 */
function forkTitleWithOrdinal(
  base: string,
  ordinal: number,
  prefix: "Fork" | "Clone" = "Fork",
): string {
  const core = base.replace(FORK_TITLE_PREFIX_PATTERN, "").trim() || base;
  return truncateSessionTitle(
    ordinal > 1 ? `${prefix} ${ordinal}: ${core}` : `${prefix}: ${core}`,
  );
}

function generatedRetitleCandidate(title: string): string | undefined {
  const firstLine = title
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) {
    return undefined;
  }
  const candidate = normalizeRestartTitleCandidate(
    firstLine
      .replace(/^title:\s*/iu, "")
      .replace(/^["'“”‘’]+|["'“”‘’]+$/gu, "")
      .replace(/[.!?]+$/u, "")
      .trim(),
  );
  return candidate ? truncateSessionTitle(candidate) : undefined;
}

function messageTitleCandidate(message: Message): string | undefined {
  if (
    !isHumanUserMessage(message) ||
    isRestartInternalCompactCommand(message)
  ) {
    return undefined;
  }

  const nested = message.message as { content?: unknown } | undefined;
  const content =
    renderRestartContent(nested?.content) ||
    renderRestartContent((message as { content?: unknown }).content);
  const candidate = normalizeRestartTitleCandidate(content);

  if (
    !candidate ||
    /^\[(tool_result|tool_use|thinking|image|document)\]/i.test(candidate)
  ) {
    return undefined;
  }
  return candidate;
}

function latestUserTitleCandidate(messages: Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    const candidate = messageTitleCandidate(message);
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

function truncateRestartTitle(title: string): string {
  return truncateSessionTitle(title);
}

function deriveRestartTitle(params: {
  preferredTitle?: string | null;
  sourceSession: Session;
}): string {
  const candidates = [
    params.preferredTitle,
    params.sourceSession.customTitle,
    params.sourceSession.title,
    latestUserTitleCandidate(params.sourceSession.messages),
  ];
  const base =
    candidates.map(normalizeRestartTitleCandidate).find(Boolean) ??
    "restarted session";
  const title = /^Handoff:/i.test(base) ? base : `Handoff: ${base}`;
  return truncateRestartTitle(title);
}

function deriveForkTitle(params: {
  preferredTitle?: string | null;
  sourceSession: Session;
  ordinal: number;
}): string {
  const candidates = [
    params.preferredTitle,
    params.sourceSession.customTitle,
    params.sourceSession.title,
    latestUserTitleCandidate(params.sourceSession.messages),
  ];
  const base =
    candidates.map(normalizeRestartTitleCandidate).find(Boolean) ??
    "forked session";
  return forkTitleWithOrdinal(base, params.ordinal);
}

function buildRestartHandoff(params: {
  handoffTitle: string;
  sourceSession: Session;
  sourceProvider?: ProviderName;
  sourceModel?: string;
  sourceProcess?: Process;
  sourceUrl?: string;
  sourceTranscriptPath?: string;
  sourceTranscriptHost?: string;
  targetExecutor?: string;
  projectPath: string;
  omittedCount: number;
  transcript: string;
  /**
   * Why the successor exists. A restart continues the source's work; a
   * cold-session redirect carries a new user message that may be unrelated
   * to it (topics/limited-users.md § Freshness).
   */
  purpose?: "restart" | "cold-session";
}): string {
  const {
    handoffTitle,
    sourceSession,
    sourceProvider,
    sourceModel,
    sourceProcess,
    sourceUrl,
    sourceTranscriptPath,
    sourceTranscriptHost,
    targetExecutor,
    projectPath,
    omittedCount,
    transcript,
  } = params;
  const urlLine = formatRestartSourceUrl(sourceUrl);
  const transcriptPathLine = formatRestartTranscriptPath({
    path: sourceTranscriptPath,
    host: sourceTranscriptHost,
    targetExecutor,
  });
  const sessionTurnLine = formatRestartSessionTurnHint({
    provider: sourceProvider ?? sourceSession.provider,
    sessionId: sourceSession.id,
  });
  const transcriptBlock = [
    omittedCount > 0
      ? `_${omittedCount} older rendered messages were omitted to keep this handoff bounded._`
      : undefined,
    transcript || "[No textual transcript was available.]",
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
  const queuedMessages = getRestartQueuedMessages(sourceProcess);
  const queuedSection =
    queuedMessages.length > 0
      ? [
          "## Queued User Turns (Not Yet Processed)",
          "",
          "These user turns were accepted by YA's deferred queue after the source transcript. No agent response in the source session has processed them yet.",
          "",
          queuedMessages.map(formatRestartQueuedMessage).join("\n\n"),
        ].join("\n")
      : undefined;

  const intro =
    params.purpose === "cold-session"
      ? [
          "Yep Anywhere is starting this as a fresh agent session because the user sent a new message to an earlier session that had been idle too long to resume cheaply.",
          "The user's new message is at the end, under **New Message**. It may be a new, independent request: answer it on its own terms, and use the earlier session below only when the message refers to something it explains. Do not resume or repeat the earlier session's work unless the new message asks for that.",
        ]
      : [
          "Yep Anywhere is starting this as a fresh agent session because the previous process became unhealthy or was manually restarted.",
          "Treat the transcript below as context, not as a new request to repeat. Prefer any provider-native compact summary when present, then use the recent user turns and summarized activity to continue the user's latest unresolved work after checking the live repository state.",
        ];

  return [
    `# ${handoffTitle}`,
    "",
    ...intro,
    "",
    "## Source Session",
    "",
    `- Session ID: ${sourceSession.id}`,
    urlLine,
    `- Project path: ${projectPath}`,
    `- Provider: ${sourceProvider ?? sourceSession.provider}`,
    `- Model: ${sourceModel ?? sourceSession.model ?? "unknown"}`,
    transcriptPathLine,
    sessionTurnLine,
    "",
    transcriptBlock,
    queuedSection,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

// Keep the resumable source URL to one http(s) token so it cannot inject lines.
function formatRestartSourceUrl(url: string | undefined): string | undefined {
  const trimmed = (url ?? "").trim().split(/\s/)[0] ?? "";
  if (!/^https?:\/\//i.test(trimmed)) {
    return undefined;
  }
  return `- URL: ${compactRestartLine(trimmed, 400)}`;
}

function formatRestartTranscriptPath(params: {
  path: string | undefined;
  host?: string;
  targetExecutor?: string;
}): string | undefined {
  const trimmed = (params.path ?? "").trim().split(/[\r\n]/)[0] ?? "";
  if (!trimmed) {
    return undefined;
  }
  const host = compactRestartLine(params.host?.trim() || "YA server", 160);
  const executorNote = params.targetExecutor
    ? `; successor executor: ${compactRestartLine(params.targetExecutor, 160)}`
    : "";
  return `- Full transcript on ${host}${executorNote} (read or grep there for detail beyond this summary): ${compactRestartLine(
    trimmed,
    400,
  )}`;
}

// A claude/codex source session can answer one more turn in place through the
// optional session-turn helper (YA provider-host protocol; the incumbent
// worker keeps ownership, so no second writer or transcript fork). Offer that
// alongside the transcript path; other providers have no helper harness.
function formatRestartSessionTurnHint(params: {
  provider: string | undefined;
  sessionId: string;
}): string | undefined {
  const harness = agentHarness(params.provider ?? "");
  if (harness !== "claude" && harness !== "codex") {
    return undefined;
  }
  return `- Ask the source session itself (non-forking; needs the optional session-turn helper on PATH): echo '<question>' | session-turn ${harness} ${compactRestartLine(params.sessionId, 200)}`;
}

function isRestartReplacementActivity(message: SDKMessage): boolean {
  return message.type === "assistant";
}

export function createSessionsRoutes(deps: SessionsDeps): Hono {
  const routes = new Hono();
  const { creationForRequest, creationAcceptance } =
    createSessionCreationRequests(deps);
  routes.get("/session-creations/:requestId", (c) => {
    const principal = principalFor(c);
    const owner =
      principal.kind === "limited"
        ? { kind: "limited" as const, username: principal.username }
        : { kind: "superuser" as const };
    const requestId = c.req.param("requestId");
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestId))
      return c.json({ error: "Invalid creation request id" }, 400);
    const saved = deps.sessionMetadataService?.creations.get(owner, requestId);
    if (!saved) return c.json({ error: "Creation request not found" }, 404);
    if (saved.deleted)
      return c.json({ error: "Session creation was deleted" }, 410);
    return c.json(sessionCreationReceipt(saved));
  });
  const storedIdentityFor = (sessionId: string) =>
    isYaSessionId(sessionId)
      ? deps.sessionMetadataService?.identities?.resolveYa(sessionId)
      : undefined;
  // Historical executor labels are read-only. Never turn a retired remote
  // session into a local writer through resume, clone, fork or another action.
  routes.use("/projects/:projectId/sessions/:sessionId/*", async (c, next) => {
    // Preview refresh only reads the retained transcript; execution stays blocked.
    if (c.req.method === "POST" && !c.req.path.endsWith("/refresh-preview")) {
      const sessionId = c.req.param("sessionId");
      const executor =
        deps.sessionMetadataService?.getMetadata?.(sessionId)?.executor ??
        deps.sessionMetadataService?.getExecutor?.(sessionId);
      if (executor) {
        return c.json(
          {
            error: "SSH executors have been removed; this session is read-only",
          },
          410,
        );
      }
    }
    await next();
  });
  // Successors of a router-pinned session would launch without its pin and
  // run on the owner's direct provider login; refuse them up front.
  const isRoutedSession = (sessionId: string): boolean =>
    Boolean(
      deps.sessionMetadataService?.getMetadata?.(sessionId)?.routerBinding,
    );
  const activeForkSummaryJobs = new Map<
    string,
    { objectId: string; abortController: AbortController }
  >();
  const emitTranscriptDisplayObjects = (sessionId: string): void => {
    deps.eventBus?.emit({
      type: "session-metadata-changed",
      sessionId,
      transcriptDisplayObjects:
        deps.sessionMetadataService?.getTranscriptDisplayObjects(sessionId) ??
        [],
      timestamp: new Date().toISOString(),
    });
  };
  const updateForkSummaryChildMetadata = async (
    childSessionId: string,
    sourceSessionId: string,
    title: string,
    archived: boolean,
    forkLineageRootId?: string,
  ): Promise<void> => {
    await deps.sessionMetadataService?.updateMetadata(childSessionId, {
      title,
      archived,
      forkedFromSessionId: sourceSessionId,
      ...(forkLineageRootId ? { forkLineageRootId } : {}),
    });
    deps.eventBus?.emit({
      type: "session-metadata-changed",
      sessionId: childSessionId,
      title,
      archived,
      forkedFromSessionId: sourceSessionId,
      timestamp: new Date().toISOString(),
    });
  };
  const getCodexReader = (projectPath: string): CodexSessionReader | null =>
    deps.codexReaderFactory?.(projectPath) ??
    (deps.codexSessionsDir
      ? new CodexSessionReader({
          sessionsDir: deps.codexSessionsDir,
          projectPath,
        })
      : null);

  const {
    getGrokNativeProjectId,
    buildGrokNativeRedirectPath,
    buildSessionProjectRedirectPath,
    resolveSessionProjectRouting,
  } = createSessionProjectRouting(deps, storedIdentityFor);

  const { getGlobalInstructions, buildResumeLaunch } =
    createSessionLaunchSettings(deps);

  const persistLaunchMetadata = async (
    sessionId: string,
    provider: ProviderName | undefined,
    executor: string | undefined,
    initialPrompt?: string,
    requestedModel?: string,
    promptSuggestionMode?: PromptSuggestionMode,
    recapAfterSeconds?: number,
    sandbox?: {
      level: SessionSandboxLevel;
      networkFirewall?: boolean;
      stateKey?: string;
      projectPath: string;
      projectId: UrlProjectId;
    },
  ): Promise<void> => {
    if (!deps.sessionMetadataService) {
      return;
    }
    if (provider) {
      await deps.sessionMetadataService.setProvider(sessionId, provider);
    }
    if (executor) {
      await deps.sessionMetadataService.setExecutor(sessionId, executor);
    }
    if (initialPrompt?.trim()) {
      await deps.sessionMetadataService.setInitialPrompt(
        sessionId,
        initialPrompt,
      );
    }
    // Persist the launch model identity. Normal launches retain the selected YA
    // alias (including "default"); forks replace "default" with the observed
    // source model so a cold first resume cannot drift to a new default.
    if (requestedModel) {
      await deps.sessionMetadataService.setRequestedModel(
        sessionId,
        requestedModel,
      );
    }
    // Persist the resolved prompt-suggestion mode so a later resume (which may
    // omit it from the request body) recovers the per-session preference
    // instead of falling back to the provider's native default.
    if (promptSuggestionMode !== undefined) {
      await deps.sessionMetadataService.updateMetadata(sessionId, {
        promptSuggestionMode,
      });
    }
    if (recapAfterSeconds !== undefined) {
      await deps.sessionMetadataService.updateMetadata(sessionId, {
        recapAfterSeconds,
      });
    }
    if (sandbox) {
      await deps.sessionMetadataService.setSessionSandbox?.(sessionId, sandbox);
    }
  };

  /**
   * Ids of the rewinds a detail response's projection applied, so a client
   * holding a cached transcript can tell whether it predates a rewind
   * (topics/session-rewind.md). Absent when the session has none.
   */
  const rewindRecordIdsFor = (sessionId: string): string[] | undefined => {
    const records = deps.sessionMetadataService?.getRewindRecords?.(sessionId);
    return records?.length ? records.map((record) => record.id) : undefined;
  };

  const loadRestartSourceSession = async (
    project: Project,
    sessionId: string,
    projectId: UrlProjectId,
    preferredProvider?: ProviderName,
    process?: Process,
  ): Promise<Session | null> => {
    const resolved = await findSessionListSummaryAcrossProviders(
      project,
      sessionId,
      projectId,
      providerResolutionDeps(deps),
      preferredProvider,
    );

    if (resolved) {
      const loaded = await resolved.source.reader.getSession(
        resolved.nativeSessionId,
        projectId,
        undefined,
        { includeOrphans: false },
      );
      if (loaded) {
        return normalizeSession(
          {
            ...loaded,
            summary: {
              ...loaded.summary,
              id: sessionId,
              provider: resolved.source.provider,
            },
          },
          {
            rewindRecords:
              deps.sessionMetadataService?.getRewindRecords?.(sessionId),
          },
        );
      }
    }

    if (process) {
      const messages = sdkMessagesToClientMessages(process.getMessageHistory());
      return {
        id: sessionId,
        projectId,
        title: null,
        fullTitle: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: messages.length,
        ownership: sessionOwnershipFromProcess(process),
        provider: process.provider,
        model: process.resolvedModel ?? process.model,
        messages,
      };
    }

    return null;
  };

  /**
   * The transcript's last row on disk, read once the session's process has
   * stopped: every row up to it belongs to a rewind recorded now, and the
   * resumed continuation is written after it.
   */
  const readRewindBoundRowId = async (
    project: Project,
    sessionId: string,
    projectId: UrlProjectId,
    providerName: ProviderName,
  ): Promise<string | undefined> => {
    const resolved = await findSessionListSummaryAcrossProviders(
      project,
      sessionId,
      projectId,
      providerResolutionDeps(deps),
      providerName,
    );
    const loaded = await resolved?.source.reader.getSession(
      resolved.nativeSessionId,
      projectId,
      undefined,
      { includeOrphans: false },
    );
    const data = loaded?.data;
    switch (data?.provider) {
      case "claude":
      case "claude-gateway":
      case "claude-ollama":
        return lastRewindableClaudeRowId(data.session.messages);
      default:
        return undefined;
    }
  };

  const interruptOldProcessForHandoff = async (
    oldProcess: Process | undefined,
  ): Promise<boolean> => {
    if (!oldProcess) {
      return false;
    }
    try {
      const result = await deps.supervisor.interruptProcess(oldProcess.id);
      return result.success;
    } catch (error) {
      console.warn(
        `[restart] Failed to interrupt old process ${oldProcess.id}:`,
        error,
      );
      return false;
    }
  };

  const abortOldProcessAfterReplacementActivity = (
    oldProcess: Process | undefined,
    replacement: Process,
  ): boolean => {
    if (!oldProcess || oldProcess.id === replacement.id) {
      return false;
    }

    let unsubscribe: (() => void) | null = null;
    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      unsubscribe?.();
      unsubscribe = null;
    };

    unsubscribe = replacement.subscribe((event) => {
      if (
        event.type === "message" &&
        isRestartReplacementActivity(event.message)
      ) {
        cleanup();
        void deps.supervisor.abortProcess(oldProcess.id).catch((error) => {
          console.warn(
            `[restart] Failed to abort old process ${oldProcess.id}:`,
            error,
          );
        });
        return;
      }

      if (
        event.type === "terminated" ||
        event.type === "complete" ||
        event.type === "error"
      ) {
        cleanup();
      }
    });

    return true;
  };

  const ensureDetachedProjectPath = async (
    executor?: string,
    username?: string,
  ): Promise<string> => {
    const projectPath = username
      ? limitedDetachedProjectPath(username)
      : DETACHED_PROJECT_PATH;
    await mkdir(projectPath, { recursive: true, mode: 0o700 });
    if (executor) throw new Error("SSH executors have been removed");
    return projectPath;
  };

  routes.get("/sessions/:sessionId/native-source", async (c) => {
    if (principalFor(c).kind !== "superuser")
      return c.json({ error: "Operator access required" }, 403);
    const sessionId = c.req.param("sessionId");
    if (!isYaSessionId(sessionId))
      return c.json({ error: "Invalid session ID" }, 400);
    const identity = storedIdentityFor(sessionId);
    if (
      !identity ||
      creationStatusForSession(
        deps.sessionMetadataService,
        sessionId,
        deps.signal,
      )?.state === "deleted"
    )
      return c.json({ error: "Session not found" }, 404);
    const result = {
      sessionId: identity.sessionId,
      provider: identity.provider,
      projectId: identity.projectId,
      native: identity.native,
      transcriptPath: null as string | null,
    };
    if (!identity.native) return c.json({ ...result, status: "unbound" });
    const project = await deps.scanner.getOrCreateProject(identity.projectId);
    if (!project) return c.json({ ...result, status: "missing" });
    const reader = deps.readerFactory(
      { ...project, provider: identity.provider },
      identity.native,
    );
    if (!reader.getSessionFilePath)
      return c.json({ ...result, status: "unsupported" });
    const transcriptPath = await reader.getSessionFilePath(identity.native.id);
    return c.json({
      ...result,
      transcriptPath,
      status: transcriptPath ? "available" : "missing",
    });
  });

  const sessionDetailRouting = {
    resolveSessionProjectRouting,
    buildSessionProjectRedirectPath,
    getGrokNativeProjectId,
    buildGrokNativeRedirectPath,
    rewindRecordIdsFor,
    storedIdentityFor,
  };
  registerSessionDetailSubresourceRoutes(routes, deps, sessionDetailRouting);

  // PUT /api/projects/:projectId/sessions/:sessionId/project
  // Reclassify a session under a different YA project without sending any
  // provider-visible turn. The provider transcript remains under
  // transcriptProjectId; relative file links and UI routing use projectId.
  routes.put("/projects/:projectId/sessions/:sessionId/project", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }
    if (!deps.sessionMetadataService) {
      return c.json({ error: "Session metadata service unavailable" }, 503);
    }

    let body: { projectId?: unknown };
    try {
      body = await c.req.json<{ projectId?: unknown }>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const targetProjectId = body.projectId;
    if (
      typeof targetProjectId !== "string" ||
      !isUrlProjectId(targetProjectId)
    ) {
      return c.json({ error: "Invalid target project ID format" }, 400);
    }

    const targetProject =
      await deps.scanner.getOrCreateProject(targetProjectId);
    if (!targetProject) {
      return c.json({ error: "Target project not found" }, 404);
    }

    const metadata = deps.sessionMetadataService.getMetadata(sessionId);
    const identity = await resolveExistingSessionIdentity({
      sessionId,
      requestProjectId: projectId,
      metadata: metadata
        ? { ...metadata, workingProjectId: undefined }
        : undefined,
      scanner: deps.scanner,
      providerDeps: providerResolutionDeps(deps),
    });
    if (!identity) {
      return c.json({ error: "Session not found" }, 404);
    }
    const previousWorkingProjectId =
      metadata?.workingProjectId ?? identity.workingProjectId;
    const transcriptProjectId = identity.transcriptProjectId;

    const storedWorkingProjectId =
      targetProjectId === transcriptProjectId ? undefined : targetProjectId;
    const storedTranscriptProjectId =
      targetProjectId === transcriptProjectId ? undefined : transcriptProjectId;

    await deps.sessionMetadataService.setWorkingProject(
      sessionId,
      storedWorkingProjectId,
      storedTranscriptProjectId,
    );
    deps.projectQueueScheduler?.sessionProjectChanged(
      previousWorkingProjectId,
      targetProjectId,
    );

    deps.eventBus?.emit({
      type: "session-metadata-changed",
      sessionId,
      projectId: targetProjectId,
      transcriptProjectId: storedTranscriptProjectId ?? null,
      timestamp: new Date().toISOString(),
    });

    return c.json({
      updated: true,
      projectId: targetProjectId,
      transcriptProjectId: storedTranscriptProjectId ?? null,
    });
  });

  // POST /api/projects/:projectId/sessions/:sessionId/refresh-preview
  // On-demand recompute of the hover-card recent-activity excerpt for a
  // non-running session (its live state is otherwise only refreshed when the
  // session is resumed). Fast reverse-scan of the JSONL, then push the result
  // to lists/hovers via a session-updated event so the preview updates in
  // place without flicker. See topics/session-hovercard-recent-activity.md.
  routes.post(
    "/projects/:projectId/sessions/:sessionId/refresh-preview",
    async (c) => {
      const projectId = c.req.param("projectId");
      const sessionId = c.req.param("sessionId");
      if (!isUrlProjectId(projectId)) {
        return c.json({ error: "Invalid project ID format" }, 400);
      }
      const routing = await resolveSessionProjectRouting(
        projectId as UrlProjectId,
        sessionId,
      );
      if ("redirectProjectId" in routing) {
        return c.redirect(
          buildSessionProjectRedirectPath(
            routing.redirectProjectId,
            sessionId,
            "/refresh-preview",
            c.req.url,
          ),
          307,
        );
      }
      if ("error" in routing) {
        return c.json({ error: routing.error }, routing.status);
      }
      const transcriptProject = routing.transcriptProject;
      const transcriptProjectId = routing.transcriptProjectId;
      const metadataProvider = deps.sessionMetadataService?.getProvider(
        sessionId,
      ) as ProviderName | undefined;
      const recapMessages =
        deps.sessionMetadataService?.getRecapMessages?.(sessionId) ?? [];
      let lastAgentText: string | undefined;
      if (recapMessages.length > 0) {
        const summaryResult = await findSessionSummaryAcrossProviders(
          transcriptProject,
          sessionId,
          transcriptProjectId,
          providerResolutionDeps(deps),
          metadataProvider,
        );
        if (summaryResult?.summary) {
          lastAgentText = applyRecapOverlayToSummary(
            summaryResult.summary,
            recapMessages,
          ).lastAgentText;
        }
      }

      // Claude uses the fast reverse-scan when there is no durable overlay to
      // compare; every other provider goes through the cross-provider load +
      // normalize, then a shared extractor on the uniform message form.
      const sourceDeps = providerResolutionDeps(deps);
      const bound = boundSessionSource(
        transcriptProject,
        sessionId,
        sourceDeps,
      );
      const legacy =
        bound === undefined
          ? await resolveLegacySessionSource(
              {
                provider: transcriptProject.provider,
                reader: deps.readerFactory(transcriptProject),
                sessionDir: transcriptProject.sessionDir,
                kind: "primary",
              },
              sessionId,
              { ...transcriptProject, id: transcriptProjectId },
              sourceDeps,
            )
          : undefined;
      const readable = bound ?? legacy;
      lastAgentText ??= readable?.source.reader.getLastAgentExcerpt
        ? await readable.source.reader.getLastAgentExcerpt(
            readable.nativeSessionId,
          )
        : undefined;
      if (lastAgentText === undefined) {
        const normalized = await loadRestartSourceSession(
          transcriptProject,
          sessionId,
          transcriptProjectId,
          metadataProvider,
        );
        if (normalized) {
          lastAgentText = extractLastAgentExcerpt(normalized.messages);
        }
      }
      if (lastAgentText !== undefined) {
        deps.eventBus?.emit({
          type: "session-updated",
          sessionId,
          projectId: routing.workingProjectId,
          lastAgentText,
          timestamp: new Date().toISOString(),
        });
      }
      return c.json({ lastAgentText: lastAgentText ?? null });
    },
  );

  registerSessionDetailRoute(routes, deps, sessionDetailRouting);

  // POST /api/projects/:projectId/session-creations — accept initial input.
  const startProjectSession = async (c: Context) => {
    const projectId = c.req.param("projectId") ?? "";

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    let body: StartSessionBody;
    try {
      body = (await readLimitedJsonObject(
        c.req.raw,
        256 * 1024,
      )) as unknown as StartSessionBody;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const acceptance = creationAcceptance(c, body, projectId);
    if (acceptance instanceof Response) return acceptance;
    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project)
      return c.json({ error: "Project not found or path does not exist" }, 404);

    if (
      body.machineControl !== undefined &&
      typeof body.machineControl !== "boolean"
    )
      return c.json({ error: "machineControl must be a boolean" }, 400);
    if (body.computerControl)
      return c.json({ error: RETIRED_COMPUTER_CONTROL_ERROR }, 400);

    const modeError = permissionModeError(body.mode);
    if (modeError) {
      return c.json({ error: modeError }, 400);
    }

    if (!hasSessionMessageContent(body) && body.intent !== "prepare") {
      return c.json({ error: "Message is required" }, 400);
    }
    const { executor, error: executorError } = parseOptionalExecutor(
      body.executor,
    );
    if (executorError) {
      return c.json({ error: executorError }, 400);
    }
    // A limited user's session is sandboxed and obeys their lock, decided
    // here rather than in the form (topics/limited-users.md § Delivery v1).
    const limitedLaunch = applyLimitedLaunchPolicy(c, body);
    if (limitedLaunch.kind === "error") {
      return c.json({ error: limitedLaunch.error }, 403);
    }
    const sandboxSelection = parseSessionSandboxLevel(
      body.sandboxLevel,
      body.sandboxNetworkFirewall,
    );
    if ("error" in sandboxSelection) {
      return c.json({ error: sandboxSelection.error }, 400);
    }
    const helperSettings = parseHelperSettings(body);
    if (helperSettings.error) {
      return c.json({ error: helperSettings.error }, 400);
    }
    const sandboxSettingsError = getSessionSandboxSettingsError(
      sandboxSelection.sandboxLevel,
      helperSettings.recapMode,
    );
    if (sandboxSettingsError) {
      return c.json({ error: sandboxSettingsError }, 400);
    }
    if (body.workstreamId !== undefined) {
      return c.json({ error: "Managed checkout lanes have been removed" }, 410);
    }

    const serverTimestamp = Date.now();
    const userMessage: UserMessage = {
      text: body.message,
      images: body.images,
      documents: body.documents,
      attachments: body.attachments,
      mode: body.mode,
      tempId: body.tempId,
      metadata: buildUserMessageMetadata(
        body,
        serverTimestamp,
        "direct",
        actingUsername(c),
      ),
    };

    const { thinking, effort } = buildThinkingOptions(body);

    // Convert model option (undefined or "default" means use CLI default)
    const model =
      body.model && body.model !== "default" ? body.model : undefined;
    const serviceTier = normalizeOptionalServiceTier(body.serviceTier);

    // Debug: log what we received
    console.log("[startSession] Request body:", {
      provider: body.provider,
      executor,
      model: body.model,
      serviceTier,
    });

    const replay = acceptance.replay();
    if (replay) return replay;
    const operation = deps.supervisor.startSession(
      project.path,
      userMessage,
      body.mode,
      {
        model,
        requestedModel: body.model,
        serviceTier,
        thinking,
        effort,
        providerName: body.provider,
        routerAccountId: body.routerAccountId,
        routerPoolId: body.routerPoolId,
        routerPolicy: body.routerPolicy,
        routerClaudeAiConnectors: body.routerClaudeAiConnectors,
        computerControl: body.computerControl,
        machineControl: body.machineControl,
        desktopControlOrigin:
          body.machineControl === true ? desktopControlOrigin(c) : undefined,
        executor,
        sandboxLevel: sandboxSelection.sandboxLevel,
        sandboxNetworkFirewall: sandboxSelection.sandboxNetworkFirewall,
        instructionUsername: actingUsername(c),
        globalInstructions: getGlobalInstructions(),
        permissions: body.permissions,
        recapMode: helperSettings.recapMode,
        recapAfterSeconds: helperSettings.recapAfterSeconds,
        promptSuggestionMode: helperSettings.promptSuggestionMode,
        helperSideModel: helperSettings.helperSideModel,
        ...resolveCompactModelSettings(deps, {
          provider: body.provider ?? project.provider,
          yaModelId: body.model,
          modelCandidates: [body.model, model],
        }),
      },
      {
        projectId: project.id,
        creation: acceptance.creation,
      },
    );

    void operation.then(acceptance.finished, acceptance.failed);
    const saved = await acceptance.promise.catch(acceptance.refused);
    if (saved instanceof Response) return saved;
    void deps.userUsageService?.recordSession(actingUsername(c));
    if (body.intent !== "prepare")
      void deps.userUsageService?.recordTurn(
        actingUsername(c),
        userMessage.text,
      );
    return c.json(sessionCreationReceipt(saved), 202);
  };
  routes.post("/projects/:projectId/session-creations", startProjectSession);

  // POST /api/session-creations — accept a detached session.
  const startDetachedSession = async (c: Context) => {
    let body: StartSessionBody;
    try {
      body = (await readLimitedJsonObject(
        c.req.raw,
        256 * 1024,
      )) as unknown as StartSessionBody;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const acceptance = creationAcceptance(c, body, "detached");
    if (acceptance instanceof Response) return acceptance;

    if (
      body.machineControl !== undefined &&
      typeof body.machineControl !== "boolean"
    )
      return c.json({ error: "machineControl must be a boolean" }, 400);
    if (body.computerControl)
      return c.json({ error: RETIRED_COMPUTER_CONTROL_ERROR }, 400);

    const limitedLaunch = applyLimitedLaunchPolicy(c, body);
    if (limitedLaunch.kind === "error")
      return c.json({ error: limitedLaunch.error }, 403);

    const modeError = permissionModeError(body.mode);
    if (modeError) {
      return c.json({ error: modeError }, 400);
    }

    if (!hasSessionMessageContent(body) && body.intent !== "prepare") {
      return c.json({ error: "Message is required" }, 400);
    }
    const { executor, error: executorError } = parseOptionalExecutor(
      body.executor,
    );
    if (executorError) {
      return c.json({ error: executorError }, 400);
    }
    const sandboxSelection = parseSessionSandboxLevel(
      body.sandboxLevel,
      body.sandboxNetworkFirewall,
    );
    if ("error" in sandboxSelection) {
      return c.json({ error: sandboxSelection.error }, 400);
    }
    const helperSettings = parseHelperSettings(body);
    if (helperSettings.error) {
      return c.json({ error: helperSettings.error }, 400);
    }
    const sandboxSettingsError = getSessionSandboxSettingsError(
      sandboxSelection.sandboxLevel,
      helperSettings.recapMode,
    );
    if (sandboxSettingsError) {
      return c.json({ error: sandboxSettingsError }, 400);
    }

    const projectPath = await ensureDetachedProjectPath(
      executor,
      actingUsername(c),
    );
    const serverTimestamp = Date.now();
    const userMessage: UserMessage = {
      text: body.message,
      images: body.images,
      documents: body.documents,
      attachments: body.attachments,
      mode: body.mode,
      tempId: body.tempId,
      metadata: buildUserMessageMetadata(
        body,
        serverTimestamp,
        "direct",
        actingUsername(c),
      ),
    };

    const { thinking, effort } = buildThinkingOptions(body);
    const model =
      body.model && body.model !== "default" ? body.model : undefined;
    const serviceTier = normalizeOptionalServiceTier(body.serviceTier);

    const replay = acceptance.replay();
    if (replay) return replay;
    const operation = deps.supervisor.startSession(
      projectPath,
      userMessage,
      body.mode,
      {
        model,
        requestedModel: body.model,
        serviceTier,
        thinking,
        effort,
        providerName: body.provider,
        routerAccountId: body.routerAccountId,
        routerPoolId: body.routerPoolId,
        routerPolicy: body.routerPolicy,
        routerClaudeAiConnectors: body.routerClaudeAiConnectors,
        computerControl: body.computerControl,
        machineControl: body.machineControl,
        desktopControlOrigin:
          body.machineControl === true ? desktopControlOrigin(c) : undefined,
        executor,
        sandboxLevel: sandboxSelection.sandboxLevel,
        sandboxNetworkFirewall: sandboxSelection.sandboxNetworkFirewall,
        globalInstructions: getGlobalInstructions(),
        instructionUsername: actingUsername(c),
        permissions: body.permissions,
        recapMode: helperSettings.recapMode,
        recapAfterSeconds: helperSettings.recapAfterSeconds,
        promptSuggestionMode: helperSettings.promptSuggestionMode,
        helperSideModel: helperSettings.helperSideModel,
      },
      {
        creation: acceptance.creation,
      },
    );

    void operation.then(acceptance.finished, acceptance.failed);
    const saved = await acceptance.promise.catch(acceptance.refused);
    if (saved instanceof Response) return saved;
    void deps.userUsageService?.recordSession(actingUsername(c));
    if (body.intent !== "prepare")
      void deps.userUsageService?.recordTurn(
        actingUsername(c),
        userMessage.text,
      );
    return c.json(sessionCreationReceipt(saved), 202);
  };
  routes.post("/session-creations", startDetachedSession);

  // POST /api/projects/:projectId/sessions/:sessionId/resume - Resume session
  routes.post("/projects/:projectId/sessions/:sessionId/resume", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const requestProject = await deps.scanner.getOrCreateProject(projectId);
    if (!requestProject) {
      return c.json({ error: "Project not found or path does not exist" }, 404);
    }

    let body: StartSessionBody;
    try {
      body = await c.req.json<StartSessionBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (
      body.routerAccountId !== undefined ||
      body.routerPoolId !== undefined ||
      body.routerPolicy !== undefined ||
      body.routerClaudeAiConnectors !== undefined
    ) {
      return c.json(
        {
          error:
            "Router account selection is only supported when creating a session; resumed sessions retain their pin",
        },
        400,
      );
    }

    const modeError = permissionModeError(body.mode);
    if (modeError) {
      return c.json({ error: modeError }, 400);
    }

    if (!hasSessionMessageContent(body)) {
      return c.json({ error: "Message is required" }, 400);
    }
    const parsedBodyExecutor = parseOptionalExecutor(body.executor);
    if (parsedBodyExecutor.error) {
      return c.json({ error: parsedBodyExecutor.error }, 400);
    }
    const helperSettings = parseHelperSettings(body);
    if (helperSettings.error) {
      return c.json({ error: helperSettings.error }, 400);
    }
    const parsedResumeMode = parseOptionalResumeMode(body.resumeMode);
    if (parsedResumeMode.error) {
      return c.json({ error: parsedResumeMode.error }, 400);
    }
    const resumeMode = parsedResumeMode.resumeMode ?? "full";
    const persistedMetadata =
      deps.sessionMetadataService?.getMetadata?.(sessionId);
    const metadataProvider = deps.sessionMetadataService?.getProvider(
      sessionId,
    ) as ProviderName | undefined;
    const identity = await resolveExistingSessionIdentity({
      sessionId,
      requestProjectId: projectId,
      preferredProvider: body.provider,
      requestFallbackProvider: requestProject.provider,
      metadata: persistedMetadata,
      scanner: deps.scanner,
      providerDeps: providerResolutionDeps(deps),
    });
    if (!identity) {
      return c.json({ error: "Session not found" }, 404);
    }
    const settledSandboxLevel = persistedMetadata?.sandboxLevel ?? "none";
    const settledSandboxNetworkFirewall =
      persistedSandboxNetworkFirewall(persistedMetadata);
    if (
      body.sandboxLevel !== undefined ||
      body.sandboxNetworkFirewall !== undefined
    ) {
      const requestedSandbox = parseSessionSandboxLevel(
        body.sandboxLevel,
        body.sandboxNetworkFirewall,
        settledSandboxLevel,
        settledSandboxNetworkFirewall,
      );
      if ("error" in requestedSandbox) {
        return c.json({ error: requestedSandbox.error }, 400);
      }
      if (
        requestedSandbox.sandboxLevel !== settledSandboxLevel ||
        requestedSandbox.sandboxNetworkFirewall !==
          settledSandboxNetworkFirewall
      ) {
        return c.json(
          {
            error:
              "The session sandbox boundary is settled at creation and cannot change on resume",
          },
          409,
        );
      }
    }

    const serverTimestamp = Date.now();
    const userMessage: UserMessage = {
      text: body.message,
      images: body.images,
      documents: body.documents,
      attachments: body.attachments,
      mode: body.mode,
      tempId: body.tempId,
      metadata: buildUserMessageMetadata(
        body,
        serverTimestamp,
        "direct",
        actingUsername(c),
      ),
    };

    const providerName = body.provider ?? metadataProvider ?? identity.provider;
    const previousProcess = deps.supervisor.getProcessForSession?.(sessionId);
    const resumeDiagnostics = {
      requestedMode: resumeMode,
      provider: providerName,
      previousProcess: previousProcess
        ? {
            processId: previousProcess.id,
            state: previousProcess.state.type,
            provider: previousProcess.provider,
            supportsDynamicCommands: previousProcess.supportsDynamicCommands,
          }
        : null,
    };

    let resumeSessionAt: string | undefined;
    // A recorded same-session rewind is applied by the supervisor at process
    // launch, whichever path starts the process (topics/session-rewind.md);
    // it wins over the API-error truncation below, whose blocker check is
    // skipped here because the dropped tail is already accounted for.
    const pendingRewind =
      deps.sessionMetadataService?.getPendingRewind?.(sessionId);
    if (!pendingRewind && isClaudeSdkProviderName(providerName)) {
      let blocker: ClaudeResumeApiErrorBlocker | null = null;
      try {
        blocker = await getClaudeResumeBlockerFromReader(
          deps.readerFactory(
            { ...identity.transcriptProject, provider: identity.provider },
            identity.native,
          ),
          identity.native?.id ?? sessionId,
          identity.transcriptProjectId,
        );
      } catch (error) {
        getLogger().warn(
          {
            event: "claude_resume_api_error_check_failed",
            sessionId,
            projectId,
            providerName,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to check Claude session for resume-blocking API error",
        );
      }

      if (blocker?.resumeAtMessageId) {
        // Recoverable: resume up to the last good assistant message,
        // dropping the API-error tail, instead of forcing a handoff.
        resumeSessionAt = blocker.resumeAtMessageId;
        getLogger().info(
          {
            event: "claude_resume_truncated_after_api_error",
            sessionId,
            projectId,
            providerName,
            messageId: blocker.messageId,
            apiErrorStatus: blocker.apiErrorStatus,
            resumeSessionAt,
          },
          "Resuming Claude session before SDK API-error tail",
        );
      } else if (blocker) {
        getLogger().warn(
          {
            event: "claude_resume_blocked_after_api_error",
            sessionId,
            projectId,
            providerName,
            messageId: blocker.messageId,
            apiErrorStatus: blocker.apiErrorStatus,
          },
          "Blocked Claude provider resume after SDK API-error message",
        );
        return c.json(
          {
            error: blocker.error,
            recovery: blocker.recovery,
            resume: {
              ...resumeDiagnostics,
              blockedReason: "claude-api-error-tail",
            },
          },
          409,
        );
      }
    }

    const launch = buildResumeLaunch({
      sessionId,
      providerName,
      workingProjectPath: identity.workingProject.path,
      previousResolvedModel: previousProcess?.resolvedModel,
      request: {
        model: body.model,
        serviceTier: normalizeOptionalServiceTier(body.serviceTier),
        ...buildThinkingOptions(body),
        executor: parsedBodyExecutor.executor,
        permissions: body.permissions,
        recapMode: helperSettings.recapMode,
        recapAfterSeconds: helperSettings.recapAfterSeconds,
        promptSuggestionMode: helperSettings.promptSuggestionMode,
        helperSideModel: helperSettings.helperSideModel,
        resumeMode,
        resumeSessionAt,
      },
    });
    if ("error" in launch) {
      return c.json({ error: launch.error }, 400);
    }
    const { settings: resumeSettings, projectPath: resumeProjectPath } = launch;
    // A limited user resumes only a sandboxed session, on this host, inside
    // their lock (topics/limited-users.md § Delivery v1).
    const limitedResume = applyLimitedResumePolicy(c, resumeSettings, body);
    if (limitedResume.kind === "error") {
      return c.json({ error: limitedResume.error }, 403);
    }

    let result: Awaited<ReturnType<Supervisor["resumeSession"]>>;
    try {
      result = await deps.supervisor.resumeSession(
        sessionId,
        resumeProjectPath,
        userMessage,
        body.mode,
        resumeSettings,
        { requireProviderSessionId: true },
      );
    } catch (error) {
      if (error instanceof ResumeCompactionError) {
        getLogger().warn(
          {
            event: "resume_compaction_failed",
            sessionId,
            projectId,
            providerName,
            attempt: error.attempt,
          },
          "Compact-first resume failed",
        );
        return c.json(
          {
            error: error.message,
            recovery: error.recovery,
            resume: {
              ...resumeDiagnostics,
              compaction: error.attempt,
            },
          },
          409,
        );
      }
      if (error instanceof SessionMessageRejectedError) {
        return c.json({ error: error.message, reason: error.message }, 409);
      }
      if (error instanceof RetryableSessionLaunchError) {
        getLogger().warn(
          {
            event: "provider_resume_attachment_failed",
            sessionId,
            projectId,
            providerName,
            error: error.message,
          },
          "Provider resume failed before native session attachment",
        );
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }

    // Check if queue is full
    if (isQueueFullResponse(result)) {
      return c.json(
        { error: "Queue is full", maxQueueSize: result.maxQueueSize },
        503,
      );
    }

    // Check if request was queued
    if (isQueuedResponse(result)) {
      void deps.userUsageService?.recordTurn(
        actingUsername(c),
        userMessage.text,
      );
      return c.json(
        {
          ...result,
          serverTimestamp: Date.now(),
          resume: { ...resumeDiagnostics, outcome: "queued" },
        },
        202,
      ); // 202 Accepted - queued for processing
    }
    void deps.userUsageService?.recordTurn(actingUsername(c), userMessage.text);

    return c.json({
      processId: result.id,
      permissionMode: result.permissionMode,
      appliedPermissionMode: result.appliedPermissionMode,
      modeVersion: result.modeVersion,
      recapAfterSeconds: result.recapAfterSeconds,
      sandboxEnforcement: result.sandboxEnforcement,
      serverTimestamp,
      resume: {
        ...resumeDiagnostics,
        outcome: "started",
        compaction:
          resumeMode === "compact-first" ? { status: "completed" } : undefined,
      },
    });
  });

  // POST /api/projects/:projectId/sessions/:sessionId/reactivate
  // Spawn or reconcile a live harness process without delivering a turn. Every
  // request is validated and serialized, including when the session is already
  // owned or another activation is still in flight.
  routes.use(
    "/projects/:projectId/sessions/:sessionId/reactivate",
    async (c, next) => {
      const projectId = c.req.param("projectId");
      if (!isUrlProjectId(projectId) || !deps.projectQueueScheduler) {
        await next();
        return;
      }

      const release = deps.projectQueueScheduler.reserveUserSessionStart(
        projectId,
        c.req.param("sessionId"),
      );
      try {
        await next();
      } finally {
        release();
      }
    },
  );
  routes.post(
    "/projects/:projectId/sessions/:sessionId/reactivate",
    async (c) => {
      const projectId = c.req.param("projectId");
      const sessionId = c.req.param("sessionId");

      if (!isUrlProjectId(projectId)) {
        return c.json({ error: "Invalid project ID format" }, 400);
      }

      const parsedBody = parseOptionalReactivateSessionBody(await c.req.text());
      if ("error" in parsedBody) {
        return c.json({ error: parsedBody.error }, 400);
      }
      const body = parsedBody.body;
      const modeError = permissionModeError(body.mode);
      if (modeError) {
        return c.json({ error: modeError }, 400);
      }
      const parsedBodyExecutor = parseOptionalExecutor(body.executor);
      if (parsedBodyExecutor.error) {
        return c.json({ error: parsedBodyExecutor.error }, 400);
      }
      const helperSettings = parseHelperSettings(body);
      if (helperSettings.error) {
        return c.json({ error: helperSettings.error }, 400);
      }
      const requestProject = await deps.scanner.getOrCreateProject(projectId);
      if (!requestProject) {
        return c.json(
          { error: "Project not found or path does not exist" },
          404,
        );
      }

      const metadata = deps.sessionMetadataService?.getMetadata?.(sessionId);
      const parsedSandbox = parseSessionSandboxLevel(
        body.sandboxLevel,
        body.sandboxNetworkFirewall,
        metadata?.sandboxLevel ?? "none",
        persistedSandboxNetworkFirewall(metadata),
      );
      if ("error" in parsedSandbox) {
        return c.json({ error: parsedSandbox.error }, 400);
      }
      const hasProvider = Object.hasOwn(body, "provider");
      const hasExecutor = Object.hasOwn(body, "executor");
      const hasModel = Object.hasOwn(body, "model");
      const hasServiceTier = Object.hasOwn(body, "serviceTier");
      const hasThinking = Object.hasOwn(body, "thinking");
      const hasSandbox =
        Object.hasOwn(body, "sandboxLevel") ||
        Object.hasOwn(body, "sandboxNetworkFirewall");
      const hasPermissions = Object.hasOwn(body, "permissions");
      const hasRecapMode = Object.hasOwn(body, "recapMode");
      const hasRecapAfterSeconds = Object.hasOwn(body, "recapAfterSeconds");
      const hasPromptSuggestionMode = Object.hasOwn(
        body,
        "promptSuggestionMode",
      );
      const hasHelperSideModel = Object.hasOwn(body, "helperSideModel");

      const existingProcess = deps.supervisor.getProcessForSession?.(sessionId);
      const identity = existingProcess
        ? null
        : await resolveExistingSessionIdentity({
            sessionId,
            requestProjectId: projectId,
            preferredProvider: hasProvider
              ? body.provider
              : (metadata?.provider as ProviderName | undefined),
            metadata,
            scanner: deps.scanner,
            providerDeps: providerResolutionDeps(deps),
          });
      if (!existingProcess && !identity) {
        return c.json({ error: "Session not found" }, 404);
      }
      let providerName = hasProvider
        ? body.provider
        : (metadata?.provider as ProviderName | undefined);
      if (!providerName) {
        providerName = existingProcess?.provider ?? identity?.provider;
      }
      if (!providerName) {
        return c.json({ error: "Session provider not found" }, 404);
      }
      const executor = hasExecutor
        ? parsedBodyExecutor.executor
        : metadata?.executor;
      const requestedModel = hasModel ? body.model : metadata?.requestedModel;
      const model =
        requestedModel && requestedModel !== "default"
          ? requestedModel
          : undefined;
      const serviceTier = normalizeOptionalServiceTier(body.serviceTier);
      const thinkingOptions = hasThinking
        ? buildThinkingOptions(body)
        : undefined;
      const sandboxLevel = hasSandbox
        ? parsedSandbox.sandboxLevel
        : metadata?.sandboxLevel;
      const sandboxNetworkFirewall = hasSandbox
        ? parsedSandbox.sandboxNetworkFirewall
        : metadata?.sandboxLevel === "project-write" &&
          metadata.sandboxNetworkFirewall !== false;
      const recapMode = hasRecapMode
        ? helperSettings.recapMode
        : metadata?.recapMode;
      const recapAfterSeconds = hasRecapAfterSeconds
        ? helperSettings.recapAfterSeconds
        : metadata?.recapAfterSeconds;
      const promptSuggestionMode = hasPromptSuggestionMode
        ? helperSettings.promptSuggestionMode
        : metadata?.promptSuggestionMode;
      const sandboxSettingsError = getSessionSandboxSettingsError(
        sandboxLevel,
        recapMode,
      );
      if (sandboxSettingsError) {
        return c.json({ error: sandboxSettingsError }, 400);
      }

      const coldSettings: ModelSettings = {
        model,
        requestedModel,
        ...(hasServiceTier ? { serviceTier } : {}),
        ...thinkingOptions,
        providerName,
        executor,
        ...(hasPermissions
          ? { permissions: body.permissions ?? undefined }
          : {}),
        ...(hasSandbox || sandboxLevel === "project-write"
          ? {
              sandboxLevel,
              sandboxNetworkFirewall,
              sandboxStateKey: metadata?.sandboxStateKey,
            }
          : {}),
        globalInstructions: getGlobalInstructions(),
        recapAfterSeconds,
        recapMode,
        promptSuggestionMode,
        ...(hasHelperSideModel
          ? { helperSideModel: helperSettings.helperSideModel }
          : {}),
        ...resolveCompactModelSettings(deps, {
          provider: providerName,
          yaModelId: requestedModel,
          modelCandidates: [requestedModel, model],
        }),
      };
      const overrideModelSettings: ModelSettings = {
        ...(hasModel ? { model, requestedModel: body.model } : {}),
        ...(hasServiceTier ? { serviceTier } : {}),
        ...thinkingOptions,
        ...(hasProvider ? { providerName: body.provider } : {}),
        ...(hasExecutor ? { executor: parsedBodyExecutor.executor } : {}),
        ...(hasPermissions
          ? { permissions: body.permissions ?? undefined }
          : {}),
        ...(hasSandbox
          ? {
              sandboxLevel: parsedSandbox.sandboxLevel,
              sandboxNetworkFirewall: parsedSandbox.sandboxNetworkFirewall,
              sandboxStateKey: metadata?.sandboxStateKey,
            }
          : {}),
        ...(hasRecapMode ? { recapMode: helperSettings.recapMode } : {}),
        ...(hasRecapAfterSeconds
          ? { recapAfterSeconds: helperSettings.recapAfterSeconds }
          : {}),
        ...(hasPromptSuggestionMode
          ? { promptSuggestionMode: helperSettings.promptSuggestionMode }
          : {}),
        ...(hasHelperSideModel
          ? { helperSideModel: helperSettings.helperSideModel }
          : {}),
      };
      // A limited user reactivates only a sandboxed session, on this host,
      // inside their lock (topics/limited-users.md § Delivery v1). The cold
      // settings already carry every override the body named, so checking
      // them covers both; an override the lock then replaced follows it.
      const limitedReactivate = applyLimitedResumePolicy(c, coldSettings, body);
      if (limitedReactivate.kind === "error") {
        return c.json({ error: limitedReactivate.error }, 403);
      }
      if (limitedReactivate.kind === "applied") {
        for (const field of [
          "model",
          "requestedModel",
          "thinking",
          "effort",
        ] as const) {
          if (Object.hasOwn(overrideModelSettings, field)) {
            (overrideModelSettings as Record<string, unknown>)[field] =
              coldSettings[field];
          }
        }
      }
      const requestedOverrides: SessionReactivationOverrides = {
        ...(Object.hasOwn(body, "mode") && body.mode !== undefined
          ? { permissionMode: body.mode }
          : {}),
        ...(Object.keys(overrideModelSettings).length > 0
          ? { modelSettings: overrideModelSettings }
          : {}),
      };
      const reactivationProjectPath =
        sandboxLevel === "project-write"
          ? (metadata?.sandboxProjectPath ??
            existingProcess?.projectPath ??
            identity?.workingProject.path ??
            requestProject.path)
          : (existingProcess?.projectPath ??
            identity?.workingProject.path ??
            requestProject.path);
      const reservationProjectId =
        existingProcess?.projectId ?? identity?.workingProjectId ?? projectId;
      const release =
        reservationProjectId === projectId
          ? undefined
          : deps.projectQueueScheduler?.reserveUserSessionStart(
              reservationProjectId,
              sessionId,
            );

      let process: Process;
      try {
        process = await deps.supervisor.reactivateSession(
          reactivationProjectPath,
          sessionId,
          body.mode,
          coldSettings,
          { requestedOverrides },
        );
      } catch (error) {
        return c.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "Failed to reactivate session",
          },
          error instanceof SessionConfigurationConflictError ? 409 : 503,
        );
      } finally {
        release?.();
      }

      return c.json({
        processId: process.id,
        permissionMode: process.permissionMode,
        appliedPermissionMode: process.appliedPermissionMode,
        modeVersion: process.modeVersion,
        recapAfterSeconds: process.recapAfterSeconds,
        sandboxEnforcement: process.sandboxEnforcement,
        serverTimestamp: Date.now(),
      });
    },
  );

  // POST /api/projects/:projectId/sessions/:sessionId/recap
  // Away-recap trigger, keyed by session (not process) so it survives a server
  // restart that killed the process. A live process recaps directly in its own
  // mode; a cold fork-mode session is revived — without ever preempting a live
  // worker — and recapped from its on-disk transcript. See topics/fork-recap.md.
  routes.post("/projects/:projectId/sessions/:sessionId/recap", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    let sinceMs: number | null = null;
    try {
      const body = await c.req.json<{ hiddenSinceMs?: unknown }>();
      if (
        typeof body.hiddenSinceMs === "number" &&
        Number.isFinite(body.hiddenSinceMs)
      ) {
        sinceMs = body.hiddenSinceMs;
      }
    } catch {
      // Empty body is accepted.
    }

    // Live process: recap directly in whatever mode it runs.
    const live = deps.supervisor.getProcessForSession(sessionId);
    if (live && !live.isTerminated) {
      const result = await deps.supervisor.requestRecap(live.id, { sinceMs });
      return c.json(result);
    }

    // Cold session: only fork mode can recap from the on-disk transcript —
    // side-session/native recaps need in-memory recent text a revived process
    // lacks. Other modes simply skip until the session is live again.
    const metadata = deps.sessionMetadataService?.getMetadata?.(sessionId);
    if (deps.supervisor.isRecapPausedUntilUserTurn(sessionId)) {
      return c.json({
        supported: true,
        emitted: false,
        reason: "recaps paused until next user turn",
      });
    }
    if (!isAutomaticSessionResumeAllowed(metadata)) {
      return c.json({
        supported: true,
        emitted: false,
        reason: "recap skipped: automatic resume disabled",
      });
    }
    const recapMode =
      metadata?.recapMode ??
      deps.sessionMetadataService?.getRecapMode?.(sessionId);
    const sandboxSettingsError = getSessionSandboxSettingsError(
      metadata?.sandboxLevel,
      recapMode,
    );
    if (sandboxSettingsError) {
      return c.json({
        supported: false,
        emitted: false,
        reason: sandboxSettingsError,
      });
    }
    if (recapMode !== "fork") {
      return c.json({
        supported: true,
        emitted: false,
        reason: "recap requires a live process for this recap mode",
      });
    }

    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found or path does not exist" }, 404);
    }

    const providerName =
      (metadata?.provider as ProviderName | undefined) ?? project.provider;
    const rawModel = metadata?.requestedModel;
    const model = rawModel && rawModel !== "default" ? rawModel : undefined;

    let process: Process;
    try {
      const recapProjectPath =
        metadata?.sandboxLevel === "project-write"
          ? (metadata.sandboxProjectPath ?? project.path)
          : project.path;
      process = await deps.supervisor.reactivateSession(
        recapProjectPath,
        sessionId,
        undefined,
        {
          model,
          providerName,
          executor: metadata?.executor,
          ...inheritedSandboxSettings(metadata),
          globalInstructions: getGlobalInstructions(),
          recapAfterSeconds: metadata?.recapAfterSeconds,
          recapMode: "fork",
        },
        { preempt: false, requestedOverrides: {} },
      );
    } catch (error) {
      // At capacity with no idle worker to drop (background recaps never
      // preempt), or reactivation failed — skip the recap rather than error.
      const atCapacity =
        error instanceof Error && error.message.includes("worker capacity");
      return c.json({
        supported: true,
        emitted: false,
        reason: atCapacity
          ? "recap skipped: at worker capacity"
          : "recap skipped: session could not be revived",
      });
    }

    const result = await deps.supervisor.requestRecap(process.id, {
      sinceMs,
      revived: true,
    });
    return c.json(result);
  });

  /**
   * The text a handoff successor would receive. Shared by the preview route
   * and the restart itself, so the draft a user edits and the message an
   * unedited handoff sends are built the same way.
   */
  const buildHandoffText = async (params: {
    project: Project;
    projectId: UrlProjectId;
    sessionId: string;
    handoffTitle: string;
    sourceSession: Session;
    sourceProvider: ProviderName;
    oldProcess?: Process;
    sourceUrl?: string;
    targetExecutor?: string;
    projectPath: string;
    purpose?: "restart" | "cold-session";
  }): Promise<string> => {
    const { transcript, omittedCount } = buildRestartTranscript(
      params.sourceSession.messages,
    );
    // The provider's reader knows where the source session's transcript lives
    // on disk; surface it so the successor can grep/read for any detail the
    // bounded summary above dropped. Best-effort — omitted when unavailable.
    const sourceReader = await resolveSessionReader({
      deps,
      project: params.project,
      sessionId: params.sessionId,
      projectId: params.projectId,
    });
    const sourceTranscriptPath =
      (sourceReader
        ? await sourceReader.reader.getSessionFilePath?.(
            sourceReader.nativeSessionId,
          )
        : undefined) ?? undefined;
    return buildRestartHandoff({
      handoffTitle: params.handoffTitle,
      sourceSession: params.sourceSession,
      sourceProvider: params.sourceProvider,
      sourceModel:
        params.oldProcess?.resolvedModel ?? params.sourceSession.model,
      sourceProcess: params.oldProcess,
      sourceUrl: params.sourceUrl,
      sourceTranscriptPath,
      sourceTranscriptHost: hostname(),
      targetExecutor: params.targetExecutor,
      projectPath: params.projectPath,
      omittedCount,
      transcript,
      purpose: params.purpose,
    });
  };

  // GET /api/projects/:projectId/sessions/:sessionId/restart/handoff
  // The handoff text as it stands now, so the client can offer it as an
  // editable draft. Compacts first, exactly as the handoff path does, so the
  // draft shows the boundary a real handoff would carry. Unlike the restart
  // itself this never interrupts the source process: previewing is not
  // starting, and a user who closes the dialog keeps their session running.
  routes.get(
    "/projects/:projectId/sessions/:sessionId/restart/handoff",
    async (c) => {
      const projectId = c.req.param("projectId");
      const sessionId = c.req.param("sessionId");

      if (!isUrlProjectId(projectId)) {
        return c.json({ error: "Invalid project ID format" }, 400);
      }

      const project = await deps.scanner.getOrCreateProject(projectId);
      if (!project) {
        return c.json(
          { error: "Project not found or path does not exist" },
          404,
        );
      }

      const oldProcess = deps.supervisor.getProcessForSession(sessionId);
      const metadataProvider = deps.sessionMetadataService?.getProvider(
        sessionId,
      ) as ProviderName | undefined;
      const preferredSourceProvider =
        metadataProvider ?? oldProcess?.provider ?? project.provider;
      const compact = await tryRestartCompact(oldProcess);
      const sourceSession = await loadRestartSourceSession(
        project,
        sessionId,
        projectId,
        preferredSourceProvider,
        oldProcess,
      );
      if (!sourceSession) {
        return c.json({ error: "Session not found" }, 404);
      }

      const originalMetadata =
        deps.sessionMetadataService?.getMetadata?.(sessionId);
      const parsedExecutor = parseOptionalExecutor(
        deps.sessionMetadataService?.getExecutor(sessionId),
      );
      if (parsedExecutor.error) {
        return c.json({ error: parsedExecutor.error }, 400);
      }
      const handoffTitle = deriveRestartTitle({
        preferredTitle: originalMetadata?.customTitle,
        sourceSession,
      });
      const handoff = await buildHandoffText({
        project,
        projectId,
        sessionId,
        handoffTitle,
        sourceSession,
        sourceProvider: sourceSession.provider ?? preferredSourceProvider,
        oldProcess,
        sourceUrl: c.req.query("sourceUrl"),
        targetExecutor: parsedExecutor.executor,
        projectPath:
          originalMetadata?.sandboxLevel === "project-write"
            ? (originalMetadata.sandboxProjectPath ?? project.path)
            : project.path,
      });

      // The compact status explains a draft that carries no compact summary
      // without making the client parse the text for one.
      return c.json({ handoff, handoffTitle, compactStatus: compact.status });
    },
  );

  // POST /api/projects/:projectId/sessions/:sessionId/restart
  // Start a fresh session from a bounded handoff, then terminate the old YA-owned process.
  routes.post("/projects/:projectId/sessions/:sessionId/restart", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");
    if (isRoutedSession(sessionId)) {
      return c.json(
        { error: routedSessionUnsupportedMessage("Restart and handoff") },
        409,
      );
    }

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const parsedBody = parseOptionalRestartSessionBody(await c.req.text());
    if ("error" in parsedBody) {
      return c.json({ error: parsedBody.error }, 400);
    }
    const { body } = parsedBody;

    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found or path does not exist" }, 404);
    }

    const modeError = permissionModeError(body.mode);
    if (modeError) {
      return c.json({ error: modeError }, 400);
    }

    const parsedHandoffText = parseRestartHandoffText(body.handoffText);
    if ("error" in parsedHandoffText) {
      return c.json({ error: parsedHandoffText.error }, 400);
    }
    const { handoffText } = parsedHandoffText;

    const parsedBodyExecutor = parseOptionalExecutor(body.executor);
    if (parsedBodyExecutor.error) {
      return c.json({ error: parsedBodyExecutor.error }, 400);
    }
    const helperSettings = parseHelperSettings(body);
    if (helperSettings.error) {
      return c.json({ error: helperSettings.error }, 400);
    }
    const originalMetadata =
      deps.sessionMetadataService?.getMetadata?.(sessionId);
    const originalSandboxLevel = originalMetadata?.sandboxLevel ?? "none";
    const originalSandboxNetworkFirewall =
      originalSandboxLevel === "project-write" &&
      originalMetadata?.sandboxNetworkFirewall !== false;
    const requestedRestartSandbox = parseSessionSandboxLevel(
      body.sandboxLevel,
      body.sandboxNetworkFirewall,
      originalSandboxLevel,
      originalSandboxNetworkFirewall,
    );
    if ("error" in requestedRestartSandbox) {
      return c.json({ error: requestedRestartSandbox.error }, 400);
    }
    const restartSandboxLevel = requestedRestartSandbox.sandboxLevel;
    const restartSandboxNetworkFirewall =
      requestedRestartSandbox.sandboxNetworkFirewall;
    const sandboxSettingsError = getSessionSandboxSettingsError(
      restartSandboxLevel,
      helperSettings.recapMode ?? originalMetadata?.recapMode,
    );
    if (sandboxSettingsError) {
      return c.json({ error: sandboxSettingsError }, 400);
    }

    let executor = parsedBodyExecutor.executor;
    if (!executor) {
      const parsedSavedExecutor = parseOptionalExecutor(
        deps.sessionMetadataService?.getExecutor(sessionId),
      );
      if (parsedSavedExecutor.error) {
        return c.json({ error: parsedSavedExecutor.error }, 400);
      }
      executor = parsedSavedExecutor.executor;
    }

    const restartMode = body.restartMode ?? "handoff";
    if (
      restartSandboxLevel !== originalSandboxLevel ||
      restartSandboxNetworkFirewall !== originalSandboxNetworkFirewall
    ) {
      return c.json(
        {
          error:
            "A restarted session inherits the source sandbox boundary and cannot change it",
        },
        409,
      );
    }
    const restartProjectPath =
      originalMetadata?.sandboxLevel === "project-write"
        ? (originalMetadata.sandboxProjectPath ?? project.path)
        : project.path;

    const oldProcess = deps.supervisor.getProcessForSession(sessionId);
    const metadataProvider = deps.sessionMetadataService?.getProvider(
      sessionId,
    ) as ProviderName | undefined;
    const preferredSourceProvider =
      metadataProvider ?? oldProcess?.provider ?? project.provider;
    let sourceSession: Session | null = null;

    // Fork validation must use the source transcript, but it must not disturb
    // the source process until every unsupported request has been rejected.
    if (restartMode === "fork") {
      sourceSession = await loadRestartSourceSession(
        project,
        sessionId,
        projectId,
        preferredSourceProvider,
        oldProcess,
      );
      if (!sourceSession) {
        return c.json({ error: "Session not found" }, 404);
      }
      const forkSourceProvider =
        sourceSession.provider ?? preferredSourceProvider;
      if (body.provider && body.provider !== forkSourceProvider) {
        return c.json(
          {
            error:
              "Fork keeps the source provider; omit provider or match the source session",
          },
          400,
        );
      }
      if (!deps.supervisor.supportsForkSession(forkSourceProvider)) {
        return c.json(
          { error: `${forkSourceProvider} does not support transcript fork` },
          400,
        );
      }
    }

    // Fork copies the transcript as-is. Handoff first asks the provider to
    // compact so the bounded transcript can include that boundary when one is
    // available. A supplied draft was already built from a compacted
    // transcript by the preview route, so compacting again would only spend
    // tokens to produce a boundary this restart will not read.
    if (restartMode !== "fork" && handoffText === undefined) {
      await tryRestartCompact(oldProcess);
    }
    const oldProcessInterrupted =
      await interruptOldProcessForHandoff(oldProcess);
    if (restartMode !== "fork") {
      sourceSession = await loadRestartSourceSession(
        project,
        sessionId,
        projectId,
        preferredSourceProvider,
        oldProcess,
      );
    }
    if (!sourceSession) {
      return c.json({ error: "Session not found" }, 404);
    }

    const sourceProvider = sourceSession.provider ?? preferredSourceProvider;
    const providerName = body.provider ?? sourceProvider;
    const inheritsSourceProviderSettings = providerName === sourceProvider;

    const {
      requestedModel,
      thinking,
      effort,
      serviceTier,
      permissionMode: restartPermissionMode,
    } = inheritSuccessorLaunchSettings(
      originalMetadata?.effectiveLaunchSettings,
      {
        sameProvider: inheritsSourceProviderSettings,
        legacyRequestedModel: () =>
          deps.sessionMetadataService?.getRequestedModel(sessionId),
      },
      {
        requestedModel: body.model,
        thinking: body.thinking,
        serviceTier:
          body.serviceTier !== undefined
            ? (normalizeOptionalServiceTier(body.serviceTier) ?? null)
            : undefined,
        permissionMode: body.mode,
      },
    );
    const model =
      requestedModel && requestedModel !== "default"
        ? requestedModel
        : undefined;

    if (restartMode === "fork") {
      const claimed =
        await deps.sessionMetadataService?.nextForkOrdinal(sessionId);
      const lineageRootId = claimed?.lineageRootId ?? sessionId;
      const forkTitle = deriveForkTitle({
        preferredTitle: originalMetadata?.customTitle,
        sourceSession,
        ordinal: claimed?.ordinal ?? 1,
      });
      let fork: Awaited<ReturnType<Supervisor["forkSession"]>>;
      try {
        fork = await deps.supervisor.forkSession({
          creation: creationForRequest(c, body.creationProvenance, {
            continuedFrom: sessionId,
          }),
          sessionId,
          projectPath: restartProjectPath,
          providerName: sourceProvider,
          upToMessageId: body.forkUpToMessageId,
          initialPrompt:
            body.reason?.trim() || "Continue from this fork point.",
          title: forkTitle,
          launchOverrides: {
            requestedModel,
            thinking: body.thinking,
            permissionMode: restartPermissionMode,
            serviceTier:
              body.serviceTier !== undefined
                ? (serviceTier ?? null)
                : undefined,
          },
          sandboxLevel: restartSandboxLevel,
          sandboxNetworkFirewall: restartSandboxNetworkFirewall,
          sandboxStateKey: originalMetadata?.sandboxStateKey,
        });
      } catch (error) {
        if (claimed && !(error instanceof ForkSettingsPersistenceError)) {
          await deps.sessionMetadataService?.releaseForkOrdinal(claimed);
        }
        getLogger().warn(
          {
            event: "restart_fork_failed",
            sessionId,
            projectId,
            sourceProvider,
            upToMessageId: body.forkUpToMessageId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Transcript fork failed",
        );
        if (error instanceof ForkSettingsPersistenceError)
          return c.json(
            { error: error.message, sessionId: error.sessionId, projectId },
            error.status as 409 | 500,
          );
        return c.json(
          {
            error:
              error instanceof Error ? error.message : "Transcript fork failed",
          },
          error instanceof RouterUnavailable ? 409 : 500,
        );
      }

      const forkMessage =
        body.reason?.trim() || "Continue from this fork point.";
      let result: Awaited<ReturnType<Supervisor["resumeSession"]>>;
      try {
        result = await deps.supervisor.resumeSession(
          fork.sessionId,
          restartProjectPath,
          { text: forkMessage, mode: restartPermissionMode },
          restartPermissionMode,
          {
            model,
            requestedModel: requestedModel ?? undefined,
            serviceTier,
            thinking,
            effort,
            providerName: sourceProvider,
            executor,
            sandboxLevel: restartSandboxLevel,
            sandboxNetworkFirewall: restartSandboxNetworkFirewall,
            sandboxStateKey:
              fork.sandboxStateKey ?? originalMetadata?.sandboxStateKey,
            globalInstructions: getGlobalInstructions(),
            permissions: body.permissions,
            recapMode: helperSettings.recapMode,
            recapAfterSeconds:
              helperSettings.recapAfterSeconds ??
              originalMetadata?.recapAfterSeconds,
            // Inherit the source session's preference unless the body overrides.
            promptSuggestionMode:
              helperSettings.promptSuggestionMode ??
              originalMetadata?.promptSuggestionMode,
            helperSideModel: helperSettings.helperSideModel,
            ...resolveCompactModelSettings(deps, {
              provider: sourceProvider,
              yaModelId: requestedModel ?? undefined,
              modelCandidates: [
                body.model,
                model,
                oldProcess?.resolvedModel,
                sourceSession.model,
              ],
            }),
          },
        );
      } catch (error) {
        return c.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "Fork continuation failed",
            sessionId: fork.sessionId,
            projectId,
          },
          500,
        );
      }

      if (isQueueFullResponse(result)) {
        return c.json(
          {
            error: "Queue is full",
            maxQueueSize: result.maxQueueSize,
            sessionId: fork.sessionId,
            projectId,
          },
          503,
        );
      }
      if (isQueuedResponse(result)) {
        deps.supervisor.cancelQueuedRequest(result.queueId);
        return c.json(
          {
            error:
              "Fork could not start immediately; old process was left running",
            sessionId: fork.sessionId,
            projectId,
          },
          503,
        );
      }

      void deps.userUsageService?.recordSession(actingUsername(c));
      await persistLaunchMetadata(
        result.sessionId,
        sourceProvider,
        executor,
        undefined,
        requestedModel ?? undefined,
        result.promptSuggestionMode,
        result.recapAfterSeconds,
        {
          level: restartSandboxLevel,
          networkFirewall: restartSandboxNetworkFirewall,
          stateKey:
            result.sandboxStateKey ??
            fork.sandboxStateKey ??
            originalMetadata?.sandboxStateKey,
          projectPath: restartProjectPath,
          projectId: result.projectId,
        },
      );
      if (deps.sessionMetadataService) {
        await deps.sessionMetadataService.updateMetadata(result.sessionId, {
          title: forkTitle,
          forkLineageRootId: lineageRootId,
        });
        deps.eventBus?.emit({
          type: "session-metadata-changed",
          sessionId: result.sessionId,
          title: forkTitle,
          timestamp: new Date().toISOString(),
        });
      }

      const oldProcessAbortDeferred = abortOldProcessAfterReplacementActivity(
        oldProcess,
        result,
      );

      return c.json({
        sessionId: result.sessionId,
        processId: result.id,
        projectId: result.projectId,
        provider: result.provider,
        model: result.resolvedModel ?? result.model,
        title: forkTitle,
        permissionMode: result.permissionMode,
        appliedPermissionMode: result.appliedPermissionMode,
        modeVersion: result.modeVersion,
        recapAfterSeconds: result.recapAfterSeconds,
        sandboxEnforcement: result.sandboxEnforcement,
        restartedFrom: sessionId,
        forkUpToMessageId: body.forkUpToMessageId,
        oldProcessId: oldProcess?.id,
        oldProcessInterrupted,
        oldProcessAbortDeferred,
        oldProcessAborted: false,
      });
    }

    const handoffTitle = deriveRestartTitle({
      preferredTitle: originalMetadata?.customTitle,
      sourceSession,
    });
    const handoff =
      handoffText ??
      (await buildHandoffText({
        project,
        projectId,
        sessionId,
        handoffTitle,
        sourceSession,
        sourceProvider,
        oldProcess,
        sourceUrl: body.sourceUrl,
        targetExecutor: executor,
        projectPath: restartProjectPath,
      }));

    const result = await deps.supervisor.startSession(
      restartProjectPath,
      {
        text: handoff,
        mode: restartPermissionMode,
      },
      restartPermissionMode,
      {
        model,
        requestedModel: requestedModel ?? undefined,
        serviceTier,
        thinking,
        effort,
        providerName,
        clientName: "yep-anywhere",
        executor,
        sandboxLevel: restartSandboxLevel,
        sandboxNetworkFirewall: restartSandboxNetworkFirewall,
        globalInstructions: getGlobalInstructions(),
        permissions: body.permissions,
        recapMode: helperSettings.recapMode,
        recapAfterSeconds:
          helperSettings.recapAfterSeconds ??
          originalMetadata?.recapAfterSeconds,
        // Inherit the source session's preference unless the body overrides.
        promptSuggestionMode:
          helperSettings.promptSuggestionMode ??
          originalMetadata?.promptSuggestionMode,
        helperSideModel: helperSettings.helperSideModel,
        ...resolveCompactModelSettings(deps, {
          provider: providerName,
          yaModelId: requestedModel ?? undefined,
          modelCandidates: inheritsSourceProviderSettings
            ? [
                body.model,
                model,
                oldProcess?.resolvedModel,
                sourceSession.model,
              ]
            : [body.model, model],
        }),
      },
      {
        creation: creationForRequest(c, body.creationProvenance, {
          continuedFrom: sessionId,
        }),
      },
    );

    if (isQueueFullResponse(result)) {
      return c.json(
        { error: "Queue is full", maxQueueSize: result.maxQueueSize },
        503,
      );
    }

    if (isQueuedResponse(result)) {
      deps.supervisor.cancelQueuedRequest(result.queueId);
      return c.json(
        {
          error:
            "Restart could not start immediately; old process was left running",
        },
        503,
      );
    }

    void deps.userUsageService?.recordSession(actingUsername(c));
    await persistLaunchMetadata(
      result.sessionId,
      providerName,
      executor,
      undefined,
      requestedModel ?? undefined,
      result.promptSuggestionMode,
      result.recapAfterSeconds,
      {
        level: restartSandboxLevel,
        networkFirewall: restartSandboxNetworkFirewall,
        stateKey: result.sandboxStateKey,
        projectPath: result.sandboxProjectPath ?? result.projectPath,
        projectId: result.projectId,
      },
    );
    if (deps.sessionMetadataService) {
      await deps.sessionMetadataService.updateMetadata(result.sessionId, {
        title: handoffTitle,
      });
      deps.eventBus?.emit({
        type: "session-metadata-changed",
        sessionId: result.sessionId,
        title: handoffTitle,
        timestamp: new Date().toISOString(),
      });
    }

    const oldProcessAbortDeferred = abortOldProcessAfterReplacementActivity(
      oldProcess,
      result,
    );

    return c.json({
      sessionId: result.sessionId,
      processId: result.id,
      projectId: result.projectId,
      provider: result.provider,
      model: result.resolvedModel ?? result.model,
      title: handoffTitle,
      permissionMode: result.permissionMode,
      appliedPermissionMode: result.appliedPermissionMode,
      modeVersion: result.modeVersion,
      recapAfterSeconds: result.recapAfterSeconds,
      sandboxEnforcement: result.sandboxEnforcement,
      restartedFrom: sessionId,
      oldProcessId: oldProcess?.id,
      oldProcessInterrupted,
      oldProcessAbortDeferred,
      oldProcessAborted: false,
    });
  });

  // POST /api/projects/:projectId/sessions/:sessionId/stale-handoff
  // A turn refused because its session went cold under the limited-user
  // freshness cutoff, delivered instead as the first turn of a new session
  // seeded with a bounded handoff of the old one
  // (topics/limited-users.md § Freshness). Unlike restart, the source is
  // neither compacted nor interrupted: either would spend the cold context
  // this exists to avoid, and the old session is left exactly as it was.
  routes.post(
    "/projects/:projectId/sessions/:sessionId/stale-handoff",
    async (c) => {
      const projectId = c.req.param("projectId");
      const sessionId = c.req.param("sessionId");
      if (isRoutedSession(sessionId)) {
        return c.json(
          { error: routedSessionUnsupportedMessage("Handoff") },
          409,
        );
      }
      if (!isUrlProjectId(projectId)) {
        return c.json({ error: "Invalid project ID format" }, 400);
      }
      const project = await deps.scanner.getOrCreateProject(projectId);
      if (!project) {
        return c.json(
          { error: "Project not found or path does not exist" },
          404,
        );
      }

      let body: StartSessionBody;
      try {
        body = await c.req.json<StartSessionBody>();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      const modeError = permissionModeError(body.mode);
      if (modeError) {
        return c.json({ error: modeError }, 400);
      }
      if (!hasSessionMessageContent(body)) {
        return c.json({ error: "Message is required" }, 400);
      }

      const originalMetadata =
        deps.sessionMetadataService?.getMetadata?.(sessionId);
      const oldProcess = deps.supervisor.getProcessForSession(sessionId);
      const metadataProvider = deps.sessionMetadataService?.getProvider(
        sessionId,
      ) as ProviderName | undefined;
      const preferredSourceProvider =
        metadataProvider ?? oldProcess?.provider ?? project.provider;
      const sourceSession = await loadRestartSourceSession(
        project,
        sessionId,
        projectId,
        preferredSourceProvider,
        oldProcess,
      );
      if (!sourceSession) {
        return c.json({ error: "Session not found" }, 404);
      }
      const sourceProvider = sourceSession.provider ?? preferredSourceProvider;

      // The request names no launch settings: the lock supplies what it
      // fixes, the source session the rest, so nothing here can conflict
      // with the lock.
      const launchBody: LimitedLaunchBody = {};
      const limitedLaunch = applyLimitedLaunchPolicy(c, launchBody);
      if (limitedLaunch.kind === "error") {
        return c.json({ error: limitedLaunch.error }, 403);
      }
      const limited = limitedLaunch.kind === "applied";
      const sandbox: { level: SessionSandboxLevel; networkFirewall: boolean } =
        limited
          ? { level: "project-write", networkFirewall: true }
          : {
              level: originalMetadata?.sandboxLevel ?? "none",
              networkFirewall:
                persistedSandboxNetworkFirewall(originalMetadata),
            };
      const parsedExecutor = limited
        ? { executor: undefined }
        : parseOptionalExecutor(
            deps.sessionMetadataService?.getExecutor(sessionId),
          );
      if ("error" in parsedExecutor && parsedExecutor.error) {
        return c.json({ error: parsedExecutor.error }, 400);
      }
      const executor = parsedExecutor.executor;
      const providerName =
        (launchBody.provider as ProviderName | undefined) ?? sourceProvider;
      const { requestedModel, thinking, effort, serviceTier, permissionMode } =
        inheritSuccessorLaunchSettings(
          originalMetadata?.effectiveLaunchSettings,
          {
            sameProvider: providerName === sourceProvider,
            legacyRequestedModel: () =>
              deps.sessionMetadataService?.getRequestedModel(sessionId),
          },
          {
            requestedModel: launchBody.model,
            thinking: launchBody.thinking as ThinkingOption | undefined,
            permissionMode: body.mode,
          },
        );
      const model =
        requestedModel && requestedModel !== "default"
          ? requestedModel
          : undefined;
      const projectPath =
        originalMetadata?.sandboxLevel === "project-write"
          ? (originalMetadata.sandboxProjectPath ?? project.path)
          : project.path;

      const handoffTitle = deriveRestartTitle({
        preferredTitle: originalMetadata?.customTitle,
        sourceSession,
      });
      const handoff = await buildHandoffText({
        project,
        projectId,
        sessionId,
        handoffTitle,
        sourceSession,
        sourceProvider,
        oldProcess,
        targetExecutor: executor,
        projectPath,
        purpose: "cold-session",
      });
      const serverTimestamp = Date.now();
      const userMessage: UserMessage = {
        text: `${handoff}\n\n## New Message\n\n${body.message}`,
        images: body.images,
        documents: body.documents,
        attachments: body.attachments,
        mode: body.mode,
        tempId: body.tempId,
        metadata: buildUserMessageMetadata(
          body,
          serverTimestamp,
          "direct",
          actingUsername(c),
        ),
      };

      const result = await deps.supervisor.startSession(
        projectPath,
        userMessage,
        permissionMode,
        {
          model,
          requestedModel: requestedModel ?? undefined,
          serviceTier,
          thinking,
          effort,
          providerName,
          executor,
          sandboxLevel: sandbox.level,
          sandboxNetworkFirewall: sandbox.networkFirewall,
          instructionUsername: actingUsername(c),
          globalInstructions: getGlobalInstructions(),
          recapAfterSeconds: originalMetadata?.recapAfterSeconds,
          promptSuggestionMode: originalMetadata?.promptSuggestionMode,
          ...resolveCompactModelSettings(deps, {
            provider: providerName,
            yaModelId: requestedModel ?? undefined,
            modelCandidates: [model, sourceSession.model],
          }),
        },
        {
          projectId: project.id,
          creation: creationForRequest(c, body.creationProvenance, {
            continuedFrom: sessionId,
          }),
        },
      );
      if (isQueueFullResponse(result)) {
        return c.json(
          { error: "Queue is full", maxQueueSize: result.maxQueueSize },
          503,
        );
      }
      void deps.userUsageService?.recordSession(actingUsername(c));
      void deps.userUsageService?.recordTurn(actingUsername(c), body.message);
      if (isQueuedResponse(result)) {
        return c.json({ ...result, serverTimestamp }, 202);
      }

      if (deps.sessionMetadataService) {
        await deps.sessionMetadataService.updateMetadata(result.sessionId, {
          title: handoffTitle,
        });
        deps.eventBus?.emit({
          type: "session-metadata-changed",
          sessionId: result.sessionId,
          title: handoffTitle,
          timestamp: new Date().toISOString(),
        });
      }
      return c.json({
        sessionId: result.sessionId,
        processId: result.id,
        projectId: result.projectId,
        provider: result.provider,
        model: result.resolvedModel ?? result.model,
        title: handoffTitle,
        permissionMode: result.permissionMode,
        appliedPermissionMode: result.appliedPermissionMode,
        modeVersion: result.modeVersion,
        recapAfterSeconds: result.recapAfterSeconds,
        sandboxEnforcement: result.sandboxEnforcement,
        serverTimestamp,
        staleHandoffFrom: sessionId,
      });
    },
  );

  // POST /api/projects/:projectId/sessions/:sessionId/fork
  // Fork the provider transcript into a new resumable session without
  // starting a process or sending any message ("fork from here" / rewind).
  // The forked session opens cold; the next user send resumes it normally.
  // ---------------------------------------------------------------------
  // Same-session rewind, /clear N, and /clearloop (topics/session-rewind.md)
  // ---------------------------------------------------------------------

  type RewindCut = {
    kind: "after-user-turn" | "before-user-turn";
    sourceMessageId: string;
  };

  type RewindFailure = { ok: false; error: string; status: 400 | 404 | 409 };
  type RewindSuccess = {
    ok: true;
    /** Null when the cut was already the tail and nothing was dropped. */
    record: SessionRewindRecord | null;
    cutMessageId: string;
    processAborted: boolean;
  };

  /** A session as one rewind command read it, shared by its steps. */
  type RewindSource = {
    providerName: ProviderName;
    process: Process | undefined;
    session: Session | null;
  };

  const isRewindProvider = (providerName: ProviderName): boolean =>
    isClaudeSdkProviderName(providerName);

  const resolveRewindProvider = async (
    project: Project,
    projectId: UrlProjectId,
    sessionId: string,
  ): Promise<{ providerName: ProviderName; process: Process | undefined }> => {
    const process = deps.supervisor.getProcessForSession(sessionId);
    const metadataProvider = deps.sessionMetadataService?.getProvider(
      sessionId,
    ) as ProviderName | undefined;
    let providerName = process?.provider ?? metadataProvider;
    if (!providerName) {
      const summary = await findSessionListSummaryAcrossProviders(
        project,
        sessionId,
        projectId,
        providerResolutionDeps(deps),
        undefined,
      );
      providerName = summary?.source.provider ?? project.provider;
    }
    return { providerName, process };
  };

  /**
   * Drop everything after `cutMessageId` from the live conversation: record
   * the rewind, arm it for the next resume, and stop the live process so that
   * resume happens. The transcript file is untouched; the reader groups the
   * dropped rows from the record.
   */
  const rewindSessionToCut = async (input: {
    project: Project;
    projectId: UrlProjectId;
    sessionId: string;
    cutMessageId: string;
    cutTurnIndex: number;
    reason: SessionRewindReason;
    clearloopId?: string;
    clearloopIteration?: number;
    clearloopTotal?: number;
    clearloopPrompt?: string;
    /** The session as the caller just resolved it; absent loads it here. */
    source?: RewindSource;
  }): Promise<RewindFailure | RewindSuccess> => {
    const { project, projectId, sessionId } = input;
    const { providerName, process } =
      input.source ??
      (await resolveRewindProvider(project, projectId, sessionId));
    if (!isRewindProvider(providerName)) {
      return {
        ok: false,
        error: `${providerName} does not support same-session rewind`,
        status: 409,
      };
    }
    if (deps.externalTracker?.isExternal(sessionId)) {
      return {
        ok: false,
        error: "The session is being written by another process",
        status: 409,
      };
    }
    if (
      process &&
      (process.state.type === "in-turn" ||
        process.state.type === "waiting-input")
    ) {
      return {
        ok: false,
        error:
          "Rewind is available after the current response completes. Nothing was changed.",
        status: 409,
      };
    }
    if (process && process.getDeferredQueueSummary().length > 0) {
      return {
        ok: false,
        error:
          "Cancel or deliver the queued messages before rewinding. Nothing was changed.",
        status: 409,
      };
    }
    const session = input.source
      ? input.source.session
      : await loadRestartSourceSession(
          project,
          sessionId,
          projectId,
          providerName,
          process,
        );
    if (!session) {
      return { ok: false, error: "Session not found", status: 404 };
    }
    const cutIndex = session.messages.findIndex(
      (message) =>
        messageId(message) === input.cutMessageId && !message.rewoundGroupId,
    );
    if (cutIndex < 0) {
      return {
        ok: false,
        error: "The rewind cut is no longer in the session",
        status: 409,
      };
    }
    let droppedTurnCount = 0;
    let droppedFromMessageId: string | undefined;
    let droppedPromptIds: string[] = [];
    for (let index = cutIndex + 1; index < session.messages.length; index++) {
      const message = session.messages[index];
      if (!message || message.rewoundGroupId) continue;
      if (isRealUserTurn(message)) {
        droppedTurnCount += 1;
        const id = messageId(message);
        if (id) {
          droppedFromMessageId ??= id;
          droppedPromptIds.push(id);
        }
      }
    }
    const hasTail = session.messages
      .slice(cutIndex + 1)
      .some(
        (message) => !message.rewoundGroupId && Boolean(messageId(message)),
      );
    if (!hasTail) {
      return {
        ok: true,
        record: null,
        cutMessageId: input.cutMessageId,
        processAborted: false,
      };
    }
    // The drop guard protects a hand-picked `/clear N` from discarding what
    // the user never saw. A clearloop iteration is discarded whole by
    // contract, task notifications and absorbed queued messages included.
    if (droppedTurnCount > 1 || input.reason === "clearloop") {
      droppedPromptIds = [];
    }

    let processAborted = false;
    if (process) {
      await deps.supervisor.abortSessionWithVerification(sessionId);
      processAborted = true;
    }
    const droppedThroughMessageId = await readRewindBoundRowId(
      project,
      sessionId,
      projectId,
      providerName,
    );
    if (!droppedThroughMessageId) {
      console.warn(
        `Rewind of ${sessionId} found no transcript rows on disk; its group falls back to timestamps`,
      );
    }
    const record: SessionRewindRecord = {
      id: randomUUID(),
      at: new Date().toISOString(),
      cutMessageId: input.cutMessageId,
      cutTurnIndex: input.cutTurnIndex,
      ...(droppedFromMessageId ? { droppedFromMessageId } : {}),
      ...(droppedThroughMessageId ? { droppedThroughMessageId } : {}),
      droppedTurnCount,
      reason: input.reason,
      ...(input.clearloopId ? { clearloopId: input.clearloopId } : {}),
      ...(input.clearloopIteration !== undefined
        ? { clearloopIteration: input.clearloopIteration }
        : {}),
      ...(input.clearloopTotal !== undefined
        ? { clearloopTotal: input.clearloopTotal }
        : {}),
      ...(input.clearloopPrompt
        ? { clearloopPrompt: input.clearloopPrompt }
        : {}),
    };
    await deps.sessionMetadataService?.addRewindRecord(sessionId, record, {
      recordId: record.id,
      cutMessageId: input.cutMessageId,
      ...(droppedPromptIds.length === 1
        ? { dropsTurnPromptId: droppedPromptIds[0] }
        : {}),
    });
    deps.eventBus?.emit({
      type: "session-metadata-changed",
      sessionId,
      projectId,
      rewindRecord: record,
      timestamp: new Date().toISOString(),
    });
    return {
      ok: true,
      record,
      cutMessageId: input.cutMessageId,
      processAborted,
    };
  };

  /** Resolve a turn-relative cut to the provider chain entry it keeps. */
  const resolveRewindCut = (
    source: RewindSource & { session: Session },
    sessionId: string,
    cut: RewindCut,
  ):
    | RewindFailure
    | { ok: true; cutMessageId: string; cutTurnIndex: number } => {
    const { providerName, process, session } = source;
    // Numbering spans the full sequence, cleared turns included, but a cut
    // inside a cleared span is a tree hop whose UI is unspecified; refuse it
    // (topics/session-rewind.md § Vocabulary).
    const sourceMessage = session.messages.find(
      (message) => messageId(message) === cut.sourceMessageId,
    );
    if (sourceMessage?.rewoundGroupId) {
      return {
        ok: false,
        error:
          "That turn is inside a cleared span; rewinding into cleared history is not supported yet",
        status: 409,
      };
    }
    const messages = session.messages.filter(
      (message) =>
        (message as { subtype?: unknown }).subtype !== "rewound_group",
    );
    const sourceIsBusy = Boolean(
      deps.externalTracker?.isExternal(sessionId) ||
        process?.state.type === "in-turn" ||
        process?.state.type === "waiting-input",
    );
    const boundary =
      cut.kind === "before-user-turn"
        ? resolveForkBeforeBoundary(messages, cut.sourceMessageId, providerName)
        : resolveForkAfterBoundary(
            messages,
            cut.sourceMessageId,
            sourceIsBusy,
            providerName,
          );
    if ("error" in boundary) {
      return { ok: false, error: boundary.error, status: boundary.status };
    }
    if (boundary.providerBoundary?.kind !== "message") {
      return {
        ok: false,
        error: "Same-session rewind needs a Claude transcript boundary",
        status: 409,
      };
    }
    // The kept turn's stamped ordinal is the record's N: the same number the
    // turn menu shows, so `/clear N` and the label agree by construction.
    // A before cut keeps the previous turn on the source's chain, which a
    // clear may have put well below N−1. The boundary above already refused
    // non-turns; a kept turn that still has no stamp came from an
    // unnormalized history and has no N to record.
    const keptTurn =
      cut.kind === "before-user-turn" && sourceMessage
        ? precedingChainTurn(messages, sourceMessage)
        : sourceMessage;
    const cutTurnIndex = turnIndexOf(keptTurn);
    if (cutTurnIndex === undefined) {
      return {
        ok: false,
        error: "That message is not a user turn",
        status: 409,
      };
    }
    return {
      ok: true,
      cutMessageId: boundary.providerBoundary.messageId,
      cutTurnIndex,
    };
  };

  const parseRewindCut = (body: unknown): RewindCut | { error: string } => {
    if (!body || typeof body !== "object") return { error: "Invalid body" };
    const cut = (body as { cut?: unknown }).cut;
    if (!cut || typeof cut !== "object") return { error: "cut is required" };
    const kind = (cut as { kind?: unknown }).kind;
    const sourceMessageId = (cut as { sourceMessageId?: unknown })
      .sourceMessageId;
    if (kind !== "after-user-turn" && kind !== "before-user-turn") {
      return { error: "cut.kind must be after-user-turn or before-user-turn" };
    }
    if (typeof sourceMessageId !== "string" || !sourceMessageId.trim()) {
      return { error: "cut.sourceMessageId is required" };
    }
    return { kind, sourceMessageId: sourceMessageId.trim() };
  };

  /** Resume the session with one direct prompt using its saved launch settings. */
  const sendClearloopPrompt = async (input: {
    project: Project;
    projectId: UrlProjectId;
    sessionId: string;
    prompt: string;
  }): Promise<void> => {
    const { project, projectId, sessionId } = input;
    const { providerName } = await resolveRewindProvider(
      project,
      projectId,
      sessionId,
    );
    // No client asks for this turn, so the settings the session last applied
    // stand in for the choices a resume request would carry.
    const saved =
      deps.sessionMetadataService?.getEffectiveLaunchSettings?.(sessionId);
    const launch = buildResumeLaunch({
      sessionId,
      providerName,
      workingProjectPath: project.path,
      request: {
        serviceTier: saved?.serviceTier ?? undefined,
        thinking: saved?.thinking ?? undefined,
        effort: saved?.effort ?? undefined,
        // The iteration's rewind is armed as the session's pending rewind;
        // the supervisor applies it when this resume launches the process.
        resumeMode: "full",
      },
    });
    if ("error" in launch) throw new Error(launch.error);
    const userMessage: UserMessage = {
      text: input.prompt,
      // YA-injected, not a principal's turn: no sender and no usage record.
      metadata: buildUserMessageMetadata({}, Date.now(), "direct"),
    };
    const result = await deps.supervisor.resumeSession(
      sessionId,
      launch.projectPath,
      userMessage,
      saved?.permissionMode,
      launch.settings,
      { requireProviderSessionId: true },
    );
    if (isQueueFullResponse(result)) {
      throw new Error("Queue is full");
    }
  };

  deps.clearloopService?.setRunner({
    rewind: async ({ sessionId, projectId, job, iteration }) => {
      const project = await deps.scanner.getOrCreateProject(projectId);
      if (!project) throw new Error("Project not found");
      const result = await rewindSessionToCut({
        project,
        projectId,
        sessionId,
        cutMessageId: job.cutMessageId,
        cutTurnIndex: job.cutTurnIndex,
        reason: "clearloop",
        clearloopId: job.id,
        clearloopIteration: iteration,
        clearloopTotal: job.total,
        clearloopPrompt: job.prompt,
      });
      if (!result.ok) throw new Error(result.error);
      return result.record ? "rewound" : "noop";
    },
    send: async ({ sessionId, projectId, job }) => {
      const project = await deps.scanner.getOrCreateProject(projectId);
      if (!project) throw new Error("Project not found");
      await sendClearloopPrompt({
        project,
        projectId,
        sessionId,
        prompt: job.prompt,
      });
    },
  });

  /**
   * The user turn a typed rewind command names: turn `N`, or the session's
   * last real turn when the command gave no number. Queued commands resolve
   * this at dispatch, so `/clearloop 3: p` queued now loops over whatever the
   * tail is when the project finally goes quiet.
   */
  const typedTurnSourceMessageId = (
    session: Session,
    turnIndex: number | undefined,
  ): RewindFailure | { ok: true; sourceMessageId: string } => {
    const turns = session.messages.filter(
      (message) =>
        !message.rewoundGroupId && turnIndexOf(message) !== undefined,
    );
    const target =
      turnIndex === undefined
        ? turns[turns.length - 1]
        : turns.find((message) => turnIndexOf(message) === turnIndex);
    if (!target) {
      return {
        ok: false,
        error:
          turnIndex === undefined
            ? "The session has no turns to rewind to"
            : `Turn ${turnIndex} is not in the session`,
        status: 409,
      };
    }
    const id = messageId(target);
    if (!id) {
      return { ok: false, error: "That turn has no id", status: 409 };
    }
    return { ok: true, sourceMessageId: id };
  };

  /**
   * The one server operation behind `/clear N` and `/clearloop`, whether the
   * composer sent it or Project Queue dispatched it: refuse what rewind cannot
   * do, read the session once, resolve the kept turn, then rewind or start the
   * loop (topics/session-rewind.md).
   */
  const runRewindCommand = async (input: {
    project: Project;
    projectId: UrlProjectId;
    sessionId: string;
    /** An explicit cut, or typed turn N (the last real turn when absent). */
    target: { cut: RewindCut } | { turnIndex?: number };
    action:
      | { name: "clear" }
      | {
          name: "clearloop";
          prompt: string;
          total: number;
          commandText: string;
          patient: boolean;
        };
  }): Promise<
    | RewindFailure
    | { ok: true; rewind: RewindSuccess }
    | {
        ok: true;
        job: Awaited<ReturnType<ClearloopService["start"]>>;
      }
  > => {
    const { project, projectId, sessionId, action } = input;
    const clearloopService = deps.clearloopService;
    if (action.name === "clear" && clearloopService?.isRunning(sessionId)) {
      return {
        ok: false,
        error: "Cancel the running /clearloop before rewinding",
        status: 409,
      };
    }
    const { providerName, process } = await resolveRewindProvider(
      project,
      projectId,
      sessionId,
    );
    if (!isRewindProvider(providerName)) {
      return {
        ok: false,
        error: `${providerName} does not support same-session rewind`,
        status: 409,
      };
    }
    const session = await loadRestartSourceSession(
      project,
      sessionId,
      projectId,
      providerName,
      process,
    );
    if (!session) {
      return { ok: false, error: "Session not found", status: 404 };
    }
    const source = { providerName, process, session };
    let cut: RewindCut;
    if ("cut" in input.target) {
      cut = input.target.cut;
    } else {
      const typed = typedTurnSourceMessageId(session, input.target.turnIndex);
      if (!typed.ok) return typed;
      cut = { kind: "after-user-turn", sourceMessageId: typed.sourceMessageId };
    }
    const resolved = resolveRewindCut(source, sessionId, cut);
    if (!resolved.ok) return resolved;
    if (action.name === "clear") {
      const rewind = await rewindSessionToCut({
        project,
        projectId,
        sessionId,
        cutMessageId: resolved.cutMessageId,
        cutTurnIndex: resolved.cutTurnIndex,
        reason: "clear",
        source,
      });
      return rewind.ok ? { ok: true, rewind } : rewind;
    }
    if (!clearloopService) {
      return { ok: false, error: "clearloop is not available", status: 404 };
    }
    try {
      const job = await clearloopService.start(sessionId, projectId, {
        cutMessageId: resolved.cutMessageId,
        cutTurnIndex: resolved.cutTurnIndex,
        prompt: action.prompt,
        total: action.total,
        commandText: action.commandText,
        ...(action.patient ? { patient: true } : {}),
      });
      return { ok: true, job };
    } catch (error) {
      if (error instanceof ClearloopConflictError) {
        return { ok: false, error: error.message, status: 409 };
      }
      throw error;
    }
  };

  // Route tests supply a partial scheduler; the runner is optional like the
  // other scheduler hooks this module calls.
  deps.projectQueueScheduler?.setYaCommandRunner?.({
    run: async ({ sessionId, projectId, command, commandText }) => {
      const project = await deps.scanner.getOrCreateProject(projectId);
      if (!project) throw new Error("Project not found");
      // The queue refused an unreadable argument when the item was queued,
      // edited, or loaded; the scheduler hands over only commands that read.
      const reading = readQueuedYaCommand(command);
      if (!reading.ok) {
        throw new Error(
          describeQueuedYaCommandProblem(command, reading.problem),
        );
      }
      const { action } = reading;
      const turnArgument =
        action.name === "clear" ? action.turnIndex : action.arguments.turnIndex;
      // A refusal fails the queued item, which keeps its text for Retry.
      const result = await runRewindCommand({
        project,
        projectId,
        sessionId,
        target: turnArgument === undefined ? {} : { turnIndex: turnArgument },
        action:
          action.name === "clearloop"
            ? {
                name: "clearloop",
                prompt: action.arguments.prompt,
                total: action.arguments.total,
                commandText,
                // The user chose a lane that waits for the project; the loop it
                // starts keeps waiting (topics/project-queue.md § Queued YA
                // commands).
                patient: true,
              }
            : { name: "clear" },
      });
      if (!result.ok) throw new Error(result.error);
    },
  });

  // POST /api/projects/:projectId/sessions/:sessionId/rewind
  routes.post("/projects/:projectId/sessions/:sessionId/rewind", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }
    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found or path does not exist" }, 404);
    }
    let body: unknown;
    try {
      body = await c.req.json<unknown>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const cut = parseRewindCut(body);
    if ("error" in cut) return c.json({ error: cut.error }, 400);
    const result = await runRewindCommand({
      project,
      projectId,
      sessionId,
      target: { cut },
      action: { name: "clear" },
    });
    if (!result.ok) {
      return c.json({ error: result.error }, result.status);
    }
    if (!("rewind" in result)) {
      throw new Error("A clear command returned no rewind result");
    }
    const { rewind } = result;
    return c.json({
      record: rewind.record,
      cutMessageId: rewind.cutMessageId,
      noop: rewind.record === null,
      processAborted: rewind.processAborted,
    });
  });

  // POST /api/projects/:projectId/sessions/:sessionId/clearloop
  routes.post(
    "/projects/:projectId/sessions/:sessionId/clearloop",
    async (c) => {
      const projectId = c.req.param("projectId");
      const sessionId = c.req.param("sessionId");
      if (!isUrlProjectId(projectId)) {
        return c.json({ error: "Invalid project ID format" }, 400);
      }
      if (!deps.clearloopService) {
        return c.json({ error: "clearloop is not available" }, 404);
      }
      const project = await deps.scanner.getOrCreateProject(projectId);
      if (!project) {
        return c.json(
          { error: "Project not found or path does not exist" },
          404,
        );
      }
      let body: unknown;
      try {
        body = await c.req.json<unknown>();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      const cut = parseRewindCut(body);
      if ("error" in cut) return c.json({ error: cut.error }, 400);
      const record = body as {
        prompt?: unknown;
        total?: unknown;
        commandText?: unknown;
        patient?: unknown;
      };
      const prompt =
        typeof record.prompt === "string" ? record.prompt.trim() : "";
      const total = record.total;
      if (!prompt) return c.json({ error: "prompt is required" }, 400);
      if (
        typeof total !== "number" ||
        !Number.isInteger(total) ||
        total < 1 ||
        total > 10_000
      ) {
        return c.json({ error: "total must be an integer from 1" }, 400);
      }
      const commandText =
        typeof record.commandText === "string" && record.commandText.trim()
          ? record.commandText.trim()
          : `/clearloop ${total}: ${prompt}`;
      const result = await runRewindCommand({
        project,
        projectId,
        sessionId,
        target: { cut },
        action: {
          name: "clearloop",
          prompt,
          total,
          commandText,
          patient: record.patient === true,
        },
      });
      if (!result.ok) {
        return c.json({ error: result.error }, result.status);
      }
      if (!("job" in result)) {
        throw new Error("A clearloop command returned no job");
      }
      return c.json({ job: result.job }, 202);
    },
  );

  // PATCH /api/projects/:projectId/sessions/:sessionId/clearloop
  // Runtime controls on a running loop: the project-idle wait, and Start now.
  routes.patch(
    "/projects/:projectId/sessions/:sessionId/clearloop",
    async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!deps.clearloopService) {
        return c.json({ error: "clearloop is not available" }, 404);
      }
      let body: unknown;
      try {
        body = await c.req.json<unknown>();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      const request = (body ?? {}) as UpdateClearloopRequest;
      if (
        request.patient !== undefined &&
        typeof request.patient !== "boolean"
      ) {
        return c.json({ error: "patient must be a boolean" }, 400);
      }
      if (request.patient === undefined && request.startNow !== true) {
        return c.json({ error: "patient or startNow is required" }, 400);
      }
      try {
        let job =
          request.patient === undefined
            ? deps.clearloopService.getRunningJob(sessionId)
            : await deps.clearloopService.setPatience(
                sessionId,
                request.patient,
              );
        if (job && request.startNow === true) {
          job = await deps.clearloopService.startNow(sessionId);
        }
        if (!job) return c.json({ error: "No running /clearloop" }, 404);
        return c.json({ job });
      } catch (error) {
        if (error instanceof ClearloopConflictError) {
          return c.json({ error: error.message }, 409);
        }
        throw error;
      }
    },
  );

  // DELETE /api/projects/:projectId/sessions/:sessionId/clearloop
  // Cancels without stopping in-flight work or starting a turn.
  routes.delete(
    "/projects/:projectId/sessions/:sessionId/clearloop",
    async (c) => {
      const sessionId = c.req.param("sessionId");
      const job = await deps.clearloopService?.cancel(sessionId);
      if (!job) {
        return c.json({ error: "No running /clearloop" }, 404);
      }
      return c.json({ job });
    },
  );

  routes.post("/projects/:projectId/sessions/:sessionId/fork", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }
    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found or path does not exist" }, 404);
    }

    let body: {
      forkKind?: unknown;
      sourceMessageId?: unknown;
      upToMessageId?: unknown;
      thinking?: unknown;
      creationProvenance?: unknown;
    } = {};
    try {
      const parsed = await c.req.json<unknown>();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      body = parsed as typeof body;
    } catch {
      // Body is optional; full-transcript fork.
    }
    let forkThinking: ThinkingOption | undefined;
    if (body.thinking !== undefined) {
      if (!isThinkingOption(body.thinking)) {
        return c.json(
          { error: "thinking must be off, auto, or on:<effort level>" },
          400,
        );
      }
      forkThinking = body.thinking;
    }
    const hasIntentFields =
      body.forkKind !== undefined || body.sourceMessageId !== undefined;
    if (hasIntentFields && body.upToMessageId !== undefined) {
      return c.json(
        {
          error:
            "forkKind/sourceMessageId cannot be combined with upToMessageId",
        },
        400,
      );
    }
    const forkKind =
      body.forkKind === "clone-latest-complete" ||
      body.forkKind === "before-user-turn" ||
      body.forkKind === "after-user-turn"
        ? (body.forkKind as SessionForkKind)
        : undefined;
    if (hasIntentFields && !forkKind) {
      return c.json({ error: "Invalid forkKind" }, 400);
    }
    const sourceMessageId =
      typeof body.sourceMessageId === "string" && body.sourceMessageId.trim()
        ? body.sourceMessageId.trim()
        : undefined;
    if (
      (forkKind === "before-user-turn" || forkKind === "after-user-turn") &&
      !sourceMessageId
    ) {
      return c.json({ error: "sourceMessageId is required" }, 400);
    }
    if (forkKind === "clone-latest-complete" && sourceMessageId) {
      return c.json(
        { error: "clone-latest-complete does not accept sourceMessageId" },
        400,
      );
    }
    const upToMessageId =
      typeof body.upToMessageId === "string" && body.upToMessageId
        ? body.upToMessageId
        : undefined;

    const metadataProvider = deps.sessionMetadataService?.getProvider(
      sessionId,
    ) as ProviderName | undefined;
    const sourceProcess = deps.supervisor.getProcessForSession(sessionId);
    const sessionSummaryResult = await findSessionListSummaryAcrossProviders(
      project,
      sessionId,
      projectId,
      providerResolutionDeps(deps),
      sourceProcess?.provider ?? metadataProvider,
    );
    const sessionSummary = sessionSummaryResult?.summary ?? null;
    const providerName =
      sourceProcess?.provider ??
      metadataProvider ??
      sessionSummaryResult?.source.provider ??
      project.provider;
    if (!deps.supervisor.supportsForkSession(providerName)) {
      return c.json(
        { error: `${providerName} does not support transcript fork` },
        400,
      );
    }

    const sourceIsBusy = Boolean(
      deps.externalTracker?.isExternal(sessionId) ||
        sourceProcess?.state.type === "in-turn" ||
        sourceProcess?.state.type === "waiting-input",
    );
    let providerBoundary: ProviderForkBoundary | undefined;
    let retainedThroughMessageId: string | undefined;
    if (forkKind === "clone-latest-complete" && sourceIsBusy) {
      return c.json(
        {
          error:
            "Clone is available after the current response completes. No new session was created and the source is unchanged.",
        },
        409,
      );
    }
    if (
      (forkKind === "before-user-turn" || forkKind === "after-user-turn") &&
      sourceMessageId
    ) {
      const sourceSession = await loadRestartSourceSession(
        project,
        sessionId,
        projectId,
        providerName,
        sourceProcess,
      );
      if (!sourceSession) {
        return c.json({ error: "Source session not found" }, 404);
      }
      const boundary =
        forkKind === "before-user-turn"
          ? resolveForkBeforeBoundary(
              sourceSession.messages,
              sourceMessageId,
              providerName,
            )
          : resolveForkAfterBoundary(
              sourceSession.messages,
              sourceMessageId,
              sourceIsBusy,
              providerName,
            );
      if ("error" in boundary) {
        return c.json({ error: boundary.error }, boundary.status);
      }
      if (!boundary.providerBoundary) {
        return c.json(
          { error: "Completed turn provider boundary is unavailable" },
          409,
        );
      }
      providerBoundary = boundary.providerBoundary;
      retainedThroughMessageId = boundary.retainedThroughMessageId;
    }

    const originalMetadata =
      deps.sessionMetadataService?.getMetadata?.(sessionId);
    const forkProjectPath =
      originalMetadata?.sandboxLevel === "project-write"
        ? (originalMetadata.sandboxProjectPath ?? project.path)
        : project.path;
    let baseTitle = normalizeRestartTitleCandidate(
      originalMetadata?.customTitle,
    );
    if (!baseTitle) {
      baseTitle = normalizeRestartTitleCandidate(sessionSummary?.title);
    }
    const titlePrefix = forkKind === "clone-latest-complete" ? "Clone" : "Fork";
    const claimed = baseTitle
      ? await deps.sessionMetadataService?.nextForkOrdinal(sessionId)
      : undefined;
    const forkLineageRootId =
      claimed?.lineageRootId ??
      deps.sessionMetadataService?.forkLineageRoot(sessionId) ??
      sessionId;
    const forkTitle = baseTitle
      ? forkTitleWithOrdinal(baseTitle, claimed?.ordinal ?? 1, titlePrefix)
      : undefined;

    let fork: Awaited<ReturnType<Supervisor["forkSession"]>>;
    try {
      fork = await deps.supervisor.forkSession({
        creation: creationForRequest(c, body.creationProvenance),
        sessionId,
        projectPath: forkProjectPath,
        providerName,
        upToMessageId,
        boundary: providerBoundary,
        title: forkTitle,
        ...(forkThinking !== undefined
          ? { launchOverrides: { thinking: forkThinking } }
          : {}),
        ...inheritedSandboxSettings(originalMetadata),
      });
    } catch (error) {
      if (claimed && !(error instanceof ForkSettingsPersistenceError)) {
        await deps.sessionMetadataService?.releaseForkOrdinal(claimed);
      }
      getLogger().warn(
        {
          event: "session_fork_failed",
          sessionId,
          projectId,
          providerName,
          forkKind: forkKind ?? null,
          sourceMessageId: sourceMessageId ?? null,
          retainedThroughMessageId: retainedThroughMessageId ?? null,
          upToMessageId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Transcript fork failed",
      );
      if (error instanceof ForkSettingsPersistenceError)
        return c.json(
          { error: error.message, sessionId: error.sessionId, projectId },
          error.status as 409 | 500,
        );
      // A copy of a pinned session that could not keep its account.
      if (error instanceof RouterUnavailable) {
        return c.json({ error: error.message }, 409);
      }
      return c.json(
        hasIntentFields && !(error instanceof ForkSettingsPersistenceError)
          ? {
              error:
                "No new session was created. The source session is unchanged. Try again after the selected response completes.",
              detail:
                error instanceof Error
                  ? error.message
                  : "Transcript fork failed",
            }
          : {
              error:
                error instanceof Error
                  ? error.message
                  : "Transcript fork failed",
            },
        500,
      );
    }

    const savedExecutor = parseOptionalExecutor(
      deps.sessionMetadataService?.getExecutor(sessionId),
    ).executor;
    let inheritedModel = fork.launchSettings
      ? (fork.launchSettings.requestedModel ?? undefined)
      : resolveInheritedForkModel(
          deps.sessionMetadataService?.getRequestedModel(sessionId),
          sourceProcess?.resolvedModel,
          sourceProcess?.model,
        );
    if (!fork.launchSettings && !inheritedModel) {
      const fullSummary = await findSessionSummaryAcrossProviders(
        project,
        sessionId,
        projectId,
        providerResolutionDeps(deps),
        providerName,
      );
      inheritedModel = resolveInheritedForkModel(
        deps.sessionMetadataService?.getRequestedModel(sessionId),
        fullSummary?.summary.model,
      );
    }
    await persistLaunchMetadata(
      fork.sessionId,
      providerName,
      savedExecutor,
      undefined,
      inheritedModel,
      originalMetadata?.promptSuggestionMode,
      originalMetadata?.recapAfterSeconds,
      {
        level: originalMetadata?.sandboxLevel ?? "none",
        networkFirewall: persistedSandboxNetworkFirewall(originalMetadata),
        stateKey: fork.sandboxStateKey ?? originalMetadata?.sandboxStateKey,
        projectPath: forkProjectPath,
        projectId:
          originalMetadata?.workingProjectId ?? (projectId as UrlProjectId),
      },
    );
    const forkCreator = actingUsername(c);
    if (forkCreator) {
      // A limited user's fork is theirs, like a session they start
      // (topics/limited-users.md § Delivery v1).
      await deps.sessionMetadataService?.recordSessionCreator(
        fork.sessionId,
        forkCreator,
      );
    }
    void deps.userUsageService?.recordSession(forkCreator);
    if (deps.sessionMetadataService) {
      await deps.sessionMetadataService.updateMetadata(fork.sessionId, {
        title: forkTitle,
        forkedFromSessionId: sessionId,
        forkLineageRootId,
      });
      deps.eventBus?.emit({
        type: "session-metadata-changed",
        sessionId: fork.sessionId,
        title: forkTitle,
        forkedFromSessionId: sessionId,
        timestamp: new Date().toISOString(),
      });
    }

    return c.json({
      sessionId: fork.sessionId,
      projectId,
      provider: providerName,
      title: forkTitle,
      forkedFrom: sessionId,
      upToMessageId,
      ...(forkKind ? { forkKind } : {}),
      ...(sourceMessageId ? { sourceMessageId } : {}),
      ...(retainedThroughMessageId ? { retainedThroughMessageId } : {}),
    });
  });

  // POST /api/projects/:projectId/sessions/:sessionId/retitle
  // Generate a proposed session title through an archived helper fork. This
  // never updates the source session title; the client must explicitly accept
  // the returned proposal through the ordinary metadata update route.
  routes.post("/projects/:projectId/sessions/:sessionId/retitle", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");
    if (isRoutedSession(sessionId)) {
      return c.json(
        { error: routedSessionUnsupportedMessage("Title generation") },
        409,
      );
    }

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }
    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found or path does not exist" }, 404);
    }
    if (!deps.sessionMetadataService) {
      return c.json({ error: "Session metadata service not available" }, 503);
    }

    let body: { currentTitle?: unknown; lengthTarget?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      // Body is optional.
    }

    const currentTitle =
      typeof body.currentTitle === "string"
        ? body.currentTitle.trim().slice(0, 200)
        : undefined;
    let lengthTarget: number | undefined;
    if (body.lengthTarget !== undefined) {
      if (
        typeof body.lengthTarget !== "number" ||
        !Number.isInteger(body.lengthTarget) ||
        body.lengthTarget < 20 ||
        body.lengthTarget > 132
      ) {
        return c.json(
          { error: "lengthTarget must be an integer between 20 and 132" },
          400,
        );
      }
      lengthTarget = body.lengthTarget;
    }

    const metadataProvider = deps.sessionMetadataService.getProvider(
      sessionId,
    ) as ProviderName | undefined;
    let sourceProcess = deps.supervisor.getProcessForSession(sessionId);
    const liveSourceProcess =
      sourceProcess && !sourceProcess.isTerminated ? sourceProcess : undefined;
    const sessionSummaryResult = await findSessionListSummaryAcrossProviders(
      project,
      sessionId,
      projectId,
      providerResolutionDeps(deps),
      liveSourceProcess?.provider ?? metadataProvider,
    );
    const providerName =
      liveSourceProcess?.provider ??
      metadataProvider ??
      sessionSummaryResult?.source.provider ??
      sourceProcess?.provider ??
      project.provider;
    if (!deps.supervisor.supportsForkSession(providerName)) {
      return c.json(
        { error: `${providerName} does not support transcript fork` },
        400,
      );
    }

    const savedExecutor = parseOptionalExecutor(
      deps.sessionMetadataService.getExecutor(sessionId),
    ).executor;
    let requestedModel = resolveInheritedForkModel(
      deps.sessionMetadataService.getRequestedModel(sessionId),
      liveSourceProcess?.resolvedModel,
      liveSourceProcess?.model,
    );
    if (!requestedModel) {
      const fullSummary = await findSessionSummaryAcrossProviders(
        project,
        sessionId,
        projectId,
        providerResolutionDeps(deps),
        providerName,
      );
      requestedModel = resolveInheritedForkModel(
        deps.sessionMetadataService.getRequestedModel(sessionId),
        fullSummary?.summary.model,
      );
    }
    const sourceMetadata = deps.sessionMetadataService.getMetadata?.(sessionId);
    const sourceProjectPath =
      sourceMetadata?.sandboxLevel === "project-write"
        ? (sourceMetadata.sandboxProjectPath ?? project.path)
        : project.path;
    const promptSuggestionMode = sourceMetadata?.promptSuggestionMode;
    const recapAfterSeconds = sourceMetadata?.recapAfterSeconds;
    const abortController = new AbortController();
    const abortFromRequest = () => abortController.abort();
    if (c.req.raw.signal.aborted) {
      abortController.abort();
    } else {
      c.req.raw.signal.addEventListener("abort", abortFromRequest, {
        once: true,
      });
    }

    let generatorSessionId: string | undefined;
    try {
      if (!liveSourceProcess) {
        sourceProcess = await deps.supervisor.reactivateSession(
          sourceProjectPath,
          sessionId,
          undefined,
          {
            model:
              requestedModel && requestedModel !== "default"
                ? requestedModel
                : undefined,
            providerName,
            executor: savedExecutor,
            ...inheritedSandboxSettings(sourceMetadata),
            globalInstructions: getGlobalInstructions(),
            promptSuggestionMode,
            recapAfterSeconds,
          },
          { requestedOverrides: {} },
        );
        requestedModel = resolveInheritedForkModel(
          requestedModel,
          sourceProcess.resolvedModel,
          sourceProcess.model,
        );
      }

      const generator = await deps.supervisor.forkSession({
        creation: {
          context: {
            owner: { kind: "superuser" },
            source: { kind: "internal", reason: "retitle" },
          },
          authorize: async () => {
            if (deps.signal?.aborted || abortController.signal.aborted)
              throw new Error("Summary job was cancelled");
          },
        },
        sessionId,
        projectPath: sourceProjectPath,
        providerName,
        title: "Retitle generator",
        ...inheritedSandboxSettings(sourceMetadata),
      });
      generatorSessionId = generator.sessionId;
      requestedModel =
        generator.launchSettings?.requestedModel ?? requestedModel;
      await updateForkSummaryChildMetadata(
        generator.sessionId,
        sessionId,
        "Retitle generator",
        true,
      );
      await persistLaunchMetadata(
        generator.sessionId,
        providerName,
        savedExecutor,
        undefined,
        requestedModel,
        promptSuggestionMode,
        recapAfterSeconds,
        {
          level: sourceMetadata?.sandboxLevel ?? "none",
          networkFirewall: persistedSandboxNetworkFirewall(sourceMetadata),
          stateKey:
            generator.sandboxStateKey ?? sourceMetadata?.sandboxStateKey,
          projectPath: sourceProjectPath,
          projectId:
            sourceMetadata?.workingProjectId ?? (projectId as UrlProjectId),
        },
      );
      if (abortController.signal.aborted) {
        throw new DOMException("Retitle cancelled", "AbortError");
      }

      const generated = await deps.supervisor.generateSummary(providerName, {
        purpose: "session-retitle",
        strategy: "fork",
        generatorSessionId: generator.sessionId,
        cwd: sourceProjectPath,
        model: requestedModel,
        currentTitle,
        lengthTarget,
        signal: abortController.signal,
        sessionSandbox: generator.sessionSandbox,
      });
      const title = generatedRetitleCandidate(generated.text);
      if (!title) {
        throw new Error("Retitle generation returned empty title");
      }
      return c.json({ title, generatorSessionId: generator.sessionId });
    } catch (error) {
      const cancelled =
        abortController.signal.aborted ||
        (error instanceof DOMException && error.name === "AbortError");
      const message =
        error instanceof Error ? error.message : "Retitle generation failed";
      getLogger().warn(
        {
          event: cancelled
            ? "session_retitle_cancelled"
            : "session_retitle_failed",
          sessionId,
          projectId,
          providerName,
          generatorSessionId,
          error: message,
        },
        cancelled ? "Session retitle cancelled" : "Session retitle failed",
      );
      return c.json({ error: message }, cancelled ? 400 : 500);
    } finally {
      c.req.raw.signal.removeEventListener("abort", abortFromRequest);
      abortController.abort();
    }
  });

  // POST /api/projects/:projectId/sessions/:sessionId/fork-summary
  // Start a server-owned whole-context fork-after-summary job. The response
  // returns after durable job creation; generation continues independently of
  // the requesting client connection.
  routes.post(
    "/projects/:projectId/sessions/:sessionId/fork-summary",
    async (c) => {
      const projectId = c.req.param("projectId");
      const sessionId = c.req.param("sessionId");
      // Its summary step calls the provider directly, without the pin.
      if (isRoutedSession(sessionId)) {
        return c.json(
          { error: routedSessionUnsupportedMessage("Fork with summary") },
          409,
        );
      }

      if (!isUrlProjectId(projectId)) {
        return c.json({ error: "Invalid project ID format" }, 400);
      }
      const project = await deps.scanner.getOrCreateProject(projectId);
      if (!project) {
        return c.json(
          { error: "Project not found or path does not exist" },
          404,
        );
      }

      let body: {
        sourceMessageId?: unknown;
        instructions?: unknown;
        mode?: unknown;
        autoOpenWhenReady?: unknown;
      };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      const sourceMessageId =
        typeof body.sourceMessageId === "string" && body.sourceMessageId.trim()
          ? body.sourceMessageId.trim()
          : undefined;
      if (!sourceMessageId) {
        return c.json({ error: "sourceMessageId is required" }, 400);
      }
      if (
        body.mode !== undefined &&
        (typeof body.mode !== "string" ||
          !ALL_PERMISSION_MODES.includes(body.mode as PermissionMode))
      ) {
        return c.json({ error: "Invalid permission mode" }, 400);
      }
      if (
        body.autoOpenWhenReady !== undefined &&
        typeof body.autoOpenWhenReady !== "boolean"
      ) {
        return c.json({ error: "autoOpenWhenReady must be a boolean" }, 400);
      }
      const mode = body.mode as PermissionMode | undefined;
      const instructions =
        typeof body.instructions === "string" ? body.instructions : undefined;
      const autoOpenWhenReady = body.autoOpenWhenReady === true;

      const metadataProvider = deps.sessionMetadataService?.getProvider(
        sessionId,
      ) as ProviderName | undefined;
      const sourceProcess = deps.supervisor.getProcessForSession(sessionId);
      const providerName =
        metadataProvider ?? sourceProcess?.provider ?? project.provider;
      if (!deps.supervisor.supportsForkSession(providerName)) {
        return c.json(
          { error: `${providerName} does not support transcript fork` },
          400,
        );
      }
      if (!deps.sessionMetadataService) {
        return c.json({ error: "Session metadata service not available" }, 503);
      }
      const originalMetadata =
        deps.sessionMetadataService.getMetadata?.(sessionId);
      const sourceProjectPath =
        originalMetadata?.sandboxLevel === "project-write"
          ? (originalMetadata.sandboxProjectPath ?? project.path)
          : project.path;
      if (activeForkSummaryJobs.has(sessionId)) {
        return c.json(
          { error: "A fork summary is already generating for this session" },
          409,
        );
      }

      const sourceSession = await loadRestartSourceSession(
        project,
        sessionId,
        projectId,
        providerName,
        sourceProcess,
      );
      if (!sourceSession) {
        return c.json({ error: "Source session not found" }, 404);
      }
      const boundary = resolveForkAfterBoundary(
        sourceSession.messages,
        sourceMessageId,
        sourceProcess?.state.type === "in-turn" ||
          sourceProcess?.state.type === "waiting-input",
        providerName,
      );
      if ("error" in boundary) {
        return c.json({ error: boundary.error }, boundary.status);
      }

      const displayObject: TranscriptDisplayObject = {
        id: randomUUID(),
        kind: "fork-summary",
        createdAt: new Date().toISOString(),
        placementAfterMessageId: boundary.placementAfterMessageId,
        sourceMessageId,
        retainedThroughMessageId: boundary.retainedThroughMessageId,
        status: "generating",
        autoOpenWhenReady: autoOpenWhenReady || undefined,
      };
      const abortController = new AbortController();
      activeForkSummaryJobs.set(sessionId, {
        objectId: displayObject.id,
        abortController,
      });
      try {
        await deps.sessionMetadataService.addTranscriptDisplayObject(
          sessionId,
          displayObject,
        );
      } catch (error) {
        activeForkSummaryJobs.delete(sessionId);
        throw error;
      }
      emitTranscriptDisplayObjects(sessionId);

      const baseTitle = normalizeRestartTitleCandidate(
        originalMetadata?.customTitle ?? sourceSession.title,
      );
      // Claim a fork ordinal only when the generated summary yields no title,
      // so an unused number is not burned on every fork-after-summary. The
      // lineage the target belongs to is recorded either way.
      const forkLineageRootId =
        deps.sessionMetadataService.forkLineageRoot(sessionId);
      let fallbackClaim: ForkOrdinalClaim | undefined;
      const fallbackTitle = async (): Promise<string | undefined> => {
        if (!baseTitle) return undefined;
        fallbackClaim =
          await deps.sessionMetadataService?.nextForkOrdinal(sessionId);
        return forkTitleWithOrdinal(baseTitle, fallbackClaim?.ordinal ?? 1);
      };
      const savedExecutor = parseOptionalExecutor(
        deps.sessionMetadataService.getExecutor(sessionId),
      ).executor;
      let requestedModel = resolveInheritedForkModel(
        deps.sessionMetadataService.getRequestedModel(sessionId),
        sourceProcess?.resolvedModel,
        sourceSession.model,
        sourceProcess?.model,
      );
      const forkSummaryActor = actingUsername(c);

      void (async () => {
        let generatorSessionId: string | undefined;
        let targetSessionId: string | undefined;
        let targetTitle: string | undefined;
        let targetProcessId: string | undefined;
        let completed = false;
        try {
          const generator = await deps.supervisor.forkSession({
            creation: {
              context: {
                owner: { kind: "superuser" },
                source: { kind: "internal", reason: "fork-summary" },
              },
              authorize: async () => {
                if (deps.signal?.aborted || abortController.signal.aborted)
                  throw new Error("Summary job was cancelled");
              },
            },
            sessionId,
            projectPath: sourceProjectPath,
            providerName,
            title: "Fork summary generator",
            ...inheritedSandboxSettings(originalMetadata),
          });
          generatorSessionId = generator.sessionId;
          requestedModel =
            generator.launchSettings?.requestedModel ?? requestedModel;
          await updateForkSummaryChildMetadata(
            generator.sessionId,
            sessionId,
            "Fork summary generator",
            true,
          );
          await persistLaunchMetadata(
            generator.sessionId,
            providerName,
            savedExecutor,
            undefined,
            requestedModel,
            originalMetadata?.promptSuggestionMode,
            originalMetadata?.recapAfterSeconds,
            {
              level: originalMetadata?.sandboxLevel ?? "none",
              networkFirewall:
                persistedSandboxNetworkFirewall(originalMetadata),
              stateKey:
                generator.sandboxStateKey ?? originalMetadata?.sandboxStateKey,
              projectPath: sourceProjectPath,
              projectId:
                originalMetadata?.workingProjectId ??
                (projectId as UrlProjectId),
            },
          );
          if (abortController.signal.aborted) {
            throw new DOMException("Fork summary cancelled", "AbortError");
          }

          const generated = await deps.supervisor.generateSummary(
            providerName,
            {
              purpose: "fork-after-summary",
              strategy: "fork",
              generatorSessionId: generator.sessionId,
              cwd: sourceProjectPath,
              model: requestedModel,
              afterTurnMessageId: boundary.retainedThroughMessageId,
              afterTurnContext: boundary.retainedThroughContext,
              instructions,
              signal: abortController.signal,
              sessionSandbox: generator.sessionSandbox,
            },
          );
          if (abortController.signal.aborted) {
            throw new DOMException("Fork summary cancelled", "AbortError");
          }

          const summaryTitle = forkSummaryTitleCandidate(generated.text);
          const title = summaryTitle
            ? truncateSessionTitle(summaryTitle)
            : ((await fallbackTitle()) ?? "Forked session");
          targetTitle = title;
          const targetCreation = creationForRequest(c, undefined);
          const target = await deps.supervisor.forkSession({
            initialPrompt: generated.text,
            creation: {
              ...targetCreation,
              requestId: `fork-summary-target-${displayObject.id}`,
              authorize: async (saved) => {
                if (abortController.signal.aborted)
                  throw new Error("Fork summary was cancelled");
                return (await targetCreation.authorize(saved)) ?? undefined;
              },
              onAccepted: async (saved) => {
                targetSessionId = saved.sessionId;
                await deps.sessionMetadataService!.updateTranscriptDisplayObject(
                  sessionId,
                  displayObject.id,
                  (object) =>
                    object.kind !== "fork-summary"
                      ? object
                      : { ...object, targetSessionId: saved.sessionId },
                );
                emitTranscriptDisplayObjects(sessionId);
              },
            },
            sessionId,
            launchSettings: generator.launchSettings,
            launchOverrides:
              mode !== undefined ? { permissionMode: mode } : undefined,
            projectPath: sourceProjectPath,
            providerName,
            ...(boundary.providerBoundary
              ? { boundary: boundary.providerBoundary }
              : { upToMessageId: boundary.retainedThroughMessageId }),
            title,
            ...inheritedSandboxSettings(originalMetadata),
          });
          targetSessionId = target.sessionId;
          void deps.userUsageService?.recordSession(forkSummaryActor);
          await updateForkSummaryChildMetadata(
            target.sessionId,
            sessionId,
            title,
            true,
            forkLineageRootId,
          );
          await persistLaunchMetadata(
            target.sessionId,
            providerName,
            savedExecutor,
            undefined,
            requestedModel,
            originalMetadata?.promptSuggestionMode,
            originalMetadata?.recapAfterSeconds,
            {
              level: originalMetadata?.sandboxLevel ?? "none",
              networkFirewall:
                persistedSandboxNetworkFirewall(originalMetadata),
              stateKey:
                target.sandboxStateKey ?? originalMetadata?.sandboxStateKey,
              projectPath: sourceProjectPath,
              projectId:
                originalMetadata?.workingProjectId ??
                (projectId as UrlProjectId),
            },
          );
          if (abortController.signal.aborted) {
            throw new DOMException("Fork summary cancelled", "AbortError");
          }

          const result = await deps.supervisor.resumeSession(
            target.sessionId,
            sourceProjectPath,
            { text: generated.text, mode },
            mode,
            {
              providerName,
              executor: savedExecutor,
              ...inheritedSandboxSettings({
                ...originalMetadata,
                sandboxStateKey:
                  target.sandboxStateKey ?? originalMetadata?.sandboxStateKey,
              }),
              globalInstructions: getGlobalInstructions(),
              model: requestedModel,
              promptSuggestionMode: originalMetadata?.promptSuggestionMode,
              recapAfterSeconds: originalMetadata?.recapAfterSeconds,
              ...resolveCompactModelSettings(deps, {
                provider: providerName,
                yaModelId: requestedModel,
                modelCandidates: [requestedModel],
              }),
            },
          );
          if (isQueueFullResponse(result)) {
            throw new Error("Queue is full");
          }
          if (isQueuedResponse(result)) {
            deps.supervisor.cancelQueuedRequest(result.queueId);
            throw new Error("Fork summary could not start immediately");
          }
          targetProcessId = result.id;
          if (abortController.signal.aborted) {
            await deps.supervisor.abortProcess(result.id);
            targetProcessId = undefined;
            throw new DOMException("Fork summary cancelled", "AbortError");
          }

          await persistLaunchMetadata(
            result.sessionId,
            providerName,
            savedExecutor,
            undefined,
            requestedModel,
            result.promptSuggestionMode,
            result.recapAfterSeconds,
            {
              level: originalMetadata?.sandboxLevel ?? "none",
              networkFirewall:
                persistedSandboxNetworkFirewall(originalMetadata),
              stateKey:
                result.sandboxStateKey ??
                target.sandboxStateKey ??
                originalMetadata?.sandboxStateKey,
              projectPath: result.sandboxProjectPath ?? result.projectPath,
              projectId: result.projectId,
            },
          );
          await updateForkSummaryChildMetadata(
            result.sessionId,
            sessionId,
            title,
            false,
            forkLineageRootId,
          );
          await deps.sessionMetadataService?.updateTranscriptDisplayObject(
            sessionId,
            displayObject.id,
            (object) =>
              object.kind !== "fork-summary"
                ? object
                : {
                    ...object,
                    status: "ready",
                    targetSessionId: result.sessionId,
                    title,
                    error: undefined,
                  },
          );
          emitTranscriptDisplayObjects(sessionId);
          completed = true;
        } catch (error) {
          const cancelled =
            abortController.signal.aborted ||
            (error instanceof DOMException && error.name === "AbortError");
          const logCleanupFailure = (
            stage: string,
            cleanupError: unknown,
          ): void => {
            getLogger().warn(
              {
                event: "fork_after_summary_cleanup_failed",
                sessionId,
                projectId,
                providerName,
                stage,
                error:
                  cleanupError instanceof Error
                    ? cleanupError.message
                    : String(cleanupError),
              },
              "Fork-after-summary cleanup failed",
            );
          };
          if (generatorSessionId) {
            try {
              await updateForkSummaryChildMetadata(
                generatorSessionId,
                sessionId,
                "Fork summary generator",
                true,
              );
            } catch (cleanupError) {
              logCleanupFailure("archive-generator", cleanupError);
            }
          }
          if (targetSessionId && targetTitle) {
            try {
              await updateForkSummaryChildMetadata(
                targetSessionId,
                sessionId,
                targetTitle,
                true,
              );
            } catch (cleanupError) {
              logCleanupFailure("archive-target", cleanupError);
            }
          } else if (
            fallbackClaim &&
            !(error instanceof ForkSettingsPersistenceError)
          ) {
            try {
              await deps.sessionMetadataService?.releaseForkOrdinal(
                fallbackClaim,
              );
            } catch (cleanupError) {
              logCleanupFailure("release-fork-ordinal", cleanupError);
            }
          }
          if (!completed && targetProcessId) {
            try {
              await deps.supervisor.abortProcess(targetProcessId);
            } catch (cleanupError) {
              logCleanupFailure("abort-target-process", cleanupError);
            }
          }
          if (!cancelled) {
            const message =
              error instanceof Error
                ? error.message
                : "Summary generation failed";
            getLogger().warn(
              {
                event: "fork_after_summary_failed",
                sessionId,
                projectId,
                providerName,
                sourceMessageId,
                error: message,
              },
              "Fork-after-summary job failed",
            );
            try {
              await deps.sessionMetadataService?.updateTranscriptDisplayObject(
                sessionId,
                displayObject.id,
                (object) =>
                  object.kind !== "fork-summary"
                    ? object
                    : {
                        ...object,
                        status: "error",
                        error: message,
                      },
              );
              emitTranscriptDisplayObjects(sessionId);
            } catch (cleanupError) {
              logCleanupFailure("persist-error-state", cleanupError);
            }
          }
        } finally {
          const active = activeForkSummaryJobs.get(sessionId);
          if (active?.objectId === displayObject.id) {
            activeForkSummaryJobs.delete(sessionId);
          }
        }
      })().catch((error) => {
        getLogger().error(
          {
            event: "fork_after_summary_unhandled_failure",
            sessionId,
            projectId,
            providerName,
            sourceMessageId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Fork-after-summary job escaped its guarded workflow",
        );
      });

      return c.json({ displayObject }, 202);
    },
  );

  routes.post(
    "/projects/:projectId/sessions/:sessionId/fork-summary/:objectId/cancel",
    async (c) => {
      const projectId = c.req.param("projectId");
      const sessionId = c.req.param("sessionId");
      const objectId = c.req.param("objectId");
      if (!isUrlProjectId(projectId)) {
        return c.json({ error: "Invalid project ID format" }, 400);
      }
      const active = activeForkSummaryJobs.get(sessionId);
      const object = deps.sessionMetadataService
        ?.getTranscriptDisplayObjects(sessionId)
        .find((candidate) => candidate.id === objectId);
      if (!object) {
        return c.json({ error: "Transcript display object not found" }, 404);
      }
      if (active?.objectId === objectId && object.status === "generating") {
        active.abortController.abort();
      } else if (object.status !== "error") {
        return c.json({ error: "Fork summary job is not active" }, 409);
      }
      await deps.sessionMetadataService?.removeTranscriptDisplayObject(
        sessionId,
        objectId,
      );
      emitTranscriptDisplayObjects(sessionId);
      return c.json({
        transcriptDisplayObjects:
          deps.sessionMetadataService?.getTranscriptDisplayObjects(sessionId) ??
          [],
      });
    },
  );

  routes.patch(
    "/projects/:projectId/sessions/:sessionId/fork-summary/:objectId",
    async (c) => {
      const projectId = c.req.param("projectId");
      const sessionId = c.req.param("sessionId");
      const objectId = c.req.param("objectId");
      if (!isUrlProjectId(projectId)) {
        return c.json({ error: "Invalid project ID format" }, 400);
      }
      if (!deps.sessionMetadataService) {
        return c.json({ error: "Session metadata service not available" }, 503);
      }
      let body: { autoOpenWhenReady?: unknown; action?: unknown };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      const action =
        body.action === "opened" || body.action === "clicked"
          ? body.action
          : undefined;
      if (
        body.autoOpenWhenReady !== undefined &&
        typeof body.autoOpenWhenReady !== "boolean"
      ) {
        return c.json({ error: "autoOpenWhenReady must be a boolean" }, 400);
      }
      if (body.action !== undefined && !action) {
        return c.json({ error: "action must be opened or clicked" }, 400);
      }
      const now = new Date().toISOString();
      const updated =
        await deps.sessionMetadataService.updateTranscriptDisplayObject(
          sessionId,
          objectId,
          (object) =>
            object.kind !== "fork-summary"
              ? object
              : {
                  ...object,
                  ...(typeof body.autoOpenWhenReady === "boolean"
                    ? { autoOpenWhenReady: body.autoOpenWhenReady || undefined }
                    : {}),
                  ...(action === "opened" ? { openedAt: now } : {}),
                  ...(action === "clicked" ? { clickedAt: now } : {}),
                },
        );
      if (!updated) {
        return c.json({ error: "Transcript display object not found" }, 404);
      }
      emitTranscriptDisplayObjects(sessionId);
      return c.json({
        displayObject: updated,
        transcriptDisplayObjects:
          deps.sessionMetadataService.getTranscriptDisplayObjects(sessionId),
      });
    },
  );

  // POST /api/sessions/:sessionId/messages - Queue message
  routes.post("/sessions/:sessionId/messages", async (c) => {
    const sessionId = c.req.param("sessionId");

    const process = deps.supervisor.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ error: "No active process for session" }, 404);
    }

    let body: StartSessionBody & { deferred?: boolean };
    try {
      body = await c.req.json<StartSessionBody & { deferred?: boolean }>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (
      body.routerAccountId !== undefined ||
      body.routerPoolId !== undefined ||
      body.routerPolicy !== undefined ||
      body.routerClaudeAiConnectors !== undefined
    ) {
      return c.json(
        {
          error:
            "Router account selection is only supported when creating a session; resumed sessions retain their pin",
        },
        400,
      );
    }

    const modeError = permissionModeError(body.mode);
    if (modeError) {
      return c.json({ error: modeError }, 400);
    }

    if (!hasSessionMessageContent(body)) {
      return c.json({ error: "Message is required" }, 400);
    }

    const serverTimestamp = Date.now();
    const userMessage: UserMessage = {
      text: body.message,
      images: body.images,
      documents: body.documents,
      attachments: body.attachments,
      mode: body.mode,
      tempId: body.tempId,
      metadata: buildUserMessageMetadata(
        body,
        serverTimestamp,
        body.deferred ? "deferred" : "direct",
        actingUsername(c),
      ),
    };

    if (
      userMessage.metadata?.turnEffort &&
      process.provider !== "codex" &&
      !isClaudeSdkProviderName(process.provider)
    ) {
      return c.json(
        { error: "This provider does not support one-turn effort modifiers" },
        400,
      );
    }

    // Check if process is terminated
    if (process.isTerminated) {
      return c.json(
        {
          error: "Process terminated",
          reason: process.terminationReason,
        },
        410,
      ); // 410 Gone
    }

    // Invalidate speculative idle work before any provider-native command or
    // delivery preparation can await.
    process.noteInputIntent();

    // Past the request-shape guards this turn is delivered or queued, so it
    // counts here rather than at each of the branches below.
    void deps.userUsageService?.recordTurn(actingUsername(c), userMessage.text);

    // Provider-native slash commands (e.g. Codex `/compact`) are dispatched
    // through the provider's own protocol rather than delivered as turn text the
    // model would never interpret. Claude's `/compact` reports handled:false and
    // falls through to normal delivery so the SDK handles it as a regular turn
    // (and any trailing focus instructions reach the SDK verbatim). Native
    // controls stay out-of-band except explicitly queued compaction, which
    // must retain its selected delivery boundary.
    const parsed = parseSlashCommandSubmission(body.message);
    if (parsed?.name === "compact" && body.deferred) {
      if (
        process.provider !== "codex" &&
        !isClaudeSdkProviderName(process.provider)
      )
        return c.json(
          { error: "Queued compaction is unavailable for this provider" },
          409,
        );
      if (
        userMessage.attachments?.length ||
        userMessage.images?.length ||
        userMessage.documents?.length
      )
        return c.json(
          { error: "Queue compaction separately from attachments" },
          400,
        );
      const commands = await process.supportedCommands();
      if (
        !commands?.some(
          (command) => command.name.replace(/^\//, "") === "compact",
        )
      )
        return c.json(
          { error: "This session does not advertise compaction" },
          409,
        );
      if (userMessage.metadata)
        userMessage.metadata.compactAboveContextPercent = undefined;
      userMessage.queuedCompact = {
        command: "compact",
        argument: parsed.argument,
      };
    }
    if (parsed && !userMessage.queuedCompact) {
      const providerResult = await dispatchProviderCommand(
        process,
        parsed,
        body.tempId,
        deps.sessionMetadataService,
      );
      if (providerResult.handled) {
        if (providerResult.error) {
          return c.json(
            { error: providerResult.error, reason: providerResult.error },
            409,
          );
        }
        return c.json({ queued: true, serverTimestamp });
      }
    }

    // Uploads arriving outside the composer follow this choice in "auto".
    process.noteBusySendAction(userMessage);

    // Retained for response compatibility. YA no longer chooses an implicit
    // model-specific threshold; only an explicit per-model setting can trigger
    // early compaction.
    const compactQueued = false;

    // Deferred messages stay server-side until Process reaches a safe delivery
    // boundary. If the process is already idle, Process can accept them now.
    if (
      body.deferred ||
      process.queuedCompactionBlocksInput ||
      (userMessage.metadata?.turnEffort && process.state.type !== "idle")
    ) {
      if (body.mode) {
        process.setPermissionMode(body.mode);
      }
      await process.primeSupportedCommandsForMessage(userMessage);
      const deferredResult = process.deferMessage(userMessage, {
        promoteIfReady: true,
      });
      if (!deferredResult.success) {
        return c.json(
          {
            error: "Failed to queue message",
            reason: deferredResult.error,
          },
          410,
        );
      }
      await process.waitForPatientQueuePersistenceIdle();
      return c.json({
        queued: true,
        deferred: deferredResult.deferred,
        promoted: deferredResult.promoted,
        position: deferredResult.position,
        deferredMessages: sessionQueueSummaries(deps, sessionId, process),
        serverTimestamp,
      });
    }

    const { thinking, effort } = buildThinkingOptions(body);

    const metadataProvider = deps.sessionMetadataService?.getProvider(
      sessionId,
    ) as ProviderName | undefined;
    const metadataExecutor = parseOptionalExecutor(
      deps.sessionMetadataService?.getExecutor(sessionId),
    );
    if (metadataExecutor.error) {
      return c.json({ error: metadataExecutor.error }, 400);
    }
    const { executor, error: executorError } = parseOptionalExecutor(
      body.executor,
    );
    if (executorError) {
      return c.json({ error: executorError }, 400);
    }

    const model =
      body.model && body.model !== "default"
        ? body.model
        : (process.resolvedModel ?? process.model);
    const serviceTier = normalizeOptionalServiceTier(body.serviceTier);
    const requestedProvider =
      metadataProvider ?? body.provider ?? process.provider;

    // Per-model preemptive-compaction threshold (task 029). The route holds the
    // settings; the Supervisor stays settings-agnostic. Key strictly by the YA
    // model id: the alias the user picked this turn, else the live requested
    // alias, else the alias persisted at launch (survives restart), else the
    // provider's reported→YA-id helper for sessions YA didn't start. No family
    // fallback. See topics/provider-abstraction.md § Per-model settings keying.
    const yaModelId =
      body.model ??
      process.requestedModel ??
      deps.sessionMetadataService?.getRequestedModel(sessionId) ??
      getProvider(requestedProvider)?.yaModelIdForReported?.(
        process.resolvedModel,
      );
    const compactSettings = resolveCompactModelSettings(deps, {
      provider: requestedProvider,
      yaModelId,
      modelCandidates: [yaModelId, process.resolvedModel, process.model],
    });

    // Use queueMessageToSession which handles thinking mode changes
    // If thinking mode changed, it will restart the process automatically
    const queueGlobalInstructions = getGlobalInstructions();
    const result = await deps.supervisor.queueMessageToSession(
      sessionId,
      process.projectPath,
      userMessage,
      body.mode,
      {
        model,
        serviceTier,
        thinking,
        effort,
        providerName: requestedProvider,
        executor:
          executor ??
          metadataExecutor.executor ??
          process.executor ??
          undefined,
        globalInstructions: queueGlobalInstructions,
        permissions: body.permissions,
        ...compactSettings,
      },
    );

    if (!result.success) {
      return c.json(
        {
          error: "Failed to queue message",
          reason: result.error,
        },
        410,
      ); // 410 Gone - process is no longer available
    }

    return c.json({
      queued: true,
      compactQueued,
      restarted: result.restarted,
      processId: result.process.id,
      serverTimestamp,
    });
  });

  // DELETE /api/sessions/:sessionId/recovered-queue/:queueId - Delete a
  // restart-paused patient queue entry by durable queue id.
  routes.delete("/sessions/:sessionId/recovered-queue/:queueId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const queueId = c.req.param("queueId");
    const service = deps.sessionQueuePersistenceService;
    if (!service) {
      return c.json({ error: "Session queue persistence unavailable" }, 503);
    }

    const item = service
      .listSession(sessionId)
      .find((candidate) => candidate.id === queueId);
    if (item?.kind !== "patient" || item.status !== "paused-after-restart") {
      return c.json({ error: "Recovered queued message not found" }, 404);
    }

    await service.deleteItem(queueId);
    return c.json({
      deleted: true,
      deferredMessages: sessionQueueSummaries(
        deps,
        sessionId,
        deps.supervisor.getProcessForSession(sessionId),
      ),
    });
  });

  const recoveredQueueDeps = {
    sessionQueuePersistenceService: deps.sessionQueuePersistenceService,
    sessionMetadataService: deps.sessionMetadataService,
    supervisor: deps.supervisor,
    getGlobalInstructions,
    persistLaunchMetadata,
  };

  // POST /api/sessions/:sessionId/recovered-queue/:queueId/resume - Move
  // restart-paused patient queue entries back into the live patient queue,
  // through the requested entry: resuming a non-head entry also resumes every
  // recovered entry before it, so compose order is preserved.
  routes.post(
    "/sessions/:sessionId/recovered-queue/:queueId/resume",
    async (c) => {
      const sessionId = c.req.param("sessionId");
      const queueId = c.req.param("queueId");
      const resolved = await resolveRecoveredGroupForDelivery(
        recoveredQueueDeps,
        sessionId,
        queueId,
        "Drain or cancel newer queued messages before resuming recovered work.",
      );
      if (!resolved.ok) {
        return c.json(resolved.body, resolved.status);
      }
      const { process, group } = resolved;

      const { last, error } = await resumeRecoveredGroup(process, group, {
        promoteIfReady: true,
      });
      if (error || !last) {
        return c.json(
          {
            error: "Failed to resume recovered queued message",
            reason: error,
            deferredMessages: sessionQueueSummaries(deps, sessionId, process),
          },
          409,
        );
      }

      await process.waitForPatientQueuePersistenceIdle();
      return c.json({
        resumed: true,
        resumedCount: group.length,
        deferred: last.deferred,
        promoted: last.promoted,
        position: last.position,
        processId: process.id,
        processState: reportableProcessState(process),
        permissionMode: process.permissionMode,
        appliedPermissionMode: process.appliedPermissionMode,
        modeVersion: process.modeVersion,
        recapAfterSeconds: process.recapAfterSeconds,
        deferredMessages: sessionQueueSummaries(deps, sessionId, process),
        serverTimestamp: Date.now(),
      });
    },
  );

  // POST /api/sessions/:sessionId/recovered-queue/:queueId/steer - Steer a
  // restart-paused patient queue entry into the session now, without waiting
  // for verified quiet: the entry and every recovered or live patient entry
  // composed before it rejoin the live queue and steer in compose order.
  routes.post(
    "/sessions/:sessionId/recovered-queue/:queueId/steer",
    async (c) => {
      const sessionId = c.req.param("sessionId");
      const queueId = c.req.param("queueId");
      const resolved = await resolveRecoveredGroupForDelivery(
        recoveredQueueDeps,
        sessionId,
        queueId,
        "Drain or cancel newer queued messages before steering recovered work.",
      );
      if (!resolved.ok) {
        return c.json(resolved.body, resolved.status);
      }
      const { process, group } = resolved;

      const { lastMessage, error } = await resumeRecoveredGroup(
        process,
        group,
        { promoteIfReady: false },
      );
      if (error || !lastMessage?.tempId) {
        return c.json(
          {
            error: "Failed to steer recovered queued message",
            reason: error,
            deferredMessages: sessionQueueSummaries(deps, sessionId, process),
          },
          409,
        );
      }

      const steerResult = process.steerPatientDeferredMessagesThrough(
        lastMessage.tempId,
      );
      if (!steerResult.success) {
        return c.json(
          {
            error:
              steerResult.error ?? "Failed to steer recovered queued message",
            deferredMessages: sessionQueueSummaries(deps, sessionId, process),
          },
          409,
        );
      }

      await process.waitForPatientQueuePersistenceIdle();
      return c.json({
        steered: true,
        count: steerResult.steered,
        processId: process.id,
        processState: reportableProcessState(process),
        permissionMode: process.permissionMode,
        appliedPermissionMode: process.appliedPermissionMode,
        modeVersion: process.modeVersion,
        recapAfterSeconds: process.recapAfterSeconds,
        deferredMessages: sessionQueueSummaries(deps, sessionId, process),
        serverTimestamp: Date.now(),
      });
    },
  );

  // DELETE /api/sessions/:sessionId/deferred/:tempId - Cancel a deferred message
  routes.delete("/sessions/:sessionId/deferred/:tempId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const tempId = c.req.param("tempId");

    const process = deps.supervisor.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ error: "No active process for session" }, 404);
    }

    const cancelled = process.cancelDeferredMessage(tempId);
    if (!cancelled) {
      return c.json({ error: "Deferred message not found" }, 404);
    }

    await process.waitForPatientQueuePersistenceIdle();
    return c.json({ cancelled: true });
  });

  // DELETE /api/sessions/:sessionId/steering/:tempId - Cancel a sent steering
  // message that has not yet been consumed by the provider.
  routes.delete("/sessions/:sessionId/steering/:tempId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const tempId = c.req.param("tempId");

    const process = deps.supervisor.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ error: "No active process for session" }, 404);
    }

    const cancelled = process.cancelUnconfirmedSteerMessage(tempId);
    if (!cancelled) {
      return c.json(
        { error: "Steering message already acted on or not found" },
        404,
      );
    }

    return c.json({ cancelled: true });
  });

  // POST /api/sessions/:sessionId/deferred/:tempId/steer - Steer a patient
  // queued message, and every patient entry ahead of it, into the session now.
  routes.post("/sessions/:sessionId/deferred/:tempId/steer", async (c) => {
    const sessionId = c.req.param("sessionId");
    const tempId = c.req.param("tempId");

    const process = deps.supervisor.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ error: "No active process for session" }, 404);
    }

    const result = process.steerPatientDeferredMessagesThrough(tempId);
    if (!result.success) {
      const status = result.error === "Deferred message not found" ? 404 : 409;
      return c.json({ error: result.error }, status);
    }

    await process.waitForPatientQueuePersistenceIdle();
    return c.json({
      steered: true,
      count: result.steered,
      // Include any still-paused recovered entries so the client's list does
      // not lose their chips when a live entry is steered.
      deferredMessages: sessionQueueSummaries(deps, sessionId, process),
    });
  });

  // POST /api/sessions/:sessionId/deferred/:tempId/deliver-without-compaction
  // - Release a patient item held for compact-first delivery so it delivers at
  // its ordinary boundary without compacting.
  routes.post(
    "/sessions/:sessionId/deferred/:tempId/deliver-without-compaction",
    async (c) => {
      const sessionId = c.req.param("sessionId");
      const tempId = c.req.param("tempId");

      const process = deps.supervisor.getProcessForSession(sessionId);
      if (!process) {
        return c.json({ error: "No active process for session" }, 404);
      }
      if (!deps.supervisor.deliverPatientWithoutCompaction(process, tempId)) {
        return c.json({ error: "No compact-first queued message found" }, 404);
      }
      return c.json({
        released: true,
        deferredMessages: sessionQueueSummaries(deps, sessionId, process),
      });
    },
  );

  // PUT /api/sessions/:sessionId/mode - Update permission mode without sending a message
  routes.put("/sessions/:sessionId/mode", async (c) => {
    const sessionId = c.req.param("sessionId");
    const body = await c.req.json<{ mode: PermissionMode }>();

    if (!body.mode) {
      return c.json({ error: "mode is required" }, 400);
    }
    const modeError = permissionModeError(body.mode);
    if (modeError) {
      return c.json({ error: modeError }, 400);
    }

    const process = deps.supervisor.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ error: "No active process for session" }, 404);
    }

    process.setPermissionMode(body.mode);

    return c.json({
      permissionMode: process.permissionMode,
      appliedPermissionMode: process.appliedPermissionMode,
      modeVersion: process.modeVersion,
    });
  });

  // GET /api/sessions/:sessionId/pending-input - Get pending input request
  routes.get("/sessions/:sessionId/pending-input", async (c) => {
    const sessionId = c.req.param("sessionId");

    const process = deps.supervisor.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ request: null });
    }

    // Use getPendingInputRequest which works for both mock and real SDK
    const request = process.getPendingInputRequest();
    return c.json({ request });
  });

  // GET /api/sessions/:sessionId/process - Get process info for a session
  routes.get("/sessions/:sessionId/process", async (c) => {
    const sessionId = c.req.param("sessionId");

    const process = deps.supervisor.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ process: null });
    }

    return c.json({ process: process.getInfo() });
  });

  // POST /api/sessions/:sessionId/input - Respond to input request
  routes.post("/sessions/:sessionId/input", async (c) => {
    const sessionId = c.req.param("sessionId");

    const process = deps.supervisor.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ error: "No active process for session" }, 404);
    }

    let body: InputResponseBody;
    try {
      body = await c.req.json<InputResponseBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.requestId || !body.response) {
      return c.json({ error: "requestId and response are required" }, 400);
    }

    // Handle approve_accept_edits: approve and switch permission mode
    const isApproveAcceptEdits = body.response === "approve_accept_edits";

    // Normalize response to approve/deny
    const normalizedResponse =
      body.response === "approve" ||
      body.response === "allow" ||
      body.response === "approve_accept_edits"
        ? "approve"
        : "deny";

    const requestBefore = process.getPendingInputRequest();
    const permissionModeBefore = process.permissionMode;

    if (process.state.type !== "waiting-input") {
      if (isApprovalAuditLogEnabled(deps)) {
        try {
          await appendApprovalAuditLog(deps.dataDir, {
            timestamp: new Date().toISOString(),
            sessionId,
            processId: process.id,
            provider: process.provider,
            requestId: body.requestId,
            request: requestBefore,
            response: body.response,
            normalizedResponse,
            answers: body.answers,
            feedback: body.feedback,
            accepted: false,
            failure: "No pending input request",
            permissionModeBefore,
            permissionModeAfter: process.permissionMode,
          });
        } catch (error) {
          console.warn("[approval-audit] Failed to append audit log:", error);
        }
      }
      return c.json({ error: "No pending input request" }, 400);
    }

    // Call respondToInput which resolves the SDK's canUseTool promise
    const accepted = process.respondToInput(
      body.requestId,
      normalizedResponse,
      body.answers,
      body.feedback,
    );

    if (!accepted) {
      if (isApprovalAuditLogEnabled(deps)) {
        try {
          await appendApprovalAuditLog(deps.dataDir, {
            timestamp: new Date().toISOString(),
            sessionId,
            processId: process.id,
            provider: process.provider,
            requestId: body.requestId,
            request: requestBefore,
            response: body.response,
            normalizedResponse,
            answers: body.answers,
            feedback: body.feedback,
            accepted: false,
            failure: "Invalid request ID or no pending request",
            permissionModeBefore,
            permissionModeAfter: process.permissionMode,
          });
        } catch (error) {
          console.warn("[approval-audit] Failed to append audit log:", error);
        }
      }
      return c.json({ error: "Invalid request ID or no pending request" }, 400);
    }

    // Preserve a concurrently selected Bypass policy: this narrower legacy
    // combined action must not overwrite the user's newer standing choice.
    if (
      isApproveAcceptEdits &&
      process.permissionMode !== "bypassPermissions"
    ) {
      process.setPermissionMode("acceptEdits");
    }

    const pendingInputRequest = process.getPendingInputRequest();
    if (isApprovalAuditLogEnabled(deps)) {
      try {
        await appendApprovalAuditLog(deps.dataDir, {
          timestamp: new Date().toISOString(),
          sessionId,
          processId: process.id,
          provider: process.provider,
          requestId: body.requestId,
          request: requestBefore,
          response: body.response,
          normalizedResponse,
          answers: body.answers,
          feedback: body.feedback,
          accepted: true,
          permissionModeBefore,
          permissionModeAfter: process.permissionMode,
        });
      } catch (error) {
        console.warn("[approval-audit] Failed to append audit log:", error);
      }
    }

    return c.json({ accepted: true, pendingInputRequest });
  });

  registerSessionMetadataRoutes(routes, deps);

  // POST /api/projects/:projectId/sessions/:sessionId/clone - Clone a session
  routes.post("/projects/:projectId/sessions/:sessionId/clone", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    // Check provider supports cloning
    const supportedProviders = ["claude", "codex", "codex-oss"];
    if (!supportedProviders.includes(project.provider)) {
      return c.json(
        { error: `Clone is not supported for ${project.provider} sessions` },
        400,
      );
    }

    let body: {
      title?: string;
      provider?: ProviderName;
      parentSessionId?: string | null;
      creationProvenance?: unknown;
    } = {};
    try {
      body = await c.req.json();
    } catch {
      // Body is optional
    }

    if (
      body.parentSessionId !== undefined &&
      body.parentSessionId !== null &&
      typeof body.parentSessionId !== "string"
    ) {
      return c.json({ error: "parentSessionId must be a string or null" }, 400);
    }
    const parentSessionId =
      typeof body.parentSessionId === "string"
        ? body.parentSessionId.trim() || undefined
        : undefined;

    try {
      // A copy of a router-pinned session must be able to keep its account.
      deps.supervisor.assertRouterBindingInheritable(sessionId);
      // Get session directory from project
      let sessionDir = project.sessionDir;
      const sourceIdentity = storedIdentityFor(sessionId);
      const sourceLookup: SessionIdentityLookup = sourceIdentity
        ? { kind: "stored", identity: sourceIdentity }
        : { kind: "legacy" };
      if (sourceIdentity && !sourceIdentity.native)
        return c.json(
          { error: "Session has no native transcript to clone" },
          409,
        );
      if (!sessionDir) {
        return c.json({ error: "Session directory not found" }, 500);
      }

      // One operation-scoped identity snapshot owns every native source read.
      const originalMetadata =
        deps.sessionMetadataService?.getMetadata?.(sessionId);
      const sourceProject = await resolveExistingSessionIdentity({
        sessionId,
        requestProjectId: projectId,
        identityLookup: sourceLookup,
        preferredProvider: body.provider,
        metadata: originalMetadata,
        scanner: deps.scanner,
        providerDeps: providerResolutionDeps(deps),
      });
      // Keep the explicit legacy provider-probe boundary when there is no YA row.
      const transcriptProject = sourceProject?.transcriptProject ?? project;
      const transcriptProjectId =
        sourceProject?.transcriptProjectId ?? projectId;
      const originalResolution = await findSessionListSummaryAcrossProviders(
        transcriptProject,
        sessionId,
        transcriptProjectId,
        providerResolutionDeps(deps),
        body.provider,
        sourceLookup,
      );
      if (sourceIdentity && !originalResolution)
        return c.json({ error: "Session native transcript not found" }, 404);
      const originalNative =
        originalResolution?.native ??
        (await originalResolution?.source.reader.getNativeSessionRef?.(
          originalResolution.nativeSessionId,
        ));
      if (originalNative?.family === "claude")
        sessionDir = originalNative.storageScope;
      const originalSession = originalResolution?.summary ?? null;
      let cloneProvider: ProviderName =
        originalResolution?.source.provider ?? project.provider;

      const originalTitle =
        originalMetadata?.customTitle ?? originalSession?.title;
      const cloneTitle =
        body.title ?? (originalTitle ? `${originalTitle} [cloned]` : undefined);

      let result: { newSessionId: string; entries: number };

      const shouldCloneFromCodex =
        isCodexProviderName(body.provider) ||
        isCodexProviderName(originalResolution?.source.provider) ||
        isCodexProviderName(project.provider) ||
        (!originalSession && project.provider === "claude");

      const cloneSettings = !shouldCloneFromCodex
        ? await deps.supervisor.resolveForkLaunchSettings(
            sessionId,
            project.path,
            cloneProvider,
          )
        : undefined;

      if (shouldCloneFromCodex) {
        const codexReader = getCodexReader(project.path);
        if (!codexReader) {
          return c.json({ error: "Codex session reader not available" }, 500);
        }
        cloneProvider =
          originalResolution?.source.provider ??
          body.provider ??
          (isCodexProviderName(project.provider) ? project.provider : "codex");
        const forkProjectPath =
          originalMetadata?.sandboxLevel === "project-write"
            ? (originalMetadata.sandboxProjectPath ?? project.path)
            : project.path;
        const fork = await deps.supervisor.forkSession({
          creation: creationForRequest(c, undefined, {
            asideOf: parentSessionId === sessionId ? sessionId : undefined,
          }),
          sessionId,
          projectPath: forkProjectPath,
          providerName: cloneProvider,
          title: cloneTitle,
          ...inheritedSandboxSettings(originalMetadata),
        });
        if (originalMetadata?.sandboxLevel === "project-write") {
          await deps.sessionMetadataService?.setSessionSandbox(fork.sessionId, {
            level: originalMetadata.sandboxLevel,
            networkFirewall: persistedSandboxNetworkFirewall(originalMetadata),
            stateKey: fork.sandboxStateKey ?? originalMetadata.sandboxStateKey,
            projectPath: forkProjectPath,
            projectId:
              originalMetadata.workingProjectId ?? (projectId as UrlProjectId),
          });
        }
        result = {
          newSessionId: fork.sessionId,
          // Older /btw clients use this offset only until their prompt marker
          // arrives. A conservative bound hides inherited text without a scan.
          entries: Number.MAX_SAFE_INTEGER,
        };
      } else {
        const clone = await deps.supervisor.cloneSession({
          sessionId,
          projectPath: originalMetadata?.sandboxProjectPath ?? project.path,
          providerName: cloneProvider,
          title: cloneTitle,
          launchSettings: cloneSettings,
          creation: creationForRequest(c, body.creationProvenance, {
            asideOf: parentSessionId === sessionId ? sessionId : undefined,
          }),
          ...inheritedSandboxSettings(originalMetadata),
        });
        result = {
          newSessionId: clone.sessionId,
          entries: clone.entries ?? Number.MAX_SAFE_INTEGER,
        };
      }
      if (!shouldCloneFromCodex) {
        // The verbatim copy keeps every uuid, so the source's rewound groups
        // and any still-pending rewind mean the same rows in the clone
        // (topics/session-rewind.md).
        await deps.sessionMetadataService?.copyRewindState?.(
          sessionId,
          result.newSessionId,
        );
      }

      const cloneCreator = actingUsername(c);
      if (cloneCreator) {
        // A limited user's clone is theirs, like a session they start
        // (topics/limited-users.md § Delivery v1).
        await deps.sessionMetadataService?.recordSessionCreator(
          result.newSessionId,
          cloneCreator,
        );
      }
      void deps.userUsageService?.recordSession(cloneCreator);
      // Set clone metadata. /btw asides pass parentSessionId so the child
      // can jump back into the parent viewport.
      if (deps.sessionMetadataService) {
        await deps.sessionMetadataService.updateMetadata(result.newSessionId, {
          title: cloneTitle,
          parentSessionId,
          parentSessionKind: parentSessionId ? "btw-aside" : undefined,
          forkedFromSessionId: sessionId,
        });
      }

      return c.json({
        sessionId: result.newSessionId,
        messageCount: result.entries,
        clonedFrom: sessionId,
        provider: cloneProvider,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to clone session";
      return c.json(
        {
          error: message,
          ...(error instanceof ForkSettingsPersistenceError
            ? { sessionId: error.sessionId, projectId }
            : {}),
        },
        error instanceof ForkSettingsPersistenceError
          ? (error.status as 409 | 500)
          : error instanceof RouterUnavailable
            ? 409
            : 500,
      );
    }
  });

  return routes;
}
