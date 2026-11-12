import { NEW_SESSION_BOOTSTRAP, type RelayRequest } from "@yep-anywhere/shared";
import { getPath } from "hono/utils/url";
import { internalWsRequestEnv } from "./ws-internal-request-env.js";
import type { AuthenticatedSrpTransportContext } from "../middleware/authenticated-transport.js";

// Only pending collection headers, <=32 per logical connection. Retired on
// response admission or connection teardown; ordinary mutations are untouched.
const acquiring = new WeakMap<object, Set<AbortController>>();

export function abortCollections(connection: object): void {
  for (const controller of acquiring.get(connection) ?? []) controller.abort();
  acquiring.delete(connection);
}

export function dropClosedBody(
  connection: { cleanupStarted: boolean },
  body: ReadableStream<Uint8Array>,
): boolean {
  if (!connection.cleanupStarted) return false;
  void body.cancel().catch(() => {});
  return true;
}

function collectionPath(path: string): boolean {
  return (
    getPath(new Request(new URL(path, "http://relay.invalid"))) ===
    "/api/activity/collections"
  );
}

/** Never start an endless producer on a tunnel that would buffer it to EOF. */
export async function dispatchRelay(
  request: RelayRequest,
  fetchRequest: Request,
  srpTransport: AuthenticatedSrpTransportContext | null,
  app: {
    fetch(
      request: Request,
      env?: Record<symbol, unknown>,
    ): Response | Promise<Response>;
  },
  connection: Parameters<typeof internalWsRequestEnv>[0] & {
    cleanupStarted: boolean;
  },
  canStream: boolean,
): Promise<Response> {
  const env = internalWsRequestEnv(connection, srpTransport);
  if (!collectionPath(request.path)) return app.fetch(fetchRequest, env);
  const refused = () =>
    Response.json(
      { error: "Collection response streaming unavailable" },
      { status: 503 },
    );
  if (
    !canStream ||
    connection.cleanupStarted ||
    (request.stream !== true && request.stream !== "connection")
  )
    return refused();
  let pending = acquiring.get(connection);
  if (!pending) {
    pending = new Set();
    acquiring.set(connection, pending);
  }
  if (pending.size >= 32) return refused();
  const controller = new AbortController();
  pending.add(controller);
  try {
    const response = await app.fetch(
      new Request(fetchRequest, { signal: controller.signal }),
      env,
    );
    if (controller.signal.aborted || connection.cleanupStarted) {
      await response.body?.cancel().catch(() => {});
      return refused();
    }
    return response;
  } catch (error) {
    if (controller.signal.aborted) return refused();
    throw error;
  } finally {
    pending.delete(controller);
    if (!pending.size) acquiring.delete(connection);
  }
}

/** File/bootstrap policy plus the explicitly bounded live collection route. */
export function relayStreamBody(
  request: RelayRequest,
  response: Response,
  encrypted: boolean,
  binaryResponse: boolean,
): ReadableStream<Uint8Array> | null {
  if (
    (request.stream !== true && request.stream !== "connection") ||
    !encrypted ||
    !response.ok
  )
    return null;
  const url = new URL(request.path, "http://relay.invalid");
  const contentType = response.headers.get("Content-Type") ?? "";
  const bootstrap =
    url.pathname === "/api/settings" &&
    url.searchParams.get("bootstrap") === NEW_SESSION_BOOTSTRAP &&
    contentType.startsWith("text/event-stream");
  const collection =
    collectionPath(request.path) &&
    contentType.startsWith("application/x-ndjson");
  return binaryResponse || bootstrap || collection ? response.body : null;
}
