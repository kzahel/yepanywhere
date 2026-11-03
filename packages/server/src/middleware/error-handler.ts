import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { getLogger } from "../logging/logger.js";
import { RouterUnavailable } from "../services/AgentAuthRouter.js";

/**
 * An error that names its own HTTP response status. Throw it from a service
 * when the failure maps to a specific status (e.g. 503 while a service is not
 * yet initialized). Foreign statusCode-bearing errors (e.g. web-push upstream
 * failures) are reported in the body but do not drive the response status.
 */
export class HttpError extends Error {
  readonly status: ContentfulStatusCode;

  constructor(status: ContentfulStatusCode, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/**
 * App-wide Hono error handler: an unhandled throw in any route returns
 * structured JSON `{ error, statusCode? }` instead of an opaque empty 500
 * the client cannot diagnose (kzahel/yepanywhere#84). Hono routes a sub-app's
 * thrown errors to the mounted app's handler, so installing this on the root
 * app covers every route group; a sub-app exercised by direct-request tests
 * installs the same handler itself.
 */
function redactRequestPath(path: string): string {
  return path.replace(/(\/public-api\/shares\/)[^/]+/g, "$1[redacted]");
}

export function structuredErrorHandler(error: Error, c: Context): Response {
  // A router refusal is recoverable session feedback, not a YA login failure
  // or an unexpected server fault. Messages are generated locally, never
  // copied from provider responses or socket/filesystem errors; at most they
  // quote a short plain-text 4xx reason from the verified router socket or
  // the session's saved account label.
  if (error instanceof RouterUnavailable) {
    getLogger().warn(
      {
        event: "agent_auth_router_refused",
        method: c.req.method,
        path: redactRequestPath(c.req.path),
        routerStatus: error.status,
        code: error.code,
        loginRequired: error.loginRequired,
        error: error.message,
      },
      "Agent Auth Router refused the request",
    );
    return c.json({ error: error.message }, 409);
  }
  if (error instanceof HTTPException) {
    return error.getResponse();
  }
  const message = error.message || String(error);
  console.error(
    `[API] ${c.req.method} ${redactRequestPath(c.req.path)} error:`,
    message,
  );
  if (error instanceof HttpError) {
    return c.json({ error: message }, error.status);
  }
  const rawStatus = (error as { statusCode?: unknown }).statusCode;
  const statusCode = typeof rawStatus === "number" ? rawStatus : undefined;
  return c.json(
    { error: message, ...(statusCode !== undefined ? { statusCode } : {}) },
    500,
  );
}
