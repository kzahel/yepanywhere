/**
 * Resolve which project a session belongs to, who started it, whether it runs
 * sandboxed, and whether it is still fresh enough for a limited user's turn.
 *
 * Contract: topics/limited-users.md § Delivery v1 — Authorization.
 *
 * A live process is authoritative for the project and cheap. A session with no
 * process is looked up in the session catalog, whose rows are cached here for
 * a few seconds so a burst of session requests costs one read. Last activity
 * is the process's last provider message, else the catalog's last update;
 * a session with neither is never fresh.
 */

import { isSessionFreshForJoin } from "@yep-anywhere/shared";

export interface SessionAccessFacts {
  projectId: string;
  provider: string | undefined;
  lastActivityMs: number | null;
  createdByUser: string | undefined;
  /**
   * Whether the session runs in the project-write sandbox with its network
   * firewall on: what the live process enforces, else what its last launch
   * recorded. A firewall-off session is as far outside a limited user's
   * boundary as an unsandboxed one.
   */
  sandboxed: boolean;
}

export interface SessionAccessResolverDeps {
  /** Live process lookup, authoritative when the session is running. */
  getLiveSession: (sessionId: string) =>
    | {
        projectId: string;
        provider?: string;
        /** Last provider message; null before the process has seen one. */
        lastActivityMs?: number | null;
        /** The process enforces the project-write sandbox and its firewall. */
        sandboxed?: boolean;
      }
    | undefined;
  /** Session catalog rows, for sessions with no live process. */
  readCatalogRows: () => Promise<
    ReadonlyArray<{
      sessionId: string;
      projectId: string;
      provider?: string;
      updatedAt?: string;
    }>
  >;
  /** Persisted creation resources; only a bound native row may supply activity. */
  getCreationSession?: (
    sessionId: string,
  ) =>
    | { projectId: string; provider: string; nativeBound?: boolean }
    | undefined;
  /** Compact publication identity; never scans or refreshes provider stores. */
  getCatalogVersion?: () => string | undefined;
  /** Session metadata: the user recorded at creation and the sandbox level. */
  getSessionMetadata: (sessionId: string) =>
    | {
        createdByUser?: string;
        workingProjectId?: string;
        sandboxLevel?: string;
        /** Absent means on for a project-write session. */
        sandboxNetworkFirewall?: boolean;
      }
    | undefined;
  now?: () => number;
}

const CATALOG_CACHE_TTL_MS = 5_000;

interface CatalogFacts {
  projectId: string;
  provider?: string;
  updatedAtMs: number | null;
}

export class SessionAccessResolver {
  private catalog = new Map<string, CatalogFacts>();
  /** Session ids whose catalog rows name more than one project. */
  private ambiguous = new Set<string>();
  private catalogAttemptedAt = Number.NEGATIVE_INFINITY;
  private catalogLoad: Promise<void> | null = null;
  private catalogAttemptedVersion: string | undefined;
  private catalogLoadedVersion: string | undefined;

  constructor(private readonly deps: SessionAccessResolverDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * Re-read the catalog at most once per TTL, success or failure, so a
   * failing or unknown-id stream costs one read per interval.
   */
  private async refreshCatalog(): Promise<void> {
    const version = this.deps.getCatalogVersion?.();
    if (
      !this.catalogLoad &&
      this.now() - this.catalogAttemptedAt < CATALOG_CACHE_TTL_MS &&
      version === this.catalogAttemptedVersion
    ) {
      return;
    }
    this.catalogLoad ??= (async () => {
      this.catalogAttemptedAt = this.now();
      this.catalogAttemptedVersion = version;
      try {
        const rows = await this.deps.readCatalogRows();
        const next = new Map<string, CatalogFacts>();
        const ambiguous = new Set<string>();
        for (const row of rows) {
          const updatedAtMs = row.updatedAt
            ? Date.parse(row.updatedAt)
            : Number.NaN;
          const facts: CatalogFacts = {
            projectId: row.projectId,
            provider: row.provider,
            updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : null,
          };
          const prior = next.get(row.sessionId);
          if (prior && prior.projectId !== facts.projectId) {
            ambiguous.add(row.sessionId);
          }
          if (!prior || (facts.updatedAtMs ?? 0) > (prior.updatedAtMs ?? 0)) {
            next.set(row.sessionId, facts);
          }
        }
        this.catalog = next;
        this.ambiguous = ambiguous;
        // Capture the version before reading. A publication during the read
        // must remain observable to the next caller, even if that read ended
        // up using the newer generation.
        this.catalogLoadedVersion = version;
      } finally {
        this.catalogLoad = null;
      }
    })();
    await this.catalogLoad;
  }

  private catalogFacts(sessionId: string): CatalogFacts | undefined {
    // A removed, moved or newly ambiguous session must not keep authorizing
    // requests/events while its replacement projection loads or retries.
    if (!this.catalogIsCurrent()) return undefined;
    return this.ambiguous.has(sessionId)
      ? undefined
      : this.catalog.get(sessionId);
  }

  private catalogIsCurrent(): boolean {
    return this.catalogLoadedVersion === this.deps.getCatalogVersion?.();
  }

  /** Whether the catalog could add a project or activity time to these facts. */
  private needsCatalog(
    sessionId: string,
    live: ReturnType<SessionAccessResolverDeps["getLiveSession"]>,
  ): boolean {
    if (live?.lastActivityMs != null) return false;
    if (this.deps.getCatalogVersion?.() !== this.catalogLoadedVersion)
      return true;
    if (this.catalog.has(sessionId)) return false;
    return !live || live.lastActivityMs == null;
  }

  /** Facts about a session, or null when it resolves to no project. */
  async resolve(sessionId: string): Promise<SessionAccessFacts | null> {
    const metadata = this.deps.getSessionMetadata(sessionId);
    const live = this.deps.getLiveSession(sessionId);
    const saved = live ? undefined : this.deps.getCreationSession?.(sessionId);
    if (
      (!saved || saved.nativeBound === true) &&
      this.needsCatalog(sessionId, live)
    ) {
      await this.refreshCatalog();
      // A publication can race the shared read. Join one replacement read,
      // then fail closed if publications still outpace it; never chase an
      // unbounded sequence of generations on a foreground request.
      if (!this.catalogIsCurrent()) await this.refreshCatalog();
    }
    return this.factsFrom(sessionId, metadata, live, saved);
  }

  /**
   * Facts from what is already in memory — the live process, session
   * metadata, and the last catalog read — for callers that cannot wait, such
   * as per-event activity filtering. A session the last read lacked starts a
   * background read, so its later events resolve.
   */
  resolveKnown(sessionId: string): SessionAccessFacts | null {
    const live = this.deps.getLiveSession(sessionId);
    const saved = live ? undefined : this.deps.getCreationSession?.(sessionId);
    if (
      (!saved || saved.nativeBound === true) &&
      this.needsCatalog(sessionId, live)
    ) {
      this.refreshCatalog().catch((error: unknown) => {
        console.warn("[SessionAccess] Session catalog read failed:", error);
      });
    }
    return this.factsFrom(
      sessionId,
      this.deps.getSessionMetadata(sessionId),
      live,
      saved,
    );
  }

  private factsFrom(
    sessionId: string,
    metadata: ReturnType<SessionAccessResolverDeps["getSessionMetadata"]>,
    live: ReturnType<SessionAccessResolverDeps["getLiveSession"]>,
    saved?: { projectId: string; provider: string; nativeBound?: boolean },
  ): SessionAccessFacts | null {
    const row = this.catalogFacts(sessionId);
    if (live) {
      return {
        projectId: metadata?.workingProjectId ?? live.projectId,
        provider: live.provider,
        lastActivityMs: live.lastActivityMs ?? row?.updatedAtMs ?? null,
        createdByUser: metadata?.createdByUser,
        // What the running process enforces, whatever its metadata says.
        sandboxed: live.sandboxed === true,
      };
    }

    const sandboxed =
      metadata?.sandboxLevel === "project-write" &&
      metadata.sandboxNetworkFirewall !== false;
    // The current YA resource wins over a cached native spelling with the
    // same id. Its saved timestamp is never native activity or join freshness.
    if (saved) {
      return {
        projectId: metadata?.workingProjectId ?? saved.projectId,
        provider: saved.provider,
        lastActivityMs: saved.nativeBound ? (row?.updatedAtMs ?? null) : null,
        createdByUser: metadata?.createdByUser,
        sandboxed,
      };
    }
    if (!row) {
      // A pinned project still identifies an otherwise unknown session.
      if (metadata?.workingProjectId) {
        return {
          projectId: metadata.workingProjectId,
          provider: undefined,
          lastActivityMs: null,
          createdByUser: metadata.createdByUser,
          sandboxed,
        };
      }
      return null;
    }
    return {
      projectId: metadata?.workingProjectId ?? row.projectId,
      provider: row.provider,
      lastActivityMs: row.updatedAtMs,
      createdByUser: metadata?.createdByUser,
      sandboxed,
    };
  }

  /**
   * Whether the session is fresh enough for a limited user to send turns to
   * it right now. Freshness alone: the middleware also requires the session
   * to run sandboxed. Who started the session does not matter — the cost of
   * a cold turn is the same in the user's own session.
   */
  isFresh(
    facts: SessionAccessFacts,
    options: { offsetMinutes: number },
  ): boolean {
    return isSessionFreshForJoin({
      provider: facts.provider,
      lastActivityMs: facts.lastActivityMs,
      offsetMinutes: options.offsetMinutes,
      nowMs: this.now(),
    });
  }
}
