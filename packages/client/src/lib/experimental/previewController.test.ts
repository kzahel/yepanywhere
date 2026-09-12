import { describe, expect, it, vi } from "vitest";
import { CONVERSATION_API_REVISION } from "@yep-anywhere/shared/experimental/conversation-protocol";
import type { ConversationQuery } from "@yep-anywhere/shared/experimental/simple-client.generated";
import fixture from "../../../../shared/test/fixtures/simple-client/claude-conversation.json";
import type { SavedHost } from "../hostStorage";
import type { StreamHandlers } from "../connection/types";
import { PreviewController, type PreviewConnection } from "./previewController";
import { previewGroups } from "./previewGroups";

const supported = {
  capabilityEncoding: 1,
  capabilityBits: [[2, 32]],
  experimentalSimpleClientApiRevision: CONVERSATION_API_REVISION,
};
const host = (id: string): SavedHost => ({
  id,
  displayName: id,
  mode: "direct",
  wsUrl: "ws://test/ws",
  srpUsername: "test",
  createdAt: "",
  session: {
    wsUrl: "ws://test/ws",
    username: "test",
    sessionId: "resume",
    sessionKey: "test",
  },
});
function connection(version: object = supported) {
  const streams: Array<{
    id: string;
    query: ConversationQuery;
    handlers: StreamHandlers;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const fetch = vi.fn(async (path: string) =>
    path === "/version"
      ? version
      : {
          sessions: [
            {
              id: "collision",
              title: "Session",
              projectId: "project",
              projectName: "Project",
            },
          ],
          hasMore: false,
        },
  );
  const close = vi.fn();
  const subscribeConversation = vi.fn(
    (id: string, query: ConversationQuery, handlers: StreamHandlers) => {
      const stream = { id, query, handlers, close: vi.fn() };
      streams.push(stream);
      return { id, close: stream.close };
    },
  );
  return {
    fetch,
    close,
    subscribeConversation,
    streams,
    api: { fetch, close, subscribeConversation } as PreviewConnection,
  };
}
function emit(
  stream: ReturnType<typeof connection>["streams"][number],
  sequence = 0,
  text = "hello",
) {
  const payload = structuredClone(fixture);
  payload.subscriptionId = stream.id;
  payload.sequence = sequence;
  payload.view.sessionId = "collision";
  payload.view.messages[0]!.content[0]!.text = text;
  stream.handlers.onEvent("snapshot", undefined, payload);
}
async function ready(controller: PreviewController, ids: string[]) {
  for (const id of ids) controller.include(id, true);
  await vi.waitFor(() =>
    expect(
      controller
        .getSnapshot()
        .sources.filter((source) => source.status === "ready"),
    ).toHaveLength(ids.length),
  );
}

describe("experimental web preview owner", () => {
  it.each([
    { current: "0.8.0" },
    { current: "0.8.1" },
    { ...supported, experimentalSimpleClientApiRevision: undefined },
    { ...supported, experimentalSimpleClientApiRevision: "future" },
  ])(
    "gates unsupported servers before catalog or experimental requests: %j",
    async (version) => {
      const old = connection(version);
      const peer = connection();
      const controller = new PreviewController(
        [host("old"), host("peer")],
        async (h) => (h.id === "old" ? old.api : peer.api),
      );
      try {
        controller.include("old", true);
        await ready(controller, ["peer"]);
        await vi.waitFor(() =>
          expect(controller.getSnapshot().sources[0]?.status).toMatch(
            /update-required|revision-mismatch/,
          ),
        );
        expect(old.fetch.mock.calls).toEqual([["/version"]]);
        expect(old.subscribeConversation).not.toHaveBeenCalled();
        controller.select("peer", "collision");
        emit(peer.streams[0]!);
        expect(controller.getSnapshot().conversationStatus).toBe("ready");
      } finally {
        controller.dispose();
      }
    },
  );
  it("isolates colliding identities, rejects late frames and keeps grouping local", async () => {
    const a = connection();
    const b = connection();
    const controller = new PreviewController(
      [host("a"), host("b")],
      async (h) => (h.id === "a" ? a.api : b.api),
    );
    try {
      await ready(controller, ["a", "b"]);
      controller.select("a", "collision");
      emit(a.streams[0]!, 0, "Alpha");
      controller.select("b", "collision");
      emit(b.streams[0]!, 0, "Beta");
      const snapshot = controller.getSnapshot();
      emit(a.streams[0]!, 4, "stale Alpha");
      emit(b.streams[0]!, 0, "duplicate Beta");
      expect(controller.getSnapshot()).toBe(snapshot);
      expect(a.streams[0]!.close).toHaveBeenCalledTimes(1);
      expect(previewGroups(snapshot.sources, "project")).toHaveLength(2);
      expect(previewGroups(snapshot.sources, "issue")).toHaveLength(2);
      expect(a.fetch).toHaveBeenCalledTimes(2);
      expect(b.fetch).toHaveBeenCalledTimes(2);
      controller.include("a", false);
      expect(b.close).not.toHaveBeenCalled();
      expect(controller.getSnapshot().view).toBe(snapshot.view);
    } finally {
      controller.dispose();
    }
    expect(b.streams[0]!.close).toHaveBeenCalledTimes(1);
    expect(b.close).toHaveBeenCalledTimes(1);
  });
  it("rebinds larger history at a fixed message and resets to the latest tail", async () => {
    const conn = connection();
    const controller = new PreviewController([host("a")], async () => conn.api);
    try {
      await ready(controller, ["a"]);
      controller.select("a", "collision");
      emit(conn.streams[0]!);
      controller.more();
      expect(conn.streams[1]?.query).toMatchObject({
        maxMessages: 40,
        anchorMessageId: fixture.view.messages.at(-1)?.id,
      });
      expect(conn.streams[1]?.id).not.toBe(conn.streams[0]?.id);
      controller.latest();
      expect(conn.streams[2]?.query.anchorMessageId).toBeNull();
      emit(conn.streams[1]!);
      expect(controller.getSnapshot().conversationStatus).toBe("loading");
      emit(conn.streams[2]!);
      expect(controller.getSnapshot().conversationStatus).toBe("ready");
    } finally {
      controller.dispose();
    }
  });
  it("retains a visibly stale snapshot after disconnect and reconnects with a fresh binding", async () => {
    const conn = connection();
    let disconnected = () => {};
    const controller = new PreviewController(
      [host("a")],
      async (_h, _signal, fail) => {
        disconnected = fail;
        return conn.api;
      },
    );
    try {
      await ready(controller, ["a"]);
      controller.select("a", "collision");
      emit(conn.streams[0]!);
      const view = controller.getSnapshot().view;
      disconnected();
      expect(controller.getSnapshot()).toMatchObject({
        view,
        conversationStatus: "offline",
      });
      await ready(controller, ["a"]);
      emit(conn.streams[1]!);
      expect(controller.getSnapshot().conversationStatus).toBe("ready");
      expect(conn.streams[1]?.id).not.toBe(conn.streams[0]?.id);
    } finally {
      controller.dispose();
    }
  });
  it.each([false, true])(
    "reads bounded saved issue links only when enabled=%s",
    async (enabled) => {
      const conn = connection({ ...supported, capabilityBits: [[2, 48]] });
      conn.fetch.mockImplementation(async (path) => {
        if (path === "/version")
          return { ...supported, capabilityBits: [[2, 48]] };
        if (path === "/issues/settings") return { settings: { enabled } };
        if (path.startsWith("/issues?"))
          return {
            items: [
              {
                id: "https://github.com/test/repo/issues/1",
                key: "test/repo#1",
              },
            ],
          };
        return {
          sessions: [
            {
              id: "collision",
              title: "Session",
              projectId: "project",
              projectName: "Project",
            },
          ],
          hasMore: false,
        };
      });
      const controller = new PreviewController(
        [host("a")],
        async () => conn.api,
      );
      try {
        await ready(controller, ["a"]);
        await vi.waitFor(() =>
          expect(controller.getSnapshot().sources[0]?.issueCoverage).toBe(
            enabled ? "partial" : "disabled",
          ),
        );
        if (enabled)
          await vi.waitFor(() =>
            expect(
              controller.getSnapshot().sources[0]?.sessions[0]?.issues,
            ).toHaveLength(1),
          );
        expect(conn.fetch.mock.calls.map(([path]) => path)).toEqual([
          "/version",
          "/sessions?limit=50",
          "/issues/settings",
          ...(enabled ? ["/issues?sessionId=collision&limit=10"] : []),
        ]);
        expect(conn.subscribeConversation).not.toHaveBeenCalled();
      } finally {
        controller.dispose();
      }
    },
  );
  it("identifies expired authentication without redirecting healthy peers", async () => {
    const peer = connection();
    const controller = new PreviewController(
      [host("expired"), host("peer")],
      async (h) => {
        if (h.id === "expired") throw new Error("Session invalid: expired");
        return peer.api;
      },
    );
    try {
      controller.include("expired", true);
      await ready(controller, ["peer"]);
      expect(controller.getSnapshot().sources[0]?.status).toBe(
        "sign-in-required",
      );
      controller.select("peer", "collision");
      emit(peer.streams[0]!);
      expect(controller.getSnapshot().conversationStatus).toBe("ready");
    } finally {
      controller.dispose();
    }
  });
  it("closes a connection that finishes authentication after disposal", async () => {
    const conn = connection();
    let resolve!: (c: PreviewConnection) => void;
    let signal: AbortSignal | undefined;
    const controller = new PreviewController([host("a")], async (_h, s) => {
      signal = s;
      return new Promise((r) => {
        resolve = r;
      });
    });
    controller.include("a", true);
    controller.dispose();
    expect(signal?.aborted).toBe(true);
    resolve(conn.api);
    await vi.waitFor(() => expect(conn.close).toHaveBeenCalledTimes(1));
    expect(conn.fetch).not.toHaveBeenCalled();
  });
  it("stops malformed known content but preserves unknown content as a fallback", async () => {
    const conn = connection();
    const controller = new PreviewController([host("a")], async () => conn.api);
    try {
      await ready(controller, ["a"]);
      controller.select("a", "collision");
      const stream = conn.streams[0]!;
      const payload = {
        ...fixture,
        subscriptionId: stream.id,
        view: {
          ...fixture.view,
          sessionId: "collision",
          pendingRequests: [{ kind: "future", secret: "opaque" }],
        },
      };
      stream.handlers.onEvent("snapshot", undefined, payload);
      expect(controller.getSnapshot().view).toMatchObject({
        pendingRequests: [{ kind: "unknown", originalKind: "future" }],
      });
      stream.handlers.onEvent("snapshot", undefined, {
        ...payload,
        sequence: 1,
        view: { ...payload.view, messages: "invalid" },
      });
      expect(controller.getSnapshot().conversationStatus).toBe("invalid");
      expect(stream.close).toHaveBeenCalledTimes(1);
    } finally {
      controller.dispose();
    }
  });
});
