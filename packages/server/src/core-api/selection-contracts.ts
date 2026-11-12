import { z } from "zod";

export const selectionQuery = z
  .object({
    provider: z
      .enum(["claude", "codex"])
      .describe("Configured launch harness."),
    routing: z
      .enum(["direct", "aar"])
      .default("aar")
      .describe(
        "Choose the catalog to inspect. AAR is the default; direct explicitly reads the host provider's catalog. Neither launches a session.",
      ),
  })
  .strict();

/** Public launch choices only: never forward arbitrary provider/router fields. */
export const selectionModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  resolvedModel: z.string().optional(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
  supportsEffort: z.boolean().optional(),
  supportsAdaptiveThinking: z.boolean().optional(),
  supportsFastMode: z.boolean().optional(),
  supportsAutoMode: z.boolean().optional(),
  defaultReasoningEffort: z.string().optional(),
  supportedReasoningEfforts: z
    .array(
      z.object({
        reasoningEffort: z.string(),
        description: z.string().optional(),
      }),
    )
    .optional(),
  supportedEffortLevels: z.array(z.string()).optional(),
  defaultEffortLevel: z.string().optional(),
  serviceTiers: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().optional(),
      }),
    )
    .optional(),
});
export const selectionSchema = z.object({
  provider: z.enum(["claude", "codex"]),
  routing: z.enum(["direct", "aar"]),
  available: z
    .boolean()
    .describe("Discovery availability, not a launch/authentication guarantee."),
  observedAt: z.string(),
  models: z.array(selectionModelSchema).optional(),
  catalog: z
    .object({
      source: z.enum(["live", "fallback", "static"]),
      fetchedAt: z.string().optional(),
    })
    .optional(),
  serviceTierSelection: z.boolean().optional(),
  policies: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
  pools: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        provider: z.enum(["claude", "codex"]),
        accountIds: z.array(z.string()),
        policy: z.string(),
        revision: z.number(),
      }),
    )
    .optional(),
  accounts: z
    .array(
      z.object({
        id: z.string(),
        displayName: z.string().optional(),
        provider: z.enum(["claude", "codex"]),
        enabled: z.boolean(),
        directAccountAccess: z.boolean().optional(),
        freshness: z.enum(["fresh", "stale", "unknown"]),
        catalogAt: z.string().nullable(),
        models: z.array(selectionModelSchema),
        cliModels: z.array(selectionModelSchema).optional(),
        blocked: z.enum(["auth-unavailable", "cooldown"]).optional(),
        cooldownUntil: z.string().optional(),
      }),
    )
    .optional(),
});
export type ApiSelection = z.infer<typeof selectionSchema>;
export type SelectionQuery = z.infer<typeof selectionQuery>;

export const effectiveSettingsSchema = z.object({
  source: z.enum(["live", "saved", "unavailable"]),
  requestedModel: z.string().nullable(),
  model: z
    .string()
    .nullable()
    .describe(
      "Best known live model, which may still be an alias. Null without live model evidence; never inferred from a saved requested model.",
    ),
  thinking: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("disabled") }),
      z.object({
        type: z.literal("adaptive"),
        display: z.enum(["summarized", "omitted"]).optional(),
      }),
      z.object({
        type: z.literal("enabled"),
        budgetTokens: z.number().optional(),
        display: z.enum(["summarized", "omitted"]).optional(),
      }),
    ])
    .nullable(),
  effort: z
    .string()
    .nullable()
    .describe(
      "Last applied effort, excluding a queued next-turn change. Null means provider default, or unknown when source=unavailable.",
    ),
  permissionMode: z.string().nullable(),
  serviceTier: z.string().nullable(),
  revision: z
    .number()
    .int()
    .optional()
    .describe(
      "Revision of the durable last-applied launch snapshot, when retained.",
    ),
});
export const routingSchema = z.object({
  mode: z.enum(["direct", "aar", "unknown"]),
  routerId: z.string().optional(),
  poolId: z.string().optional(),
  poolName: z.string().optional(),
  accountId: z.string().optional(),
  accountDisplayName: z.string().optional(),
  policy: z.string().optional(),
  policyLabel: z.string().optional(),
  reason: z.string().optional(),
  observedAt: z.string().optional(),
  claudeAiConnectors: z.boolean().optional(),
});
export const sessionInspectionSchema = z.object({
  settings: effectiveSettingsSchema,
  routing: routingSchema,
});
export type ApiSessionInspection = z.infer<typeof sessionInspectionSchema>;
