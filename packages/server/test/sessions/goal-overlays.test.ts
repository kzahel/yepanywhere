import type { DurableLocalCommandMessage } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import { mergeLocalCommandMessages } from "../../src/sessions/recap-overlays.js";
import type { Message } from "../../src/supervisor/types.js";

function goal(
  id: string,
  second: number,
  anchor?: string,
): DurableLocalCommandMessage {
  return {
    id,
    uuid: id,
    type: "system",
    subtype: "local_command",
    content: "/goal",
    details: ["Finish the work", "Goal set"],
    session_id: "session-1",
    isSynthetic: true,
    timestamp: `2026-09-05T00:00:${String(second).padStart(2, "0")}.000Z`,
    ...(anchor ? { placementAfterMessageId: anchor } : {}),
  };
}
function provider(id: string, second: number): Message {
  return {
    id,
    uuid: id,
    type: "assistant",
    timestamp: goal(id, second).timestamp,
    message: { role: "assistant", content: "Work" },
  };
}
function grouped(
  id: string,
  second: number,
  groupId: string,
  parentGroupId?: string,
): Message {
  return {
    ...provider(id, second),
    rewoundGroupId: groupId,
    ...(parentGroupId ? { rewoundParentGroupId: parentGroupId } : {}),
  };
}
/** A rewound-group header: the cut's time, the rewind's time in `at`. */
function header(
  groupId: string,
  cutSecond: number,
  atSecond: number,
  parentGroupId?: string,
): Message {
  const id = `rewound-group-${groupId}`;
  return {
    id,
    uuid: id,
    type: "system",
    subtype: "rewound_group",
    timestamp: goal(id, cutSecond).timestamp,
    rewoundGroupId: groupId,
    ...(parentGroupId ? { rewoundParentGroupId: parentGroupId } : {}),
    rewoundGroup: { at: goal(id, atSecond).timestamp },
  };
}
const ids = (messages: Message[]) => messages.map((message) => message.id);

describe("durable goal receipts", () => {
  it("keeps an in-turn receipt after the assistant even when its final timestamp is later", () => {
    const commands = [
      goal("set", 10, "assistant"),
      goal("clear", 11, "assistant"),
    ];
    const result = mergeLocalCommandMessages(
      [provider("assistant", 20), provider("next", 30)],
      commands,
    );
    expect(ids(result)).toEqual(["assistant", "set", "clear", "next"]);
    expect(mergeLocalCommandMessages(result, commands)).toEqual(result);
  });
  it("replaces Claude's persisted copy of the hidden /goal line with the receipt", () => {
    // Claude records the line YA sent as a command row after the anchor; a
    // reload showed it beside the receipt (the double echo).
    const commandRow = (id: string, second: number, args: string): Message => ({
      id,
      uuid: id,
      type: "user",
      timestamp: goal(id, second).timestamp,
      message: {
        role: "user",
        content: `<command-name>/goal</command-name>\n  <command-message>goal</command-message>\n  <command-args>${args}</command-args>`,
      },
    });
    const history = [
      provider("before", 1),
      commandRow("claude-goal", 2, "Finish the work"),
      provider("after", 3),
      commandRow("user-typed", 9, "Something else"),
    ];
    const tagged = {
      ...goal("receipt", 2, "before"),
      providerCommandText: "/goal Finish the work",
    };
    expect(ids(mergeLocalCommandMessages(history, [tagged]))).toEqual([
      "before",
      "receipt",
      "after",
      "user-typed",
    ]);
    // Receipts persisted before providerCommandText fall back to the objective.
    expect(
      ids(mergeLocalCommandMessages(history, [goal("legacy", 2, "before")])),
    ).toEqual(["before", "legacy", "after", "user-typed"]);
  });
  it("keeps old receipts out of a tail or incremental window", () => {
    const result = mergeLocalCommandMessages(
      [provider("tail", 20)],
      [goal("old", 10), goal("new", 21)],
      { hasOlderMessages: true },
    );
    expect(ids(result)).toEqual(["tail", "new"]);
  });
  it("includes receipts in older pages without leaking newer receipts", () => {
    const result = mergeLocalCommandMessages(
      [provider("first", 10), provider("last", 20)],
      [goal("old", 5), goal("inside", 15), goal("new", 25)],
      { hasOlderMessages: true, hasNewerMessages: true },
    );
    expect(ids(result)).toEqual(["first", "inside", "last"]);
  });
  it("shows a receipt with no provider history, but does not widen an empty bounded window", () => {
    expect(ids(mergeLocalCommandMessages([], [goal("set", 1)]))).toEqual([
      "set",
    ]);
    expect(
      mergeLocalCommandMessages([], [goal("set", 1)], {
        hasOlderMessages: true,
      }),
    ).toEqual([]);
  });
  it("puts a receipt written inside a cleared span into that group", () => {
    const result = mergeLocalCommandMessages(
      [
        provider("cut", 5),
        header("rw-1", 5, 40),
        grouped("dropped", 10, "rw-1"),
        grouped("more", 30, "rw-1"),
      ],
      [goal("notice", 20)],
    );
    expect(ids(result)).toEqual([
      "cut",
      "rewound-group-rw-1",
      "dropped",
      "notice",
      "more",
    ]);
    expect(result[3]?.rewoundGroupId).toBe("rw-1");
  });
  it("leaves a receipt written after the last rewind live at the group's tail", () => {
    // A clearloop's final notice, or a /goal receipt after /clear N with no
    // later turn: nothing follows it, and a reload must match the live view.
    const result = mergeLocalCommandMessages(
      [
        provider("cut", 5),
        header("rw-1", 5, 40),
        grouped("dropped", 10, "rw-1"),
        grouped("last", 30, "rw-1"),
      ],
      [goal("final-notice", 45)],
    );
    expect(ids(result).at(-1)).toBe("final-notice");
    expect(result.at(-1)?.rewoundGroupId).toBeUndefined();
  });
  it("leaves a receipt written after the rewind live before the next turn", () => {
    const result = mergeLocalCommandMessages(
      [
        provider("cut", 5),
        header("rw-1", 5, 40),
        grouped("dropped", 10, "rw-1"),
        provider("next-turn", 50),
      ],
      [goal("notice", 45)],
    );
    expect(ids(result)).toEqual([
      "cut",
      "rewound-group-rw-1",
      "dropped",
      "notice",
      "next-turn",
    ]);
    expect(result[3]?.rewoundGroupId).toBeUndefined();
  });
  it("puts a receipt written between two rewinds to one cut into the later group", () => {
    // A clearloop retry notice: written after iteration 1's rewind, dropped
    // by iteration 2's.
    const result = mergeLocalCommandMessages(
      [
        provider("cut", 5),
        header("rw-1", 5, 20),
        grouped("first", 10, "rw-1"),
        header("rw-2", 5, 40),
        grouped("second", 30, "rw-2"),
      ],
      [goal("retry-notice", 25)],
    );
    expect(ids(result)).toEqual([
      "cut",
      "rewound-group-rw-1",
      "first",
      "rewound-group-rw-2",
      "retry-notice",
      "second",
    ]);
    expect(result[4]?.rewoundGroupId).toBe("rw-2");
  });
  it("puts a receipt the enclosing rewind dropped into the enclosing group", () => {
    const result = mergeLocalCommandMessages(
      [
        provider("outer-cut", 2),
        header("rw-outer", 2, 55),
        grouped("inner-cut", 5, "rw-outer"),
        header("rw-inner", 5, 20, "rw-outer"),
        grouped("inner-dropped", 10, "rw-inner", "rw-outer"),
      ],
      [goal("notice", 30)],
    );
    const notice = result.find((message) => message.id === "notice");
    expect(notice?.rewoundGroupId).toBe("rw-outer");
    expect(notice?.rewoundParentGroupId).toBeUndefined();
  });
  it("leaves a receipt on the live branch alone", () => {
    const result = mergeLocalCommandMessages(
      [provider("cut", 5), provider("live", 30)],
      [goal("notice", 20)],
    );
    expect(ids(result)).toEqual(["cut", "notice", "live"]);
    expect(result[1]?.rewoundGroupId).toBeUndefined();
  });
});
