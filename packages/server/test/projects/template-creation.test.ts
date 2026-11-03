import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { TemplateSourceService } from "../../src/projects/TemplateSourceService.js";
import { TemplateCreationService } from "../../src/projects/TemplateCreationService.js";
import { runGit } from "../../src/git/gitExec.js";
import { createProjectTemplateRoutes } from "../../src/routes/project-templates.js";
import { Hono } from "hono";
import {
  PRINCIPAL_VARIABLE,
  type Principal,
} from "../../src/auth/principal.js";
import { createApp } from "../setup/create-app.js";
import { MockServerClaudeProvider } from "../../src/sdk/mock.js";
import { ProjectMetadataService } from "../../src/metadata/ProjectMetadataService.js";
import { LimitedUsersService } from "../../src/auth/LimitedUsersService.js";
import { probeSessionSandboxAvailability } from "../../src/session-sandbox.js";
import {
  closeTestDiscoveryDatabases,
  createTestSessionMetadataService,
} from "../utils/session-metadata-database.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ya-template-create-"));
});
afterEach(async () => {
  closeTestDiscoveryDatabases();
  await rm(root, { recursive: true });
});

async function source() {
  const repository = join(root, "source");
  const directory = join(repository, "templates/app");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(repository, "library.json"),
    JSON.stringify({ formatVersion: 1, bases: [], templates: ["app"] }),
  );
  const files = {
    "setup.mjs":
      'import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync("dist"); writeFileSync("dist/index.html", "Ready"); writeFileSync("ready.txt", "Ready"); console.log("setup ran");',
    ".project-template/app.json": JSON.stringify({
      kind: "static",
      dir: "dist",
      setup: [process.execPath, "setup.mjs"],
      build: ["node", "setup.mjs"],
      test: ["node", "setup.mjs"],
      preview: ["node", "setup.mjs"],
      prepare: "PREPARE.md",
    }),
    "PREPARE.md": "Prepare the project without implementing the whole app.",
    ".project-template/icon.svg":
      '<svg xmlns="http://www.w3.org/2000/svg"><title>Original icon</title></svg>',
  };
  const entries = [];
  for (const [to, bytes] of Object.entries(files)) {
    const from = `file-${entries.length}`;
    await writeFile(join(directory, from), bytes);
    entries.push({ from, to });
  }
  await writeFile(
    join(directory, "template.json"),
    JSON.stringify({
      formatVersion: 1,
      kind: "template",
      status: "ready",
      id: "app",
      title: "App",
      description: "Starter",
      extends: [],
      files: entries,
      overrides: [],
    }),
  );
  const service = new TemplateSourceService(join(root, "data"));
  await service.configure({
    enabled: true,
    sources: [{ id: "local", repository, contentPath: "", revision: "HEAD" }],
  });
  await service.waitForRetrieval();
  expect((await service.current()).phase).toBe("ready");
  return service;
}

it("creates and commits a real starter, then dispatches intent once across retries and restart", async () => {
  const sources = await source();
  const data = join(root, "data");
  const service = new TemplateCreationService(data, sources);
  const request = {
    operationId: randomUUID(),
    sourceId: "local",
    templateId: "app",
    path: join(root, "project"),
    name: "Garden",
    intent: "Draw $(touch injected)",
    session: { model: "chosen" },
  };
  let registered = 0;
  let prepared = 0;
  const actions = {
    register: async (path: string) => {
      registered++;
      expect(await readFile(join(path, "ready.txt"), "utf8")).toBe("Ready");
      expect((await runGit(path, ["status", "--porcelain"])).stdout).toBe("");
      return "project-id";
    },
    prepare: async (
      projectId: string,
      message: string,
      settings: Record<string, unknown>,
    ) => {
      prepared++;
      expect(projectId).toBe("project-id");
      expect(message).toContain(request.intent);
      expect(settings).toEqual(request.session);
      return "session-id";
    },
  };
  const repeated = await Promise.all([
    service.start(request, actions),
    service.start(request, actions),
  ]);
  expect(repeated.every((operation) => operation.phase !== "interrupted")).toBe(
    true,
  );
  await service.wait(request.operationId);
  expect(await service.get(request.operationId)).toMatchObject({
    phase: "started",
    sessionId: "session-id",
    log: expect.stringContaining("setup ran"),
  });
  await new TemplateCreationService(data, sources).start(request, actions);
  expect([registered, prepared]).toEqual([1, 1]);
  await expect(
    service.start({ ...request, name: "Different" }, actions),
  ).rejects.toThrow("different request");
});

it("names the limited owner of each started preparation session", async () => {
  const data = join(root, "data");
  const directory = join(data, "project-template-operations");
  await mkdir(directory, { recursive: true });
  const record = (fields: Record<string, unknown>) =>
    JSON.stringify({
      request: {
        operationId: randomUUID(),
        sourceId: "local",
        templateId: "app",
        path: join(root, "project"),
        name: "Garden",
        intent: "Draw",
      },
      log: "",
      ...fields,
    });
  await writeFile(
    join(directory, `${randomUUID()}.json`),
    record({
      phase: "started",
      sessionId: "archer-session",
      ownerUsername: "archer",
    }),
  );
  // The superuser's own creations and ones that never started a session name
  // no owner to restore.
  await writeFile(
    join(directory, `${randomUUID()}.json`),
    record({
      phase: "started",
      sessionId: "owner-session",
      ownerUsername: null,
    }),
  );
  await writeFile(
    join(directory, `${randomUUID()}.json`),
    record({ phase: "failed", ownerUsername: "archer" }),
  );
  const service = new TemplateCreationService(
    data,
    new TemplateSourceService(data),
  );
  expect(await service.startedSessionOwners()).toEqual([
    { sessionId: "archer-session", ownerUsername: "archer" },
  ]);
});

it("revalidates local source edits before allocating any project", async () => {
  const sources = await source();
  await rm(join(root, "source/templates/app/file-0"));
  await expect(sources.creationLibrary()).rejects.toThrow();
});

it("serves ready choices and creates through HTTP without accepting a forged source", async () => {
  const sources = await source();
  const service = new TemplateCreationService(join(root, "data"), sources);
  const dispatched: string[] = [];
  const routes = createProjectTemplateRoutes(
    sources,
    service,
    async (_context, path) => {
      dispatched.push(path);
      return Response.json(
        path === "/api/projects"
          ? { project: { id: "created" } }
          : { sessionId: "prepared" },
      );
    },
  );
  const choices = await routes.request("/project-templates/choices");
  expect(choices.status).toBe(200);
  expect(await choices.json()).toMatchObject({
    enabled: true,
    templates: [{ id: "app", sourceId: "local" }],
  });
  const updatedIcon =
    '<svg xmlns="http://www.w3.org/2000/svg"><title>Updated icon</title></svg>';
  await writeFile(join(root, "source/templates/app/file-3"), updatedIcon);
  const refreshed = await (
    await routes.request("/project-templates/choices")
  ).json();
  expect(refreshed.templates[0].icon).toBe(
    `data:image/svg+xml;base64,${Buffer.from(updatedIcon).toString("base64")}`,
  );
  const request = {
    operationId: randomUUID(),
    sourceId: "forged",
    templateId: "app",
    path: join(root, "http-project"),
    name: "HTTP project",
    intent: "Make it useful",
    session: {},
  };
  const post = (body: unknown) =>
    routes.request("/project-templates/operations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await post(request)).status).toBe(409);
  expect(dispatched).toEqual([]);
  request.sourceId = "local";
  expect((await post(request)).status).toBe(202);
  await service.wait(request.operationId);
  const outcome = await routes.request(
    `/project-templates/operations/${request.operationId}`,
  );
  expect(await outcome.json()).toMatchObject({
    phase: "started",
    projectId: "created",
    sessionId: "prepared",
  });
  expect(dispatched).toEqual([
    "/api/projects",
    "/api/projects/created/session-creations",
    "/api/sessions/prepared/metadata",
  ]);
});

it("denies creation endpoints without an active limited-user grant before reading operation state", async () => {
  const sources = new TemplateSourceService(join(root, "data"));
  const service = new TemplateCreationService(join(root, "data"), sources);
  const app = new Hono<{
    Variables: Record<typeof PRINCIPAL_VARIABLE, Principal>;
  }>();
  app.use("*", async (c, next) => {
    c.set(PRINCIPAL_VARIABLE, {
      kind: "limited",
      username: "reader",
      switched: false,
      locked: true,
      via: "direct",
      grants: {
        newSessionProjects: [],
        joinProjects: [],
        viewProjects: [],
        joinStaleOffsetMinutes: 0,
        lock: {},
      },
    });
    await next();
  });
  app.route(
    "/",
    createProjectTemplateRoutes(sources, service, async () => {
      throw new Error("Must not dispatch");
    }),
  );
  for (const [method, path] of [
    ["GET", "choices"],
    ["POST", "operations"],
    ["GET", `operations/${randomUUID()}`],
  ])
    expect(
      (await app.request(`/project-templates/${path}`, { method })).status,
    ).toBe(403);
});

it("enforces source-qualified grants, owner-only operations and real sandboxed limited-user setup", async () => {
  const sources = await source();
  const outside = join(root, "outside-marker");
  await writeFile(outside, "protected");
  const setupFile = join(root, "source/templates/app/file-0");
  await writeFile(
    setupFile,
    `${await readFile(setupFile, "utf8")}\ntry { writeFileSync(${JSON.stringify(outside)}, "escaped"); } catch { /* A confined write may fail or land in private temporary storage. */ }`,
  );
  const users = new LimitedUsersService({ dataDir: join(root, "users") });
  await users.initialize();
  await users.create({
    username: "archer",
    password: "test-password",
    projectRoot: root,
    templateCreation: {
      mode: "selected",
      templates: [{ sourceId: "local", templateId: "app" }],
    },
    lock: { provider: "claude", model: "locked-model" },
  });
  await users.create({
    username: "other",
    password: "test-password",
    projectRoot: root,
  });
  const service = new TemplateCreationService(join(root, "data"), sources);
  const app = new Hono<{
    Variables: Record<typeof PRINCIPAL_VARIABLE, Principal>;
  }>();
  let username = "archer";
  app.use("*", async (c, next) => {
    c.set(PRINCIPAL_VARIABLE, {
      kind: "limited",
      username,
      via: "direct",
      switched: false,
      locked: true,
      grants: users.getActiveGrants(username)!,
    });
    await next();
  });
  let launches = 0;
  app.route(
    "/",
    createProjectTemplateRoutes(
      sources,
      service,
      async (_context, path, body) => {
        if (path === "/api/projects")
          return Response.json({ project: { id: "owned" } });
        if (path === "/api/sessions/prepared/metadata") {
          expect(body).toEqual({ title: "Make a game" });
          return Response.json({ updated: true });
        }
        launches++;
        expect(body).toMatchObject({
          provider: "claude",
          model: "locked-model",
          sandboxLevel: "project-write",
          sandboxNetworkFirewall: true,
        });
        return Response.json({ sessionId: "prepared" });
      },
      (name) => users.getActiveGrants(name),
    ),
  );
  const choices = await (
    await app.request("/project-templates/choices")
  ).json();
  expect(choices.templates.map((item: { id: string }) => item.id)).toEqual([
    "app",
  ]);
  const request = {
    operationId: randomUUID(),
    sourceId: "local",
    templateId: "app",
    path: join(root, "owned"),
    name: "Owned",
    intent: "Make a game",
    session: {},
  };
  const post = (body: unknown) =>
    app.request("/project-templates/operations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await post({ ...request, sourceId: "forged" })).status).toBe(409);
  expect(
    (await post({ ...request, path: join(root, "../escape") })).status,
  ).toBe(409);
  expect(
    (await post({ ...request, session: { model: "different" } })).status,
  ).toBe(409);
  const firewallOff = await post({
    ...request,
    session: { sandboxNetworkFirewall: false },
  });
  expect(firewallOff.status).toBe(409);
  expect((await firewallOff.json()).error).toContain("network firewall");
  await users.update("archer", {
    templateCreation: { mode: "selected", templates: [] },
  });
  expect(
    (await (await app.request("/project-templates/choices")).json()).templates,
  ).toEqual([]);
  expect((await post(request)).status).toBe(409);
  await users.update("archer", { templateCreation: { mode: "any" } });
  const availability = await probeSessionSandboxAvailability();
  const response = await post(request);
  // Non-Linux hosts refuse admission before creating a sandbox operation.
  if (availability.state === "unsupported-platform") {
    expect(response.status).toBe(409);
    expect(launches).toBe(0);
    expect(await service.get(request.operationId)).toBeNull();
  } else {
    expect(response.status).toBe(202);
    await service.wait(request.operationId);
    const outcome = await service.get(request.operationId);
    if (availability.state === "available") {
      expect(await readFile(outside, "utf8")).toBe("protected");
      expect(outcome, outcome?.error).toMatchObject({
        phase: "started",
        ownerUsername: "archer",
      });
      expect(launches).toBe(1);
      expect(
        await readFile(join(request.path, "dist/index.html"), "utf8"),
      ).toBe("Ready");
    } else {
      expect(outcome).toMatchObject({ phase: "failed" });
      expect(launches).toBe(0);
    }
  }
  username = "other";
  expect(
    (await app.request(`/project-templates/operations/${request.operationId}`))
      .status,
  ).toBe(404);
  expect((await post(request)).status).toBe(
    availability.state === "unsupported-platform" ? 409 : 404,
  );
  await users.update("other", { templateCreation: { mode: "none" } });
  expect((await app.request("/project-templates/choices")).status).toBe(403);
}, 30_000);

it("retains a failed starter and never registers or prepares it on retry", async () => {
  const sources = await source();
  await writeFile(
    join(root, "source/templates/app/file-0"),
    'console.error("setup failure"); process.exit(7);',
  );
  const service = new TemplateCreationService(join(root, "data"), sources);
  const request = {
    operationId: randomUUID(),
    sourceId: "local",
    templateId: "app",
    path: join(root, "failed"),
    name: "Failed",
    intent: "Keep my files",
    session: {},
  };
  const actions = {
    register: async () => {
      throw new Error("Must not register");
    },
    prepare: async () => {
      throw new Error("Must not prepare");
    },
  };
  await service.start(request, actions);
  await service.wait(request.operationId);
  expect(await service.get(request.operationId)).toMatchObject({
    phase: "failed",
    error: "Template setup failed (7)",
    log: expect.stringContaining("setup failure"),
  });
  await writeFile(join(request.path, "keep.txt"), "User work");
  await service.start(request, actions);
  expect(await readFile(join(request.path, "keep.txt"), "utf8")).toBe(
    "User work",
  );
});

it("stops an in-flight setup on shutdown and records an interruption", async () => {
  const sources = await source();
  await writeFile(
    join(root, "source/templates/app/file-0"),
    'console.log("setup waiting"); setInterval(() => {}, 1000);',
  );
  const service = new TemplateCreationService(join(root, "data"), sources);
  const request = {
    operationId: randomUUID(),
    sourceId: "local",
    templateId: "app",
    path: join(root, "stopped"),
    name: "Stopped",
    intent: "Stop setup",
    session: {},
  };
  await service.start(request, {
    register: async () => {
      throw new Error("Must not register");
    },
    prepare: async () => {
      throw new Error("Must not prepare");
    },
  });
  try {
    await expect
      .poll(async () => (await service.get(request.operationId))?.log)
      .toContain("setup waiting");
  } finally {
    await service.close();
  }
  expect(await service.get(request.operationId)).toMatchObject({
    phase: "interrupted",
    error: "Template setup was interrupted",
  });
});

it("wires the production creation route through project registration and session launch", async () => {
  await source();
  const sessionMetadataService = createTestSessionMetadataService(
    join(root, "data"),
  );
  await sessionMetadataService.initialize();
  const projectMetadataService = new ProjectMetadataService({
    dataDir: join(root, "data"),
  });
  await projectMetadataService.initialize();
  const instance = createApp({
    provider: new MockServerClaudeProvider(),
    projectMetadataService,
    sessionMetadataService,
    dataDir: join(root, "data"),
    projectsDir: join(root, "sessions"),
  });
  const request = {
    operationId: randomUUID(),
    sourceId: "local",
    templateId: "app",
    path: join(root, "wired"),
    name: "Wired",
    intent: "Prepare my canvas",
    session: {},
  };
  try {
    const response = await instance.app.request(
      "/api/project-templates/operations",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
          "Accept-Encoding": "gzip",
        },
        body: JSON.stringify(request),
      },
    );
    expect(response.status).toBe(202);
    let result: Record<string, unknown> = {};
    await expect
      .poll(async () => {
        result = await (
          await instance.app.request(
            `/api/project-templates/operations/${request.operationId}`,
          )
        ).json();
        return result.phase;
      })
      .toBe("started");
    expect(result.sessionId).toBeTypeOf("string");
    const saved = sessionMetadataService.creations.get(
      { kind: "superuser" },
      `template-${request.operationId}`,
    )!;
    expect(saved.sessionId).toBe(result.sessionId);
    expect(saved.request?.message).toContain(request.intent);
    expect(saved.context.source).toMatchObject({
      kind: "request",
      provenance: { surface: "api" },
    });
    expect(sessionMetadataService.creations.listProjections()).toHaveLength(1);
    const project = await (
      await instance.app.request(`/api/projects/${result.projectId}`)
    ).json();
    expect(project.project).toMatchObject({
      name: "Wired",
      path: await realpath(request.path),
    });
    expect(await readFile(join(request.path, "dist/index.html"), "utf8")).toBe(
      "Ready",
    );
  } finally {
    for (const process of instance.supervisor.getAllProcesses())
      await process.abort();
    await instance.disposeSessionReaders();
  }
});
