import {
  ActivityStateSchema,
  ConversationQuerySchema,
  IdSchema,
  KnowledgeSchema,
  MAX_SNAPSHOT_BYTES,
  PendingRequestSchema,
  SnapshotEnvelopeSchema,
  type ActivityState,
  type ApiError,
  type Conversation,
  type ConversationMessage,
  type ConversationQuery,
  type HistoryLimit,
  type Knowledge,
  type PendingRequest,
  type SnapshotEnvelope,
} from "@yep-anywhere/shared/experimental/simple-client.generated";
import { compileTranscriptProjection } from "@yep-anywhere/shared/transcript/compiler";
import { isUserPromptMessage } from "@yep-anywhere/shared/transcript/messageProjection";
import {
  getMessageId,
  type Message,
} from "@yep-anywhere/shared/transcript/message";
import { sliceAtCompactBoundaries } from "../sessions/pagination.js";
import type { Message as ServerMessage } from "../supervisor/types.js";
import {
  groupConversation,
  type GroupedConversation,
} from "./conversation-groups.js";

// Pure producer limits; acquisition and shared subscription ownership are the
// next service layer. These do not authorize loading a full provider history.
export const MAX_PROJECTION_RECORDS = 10000;
export const MAX_PROJECTION_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_BYTES = 32 * 1024;

export interface ConversationInput {
  sessionId: string;
  /** Ordered, normalized, reconciled active-branch messages, not provider events. */
  messages: Message[];
  activity: ActivityState;
  pendingRequests: PendingRequest[];
  sourceCoverage: {
    earlierOutsideScope: Knowledge;
    complete: boolean;
    leadingUserMessageId?: string | null;
  };
}

export interface PreparedConversation extends GroupedConversation {
  kind: "prepared";
  sessionId: string;
  activity: ActivityState;
  pendingRequests: PendingRequest[];
  earlierOutsideScope: Knowledge;
  sourceComplete: boolean;
}

export type ConversationSnapshot = Omit<SnapshotEnvelope, "view"> & {
  view: Conversation | ApiError;
};
export interface SnapshotBinding {
  subscriptionId: string;
  sequence: number;
}

function error(code: ApiError["code"], message: string): ApiError {
  return { kind: "error", code, message };
}

/** Serialize only the declared open unions; never recursively interpret raw data. */
export function serializeConversationSnapshot(
  snapshot: ConversationSnapshot,
): string {
  const opaque = <T extends { kind: string }>(entry: T): unknown =>
    entry.kind === "unknown" && "raw" in entry ? entry.raw : entry;
  const view =
    snapshot.view.kind === "conversation"
      ? {
          ...snapshot.view,
          messages: snapshot.view.messages.map((message) => ({
            ...message,
            content: message.content.map(opaque),
          })),
          pendingRequests: snapshot.view.pendingRequests.map(opaque),
        }
      : snapshot.view;
  return JSON.stringify({ ...snapshot, view });
}

/** Prepare once per scoped input revision; many windows may reuse this result. */
export function prepareConversation(
  input: ConversationInput,
): PreparedConversation | ApiError {
  if (
    !IdSchema.safeParse(input.sessionId).success ||
    !ActivityStateSchema.safeParse(input.activity).success ||
    !KnowledgeSchema.safeParse(input.sourceCoverage.earlierOutsideScope)
      .success ||
    typeof input.sourceCoverage.complete !== "boolean"
  )
    return error("invalidRequest", "Invalid conversation input metadata");
  if (input.messages.length > MAX_PROJECTION_RECORDS)
    return error("unavailable", "Normalized input exceeds the record budget");
  // Reuse the authoritative existing scope selector before compiling or grouping.
  // Both structural message types represent this same normalized server boundary.
  const slice = sliceAtCompactBoundaries(input.messages as ServerMessage[], 2);
  const messages = slice.messages as Message[];
  try {
    if (
      Buffer.byteLength(JSON.stringify(messages), "utf8") >
      MAX_PROJECTION_INPUT_BYTES
    )
      return error(
        "unavailable",
        "Scoped normalized input exceeds the byte budget",
      );
    const seen = new Set<string>();
    for (const message of messages) {
      const id = getMessageId(message);
      // Internal metadata without identity is allowed only when it cannot create
      // a visible row. Never accept the compiler's legacy clock/index fallback.
      if (!id && ["assistant", "user", "error"].includes(message.type ?? ""))
        return error(
          "unavailable",
          "Visible source record lacks stable identity",
        );
      if (id && (!IdSchema.safeParse(id).success || seen.has(id)))
        return error("unavailable", "Ambiguous normalized source identity");
      if (id) seen.add(id);
    }
    if (input.pendingRequests.length > 16)
      return error("unavailable", "Pending request count exceeds the budget");
    const pendingRequests = input.pendingRequests.map((request) => {
      // These are decoded contract models; unwrap an opaque fallback for validation.
      return PendingRequestSchema.parse(
        request.kind === "unknown" ? request.raw : request,
      );
    });
    if (
      Buffer.byteLength(JSON.stringify(pendingRequests), "utf8") >
      MAX_PENDING_BYTES
    )
      return error("unavailable", "Pending requests exceed the byte budget");
    // This identity-only prefix fact comes from the already supplied array. No
    // older text is compiled or returned, and no older read is triggered.
    let leadingUserId = input.sourceCoverage.leadingUserMessageId ?? null;
    if (leadingUserId !== null && !IdSchema.safeParse(leadingUserId).success)
      return error("unavailable", "Invalid leading response identity");
    const start = input.messages.length - messages.length;
    for (let index = start - 1; index >= 0; index--) {
      const source = input.messages[index];
      if (source && !source.isSubagent && isUserPromptMessage(source)) {
        leadingUserId = getMessageId(source) || null;
        break;
      }
    }
    const unmatchedResults = new Set<string>();
    const items = compileTranscriptProjection(
      messages,
      {
        activeToolApproval:
          input.activity === "working" || input.activity === "waiting",
      },
      {
        onUnmatchedToolResult: ({ message }) => {
          unmatchedResults.add(getMessageId(message));
        },
      },
    );
    const grouped = groupConversation(
      items,
      messages,
      input.activity,
      leadingUserId,
      start > 0 || input.sourceCoverage.earlierOutsideScope !== "no",
      unmatchedResults,
    );
    const ids = new Set<string>();
    for (const message of grouped.messages) {
      if (!IdSchema.safeParse(message.id).success || ids.has(message.id))
        return error("unavailable", "Ambiguous grouped message identity");
      ids.add(message.id);
    }
    return {
      kind: "prepared",
      sessionId: input.sessionId,
      activity: input.activity,
      pendingRequests,
      ...grouped,
      earlierOutsideScope:
        start > 0 ? "yes" : input.sourceCoverage.earlierOutsideScope,
      sourceComplete: input.sourceCoverage.complete,
    };
  } catch {
    // Malformed normalized input cannot leak a raw provider exception or partial
    // apparently complete view into a simple client.
    return error("unavailable", "Cannot project this normalized conversation");
  }
}

function omission(message: ConversationMessage): ConversationMessage {
  const failed = message.content.some((content) => content.kind === "failure");
  return {
    ...message,
    truncated: true,
    content: [
      failed
        ? {
            kind: "failure",
            toolName: "Transcript",
            message:
              "Message content, including failures, omitted by the payload limit",
            exitCode: null,
          }
        : {
            kind: "text",
            format: "plain",
            text: "Message content omitted by the payload limit",
          },
    ],
  };
}

/** Select/count after semantic grouping. Never mutate a prepared shared view. */
export function selectConversation(
  prepared: PreparedConversation | ApiError,
  query: ConversationQuery,
  binding: SnapshotBinding,
): ConversationSnapshot {
  const envelope = (view: Conversation | ApiError): ConversationSnapshot => ({
    apiRevision: "simple-client-spike-1",
    ...binding,
    view,
  });
  // Validate binding once, without involving any source or history work.
  SnapshotEnvelopeSchema.parse(envelope(error("unavailable", "binding check")));
  if (prepared.kind === "error") return envelope(prepared);
  const request = ConversationQuerySchema.safeParse(query);
  if (!request.success)
    return envelope(error("invalidRequest", "Invalid message count or anchor"));
  if (query.sessionId !== prepared.sessionId)
    return envelope(
      error("notFound", "Session does not match this projection"),
    );
  const end =
    query.anchorMessageId === null
      ? prepared.messages.length
      : prepared.messages.findIndex(
          (message) => message.id === query.anchorMessageId,
        ) + 1;
  if (query.anchorMessageId !== null && end === 0)
    return envelope(
      error(
        "anchorUnavailable",
        "The requested message is outside the available scope",
      ),
    );
  const start = Math.max(0, end - query.maxMessages);
  const messages = prepared.messages.slice(start, end);
  const limitedBy = new Set<HistoryLimit>();
  if (start > 0) limitedBy.add("maxMessages");
  if (prepared.earlierOutsideScope !== "no") limitedBy.add("compactionScope");
  if (
    !prepared.sourceComplete ||
    messages.some((message) => prepared.unavailableMessageIds.has(message.id))
  )
    limitedBy.add("unavailable");
  if (
    messages.some((message) => prepared.byteLimitedMessageIds.has(message.id))
  )
    limitedBy.add("bytes");
  const view: Conversation = {
    kind: "conversation",
    sessionId: prepared.sessionId,
    activity: prepared.activity,
    messages,
    pendingRequests: prepared.pendingRequests,
    coverage: {
      scope: "recentCompactions",
      compactions: 2,
      maxMessages: query.maxMessages,
      returnedMessages: messages.length,
      earlierInScope: start > 0,
      earlierOutsideScope: prepared.earlierOutsideScope,
      completeForRequest:
        prepared.sourceComplete &&
        !messages.some((message) => message.truncated),
      limitedBy: [],
      anchorMessageId: query.anchorMessageId,
    },
  };
  const finish = () => {
    view.coverage.limitedBy = [...limitedBy];
    view.coverage.returnedMessages = view.messages.length;
    return envelope(view);
  };
  const bytes = () =>
    Buffer.byteLength(serializeConversationSnapshot(finish()), "utf8");
  // Per-message content has already been bounded. Drop older rows in one pass
  // using encoded row sizes, then recheck the final envelope's exact UTF-8 size.
  let size = bytes();
  let omitted = 0;
  while (size > MAX_SNAPSHOT_BYTES && view.messages.length - omitted > 1) {
    const message = view.messages[omitted];
    if (!message) break;
    size -=
      Buffer.byteLength(
        serializeConversationSnapshot(
          envelope({ ...view, messages: [message] }),
        ),
        "utf8",
      ) -
      Buffer.byteLength(
        serializeConversationSnapshot(envelope({ ...view, messages: [] })),
        "utf8",
      );
    omitted++;
  }
  if (omitted) {
    view.messages = view.messages.slice(omitted);
    view.coverage.earlierInScope = true;
    view.coverage.completeForRequest = false;
    limitedBy.add("bytes");
  }
  if (bytes() > MAX_SNAPSHOT_BYTES) {
    view.messages = view.messages.map(omission);
    view.coverage.completeForRequest = false;
    limitedBy.add("bytes");
  }
  const snapshot = finish();
  const encoded = serializeConversationSnapshot(snapshot);
  if (Buffer.byteLength(encoded, "utf8") > MAX_SNAPSHOT_BYTES)
    return envelope(
      error("unavailable", "Conversation metadata exceeds the payload budget"),
    );
  // Structural conformance is checked on the actual wire representation. Opaque
  // fallbacks are encoded as their original kind, not as decoder implementation data.
  SnapshotEnvelopeSchema.parse(JSON.parse(encoded));
  return snapshot;
}
