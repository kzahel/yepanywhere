import {
  appendFile,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseNativeSessionId,
  parseYaSessionId,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { expect, it, vi } from "vitest";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { ScriptedClaudeProvider } from "../support/scripted-provider.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import { resolveNativeSessionRef } from "../../src/sessions/SessionIdentityStore.js";
import { MergedSessionReader } from "../../src/sessions/merged-reader.js";
import {
  findSessionSummaryAcrossProviders,
  listSessionListSummariesAcrossProviders,
  listSessionsAcrossProviders,
} from "../../src/sessions/provider-resolution.js";
import { RetainedSessionCollections } from "../../src/services/RetainedSessionCollections.js";
import {
  closeTestDiscoveryDatabases,
  openTestDiscoveryDatabase,
} from "../utils/session-metadata-database.js";
import { collectionCatalogAdapters } from "../../src/sessions/catalog-adapters/collection-catalog-adapters.js";
import { readRetainedSessionItems } from "../../src/routes/retained-session-collections.js";
import { vocabularySessions } from "../../src/services/voice/vocabulary-sessions.js";
import {
  metadataForNativeCatalogRow,
  projectCatalogIdentities,
} from "../../src/sessions/catalog-identity.js";
import { createApp } from "../setup/create-app.js";

it("projects discovery once across native collections and scoped summary lookups, including a merged private root and reopen", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "ya-discovery-identity-")),
  );
  const dataDir = join(root, "data");
  const projectPath = join(root, "project");
  const projectId = toUrlProjectId(projectPath);
  const otherProject = join(root, "other-project");
  const otherProjectId = toUrlProjectId(otherProject);
  const projectsDir = join(root, "claude");
  const claudeDir = join(projectsDir, projectPath.replace(/[/\\:]/g, "-"));
  const globalRoot = join(root, "codex-global");
  const privateRoot = join(root, "codex-private");
  const nativeId = parseNativeSessionId("019a0000-3333-7333-8333-333333333333");
  const publicId = parseYaSessionId("permanent-discovered-public");
  const timestamp = "2026-11-01T00:00:00.000Z";
  let storage: DiscoverySqliteService | undefined;
  let app: ReturnType<typeof createApp> | undefined;
  let collections: RetainedSessionCollections | undefined;
  try {
    await Promise.all(
      [projectPath, otherProject, claudeDir, globalRoot, privateRoot].map((p) =>
        mkdir(p, { recursive: true }),
      ),
    );
    await writeFile(
      join(claudeDir, "legacy-claude.jsonl"),
      JSON.stringify({
        type: "user",
        uuid: "human-1",
        sessionId: "legacy-claude",
        cwd: projectPath,
        timestamp,
        message: { role: "user", content: "preserved legacy Claude" },
      }) + "\n",
    );
    const file = join(
      privateRoot,
      `rollout-2026-11-01T00-00-00-${nativeId}.jsonl`,
    );
    await writeFile(
      file,
      [
        {
          type: "session_meta",
          timestamp,
          payload: {
            id: nativeId,
            cwd: projectPath,
            timestamp,
            model_provider: "ollama",
          },
        },
        {
          type: "event_msg",
          timestamp,
          payload: { type: "user_message", message: "private native source" },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    const native = await resolveNativeSessionRef(
      "codex-oss",
      privateRoot,
      nativeId,
    );
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
      if (restart === 0) {
        const insert = storage
          .getDatabase()
          .prepare(
            "INSERT INTO session_identities VALUES (?, 'codex-oss', ?, ?, 'codex', ?, ?)",
          );
        try {
          insert.run(
            publicId,
            projectId,
            timestamp,
            native.storageScope,
            nativeId,
          );
        } finally {
          insert.finalize();
        }
        await metadata.setProvider("legacy-claude", "claude-gateway");
        const unrelated = storage
          .getDatabase()
          .prepare(
            "INSERT INTO session_identities VALUES (?, 'claude', ?, ?, 'claude', ?, 'unrelated-claude-native')",
          );
        try {
          unrelated.run(nativeId, otherProjectId, timestamp, claudeDir);
        } finally {
          unrelated.finalize();
        }
        await metadata.setProvider(nativeId, "claude");
      }
      app = createApp({
        provider: new ScriptedClaudeProvider(),
        dataDir,
        projectsDir,
        codexSessionsDir: privateRoot,
        sessionMetadataService: metadata,
        discoverySqlite: storage,
      });
      const project = await app.scanner.getOrCreateProject(projectId);
      if (!project) throw new Error("expected project");
      const merged = new MergedSessionReader([
        app.readerFactory({ ...project, provider: "codex-oss" }, native),
        app.readerFactory({
          ...project,
          provider: "codex",
          sessionDir: globalRoot,
        }),
      ]);
      const resolution = {
        readerFactory: app.readerFactory,
        identities: metadata.identities,
        getRecordedProvider: (id: string) => metadata.getProvider(id),
        codexSessionsDir: globalRoot,
        codexReaderFactory: () => merged,
        grokSessionsDir: join(root, "empty-grok"),
        piSessionsDir: join(root, "empty-pi"),
      };
      for (const list of [
        listSessionsAcrossProviders,
        listSessionListSummariesAcrossProviders,
      ]) {
        const sessions = await list(project, resolution);
        expect(sessions.map((s) => s.id).sort()).toEqual(
          ["legacy-claude", publicId].sort(),
        );
        expect(sessions.find((s) => s.id === publicId)?.provider).toBe(
          "codex-oss",
        );
        expect(sessions.find((s) => s.id === "legacy-claude")?.provider).toBe(
          "claude-gateway",
        );
      }
      expect(
        metadata.identities.resolveYa(parseYaSessionId(nativeId)),
      ).toMatchObject({
        provider: "claude",
        projectId: otherProjectId,
        native: { id: "unrelated-claude-native" },
      });
      expect(metadata.getProvider(nativeId)).toBe("claude");
      expect(metadata.identities.lookupNative(native)?.sessionId).toBe(
        publicId,
      );
      for (const url of [
        `/api/projects/${projectId}/sessions`,
        "/api/sessions",
      ]) {
        const response = await app.app.request(url);
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(
          result.sessions.map((session: { id: string }) => session.id).sort(),
        ).toEqual(["legacy-claude", publicId].sort());
      }
      if (restart === 0) {
        // A global stored-source lookup is not proof of project membership.
        await app.scanner.getOrCreateProject(otherProjectId);
        const command = (id: string) =>
          app!.app.request(
            `/api/projects/${id}/sessions/legacy-claude/bang-commands`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Yep-Anywhere": "true",
              },
              body: JSON.stringify({ command: "echo membership-check" }),
            },
          );
        expect((await command(otherProjectId)).status).toBe(404);
        expect(metadata.getTranscriptDisplayObjects("legacy-claude")).toEqual(
          [],
        );
        const correct = await command(projectId);
        expect(correct.status).toBe(200);
        expect((await correct.json()).displayObject.cwd).toBe(projectPath);
        await metadata.setWorkingProject(
          "legacy-claude",
          otherProjectId,
          projectId,
        );
        expect((await command(projectId)).status).toBe(404);
        const moved = await command(otherProjectId);
        expect(moved.status).toBe(200);
        expect((await moved.json()).displayObject.cwd).toBe(otherProject);
        await metadata.setWorkingProject("legacy-claude", undefined, undefined);
      }
      const summary = await findSessionSummaryAcrossProviders(
        project,
        publicId,
        projectId,
        resolution,
      );
      expect(summary?.summary).toMatchObject({
        id: publicId,
        provider: "codex-oss",
        title: "private native source",
      });
      expect(summary?.nativeSessionId).toBe(nativeId);
      expect(
        await summary?.source.reader.getSessionFilePath?.(
          summary.nativeSessionId,
        ),
      ).toBe(file);
      if (restart === 1) {
        expect(
          JSON.stringify(
            await summary?.source.reader.getSession(
              summary.nativeSessionId,
              projectId,
            ),
          ),
        ).toContain("appended before restart");
      }

      collections = new RetainedSessionCollections({
        dataDir: join(root, "catalog"),
        database: openTestDiscoveryDatabase(join(root, "catalog")),
        adapters: (rows, signal, changedPaths) =>
          collectionCatalogAdapters(
            {
              ...resolution,
              scanner: app!.scanner,
              getCatalogFamilies: () => ["claude", "codex"],
            },
            rows,
            signal,
            changedPaths,
          ),
      });
      await collections.refresh();
      const { rows, catalog } = await collections.read();
      const row = rows.find((r) => r.sessionId === nativeId);
      expect(row?.nativeStorageScope).toBe(native.storageScope);
      expect(row?.storeKey).toBe(globalRoot);
      expect(row?.location).toEqual({ kind: "file", path: file });
      expect(
        (await projectCatalogIdentities(rows, metadata)).find(
          (r) => r.sessionId === publicId,
        )?.nativeSessionId,
      ).toBe(nativeId);
      if (!row) throw new Error("expected scoped native catalogue row");
      await metadata.setArchived(nativeId, true);
      await metadata.setArchived(publicId, false);
      expect(
        metadataForNativeCatalogRow(row, metadata)?.isArchived ?? false,
      ).toBe(false);
      await metadata.setArchived(publicId, true);
      expect(metadataForNativeCatalogRow(row, metadata)?.isArchived).toBe(true);
      expect(
        metadataForNativeCatalogRow(
          { ...row, nativeStorageScope: globalRoot },
          metadata,
        ),
      ).toBeUndefined();
      await metadata.setArchived(publicId, false);
      // The vocabulary consumer keeps native checkpoint keys but must read
      // this actual private root, not an ambient reader with the same N.
      const wrongFile = join(globalRoot, `rollout-${nativeId}.jsonl`);
      await writeFile(
        wrongFile,
        [
          JSON.stringify({
            type: "session_meta",
            timestamp,
            payload: { id: nativeId, cwd: projectPath, timestamp },
          }),
          JSON.stringify({
            type: "event_msg",
            timestamp,
            payload: {
              type: "user_message",
              message: "WRONG AMBIENT VOCABULARY",
            },
          }),
        ].join("\n") + "\n",
      );
      try {
        const vocabularyDeps = {
          ...resolution,
          codexReaderFactory: () =>
            app!.readerFactory({
              ...project,
              provider: "codex",
              sessionDir: globalRoot,
            }) as import("../../src/sessions/codex-reader.js").CodexSessionReader,
        };
        const collect = async (sourceRow: typeof row) => {
          const sessions = vocabularySessions(
            {
              readChanges: async () => ({
                ...catalog,
                full: true,
                rows: [sourceRow],
                removed: [],
              }),
              invalidate: vi.fn(),
            },
            app!.scanner,
            vocabularyDeps,
            0,
          );
          const first = await sessions[Symbol.asyncIterator]().next();
          if (first.done) return undefined;
          const batches = [];
          for await (const batch of first.value.messages()) batches.push(batch);
          return JSON.stringify(batches);
        };
        const learned = await collect(row);
        expect(learned).toContain("private native source");
        expect(learned).not.toContain("WRONG AMBIENT VOCABULARY");
        await expect(
          collect({ ...row, nativeStorageScope: undefined }),
        ).resolves.toBeUndefined();
      } finally {
        await rm(wrongFile);
      }
      // This shared projection also supplies the authorization catalogue.
      expect(
        (await projectCatalogIdentities(rows, metadata)).find(
          (row) => row.sessionId === publicId,
        ),
      ).toMatchObject({
        nativeSessionId: nativeId,
        provider: "codex-oss",
        projectId,
      });
      expect(
        metadata.identities.resolveYa(parseYaSessionId(nativeId)),
      ).toMatchObject({
        provider: "claude",
        projectId: otherProjectId,
        native: { id: "unrelated-claude-native" },
      });
      expect(metadata.getProvider(nativeId)).toBe("claude");
      const items = await readRetainedSessionItems(collections, {
        sessionMetadataService: metadata,
      });
      expect(items.sessions.map((s) => s.id).sort()).toEqual(
        ["legacy-claude", publicId].sort(),
      );
      if (restart === 0)
        await appendFile(
          file,
          JSON.stringify({
            type: "event_msg",
            timestamp: "2026-11-01T00:01:00.000Z",
            payload: {
              type: "user_message",
              message: "appended before restart",
            },
          }) + "\n",
        );
      await collections.dispose();
      collections = undefined;
      app.stopNotifications();
      await app.disposeSessionReaders();
      app = undefined;
      storage.close();
      storage = undefined;
    }
  } finally {
    await collections?.dispose();
    app?.stopNotifications();
    await app?.disposeSessionReaders();
    storage?.close();
    closeTestDiscoveryDatabases();
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});
