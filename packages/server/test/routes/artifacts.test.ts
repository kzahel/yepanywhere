import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ArtifactServer } from "../../src/artifacts/ArtifactServer.js";
import { createArtifactRoutes } from "../../src/routes/artifacts.js";
import { createLocalResourcePathPolicy } from "../../src/routes/local-resource-policy.js";
import { createApp } from "../setup/create-app.js";
import { ScriptedClaudeProvider } from "../support/scripted-provider.js";
import { ServerSettingsService } from "../../src/services/ServerSettingsService.js";
import { initFileAccess } from "../../src/middleware/file-access.js";
import {
  updateAllowedHosts,
  isAllowedOrigin,
} from "../../src/middleware/allowed-hosts.js";
import {
  readArtifactConfig,
  validateArtifactConfig,
} from "../../src/artifacts/config.js";
import { createServer, request } from "node:http";
import { getRequestListener } from "@hono/node-server";

let directory: string;
afterEach(async () => {
  vi.restoreAllMocks();
  if (directory) await rm(directory, { recursive: true });
  directory = "";
});

it("grants the same home-relative HTML file with or without project context", async () => {
  directory = await mkdtemp(join(homedir(), ".ya-artifact-test-"));
  const entry = join(directory, "index.html");
  await writeFile(entry, "<h1>Home-relative</h1>");
  const server = new ArtifactServer(
    { port: 4402, localOrigin: "http://artifacts.localhost:4402" },
    createLocalResourcePathPolicy({ allowedPaths: [directory] }),
  );
  const routes = createArtifactRoutes({
    server,
    scanner: { getProject: vi.fn().mockResolvedValue({ path: directory }) },
    locked: true,
  });
  try {
    for (const projectId of [undefined, "project"]) {
      for (const path of [
        entry,
        `~/${relative(homedir(), entry)}`,
        `~\\${relative(homedir(), entry)}`,
      ]) {
        const response = await routes.request("/artifacts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, projectId, audience: "local" }),
        });
        expect(response.status).toBe(200);
        const grant = await response.json();
        expect(await (await server.app.request(grant.url)).text()).toBe(
          "<h1>Home-relative</h1>",
        );
      }
    }
  } finally {
    await server.close();
  }
});

it("configures, creates, and revokes artifacts through the app's public routes", async () => {
  directory = await mkdtemp(join(tmpdir(), "ya-artifact-routes-"));
  const entry = join(directory, "index.html");
  await writeFile(entry, "<h1>Public route</h1>");
  const dataDir = join(directory, "data");
  const settings = new ServerSettingsService({ dataDir });
  await settings.initialize();
  initFileAccess({
    uploadsDir: directory,
    homeDir: directory,
    tempPaths: [directory],
    envPaths: [directory],
  });
  const instance = createApp({
    provider: new ScriptedClaudeProvider(),
    dataDir,
    projectsDir: join(directory, "sessions"),
    serverSettingsService: settings,
  });
  const call = (path: string, method: string, body?: object) =>
    instance.app.request(path, {
      method,
      headers: { "Content-Type": "application/json", "X-Yep-Anywhere": "true" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  try {
    expect(
      (await call("/api/artifacts", "POST", { path: entry, audience: "local" }))
        .status,
    ).toBe(409);
    expect(
      (
        await call("/api/artifacts/config", "PUT", {
          port: 4402,
          localOrigin: "http://artifacts.localhost:3400",
          expiryDays: 2,
        })
      ).status,
    ).toBe(200);
    expect(settings.getSetting("artifactViewer")?.expiryDays).toBe(2);
    const response = await call("/api/artifacts", "POST", {
      path: entry,
      audience: "local",
    });
    expect(response.status).toBe(200);
    const grant = await response.json();
    expect(
      await (await instance.artifactServer.app.request(grant.url)).text(),
    ).toBe("<h1>Public route</h1>");
    expect((await call(`/api/artifacts/${grant.id}`, "DELETE")).status).toBe(
      200,
    );
    expect((await instance.artifactServer.app.request(grant.url)).status).toBe(
      404,
    );
  } finally {
    await instance.artifactServer.close();
    await instance.disposeSessionReaders();
  }
});

it("serves an authorized HTML directory with executable bytes and revocable access", async () => {
  directory = await mkdtemp(join(tmpdir(), "ya-artifact-"));
  const root = join(directory, "mockup");
  await mkdir(root);
  await writeFile(join(root, "index.html"), '<script src="app.js"></script>');
  await writeFile(join(root, "app.js"), 'document.title = "working";');
  const server = new ArtifactServer(
    { port: 4402, localOrigin: "http://artifacts.localhost:4402" },
    createLocalResourcePathPolicy({ allowedPaths: [directory] }),
  );
  const grant = await server.createGrant(join(root, "index.html"), "local");
  const html = await server.app.request(grant.url);
  expect(html.status).toBe(200);
  expect(html.headers.get("content-type")).toContain("text/html");
  // No popup authority: an unsandboxed popup could navigate the YA tab that
  // frames this document. The artifact may start downloads.
  expect(html.headers.get("content-security-policy")).toContain(
    "sandbox allow-scripts allow-same-origin allow-downloads;",
  );
  // A PDF navigated to inside the sandboxed frame gets a hand-off page that
  // asks the viewer for a tab; other fetch destinations and explicit
  // downloads receive the bytes.
  await writeFile(join(root, "paper.pdf"), "%PDF-1.4 stub");
  const framed = await server.app.request(new URL("paper.pdf", grant.url), {
    headers: { "Sec-Fetch-Dest": "iframe" },
  });
  expect(framed.headers.get("content-type")).toContain("text/html");
  const handoff = await framed.text();
  expect(handoff).toContain("yep-artifact-tab/1");
  expect(handoff).not.toContain('target="_blank"');
  expect(handoff).toContain("paper.pdf");
  expect(handoff).not.toContain("%PDF");
  // The page takes its address from the browser's location: behind a
  // TLS-terminating tunnel the request URL the server saw is plain http.
  expect(handoff).not.toContain(new URL(grant.url).origin);
  const topLevel = await server.app.request(new URL("paper.pdf", grant.url), {
    headers: { "Sec-Fetch-Dest": "document" },
  });
  expect(topLevel.headers.get("content-type")).toContain("application/pdf");
  expect(await topLevel.text()).toBe("%PDF-1.4 stub");
  const download = await server.app.request(
    new URL("paper.pdf?download=true", grant.url),
    { headers: { "Sec-Fetch-Dest": "iframe" } },
  );
  expect(download.headers.get("content-disposition")).toBe("attachment");
  expect(await download.text()).toBe("%PDF-1.4 stub");
  expect(await html.text()).toContain('<script src="app.js">');
  const script = await server.app.request(new URL("app.js", grant.url));
  expect(script.status).toBe(200);
  expect(script.headers.get("content-type")).toContain("javascript");
  expect(await script.text()).toContain('"working"');
  const range = await server.app.request(new URL("app.js", grant.url), {
    headers: { Range: "bytes=0-7" },
  });
  expect(range.status).toBe(206);
  expect(await range.text()).toBe("document");
  const head = await server.app.request(grant.url, { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  for (const path of [
    "../secret.txt",
    "%2e%2e%2fsecret.txt",
    ".env",
    "app.js%00",
  ]) {
    expect(
      (await server.app.request(new URL(path, grant.url))).status,
    ).not.toBe(200);
  }
  expect(
    (await server.app.request(new URL("/api/version", grant.url))).status,
  ).toBe(404);
  expect((await server.app.request(grant.url, { method: "POST" })).status).toBe(
    405,
  );
  expect(
    (
      await server.app.request(grant.url, {
        headers: { Host: "localhost:4402" },
      })
    ).status,
  ).toBe(421);
  await server.revoke(grant.id);
  expect((await server.app.request(grant.url)).status).toBe(404);
});

it("adds the find agent only to HTML framed by a viewer", async () => {
  directory = await mkdtemp(join(tmpdir(), "ya-artifact-find-"));
  const source = "<p>Findable text</p>";
  await writeFile(join(directory, "index.html"), source);
  await writeFile(join(directory, "doc.xhtml"), "<html/>");
  const server = new ArtifactServer(
    { port: 4402, localOrigin: "http://artifacts.localhost:4402" },
    createLocalResourcePathPolicy({ allowedPaths: [directory] }),
  );
  const grant = await server.createGrant(
    join(directory, "index.html"),
    "local",
  );
  const iframe = { "Sec-Fetch-Dest": "iframe" };
  const framed = await server.app.request(grant.url, { headers: iframe });
  const body = await framed.text();
  expect(body.startsWith(source)).toBe(true);
  expect(body).toContain("<script data-yep-find-agent>");
  expect(body.trimEnd().endsWith("</script>")).toBe(true);
  expect(Number(framed.headers.get("content-length"))).toBe(
    Buffer.byteLength(body),
  );
  const framedHead = await server.app.request(grant.url, {
    method: "HEAD",
    headers: iframe,
  });
  expect(framedHead.headers.get("content-length")).toBe(
    framed.headers.get("content-length"),
  );
  for (const [url, headers] of [
    [grant.url, { "Sec-Fetch-Dest": "document" }],
    [`${grant.url}?download=true`, iframe],
    [grant.url, { ...iframe, Range: "bytes=0-2" }],
  ] as const) {
    const plain = await (await server.app.request(url, { headers })).text();
    expect(source.startsWith(plain)).toBe(true);
    expect(plain).not.toContain("yep-find");
  }
  expect(
    await (
      await server.app.request(new URL("doc.xhtml", grant.url), {
        headers: iframe,
      })
    ).text(),
  ).toBe("<html/>");
  await server.close();
});

it("routes the artifact Host on YA's actual HTTP port before YA APIs", async () => {
  directory = await mkdtemp(join(tmpdir(), "ya-artifact-host-"));
  await writeFile(join(directory, "index.html"), "<h1>Isolated</h1>");
  initFileAccess({
    uploadsDir: directory,
    homeDir: directory,
    tempPaths: [directory],
    envPaths: [directory],
  });
  const instance = createApp({
    provider: new ScriptedClaudeProvider(),
    dataDir: join(directory, "data"),
    projectsDir: join(directory, "sessions"),
    artifacts: {
      port: 4402,
      localOrigin: "http://artifacts.localhost:3400",
    },
  });
  const listener = createServer(getRequestListener(instance.app.fetch));
  await new Promise<void>((ready) => listener.listen(0, "127.0.0.1", ready));
  const address = listener.address();
  if (!address || typeof address === "string")
    throw new Error("Missing listener port");
  const port = address.port;
  const get = (path: string, host: string, origin?: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          headers: { Host: host, ...(origin ? { Origin: origin } : {}) },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  try {
    const grant = await instance.artifactServer.createGrant(
      join(directory, "index.html"),
      "local",
    );
    expect(
      await get(new URL(grant.url).pathname, "artifacts.localhost:3400"),
    ).toMatchObject({ status: 200, body: "<h1>Isolated</h1>" });
    expect((await get("/health", "artifacts.localhost:3400")).body).toBe(
      '{"artifactViewer":1}',
    );
    for (const path of [
      "/api/version",
      "/public-api/shares/test",
      "/desktop-bootstrap",
      "/api/ws",
    ]) {
      expect((await get(path, "artifacts.localhost:3400")).status).toBe(404);
    }
    updateAllowedHosts("*");
    expect(
      (
        await get(
          "/api/version",
          "localhost:3400",
          "http://artifacts.localhost:3400",
        )
      ).status,
    ).toBe(403);
    expect((await get("/api/version", "localhost:3400", "null")).status).toBe(
      403,
    );
    expect(isAllowedOrigin("http://artifacts.localhost:9999")).toBe(false);
  } finally {
    updateAllowedHosts(undefined);
    listener.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    await instance.disposeSessionReaders();
  }
});

it("expires each link at its original lifetime after an expiry-only settings change", async () => {
  directory = await mkdtemp(join(tmpdir(), "ya-artifact-expiry-"));
  const entry = join(directory, "index.html");
  await writeFile(entry, "<h1>Expires</h1>");
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const server = new ArtifactServer(
    { port: 4402, localOrigin: "http://artifacts.localhost:3400" },
    createLocalResourcePathPolicy({ allowedPaths: [directory] }),
  );
  const original = await server.createGrant(entry, "local");
  expect(original.expiresAt).toBe(now + 7 * 24 * 3600_000);
  await server.configure({ ...server.config, expiryDays: 2 });
  const shorter = await server.createGrant(entry, "local");
  expect(shorter.expiresAt).toBe(now + 2 * 24 * 3600_000);
  clock.mockReturnValue(shorter.expiresAt - 1);
  expect(
    (await server.app.request(shorter.url, { method: "HEAD" })).status,
  ).toBe(200);
  clock.mockReturnValue(shorter.expiresAt);
  expect((await server.app.request(shorter.url)).status).toBe(404);
  expect(
    (await server.app.request(original.url, { method: "HEAD" })).status,
  ).toBe(200);
  await server.configure({ ...server.config, port: 4403 });
  expect((await server.app.request(original.url)).status).toBe(404);
  await server.close();
});

it("reopening a file reuses its live borrowed link instead of filling the grant cap", async () => {
  directory = await mkdtemp(join(tmpdir(), "ya-artifact-reuse-"));
  const entry = join(directory, "index.html");
  await writeFile(entry, "<h1>Reused</h1>");
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const server = new ArtifactServer(
    { port: 4402, localOrigin: "http://artifacts.localhost:3400" },
    createLocalResourcePathPolicy({ allowedPaths: [directory] }),
  );
  try {
    const first = await server.createGrant(entry, "local");
    expect(first.reused).toBe(false);
    // More preview starts than the cap allows, each leaving its link behind.
    for (let open = 0; open < 300; open++) {
      const again = await server.createGrant(entry, "local");
      expect(again).toMatchObject({ id: first.id, url: first.url });
      expect(again.reused).toBe(true);
    }
    // A caller asking to own its directory always gets a grant of its own.
    const owning = await server.createGrant(entry, "local", true);
    expect(owning.id).not.toBe(first.id);
    expect(owning.reused).toBe(false);
    // Past half its lifetime a link is no longer handed to a new viewer, but
    // it keeps serving whoever already holds it.
    clock.mockReturnValue(now + 3.5 * 24 * 3600_000 + 1);
    const renewed = await server.createGrant(entry, "local");
    expect(renewed.id).not.toBe(first.id);
    expect(renewed.expiresAt).toBe(
      now + 3.5 * 24 * 3600_000 + 1 + 7 * 24 * 3600_000,
    );
    expect((await server.app.request(first.url)).status).toBe(200);
  } finally {
    await server.close();
  }
});

it("refuses a new link past the cap with the time the next one expires", async () => {
  directory = await mkdtemp(join(tmpdir(), "ya-artifact-cap-"));
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  const server = new ArtifactServer(
    { port: 4402, localOrigin: "http://artifacts.localhost:3400" },
    createLocalResourcePathPolicy({ allowedPaths: [directory] }),
  );
  try {
    const entries: string[] = [];
    for (let index = 0; index <= 256; index++) {
      const dir = join(directory, `bundle-${index}`);
      await mkdir(dir);
      entries.push(join(dir, "index.html"));
      await writeFile(entries[index]!, `<h1>${index}</h1>`);
    }
    for (const entry of entries.slice(0, 256))
      await server.createGrant(entry, "local");
    await expect(server.createGrant(entries[256]!, "local")).rejects.toThrow(
      `Too many live artifact links (256); the next one expires at ${new Date(now + 7 * 24 * 3600_000).toISOString()}`,
    );
    // Reopening an already linked file needs no new slot.
    expect((await server.createGrant(entries[0]!, "local")).reused).toBe(true);
  } finally {
    await server.close();
  }
});

it("validates whole expiry days, rounding a legacy hours write up to a day", () => {
  expect(validateArtifactConfig({ port: 4402 }).expiryDays).toBe(7);
  expect(validateArtifactConfig({ port: 4402 }, 3).expiryDays).toBe(3);
  for (const expiryDays of [1, 30]) {
    expect(validateArtifactConfig({ port: 4402, expiryDays }).expiryDays).toBe(
      expiryDays,
    );
  }
  // Hours remain readable for an older client and a settings file written
  // before days existed; anything under a day becomes one day.
  expect(validateArtifactConfig({ port: 4402, expiryHours: 2 })).toMatchObject({
    expiryDays: 1,
    expiryHours: 24,
  });
  expect(
    validateArtifactConfig({ port: 4402, expiryHours: 168 }).expiryDays,
  ).toBe(7);
  // Days win when a client sends both.
  expect(
    validateArtifactConfig({ port: 4402, expiryDays: 3, expiryHours: 168 })
      .expiryDays,
  ).toBe(3);
  for (const expiryDays of [0, 31, 1.5, "7", null, NaN]) {
    expect(() => validateArtifactConfig({ port: 4402, expiryDays })).toThrow(
      "whole days",
    );
  }
  for (const expiryHours of [0, 169, 1.5, "24", null, NaN]) {
    expect(() => validateArtifactConfig({ port: 4402, expiryHours })).toThrow(
      "whole hours",
    );
  }
  // A settings file or hosted client written before the setting was removed
  // still sends it; it is dropped rather than rejected.
  expect(
    validateArtifactConfig({ port: 4402, deleteOnExpiry: true }),
  ).not.toHaveProperty("deleteOnExpiry");
});

it("keeps launch overrides explicit and rejects shared-loopback origins", () => {
  expect(readArtifactConfig({})).toBeUndefined();
  expect(
    readArtifactConfig({
      YEP_ARTIFACT_PORT: "0",
      YEP_ARTIFACT_PUBLIC_ORIGIN: "https://artifacts.example.org",
    }),
  ).toEqual({ port: 4402 });
  expect(() => validateArtifactConfig({ port: 0 })).toThrow();
  expect(() =>
    validateArtifactConfig({
      port: 4402,
      localOrigin: "http://localhost:4402",
    }),
  ).toThrow();
  expect(() =>
    validateArtifactConfig({
      port: 4402,
      publicOrigin: "http://artifacts.example.org",
    }),
  ).toThrow();
});

it("validates and preserves the unconditional vhost link rewrite setting", () => {
  expect(
    validateArtifactConfig({ port: 4402, alwaysRewriteVhostLinks: true }),
  ).toMatchObject({ alwaysRewriteVhostLinks: true });
  expect(
    validateArtifactConfig({ port: 4402 }, 7, {
      alwaysRewriteVhostLinks: true,
    }),
  ).toMatchObject({ alwaysRewriteVhostLinks: true });
  expect(() =>
    validateArtifactConfig({
      port: 4402,
      alwaysRewriteVhostLinks: "yes",
    }),
  ).toThrow("alwaysRewriteVhostLinks must be a boolean");
});

it("proxies a static vhost Host to loopback before YA APIs", async () => {
  directory = await mkdtemp(join(tmpdir(), "ya-vhost-"));
  initFileAccess({
    uploadsDir: directory,
    homeDir: directory,
    tempPaths: [directory],
    envPaths: [directory],
  });
  const upstream = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`ok ${req.headers.host} ${req.url}`);
  });
  await new Promise<void>((ready) => upstream.listen(0, "127.0.0.1", ready));
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === "string")
    throw new Error("Missing upstream port");
  const instance = createApp({
    provider: new ScriptedClaudeProvider(),
    dataDir: join(directory, "data"),
    projectsDir: join(directory, "sessions"),
    artifacts: {
      port: 4402,
      localOrigin: "http://artifacts.localhost:3400",
      vhostPublicRoot: "graehl.org",
      vhosts: [{ name: "plan", port: upstreamAddress.port, public: true }],
    },
  });
  const listener = createServer(getRequestListener(instance.app.fetch));
  await new Promise<void>((ready) => listener.listen(0, "127.0.0.1", ready));
  const address = listener.address();
  if (!address || typeof address === "string")
    throw new Error("Missing listener port");
  const get = (path: string, host: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path,
          headers: { Host: host },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  try {
    expect(await get("/health", "plan.localhost:3400")).toMatchObject({
      status: 200,
      body: `ok plan.localhost:3400 /health`,
    });
    expect(await get("/health", "plan.graehl.org")).toMatchObject({
      status: 200,
      body: "ok plan.graehl.org /health",
    });
    expect(await get("/api/version", "plan.localhost:3400")).toMatchObject({
      status: 200,
      body: "ok plan.localhost:3400 /api/version",
    });
    expect((await get("/api/version", "localhost:3400")).status).toBe(200);
  } finally {
    listener.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    upstream.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
    await instance.disposeSessionReaders();
  }
});
