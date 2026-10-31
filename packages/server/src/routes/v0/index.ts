import { bodyLimit } from "hono/body-limit";
import { Hono } from "hono";
import { PRINCIPAL_VARIABLE } from "../../auth/principal.js";
import type { ApiPrincipal } from "../../core-api/peer-policy.js";
import {
  operations,
  operationMethod,
  API_LAUNCH_VARIABLE,
  API_SIGNAL_VARIABLE,
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
  for (const operation of operations) {
    routes.on(operationMethod(operation), operation.path || "/", async (c) => {
      let body: unknown;
      if (operationMethod(operation) === "POST") {
        try {
          body = readBody
            ? await readBody(c.req.raw, c.get(PRINCIPAL_VARIABLE))
            : await c.req.json();
        } catch (error) {
          if (error instanceof CoreApiError) throw error;
          throw new CoreApiError(
            "invalid_request",
            "Expected a JSON request body",
            400,
          );
        }
      }
      const result = await api.read(
        operation.id,
        c.get(PRINCIPAL_VARIABLE) as ApiPrincipal,
        {
          serverId: c.req.param("serverId"),
          sessionId: c.req.param("sessionId"),
          receiptId: c.req.param("receiptId"),
          body,
          query: c.req.query(),
          signal: c.get(API_SIGNAL_VARIABLE) ?? c.req.raw.signal,
          launch: c.get(API_LAUNCH_VARIABLE),
        },
      );
      if (operation.id === "help")
        return c.body(result as string, 200, {
          "Content-Type": "text/markdown; charset=utf-8",
        });
      return c.json(result, operationMethod(operation) === "POST" ? 202 : 200);
    });
  }
  routes.all("*", (c) =>
    c.json(
      { error: { code: "not_found", message: "Unknown v0 resource" } },
      404,
    ),
  );
  return routes;
}
