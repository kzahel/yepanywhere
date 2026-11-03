import type { CodexSessionEntry, ToolResultMedia } from "@yep-anywhere/shared";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthService } from "../../src/auth/AuthService.js";
import { SESSION_COOKIE_NAME } from "../../src/auth/routes.js";
import { runIdleSweeps } from "../../src/lib/processIdleSweep.js";
import { ToolResultMediaStore } from "../../src/media/ToolResultMediaStore.js";
import { grokSessionMediaRoots } from "../../src/projects/paths.js";
import { createAuthMiddleware } from "../../src/middleware/auth.js";
import {
  createSessionsRoutes,
  type SessionsDeps,
} from "../../src/routes/sessions.js";
import { createToolResultMediaRoutes } from "../../src/routes/tool-result-media.js";
import { normalizeSession } from "../../src/sessions/normalization.js";
import type {
  ISessionReader,
  LoadedSession,
} from "../../src/sessions/types.js";
import type { SDKMessage } from "../../src/sdk/types.js";
import { Process } from "../../src/supervisor/Process.js";
import { encodeProjectId, type Project } from "../../src/supervisor/types.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { ProjectStoragePolicy } from "../../src/projects/projectStoragePolicy.js";
import { MessageQueue } from "../../src/sdk/messageQueue.js";

const execFileAsync = promisify(execFile);
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");
const DATA_URL = `data:image/png;base64,${PNG_BASE64}`;
const MP4_BYTES = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00,
  0x00, 0x00, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31,
]);

describe("tool-result media storage", () => {
  let tempDir: string;
  let projectDir: string;
  let dataDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "yep-tool-result-media-"));
    projectDir = join(tempDir, "project");
    dataDir = join(tempDir, "data");
    await mkdir(projectDir, { recursive: true });
    await execFileAsync("git", ["init", "-q", projectDir]);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("stores authoritative returned bytes and git-excludes a new .yep", async () => {
    const sourcePath = join(projectDir, "source.png");
    const differentSourceBytes = Buffer.from(PNG_BYTES);
    differentSourceBytes[differentSourceBytes.length - 1] ^= 0xff;
    await writeFile(sourcePath, differentSourceBytes);

    const store = new ToolResultMediaStore({
      dataDir,
      storagePolicy: new ProjectStoragePolicy({
        dataDir,
        getMode: () => "project",
      }),
    });
    const projectId = encodeProjectId(projectDir);
    const media = await store.capture(
      { dataUrl: DATA_URL, originalPath: sourcePath },
      {
        provider: "codex",
        projectId,
        projectPath: projectDir,
        getSessionId: () => "session-a",
      },
      "call-a",
      0,
      { preserve: true },
    );

    expect(media).toMatchObject({
      state: "stored",
      mimeType: "image/png",
      width: 1,
      height: 1,
    });
    if (media.state !== "stored") throw new Error("Expected stored media");

    await writeFile(sourcePath, "source mutated after capture");
    const file = await store.getMediaFile(
      projectDir,
      projectId,
      "session-a",
      media.id,
    );
    expect(file?.path).toContain(
      join(".yep", "tool-results", "session-a", "blobs"),
    );
    await expect(readFile(file?.path ?? "")).resolves.toEqual(PNG_BYTES);
    await expect(
      readFile(join(projectDir, ".git", "info", "exclude"), "utf8"),
    ).resolves.toContain(".yep/");
  });

  it("rejects a same-size blob whose bytes no longer match its content hash", async () => {
    const store = new ToolResultMediaStore({ dataDir });
    const projectId = encodeProjectId(projectDir);
    const media = await captureDataUrl(store, projectDir, "session-corrupt");
    if (media.state !== "stored") throw new Error("Expected stored media");
    const file = await store.getMediaFile(
      projectDir,
      projectId,
      "session-corrupt",
      media.id,
    );
    if (!file) throw new Error("Expected stored media file");

    const corruptBytes = Buffer.alloc(file.byteLength, 0x5a);
    await writeFile(file.path, corruptBytes);

    await expect(
      store.getMediaFile(projectDir, projectId, "session-corrupt", media.id),
    ).resolves.toBeNull();
  });

  it("repairs a same-size corrupted blob when the content is captured again", async () => {
    const store = new ToolResultMediaStore({ dataDir });
    const projectId = encodeProjectId(projectDir);
    const first = await captureDataUrl(store, projectDir, "session-repair");
    if (first.state !== "stored") throw new Error("Expected stored media");
    const file = await store.getMediaFile(
      projectDir,
      projectId,
      "session-repair",
      first.id,
    );
    if (!file) throw new Error("Expected stored media file");
    await writeFile(file.path, Buffer.alloc(file.byteLength, 0x5a));

    const repaired = await captureDataUrl(store, projectDir, "session-repair");

    expect(repaired).toMatchObject({ state: "stored", id: first.id });
    await expect(readFile(file.path)).resolves.toEqual(PNG_BYTES);
  });

  it("does not rewrite git excludes when .yep already exists", async () => {
    await mkdir(join(projectDir, ".yep"), { recursive: true });
    const excludePath = join(projectDir, ".git", "info", "exclude");
    await writeFile(excludePath, "# user-owned exclude\n");

    const media = await captureDataUrl(
      new ToolResultMediaStore({ dataDir }),
      projectDir,
      "session-existing",
    );

    expect(media.state).toBe("stored");
    await expect(readFile(excludePath, "utf8")).resolves.toBe(
      "# user-owned exclude\n",
    );
  });

  it("snapshots a permitted path-only image at capture time", async () => {
    const sourcePath = join(projectDir, "path-only.png");
    await writeFile(sourcePath, PNG_BYTES);
    const store = new ToolResultMediaStore({ dataDir });
    const projectId = encodeProjectId(projectDir);
    const media = await store.capture(
      { originalPath: sourcePath },
      {
        provider: "codex",
        projectId,
        projectPath: projectDir,
        getSessionId: () => "session-path-only",
      },
      "call-path-only",
      0,
      { preserve: true },
    );
    if (media.state !== "stored") throw new Error("Expected stored media");

    await rm(sourcePath);
    const file = await store.getMediaFile(
      projectDir,
      projectId,
      "session-path-only",
      media.id,
    );
    await expect(readFile(file?.path ?? "")).resolves.toEqual(PNG_BYTES);
  });

  it("admits only the matching Grok project/session image root", async () => {
    const grokSessionsDir = join(tempDir, "grok-sessions");
    const sessionId = "grok-session";
    const imageRoot = join(
      grokSessionsDir,
      encodeURIComponent(projectDir),
      sessionId,
      "images",
    );
    const sourcePath = join(imageRoot, "1.png");
    await mkdir(imageRoot, { recursive: true });
    await writeFile(sourcePath, PNG_BYTES);
    const store = new ToolResultMediaStore({
      dataDir,
      resolveSourcePath: async () => null,
      providerSourceRoots: ({ provider, projectPath, sessionId }) =>
        provider === "grok"
          ? [
              join(
                grokSessionsDir,
                encodeURIComponent(projectPath),
                sessionId,
                "images",
              ),
            ]
          : [],
    });
    const projectId = encodeProjectId(projectDir);
    const context = {
      provider: "grok" as const,
      projectId,
      projectPath: projectDir,
      getSessionId: () => sessionId,
    };
    const otherProjectDir = join(tempDir, "other-project");
    await mkdir(otherProjectDir);

    await expect(
      store.capture({ originalPath: sourcePath }, context, "call-grok", 0),
    ).resolves.toMatchObject({
      state: "stored",
      mimeType: "image/png",
    });
    await expect(
      store.capture(
        { originalPath: sourcePath },
        { ...context, provider: "codex" },
        "call-wrong-provider",
        0,
      ),
    ).resolves.toEqual({
      state: "rejected",
      toolCallId: "call-wrong-provider",
      reason: "source-unavailable",
      filename: "1.png",
    });
    await expect(
      store.capture(
        { originalPath: sourcePath },
        {
          ...context,
          projectId: encodeProjectId(otherProjectDir),
          projectPath: otherProjectDir,
        },
        "call-wrong-project",
        0,
      ),
    ).resolves.toEqual({
      state: "rejected",
      toolCallId: "call-wrong-project",
      reason: "source-unavailable",
      filename: "1.png",
    });
    await expect(
      store.capture(
        { originalPath: sourcePath },
        { ...context, getSessionId: () => "other-session" },
        "call-wrong-session",
        0,
      ),
    ).resolves.toEqual({
      state: "rejected",
      toolCallId: "call-wrong-session",
      reason: "source-unavailable",
      filename: "1.png",
    });
  });

  it("admits Grok session videos through the same media store", async () => {
    const grokSessionsDir = join(tempDir, "grok-sessions");
    const sessionId = "grok-session";
    const videoRoot = join(
      grokSessionsDir,
      encodeURIComponent(projectDir),
      sessionId,
      "videos",
    );
    const sourcePath = join(videoRoot, "1.mp4");
    await mkdir(videoRoot, { recursive: true });
    await writeFile(sourcePath, MP4_BYTES);
    const store = new ToolResultMediaStore({
      dataDir,
      resolveSourcePath: async () => null,
      providerSourceRoots: ({ provider, projectPath, sessionId }) =>
        provider === "grok"
          ? grokSessionMediaRoots(grokSessionsDir, projectPath, sessionId)
          : [],
    });
    const projectId = encodeProjectId(projectDir);

    await expect(
      store.capture(
        { originalPath: sourcePath, filename: "1.mp4" },
        {
          provider: "grok",
          projectId,
          projectPath: projectDir,
          getSessionId: () => sessionId,
        },
        "call-video",
        0,
      ),
    ).resolves.toMatchObject({
      state: "stored",
      mimeType: "video/mp4",
      filename: "1.mp4",
    });
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symlink escaping the Grok session image root",
    async () => {
      const grokSessionsDir = join(tempDir, "grok-sessions");
      const sessionId = "grok-session";
      const imageRoot = join(
        grokSessionsDir,
        encodeURIComponent(projectDir),
        sessionId,
        "images",
      );
      const outsidePath = join(tempDir, "outside.png");
      const sourcePath = join(imageRoot, "linked.png");
      await mkdir(imageRoot, { recursive: true });
      await writeFile(outsidePath, PNG_BYTES);
      await symlink(outsidePath, sourcePath);
      const store = new ToolResultMediaStore({
        dataDir,
        resolveSourcePath: async () => null,
        providerSourceRoots: ({ provider, projectPath, sessionId }) =>
          provider === "grok"
            ? [
                join(
                  grokSessionsDir,
                  encodeURIComponent(projectPath),
                  sessionId,
                  "images",
                ),
              ]
            : [],
      });

      await expect(
        store.capture(
          { originalPath: sourcePath },
          {
            provider: "grok",
            projectId: encodeProjectId(projectDir),
            projectPath: projectDir,
            getSessionId: () => sessionId,
          },
          "call-grok-symlink",
          0,
        ),
      ).resolves.toEqual({
        state: "rejected",
        toolCallId: "call-grok-symlink",
        reason: "source-unavailable",
        filename: "linked.png",
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "falls back to the server data directory for a symlinked .yep",
    async () => {
      const outside = join(tempDir, "outside");
      await mkdir(outside);
      await symlink(outside, join(projectDir, ".yep"));
      const store = new ToolResultMediaStore({ dataDir });
      const media = await captureDataUrl(store, projectDir, "session-fallback");

      expect(media.state).toBe("stored");
      if (media.state !== "stored") throw new Error("Expected stored media");
      const file = await store.getMediaFile(
        projectDir,
        encodeProjectId(projectDir),
        "session-fallback",
        media.id,
      );
      expect(await realpath(file?.path ?? "")).toContain(
        await realpath(join(dataDir, "tool-results")),
      );
    },
  );

  it("rejects unsupported SVG bytes without creating a fetchable handle", async () => {
    const store = new ToolResultMediaStore({ dataDir });
    const media = await store.capture(
      {
        dataUrl: `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`,
      },
      {
        provider: "claude",
        projectId: encodeProjectId(projectDir),
        projectPath: projectDir,
        getSessionId: () => "session-svg",
      },
      "call-svg",
      0,
    );

    expect(media).toEqual({
      state: "rejected",
      toolCallId: "call-svg",
      reason: "unsupported-media",
    });
  });

  it("materializes normalized Codex output without retaining inline data", async () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2026-07-27T00:00:00Z",
        payload: {
          type: "function_call",
          name: "view_image",
          call_id: "call-codex",
          arguments: JSON.stringify({ path: "source.png" }),
        },
      },
      {
        type: "response_item",
        timestamp: "2026-07-27T00:00:01Z",
        payload: {
          type: "function_call_output",
          call_id: "call-codex",
          output: DATA_URL,
        },
      },
    ];
    const projectId = encodeProjectId(projectDir);
    const normalized = normalizeSession(
      buildCodexLoadedSession(entries, projectId),
    );
    const materialized = await new ToolResultMediaStore({
      dataDir,
    })
      .createMaterializer({
        provider: "codex",
        projectId,
        projectPath: projectDir,
        getSessionId: () => "session-codex",
      })
      .materializeMessages(normalized.messages);

    expect(JSON.stringify(materialized)).not.toContain("data:image");
    expect(materialized[1]?.toolResultMedia).toEqual([
      expect.objectContaining({
        state: "stored",
        mimeType: "image/png",
      }),
    ]);
    await expect(access(join(projectDir, ".yep"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(join(dataDir, "tool-results"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rematerializes persisted Codex media through session detail before fetch", async () => {
    const projectId = encodeProjectId(projectDir);
    const sourcePath = join(tempDir, "missing-view-image-source.png");
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2026-08-24T07:00:00Z",
        payload: {
          type: "custom_tool_call",
          call_id: "call-route-codex",
          name: "exec",
          input: `const r = await tools.view_image({ path: ${JSON.stringify(sourcePath)} }); image(r.image_url);`,
        },
      },
      {
        type: "response_item",
        timestamp: "2026-08-24T07:00:01Z",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-route-codex",
          output: [
            { type: "input_text", text: "Image loaded" },
            { type: "input_image", image_url: DATA_URL },
          ],
        },
      },
    ];
    const project: Project = {
      id: projectId,
      path: projectDir,
      name: "project",
      sessionCount: 1,
      sessionDir: join(tempDir, "codex-sessions"),
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
      provider: "codex",
    };
    const scanner = {
      getProject: vi.fn(async (requestedId: string) =>
        requestedId === projectId ? project : null,
      ),
      getOrCreateProject: vi.fn(async (requestedId: string) =>
        requestedId === projectId ? project : null,
      ),
    } as unknown as ProjectScanner;
    const store = new ToolResultMediaStore({ dataDir });
    const loaded = buildCodexLoadedSession(entries, projectId);
    const reader = {
      getSession: vi.fn(async () => loaded),
    } as unknown as ISessionReader;
    const sessionRoutes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => null),
        wasEverOwned: vi.fn(() => false),
      } as unknown as SessionsDeps["supervisor"],
      scanner,
      readerFactory: vi.fn(() => reader),
      toolResultMediaStore: store,
    });

    const detailResponse = await sessionRoutes.request(
      `/projects/${projectId}/sessions/session-codex?fullHistory=1`,
    );
    expect(detailResponse.status).toBe(200);
    const detail = await detailResponse.json();
    expect(JSON.stringify(detail)).not.toContain("data:image");
    const media = detail.messages[1]?.toolResultMedia?.[0] as
      | ToolResultMedia
      | undefined;
    expect(media).toMatchObject({
      state: "stored",
      toolCallId: "call-route-codex",
      mimeType: "image/png",
      byteLength: PNG_BYTES.byteLength,
    });
    if (media?.state !== "stored") throw new Error("Expected stored media");

    const revisitResponse = await sessionRoutes.request(
      `/projects/${projectId}/sessions/session-codex?fullHistory=1`,
    );
    const revisitDetail = await revisitResponse.json();
    expect(revisitResponse.status).toBe(200);
    expect(revisitDetail.messages[1]?.toolResultMedia?.[0]).toMatchObject({
      state: "stored",
      id: media.id,
    });
    expect(
      normalizeSession(loaded).messages[1]?.toolResultMedia,
    ).toBeUndefined();

    const mediaResponse = await createToolResultMediaRoutes({
      scanner,
      store,
    }).request(
      `/projects/${projectId}/sessions/session-codex/media/${media.id}`,
    );
    expect(mediaResponse.status).toBe(200);
    expect(mediaResponse.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await mediaResponse.arrayBuffer())).toEqual(PNG_BYTES);
    await expect(access(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never preserves historical materialization when preservation is enabled", async () => {
    const storagePolicy = new ProjectStoragePolicy({
      dataDir,
      getMode: () => "app-data",
    });
    const store = new ToolResultMediaStore({
      dataDir,
      storagePolicy,
      shouldPreserveLiveMedia: () => true,
    });
    const materialized = await store
      .createMaterializer({
        provider: "claude",
        projectId: encodeProjectId(projectDir),
        projectPath: projectDir,
        getSessionId: () => "historical-session",
      })
      .materializeMessages(toolImageMessages("historical-call"));

    expect(materialized[1]?.toolResultMedia).toHaveLength(1);
    await expect(
      access(
        storagePolicy.writePath(
          projectDir,
          "tool-results",
          "historical-session",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("expires transient media from the process idle sweep", async () => {
    const store = new ToolResultMediaStore({
      dataDir,
      storagePolicy: new ProjectStoragePolicy({
        dataDir,
        getMode: () => "app-data",
      }),
      transientMediaTtlMs: 1000,
    });
    await store
      .createMaterializer({
        provider: "claude",
        projectId: encodeProjectId(projectDir),
        projectPath: projectDir,
        getSessionId: () => "transient-session",
      })
      .materializeMessages(toolImageMessages("transient-call"));
    const transient = (
      store as unknown as { transientMedia: Map<string, unknown> }
    ).transientMedia;
    expect(transient.size).toBe(1);

    const later = Date.now() + 2000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      runIdleSweeps(later);
    } finally {
      clock.mockRestore();
    }
    expect(transient.size).toBe(0);
  });

  it("preserves only a new result crossing the live materializer boundary", async () => {
    const storagePolicy = new ProjectStoragePolicy({
      dataDir,
      getMode: () => "app-data",
    });
    const store = new ToolResultMediaStore({
      dataDir,
      storagePolicy,
      shouldPreserveLiveMedia: () => true,
    });
    const materialized = await store
      .createMaterializer(
        {
          provider: "claude",
          projectId: encodeProjectId(projectDir),
          projectPath: projectDir,
          getSessionId: () => "live-session",
        },
        { live: true },
      )
      .materializeMessages(toolImageMessages("live-call"));
    const media = materialized[1]?.toolResultMedia?.[0];
    if (media?.state !== "stored") throw new Error("Expected stored media");

    await expect(
      access(
        join(
          storagePolicy.writePath(projectDir, "tool-results", "live-session"),
          "records",
          `${media.id}.json`,
        ),
      ),
    ).resolves.toBeUndefined();
    await expect(access(join(projectDir, ".yep"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves Claude Read image behavior through the shared materializer", async () => {
    const store = new ToolResultMediaStore({ dataDir });
    const projectId = encodeProjectId(projectDir);
    const messages = [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "call-read",
              name: "Read",
              input: { file_path: "source.png" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-read",
              content: "Image read",
            },
          ],
        },
        toolUseResult: {
          type: "image",
          file: {
            base64: PNG_BASE64,
            type: "image/png",
            dimensions: { originalWidth: 1, originalHeight: 1 },
          },
        },
      },
    ];

    const materialized = await store
      .createMaterializer({
        provider: "claude",
        projectId,
        projectPath: projectDir,
        getSessionId: () => "session-read",
      })
      .materializeMessages(messages);

    expect(JSON.stringify(materialized)).not.toContain(PNG_BASE64);
    expect(materialized[1]?.toolResultMedia).toEqual([
      expect.objectContaining({ state: "stored", width: 1, height: 1 }),
    ]);
  });

  it("partitions grouped provider-neutral image blocks by tool call", async () => {
    const materialized = await new ToolResultMediaStore({ dataDir })
      .createMaterializer({
        provider: "opencode",
        projectId: encodeProjectId(projectDir),
        projectPath: projectDir,
        getSessionId: () => "session-neutral",
      })
      .materializeMessages([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "call-text",
                name: "ReadMetadata",
                input: {},
              },
              {
                type: "tool_use",
                id: "call-neutral",
                name: "RenderDiagram",
                input: {},
              },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "call-text",
                content: "No image here",
              },
              {
                type: "tool_result",
                tool_use_id: "call-neutral",
                content: [
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: "image/png",
                      data: PNG_BASE64,
                    },
                  },
                ],
              },
            ],
          },
        },
      ]);

    expect(JSON.stringify(materialized)).not.toContain(PNG_BASE64);
    expect(materialized[1]?.toolResultMedia).toEqual([
      expect.objectContaining({
        state: "stored",
        toolCallId: "call-neutral",
        mimeType: "image/png",
      }),
    ]);
  });

  it("materializes live Process messages before replay retains them", async () => {
    async function* messages(): AsyncGenerator<SDKMessage> {
      yield {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "call-live",
              name: "RenderDiagram",
              input: {},
            },
          ],
        },
      };
      yield {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-live",
              content: DATA_URL,
            },
          ],
        },
      };
    }

    const process = new Process(messages(), {
      queue: new MessageQueue(),
      projectId: encodeProjectId(projectDir),
      projectPath: projectDir,
      provider: "opencode",
      sessionId: "session-live",
      idleTimeoutMs: 20,
      toolResultMediaStore: new ToolResultMediaStore({ dataDir }),
    });

    await vi.waitFor(() => {
      expect(process.getMessageHistory().length).toBeGreaterThanOrEqual(2);
    });
    const history = process.getMessageHistory();
    expect(JSON.stringify(history)).not.toContain("data:image");
    expect(history[1]?.toolResultMedia).toEqual([
      expect.objectContaining({ state: "stored", mimeType: "image/png" }),
    ]);
    await process.abort();
  });

  it("serves only handles bound to the requested project and session", async () => {
    const store = new ToolResultMediaStore({ dataDir });
    const projectId = encodeProjectId(projectDir);
    const media = await captureDataUrl(store, projectDir, "session-route");
    if (media.state !== "stored") throw new Error("Expected stored media");

    const routes = createToolResultMediaRoutes({
      store,
      scanner: {
        getProject: async (requestedId: string) =>
          requestedId === projectId ? { path: projectDir } : null,
      } as ProjectScanner,
    });
    const response = await routes.request(
      `/projects/${projectId}/sessions/session-route/media/${media.id}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG_BYTES);

    const wrongSession = await routes.request(
      `/projects/${projectId}/sessions/other-session/media/${media.id}`,
    );
    expect(wrongSession.status).toBe(404);
    expect(
      await routes.request(
        `/projects/${encodeProjectId(join(tempDir, "other"))}/sessions/session-route/media/${media.id}`,
      ),
    ).toMatchObject({ status: 404 });
  });

  it("keeps the handle behind normal auth and outside public-share routes", async () => {
    const store = new ToolResultMediaStore({ dataDir });
    const projectId = encodeProjectId(projectDir);
    const media = await captureDataUrl(store, projectDir, "session-auth");
    if (media.state !== "stored") throw new Error("Expected stored media");
    const mediaRoutes = createToolResultMediaRoutes({
      store,
      scanner: {
        getProject: async (requestedId: string) =>
          requestedId === projectId ? { path: projectDir } : null,
      } as ProjectScanner,
    });
    const authService = {
      hasAccount: () => true,
      isEnabled: () => true,
      isLocalhostOpen: () => false,
      validateSession: async (sessionId: string) => sessionId === "authorized",
    } as AuthService;
    const app = new Hono();
    app.use("/api/*", createAuthMiddleware({ authService }));
    app.route("/api", mediaRoutes);
    const path = `/api/projects/${projectId}/sessions/session-auth/media/${media.id}`;

    expect((await app.request(path, undefined, {})).status).toBe(401);
    expect(
      (
        await app.request(
          path,
          {
            headers: { Cookie: `${SESSION_COOKIE_NAME}=authorized` },
          },
          {},
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          `/public-api/shares/not-a-share/sessions/session-auth/media/${media.id}`,
          undefined,
          {},
        )
      ).status,
    ).toBe(404);
  });
});

async function captureDataUrl(
  store: ToolResultMediaStore,
  projectDir: string,
  sessionId: string,
): Promise<ToolResultMedia> {
  return store.capture(
    { dataUrl: DATA_URL, claimedMimeType: "image/png" },
    {
      provider: "codex",
      projectId: encodeProjectId(projectDir),
      projectPath: projectDir,
      getSessionId: () => sessionId,
    },
    "call-image",
    0,
    { preserve: true },
  );
}

function buildCodexLoadedSession(
  entries: CodexSessionEntry[],
  projectId: ReturnType<typeof encodeProjectId>,
): LoadedSession {
  return {
    summary: {
      id: "session-codex",
      projectId,
      title: "Image session",
      fullTitle: "Image session",
      createdAt: "2026-07-27T00:00:00Z",
      updatedAt: "2026-07-27T00:00:01Z",
      messageCount: entries.length,
      status: "chat",
      provider: "codex",
    },
    data: {
      provider: "codex",
      events: [],
      session: { entries },
    },
  } as unknown as LoadedSession;
}

function toolImageMessages(toolCallId: string) {
  return [
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: toolCallId,
            name: "RenderDiagram",
            input: {},
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: toolCallId,
            content: DATA_URL,
          },
        ],
      },
    },
  ];
}
