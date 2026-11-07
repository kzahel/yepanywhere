import type { Context } from "hono";
import type { RefusedLaunch } from "../sessions/session-launch-outcome.js";

/**
 * The 503 a route answers for a refused launch. `context` names what the
 * request already made, such as a restart fork's new session.
 */
export function refusedLaunchResponse(
  c: Context,
  refused: RefusedLaunch,
  context: Record<string, unknown> = {},
): Response {
  return c.json(
    { error: refused.error, maxQueueSize: refused.maxQueueSize, ...context },
    503,
  );
}
