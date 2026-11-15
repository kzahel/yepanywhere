import { mkdtemp, rm, writeFile, unlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, expect, it } from "vitest";
import {
  PRINCIPAL_VARIABLE,
  SUPERUSER,
  type Principal,
} from "../../src/auth/principal.js";
import { createCliInstallationRoutes } from "../../src/routes/cli-installations.js";
import { CliInstallationService } from "../../src/services/CliInstallationService.js";
import { ServerSettingsService } from "../../src/services/ServerSettingsService.js";
import { setCliInstallationService } from "../../src/sdk/cli-installation-context.js";

const roots: string[] = [];
afterEach(async () => {
  setCliInstallationService(undefined);
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("protects server paths and persists an explicit missing choice without falling back", async () => {
  const root = await mkdtemp(join(tmpdir(), "ya-cli-route-"));
  roots.push(root);
  const binary = join(root, "codex");
  await writeFile(binary, "fixture");
  const settings = new ServerSettingsService({ dataDir: root });
  await settings.initialize();
  let probes = 0;
  let managed = false;
  const service = new CliInstallationService(
    root,
    [
      {
        family: "codex",
        installationFamily: "codex-cli",
        probeRevision: "route-test",
        contextKey: () => "controlled",
        discover: async (explicit) => [
          {
            path: explicit ?? binary,
            launch: { command: explicit ?? binary, args: [] },
            source: "fixture",
            watchPaths: [],
            ...(!(await stat(explicit ?? binary).catch(() => null))
              ? { error: "Selected executable no longer exists" }
              : {}),
          },
        ],
        verify: async () => {
          probes++;
        },
      },
    ],
    () => settings.getSetting("cliInstallations") ?? {},
    () => (managed ? { codex: binary } : {}),
  );
  setCliInstallationService(service);
  const app = new Hono<{
    Variables: Record<typeof PRINCIPAL_VARIABLE, Principal>;
  }>();
  app.use("*", async (c, next) => {
    if (c.req.header("X-Test-Admin")) c.set(PRINCIPAL_VARIABLE, SUPERUSER);
    await next();
  });
  app.route("/installations", createCliInstallationRoutes(settings));
  const request = (path: string, init?: RequestInit) =>
    app.request(`/installations/codex${path}`, {
      ...init,
      headers: { "X-Test-Admin": "yes", "Content-Type": "application/json" },
    });
  expect((await app.request("/installations/codex")).status).toBe(403);
  expect((await request("")).status).toBe(200);
  expect(probes).toBe(0);
  expect(
    (
      await request("", {
        method: "PUT",
        body: JSON.stringify({ path: "relative/codex" }),
      })
    ).status,
  ).toBe(400);
  const selected = await request("", {
    method: "PUT",
    body: JSON.stringify({ path: binary }),
  });
  expect(selected.status).toBe(200);
  expect(
    (await selected.json()).candidates.find(
      (candidate: { selected: boolean }) => candidate.selected,
    ).verification,
  ).toBe("verified");
  expect(probes).toBe(1);
  expect((await request("/rescan", { method: "POST" })).status).toBe(200);
  expect(probes).toBe(1);
  const reopened = new ServerSettingsService({ dataDir: root });
  await reopened.initialize();
  expect(reopened.getSetting("cliInstallations")).toEqual({ codex: binary });
  await unlink(binary);
  const missing = await (await request("")).json();
  expect(missing.selection).toBe(binary);
  expect(missing.candidates[0].selected).toBe(true);
  const savedBroken = await (
    await request("", { method: "PUT", body: JSON.stringify({ path: binary }) })
  ).json();
  expect(savedBroken.error).toContain("no longer exists");
  expect(savedBroken.selection).toBe(binary);
  const tested = await (await request("/test", { method: "POST" })).json();
  expect(tested.error).toContain("no longer exists");
  expect(probes).toBe(1);
  managed = true;
  expect(
    (await request("", { method: "PUT", body: JSON.stringify({ path: null }) }))
      .status,
  ).toBe(409);
});
