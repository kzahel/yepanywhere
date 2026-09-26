import { randomBytes, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { basename, dirname, extname, resolve } from "node:path";
import { Readable } from "node:stream";
import { getRequestListener } from "@hono/node-server";
import { ARTIFACT_SANDBOX, ARTIFACT_TAB_PROTOCOL } from "@yep-anywhere/shared";
import { FRAME_FIND_AGENT_SCRIPT } from "@yep-anywhere/shared/find/frameFindAgent.generated";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { getMimeType } from "hono/utils/mime";
import {
  isPathInsideDirectory,
  type createLocalResourcePathPolicy,
} from "../routes/local-resource-policy.js";
import { openMutableFileSnapshot } from "../routes/mutable-file-cache.js";
import { validateArtifactConfig, type ArtifactConfig } from "./config.js";
import {
  deletableDirectory,
  GrantStore,
  type PendingDeletion,
  type StoredGrant,
} from "./GrantStore.js";
import {
  registerArtifactOrigins,
  setVhostHostnames,
} from "../middleware/allowed-hosts.js";
import { proxyLoopbackVhost } from "./vhost-proxy.js";
import { matchVhost, vhostHostnames } from "./vhosts.js";
import { VhostAccess } from "./VhostAccess.js";

const MAX_GRANTS = 256;

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}

/**
 * Stand-in served to a sandboxed frame that navigated to a PDF. The frame may
 * not open popups or download, so its buttons ask the YA viewer to open this
 * same URL in a new tab; the page's own address is the fallback.
 */
function pdfInFrameDocument(name: string): string {
  const protocol = JSON.stringify(ARTIFACT_TAB_PROTOCOL);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(name)}</title><style>body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:24px;color:#222;background:#fafafa}p{margin:0 0 12px}.actions{display:flex;flex-wrap:wrap;gap:8px}button{font:inherit;padding:6px 12px}code{word-break:break-all;user-select:all}</style></head><body><p><strong>${escapeHtml(name)}</strong> is a PDF. The embedded preview cannot display PDFs, so open it in its own tab.</p><p class="actions"><button type="button" id="open">Open PDF in a new tab</button><button type="button" id="download">Download</button><button type="button" onclick="history.back()">Back</button></p><p>If nothing opens, copy this address into a new tab: <code id="address"></code></p><script>(function(){var url=new URL(location.href);url.hash="";url.search="";document.getElementById("address").textContent=url.href;function send(download){var target=new URL(url.href);if(download)target.searchParams.set("download","true");parent.postMessage({protocol:${protocol},type:"open",url:target.href},"*");}document.getElementById("open").onclick=function(){send(false);};document.getElementById("download").onclick=function(){send(true);};})();</script></body></html>`;
}
const MAX_FILE_BYTES = 64 * 1024 * 1024;
/**
 * Appended to HTML framed by a YA viewer so the viewer's find field can search
 * that document alone. Content after `</html>` still parses into the body.
 */
const FIND_AGENT_TAIL = Buffer.from(
  `\n<script data-yep-find-agent>${FRAME_FIND_AGENT_SCRIPT}</script>\n`,
);
const ARTIFACT_CSP = [
  `sandbox ${ARTIFACT_SANDBOX}`,
  "default-src 'self' data: blob: http: https:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: http: https:",
  "style-src 'self' 'unsafe-inline' data: blob: http: https:",
  "connect-src 'self' http: https: ws: wss:",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

interface Grant extends StoredGrant {
  files: Set<string>;
}

/** How often expiry is noticed without traffic; deletions owe a deadline. */
const SWEEP_MS = 60_000;

export interface ArtifactServerOptions {
  /** Where grants and pending deletions survive a restart. */
  stateDir?: string;
  /** Directories an owning grant may never delete, whatever a caller says. */
  protectedPaths?: readonly (string | undefined)[];
}

export class ArtifactServer {
  readonly vhostAccess: VhostAccess;
  readonly app = new Hono();
  private readonly grants = new Map<string, Grant>();
  private listener: Server | undefined;
  private listening = false;

  private readonly store: GrantStore;
  private readonly protectedPaths: readonly (string | undefined)[];
  private deletions: PendingDeletion[] = [];
  private sweepTimer?: ReturnType<typeof setInterval>;
  /** Restore runs once; every path that reads grants waits for it. */
  readonly ready: Promise<void>;

  constructor(
    public config: ArtifactConfig,
    private readonly policy: ReturnType<typeof createLocalResourcePathPolicy>,
    options: ArtifactServerOptions = {},
  ) {
    this.config = validateArtifactConfig(config);
    this.store = new GrantStore(options.stateDir);
    this.protectedPaths = options.protectedPaths ?? [];
    this.vhostAccess = new VhostAccess(options.stateDir);
    this.ready = Promise.all([this.restore(), this.vhostAccess.ready]).then(
      () => {},
    );
    // Startup restores and saves before any caller awaits readiness, so a
    // failed state write would otherwise reject with no handler attached and
    // take down the process. Report it here; `ready` still rejects for the
    // request paths that await it.
    this.ready.catch((error: unknown) =>
      console.warn("[ArtifactServer] Grant state unavailable:", error),
    );
    this.registerHosts(this.config);
    this.app.use("*", async (c, next) => {
      await this.ready;
      if (!this.matchesHost(c.req.header("Host") ?? new URL(c.req.url).host))
        return c.text("Unknown artifact host", 421);
      c.header("Content-Security-Policy", ARTIFACT_CSP);
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Referrer-Policy", "no-referrer");
      c.header("Cache-Control", "no-store");
      // Every feature named here is one browsers actually recognize: an
      // unknown name is ignored anyway, and Chromium logs it as an error in
      // the reader's console for every artifact they open. Web Bluetooth is
      // the name that costs more noise than it denies.
      c.header(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), payment=(), usb=(), serial=(), display-capture=()",
      );
      if (c.req.method !== "GET" && c.req.method !== "HEAD")
        return c.text("Read only", 405);
      await next();
    });
    this.app.get("/health", (c) => {
      c.header("Access-Control-Allow-Origin", "*");
      return c.json({ artifactViewer: 1 });
    });
    this.app.get("/a/:token/*", async (c) => {
      const grant = this.grants.get(c.req.param("token"));
      if (!grant || grant.expiresAt <= Date.now()) {
        if (grant) this.grants.delete(grant.token);
        return c.notFound();
      }
      const prefix = `/a/${grant.token}/`;
      const encoded = new URL(c.req.url).pathname.slice(prefix.length);
      let relative: string;
      try {
        relative = decodeURIComponent(encoded);
      } catch {
        return c.text("Invalid artifact path", 400);
      }
      if (
        !relative ||
        relative.includes("\\") ||
        relative.includes("\0") ||
        relative
          .split("/")
          .some((part) => part === ".." || part.startsWith("."))
      ) {
        return c.text("Invalid artifact path", 400);
      }
      const candidate = resolve(grant.root, relative);
      if (!isPathInsideDirectory(candidate, grant.root)) return c.notFound();
      let canonical: string;
      try {
        canonical = await realpath(candidate);
      } catch (error) {
        if (
          ["ENOENT", "ENOTDIR"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          return c.notFound();
        throw error;
      }
      if (!isPathInsideDirectory(canonical, grant.root)) return c.notFound();
      const allowed = await this.policy.resolveAllowedFilePath(canonical);
      if (!allowed.ok) return c.text(allowed.error, allowed.status);
      if (!grant.files.has(canonical) && grant.files.size >= 1024)
        return c.text("Artifact file limit reached", 413);
      const snapshot = await openMutableFileSnapshot(canonical);
      if (!snapshot) return c.notFound();
      const { handle, stats } = snapshot;
      if (stats.size > MAX_FILE_BYTES) {
        await handle.close();
        return c.text("Artifact file exceeds 64 MiB", 413);
      }
      grant.files.add(canonical);
      const mime = getMimeType(canonical) ?? "application/octet-stream";
      // Chromium refuses its PDF viewer inside a sandboxed frame and shows
      // "This content is blocked", so a frame navigation to a PDF gets a page
      // that opens the same URL in a top-level tab instead. Direct fetches,
      // top-level tabs, and explicit downloads still receive the bytes.
      if (
        mime === "application/pdf" &&
        c.req.header("Sec-Fetch-Dest") === "iframe" &&
        new URL(c.req.url).searchParams.get("download") !== "true"
      ) {
        await handle.close();
        return c.html(pdfInFrameDocument(basename(canonical)));
      }
      // Only a frame navigation gets the find agent: downloads, top-level
      // tabs, fetches and range reads still receive the original bytes.
      // XHTML is left alone, since an appended element would make it invalid.
      if (
        mime.startsWith("text/html") &&
        c.req.header("Sec-Fetch-Dest") === "iframe" &&
        new URL(c.req.url).searchParams.get("download") !== "true" &&
        !c.req.header("Range")
      ) {
        c.header("Content-Type", mime);
        if (c.req.method === "HEAD") {
          await handle.close();
          c.header(
            "Content-Length",
            String(stats.size + FIND_AGENT_TAIL.length),
          );
          return c.body(null, 200);
        }
        const framed = Buffer.concat([
          await handle.readFile(),
          FIND_AGENT_TAIL,
        ]);
        await handle.close();
        c.header("Content-Length", String(framed.length));
        return c.body(framed, 200);
      }
      c.header("Content-Type", mime);
      if (new URL(c.req.url).searchParams.get("download") === "true") {
        c.header("Content-Disposition", "attachment");
      }
      c.header("Accept-Ranges", "bytes");
      let start = 0;
      let end = stats.size - 1;
      const range = c.req.header("Range");
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (match && (match[1] || match[2])) {
          start = match[1]
            ? Number(match[1])
            : Math.max(0, stats.size - Number(match[2]));
          end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
        }
        if (
          !match ||
          (!match[1] && !match[2]) ||
          start > end ||
          start >= stats.size ||
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end)
        ) {
          await handle.close();
          c.header("Content-Range", `bytes */${stats.size}`);
          return c.body(null, 416);
        }
        c.header("Content-Range", `bytes ${start}-${end}/${stats.size}`);
      }
      c.header("Content-Length", String(Math.max(0, end - start + 1)));
      if (c.req.method === "HEAD" || stats.size === 0) {
        await handle.close();
        return c.body(null, range ? 206 : 200);
      }
      const stream = handle.createReadStream({ start, end, autoClose: true });
      return c.body(
        Readable.toWeb(stream) as ReadableStream,
        range ? 206 : 200,
      );
    });
  }

  /**
   * Adopt saved grants, drop the ones that expired while the server was down,
   * and settle anything they owed. A grant that expired unnoticed still owes
   * its deletion, so the queue is read before the first request is served.
   */
  private async restore(): Promise<void> {
    const state = await this.store.load();
    const now = Date.now();
    this.deletions = state.deletions;
    for (const stored of state.grants) {
      if (stored.expiresAt > now) {
        this.grants.set(stored.token, { ...stored, files: new Set() });
        continue;
      }
      if (stored.owned)
        this.owe(stored.root, stored.ownedFiles ?? [], stored.expiresAt);
    }
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.sweepTimer.unref?.();
    await this.sweep();
  }

  private owe(root: string, files: readonly string[], dueAt: number): void {
    const existing = this.deletions.find((pending) => pending.root === root);
    // Two grants over one directory own the union of what each froze.
    if (existing) existing.files = [...new Set([...existing.files, ...files])];
    else this.deletions.push({ root, files: [...files], dueAt });
  }

  private persist(): Promise<void> {
    return this.store.save(
      [...this.grants.values()].map(({ files: _files, ...stored }) => stored),
      this.deletions,
    );
  }

  /** Expire grants, pay the deletions they owe, and save what remains. */
  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const [token, grant] of this.grants) {
      if (grant.expiresAt > now) continue;
      this.grants.delete(token);
      if (grant.owned)
        this.owe(grant.root, grant.ownedFiles ?? [], grant.expiresAt);
    }
    const due = this.deletions.filter((pending) => pending.dueAt <= now);
    if (due.length) {
      // A directory that failed to delete is dropped rather than retried
      // forever; the grant is gone either way and nothing is served from it.
      for (const pending of due)
        await GrantStore.deleteFrozen(pending.root, pending.files);
      this.deletions = this.deletions.filter((pending) => pending.dueAt > now);
    }
    await this.persist();
  }

  /** Awaitable sweep for callers that must observe the result. */
  async settleExpired(): Promise<void> {
    await this.ready;
    await this.sweep();
    await this.store.settled();
  }

  get available(): boolean {
    return (
      Boolean(this.config.localOrigin) || Boolean(this.config.publicOrigin)
    );
  }

  private shouldListen(config = this.config): boolean {
    return Boolean(config.publicOrigin) || Boolean(config.vhostPublicRoot);
  }

  private registerHosts(config: ArtifactConfig): void {
    registerArtifactOrigins([config.localOrigin, config.publicOrigin]);
    setVhostHostnames(
      vhostHostnames(config.vhosts ?? [], config.vhostPublicRoot),
    );
  }

  matchesHost(host: string): boolean {
    return [this.config.localOrigin, this.config.publicOrigin].some(
      (origin) => origin && new URL(origin).host === host.toLowerCase(),
    );
  }

  matchesVhost(host: string | undefined) {
    return matchVhost(
      host,
      this.config.vhosts ?? [],
      this.config.vhostPublicRoot,
    );
  }

  async dispatchHost(
    request: Request,
    clientAddress?: string,
  ): Promise<Response | null> {
    const host = request.headers.get("host") ?? new URL(request.url).host;
    const vhost = this.matchesVhost(host);
    if (vhost) {
      await this.ready;
      const authorized = this.vhostAccess.authorize(request, vhost);
      if (!authorized)
        return new Response("App link required", {
          status: 401,
          headers: {
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
          },
        });
      const response = await proxyLoopbackVhost(
        authorized.request,
        vhost.port,
        clientAddress,
      );
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("Referrer-Policy", "no-referrer");
      if (authorized.cookie)
        response.headers.append("Set-Cookie", authorized.cookie);
      return response;
    }
    if (this.matchesHost(host)) return this.app.fetch(request);
    return null;
  }

  async configure(config: ArtifactConfig): Promise<void> {
    config = validateArtifactConfig(
      config,
      this.config.expiryDays,
      this.config,
    );
    const previous = this.config;
    const deliveryChanged =
      config.port !== previous.port ||
      config.localOrigin !== previous.localOrigin ||
      config.publicOrigin !== previous.publicOrigin;
    const wasListening = this.listening;
    if (
      config.port !== previous.port ||
      (this.listening && !this.shouldListen(config))
    )
      await this.close();
    this.config = config;
    this.registerHosts(config);
    try {
      if (!this.listening && this.shouldListen(config)) await this.start();
      if (deliveryChanged) {
        // Changing where artifacts are served revokes outstanding links, and
        // an owning grant pays its deletion on revocation.
        for (const [token, grant] of this.grants) {
          this.grants.delete(token);
          if (grant.owned)
            this.owe(grant.root, grant.ownedFiles ?? [], Date.now());
        }
        void this.sweep();
      }
    } catch (error) {
      this.listener = undefined;
      this.config = previous;
      if (wasListening && !this.listening) await this.start();
      throw error;
    }
  }

  async start(): Promise<void> {
    if (this.listener) throw new Error("Artifact server already started");
    await new Promise<void>((resolveReady, reject) => {
      const listener = createServer(
        getRequestListener(async (request, env) => {
          return (
            (await this.dispatchHost(
              request,
              env.incoming.socket.remoteAddress,
            )) ?? this.app.fetch(request)
          );
        }),
      );
      this.listener = listener;
      listener.once("error", reject);
      listener.listen(this.config.port, "127.0.0.1", () => {
        listener.removeListener("error", reject);
        this.listening = true;
        resolveReady();
      });
    });
  }

  async close(): Promise<void> {
    // Startup restores and writes state under stateDir; closing before that
    // settles lets a caller remove the directory mid-write. Its failure is
    // already reported by the constructor.
    await this.ready.catch(() => {});
    this.listening = false;
    // Persisted grants outlive the process; only this listener stops here.
    clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    // A half-written state file would lose grants a caller already holds.
    await this.store.settled();
    this.grants.clear();
    const listener = this.listener;
    this.listener = undefined;
    if (listener) {
      listener.closeAllConnections();
      await new Promise<void>((resolveClosed, reject) =>
        listener.close((error) => (error ? reject(error) : resolveClosed())),
      );
    }
  }

  async createGrant(
    filePath: string,
    audience: "local" | "public",
    owned?: boolean,
  ) {
    await this.ready;
    const origin =
      audience === "local" ? this.config.localOrigin : this.config.publicOrigin;
    if (!origin)
      throw new HTTPException(409, {
        message: `No ${audience} artifact origin configured`,
      });
    const allowed = await this.policy.resolveAllowedFilePath(filePath);
    if (!allowed.ok)
      throw new HTTPException(allowed.status, { message: allowed.error });
    if (
      ![".html", ".htm"].includes(
        extname(allowed.file.resolvedPath).toLowerCase(),
      )
    ) {
      throw new HTTPException(400, {
        message: "Artifact entry must be an HTML file",
      });
    }
    const now = Date.now();
    for (const [token, grant] of this.grants)
      if (grant.expiresAt <= now) this.grants.delete(token);
    if (this.grants.size >= MAX_GRANTS)
      throw new HTTPException(429, {
        message: "Close an artifact viewer before opening another",
      });
    const token = randomBytes(32).toString("base64url");
    const root = dirname(allowed.file.resolvedPath);
    // Ownership is refused rather than honoured for a directory that is
    // plainly not a disposable bundle; the grant is still created, borrowing.
    // Ownership is never inherited from configuration: a preview of a file
    // the user already had must not delete it when the viewer closes. Only a
    // caller that produced the directory says so, by asking.
    const wants = owned === true;
    // Ownership freezes the fileset: what is here now and is not the working
    // tree's own is what this grant may remove later, whatever else the
    // directory collects. Nothing left to own means nothing to own it.
    const frozen =
      wants && (await deletableDirectory(root, this.protectedPaths))
        ? await GrantStore.freeze(root)
        : null;
    const grant: Grant = {
      id: randomUUID(),
      token,
      root,
      entry: basename(allowed.file.resolvedPath),
      expiresAt: now + this.config.expiryDays! * 24 * 60 * 60 * 1000,
      owned: frozen !== null,
      ...(frozen ? { ownedFiles: frozen } : {}),
      files: new Set(),
    };
    this.grants.set(token, grant);
    // The caller is handed a URL, so the grant must already be durable.
    await this.persist();
    return {
      id: grant.id,
      url: `${origin}/a/${token}/${encodeURIComponent(grant.entry)}`,
      expiresAt: grant.expiresAt,
      owned: grant.owned,
    };
  }

  /** Resolve an artifact URL for the authenticated source editor only. */
  async resolveSourceUrl(rawUrl: string): Promise<string> {
    await this.ready;
    const url = new URL(rawUrl);
    if (
      ![this.config.localOrigin, this.config.publicOrigin].includes(url.origin)
    )
      throw new HTTPException(403, { message: "Not an artifact origin" });
    const match = /^\/a\/([^/]+)\/(.+)$/.exec(url.pathname);
    const grant = match && this.grants.get(match[1]!);
    if (!match || !grant || grant.expiresAt <= Date.now())
      throw new HTTPException(404, {
        message: "Artifact grant expired or unavailable",
      });
    const relative = decodeURIComponent(match[2]!);
    if (
      relative.includes("\\") ||
      relative.includes("\0") ||
      relative.split("/").some((part) => part.startsWith("."))
    )
      throw new HTTPException(400, { message: "Invalid artifact path" });
    const path = await realpath(resolve(grant.root, relative));
    if (!isPathInsideDirectory(path, grant.root))
      throw new HTTPException(403, {
        message: "Artifact source outside granted directory",
      });
    return path;
  }

  /** Revoking an owning grant pays its deletion now, not at its old deadline. */
  async revoke(id: string): Promise<void> {
    await this.ready;
    for (const [token, grant] of this.grants)
      if (grant.id === id) {
        this.grants.delete(token);
        if (grant.owned)
          this.owe(grant.root, grant.ownedFiles ?? [], Date.now());
      }
    await this.sweep();
  }
}
