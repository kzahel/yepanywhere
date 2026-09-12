// @vitest-environment node
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
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
import { afterEach, describe, expect, it } from "vitest";
import { chromium } from "@playwright/test";
import {
  captureArtifact,
  markdownLink,
  writeCapturePreview,
} from "./artifact-capture";

const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  }
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true });
});

async function fixture(
  html = '<h1>Before script</h1><script type="module" src="./main.js"></script>',
) {
  const directory = await mkdtemp(join(tmpdir(), "ya-artifact-capture-"));
  directories.push(directory);
  const root = join(directory, "bundle with spaces");
  await mkdir(root);
  const input = join(root, "index.html");
  await writeFile(input, html);
  await writeFile(
    join(root, "main.js"),
    'document.querySelector("h1").textContent = "Ready";',
  );
  return { directory, root, input, out: join(directory, "capture") };
}

async function serverFixture({
  configured = true,
  capable = true,
  available = true,
  broken = false,
  healthy = true,
} = {}) {
  const requests: {
    path: string;
    method: string;
    headers: IncomingHttpHeaders;
  }[] = [];
  let artifactUrl = "";
  const server = createServer(async (request, response) => {
    requests.push({
      path: request.url!,
      method: request.method!,
      headers: request.headers,
    });
    response.setHeader("Content-Type", "application/json");
    switch (request.url) {
      case "/api/version":
        response.end(
          JSON.stringify({
            current: "0.8.2",
            capabilities: capable ? ["artifact-viewer"] : [],
            artifactViewer: {
              available,
              ...(configured ? { localOrigin: artifactUrl } : {}),
            },
          }),
        );
        break;
      case "/health":
        if (!healthy) response.statusCode = 503;
        response.end(healthy ? '{"artifactViewer":1}' : "{}");
        break;
      case "/api/artifacts": {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (body.audience !== "local" || !body.path) response.statusCode = 400;
        response.end(
          JSON.stringify({
            id: "grant-id",
            url: `${artifactUrl}/a/token/index.html`,
            expiresAt: Date.now() + 86400000,
          }),
        );
        break;
      }
      case "/api/artifacts/grant-id":
        response.end('{"success":true}');
        break;
      case "/a/token/index.html":
        response.statusCode = broken ? 404 : 200;
        response.setHeader("Content-Type", "text/html");
        response.end("<h1>Hosted artifact</h1>");
        break;
      default:
        response.statusCode = 404;
        response.end("missing");
    }
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, done));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP listener");
  artifactUrl = `http://localhost:${address.port}`;
  return { requests, yaUrl: `http://127.0.0.1:${address.port}`, artifactUrl };
}

describe("portable artifact capture", () => {
  it("captures a standalone bundle in both standard sizes without YA", async () => {
    const files = await fixture();
    const result = await captureArtifact({
      ...files,
      readySelector: "h1:text('Ready')",
    });
    expect(result.delivery.status).toBe("skipped");
    expect(result.markdown).toContain(
      `Open in YA: ${markdownLink("File viewer", await realpath(files.input))}`,
    );
    for (const capture of result.screenshots) {
      const png = await readFile(capture.path);
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([
        capture.width,
        capture.height,
      ]);
    }
    expect(
      result.screenshots.map(({ width, height }) => [width, height]),
    ).toEqual([
      [1000, 600],
      [375, 812],
    ]);
    expect(
      JSON.parse(await readFile(join(files.out, "capture.json"), "utf8")),
    ).toEqual(result);
    expect(await readFile(join(files.out, "links.md"), "utf8")).toBe(
      `${result.markdown}\n`,
    );
    await expect(captureArtifact(files)).rejects.toThrow("EEXIST");
  });

  it.each([{ configured: false }, { available: false }, { capable: false }])(
    "skips health and grants when delivery is absent: %j",
    async (options) => {
      const files = await fixture();
      const server = await serverFixture(options);
      const result = await captureArtifact({ ...files, yaUrl: server.yaUrl });
      expect(result.delivery.status).toBe("skipped");
      expect(server.requests.map((item) => item.path)).toEqual([
        "/api/version",
      ]);
    },
  );

  it("takes the session's announced artifact origin without asking the server", async () => {
    const files = await fixture();
    const server = await serverFixture({ capable: false, available: false });
    const result = await captureArtifact({
      ...files,
      yaUrl: server.yaUrl,
      artifactOrigin: server.artifactUrl,
    });
    // The marker comes from the user's YA, so neither the capability answer nor
    // the origin health probe adds anything: only the grant request is made.
    expect(result.delivery.status).toBe("created");
    expect(
      server.requests.map((item) => item.path).filter((path) => path !== "/"),
    ).not.toContain("/api/version");
    expect(server.requests.map((item) => item.path)).not.toContain("/health");
  });

  it("keeps the captures when the announced origin cannot mint a grant", async () => {
    const files = await fixture();
    const server = await serverFixture();
    // An origin sharing the YA hostname is not the isolated origin the viewer
    // needs. That costs the interactive link, never the images.
    const result = await captureArtifact({
      ...files,
      yaUrl: server.yaUrl,
      artifactOrigin: server.yaUrl,
    });
    expect(result.delivery).toMatchObject({ status: "skipped" });
    expect(result.markdown).toContain("isolated origin");
    expect(result.screenshots).toHaveLength(2);
  });

  it("never probes the configured origin for reachability", async () => {
    const files = await fixture();
    const server = await serverFixture({ healthy: false });
    const result = await captureArtifact({ ...files, yaUrl: server.yaUrl });
    // Enabled or not is the whole decision, and the grant request answers it.
    // Whether the origin resolves belongs to the browser, which maps
    // `*.localhost` to loopback on its own.
    expect(result.delivery.status).toBe("created");
    expect(server.requests.map((item) => item.path)).not.toContain("/health");
    expect(result.screenshots).toHaveLength(2);
  });

  it("captures through a configured grant without leaking YA headers, and retains the delivered grant", async () => {
    const files = await fixture();
    const server = await serverFixture();
    const result = await captureArtifact({
      ...files,
      yaUrl: server.yaUrl,
      yaHeaders: { Cookie: "session=private", Authorization: "private" },
    });
    expect(result.delivery.status).toBe("created");
    expect(result.markdown).toContain("expires ");
    expect(
      server.requests.filter((item) => item.path === "/api/artifacts"),
    ).toHaveLength(1);
    expect(server.requests.some((item) => item.method === "DELETE")).toBe(
      false,
    );
    for (const item of server.requests.filter(
      (item) => !item.path.startsWith("/api/"),
    )) {
      expect(item.headers.cookie).toBeUndefined();
      expect(item.headers.authorization).toBeUndefined();
      expect(item.headers["x-yep-anywhere"]).toBeUndefined();
    }
  });

  it("reports broken hosted documents and revokes grants from failed captures", async () => {
    const files = await fixture();
    const server = await serverFixture({ broken: true });
    await expect(
      captureArtifact({ ...files, yaUrl: server.yaUrl }),
    ).rejects.toThrow("HTTP 404");
    expect(
      server.requests.some(
        (item) =>
          item.method === "DELETE" && item.path === "/api/artifacts/grant-id",
      ),
    ).toBe(true);
  });

  it("revokes a created grant when the interaction fails without writing a successful manifest", async () => {
    const files = await fixture();
    const server = await serverFixture();
    await expect(
      captureArtifact({
        ...files,
        yaUrl: server.yaUrl,
        interact: async () => {
          throw new Error("Workflow failed");
        },
      }),
    ).rejects.toThrow("Workflow failed");
    expect(server.requests.some((item) => item.method === "DELETE")).toBe(true);
    await expect(
      readFile(join(files.out, "capture.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("packages an existing driven page without replacing its screenshots or owning its browser", async () => {
    const files = await fixture();
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({
        viewport: { width: 375, height: 812 },
      });
      await page.setContent(
        "<button onclick=\"this.textContent='Expanded'\">Expand</button>",
      );
      await page.getByRole("button", { name: "Expand", exact: true }).click();
      const path = join(files.directory, "chosen state.png");
      const bytes = await page.screenshot({ path });
      const options = {
        input: "Caller-owned browser workflow",
        out: files.out,
        screenshots: [{ name: "phone", width: 375, height: 812, path }],
      };
      const result = await writeCapturePreview(options);
      expect(result._acli?.commentary[1]?.text).toContain(
        `![phone](<${(await realpath(path)).replaceAll("\\", "/")}>)`,
      );
      expect(await readFile(path)).toEqual(bytes);
      expect(await page.getByRole("button").textContent()).toBe("Expanded");
      expect(
        JSON.parse(await readFile(join(files.out, "capture.json"), "utf8")),
      ).toEqual(result);
      await expect(writeCapturePreview(options)).rejects.toMatchObject({
        code: "EEXIST",
      });
      await expect(
        writeCapturePreview({
          ...options,
          out: join(files.directory, "missing"),
          screenshots: [
            {
              ...options.screenshots[0]!,
              path: join(files.directory, "absent.png"),
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await browser.close();
    }
  });

  it("captures an existing URL without creating or renewing a grant", async () => {
    const files = await fixture();
    const server = await serverFixture();
    const result = await captureArtifact({
      input: `${server.artifactUrl}/a/token/index.html`,
      out: files.out,
    });
    expect(result.delivery).toMatchObject({
      status: "existing",
      expiresAt: null,
    });
    expect(result.markdown).not.toContain("File viewer");
    expect(server.requests.every((item) => item.path.startsWith("/a/"))).toBe(
      true,
    );
  });

  it("reports missing assets and refuses directory traversal", async () => {
    const files = await fixture('<script src="/%2e%2e%2fsecret.js"></script>');
    await writeFile(
      join(files.directory, "secret.js"),
      "throw new Error('must never run');",
    );
    await expect(captureArtifact(files)).rejects.toThrow(
      "outside the HTML entry directory",
    );
  });

  it("blocks external requests unless explicitly allowed", async () => {
    const server = await serverFixture();
    const files = await fixture(`<img src="${server.yaUrl}/private.png">`);
    await expect(captureArtifact(files)).rejects.toThrow(
      "Blocked external request",
    );
    expect(server.requests).toHaveLength(0);
  });

  it("does not substitute a configured local origin for an unconfigured public origin", async () => {
    const files = await fixture();
    const server = await serverFixture();
    const result = await captureArtifact({
      ...files,
      yaUrl: server.yaUrl,
      audience: "public",
    });
    expect(result.delivery).toMatchObject({
      status: "skipped",
      reason: "public artifact origin is disabled or unconfigured",
    });
    expect(server.requests.map((item) => item.path)).toEqual(["/api/version"]);
  });

  it("reports a missing readiness target within the configured deadline", async () => {
    const files = await fixture();
    await expect(
      captureArtifact({ ...files, readySelector: "#missing", timeoutMs: 750 }),
    ).rejects.toThrow("Timeout");
  });

  it("retains browser warnings in successful capture reports", async () => {
    const files = await fixture(
      '<h1>Ready</h1><script>console.warn("Example warning")</script>',
    );
    const result = await captureArtifact(files);
    expect(result.warnings).toEqual(["Example warning"]);
    expect(result.markdown).toContain("Browser warnings: Example warning");
  });

  it("rejects console errors instead of presenting successful captures", async () => {
    const files = await fixture(
      '<script>console.error("Broken artifact")</script>',
    );
    await expect(captureArtifact(files)).rejects.toThrow("Broken artifact");
  });

  it("does not expose invalid authentication headers in errors", async () => {
    const files = await fixture();
    const server = await serverFixture();
    await expect(
      captureArtifact({
        ...files,
        yaUrl: server.yaUrl,
        yaHeaders: { Authorization: "private\ninvalid" },
      }),
    ).rejects.toThrow(
      /^YA \/api\/version: request failed; check origin, headers, and timeout$/,
    );
    expect(server.requests).toHaveLength(0);
  });

  it("prints Markdown destinations with portable separators and escaped delimiters", () => {
    expect(markdownLink("File viewer", "C:\\work dir\\a#?%.html")).toBe(
      "[File viewer](<C:/work dir/a%23%3F%25.html>)",
    );
  });
});
