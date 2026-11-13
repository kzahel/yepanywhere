import { z } from "zod";
import { requestIdSchema } from "./command-contracts.js";

export const controlRequest = z.object({ requestId: requestIdSchema }).strict();
export const respondRequest = controlRequest.extend({
  response: z.enum(["approve", "deny"]),
});
export const pendingRequestsSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        kind: z.enum(["permission", "question"]),
        description: z.string(),
        toolName: z.string().optional(),
        toolInput: z.unknown().optional(),
        canRespond: z.boolean(),
      }),
    )
    .max(1),
});
export type ControlOperation = "respond" | "cancel" | "stop";
export type PendingRequests = z.infer<typeof pendingRequestsSchema>;
