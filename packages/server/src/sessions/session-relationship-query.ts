import type {
  RelationshipEvidence,
  RelationshipResource,
  SessionRelationshipStore,
  StoredRelationship,
} from "./SessionRelationshipStore.js";

export type RelationshipQuerySource = Pick<
  SessionRelationshipStore,
  "list" | "evidence"
>;

export interface RelationshipProjectionAccess<T, E> {
  /** The queried resource must be authorized before looking up graph rows. */
  anchor(resource: RelationshipResource): boolean;
  /**
   * Resolve through the caller's existing identity/access owner. Undefined
   * withholds the whole edge and its evidence. An edge grants
   * no authority to resolve either endpoint.
   */
  endpoint(
    resource: RelationshipResource,
    edge: StoredRelationship,
    position: "source" | "target",
  ): T | undefined;
  /**
   * Authorize and project an evidence allow-list. Receipt/proof visibility is
   * separate from endpoint access; private source keys/versions are not wire data.
   */
  evidence(
    evidence: RelationshipEvidence,
    edge: StoredRelationship,
  ): E | undefined;
}

export interface ProjectedRelationship<T, E> {
  type: StoredRelationship["type"];
  source: T;
  target: T;
  evidence: E[];
}

/**
 * Internal bounded acquisition batch, NOT a public pagination response.
 * `scanAfter` advances past raw rows, including withheld ones. Never serialize
 * it, `withheld`, raw edge ids, or inferred count/has-more into an API reply. An API
 * adapter needs its own authorized-page lookahead and continuation contract.
 */
export class RelationshipProjectionBatch<T, E> {
  #scanAfter: string | null;
  #withheld: boolean;
  #positions: readonly string[];
  #scanned: number;
  #verify: readonly (() => ProjectedRelationship<T, E> | undefined)[];
  constructor(
    readonly relationships: ProjectedRelationship<T, E>[],
    scanAfter: string | null,
    withheld: boolean,
    positions: readonly string[],
    scanned: number,
    verify: readonly (() => ProjectedRelationship<T, E> | undefined)[],
  ) {
    this.#scanAfter = scanAfter;
    this.#withheld = withheld;
    this.#positions = positions;
    this.#scanned = scanned;
    this.#verify = verify;
  }
  // Private scan control is intentionally absent from JSON/object spread.
  get scanAfter(): string | null {
    return this.#scanAfter;
  }
  get withheld(): boolean {
    return this.#withheld;
  }
  /** Private continuation of a projected row, never a wire identifier. */
  position(index: number): string {
    const position = this.#positions[index];
    if (position === undefined)
      throw new Error("Invalid relationship position");
    return position;
  }
  get scanned(): number {
    return this.#scanned;
  }
  /** Re-run caller-owned visibility before publishing a page across yields. */
  verifier(index: number): () => ProjectedRelationship<T, E> | undefined {
    const verify = this.#verify[index];
    if (!verify) throw new Error("Invalid relationship position");
    return verify;
  }
}

/**
 * Common read boundary above the private SQL index. No native I/O, identity
 * registry, grants, cache, transitive expansion, or background work. The
 * caller supplies existing resource and evidence policy for its projection.
 * At most two indexed anchor reads select 200 unique edges for projection,
 * with at most 20 evidence rows per selected edge. For the bare index, both
 * directions use at most four list statements / 804 fetched rows / 400 decoded
 * edges, plus 200 evidence queries and caller-owned policy work. An authorized
 * SQL source may examine more anchor edges while filtering before LIMIT; these
 * are result/decode bounds, not a per-statement work or latency ceiling.
 * Existing statements and the incoming/outgoing merge are reused.
 */
export function projectRelationshipBatch<T, E>(
  store: RelationshipQuerySource,
  input: Omit<Parameters<SessionRelationshipStore["list"]>[0], "resource"> & {
    /** A canonical YA resource plus its existing exact native binding, at most. */
    resources: readonly RelationshipResource[];
    /** Only async page assembly retains witnesses across event-loop yields. */
    retainVerification?: true;
  },
  access: RelationshipProjectionAccess<T, E>,
): RelationshipProjectionBatch<T, E> | undefined {
  if (input.resources.length < 1 || input.resources.length > 2)
    throw new Error("Invalid relationship projection anchors");
  if (input.resources.some((resource) => !access.anchor(resource)))
    return undefined;
  const requested = input.limit ?? 200;
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > 200)
    throw new Error("Invalid relationship projection batch size");
  const pages = input.resources.map((resource) =>
    store.list({ ...input, resource, limit: requested }),
  );
  const acquired = [
    ...new Map(
      pages.flatMap((page) => page.edges).map((edge) => [edge.id, edge]),
    ).values(),
  ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const edges = acquired.slice(0, requested);
  const scanAfter =
    acquired.length > requested || pages.some((page) => page.next)
      ? edges.at(-1)!.id
      : null;
  const relationships: ProjectedRelationship<T, E>[] = [];
  const positions: string[] = [];
  const verify: (() => ProjectedRelationship<T, E> | undefined)[] = [];
  let withheld = false;
  for (const edge of edges) {
    const source = access.endpoint(edge.source, edge, "source");
    if (source === undefined) {
      withheld = true;
      continue;
    }
    const target = access.endpoint(edge.target, edge, "target");
    if (target === undefined) {
      withheld = true;
      continue;
    }
    const evidence: E[] = [];
    const entries = store.evidence(edge.id, { limit: 20 });
    for (const entry of entries) {
      const projected = access.evidence(entry, edge);
      if (projected !== undefined) evidence.push(projected);
    }
    if (!evidence.length) {
      withheld = true;
      continue;
    }
    relationships.push({
      type: edge.type,
      source,
      target,
      evidence,
    });
    positions.push(edge.id);
    if (input.retainVerification)
      verify.push(() => {
        const source = access.endpoint(edge.source, edge, "source");
        if (source === undefined) return undefined;
        const target = access.endpoint(edge.target, edge, "target");
        if (target === undefined) return undefined;
        const evidence = entries
          .map((entry) => access.evidence(entry, edge))
          .filter((entry): entry is E => entry !== undefined);
        return evidence.length
          ? { type: edge.type, source, target, evidence }
          : undefined;
      });
  }
  return new RelationshipProjectionBatch(
    relationships,
    scanAfter,
    withheld,
    positions,
    edges.length,
    verify,
  );
}
