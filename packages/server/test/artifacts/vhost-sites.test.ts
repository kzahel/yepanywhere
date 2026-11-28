import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { Hono } from "hono";
import {
  EMPTY_LIMITED_USER_GRANTS,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import {
  PRINCIPAL_VARIABLE,
  type Principal,
} from "../../src/auth/principal.js";
import { decideLimitedRoute } from "../../src/auth/limitedUserPolicy.js";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ArtifactServer } from "../../src/artifacts/ArtifactServer.js";
import { validateArtifactConfig } from "../../src/artifacts/config.js";
import {
  clientVhostSite,
  hashVhostPassword,
} from "../../src/artifacts/vhosts.js";
import { createArtifactConfigWriter } from "../../src/routes/artifactConfigWriter.js";
import { createVhostSiteRoutes } from "../../src/routes/vhostSites.js";
import { createLocalResourcePathPolicy } from "../../src/routes/local-resource-policy.js";
import { ServerSettingsService } from "../../src/services/ServerSettingsService.js";

const cleanup: string[] = [];
const servers: ArtifactServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true });
});

async function site() {
  const directory = await mkdtemp(join(tmpdir(), "ya-vhost-site-"));
  cleanup.push(directory);
  await mkdir(join(directory, "assets"));
  await mkdir(join(directory, "docs"));
  await writeFile(
    join(directory, "page.html"),
    '<link rel="stylesheet" href="/assets/app.css"><a href="secret.txt">x</a>',
  );
  await writeFile(join(directory, "assets", "app.css"), "body{}");
  await writeFile(join(directory, "secret.txt"), "private");
  await writeFile(join(directory, "docs", "index.html"), "<h1>Docs</h1>");
  await writeFile(join(directory, ".env"), "TOKEN=1");
  return directory;
}

/** A port nothing listens on, since a public root starts the listener. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function server(directory: string, vhostSites: unknown[]) {
  const port = await freePort();
  const artifacts = new ArtifactServer(
    validateArtifactConfig({
      port,
      localOrigin: `http://artifacts.localhost:${port}`,
      vhostPublicRoot: "example.org",
      vhostSites,
    }),
    createLocalResourcePathPolicy({ allowedPaths: [directory] }),
    { stateDir: join(directory, ".state") },
  );
  servers.push(artifacts);
  return artifacts;
}

const get = (artifacts: ArtifactServer, url: string, init?: RequestInit) =>
  artifacts.dispatchHost(new Request(url, init)) as Promise<Response>;

it("serves a file at / and what it links to, never anything else", async () => {
  const directory = await site();
  const artifacts = await server(directory, [
    { name: "page", path: join(directory, "page.html"), public: true },
  ]);
  const root = await get(artifacts, "https://page.example.org/");
  expect(root.status).toBe(200);
  expect(await root.text()).toContain("app.css");
  expect(root.headers.get("content-security-policy")).toContain("sandbox");
  expect(root.headers.get("cache-control")).toBe("no-store");
  const css = await get(artifacts, "http://page.localhost/assets/app.css");
  expect(css.status).toBe(200);
  expect(css.headers.get("content-type")).toContain("text/css");
  // A linked document is served like an asset.
  expect(
    await (await get(artifacts, "https://page.example.org/secret.txt")).text(),
  ).toBe("private");
  for (const path of ["/.env", "/docs/index.html", "/%2e%2e/x"])
    expect(
      (await get(artifacts, `https://page.example.org${path}`)).status,
    ).toBeGreaterThanOrEqual(400);
  expect(await get(artifacts, "https://other.example.org/")).toBeNull();
});

it("keeps the root at / while its links leave the root's folder", async () => {
  const directory = await site();
  const report = join(directory, "research", "sr", "report.html");
  await mkdir(join(directory, "research", "sr"), { recursive: true });
  await mkdir(join(directory, "topics"));
  await writeFile(
    report,
    '<link rel="stylesheet" href="style.css"><a href="../../topics/speech-mt.md">topic</a>',
  );
  await writeFile(join(directory, "research", "sr", "style.css"), "body{}");
  await writeFile(
    join(directory, "topics", "speech-mt.md"),
    "# Speech MT\n\n[back](../research/sr/report.html)\n",
  );
  await writeFile(join(directory, "topics", "unlinked.md"), "# Other");
  const artifacts = await server(directory, [
    { name: "report", path: report, public: true },
  ]);
  const at = (path: string, headers?: Record<string, string>) =>
    get(artifacts, `https://report.example.org${path}`, { headers });

  expect((await at("/style.css")).status).toBe(200);
  // A browser opening the topic link gets YA's rendered Markdown page, whose
  // own links stay relative to the address it was opened at.
  const topic = await at("/topics/speech-mt.md", {
    "sec-fetch-dest": "document",
  });
  expect(topic.status).toBe(200);
  expect(topic.headers.get("content-type")).toContain("text/html");
  const page = await topic.text();
  expect(page).toContain("Speech MT</h1>");
  expect(page).toContain('href="../research/sr/report.html"');
  expect(page).toContain('href="/topics/speech-mt.md?raw=1"');
  // A script's fetch, or ?raw, gets the text itself.
  for (const [path, headers] of [
    ["/topics/speech-mt.md?raw=1", { "sec-fetch-dest": "document" }],
    ["/topics/speech-mt.md", { "sec-fetch-dest": "empty" }],
  ] as const) {
    const raw = await at(path, headers);
    expect(raw.headers.get("content-type")).toContain("text/plain");
    expect(await raw.text()).toContain("# Speech MT");
  }
  expect((await at("/research/sr/report.html")).status).toBe(200);
  expect((await at("/topics/unlinked.md")).status).toBe(404);
});

it("serves a directory with index pages and never dotfiles", async () => {
  const directory = await site();
  const artifacts = await server(directory, [
    { name: "tree", path: directory, public: true },
  ]);
  expect(
    await (await get(artifacts, "https://tree.example.org/secret.txt")).text(),
  ).toBe("private");
  const folder = await get(artifacts, "https://tree.example.org/docs");
  expect(folder.status).toBe(308);
  expect(folder.headers.get("location")).toBe("/docs/");
  expect(
    await (await get(artifacts, "https://tree.example.org/docs/")).text(),
  ).toBe("<h1>Docs</h1>");
  expect((await get(artifacts, "https://tree.example.org/.env")).status).toBe(
    400,
  );
  expect(
    (await get(artifacts, "https://tree.example.org/x", { method: "POST" }))
      .status,
  ).toBe(405);
});

it("requires the link for a private row and the password for a protected one", async () => {
  const directory = await site();
  const path = join(directory, "page.html");
  const artifacts = await server(directory, [
    { name: "private", path },
    { name: "locked", path, public: true, password: "open sesame" },
  ]);
  await artifacts.ready;
  expect((await get(artifacts, "https://private.example.org/")).status).toBe(
    401,
  );
  const [privateRow, lockedRow] = artifacts.config.vhostSites!;
  const token = artifacts.vhostAccess.token(privateRow!);
  expect(
    (await get(artifacts, `https://private.example.org/?ya_access=${token}`))
      .status,
  ).toBe(200);

  const challenge = await get(artifacts, "https://locked.example.org/");
  expect(challenge.status).toBe(401);
  expect(challenge.headers.get("www-authenticate")).toContain("Basic");
  const basic = (password: string) => ({
    headers: {
      authorization: `Basic ${Buffer.from(`any:${password}`).toString("base64")}`,
    },
  });
  expect(
    (await get(artifacts, "https://locked.example.org/", basic("wrong")))
      .status,
  ).toBe(401);
  const opened = await get(
    artifacts,
    "https://locked.example.org/",
    basic("open sesame"),
  );
  expect(opened.status).toBe(200);
  // The password earns the app cookie, so assets skip the slow check.
  const cookie = opened.headers.get("set-cookie")!.split(";")[0]!;
  expect(
    (
      await get(artifacts, "https://locked.example.org/assets/app.css", {
        headers: { cookie },
      })
    ).status,
  ).toBe(200);
  // An app link still opens it without the password.
  expect(
    (
      await get(
        artifacts,
        `https://locked.example.org/?ya_access=${artifacts.vhostAccess.token(lockedRow!)}`,
      )
    ).status,
  ).toBe(200);
  expect(clientVhostSite(lockedRow!)).toEqual({
    name: "locked",
    path,
    public: true,
    passwordProtected: true,
  });
});

it("keeps names unique across rows, keeps a saved password, and resets it", () => {
  const hash = hashVhostPassword("first");
  const base = { port: 4402, vhosts: [{ name: "plan", port: 19432 }] };
  expect(() =>
    validateArtifactConfig({
      ...base,
      vhostSites: [{ name: "plan", path: "/tmp/a" }],
    }),
  ).toThrow(/Duplicate/);
  for (const name of ["ya", "relay", "app-x", "sbx-y"])
    expect(() =>
      validateArtifactConfig({ ...base, vhostSites: [{ name, path: "/a" }] }),
    ).toThrow(/Invalid vhost name/);
  const previous = [
    { name: "page", path: "/a", public: true, passwordHash: hash },
  ];
  const kept = validateArtifactConfig(
    { ...base, vhostSites: [{ name: "page", path: "/a", public: true }] },
    undefined,
    { vhostSites: previous },
  );
  expect(kept.vhostSites?.[0]?.passwordHash).toBe(hash);
  const reset = validateArtifactConfig(
    {
      ...base,
      vhostSites: [{ name: "page", path: "/a", public: true, password: "new" }],
    },
    undefined,
    { vhostSites: previous },
  );
  expect(reset.vhostSites?.[0]?.passwordHash).not.toBe(hash);
  const cleared = validateArtifactConfig(
    {
      ...base,
      vhostSites: [{ name: "page", path: "/a", public: true, password: "" }],
    },
    undefined,
    { vhostSites: previous },
  );
  expect(cleared.vhostSites?.[0]?.passwordHash).toBeUndefined();
  // A client that predates file rows keeps them by omitting the list.
  expect(
    validateArtifactConfig(base, undefined, { vhostSites: previous })
      .vhostSites,
  ).toEqual(previous);
});

it("claims a name first come, first served and releases it", async () => {
  const directory = await site();
  const dataDir = join(directory, ".data");
  const settings = new ServerSettingsService({ dataDir });
  await settings.initialize();
  const artifacts = await server(directory, []);
  const routes = createVhostSiteRoutes({
    server: artifacts,
    scanner: { getProject: async () => null },
    writer: createArtifactConfigWriter({
      server: artifacts,
      settings,
      locked: false,
    }),
  });
  const claim = (name: string, path = join(directory, "page.html")) =>
    routes.request("/artifacts/vhost-sites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, path, public: true }),
    });
  const first = await claim("garden");
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({
    name: "garden",
    kind: "file",
    publicUrl: "https://garden.example.org/",
    localUrl: `http://garden.localhost:${artifacts.config.port}/`,
    linkedFiles: {
      count: 3,
      paths: ["page.html", "assets/app.css", "secret.txt"],
      truncated: false,
    },
  });
  expect((await claim("garden", directory)).status).toBe(409);
  expect((await claim("relay")).status).toBe(400);
  expect((await claim("elsewhere", "/nonexistent/page.html")).status).toBe(404);
  const listed = await routes.request(
    `/artifacts/vhost-sites?path=${encodeURIComponent(join(directory, "page.html"))}`,
  );
  expect((await listed.json()).sites).toHaveLength(1);
  expect(settings.getSetting("artifactViewer")?.vhostSites).toHaveLength(1);
  const released = await routes.request("/artifacts/vhost-sites/garden", {
    method: "DELETE",
  });
  expect(released.status).toBe(200);
  expect((await claim("garden", directory)).status).toBe(200);
});

it("replaces only an explicitly selected file mapping and revokes its old link", async () => {
  const directory = await site();
  const artifacts = await server(directory, []);
  const settings = new ServerSettingsService({
    dataDir: join(directory, ".data"),
  });
  await settings.initialize();
  const routes = createVhostSiteRoutes({
    server: artifacts,
    scanner: { getProject: async () => null },
    writer: createArtifactConfigWriter({
      server: artifacts,
      settings,
      locked: false,
    }),
  });
  const claim = (path: string, replace?: unknown, password?: string) =>
    routes.request("/artifacts/vhost-sites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "page",
        path,
        replace,
        password,
        public: false,
      }),
    });
  const path = join(directory, "page.html");
  expect((await claim(path, undefined, "old password")).status).toBe(200);
  const old = artifacts.config.vhostSites![0]!;
  const token = artifacts.vhostAccess.token(old);
  expect((await claim(path)).status).toBe(409);
  expect((await claim(path, "yes")).status).toBe(400);
  expect((await claim(path, true)).status).toBe(200);
  expect(artifacts.config.vhostSites).toHaveLength(1);
  expect(artifacts.config.vhostSites![0]!.passwordHash).toBeUndefined();
  expect(
    (await get(artifacts, `https://page.example.org/?ya_access=${token}`))
      .status,
  ).toBe(401);
  expect((await claim(join(directory, "docs"), true)).status).toBe(200);
  const replacedDirectory = artifacts.config.vhostSites![0]!;
  const directoryToken = artifacts.vhostAccess.token(replacedDirectory);
  expect(
    await (
      await get(
        artifacts,
        `https://page.example.org/?ya_access=${directoryToken}`,
      )
    ).text(),
  ).toBe("<h1>Docs</h1>");
  expect((await routes.request("/artifacts/vhost-sites")).status).toBe(200);
  expect(settings.getSetting("artifactViewer")!.vhostSites![0]!.path).toBe(
    join(directory, "docs"),
  );
});

it("limits file-address replacement and release to its creator and confines linked files", async () => {
  const directory = await site();
  const projectPath = join(directory, "docs");
  const path = join(projectPath, "report.html");
  await writeFile(
    path,
    '<a href="../secret.txt">Outside</a><a href="index.html">Inside</a>',
  );
  await symlink(join(directory, "page.html"), join(projectPath, "escape.html"));
  const artifacts = await server(directory, [{ name: "admin", path }]);
  const settings = new ServerSettingsService({
    dataDir: join(directory, ".data"),
  });
  await settings.initialize();
  let allowed = true;
  const grants = {
    ...EMPTY_LIMITED_USER_GRANTS,
    newSessionProjects: ["project"],
    allowPublicApps: true,
  };
  const activeGrants = () => (allowed ? grants : null);
  const routes = new Hono<{
    Variables: Record<typeof PRINCIPAL_VARIABLE, Principal>;
  }>();
  routes.use("*", async (c, next) => {
    c.set(PRINCIPAL_VARIABLE, {
      kind: "limited",
      username: c.req.header("x-user") ?? "alice",
      grants,
      switched: false,
      locked: true,
      via: "direct",
    });
    const decision = decideLimitedRoute({
      method: c.req.method,
      path: `/api${c.req.path}`,
    });
    if (decision.kind === "deny") return c.json({ error: "Denied" }, 403);
    await next();
  });
  routes.route(
    "/",
    createVhostSiteRoutes({
      server: artifacts,
      scanner: {
        getProject: async (id) =>
          id === "project"
            ? {
                id: toUrlProjectId(projectPath),
                path: projectPath,
                name: "docs",
                sessionCount: 0,
                sessionDir: directory,
                activeOwnedCount: 0,
                activeExternalCount: 0,
                lastActivity: null,
                provider: "claude",
              }
            : null,
      },
      activeGrants,
      writer: createArtifactConfigWriter({
        server: artifacts,
        settings,
        locked: false,
      }),
    }),
  );
  artifacts.setFileSiteAdmission((site) => !site.ownerUsername || allowed);
  const claim = (
    name: string,
    user = "alice",
    target = path,
    replace = false,
    projectId = "project",
  ) =>
    routes.request("/artifacts/vhost-sites", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user": user },
      body: JSON.stringify({
        name,
        path: target,
        projectId,
        public: true,
        replace,
        ownerUsername: "superuser",
      }),
    });
  expect((await claim("report")).status).toBe(200);
  expect(
    artifacts.config.vhostSites?.find((row) => row.name === "report")
      ?.ownerUsername,
  ).toBe("alice");
  const persisted = settings.getSetting("artifactViewer")!;
  expect(
    validateArtifactConfig(persisted).vhostSites?.find(
      (row) => row.name === "report",
    )?.ownerUsername,
  ).toBe("alice");
  expect((await claim("report", "bob", path, true)).status).toBe(403);
  expect((await claim("admin", "alice", path, true)).status).toBe(403);
  expect((await claim("report", "alice", path, true)).status).toBe(200);
  expect(
    (await claim("outside", "alice", join(directory, "page.html"))).status,
  ).toBe(403);
  expect(
    (await claim("escape", "alice", join(projectPath, "escape.html"))).status,
  ).toBe(403);
  expect(
    (await claim("ungranted", "alice", path, false, "other-project")).status,
  ).toBe(404);
  const listed = await routes.request(
    "/artifacts/vhost-sites?projectId=project",
  );
  expect(
    (await listed.json()).sites.map((site: { name: string }) => site.name),
  ).toEqual(["report"]);
  const privateClaim = await routes.request("/artifacts/vhost-sites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "private-report",
      path,
      projectId: "project",
    }),
  });
  expect(privateClaim.status).toBe(200);
  Object.assign(grants, { allowPrivateAppLinks: false });
  const publicOnly = await routes.request(
    "/artifacts/vhost-sites?projectId=project",
  );
  expect(
    (await publicOnly.json()).sites.map((site: { name: string }) => site.name),
  ).toEqual(["report"]);
  expect(
    (
      await routes.request("/artifacts/vhost-sites/report", {
        method: "DELETE",
        headers: { "x-user": "bob" },
      })
    ).status,
  ).toBe(403);
  expect((await get(artifacts, "https://report.example.org/")).status).toBe(
    200,
  );
  expect(
    (await get(artifacts, "https://report.example.org/secret.txt")).status,
  ).toBe(404);
  expect(
    (await get(artifacts, "https://report.example.org/index.html")).status,
  ).toBe(200);
  allowed = false;
  expect((await claim("report", "alice", path, true)).status).toBe(403);
  expect((await get(artifacts, "https://report.example.org/")).status).toBe(
    403,
  );
  allowed = true;
  expect(
    (
      await routes.request("/artifacts/vhost-sites/report", {
        method: "DELETE",
      })
    ).status,
  ).toBe(200);
});
