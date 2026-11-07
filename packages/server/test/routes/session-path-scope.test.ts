import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import {
  PRINCIPAL_VARIABLE,
  type Principal,
} from "../../src/auth/principal.js";
import { createLocalFileRoutes } from "../../src/routes/local-file.js";
import { createLocalImageRoutes } from "../../src/routes/local-image.js";
import { createSessionPathScopeResolver } from "../../src/routes/session-path-scope.js";

const limited: Principal = {
  kind: "limited",
  username: "archer",
  grants: {
    newSessionProjects: [],
    joinProjects: [],
    viewProjects: [],
    joinStaleOffsetMinutes: 0,
    lock: {},
  },
  switched: false,
  locked: true,
  via: "direct",
};

describe("session-scoped local files", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true })),
    );
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "ya-session-path-scope-"));
    roots.push(root);
    const projectPath = join(root, "project");
    const stateRoot = join(root, "session-sandboxes");
    const tempDir = join(stateRoot, "project-abc", "tmp");
    const outside = join(root, "outside");
    await Promise.all([
      mkdir(projectPath, { recursive: true }),
      mkdir(tempDir, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    await writeFile(join(tempDir, "note.txt"), "sandbox tmp\n");
    await writeFile(join(tempDir, "shot.png"), "png");
    await writeFile(join(projectPath, "readme.txt"), "project\n");
    await writeFile(join(outside, "secret.txt"), "host\n");
    const metadata = {
      sandboxed: {
        sandboxLevel: "project-write",
        sandboxStateKey: "project-abc",
        sandboxProjectPath: projectPath,
      },
      plain: { sandboxProjectPath: projectPath },
    } as Record<string, Record<string, string>>;
    const scope = createSessionPathScopeResolver({
      sessionMetadataService: {
        getMetadata: (id: string) => metadata[id] as never,
      },
      sandboxStateRoot: stateRoot,
      // The superuser's host-wide allow-set; the limited user never gets it.
      allowedPaths: () => [outside, projectPath],
      includeProjects: () => false,
    });
    return { projectPath, outside, scope };
  }

  function app(
    scope: ReturnType<typeof createSessionPathScopeResolver>,
    principal: Principal | undefined,
  ) {
    const deps = { allowedPaths: [] as string[], scope };
    const app = new Hono();
    app.use("*", async (c, next) => {
      if (principal) c.set(PRINCIPAL_VARIABLE as never, principal as never);
      await next();
    });
    app.route(
      "/api/sessions/:sessionId/local-file",
      createLocalFileRoutes(deps),
    );
    app.route(
      "/api/sessions/:sessionId/local-image",
      createLocalImageRoutes(deps),
    );
    return app;
  }

  it("reads a sandboxed session's /tmp from its private directory", async () => {
    const { scope } = await fixture();
    for (const principal of [undefined, limited]) {
      const response = await app(scope, principal).request(
        "/api/sessions/sandboxed/local-file?path=/tmp/note.txt",
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("sandbox tmp\n");
      const image = await app(scope, principal).request(
        "/api/sessions/sandboxed/local-image?path=/tmp/shot.png",
      );
      expect(image.status).toBe(200);
    }
  });

  it("confines a limited user to the session's project and sandbox temp", async () => {
    const { scope, outside, projectPath } = await fixture();
    const asLimited = app(scope, limited);
    // The sandbox binds its project at the project's own path, so a project
    // file stays the project's even though this fixture lives under /tmp.
    expect(
      (
        await asLimited.request(
          `/api/sessions/sandboxed/local-file?path=${join(projectPath, "readme.txt")}`,
        )
      ).status,
    ).toBe(200);
    // Outside the project, with no /tmp rerouting in the way, is refused.
    expect(
      (
        await asLimited.request(
          `/api/sessions/plain/local-file?path=${join(outside, "secret.txt")}`,
        )
      ).status,
    ).toBe(403);
    // The superuser keeps the host-wide allow-set through the same door.
    const host = await app(scope, undefined).request(
      `/api/sessions/plain/local-file?path=${join(outside, "secret.txt")}`,
    );
    expect(host.status).toBe(200);
    expect(await host.text()).toBe("host\n");
    // In the sandboxed session that /tmp path is the sandbox's, never the
    // host file behind it.
    const sandboxed = await app(scope, undefined).request(
      `/api/sessions/sandboxed/local-file?path=${join(outside, "secret.txt")}`,
    );
    expect(sandboxed.status).not.toBe(200);
  });

  it("leaves an unsandboxed session's paths as they are", async () => {
    const { scope } = await fixture();
    const response = await app(scope, undefined).request(
      "/api/sessions/plain/local-file?path=/tmp/note.txt",
    );
    expect(response.status).not.toBe(200);
  });

  it("refuses a limited user a session with no project", async () => {
    const { scope } = await fixture();
    const response = await app(scope, limited).request(
      "/api/sessions/unknown/local-file?path=/tmp/note.txt",
    );
    expect(response.status).toBe(404);
  });
});
