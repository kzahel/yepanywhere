import type {
  ProviderChildSessionSummary,
  ProviderName,
} from "@yep-anywhere/shared";
import type { Project } from "../supervisor/types.js";
import {
  boundSessionSource,
  getSessionSourceForProvider,
  type ProviderProjectCatalog,
  type ProviderResolutionDeps,
} from "./provider-resolution.js";
import type { ISessionReader } from "./types.js";

export type ProviderChildLookupMode = "fresh" | "accepted-or-cheap";

export async function resolveProviderChildSessions(
  reader:
    | Pick<
        ISessionReader,
        "listProviderChildSessions" | "listAcceptedProviderChildSessions"
      >
    | undefined,
  nativeParentSessionId: string,
  mode: ProviderChildLookupMode,
): Promise<ProviderChildSessionSummary[] | undefined> {
  if (!reader) {
    return undefined;
  }
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
      let legacyReader: ISessionReader | undefined;
      for (const { index, session } of providerSessions) {
        const bound = boundSessionSource(project, session.id, deps);
        if (bound === null) continue;
        if (!bound && !legacyReader) {
          legacyReader = readerForProviderChildren(
            project,
            deps,
            provider,
            catalog,
          );
        }
        const reader = bound?.source.reader ?? legacyReader;
        const children = projectProviderChildren(
          await resolveProviderChildSessions(
            reader,
            bound?.nativeSessionId ?? session.id,
            mode,
          ),
          session.id,
        );
        if (children?.length) {
          attached[index] = { ...session, providerChildren: children };
        }
      }
    }),
  );
  return attached;
}
