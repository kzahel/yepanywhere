import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ContentSchema,
  ConversationQuerySchema,
  decodeSnapshot,
  MAX_SNAPSHOT_BYTES,
  type Conversation,
  type SourceOverview,
} from "../src/experimental/simple-client.generated.js";

function read(name: string): string {
  return readFileSync(
    new URL(`./fixtures/simple-client/${name}`, import.meta.url),
    "utf8",
  );
}
const examples: Array<{
  file: string;
  kind: string;
  messageCount?: number;
  sourceKey: string;
}> = JSON.parse(read("examples.json"));
const invalid: Array<{ name: string; payload: unknown }> = JSON.parse(
  read("invalid-snapshots.json"),
);

describe("experimental simple-client generated contract", () => {
  it.each(examples)("decodes $file", ({ file, kind, messageCount }) => {
    const snapshot = decodeSnapshot(read(file));
    expect(snapshot.view.kind).toBe(kind);
    if (snapshot.view.kind === "conversation") {
      expect(snapshot.view.messages).toHaveLength(messageCount!);
      expect(snapshot.view.coverage.returnedMessages).toBe(messageCount);
      expect(snapshot.view.messages.length).toBeLessThanOrEqual(
        snapshot.view.coverage.maxMessages,
      );
      expect(
        new Set(snapshot.view.messages.map((message) => message.id)).size,
      ).toBe(messageCount);
    }
  });

  it.each(invalid)("rejects $name", ({ payload }) => {
    expect(() => decodeSnapshot(JSON.stringify(payload))).toThrow();
  });

  it("preserves unknown content and pending requests without making them actionable", () => {
    const view = decodeSnapshot(read("waiting-history.json"))
      .view as Conversation;
    expect(view.messages[0]?.content[1]).toEqual({
      kind: "unknown",
      originalKind: "future-diagram",
      raw: {
        kind: "future-diagram",
        version: 2,
        payload: { nodes: ["one"], enabled: true },
      },
    });
    expect(view.pendingRequests[1]).toMatchObject({
      kind: "unknown",
      originalKind: "future-approval",
      raw: { canApprove: true },
    });
    expect(view.pendingRequests[1]).not.toHaveProperty("canApprove");
    expect(view.pendingRequests[0]).toMatchObject({
      kind: "question",
      canAnswer: false,
    });
  });

  it("keeps disabled issue coverage and source-local collisions explicit", () => {
    const a = decodeSnapshot(read("overview-disabled.json"))
      .view as SourceOverview;
    const b = decodeSnapshot(read("overview-peer.json")).view as SourceOverview;
    expect(a.sessions[0]?.issueCoverage).toBe("disabled");
    expect(a.sessions[0]?.issues).toEqual([]);
    expect(a.sessions[0]?.id).toBe(b.sessions[0]?.id);
    const sourceA = examples.find(
      (e) => e.file === "overview-disabled.json",
    )!.sourceKey;
    const sourceB = examples.find(
      (e) => e.file === "overview-peer.json",
    )!.sourceKey;
    expect([sourceA, a.sessions[0]?.id]).not.toEqual([
      sourceB,
      b.sessions[0]?.id,
    ]);
    const issues = b.sessions[0]!.issues;
    expect(issues[0]?.key).toBe(issues[1]?.key);
    expect(issues[0]?.id).not.toBe(issues[1]?.id);
  });

  it("counts messages after grouping; a complete tail need not be complete history", () => {
    const full = decodeSnapshot(read("claude-conversation.json"))
      .view as Conversation;
    const tail = decodeSnapshot(read("claude-tail.json")).view as Conversation;
    expect(tail.messages).toEqual(full.messages.slice(-2));
    expect(tail.coverage).toMatchObject({
      compactions: 2,
      maxMessages: 2,
      earlierInScope: true,
      completeForRequest: true,
      limitedBy: ["maxMessages"],
    });
    const activity = full.messages[1]!.content.find(
      (c) => c.kind === "activity",
    );
    expect(activity).toMatchObject({ toolCount: 4, failedToolCount: 1 });
  });

  it("ignores additive known fields but keeps unknown raw objects independent", () => {
    const known = ContentSchema.parse({
      kind: "text",
      format: "plain",
      text: "hello",
      future: true,
    });
    expect(known).not.toHaveProperty("future");
    const input = { kind: "future", payload: { value: 1 } };
    const unknown = ContentSchema.parse(input);
    input.payload.value = 2;
    expect(unknown).toMatchObject({ raw: { payload: { value: 1 } } });
    expect(
      ContentSchema.parse({ kind: "__proto__", payload: null }),
    ).toMatchObject({ kind: "unknown", originalKind: "__proto__" });
  });

  it("uses Unicode code points for known text and unknown discriminator bounds", () => {
    expect(
      ContentSchema.parse({
        kind: "text",
        format: "plain",
        text: "👋".repeat(16000),
      }).kind,
    ).toBe("text");
    expect(() =>
      ContentSchema.parse({
        kind: "text",
        format: "plain",
        text: "👋".repeat(16001),
      }),
    ).toThrow();
    expect(ContentSchema.parse({ kind: "👋".repeat(128) }).kind).toBe(
      "unknown",
    );
    expect(() => ContentSchema.parse({ kind: "👋".repeat(129) })).toThrow();
  });

  it("bounds encoded bytes even for unknown content", () => {
    const base = JSON.parse(read("unknown-view.json"));
    base.view.payload = "";
    const padding =
      MAX_SNAPSHOT_BYTES - Buffer.byteLength(JSON.stringify(base));
    base.view.payload = "x".repeat(padding);
    expect(decodeSnapshot(JSON.stringify(base)).view.kind).toBe("unknown");
    base.view.payload += "👋";
    expect(() => decodeSnapshot(JSON.stringify(base))).toThrow("byte limit");
  });

  it("requires explicit bounded history queries and nullable anchors", () => {
    expect(
      ConversationQuerySchema.parse({
        sessionId: "s",
        maxMessages: 20,
        anchorMessageId: null,
      }),
    ).toMatchObject({ maxMessages: 20 });
    for (const maxMessages of [0, 101, 1.5]) {
      expect(() =>
        ConversationQuerySchema.parse({
          sessionId: "s",
          maxMessages,
          anchorMessageId: null,
        }),
      ).toThrow();
    }
  });
});
