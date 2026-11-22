import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AntigravityLogProjection,
  antigravityLogLines,
  parseAntigravityLogRecord,
  projectAntigravityLog,
  type AntigravityLogRecord,
} from "../../src/sessions/antigravity-log-projection.js";
import type { Message } from "../../src/supervisor/types.js";
import { writeAntigravityScaleConversation } from "../utils/antigravity-scale-log.js";

const ID = "c0ffee00-0000-4000-8000-000000000195";
const at = "2026-11-22T08:00:00Z";
const user = (step: number, text: string) => ({
  step_index: step,
  source: "USER_EXPLICIT",
  type: "USER_INPUT",
  status: "DONE",
  created_at: at,
  content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: ${at}.\n</ADDITIONAL_METADATA>`,
});
const planner = (
  step: number,
  fields: Record<string, unknown> = {},
  status = "DONE",
) => ({
  step_index: step,
  source: "MODEL",
  type: "PLANNER_RESPONSE",
  status,
  created_at: at,
  model: "gemini-3.8-flash-high",
  input_tokens: 100,
  cache_read_tokens: 0,
  output_tokens: 5,
  ...fields,
});
const calls = (...names: string[]) => ({
  tool_calls: names.map((name, i) => ({ name, args: { Path: `/p/${i}` } })),
});
const result = (step: number, status = "DONE", extra = {}) => ({
  step_index: step,
  source: "MODEL",
  type: "GENERIC",
  status,
  created_at: at,
  ...extra,
  content: `Created At: ${at}\nCompleted At: ${at}\nRESULT_${step}`,
});
const system = (
  step: number,
  type: string,
  fields: Record<string, unknown>,
) => ({
  step_index: step,
  source: "SYSTEM",
  type,
  status: "DONE",
  created_at: at,
  ...fields,
});
const wrap = (text: string) =>
  `The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n${text}\n</SYSTEM_MESSAGE>`;

async function* chunks(bytes: Buffer, size = 7) {
  for (let i = 0; i < bytes.length; i += size)
    yield bytes.subarray(i, i + size);
}

type Line = Record<string, unknown> | string | Buffer;
const bytesOf = (line: Line) =>
  Buffer.isBuffer(line)
    ? line
    : Buffer.from(typeof line === "string" ? line : JSON.stringify(line));

async function project(
  records: Line[],
  options: { ownerLive?: boolean; tail?: Line } = {},
) {
  const bytes = Buffer.concat(
    [...records.flatMap((line) => [bytesOf(line), Buffer.from("\n")])].concat(
      options.tail === undefined ? [] : [bytesOf(options.tail)],
    ),
  );
  const result = await projectAntigravityLog(
    antigravityLogLines(chunks(bytes)),
    {
      conversationId: ID,
      ownerLive: options.ownerLive ?? false,
    },
  );
  // The projection reports its own throws as unknown; none may happen here.
  expect(result.status === "unknown" && result.error).toBeFalsy();
  return result;
}

/** One line per message: its ID suffix and what it shows. */
function shown(messages: Message[]): string[] {
  return messages.map((message) => {
    const id = String(message.uuid).slice(ID.length + 1);
    const content = message.message?.content;
    const block = Array.isArray(content) ? content[0] : undefined;
    const body =
      message.type === "error"
        ? `error ${message.error}`
        : message.type === "system"
          ? `${message.subtype} ${message.compactSummaryText ?? (message.details as string[])[0]}`
          : typeof content === "string"
            ? `${message.type} ${content}`
            : block?.type === "tool_use"
              ? `call ${block.name}`
              : block?.type === "tool_result"
                ? `result ${block.is_error ? "error " : ""}${String(block.content).split("\n").at(-1)}`
                : `thinking ${block?.thinking}`;
    return `${id} ${body}${message.orphanedToolUseIds ? " (interrupted)" : ""}`;
  });
}

describe("Antigravity log projection", () => {
  it.each([
    {
      name: "a turn with thinking, text and a complete group, across a skipped step",
      records: [
        user(0, "HELLO"),
        planner(1, {
          thinking: "THINK",
          content: "TEXT",
          ...calls("read_file", "run_command"),
        }),
        result(2),
        result(3, "ERROR", { error: "boom" }),
        planner(5, { content: "DONE" }),
      ],
      expected: [
        "step-0 user HELLO",
        "step-1:thinking thinking THINK",
        "step-1:text assistant TEXT",
        "step-1:tool-0:call call read_file",
        "step-1:tool-1:call call run_command",
        "step-1:tool-0:result result RESULT_2",
        "step-1:tool-1:result result error RESULT_3",
        "step-5:text assistant DONE",
      ],
    },
    {
      name: "a running background task, its wake and a checkpoint",
      records: [
        user(0, "BG"),
        planner(1, calls("run_command")),
        {
          ...result(2, "RUNNING"),
          content: `Created At: ${at}\nTool is running as a background task with task id: ${ID}/task-2`,
        },
        planner(3, { content: "LAUNCHED" }),
        system(4, "SYSTEM_MESSAGE", {
          content: wrap(
            `[Message] sender=${ID}/task-2 content=Task id "${ID}/task-2" finished with result:`,
          ),
        }),
        planner(5, { content: "WOKE" }),
        system(6, "CHECKPOINT", {
          input_tokens: 1,
          cache_read_tokens: 0,
          output_tokens: 1,
          content: "SUMMARY",
        }),
      ],
      expected: [
        "step-0 user BG",
        "step-1:tool-0:call call run_command",
        `step-1:tool-0:result result Tool is running as a background task with task id: ${ID}/task-2`,
        "step-3:text assistant LAUNCHED",
        `step-4 informational [Message] sender=${ID}/task-2 content=Task id "${ID}/task-2" finished with result:`,
        "step-5:text assistant WOKE",
        "step-6 compact_boundary SUMMARY",
      ],
    },
    {
      name: "a cancel on 1.5.13: partial text DONE, then ERROR_MESSAGE",
      records: [
        user(0, "C"),
        { ...planner(1, { content: "PARTIAL " }), input_tokens: undefined },
        system(2, "ERROR_MESSAGE", {
          error: "The stream was interrupted.",
          content: "Error: The stream was interrupted.",
        }),
      ],
      expected: [
        "step-0 user C",
        "step-1:text assistant PARTIAL ",
        "step-2 error The stream was interrupted.",
      ],
    },
    {
      name: "a cancel on 1.5.14: partial text ERROR with its error",
      records: [
        user(0, "C"),
        planner(
          1,
          { content: "PARTIAL ", error: "context canceled by user" },
          "ERROR",
        ),
        system(2, "ERROR_MESSAGE", { error: "canceled" }),
      ],
      expected: [
        "step-0 user C",
        "step-1:text assistant PARTIAL ",
        "step-1:error error context canceled by user",
        "step-2 error canceled",
      ],
    },
    {
      name: "a group cut short, then the next turn (a Deny result ends its turn)",
      records: [
        planner(4, calls("write_file", "edit_file", "edit_file")),
        result(5, "ERROR", { error: "denied" }),
        user(8, "NEXT"),
      ],
      expected: [
        "step-4:tool-0:call call write_file",
        "step-4:tool-1:call call edit_file (interrupted)",
        "step-4:tool-2:call call edit_file (interrupted)",
        "step-4:tool-0:result result error RESULT_5",
        "step-8 user NEXT",
      ],
    },
    {
      name: "an interior missing result",
      records: [
        planner(0, calls("read_file", "read_file", "read_file")),
        result(1),
        result(3),
        planner(4, { content: "AFTER" }),
      ],
      expected: [
        "step-0:tool-0:call call read_file",
        "step-0:tool-1:call call read_file (interrupted)",
        "step-0:tool-2:call call read_file",
        "step-0:tool-0:result result RESULT_1",
        "step-0:tool-2:result result RESULT_3",
        "step-4:text assistant AFTER",
      ],
    },
    {
      name: "an unterminated last line is not a record yet, even mid-character",
      records: [user(0, "A")],
      tail: Buffer.from([
        ...Buffer.from('{"step_index":1,"content":"'),
        0xe2,
        0x82,
      ]),
      expected: ["step-0 user A"],
    },
    {
      name: "user text keeps literal tags, and settings changes are dropped",
      records: [
        {
          ...user(0, "x"),
          content: `<USER_REQUEST>\nsay </USER_REQUEST> and <SYSTEM_MESSAGE> \u20ac\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: ${at}.\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nThe user changed setting.\n</USER_SETTINGS_CHANGE>`,
        },
      ],
      expected: ["step-0 user say </USER_REQUEST> and <SYSTEM_MESSAGE> \u20ac"],
    },
  ])("$name", async ({ records, tail, expected }) => {
    const projected = await project(records, { tail });
    expect(projected.status).toBe("known");
    if (projected.status === "known")
      expect(shown(projected.messages)).toEqual(expected);
  });

  it("leaves calls open at the end running under a live owner and interrupted once stopped", async () => {
    const records = [planner(0, calls("read_file", "run_command")), result(1)];
    const live = await project(records, { ownerLive: true });
    const stopped = await project(records);
    expect(live.status === "known" && shown(live.messages)).toEqual([
      "step-0:tool-0:call call read_file",
      "step-0:tool-1:call call run_command",
      "step-0:tool-0:result result RESULT_1",
    ]);
    expect(stopped.status === "known" && shown(stopped.messages)[1]).toBe(
      "step-0:tool-1:call call run_command (interrupted)",
    );
  });

  it.each([
    { name: "a bad line", records: [user(0, "A"), "{not json", user(2, "B")] },
    { name: "an empty line", records: [user(0, "A"), "", user(2, "B")] },
    {
      name: "a shortened field",
      records: [{ ...user(0, "A"), truncated_fields: ["content"] }],
    },
    {
      name: "a step that does not increase",
      records: [user(3, "A"), user(3, "B")],
    },
    {
      name: "an unrecognized type",
      records: [system(0, "BROWSER_STEP", { content: "x" })],
    },
    {
      name: "an unrecognized field",
      records: [{ ...user(0, "A"), images: [] }],
    },
    {
      name: "an unexpected status",
      records: [{ ...user(0, "A"), status: "RUNNING" }],
    },
    {
      name: "user input without a request",
      records: [{ ...user(0, "A"), content: "A" }],
    },
    { name: "a result no group owns", records: [user(0, "A"), result(1)] },
    {
      name: "more results than calls",
      records: [planner(0, calls("read_file")), result(1), result(2)],
    },
    {
      name: "another record inside a group's steps",
      records: [
        planner(0, calls("read_file", "read_file")),
        result(1),
        user(2, "A"),
      ],
    },
    {
      name: "a call without args",
      records: [planner(0, { tool_calls: [{ name: "read_file" }] })],
    },
    { name: "tool_calls null", records: [planner(0, { tool_calls: null })] },
    {
      name: "an inherited type name",
      records: [{ step_index: 0, type: "constructor", created_at: at }],
    },
    {
      name: "a type that is an object",
      records: [{ ...user(0, "A"), type: { toString: null } }],
    },
    {
      name: "a source that is an object",
      records: [{ ...user(0, "A"), source: { toString: null } }],
    },
    {
      name: "invalid UTF-8 in a complete line",
      records: [
        (() => {
          const json = JSON.stringify(planner(0, { content: "A_B" }));
          const at = json.indexOf("A_B") + 1;
          return Buffer.concat([
            Buffer.from(json.slice(0, at)),
            Buffer.from([0xff]),
            Buffer.from(json.slice(at + 1)),
          ]);
        })(),
      ],
    },
    {
      name: "a system message outside its wrapper",
      records: [
        system(0, "SYSTEM_MESSAGE", {
          content: "<SYSTEM_MESSAGE>\nx\n</SYSTEM_MESSAGE>",
        }),
      ],
    },
    {
      name: "text after a user request's known blocks",
      records: [
        { ...user(0, "A"), content: `${user(0, "A").content}\nTRAILING` },
      ],
    },
  ])("makes the log unknown on $name", async ({ records }) => {
    expect((await project(records)).status).toBe("unknown");
  });

  it("gives every window the messages a whole projection gives its records", async () => {
    const root = await mkdtemp(join(tmpdir(), "ya-agy-projection-"));
    try {
      const scale = await writeAntigravityScaleConversation({
        store: join(root, "antigravity-cli"),
        id: ID,
        cwd: root,
        steps: 400,
        targetBytes: 200_000,
        checkpointEvery: 120,
        skipEvery: 150,
        interruptedGroupEvery: 90,
        interiorGapGroupEvery: 70,
        shortLog: false,
        summaries: false,
      });
      expect(scale.interruptedGroups.map((group) => group.shape)).toEqual(
        expect.arrayContaining(["suffix", "interior"]),
      );
      const records = (await readFile(scale.fullPath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => parseAntigravityLogRecord(line) as AntigravityLogRecord);
      const whole = await projectAntigravityLog(
        antigravityLogLines(createReadStream(scale.fullPath)),
        { conversationId: ID, ownerLive: false },
      );
      expect(whole.status).toBe("known");
      const all = whole.status === "known" ? whole.messages : [];
      expect(all.filter((m) => m.orphanedToolUseIds).length).toBe(
        scale.interruptedGroups.reduce((n, g) => n + g.omitted.length, 0),
      );
      for (let start = 1; start < records.length; start++) {
        // Context before: from the last record that is not GENERIC.
        let from = start - 1;
        while (from > 0 && records[from]!.type === "GENERIC") from--;
        const before = new AntigravityLogProjection(ID);
        for (const record of records.slice(0, start)) before.add(record);
        // Lookahead after the earlier window, while one of its groups is open.
        for (
          let next = start;
          before.awaitingGroup && next < records.length;
          next++
        )
          before.observe(records[next]!);
        const after = new AntigravityLogProjection(ID);
        for (const record of records.slice(from, start)) after.observe(record);
        for (const record of records.slice(start)) after.add(record);
        const first = before.finish({ ownerLive: false });
        const second = after.finish({ ownerLive: false });
        expect(first.status === "known" && second.status === "known").toBe(
          true,
        );
        if (first.status === "known" && second.status === "known")
          expect([...first.messages, ...second.messages]).toEqual(all);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
