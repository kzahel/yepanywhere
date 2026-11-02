import { Hono } from "hono";
import type { ApiPrincipal } from "../core-api/peer-policy.js";
import { type CoreApi, CoreApiError } from "../core-api/service.js";
import { PRINCIPAL_VARIABLE } from "../auth/principal.js";
import { createV0Routes } from "../routes/v0/index.js";
import {
  peerAttestation,
  type PeerDirectory,
  type IncomingPeerGrant,
  type PeerRequestAuthority,
} from "./directory.js";

export const PEER_SRP_CONTEXT = Symbol("verified-peer-srp-context");
export interface PeerSrpContext {
  credentialId: string;
  generation: number;
  protocol?: "peer-v0" | "peer-v1";
}

/** A revoked or disconnected caller cannot pin an admission slot with a body. */
async function readPeerBody(request: Request, caller: ApiPrincipal) {
  if (caller.kind !== "peer")
    throw new CoreApiError("unauthorized", "Peer authentication required", 401);
  const signal = AbortSignal.any([
    caller.signal,
    request.signal,
    AbortSignal.timeout(10_000),
  ]);
  const reader = request.body?.getReader();
  if (!reader)
    throw new CoreApiError("invalid_request", "Expected JSON body", 400);
  let aborted!: () => void;
  const interruption = new Promise<never>((_resolve, reject) => {
    aborted = () =>
      reject(
        new CoreApiError(
          "controller_unavailable",
          "Peer body acquisition was cancelled or timed out",
          503,
        ),
      );
    signal.addEventListener("abort", aborted, { once: true });
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (signal.aborted) aborted();
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), interruption]);
      if (done) break;
      size += value.byteLength;
      if (size > 256 * 1024)
        throw new CoreApiError(
          "invalid_request",
          "API request body exceeds 256 KiB",
          400,
        );
      chunks.push(value);
    }
    caller.assertActive();
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    signal.removeEventListener("abort", aborted);
    // A malicious stream's cancel promise must not keep its slot alive either.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
    caller.assertActive();
  }
}

/** Isolated v0-only receiving adapter; never mount this authenticator on /api. */
export function createPeerReceiver(
  api: CoreApi,
  directory: PeerDirectory,
  options: {
    requireSrp?: boolean;
    authentication?: (
      request: Request,
      context: PeerSrpContext,
    ) => Promise<unknown>;
    identityServiceAuthority?: (
      grant: IncomingPeerGrant,
      token: string,
      signal: AbortSignal,
    ) => Promise<PeerRequestAuthority>;
  } = {},
) {
  const app = new Hono<{
    Bindings: { [PEER_SRP_CONTEXT]?: PeerSrpContext };
    Variables: { yaPrincipal: ApiPrincipal };
  }>();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-YA-Server-ID", api.serverId);
    await next();
  });
  // Public identity is not a grant or a cryptographic proof. HTTPS/SRP binds its route.
  app.get("/peer/id", (c) => c.json({ serverId: api.serverId }));
  for (const path of ["/peer/v1/auth/identity", "/peer/v1/auth/refresh"]) {
    app.all(path, async (c) => {
      try {
        const context = c.env?.[PEER_SRP_CONTEXT];
        if (
          c.req.header("Origin") ||
          !context ||
          context.protocol !== "peer-v1" ||
          !options.authentication
        )
          throw new CoreApiError(
            "unauthorized",
            "Verified peer-v1 context required",
            401,
          );
        return c.json(await options.authentication(c.req.raw, context));
      } catch (error) {
        const failure =
          error instanceof CoreApiError
            ? error
            : new CoreApiError(
                "invalid_request",
                "Invalid authentication request",
                400,
              );
        return c.json(
          { error: { code: failure.code, message: failure.message } },
          failure.status,
        );
      }
    });
  }
  app.use("/v0/*", async (c, next) => {
    if (c.req.header("Origin"))
      return c.json(
        {
          error: {
            code: "forbidden",
            message: "Browser origins are not accepted",
          },
        },
        403,
      );
    let acquired: ReturnType<PeerDirectory["authenticate"]> | undefined;
    try {
      const expected = c.env?.[PEER_SRP_CONTEXT];
      if (options.requireSrp && !expected)
        throw new CoreApiError(
          "unauthorized",
          "An authenticated peer SRP handoff is required",
          401,
        );
      const authorization = c.req.header("Authorization") ?? "";
      const encoded = c.req.header("X-YA-Peer-Context");
      if (encoded && encoded.length > 2048)
        throw new CoreApiError("invalid_request", "Invalid peer context", 400);
      if (!authorization.startsWith("Bearer ") || authorization.length > 256)
        throw new CoreApiError(
          "unauthorized",
          "Peer authentication required",
          401,
        );
      const attestation = peerAttestation.parse(
        encoded && encoded.length <= 2048
          ? JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
          : { sessionId: null, launchId: null },
      );
      const grant = directory.lookup(authorization.slice(7));
      let authority: PeerRequestAuthority | undefined;
      if (grant?.identityBinding) {
        const token = c.req.header("X-YA-Fleet-Grant");
        if (
          !token ||
          token.length > 32 * 1024 ||
          !options.identityServiceAuthority
        )
          throw new CoreApiError(
            "unauthorized",
            "An identity service grant token is required",
            401,
          );
        authority = await options.identityServiceAuthority(
          grant,
          token,
          c.req.raw.signal,
        );
      }
      acquired = directory.authenticate(
        authorization.slice(7),
        attestation,
        authority,
      );
      if (
        expected &&
        (acquired.principal.credentialId !== expected.credentialId ||
          acquired.principal.credentialGeneration !== expected.generation)
      )
        throw new CoreApiError(
          "unauthorized",
          "Peer transport and credential generation do not match",
          401,
        );
      c.set(PRINCIPAL_VARIABLE, acquired.principal);
      await next();
      acquired.principal.assertActive();
    } catch (error) {
      if (error instanceof CoreApiError)
        return c.json(
          { error: { code: error.code, message: error.message } },
          error.status,
        );
      return c.json(
        { error: { code: "invalid_request", message: "Invalid peer context" } },
        400,
      );
    } finally {
      acquired?.release();
    }
  });
  app.route("/v0", createV0Routes(api, readPeerBody));
  return app;
}
