import { z } from "zod";

export const requestIdSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)
  .describe(
    "Caller-generated unique retry key. Reuse with the identical request after a lost response; a conflicting payload returns 409. Never generate a new key merely to retry an uncertain operation.",
  );
export const createSessionRequest = z
  .object({
    requestId: requestIdSchema,
    projectId: z
      .string()
      .min(1)
      .max(4096)
      .describe(
        "Existing authorized project id from this server's projects collection. The server owns its path.",
      ),
    provider: z
      .enum(["claude", "codex"])
      .describe(
        "Configured native harness. Other providers, remote executors and blank-session creation are not qualified in this slice.",
      ),
    message: z
      .string()
      .min(1)
      .max(100000)
      .refine((value) => value.trim().length > 0)
      .describe(
        "Initial prompt, exact text. Native agents choose checkout/worktree and workflow behavior.",
      ),
    model: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe(
        "Native/YA model selector; omitted or default uses the harness default. No installation or protocol upgrade is performed.",
      ),
    thinking: z
      .enum([
        "off",
        "auto",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "on:low",
        "on:medium",
        "on:high",
        "on:xhigh",
        "on:max",
      ])
      .optional()
      .describe(
        "Existing native thinking/effort selection; on:high is forced thinking with high effort.",
      ),
    permissionMode: z
      .enum(["default", "acceptEdits", "plan", "bypassPermissions", "auto"])
      .default("default")
      .describe("Native permission mode, explicit bypass only when requested."),
    serviceTier: z.string().min(1).max(128).optional(),
  })
  .strict();
export const sendMessageRequest = z
  .object({
    requestId: requestIdSchema,
    message: z
      .string()
      .min(1)
      .max(100000)
      .refine((value) => value.trim().length > 0)
      .describe(
        "Follow-up text for the incumbent native session owner. No automatic resume, mode/model change, interruption or command translation.",
      ),
    delivery: z
      .literal("queue")
      .default("queue")
      .describe(
        "Append to the native input queue. Does not steer/intercept an active turn. Busy inputs may be consumed together; consumption is not successful response completion.",
      ),
  })
  .strict();
export type SendMessageRequest = z.infer<typeof sendMessageRequest>;
export type CreateSessionRequest = z.infer<typeof createSessionRequest>;
export const creatorSchema = z.object({
  serverId: z
    .string()
    .describe(
      "Authenticated originating server. Local calls originate on this profile; peer identity is not accepted from JSON/headers.",
    ),
  sessionId: z
    .string()
    .nullable()
    .describe(
      "Trusted owning launch session; null for ordinary operator HTTP calls.",
    ),
  launchId: z.string().nullable(),
  principal: z.object({ kind: z.enum(["superuser", "peer"]) }),
  authentication: z
    .object({
      credentialId: z.string(),
      sessionAttribution: z.literal("source-attested"),
    })
    .optional()
    .describe(
      "Immediate peer proof and explicitly source-attested session identity.",
    ),
});
export type ApiCreator = z.infer<typeof creatorSchema>;
export const receiptSchema = z.object({
  id: z.string(),
  requestId: requestIdSchema,
  kind: z.enum(["createSession", "sendMessage"]),
  state: z
    .enum(["dispatching", "queued", "accepted", "failed", "uncertain"])
    .describe(
      "Admission evidence, not successful response completion. Uncertain operations are never automatically resubmitted.",
    ),
  projectId: z.string(),
  sessionId: z.string().nullable(),
  requestedSessionId: z
    .string()
    .optional()
    .describe(
      "On message command responses, the exact submitted target path. sessionId is the target's canonical identity and may differ after remapping. This field is response correlation, not a new persisted receipt scope.",
    ),
  queueId: z.string().optional(),
  creator: creatorSchema,
  destinationServerId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  delivery: z
    .enum(["unknown", "consumed", "uncertain"])
    .describe(
      "unknown awaits evidence; uncertain means owner/restart lost delivery proof. consumed means the native provider input iterator consumed the input, not provider acknowledgement or successful completion.",
    ),
  completion: z
    .enum(["unknown"])
    .describe(
      "No completion claim is inferred from idle activity or unrelated replies. Follow the conversation and inspect evidence.",
    ),
  failure: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type ApiReceipt = z.infer<typeof receiptSchema>;
export const outboundSchema = z.object({
  id: z.string(),
  sourceServerId: z.string(),
  sourceSessionId: z.string().nullable(),
  attestedSessionId: z
    .string()
    .nullable()
    .describe(
      "Original source attribution retained on retries across local canonical ID remaps.",
    ),
  sourceLaunchId: z.string().nullable(),
  destinationServerId: z.string(),
  operation: z.enum(["createSession", "sendMessage"]),
  resource: z.string(),
  requestId: requestIdSchema,
  state: z.enum(["uncertain", "confirmed"]),
  createdAt: z.string(),
  receipt: receiptSchema.nullable(),
});
export type ApiOutbound = z.infer<typeof outboundSchema>;
export const relationshipsSchema = z.object({
  sessionId: z.string(),
  creation: receiptSchema
    .nullable()
    .describe(
      "First recorded v0 creation receipt; null does not establish a human origin for older sessions.",
    ),
  initiated: z.array(receiptSchema).max(100),
  nextCursor: z.string().nullable(),
  outbound: z
    .object({
      items: z.array(outboundSchema).max(100),
      nextCursor: z.string().nullable(),
    })
    .optional()
    .describe(
      "Separately paged source ledger. An uncertain record may have been accepted remotely.",
    ),
});
