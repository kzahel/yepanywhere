import { ALL_PROVIDERS } from "@yep-anywhere/shared";
import { z } from "zod";
import { SESSION_RELATIONSHIP_TYPES } from "../sessions/SessionRelationshipStore.js";

const endpointCommon = {
  serverId: z.string(),
  projectId: z.string(),
  provider: z.enum(ALL_PROVIDERS),
};
const endpoint = z.discriminatedUnion("kind", [
  z.object({
    ...endpointCommon,
    kind: z.literal("session"),
    sessionId: z.string(),
  }),
  z.object({
    ...endpointCommon,
    kind: z.literal("provider-child"),
    parentSessionId: z.string(),
    childId: z.string(),
  }),
]);
/** Public allow-list, independent from private graph/evidence serialization. */
export const relationshipGraphPageSchema = z.object({
  relationships: z
    .array(
      z.object({
        type: z
          .string()
          .describe(
            "Unknown predicates remain display-only; they never imply provider-child control.",
          ),
        source: endpoint,
        target: endpoint,
        evidence: z
          .array(
            z.object({
              trust: z.enum([
                "local-authenticated",
                "peer-attested",
                "provider-observed",
                "command-observed",
              ]),
              observedAt: z.string(),
              title: z.string().optional(),
              agentType: z.string().optional(),
              toolUseId: z.string().optional(),
              spawnDepth: z.number().optional(),
              sourceTimestamp: z.string().optional(),
            }),
          )
          .max(20),
      }),
    )
    .max(100),
  nextCursor: z.string().nullable(),
});

export const relatedQuery = z.object({
  includeRelated: z
    .enum(["true", "false"])
    .optional()
    .describe(
      "Opt into the separately paged operator structural projection. Absent on older servers and peer views.",
    ),
  relatedLimit: z.coerce.number().int().min(1).max(100).optional(),
  relatedCursor: z.string().min(40).max(1024).optional(),
  relatedDirection: z
    .enum(["incoming", "outgoing", "both"])
    .optional()
    .describe(
      "Direction of the related graph page (default both), independent of outgoing receipt history.",
    ),
  relatedType: z
    .enum(SESSION_RELATIONSHIP_TYPES)
    .optional()
    .describe(
      "Filter accepted local relationships by this predicate. Other predicates and receipt pagination are unchanged.",
    ),
});
