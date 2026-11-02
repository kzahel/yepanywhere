import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { CoreApiError } from "../core-api/errors.js";
import type { PeerAccessManager } from "./manager.js";
import { IdentityServiceError } from "../identity-service/errors.js";
import { PeerConnections } from "./connections.js";
import { peerHostSchema, recordPeerAudit } from "./connection-contracts.js";
import { outgoingPeerRequest } from "./state.js";
import { identityServicePageQuery } from "../identity-service/contracts.js";

/** Mount after normal host/CSRF/auth and acting-principal resolution. */
export function createPeerManagementRoutes(
  manager: PeerAccessManager,
  ownerProof: (context: Context) => Promise<boolean>,
  ownerBinding?: (context: Context) => string | null,
  endOwnerSession?: (context: Context) => Promise<void>,
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
    // The settings transport expects a human-readable error string. Preserve
    // the older manual/fleet API's structured error contract outside this pane.
    if (c.req.path.includes("/connections")) {
      if (
        error instanceof CoreApiError ||
        error instanceof IdentityServiceError
      )
        return c.json({ error: error.message, code: error.code }, error.status);
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return c.json(
          {
            error: "Invalid server connection request",
            code: "invalid_request",
          },
          400,
        );
      return c.json(
        {
          error:
            "The change could not be confirmed; inspect both servers before retrying",
          code: "peer_state_unavailable",
        },
        503,
      );
    }
    if (error instanceof IdentityServiceError)
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
  const connections = new PeerConnections(manager);
  const liveOwner = (c: Context) => {
    const binding = ownerBinding?.(c);
    if (!binding)
      throw new CoreApiError(
        "forbidden",
        "A live authenticated owner session is required",
        403,
      );
    return () => {
      c.req.raw.signal.throwIfAborted();
      if (ownerBinding?.(c) !== binding)
        throw new CoreApiError(
          "forbidden",
          "The initiating owner session ended",
          403,
        );
    };
  };
  routes.get("/connections", (c) => {
    const query = z
      .object({
        cursor: z.coerce.number().int().min(0).max(128).default(0),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      })
      .parse(c.req.query());
    return c.json(connections.overview(query.cursor, query.limit));
  });
  routes.get("/connections/bootstrap", (c) =>
    c.json(
      connections.bootstrap(z.uuid().parse(c.req.query("sourceServerId"))),
    ),
  );
  routes.delete("/connections/owner-session", async (c) => {
    if (!endOwnerSession)
      throw new CoreApiError(
        "peer_unsupported",
        "Owner session cleanup is unavailable",
        501,
      );
    await endOwnerSession(c);
    return c.json({ success: true });
  });
  routes.put("/connections/enabled", async (c) => {
    const { enabled } = z
      .object({ enabled: z.boolean() })
      .strict()
      .parse(await c.req.json());
    await manager.setEnabled(enabled, liveOwner(c));
    return c.json(connections.overview());
  });
  routes.put("/connections/agent-access", async (c) => {
    const { enabled } = z
      .object({ enabled: z.boolean() })
      .strict()
      .parse(await c.req.json());
    await manager.setAgentAccess({ enabled }, liveOwner(c));
    return c.json({ success: true });
  });
  routes.post("/connections/connect", async (c) =>
    c.json(
      await connections.connect(
        await c.req.json(),
        liveOwner(c),
        c.req.raw.signal,
      ),
    ),
  );
  routes.post("/connections/grant", async (c) =>
    c.json(
      await connections.grant(
        await c.req.json(),
        liveOwner(c),
        c.req.raw.signal,
      ),
      201,
    ),
  );
  routes.post("/connections/prepare", async (c) => {
    const { expectedPolicyRevision } = z
        .object({ expectedPolicyRevision: z.number().int().nonnegative() })
        .strict()
        .parse(await c.req.json()),
      owner = liveOwner(c);
    const check = () => {
      owner();
      if (manager.store.currentRevision() !== expectedPolicyRevision)
        throw new CoreApiError(
          "peer_record_conflict",
          "The target policy changed since inspection",
          409,
        );
    };
    check();
    let revision = expectedPolicyRevision;
    if (!manager.isEnabled()) {
      await manager.setEnabled(true, check);
      revision++;
    }
    owner();
    if (manager.store.currentRevision() !== revision)
      throw new CoreApiError(
        "peer_record_conflict",
        "The target policy changed during enablement",
        409,
      );
    return c.json({ policyRevision: revision });
  });
  routes.post("/connections/import", async (c) => {
    const schema = outgoingPeerRequest
      .extend({
        identity: peerHostSchema,
        operationId: z.uuid(),
        expectedPolicyRevision: z.number().int().nonnegative(),
      })
      .strict();
    const { identity, operationId, expectedPolicyRevision, ...input } =
      schema.parse(await c.req.json());
    if (identity.serverId !== input.invitation.targetServerId)
      throw new CoreApiError(
        "peer_identity_mismatch",
        "Peer identity differs from invitation",
        502,
      );
    const selected = manager.store.read().selected[identity.serverId];
    const existing = manager.store
      .read()
      .outgoing.find(
        (p) =>
          p.invitation.targetServerId === identity.serverId &&
          p.origin === "manual",
      );
    if (selected && selected !== existing?.invitation.credentialId)
      throw new CoreApiError(
        "peer_record_conflict",
        "An identity service credential is already selected; inspect credential selection before importing trusted control",
        409,
      );
    const owner = liveOwner(c);
    const guard = () => {
      owner();
      if (manager.store.currentRevision() !== expectedPolicyRevision)
        throw new CoreApiError(
          "peer_record_conflict",
          "The target policy changed since inspection",
          409,
        );
      const selected = manager.store.read().selected[identity.serverId];
      const manual = manager.store
        .read()
        .outgoing.find(
          (p) =>
            p.invitation.targetServerId === identity.serverId &&
            p.origin === "manual",
        );
      if (selected && selected !== manual?.invitation.credentialId)
        throw new CoreApiError(
          "peer_record_conflict",
          "A different credential is selected",
          409,
        );
    };
    guard();
    if (!manager.isEnabled())
      throw new CoreApiError(
        "forbidden",
        "Server connections are disabled",
        403,
      );
    await manager.importOutgoing(
      {
        ...input,
        ...(existing
          ? {
              operations: existing.operations,
              allowAgentSessions: existing.allowAgentSessions,
            }
          : {}),
      },
      c.req.raw.signal,
      guard,
      identity,
      undefined,
      operationId,
    );
    return c.json({ success: true });
  });
  routes.post("/connections/:id/test", async (c) => {
    await connections.test(
      z.uuid().parse(c.req.param("id")),
      liveOwner(c),
      c.req.raw.signal,
    );
    return c.json({ success: true });
  });
  routes.patch("/connections/:id", async (c) => {
    const id = z.uuid().parse(c.req.param("id")),
      { label } = z
        .object({ label: z.string().trim().min(1).max(128) })
        .strict()
        .parse(await c.req.json()),
      guard = liveOwner(c);
    await manager.store.mutate((next) => {
      guard();
      const metadata = next.connections?.find((p) => p.serverId === id);
      if (!metadata)
        throw new CoreApiError(
          "server_not_found",
          "Peer identity not found",
          404,
        );
      metadata.label = label;
      metadata.updatedAt = new Date().toISOString();
      recordPeerAudit(next, "label-changed", id, manager.serverId);
    });
    return c.json({ success: true });
  });
  routes.get("/connections/:id/activity", (c) =>
    c.json(manager.connectionActivity(z.uuid().parse(c.req.param("id")))),
  );
  routes.delete(
    "/connections/:id/:direction/:credentialId/:generation",
    async (c) => {
      await connections.remove(
        z.uuid().parse(c.req.param("id")),
        z.enum(["incoming", "outgoing"]).parse(c.req.param("direction")),
        z.uuid().parse(c.req.param("credentialId")),
        z.coerce.number().int().positive().parse(c.req.param("generation")),
        liveOwner(c),
      );
      return c.json({ success: true });
    },
  );

  const boundOwner = async (c: Context) => {
    const binding = await ownerBinding?.(c);
    if (!binding)
      throw new IdentityServiceError(
        "forbidden",
        "A stable authenticated owner-session binding is required for OIDC enrollment",
        403,
      );
    return binding;
  };
  routes.get("/identity-service/oidc/providers", async (c) =>
    c.json(await manager.delegatedAccess.oidcProviders(c.req.raw.signal)),
  );
  routes.post("/identity-service/oidc/start", async (c) =>
    c.json(
      await manager.delegatedAccess.startOidc(
        await c.req.json(),
        await boundOwner(c),
        c.req.raw.signal,
      ),
    ),
  );
  routes.get("/identity-service/oidc/:id", async (c) =>
    c.json(
      await manager.delegatedAccess.oidcStatus(
        c.req.param("id"),
        await boundOwner(c),
        c.req.raw.signal,
      ),
    ),
  );
  routes.post("/identity-service/oidc/:id/complete", async (c) => {
    const owner = await boundOwner(c),
      input = await c.req.json();
    const assertOwner = () => {
      c.req.raw.signal.throwIfAborted();
      if (ownerBinding?.(c) !== owner)
        throw new IdentityServiceError(
          "owner_session_changed",
          "The initiating owner session is no longer valid",
          403,
        );
    };
    return c.json(
      await manager.delegatedAccess.completeOidc(
        c.req.param("id"),
        owner,
        input,
        assertOwner,
        c.req.raw.signal,
      ),
    );
  });

  routes.put("/identity-service", async (c) => {
    await manager.delegatedAccess.configure(await c.req.json());
    return c.json(manager.publicState().fleet);
  });
  routes.post("/identity-service/login", async (c) =>
    c.json(
      await manager.delegatedAccess.login(await c.req.json(), c.req.raw.signal),
    ),
  );
  routes.delete("/identity-service", async (c) =>
    c.json(await manager.delegatedAccess.disconnect()),
  );
  const page = (query: unknown) => {
    const parsed = identityServicePageQuery.parse(query);
    return `cursor=${parsed.cursor}&limit=${parsed.limit}`;
  };
  routes.get("/identity-service/clients", async (c) =>
    c.json(
      await manager.delegatedAccess.request(
        `/clients?${page(c.req.query())}`,
        "GET",
        undefined,
        c.req.raw.signal,
      ),
    ),
  );
  routes.get("/identity-service/clients/:id", async (c) =>
    c.json(
      await manager.delegatedAccess.introduce(
        z.uuid().parse(c.req.param("id")),
        c.req.raw.signal,
      ),
    ),
  );
  routes.get("/identity-service/relationships", async (c) =>
    c.json(
      await manager.delegatedAccess.request(
        `/relationships?${page(c.req.query())}`,
        "GET",
        undefined,
        c.req.raw.signal,
      ),
    ),
  );
  routes.get("/identity-service/relationships/:id", async (c) =>
    c.json(
      await manager.delegatedAccess.request(
        `/relationships/${z.uuid().parse(c.req.param("id"))}`,
        "GET",
        undefined,
        c.req.raw.signal,
      ),
    ),
  );
  routes.post("/identity-service/relationships", async (c) =>
    c.json(
      await manager.delegatedAccess.propose(
        await c.req.json(),
        c.req.raw.signal,
      ),
      201,
    ),
  );
  routes.delete("/identity-service/relationships/:id", async (c) =>
    c.json(
      await manager.delegatedAccess.revokeRelationship(
        z.uuid().parse(c.req.param("id")),
        c.req.raw.signal,
      ),
    ),
  );
  routes.post("/identity-service/accept", async (c) =>
    c.json(
      await manager.delegatedAccess.accept(
        await c.req.json(),
        c.req.raw.signal,
      ),
      201,
    ),
  );
  routes.post("/identity-service/deliver/:id", async (c) =>
    c.json(
      await manager.delegatedAccess.deliver(
        z.uuid().parse(c.req.param("id")),
        c.req.raw.signal,
      ),
    ),
  );
  routes.get("/identity-service/mailbox", async (c) =>
    c.json(
      await manager.delegatedAccess.request(
        `/mailbox?${page(c.req.query())}`,
        "GET",
        undefined,
        c.req.raw.signal,
      ),
    ),
  );
  routes.post("/identity-service/adopt", async (c) =>
    c.json(
      await manager.delegatedAccess.adopt(await c.req.json(), c.req.raw.signal),
    ),
  );
  routes.post("/outgoing/:id/select", async (c) => {
    const input = z
      .object({ credentialId: z.uuid() })
      .strict()
      .parse(await c.req.json());
    await manager.delegatedAccess.select(c.req.param("id"), input.credentialId);
    return c.body(null, 204);
  });
  routes.delete("/outgoing/:id/credentials/:credentialId", async (c) => {
    await manager.delegatedAccess.removeOutgoing(
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
