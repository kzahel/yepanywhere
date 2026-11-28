import {
  mkdtemp,
  mkdir,
  readFile,
  truncate,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_LIMITED_USER_GRANTS } from "@yep-anywhere/shared";
import { Hono } from "hono";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  PRINCIPAL_VARIABLE,
  type Principal,
} from "../../src/auth/principal.js";
import { decideLimitedRoute } from "../../src/auth/limitedUserPolicy.js";
import { createArtifactPreviewRoutes } from "../../src/routes/artifact-previews.js";
import { createLocalResourcePathPolicy } from "../../src/routes/local-resource-policy.js";

type PrincipalEnv = { Variables: Record<typeof PRINCIPAL_VARIABLE, Principal> };

let root: string;
let allowed: string[];
let clock: number;
let app: Hono<PrincipalEnv>;
let previews: ReturnType<typeof createArtifactPreviewRoutes>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ya-preview-"));
  const bundle = join(root, "bundle");
  await mkdir(bundle);
  await writeFile(
    join(bundle, "index.html"),
    '<script>document.body.textContent="interactive"</script>',
  );
  await writeFile(join(bundle, "data.json"), '{"value":42}');
  await writeFile(join(root, "outside.json"), '"secret"');
  await writeFile(join(bundle, ".secret"), "hidden");
  allowed = [root];
  clock = Date.now();
  mount();
});
function mount(maxViewerBytes?: number) {
  app = new Hono<PrincipalEnv>();
  app.use("*", async (c, next) => {
    const username = c.req.header("user");
    c.set(
      PRINCIPAL_VARIABLE,
      username
        ? {
            kind: "limited",
            username,
            grants: EMPTY_LIMITED_USER_GRANTS,
            switched: false,
            locked: true,
            via: "direct",
          }
        : { kind: "superuser" },
    );
    await next();
  });
  previews = createArtifactPreviewRoutes({
    policy: createLocalResourcePathPolicy({ allowedPaths: () => allowed }),
    scope: (_c, path) => ({
      hostPath: path,
      allowedPaths: () => allowed,
      includeProjects: () => false,
    }),
    scanner: { listProjects: async () => [], getProject: async () => null },
    now: () => clock,
    maxViewerBytes,
  });
  app.route("/api", previews.routes);
}
afterEach(async () => {
  previews.close();
  await rm(root, { recursive: true, force: true });
});
async function admit(base = "/api/artifact-previews", user?: string) {
  const response = await app.request(base, {
    method: "POST",
    headers: { "content-type": "application/json", ...(user ? { user } : {}) },
    body: JSON.stringify({ path: join(root, "bundle/index.html") }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    id: string;
    entry: string;
    expiresAt: number;
  };
}
function file(
  id: string,
  path: string,
  base = "/api/artifact-previews",
  user?: string,
) {
  return app.request(`${base}/${id}/file?${new URLSearchParams({ path })}`, {
    headers: user ? { user } : {},
  });
}
it("serves native bytes without a listener, with inert active responses and ranges", async () => {
  const grant = await admit();
  expect(grant.entry).toBe("index.html");
  const html = await file(grant.id, "index.html");
  expect(html.headers.get("content-disposition")).toContain("attachment");
  expect(html.headers.get("content-security-policy")).toContain("sandbox");
  expect(await html.text()).toContain("interactive");
  const data = await file(grant.id, "data.json");
  expect(await data.json()).toEqual({ value: 42 });
  const range = await app.request(
    `/api/artifact-previews/${grant.id}/file?path=data.json`,
    { headers: { range: "bytes=0-3" } },
  );
  expect(range.status).toBe(206);
  expect(await range.text()).toBe('{"va');
});
it("refuses traversal, hidden files, absolute paths and an out-of-root symlink", async () => {
  const grant = await admit();
  for (const path of [
    "../outside.json",
    ".secret",
    "/outside.json",
    "a\\outside.json",
    "a/../data.json",
  ])
    expect((await file(grant.id, path)).status).toBe(400);
  await symlink(join(root, "outside.json"), join(root, "bundle/link.json"));
  expect((await file(grant.id, "link.json")).status).toBe(404);
});
it("rechecks policy, expiry and viewer release without deleting source files", async () => {
  const grant = await admit();
  allowed = [];
  expect((await file(grant.id, "data.json")).status).toBe(403);
  allowed = [root];
  expect(
    (
      await app.request(`/api/artifact-previews/${grant.id}`, {
        method: "DELETE",
      })
    ).status,
  ).toBe(200);
  expect((await file(grant.id, "data.json")).status).toBe(404);
  expect(await readFile(join(root, "bundle/data.json"), "utf8")).toContain(
    "42",
  );
  const next = await admit();
  clock = next.expiresAt;
  expect((await file(next.id, "data.json")).status).toBe(404);
});
it("binds leases to the acting principal and session; limited routes require access", async () => {
  const base = "/api/sessions/s1/artifact-previews";
  const grant = await admit(base, "alice");
  expect((await file(grant.id, "data.json", base, "bob")).status).toBe(404);
  expect(
    (
      await file(
        grant.id,
        "data.json",
        "/api/sessions/s2/artifact-previews",
        "alice",
      )
    ).status,
  ).toBe(404);
  expect(
    (await file(grant.id, "data.json", "/api/artifact-previews", "alice"))
      .status,
  ).toBe(404);
  expect(
    await (await file(grant.id, "data.json", base, "alice")).json(),
  ).toEqual({ value: 42 });
  expect(decideLimitedRoute({ method: "POST", path: base })).toMatchObject({
    kind: "session",
    sessionId: "s1",
    required: "join",
  });
  expect(
    decideLimitedRoute({ method: "GET", path: `${base}/${grant.id}/file` }),
  ).toMatchObject({ kind: "session", required: "view" });
  expect(
    decideLimitedRoute({ method: "POST", path: "/api/artifact-previews" }),
  ).toEqual({ kind: "deny" });
});
it("revocation cancels a live response and releases reader capacity", async () => {
  await writeFile(
    join(root, "bundle/large.bin"),
    new Uint8Array(4 * 1024 * 1024),
  );
  const grant = await admit();
  const responses = await Promise.all(
    Array.from({ length: 16 }, () => file(grant.id, "large.bin")),
  );
  expect(responses.every((response) => response.status === 200)).toBe(true);
  expect((await file(grant.id, "data.json")).status).toBe(429);
  await app.request(`/api/artifact-previews/${grant.id}`, { method: "DELETE" });
  for (const response of responses)
    await expect(response.arrayBuffer()).rejects.toThrow("Preview read ended");
  const next = await admit();
  expect(await (await file(next.id, "data.json")).json()).toEqual({
    value: 42,
  });
});

it("charges only range bytes and enforces concurrent admission before filesystem awaits", async () => {
  await writeFile(join(root, "bundle/sparse.bin"), "");
  await truncate(join(root, "bundle/sparse.bin"), 64 * 1024 * 1024);
  const grant = await admit();
  for (let i = 0; i < 6; i++) {
    const response = await app.request(
      `/api/artifact-previews/${grant.id}/file?path=sparse.bin`,
      { headers: { range: "bytes=0-3" } },
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-3/67108864");
    expect((await response.arrayBuffer()).byteLength).toBe(4);
  }
  await writeFile(
    join(root, "bundle/concurrent.bin"),
    new Uint8Array(4 * 1024 * 1024),
  );
  const responses = await Promise.all(
    Array.from({ length: 24 }, () => file(grant.id, "concurrent.bin")),
  );
  expect(responses.filter((response) => response.status === 200)).toHaveLength(
    16,
  );
  expect(responses.filter((response) => response.status === 429)).toHaveLength(
    8,
  );
  for (const response of responses) await response.body?.cancel();
  expect(await (await file(grant.id, "data.json")).json()).toEqual({
    value: 42,
  });
  await app.request(`/api/artifact-previews/${grant.id}`, { method: "DELETE" });
  expect(await (await file(grant.id, "data.json")).json()).toMatchObject({
    reason: "preview-unavailable",
  });
});

it("does not charge cancelled movie promises and retains late seek and 416 metadata", async () => {
  const size = 160 * 1024 * 1024;
  await writeFile(join(root, "bundle/movie.mp4"), "");
  await truncate(join(root, "bundle/movie.mp4"), size);
  const grant = await admit();
  for (let i = 0; i < 10; i++) {
    const response = await app.request(
      `/api/artifact-previews/${grant.id}/file?path=movie.mp4`,
      { headers: { Range: "bytes=0-" } },
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-length")).toBe(String(size));
    const reader = response.body!.getReader();
    expect((await reader.read()).value!.byteLength).toBeGreaterThan(0);
    await reader.cancel();
  }
  const seek = await app.request(
    `/api/artifact-previews/${grant.id}/file?path=movie.mp4`,
    { headers: { Range: "bytes=150000000-150000099" } },
  );
  expect(seek.status).toBe(206);
  expect(seek.headers.get("content-range")).toBe(
    `bytes 150000000-150000099/${size}`,
  );
  expect((await seek.arrayBuffer()).byteLength).toBe(100);
  const invalid = await app.request(
    `/api/artifact-previews/${grant.id}/file?path=movie.mp4`,
    { headers: { Range: "bytes=200000000-" } },
  );
  expect(invalid.status).toBe(416);
  expect(invalid.headers.get("content-range")).toBe(`bytes */${size}`);
});

it("fails a body at the delivered-byte budget and releases all reader slots", async () => {
  previews.close();
  mount(65536);
  await writeFile(join(root, "bundle/movie.mp4"), new Uint8Array(512 * 1024));
  const grant = await admit();
  const response = await file(grant.id, "movie.mp4");
  expect(response.status).toBe(200);
  await expect(response.arrayBuffer()).rejects.toThrow("Preview read ended");
  expect((await file(grant.id, "data.json")).status).toBe(413);
  const fresh = await admit();
  const responses = await Promise.all(
    Array.from({ length: 16 }, () => file(fresh.id, "data.json")),
  );
  expect(responses.every((r) => r.ok)).toBe(true);
  for (const response of responses) await response.body?.cancel();
});
