import { createHash } from "node:crypto";
import {
  getAuthenticatedDirectLogin,
  getAuthenticatedSrpTransport,
} from "../middleware/authenticated-transport.js";
import type { Context } from "hono";
import { stream } from "hono/streaming";
import {
  diffCollectionView,
  type CollectionUpdate,
  type CollectionView,
} from "@yep-anywhere/shared/collection-updates";
import { PRINCIPAL_VARIABLE } from "../auth/principal.js";
import type { CollectionUpdates } from "../services/CollectionUpdates.js";

// Private WS login objects are weakly scoped to their original stream request.
// Unlike a username, their identity cannot merge independently bound logins.
const privateLoginScopes = new WeakMap<object, number>();
let nextPrivateLoginScope = 0;
function loginScope(context: Context) {
  const login =
    getAuthenticatedSrpTransport(context.env) ??
    getAuthenticatedDirectLogin(context.env);
  if (!login) return null;
  let scope = privateLoginScopes.get(login);
  if (scope === undefined) {
    scope = ++nextPrivateLoginScope;
    privateLoginScopes.set(login, scope);
  }
  return scope;
}

/** Only these existing canonical filtered reads may be subscribed. */
export function collectionReadPath(query: string): string {
  if (query.length > 4096 || !query.startsWith("/"))
    throw new Error("Invalid collection query");
  const url = new URL(query, "http://collection.invalid");
  const allowed =
    url.pathname === "/sessions"
      ? [
          "summaryMode",
          "limit",
          "project",
          "includeArchived",
          "starred",
          "categorized",
          "includeStats",
        ]
      : url.pathname === "/inbox"
        ? ["summaryMode", "projectId"]
        : url.pathname === "/projects"
          ? ["summaryMode"]
          : url.pathname === "/project-queue"
            ? []
            : null;
  if (
    url.origin !== "http://collection.invalid" ||
    url.pathname !== query.split("?")[0] ||
    allowed === null ||
    url.hash ||
    [...url.searchParams.keys()].some(
      (key) =>
        !allowed.includes(key) || url.searchParams.getAll(key).length !== 1,
    )
  )
    throw new Error("Invalid collection query");
  const limit = Number(url.searchParams.get("limit") ?? "100");
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new Error("Invalid collection window");
  if (url.pathname !== "/project-queue")
    url.searchParams.set("summaryMode", "retained");
  return "/api" + url.pathname + "?" + url.searchParams;
}
export function createCollectionUpdateStream(
  owner: CollectionUpdates,
  read: (
    context: Context,
    path: string,
    signal: AbortSignal,
  ) => Promise<Response>,
) {
  // Route-owner lifetime, never one allocation per historic session/query.
  let streams = 0;
  return (context: Context) => {
    let queries: string[];
    try {
      const raw: unknown = JSON.parse(context.req.query("queries") ?? "null");
      if (
        !Array.isArray(raw) ||
        !raw.length ||
        raw.length > 8 ||
        raw.some((q) => typeof q !== "string") ||
        new Set(raw).size !== raw.length
      )
        throw new Error("Invalid collection query set");
      queries = raw;
      for (const query of queries) collectionReadPath(query);
    } catch {
      return context.json({ error: "Invalid collection queries" }, 400);
    }
    const metadataFields = context.req.query("metadata") === "fields";
    if (streams >= 32)
      return context.json({ error: "Collection stream limit" }, 429);
    streams++;
    context.header("Cache-Control", "private, no-store");
    context.header("Content-Type", "application/x-ndjson");
    // Membership/grants are resolved by the canonical routes, not by this key.
    const credential = createHash("sha256")
      .update(
        JSON.stringify([
          context.req.header("host") ?? null,
          context.req.header("origin") ?? null,
          context.req.header("cookie") ?? null,
          context.req.header("authorization") ?? null,
          context.req.header("x-desktop-token") ?? null,
          context.req.query("desktop_token") ?? null,
          loginScope(context),
        ]),
      )
      .digest("hex");
    const audience = JSON.stringify([
      context.get(PRINCIPAL_VARIABLE) ?? { kind: "superuser" },
      credential,
    ]);
    return stream(context, async (output) => {
      const releases: Array<() => void> = [];
      const pending = new Map<string, string>();
      let pendingBytes = 0,
        writing = false,
        stopped = false;
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const stop = () => {
        if (stopped) return;
        stopped = true;
        for (const release of releases.splice(0)) release();
        pending.clear();
        pendingBytes = 0;
        finish();
      };
      output.onAbort(stop);
      context.req.raw.signal.addEventListener("abort", stop, { once: true });
      const drain = async () => {
        if (writing || stopped) return;
        writing = true;
        try {
          while (pending.size && !stopped) {
            const [key, text] = pending.entries().next().value!;
            pending.delete(key);
            pendingBytes -= Buffer.byteLength(text);
            await output.write(text);
          }
        } catch {
          stop();
        } finally {
          writing = false;
        }
      };
      const enqueue = (update: CollectionUpdate, snapshot: CollectionView) => {
        if (stopped) return;
        // A slow reader gets a replacement rather than an unbounded delta queue.
        const frame = pending.has(update.query)
          ? diffCollectionView(
              update.query,
              update.revision,
              undefined,
              snapshot,
            )!
          : update;
        const text = JSON.stringify(frame) + "\n";
        const old = pending.get(update.query);
        const bytes =
          pendingBytes -
          (old ? Buffer.byteLength(old) : 0) +
          Buffer.byteLength(text);
        if (bytes > 2 * 1024 ** 2) {
          stop();
          return;
        }
        pendingBytes = bytes;
        pending.set(update.query, text);
        void drain();
      };
      try {
        for (const query of queries) {
          releases.push(
            owner.retain(
              audience,
              query,
              async (signal) => {
                const response = await read(
                  context,
                  collectionReadPath(query),
                  signal,
                );
                if (!response.ok)
                  throw new Error("Collection canonical read refused");
                const body = (await response.json()) as Record<string, unknown>;
                if (
                  new URL(query, "http://collection.invalid").pathname ===
                  "/project-queue"
                    ? !Array.isArray(body.items)
                    : !body.catalog
                )
                  throw new Error("Retained collections unavailable");
                return body;
              },
              { send: enqueue, fail: stop },
              metadataFields,
            ),
          );
        }
        if (context.req.raw.signal.aborted) stop();
        await done;
      } finally {
        stop();
        streams--;
        context.req.raw.signal.removeEventListener("abort", stop);
      }
    });
  };
}
