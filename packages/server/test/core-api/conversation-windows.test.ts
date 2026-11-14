import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { ClaudeSessionReader } from "../../src/sessions/reader.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import { createProviderConversationSource } from "../../src/experimental/provider-conversation-source.js";
import { ConversationSubscriptions } from "../../src/experimental/conversation-subscriptions.js";
import type { ConversationSourceDependencies } from "../../src/experimental/conversation-source.js";
import {
  createConversationRead,
  createConversationFollow,
} from "../../src/core-api/conversation.js";
import {
  loadCapture,
  replayNative,
} from "../utils/captured-provider-replay.js";
import {
  prepareConversation,
  selectConversation,
} from "../../src/experimental/conversation-projection.js";

it.each(["claude", "codex"] as const)(
  "%s native windows preserve captured prose and failure projection",
  async (provider) => {
    const capture = await loadCapture(`${provider}-basic-2026-09-12`);
    const dir = await mkdtemp(join(tmpdir(), "ya-v0-window-"));
    const { sessionId, projectPath } = capture.manifest;
    const path =
      provider === "claude"
        ? join(dir, `${sessionId}.jsonl`)
        : join(dir, `rollout-2026-09-12T00-00-00-${sessionId}.jsonl`);
    const reader =
      provider === "claude"
        ? new ClaudeSessionReader({ sessionDir: dir })
        : new CodexSessionReader({
            sessionsDir: dir,
            dataDir: join(dir, "data"),
          });
    const subscriptions = new ConversationSubscriptions(
      createProviderConversationSource({
        resolve: async () => ({
          sessionId,
          nativeStorageScope: dir,
          catalogFamily: provider,
          storeKey: dir,
          projectId: toUrlProjectId(projectPath),
          projectPath,
          projectIdentityKey: projectPath,
          updatedAt: "2026-09-12T00:00:00.000Z",
          fidelity: "tail",
          sourceVersion: "fixture",
          location: { kind: "file", path },
        }),
        getProcess: () => undefined,
        readerFactory: () => reader,
      }),
    );
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        capture.native.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      );
      const actual = await createConversationRead(subscriptions)(sessionId, {});
      const expected = await replayNative(capture);
      const view = selectConversation(
        prepareConversation({
          sessionId,
          messages: expected.messages,
          activity: "unknown",
          pendingRequests: [],
          sourceCoverage: { complete: true, earlierOutsideScope: "no" },
        }),
        { sessionId, maxMessages: 20, anchorMessageId: null },
        { subscriptionId: "test", sequence: 0 },
      ).view;
      expect(view.kind).toBe("conversation");
      if (view.kind === "conversation")
        expect(actual.messages).toEqual(view.messages);
    } finally {
      subscriptions.close();
      await reader.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it("reads the recent prose of a long Claude history and reports byte-limited acquisition", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ya-v0-long-window-"));
  const path = join(dir, "session.jsonl");
  const reader = new ClaudeSessionReader({ sessionDir: dir });
  let process: ReturnType<ConversationSourceDependencies["getProcess"]>;
  const records: Record<string, unknown>[] = [];
  let parent: string | null = null;
  const add = (type: string, content: unknown) => {
    const uuid = `row-${records.length}`;
    records.push({
      type,
      uuid,
      parentUuid: parent,
      sessionId: "session",
      timestamp: "2026-11-14T00:00:00.000Z",
      message: { role: type, content },
    });
    parent = uuid;
  };
  add("user", "Start");
  add("assistant", [{ type: "thinking", thinking: "private".repeat(1400000) }]);
  for (let i = 0; i < 100; i++) {
    add("user", `Question ${i}`);
    add("assistant", [{ type: "text", text: "x".repeat(96 * 1024) }]);
  }
  add("user", "What shipped?");
  add("assistant", [{ type: "text", text: "Shipped **Orchid**." }]);
  const subscriptions = new ConversationSubscriptions(
    createProviderConversationSource({
      resolve: async () => ({
        sessionId: "session",
        nativeStorageScope: dir,
        catalogFamily: "claude",
        storeKey: dir,
        projectId: toUrlProjectId(dir),
        projectPath: dir,
        projectIdentityKey: dir,
        updatedAt: "2026-11-14T00:00:00.000Z",
        fidelity: "tail",
        sourceVersion: "fixture",
        location: { kind: "file", path },
      }),
      getProcess: () => process,
      readerFactory: () => reader,
    }),
  );
  try {
    await writeFile(
      path,
      records.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );
    const read = createConversationRead(subscriptions);
    const result = await read("session", { maxMessages: "2" });
    expect(result.messages.map((message) => message.role)).toEqual([
      "user",
      "agent",
    ]);
    expect(result.messages[1]?.content).toEqual([
      { kind: "text", format: "markdown", text: "Shipped **Orchid**." },
    ]);
    expect(result.coverage).toMatchObject({
      completeForRequest: false,
      earlierInScope: true,
      limitedBy: expect.arrayContaining(["bytes"]),
    });
    expect(JSON.stringify(result)).not.toContain("private");

    // One enormous newest record must produce an omission, not a 503 or an
    // apparently complete answer from before that record.
    add("assistant", [{ type: "text", text: "z".repeat(9 * 1024 * 1024) }]);
    await writeFile(
      path,
      records.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );
    const oversized = await read("session", { maxMessages: "2" });
    expect(oversized.coverage.completeForRequest).toBe(false);
    expect(oversized.messages.at(-1)?.truncated).toBe(true);
    expect(JSON.stringify(oversized)).toContain("Unavailable content");
    process = {
      state: { type: "in-turn" },
      subscribe: () => () => {},
      registerViewer: () => () => {},
      getMessageHistory: () => [
        {
          type: "assistant",
          uuid: "live-huge",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "v".repeat(9 * 1024 * 1024) }],
          },
        },
      ],
    };
    const live = await read("session", { maxMessages: "2" });
    expect(live.activity).toBe("working");
    expect(live.coverage).toMatchObject({
      completeForRequest: false,
      limitedBy: expect.arrayContaining(["bytes"]),
    });
    expect(live.messages.at(-1)?.truncated).toBe(true);
  } finally {
    subscriptions.close();
    await reader.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("keeps different compaction scopes independent and resets follow cursors when scope changes", async () => {
  const source = new ConversationSubscriptions(async (sessionId) => ({
    close() {},
    async read() {
      return {
        sessionId,
        activity: "idle",
        pendingRequests: [],
        sourceCoverage: { complete: true, earlierOutsideScope: "no" },
        messages: [
          { type: "user", uuid: "u1", content: "old" },
          { type: "assistant", uuid: "a1", content: "old answer" },
          { type: "system", uuid: "c1", subtype: "compact_boundary" },
          { type: "user", uuid: "u2", content: "middle" },
          { type: "assistant", uuid: "a2", content: "middle answer" },
          { type: "system", uuid: "c2", subtype: "compact_boundary" },
          { type: "user", uuid: "u3", content: "latest" },
          { type: "assistant", uuid: "a3", content: "latest answer" },
        ],
      };
    },
  }));
  try {
    const read = createConversationRead(source);
    const [one, two] = await Promise.all([
      read("s", { tailCompactions: "1" }),
      read("s", { tailCompactions: "2" }),
    ]);
    expect(one.messages.map((message) => message.id)).toEqual([
      "u3",
      "agent:u3",
    ]);
    expect(two.messages.map((message) => message.id)).toEqual([
      "u2",
      "agent:u2",
      "u3",
      "agent:u3",
    ]);
    expect(one.coverage.compactions).toBe(1);
    expect(two.coverage.compactions).toBe(2);
    const follow = createConversationFollow(source, "A");
    const initial = await follow("s", { tailCompactions: "1" });
    expect(
      await follow("s", {
        tailCompactions: "2",
        after: initial.cursor,
        waitMs: "0",
      }),
    ).toMatchObject({ changed: true, reset: true });
  } finally {
    source.close();
  }
});
