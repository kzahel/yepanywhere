import { z } from "zod";

export const pendingInputSchema = z.object({
  id: z
    .string()
    .describe(
      "Input id for cancelInput. For v0-created input this is also its receipt id.",
    ),
  receiptId: z
    .string()
    .nullable()
    .describe("v0 receipt for this input; null for composer or YA-owned work."),
  type: z
    .enum(["prompt", "compact", "command"])
    .describe("command is YA-owned queued work such as /done or /clearloop."),
  delivery: z
    .enum(["deferred", "patient", "steer", "direct"])
    .nullable()
    .describe("Recorded delivery intent; null when not recorded."),
  status: z
    .enum([
      "queued",
      "paused-after-restart",
      "compacting",
      "failed",
      "unconfirmed",
    ])
    .describe(
      "compacting/failed/unconfirmed are compaction states. A failed compaction holds later input until it is cancelled. paused-after-restart items wait for an explicit resume in the UI.",
    ),
  failure: z
    .string()
    .optional()
    .describe("Compaction failure reason, when reported."),
  cancellable: z
    .boolean()
    .describe(
      "False once a compaction has been dispatched, or for YA-owned commands.",
    ),
  text: z
    .string()
    .nullable()
    .describe(
      "Pending text; null when the caller lacks conversation read access.",
    ),
  createdAt: z.string(),
  creator: z
    .object({
      origin: z
        .enum(["user", "coordination", "rendezvous", "automation", "ya"])
        .describe("coordination is agent-sent input, including v0."),
      sourceSessionId: z.string().optional(),
      sentByUser: z.string().optional(),
    })
    .describe("Recorded provenance, not authentication proof."),
});
export type ApiPendingInput = z.infer<typeof pendingInputSchema>;
export const pendingInputsSchema = z.object({
  items: z.array(pendingInputSchema).max(500),
  nextCursor: z.null(),
});
