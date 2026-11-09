import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import type { FSWatcher } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseNativeSessionId,
  toUrlProjectId,
  type ToolResultMedia,
  type YepMessage,
} from "@yep-anywhere/shared";
import { expect, it, vi } from "vitest";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import { ScriptedClaudeProvider } from "../support/scripted-provider.js";
import { SessionIndexService } from "../../src/indexes/SessionIndexService.js";
import { GrokSessionReader } from "../../src/sessions/grok-reader.js";
import { GrokSessionCatalogAdapter } from "../../src/sessions/catalog-adapters/grok-catalog-adapter.js";
import { projectCatalogIdentities } from "../../src/sessions/catalog-identity.js";
import { listSessionsAcrossProviders } from "../../src/sessions/provider-resolution.js";
import { handleSessionWatchSubscribe } from "../../src/routes/ws-relay-handlers.js";
import * as sharedWatches from "../../src/watcher/SharedDirectoryWatcher.js";
import { createApp } from "../setup/create-app.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
function update(value: Record<string, unknown>, stamp = 1_790_000_000) {
  return JSON.stringify({ timestamp: stamp, params: { update: value } }) + "\n";
}
function text(text: string) {
  return update({
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text },
  });
}
function image(id: string, path: string) {
  return (
    update({
      sessionUpdate: "tool_call",
      toolCallId: id,
      rawInput: { variant: "ImageGen", prompt: "fixture" },
      _meta: {
        "x.ai/tool": {
          version: 1,
          name: "image_gen",
          kind: "image.generate",
          namespace: "xai",
          label: "Generate Image",
          read_only: false,
          input: {},
        },
      },
    }) +
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: id,
      status: "completed",
      rawOutput: { type: "ImageGen", path, filename: "fixture.png" },
    })
  );
}

it("keeps Grok native ids, late replay, child and media sources scoped behind public identity through reopen", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const root = await realpath(await mkdtemp(join(tmpdir(), "ya-grok-source-")));
  const projectPath = join(root, "project"),
    workingPath = join(root, "working"),
    scope = join(root, "native"),
    otherScope = join(root, "other-native"),
    dataDir = join(root, "data");
  await Promise.all(
    [projectPath, workingPath, scope, otherScope].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  const projectId = toUrlProjectId(projectPath),
    workingId = toUrlProjectId(workingPath),
    nativeId = parseNativeSessionId("native-grok-source"),
    publicId = "permanent-grok-public";
  const parentDir = join(
    scope,
    encodeURIComponent(projectPath),
    "physical-directory",
  );
  const otherDir = join(
    otherScope,
    encodeURIComponent(projectPath),
    "physical-directory",
  );
  const writeSession = async (
    dir: string,
    id: string,
    title: string,
    history?: string,
  ) => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "summary.json"),
      JSON.stringify({
        info: { id, cwd: projectPath },
        created_at: "2026-11-01T00:00:00Z",
        updated_at: "2026-11-01T00:00:01Z",
        generated_title: title,
        num_messages: history ? 1 : 0,
        current_model_id: "grok-build",
      }),
    );
    if (history !== undefined)
      await writeFile(join(dir, "updates.jsonl"), history);
  };
  await writeSession(parentDir, nativeId, "selected private root");
  await writeSession(
    otherDir,
    nativeId,
    "other private root",
    text("other exact history"),
  );
  await writeSession(
    join(scope, encodeURIComponent(projectPath), "legacy-grok"),
    "legacy-grok",
    "legacy session",
    text("legacy history"),
  );
  await Promise.all(
    [join(parentDir, "images"), join(otherDir, "images")].map((path) =>
      mkdir(path),
    ),
  );
  const ownImage = join(parentDir, "images", "own.png"),
    foreignImage = join(otherDir, "images", "foreign.png");
  await writeFile(ownImage, png);
  await writeFile(foreignImage, png);
  const subscriptions = new Map<string, () => void>();
  let app: ReturnType<typeof createApp> | undefined,
    storage: DiscoverySqliteService | undefined,
    index: SessionIndexService | undefined;
  try {
    for (let restart = 0; restart < 2; restart++) {
      storage = new DiscoverySqliteService({
        dataDir,
        probeNetworkFilesystem: () => undefined,
      });
      const metadata = new SessionMetadataService({
        dataDir,
        database: storage.getDatabase(),
      });
      await metadata.initialize();
      if (!restart) {
        const insert = storage
          .getDatabase()
          .prepare(
            "INSERT INTO session_identities VALUES (?, 'grok', ?, '2026-11-01T00:00:00Z', 'grok', ?, ?)",
          );
        try {
          insert.run(publicId, projectId, scope, nativeId);
          insert.run("other-public", projectId, otherScope, nativeId);
        } finally {
          insert.finalize();
        }
        await metadata.setWorkingProject(publicId, workingId, projectId);
      }
      index = new SessionIndexService({
        database: storage.getDatabase(),
        dataDir: join(root, "indexes"),
        projectsDir: join(root, "empty-ambient"),
      });
      app = createApp({
        provider: new ScriptedClaudeProvider(),
        dataDir,
        sessionMetadataService: metadata,
        discoverySqlite: storage,
        sessionIndexService: index,
        projectsDir: join(root, "empty-ambient"),
        allowedImagePaths: [],
      });
      const read = async (id = publicId, project = workingId) => {
        const response = await app!.app.request(
          `/api/projects/${project}/sessions/${id}`,
        );
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.session.id).toBe(id);
        return body;
      };
      const first = await read();
      expect(first.session.provider).toBe("grok");
      if (!restart) expect(first.messages).toEqual([]);
      expect(
        JSON.stringify((await read("other-public", projectId)).messages),
      ).toContain("other exact history");
      expect(
        (
          await app.app.request(
            `/api/projects/${workingId}/sessions/${nativeId}`,
          )
        ).status,
      ).toBe(404);
      const summaries = await Promise.all(
        [
          [workingId, publicId],
          [projectId, "other-public"],
        ].map(async ([project, id]) => {
          const r = await app!.app.request(
            `/api/projects/${project}/sessions/${id}/metadata`,
          );
          expect(r.status).toBe(200);
          return r.json();
        }),
      );
      expect(summaries.map((body) => body.session.title)).toEqual([
        "selected private root",
        "other private root",
      ]);
      if (!restart) {
        // The parent read warmed discovery before this real child appeared.
        const childId = "new-grok-child";
        await writeSession(
          join(scope, encodeURIComponent(projectPath), childId),
          childId,
          "new child",
          text("selected child history"),
        );
        const childMeta = join(parentDir, "subagents", childId);
        await mkdir(childMeta, { recursive: true });
        await writeFile(
          join(childMeta, "meta.json"),
          JSON.stringify({
            subagent_id: childId,
            child_session_id: childId,
            parent_session_id: nativeId,
            description: "child of selected parent",
            status: "completed",
          }),
        );
        const child = await app.app.request(
          `/api/projects/${workingId}/sessions/${publicId}/agents/${childId}`,
        );
        expect(child.status).toBe(200);
        expect(JSON.stringify(await child.json())).toContain(
          "selected child history",
        );
        const unrelated = "unrelated-grok";
        await writeSession(
          join(scope, encodeURIComponent(projectPath), unrelated),
          unrelated,
          "unrelated session",
          text("unrelated content"),
        );
        expect(
          (
            await app.app.request(
              `/api/projects/${workingId}/sessions/${publicId}/agents/${unrelated}`,
            )
          ).status,
        ).toBe(404);
        let ready!: (lease: FSWatcher) => void;
        const watching = new Promise<FSWatcher>((resolve) => {
          ready = resolve;
        });
        const watch = sharedWatches.watchSharedDirectory;
        const spy = vi
          .spyOn(sharedWatches, "watchSharedDirectory")
          .mockImplementation((...args) => {
            const lease = watch(...args);
            ready(lease);
            return lease;
          });
        const changes = [0, 1].map(
          (viewer) =>
            new Promise<YepMessage>((resolve) =>
              handleSessionWatchSubscribe(
                subscriptions,
                {
                  type: "subscribe",
                  channel: "session-watch",
                  subscriptionId: `viewer-${viewer}`,
                  sessionId: publicId,
                  projectId: workingId,
                  provider: "claude",
                },
                (event) => {
                  if (
                    event.type === "event" &&
                    event.eventType === "session-watch-change"
                  )
                    resolve(event);
                },
                app!.focusedSessionWatchManager,
              ),
            ),
        );
        const lease = await watching,
          close = vi.spyOn(lease, "close");
        const summaryBytes = await readFile(join(parentDir, "summary.json"));
        await writeFile(
          join(parentDir, "updates.jsonl"),
          text("late-created exact replay") +
            image("own-image", ownImage) +
            image("foreign-image", foreignImage),
        );
        for (const event of await Promise.all(changes)) {
          expect(event.type).toBe("event");
          if (event.type === "event")
            expect(event.data).toMatchObject({
              sessionId: publicId,
              projectId: workingId,
              provider: "grok",
              path: join(parentDir, "summary.json"),
            });
        }
        expect(await readFile(join(parentDir, "summary.json"))).toEqual(
          summaryBytes,
        );
        const refreshed = await read();
        expect(JSON.stringify(refreshed.messages)).toContain(
          "late-created exact replay",
        );
        const media = refreshed.messages.flatMap(
          (message: { toolResultMedia?: ToolResultMedia[] }) =>
            message.toolResultMedia ?? [],
        ) as ToolResultMedia[];
        expect(
          media.find((item) => item.toolCallId === "own-image"),
        ).toMatchObject({ state: "stored", mimeType: "image/png" });
        expect(
          media.find((item) => item.toolCallId === "foreign-image"),
        ).toMatchObject({ state: "rejected", reason: "source-unavailable" });
        const own = media.find((item) => item.toolCallId === "own-image");
        if (own?.state !== "stored") throw new Error("missing owned media");
        const imageResponse = await app.app.request(
          `/api/projects/${workingId}/sessions/${publicId}/media/${own.id}`,
        );
        expect(imageResponse.status).toBe(200);
        expect(Buffer.from(await imageResponse.arrayBuffer())).toEqual(png);
        subscriptions.get("viewer-0")!();
        subscriptions.delete("viewer-0");
        expect(close).not.toHaveBeenCalled();
        subscriptions.get("viewer-1")!();
        subscriptions.delete("viewer-1");
        expect(close).toHaveBeenCalledTimes(1);
        spy.mockRestore();
      } else
        expect(JSON.stringify(first.messages)).toContain(
          "late-created exact replay",
        );
      const scan = await new GrokSessionCatalogAdapter({
        sessionsDir: scope,
      }).scan({
        catalogEpoch: "test",
        targetGeneration: restart + 1,
        mode: { kind: "complete" },
        signal: new AbortController().signal,
      });
      const projected = await projectCatalogIdentities(
        [
          ...(scan.rows as Iterable<
            import("../../src/sessions/catalog-types.js").SessionCatalogRow
          >),
        ],
        metadata,
      );
      expect(projected.find((row) => row.sessionId === publicId)).toMatchObject(
        { nativeSessionId: nativeId, nativeStorageScope: scope, projectId },
      );
      expect(
        projected.some(
          (row) =>
            row.sessionId === nativeId ||
            row.sessionId === "physical-directory" ||
            row.sessionId === "new-grok-child",
        ),
      ).toBe(false);
      const reader = new GrokSessionReader({ sessionsDir: scope, projectPath });
      try {
        const project = (await app.scanner.getOrCreateProject(projectId))!;
        const rows = await listSessionsAcrossProviders(project, {
          readerFactory: app.readerFactory,
          identities: metadata.identities,
          grokReaderFactory: () => reader,
          grokSessionsDir: scope,
        });
        expect(rows.map((row) => row.id)).toEqual(
          expect.arrayContaining([publicId, "legacy-grok"]),
        );
        expect(rows.some((row) => row.id === nativeId)).toBe(false);
        expect(
          await reader.getNativeSessionRef(
            parseNativeSessionId("physical-directory"),
          ),
        ).toBeNull();
        const pending = reader.getNativeSessionRef(nativeId);
        reader.close();
        expect(await pending).toBeNull();
        expect(await reader.getSession(nativeId, projectId)).toBeNull();
      } finally {
        reader.close();
      }
      await app.disposeSessionReaders();
      app = undefined;
      index.dispose();
      index = undefined;
      storage.close();
      storage = undefined;
    }
  } finally {
    for (const release of subscriptions.values()) release();
    await app?.disposeSessionReaders();
    index?.dispose();
    storage?.close();
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});
