import {
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalImageRoutes } from "../../src/routes/local-image.js";
import { createMutableFileCacheMetadata } from "../../src/routes/mutable-file-cache.js";
import { projectForPath } from "./route-fixtures.js";

describe("Local image routes", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "yep-local-image-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("serves files from the managed uploads directory", async () => {
    const uploadsDir = path.join(tempDir, "uploads");
    const sessionDir = path.join(
      uploadsDir,
      "encoded-project-path",
      "session-123",
    );
    await mkdir(sessionDir, { recursive: true });

    const filePath = path.join(sessionDir, "screenshot 9.10.56 AM.png");
    await writeFile(filePath, "png-bytes");

    const routes = createLocalImageRoutes({
      allowedPaths: [uploadsDir],
    });

    const response = await routes.request(
      `/?path=${encodeURIComponent(filePath)}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(response.headers.get("etag")).toMatch(/^W\/"/);
    expect(response.headers.get("last-modified")).not.toBeNull();
    expect(await response.text()).toBe("png-bytes");

    const etag = response.headers.get("etag");
    expect(etag).not.toBeNull();
    const unchanged = await routes.request(
      `/?path=${encodeURIComponent(filePath)}`,
      { headers: { "If-None-Match": etag ?? "" } },
    );
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get("cache-control")).toBe("private, no-cache");
    expect(unchanged.headers.get("content-length")).toBeNull();

    await writeFile(filePath, "new-png-bytes");
    const changed = await routes.request(
      `/?path=${encodeURIComponent(filePath)}`,
      { headers: { "If-None-Match": etag ?? "" } },
    );
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
    expect(await changed.text()).toBe("new-png-bytes");
  });

  it("serves allowed audio files with an audio content type", async () => {
    const filePath = path.join(tempDir, "clip.wav");
    await writeFile(filePath, "wav-bytes");

    const routes = createLocalImageRoutes({ allowedPaths: [tempDir] });
    const response = await routes.request(
      `/?path=${encodeURIComponent(filePath)}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect(response.headers.get("content-disposition") ?? "inline").toMatch(
      /^inline/,
    );
    expect(await response.text()).toBe("wav-bytes");
  });

  it("derives validators and bytes from one opened file snapshot", async () => {
    const allowedDir = path.join(tempDir, "allowed");
    await mkdir(allowedDir, { recursive: true });
    const filePath = path.join(allowedDir, "mutable.png");
    await writeFile(filePath, "old");
    const oldMetadata = createMutableFileCacheMetadata(await stat(filePath));

    const routes = createLocalImageRoutes({
      allowedPaths: [allowedDir],
      openFile: async (resolvedPath) => {
        await rename(filePath, `${filePath}.old`);
        await writeFile(filePath, "replacement image bytes");
        return open(resolvedPath, "r");
      },
    });

    const response = await routes.request(
      `/?path=${encodeURIComponent(filePath)}`,
    );
    const replacementMetadata = createMutableFileCacheMetadata(
      await stat(filePath),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("23");
    expect(response.headers.get("etag")).toBe(replacementMetadata.etag);
    expect(response.headers.get("etag")).not.toBe(oldMetadata.etag);
    await expect(response.text()).resolves.toBe("replacement image bytes");
  });

  it("serves media files from discovered project directories", async () => {
    const uploadsDir = path.join(tempDir, "uploads");
    const projectDir = path.join(tempDir, "project");
    await mkdir(projectDir, { recursive: true });

    const filePath = path.join(projectDir, "trajectory.png");
    await writeFile(filePath, "png-bytes");

    const routes = createLocalImageRoutes({
      allowedPaths: [uploadsDir],
      scanner: {
        async listProjects() {
          return [projectForPath(projectDir)];
        },
      },
    });

    const response = await routes.request(
      `/?path=${encodeURIComponent(filePath)}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(await response.text()).toBe("png-bytes");
  });

  it("forces active SVG media to download with a scriptless CSP", async () => {
    const projectDir = path.join(tempDir, "project");
    await mkdir(projectDir, { recursive: true });

    const filePath = path.join(projectDir, "proof.svg");
    await writeFile(filePath, '<svg onload="fetch(`/api/processes`)"></svg>');

    const routes = createLocalImageRoutes({
      allowedPaths: [projectDir],
    });
    const response = await routes.request(
      `/?path=${encodeURIComponent(filePath)}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("content-security-policy")).toContain(
      "script-src 'none'",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("rejects files outside the allowed directories", async () => {
    const uploadsDir = path.join(tempDir, "uploads");
    const otherDir = path.join(tempDir, "other");
    await mkdir(otherDir, { recursive: true });

    const filePath = path.join(otherDir, "outside.png");
    await writeFile(filePath, "png-bytes");

    const routes = createLocalImageRoutes({
      allowedPaths: [uploadsDir],
    });

    const response = await routes.request(
      `/?path=${encodeURIComponent(filePath)}`,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Path not in allowed directories",
    });
  });

  it("rejects non-absolute paths before media type checks", async () => {
    const routes = createLocalImageRoutes({
      allowedPaths: [tempDir],
    });

    const response = await routes.request("/?path=relative-file.txt");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Path must be absolute",
    });
  });

  it.skipIf(process.platform === "win32")(
    "rejects symlinks that resolve outside allowed directories",
    async () => {
      const uploadsDir = path.join(tempDir, "uploads");
      const otherDir = path.join(tempDir, "other");
      await mkdir(uploadsDir, { recursive: true });
      await mkdir(otherDir, { recursive: true });

      const outsideFile = path.join(otherDir, "outside.png");
      const linkPath = path.join(uploadsDir, "linked.png");
      await writeFile(outsideFile, "png-bytes");
      await symlink(outsideFile, linkPath);

      const routes = createLocalImageRoutes({
        allowedPaths: [uploadsDir],
      });

      const response = await routes.request(
        `/?path=${encodeURIComponent(linkPath)}`,
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "Path not in allowed directories",
      });
    },
  );
});
