import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nativeSessionRef,
  parseNativeSessionId,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeProjectId } from "../../src/projects/paths.js";
import { CodexSessionScanner } from "../../src/projects/codex-scanner.js";
import {
  CodexSessionReader,
  observeCodexRolloutTree,
} from "../../src/sessions/codex-reader.js";
import { EventBus } from "../../src/watcher/EventBus.js";
import { ProviderChildRelationshipService } from "../../src/sessions/ProviderChildRelationshipService.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";

const PROJECT_PATH = "/test/project";

function line(type: string, payload: unknown, timestamp: string): string {
  return JSON.stringify({ type, timestamp, payload });
}

function sessionMeta(
  id: string,
  timestamp: string,
  extra: Record<string, unknown> = {},
): string {
  return line(
    "session_meta",
    {
      id,
      cwd: PROJECT_PATH,
      timestamp,
      model_provider: "openai",
      ...extra,
    },
    timestamp,
  );
}

async function writeRollout(
  sessionsDir: string,
  id: string,
  lines: string[],
): Promise<string> {
  const dateDir = join(sessionsDir, "2026", "06", "25");
  await mkdir(dateDir, { recursive: true });
  const filePath = join(dateDir, `rollout-${id}.jsonl`);
  await writeFile(filePath, `${lines.join("\n")}\n`);
  return filePath;
}

describe("Codex subagent sessions", () => {
  let sessionsDir: string;

  beforeEach(async () => {
    sessionsDir = join(tmpdir(), `codex-subagents-${randomUUID()}`);
    await mkdir(sessionsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(sessionsDir, { recursive: true, force: true });
  });

  it("fences structural snapshots even when another reader consumes the native invalidation", async () => {
    const now = "2026-11-04T00:00:00.000Z";
    const events = new EventBus();
    using _observation = {
      [Symbol.dispose]: observeCodexRolloutTree({
        sessionsDir,
        eventBus: events,
        epoch: () => 1,
      }),
    };
    await writeRollout(sessionsDir, "source-parent", [
      sessionMeta("source-parent", now),
    ]);
    await writeRollout(sessionsDir, "other-parent", [
      sessionMeta("other-parent", now),
    ]);
    const childPath = await writeRollout(sessionsDir, "source-child", [
      sessionMeta("source-child", now, {
        parent_thread_id: "source-parent",
        source: {
          subagent: { thread_spawn: { parent_thread_id: "source-parent" } },
        },
      }),
    ]);
    const reader = new CodexSessionReader({
      sessionsDir,
      projectPath: PROJECT_PATH,
    });
    const another = new CodexSessionReader({
      sessionsDir,
      projectPath: PROJECT_PATH,
    });
    try {
      const scope = await realpath(sessionsDir);
      const source = reader.getProviderChildSource(
        nativeSessionRef("codex", scope, parseNativeSessionId("source-parent")),
      )!;
      const first = await source.observe(new AbortController().signal);
      expect(first.state).toBe("complete");
      expect(first.children.map((c) => c.native.id)).toEqual(["source-child"]);
      expect(await source.isCurrent(first.version)).toBe(true);
      // A restored/backdated file must supersede the current native proof, even
      // though the reader's separate historical best-file cache retains it.
      await writeFile(
        childPath,
        sessionMeta("source-child", now, {
          parent_thread_id: "other-parent",
          source: {
            subagent: { thread_spawn: { parent_thread_id: "other-parent" } },
          },
        }) + "\n",
      );
      await utimes(childPath, new Date("2020-01-01"), new Date("2020-01-01"));
      events.emit({
        type: "file-change",
        provider: "codex",
        path: childPath,
        relativePath: childPath,
        changeType: "modify",
        timestamp: now,
        fileType: "session",
      });
      await another.listSessions(encodeProjectId(PROJECT_PATH));
      expect(await source.isCurrent(first.version)).toBe(false);
      const current = await source.observe(new AbortController().signal);
      expect(current.children).toEqual([]);
      const moved = another.getProviderChildSource(
        nativeSessionRef("codex", scope, parseNativeSessionId("other-parent")),
      )!;
      expect(
        (await moved.observe(new AbortController().signal)).children.map(
          (c) => c.native.id,
        ),
      ).toEqual(["source-child"]);
    } finally {
      await reader.close();
      await another.close();
    }
  });

  it("retains partial catalog evidence across shared cache hits instead of publishing false empty", async () => {
    const now = "2026-11-04T00:00:00.000Z";
    await writeRollout(sessionsDir, "partial-parent", [
      sessionMeta("partial-parent", now),
    ]);
    const failedPath = await writeRollout(sessionsDir, "unreadable-child", [
      "{incomplete native header",
    ]);
    const reader = new CodexSessionReader({
      sessionsDir,
      projectPath: PROJECT_PATH,
    });
    const events = new EventBus();
    using _observation = {
      [Symbol.dispose]: observeCodexRolloutTree({
        sessionsDir,
        eventBus: events,
        epoch: () => 1,
      }),
    };
    try {
      const native = nativeSessionRef(
        "codex",
        await realpath(sessionsDir),
        parseNativeSessionId("partial-parent"),
      );
      const source = reader.getProviderChildSource(native)!;
      for (let i = 0; i < 2; i++) {
        const observation = await source.observe(new AbortController().signal);
        expect(observation.state).toBe("partial");
        expect(observation.children).toEqual([]);
      }
      await writeFile(failedPath, sessionMeta("unreadable-child", now) + "\n");
      events.emit({
        type: "file-change",
        provider: "codex",
        path: failedPath,
        relativePath: failedPath,
        changeType: "modify",
        timestamp: now,
        fileType: "session",
      });
      expect((await source.observe(new AbortController().signal)).state).toBe(
        "complete",
      );
    } finally {
      await reader.close();
    }
  });

  it("overlays native activity without SQL commits/events for unchanged child structure", async () => {
    const now = "2026-11-04T00:00:00.000Z";
    await writeRollout(sessionsDir, "bd97b7b1-7d0e-41aa-9c70-340a581dcdb1", [
      sessionMeta("bd97b7b1-7d0e-41aa-9c70-340a581dcdb1", now),
    ]);
    const path = await writeRollout(
      sessionsDir,
      "823e2da4-5fc7-405b-a5be-ddd3eea35ab3",
      [
        sessionMeta("823e2da4-5fc7-405b-a5be-ddd3eea35ab3", now, {
          parent_thread_id: "bd97b7b1-7d0e-41aa-9c70-340a581dcdb1",
          agent_type: "legacy-reviewer",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: "bd97b7b1-7d0e-41aa-9c70-340a581dcdb1",
              },
            },
          },
        }),
      ],
    );
    const reader = new CodexSessionReader({
      sessionsDir,
      projectPath: PROJECT_PATH,
    });
    const db = new DiscoverySqliteService({
      dataDir: join(sessionsDir, "ya"),
      probeNetworkFilesystem: () => undefined,
    });
    let committed!: () => void;
    const firstCommit = new Promise<void>((resolve) => {
      committed = resolve;
    });
    let commits = 0;
    const service = new ProviderChildRelationshipService(
      db.getDatabase(),
      "local",
      () => {
        commits++;
        committed();
      },
    );
    const events = new EventBus();
    using _observation = {
      [Symbol.dispose]: observeCodexRolloutTree({
        sessionsDir,
        eventBus: events,
        epoch: () => 1,
      }),
    };
    const unsubscribe = events.subscribe((event) => {
      if (event.type === "file-change") service.notifyNativeFileChange(event);
    });
    try {
      const parent = nativeSessionRef(
        "codex",
        await realpath(sessionsDir),
        parseNativeSessionId("bd97b7b1-7d0e-41aa-9c70-340a581dcdb1"),
      );
      const source = reader.getProviderChildSource(parent)!;
      let observed!: () => void;
      const observe = source.observe;
      source.observe = async (signal) => {
        const value = await observe(signal);
        observed?.();
        return value;
      };
      service.demand(parent, { sessionId: "public-parent" }, source);
      await firstCommit;
      const original = service.accepted(parent, "public-parent")!;
      expect(original[0]?.agentType).toBe("legacy-reviewer");
      for (let i = 1; i <= 3; i++) {
        const next = new Promise<void>((resolve) => {
          observed = resolve;
        });
        await appendFile(
          path,
          line(
            "event_msg",
            { type: "agent_message", message: "Ordinary child activity" },
            now,
          ) + "\n",
        );
        await utimes(path, new Date(), new Date(Date.now() + i * 1000));
        events.emit({
          type: "file-change",
          provider: "codex",
          path,
          relativePath: path,
          changeType: "modify",
          timestamp: now,
          fileType: "session",
        });
        await next;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(commits).toBe(1);
      expect(service.accepted(parent, "public-parent")).toEqual(
        source.overlayActivity!(original),
      );
      expect(source.overlayActivity!(original)[0]!.updatedAt).not.toBe(
        original[0]!.updatedAt,
      );
      await reader.close();
      expect(service.hasSource(parent)).toBe(false);
      expect(service.accepted(parent, "public-parent")).toEqual(original);
    } finally {
      unsubscribe();
      await service.close();
      db.close();
      await reader.close();
    }
  });

  it("keeps review/internal delegates outside the qualified thread-spawn navigation source", async () => {
    const now = "2026-11-04T00:00:00.000Z";
    await writeRollout(sessionsDir, "delegate-parent", [
      sessionMeta("delegate-parent", now),
    ]);
    await writeRollout(sessionsDir, "review-delegate", [
      sessionMeta("review-delegate", now, {
        parent_thread_id: "delegate-parent",
        source: { subagent: "review" },
      }),
    ]);
    await writeRollout(sessionsDir, "guardian-delegate", [
      sessionMeta("guardian-delegate", now, {
        parent_thread_id: "delegate-parent",
        source: { internal: "guardian" },
      }),
    ]);
    await writeRollout(sessionsDir, "spawn-delegate", [
      sessionMeta("spawn-delegate", now, {
        parent_thread_id: "delegate-parent",
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: "delegate-parent",
              agent_type: "legacy-spawn-role",
            },
          },
        },
      }),
    ]);
    const reader = new CodexSessionReader({
      sessionsDir,
      projectPath: PROJECT_PATH,
    });
    try {
      const parent = nativeSessionRef(
        "codex",
        await realpath(sessionsDir),
        parseNativeSessionId("delegate-parent"),
      );
      const observation = await reader
        .getProviderChildSource(parent)!
        .observe(new AbortController().signal);
      expect(observation.children.map((child) => child.summary)).toMatchObject([
        { id: "spawn-delegate", agentType: "legacy-spawn-role" },
      ]);
    } finally {
      await reader.close();
    }
  });

  it("maps spawn_agent calls to child rollout sessions", async () => {
    const now = "2026-06-25T12:00:00.000Z";
    const parentId = "parent-thread";
    const childId = "child-thread";
    const callId = "call-spawn-1";

    await writeRollout(sessionsDir, parentId, [
      sessionMeta(parentId, now),
      line(
        "response_item",
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Use a subagent" }],
        },
        now,
      ),
      line(
        "response_item",
        {
          type: "function_call",
          name: "spawn_agent",
          call_id: callId,
          arguments: JSON.stringify({
            role: "reviewer",
            prompt: "Inspect the implementation",
          }),
        },
        now,
      ),
      line(
        "response_item",
        {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify({ agent_id: childId, nickname: "Parfit" }),
        },
        now,
      ),
    ]);

    await writeRollout(sessionsDir, childId, [
      sessionMeta(childId, now, {
        parent_thread_id: parentId,
        session_id: parentId,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: parentId,
              agent_role: "reviewer",
            },
          },
        },
        agent_nickname: "Parfit",
        agent_role: "reviewer",
        multi_agent_version: "v2",
      }),
      line(
        "event_msg",
        {
          type: "task_started",
          turn_id: "turn-child",
          model_context_window: 200000,
          collaboration_mode_kind: "subagent",
        },
        now,
      ),
      line(
        "response_item",
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Child result" }],
        },
        now,
      ),
      line(
        "event_msg",
        {
          type: "task_complete",
          turn_id: "turn-child",
          last_agent_message: "Child result",
        },
        now,
      ),
    ]);

    const projectId = encodeProjectId(PROJECT_PATH) as UrlProjectId;
    const reader = new CodexSessionReader({
      sessionsDir,
      projectPath: PROJECT_PATH,
    });

    const summaries = await reader.listSessions(projectId);
    expect(summaries.map((summary) => summary.id)).toEqual([parentId]);

    expect(reader.getAgentMappingCacheStats()).toEqual({
      sessions: 0,
      mappings: 0,
    });
    await expect(
      reader.getSession(parentId, projectId),
    ).resolves.not.toBeNull();
    expect(reader.getAgentMappingCacheStats()).toEqual({
      sessions: 1,
      mappings: 1,
    });

    await expect(reader.getAgentMappings(parentId)).resolves.toEqual([
      { toolUseId: callId, agentId: childId },
    ]);
    const coldReader = new CodexSessionReader({
      sessionsDir,
      projectPath: PROJECT_PATH,
    });
    await expect(coldReader.getAgentMappings(parentId)).resolves.toEqual([
      { toolUseId: callId, agentId: childId },
    ]);
    expect(coldReader.getAgentMappingCacheStats()).toEqual({
      sessions: 1,
      mappings: 1,
    });
    await expect(reader.listProviderChildSessions(parentId)).resolves.toEqual([
      {
        id: childId,
        parentSessionId: parentId,
        title: "Parfit",
        agentType: "reviewer",
        toolUseId: callId,
        updatedAt: now,
      },
    ]);

    const agentSession = await reader.getAgentSession(childId);
    expect(agentSession?.status).toBe("completed");
    expect(agentSession?.messages).toHaveLength(2);
    expect(agentSession?.messages[0]).toMatchObject({
      type: "assistant",
      isSubagent: true,
    });
    expect(agentSession?.messages[0]?.message?.content).toEqual([
      { type: "text", text: "Child result" },
    ]);
    expect(agentSession?.messages[1]).toMatchObject({
      type: "system",
      subtype: "turn_complete",
      codexTurnId: "turn-child",
      isSubagent: true,
    });
  });

  it.each(["item_completed", "sub_agent_activity"] as const)(
    "accepts only correlated %s v2 starts across a partial append",
    async (envelope) => {
      const now = "2026-11-04T12:00:00.000Z";
      const parentId = "parent-v2",
        callId = "spawn-v2",
        childId = "child-v2";
      for (const id of [childId, "not-created", "not-correlated"])
        await writeRollout(sessionsDir, id, [
          sessionMeta(id, now, { parent_thread_id: parentId }),
        ]);
      const file = await writeRollout(sessionsDir, parentId, [
        sessionMeta(parentId, now),
        line(
          "response_item",
          {
            type: "function_call",
            name: "spawn_agent",
            namespace: "collaboration",
            call_id: callId,
            arguments: JSON.stringify({
              task_name: "child",
              message: "Inspect v2 work",
            }),
          },
          now,
        ),
        line(
          "response_item",
          {
            type: "function_call_output",
            call_id: callId,
            output: '{"task_name":"/root/child"}',
          },
          now,
        ),
      ]);
      const activity = (
        kind: string,
        id: string,
        child: string,
        format = envelope,
      ) =>
        line(
          "event_msg",
          format === "item_completed"
            ? {
                type: format,
                item: {
                  type: "SubAgentActivity",
                  kind,
                  id,
                  agent_thread_id: child,
                },
              }
            : {
                type: format,
                kind,
                event_id: id,
                agent_thread_id: child,
                agent_path: "/root/child",
              },
          now,
        );
      const reader = new CodexSessionReader({
        sessionsDir,
        projectPath: PROJECT_PATH,
      });
      try {
        expect(await reader.listProviderChildSessions(parentId)).toEqual([]);
        await appendFile(
          file,
          activity("interacted", callId, "not-created") +
            "\n" +
            activity("started", "unrelated-call", "not-correlated") +
            "\n",
        );
        const started = activity("started", callId, childId);
        const split = Math.floor(started.length / 2);
        await appendFile(file, started.slice(0, split));
        expect(await reader.listProviderChildSessions(parentId)).toEqual([]);
        await appendFile(file, started.slice(split) + "\n");
        expect(await reader.listProviderChildSessions(parentId)).toEqual([
          expect.objectContaining({
            id: childId,
            parentSessionId: parentId,
            toolUseId: callId,
            title: "Inspect v2 work",
          }),
        ]);
        await appendFile(
          file,
          activity(
            "started",
            callId,
            childId,
            envelope === "item_completed"
              ? "sub_agent_activity"
              : "item_completed",
          ) +
            "\n" +
            JSON.stringify({ type: "event_msg", marker: "SubAgentActivity" }) +
            "\n",
        );
        expect(await reader.listProviderChildSessions(parentId)).toHaveLength(
          1,
        );
      } finally {
        await reader.close();
      }
    },
  );

  it.each(["v1", "v2"])(
    "does not attribute fork-copied %s launches to the fork",
    async (version) => {
      const now = "2026-11-04T12:00:00.000Z";
      const parent = "original",
        fork = "copied-fork",
        child = "original-child",
        ownChild = "fork-child",
        nested = "native-fork",
        grandchild = "native-grandchild";
      const spawn = (id: string, call: string) => [
        line(
          "response_item",
          {
            type: "function_call",
            name: "spawn_agent",
            call_id: call,
            arguments: '{"message":"Inspect work"}',
          },
          now,
        ),
        version === "v1"
          ? line(
              "response_item",
              {
                type: "function_call_output",
                call_id: call,
                output: JSON.stringify({ agent_id: id }),
              },
              now,
            )
          : line(
              "event_msg",
              {
                type: "sub_agent_activity",
                event_id: call,
                kind: "started",
                agent_thread_id: id,
                agent_path: "/root/child",
              },
              now,
            ),
      ];
      await writeRollout(sessionsDir, child, [
        sessionMeta(child, now, { parent_thread_id: parent }),
      ]);
      await writeRollout(sessionsDir, ownChild, [
        sessionMeta(ownChild, now, {
          source: { subagent: { thread_spawn: { parent_thread_id: fork } } },
        }),
      ]);
      await writeRollout(sessionsDir, parent, [
        sessionMeta(parent, now),
        ...spawn(child, "inherited"),
      ]);
      await writeRollout(sessionsDir, fork, [
        sessionMeta(fork, now, {
          forked_from_id: parent,
          history_mode: "legacy",
        }),
        ...spawn(child, "inherited"),
        ...spawn(ownChild, "own"),
      ]);
      await writeRollout(sessionsDir, grandchild, [
        sessionMeta(grandchild, now, { parent_thread_id: nested }),
      ]);
      await writeRollout(sessionsDir, nested, [
        sessionMeta(nested, now, {
          parent_thread_id: parent,
          forked_from_id: parent,
          history_mode: "legacy",
        }),
        ...spawn(child, "inherited"),
        ...spawn(grandchild, "nested-own"),
      ]);
      const reader = new CodexSessionReader({
        sessionsDir,
        projectPath: PROJECT_PATH,
      });
      try {
        expect(
          (await reader.listProviderChildSessions(nested)).map((c) => c.id),
        ).toEqual([grandchild]);
        expect(
          (await reader.listProviderChildSessions(parent)).map((c) => c.id),
        ).toEqual([child]);
        expect(
          (await reader.listProviderChildSessions(fork)).map((c) => c.id),
        ).toEqual([ownChild]);
      } finally {
        await reader.close();
      }
    },
  );

  it("coalesces and incrementally refreshes bounded child projections", async () => {
    const events = new EventBus();
    using _observation = {
      [Symbol.dispose]: observeCodexRolloutTree({
        sessionsDir,
        eventBus: events,
        epoch: () => 1,
      }),
    };
    const now = "2026-06-25T12:00:00.000Z";
    const parentId = "projection-parent";
    const firstChildId = "projection-child-1";
    const secondChildId = "projection-child-2";
    const firstCallId = "call-projection-1";
    const secondCallId = "call-projection-2";
    const ordinaryLines = Array.from({ length: 2_000 }, (_, index) =>
      line(
        "event_msg",
        { type: "agent_message", message: `ordinary-${index}` },
        now,
      ),
    );
    const parentPath = await writeRollout(sessionsDir, parentId, [
      sessionMeta(parentId, now),
      ...ordinaryLines,
      line(
        "response_item",
        {
          type: "function_call",
          name: "spawn_agent",
          call_id: firstCallId,
          arguments: JSON.stringify({
            role: "reviewer",
            prompt: "Inspect the projection",
          }),
        },
        now,
      ),
      line(
        "response_item",
        {
          type: "function_call_output",
          call_id: firstCallId,
          output: JSON.stringify({ agent_id: firstChildId }),
        },
        now,
      ),
    ]);
    await writeRollout(sessionsDir, firstChildId, [
      sessionMeta(firstChildId, now, {
        parent_thread_id: parentId,
        source: { subagent: { thread_spawn: { parent_thread_id: parentId } } },
      }),
    ]);

    const readers = Array.from(
      { length: 20 },
      () =>
        new CodexSessionReader({
          sessionsDir,
          projectPath: PROJECT_PATH,
        }),
    );
    const statsBefore = readers[0]!.getProviderChildProjectionCacheStats();
    const concurrent = await Promise.all(
      readers.map((reader) => reader.listProviderChildSessions(parentId)),
    );
    const statsAfter = readers[0]!.getProviderChildProjectionCacheStats();

    expect(concurrent.every((children) => children.length === 1)).toBe(true);
    expect(statsAfter.workStarts - statsBefore.workStarts).toBe(1);
    expect(
      statsAfter.joinedCalls -
        statsBefore.joinedCalls +
        (statsAfter.cacheHits - statsBefore.cacheHits),
    ).toBe(19);
    for (const reader of readers) {
      expect(reader.getEntryCacheStats()).toEqual({
        sessions: 0,
        entries: 0,
        sourceBytes: 0,
        partialLineBytes: 0,
      });
    }

    const reader = readers[0]!;
    await expect(
      reader.listProviderChildSessions(parentId),
    ).resolves.toHaveLength(1);
    expect(reader.getLastProviderChildProjectionMetrics()).toMatchObject({
      status: "hit",
      sourceBytesRead: 0,
      childCount: 1,
    });

    const sizeBeforeOrdinaryAppend = (await stat(parentPath)).size;
    const ordinaryAppend = `${line(
      "event_msg",
      { type: "agent_message", message: "ordinary append" },
      now,
    )}\n`;
    await appendFile(parentPath, ordinaryAppend);
    await expect(
      reader.listProviderChildSessions(parentId),
    ).resolves.toHaveLength(1);
    expect(reader.getLastProviderChildProjectionMetrics()).toMatchObject({
      status: "computed",
      fullRebuild: false,
      startOffset: sizeBeforeOrdinaryAppend,
      sourceBytesRead: Buffer.byteLength(ordinaryAppend),
      childCount: 1,
    });

    const secondChildPath = await writeRollout(sessionsDir, secondChildId, [
      sessionMeta(secondChildId, now, {
        parent_thread_id: parentId,
        source: { subagent: { thread_spawn: { parent_thread_id: parentId } } },
      }),
    ]);
    events.emit({
      type: "file-change",
      provider: "codex",
      path: secondChildPath,
      relativePath: secondChildPath,
      nativeStorageScope: sessionsDir,
      changeType: "create",
      timestamp: now,
      fileType: "session",
    });
    const spawnAppend = line(
      "response_item",
      {
        type: "function_call",
        name: "spawn_agent",
        call_id: secondCallId,
        arguments: JSON.stringify({
          role: "explorer",
          prompt: "Map the callers",
        }),
      },
      now,
    );
    const sizeBeforeSpawnAppend = (await stat(parentPath)).size;
    await appendFile(parentPath, spawnAppend);
    await expect(
      reader.listProviderChildSessions(parentId),
    ).resolves.toHaveLength(1);
    expect(reader.getLastProviderChildProjectionMetrics()).toMatchObject({
      status: "computed",
      fullRebuild: false,
      startOffset: sizeBeforeSpawnAppend,
      sourceBytesRead: Buffer.byteLength(spawnAppend),
      childCount: 1,
    });

    const outputAppend = `\n${line(
      "response_item",
      {
        type: "function_call_output",
        call_id: secondCallId,
        output: JSON.stringify({ agent_id: secondChildId, nickname: "Hume" }),
      },
      now,
    )}\n`;
    const sizeBeforeOutputAppend = (await stat(parentPath)).size;
    await appendFile(parentPath, outputAppend);
    await expect(reader.listProviderChildSessions(parentId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: firstChildId }),
        expect.objectContaining({
          id: secondChildId,
          title: "Hume",
          agentType: "explorer",
          toolUseId: secondCallId,
        }),
      ]),
    );
    expect(reader.getLastProviderChildProjectionMetrics()).toMatchObject({
      status: "computed",
      fullRebuild: false,
      startOffset: sizeBeforeOutputAppend,
      sourceBytesRead: Buffer.byteLength(outputAppend),
      childCount: 2,
    });

    const sizeBeforeReplacement = (await stat(parentPath)).size;
    const replacementHead = `${sessionMeta(parentId, now)}\n`;
    await writeFile(
      parentPath,
      `${replacementHead}${" ".repeat(
        sizeBeforeReplacement - Buffer.byteLength(replacementHead),
      )}`,
    );
    await expect(reader.listProviderChildSessions(parentId)).resolves.toEqual(
      [],
    );
    expect(reader.getLastProviderChildProjectionMetrics()).toMatchObject({
      status: "computed",
      fullRebuild: true,
      startOffset: 0,
      fileSize: sizeBeforeReplacement,
      childCount: 0,
    });

    await writeFile(parentPath, `${sessionMeta(parentId, now)}\n`);
    await expect(reader.listProviderChildSessions(parentId)).resolves.toEqual(
      [],
    );
    expect(reader.getLastProviderChildProjectionMetrics()).toMatchObject({
      status: "computed",
      fullRebuild: true,
      startOffset: 0,
      childCount: 0,
    });
  });

  it("serves accepted child state while a cold refresh runs", async () => {
    const now = "2026-06-25T12:00:00.000Z";
    const parentId = "accepted-parent";
    const childId = "accepted-child";
    const callId = "call-accepted";
    await writeRollout(sessionsDir, parentId, [
      sessionMeta(parentId, now),
      line(
        "response_item",
        {
          type: "function_call",
          name: "spawn_agent",
          call_id: callId,
          arguments: JSON.stringify({ prompt: "Inspect accepted state" }),
        },
        now,
      ),
      line(
        "response_item",
        {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify({ agent_id: childId }),
        },
        now,
      ),
    ]);
    await writeRollout(sessionsDir, childId, [
      sessionMeta(childId, now, {
        parent_thread_id: parentId,
        source: { subagent: { thread_spawn: { parent_thread_id: parentId } } },
      }),
    ]);
    const reader = new CodexSessionReader({
      sessionsDir,
      projectPath: PROJECT_PATH,
    });

    expect(reader.listAcceptedProviderChildSessions(parentId)).toBeUndefined();
    await expect(
      reader.listProviderChildSessions(parentId),
    ).resolves.toHaveLength(1);
    expect(reader.listAcceptedProviderChildSessions(parentId)).toEqual([
      expect.objectContaining({ id: childId, parentSessionId: parentId }),
    ]);
  });

  it("keeps unpublished cold misses distinct from a published empty projection", async () => {
    const now = "2026-06-25T12:00:00.000Z";
    const parentId = "published-empty-parent";
    await writeRollout(sessionsDir, parentId, [sessionMeta(parentId, now)]);
    const reader = new CodexSessionReader({
      sessionsDir,
      projectPath: PROJECT_PATH,
    });

    expect(reader.listAcceptedProviderChildSessions(parentId)).toBeUndefined();
    await expect(reader.listProviderChildSessions(parentId)).resolves.toEqual(
      [],
    );
    expect(reader.listAcceptedProviderChildSessions(parentId)).toEqual([]);
  });

  it("does not expose child rollouts as standalone Codex projects", async () => {
    const now = "2026-06-25T12:00:00.000Z";
    const parentId = "project-parent-thread";
    const childId = "project-child-thread";

    await writeRollout(sessionsDir, parentId, [
      sessionMeta(parentId, now),
      line(
        "response_item",
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Parent session" }],
        },
        now,
      ),
    ]);
    await writeRollout(sessionsDir, childId, [
      sessionMeta(childId, now, {
        parent_thread_id: parentId,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: parentId,
            },
          },
        },
      }),
      line(
        "response_item",
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Child session" }],
        },
        now,
      ),
    ]);

    const scanner = new CodexSessionScanner({ sessionsDir });
    const projects = await scanner.listProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      path: PROJECT_PATH,
      sessionCount: 1,
    });
  });
});
