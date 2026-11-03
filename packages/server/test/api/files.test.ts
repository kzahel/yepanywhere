import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileContentResponse } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../setup/create-app.js";
import { canonicalizeProjectPath } from "../../src/projects/paths.js";
import {
  __test__ as projectPathIndexTest,
  getProjectPathIndex,
  type PathIndexIo,
} from "../../src/projects/projectPathIndex.js";
import {
  initFileAccess,
  updateFileAccess,
} from "../../src/middleware/file-access.js";
import { ScriptedClaudeProvider } from "../support/scripted-provider.js";
import { encodeProjectId } from "../../src/supervisor/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function primeProjectFiles(
  projectPath: string,
  relativePaths: readonly string[],
): Promise<void> {
  const index = await getProjectPathIndex(projectPath);
  try {
    // macOS may deliver fixture-creation events after fs.watch attaches. Let
    // that valid invalidation settle, then rebuild the known-only facts the
    // response under test is meant to consume.
    await index.findExisting(relativePaths);
    await new Promise((resolve) =>
      setTimeout(resolve, process.platform === "darwin" ? 100 : 10),
    );
    await index.findExisting(relativePaths);
  } finally {
    index.release();
  }
}

describe("Files API", () => {
  let mockSdk: ScriptedClaudeProvider;
  let testDir: string;
  let projectId: string;
  let projectPath: string;

  beforeEach(async () => {
    mockSdk = new ScriptedClaudeProvider();

    // Create temp directory structure with a valid project
    testDir = join(await realpath(tmpdir()), `claude-test-${randomUUID()}`);
    projectPath = canonicalizeProjectPath(join(testDir, "myproject"));
    projectId = encodeProjectId(projectPath);
    const encodedPath = projectPath.replace(/[/\\:]/g, "-");

    // Create project directory
    await mkdir(projectPath, { recursive: true });

    // Create sessions directory for project discovery
    const sessionsDir = join(testDir, "sessions", "localhost", encodedPath);
    await mkdir(sessionsDir, { recursive: true });

    // Session file must include cwd field for project path discovery
    await writeFile(
      join(sessionsDir, "sess-existing.jsonl"),
      `{"type":"user","cwd":"${projectPath}","message":{"content":"Hello"}}\n`,
    );

    // Create test files in project
    await mkdir(join(projectPath, "src"), { recursive: true });
    await writeFile(
      join(projectPath, "README.md"),
      "# Test Project\n\nThis is a test.",
    );
    await mkdir(join(projectPath, "docs", "assets"), { recursive: true });
    await writeFile(join(projectPath, "docs", "peer.md"), "# Peer");
    await writeFile(
      join(projectPath, "docs", "guide.md"),
      "# Guide\n\n[Peer](peer.md)\n\n![Diagram](assets/diagram.svg)",
    );
    await writeFile(
      join(projectPath, "docs", "assets", "diagram.svg"),
      "<svg></svg>",
    );
    await writeFile(
      join(projectPath, "src", "index.ts"),
      'console.log("Hello, world!");',
    );
    await writeFile(join(projectPath, "data.json"), '{"key": "value"}');

    // Create a binary-like file (small PNG header)
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    await writeFile(join(projectPath, "image.png"), pngHeader);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("GET /api/projects/:projectId/files", () => {
    it("returns file metadata and content for text file", async () => {
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=README.md`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.metadata.path).toBe("README.md");
      expect(json.metadata.mimeType).toBe("text/markdown");
      expect(json.metadata.isText).toBe(true);
      expect(json.metadata.size).toBeGreaterThan(0);
      expect(json.content).toBe("# Test Project\n\nThis is a test.");
      expect(json.rawUrl).toContain("/api/projects/");
      expect(json.rawUrl).toContain("/files/raw?path=README.md");
    });

    it("links paths relative to the viewed file directory", async () => {
      await mkdir(join(projectPath, "configs", "input"), { recursive: true });
      await writeFile(
        join(projectPath, "configs", "input", "request.txt"),
        "request",
      );
      await writeFile(
        join(projectPath, "configs", "regtest.yml"),
        "input: $ROOT/input/request.txt\nreadme: README.md\n",
      );
      await primeProjectFiles(projectPath, [
        "configs/input/request.txt",
        "README.md",
      ]);
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=configs%2Fregtest.yml&highlight=true`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.highlightedHtml).toContain(
        `data-ya-path="${join(projectPath, "configs", "input", "request.txt")}"`,
      );
      expect(json.highlightedHtml).toContain(">$ROOT/input/request.txt</a>");
      expect(json.highlightedHtml).toContain(
        `data-ya-path="${join(projectPath, "README.md")}"`,
      );
    });

    it("returns rendered text before cold path discovery settles", async () => {
      await writeFile(
        join(projectPath, "manifest.yml"),
        "artifact: src/index.ts\n",
      );
      const probeStarted = deferred<void>();
      const releaseProbe = deferred<void>();
      const blockProbe = async () => {
        probeStarted.resolve();
        await releaseProbe.promise;
      };
      const io: PathIndexIo = {
        async lstat(path) {
          await blockProbe();
          return lstat(path);
        },
        async readdir(path) {
          await blockProbe();
          return readdir(path, { withFileTypes: true });
        },
        watch(path, listener) {
          return watch(path, { persistent: false }, (event, filename) =>
            listener(event, filename),
          );
        },
      };
      const heldIndex = projectPathIndexTest.claimIndex(projectPath, { io });
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });
      let response: Response | undefined;
      const responsePromise = app
        .request(
          `/api/projects/${projectId}/files?path=manifest.yml&highlight=true`,
        )
        .then((resolved) => {
          response = resolved;
          return resolved;
        });

      try {
        await probeStarted.promise;
        expect(response).toBeDefined();
      } finally {
        releaseProbe.resolve();
        heldIndex.release();
      }

      const resolvedResponse = await responsePromise;
      expect(resolvedResponse.status).toBe(200);
      const json = (await resolvedResponse.json()) as FileContentResponse;
      expect(json.content).toBe("artifact: src/index.ts\n");
      expect(json.highlightedHtml).toBeDefined();
    });

    it("links relative paths from an allowed file outside the project", async () => {
      const externalRoot = join(testDir, "external-files");
      const configDir = join(externalRoot, "config");
      const modelsDir = join(externalRoot, "models");
      const viewedFile = join(configDir, "XMTConfig.yml");
      const basisFile = join(configDir, "basis.yml");
      const modelFile = join(modelsDir, "boundary-refiner.onnx");
      await mkdir(configDir, { recursive: true });
      await mkdir(modelsDir, { recursive: true });
      await writeFile(basisFile, "basis");
      await writeFile(modelFile, "model");
      await writeFile(
        viewedFile,
        "basis: basis.yml\nmodel: ../models/boundary-refiner.onnx\n" +
          "action: call\n",
      );
      initFileAccess({
        uploadsDir: join(testDir, "uploads"),
        homeDir: join(testDir, "home"),
        tempPaths: [],
        envPaths: [externalRoot],
      });

      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });
      const coldRes = await app.request(
        `/api/projects/${projectId}/files?path=${encodeURIComponent(viewedFile)}&highlight=true`,
      );

      expect(coldRes.status).toBe(200);
      const coldJson = (await coldRes.json()) as FileContentResponse;
      expect(coldJson.content).toContain("basis: basis.yml");

      let json = coldJson;
      await expect
        .poll(
          async () => {
            const res = await app.request(
              `/api/projects/${projectId}/files?path=${encodeURIComponent(viewedFile)}&highlight=true`,
            );
            expect(res.status).toBe(200);
            json = (await res.json()) as FileContentResponse;
            return json.highlightedHtml;
          },
          { interval: 10, timeout: 2_000 },
        )
        .toContain(`path=${encodeURIComponent(basisFile)}`);
      expect(json.highlightedHtml).toContain(
        `path=${encodeURIComponent(basisFile)}`,
      );
      expect(json.highlightedHtml).toContain(">basis.yml</a>");
      expect(json.highlightedHtml).toContain(
        `path=${encodeURIComponent(modelFile)}`,
      );
      expect(json.highlightedHtml).toContain(
        ">../models/boundary-refiner.onnx</a>",
      );
      expect(json.highlightedHtml).not.toContain(">call</a>");
    });

    it("keeps file reads independent of provider inventory refreshes", async () => {
      const { app } = createApp({
        codexSessionsDir: join(testDir, "codex-sessions"),
        geminiSessionsDir: join(testDir, "gemini-sessions"),
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
        projectScanCacheTtlMs: 0,
      });

      const initial = await app.request(
        `/api/projects/${projectId}/files?path=README.md`,
      );
      expect(initial.status).toBe(200);

      await rm(join(testDir, "sessions"), { recursive: true });

      const inline = await app.request(
        `/api/projects/${projectId}/files?path=README.md`,
      );
      expect(inline.status).toBe(200);
      const json = (await inline.json()) as FileContentResponse;
      expect(json.content).toBe("# Test Project\n\nThis is a test.");

      const raw = await app.request(
        `/api/projects/${projectId}/files/raw?path=README.md`,
      );
      expect(raw.status).toBe(200);
      await expect(raw.text()).resolves.toBe(
        "# Test Project\n\nThis is a test.",
      );
    });

    it("renders Markdown previews with relative project media resolved", async () => {
      await primeProjectFiles(projectPath, ["docs/peer.md"]);
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=docs/guide.md&highlight=true`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      const diagramPath = await realpath(
        join(projectPath, "docs", "assets", "diagram.svg"),
      );
      expect(json.renderedMarkdownHtml).toContain(
        '<h1 id="user-content-guide">Guide</h1>',
      );
      expect(json.renderedMarkdownHtml).toContain(
        `href="/projects/${projectId}/file?path=docs%2Fpeer.md"`,
      );
      expect(json.renderedMarkdownHtml).not.toContain(
        "data-ya-private-project-file-link",
      );
      expect(json.renderedMarkdownHtml).toContain(
        `data-media-path="${diagramPath}"`,
      );
      expect(json.embeddedMedia?.[diagramPath]).toEqual({
        data: Buffer.from("<svg></svg>").toString("base64"),
        mimeType: "image/svg+xml",
      });
      expect(json.embeddedMedia?.["docs/assets/diagram.svg"]).toEqual(
        json.embeddedMedia?.[diagramPath],
      );
    });

    it("renders Quarto includes as contained project FileViewer links", async () => {
      await mkdir(join(projectPath, "shared"), { recursive: true });
      await writeFile(join(projectPath, "docs", "_introduction.qmd"), "Intro");
      await writeFile(join(projectPath, "shared", "_methods.md"), "Methods");
      await writeFile(
        join(projectPath, "docs", "report.qmd"),
        [
          "# Report",
          "",
          "{{< include _introduction.qmd >}}",
          "",
          "{{< include /shared/_methods.md >}}",
        ].join("\n"),
      );
      await primeProjectFiles(projectPath, [
        "docs/_introduction.qmd",
        "shared/_methods.md",
      ]);
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=docs/report.qmd&highlight=true`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.metadata.mimeType).toBe("text/markdown");
      expect(json.highlightedLanguage).toBe("markdown");
      expect(json.renderedMarkdownHtml).toContain(
        `href="/projects/${projectId}/file?path=docs%2F_introduction.qmd"`,
      );
      expect(json.renderedMarkdownHtml).toContain(
        `href="/projects/${projectId}/file?path=shared%2F_methods.md"`,
      );
      expect(json.renderedMarkdownHtml).not.toContain(
        "data-ya-private-project-file-link",
      );
    });

    it("embeds the resolved SVG for an extensionless document image", async () => {
      const svg = '<svg width="320" height="180"></svg>';
      await writeFile(
        join(projectPath, "docs", "extensionless.md"),
        "# Figures\n\n![Frontier](assets/frontier)",
      );
      await writeFile(join(projectPath, "docs", "assets", "frontier.svg"), svg);
      await writeFile(
        join(projectPath, "docs", "assets", "frontier.png"),
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      );
      await primeProjectFiles(projectPath, ["docs/assets/frontier.svg"]);
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=docs/extensionless.md&highlight=true`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      const svgPath = await realpath(
        join(projectPath, "docs", "assets", "frontier.svg"),
      );
      expect(json.renderedMarkdownHtml).toContain(
        `data-media-path="${svgPath}"`,
      );
      expect(json.renderedMarkdownHtml).not.toContain("frontier.png");
      expect(json.embeddedMedia?.[svgPath]).toEqual({
        data: Buffer.from(svg).toString("base64"),
        mimeType: "image/svg+xml",
      });
    });

    it("wraps requested Markdown preview line ranges", async () => {
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=docs/guide.md&highlight=true&line=1&lineEnd=3`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.renderedMarkdownHtml).toContain(
        'class="markdown-preview-line-boundary markdown-preview-line-boundary-start" data-line="1"',
      );
      expect(json.renderedMarkdownHtml).toContain(
        'class="markdown-preview-span markdown-preview-span-start" data-line-start="1" data-line-end="3"',
      );
      expect(json.renderedMarkdownHtml).toContain(
        'class="markdown-preview-line-boundary markdown-preview-line-boundary-end" data-line="3"',
      );
    });

    it("snaps split Markdown preview ranges to block boundaries", async () => {
      await writeFile(
        join(projectPath, "docs", "list.md"),
        "# Snap\n\n- first\n- selected\n- last\n\nTail",
      );
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=docs/list.md&highlight=true&line=4&lineEnd=4`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.renderedMarkdownHtml).toContain(
        'class="markdown-preview-span markdown-preview-span-start" data-line-start="3" data-line-end="5"',
      );
      expect(json.renderedMarkdownHtml).toContain("<li>first</li>");
      expect(json.renderedMarkdownHtml).toContain("<li>selected</li>");
      expect(json.renderedMarkdownHtml).toContain("<li>last</li>");
    });

    it("keeps Markdown reference definitions available in range previews", async () => {
      await writeFile(
        join(projectPath, "docs", "references.md"),
        "See [Peer][peer]\n\nContext\n\n[peer]: peer.md",
      );
      await primeProjectFiles(projectPath, ["docs/peer.md"]);
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=docs/references.md&highlight=true&view=range&line=1&lineEnd=1`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.content).toBe("See [Peer][peer]");
      expect(json.renderedMarkdownHtml).toContain(
        'class="markdown-preview-span markdown-preview-span-start" data-line-start="1" data-line-end="1"',
      );
      expect(json.renderedMarkdownHtml).toContain(
        `href="/projects/${projectId}/file?path=docs%2Fpeer.md"`,
      );
    });

    it("uses bounded Markdown context for large range previews", async () => {
      await writeFile(
        join(projectPath, "docs", "large-references.md"),
        [
          "See [Peer][peer]",
          "",
          "[peer]: peer.md",
          "",
          "tail\n".repeat(240_000),
        ].join("\n"),
      );
      await primeProjectFiles(projectPath, ["docs/peer.md"]);
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=docs/large-references.md&highlight=true&view=range&line=1&lineEnd=1`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.content).toBe("See [Peer][peer]");
      expect(json.renderedMarkdownHtml).toContain(
        `href="/projects/${projectId}/file?path=docs%2Fpeer.md"`,
      );
    });

    it("returns file metadata and content for TypeScript file", async () => {
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=src/index.ts`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.metadata.path).toBe("src/index.ts");
      expect(json.metadata.mimeType).toBe("text/typescript");
      expect(json.metadata.isText).toBe(true);
      expect(json.content).toBe('console.log("Hello, world!");');
    });

    it("returns file metadata without content for binary file", async () => {
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=image.png`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.metadata.path).toBe("image.png");
      expect(json.metadata.mimeType).toBe("image/png");
      expect(json.metadata.isText).toBe(false);
      expect(json.content).toBeUndefined();
      expect(json.rawUrl).toContain("image.png");
    });

    it("sniffs unknown-extension UTF-8 files as displayable text", async () => {
      await writeFile(join(projectPath, "job.output"), "alpha\nbeta\ngamma\n");
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=job.output&highlight=true`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.metadata.path).toBe("job.output");
      expect(json.metadata.mimeType).toBe("application/octet-stream");
      expect(json.metadata.isText).toBe(true);
      expect(json.content).toBe("alpha\nbeta\ngamma\n");
    });

    it("returns requested ranges for unknown-extension text files", async () => {
      await writeFile(
        join(projectPath, "task.stdout"),
        ["one", "two", "three", "four"].join("\n"),
      );
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=task.stdout&line=2&lineEnd=3&view=range&highlight=true`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.metadata.mimeType).toBe("application/octet-stream");
      expect(json.metadata.isText).toBe(true);
      expect(json.content).toBe("two\nthree");
      expect(json.contentStartLine).toBe(2);
      expect(json.contentEndLine).toBe(3);
      expect(json.contentTotalLines).toBe(4);
      expect(json.contentTruncated).toBe(true);
    });

    it("keeps unknown-extension binary files out of text preview", async () => {
      await writeFile(
        join(projectPath, "artifact.output"),
        Buffer.from([0, 1, 2, 3, 4, 5]),
      );
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=artifact.output`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.metadata.mimeType).toBe("application/octet-stream");
      expect(json.metadata.isText).toBe(false);
      expect(json.content).toBeUndefined();
    });

    it("returns 400 for missing path parameter", async () => {
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(`/api/projects/${projectId}/files`);

      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("Missing path parameter");
    });

    it("returns 400 for invalid project ID format", async () => {
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        "/api/projects/invalid!project/files?path=README.md",
      );

      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("Invalid project ID format");
    });

    it("returns 404 for non-existent project", async () => {
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const fakeProjectId = encodeProjectId("/nonexistent/project");
      const res = await app.request(
        `/api/projects/${fakeProjectId}/files?path=README.md`,
      );

      expect(res.status).toBe(404);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("Project not found");
    });

    it("returns 404 for non-existent file", async () => {
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=nonexistent.txt`,
      );

      expect(res.status).toBe(404);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("File not found");
    });

    it("returns 400 for path traversal attempt with ..", async () => {
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=../../../etc/passwd`,
      );

      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("Invalid file path");
    });

    it("serves an absolute path inside an allowed (project) prefix", async () => {
      // Projects are in the default file-access allow-set, so an absolute path
      // that resolves inside a scanned project still opens.
      const inProjectFile = join(projectPath, "abs-notes.txt");
      await writeFile(inProjectFile, "in-project notes");

      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=${encodeURIComponent(inProjectFile)}`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.content).toBe("in-project notes");
    });

    it("denies an absolute path outside the file-access allow-set", async () => {
      // Secure default: out-of-project absolute paths are no longer served over
      // HTTP unless the folder is added to the file-access allow-set.
      const outsideDir = join(testDir, "outside");
      const outsideFile = join(outsideDir, "notes.txt");
      await mkdir(outsideDir, { recursive: true });
      await writeFile(outsideFile, "outside notes");

      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=${encodeURIComponent(outsideFile)}`,
      );

      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("Invalid file path");
    });

    it("serves an app-data project attachment path", async () => {
      const dataDir = join(testDir, "data");
      const attachmentDir = join(
        dataDir,
        "projects",
        "0123456789abcdef0123456789abcdef",
        "attachments",
        "session-a",
      );
      const attachmentFile = join(attachmentDir, "photo.png");
      await mkdir(attachmentDir, { recursive: true });
      await writeFile(attachmentFile, "png-bytes");
      initFileAccess({
        uploadsDir: join(dataDir, "uploads"),
        homeDir: "/home/me",
        tempPaths: [],
        envPaths: null,
        appDataProjectsDir: join(dataDir, "projects"),
      });
      updateFileAccess({
        projects: true,
        uploads: false,
        temp: false,
        home: false,
        custom: [],
      });

      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=${encodeURIComponent(attachmentFile)}`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.metadata.mimeType).toBe("image/png");
      expect(json.metadata.isText).toBe(false);
    });

    it.skipIf(process.platform === "win32")(
      "returns 400 for symlink escaping project root",
      async () => {
        const outsideDir = join(testDir, "outside");
        const outsideFile = join(outsideDir, "secret.txt");
        const linkPath = join(projectPath, "outside-link.txt");
        await mkdir(outsideDir, { recursive: true });
        await writeFile(outsideFile, "outside secret");
        await symlink(outsideFile, linkPath);

        const { app } = createApp({
          provider: mockSdk,
          projectsDir: join(testDir, "sessions"),
        });

        const res = await app.request(
          `/api/projects/${projectId}/files?path=outside-link.txt`,
        );

        expect(res.status).toBe(400);
        const json = (await res.json()) as { error: string };
        expect(json.error).toBe("Invalid file path");
      },
    );

    it("returns 400 for directory path", async () => {
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=src`,
      );

      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("Path is not a file");
    });

    it("handles paths with dots correctly", async () => {
      // Create a file with dots in path
      await writeFile(join(projectPath, ".env"), "SECRET=value");

      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=.env`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.metadata.path).toBe(".env");
      expect(json.content).toBe("SECRET=value");
    });
  });

  describe("GET /api/projects/:projectId/files/raw", () => {
    it("serves a requested byte range so media can seek", async () => {
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files/raw?path=README.md`,
        { headers: { Range: "bytes=2-5" } },
      );

      expect(res.status).toBe(206);
      expect(res.headers.get("Content-Range")).toBe("bytes 2-5/31");
      expect(res.headers.get("Accept-Ranges")).toBe("bytes");
      await expect(res.text()).resolves.toBe("Test");
    });

    it("returns raw text file with correct content-type", async () => {
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files/raw?path=README.md`,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/markdown");
      expect(res.headers.get("Content-Disposition")).toContain("README.md");
      expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
      expect(res.headers.get("ETag")).toMatch(/^W\/"/);
      expect(res.headers.get("Last-Modified")).not.toBeNull();
      const text = await res.text();
      expect(text).toBe("# Test Project\n\nThis is a test.");

      const unchanged = await app.request(
        `/api/projects/${projectId}/files/raw?path=README.md`,
        { headers: { "If-None-Match": res.headers.get("ETag") ?? "" } },
      );
      expect(unchanged.status).toBe(304);
      expect(unchanged.headers.get("Content-Length")).toBeNull();
    });

    it("returns raw TypeScript file with correct content-type", async () => {
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files/raw?path=src/index.ts`,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/typescript");
      const text = await res.text();
      expect(text).toBe('console.log("Hello, world!");');
    });

    it("returns raw JSON with its content-type", async () => {
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files/raw?path=data.json`,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      expect(await res.text()).toBe('{"key": "value"}');
    });

    it("returns raw binary file with correct content-type", async () => {
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files/raw?path=image.png`,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/png");
      const buffer = await res.arrayBuffer();
      expect(buffer.byteLength).toBe(8);
    });

    it("streams a sparse file larger than the public relay limit over direct HTTP", async () => {
      const sparsePath = join(projectPath, "large-sparse.bin");
      const sparseSize = 8 * 1024 * 1024 + 1;
      await writeFile(sparsePath, "");
      await truncate(sparsePath, sparseSize);
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files/raw?path=large-sparse.bin`,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Length")).toBe(String(sparseSize));
      await res.body?.cancel();
    });

    it("sets attachment disposition when download=true", async () => {
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files/raw?path=README.md&download=true`,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Disposition")).toContain("attachment");
      expect(res.headers.get("Content-Disposition")).toContain("README.md");
    });

    it("sets inline disposition by default", async () => {
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files/raw?path=README.md`,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Disposition")).toContain("inline");
    });

    it.each([
      ["proof.html", "text/html"],
      ["proof.svg", "image/svg+xml"],
      ["proof.xml", "application/xml"],
    ])(
      "forces active %s content to download with scriptless headers",
      async (filename, contentType) => {
        await writeFile(
          join(projectPath, filename),
          '<script>fetch("/api/processes", { headers: { "X-Yep-Anywhere": "true" } })</script>',
        );
        const { app } = createApp({
          provider: mockSdk,
          projectsDir: join(testDir, "sessions"),
        });

        const res = await app.request(
          `/api/projects/${projectId}/files/raw?path=${filename}`,
        );

        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toBe(contentType);
        expect(res.headers.get("Content-Disposition")).toContain("attachment");
        expect(res.headers.get("Content-Security-Policy")).toContain(
          "script-src 'none'",
        );
        expect(res.headers.get("Permissions-Policy")).toContain("camera=()");
        expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
        expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      },
    );

    it("serves raw content for an absolute path inside an allowed prefix", async () => {
      const inProjectFile = join(projectPath, "abs-raw-notes.txt");
      await writeFile(inProjectFile, "in-project raw notes");

      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files/raw?path=${encodeURIComponent(inProjectFile)}`,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/plain");
      expect(await res.text()).toBe("in-project raw notes");
    });

    it("denies raw content for an absolute path outside the allow-set", async () => {
      const outsideDir = join(testDir, "outside");
      const outsideFile = join(outsideDir, "raw-notes.txt");
      await mkdir(outsideDir, { recursive: true });
      await writeFile(outsideFile, "outside raw notes");

      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files/raw?path=${encodeURIComponent(outsideFile)}`,
      );

      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("Invalid file path");
    });

    it("returns 400 for path traversal attempt", async () => {
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files/raw?path=../../../etc/passwd`,
      );

      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("Invalid file path");
    });

    it.skipIf(process.platform === "win32")(
      "returns 400 for symlink escaping project root",
      async () => {
        const outsideDir = join(testDir, "outside");
        const outsideFile = join(outsideDir, "secret.txt");
        const linkPath = join(projectPath, "outside-link.txt");
        await mkdir(outsideDir, { recursive: true });
        await writeFile(outsideFile, "outside secret");
        await symlink(outsideFile, linkPath);

        const { app } = createApp({
          provider: mockSdk,
          projectsDir: join(testDir, "sessions"),
        });

        const res = await app.request(
          `/api/projects/${projectId}/files/raw?path=outside-link.txt`,
        );

        expect(res.status).toBe(400);
        const json = (await res.json()) as { error: string };
        expect(json.error).toBe("Invalid file path");
      },
    );

    it("returns 404 for non-existent file", async () => {
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files/raw?path=nonexistent.txt`,
      );

      expect(res.status).toBe(404);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("File not found");
    });
  });

  describe("MIME type detection", () => {
    it.each([
      ["file.ts", "text/typescript"],
      ["file.tsx", "text/typescript"],
      ["file.js", "text/javascript"],
      ["file.jsx", "text/javascript"],
      ["file.json", "application/json"],
      ["file.css", "text/css"],
      ["file.html", "text/html"],
      ["file.py", "text/x-python"],
      ["file.go", "text/x-go"],
      ["file.rs", "text/x-rust"],
      ["file.svg", "image/svg+xml"],
      ["file.jpg", "image/jpeg"],
      ["file.png", "image/png"],
      ["file.gif", "image/gif"],
      ["file.webp", "image/webp"],
      ["file.apng", "image/apng"],
      ["file.avif", "image/avif"],
      ["file.bmp", "image/bmp"],
      ["file.ico", "image/x-icon"],
      ["file.tif", "image/tiff"],
      ["file.tiff", "image/tiff"],
      ["file.avi", "video/x-msvideo"],
      ["file.mkv", "video/x-matroska"],
      ["file.mov", "video/quicktime"],
      ["file.ogv", "video/ogg"],
      ["file.mp4", "video/mp4"],
      ["file.webm", "video/webm"],
      ["file.pdf", "application/pdf"],
      ["file.unknown", "application/octet-stream"],
    ])("detects correct MIME type for %s", async (filename, expectedMime) => {
      // Create the file
      await writeFile(join(projectPath, filename), "test content");

      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=${filename}`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.metadata.mimeType).toBe(expectedMime);
    });
  });

  describe("text file detection", () => {
    it.each([
      ["file.ts", true],
      ["file.md", true],
      ["file.json", true],
      ["file.svg", true],
      ["file.output", true],
      ["file.stdout", true],
      ["file.png", false],
      ["file.jpg", false],
      ["file.pdf", false],
      ["file.zip", false],
    ])("correctly identifies %s as text=%s", async (filename, isText) => {
      await writeFile(join(projectPath, filename), "test content");

      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=${filename}`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.metadata.isText).toBe(isText);
    });
  });

  describe("large file handling", () => {
    it.each([
      ["html", 3],
      ["htm", 3],
      ["html", 200],
    ] as const)(
      "returns complete large %s documents at %i MiB with bounded source highlighting",
      async (extension, sizeMiB) => {
        const prefix = "<!doctype html><html><body><p>Paper</p><!--";
        const suffix = "--><p>End of paper</p></body></html>";
        const content =
          prefix +
          "x".repeat(sizeMiB * 1024 * 1024 - prefix.length - suffix.length) +
          suffix;
        await writeFile(join(projectPath, `paper.${extension}`), content);
        const { app } = createApp({
          provider: mockSdk,
          projectsDir: join(testDir, "sessions"),
        });

        const res = await app.request(
          `/api/projects/${projectId}/files?path=paper.${extension}&highlight=true`,
        );
        expect(res.status).toBe(200);
        const json = (await res.json()) as FileContentResponse;
        expect(json.metadata.mimeType).toBe("text/html");
        expect(json.content === content).toBe(true);
        expect(json.contentTruncated).not.toBe(true);
        expect(json.highlightedHtml).toBeDefined();
        expect(json.highlightedTruncated).toBe(true);
        expect(json.highlightedHtml).not.toContain("End of paper");
      },
      // CI 36977714764 exceeded 5 s while writing, serving and parsing the
      // complete 200 MiB document. Allow 4x that observed limit for this I/O
      // fixture; exact content and bounded-highlighting assertions stay intact.
      20_000,
    );

    it("omits HTML content above the 200 MiB document limit", async () => {
      const path = join(projectPath, "too-large.html");
      await writeFile(path, "<!doctype html>");
      await truncate(path, 200 * 1024 * 1024 + 1);
      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });
      const res = await app.request(
        `/api/projects/${projectId}/files?path=too-large.html&highlight=true`,
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.metadata.isText).toBe(true);
      expect(json.content).toBeUndefined();
      expect(json.rawUrl).toBeDefined();
    });

    it("returns complete text files over the highlight bound", async () => {
      const largeContent = `${"x".repeat(3 * 1024 * 1024)}\nlast line`;
      await writeFile(join(projectPath, "large.txt"), largeContent);

      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=large.txt`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.metadata.isText).toBe(true);
      expect(json.content === largeContent).toBe(true);
      expect(json.contentTruncated).not.toBe(true);
    });

    it("omits content for text files over 100 MiB", async () => {
      const path = join(projectPath, "too-large.txt");
      await writeFile(path, "x");
      await truncate(path, 100 * 1024 * 1024 + 1);

      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=too-large.txt`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.metadata.isText).toBe(true);
      expect(json.content).toBeUndefined();
      expect(json.rawUrl).toBeDefined();
    });

    it("returns only requested lines for compact range views", async () => {
      await writeFile(
        join(projectPath, "range.ts"),
        ["const one = 1;", "const two = 2;", "const three = 3;"].join("\n"),
      );

      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=range.ts&line=2&lineEnd=3&view=range&highlight=true`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.content).toBe("const two = 2;\nconst three = 3;");
      expect(json.contentStartLine).toBe(2);
      expect(json.contentEndLine).toBe(3);
      expect(json.contentTotalLines).toBe(3);
      expect(json.contentTruncated).toBe(true);
      expect(json.highlightedHtml).toBeDefined();
    });

    it("returns a bounded window around requested lines in large files", async () => {
      const lines = Array.from(
        { length: 1600 },
        (_, index) =>
          `const line${String(index + 1).padStart(4, "0")} = ` +
          `"${"x".repeat(880)}";`,
      );
      await writeFile(join(projectPath, "large.ts"), lines.join("\n"));

      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=large.ts&line=1200&lineEnd=1202&highlight=true`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.metadata.isText).toBe(true);
      expect(json.contentTruncated).toBe(true);
      expect(json.contentStartLine).toBeGreaterThan(1);
      expect(json.contentStartLine).toBeLessThanOrEqual(1200);
      expect(json.contentEndLine).toBeGreaterThanOrEqual(1202);
      expect(Buffer.byteLength(json.content ?? "", "utf8")).toBeLessThanOrEqual(
        1024 * 1024,
      );
      expect(json.content).toContain("1200 ");
      expect(json.content).toContain("1202 ");
      expect(json.highlightedHtml).toBeDefined();
    });

    it("raw endpoint still returns large files", async () => {
      // Create a file larger than 1MB
      const largeContent = "x".repeat(1024 * 1024 + 1);
      await writeFile(join(projectPath, "large.txt"), largeContent);

      const { app } = createApp({
        provider: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files/raw?path=large.txt`,
      );

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text.length).toBeGreaterThan(1024 * 1024);
    });
  });
});
