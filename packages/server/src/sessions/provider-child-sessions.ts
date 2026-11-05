import type { NativeSessionRef } from "@yep-anywhere/shared";
import type { ProviderChildRelationshipService } from "./ProviderChildRelationshipService.js";
import type {
  ProviderChildSessionSummary,
  ProviderName,
} from "@yep-anywhere/shared";
import type { Project } from "../supervisor/types.js";
import {
  boundSessionSource,
  getSessionSourceForProvider,
  resolveLegacySessionSource,
  type SessionSource,
  type ProviderProjectCatalog,
  type ProviderResolutionDeps,
} from "./provider-resolution.js";
import type { ISessionReader } from "./types.js";
import type { AgentMapping } from "./reader.js";

/** Preserve fresh native anchors and supplement unavailable legacy metadata. */
export function mergeProviderChildAgentMappings(
  fresh: readonly AgentMapping[],
  accepted: readonly ProviderChildSessionSummary[] | undefined,
): AgentMapping[] {
  const mappings = [...fresh];
  if (!accepted) return mappings;
  const byAgent = new Map<string, number>();
  const byCall = new Map<string, Set<string>>();
  const positions = new Map<string, number[]>();
  const freshCalls = new Map<string, Set<string>>();
  for (const [i, m] of mappings.entries()) {
    const at = positions.get(m.agentId) ?? [];
    at.push(i);
    positions.set(m.agentId, at);
    if (m.toolUseId === m.agentId) continue;
    const agents = freshCalls.get(m.toolUseId) ?? new Set<string>();
    agents.add(m.agentId);
    freshCalls.set(m.toolUseId, agents);
  }
  for (const child of accepted) {
    byAgent.set(child.id, (byAgent.get(child.id) ?? 0) + 1);
    if (!child.toolUseId) continue;
    const ids = byCall.get(child.toolUseId) ?? new Set<string>();
    ids.add(child.id);
    byCall.set(child.toolUseId, ids);
  }
  for (const child of accepted) {
    if (
      !child.toolUseId ||
      byAgent.get(child.id) !== 1 ||
      byCall.get(child.toolUseId)?.size !== 1
    )
      continue;
    const existing = positions.get(child.id) ?? [];
    // A current anchor (including provider part-id aliases) outranks SQL.
    // An agent-id placeholder carries no contrary launch evidence.
    if (existing.some((i) => mappings[i]!.toolUseId !== mappings[i]!.agentId))
      continue;
    const calls = freshCalls.get(child.toolUseId);
    if (calls && (calls.size > 1 || !calls.has(child.id))) continue;
    const known: AgentMapping = {
      toolUseId: child.toolUseId,
      agentId: child.id,
      ...(child.agentType ? { agentType: child.agentType } : {}),
      ...(child.title ? { description: child.title } : {}),
      ...(child.spawnDepth !== undefined
        ? { spawnDepth: child.spawnDepth }
        : {}),
    };
    if (!existing.length) mappings.push(known);
    else
      for (const i of existing)
        mappings[i] = { ...known, ...mappings[i]!, toolUseId: known.toolUseId };
  }
  return mappings;
}

export type ProviderChildLookupMode = "fresh" | "accepted-or-cheap";

export async function resolveProviderChildSessions(
  reader:
    | Pick<
        ISessionReader,
        | "listProviderChildSessions"
        | "listAcceptedProviderChildSessions"
        | "getProviderChildSource"
      >
    | undefined,
  nativeParentSessionId: string,
  mode: ProviderChildLookupMode,
  indexed?: {
    service: ProviderChildRelationshipService;
    native: NativeSessionRef;
    publicSessionId: string;
  },
): Promise<ProviderChildSessionSummary[] | undefined> {
  if (indexed) {
    const accepted = indexed.service.accepted(
      indexed.native,
      indexed.publicSessionId,
    );
    const source = reader?.getProviderChildSource?.(indexed.native);
    // A bound lookup never loses its namespace or its durable facts because
    // native acquisition is unavailable. Bare-id discovery is legacy only.
    if (!source) return accepted;
    const children =
      accepted && !indexed.service.hasSource(indexed.native)
        ? (source.overlayActivity?.(accepted) ?? accepted)
        : accepted;
    if (mode === "fresh")
      indexed.service.demand(
        indexed.native,
        { sessionId: indexed.publicSessionId },
        source,
        "foreground",
      );
    else
      indexed.service.requestMetadataRefresh(
        indexed.native,
        { sessionId: indexed.publicSessionId },
        source,
      );
    return children;
  }
  if (!reader) return undefined;
  if (
    mode === "accepted-or-cheap" &&
    reader.listAcceptedProviderChildSessions
  ) {
    return reader.listAcceptedProviderChildSessions(nativeParentSessionId);
  }
  return reader.listProviderChildSessions?.(nativeParentSessionId);
}

/** Child handles stay native beneath the canonical public parent /agents URL. */
export function projectProviderChildren(
  children: ProviderChildSessionSummary[] | undefined,
  sessionId: string,
): ProviderChildSessionSummary[] | undefined {
  return children?.map((child) => ({ ...child, parentSessionId: sessionId }));
}

export function readerForProviderChildren(
  project: Project,
  deps: ProviderResolutionDeps,
  provider?: ProviderName,
  catalog?: ProviderProjectCatalog,
): ISessionReader | undefined {
  return getSessionSourceForProvider(
    project,
    deps,
    provider ?? project.provider,
    catalog,
  )?.reader;
}

export async function attachProviderChildSessions<
  T extends {
    id: string;
    provider?: ProviderName;
    providerChildren?: ProviderChildSessionSummary[];
  },
>(
  sessions: T[],
  project: Project,
  deps: ProviderResolutionDeps,
  mode: ProviderChildLookupMode,
  catalog?: ProviderProjectCatalog,
): Promise<Array<T & { providerChildren?: ProviderChildSessionSummary[] }>> {
  if (sessions.length === 0) {
    return sessions;
  }

  const sessionsByProvider = new Map<
    ProviderName,
    Array<{ index: number; session: T }>
  >();
  sessions.forEach((session, index) => {
    const provider = session.provider ?? project.provider;
    const providerSessions = sessionsByProvider.get(provider);
    if (providerSessions) providerSessions.push({ index, session });
    else sessionsByProvider.set(provider, [{ index, session }]);
  });

  const attached = [...sessions];
  await Promise.all(
    [...sessionsByProvider].map(async ([provider, providerSessions]) => {
      let legacySource: SessionSource | undefined;
      let nativeRefs: ReadonlyMap<string, NativeSessionRef> | undefined;
      for (const { index, session } of providerSessions) {
        const bound = boundSessionSource(project, session.id, deps);
        if (bound === null) continue;
        if (!bound && !legacySource) {
          legacySource =
            getSessionSourceForProvider(project, deps, provider, catalog) ??
            undefined;
          if (
            deps.identities &&
            deps.providerChildRelationships &&
            legacySource?.reader.getProviderChildSource &&
            legacySource.reader.getNativeSessionRefs
          ) {
            nativeRefs = await legacySource.reader.getNativeSessionRefs(
              providerSessions.map(({ session }) => session.id),
            );
          }
        }
        const legacy =
          !bound &&
          legacySource &&
          legacySource.reader.getProviderChildSource &&
          deps.providerChildRelationships
            ? await resolveLegacySessionSource(
                legacySource,
                session.id,
                project,
                deps,
                nativeRefs
                  ? { nativeRef: nativeRefs.get(session.id) ?? null }
                  : undefined,
              )
            : legacySource
              ? {
                  source: legacySource,
                  nativeSessionId: session.id,
                  native: undefined,
                }
              : undefined;
        if (legacy === null) continue;
        const resolved = bound ?? legacy;
        const reader = resolved?.source.reader;
        const children = projectProviderChildren(
          await resolveProviderChildSessions(
            reader,
            resolved?.nativeSessionId ?? session.id,
            mode,
            deps.providerChildRelationships && resolved?.native
              ? {
                  service: deps.providerChildRelationships,
                  native: resolved.native,
                  publicSessionId: session.id,
                }
              : undefined,
          ),
          session.id,
        );
        if (
          children?.length ||
          (deps.providerChildRelationships &&
            resolved?.native &&
            children !== undefined)
        ) {
          attached[index] = { ...session, providerChildren: children };
        }
      }
    }),
  );
  return attached;
}
