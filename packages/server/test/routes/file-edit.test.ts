import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  symlink,
  rm,
  chmod,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PRINCIPAL_VARIABLE,
  type Principal,
} from "../../src/auth/principal.js";
import { createFileEditRoutes } from "../../src/routes/file-edit.js";
import { createLocalResourcePathPolicy } from "../../src/routes/local-resource-policy.js";

describe("source editing routes", () => {
  let root: string;
  let file: string;
  let pending = false;
  const create = () =>
    createFileEditRoutes({
      policy: createLocalResourcePathPolicy({
        allowedPaths: [join(root, "project")],
      }),
      scanner: { getProject: async () => null },
      resolveArtifactUrl: async () => file,
      isWritePending: async () => pending,
    });
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "source-edit-"));
    await mkdir(join(root, "project"));
    file = join(root, "project", "section.qmd");
    await writeFile(file, "# Heading\nOriginal text\n");
    pending = false;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const save = (
    app: ReturnType<typeof create>,
    revision: string,
    content: string,
  ) =>
    app.request("/file-edit", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: file, revision, content }),
    });

  it("reads the real source, conditionally saves it, and rejects a second stale save", async () => {
    const app = create();
    const snapshot = await (
      await app.request(`/file-edit?path=${encodeURIComponent(file)}`)
    ).json();
    expect(snapshot.content).toBe("# Heading\nOriginal text\n");
    expect(
      (await save(app, snapshot.revision, "# Changed\nOriginal text\n")).status,
    ).toBe(200);
    expect(await readFile(file, "utf8")).toBe("# Changed\nOriginal text\n");
    expect((await save(app, snapshot.revision, "lost update")).status).toBe(
      409,
    );
    expect(await readFile(file, "utf8")).toContain("Changed");
  });
  it("resolves original source relative to the artifact and checks the allow-set", async () => {
    const app = create();
    const response = await app.request(
      `/file-edit?path=section.qmd&relativeTo=${encodeURIComponent(file)}`,
    );
    expect(response.status).toBe(200);
    await writeFile(join(root, "outside.txt"), "private");
    expect(
      (
        await app.request(
          `/file-edit?path=../outside.txt&relativeTo=${encodeURIComponent(file)}`,
        )
      ).status,
    ).toBe(403);
    await symlink(
      join(root, "outside.txt"),
      join(root, "project", "escape.txt"),
    );
    expect(
      (
        await app.request(
          `/file-edit?path=${encodeURIComponent(join(root, "project", "escape.txt"))}`,
        )
      ).status,
    ).toBe(403);
  });
  it("refuses active tool writes and preserves file mode", async () => {
    const app = create();
    await chmod(file, 0o640);
    const snapshot = await (
      await app.request(`/file-edit?path=${encodeURIComponent(file)}`)
    ).json();
    pending = true;
    expect((await save(app, snapshot.revision, "new")).status).toBe(409);
    pending = false;
    expect((await save(app, snapshot.revision, "new")).status).toBe(200);
    if (process.platform !== "win32")
      expect((await stat(file)).mode & 0o777).toBe(0o640);
  });
  it("rejects binary, invalid UTF-8 and oversized sources", async () => {
    const app = create();
    for (const bytes of [
      Buffer.from([0, 1]),
      Buffer.from([0xff]),
      Buffer.alloc(1024 * 1024 + 1, 65),
    ]) {
      await writeFile(file, bytes);
      expect(
        (await app.request(`/file-edit?path=${encodeURIComponent(file)}`))
          .status,
      ).toBe(bytes.length > 1024 * 1024 ? 413 : 415);
    }
  });
  it("reads large HTML for target selection without making it editable", async () => {
    const app = create();
    const html = join(root, "project", "large.html");
    await writeFile(html, `<p>Mapped report</p>${" ".repeat(2 * 1024 * 1024)}`);
    const response = await app.request(
      `/file-edit?path=${encodeURIComponent(html)}&preview=1`,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).editable).toBe(false);
    expect(
      (await app.request(`/file-edit?path=${encodeURIComponent(html)}`)).status,
    ).toBe(413);
  });
  it("reports a rebuild hook on preview and runs it only after explicit approval", async () => {
    const { ArtifactRebuildService } = await import(
      "../../src/services/ArtifactRebuildService.js"
    );
    const rebuild = new ArtifactRebuildService(join(root, "state"));
    const app = createFileEditRoutes({
      policy: createLocalResourcePathPolicy({
        allowedPaths: [join(root, "project")],
      }),
      scanner: { getProject: async () => null },
      resolveArtifactUrl: async () => file,
      rebuild,
    });
    const artifact = join(root, "project", "report.html");
    const script = join(root, "project", "build.mjs");
    // The build keeps the descriptor comment, so the approval still matches.
    await writeFile(
      script,
      `import { readFileSync, writeFileSync } from "node:fs"; writeFileSync(process.argv[2], readFileSync(process.argv[2], "utf8").replace("Before", "Rebuilt"));`,
    );
    const regenerate = {
      hook: "report",
      registrationVersion: 1,
      proposedRegistration: {
        cwd: join(root, "project"),
        argv: [process.execPath, script, artifact],
        outputs: [artifact],
        timeoutSeconds: 30,
      },
    };
    await writeFile(
      artifact,
      `<!-- ya-artifact:v1 ${JSON.stringify({ regenerate })} --><p>Before</p>`,
    );
    const preview = await (
      await app.request(
        `/file-edit?path=${encodeURIComponent(artifact)}&preview=1`,
      )
    ).json();
    expect(preview.regenerate).toMatchObject({
      hook: "report",
      registered: false,
      matches: false,
    });
    const post = (body: object) =>
      app.request("/file-edit/rebuild", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const refused = await post({ path: artifact, hook: "report" });
    expect(refused.status).toBe(409);
    expect((await refused.json()).regenerate.registered).toBe(false);
    expect(await readFile(artifact, "utf8")).toContain("Before");

    const approved = await post({
      path: artifact,
      hook: "report",
      register: true,
      approved: {
        registrationVersion: 1,
        ...regenerate.proposedRegistration,
      },
    });
    expect(approved.status).toBe(200);
    const result = await approved.json();
    expect(result.ok).toBe(true);
    expect(result.preview.content).toContain("Rebuilt");
    expect(result.regenerate).toMatchObject({
      registered: true,
      matches: true,
    });
    expect((await post({ path: artifact, hook: "other" })).status).toBe(409);
  });
  it("registers only the proposal the user approved, not one written after the preview", async () => {
    const { ArtifactRebuildService } = await import(
      "../../src/services/ArtifactRebuildService.js"
    );
    const rebuild = new ArtifactRebuildService(join(root, "state"));
    const run = vi.spyOn(rebuild, "run");
    const app = createFileEditRoutes({
      policy: createLocalResourcePathPolicy({
        allowedPaths: [join(root, "project")],
      }),
      scanner: { getProject: async () => null },
      resolveArtifactUrl: async () => file,
      rebuild,
    });
    const artifact = join(root, "project", "report.html");
    const marker = join(root, "project", "swapped-command-ran");
    const proposal = (argv: string[]) => ({
      hook: "report",
      registrationVersion: 1,
      proposedRegistration: {
        cwd: join(root, "project"),
        argv,
        outputs: [artifact],
        timeoutSeconds: 30,
      },
    });
    const shown = proposal([process.execPath, "-e", "0"]);
    await writeFile(
      artifact,
      `<!-- ya-artifact:v1 ${JSON.stringify({ regenerate: shown })} --><p>x</p>`,
    );
    const preview = await (
      await app.request(
        `/file-edit?path=${encodeURIComponent(artifact)}&preview=1`,
      )
    ).json();
    // The descriptor changes between the preview read and the approval.
    const swapped = proposal([
      process.execPath,
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`,
    ]);
    await writeFile(
      artifact,
      `<!-- ya-artifact:v1 ${JSON.stringify({ regenerate: swapped })} --><p>x</p>`,
    );
    const post = (body: object) =>
      app.request("/file-edit/rebuild", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const approval = {
      registrationVersion: preview.regenerate.registrationVersion,
      ...preview.regenerate.proposedRegistration,
    };
    for (const body of [
      { path: artifact, hook: "report", register: true, approved: approval },
      { path: artifact, hook: "report", register: true },
    ]) {
      const refused = await post(body);
      expect(refused.status).toBe(409);
      expect((await refused.json()).regenerate).toMatchObject({
        registered: false,
        proposedRegistration: { argv: swapped.proposedRegistration.argv },
      });
    }
    expect(run).not.toHaveBeenCalled();
    await expect(stat(marker)).rejects.toThrow();
    expect((await rebuild.status(artifact, swapped)).registered).toBe(false);
  });
  it("refuses artifact rebuild to a limited principal before registering or running it", async () => {
    const { ArtifactRebuildService } = await import(
      "../../src/services/ArtifactRebuildService.js"
    );
    const rebuild = new ArtifactRebuildService(join(root, "state"));
    const register = vi.spyOn(rebuild, "register");
    const run = vi.spyOn(rebuild, "run");
    const app = new Hono<{
      Variables: Record<typeof PRINCIPAL_VARIABLE, Principal>;
    }>();
    app.use("*", async (c, next) => {
      c.set(PRINCIPAL_VARIABLE, {
        kind: "limited",
        username: "bob",
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
      createFileEditRoutes({
        policy: createLocalResourcePathPolicy({
          allowedPaths: [join(root, "project")],
        }),
        scanner: { getProject: async () => null },
        resolveArtifactUrl: async () => file,
        rebuild,
      }),
    );
    const artifact = join(root, "project", "x.html");
    const marker = join(root, "project", "escaped");
    const regenerate = {
      hook: "h",
      registrationVersion: 1,
      proposedRegistration: {
        cwd: join(root, "project"),
        argv: [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`,
        ],
        outputs: [artifact],
        timeoutSeconds: 30,
      },
    };
    await writeFile(
      artifact,
      `<!-- ya-artifact:v1 ${JSON.stringify({ regenerate })} --><p>x</p>`,
    );
    const response = await app.request("/file-edit/rebuild", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: artifact, hook: "h", register: true }),
    });
    expect(response.status).toBe(403);
    expect(register).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    await expect(stat(marker)).rejects.toThrow();
  });
  it("does not apply source edit middleware to unrelated API routes", async () => {
    const app = create();
    app.get("/other", (c) => c.text("ok"));
    expect(
      (await app.request("/other")).headers.get("Cache-Control"),
    ).toBeNull();
  });
});
