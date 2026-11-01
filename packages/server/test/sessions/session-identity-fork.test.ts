import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
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
import { getLogger } from "../../src/logging/logger.js";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { ClaudeProvider } from "../../src/sdk/providers/claude.js";
import { PiProvider } from "../../src/sdk/providers/pi.js";
import { MockClaudeSDK } from "../../src/sdk/mock.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import { createApp } from "../setup/create-app.js";

it("forks and clones the native Claude source while keeping public lineage and durable child addresses", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const warnings = vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
  const root = await realpath(await mkdtemp(join(tmpdir(), "ya-native-fork-")));
  const dataDir = join(root, "data");
  const sourcePath = join(root, "original-project");
  const workingPath = join(root, "working-project");
  const sourceProjectId = toUrlProjectId(sourcePath);
  const workingProjectId = toUrlProjectId(workingPath);
  const claudeConfig = join(root, "claude");
  vi.stubEnv("CLAUDE_CONFIG_DIR", claudeConfig);
  const nativeRoot = join(
    claudeConfig,
    "projects",
    sourcePath.replace(/[/\\:]/g, "-"),
  );
  const publicId = parseYaSessionId("permanent-fork-parent");
  const nativeId = "019a0000-6666-7666-8666-666666666666";
  const timestamp = "2026-11-01T00:00:00.000Z";
  const children: string[] = [];
  let app: ReturnType<typeof createApp> | undefined;
  let storage: DiscoverySqliteService | undefined;
  try {
    await Promise.all(
      [sourcePath, workingPath, nativeRoot].map((path) =>
        mkdir(path, { recursive: true }),
      ),
    );
    const sourceFile = join(nativeRoot, `${nativeId}.jsonl`);
    const source =
      [
        {
          type: "user",
          uuid: "11111111-1111-4111-8111-111111111111",
          parentUuid: null,
          sessionId: nativeId,
          cwd: sourcePath,
          timestamp,
          message: { role: "user", content: "correct private parent history" },
        },
        {
          type: "assistant",
          uuid: "22222222-2222-4222-8222-222222222222",
          parentUuid: "11111111-1111-4111-8111-111111111111",
          sessionId: nativeId,
          cwd: sourcePath,
          timestamp,
          message: { role: "assistant", content: "completed private answer" },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + '\n{"type":"assistant"';
    await writeFile(sourceFile, source);
    const offLayout = join(root, "unqualified-native-store");
    await mkdir(offLayout);
    await writeFile(join(offLayout, nativeId + ".jsonl"), source);
    const before = await readdir(nativeRoot);
    await expect(
      new ClaudeProvider().forkSession({
        nativeSessionId: parseNativeSessionId(nativeId),
        cwd: workingPath,
        nativeSource: {
          native: {
            family: "claude",
            storageScope: nativeRoot,
            id: parseNativeSessionId(nativeId),
          },
          filePath: sourceFile,
          projectId: sourceProjectId,
        },
        upToMessageId: "missing-anchor",
      }),
    ).rejects.toThrow("not found");
    expect(await readdir(nativeRoot)).toEqual(before);
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
            "INSERT INTO session_identities VALUES (?, 'claude', ?, ?, 'claude', ?, ?)",
          );
        try {
          insert.run(
            publicId,
            sourceProjectId,
            timestamp,
            nativeRoot,
            nativeId,
          );
        } finally {
          insert.finalize();
        }
        await metadata.setProvider(publicId, "claude");
        await metadata.setWorkingProject(
          publicId,
          workingProjectId,
          sourceProjectId,
        );
        await metadata.recordEffectiveLaunchSettings(publicId, {
          schemaVersion: 1,
          revision: 1,
          permissionMode: "bypassPermissions",
          requestedModel: "source-model",
          serviceTier: null,
          thinking: null,
          effort: null,
        });
      }
      const provider = new ClaudeProvider();
      const fork = vi.spyOn(provider, "forkSession");
      const launch = vi
        .spyOn(provider, "startSession")
        .mockImplementation(async () => {
          throw new Error("a cold native copy must not launch a turn");
        });
      app = createApp({
        sdk: new MockClaudeSDK(),
        provider,
        dataDir,
        projectsDir: join(root, "ambient"),
        sessionMetadataService: metadata,
        discoverySqlite: storage,
      });
      if (restart === 0) {
        for (const action of ["fork", "clone"]) {
          const response = await app.app.request(
            `/api/projects/${workingProjectId}/sessions/${publicId}/${action}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Yep-Anywhere": "true",
              },
              body: JSON.stringify(
                action === "fork"
                  ? { upToMessageId: "22222222-2222-4222-8222-222222222222" }
                  : {},
              ),
            },
          );
          expect(response.status, await response.clone().text()).toBe(200);
          const body = await response.json();
          const childId = body.sessionId ?? body.newSessionId;
          expect(typeof childId).toBe("string");
          expect(childId).not.toBe(nativeId);
          expect(childId).not.toBe(publicId);
          children.push(childId);
          const identity = metadata.identities.resolveYa(
            parseYaSessionId(childId),
          );
          expect(identity).toMatchObject({
            projectId: sourceProjectId,
            provider: "claude",
            native: { id: childId, storageScope: nativeRoot },
          });
          expect(metadata.getMetadata(childId)).toMatchObject({
            forkedFromSessionId: publicId,
            workingProjectId,
            transcriptProjectId: sourceProjectId,
          });
          expect(
            await readFile(join(nativeRoot, `${childId}.jsonl`), "utf8"),
          ).toContain("correct private parent history");
        }
        const unsupported = storage
          .getDatabase()
          .prepare(
            "INSERT INTO session_identities VALUES (?, 'claude', ?, ?, 'claude', ?, ?)",
          );
        try {
          unsupported.run(
            "unqualified-copy",
            sourceProjectId,
            timestamp,
            offLayout,
            nativeId,
          );
        } finally {
          unsupported.finalize();
        }
        for (const action of ["fork", "clone"]) {
          const refused = await app.app.request(
            `/api/projects/${sourceProjectId}/sessions/unqualified-copy/${action}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Yep-Anywhere": "true",
              },
              body: "{}",
            },
          );
          expect(refused.status).toBe(500);
          expect(await refused.text()).toContain(
            "scoped resume is not qualified",
          );
          expect(await readdir(offLayout)).toEqual([nativeId + ".jsonl"]);
        }
        expect(warnings).toHaveBeenCalledWith(
          expect.objectContaining({
            event: "session_fork_failed",
            sessionId: "unqualified-copy",
            error: expect.stringContaining("scoped resume is not qualified"),
          }),
          "Transcript fork failed",
        );
        warnings.mockRestore();
        const unboundId = "019a0000-9999-7999-8999-999999999999";
        const unbound = storage
          .getDatabase()
          .prepare(
            "INSERT INTO session_identities VALUES (?, 'claude', ?, ?, NULL, NULL, NULL)",
          );
        try {
          unbound.run(unboundId, sourceProjectId, timestamp);
        } finally {
          unbound.finalize();
        }
        const ambient = join(
          root,
          "ambient",
          workingPath.replace(/[/\\:]/g, "-"),
        );
        await mkdir(ambient, { recursive: true });
        await writeFile(join(ambient, unboundId + ".jsonl"), source);
        await expect(
          app.supervisor.forkSession({
            sessionId: unboundId,
            projectPath: workingPath,
            providerName: "claude",
          }),
        ).rejects.toThrow("no readable native fork source");
        const refused = await app.app.request(
          `/api/projects/${workingProjectId}/sessions/${unboundId}/clone`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Yep-Anywhere": "true",
            },
            body: "{}",
          },
        );
        expect(refused.status).toBe(409);
        expect(fork).toHaveBeenCalledTimes(2);
        expect(fork.mock.calls[0]?.[0]).toMatchObject({
          nativeSessionId: nativeId,
          nativeSource: {
            native: { id: nativeId, storageScope: nativeRoot },
            filePath: sourceFile,
            projectId: sourceProjectId,
          },
        });
        expect(fork.mock.calls[0]?.[0]).not.toHaveProperty("sessionId");
        const adoption = vi.spyOn(metadata.identities, "adoptDiscovered");
        adoption.mockImplementationOnce(() => {
          throw new Error("injected identity save failure");
        });
        await expect(
          app.supervisor.forkSession({
            sessionId: publicId,
            projectPath: workingPath,
            providerName: "claude",
          }),
        ).rejects.toMatchObject({
          name: "ForkSettingsPersistenceError",
          sessionId: expect.any(String),
          message: expect.stringContaining("A transcript child was created"),
        });
        const retainedResult = await fork.mock.results.at(-1)?.value;
        expect(await readFile(retainedResult.filePath!, "utf8")).toContain(
          "correct private parent history",
        );
        adoption.mockRestore();
      }
      for (const childId of children) {
        const response = await app.app.request(
          `/api/projects/${workingProjectId}/sessions/${childId}`,
        );
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.session.id).toBe(childId);
        expect(JSON.stringify(body.messages)).toContain(
          "correct private parent history",
        );
      }
      expect(launch).not.toHaveBeenCalled();
      expect(await readFile(sourceFile, "utf8")).toBe(source);
      app.stopNotifications();
      await app.disposeSessionReaders();
      app = undefined;
      storage.close();
      storage = undefined;
    }
  } finally {
    app?.stopNotifications();
    await app?.disposeSessionReaders();
    storage?.close();
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

it("reads a retained Pi fork through the recorded native root after profile reopen", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const root = await realpath(await mkdtemp(join(tmpdir(), "ya-pi-fork-")));
  const projectPath = join(root, "project");
  const projectId = toUrlProjectId(projectPath);
  const piAgentDir = join(root, "private-pi");
  vi.stubEnv("PI_CODING_AGENT_DIR", piAgentDir);
  const nativeRoot = join(piAgentDir, "sessions");
  const dataDir = join(root, "data");
  const nativeId = "pi-native-parent";
  const publicId = parseYaSessionId("pi-public-parent");
  let app: ReturnType<typeof createApp> | undefined;
  let storage: DiscoverySqliteService | undefined;
  let childId: string | undefined;
  try {
    await mkdir(join(nativeRoot, "--fixture--"), { recursive: true });
    await mkdir(projectPath, { recursive: true });
    await writeFile(
      join(nativeRoot, "--fixture--", `2026-11-01_${nativeId}.jsonl`),
      [
        {
          type: "session",
          version: 3,
          id: nativeId,
          cwd: projectPath,
          timestamp: "2026-11-01T00:00:00Z",
        },
        {
          type: "message",
          id: "u1",
          parentId: null,
          message: { role: "user", content: "private Pi parent" },
        },
        {
          type: "message",
          id: "a1",
          parentId: "u1",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "private Pi answer" }],
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
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
            "INSERT INTO session_identities VALUES (?, 'pi', ?, ?, 'pi', ?, ?)",
          );
        try {
          insert.run(
            publicId,
            projectId,
            "2026-11-01T00:00:00Z",
            nativeRoot,
            nativeId,
          );
        } finally {
          insert.finalize();
        }
        await metadata.setProvider(publicId, "pi");
      }
      const provider = new PiProvider({
        sessionsDir: join(root, "empty-ambient"),
      });
      app = createApp({
        sdk: new MockClaudeSDK(),
        provider,
        dataDir,
        sessionMetadataService: metadata,
        discoverySqlite: storage,
      });
      if (restart === 0) {
        vi.stubEnv(
          "PI_CODING_AGENT_DIR",
          join(root, "unqualified-launch-store"),
        );
        await expect(
          app.supervisor.forkSession({
            sessionId: publicId,
            projectPath,
            providerName: "pi",
          }),
        ).rejects.toThrow("scoped resume is not qualified");
        expect(await readdir(join(nativeRoot, "--fixture--"))).toHaveLength(1);
        vi.stubEnv("PI_CODING_AGENT_DIR", piAgentDir);
        const child = await app.supervisor.forkSession({
          sessionId: publicId,
          projectPath,
          providerName: "pi",
        });
        childId = child.sessionId;
        expect(
          metadata.identities.resolveYa(parseYaSessionId(childId)),
        ).toMatchObject({ native: { storageScope: nativeRoot, id: childId } });
        expect(childId).not.toBe(parseNativeSessionId(nativeId));
      }
      const response = await app.app.request(
        `/api/projects/${projectId}/sessions/${childId}`,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      expect(JSON.stringify(await response.json())).toContain(
        "private Pi answer",
      );
      app.stopNotifications();
      await app.disposeSessionReaders();
      app = undefined;
      storage.close();
      storage = undefined;
    }
  } finally {
    app?.stopNotifications();
    await app?.disposeSessionReaders();
    storage?.close();
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});
