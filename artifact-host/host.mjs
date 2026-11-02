export const VERSION = "1";
export const DEFAULT_PARENTS = [
  "https://yepanywhere.com",
  "https://latest.yepanywhere.com",
  "chrome-extension://dgeameddpnggdeenoekpiaacfghdodch",
];
const PERMISSIONS =
  "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), payment=(), usb=(), serial=(), display-capture=()";

/** Static shell only. This host has no YA connection or artifact storage. */
export function serve(request, assets, env = {}) {
  const url = new URL(request.url);
  const parents = env.PARENT_ORIGINS
    ? JSON.parse(env.PARENT_ORIGINS)
    : DEFAULT_PARENTS;
  const hostAllowed =
    /^artifact-[a-f0-9]{32}\.yepanywhere\.com$/.test(url.hostname) ||
    (env.LOCAL_TEST === "1" && url.hostname.endsWith(".localhost"));
  const headers = new Headers({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Origin-Agent-Cluster": "?1",
    "Permissions-Policy": PERMISSIONS,
    "Content-Security-Policy": `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; frame-src 'self'; worker-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${parents.join(" ")}`,
  });
  if (!hostAllowed || !["GET", "HEAD"].includes(request.method))
    return new Response("Not found", { status: 404, headers });
  let content;
  if (url.pathname === `/__ya/${VERSION}/bootstrap.html`) {
    const parent = url.searchParams.get("parent");
    const viewer = url.searchParams.get("viewer");
    if (!parents.includes(parent) || !/^[a-f0-9]{32}$/.test(viewer ?? ""))
      return new Response("Invalid viewer", { status: 400, headers });
    headers.set("Content-Type", "text/html; charset=utf-8");
    content = bootstrapHtml(parent);
  } else if (
    url.pathname === `/__ya/${VERSION}/bootstrap.js` ||
    url.pathname === `/__ya/${VERSION}/worker.js` ||
    url.pathname === `/__ya/${VERSION}/frame.js`
  ) {
    const name = url.pathname.split("/").at(-1);
    content = assets[name];
    headers.set("Content-Type", "text/javascript; charset=utf-8");
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    if (name === "worker.js") headers.set("Service-Worker-Allowed", "/v/");
  }
  if (content === undefined)
    return new Response("No artifact on this server", { status: 404, headers });
  return new Response(request.method === "HEAD" ? null : content, { headers });
}

export function bootstrapHtml(parent) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="ya-parent-origin" content="${parent}"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;display:block}html,body{overflow:hidden}</style><script defer src="/__ya/${VERSION}/bootstrap.js"></script></head><body></body></html>`;
}
