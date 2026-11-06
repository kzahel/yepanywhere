import { Hono } from "hono";
import { principalFor } from "../auth/limitedLaunchPolicy.js";
import { CoreApiError } from "../core-api/errors.js";
import type { SessionRelationshipRead } from "../sessions/session-relationship-read.js";

export function createSessionRelationshipRoutes(read: SessionRelationshipRead) {
  const routes = new Hono();
  routes.get(
    "/projects/:projectId/sessions/:sessionId/relationships",
    async (c) => {
      c.header("Cache-Control", "no-store");
      if (principalFor(c).kind !== "superuser")
        return c.json(
          {
            error: "Relationship provenance requires operator authority",
            code: "forbidden",
          },
          403,
        );
      try {
        return c.json(
          await read({
            sessionId: c.req.param("sessionId"),
            projectId: c.req.param("projectId"),
            query: c.req.query(),
            signal: c.req.raw.signal,
          }),
        );
      } catch (error) {
        if (!(error instanceof CoreApiError)) throw error;
        return c.json({ error: error.message, code: error.code }, error.status);
      }
    },
  );
  return routes;
}
