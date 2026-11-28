import type { FileContentResponse } from "@yep-anywhere/shared";
import {
  assertUrlProjectId,
  fromUrlProjectId,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSafeMarkdown } from "../../src/augments/safe-markdown.js";
import { createPublicFileShareRoutes } from "../../src/routes/public-file-shares.js";
import { createPublicSharePublicRoutes } from "../../src/routes/public-shares.js";
import { PublicShareService } from "../../src/services/PublicShareService.js";

// Live file shares require Linux descriptor-bound project reads.
// Other hosts fail closed, covered by projectFileAccess.test.ts.
const itLinux = it.skipIf(process.platform !== "linux");

describe("public file shares", () => {
  let testDir: string;
  let projectRoot: string;
  let projectId: ReturnType<typeof toUrlProjectId>;
  let service: PublicShareService;
  let files: Map<string, string>;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "public-file-routes-"));
    projectRoot = path.join(testDir, "project");
    await fs.mkdir(projectRoot);
    projectId = toUrlProjectId(projectRoot);
    service = new PublicShareService({ dataDir: testDir });
    await service.initialize();
    files = new Map();
    await put(
      "docs/guide.md",
      "# Guide\n\n![Diagram](diagram.svg)\n\n[Details](details.md)\n",
    );
    await put("docs/diagram.svg", '<svg><circle r="4" /></svg>');
    await put("docs/next.svg", '<svg><rect width="4" height="4" /></svg>');
    await put("docs/details.md", "linked document");
    await put("docs/unlinked.svg", "<svg />");
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  /** A project file, written where a share's link walk reads it. */
  async function put(
    relativePath: string,
    content: string,
    root = projectRoot,
  ) {
    const target = path.join(root, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
    if (root === projectRoot) files.set(relativePath, content);
  }

  const fetchProjectFile = async (
    requestedProjectId: string,
    requestedPath: string,
    options: { raw?: boolean; projectRoot?: string },
  ): Promise<Response> => {
    assertUrlProjectId(requestedProjectId);
    const content = options.projectRoot
      ? await fs
          .readFile(path.join(options.projectRoot, requestedPath), "utf8")
          .catch(() => undefined)
      : requestedProjectId === projectId
        ? files.get(requestedPath)
        : await fs
            .readFile(
              path.join(fromUrlProjectId(requestedProjectId), requestedPath),
              "utf8",
            )
            .catch(() => undefined);
    if (content === undefined) {
      return new Response(JSON.stringify({ error: "File not found" }), {
        status: 404,
      });
    }
    if (options.raw) {
      return new Response(content, {
        headers: {
          "Content-Type": requestedPath.endsWith(".svg")
            ? "image/svg+xml"
            : "text/plain",
        },
      });
    }
    const response: FileContentResponse = {
      metadata: {
        path: requestedPath,
        size: Buffer.byteLength(content),
        mimeType: requestedPath.endsWith(".md")
          ? "text/markdown"
          : "image/svg+xml",
        isText: true,
      },
      content,
      rawUrl: `/api/projects/${projectId}/files/raw?path=${encodeURIComponent(
        requestedPath,
      )}`,
    };
    if (requestedPath.endsWith(".md")) {
      // Rendered as the files route renders it, with the read's root as the
      // project its links are relative to.
      const root = options.projectRoot ?? fromUrlProjectId(requestedProjectId);
      response.renderedMarkdownHtml = renderSafeMarkdown(content, {
        localFileBasePath: path.dirname(path.join(root, requestedPath)),
        projectFileLinks: { projectId: requestedProjectId, projectPath: root },
      });
    }
    return new Response(JSON.stringify(response), {
      headers: { "Content-Type": "application/json" },
    });
  };

  it("creates, lists, and revokes an exact live file grant", async () => {
    const app = createPublicFileShareRoutes({
      publicShareService: service,
      fetchProjectFile,
      getPublicSharesEnabled: () => true,
      getRemoteAccessEnabled: () => true,
      getRelayConfig: () => ({
        url: "wss://relay.example/ws",
        username: "example-host",
      }),
      getYaClientBaseUrl: () => "https://ya.example/",
    });

    const createResponse = await app.request("/public-file-shares", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        path: "docs/guide.md",
        title: "Guide",
      }),
    });
    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as {
      createdAt: string;
      shareId: string;
      url: string;
    };
    const publicUrl = new URL(created.url);
    expect(publicUrl.pathname).toMatch(/^\/share\/[A-Za-z0-9_-]{22}\/file$/);
    expect(publicUrl.searchParams.get("h")).toBe("example-host");
    expect(publicUrl.searchParams.get("projectId")).toBe(projectId);
    expect(publicUrl.searchParams.get("path")).toBe("docs/guide.md");
    expect(publicUrl.searchParams.get("standalone")).toBe("1");
    expect(publicUrl.hash).toBe("#v=2&target=file");

    const listResponse = await app.request(
      `/public-file-shares?projectId=${encodeURIComponent(
        projectId,
      )}&path=docs%2Fguide.md`,
    );
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual({
      items: [
        {
          shareId: created.shareId,
          url: created.url,
          title: "Guide",
          createdAt: created.createdAt,
          updatedAt: created.createdAt,
        },
      ],
    });

    const otherPathResponse = await app.request(
      `/public-file-shares?projectId=${encodeURIComponent(
        projectId,
      )}&path=docs%2Fother.md`,
    );
    expect(await otherPathResponse.json()).toEqual({ items: [] });

    const revokeResponse = await app.request(
      `/public-file-shares/${created.shareId}`,
      { method: "DELETE" },
    );
    expect(revokeResponse.status).toBe(200);
    expect(await revokeResponse.json()).toEqual({ revoked: true });
  });

  it("shares an absolute path under the registered project that owns it", async () => {
    const otherRoot = path.join(testDir, "other-project");
    await fs.mkdir(path.join(otherRoot, "build"), { recursive: true });
    await fs.writeFile(path.join(otherRoot, "build", "paper.html"), "<p>x</p>");
    // The existence check reads through the project file fetcher.
    files.set("build/paper.html", "<p>x</p>");
    const app = createPublicFileShareRoutes({
      publicShareService: service,
      fetchProjectFile,
      listProjectRoots: async () => [projectRoot, otherRoot],
      getPublicSharesEnabled: () => true,
      getRemoteAccessEnabled: () => true,
      getRelayConfig: () => ({
        url: "wss://relay.example/ws",
        username: "example-host",
      }),
      getYaClientBaseUrl: () => "https://ya.example/",
    });
    // Viewed from the first project's viewer, the file lives in the other one.
    const created = await app.request("/public-file-shares", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        path: path.join(otherRoot, "build", "paper.html"),
      }),
    });
    expect(created.status).toBe(200);
    const url = new URL(((await created.json()) as { url: string }).url);
    expect(url.searchParams.get("projectId")).toBe(toUrlProjectId(otherRoot));
    expect(url.searchParams.get("path")).toBe("build/paper.html");
    // The list resolves the same way, so the retained link is found again.
    const listed = await app.request(
      `/public-file-shares?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path.join(otherRoot, "build", "paper.html"))}`,
    );
    expect(((await listed.json()) as { items: unknown[] }).items).toHaveLength(
      1,
    );
    // Outside every registered project stays refused.
    const outside = await app.request("/public-file-shares", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        path: path.join(testDir, "stray.html"),
      }),
    });
    expect(outside.status).toBe(400);
    expect(((await outside.json()) as { error: string }).error).toMatch(
      /outside every registered project/,
    );
  });

  itLinux("authorizes only an HTML root's linked files", async () => {
    await put(
      "site/index.html",
      '<link rel="stylesheet" href="site.css"><link rel="preload" as="font" href="paper.woff2"><script src="app.js"></script><script src="/assets/entry.js"></script><img src="logo.png"><a href="src/server.js">source</a><a href="../../outside/notes.md">notes</a>',
    );
    await put("site/site.css", "body{font-family:Paper}");
    await put("site/app.js", "console.log(1)");
    await put("site/assets/entry.js", "console.log(3)");
    await put("site/other.js", "console.log(2)");
    await put("site/src/server.js", "export const shown = 1;");
    await put("site/paper.woff2", "font");
    const outside = path.join(testDir, "outside");
    await put("notes.md", "# Notes\n\n[more](more.md)\n", outside);
    await put("more.md", "more", outside);
    const { secret } = await service.createFileShare({
      projectId,
      path: "site/index.html",
      title: "Site",
      buildPublicUrl: (value) => `https://ya.example/share/${value}/file`,
    });
    const routes = (outsideAllowed: boolean) =>
      createPublicSharePublicRoutes({
        publicShareService: service,
        loadSession: vi.fn(async () => null),
        getPublicSharesEnabled: () => true,
        fetchProjectFile,
        localFilePolicy: {
          resolveAllowedFilePath: async (filePath: string) => {
            const stats = await fs.stat(filePath).catch(() => null);
            return outsideAllowed && stats?.isFile()
              ? { ok: true, file: { resolvedPath: filePath, stats } }
              : { ok: false, error: "Refused", status: 403 };
          },
        },
      });
    const app = routes(true);
    const status = async (path: string, share = app) =>
      (
        await share.request(
          `/${secret}/files/raw?path=${encodeURIComponent(path)}`,
        )
      ).status;
    expect(await status("site/site.css")).toBe(200);
    expect(await status("site/app.js")).toBe(200);
    // A leading slash names the root's directory, as the play page resolves it.
    expect(await status("site/assets/entry.js")).toBe(200);
    // A linked document is served, and so is anything else the root names.
    expect(await status("site/src/server.js")).toBe(200);
    expect(await status("site/paper.woff2")).toBe(200);
    expect(await status("site/other.js")).toBe(404);
    // A link out of the project is a grant too, followed onward, when the
    // local file policy admits its target.
    const notes = path.join(outside, "notes.md");
    const response = await app.request(
      `/${secret}/files/raw?path=${encodeURIComponent(notes)}`,
    );
    expect(await response.text()).toContain("# Notes");
    expect(await status(path.join(outside, "more.md"))).toBe(200);
    // Read with its own folder standing in as the project, an outside
    // document's links come back as absolute local-file links, which the
    // viewer resolves against the share, never against the share's project.
    const view = (await (
      await app.request(`/${secret}/files?path=${encodeURIComponent(notes)}`)
    ).json()) as FileContentResponse;
    expect(view.renderedMarkdownHtml).toContain(
      `href="/api/local-file?path=${encodeURIComponent(path.join(outside, "more.md"))}&amp;render=1"`,
    );
    expect(view.renderedMarkdownHtml).toContain(
      'data-ya-resource="local-file"',
    );
    expect(view.renderedMarkdownHtml).not.toContain("/projects/");
    expect(await status(notes, routes(false))).toBe(404);
  });

  itLinux("serves the current root and what it links to", async () => {
    const { secret } = await service.createFileShare({
      projectId,
      path: "docs/guide.md",
      title: "Guide",
      buildPublicUrl: (value) => `https://ya.example/share/${value}/file`,
    });
    const fetchFile = vi.fn(fetchProjectFile);
    const app = createPublicSharePublicRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () => null),
      getPublicSharesEnabled: () => true,
      fetchProjectFile: fetchFile,
    });

    const rootResponse = await app.request(
      `/${secret}/files?path=docs%2Fguide.md&highlight=true`,
    );
    expect(rootResponse.status).toBe(200);
    expect((await rootResponse.json()).content).toContain("# Guide");

    const linkedAsset = await app.request(
      `/${secret}/files/raw?path=docs%2Fdiagram.svg`,
    );
    expect(linkedAsset.status).toBe(200);
    expect(await linkedAsset.text()).toContain("<circle");

    expect(
      (await app.request(`/${secret}/files/raw?path=docs%2Funlinked.svg`))
        .status,
    ).toBe(404);
    expect(
      (await app.request(`/${secret}/files?path=docs%2Fdetails.md`)).status,
    ).toBe(200);

    // An edit is noticed once the walk's short reuse window has passed.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    await put("docs/guide.md", "# Guide\n\n![Next](next.svg)\n");
    vi.setSystemTime(Date.now() + 3000);
    expect(
      (await app.request(`/${secret}/files/raw?path=docs%2Fdiagram.svg`))
        .status,
    ).toBe(404);
    expect(
      (await app.request(`/${secret}/files/raw?path=docs%2Fnext.svg`)).status,
    ).toBe(200);
  });
});
