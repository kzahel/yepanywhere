import { relationshipGraphPageSchema } from "./relationship-graph-contracts.js";
import { z } from "zod";
import { selectableProvider } from "./selection-contracts.js";

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
    provider: selectableProvider.describe(
      "Configured native harness. Other providers, remote executors and blank-session creation are not qualified in this slice.",
    ),
    prompt: z
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
        "Omit to use the direct provider default or the inherited router binding's model. With routerPoolId or routerAccountId, supply a model id from that selection's catalog.",
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
    routing: z
      .literal("direct")
      .optional()
      .describe(
        "Use the requested provider's direct login on the target server and skip caller routing inheritance. Cannot be combined with routerPoolId, routerAccountId, routerPolicy or routerClaudeAiConnectors.",
      ),
    routerPoolId: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe(
        "Pool id from selection; select afresh at launch. No automatic direct fallback.",
      ),
    routerAccountId: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe("Explicit account, or manual account within routerPoolId."),
    routerPolicy: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe(
        "Router policy id from selection. Requires routerPoolId; manual requires routerAccountId.",
      ),
    routerClaudeAiConnectors: z.boolean().optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.routing !== "direct" ||
      (body.routerPoolId === undefined &&
        body.routerAccountId === undefined &&
        body.routerPolicy === undefined &&
        body.routerClaudeAiConnectors === undefined),
    "Direct routing cannot be combined with router fields",
  )
  .refine(
    (body) => !body.routerPolicy || !!body.routerPoolId,
    "routerPolicy requires routerPoolId",
  )
  .refine(
    (body) =>
      body.provider !== "antigravity" ||
      (body.serviceTier === undefined && body.permissionMode !== "plan"),
    "Antigravity uses native model IDs without service tiers, with /plan as a session command",
  )
  .refine(
    (body) => body.routerPolicy !== "manual" || !!body.routerAccountId,
    "manual policy requires routerAccountId",
  )
  .refine(
    (body) =>
      body.routerClaudeAiConnectors === undefined ||
      (body.provider === "claude" &&
        !!(body.routerPoolId || body.routerAccountId)),
    "Claude connectors require an explicit Claude router selection",
  );
const promptInput = z
  .object({
    type: z.literal("prompt"),
    text: z
      .string()
      .min(1)
      .max(100000)
      .refine((value) => value.trim().length > 0)
      .describe(
        "Exact input text for the incumbent session, delivered unchanged without YA command emulation. Claude Code runs a leading native slash command itself; Codex receives it as text. Queue compaction with type=compact so its receipt reports the outcome and later input waits for it.",
      ),
    delivery: z
      .enum(["deferred", "patient", "steer"])
      .default("deferred")
      .describe(
        "deferred: YA's regular queue, delivered at the next turn boundary. patient: waits for verified idle plus a short quiet interval, and survives restart paused. steer: joins the active turn where the provider supports steering, otherwise queues after it. An idle session receives deferred and steer input at once.",
      ),
  })
  .strict();
const compactInput = z
  .object({
    type: z.literal("compact"),
    instructions: z
      .string()
      .min(1)
      .max(10000)
      .refine((value) => value.trim().length > 0)
      .optional()
      .describe(
        "Optional focus instructions. Claude and Antigravity receive them after /compact; Codex's native compaction ignores them.",
      ),
    delivery: z
      .enum(["deferred", "patient"])
      .default("deferred")
      .describe(
        "When compaction starts, as for a prompt: deferred at the next turn boundary even while background tasks run, patient after verified idle. Later input waits until compaction succeeds; a failure holds it visibly until the compaction is cancelled.",
      ),
  })
  .strict();
/** Request body without the header-supplied retry key. */
export const inputBody = z.discriminatedUnion("type", [
  promptInput,
  compactInput,
]);
export const inputRequest = z.discriminatedUnion("type", [
  promptInput.extend({ requestId: requestIdSchema }),
  compactInput.extend({ requestId: requestIdSchema }),
]);
export type InputRequest = z.infer<typeof inputRequest>;
export const inputProgressSchema = z.object({
  type: z.enum(["prompt", "compact"]),
  delivery: z
    .enum(["deferred", "patient", "steer"])
    .describe("Requested delivery."),
  status: z
    .enum(["queued", "released", "cancelled", "paused"])
    .describe(
      "queued: held in YA's queue. released: handed to the provider. cancelled: removed before delivery. paused: preserved across a server restart; inspect inputs.",
    ),
  compaction: z
    .enum(["pending", "compacting", "compacted", "failed", "unconfirmed"])
    .optional()
    .describe("Compact inputs only."),
});
export type InputProgress = z.infer<typeof inputProgressSchema>;
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
      generation: z.number().int().positive().optional(),
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
  kind: z
    .enum([
      "createSession",
      "input",
      "cancelInput",
      "respond",
      "cancel",
      "stop",
      "prompt",
    ])
    .describe(
      "prompt appears only on receipts recorded before the inputs API replaced it.",
    ),
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
    .enum(["unknown", "consumed", "uncertain", "cancelled"])
    .describe(
      "unknown awaits evidence; uncertain means the owner lost delivery proof. consumed means the native provider consumed the input (for compaction, that it compacted), not provider acknowledgement or successful completion. cancelled means removed from YA's queue before delivery.",
    ),
  completion: z
    .enum(["unknown", "compacted", "failed", "unconfirmed"])
    .describe(
      "Prompts stay unknown: no completion claim is inferred from idle activity or unrelated replies, so follow the conversation. Compact inputs report the observed compaction outcome; unconfirmed means no outcome after 180 seconds.",
    ),
  input: inputProgressSchema
    .optional()
    .describe("Queue progress for input receipts."),
  result: z.record(z.string(), z.unknown()).optional(),
  failure: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type ApiReceipt = z.infer<typeof receiptSchema>;
export const receiptBindingSchema = receiptSchema
  .pick({
    id: true,
    requestId: true,
    kind: true,
    projectId: true,
    sessionId: true,
    creator: true,
    destinationServerId: true,
  })
  .extend({ kind: z.string().min(1).max(128) });
export type ReceiptBinding = z.infer<typeof receiptBindingSchema>;
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
  destinationSessionId: z
    .string()
    .nullable()
    .default(null)
    .describe(
      "Last positively observed canonical session on the destination. Receipt observation fills pending creation bindings without another mutation.",
    ),
  operation: z.string().min(1).max(128),
  resource: z.string(),
  requestId: requestIdSchema,
  state: z.enum(["uncertain", "confirmed"]),
  createdAt: z.string(),
  receipt: receiptBindingSchema.nullable(),
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
  related: relationshipGraphPageSchema
    .optional()
    .describe(
      "Separately paged local structural relationships. Operator only; absence means unsupported, never known empty. relatedCursor/relatedLimit do not affect receipt pagination.",
    ),
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
