import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ActivityStateSchema,
  TextContentSchema,
  ActivityContentSchema,
  FailureContentSchema,
  MediaContentSchema,
  SnapshotEnvelopeSchema,
} from "@yep-anywhere/shared/experimental/simple-client.generated";
import type { ConversationSubscriptions } from "../experimental/conversation-subscriptions.js";
import { CoreApiError } from "./errors.js";

export const conversationQuery = z
  .object({
    maxMessages: z
      .string()
      .regex(/^[1-9][0-9]{0,8}$/)
      .optional()
      .describe(
        "Requested visible user/agent messages, default 20. Positive integers up to 999999999 are accepted; the applied maximum is 100 and coverage reports clamping.",
      ),
    tailCompactions: z
      .string()
      .regex(/^[1-9][0-9]{0,8}$/)
      .optional()
      .describe(
        "Recent compaction boundaries to include, default 2. The applied maximum is 20; maxMessages further narrows this scope. Coverage reports clamping.",
      ),
    anchorMessageId: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe(
        "Stable message id to end the window at. Unavailable anchors fail explicitly; no silent jump to latest.",
      ),
  })
  .strict();
export const followQuery = conversationQuery
  .extend({
    after: z
      .string()
      .regex(/^c1\.[a-f0-9]{64}$/)
      .optional()
      .describe(
        "Opaque cursor returned by this same server/session/window. Changed or foreign cursors yield explicit replacement state.",
      ),
    waitMs: z
      .string()
      .regex(/^(?:0|[1-9][0-9]{0,2}|[1-3][0-9]{3}|4000)$/)
      .optional()
      .describe(
        "Hold for a visible change after the initial observation: 0–4000 milliseconds, default 4000. No retry loop is created.",
      ),
  })
  .strict();
export type ConversationFollowQuery = z.infer<typeof followQuery>;
export type ConversationReadQuery = z.infer<typeof conversationQuery>;
export const conversationSchema = z.object({
  sessionId: z.string(),
  revision: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .describe(
      "Opaque content revision, scoped to the selected window. Not an event-log offset.",
    ),
  activity: ActivityStateSchema.describe(
    "Observed idle/working/waiting/unknown, independent of whether the last message is complete.",
  ),
  messages: z
    .array(
      z.object({
        id: z.string(),
        role: z.enum(["user", "agent"]),
        createdAt: z.string().nullable(),
        state: z.enum(["complete", "growing", "interrupted"]),
        truncated: z.boolean(),
        content: z
          .array(
            z.union([
              TextContentSchema,
              ActivityContentSchema,
              FailureContentSchema,
              MediaContentSchema,
            ]),
          )
          .max(64),
      }),
    )
    .max(100),
  pendingRequests: z
    .array(
      z.object({
        id: z.string().nullable(),
        kind: z.string(),
        prompt: z.string().optional(),
        options: z.array(z.string()).optional(),
        canAnswer: z.literal(false),
      }),
    )
    .max(16)
    .describe(
      "Read-only pending attention. No approval/answer endpoint is implied.",
    ),
  coverage: z
    .object({
      scope: z.literal("recentCompactions"),
      compactions: z.number().int().min(1).max(20),
      maxMessages: z.number().int().min(1).max(100),
      returnedMessages: z.number().int().min(0).max(100),
      earlierInScope: z.boolean(),
      earlierOutsideScope: z.enum(["yes", "no", "unknown"]),
      completeForRequest: z.boolean(),
      anchorMessageId: z.string().nullable(),
      requestedMessages: z.number().int().min(1).max(999999999),
      requestedCompactions: z.number().int().min(1).max(999999999),
      limitedBy: z
        .array(
          z.enum([
            "maxMessages",
            "compactionScope",
            "bytes",
            "records",
            "unavailable",
            "serverLimit",
          ]),
        )
        .max(6),
    })
    .describe(
      "Incomplete/byte/compaction/anchor evidence; an empty or idle view does not establish successful completion.",
    ),
});
export type ApiConversation = z.infer<typeof conversationSchema>;

export const followSchema = z.object({
  cursor: z.string().regex(/^c1\.[a-f0-9]{64}$/),
  changed: z.boolean(),
  reset: z
    .boolean()
    .describe(
      "True means replace the selected compact window in full. This API does not promise event-log replay or delivery of every intermediate state.",
    ),
  conversation: conversationSchema
    .nullable()
    .describe(
      "Null on an unchanged bounded wait; retain your previous view and cursor. A changed result contains full replacement state, not raw transcript deltas.",
    ),
});
export type ApiConversationFollow = z.infer<typeof followSchema>;

/** Tool-count-only changes do not wake following; failures/prose/activity do. */
function cursorFor(
  serverId: string,
  query: ConversationReadQuery,
  view: ApiConversation,
) {
  const { revision: _revision, ...body } = view;
  const visible = {
    ...body,
    messages: body.messages.map((message) => ({
      ...message,
      content: message.content.filter((content) => content.kind !== "activity"),
    })),
  };
  return (
    "c1." +
    createHash("sha256")
      .update(
        JSON.stringify([
          serverId,
          query.maxMessages ?? "20",
          query.anchorMessageId ?? null,
          query.tailCompactions ?? "2",
          visible,
        ]),
      )
      .digest("hex")
  );
}

export function createConversationRead(
  subscriptions: ConversationSubscriptions,
) {
  return async (
    sessionId: string,
    query: ConversationReadQuery,
    signal?: AbortSignal,
  ): Promise<ApiConversation> => {
    const result = await observeConversation(
      subscriptions,
      sessionId,
      query,
      signal,
    );
    if (!result) throw new Error("Missing initial conversation");
    return result;
  };
}
export function createConversationFollow(
  subscriptions: ConversationSubscriptions,
  serverId: string,
) {
  return async (
    sessionId: string,
    query: ConversationFollowQuery,
    signal?: AbortSignal,
  ): Promise<ApiConversationFollow> => {
    const result = await observeConversation(
      subscriptions,
      sessionId,
      query,
      signal,
      {
        unchanged: (view) => cursorFor(serverId, query, view) === query.after,
        waitMs: Number(query.waitMs ?? 4000),
      },
    );
    return result
      ? {
          cursor: cursorFor(serverId, query, result),
          changed: true,
          reset: true,
          conversation: result,
        }
      : {
          cursor: query.after!,
          changed: false,
          reset: false,
          conversation: null,
        };
  };
}

/** One bounded wait shares the observation owner; no polling or HTTP ownership. */
function observeConversation(
  subscriptions: ConversationSubscriptions,
  sessionId: string,
  query: ConversationReadQuery,
  signal?: AbortSignal,
  follow?: { unchanged: (view: ApiConversation) => boolean; waitMs: number },
): Promise<ApiConversation | null> {
  return new Promise((resolve, reject) => {
    const requestedMessages = Number(query.maxMessages ?? 20);
    const requestedCompactions = Number(query.tailCompactions ?? 2);
    const maxMessages = Math.min(requestedMessages, 100);
    const compactions = Math.min(requestedCompactions, 20);
    const clamped =
      maxMessages !== requestedMessages || compactions !== requestedCompactions;
    let release: (() => void) | undefined;
    let finished = false;
    const finish = (value?: ApiConversation | null, error?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      queueMicrotask(() => release?.());
      if (error) reject(error);
      else resolve(value!);
    };
    const unavailable = () =>
      finish(
        undefined,
        new CoreApiError(
          "conversation_unavailable",
          "Conversation history is unavailable or could not be acquired before its deadline",
          503,
        ),
      );
    const abort = () =>
      finish(
        undefined,
        signal?.reason ?? new Error("Conversation read aborted"),
      );
    // Below the controller bridge deadline; stalled sources release all demand.
    let deadline = setTimeout(unavailable, 4000);
    let waiting = false;
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    try {
      release = subscriptions.subscribe(
        {
          sessionId,
          maxMessages,
          anchorMessageId: query.anchorMessageId ?? null,
        },
        randomUUID(),
        {
          close: unavailable,
          send(encoded) {
            try {
              const { view } = SnapshotEnvelopeSchema.parse(
                JSON.parse(encoded),
              );
              if (view.kind !== "conversation") {
                if (view.kind === "error" && view.code === "anchorUnavailable")
                  finish(
                    undefined,
                    new CoreApiError(
                      "anchor_unavailable",
                      "Anchor is outside available history; choose another window explicitly",
                      404,
                    ),
                  );
                else unavailable();
                return;
              }
              const opaque = view.messages.some((message) =>
                message.content.some((content) => content.kind === "unknown"),
              );
              const body = {
                sessionId: view.sessionId,
                activity: view.activity,
                messages: view.messages.map((message) => ({
                  ...message,
                  content: message.content.map((content) =>
                    content.kind === "unknown"
                      ? {
                          kind: "text" as const,
                          format: "plain" as const,
                          text: `Unavailable content (${content.originalKind.slice(0, 128)})`,
                        }
                      : content,
                  ),
                })),
                pendingRequests: view.pendingRequests.map((request) =>
                  request.kind === "question"
                    ? request
                    : {
                        kind: request.originalKind,
                        id: null,
                        canAnswer: false as const,
                      },
                ),
                coverage: {
                  ...view.coverage,
                  requestedMessages,
                  requestedCompactions,
                  completeForRequest:
                    view.coverage.completeForRequest &&
                    !opaque &&
                    !(
                      requestedMessages > maxMessages &&
                      view.coverage.earlierInScope
                    ) &&
                    !(
                      requestedCompactions > compactions &&
                      view.coverage.earlierOutsideScope !== "no"
                    ),
                  limitedBy: [
                    ...new Set([
                      ...view.coverage.limitedBy,
                      ...(opaque ? ["unavailable" as const] : []),
                      ...(clamped ? ["serverLimit" as const] : []),
                    ]),
                  ],
                },
              };
              const revision = createHash("sha256")
                .update(JSON.stringify(body))
                .digest("hex");
              const selected = conversationSchema.parse({ ...body, revision });
              if (follow?.unchanged(selected)) {
                if (!waiting) {
                  waiting = true;
                  clearTimeout(deadline);
                  deadline = setTimeout(() => finish(null), follow.waitMs);
                }
              } else finish(selected);
            } catch {
              unavailable();
            }
          },
        },
        compactions,
      );
      if (finished) release();
    } catch {
      unavailable();
    }
  });
}
