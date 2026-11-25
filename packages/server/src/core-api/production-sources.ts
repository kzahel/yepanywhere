import { inspectApiSession } from "./session-inspection.js";
import { describeBackingStore } from "./backing-store.js";
import { selectionSchema } from "./selection-contracts.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { AgentAuthRouter } from "../services/AgentAuthRouter.js";
import { CoreApiError } from "./errors.js";
import type { ProjectScanner } from "../projects/scanner.js";
import { isDetachedProjectPath } from "../projects/paths.js";
import type { RetainedSessionCollections } from "../services/RetainedSessionCollections.js";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import { projectCatalogIdentityResult } from "../sessions/catalog-identity.js";
import type { SessionCatalogRow } from "../sessions/catalog-types.js";
import type { AgentProvider } from "../sdk/providers/types.js";
import type { ApiSession } from "./contracts.js";
import type { CoreApiSources } from "./service.js";
import { apiSessionState } from "./owned-sessions.js";
import { isClaudeProviderName, isYaSessionId } from "@yep-anywhere/shared";

export function productionApiSources(deps: {
  scanner: Pick<ProjectScanner, "readRetainedProjects">;
  sessions: Pick<RetainedSessionCollections, "read"> &
    Partial<Pick<RetainedSessionCollections, "readNativeRows">>;
  /**
   * With its identity store, native catalog rows are projected to public ids.
   * Without one a row keeps its native id, which is the public id only for a
   * session YA did not create.
   */
  metadata?: Pick<SessionMetadataService, "getMetadata"> &
    Partial<Pick<SessionMetadataService, "identities" | "getMetadataBatch">>;
  providers: () => readonly (Pick<
    AgentProvider,
    "name" | "displayName" | "supportsSteering" | "supportsPermissionMode"
  > &
    Partial<
      Pick<AgentProvider, "getAvailableModels" | "getModelCatalogStatus">
    >)[];
  supervisor?: Pick<Supervisor, "getProcessForSession">;
  agentAuthRouter?: Pick<AgentAuthRouter, "selection">;
  sessionState?: (sessionId: string) => string;
  ownedSessions?: () => readonly import("./contracts.js").ApiSession[];
  hiddenProjects: NonNullable<CoreApiSources["hiddenProjects"]>;
}): CoreApiSources {
  const summary = (row: Readonly<SessionCatalogRow>): ApiSession => {
    const metadata = deps.metadata?.getMetadata(row.sessionId);
    const process = deps.supervisor?.getProcessForSession(row.sessionId);
    return {
      id: row.sessionId,
      projectId: metadata?.workingProjectId ?? row.projectId,
      provider: metadata?.provider ?? row.provider ?? row.catalogFamily,
      title: metadata?.customTitle ?? row.title ?? null,
      updatedAt: row.updatedAt,
      createdByUser: metadata?.createdByUser,
      apiClient: metadata?.apiClient,
      state:
        deps.sessionState?.(row.sessionId) ??
        (process ? apiSessionState(process) : "not-running"),
    };
  };
  return {
    async session(id, signal) {
      const readNativeRows = deps.sessions.readNativeRows;
      if (!readNativeRows) return undefined;
      signal?.throwIfAborted();
      const identities = deps.metadata?.identities;
      // A row is published under this id either by its own native spelling or
      // through the one native binding the identity store allows a YA id.
      const bound =
        identities && isYaSessionId(id)
          ? identities.resolveYa(id)?.native
          : undefined;
      const projection = await projectCatalogIdentityResult(
        await readNativeRows.call(deps.sessions, [
          id,
          ...(bound ? [String(bound.id)] : []),
        ]),
        identities ? (deps.metadata as SessionMetadataService) : undefined,
        signal,
      );
      signal?.throwIfAborted();
      // A disputed or unlisted id is left to `sessions`, which alone knows
      // whether the catalog can establish absence.
      const rows = projection.rows.filter((row) => row.sessionId === id);
      if (new Set(rows.map((row) => row.projectId)).size > 1) return undefined;
      let session = rows
        .filter((row) => !isDetachedProjectPath(row.projectPath))
        .map(summary)
        .at(-1);
      for (const owned of deps.ownedSessions?.() ?? []) {
        if (owned.id !== id) continue;
        if (session && session.projectId !== owned.projectId) return undefined;
        session ??= owned;
      }
      if (!session) return undefined;
      const candidate = rows.length === 1 ? rows[0] : undefined;
      return {
        session,
        backingStore: describeBackingStore(
          session.provider,
          candidate &&
            (deps.metadata?.getMetadata(id)?.workingProjectId ??
              candidate.projectId) === session.projectId
            ? candidate
            : undefined,
        ),
      };
    },
    async backingStore(session, signal) {
      signal?.throwIfAborted();
      const result = await deps.sessions.read();
      const projection = await projectCatalogIdentityResult(
        result.rows,
        deps.metadata?.identities
          ? (deps.metadata as SessionMetadataService)
          : undefined,
        signal,
      );
      signal?.throwIfAborted();
      const candidates = projection.rows.filter(
        (row) => row.sessionId === session.id,
      );
      const candidate = candidates.length === 1 ? candidates[0] : undefined;
      const row =
        candidate &&
        (deps.metadata?.getMetadata(session.id)?.workingProjectId ??
          candidate.projectId) === session.projectId
          ? candidate
          : undefined;
      return describeBackingStore(session.provider, row);
    },
    sessionInspection: (id) =>
      inspectApiSession(id, deps.metadata, deps.supervisor),
    async selection(query, signal) {
      signal?.throwIfAborted();
      const provider = deps
        .providers()
        .find((item) => item.name === query.provider);
      if (!provider)
        throw new CoreApiError(
          "invalid_request",
          "Provider is not configured on this server",
          400,
        );
      const observedAt = new Date().toISOString();
      if (query.routing === "direct") {
        const models = await provider.getAvailableModels?.();
        signal?.throwIfAborted();
        const catalog = provider.getModelCatalogStatus?.();
        return selectionSchema.parse({
          provider: query.provider,
          routing: "direct",
          available:
            !!models &&
            (query.provider !== "antigravity" || catalog?.source === "live"),
          observedAt,
          models,
          catalog,
        });
      }
      const overview = await deps.agentAuthRouter?.selection(query.provider);
      signal?.throwIfAborted();
      return selectionSchema.parse({
        provider: query.provider,
        routing: "aar",
        available: !!overview,
        observedAt,
        ...(overview
          ? {
              observedAt: overview.observedAt,
              serviceTierSelection: overview.serviceTierSelection,
              policies:
                overview.policies ??
                overview.supportedPolicies?.map((id) => ({ id, label: id })),
              pools: overview.pools.filter(
                (pool) => pool.provider === query.provider,
              ),
              accounts: overview.accounts.filter(
                (account) => account.provider === query.provider,
              ),
            }
          : {}),
      });
    },
    async projects(signal) {
      signal?.throwIfAborted();
      const result = await deps.scanner.readRetainedProjects();
      signal?.throwIfAborted();
      return {
        items: result.projects
          .filter((p) => !isDetachedProjectPath(p.path))
          .map((p) => ({ id: p.id, name: p.name, path: p.path })),
        catalog: { complete: result.complete, refreshing: result.refreshing },
      };
    },
    async sessions(signal) {
      signal?.throwIfAborted();
      const result = await deps.sessions.read();
      signal?.throwIfAborted();
      // Catalog rows are keyed by native id. A session keeps the YA id its
      // creator was given once its process ends only through this projection.
      const projection = deps.metadata?.identities
        ? await projectCatalogIdentityResult(
            result.rows,
            deps.metadata as SessionMetadataService,
            signal,
          )
        : { rows: result.rows, conflicts: [] };
      const rows: readonly Readonly<SessionCatalogRow>[] = projection.rows;
      signal?.throwIfAborted();
      // Session-wide metadata cannot disambiguate conflicting native sources.
      const sourceProjects = new Map<string, string>();
      const ambiguous = new Set<string>();
      for (const row of rows) {
        const previous = sourceProjects.get(row.sessionId);
        if (previous !== undefined && previous !== row.projectId)
          ambiguous.add(row.sessionId);
        sourceProjects.set(row.sessionId, row.projectId);
      }
      const items = rows
        .filter((row) => !ambiguous.has(row.sessionId))
        .filter((r) => !isDetachedProjectPath(r.projectPath))
        .map(summary);
      const byId = new Map<string, ApiSession>(
        items.map((item) => [item.id, item]),
      );
      for (const owned of deps.ownedSessions?.() ?? []) {
        if (ambiguous.has(owned.id)) continue;
        const existing = byId.get(owned.id);
        if (existing && existing.projectId !== owned.projectId) {
          ambiguous.add(owned.id);
          byId.delete(owned.id);
          continue;
        }
        if (!existing) byId.set(owned.id, owned);
      }
      return {
        items: [...byId.values()].filter((item) => !ambiguous.has(item.id)),
        catalog: {
          complete:
            result.catalog.complete && projection.conflicts.length === 0,
          refreshing: result.catalog.refreshing,
        },
      };
    },
    async providers(signal) {
      signal?.throwIfAborted();
      return deps.providers().map((p) => ({
        id: p.name,
        name: p.displayName,
        supportsSteering: p.supportsSteering,
        supportsPermissionMode: p.supportsPermissionMode,
        compaction: {
          supported:
            p.name === "codex" ||
            (p.name === "antigravity" && p.supportsSteering) ||
            isClaudeProviderName(p.name),
          honorsInstructions:
            p.name === "antigravity" || isClaudeProviderName(p.name),
        },
      }));
    },
    hiddenProjects: deps.hiddenProjects,
  };
}
