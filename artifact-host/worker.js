const MAX_FILE_BYTES = 256 * 1024 * 1024;
const PROTOCOL = "yep-artifact-preview/1";
const POLICY = [
  "sandbox allow-scripts allow-same-origin allow-downloads",
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'self' " +
    (
      self.__YA_ARTIFACT_PARENTS__ ?? [
        "https://yepanywhere.com",
        "https://latest.yepanywhere.com",
        "chrome-extension://dgeameddpnggdeenoekpiaacfghdodch",
      ]
    ).join(" "),
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith("/v/"))
    event.respondWith(
      deliver(event.request, url).catch(
        () => new Response("Viewer unavailable", { status: 502 }),
      ),
    );
});
async function deliver(request, url) {
  if (request.destination === "document")
    return new Response("Embedded viewer only", { status: 404 });
  if (request.method !== "GET")
    return new Response("Read only", { status: 405 });
  const [, , viewerId, ...parts] = url.pathname.split("/");
  let path;
  try {
    path = parts.map(decodeURIComponent).join("/");
  } catch {
    return new Response("Invalid file", { status: 400 });
  }
  if (
    !/^[a-f0-9]{32}$/.test(viewerId ?? "") ||
    !path ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => !part || part.startsWith("."))
  )
    return new Response("Invalid file", { status: 403 });
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const broker = windows.find((client) => {
    const candidate = new URL(client.url);
    return (
      candidate.origin === url.origin &&
      candidate.pathname === "/__ya/1/bootstrap.html" &&
      candidate.searchParams.get("viewer") === viewerId
    );
  });
  if (!broker) return new Response("No live viewer", { status: 503 });
  const { port1, port2 } = new MessageChannel();
  let timer;
  const head = await new Promise((resolve) => {
    timer = setTimeout(() => resolve({ status: 504 }), 15000);
    port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve(event.data);
    };
    broker.postMessage(
      {
        protocol: PROTOCOL,
        type: "read",
        viewerId,
        path,
        range: request.headers.get("range"),
      },
      [port2],
    );
  });
  if (![200, 206].includes(head?.status) || typeof head.mime !== "string") {
    port1.postMessage({ type: "cancel" });
    port1.close();
    return new Response("Read refused", {
      status: head?.status >= 400 && head.status <= 599 ? head.status : 502,
      ...(head?.status === 416 &&
      /^bytes \*\/\d+$/.test(head.headers?.["content-range"] ?? "")
        ? { headers: { "content-range": head.headers["content-range"] } }
        : {}),
    });
  }
  let bytes = 0;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    clearTimeout(timer);
    port1.postMessage({ type: "cancel" });
    port1.close();
    pendingPull?.();
  };
  let pendingPull;
  const body = new ReadableStream(
    {
      pull(controller) {
        return new Promise((resolve) => {
          pendingPull = resolve;
          timer = setTimeout(() => {
            controller.error(new Error("Body timed out"));
            cancel();
            resolve();
          }, 15000);
          port1.onmessage = (event) => {
            clearTimeout(timer);
            const message = event.data;
            if (
              message?.type === "chunk" &&
              message.bytes instanceof ArrayBuffer
            ) {
              bytes += message.bytes.byteLength;
              if (bytes > MAX_FILE_BYTES) {
                controller.error(new Error("File limit"));
                cancel();
              } else controller.enqueue(new Uint8Array(message.bytes));
            } else if (message?.type === "end") {
              controller.close();
              port1.close();
            } else {
              controller.error(new Error("Read failed"));
              cancel();
            }
            resolve();
          };
          if (!cancelled) port1.postMessage({ type: "pull" });
          else resolve();
        });
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  const headers = new Headers({
    "content-type": head.mime,
    "cache-control": "no-store",
    "content-security-policy": POLICY,
    "origin-agent-cluster": "?1",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-yep-artifact-worker": "1",
  });
  for (const name of ["content-range", "accept-ranges", "content-length"])
    if (typeof head.headers?.[name] === "string")
      headers.set(name, head.headers[name]);
  const navigation =
    request.mode === "navigate" &&
    head.mime.toLowerCase().startsWith("text/html") &&
    head.status === 200 &&
    url.searchParams.get("download") !== "true";
  if (navigation) {
    headers.delete("content-length");
    const prefix = new TextEncoder().encode(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script src="/__ya/1/frame.js"></script><style>:root{--color-text-primary:#182a37;--color-text-secondary:#637583;--color-background-primary:#fff;--color-background-secondary:#f3f6f8;--color-border-primary:#dce3e8;--font-sans:system-ui,sans-serif;--font-mono:ui-monospace,monospace}html[data-theme=dark]{--color-text-primary:#e8edf1;--color-text-secondary:#aab6c1;--color-background-primary:#17212b;--color-background-secondary:#202e3a;--color-border-primary:#40505f}body{font-family:var(--font-sans);color:var(--color-text-primary);background:var(--color-background-primary)}button,input,select,textarea{font:inherit}img{max-width:100%;height:auto}</style>',
    );
    return new Response(
      body.pipeThrough(
        new TransformStream({
          start(controller) {
            controller.enqueue(prefix);
          },
          transform(chunk, controller) {
            controller.enqueue(chunk);
          },
        }),
      ),
      { headers },
    );
  }
  return new Response(body, { status: head.status, headers });
}
