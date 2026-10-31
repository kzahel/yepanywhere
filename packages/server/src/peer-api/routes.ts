import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { CoreApiError } from "../core-api/errors.js";
import type { PeerAccessManager } from "./manager.js";

/** Mount after normal host/CSRF/auth and acting-principal resolution. */
export function createPeerManagementRoutes(
  manager: PeerAccessManager,
  ownerProof: (context: Context) => Promise<boolean>,
) {
  const routes = new Hono();
  routes.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!(await ownerProof(c)))
      return c.json(
        {
          error: {
            code: "forbidden",
            message:
              "Authenticated owner proof is required for peer administration",
          },
        },
        403,
      );
    await next();
  });
  routes.use(
    "*",
    bodyLimit({
      maxSize: 256 * 1024,
      onError: (c) =>
        c.json(
          {
            error: {
              code: "invalid_request",
              message: "Peer administration body exceeds 256 KiB",
            },
          },
          400,
        ),
    }),
  );
  routes.onError((error, c) => {
    if (error instanceof CoreApiError)
      return c.json(
        { error: { code: error.code, message: error.message } },
        error.status,
      );
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return c.json(
        {
          error: {
            code: "invalid_request",
            message: "Invalid peer administration request",
          },
        },
        400,
      );
    return c.json(
      {
        error: {
          code: "peer_state_unavailable",
          message:
            "Peer administration failed; inspect nonsecret state before retrying",
        },
      },
      503,
    );
  });
  routes.get("/", (c) => c.json(manager.publicState()));
  routes.post("/incoming", async (c) =>
    c.json(
      await manager.issue(await c.req.json(), undefined, c.req.raw.signal),
      201,
    ),
  );
  routes.post("/incoming/:id/rotate", async (c) =>
    c.json(
      await manager.issue(
        await c.req.json(),
        z.uuid().parse(c.req.param("id")),
        c.req.raw.signal,
      ),
      201,
    ),
  );
  routes.delete("/incoming/:id", async (c) => {
    await manager.store.revokeIncoming(z.uuid().parse(c.req.param("id")));
    return c.body(null, 204);
  });
  routes.post("/outgoing", async (c) => {
    await manager.importOutgoing(await c.req.json(), c.req.raw.signal);
    return c.body(null, 204);
  });
  routes.delete("/outgoing/:id", async (c) => {
    await manager.store.revokeOutgoing(z.uuid().parse(c.req.param("id")));
    return c.body(null, 204);
  });
  routes.put("/relay", async (c) => {
    await manager.store.configureRelay(await c.req.json());
    return c.body(null, 204);
  });
  routes.delete("/relay", async (c) => {
    await manager.store.removeRelay();
    return c.body(null, 204);
  });
  routes.put("/agent-access", async (c) => {
    await manager.setAgentAccess(await c.req.json());
    return c.body(null, 204);
  });
  return routes;
}
