import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNativeSessionId, toUrlProjectId } from "@yep-anywhere/shared";
import { assert, expect, it, vi } from "vitest";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import { ScriptedClaudeProvider } from "../support/scripted-provider.js";
import { SessionIndexService } from "../../src/indexes/SessionIndexService.js";
import { GeminiSessionReader } from "../../src/sessions/gemini-reader.js";
import { collectionCatalogAdapters } from "../../src/sessions/catalog-adapters/collection-catalog-adapters.js";
import { hashProjectPath } from "../../src/projects/gemini-project-map.js";
import { projectCatalogIdentities } from "../../src/sessions/catalog-identity.js";
import { listSessionsAcrossProviders } from "../../src/sessions/provider-resolution.js";
import { RETIRED_GEMINI_MESSAGE } from "../../src/sdk/providers/retired-provider.js";
import { createApp } from "../setup/create-app.js";

it("projects scoped Gemini sources once through native discovery, indexed metadata and public history across profile reopen", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "ya-gemini-source-")),
  );
  const original = join(root, "project-alias"),
    physicalOriginal = join(root, "physical-project"),
    working = join(root, "working"),
    scope = join(root, "native"),
    otherScope = join(root, "other-native"),
    dataDir = join(root, "data");
  const originalId = toUrlProjectId(original),
    workingId = toUrlProjectId(working);
  const nativeId = parseNativeSessionId("native-gemini-session"),
    publicId = "permanent-gemini-public";
  await Promise.all(
    [physicalOriginal, working, scope, otherScope].map((p) =>
      mkdir(p, { recursive: true }),
    ),
  );
  await symlink(physicalOriginal, original, "junction");
  for (const [index, nativeScope] of [scope, otherScope].entries()) {
    const directory = join(nativeScope, "actual-native-slug", "chats");
    await mkdir(directory, { recursive: true });
    for (const id of [nativeId, "legacy-gemini"])
      await writeFile(
        join(directory, `session-${id}.json`),
        JSON.stringify({
          sessionId: id,
          projectHash: hashProjectPath(physicalOriginal),
          startTime: "2026-11-01T00:00:00Z",
          lastUpdated: "2026-11-01T00:00:01Z",
          messages: [
            {
              id: "u1",
              type: "user",
              timestamp: "2026-11-01T00:00:01Z",
              content: `${index === 0 ? "selected" : "other"} root ${id}`,
            },
          ],
        }),
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
            "INSERT INTO session_identities VALUES (?, 'gemini-acp', ?, '2026-11-01T00:00:00Z', 'gemini', ?, ?)",
          );
        try {
          insert.run(publicId, originalId, scope, nativeId);
          insert.run("other-public", originalId, otherScope, nativeId);
        } finally {
          insert.finalize();
        }
        await metadata.setWorkingProject(publicId, workingId, originalId);
        metadata.creations.admit({
          requestId: "saved-gemini-request",
          context: {
            owner: { kind: "superuser" },
            source: { kind: "request", provenance: { surface: "web" } },
          },
          request: {
            projectPath: working,
            projectId: workingId,
            provider: "gemini-acp",
            message: "original saved input",
            settings: {
              permissionMode: "default",
              requestedModel: "default",
              thinking: null,
              effort: null,
              serviceTier: null,
            },
            launch: { schemaVersion: 1 },
          },
        });
      }
      index = new SessionIndexService({
        database: storage.getDatabase(),
        dataDir: join(root, "indexes"),
        projectsDir: join(root, "ambient"),
      });
      const claude = new ScriptedClaudeProvider();
      const startClaude = vi.spyOn(claude, "startSession");
      app = createApp({
        provider: claude,
        geminiSessionsDir: scope,
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
      expect(results[0].session.provider).toBe("gemini-acp");
      if (restart) {
        const post = (path: string, body: object) =>
          app!.app.request(path, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Yep-Anywhere": "true",
            },
            body: JSON.stringify(body),
          });
        const target = `/api/projects/${workingId}/sessions/${publicId}`;
        for (const [path, body] of [
          [`${target}/resume`, { message: "keep the original provider" }],
          [
            `${target}/resume`,
            { message: "no replacement", provider: "claude" },
          ],
          [`${target}/reactivate`, {}],
          [
            `/api/projects/${workingId}/session-creations`,
            { message: "no launch", provider: "gemini" },
          ],
          [
            `/api/projects/${workingId}/session-creations`,
            { message: "no launch", provider: "gemini-acp" },
          ],
        ] as const) {
          const response = await post(path, body);
          expect(response.status, await response.clone().text()).toBe(409);
          expect(await response.json()).toMatchObject({
            error: RETIRED_GEMINI_MESSAGE,
          });
        }
        await expect(
          app.supervisor.resumeSession(publicId, working, {
            text: "no background resume",
          }),
        ).rejects.toThrow(RETIRED_GEMINI_MESSAGE);
        const saved = metadata.creations.get(
          { kind: "superuser" },
          "saved-gemini-request",
        );
        expect(saved).toBeDefined();
        const authorize = vi.fn();
        await expect(
          app.supervisor.startSavedSession(saved!.attempt, authorize),
        ).rejects.toThrow(RETIRED_GEMINI_MESSAGE);
        expect(authorize).not.toHaveBeenCalled();
        expect(startClaude).not.toHaveBeenCalled();
        expect(app.supervisor.getAllProcesses()).toHaveLength(0);
      }

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
      const reader = new GeminiSessionReader({
        sessionsDir: scope,
        projectPath: original,
        hashToCwd: new Map([[hashProjectPath(physicalOriginal), original]]),
      });
      const project = {
        ...(await app.scanner.getOrCreateProject(originalId))!,
        provider: "gemini" as const,
        sessionDir: scope,
      };
      const listing = vi
        .spyOn(app.scanner, "listFileCatalogProjects")
        .mockResolvedValue([project]);
      const deps = {
        scanner: app.scanner,
        getCatalogFamilies: () => ["gemini" as const],
        readerFactory: () => reader,
        geminiReaderFactory: () => reader,
        geminiSessionsDir: scope,
        sessionIndexService: index,
      };
      const adapters = await collectionCatalogAdapters(
        deps,
        [],
        new AbortController().signal,
      );
      assert(Array.isArray(adapters));
      const nativeRows: import("../../src/sessions/catalog-types.js").SessionCatalogRow[] =
        [];
      for (const adapter of adapters) {
        const scan = await adapter.scan({
          catalogEpoch: "test",
          targetGeneration: restart + 1,
          mode: { kind: "complete" },
          signal: new AbortController().signal,
        });
        for await (const row of scan.rows) nativeRows.push(row);
      }
      expect(nativeRows).toHaveLength(2);
      expect(
        nativeRows.every(
          (row) => row.rowFormat === 4 && row.nativeStorageScope === scope,
        ),
      ).toBe(true);
      const oldRows = nativeRows.map((row) => ({
        ...row,
        rowFormat: 3,
        nativeStorageScope: undefined,
      }));
      const refreshedAdapters = await collectionCatalogAdapters(
        deps,
        oldRows,
        new AbortController().signal,
      );
      assert(Array.isArray(refreshedAdapters));
      for (const adapter of refreshedAdapters) {
        const scan = await adapter.scan({
          catalogEpoch: "test",
          targetGeneration: restart + 2,
          mode: { kind: "complete" },
          signal: new AbortController().signal,
        });
        for await (const row of scan.rows)
          expect(row.nativeStorageScope).toBe(scope);
      }
      listing.mockRestore();
      const projected = await projectCatalogIdentities(nativeRows, metadata);
      expect(projected.find((row) => row.sessionId === publicId)).toMatchObject(
        {
          nativeStorageScope: scope,
          nativeSessionId: nativeId,
          projectId: originalId,
        },
      );
      expect(projected.some((row) => row.sessionId === "legacy-gemini")).toBe(
        true,
      );
      expect(projected.some((row) => row.sessionId === nativeId)).toBe(false);
      try {
        const rows = await listSessionsAcrossProviders(project, {
          readerFactory: app.readerFactory,
          geminiReaderFactory: () => reader,
          geminiSessionsDir: scope,
          identities: metadata.identities,
        });
        expect(rows.map((row) => row.id)).toEqual(
          expect.arrayContaining([publicId, "legacy-gemini"]),
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
