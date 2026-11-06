import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  relationshipResourceKey,
  type RelationshipResource,
  type SessionRelationshipType,
} from "./SessionRelationshipStore.js";
import {
  projectRelationshipBatch,
  type ProjectedRelationship,
  type RelationshipProjectionAccess,
  type RelationshipQuerySource,
} from "./session-relationship-query.js";

export class RelationshipPageError extends Error {
  constructor(readonly code: "invalid_cursor" | "unavailable" | "forbidden") {
    super(
      code === "invalid_cursor"
        ? "Relationship cursor is invalid or expired; start a new page"
        : code === "forbidden"
          ? "Relationship anchor is unavailable"
          : "Relationship page could not be completed within its read bound",
    );
  }
}

export interface RelationshipPage<T, E> {
  relationships: ProjectedRelationship<T, E>[];
  /** Exists only when another authorized relationship was observed. */
  nextCursor: string | null;
}

const CURSOR_LIFETIME_MS = 10 * 60_000;
const MAX_SCANNED_EDGES = 2_000;
const BATCH_SIZE = 200;

/**
 * Profile-lifetime read adapter. Retains only a 32-byte process-local cursor
 * key, never session/page state. No native I/O, new statements or timers.
 * Restart expires cursors, not durable facts. Callers reauthorize both ends
 * and proof visibility through their existing policy on every request.
 */
export class SessionRelationshipPages {
  readonly #key = randomBytes(32);

  constructor(private readonly now = Date.now) {}

  async read<T, E>(input: {
    resources: readonly RelationshipResource[];
    /** Request-local scoped query; evaluated only after anchor authorization. */
    source: () => RelationshipQuerySource;
    /** Server-established principal and authorization scope, never client JSON. */
    binding: string;
    direction?: "incoming" | "outgoing" | "both";
    type?: SessionRelationshipType;
    limit?: number;
    cursor?: string;
    access: RelationshipProjectionAccess<T, E>;
    signal?: AbortSignal;
  }): Promise<RelationshipPage<T, E>> {
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Invalid relationship page size");
    if (input.resources.length < 1 || input.resources.length > 2)
      throw new Error("Invalid relationship page anchors");
    const authorize = () => {
      input.signal?.throwIfAborted();
      if (input.resources.some((resource) => !input.access.anchor(resource)))
        throw new RelationshipPageError("forbidden");
    };
    authorize(); // Even lazy graph statement creation follows authorization.
    const binding = createHash("sha256")
      .update(
        JSON.stringify([
          input.binding,
          input.resources.map(relationshipResourceKey).sort(),
          input.direction ?? "both",
          input.type ?? null,
        ]),
      )
      .digest("hex");
    let after = input.cursor ? this.decode(input.cursor, binding) : undefined;
    // Request-local witnesses: at most limit + one authorized lookahead row.
    const verify: (() => ProjectedRelationship<T, E> | undefined)[] = [];
    const finish = (nextCursor: string | null): RelationshipPage<T, E> => {
      authorize();
      const relationships = verify.map((read) => read());
      if (relationships.some((row) => row === undefined))
        throw new RelationshipPageError("unavailable");
      authorize();
      return {
        relationships: (relationships as ProjectedRelationship<T, E>[]).slice(
          0,
          limit,
        ),
        nextCursor,
      };
    };
    let scanned = 0;
    let lastPosition: string | undefined;
    while (scanned < MAX_SCANNED_EDGES) {
      authorize();
      const batch = projectRelationshipBatch(
        input.source(),
        {
          resources: input.resources,
          direction: input.direction,
          type: input.type,
          after,
          limit: Math.min(BATCH_SIZE, MAX_SCANNED_EDGES - scanned),
          retainVerification: true,
        },
        input.access,
      );
      if (!batch) throw new RelationshipPageError("forbidden");
      scanned += batch.scanned;
      for (const index of batch.relationships.keys()) {
        verify.push(batch.verifier(index));
        if (verify.length > limit) {
          return finish(this.encode(lastPosition!, binding));
        }
        lastPosition = batch.position(index);
      }
      if (batch.scanAfter === null) {
        return finish(null);
      }
      after = batch.scanAfter;
      // Yield between finite SQL batches so concurrent requests/cancellation
      // can progress. Recheck anchor authority after each yield.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    // Never turn private scan progress into a public cursor/has-more flag or
    // assert known empty because an authorization/evidence budget was reached.
    throw new RelationshipPageError("unavailable");
  }

  private encode(after: string, binding: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(
        JSON.stringify({
          after,
          binding,
          expires: this.now() + CURSOR_LIFETIME_MS,
        }),
        "utf8",
      ),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
      "base64url",
    );
  }

  private decode(cursor: string, binding: string): string {
    try {
      if (!/^[A-Za-z0-9_-]{40,1024}$/.test(cursor)) throw new Error();
      const bytes = Buffer.from(cursor, "base64url");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.#key,
        bytes.subarray(0, 12),
      );
      decipher.setAuthTag(bytes.subarray(12, 28));
      const payload = JSON.parse(
        Buffer.concat([
          decipher.update(bytes.subarray(28)),
          decipher.final(),
        ]).toString("utf8"),
      );
      if (
        payload.binding !== binding ||
        !Number.isSafeInteger(payload.expires) ||
        payload.expires <= this.now() ||
        typeof payload.after !== "string" ||
        !/^[0-9a-f]{64}$/.test(payload.after)
      )
        throw new Error();
      return payload.after;
    } catch {
      throw new RelationshipPageError("invalid_cursor");
    }
  }
}
