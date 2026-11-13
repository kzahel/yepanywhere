import {
  httpReplySchema,
  RECEIPT_HEADER,
} from "../../core-api/http-contracts.js";
import { receiptBindingSchema } from "../../core-api/command-contracts.js";
import { bodyLimit } from "hono/body-limit";
import { Hono, type Context } from "hono";
import { PRINCIPAL_VARIABLE } from "../../auth/principal.js";
import type { ApiPrincipal } from "../../core-api/peer-policy.js";
import {
  operations,
  operationMethod,
  API_LAUNCH_VARIABLE,
  API_SIGNAL_VARIABLE,
  API_OWNER_VARIABLE,
  type ApiLaunchContext,
} from "../../core-api/contracts.js";
import { type CoreApi, CoreApiError } from "../../core-api/service.js";

/** Mount after the hosting app's authentication and principal resolution. */
export function createV0Routes(
  api: {
    read(...args: Parameters<CoreApi["read"]>): Promise<unknown>;
  },
  readBody?: (request: Request, caller: ApiPrincipal) => Promise<unknown>,
) {
  const routes = new Hono<{
    Variables: {
      yaPrincipal: ApiPrincipal;
      yaApiLaunch: ApiLaunchContext;
      yaApiSignal: AbortSignal;
      yaApiOwnerAuthenticated: true;
    };
  }>();
  routes.use("*", async (c, next) => {
    if (!c.get(PRINCIPAL_VARIABLE))
      return c.json(
        { error: { code: "unauthorized", message: "Authentication required" } },
        401,
      );
    c.header("Cache-Control", "no-store");
    await next();
  });
  routes.onError((error, c) => {
    if (error instanceof CoreApiError) {
      if (error.code === "controller_unavailable")
        c.header("Connection", "close");
      return c.json(
        { error: { code: error.code, message: error.message } },
        error.status,
      );
    }
    return c.json(
      { error: { code: "internal_error", message: "API read failed" } },
      500,
    );
  });
  if (!readBody)
    routes.use(
      "*",
      bodyLimit({
        maxSize: 256 * 1024,
        onError: (c) =>
          c.json(
            {
              error: {
                code: "invalid_request",
                message: "API request body exceeds 256 KiB",
              },
            },
            400,
          ),
      }),
    );
  const handle = async (
    c: Context<{
      Variables: {
        yaPrincipal: ApiPrincipal;
        yaApiLaunch: ApiLaunchContext;
        yaApiSignal: AbortSignal;
        yaApiOwnerAuthenticated: true;
      };
    }>,
    operation?: (typeof operations)[number],
  ) => {
    const url = new URL(c.req.url);
    const method = c.req.method;
    if (method !== "GET" && method !== "POST")
      throw new CoreApiError("not_found", "Unknown v0 resource", 404);
    let text: string | undefined;
    if (method === "POST") {
      const raw = readBody
        ? await readBody(c.req.raw, c.get(PRINCIPAL_VARIABLE))
        : await c.req.text();
      text = typeof raw === "string" ? raw : JSON.stringify(raw);
    }
    const serverId =
      c.req.param("serverId") ??
      url.pathname.match(/^\/v0\/servers\/([^/]+)/)?.[1];
    const result = await api.read(
      operation?.id ?? "server",
      c.get(PRINCIPAL_VARIABLE),
      {
        serverId: serverId ? decodeURIComponent(serverId) : undefined,
        sessionId: c.req.param("sessionId"),
        receiptId: c.req.param("receiptId"),
        pendingRequestId: c.req.param("requestId"),
        query: c.req.query(),
        http: {
          method,
          ...(c.req.header("Content-Type")
            ? { contentType: c.req.header("Content-Type") }
            : {}),
          path: `${url.pathname}${url.search}`,
          ...(text !== undefined ? { body: text } : {}),
          ...(c.req.header("Idempotency-Key")
            ? { key: c.req.header("Idempotency-Key") }
            : {}),
        },
        ...(!operation ? { unknownRoute: true } : {}),
        signal: c.get(API_SIGNAL_VARIABLE) ?? c.req.raw.signal,
        launch: c.get(API_LAUNCH_VARIABLE),
        ...(c.get(API_OWNER_VARIABLE)
          ? { ownerAuthenticated: true as const }
          : {}),
      },
    );
    const forwarded = httpReplySchema.safeParse(result);
    if (forwarded.success)
      return new Response(
        [204, 205, 304].includes(forwarded.data.status)
          ? null
          : forwarded.data.body,
        {
          status: forwarded.data.status,
          // A raw Response bypasses the context headers set above, and the
          // receiving server owns caching policy whatever the target sent.
          headers: { ...forwarded.data.headers, "Cache-Control": "no-store" },
        },
      );
    const possible = result as { receipt?: unknown; creation?: unknown };
    const binding = receiptBindingSchema.safeParse(
      possible?.receipt ?? possible?.creation ?? result,
    );
    if (binding.success)
      c.header(
        RECEIPT_HEADER,
        Buffer.from(JSON.stringify(binding.data)).toString("base64url"),
      );
    if (operation?.id === "help" || operation?.id === "targetHelp")
      return c.body(result as string, 200, {
        "Content-Type": "text/markdown; charset=utf-8",
      });
    return c.json(result, method === "POST" ? 202 : 200);
  };
  for (const operation of operations)
    routes.on(operationMethod(operation), operation.path || "/", (c) =>
      handle(c, operation),
    );
  routes.all("*", (c) => handle(c));
  return routes;
}
