import type { SessionRewindRecord } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import { collectVisibleClaudeEntries } from "../../src/sessions/claude-messages.js";

// Fixture rows are intentionally partial. The collector reads uuid,
// parentUuid, type/subtype, line order, and a small number of compaction flags.
// biome-ignore lint/suspicious/noExplicitAny: loose fixture rows by design
type RawSessionMessage = any;

describe("collectVisibleClaudeEntries", () => {
  it("keeps metadata-only compact boundaries on the active transcript", () => {
    const messages: RawSessionMessage[] = [
      { type: "user", uuid: "root", parentUuid: null },
      { type: "assistant", uuid: "tail", parentUuid: "root" },
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "compact",
        parentUuid: null,
        content: "Conversation compacted",
        compactMetadata: {
          trigger: "manual",
          preTokens: 345417,
          preservedSegment: { tailUuid: "tail" },
        },
      },
      {
        type: "user",
        uuid: "summary",
        parentUuid: "compact",
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        message: { content: "Summary of previous context" },
      },
      {
        type: "user",
        uuid: "caveat",
        parentUuid: "tail",
        isMeta: true,
        message: {
          content: "<local-command-caveat>Caveat</local-command-caveat>",
        },
      },
      {
        type: "user",
        uuid: "command",
        parentUuid: "caveat",
        message: {
          content:
            "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>",
        },
      },
      { type: "assistant", uuid: "reply", parentUuid: "command" },
    ];

    const { entries } = collectVisibleClaudeEntries(messages);

    expect(
      entries.map((entry) => ("uuid" in entry ? entry.uuid : undefined)),
    ).toEqual([
      "root",
      "tail",
      "compact",
      "summary",
      "caveat",
      "command",
      "reply",
    ]);
  });
});

describe("collectVisibleClaudeEntries with rewind records", () => {
  const messages: RawSessionMessage[] = [
    {
      type: "user",
      uuid: "u1",
      parentUuid: null,
      timestamp: "2026-09-18T10:00:00.000Z",
    },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      timestamp: "2026-09-18T10:00:05.000Z",
    },
    {
      type: "user",
      uuid: "u2",
      parentUuid: "a1",
      timestamp: "2026-09-18T10:01:00.000Z",
    },
    {
      type: "assistant",
      uuid: "a2",
      parentUuid: "u2",
      timestamp: "2026-09-18T10:01:05.000Z",
    },
  ];
  const record = {
    id: "rw-1",
    at: "2026-09-18T10:02:00.000Z",
    cutMessageId: "a1",
    cutTurnIndex: 1,
    droppedFromMessageId: "u2",
    droppedTurnCount: 1,
    reason: "clear" as const,
  };

  it("keeps the cut as the tail and groups the dropped rows after it", () => {
    const { entries } = collectVisibleClaudeEntries(messages, {
      rewindRecords: [record],
    });
    const uuids = entries.map((entry) => (entry as { uuid?: string }).uuid);
    expect(uuids).toEqual(["u1", "a1", "rewound-group-rw-1", "u2", "a2"]);
    const grouped = entries.filter(
      (entry) =>
        (entry as { rewoundGroupId?: string }).rewoundGroupId === "rw-1",
    );
    expect(grouped.map((entry) => (entry as { uuid?: string }).uuid)).toEqual([
      "rewound-group-rw-1",
      "u2",
      "a2",
    ]);
    const header = entries[2] as {
      subtype?: string;
      rewoundGroup?: { droppedTurnCount: number; cutTurnIndex: number };
    };
    expect(header.subtype).toBe("rewound_group");
    expect(header.rewoundGroup).toMatchObject({
      droppedTurnCount: 1,
      cutTurnIndex: 1,
    });
  });

  it("treats rows written after the rewind as the live continuation", () => {
    const continued: RawSessionMessage[] = [
      ...messages,
      {
        type: "user",
        uuid: "u3",
        parentUuid: "a1",
        timestamp: "2026-09-18T10:03:00.000Z",
      },
      {
        type: "assistant",
        uuid: "a3",
        parentUuid: "u3",
        timestamp: "2026-09-18T10:03:05.000Z",
      },
    ];
    const { entries } = collectVisibleClaudeEntries(continued, {
      rewindRecords: [record],
    });
    const uuids = entries.map((entry) => (entry as { uuid?: string }).uuid);
    expect(uuids).toEqual([
      "u1",
      "a1",
      "rewound-group-rw-1",
      "u2",
      "a2",
      "u3",
      "a3",
    ]);
    const live = entries.filter(
      (entry) => !(entry as { rewoundGroupId?: string }).rewoundGroupId,
    );
    expect(live.map((entry) => (entry as { uuid?: string }).uuid)).toEqual([
      "u1",
      "a1",
      "u3",
      "a3",
    ]);
  });

  it("keeps a continuation stamped behind the server's clock live", () => {
    // A transcript writer whose clock runs behind YA's (a remote executor)
    // stamps the turn after the rewind earlier than the record's `at`.
    const skewed: RawSessionMessage[] = [
      ...messages,
      {
        type: "user",
        uuid: "u3",
        parentUuid: "a1",
        timestamp: "2026-09-18T10:01:30.000Z",
      },
      {
        type: "assistant",
        uuid: "a3",
        parentUuid: "u3",
        timestamp: "2026-09-18T10:01:35.000Z",
      },
    ];
    const liveUuids = (records: SessionRewindRecord[]) =>
      collectVisibleClaudeEntries(skewed, { rewindRecords: records })
        .entries.filter(
          (entry) => !(entry as { rewoundGroupId?: string }).rewoundGroupId,
        )
        .map((entry) => (entry as { uuid?: string }).uuid);

    expect(liveUuids([{ ...record, droppedThroughMessageId: "a2" }])).toEqual([
      "u1",
      "a1",
      "u3",
      "a3",
    ]);
    // A record from before the bound existed still compares timestamps, so
    // the skewed continuation is claimed with it.
    expect(liveUuids([record])).toEqual(["u1", "a1"]);
  });

  it("nests an earlier group inside a clear whose cut precedes it", () => {
    const rows: RawSessionMessage[] = [
      ...messages,
      {
        type: "user",
        uuid: "u3",
        parentUuid: "a2",
        timestamp: "2026-09-18T10:02:00.000Z",
      },
      {
        type: "assistant",
        uuid: "a3",
        parentUuid: "u3",
        timestamp: "2026-09-18T10:02:05.000Z",
      },
      // Continuation of the first rewind, which kept a2.
      {
        type: "user",
        uuid: "u4",
        parentUuid: "a2",
        timestamp: "2026-09-18T10:03:00.000Z",
      },
      {
        type: "assistant",
        uuid: "a4",
        parentUuid: "u4",
        timestamp: "2026-09-18T10:03:05.000Z",
      },
      // Continuation of the second rewind, which kept a1, stamped by a clock
      // behind the server's.
      {
        type: "user",
        uuid: "u5",
        parentUuid: "a1",
        timestamp: "2026-09-18T10:03:30.000Z",
      },
      {
        type: "assistant",
        uuid: "a5",
        parentUuid: "u5",
        timestamp: "2026-09-18T10:03:35.000Z",
      },
    ];
    const inner = {
      ...record,
      id: "rw-inner",
      at: "2026-09-18T10:02:30.000Z",
      cutMessageId: "a2",
      cutTurnIndex: 2,
      droppedFromMessageId: "u3",
      droppedThroughMessageId: "a3",
    };
    const outer = {
      ...record,
      id: "rw-outer",
      at: "2026-09-18T10:04:00.000Z",
      droppedThroughMessageId: "a4",
    };
    const { entries } = collectVisibleClaudeEntries(rows, {
      rewindRecords: [outer, inner],
    });
    const rendered = entries.map((entry) => {
      const row = entry as {
        uuid?: string;
        rewoundGroupId?: string;
        rewoundParentGroupId?: string;
      };
      return [row.uuid, row.rewoundGroupId, row.rewoundParentGroupId];
    });
    expect(rendered).toEqual([
      ["u1", undefined, undefined],
      ["a1", undefined, undefined],
      ["rewound-group-rw-outer", "rw-outer", undefined],
      ["u2", "rw-outer", undefined],
      ["a2", "rw-outer", undefined],
      ["rewound-group-rw-inner", "rw-inner", "rw-outer"],
      ["u3", "rw-inner", "rw-outer"],
      ["a3", "rw-inner", "rw-outer"],
      ["u4", "rw-outer", undefined],
      ["a4", "rw-outer", undefined],
      ["u5", undefined, undefined],
      ["a5", undefined, undefined],
    ]);
  });

  it("changes nothing without records", () => {
    const { entries } = collectVisibleClaudeEntries(messages);
    expect(entries.map((entry) => (entry as { uuid?: string }).uuid)).toEqual([
      "u1",
      "a1",
      "u2",
      "a2",
    ]);
  });

  it("groups a queued message delivered inside the cleared span", () => {
    const withQueued: RawSessionMessage[] = [
      messages[0],
      messages[1],
      {
        type: "queue-operation",
        operation: "enqueue",
        content: "keep going",
        timestamp: "2026-09-18T10:00:30.000Z",
      },
      {
        type: "queue-operation",
        operation: "remove",
        timestamp: "2026-09-18T10:00:40.000Z",
      },
      messages[2],
      messages[3],
    ];
    const { entries } = collectVisibleClaudeEntries(withQueued, {
      rewindRecords: [record],
    });
    const live = entries.filter(
      (entry) => !(entry as { rewoundGroupId?: string }).rewoundGroupId,
    );
    expect(live.map((entry) => (entry as { uuid?: string }).uuid)).toEqual([
      "u1",
      "a1",
    ]);
    const queued = entries.find(
      (entry) => (entry as { operation?: string }).operation === "enqueue",
    ) as { rewoundGroupId?: string; queueDeliveredAt?: string } | undefined;
    expect(queued?.rewoundGroupId).toBe("rw-1");
    expect(queued?.queueDeliveredAt).toBe("2026-09-18T10:00:40.000Z");
  });

  it("keeps a live queued message live and in place", () => {
    const withQueued: RawSessionMessage[] = [
      messages[0],
      messages[1],
      messages[2],
      messages[3],
      {
        type: "user",
        uuid: "u3",
        parentUuid: "a1",
        timestamp: "2026-09-18T10:03:00.000Z",
      },
      {
        type: "queue-operation",
        operation: "enqueue",
        content: "live one",
        timestamp: "2026-09-18T10:03:10.000Z",
      },
      {
        type: "queue-operation",
        operation: "remove",
        timestamp: "2026-09-18T10:03:20.000Z",
      },
      {
        type: "assistant",
        uuid: "a3",
        parentUuid: "u3",
        timestamp: "2026-09-18T10:03:30.000Z",
      },
    ];
    const { entries } = collectVisibleClaudeEntries(withQueued, {
      rewindRecords: [record],
    });
    const labels = entries.map((entry) => {
      const row = entry as { uuid?: string; operation?: string };
      return row.uuid ?? `queued:${row.operation}`;
    });
    expect(labels).toEqual([
      "u1",
      "a1",
      "rewound-group-rw-1",
      "u2",
      "a2",
      "u3",
      "queued:enqueue",
      "a3",
    ]);
  });

  it("keeps a live queued message after a cleared span of any length", () => {
    const withQueued: RawSessionMessage[] = [
      messages[0],
      messages[1],
      messages[2],
      messages[3],
      {
        type: "user",
        uuid: "u2b",
        parentUuid: "a2",
        timestamp: "2026-09-18T10:01:10.000Z",
      },
      {
        type: "assistant",
        uuid: "a2b",
        parentUuid: "u2b",
        timestamp: "2026-09-18T10:01:15.000Z",
      },
      {
        type: "user",
        uuid: "u3",
        parentUuid: "a1",
        timestamp: "2026-09-18T10:03:00.000Z",
      },
      {
        type: "queue-operation",
        operation: "enqueue",
        content: "live one",
        timestamp: "2026-09-18T10:03:10.000Z",
      },
      {
        type: "queue-operation",
        operation: "remove",
        timestamp: "2026-09-18T10:03:20.000Z",
      },
      {
        type: "assistant",
        uuid: "a3",
        parentUuid: "u3",
        timestamp: "2026-09-18T10:03:30.000Z",
      },
    ];
    const { entries } = collectVisibleClaudeEntries(withQueued, {
      rewindRecords: [record],
    });
    const labels = entries.map((entry) => {
      const row = entry as { uuid?: string; operation?: string };
      return row.uuid ?? `queued:${row.operation}`;
    });
    expect(labels).toEqual([
      "u1",
      "a1",
      "rewound-group-rw-1",
      "u2",
      "a2",
      "u2b",
      "a2b",
      "u3",
      "queued:enqueue",
      "a3",
    ]);
  });

  it("makes repeated rewinds to one live cut siblings, in order", () => {
    const looped: RawSessionMessage[] = [
      messages[0],
      messages[1],
      messages[2],
      messages[3],
      {
        type: "user",
        uuid: "u3",
        parentUuid: "a1",
        timestamp: "2026-09-18T10:03:00.000Z",
      },
      {
        type: "assistant",
        uuid: "a3",
        parentUuid: "u3",
        timestamp: "2026-09-18T10:03:05.000Z",
      },
    ];
    const second = {
      ...record,
      id: "rw-2",
      at: "2026-09-18T10:04:00.000Z",
      droppedFromMessageId: "u3",
    };
    const { entries } = collectVisibleClaudeEntries(looped, {
      rewindRecords: [record, second],
    });
    expect(entries.map((entry) => (entry as { uuid?: string }).uuid)).toEqual([
      "u1",
      "a1",
      "rewound-group-rw-1",
      "u2",
      "a2",
      "rewound-group-rw-2",
      "u3",
      "a3",
    ]);
    // Both cuts are the same live row, so neither group encloses the other.
    expect(
      entries.some(
        (entry) =>
          (entry as { rewoundParentGroupId?: string }).rewoundParentGroupId,
      ),
    ).toBe(false);
  });
});
