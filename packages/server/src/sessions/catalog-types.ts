import type { ProviderName, UrlProjectId } from "@yep-anywhere/shared";
import type { SessionListSummary } from "./types.js";
import type { ProviderCatalogFamily } from "./provider-catalog-family.js";

export type SessionCatalogFidelity = "identity" | "head" | "tail";

export type SessionCatalogLocation =
  | { kind: "file"; path: string }
  | { kind: "database"; path: string; recordId: string }
  | { kind: "provider"; recordId: string };

/**
 * A catalog title is stored whole, up to this bound: All Sessions matches
 * these rows in the browser, so a row that kept only a display-length title
 * would silently make anything past that length unsearchable. The bound is
 * the one the catalog already validates every row title against.
 */
export const SESSION_CATALOG_TITLE_MAX_LENGTH = 16_384;

/**
 * Compact provider-native facts retained independently of transcript detail.
 * Adapters must yield at most one row per (family, store, native session id).
 */
export interface SessionCatalogRow {
  catalogFamily: ProviderCatalogFamily;
  storeKey: string;
  sessionId: string;
  /** Actual reader root when a merged catalogue includes private transcripts. */
  nativeStorageScope?: string;
  /** OpenCode actual session directory, distinct from legacy worktree grouping. */
  nativeDirectoryProjectId?: UrlProjectId;
  projectId: UrlProjectId;
  /** Canonical host path for explicit detail resolution. */
  projectPath: string;
  /** Case/platform-normalized project membership key. */
  projectIdentityKey: string;
  updatedAt: string;
  createdAt?: string;
  /** The latest turn a person wrote; the sidebar files sessions by it. */
  lastHumanTurnAt?: string;
  /** Untruncated; surfaces truncate for display. */
  title?: string | null;
  provider?: ProviderName;
  projectName?: string;
  asyncQuestions?: SessionListSummary["asyncQuestions"];
  fidelity: SessionCatalogFidelity;
  /** Exact provider source identity that established this row. */
  sourceVersion: string;
  /**
   * Version of the adapter projection that built this row. An adapter that
   * reuses a row while its source is unchanged must also require its current
   * format, or rows an older build stored keep that build's facts forever.
   */
  rowFormat?: number;
  location: SessionCatalogLocation;
}

export interface SessionCatalogRowKey {
  catalogFamily: ProviderCatalogFamily;
  storeKey: string;
  sessionId: string;
}

export type SessionCatalogScanMode =
  | { kind: "complete" }
  | { kind: "recent"; activeAfterMs: number };

export interface SessionCatalogScanContext {
  catalogEpoch: string;
  targetGeneration: number;
  mode: SessionCatalogScanMode;
  signal: AbortSignal;
}

export interface SessionCatalogAdapterScan {
  /** Provider-wide source version for diagnostics and reconciliation. */
  sourceVersion: string;
  rows: Iterable<SessionCatalogRow> | AsyncIterable<SessionCatalogRow>;
  metrics?: Readonly<Record<string, number>>;
  /** A point update leaves unmentioned keys in this source unchanged. */
  partial?: boolean;
  removed?: readonly SessionCatalogRowKey[];
}

/** One install-wide scan adapter per eligible native provider store. */
export interface NativeSessionCatalogAdapter {
  catalogFamily: ProviderCatalogFamily;
  storeKey: string;
  scan(context: SessionCatalogScanContext): Promise<SessionCatalogAdapterScan>;
}

export function sessionCatalogRowKey(
  row: SessionCatalogRow | SessionCatalogRowKey,
): string {
  return JSON.stringify([row.catalogFamily, row.storeKey, row.sessionId]);
}

/** Indexed catalog facts for a changed-file publication, without a full scan. */
export interface CatalogFileLookup {
  fileStoreProject(
    family: string,
    store: string,
  ): Readonly<SessionCatalogRow> | undefined;
  readAllRows(): Promise<readonly Readonly<SessionCatalogRow>[]>;
}
