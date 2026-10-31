import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { CoreApiError } from "../core-api/errors.js";
import type { PeerAccessManager } from "./manager.js";
import { FleetError } from "../fleet/errors.js";
import { fleetPageQuery } from "../fleet/contracts.js";

/** Mount after normal host/CSRF/auth and acting-principal resolution. */
export function createPeerManagementRoutes(
  manager: PeerAccessManager,
  ownerProof: (context: Context) => Promise<boolean>,
  ownerBinding?: (context: Context) => string | null,
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
    if (error instanceof FleetError)
      return c.json(
        { error: { code: error.code, message: error.message } },
        error.status,
      );
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
  const boundOwner = async (c: Context) => {
    const binding = await ownerBinding?.(c);
    if (!binding)
      throw new FleetError(
        "forbidden",
        "A stable authenticated owner-session binding is required for OIDC enrollment",
        403,
      );
    return binding;
  };
  routes.get("/fleet/oidc/providers", async (c) =>
    c.json(await manager.fleetAccess.oidcProviders(c.req.raw.signal)),
  );
  routes.post("/fleet/oidc/start", async (c) =>
    c.json(
      await manager.fleetAccess.startOidc(
        await c.req.json(),
        await boundOwner(c),
        c.req.raw.signal,
      ),
    ),
  );
  routes.get("/fleet/oidc/:id", async (c) =>
    c.json(
      await manager.fleetAccess.oidcStatus(
        c.req.param("id"),
        await boundOwner(c),
        c.req.raw.signal,
      ),
    ),
  );
  routes.post("/fleet/oidc/:id/complete", async (c) => {
    const owner = await boundOwner(c),
      input = await c.req.json();
    const assertOwner = () => {
      c.req.raw.signal.throwIfAborted();
      if (ownerBinding?.(c) !== owner)
        throw new FleetError(
          "owner_session_changed",
          "The initiating owner session is no longer valid",
          403,
        );
    };
    return c.json(
      await manager.fleetAccess.completeOidc(
        c.req.param("id"),
        owner,
        input,
        assertOwner,
        c.req.raw.signal,
      ),
    );
  });

  routes.put("/fleet", async (c) => {
    await manager.fleetAccess.configure(await c.req.json());
    return c.json(manager.publicState().fleet);
  });
  routes.post("/fleet/login", async (c) =>
    c.json(
      await manager.fleetAccess.login(await c.req.json(), c.req.raw.signal),
    ),
  );
  routes.delete("/fleet", async (c) =>
    c.json(await manager.fleetAccess.disconnect()),
  );
  const page = (query: unknown) => {
    const parsed = fleetPageQuery.parse(query);
    return `cursor=${parsed.cursor}&limit=${parsed.limit}`;
  };
  routes.get("/fleet/clients", async (c) =>
    c.json(
      await manager.fleetAccess.request(
        `/clients?${page(c.req.query())}`,
        "GET",
        undefined,
        c.req.raw.signal,
      ),
    ),
  );
  routes.get("/fleet/clients/:id", async (c) =>
    c.json(
      await manager.fleetAccess.introduce(
        z.uuid().parse(c.req.param("id")),
        c.req.raw.signal,
      ),
    ),
  );
  routes.get("/fleet/relationships", async (c) =>
    c.json(
      await manager.fleetAccess.request(
        `/relationships?${page(c.req.query())}`,
        "GET",
        undefined,
        c.req.raw.signal,
      ),
    ),
  );
  routes.get("/fleet/relationships/:id", async (c) =>
    c.json(
      await manager.fleetAccess.request(
        `/relationships/${z.uuid().parse(c.req.param("id"))}`,
        "GET",
        undefined,
        c.req.raw.signal,
      ),
    ),
  );
  routes.post("/fleet/relationships", async (c) =>
    c.json(
      await manager.fleetAccess.propose(await c.req.json(), c.req.raw.signal),
      201,
    ),
  );
  routes.delete("/fleet/relationships/:id", async (c) =>
    c.json(
      await manager.fleetAccess.revokeRelationship(
        z.uuid().parse(c.req.param("id")),
        c.req.raw.signal,
      ),
    ),
  );
  routes.post("/fleet/accept", async (c) =>
    c.json(
      await manager.fleetAccess.accept(await c.req.json(), c.req.raw.signal),
      201,
    ),
  );
  routes.post("/fleet/deliver/:id", async (c) =>
    c.json(
      await manager.fleetAccess.deliver(
        z.uuid().parse(c.req.param("id")),
        c.req.raw.signal,
      ),
    ),
  );
  routes.get("/fleet/mailbox", async (c) =>
    c.json(
      await manager.fleetAccess.request(
        `/mailbox?${page(c.req.query())}`,
        "GET",
        undefined,
        c.req.raw.signal,
      ),
    ),
  );
  routes.post("/fleet/adopt", async (c) =>
    c.json(
      await manager.fleetAccess.adopt(await c.req.json(), c.req.raw.signal),
    ),
  );
  routes.post("/outgoing/:id/select", async (c) => {
    const input = z
      .object({ credentialId: z.uuid() })
      .strict()
      .parse(await c.req.json());
    await manager.fleetAccess.select(c.req.param("id"), input.credentialId);
    return c.body(null, 204);
  });
  routes.delete("/outgoing/:id/credentials/:credentialId", async (c) => {
    await manager.fleetAccess.removeOutgoing(
      c.req.param("id"),
      c.req.param("credentialId"),
    );
    return c.body(null, 204);
  });
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
