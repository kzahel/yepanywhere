/**
 * Resolve which project a session belongs to, who started it, whether it runs
 * sandboxed, and whether it is still fresh enough for a limited user's turn.
 *
 * Contract: topics/limited-users.md § Delivery v1 — Authorization.
 *
 * A live process is authoritative for the project and cheap. A session with no
 * process is looked up by public id in the accepted catalog. Last activity
 * is the process's last provider message, else the catalog's last update;
 * a session with neither is never fresh.
 */

import { refreshLruMap } from "../lib/lruCollections.js";
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
  readCatalogRows: (sessionId: string) => Promise<
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

interface CatalogEntry {
  version: string | undefined;
  facts?: CatalogFacts;
  retryAt: number;
}

export class SessionAccessResolver {
  private readonly catalog = new Map<string, CatalogEntry>();
  private readonly pending = new Map<string, Promise<CatalogEntry>>();

  constructor(private readonly deps: SessionAccessResolverDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private cached(sessionId: string) {
    const entry = this.catalog.get(sessionId);
    if (
      entry &&
      entry.version === this.deps.getCatalogVersion?.() &&
      (entry.facts || this.now() < entry.retryAt)
    ) {
      refreshLruMap(this.catalog, sessionId, entry);
      return entry;
    }
    return undefined;
  }

  private async load(sessionId: string): Promise<CatalogEntry> {
    const entry: CatalogEntry = {
      version: this.deps.getCatalogVersion?.(),
      retryAt: this.now() + CATALOG_CACHE_TTL_MS,
    };
    try {
      const rows = await this.deps.readCatalogRows(sessionId);
      for (const row of rows) {
        if (row.sessionId !== sessionId) continue;
        if (entry.facts && entry.facts.projectId !== row.projectId) {
          entry.facts = undefined;
          break;
        }
        const timestamp = Date.parse(row.updatedAt ?? "");
        const updatedAtMs = Number.isFinite(timestamp) ? timestamp : null;
        if (
          !entry.facts ||
          (updatedAtMs ?? 0) > (entry.facts.updatedAtMs ?? 0)
        ) {
          entry.facts = {
            projectId: row.projectId,
            provider: row.provider,
            updatedAtMs,
          };
        }
      }
      return entry;
    } finally {
      // Keep misses and failures briefly. A different publication immediately
      // invalidates all facts derived from the old one, including successes.
      refreshLruMap(this.catalog, sessionId, entry);
      if (this.catalog.size > 512)
        this.catalog.delete(this.catalog.keys().next().value!);
    }
  }

  private refresh(sessionId: string) {
    let work = this.pending.get(sessionId);
    if (!work) {
      work = this.load(sessionId).finally(() => this.pending.delete(sessionId));
      this.pending.set(sessionId, work);
    }
    return work;
  }

  async resolve(sessionId: string): Promise<SessionAccessFacts | null> {
    const live = this.deps.getLiveSession(sessionId);
    const saved = live ? undefined : this.deps.getCreationSession?.(sessionId);
    let entry = this.cached(sessionId);
    if (
      !entry &&
      live?.lastActivityMs == null &&
      (!saved || saved.nativeBound)
    ) {
      entry = await this.refresh(sessionId);
      if (entry.version !== this.deps.getCatalogVersion?.())
        entry = await this.refresh(sessionId);
    }
    const row =
      entry?.version === this.deps.getCatalogVersion?.()
        ? entry?.facts
        : undefined;
    return this.factsFrom(
      this.deps.getSessionMetadata(sessionId),
      live,
      saved,
      row,
    );
  }

  /** Event filters cannot await an uncached session. A later event can reuse its facts. */
  resolveKnown(sessionId: string): SessionAccessFacts | null {
    const live = this.deps.getLiveSession(sessionId);
    const saved = live ? undefined : this.deps.getCreationSession?.(sessionId);
    const entry = this.cached(sessionId);
    if (
      !entry &&
      live?.lastActivityMs == null &&
      (!saved || saved.nativeBound)
    ) {
      this.refresh(sessionId).catch((error: unknown) => {
        console.warn("[SessionAccess] Session catalog read failed:", error);
      });
    }
    return this.factsFrom(
      this.deps.getSessionMetadata(sessionId),
      live,
      saved,
      entry?.facts,
    );
  }

  private factsFrom(
    metadata: ReturnType<SessionAccessResolverDeps["getSessionMetadata"]>,
    live: ReturnType<SessionAccessResolverDeps["getLiveSession"]>,
    saved:
      | { projectId: string; provider: string; nativeBound?: boolean }
      | undefined,
    row: CatalogFacts | undefined,
  ): SessionAccessFacts | null {
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
