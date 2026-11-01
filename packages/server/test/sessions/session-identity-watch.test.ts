import {
  appendFile,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  writeFile,
  utimes,
} from "node:fs/promises";
import type { FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { toUrlProjectId, type YepMessage } from "@yep-anywhere/shared";
import { expect, it, vi } from "vitest";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { ClaudeSessionReader } from "../../src/sessions/reader.js";
import { hashProjectPath } from "../../src/projects/gemini-project-map.js";
import { PiSessionReader } from "../../src/sessions/pi-reader.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import { MockClaudeSDK } from "../../src/sdk/mock.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import { handleSessionWatchSubscribe } from "../../src/routes/ws-relay-handlers.js";
import * as sharedWatches from "../../src/watcher/SharedDirectoryWatcher.js";
import { createApp } from "../setup/create-app.js";

it.each(["claude", "codex", "pi", "gemini"] as const)(
  "watches the bound %s file through the retained wire protocol and releases shared interest",
  async (provider) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "ya-native-watch-")),
    );
    const dataDir = join(root, "data");
    const projectPath = join(root, "project");
    const workingPath = join(root, "working");
    const projectId = toUrlProjectId(projectPath);
    const workingId = toUrlProjectId(workingPath);
    const nativeRoot = join(root, "native");
    const sessionId = "permanent-watch-public";
    const nativeId = "019a0000-4444-7444-8444-444444444444";
    const subscriptions = new Map<string, () => void>();
    let unblock = () => {};
    let app: ReturnType<typeof createApp> | undefined;
    let storage: DiscoverySqliteService | undefined;
    try {
      await Promise.all(
        [projectPath, workingPath, nativeRoot].map((p) =>
          mkdir(p, { recursive: true }),
        ),
      );
      const nativeFile = join(
        nativeRoot,
        provider === "gemini"
          ? `native-slug/chats/session-${nativeId}.json`
          : provider === "claude"
            ? `${nativeId}.jsonl`
            : provider === "pi"
              ? `project/${nativeId}.jsonl`
              : `rollout-2026-11-01T00-00-00-${nativeId}.jsonl`,
      );
      await mkdir(dirname(nativeFile), { recursive: true });
      const user = (text: string, uuid: string) =>
        provider === "gemini"
          ? {
              id: uuid,
              type: "user",
              timestamp: "2026-11-01T00:00:01Z",
              content: text,
            }
          : provider === "pi"
            ? {
                type: "message",
                id: uuid,
                parentId: uuid === "user-2" ? "user-1" : null,
                timestamp: "2026-11-01T00:00:01.000Z",
                message: { role: "user", content: text },
              }
            : provider === "claude"
              ? {
                  type: "user",
                  uuid,
                  sessionId: nativeId,
                  cwd: projectPath,
                  timestamp: "2026-11-01T00:00:01.000Z",
                  message: { role: "user", content: text },
                }
              : {
                  type: "event_msg",
                  timestamp: "2026-11-01T00:00:01.000Z",
                  payload: { type: "user_message", message: text },
                };
      const geminiFile = (messages: unknown[]) =>
        JSON.stringify({
          sessionId: nativeId,
          projectHash: hashProjectPath(projectPath),
          startTime: "2026-11-01T00:00:00Z",
          lastUpdated: "2026-11-01T00:00:01Z",
          messages,
        });
      await writeFile(
        nativeFile,
        provider === "gemini"
          ? geminiFile([user("initial native history", "user-1")])
          : [
              ...(provider === "codex"
                ? [
                    {
                      type: "session_meta",
                      payload: {
                        id: nativeId,
                        cwd: projectPath,
                        timestamp: "2026-11-01T00:00:00.000Z",
                      },
                    },
                  ]
                : []),
              ...(provider === "pi"
                ? [
                    {
                      type: "session",
                      version: 3,
                      id: nativeId,
                      cwd: projectPath,
                      timestamp: "2026-11-01T00:00:00.000Z",
                    },
                  ]
                : []),
              user("initial native history", "user-1"),
            ]
              .map((entry) => JSON.stringify(entry))
              .join("\n") + "\n",
      );
      const fixedPiMtime = new Date("2026-11-01T00:00:00Z");
      if (provider === "pi")
        await utimes(nativeFile, fixedPiMtime, fixedPiMtime);
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
        .prepare("INSERT INTO session_identities VALUES (?, ?, ?, ?, ?, ?, ?)");
      try {
        insert.run(
          sessionId,
          provider,
          projectId,
          "2026-11-01T00:00:00.000Z",
          provider,
          nativeRoot,
          nativeId,
        );
      } finally {
        insert.finalize();
      }
      await metadata.setWorkingProject(sessionId, workingId, projectId);
      app = createApp({
        sdk: new MockClaudeSDK(),
        dataDir,
        projectsDir: join(root, "ambient"),
        sessionMetadataService: metadata,
        discoverySqlite: storage,
      });
      const before = await app.app.request(
        `/api/projects/${workingId}/sessions/${sessionId}`,
      );
      expect(before.status).toBe(200);
      expect(JSON.stringify(await before.json())).toContain(
        "initial native history",
      );

      let ready!: (lease: FSWatcher) => void;
      const watching = new Promise<FSWatcher>((resolve) => {
        ready = resolve;
      });
      const watch = sharedWatches.watchSharedDirectory;
      const watchSpy = vi
        .spyOn(sharedWatches, "watchSharedDirectory")
        .mockImplementation((...args) => {
          const lease = watch(...args);
          ready(lease);
          return lease;
        });
      const changes = [0, 1].map(
        (index) =>
          new Promise<YepMessage>((resolve) => {
            handleSessionWatchSubscribe(
              subscriptions,
              {
                type: "subscribe",
                channel: "session-watch",
                subscriptionId: `viewer-${index}`,
                sessionId,
                projectId: workingId,
                provider: "grok",
              },
              (msg) => {
                if (
                  msg.type === "event" &&
                  msg.eventType === "session-watch-change"
                )
                  resolve(msg);
              },
              app!.focusedSessionWatchManager,
            );
          }),
      );
      const lease = await watching;
      const close = vi.spyOn(lease, "close");
      if (provider === "gemini")
        await writeFile(
          nativeFile,
          geminiFile([
            user("initial native history", "user-1"),
            user("appended native history", "user-2"),
          ]),
        );
      else
        await appendFile(
          nativeFile,
          JSON.stringify(user("appended native history", "user-2")) + "\n",
        );
      if (provider === "pi")
        await utimes(nativeFile, fixedPiMtime, fixedPiMtime);
      const events = await Promise.all(changes);
      expect(watchSpy).toHaveBeenCalledTimes(1);
      for (const event of events) {
        if (event.type !== "event")
          throw new Error("expected retained event frame");
        expect(event.data).toMatchObject({
          sessionId,
          projectId: workingId,
          provider,
          path: nativeFile,
        });
        expect(nativeFile).not.toContain(sessionId);
      }
      // Reproduce the retained handler's filename-independent fetch against the app.
      // Executing released clients in a browser remains separate qualification.
      const refreshed = await app.app.request(
        `/api/projects/${workingId}/sessions/${sessionId}`,
      );
      expect(refreshed.status).toBe(200);
      expect(JSON.stringify(await refreshed.json())).toContain(
        "appended native history",
      );
      subscriptions.get("viewer-0")!();
      subscriptions.delete("viewer-0");
      expect(close).not.toHaveBeenCalled();
      subscriptions.get("viewer-1")!();
      subscriptions.delete("viewer-1");
      expect(close).toHaveBeenCalledTimes(1);
      // Neither an unbound nor a missing bound source may watch a same-string
      // ambient transcript; their live-view retry owner must also be released.
      const ambient = join(
        root,
        "ambient",
        projectPath.replace(/[/\\:]/g, "-"),
      );
      await mkdir(ambient, { recursive: true });
      for (const [id, missingNativeId] of [
        ["unbound-watch", null],
        ["missing-bound-watch", "missing-native"],
      ] as const) {
        await writeFile(
          join(ambient, id + ".jsonl"),
          JSON.stringify(user("unrelated ambient file", "ambient")) + "\n",
        );
        const row = storage
          .getDatabase()
          .prepare(
            "INSERT INTO session_identities VALUES (?, ?, ?, ?, ?, ?, ?)",
          );
        try {
          row.run(
            id,
            provider,
            projectId,
            "2026-11-01T00:00:00.000Z",
            missingNativeId ? provider : null,
            missingNativeId ? nativeRoot : null,
            missingNativeId,
          );
        } finally {
          row.finalize();
        }
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        const onChange = vi.fn();
        const cleanup = app.focusedSessionWatchManager.subscribe(
          { sessionId: id, projectId, providerHint: "claude" },
          onChange,
        );
        subscriptions.set(id, cleanup);
        await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
        expect(watchSpy).toHaveBeenCalledTimes(1);
        expect(onChange).not.toHaveBeenCalled();
        cleanup();
        subscriptions.delete(id);
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
      }
      // A slow stored-source resolution cannot acquire native reader work after
      // the last viewer has left and the application reader pool has closed.
      const lateNativeId = "019a0000-5555-7555-8555-555555555555";
      const lateRoot = join(root, "late-native");
      await mkdir(lateRoot);
      const lateRow = storage
        .getDatabase()
        .prepare("INSERT INTO session_identities VALUES (?, ?, ?, ?, ?, ?, ?)");
      try {
        lateRow.run(
          "late-watch",
          provider,
          projectId,
          "2026-11-01T00:00:00.000Z",
          provider,
          lateRoot,
          lateNativeId,
        );
      } finally {
        lateRow.finalize();
      }
      const project = await app.scanner.getOrCreateProject(projectId);
      let release!: () => void;
      let entered!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
        unblock = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      vi.spyOn(app.scanner, "getOrCreateProject").mockImplementation(
        async () => {
          entered();
          await blocked;
          return project;
        },
      );
      const nativeLookup = vi.spyOn(
        provider === "claude"
          ? ClaudeSessionReader.prototype
          : provider === "pi"
            ? PiSessionReader.prototype
            : CodexSessionReader.prototype,
        "getSessionFilePath",
      );
      const stop = app.focusedSessionWatchManager.subscribe(
        { sessionId: "late-watch", projectId },
        () => {},
      );
      subscriptions.set("late-watch", stop);
      await started;
      stop();
      subscriptions.delete("late-watch");
      app.stopNotifications();
      await app.disposeSessionReaders();
      app = undefined;
      release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        nativeLookup.mock.calls.filter(([id]) => id === lateNativeId),
      ).toEqual([]);
      expect(watchSpy).toHaveBeenCalledTimes(1);
    } finally {
      for (const cleanup of subscriptions.values()) cleanup();
      unblock();
      vi.useRealTimers();
      app?.stopNotifications();
      await app?.disposeSessionReaders();
      storage?.close();
      await rm(root, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  },
);
