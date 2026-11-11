import type { Context, Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";

/** Re-enter canonical JSON reads with the original request's authentication. */
export async function readAuthenticatedJson(
  app: Pick<Hono<{ Bindings: HttpBindings }>, "fetch">,
  context: Context,
  path: string,
  signal: AbortSignal,
): Promise<Response> {
  const headers = new Headers(context.req.raw.headers);
  headers.delete("Accept-Encoding");
  headers.delete("Content-Length");
  headers.delete("If-None-Match");
  headers.delete("If-Modified-Since");
  headers.set("Accept", "application/json");
  const url = new URL(path, context.req.url);
  const desktopToken = context.req.query("desktop_token");
  if (desktopToken !== undefined)
    url.searchParams.set("desktop_token", desktopToken);
  return app.fetch(new Request(url, { headers, signal }), context.env);
}
