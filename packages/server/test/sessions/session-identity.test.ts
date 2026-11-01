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
  nativeSessionRef,
  parseNativeSessionId,
  parseYaSessionId,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { SessionIndexService } from "../../src/indexes/SessionIndexService.js";
import { normalizeSession } from "../../src/sessions/normalization.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import { codexEntryCacheBudget } from "../../src/sessions/codex-entry-cache-budget.js";
import { ClaudeProvider } from "../../src/sdk/providers/claude.js";
import { ClaudeSessionReader } from "../../src/sessions/reader.js";
import { MockClaudeSDK } from "../../src/sdk/mock.js";
import { resolveLegacySessionSource } from "../../src/sessions/provider-resolution.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import { BoundSessionReads } from "../../src/sessions/bound-session-reader.js";
import {
  SessionIdentityConflict,
  SessionIdentityStore,
  resolveNativeSessionRef,
} from "../../src/sessions/SessionIdentityStore.js";
import {
  DiscoverySqliteService,
  discoveryMigrationPrefix,
  migrateDiscoveryDatabase,
} from "../../src/storage/discovery-sqlite.js";
import {
  openSqliteOrThrow,
  type SqliteDatabase,
} from "../../src/storage/sqlite.js";
import { createApp } from "../setup/create-app.js";

const createdAt = "2026-11-01T00:00:00.000Z";
const projectId = toUrlProjectId("/fixture/project");
const databases = new Set<SqliteDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
  vi.restoreAllMocks();
});

function fixture() {
  const database = openSqliteOrThrow(":memory:");
  databases.add(database);
  migrateDiscoveryDatabase(database);
  return { database, store: new SessionIdentityStore(database) };
}

/** A persisted managed row from the later admission owner, not native adoption. */
function managedRow(
  database: SqliteDatabase,
  publicId: string,
  nativeId: string | null,
  scope: string,
  project = projectId,
) {
  const insert = database.prepare(
    "INSERT INTO session_identities (session_id, provider, project_id, created_at, native_family, native_scope, native_id) VALUES (?, 'claude', ?, ?, ?, ?, ?)",
  );
  try {
    insert.run(
      publicId,
      project,
      createdAt,
      nativeId === null ? null : "claude",
      nativeId === null ? null : scope,
      nativeId,
    );
  } finally {
    insert.finalize();
  }
}

describe("scoped durable session identity", () => {
  it("rolls a failed schema upgrade back without losing metadata, then upgrades the actual prefix", () => {
    const database = openSqliteOrThrow(":memory:");
    databases.add(database);
    migrateDiscoveryDatabase(database, discoveryMigrationPrefix(16));
    database.exec(
      `INSERT INTO session_metadata VALUES ('ses_existing', '{"customTitle":"keep","provider":"opencode"}')`,
    );
    expect(() =>
      migrateDiscoveryDatabase(database, [
        ...discoveryMigrationPrefix(16),
        { version: 17, sql: "CREATE TABLE unfinished(value); INVALID SQL" },
      ]),
    ).toThrow();
    const version = database.prepare("PRAGMA user_version");
    const metadata = database.prepare(
      "SELECT metadata FROM session_metadata WHERE session_id = ?",
    );
    try {
      expect(version.get()).toMatchObject({ user_version: 16 });
      migrateDiscoveryDatabase(database);
      expect(version.get()).toMatchObject({ user_version: 18 });
      expect(metadata.get("ses_existing")).toEqual({
        metadata: '{"customTitle":"keep","provider":"opencode"}',
      });
      expect(() =>
        migrateDiscoveryDatabase(database, discoveryMigrationPrefix(16)),
      ).toThrow(/newer/);
    } finally {
      version.finalize();
      metadata.finalize();
    }
  });

  it("adopts once and preserves a managed public id and launch variant on reverse discovery", () => {
    const { database, store } = fixture();
    managedRow(database, "public-ya", "native-only", "/fixture/claude");
    const native = nativeSessionRef(
      "claude",
      "/fixture/claude",
      parseNativeSessionId("native-only"),
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(
        store.adoptDiscovered({
          native,
          provider: "claude-gateway",
          projectId,
          createdAt,
        }),
      ).toMatchObject({ sessionId: "public-ya", provider: "claude" });
    }
    expect(store.resolveYa(parseYaSessionId("native-only"))).toBeUndefined();
    expect(store.lookupNative(native)?.sessionId).toBe("public-ya");
    const legacy = nativeSessionRef(
      "opencode",
      "/fixture/opencode",
      parseNativeSessionId("ses_existing"),
    );
    expect(
      store.adoptDiscovered({
        native: legacy,
        provider: "opencode",
        projectId,
        createdAt,
      }),
    ).toMatchObject({ sessionId: "ses_existing", native: legacy });
  });

  it("keeps identical native strings scoped and refuses ambiguous public adoption or an unbound takeover", () => {
    const { database, store } = fixture();
    managedRow(database, "public-a", "same-native", "/fixture/a");
    managedRow(database, "public-b", "same-native", "/fixture/b");
    const ref = (scope: string) =>
      nativeSessionRef("claude", scope, parseNativeSessionId("same-native"));
    expect(store.lookupNative(ref("/fixture/a"))?.sessionId).toBe("public-a");
    expect(store.lookupNative(ref("/fixture/b"))?.sessionId).toBe("public-b");
    expect(() =>
      store.adoptDiscovered({
        native: ref("/fixture/a"),
        provider: "claude",
        projectId: toUrlProjectId("/wrong/project"),
        createdAt,
      }),
    ).toThrow(SessionIdentityConflict);
    managedRow(database, "same-native", null, "/unused");
    expect(() =>
      store.adoptDiscovered({
        native: ref("/fixture/c"),
        provider: "claude",
        projectId,
        createdAt,
      }),
    ).toThrow(SessionIdentityConflict);
    expect(store.resolveYa(parseYaSessionId("same-native"))?.native).toBeNull();
    expect(store.lookupNative(ref("/fixture/c"))).toBeUndefined();
    const beforeConflict = nativeSessionRef(
      "claude",
      "/fixture/c",
      parseNativeSessionId("before-conflict"),
    );
    expect(() =>
      store.adoptDiscoveredBatch([
        { native: beforeConflict, provider: "claude", projectId, createdAt },
        { native: ref("/fixture/c"), provider: "claude", projectId, createdAt },
      ]),
    ).toThrow(SessionIdentityConflict);
    expect(store.lookupNative(beforeConflict)).toBeUndefined();
  });

  it("rejects partial bindings and preserves surrounding writes on transaction failure", () => {
    const { database, store } = fixture();
    database.exec(
      `INSERT INTO session_metadata VALUES ('keep', '{"customTitle":"before"}')`,
    );
    expect(() =>
      database.transaction(() => {
        database.exec(
          `UPDATE session_metadata SET metadata = '{"customTitle":"after"}'`,
        );
        database.exec(
          `INSERT INTO session_identities VALUES ('partial', 'claude', 'cA', '${createdAt}', 'claude', NULL, 'native')`,
        );
      }),
    ).toThrow();
    expect(store.resolveYa(parseYaSessionId("partial"))).toBeUndefined();
    const select = database.prepare("SELECT metadata FROM session_metadata");
    try {
      expect(select.get()).toEqual({ metadata: '{"customTitle":"before"}' });
    } finally {
      select.finalize();
    }
  });

  it("keeps the Codex rollout address native while projecting the public id and OSS launch variant", async () => {
    const root = await mkdtemp(join(tmpdir(), "ya-codex-binding-"));
    const projectPath = join(root, "project");
    const privateDir = join(root, "private");
    const ambientDir = join(root, "ambient");
    const nativeId = parseNativeSessionId(
      "019a0000-1111-7111-8111-111111111111",
    );
    const currentProjectId = toUrlProjectId(projectPath);
    let app: ReturnType<typeof createApp> | undefined;
    try {
      await Promise.all(
        [projectPath, privateDir, ambientDir].map((p) =>
          mkdir(p, { recursive: true }),
        ),
      );
      for (const [directory, text] of [
        [privateDir, "correct scoped rollout"],
        [ambientDir, "wrong rollout with same native id"],
      ]) {
        await writeFile(
          join(directory!, `rollout-2026-11-01T00-00-00-${nativeId}.jsonl`),
          `${[
            {
              type: "session_meta",
              timestamp: createdAt,
              payload: {
                id: nativeId,
                cwd: projectPath,
                timestamp: createdAt,
                model_provider: "ollama",
              },
            },
            {
              type: "event_msg",
              timestamp: createdAt,
              payload: { type: "user_message", message: text },
            },
          ]
            .map((entry) => JSON.stringify(entry))
            .join("\n")}\n`,
        );
      }
      app = createApp({
        sdk: new MockClaudeSDK(),
        dataDir: join(root, "data"),
        projectsDir: ambientDir,
      });
      const reads = new BoundSessionReads({ readerFactory: app.readerFactory });
      const loaded = await reads.read({
        sessionId: parseYaSessionId("permanent-codex-public"),
        provider: "codex-oss",
        native: await resolveNativeSessionRef(
          "codex-oss",
          privateDir,
          nativeId,
        ),
        transcriptProject: {
          id: currentProjectId,
          path: projectPath,
          name: "fixture",
          provider: "codex-oss",
          sessionDir: ambientDir,
          sessionCount: 1,
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
        },
        projectId: currentProjectId,
        options: { tailCompactions: 2 },
      });
      expect(loaded?.summary).toMatchObject({
        id: "permanent-codex-public",
        provider: "codex-oss",
      });
      expect(JSON.stringify(loaded?.data)).toContain("correct scoped rollout");
      expect(JSON.stringify(loaded?.data)).not.toContain("wrong rollout");
    } finally {
      app?.stopNotifications();
      await app?.disposeSessionReaders();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shares native-index compact windows, refreshes appends and releases pooled Codex entries", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const root = await mkdtemp(join(tmpdir(), "ya-bound-codex-window-"));
    const projectPath = join(root, "project");
    const nativeRoot = join(root, "native");
    const id = parseNativeSessionId("019a0000-2222-7222-8222-222222222222");
    const project = {
      id: toUrlProjectId(projectPath),
      path: projectPath,
      name: "fixture",
      provider: "codex-oss" as const,
      sessionDir: join(root, "ambient"),
      sessionCount: 1,
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
    };
    const index = new SessionIndexService({
      dataDir: join(root, "indexes"),
      projectsDir: project.sessionDir,
    });
    let app: ReturnType<typeof createApp> | undefined;
    try {
      await Promise.all(
        [projectPath, nativeRoot].map((p) => mkdir(p, { recursive: true })),
      );
      const source = join(
        nativeRoot,
        `rollout-2026-11-01T00-00-00-${id}.jsonl`,
      );
      const event = (message: string, hour: number) => ({
        type: "event_msg",
        timestamp: `2026-11-01T0${hour}:00:01.000Z`,
        payload: { type: "user_message", message },
      });
      await writeFile(
        source,
        [
          ...[
            {
              type: "session_meta",
              timestamp: createdAt,
              payload: {
                id,
                cwd: projectPath,
                timestamp: createdAt,
                model_provider: "ollama",
              },
            },
            event("first turn", 0),
            {
              type: "world_state",
              payload: {
                full: true,
                state: { filler: "x".repeat(5 * 1024 * 1024) },
              },
            },
          ],
          ...[1, 2, 3].flatMap((hour) => [
            {
              type: "compacted",
              timestamp: `2026-11-01T0${hour}:00:00.000Z`,
              payload: { message: `compact ${hour}` },
            },
            event(`turn ${hour}`, hour),
          ]),
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      await index.initialize();
      app = createApp({
        sdk: new MockClaudeSDK(),
        dataDir: join(root, "data"),
        projectsDir: project.sessionDir,
      });
      const native = await resolveNativeSessionRef("codex-oss", nativeRoot, id);
      const reader = app.readerFactory(project, native) as CodexSessionReader;
      expect(reader).toBeInstanceOf(CodexSessionReader);
      expect(app.readerFactory(project, native)).toBe(reader);
      expect(
        await index.getSessionSummaryWithCache(
          native.storageScope,
          project.id,
          id,
          reader,
        ),
      ).not.toBeNull();
      const reads = new BoundSessionReads({
        readerFactory: app.readerFactory,
        sessionIndexService: index,
      });
      const request = {
        sessionId: parseYaSessionId("permanent-public-window"),
        provider: "codex-oss" as const,
        native,
        transcriptProject: project,
        projectId: project.id,
        options: { tailCompactions: 2 },
      };
      const original = reader.getSession.bind(reader);
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const spy = vi
        .spyOn(reader, "getSession")
        .mockImplementation(async (...args) => {
          started();
          await gate;
          return original(...args);
        });
      const first = reads.read(request);
      await entered;
      const second = reads.read(request);
      // Both callers have entered the native-index boundary before completing work.
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
      release();
      const [a, b] = await Promise.all([first, second]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(a?.data).toBe(b?.data);
      expect(a?.summary).toMatchObject({
        id: request.sessionId,
        provider: "codex-oss",
      });
      expect(a?.readWindow).toMatchObject({
        kind: "compact-tail",
        omittedPrefix: true,
        compactBoundaries: 2,
      });
      expect(JSON.stringify(a?.data)).not.toContain("first turn");
      if (!a) throw new Error("expected compact window");
      expect(a.readWindow?.startByte).toBeGreaterThan(5 * 1024 * 1024);
      expect(JSON.stringify(normalizeSession(a).messages)).toContain(
        "codex-compacted-byte-",
      );
      spy.mockRestore();
      await appendFile(
        source,
        JSON.stringify(event("appended live turn", 4)) + "\n",
      );
      const appended = await reads.read(request);
      expect(appended?.readWindow?.kind).toBe("compact-tail");
      expect(JSON.stringify(appended?.data)).toContain("appended live turn");
      // Full reads reuse the same owner and its parsed-entry budget.
      const full = await reads.read({ ...request, options: undefined });
      const again = await reads.read({ ...request, options: undefined });
      if (
        !full ||
        !again ||
        full.data.provider !== "codex-oss" ||
        again.data.provider !== "codex-oss"
      )
        throw new Error("expected Codex OSS data");
      expect(full.data.session.entries[0]).toBe(again.data.session.entries[0]);
      expect(reader.getEntryCacheStats().sourceBytes).toBeGreaterThan(
        5 * 1024 * 1024,
      );
      const before = codexEntryCacheBudget.getStats().retainedSourceBytes;
      const owned = reader.getEntryCacheStats().sourceBytes;
      await app.disposeSessionReaders();
      expect(reader.getEntryCacheStats().sessions).toBe(0);
      expect(codexEntryCacheBudget.getStats().retainedSourceBytes).toBe(
        before - owned,
      );
      // An already leased reader may finish after retirement but cannot retain entries.
      expect(await reader.getSession(id, project.id)).not.toBeNull();
      expect(reader.getEntryCacheStats().sessions).toBe(0);
    } finally {
      app?.stopNotifications();
      await app?.disposeSessionReaders();
      index.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads the bound native file through the real detail route, survives reopen, and never guesses for unbound identity", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const root = await mkdtemp(join(tmpdir(), "ya-native-identity-"));
    const dataDir = join(root, "data");
    const projectPath = join(root, "project");
    const currentProjectId = toUrlProjectId(projectPath);
    const projectsDir = join(root, "ambient");
    const ambientDir = join(projectsDir, projectPath.replace(/[/\\:]/g, "-"));
    const privateDir = join(root, "private-native");
    const grokSessionsDir = join(root, "grok");
    const otherProject = join(root, "other-project");
    await mkdir(otherProject, { recursive: true });
    for (const id of ["unbound", "missing-bound"]) {
      const dir = join(grokSessionsDir, encodeURIComponent(otherProject), id);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "summary.json"),
        JSON.stringify({
          info: { id, cwd: otherProject },
          created_at: createdAt,
          updated_at: createdAt,
          generated_title: "unrelated Grok conversation",
          num_messages: 1,
        }),
      );
    }
    await Promise.all(
      [projectPath, ambientDir, privateDir].map((p) =>
        mkdir(p, { recursive: true }),
      ),
    );
    const message = (text: string) =>
      JSON.stringify({
        type: "user",
        uuid: "message-1",
        sessionId: "native-file",
        cwd: projectPath,
        timestamp: createdAt,
        message: { role: "user", content: text },
      });
    await writeFile(
      join(ambientDir, "native-file.jsonl"),
      `${message("wrong ambient source")}\n`,
    );
    await writeFile(
      join(privateDir, "native-file.jsonl"),
      `${message("correct private source")}\n`,
    );
    await writeFile(
      join(ambientDir, "unbound.jsonl"),
      `${message("must not be guessed")}\n`,
    );
    const nativeRef = await resolveNativeSessionRef(
      "claude",
      privateDir,
      parseNativeSessionId("native-file"),
    );
    let storage: DiscoverySqliteService | undefined;
    let app: ReturnType<typeof createApp> | undefined;
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
        if (restart === 0) {
          managedRow(
            storage.getDatabase(),
            "permanent-ya",
            "native-file",
            nativeRef.storageScope,
            currentProjectId,
          );
          managedRow(
            storage.getDatabase(),
            "unbound",
            null,
            privateDir,
            currentProjectId,
          );
          managedRow(
            storage.getDatabase(),
            "missing-bound",
            "missing-native",
            privateDir,
            currentProjectId,
          );
        }
        app = createApp({
          grokSessionsDir,
          sdk: new MockClaudeSDK(),
          dataDir,
          projectsDir,
          sessionMetadataService: metadata,
          discoverySqlite: storage,
        });
        const response = await app.app.request(
          `/api/projects/${currentProjectId}/sessions/permanent-ya`,
        );
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(result.session.id).toBe("permanent-ya");
        expect(JSON.stringify(result.messages)).toContain(
          "correct private source",
        );
        expect(JSON.stringify(result.messages)).not.toContain(
          "wrong ambient source",
        );
        for (const id of ["unbound", "missing-bound"]) {
          const missing = await app.app.request(
            `/api/projects/${currentProjectId}/sessions/${id}`,
          );
          expect(missing.status).toBe(404);
          expect(missing.headers.get("location")).toBeNull();
          expect(await missing.json()).toEqual({ error: "Session not found" });
        }
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
    }
  });
});

it("cancels legacy native proof before querying a closed identity owner", async () => {
  const { database, store } = fixture();
  managedRow(
    database,
    "permanent-proof-owner",
    "native-proof-address",
    "/fixture/native-proof",
  );
  const native = nativeSessionRef(
    "claude",
    "/fixture/native-proof",
    parseNativeSessionId("native-proof-address"),
  );
  const controller = new AbortController();
  let entered = () => {};
  let release = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reader = {
    getNativeSessionRef: async () => {
      entered();
      await held;
      return native;
    },
  } as unknown as ISessionReader;
  const pending = resolveLegacySessionSource(
    {
      provider: "claude",
      kind: "primary",
      sessionDir: native.storageScope,
      reader,
    },
    native.id,
    { id: projectId } as import("../../src/supervisor/types.js").Project,
    {
      identities: store,
      readerFactory: () => reader,
      signal: controller.signal,
    },
  );
  await started;
  controller.abort();
  database.close();
  databases.delete(database);
  release();
  await expect(pending).resolves.toBeNull();
});

it("pins legacy proof to one root and refuses orphaned native aliases", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "ya-legacy-roots-")),
  );
  const path = join(root, "project");
  const id = toUrlProjectId(path);
  const projects = join(root, "claude");
  const first = join(projects, path.replace(/[/\\:]/g, "-"));
  const second = join(root, "private");
  const nativeId = "native-duplicate-address";
  const childDir = join(second, nativeId, "subagents");
  let storage: DiscoverySqliteService | undefined;
  let app: ReturnType<typeof createApp> | undefined;
  const message = (text: string) =>
    JSON.stringify({
      type: "user",
      uuid: "u1",
      parentUuid: null,
      sessionId: nativeId,
      cwd: path,
      timestamp: createdAt,
      message: { role: "user", content: text },
    }) + "\n";
  try {
    await Promise.all(
      [path, first, childDir].map((dir) => mkdir(dir, { recursive: true })),
    );
    await writeFile(join(first, nativeId + ".jsonl"), "");
    await writeFile(
      join(second, nativeId + ".jsonl"),
      message("private owner history"),
    );
    await writeFile(
      join(childDir, "agent-secret.jsonl"),
      message("private owner child"),
    );
    await writeFile(
      join(childDir, "agent-secret.meta.json"),
      JSON.stringify({ toolUseId: "private-owner-tool" }),
    );
    storage = new DiscoverySqliteService({
      dataDir: join(root, "data"),
      probeNetworkFilesystem: () => undefined,
    });
    const metadata = new SessionMetadataService({
      dataDir: join(root, "data"),
      database: storage.getDatabase(),
    });
    await metadata.initialize();
    managedRow(
      storage.getDatabase(),
      "permanent-private-owner",
      nativeId,
      second,
      id,
    );
    app = createApp({
      sdk: new MockClaudeSDK(),
      dataDir: join(root, "data"),
      projectsDir: projects,
      sessionMetadataService: metadata,
      discoverySqlite: storage,
    });
    const project = await app.scanner.getOrCreateProject(id);
    expect(project).not.toBeNull();
    project!.mergedSessionDirs = [second];
    const request = (session: string, suffix: string) =>
      app!.app.request(`/api/projects/${id}/sessions/${session}${suffix}`);
    // Empty first file proves first-root existence, not second-root history.
    const empty = await request(nativeId, "/metadata");
    expect(empty.status).toBe(404);
    await writeFile(
      join(first, nativeId + ".jsonl"),
      message("legitimate legacy history"),
    );
    const legacy = await request(nativeId, "/metadata");
    expect(legacy.status, await legacy.clone().text()).toBe(200);
    expect(await legacy.text()).not.toContain("private owner history");
    for (const suffix of ["/agents", "/agents/secret"]) {
      const child = await request(nativeId, suffix);
      expect(child.status).toBe(200);
      expect(await child.text()).not.toMatch(
        /private owner child|private-owner-tool/,
      );
    }
    // Both parent files disappear; the private native child remains readable
    // through its existing YA owner but must not create a native-parent URL.
    await rm(join(first, nativeId + ".jsonl"));
    await rm(join(second, nativeId + ".jsonl"));
    for (const suffix of ["/agents", "/agents/secret"]) {
      expect((await request(nativeId, suffix)).status).toBe(404);
    }
    const ownedChild = await request(
      "permanent-private-owner",
      "/agents/secret",
    );
    expect(ownedChild.status).toBe(200);
    expect(await ownedChild.text()).toContain("private owner child");
  } finally {
    app?.stopNotifications();
    await app?.disposeSessionReaders();
    storage?.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("cancels the production legacy fork-source proof before database teardown", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const root = await realpath(await mkdtemp(join(tmpdir(), "ya-fork-proof-")));
  const path = join(root, "project");
  const projects = join(root, "claude");
  const source = join(projects, path.replace(/[/\\:]/g, "-"));
  const nativeId = parseNativeSessionId("native-fork-proof");
  let app: ReturnType<typeof createApp> | undefined;
  let storage: DiscoverySqliteService | undefined;
  let release = () => {};
  let entered = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    await Promise.all(
      [path, source].map((dir) => mkdir(dir, { recursive: true })),
    );
    await writeFile(
      join(source, nativeId + ".jsonl"),
      JSON.stringify({
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: nativeId,
        cwd: path,
        timestamp: createdAt,
        message: { role: "user", content: "legacy fork proof" },
      }) + "\n",
    );
    storage = new DiscoverySqliteService({
      dataDir: join(root, "data"),
      probeNetworkFilesystem: () => undefined,
    });
    const metadata = new SessionMetadataService({
      dataDir: join(root, "data"),
      database: storage.getDatabase(),
    });
    await metadata.initialize();
    const provider = new ClaudeProvider();
    const fork = vi.spyOn(provider, "forkSession");
    const original = ClaudeSessionReader.prototype.getNativeSessionRef;
    let blocked = false;
    vi.spyOn(
      ClaudeSessionReader.prototype,
      "getNativeSessionRef",
    ).mockImplementation(async function (id) {
      if (id === nativeId && !blocked) {
        blocked = true;
        entered();
        await held;
      }
      return original.call(this, id);
    });
    app = createApp({
      sdk: new MockClaudeSDK(),
      provider,
      dataDir: join(root, "data"),
      projectsDir: projects,
      sessionMetadataService: metadata,
      discoverySqlite: storage,
    });
    const pending = app.supervisor.forkSession({
      sessionId: nativeId,
      projectPath: path,
      providerName: "claude",
    });
    const settled = expect(pending).rejects.toThrow(
      "Session has no readable native fork source",
    );
    await started;
    app.stopNotifications();
    await app.disposeSessionReaders();
    storage.close();
    storage = undefined;
    release();
    await settled;
    expect(fork).not.toHaveBeenCalled();
  } finally {
    release();
    app?.stopNotifications();
    await app?.disposeSessionReaders();
    storage?.close();
    await rm(root, { recursive: true, force: true });
  }
});
