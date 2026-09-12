import { describe, expect, it, vi } from "vitest";
import * as compiler from "@yep-anywhere/shared/transcript/compiler";
import {
  decodeSnapshot,
  MAX_SNAPSHOT_BYTES,
  type Conversation,
  type ConversationQuery,
} from "@yep-anywhere/shared/experimental/simple-client.generated";
import type { Message } from "@yep-anywhere/shared/transcript/message";
import {
  prepareConversation,
  selectConversation,
  serializeConversationSnapshot,
  MAX_PROJECTION_RECORDS,
  type ConversationInput,
} from "../src/experimental/conversation-projection.js";

const user = (id: string, content = id): Message => ({
  type: "user",
  uuid: id,
  content,
});
const agent = (
  id: string,
  content = id,
  fields: Partial<Message> = {},
): Message => ({
  type: "assistant",
  uuid: id,
  content: [{ type: "text", text: content }],
  ...fields,
});
const system = (id: string, subtype: string): Message => ({
  type: "system",
  uuid: id,
  subtype,
  content: subtype,
});
const call = (id: string, result?: string, failed = false): Message[] => [
  {
    type: "assistant",
    uuid: `source:${id}`,
    content: [{ type: "tool_use", id, name: "Bash", input: {} }],
  },
  ...(result === undefined
    ? []
    : [
        {
          type: "user",
          uuid: `result:${id}`,
          content: [
            {
              type: "tool_result",
              tool_use_id: id,
              content: result,
              is_error: failed,
            },
          ],
          toolUseResult: { exitCode: failed ? 7 : 0 },
        },
      ]),
];
function input(
  messages: Message[],
  extra: Partial<ConversationInput> = {},
): ConversationInput {
  return {
    sessionId: "session",
    messages,
    activity: "idle",
    pendingRequests: [],
    sourceCoverage: { complete: true, earlierOutsideScope: "no" },
    ...extra,
  };
}
const binding = { subscriptionId: "subscription", sequence: 0 };
const query: ConversationQuery = {
  sessionId: "session",
  maxMessages: 20,
  anchorMessageId: null,
};
function snapshot(
  messages: Message[],
  options: Partial<ConversationInput> = {},
  request: Partial<ConversationQuery> = {},
) {
  return selectConversation(
    prepareConversation(input(messages, options)),
    { ...query, ...request },
    binding,
  );
}
function view(
  messages: Message[],
  options: Partial<ConversationInput> = {},
  request: Partial<ConversationQuery> = {},
): Conversation {
  const result = snapshot(messages, options, request).view;
  if (result.kind !== "conversation") throw new Error(JSON.stringify(result));
  return result;
}

// Boundary cases are intentionally synthetic; the real capture test separately
// checks production reader/adapter input. No provider process or browser runs.
describe("server-owned condensed conversation projection", () => {
  it("groups activity and prose while keeping an early failure in place", () => {
    const result = view([
      user("u"),
      agent("a", "Before"),
      ...call("bad", "failure", true),
      ...call("ok", "success"),
      agent("z", "After"),
    ]);
    expect(result.messages.map((m) => [m.id, m.role])).toEqual([
      ["u", "user"],
      ["agent:u", "agent"],
    ]);
    expect(result.messages[1]!.content.map((c) => c.kind)).toEqual([
      "text",
      "activity",
      "failure",
      "activity",
      "text",
    ]);
    expect(result.messages[1]!.content[2]).toMatchObject({
      message: "failure",
      exitCode: 7,
    });
    expect(result.coverage.completeForRequest).toBe(true);
  });

  it("keeps the response ID through waiting, streaming, finalization and replay", () => {
    const empty = view([user("u")], { activity: "working" });
    const growing = view(
      [user("u"), agent("live-id", "Part", { _isStreaming: true })],
      { activity: "working" },
    );
    const final = view([user("u"), agent("durable-id", "Part complete")]);
    expect([empty, growing, final].map((v) => v.messages[1]!.id)).toEqual([
      "agent:u",
      "agent:u",
      "agent:u",
    ]);
    expect([empty, growing, final].map((v) => v.messages[1]!.state)).toEqual([
      "growing",
      "growing",
      "complete",
    ]);
    expect(view([user("u"), agent("durable-id", "Part complete")])).toEqual(
      final,
    );
  });

  it("keeps interruption explicit and lets a later retry resume the same response", () => {
    const stopped = [
      user("u"),
      agent("a", "Half", { isAbortedMidStream: true }),
      system("stop", "turn_aborted"),
    ];
    expect(view(stopped).messages[1]!.state).toBe("interrupted");
    const resumed = view(
      [...stopped, agent("b", "Continuing", { _isStreaming: true })],
      { activity: "working" },
    );
    expect(resumed.messages[1]).toMatchObject({
      id: "agent:u",
      state: "growing",
    });
    expect(resumed.messages[1]!.content.some((c) => c.kind === "failure")).toBe(
      true,
    );
    const steered = view([
      user("u"),
      agent("a", "Half", { _isStreaming: true }),
      user("v"),
      agent("b", "New answer"),
    ]);
    expect(steered.messages[1]!.state).toBe("interrupted");
    expect(steered.messages[3]!.id).toBe("agent:v");
  });

  it("respects durable completion even while coarse session activity lags", () => {
    const result = view(
      [user("u"), agent("a"), system("done", "turn_complete")],
      { activity: "working" },
    );
    expect(result.messages[1]!.state).toBe("complete");
    expect(result.activity).toBe("working");
  });

  it("applies the existing two-compaction scope before message count", () => {
    const messages = [
      user("outside", "SECRET OLD TEXT"),
      agent("old"),
      system("c0", "compact_boundary"),
      user("u"),
      agent("before", "ALSO OLD"),
      system("c1", "compact_boundary"),
      agent("after"),
      system("c2", "compact_boundary"),
      agent("last"),
      user("v"),
      agent("answer"),
    ];
    const result = view(messages, {}, { maxMessages: 100 });
    expect(result.messages.map((m) => m.id)).toEqual([
      "agent:u",
      "v",
      "agent:v",
    ]);
    expect(result.messages[0]!.truncated).toBe(true);
    expect(result.coverage).toMatchObject({
      compactions: 2,
      earlierOutsideScope: "yes",
      completeForRequest: false,
      limitedBy: ["compactionScope"],
    });
    expect(JSON.stringify(result)).not.toMatch(/SECRET OLD TEXT|ALSO OLD/);
    expect(
      snapshot(messages, {}, { anchorMessageId: "outside", maxMessages: 100 })
        .view,
    ).toMatchObject({ kind: "error", code: "anchorUnavailable" });
  });

  it("counts complete messages, not calls, and keeps a fixed reading anchor", () => {
    const before = [
      user("u"),
      ...call("t", "ok"),
      agent("a"),
      user("v"),
      agent("b"),
    ];
    const result = view(before, {}, { maxMessages: 2 });
    expect(result.messages.map((m) => m.id)).toEqual(["v", "agent:v"]);
    expect(result.coverage).toMatchObject({
      earlierInScope: true,
      completeForRequest: true,
      limitedBy: ["maxMessages"],
    });
    const pinned = view(
      [...before, user("w"), agent("c")],
      {},
      { maxMessages: 3, anchorMessageId: "agent:v" },
    );
    expect(pinned.messages.map((m) => m.id)).toEqual([
      "agent:u",
      "v",
      "agent:v",
    ]);
  });

  it("keeps current pending input outside an anchored historical window", () => {
    const result = view(
      [user("u"), agent("a"), user("v"), agent("b")],
      {
        activity: "waiting",
        pendingRequests: [
          {
            kind: "question",
            id: "q",
            prompt: "Which?",
            options: ["one"],
            canAnswer: false,
          },
        ],
      },
      { maxMessages: 1, anchorMessageId: "u" },
    );
    expect(result.messages.map((m) => m.id)).toEqual(["u"]);
    expect(result.pendingRequests[0]).toMatchObject({
      id: "q",
      canAnswer: false,
    });
    expect(result.activity).toBe("waiting");
  });

  it("shares one prepared result between independent windows without mutation", () => {
    const prepared = prepareConversation(
      input([user("u"), agent("a"), user("v"), agent("b")]),
    );
    if (prepared.kind !== "prepared")
      throw new Error("Expected prepared result");
    const copy = structuredClone(prepared);
    selectConversation(prepared, { ...query, maxMessages: 1 }, binding);
    selectConversation(
      prepared,
      { ...query, anchorMessageId: "agent:u" },
      { ...binding, sequence: 1 },
    );
    expect(prepared).toEqual(copy);
  });

  it("uses a deterministic incomplete identity when only an orphan response exists", () => {
    const result = view([agent("orphan", "Partial")], {
      sourceCoverage: { complete: false, earlierOutsideScope: "unknown" },
    });
    expect(result.messages[0]).toMatchObject({
      id: "orphan:orphan",
      truncated: true,
    });
    expect(result.coverage).toMatchObject({
      earlierOutsideScope: "unknown",
      completeForRequest: false,
    });
    expect(result.coverage.limitedBy).toContain("unavailable");
  });

  it("does not turn a missing tool result into a completed successful reply", () => {
    const result = view([
      user("u"),
      ...call("missing"),
      system("done", "turn_complete"),
    ]);
    expect(result.messages[1]!.content.some((c) => c.kind === "failure")).toBe(
      true,
    );
    expect(result.coverage).toMatchObject({
      completeForRequest: false,
      limitedBy: ["unavailable"],
    });
    const live = view([user("u"), ...call("missing")], { activity: "working" });
    expect(live.messages[1]!.state).toBe("growing");
    expect(live.coverage.completeForRequest).toBe(true);
  });

  it("exposes a result whose invocation was outside scope without a warning storm", () => {
    const warning = vi.spyOn(console, "warn");
    try {
      const result = view([user("u"), call("missing", "result")[1]!]);
      expect(result.coverage.completeForRequest).toBe(false);
      expect(result.messages[1]!.content[0]).toMatchObject({
        kind: "unknown",
        originalKind: "unsupported-content",
      });
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it("preserves unknown assistant content order without forwarding provider payloads", () => {
    const result = snapshot([
      user("u"),
      agent("a", "", {
        content: [
          { type: "text", text: "before" },
          { type: "future", secret: "RAW PROVIDER MATERIAL" },
          { type: "text", text: "after" },
        ],
      }),
    ]);
    const encoded = serializeConversationSnapshot(result);
    expect(encoded).not.toContain("RAW PROVIDER MATERIAL");
    const decoded = decodeSnapshot(encoded).view as Conversation;
    expect(decoded.messages[1]!.content.map((c) => c.kind)).toEqual([
      "text",
      "unknown",
      "text",
    ]);
    expect(decoded.messages[1]!.content[1]).toMatchObject({
      originalKind: "unsupported-content",
      raw: { sourceType: "future" },
    });
    expect(decoded.coverage.completeForRequest).toBe(false);
  });

  it("makes malformed text visible as unavailable instead of silently dropping it", () => {
    const result = view([
      user("u"),
      agent("a", "", { content: [{ type: "text" }] }),
    ]);
    expect(result.messages[1]!.content[0]).toMatchObject({ kind: "unknown" });
    expect(result.coverage.completeForRequest).toBe(false);
  });

  it("represents inline media without sending base64 or provider file paths", () => {
    const result = snapshot([
      {
        ...user("u"),
        content: [
          {
            type: "image",
            source: { data: "BASE64_DATA", file_path: "/private/file" },
          },
        ],
      },
      agent("a"),
    ]);
    expect(serializeConversationSnapshot(result)).not.toMatch(
      /BASE64_DATA|private\/file/,
    );
    expect((result.view as Conversation).messages[0]!.content[0]).toMatchObject(
      { kind: "media", availability: "unavailable" },
    );
  });

  it("truncates a giant Unicode block at code-point boundaries", () => {
    const result = view([user("u"), agent("a", "👋".repeat(16001))]);
    const text = result.messages[1]!.content[0];
    if (text?.kind !== "text") throw new Error("Expected text");
    expect(Array.from(text.text)).toHaveLength(16000);
    expect(result.coverage).toMatchObject({
      completeForRequest: false,
      limitedBy: ["bytes"],
    });
  });

  it("caps snapshot bytes by dropping older rows while retaining the anchor", () => {
    const messages = Array.from({ length: 30 }, (_, i) => [
      user(`u${i}`),
      agent(`a${i}`, "👋".repeat(15000)),
    ]).flat();
    const result = snapshot(messages, {}, { maxMessages: 100 });
    expect(
      Buffer.byteLength(serializeConversationSnapshot(result)),
    ).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
    expect((result.view as Conversation).messages.at(-1)!.id).toBe("agent:u29");
    expect((result.view as Conversation).coverage).toMatchObject({
      completeForRequest: false,
      earlierInScope: true,
    });
  });

  it("reports truncation of long agent failures as incomplete coverage", () => {
    const result = view([
      user("u"),
      { type: "error", uuid: "failure", error: "x".repeat(2049) },
    ]);
    expect(result.messages[1]).toMatchObject({
      state: "interrupted",
      truncated: true,
      content: [{ kind: "failure", message: "x".repeat(2048) }],
    });
    expect(result.coverage).toMatchObject({
      completeForRequest: false,
      limitedBy: ["bytes"],
    });
  });

  it("retains an explicit failure notice when one giant message cannot fit", () => {
    const content = Array.from({ length: 80 }, () => ({
      type: "text",
      text: "x".repeat(16000),
    }));
    const result = snapshot(
      [
        user("u"),
        agent("huge", "", { content }),
        ...call("bad", "late failure", true),
      ],
      {},
      { maxMessages: 1 },
    );
    const conversation = result.view as Conversation;
    expect(
      Buffer.byteLength(serializeConversationSnapshot(result)),
    ).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
    expect(conversation.messages[0]).toMatchObject({
      id: "agent:u",
      truncated: true,
    });
    expect(conversation.messages[0]!.content).toEqual([
      {
        kind: "failure",
        toolName: "Transcript",
        message:
          "Message content, including failures, omitted by the payload limit",
        exitCode: null,
      },
    ]);
  });

  it("rejects absent, duplicate and colliding visible identities", () => {
    for (const messages of [
      [{ type: "assistant", content: "no ID" }],
      [user("same"), agent("same")],
      [user("x"), agent("a"), user("agent:x")],
    ])
      expect(snapshot(messages).view).toMatchObject({
        kind: "error",
        code: "unavailable",
      });
  });

  it("bounds long derived identities without losing determinism", () => {
    const id = "👋".repeat(256);
    const result = view([user(id), agent("a")]);
    expect(result.messages[1]!.id).toMatch(/^agent:sha256:/);
    expect(view([user(id), agent("b")]).messages[1]!.id).toBe(
      result.messages[1]!.id,
    );
  });

  it("rejects invalid queries and preserves unknown pending request wire shapes", () => {
    expect(snapshot([user("u")], {}, { maxMessages: 101 }).view).toMatchObject({
      code: "invalidRequest",
    });
    expect(
      snapshot([user("u")], {}, { sessionId: "other" }).view,
    ).toMatchObject({ code: "notFound" });
    const result = snapshot([user("u")], {
      pendingRequests: [
        {
          kind: "unknown",
          originalKind: "future-approval",
          raw: { kind: "future-approval", canApprove: true },
        },
      ],
    });
    const encoded = serializeConversationSnapshot(result);
    expect(encoded).not.toContain('"originalKind"');
    expect(
      (decodeSnapshot(encoded).view as Conversation).pendingRequests[0],
    ).toMatchObject({ kind: "unknown", originalKind: "future-approval" });
  });

  it("refuses oversized source acquisition or pending input rather than dropping requests", () => {
    expect(
      prepareConversation(
        input(
          Array.from({ length: MAX_PROJECTION_RECORDS + 1 }, (_, i) =>
            user(`${i}`),
          ),
        ),
      ),
    ).toMatchObject({ code: "unavailable" });
    expect(
      prepareConversation(
        input([user("u")], {
          pendingRequests: [
            {
              kind: "unknown",
              originalKind: "future",
              raw: { kind: "future", data: "x".repeat(40000) },
            },
          ],
        }),
      ),
    ).toMatchObject({ code: "unavailable" });
  });

  it("can preserve a leading response identity supplied by a bounded reader", () => {
    const all = [
      user("u"),
      agent("old"),
      system("c1", "compact_boundary"),
      agent("mid"),
      system("c2", "compact_boundary"),
      agent("last"),
    ];
    const full = view(all);
    const bounded = view(all.slice(2), {
      sourceCoverage: {
        complete: true,
        earlierOutsideScope: "yes",
        leadingUserMessageId: "u",
      },
    });
    expect(bounded.messages).toEqual(full.messages);
    expect(bounded.coverage).toEqual(full.coverage);
  });

  it("compiles once when ten consumers select windows from one prepared revision", () => {
    const compile = vi.spyOn(compiler, "compileTranscriptProjection");
    try {
      const prepared = prepareConversation(
        input([user("u"), agent("a"), user("v"), agent("b")]),
      );
      for (let i = 0; i < 10; i++)
        selectConversation(
          prepared,
          { ...query, maxMessages: 1 + i },
          { subscriptionId: `consumer-${i}`, sequence: 0 },
        );
      expect(compile).toHaveBeenCalledTimes(1);
    } finally {
      compile.mockRestore();
    }
  });

  it("does not invent timestamps from malformed or unavailable instants", () => {
    expect(
      view([
        { ...user("u"), timestamp: "2026-02-30T00:00:00.000Z" },
        agent("a"),
      ]).messages.map((m) => m.createdAt),
    ).toEqual([null, null]);
  });
});
