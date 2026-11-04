import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { upgradeWebSocket } from "@hono/node-server";
import { WebSocketServer } from "ws";
import type {
  StagedAttachmentRef,
  UploadServerMessage,
  UploadStartMessage,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { attachUnifiedUpgradeHandler } from "../../src/frontend/index.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { ProjectStoragePolicy } from "../../src/projects/projectStoragePolicy.js";
import { createUploadRoutes } from "../../src/routes/upload.js";
import { AttachmentStagingService } from "../../src/uploads/index.js";

describe("staged upload direct route", () => {
  let testDir: string;
  let server: ReturnType<typeof serve> | null;
  let port: number;
  let stagingService: AttachmentStagingService;
  let storageMode: "app-data" | "project";
  let storagePolicy: ProjectStoragePolicy;
  let projectPath: string;
  let projectId: UrlProjectId;

  async function completeStagedUpload(
    content: string,
  ): Promise<StagedAttachmentRef> {
    const started = await stagingService.startDraftUpload({
      batchId: "batch-a",
      originalName: "draft.txt",
      size: Buffer.byteLength(content),
      mimeType: "text/plain",
    });
    await stagingService.writeChunk(started.uploadId, Buffer.from(content));
    return stagingService.completeUpload(started.uploadId);
  }

  beforeEach(async () => {
    testDir = join(tmpdir(), `staged-upload-route-${randomUUID()}`);
    projectPath = join(testDir, "project");
    await mkdir(projectPath, { recursive: true });
    projectId = toUrlProjectId(projectPath);
    server = null;
    storageMode = "project";
    storagePolicy = new ProjectStoragePolicy({
      dataDir: join(testDir, "data"),
      getMode: () => storageMode,
    });
    stagingService = new AttachmentStagingService({
      stagingRoot: join(testDir, "staging"),
      storagePolicy,
    });

    const app = new Hono();
    const wss = new WebSocketServer({ noServer: true });
    app.route(
      "/api",
      createUploadRoutes({
        scanner: {
          getOrCreateProject: async (requestedProjectId: string) =>
            requestedProjectId === projectId
              ? {
                  id: projectId,
                  path: projectPath,
                  name: "project",
                  sessionCount: 0,
                  sessionDir: join(testDir, "sessions"),
                  activeOwnedCount: 0,
                  activeExternalCount: 0,
                  lastActivity: null,
                  provider: "claude",
                }
              : null,
        } as unknown as ProjectScanner,
        upgradeWebSocket,
        attachmentStagingService: stagingService,
        storagePolicy,
      }),
    );

    server = serve(
      { fetch: app.fetch, websocket: { server: wss }, port: 0 },
      (info) => {
        port = info.port;
      },
    );
    attachUnifiedUpgradeHandler(server, {
      frontendProxy: undefined,
      isApiPath: (urlPath) => urlPath.startsWith("/api"),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  afterEach(async () => {
    server?.close();
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it("streams draft-staged uploads and returns a staged ref", async () => {
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(
        `ws://localhost:${port}/api/attachments/staging/drafts/upload/ws`,
      );
      socket.on("open", () => resolve(socket));
      socket.on("error", reject);
    });

    const completePromise = new Promise<UploadServerMessage>(
      (resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Timed out waiting for staged upload")),
          5000,
        );
        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString()) as UploadServerMessage;
          if (msg.type === "complete" || msg.type === "error") {
            clearTimeout(timeout);
            resolve(msg);
          }
        });
      },
    );

    const start: UploadStartMessage = {
      type: "start",
      batchId: "batch-a",
      name: "draft.txt",
      size: 5,
      mimeType: "text/plain",
    };
    ws.send(JSON.stringify(start));
    ws.send(Buffer.from("hello"));
    ws.send(JSON.stringify({ type: "end" }));

    const complete = await completePromise;
    ws.close();

    expect(complete.type).toBe("complete");
    expect("file" in complete).toBe(false);
    if (!("stagedRef" in complete)) {
      throw new Error("Expected staged upload completion");
    }
    expect(complete.stagedRef).toMatchObject({
      batchId: "batch-a",
      originalName: "draft.txt",
      size: 5,
      mimeType: "text/plain",
    });
    await expect(
      stagingService.listDraftAttachments("batch-a"),
    ).resolves.toEqual([complete.stagedRef]);
  });

  it("validates draft-staged refs over HTTP", async () => {
    const ref = await completeStagedUpload("validate");

    const response = await fetch(
      `http://localhost:${port}/api/attachments/staging/drafts/batch-a/validate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refs: [ref] }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ refs: [ref] });
  });

  it("deletes draft-staged refs over HTTP", async () => {
    const ref = await completeStagedUpload("delete");

    const response = await fetch(
      `http://localhost:${port}/api/attachments/staging/drafts/batch-a/${ref.id}`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deleted: true });
    await expect(
      stagingService.listDraftAttachments("batch-a"),
    ).resolves.toEqual([]);
  });

  it("materializes draft-staged refs into session uploads over HTTP", async () => {
    const ref = await completeStagedUpload("materialize");

    const response = await fetch(
      `http://localhost:${port}/api/projects/${projectId}/sessions/session-a/attachments/staging/materialize`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchId: "batch-a", refs: [ref] }),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      files: Array<{ path: string; name: string }>;
    };
    expect(body.files).toEqual([
      expect.objectContaining({
        id: ref.id,
        originalName: "draft.txt",
        name: ref.name,
        path: join(projectPath, ".yep", "attachments", "session-a", ref.name),
        size: ref.size,
        mimeType: "text/plain",
      }),
    ]);
    await expect(readFile(body.files[0]?.path ?? "", "utf-8")).resolves.toBe(
      "materialize",
    );

    const served = await fetch(
      `http://localhost:${port}/api/projects/${projectId}/sessions/session-a/upload/${ref.name}`,
    );
    expect(served.status).toBe(200);
    await expect(served.text()).resolves.toBe("materialize");
  });

  it("serves materialized app-data attachments through the same session route", async () => {
    storageMode = "app-data";
    const ref = await completeStagedUpload("central materialize");

    const response = await fetch(
      `http://localhost:${port}/api/projects/${projectId}/sessions/session-a/attachments/staging/materialize`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchId: "batch-a", refs: [ref] }),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      files: Array<{ path: string; name: string }>;
    };
    expect(body.files[0]?.path).toBe(
      storagePolicy.writePath(
        projectPath,
        "attachments",
        "session-a",
        ref.name,
      ),
    );

    const served = await fetch(
      `http://localhost:${port}/api/projects/${projectId}/sessions/session-a/upload/${ref.name}`,
    );
    expect(served.status).toBe(200);
    await expect(served.text()).resolves.toBe("central materialize");
  });

  it("forces materialized SVG attachments to download with a scriptless CSP", async () => {
    const content = '<svg onload="fetch(`/api/processes`)"></svg>';
    const started = await stagingService.startDraftUpload({
      batchId: "batch-svg",
      originalName: "proof.svg",
      size: Buffer.byteLength(content),
      mimeType: "image/svg+xml",
    });
    await stagingService.writeChunk(started.uploadId, Buffer.from(content));
    const ref = await stagingService.completeUpload(started.uploadId);

    const materialized = await fetch(
      `http://localhost:${port}/api/projects/${projectId}/sessions/session-svg/attachments/staging/materialize`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchId: "batch-svg", refs: [ref] }),
      },
    );
    expect(materialized.status).toBe(200);

    const served = await fetch(
      `http://localhost:${port}/api/projects/${projectId}/sessions/session-svg/upload/${ref.name}`,
    );
    expect(served.status).toBe(200);
    expect(served.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(served.headers.get("Content-Disposition")).toContain("attachment");
    expect(served.headers.get("Content-Security-Policy")).toContain(
      "script-src 'none'",
    );
    expect(served.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  // A first-turn upload materializes under a provisional session id (the
  // real id is assigned by the provider afterwards). The client derives the
  // URL's session segment from the persisted physical path, so the serve
  // route needs only the exact directory named in the URL.
  it("serves attachments through the physical directory named in the URL", async () => {
    storageMode = "app-data";
    const ref = await completeStagedUpload("provisional turn");

    const response = await fetch(
      `http://localhost:${port}/api/projects/${projectId}/sessions/provisional-id/attachments/staging/materialize`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchId: "batch-a", refs: [ref] }),
      },
    );
    expect(response.status).toBe(200);

    const served = await fetch(
      `http://localhost:${port}/api/projects/${projectId}/sessions/provisional-id/upload/${ref.name}`,
    );
    expect(served.status).toBe(200);
    await expect(served.text()).resolves.toBe("provisional turn");
  });

  it("returns 404 for a filename absent from the named session directory", async () => {
    const missing = `${randomUUID()}_missing.txt`;
    const served = await fetch(
      `http://localhost:${port}/api/projects/${projectId}/sessions/any-session/upload/${missing}`,
    );
    expect(served.status).toBe(404);
  });
});
