import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNativeSessionId, toUrlProjectId } from "@yep-anywhere/shared";
import { expect, it, vi } from "vitest";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import { MockClaudeSDK } from "../../src/sdk/mock.js";
import { SessionIndexService } from "../../src/indexes/SessionIndexService.js";
import { PiSessionReader } from "../../src/sessions/pi-reader.js";
import { PiSessionCatalogAdapter } from "../../src/sessions/catalog-adapters/pi-catalog-adapter.js";
import { projectCatalogIdentities } from "../../src/sessions/catalog-identity.js";
import { listSessionsAcrossProviders } from "../../src/sessions/provider-resolution.js";
import { createApp } from "../setup/create-app.js";

it("projects scoped Pi sources once through native discovery, indexed metadata and public history across profile reopen", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const root = await realpath(await mkdtemp(join(tmpdir(), "ya-pi-source-")));
  const original = join(root, "project"),
    working = join(root, "working"),
    scope = join(root, "native"),
    otherScope = join(root, "other-native"),
    dataDir = join(root, "data");
  const originalId = toUrlProjectId(original),
    workingId = toUrlProjectId(working);
  const nativeId = parseNativeSessionId("native-pi-session"),
    publicId = "permanent-pi-public";
  await Promise.all(
    [original, working, scope, otherScope].map((p) =>
      mkdir(p, { recursive: true }),
    ),
  );
  for (const [index, nativeScope] of [scope, otherScope].entries()) {
    const directory = join(nativeScope, "--project--");
    await mkdir(directory);
    for (const id of [nativeId, "legacy-pi"])
      await writeFile(
        join(directory, `2026-11-01T00-00-00-000Z_${id}.jsonl`),
        [
          {
            type: "session",
            version: 3,
            id,
            cwd: original,
            timestamp: "2026-11-01T00:00:00Z",
          },
          {
            type: "message",
            id: "u1",
            parentId: null,
            timestamp: "2026-11-01T00:00:01Z",
            message: {
              role: "user",
              content: `${index === 0 ? "selected" : "other"} root ${id}`,
            },
          },
        ]
          .map((x) => JSON.stringify(x))
          .join("\n") + "\n",
      );
  }
  let storage: DiscoverySqliteService | undefined,
    app: ReturnType<typeof createApp> | undefined,
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
            "INSERT INTO session_identities VALUES (?, 'pi', ?, '2026-11-01T00:00:00Z', 'pi', ?, ?)",
          );
        try {
          insert.run(publicId, originalId, scope, nativeId);
          insert.run("other-public", originalId, otherScope, nativeId);
        } finally {
          insert.finalize();
        }
        await metadata.setWorkingProject(publicId, workingId, originalId);
      }
      index = new SessionIndexService({
        dataDir: join(root, "indexes"),
        projectsDir: join(root, "ambient"),
      });
      app = createApp({
        sdk: new MockClaudeSDK(),
        dataDir,
        discoverySqlite: storage,
        sessionMetadataService: metadata,
        sessionIndexService: index,
        projectsDir: join(root, "ambient"),
      });
      const results = await Promise.all(
        [
          [workingId, publicId, "selected"],
          [originalId, "other-public", "other"],
        ].map(async ([project, id, text]) => {
          const response = await app!.app.request(
            `/api/projects/${project}/sessions/${id}`,
          );
          expect(response.status).toBe(200);
          const body = await response.json();
          expect(body.session.id).toBe(id);
          expect(JSON.stringify(body.messages)).toContain(
            `${text} root ${nativeId}`,
          );
          return body;
        }),
      );
      expect(results[0].session.provider).toBe("pi");
      const summaries = await Promise.all(
        [
          [workingId, publicId],
          [originalId, "other-public"],
        ].map(async ([project, id]) => {
          const r = await app!.app.request(
            `/api/projects/${project}/sessions/${id}/metadata`,
          );
          expect(r.status).toBe(200);
          return r.json();
        }),
      );
      expect(summaries.map((x) => x.session.title)).toEqual([
        `selected root ${nativeId}`,
        `other root ${nativeId}`,
      ]);
      expect(
        (
          await app.app.request(
            `/api/projects/${workingId}/sessions/${nativeId}`,
          )
        ).status,
      ).toBe(404);
      const scan = await new PiSessionCatalogAdapter({
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
        {
          nativeStorageScope: scope,
          nativeSessionId: nativeId,
          projectId: originalId,
        },
      );
      expect(projected.some((row) => row.sessionId === "legacy-pi")).toBe(true);
      expect(projected.some((row) => row.sessionId === nativeId)).toBe(false);
      const reader = new PiSessionReader({
        sessionsDir: scope,
        projectPath: original,
      });
      try {
        const project = (await app.scanner.getOrCreateProject(originalId))!;
        const rows = await listSessionsAcrossProviders(project, {
          readerFactory: app.readerFactory,
          piReaderFactory: () => reader,
          piSessionsDir: scope,
          identities: metadata.identities,
        });
        expect(rows.map((row) => row.id)).toEqual(
          expect.arrayContaining([publicId, "legacy-pi"]),
        );
        expect(rows.some((row) => row.id === nativeId)).toBe(false);
        const pending = reader.getNativeSessionRef(nativeId);
        reader.close();
        expect(await pending).toBeNull();
        expect(await reader.getSession(nativeId, originalId)).toBeNull();
        expect(await reader.listSessions(originalId)).toEqual([]);
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
    await app?.disposeSessionReaders();
    index?.dispose();
    storage?.close();
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});
