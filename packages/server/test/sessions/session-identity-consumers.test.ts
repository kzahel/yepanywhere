import {
  appendFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_INSTRUCTION_RESTORATION,
  parseYaSessionId,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { expect, it, vi } from "vitest";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { ServerSettingsService } from "../../src/services/ServerSettingsService.js";
import { MockClaudeSDK } from "../../src/sdk/mock.js";
import type {
  AgentProvider,
  StartSessionOptions,
} from "../../src/sdk/providers/types.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import { ConversationAcquisition } from "../../src/experimental/conversation-acquisition.js";
import { RetainedSessionCollections } from "../../src/services/RetainedSessionCollections.js";
import type { SessionCatalogRow } from "../../src/sessions/catalog-types.js";
import { EventBus } from "../../src/watcher/EventBus.js";
import { createApp } from "../setup/create-app.js";

it.each(["claude", "codex"] as const)(
  "reads %s conversation, instructions and issue sources by native identity with public observations",
  async (providerName) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "ya-source-consumers-")),
    );
    const projectPath = join(root, "original");
    const workingPath = join(root, "working");
    const projectId = toUrlProjectId(projectPath);
    const workingId = toUrlProjectId(workingPath);
    const dataDir = join(root, "data");
    const projectsDir = join(root, "claude");
    const nativeRoot =
      providerName === "claude"
        ? join(projectsDir, projectPath.replace(/[/\\:]/g, "-"))
        : join(root, "codex");
    const publicId = parseYaSessionId(`permanent-${providerName}-source`);
    const nativeId = "019a0000-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
    const timestamp = new Date().toISOString();
    let app: ReturnType<typeof createApp> | undefined;
    let storage: DiscoverySqliteService | undefined;
    const releases: Array<() => void> = [];
    const row = (text: string, id: string) =>
      providerName === "claude"
        ? {
            type: "user",
            uuid: id,
            parentUuid: id === "source-user" ? null : "source-user",
            sessionId: nativeId,
            cwd: projectPath,
            timestamp,
            message: { role: "user", content: text },
          }
        : {
            type: "event_msg",
            timestamp,
            payload: { type: "user_message", message: text },
          };
    const nativeFile = join(
      nativeRoot,
      providerName === "claude"
        ? nativeId + ".jsonl"
        : `rollout-${nativeId}.jsonl`,
    );
    try {
      await Promise.all(
        [projectPath, workingPath, nativeRoot, projectsDir].map((path) =>
          mkdir(path, { recursive: true }),
        ),
      );
      await writeFile(
        nativeFile,
        [
          ...(providerName === "codex"
            ? [
                {
                  type: "session_meta",
                  payload: { id: nativeId, cwd: projectPath, timestamp },
                },
              ]
            : []),
          row("correct native history SOURCE-4242", "source-user"),
        ]
          .map((v) => JSON.stringify(v))
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
        const settings = new ServerSettingsService({ dataDir });
        await settings.initialize();
        if (restart === 0) {
          const insert = storage
            .getDatabase()
            .prepare(
              "INSERT INTO session_identities VALUES (?, ?, ?, ?, ?, ?, ?)",
            );
          try {
            insert.run(
              publicId,
              providerName,
              projectId,
              timestamp,
              providerName,
              nativeRoot,
              nativeId,
            );
          } finally {
            insert.finalize();
          }
          await metadata.setProvider(publicId, providerName);
          await metadata.setWorkingProject(publicId, workingId, projectId);
          await settings.updateSettings({
            issueAssociations: {
              enabled: true,
              scope: "recent",
              recentDays: 7,
              aggressiveMatching: true,
            },
            instructionRestoration: {
              ...DEFAULT_INSTRUCTION_RESTORATION,
              pathPrefix: projectPath,
              providers: { [providerName]: true },
            },
          });
        }
        expect(
          settings.getSetting("instructionRestoration")?.providers[
            providerName
          ],
        ).toBe(true);
        let instructionHistory: StartSessionOptions["instructionReadHistory"];
        const start = vi.fn(async (options: StartSessionOptions) => {
          instructionHistory = options.instructionReadHistory;
          throw new Error("test stops after instruction source capture");
        });
        const provider = {
          name: providerName,
          supportsNativeResumeSource: true,
          startSession: start,
          isInstalled: async () => true,
          isAuthenticated: async () => true,
          getAvailableModels: async () => [],
        } as unknown as AgentProvider;
        app = createApp({
          sdk: new MockClaudeSDK(),
          provider,
          dataDir,
          projectsDir,
          codexSessionsDir:
            providerName === "codex" ? nativeRoot : join(root, "empty-codex"),
          sessionMetadataService: metadata,
          discoverySqlite: storage,
          serverSettingsService: settings,
          eventBus: new EventBus(),
        });
        await app.scanner.getOrCreateProject(projectId);
        await app.scanner.getOrCreateProject(workingId);
        // N is only a provider address for P. With no public resource N,
        // neither history nor control routes may expose it as another alias.
        for (const suffix of [
          "",
          "/metadata",
          "/agents",
          "/agents/unknown-native-child",
        ]) {
          const alias = await app.app.request(
            `/api/projects/${projectId}/sessions/${nativeId}${suffix}`,
          );
          expect(alias.status, suffix).toBe(404);
        }
        for (const [suffix, body] of [
          ["/bang-commands", { command: "echo must-not-run" }],
          [
            "/resume",
            { message: "must not resume native alias", provider: providerName },
          ],
        ] as const) {
          const alias = await app.app.request(
            `/api/projects/${projectId}/sessions/${nativeId}${suffix}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Yep-Anywhere": "true",
              },
              body: JSON.stringify(body),
            },
          );
          expect(alias.status, suffix).toBe(404);
        }
        for (const aliasId of [
          nativeId.toUpperCase(),
          "unknown-native-address",
        ]) {
          const historyAlias = await app.app.request(
            `/api/projects/${projectId}/sessions/${aliasId}`,
          );
          expect(historyAlias.status, aliasId).toBe(404);
          const missing = await app.app.request(
            `/api/projects/${projectId}/sessions/${aliasId}/resume`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Yep-Anywhere": "true",
              },
              body: JSON.stringify({
                message: "do not resolve a provider-side alias",
                provider: providerName,
              }),
            },
          );
          expect(missing.status, aliasId).toBe(404);
        }
        expect(start).not.toHaveBeenCalled();
        const first: string[] = [];
        const second: string[] = [];
        const query = {
          sessionId: publicId,
          maxMessages: 20,
          anchorMessageId: null,
        };
        const releaseFirst = app.conversationSubscriptions.subscribe(
          query,
          "first",
          { send: (frame) => first.push(frame), close: () => {} },
        );
        releases.push(releaseFirst);
        const releaseSecond = app.conversationSubscriptions.subscribe(
          query,
          "second",
          { send: (frame) => second.push(frame), close: () => {} },
        );
        releases.push(releaseSecond);
        await vi.waitFor(
          () => {
            expect(
              first.some((frame) =>
                frame.includes("correct native history SOURCE-4242"),
              ),
            ).toBe(true);
            expect(
              second.some(
                (frame) =>
                  frame.includes(`"sessionId":"${publicId}"`) &&
                  frame.includes("correct native history"),
              ),
            ).toBe(true);
          },
          { timeout: 5000, interval: 25 },
        );
        const issueList = async () =>
          (
            await (
              await app!.app.request(
                `/api/issues?sessionId=${publicId}&projectId=${workingId}`,
              )
            ).json()
          ).items;
        await vi.waitFor(
          async () =>
            expect(
              (await issueList()).map((item: { key: string }) => item.key),
            ).toContain("SOURCE-4242"),
          { timeout: 5000, interval: 25 },
        );
        const item = (await issueList()).find(
          (item: { key: string }) => item.key === "SOURCE-4242",
        );
        const associations = await (
          await app.app.request(
            `/api/issues/sessions?id=${encodeURIComponent(item.id)}`,
          )
        ).json();
        expect(associations.sessions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              sessionId: publicId,
              projectId: workingId,
              available: true,
            }),
          ]),
        );
        expect(JSON.stringify(associations.sessions)).not.toContain(
          `"sessionId":"${nativeId}"`,
        );
        if (restart === 0) {
          releaseFirst();
          await appendFile(
            nativeFile,
            JSON.stringify(row("appended native source", "later-user")) + "\n",
          );
          await vi.waitFor(
            () =>
              expect(
                second.some((frame) =>
                  frame.includes("appended native source"),
                ),
              ).toBe(true),
            { timeout: 5000, interval: 25 },
          );
        }
        releases.splice(0).forEach((release) => {
          release();
        });
        // Qualify the real app's instruction-history callback at the provider
        // boundary, then refuse startup before any model/provider effect.
        const resume = await app.supervisor
          .resumeSession(publicId, workingPath, { text: "continue" })
          .catch((error) => error);
        expect(start, String(resume)).toHaveBeenCalledOnce();
        expect(start.mock.calls[0]?.[0]).toMatchObject({
          resumeSessionId: nativeId,
          publicSessionId: publicId,
          nativeResumeSource: {
            native: { id: nativeId },
            filePath: nativeFile,
          },
        });
        expect(JSON.stringify(instructionHistory)).toContain(
          "correct native history SOURCE-4242",
        );
        app.stopNotifications();
        await app.disposeSessionReaders();
        app = undefined;
        storage.close();
        storage = undefined;
      }
    } finally {
      releases.splice(0).forEach((release) => {
        release();
      });
      app?.stopNotifications();
      await app?.disposeSessionReaders();
      storage?.close();
      await rm(root, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  },
  20000,
);

it.each([false, true])(
  "does not acquire an ambient conversation for a stored unreadable source (bound=%s)",
  async (bound) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "ya-unreadable-conversation-")),
    );
    const projectPath = join(root, "project");
    const projectId = toUrlProjectId(projectPath);
    const projectsDir = join(root, "claude");
    const ambient = join(projectsDir, projectPath.replace(/[/\\:]/g, "-"));
    const nativeRoot = join(root, "missing-native");
    const dataDir = join(root, "data");
    const publicId = "unreadable-public-source";
    const nativeId = "019a0000-cccc-7ccc-8ccc-cccccccccccc";
    let app: ReturnType<typeof createApp> | undefined;
    let storage: DiscoverySqliteService | undefined;
    let release = () => {};
    try {
      await Promise.all(
        [projectPath, ambient, nativeRoot].map((path) =>
          mkdir(path, { recursive: true }),
        ),
      );
      const timestamp = new Date().toISOString();
      await writeFile(
        join(ambient, publicId + ".jsonl"),
        JSON.stringify({
          type: "user",
          uuid: "ambient-user",
          sessionId: publicId,
          cwd: projectPath,
          timestamp,
          message: { role: "user", content: "must not read ambient collision" },
        }) + "\n",
      );
      storage = new DiscoverySqliteService({
        dataDir,
        probeNetworkFilesystem: () => undefined,
      });
      const metadata = new SessionMetadataService({
        dataDir,
        database: storage.getDatabase(),
      });
      await metadata.initialize();
      const insert = storage
        .getDatabase()
        .prepare(
          "INSERT INTO session_identities VALUES (?, 'claude', ?, ?, ?, ?, ?)",
        );
      try {
        insert.run(
          publicId,
          projectId,
          timestamp,
          bound ? "claude" : null,
          bound ? nativeRoot : null,
          bound ? nativeId : null,
        );
      } finally {
        insert.finalize();
      }
      await metadata.setProvider(publicId, "claude");
      const events = new EventBus();
      let published = false;
      const stop = events.subscribe((event) => {
        if (
          event.type === "session-catalog-updated" &&
          event.catalog.catalogGeneration > 0
        )
          published = true;
      });
      app = createApp({
        sdk: new MockClaudeSDK(),
        dataDir,
        projectsDir,
        eventBus: events,
        sessionMetadataService: metadata,
        discoverySqlite: storage,
      });
      const releaseWarm = app.conversationSubscriptions.subscribe(
        {
          sessionId: "warm-native-catalog-only",
          maxMessages: 20,
          anchorMessageId: null,
        },
        "warm",
        { send: () => {}, close: () => {} },
      );
      await vi.waitFor(() => expect(published).toBe(true), {
        timeout: 3000,
        interval: 25,
      });
      releaseWarm();
      stop();
      const acquisition = vi.spyOn(ConversationAcquisition.prototype, "read");
      const catalog = vi.spyOn(RetainedSessionCollections.prototype, "read");
      const frames: string[] = [];
      release = app.conversationSubscriptions.subscribe(
        { sessionId: publicId, maxMessages: 20, anchorMessageId: null },
        "unreadable",
        { send: (frame) => frames.push(frame), close: () => {} },
      );
      await vi.waitFor(
        () =>
          expect(frames.some((frame) => frame.includes('"kind":"error"'))).toBe(
            true,
          ),
        { timeout: 3000, interval: 25 },
      );
      expect(frames.join("")).not.toContain("must not read ambient collision");
      expect(acquisition).not.toHaveBeenCalled();
      if (!bound) expect(catalog).not.toHaveBeenCalled();
    } finally {
      release();
      app?.stopNotifications();
      await app?.disposeSessionReaders();
      storage?.close();
      await rm(root, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  },
);

it.each(["stored", "wrong-project", "wrong-path", "legacy-no-scope"])(
  "reads scoped Codex ancestry after verified catalogue evidence (%s)",
  async (mode) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "ya-scoped-conversation-")),
    );
    const projectPath = join(root, "project");
    const projectId = toUrlProjectId(projectPath);
    const nativeRoot = join(root, "private-native");
    const ambient = join(root, "ambient-native");
    const dataDir = join(root, "data");
    const nativeId = "019a0000-dddd-7ddd-8ddd-dddddddddddd";
    const parentId = "019a0000-eeee-7eee-8eee-eeeeeeeeeeee";
    const publicId =
      mode === "legacy-no-scope" ? nativeId : "permanent-scoped-conversation";
    const timestamp = new Date().toISOString();
    const meta = (id: string, ordinal: number) => ({
      type: "session_meta",
      ordinal,
      timestamp,
      payload: { id, cwd: projectPath, timestamp, history_mode: "paginated" },
    });
    const user = (text: string, ordinal: number) => ({
      type: "event_msg",
      ordinal,
      timestamp,
      payload: { type: "user_message", message: text },
    });
    const jsonl = (rows: unknown[]) =>
      rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
    const file = (dir: string, id: string) => join(dir, `rollout-${id}.jsonl`);
    let app: ReturnType<typeof createApp> | undefined;
    let storage: DiscoverySqliteService | undefined;
    let release = () => {};
    try {
      await Promise.all(
        [projectPath, nativeRoot, ambient].map((path) =>
          mkdir(path, { recursive: true }),
        ),
      );
      const parent = jsonl([
        meta(parentId, 0),
        user("correct private ancestor", 1),
      ]);
      await writeFile(file(nativeRoot, parentId), parent);
      await writeFile(
        file(ambient, parentId),
        jsonl([meta(parentId, 0), user("wrong ambient ancestor", 1)]),
      );
      const leaf = {
        ...meta(nativeId, 2),
        payload: {
          ...meta(nativeId, 2).payload,
          history_base: {
            thread_id: parentId,
            end_ordinal_exclusive: 2,
            end_byte_offset: Buffer.byteLength(parent),
          },
        },
      };
      await writeFile(
        file(nativeRoot, nativeId),
        jsonl([leaf, user("current private child", 3)]),
      );
      storage = new DiscoverySqliteService({
        dataDir,
        probeNetworkFilesystem: () => undefined,
      });
      const metadata = new SessionMetadataService({
        dataDir,
        database: storage.getDatabase(),
      });
      await metadata.initialize();
      const insert = storage
        .getDatabase()
        .prepare(
          "INSERT INTO session_identities VALUES (?, 'codex', ?, ?, 'codex', ?, ?)",
        );
      try {
        if (mode !== "legacy-no-scope")
          insert.run(publicId, projectId, timestamp, nativeRoot, nativeId);
      } finally {
        insert.finalize();
      }
      const row: SessionCatalogRow = {
        sessionId: nativeId,
        catalogFamily: "codex",
        storeKey: nativeRoot,
        nativeStorageScope: nativeRoot,
        projectId,
        projectPath,
        projectIdentityKey: projectPath,
        updatedAt: timestamp,
        sourceVersion: "controlled native publication",
        fidelity: "head",
        location: { kind: "file", path: file(nativeRoot, nativeId) },
      };
      // Control only catalogue publication; SQLite resolution, native file/lineage
      // acquisition and the app's pooled reader factory remain real.
      const otherPath = join(root, "other-project");
      const { nativeStorageScope: _scope, ...scopeLess } = row;
      let publishedRow: SessionCatalogRow =
        mode === "wrong-project"
          ? {
              ...row,
              projectId: toUrlProjectId(otherPath),
              projectPath: otherPath,
            }
          : mode === "wrong-path"
            ? { ...row, projectPath: otherPath }
            : mode === "legacy-no-scope"
              ? { ...scopeLess, rowFormat: 2 }
              : row;
      const events = new EventBus();
      const acquisition = vi.spyOn(ConversationAcquisition.prototype, "read");
      const original = RetainedSessionCollections.prototype.read;
      vi.spyOn(RetainedSessionCollections.prototype, "read").mockImplementation(
        async function () {
          return { ...(await original.call(this)), rows: [publishedRow] };
        },
      );
      app = createApp({
        sdk: new MockClaudeSDK(),
        dataDir,
        projectsDir: join(root, "empty-claude"),
        codexSessionsDir: ambient,
        sessionMetadataService: metadata,
        discoverySqlite: storage,
        eventBus: events,
      });
      const watch = vi.spyOn(app.focusedSessionWatchManager, "subscribe");
      const frames: string[] = [];
      release = app.conversationSubscriptions.subscribe(
        { sessionId: publicId, maxMessages: 20, anchorMessageId: null },
        "scoped",
        { send: (frame) => frames.push(frame), close: () => {} },
      );
      if (mode !== "stored") {
        await vi.waitFor(
          () =>
            expect(
              frames.some((frame) => frame.includes('"kind":"error"')),
            ).toBe(true),
          { timeout: 3000, interval: 25 },
        );
        expect(acquisition).not.toHaveBeenCalled();
        expect(watch).not.toHaveBeenCalled();
        expect(frames.join("")).not.toContain("wrong ambient ancestor");
        publishedRow = row;
        events.emit({
          type: "session-catalog-updated",
          timestamp: new Date().toISOString(),
          catalog: {
            catalogEpoch: "verified-scope",
            catalogGeneration: 3,
            complete: true,
            refreshing: false,
          },
        });
      }
      await vi.waitFor(
        () =>
          expect(
            frames.some(
              (frame) =>
                frame.includes("correct private ancestor") &&
                frame.includes("current private child"),
            ),
          ).toBe(true),
        { timeout: 5000, interval: 25 },
      );
      expect(frames.join("")).not.toContain("wrong ambient ancestor");
      expect(frames.join("")).toContain(`"sessionId":"${publicId}"`);
    } finally {
      release();
      app?.stopNotifications();
      await app?.disposeSessionReaders();
      storage?.close();
      await rm(root, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  },
);

it("cancels a late legacy catalogue publication before identity adoption after shutdown", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "ya-cancel-conversation-source-")),
  );
  const projectPath = join(root, "project");
  const projectId = toUrlProjectId(projectPath);
  const dataDir = join(root, "data");
  const nativeRoot = join(root, "native");
  const nativeId = "legacy-delayed-source";
  const timestamp = new Date().toISOString();
  let app: ReturnType<typeof createApp> | undefined;
  let storage: DiscoverySqliteService | undefined;
  let release = () => {};
  let publish!: (
    value: Awaited<ReturnType<RetainedSessionCollections["read"]>>,
  ) => void;
  const pending = new Promise<
    Awaited<ReturnType<RetainedSessionCollections["read"]>>
  >((resolve) => {
    publish = resolve;
  });
  try {
    await Promise.all(
      [projectPath, nativeRoot].map((path) => mkdir(path, { recursive: true })),
    );
    const filePath = join(nativeRoot, nativeId + ".jsonl");
    await writeFile(
      filePath,
      JSON.stringify({
        type: "user",
        uuid: "u1",
        sessionId: nativeId,
        cwd: projectPath,
        timestamp,
        message: { role: "user", content: "late native source" },
      }) + "\n",
    );
    storage = new DiscoverySqliteService({
      dataDir,
      probeNetworkFilesystem: () => undefined,
    });
    const metadata = new SessionMetadataService({
      dataDir,
      database: storage.getDatabase(),
    });
    await metadata.initialize();
    const adoption = vi.spyOn(metadata.identities, "adoptDiscoveredBatch");
    const read = vi
      .spyOn(RetainedSessionCollections.prototype, "read")
      .mockReturnValue(pending);
    const acquisition = vi.spyOn(ConversationAcquisition.prototype, "read");
    app = createApp({
      sdk: new MockClaudeSDK(),
      dataDir,
      projectsDir: join(root, "ambient"),
      sessionMetadataService: metadata,
      discoverySqlite: storage,
    });
    release = app.conversationSubscriptions.subscribe(
      { sessionId: nativeId, maxMessages: 20, anchorMessageId: null },
      "delayed",
      { send: () => {}, close: () => {} },
    );
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    release();
    app.stopNotifications();
    await app.disposeSessionReaders();
    app = undefined;
    storage.close();
    storage = undefined;
    const row: SessionCatalogRow = {
      sessionId: nativeId,
      catalogFamily: "claude",
      storeKey: nativeRoot,
      nativeStorageScope: nativeRoot,
      projectId,
      projectPath,
      projectIdentityKey: projectPath,
      updatedAt: timestamp,
      sourceVersion: "controlled delayed publication",
      fidelity: "head",
      location: { kind: "file", path: filePath },
    };
    // Only rows are consumed after this await; the lifetime must reject before
    // touching the already-closed profile or allocating native acquisition.
    publish({
      rows: [row],
      catalog: {
        catalogEpoch: "controlled-late-publication",
        catalogGeneration: 1,
        complete: true,
        refreshing: false,
      },
    });
    await pending;
    await Promise.resolve();
    expect(adoption).not.toHaveBeenCalled();
    expect(acquisition).not.toHaveBeenCalled();
  } finally {
    release();
    app?.stopNotifications();
    await app?.disposeSessionReaders();
    storage?.close();
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});
