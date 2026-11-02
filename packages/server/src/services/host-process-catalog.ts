import { dirname } from "node:path";
import {
  getSessionDisplayTitle,
  isYaSessionId,
  nativeSessionFamily,
  type YaSessionId,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import { nativeCatalogSessionRef } from "../sessions/catalog-identity.js";
import type { SessionCatalogRow } from "../sessions/catalog-types.js";
import type { DiscoveredSessionIdentity } from "../sessions/SessionIdentityStore.js";
import type { NativeProcessSession } from "./providerProcessClassifier.js";
import type { NativeSessionDescriber } from "./HostAgentProcessService.js";

/** Resolve PID facts against one retained catalogue snapshot, never by cwd. */
export function describeNativeProcessSessions(deps: {
  metadata?: SessionMetadataService;
  readRows: () => Promise<{ rows: readonly Readonly<SessionCatalogRow>[] }>;
}): NativeSessionDescriber {
  return async (sessions, signal) => {
    const result = new Map<
      NativeProcessSession,
      { sessionId: YaSessionId; projectId: UrlProjectId; sessionTitle?: string }
    >();
    if (
      signal.aborted ||
      !deps.metadata ||
      !sessions.some((session) => session.projectsRoot)
    )
      return result;
    const wanted = new Set(
      sessions
        .filter((session) => session.projectsRoot)
        .map((session) =>
          JSON.stringify([session.projectsRoot, session.nativeSessionId]),
        ),
    );
    const candidates = new Map<string, Readonly<SessionCatalogRow> | null>();
    const { rows } = await deps.readRows();
    if (signal.aborted) return result;
    for (const row of rows) {
      if (row.catalogFamily !== "claude" || !row.nativeStorageScope) continue;
      const key = JSON.stringify([
        dirname(row.nativeStorageScope),
        row.sessionId,
      ]);
      if (!wanted.has(key)) continue;
      // Duplicate native ids in different project stores are ambiguous. A cwd
      // match is not permission to choose one of them.
      candidates.set(key, candidates.has(key) ? null : row);
    }
    const discoveries: DiscoveredSessionIdentity[] = [];
    const matched: Array<{
      session: NativeProcessSession;
      row: Readonly<SessionCatalogRow>;
    }> = [];
    for (const session of sessions) {
      const row = candidates.get(
        JSON.stringify([session.projectsRoot, session.nativeSessionId]),
      );
      if (!row) continue;
      const native = nativeCatalogSessionRef(row);
      if (!native) continue;
      const bound = deps.metadata.identities.lookupNative(native);
      if (bound && bound.projectId !== row.projectId) continue;
      if (
        !bound &&
        isYaSessionId(row.sessionId) &&
        deps.metadata.identities.resolveYa(row.sessionId)
      )
        continue;
      const legacyProvider = deps.metadata.getMetadata(row.sessionId)?.provider;
      if (
        !bound &&
        legacyProvider &&
        nativeSessionFamily(legacyProvider) !== native.family
      )
        continue;
      discoveries.push({
        native,
        provider: row.provider ?? "claude",
        projectId: row.projectId,
        createdAt: row.createdAt ?? row.updatedAt,
        legacyProvider: deps.metadata.getMetadata(row.sessionId)?.provider,
      });
      matched.push({ session, row });
    }
    if (signal.aborted) return result;
    const identities =
      deps.metadata.identities.adoptDiscoveredBatch(discoveries);
    for (const [index, identity] of identities.entries()) {
      if (!identity) continue;
      const { session, row } = matched[index]!;
      const metadata = deps.metadata.getMetadata(identity.sessionId);
      const title = getSessionDisplayTitle({
        customTitle: metadata?.customTitle,
        title: row.title,
      });
      result.set(session, {
        sessionId: identity.sessionId,
        projectId: metadata?.workingProjectId ?? identity.projectId,
        ...(title !== "Untitled" ? { sessionTitle: title } : {}),
      });
    }
    return result;
  };
}
