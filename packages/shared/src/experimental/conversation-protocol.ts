import {
  ConversationQuerySchema,
  IdSchema,
  type ConversationQuery,
} from "./simple-client.generated.js";

export const CONVERSATION_API_REVISION = "simple-client-spike-1";
export const CONVERSATION_CHANNEL = "/api/experimental/conversation/subscribe";

export function parseConversationBinding(value: {
  apiRevision?: unknown;
  subscriptionId?: unknown;
  query?: unknown;
}):
  | { status: 400 | 409; error: string }
  | { subscriptionId: string; query: ConversationQuery } {
  if (value.apiRevision !== CONVERSATION_API_REVISION)
    return {
      status: 409,
      error: "Experimental conversation revision mismatch",
    };
  const id = IdSchema.safeParse(value.subscriptionId);
  const query = ConversationQuerySchema.safeParse(value.query);
  if (!id.success || !query.success)
    return { status: 400, error: "Invalid conversation binding" };
  return { subscriptionId: id.data, query: query.data };
}
