import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  realpath,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  parseNativeSessionId,
  parseYaSessionId,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { ClaudeProvider } from "../../src/sdk/providers/claude.js";
import { ClaudeSessionReader } from "../../src/sessions/reader.js";
import { createApp } from "../setup/create-app.js";

it("resolves public helper generators to their original native sources across root collisions and profile reopen", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const root = await realpath(
      await mkdtemp(join(tmpdir(), "ya-native-helper-")),
    ),
    original = join(root, "original"),
    working = join(root, "working"),
    dataDir = join(root, "data"),
    scopes = [join(root, "source"), join(root, "other-source")];
  const projectId = toUrlProjectId(original),
    workingId = toUrlProjectId(working),
    nativeId = parseNativeSessionId("019a0000-9999-7999-8999-999999999999"),
    publicId = parseYaSessionId("public-helper-generator");
  await Promise.all(
    [original, working, ...scopes].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  for (const [index, scope] of scopes.entries())
    await writeFile(
      join(scope, `${nativeId}.jsonl`),
      JSON.stringify({
        type: "user",
        uuid: "11111111-1111-4111-8111-111111111111",
        parentUuid: null,
        sessionId: nativeId,
        cwd: original,
        timestamp: "2026-11-01T00:00:00Z",
        message: {
          role: "user",
          content:
            index === 0
              ? "selected native generator"
              : "other native generator",
        },
      }) + "\n",
    );
  let app: ReturnType<typeof createApp> | undefined,
    storage: DiscoverySqliteService | undefined;
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
            "INSERT INTO session_identities VALUES (?, 'claude', ?, '2026-11-01T00:00:00Z', 'claude', ?, ?)",
          );
        try {
          insert.run(publicId, projectId, scopes[0], nativeId);
          insert.run("other-public-helper", projectId, scopes[1], nativeId);
        } finally {
          insert.finalize();
        }
        await metadata.setWorkingProject(publicId, workingId, projectId);
      }
      const provider = new ClaudeProvider();
      const generated = vi
        .spyOn(provider, "generateSummary")
        .mockImplementation(async (request) => {
          if (request.strategy !== "fork" || !request.nativeSource)
            throw new Error("missing actual source");
          expect(request.generatorSessionId).toBe(nativeId);
          expect(request.nativeSource.projectId).toBe(projectId);
          const reader = new ClaudeSessionReader({
            sessionDir: request.nativeSource.native.storageScope,
          });
          try {
            const loaded = await reader.getSession(
              request.generatorSessionId,
              projectId,
            );
            if (!loaded) throw new Error("missing native history");
            return { text: loaded.summary.title! };
          } finally {
            await reader.close();
          }
        });
      app = createApp({
        provider,
        dataDir,
        discoverySqlite: storage,
        sessionMetadataService: metadata,
        projectsDir: join(root, "ambient"),
      });
      const request = {
        purpose: "session-retitle" as const,
        strategy: "fork" as const,
        generatorSessionId: publicId,
        cwd: working,
        model: "sonnet",
      };
      expect(await app.supervisor.generateSummary("claude", request)).toEqual({
        text: "selected native generator",
      });
      expect(
        await app.supervisor.generateSummary("claude", {
          ...request,
          generatorSessionId: "other-public-helper",
          cwd: original,
        }),
      ).toEqual({ text: "other native generator" });
      await expect(
        app.supervisor.generateSummary("claude", {
          ...request,
          generatorSessionId: nativeId,
        }),
      ).rejects.toThrow();
      expect(generated).toHaveBeenCalledTimes(2);
      expect(metadata.identities.resolveYa(publicId)?.native?.id).toBe(
        nativeId,
      );
      expect(
        await readFile(join(scopes[0]!, `${nativeId}.jsonl`), "utf8"),
      ).toContain("selected native generator");
      // Cancellation after the real final native path proof must not invoke a provider.
      const reader = app.readerFactory(
        {
          id: projectId,
          path: original,
          name: "fixture",
          sessionDir: scopes[0]!,
          provider: "claude",
        },
        metadata.identities.resolveYa(publicId)!.native!,
      );
      const path = reader.getSessionFilePath!.bind(reader),
        controller = new AbortController();
      const acquire = vi
        .spyOn(reader, "getSessionFilePath")
        .mockImplementation(async (id) => {
          const found = await path(id);
          controller.abort();
          return found;
        });
      await expect(
        app.supervisor.generateSummary("claude", {
          ...request,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(generated).toHaveBeenCalledTimes(2);
      acquire.mockRestore();
      await app.disposeSessionReaders();
      app = undefined;
      storage.close();
      storage = undefined;
    }
  } finally {
    await app?.disposeSessionReaders();
    storage?.close();
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});
