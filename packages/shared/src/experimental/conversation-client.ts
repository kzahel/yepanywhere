import {
  serverHasCapability,
  SERVER_CAPABILITIES,
  type ServerCapabilitySource,
} from "../server-capabilities.js";
import { CONVERSATION_API_REVISION } from "./conversation-protocol.js";
import {
  ConversationQuerySchema,
  IdSchema,
  decodeSnapshot,
  type ConversationQuery,
  type SnapshotEnvelope,
} from "./simple-client.generated.js";

export type ConversationAvailability =
  | "available"
  | "update-required"
  | "revision-mismatch";
export function conversationAvailability(
  version: ServerCapabilitySource & {
    experimentalSimpleClientApiRevision?: unknown;
  },
): ConversationAvailability {
  if (
    !serverHasCapability(
      version,
      SERVER_CAPABILITIES.experimentalConversation,
    ) ||
    typeof version.experimentalSimpleClientApiRevision !== "string"
  )
    return "update-required";
  return version.experimentalSimpleClientApiRevision ===
    CONVERSATION_API_REVISION
    ? "available"
    : "revision-mismatch";
}

/** A binding belongs to exactly one client-owned source, including ID collisions. */
export class ConversationBinding {
  private sequence = -1;
  private closed = false;
  constructor(
    readonly sourceId: string,
    readonly subscriptionId: string,
    readonly sessionId: string,
  ) {
    IdSchema.parse(subscriptionId);
    IdSchema.parse(sessionId);
    if (!sourceId) throw new Error("Conversation requires a source binding");
  }
  close(): void {
    this.closed = true;
  }
  accept(sourceId: string, encoded: string): SnapshotEnvelope | null {
    if (this.closed || sourceId !== this.sourceId) return null;
    const snapshot = decodeSnapshot(encoded);
    if (
      snapshot.subscriptionId !== this.subscriptionId ||
      snapshot.sequence <= this.sequence
    )
      return null;
    if (
      snapshot.view.kind === "conversation" &&
      snapshot.view.sessionId !== this.sessionId
    )
      throw new Error("Conversation session mismatch");
    this.sequence = snapshot.sequence;
    return snapshot;
  }
}

export function conversationReadPath(
  query: ConversationQuery,
  subscriptionId: string,
): string {
  ConversationQuerySchema.parse(query);
  IdSchema.parse(subscriptionId);
  const params = new URLSearchParams({
    apiRevision: CONVERSATION_API_REVISION,
    subscriptionId,
    sessionId: query.sessionId,
    maxMessages: String(query.maxMessages),
  });
  if (query.anchorMessageId !== null)
    params.set("anchorMessageId", query.anchorMessageId);
  return `/api/experimental/conversation?${params}`;
}

/** Gate before sending any experimental operation; transport/auth remain owned by the caller. */
export async function readConversation(options: {
  sourceId: string;
  subscriptionId: string;
  query: ConversationQuery;
  version: ServerCapabilitySource & {
    experimentalSimpleClientApiRevision?: unknown;
  };
  request: (path: string) => Promise<string>;
}): Promise<
  | { sourceId: string; snapshot: SnapshotEnvelope }
  | {
      sourceId: string;
      unavailable: Exclude<ConversationAvailability, "available">;
    }
> {
  const availability = conversationAvailability(options.version);
  if (availability !== "available")
    return { sourceId: options.sourceId, unavailable: availability };
  const binding = new ConversationBinding(
    options.sourceId,
    options.subscriptionId,
    options.query.sessionId,
  );
  const snapshot = binding.accept(
    options.sourceId,
    await options.request(
      conversationReadPath(options.query, options.subscriptionId),
    ),
  );
  if (snapshot?.sequence !== 0)
    throw new Error("Invalid initial Conversation binding");
  return { sourceId: options.sourceId, snapshot };
}
