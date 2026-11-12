import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { projectServiceSchema } from "@yep-anywhere/shared";
import {
  ProjectServiceManager,
  readProjectService,
  readStaticAddressMode,
  projectServiceStaticEntry,
  projectServiceStaticStamp,
} from "../../src/projects/ProjectServiceManager.js";
import * as sandbox from "../../src/session-sandbox.js";

const artifacts = resolve(import.meta.dirname, "../../../../.artifacts");
await mkdir(artifacts, { recursive: true });
const root = await realpath(
  await mkdtemp(join(artifacts, "project-service-manager-")),
);
const available =
  (
    await sandbox.probeSessionSandboxAvailability({
      stateRoot: join(root, "probe"),
    })
  ).state === "available";
const staticService = {
  version: 1,
  where: { kind: "static", root: "dist", entry: "index.html" },
  serving: { target: "static-root" },
};
const processService = {
  version: 1,
  where: { kind: "process", cwd: ".", entry: "/" },
  start: { argv: [process.execPath, "server.mjs"], portEnv: "PORT" },
  status: {
    probe: "http",
    path: "/health",
    readyStatus: 200,
    startupTimeoutMs: 5000,
  },
  stop: { signal: "SIGTERM", graceMs: 3000 },
  serving: { target: "sandbox-loopback", protocol: "http" },
};
afterAll(() => rm(root, { recursive: true }));

describe("project service ownership", { timeout: 25_000 }, () => {
  let manager: ProjectServiceManager | undefined;
  afterEach(async () => {
    await manager?.close();
    manager = undefined;
    vi.restoreAllMocks();
  });
  async function fixture(service: unknown = staticService) {
    const project = await mkdtemp(join(root, "project-"));
    await mkdir(join(project, ".project-template"));
    await writeFile(
      join(project, ".project-template/app.json"),
      JSON.stringify({ service }),
    );
    return project;
  }

  it("stamps a static app by its newest served file, not hidden or repository files", async () => {
    const project = await fixture();
    await mkdir(join(project, "dist/assets"), { recursive: true });
    await mkdir(join(project, "dist/.cache"));
    await writeFile(join(project, "dist/index.html"), "app");
    await writeFile(join(project, "dist/assets/app.js"), "js");
    await writeFile(join(project, "dist/.cache/x"), "x");
    const at = (seconds: number) => new Date(seconds * 1000);
    await utimes(join(project, "dist/index.html"), at(1000), at(1000));
    await utimes(join(project, "dist/assets/app.js"), at(2000), at(2000));
    await utimes(join(project, "dist/.cache/x"), at(9000), at(9000));
    const declaration = projectServiceSchema.parse(staticService);
    // A rebuilt asset changes the stamp; a hidden cache file does not.
    expect(await projectServiceStaticStamp(project, declaration)).toEqual(
      at(2000),
    );
    // Served from the project root, only the entry counts.
    await writeFile(join(project, "index.html"), "root");
    await utimes(join(project, "index.html"), at(1500), at(1500));
    expect(
      await projectServiceStaticStamp(
        project,
        projectServiceSchema.parse({
          ...staticService,
          where: { ...staticService.where, root: "." },
        }),
      ),
    ).toEqual(at(1500));
  });
  it("reads explicit static declarations and rejects invalid or escaping source files", async () => {
    const project = await fixture();
    expect(await readProjectService(project)).toEqual(staticService);
    await mkdir(join(project, "dist"));
    await writeFile(join(project, "dist/index.html"), "app");
    expect(
      await projectServiceStaticEntry(
        project,
        projectServiceSchema.parse(staticService),
      ),
    ).toBe(join(project, "dist/index.html"));
    await symlink(root, join(project, "outside"));
    await expect(
      projectServiceStaticEntry(
        project,
        projectServiceSchema.parse({
          ...staticService,
          where: { ...staticService.where, root: "outside" },
        }),
      ),
    ).rejects.toThrow();
    await rm(join(project, ".project-template/app.json"));
    await writeFile(
      join(root, "outside.json"),
      JSON.stringify({ service: staticService }),
    );
    await symlink(
      join(root, "outside.json"),
      join(project, ".project-template/app.json"),
    );
    await expect(readProjectService(project)).rejects.toThrow(
      "escapes project",
    );
  });

  it("reads the optional static address mode beside the service declaration", async () => {
    const project = await fixture();
    expect(await readStaticAddressMode(project)).toBe("redirect");
    const declaration = join(project, ".project-template/app.json");
    await writeFile(
      declaration,
      JSON.stringify({ service: staticService, staticAddress: "frame" }),
    );
    expect(await readStaticAddressMode(project)).toBe("frame");
    // The key sits outside the strict service schema, so the declaration
    // itself is unchanged and older servers can ignore it.
    expect(await readProjectService(project)).toEqual(staticService);
    await writeFile(
      declaration,
      JSON.stringify({ service: staticService, staticAddress: "embed" }),
    );
    await expect(readStaticAddressMode(project)).rejects.toThrow();
  });

  it("does not reinterpret old template commands as permission to launch a service", async () => {
    const project = await fixture();
    await writeFile(
      join(project, ".project-template/app.json"),
      JSON.stringify({ kind: "server", start: ["node", "server.mjs"] }),
    );
    expect(await readProjectService(project)).toBeNull();
    manager = new ProjectServiceManager(join(root, "legacy-data"));
    await expect(
      manager.start("legacy", project, async () => {}),
    ).rejects.toThrow("no process service");
  });

  it.each([
    { ...processService, version: 2 },
    { ...processService, start: { argv: [], portEnv: "PORT" } },
    { ...processService, start: { argv: ["node"], portEnv: "NODE_OPTIONS" } },
    {
      ...processService,
      where: { kind: "process", cwd: "../host", entry: "/" },
    },
    {
      ...processService,
      status: { ...processService.status, path: "http://host/" },
    },
    { ...staticService, start: processService.start },
  ])("rejects an unsafe or conflicting declaration %#", (service) => {
    expect(projectServiceSchema.safeParse(service).success).toBe(false);
  });

  const native = available ? it : it.skip;
  native(
    "starts the explicit live preview instead of the static app and retains its mode",
    async () => {
      const project = await fixture(staticService);
      await writeFile(
        join(project, ".project-template/app.json"),
        JSON.stringify({ service: staticService, livePreview: processService }),
      );
      await writeFile(
        join(project, "server.mjs"),
        `import { createServer } from 'node:http'; createServer((_req, res) => res.end('ready')).listen(Number(process.env.PORT), '127.0.0.1');`,
      );
      manager = new ProjectServiceManager(join(root, "live-preview-data"));
      const runtime = await manager.start(
        "live",
        project,
        async () => {},
        "live-preview",
      );
      expect(runtime).toMatchObject({
        mode: "live-preview",
        observed: "running",
        declaration: processService,
      });
      expect(
        (await manager.start("live", project, async () => {}, "live-preview"))
          .generation,
      ).toBe(runtime.generation);
      await manager.stop("live", async () => {});
      expect(await readProjectService(project)).toEqual(staticService);
    },
  );
  native(
    "coalesces starts, rechecks authority, survives provider independence and records stop",
    async () => {
      const project = await fixture(processService);
      await writeFile(
        join(project, "server.mjs"),
        `import { appendFileSync, existsSync, watchFile, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
appendFileSync('starts.txt', 'start\\n');
const server = createServer((_req, res) => {
  if (existsSync('slow')) return;
  res.statusCode = existsSync('unhealthy') ? 503 : 200;
  res.end('ready');
});
server.listen(Number(process.env.PORT), '127.0.0.1');
watchFile('close-listener', { interval: 20 }, () => {
  if (existsSync('close-listener')) server.close(() => writeFileSync('closed', 'yes'));
});
`,
      );
      const data = join(root, "native-data");
      manager = new ProjectServiceManager(data);
      const authorize = vi.fn(async () => {});
      const [first, duplicate] = await Promise.all([
        manager.start("project", project, authorize),
        manager.start("project", project, authorize),
      ]);
      expect(first.observed).toBe("running");
      expect(duplicate.generation).toBe(first.generation);
      expect(await readFile(join(project, "starts.txt"), "utf8")).toBe(
        "start\n",
      );
      expect(authorize).toHaveBeenCalledTimes(3);
      expect(manager.upstream("project")).toMatchObject({
        generation: first.generation,
      });
      await writeFile(join(project, "unhealthy"), "yes");
      expect(
        (await manager.start("project", project, authorize)).generation,
      ).toBe(first.generation);
      await rm(join(project, "unhealthy"));
      await writeFile(join(project, "slow"), "yes");
      expect(
        (await manager.start("project", project, authorize)).generation,
      ).toBe(first.generation);
      await rm(join(project, "slow"));
      await writeFile(join(project, "close-listener"), "yes");
      await expect
        .poll(() => readFile(join(project, "closed"), "utf8").catch(() => ""))
        .toBe("yes");
      expect((await manager.status("project"))?.observed).toBe("running");
      await rm(join(project, "close-listener"));
      const recovered = await manager.start("project", project, authorize);
      expect(recovered.generation).not.toBe(first.generation);
      expect(recovered.observed).toBe("running");
      expect(await readFile(join(project, "starts.txt"), "utf8")).toBe(
        "start\nstart\n",
      );
      const restored = new ProjectServiceManager(data);
      expect(await restored.status("project")).toMatchObject({
        observed: "stopped",
        error: expect.stringContaining("interrupted"),
      });
      expect(restored.upstream("project")).toBeNull();
      await restored.close();
      await expect(
        manager.stop("project", async () => {
          throw new Error("revoked");
        }),
      ).rejects.toThrow("revoked");
      expect(manager.upstream("project")).not.toBeNull();
      expect(await manager.stop("project", authorize)).toMatchObject({
        observed: "stopped",
        desired: "stopped",
      });
      expect(manager.upstream("project")).toBeNull();
      const restarted = new ProjectServiceManager(data);
      expect(await restarted.status("project")).toMatchObject({
        observed: "stopped",
        desired: "stopped",
      });
      await restarted.close();
    },
  );
});
