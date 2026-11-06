import {
  isYaSessionId,
  type SessionRelationshipEndpoint,
  type SessionRelationshipPage,
  type SessionRelationshipProof,
} from "@yep-anywhere/shared";
import { z } from "zod";
import { CoreApiError } from "../core-api/errors.js";
import { relationshipGraphPageSchema } from "../core-api/relationship-graph-contracts.js";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type {
  AuthorizedRelationshipQuerySource,
  RelationshipReadScope,
} from "./authorized-relationship-source.js";
import type { SessionIdentityStore } from "./SessionIdentityStore.js";
import {
  SESSION_RELATIONSHIP_TYPES,
  relationshipResourceKey,
  type RelationshipResource,
  type StoredRelationship,
} from "./SessionRelationshipStore.js";
import {
  RelationshipPageError,
  SessionRelationshipPages,
} from "./session-relationship-pages.js";

export const relationshipPageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(40).max(1024).optional(),
  direction: z.enum(["incoming", "outgoing", "both"]).optional(),
  type: z.enum(SESSION_RELATIONSHIP_TYPES).optional(),
});

/**
 * Operator projection shared by ordinary HTTP and v0. No acquisition, receipt
 * joins, provider reads or identity adoption. Restricted views keep their
 * incumbent readers until their SQL scope is qualified with this projection.
 */
export function createSessionRelationshipRead(deps: {
  serverId: string;
  source: (scope: RelationshipReadScope) => AuthorizedRelationshipQuerySource;
  identities: Pick<SessionIdentityStore, "resolveYa" | "lookupNative">;
  metadata: Pick<SessionMetadataService, "getMetadata">;
  isDeleted: (sessionId: string) => boolean;
  signal?: AbortSignal;
}) {
  const pages = new SessionRelationshipPages();
  const scope: RelationshipReadScope = {
    serverId: deps.serverId,
    projects: "all",
    creators: true,
  };
  const identityFor = (resource: RelationshipResource) =>
    resource.serverId !== deps.serverId
      ? undefined
      : resource.kind === "native"
        ? deps.identities.lookupNative(resource.native)
        : isYaSessionId(resource.sessionId)
          ? deps.identities.resolveYa(resource.sessionId)
          : undefined;
  const session = (
    resource: RelationshipResource,
  ): Extract<SessionRelationshipEndpoint, { kind: "session" }> | undefined => {
    const identity = identityFor(resource);
    if (!identity || deps.isDeleted(identity.sessionId)) return;
    return {
      kind: "session",
      serverId: deps.serverId,
      sessionId: identity.sessionId,
      projectId:
        deps.metadata.getMetadata(identity.sessionId)?.workingProjectId ??
        identity.projectId,
      provider: identity.provider,
    };
  };
  const endpoint = (
    resource: RelationshipResource,
    edge: StoredRelationship,
    position: "source" | "target",
  ): SessionRelationshipEndpoint | undefined => {
    const bound = session(resource);
    if (bound) return bound;
    // A deleted/bound identity never falls back to a read-only native handle.
    if (
      resource.serverId !== deps.serverId ||
      identityFor(resource) ||
      resource.kind !== "native" ||
      edge.type !== "provider_child" ||
      position !== "target" ||
      edge.source.kind !== "native"
    )
      return;
    const parent = session(edge.source);
    if (!parent) return;
    return {
      kind: "provider-child",
      serverId: deps.serverId,
      parentSessionId: parent.sessionId,
      childId: resource.native.id,
      projectId: parent.projectId,
      provider: parent.provider,
    };
  };
  return async (input: {
    sessionId: string;
    projectId?: string;
    query?: unknown;
    signal?: AbortSignal;
  }): Promise<SessionRelationshipPage> => {
    const signal = AbortSignal.any([
      ...(deps.signal ? [deps.signal] : []),
      ...(input.signal ? [input.signal] : []),
    ]);
    signal.throwIfAborted();
    const anchor: RelationshipResource = {
      kind: "session",
      serverId: deps.serverId,
      sessionId: input.sessionId,
    };
    const visible = session(anchor);
    const unavailable = () =>
      new CoreApiError("session_not_found", "Session not found", 404);
    if (!visible || (input.projectId && visible.projectId !== input.projectId))
      throw unavailable();
    const query = relationshipPageQuery.safeParse(input.query ?? {});
    if (!query.success)
      throw new CoreApiError(
        "invalid_request",
        "Invalid relationship query",
        400,
      );
    const resources: RelationshipResource[] = [anchor];
    const native = identityFor(anchor)!.native;
    if (native)
      resources.push({ kind: "native", serverId: deps.serverId, native });
    const keys = new Set(resources.map(relationshipResourceKey));
    try {
      return relationshipGraphPageSchema.parse(
        await pages.read<SessionRelationshipEndpoint, SessionRelationshipProof>(
          {
            ...query.data,
            source: () => deps.source(scope),
            resources,
            // Constructed here, never caller-controlled or shared with peer callers.
            binding: JSON.stringify({
              principal: "superuser",
              ...scope,
            }),
            signal,
            access: {
              anchor: (resource) => {
                if (!keys.has(relationshipResourceKey(resource))) return false;
                const current = session(resource);
                return !!current && current.projectId === visible.projectId;
              },
              endpoint,
              evidence: (entry) => {
                const m = entry.metadata;
                return {
                  trust: entry.trust,
                  observedAt: entry.observedAt,
                  ...(m.title ? { title: m.title } : {}),
                  ...(m.agentType ? { agentType: m.agentType } : {}),
                  ...(m.toolUseId ? { toolUseId: m.toolUseId } : {}),
                  ...(m.spawnDepth !== undefined
                    ? { spawnDepth: m.spawnDepth }
                    : {}),
                  ...(m.sourceTimestamp
                    ? { sourceTimestamp: m.sourceTimestamp }
                    : {}),
                };
              },
            },
          },
        ),
      );
    } catch (error) {
      if (!(error instanceof RelationshipPageError)) throw error;
      if (error.code === "forbidden") throw unavailable();
      throw new CoreApiError(
        error.code === "invalid_cursor"
          ? "invalid_request"
          : "relationships_unavailable",
        error.code === "invalid_cursor"
          ? "Relationship cursor is invalid or expired; start a new page"
          : "Relationships are unavailable; retry from a fresh page",
        error.code === "invalid_cursor" ? 400 : 503,
      );
    }
  };
}
export type SessionRelationshipRead = ReturnType<
  typeof createSessionRelationshipRead
>;
