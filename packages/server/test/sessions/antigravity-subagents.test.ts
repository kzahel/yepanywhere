import * as fs from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  nativeSessionRef,
  parseNativeSessionId,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AntigravityProvider } from "../../src/sdk/providers/antigravity.js";
import { AntigravityBackground } from "../../src/sdk/providers/antigravity-background.js";
import { AntigravitySubagentTracker } from "../../src/sdk/providers/antigravity-subagent-tracker.js";
import { AntigravityTranscript } from "../../src/sdk/providers/antigravity-transcript.js";
import { AntigravitySessionReader } from "../../src/sessions/antigravity-reader.js";
import {
  correlateAntigravitySubagentCalls,
  formatSpawnAgentResult,
  parseSpawnAgentResultId,
  readAntigravityReadOnlyTranscript,
  readAntigravitySubagentLaunches,
  readAntigravityTranscriptPosition,
  readAntigravityTurnBoundary,
  readAntigravityTurnSubagentLaunches,
} from "../../src/sessions/antigravity-subagent-links.js";
import { AntigravitySummariesReader } from "../../src/sessions/antigravity-summaries.js";
import { loadSqliteDriver } from "../../src/storage/sqlite.js";

const PARENT_ID = "11111111-1111-4111-8111-111111111111";
const CHILD_ID = "22222222-2222-4222-8222-222222222222";
const GRANDCHILD_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_PARENT_ID = "44444444-4444-4444-8444-444444444444";
const FOREIGN_CHILD_ID = "55555555-5555-4555-8555-555555555555";
const SPOOFED_ID = "66666666-6666-4666-8666-666666666666";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.unstubAllEnvs();
});

async function createSubagentFixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "ya-agy-subagents-")),
  );
  const project = join(root, "project");
  const cliDir = join(root, "antigravity-cli");
  const conversationsDir = join(cliDir, "conversations");
  const brainDir = join(cliDir, "brain");
  const dbPath = join(cliDir, "conversation_summaries.db");
  await mkdir(project, { recursive: true });
  await mkdir(conversationsDir, { recursive: true });
  await mkdir(brainDir, { recursive: true });

  const db = loadSqliteDriver()!.open(dbPath);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      workspace_uris TEXT NOT NULL,
      agent_name TEXT NOT NULL DEFAULT '',
      parent_conversation_id TEXT NOT NULL DEFAULT '',
      nesting_depth INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT '',
      not_fully_idle NUMERIC NOT NULL DEFAULT 0,
      killed NUMERIC NOT NULL DEFAULT 0,
      last_modified_time DATETIME NOT NULL DEFAULT '0001-01-01 00:00:00+00:00'
    );
  `);
  const insert = db.prepare(
    "INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const projectUri = JSON.stringify([pathToFileURL(project).href]);
  const writeTranscriptLog = async (parentId: string, lines: object[]) => {
    const logsDir = join(brainDir, parentId, ".system_generated", "logs");
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, "transcript.jsonl"),
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
  };

  cleanup.push(async () => {
    insert.finalize();
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  return {
    root,
    project,
    projectUri,
    cliDir,
    conversationsDir,
    brainDir,
    dbPath,
    db,
    insert,
    writeTranscriptLog,
  };
}

describe("Antigravity subagent transcript, links, reader, and background retention", () => {
  it("normalizes live and cold-replayed invoke_subagent into spawn_agent and enriches agent_id in-place", () => {
    const live = new AntigravityTranscript(PARENT_ID, PARENT_ID, true);
    const callOut = live.accept({
      sessionUpdate: "tool_call",
      toolCallId: "tc-1",
      name: "invoke_subagent",
      title: "Run invoke_subagent",
      status: "in_progress",
      rawInput: {
        Role: "Codebase Researcher",
        TypeName: "research",
        Prompt: "Find the entry point",
        Model: "flash",
      },
    });
    expect(callOut).toHaveLength(1);
    expect(callOut[0]?.message?.content).toEqual([
      {
        type: "tool_use",
        id: "tc-1",
        name: "spawn_agent",
        input: {
          description: "Codebase Researcher",
          subagent_type: "research",
          role: "research",
          prompt: "Find the entry point",
          model: "flash",
        },
      },
    ]);
    live.accept({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-1",
      name: "invoke_subagent",
      status: "completed",
    });
    const enriched = live.enrichSubagentResult("tc-1", CHILD_ID);
    expect(enriched?.uuid).toBe("tc-1:result");
    expect(live.messages.filter((m) => m.uuid === "tc-1:result")).toHaveLength(
      1,
    );
    const resultBlock = Array.isArray(enriched?.message?.content)
      ? enriched.message.content[0]
      : undefined;
    expect(resultBlock?.type).toBe("tool_result");
    if (resultBlock?.type === "tool_result") {
      expect(parseSpawnAgentResultId(resultBlock.content)).toBe(CHILD_ID);
      expect(JSON.parse(String(resultBlock.content))).toEqual({
        agent_id: CHILD_ID,
        nickname: "Codebase Researcher",
      });
    }

    // Cold session/load emits a single completed tool_call with no tool_call_update.
    const cold = new AntigravityTranscript(PARENT_ID, PARENT_ID, false);
    const coldOut = cold.accept({
      sessionUpdate: "tool_call",
      toolCallId: "cold-1",
      name: "invoke_subagent",
      title: "Run invoke_subagent",
      status: "completed",
      rawInput: {
        Role: "Cold Helper",
        TypeName: "self",
        Prompt: "Check logs",
        Model: "inherit",
      },
    });
    expect(coldOut).toHaveLength(2);
    expect(coldOut[0]?.uuid).toBe("cold-1:call");
    expect(coldOut[1]?.uuid).toBe("cold-1:result");
    expect(cold.listSubagentCalls()).toEqual([
      {
        toolUseId: "cold-1",
        role: "Cold Helper",
        typeName: "self",
        prompt: "Check logs",
        completed: true,
        failed: false,
      },
    ]);
    cold.enrichSubagentResult("cold-1", CHILD_ID, "Cold Helper");
    expect(cold.messages).toHaveLength(2);
    const coldResult = cold.messages[1]?.message?.content;
    expect(
      Array.isArray(coldResult) && coldResult[0]?.type === "tool_result"
        ? coldResult[0].content
        : "",
    ).toBe(formatSpawnAgentResult(CHILD_ID, "Cold Helper"));

    // A failed invoke_subagent call preserves is_error and refuses enrichment.
    const failedTx = new AntigravityTranscript(PARENT_ID, PARENT_ID, true);
    failedTx.accept({
      sessionUpdate: "tool_call",
      toolCallId: "fail-1",
      name: "invoke_subagent",
      title: "Run invoke_subagent",
      status: "in_progress",
      rawInput: { Role: "Denied", TypeName: "research", Prompt: "Nope" },
    });
    failedTx.accept({
      sessionUpdate: "tool_call_update",
      toolCallId: "fail-1",
      name: "invoke_subagent",
      status: "failed",
      rawOutput: "Permission denied",
    });
    expect(failedTx.enrichSubagentResult("fail-1", CHILD_ID)).toBeUndefined();
    const failedResultBlock = Array.isArray(
      failedTx.messages[1]?.message?.content,
    )
      ? failedTx.messages[1].message.content[0]
      : undefined;
    expect(failedResultBlock).toMatchObject({
      type: "tool_result",
      tool_use_id: "fail-1",
      content: "Permission denied",
      is_error: true,
    });
  });

  it("reads bounded transcript.jsonl launches, rejects symlinks outside brain dir, and filters unverified IDs", async () => {
    const f = await createSubagentFixture();
    await f.writeTranscriptLog(PARENT_ID, [
      {
        step_index: 10,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        tool_calls: [
          { name: "read_file", args: { Path: '"/tmp/a"' } },
          {
            name: "invoke_subagent",
            args: {
              Role: '"Alpha Researcher"',
              TypeName: '"research"',
              Prompt: '"Inspect alpha"',
            },
          },
          {
            name: "invoke_subagent",
            args: {
              Role: '"Spoofed Agent"',
              TypeName: '"self"',
              Prompt: '"Should be ignored"',
            },
          },
        ],
      },
      { step_index: 11, type: "GENERIC", status: "DONE", content: "file text" },
      {
        step_index: 12,
        type: "GENERIC",
        status: "DONE",
        content: `Created At: 2026-11-21\nCreated the following subagent:\n{\n  "conversationId": "${CHILD_ID}"\n}\nDone.`,
      },
      {
        step_index: 13,
        type: "GENERIC",
        status: "DONE",
        content: `Created the following subagent:\n{\n  "conversationId": "${SPOOFED_ID}"\n}`,
      },
    ]);

    const launches = await readAntigravitySubagentLaunches(
      f.conversationsDir,
      PARENT_ID,
    );
    expect(launches).toEqual([
      {
        childId: CHILD_ID,
        role: "Alpha Researcher",
        typeName: "research",
        prompt: "Inspect alpha",
        stepIndex: 12,
        plannerStepIndex: 10,
        pairedWithInvokeSubagent: true,
      },
      {
        childId: SPOOFED_ID,
        role: "Spoofed Agent",
        typeName: "self",
        prompt: "Should be ignored",
        stepIndex: 13,
        plannerStepIndex: 10,
        pairedWithInvokeSubagent: true,
      },
    ]);

    const correlated = correlateAntigravitySubagentCalls(
      [
        {
          toolUseId: "tc-a",
          role: "Alpha Researcher",
          typeName: "research",
          prompt: "Inspect alpha",
        },
        {
          toolUseId: "tc-spoof",
          role: "Spoofed Agent",
          typeName: "self",
          prompt: "Should be ignored",
        },
      ],
      launches,
      new Set([CHILD_ID]),
    );
    expect([...correlated.entries()]).toEqual([
      [
        "tc-a",
        {
          childId: CHILD_ID,
          role: "Alpha Researcher",
          typeName: "research",
          prompt: "Inspect alpha",
          stepIndex: 12,
          plannerStepIndex: 10,
          pairedWithInvokeSubagent: true,
        },
      ],
    ]);

    // Conflicting metadata, failed calls, unpaired launches, or ambiguous
    // identical launches must NEVER be guessed or linked.
    expect(
      correlateAntigravitySubagentCalls(
        [
          {
            toolUseId: "tc-mismatch",
            role: "Different Role",
            typeName: "self",
            prompt: "Different Prompt",
          },
        ],
        [launches[0]!],
        new Set([CHILD_ID]),
      ).size,
    ).toBe(0);
    expect(
      correlateAntigravitySubagentCalls(
        [
          {
            toolUseId: "tc-failed",
            role: "Alpha Researcher",
            typeName: "research",
            prompt: "Inspect alpha",
            failed: true,
          },
        ],
        [launches[0]!],
        new Set([CHILD_ID]),
      ).size,
    ).toBe(0);
    // Unpaired GENERIC launch must be rejected even when verified in DB.
    expect(
      correlateAntigravitySubagentCalls(
        [
          {
            toolUseId: "tc-unpaired",
            role: "Alpha Researcher",
            typeName: "research",
            prompt: "Inspect alpha",
          },
        ],
        [{ childId: CHILD_ID, stepIndex: 99, pairedWithInvokeSubagent: false }],
        new Set([CHILD_ID]),
      ).size,
    ).toBe(0);
    // Ambiguous: 1 call matching 2 identical launches -> unlinked.
    expect(
      correlateAntigravitySubagentCalls(
        [
          {
            toolUseId: "tc-dup-1",
            role: "Alpha Researcher",
            typeName: "research",
            prompt: "Inspect alpha",
          },
        ],
        [
          launches[0]!,
          { ...launches[0]!, childId: GRANDCHILD_ID, stepIndex: 20 },
        ],
        new Set([CHILD_ID, GRANDCHILD_ID]),
      ).size,
    ).toBe(0);
    // Ambiguous: 2 identical calls matching 2 identical launches -> both unlinked.
    expect(
      correlateAntigravitySubagentCalls(
        [
          {
            toolUseId: "tc-dup-1",
            role: "Alpha Researcher",
            typeName: "research",
            prompt: "Inspect alpha",
          },
          {
            toolUseId: "tc-dup-2",
            role: "Alpha Researcher",
            typeName: "research",
            prompt: "Inspect alpha",
          },
        ],
        [
          launches[0]!,
          { ...launches[0]!, childId: GRANDCHILD_ID, stepIndex: 20 },
        ],
        new Set([CHILD_ID, GRANDCHILD_ID]),
      ).size,
    ).toBe(0);

    // Turn boundary isolation: even when Turn A's USER_INPUT AND launch BOTH
    // flush late (after the baseline snapshot, before Turn B's USER_INPUT),
    // Turn B's promptOffset + promptText check MUST NOT select Turn A!
    const freshBaseline = await readAntigravityTurnBoundary(
      f.conversationsDir,
      GRANDCHILD_ID,
    );
    expect(freshBaseline).toEqual({ step: -1 });
    // Turn A (promptOffset 0) and Turn B (promptOffset 1) submitted; Turn A's
    // USER_INPUT + launch flush late while Turn B's USER_INPUT is still pending.
    await f.writeTranscriptLog(GRANDCHILD_ID, [
      {
        step_index: 0,
        type: "USER_INPUT",
        status: "DONE",
        content: "Same prompt",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        tool_calls: [
          {
            name: "invoke_subagent",
            args: {
              Role: '"Alpha Researcher"',
              TypeName: '"research"',
              Prompt: '"Same prompt"',
            },
          },
        ],
      },
      {
        step_index: 2,
        type: "GENERIC",
        status: "DONE",
        content: `Created the following subagent:\n{"conversationId":"${CHILD_ID}"}`,
      },
    ]);
    // Turn B (promptOffset 1) sees only Turn A's input at offset 0 -> returns []!
    expect(
      await readAntigravityTurnSubagentLaunches(
        f.conversationsDir,
        GRANDCHILD_ID,
        {
          afterStepExclusive: freshBaseline!.step,
          promptOffset: 1,
          promptText: "Same prompt",
        },
      ),
    ).toEqual({ launches: [] });
    // Even if Turn B's USER_INPUT arrives at step 3 with mismatched text -> returns [].
    await f.writeTranscriptLog(GRANDCHILD_ID, [
      { step_index: 0, type: "USER_INPUT", status: "DONE", content: "Turn A" },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        tool_calls: [
          {
            name: "invoke_subagent",
            args: {
              Role: '"Alpha Researcher"',
              TypeName: '"research"',
              Prompt: '"Same prompt"',
            },
          },
        ],
      },
      {
        step_index: 2,
        type: "GENERIC",
        status: "DONE",
        content: `Created the following subagent:\n{"conversationId":"${CHILD_ID}"}`,
      },
      { step_index: 3, type: "USER_INPUT", status: "DONE", content: "Turn B" },
    ]);
    expect(
      await readAntigravityTurnSubagentLaunches(
        f.conversationsDir,
        GRANDCHILD_ID,
        {
          afterStepExclusive: freshBaseline!.step,
          promptOffset: 1,
          promptText: "Turn B",
        },
      ),
    ).toMatchObject({ launches: [], verifiedUserStep: 3 });
    expect(
      await readAntigravityTurnSubagentLaunches(
        f.conversationsDir,
        GRANDCHILD_ID,
        {
          afterStepExclusive: freshBaseline!.step,
          promptOffset: 1,
          promptText: "Different Prompt",
        },
      ),
    ).toEqual({ launches: [] });
    // Once Turn B (or a steering prompt at step 3) launches SPOOFED_ID after step 3:
    // - Turn A (promptOffset 0) is strictly bounded to (0, 3) and MUST NOT see SPOOFED_ID!
    // - Turn B (promptOffset 1) sees ONLY SPOOFED_ID!
    await f.writeTranscriptLog(GRANDCHILD_ID, [
      { step_index: 0, type: "USER_INPUT", status: "DONE", content: "Turn A" },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        tool_calls: [
          {
            name: "invoke_subagent",
            args: {
              Role: '"Alpha Researcher"',
              TypeName: '"research"',
              Prompt: '"Same prompt"',
            },
          },
        ],
      },
      {
        step_index: 2,
        type: "GENERIC",
        status: "DONE",
        content: `Created the following subagent:\n{"conversationId":"${CHILD_ID}"}`,
      },
      { step_index: 3, type: "USER_INPUT", status: "DONE", content: "Turn B" },
      {
        step_index: 4,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        tool_calls: [
          {
            name: "invoke_subagent",
            args: {
              Role: '"Alpha Researcher"',
              TypeName: '"research"',
              Prompt: '"Same prompt"',
            },
          },
        ],
      },
      {
        step_index: 5,
        type: "GENERIC",
        status: "DONE",
        content: `Created the following subagent:\n{"conversationId":"${SPOOFED_ID}"}`,
      },
    ]);
    // Prompt 0 (Turn A) is strictly upper-bounded by step 3 (Turn B / Steer)!
    expect(
      await readAntigravityTurnSubagentLaunches(
        f.conversationsDir,
        GRANDCHILD_ID,
        {
          afterStepExclusive: freshBaseline!.step,
          promptOffset: 0,
          promptText: "Turn A",
        },
      ),
    ).toMatchObject({
      verifiedUserStep: 0,
      launches: [
        {
          childId: CHILD_ID,
          role: "Alpha Researcher",
          typeName: "research",
          prompt: "Same prompt",
          stepIndex: 2,
          plannerStepIndex: 1,
          pairedWithInvokeSubagent: true,
        },
      ],
    });
    expect(
      await readAntigravityTurnSubagentLaunches(
        f.conversationsDir,
        GRANDCHILD_ID,
        {
          afterStepExclusive: freshBaseline!.step,
          promptOffset: 1,
          promptText: "Turn B",
        },
      ),
    ).toMatchObject({
      verifiedUserStep: 3,
      launches: [
        {
          childId: SPOOFED_ID,
          role: "Alpha Researcher",
          typeName: "research",
          prompt: "Same prompt",
          stepIndex: 5,
          plannerStepIndex: 4,
          pairedWithInvokeSubagent: true,
        },
      ],
    });
    // Advancing anchor after verifying Turn A (step 0) allows Turn B to verify
    // cleanly at offset 0 via its pre-submission startByte even when step 0
    // falls outside a tiny 450-byte tail budget (while without startByte, an
    // incomplete tail refuses to guess)!
    const turnBStartByte = Buffer.byteLength(
      `${[
        {
          step_index: 0,
          type: "USER_INPUT",
          status: "DONE",
          content: "Turn A",
        },
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          tool_calls: [
            {
              name: "invoke_subagent",
              args: {
                Role: '"Alpha Researcher"',
                TypeName: '"research"',
                Prompt: '"Same prompt"',
              },
            },
          ],
        },
        {
          step_index: 2,
          type: "GENERIC",
          status: "DONE",
          content: `Created the following subagent:\n{"conversationId":"${CHILD_ID}"}`,
        },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n")}\n`,
      "utf8",
    );
    expect(
      await readAntigravityTurnSubagentLaunches(
        f.conversationsDir,
        GRANDCHILD_ID,
        {
          afterStepExclusive: 0,
          promptOffset: 0,
          promptText: "Turn B",
        },
        450,
      ),
    ).toEqual({ launches: [] });
    expect(
      await readAntigravityTurnSubagentLaunches(
        f.conversationsDir,
        GRANDCHILD_ID,
        {
          afterStepExclusive: 0,
          promptOffset: 0,
          promptText: "Turn B",
          startByte: turnBStartByte,
        },
        450,
      ),
    ).toMatchObject({
      verifiedUserStep: 3,
      launches: [
        {
          childId: SPOOFED_ID,
          role: "Alpha Researcher",
          typeName: "research",
          prompt: "Same prompt",
          stepIndex: 5,
          plannerStepIndex: 4,
          pairedWithInvokeSubagent: true,
        },
      ],
    });

    // Truncated tail ordinal completeness & UTF-8 chunk boundary safety:
    // Prompt A (step 0, "Same prompt") falls OUTSIDE a small tail while
    // Prompt B (step 2, identical "Same prompt") + launch sit INSIDE the tail.
    // 1. Without startByte, tail is truncated before anchor -> MUST NOT accept
    //    Prompt B's step 2 as Prompt A or leak Prompt B's child!
    // 2. With startByte=0, forward scan proves step 0 (even with a 4-byte emoji
    //    straddling the 64 KiB chunk boundary!) and upper-bounds Prompt A at step 2.
    const emojiPadLen = 65_536 - 78;
    const emojiPrompt = `${"a".repeat(emojiPadLen)}🚀end`;
    await f.writeTranscriptLog(GRANDCHILD_ID, [
      {
        step_index: 0,
        type: "USER_INPUT",
        status: "DONE",
        content: emojiPrompt,
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "y".repeat(20_000),
      },
      {
        step_index: 2,
        type: "USER_INPUT",
        status: "DONE",
        content: emojiPrompt,
      },
      {
        step_index: 3,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        tool_calls: [
          {
            name: "invoke_subagent",
            args: {
              Role: '"Alpha Researcher"',
              TypeName: '"research"',
              Prompt: '"Same prompt"',
            },
          },
        ],
      },
      {
        step_index: 4,
        type: "GENERIC",
        status: "DONE",
        content: `Created the following subagent:\n{"conversationId":"${SPOOFED_ID}"}`,
      },
    ]);
    // Tail budget 75 KiB covers step 2..4 (including Prompt B's identical text)
    // but stops mid-step 1 before reaching step 0 or start-of-file.
    expect(
      await readAntigravityTurnSubagentLaunches(
        f.conversationsDir,
        GRANDCHILD_ID,
        {
          afterStepExclusive: -1,
          promptOffset: 0,
          promptText: emojiPrompt,
        },
        75_000,
      ),
    ).toEqual({ launches: [] });
    // With startByte=0, forward scan decodes the 4-byte 🚀 across the 64 KiB
    // boundary cleanly, proves step 0, and excludes Prompt B's SPOOFED_ID at step 4!
    expect(
      await readAntigravityTurnSubagentLaunches(
        f.conversationsDir,
        GRANDCHILD_ID,
        {
          afterStepExclusive: -1,
          promptOffset: 0,
          promptText: emojiPrompt,
          startByte: 0,
        },
        75_000,
      ),
    ).toMatchObject({ verifiedUserStep: 0, launches: [] });

    // 1. Unscanned gap hiding a steering USER_INPUT: forward scan verifies step 0,
    //    gap contains step 2 (steering USER_INPUT), tail contains step 4 launch.
    //    MUST preserve verifiedUserStep: 0 while returning launches: []!
    // 2. Nested `"step_index": 0` inside tool output MUST NOT forge tail coverage!
    await f.writeTranscriptLog(GRANDCHILD_ID, [
      {
        step_index: 1,
        type: "USER_INPUT",
        status: "DONE",
        content: "Original",
      },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "p".repeat(120_000),
      },
      { step_index: 3, type: "USER_INPUT", status: "DONE", content: "Steer" },
      {
        nested: { step_index: 0 },
        step_index: 4,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "q".repeat(120_000),
      },
      {
        step_index: 5,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        tool_calls: [
          {
            name: "invoke_subagent",
            args: {
              Role: '"Alpha Researcher"',
              TypeName: '"research"',
              Prompt: '"Same prompt"',
            },
          },
        ],
      },
      {
        step_index: 6,
        type: "GENERIC",
        status: "DONE",
        content: `Created the following subagent:\n{"conversationId":"${SPOOFED_ID}"}`,
      },
    ]);
    // Budget 70 KiB: forward scan reads 0..70 KiB (verifies step 1 only), gap is
    // 70..170 KiB (hiding step 3 Steer), tail reads 170..240 KiB (sees step 5..6).
    // MUST return verifiedUserStep: 1 with launches: []!
    expect(
      await readAntigravityTurnSubagentLaunches(
        f.conversationsDir,
        GRANDCHILD_ID,
        {
          afterStepExclusive: 0,
          promptOffset: 0,
          promptText: "Original",
          startByte: 0,
        },
        70_000,
      ),
    ).toMatchObject({ verifiedUserStep: 1, launches: [] });
    // Real nested `{ step_index: 0 }` appearing BEFORE top-level `step_index: 4`
    // MUST NOT make the 140 KiB tail appear to reach baseline 0!
    expect(
      await readAntigravityTurnSubagentLaunches(
        f.conversationsDir,
        GRANDCHILD_ID,
        {
          afterStepExclusive: 0,
          promptOffset: 0,
          promptText: "Steer",
        },
        140_000,
      ),
    ).toEqual({ launches: [] });
    // Atomic file replacement invalidates saved (dev, ino) across ALL paths:
    // forward byte offset, verifiedUserStep, AND tail-only ordinal matching
    // (even on a small, fully readable tail that reuses step_index & prompt text)!
    const posBeforeReplace = await readAntigravityTranscriptPosition(
      f.conversationsDir,
      GRANDCHILD_ID,
    );
    expect(posBeforeReplace?.ino).toBeDefined();
    const grandchildTranscriptPath = join(
      f.brainDir,
      GRANDCHILD_ID,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    await unlink(grandchildTranscriptPath);
    await f.writeTranscriptLog(GRANDCHILD_ID, [
      {
        step_index: 1,
        type: "USER_INPUT",
        status: "DONE",
        content: "Original",
      },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        tool_calls: [
          {
            name: "invoke_subagent",
            args: {
              Role: '"Alpha Researcher"',
              TypeName: '"research"',
              Prompt: '"Same prompt"',
            },
          },
        ],
      },
      {
        step_index: 3,
        type: "GENERIC",
        status: "DONE",
        content: `Created the following subagent:\n{"conversationId":"${SPOOFED_ID}"}`,
      },
    ]);
    // 1. Verified-step path bound to old inode MUST reject replacement even on full tail!
    expect(
      await readAntigravityTurnSubagentLaunches(
        f.conversationsDir,
        GRANDCHILD_ID,
        {
          afterStepExclusive: 0,
          anchorDev: posBeforeReplace!.dev,
          anchorIno: posBeforeReplace!.ino,
          promptOffset: 0,
          promptText: "Original",
          verifiedUserStep: 1,
        },
      ),
    ).toEqual({ launches: [], replaced: true });
    // 2. Tail-only ordinal path bound to old inode MUST reject replacement even on full tail!
    expect(
      await readAntigravityTurnSubagentLaunches(
        f.conversationsDir,
        GRANDCHILD_ID,
        {
          afterStepExclusive: 0,
          anchorDev: posBeforeReplace!.dev,
          anchorIno: posBeforeReplace!.ino,
          promptOffset: 0,
          promptText: "Original",
        },
      ),
    ).toEqual({ launches: [], replaced: true });
    // 3. Forward-offset path bound to old inode MUST reject replacement!
    expect(
      await readAntigravityTurnSubagentLaunches(
        f.conversationsDir,
        GRANDCHILD_ID,
        {
          afterStepExclusive: 0,
          promptOffset: 0,
          promptText: "Original",
          startByte: 0,
          startDev: posBeforeReplace!.dev,
          startIno: posBeforeReplace!.ino,
        },
      ),
    ).toEqual({ launches: [], replaced: true });
    // 4. Same-inode in-place truncation (file rewritten smaller on SAME inode)
    //    MUST ALSO invalidate verifiedUserStep and tail-ordinal paths!
    const posBeforeTruncate = await readAntigravityTranscriptPosition(
      f.conversationsDir,
      GRANDCHILD_ID,
    );
    // Write a SHORTER file in-place (preserving inode) reusing step 1 & "Original".
    await writeFile(
      grandchildTranscriptPath,
      `${JSON.stringify({ step_index: 1, type: "USER_INPUT", status: "DONE", content: "Original" })}\n`,
    );
    const posAfterTruncate = await readAntigravityTranscriptPosition(
      f.conversationsDir,
      GRANDCHILD_ID,
    );
    expect(posAfterTruncate!.ino).toBe(posBeforeTruncate!.ino);
    expect(posAfterTruncate!.byte).toBeLessThan(posBeforeTruncate!.byte);
    expect(
      await readAntigravityTurnSubagentLaunches(
        f.conversationsDir,
        GRANDCHILD_ID,
        {
          afterStepExclusive: 0,
          anchorDev: posBeforeTruncate!.dev,
          anchorIno: posBeforeTruncate!.ino,
          anchorSize: posBeforeTruncate!.byte,
          promptOffset: 0,
          promptText: "Original",
          verifiedUserStep: 1,
        },
      ),
    ).toEqual({ launches: [], replaced: true });
    // 5. After atomic replacement invalidates old scopes, AntigravitySubagentTracker
    //    re-establishes a fresh boundary on readStartPosition() for subsequent prompts!
    const ac = new AbortController();
    const bg = new AntigravityBackground();
    const tracker = new AntigravitySubagentTracker({
      sessionId: GRANDCHILD_ID,
      storageScope: f.conversationsDir,
      modern: true,
      signal: ac.signal,
      background: bg,
      isInTurn: () => false,
      publish: () => {},
    });
    try {
      await tracker.initialize(true);
      const oldScope = tracker.beginPrompt("Old prompt", posAfterTruncate);
      expect(oldScope).toBeDefined();
      // Atomically replace transcript with a new inode.
      await unlink(grandchildTranscriptPath);
      await f.writeTranscriptLog(GRANDCHILD_ID, [
        { step_index: 0, type: "USER_INPUT", status: "DONE", content: "Reset" },
      ]);
      const freshPos = await tracker.readStartPosition();
      expect(oldScope?.promptOffset).toBe(-1);
      const nextScope = tracker.beginPrompt("Fresh prompt", freshPos);
      expect(nextScope).toBeDefined();
      expect(nextScope?.afterStepExclusive).toBe(0);
      expect(nextScope?.promptOffset).toBe(0);
    } finally {
      tracker.close();
    }

    // 6. Invalidating a prompt scope while a transcript lookup is in flight
    //    (e.g., atomic replacement + steering submission while handle.close() is
    //    pending) MUST NOT restore the invalidated scope, track its old launches,
    //    or publish its old child link when the lookup resumes.
    await unlink(grandchildTranscriptPath);
    await f.writeTranscriptLog(GRANDCHILD_ID, [
      {
        step_index: 0,
        type: "USER_INPUT",
        status: "DONE",
        content: "Prior",
      },
    ]);
    const inFlightAc = new AbortController();
    const inFlightBg = new AntigravityBackground();
    const published: unknown[] = [];
    const inFlightTracker = new AntigravitySubagentTracker({
      sessionId: GRANDCHILD_ID,
      storageScope: f.conversationsDir,
      modern: true,
      signal: inFlightAc.signal,
      background: inFlightBg,
      isInTurn: () => true,
      publish: (msg) => published.push(msg),
    });
    const origOpen = fs.promises.open.bind(fs.promises);
    const openSpy = vi.spyOn(fs.promises, "open");
    try {
      await inFlightTracker.initialize(true);
      const startPos = await inFlightTracker.readStartPosition();
      const oldScope = inFlightTracker.beginPrompt("Old prompt", startPos);
      expect(oldScope).toBeDefined();
      // Append the prompt and its invoke_subagent launch to the pre-replacement file.
      await f.writeTranscriptLog(GRANDCHILD_ID, [
        {
          step_index: 0,
          type: "USER_INPUT",
          status: "DONE",
          content: "Prior",
        },
        {
          step_index: 1,
          type: "USER_INPUT",
          status: "DONE",
          content: "Old prompt",
        },
        {
          step_index: 2,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          tool_calls: [
            {
              name: "invoke_subagent",
              args: {
                Role: '"Alpha Researcher"',
                TypeName: '"research"',
                Prompt: '"Old work"',
              },
            },
          ],
        },
        {
          step_index: 3,
          type: "GENERIC",
          status: "DONE",
          content: `Created the following subagent:\n{"conversationId":"${SPOOFED_ID}"}`,
        },
      ]);
      // Prepare a completed invoke_subagent call on the live transcript.
      const liveTranscript = new AntigravityTranscript(
        GRANDCHILD_ID,
        `${GRANDCHILD_ID}:turn`,
        true,
      );
      liveTranscript.accept({
        sessionUpdate: "tool_call",
        toolCallId: "call-stale",
        name: "invoke_subagent",
        title: "Run invoke_subagent",
        status: "in_progress",
        rawInput: {
          Role: "Alpha Researcher",
          TypeName: "research",
          Prompt: "Old work",
        },
      });
      liveTranscript.accept({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-stale",
        status: "completed",
      });

      const pauseNextClose = () => {
        let onCloseStarted!: () => void;
        let releaseClose!: () => void;
        const closeStarted = new Promise<void>((resolve) => {
          onCloseStarted = resolve;
        });
        const closeGate = new Promise<void>((resolve) => {
          releaseClose = resolve;
        });
        openSpy.mockImplementationOnce(async (...args) => {
          const handle = await origOpen(...args);
          const origClose = handle.close.bind(handle);
          handle.close = async () => {
            onCloseStarted();
            await closeGate;
            return origClose();
          };
          return handle;
        });
        return { closeStarted, releaseClose };
      };

      // Case A: resolveCall() lookup paused in handle.close() while a steer
      // observes an atomic transcript replacement and invalidates oldScope.
      const resolvePause = pauseNextClose();
      inFlightTracker.resolveCall(
        liveTranscript,
        "call-stale",
        undefined,
        true,
        [],
        oldScope,
        new Set(["call-stale"]),
      );
      await resolvePause.closeStarted;
      await unlink(grandchildTranscriptPath);
      await f.writeTranscriptLog(GRANDCHILD_ID, [
        {
          step_index: 0,
          type: "USER_INPUT",
          status: "DONE",
          content: "Replaced",
        },
      ]);
      const steerPos = inFlightTracker.readStartPositionSync();
      expect(inFlightTracker.beginPrompt("Steer", steerPos)).toBeUndefined();
      expect(oldScope?.promptOffset).toBe(-1);
      expect(oldScope?.verifiedUserStep).toBeUndefined();
      resolvePause.releaseClose();
      await inFlightTracker.drainPending();

      expect(oldScope?.verifiedUserStep).toBeUndefined();
      expect(oldScope?.promptOffset).toBe(-1);
      expect(published).toEqual([]);
      expect(inFlightBg.hasActiveSubagents()).toBe(false);
      expect(inFlightTracker.isCallResolved("call-stale")).toBe(false);

      // Case B: schedulePromptAnchorVerification() paused in handle.close()
      // while a steer invalidates its scope MUST NOT restore verifiedUserStep.
      const freshPos2 = await inFlightTracker.readStartPosition();
      const oldVerifyScope = inFlightTracker.beginPrompt(
        "Verify me",
        freshPos2,
      );
      expect(oldVerifyScope).toBeDefined();
      await f.writeTranscriptLog(GRANDCHILD_ID, [
        {
          step_index: 0,
          type: "USER_INPUT",
          status: "DONE",
          content: "Replaced",
        },
        {
          step_index: 1,
          type: "USER_INPUT",
          status: "DONE",
          content: "Verify me",
        },
      ]);
      const verifyPause = pauseNextClose();
      inFlightTracker.schedulePromptAnchorVerification(oldVerifyScope!);
      await verifyPause.closeStarted;
      await unlink(grandchildTranscriptPath);
      await f.writeTranscriptLog(GRANDCHILD_ID, [
        {
          step_index: 0,
          type: "USER_INPUT",
          status: "DONE",
          content: "Replaced again",
        },
      ]);
      const steerPos2 = inFlightTracker.readStartPositionSync();
      expect(inFlightTracker.beginPrompt("Steer 2", steerPos2)).toBeUndefined();
      verifyPause.releaseClose();
      await inFlightTracker.drainPending();
      expect(oldVerifyScope?.verifiedUserStep).toBeUndefined();
      expect(oldVerifyScope?.promptOffset).toBe(-1);
    } finally {
      openSpy.mockRestore();
      inFlightTracker.close();
    }

    // Disappearing transcript must return [] cleanly instead of throwing ENOENT.
    const vanishedPath = join(
      f.brainDir,
      PARENT_ID,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    await unlink(vanishedPath);
    expect(
      await readAntigravitySubagentLaunches(f.conversationsDir, PARENT_ID),
    ).toEqual([]);
    expect(
      await readAntigravityReadOnlyTranscript(f.conversationsDir, PARENT_ID),
    ).toEqual([]);

    // Symlinked transcript.jsonl escaping brain/<parentId> must be rejected.
    const outsideLog = join(f.root, "outside.jsonl");
    await writeFile(
      outsideLog,
      `${JSON.stringify({
        step_index: 1,
        type: "GENERIC",
        status: "DONE",
        content: `Created the following subagent:\n{"conversationId":"${CHILD_ID}"}`,
      })}\n`,
    );
    const escapedLogsDir = join(
      f.brainDir,
      OTHER_PARENT_ID,
      ".system_generated",
      "logs",
    );
    await mkdir(escapedLogsDir, { recursive: true });
    await symlink(outsideLog, join(escapedLogsDir, "transcript.jsonl"));
    expect(
      await readAntigravitySubagentLaunches(
        f.conversationsDir,
        OTHER_PARENT_ID,
      ),
    ).toEqual([]);

    // Symlink on brain/<parentId> directory itself escaping the store must also be rejected.
    const outsideBrain = join(f.root, "outside-brain");
    const outsideBrainLogs = join(outsideBrain, ".system_generated", "logs");
    await mkdir(outsideBrainLogs, { recursive: true });
    await writeFile(
      join(outsideBrainLogs, "transcript.jsonl"),
      `${JSON.stringify({
        step_index: 1,
        type: "GENERIC",
        status: "DONE",
        content: `Created the following subagent:\n{"conversationId":"${CHILD_ID}"}`,
      })}\n`,
    );
    await symlink(outsideBrain, join(f.brainDir, FOREIGN_CHILD_ID));
    expect(
      await readAntigravitySubagentLaunches(
        f.conversationsDir,
        FOREIGN_CHILD_ID,
      ),
    ).toEqual([]);
  });

  it("retains background owner while subagents run, clears settled/disappeared rows, and bounds provisional retention", () => {
    const onChange = vi.fn();
    const bg = new AntigravityBackground(onChange);
    const t0 = 1_000_000;
    bg.trackSubagent(CHILD_ID, "Smoke Researcher", "research", true, {
      nowMs: t0,
    });
    expect(bg.hasActiveSubagents()).toBe(true);
    expect(bg.snapshot()).toMatchObject({
      retained: false,
      foregroundWaits: [
        { id: CHILD_ID, kind: "subagent", label: "Smoke Researcher" },
      ],
      backgroundWork: [],
    });

    bg.foregroundSettled();
    expect(bg.snapshot()).toMatchObject({
      retained: true,
      backgroundTaskCount: 1,
      backgroundWork: [
        { id: CHILD_ID, kind: "subagent", label: "Smoke Researcher" },
      ],
    });

    // Provisional child (not yet in summaries DB) stays retained within grace.
    expect(
      bg.reconcileSubagents(new Map(), {
        nowMs: t0 + 5_000,
        provisionalGraceMs: 10_000,
      }),
    ).toBe(false);
    expect(bg.snapshot().retained).toBe(true);

    // Still running once seen -> stays retained, and transient DB outage (`undefined`) preserves it.
    expect(
      bg.reconcileSubagents(
        new Map([
          [
            CHILD_ID,
            {
              conversationId: CHILD_ID,
              parentConversationId: PARENT_ID,
              status: "CASCADE_RUN_STATUS_RUNNING",
              notFullyIdle: true,
              killed: false,
            },
          ],
        ]),
        { expectedParentId: PARENT_ID, nowMs: t0 + 6_000 },
      ),
    ).toBe(false);
    // IDLE + not_fully_idle = 1 must ALSO stay retained (matching viewer's running state).
    expect(
      bg.reconcileSubagents(
        new Map([
          [
            CHILD_ID,
            {
              conversationId: CHILD_ID,
              parentConversationId: PARENT_ID,
              status: "CASCADE_RUN_STATUS_IDLE",
              notFullyIdle: true,
              killed: false,
            },
          ],
        ]),
        { expectedParentId: PARENT_ID, nowMs: t0 + 6_500 },
      ),
    ).toBe(false);
    expect(
      bg.reconcileSubagents(undefined, {
        expectedParentId: PARENT_ID,
        nowMs: t0 + 60_000,
      }),
    ).toBe(false);
    expect(bg.snapshot().retained).toBe(true);

    // Reparented / foreign-parent row must immediately release retention (never
    // confirming a provisional launch or retaining a moved child).
    expect(
      bg.reconcileSubagents(
        new Map([
          [
            CHILD_ID,
            {
              conversationId: CHILD_ID,
              parentConversationId: OTHER_PARENT_ID,
              status: "CASCADE_RUN_STATUS_RUNNING",
              notFullyIdle: true,
              killed: false,
            },
          ],
        ]),
        { expectedParentId: PARENT_ID, nowMs: t0 + 6_800 },
      ),
    ).toBe(true);
    expect(bg.hasActiveSubagents()).toBe(false);
    expect(bg.snapshot().retained).toBe(false);

    // Confirmed absence after having been seen clears immediately.
    bg.trackSubagent(CHILD_ID, "Seen Then Vanished", "research", false, {
      seenInSummaries: true,
      nowMs: t0,
    });
    expect(
      bg.reconcileSubagents(new Map(), {
        expectedParentId: PARENT_ID,
        nowMs: t0 + 7_000,
      }),
    ).toBe(true);
    expect(bg.hasActiveSubagents()).toBe(false);
    expect(bg.snapshot().retained).toBe(false);

    // A provisional child whose UUID exists under ANOTHER parent clears immediately
    // rather than confirming and bypassing grace.
    bg.trackSubagent(
      FOREIGN_CHILD_ID,
      "Foreign Provisional",
      "research",
      false,
      {
        nowMs: t0,
      },
    );
    expect(
      bg.reconcileSubagents(
        new Map([
          [
            FOREIGN_CHILD_ID,
            {
              conversationId: FOREIGN_CHILD_ID,
              parentConversationId: OTHER_PARENT_ID,
              status: "CASCADE_RUN_STATUS_RUNNING",
              notFullyIdle: true,
              killed: false,
            },
          ],
        ]),
        { expectedParentId: PARENT_ID, nowMs: t0 + 1_000 },
      ),
    ).toBe(true);
    expect(bg.snapshot().retained).toBe(false);

    // A provisional child that NEVER appears in summaries DB clears once grace elapses.
    bg.trackSubagent(SPOOFED_ID, "Never Flushed", "research", false, {
      nowMs: t0,
    });
    expect(bg.snapshot().retained).toBe(true);
    expect(
      bg.reconcileSubagents(new Map(), {
        nowMs: t0 + 10_000,
        provisionalGraceMs: 10_000,
      }),
    ).toBe(true);
    expect(bg.snapshot().retained).toBe(false);

    // Settled idle and killed subagents clear cleanly.
    bg.trackSubagent(CHILD_ID, "Settling", "research", false, {
      seenInSummaries: true,
      nowMs: t0,
    });
    expect(
      bg.reconcileSubagents(
        new Map([
          [
            CHILD_ID,
            {
              conversationId: CHILD_ID,
              status: "CASCADE_RUN_STATUS_IDLE",
              notFullyIdle: false,
              killed: false,
            },
          ],
        ]),
      ),
    ).toBe(true);
    expect(bg.snapshot().retained).toBe(false);

    bg.trackSubagent(GRANDCHILD_ID, "Killed Helper", "self", false, {
      seenInSummaries: true,
      nowMs: t0,
    });
    expect(
      bg.reconcileSubagents(
        new Map([
          [
            GRANDCHILD_ID,
            {
              conversationId: GRANDCHILD_ID,
              status: "CASCADE_RUN_STATUS_RUNNING",
              notFullyIdle: true,
              killed: true,
            },
          ],
        ]),
      ),
    ).toBe(true);
    expect(bg.snapshot().retained).toBe(false);
  });

  it("replays verified children and grandchildren via getAgentSession, enriches cold getSession + getAgentMappings, and blocks unauthorized UUIDs before ACP", async () => {
    if (process.platform === "win32") return;
    const f = await createSubagentFixture();
    await writeFile(join(f.conversationsDir, `${PARENT_ID}.db`), "parent");
    await writeFile(join(f.conversationsDir, `${CHILD_ID}.db`), "child");
    await writeFile(
      join(f.conversationsDir, `${GRANDCHILD_ID}.db`),
      "grandchild",
    );
    await writeFile(
      join(f.conversationsDir, `${FOREIGN_CHILD_ID}.db`),
      "foreign",
    );
    await writeFile(
      join(f.conversationsDir, `${OTHER_PARENT_ID}.db`),
      "other-parent",
    );

    f.insert.run(
      PARENT_ID,
      "Parent",
      f.projectUri,
      "",
      "",
      0,
      "CASCADE_RUN_STATUS_IDLE",
      0,
      0,
      "2026-11-21 17:00:00+00:00",
    );
    f.insert.run(
      CHILD_ID,
      "Child Research",
      f.projectUri,
      "research",
      PARENT_ID,
      1,
      "CASCADE_RUN_STATUS_RUNNING",
      1,
      0,
      "0001-01-01 00:00:00+00:00",
    );
    f.insert.run(
      GRANDCHILD_ID,
      "Grandchild Work",
      f.projectUri,
      "self",
      CHILD_ID,
      2,
      "CASCADE_RUN_STATUS_IDLE",
      0,
      0,
      "2026-11-21 17:02:00+00:00",
    );
    f.insert.run(
      OTHER_PARENT_ID,
      "Other Parent",
      f.projectUri,
      "",
      "",
      0,
      "CASCADE_RUN_STATUS_IDLE",
      0,
      0,
      "2026-11-21 17:00:00+00:00",
    );
    f.insert.run(
      FOREIGN_CHILD_ID,
      "Other Parent Child",
      f.projectUri,
      "research",
      OTHER_PARENT_ID,
      1,
      "CASCADE_RUN_STATUS_IDLE",
      0,
      0,
      "2026-11-21 17:01:00+00:00",
    );

    await f.writeTranscriptLog(PARENT_ID, [
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        tool_calls: [
          {
            name: "invoke_subagent",
            args: {
              Role: '"Code Researcher"',
              TypeName: '"research"',
              Prompt: '"Inspect module"',
            },
          },
        ],
      },
      {
        step_index: 2,
        type: "GENERIC",
        status: "DONE",
        content: `Created the following subagent:\n{"conversationId":"${CHILD_ID}"}`,
      },
    ]);
    await f.writeTranscriptLog(CHILD_ID, [
      {
        step_index: 0,
        type: "USER_INPUT",
        status: "DONE",
        content: "Inspect module",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "RUNNING_READ_ONLY_PROGRESS",
      },
    ]);

    const spyLog = join(f.root, "acp-loads.log");
    const listLog = join(f.root, "acp-lists.log");
    const peerBin = join(f.root, "agy");
    await writeFile(
      peerBin,
      `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const send = (v) => process.stdout.write(JSON.stringify(v) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1 } });
  if (m.method === "session/list") {
    fs.appendFileSync(${JSON.stringify(listLog)}, "list\\n");
    return setTimeout(() => send({ jsonrpc: "2.0", id: m.id, result: { sessions: [{ sessionId: ${JSON.stringify(PARENT_ID)}, title: "Listed Parent" }] } }), 40);
  }
  if (m.method === "session/load") {
    const sid = m.params.sessionId;
    fs.appendFileSync(${JSON.stringify(spyLog)}, sid + "\\n");
    if (sid === ${JSON.stringify(PARENT_ID)}) {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Delegate task" } } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call", toolCallId: "cold-tc-1", name: "invoke_subagent", title: "Run invoke_subagent", status: "completed", rawInput: { Role: "Code Researcher", TypeName: "research", Prompt: "Inspect module" } } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call", toolCallId: "cold-tc-failed", name: "invoke_subagent", title: "Run invoke_subagent", status: "failed", rawInput: { Role: "Code Researcher", TypeName: "research", Prompt: "Inspect module" }, rawOutput: "permission denied" } } });
    } else if (sid === ${JSON.stringify(CHILD_ID)}) {
      // Also emit a stray parent session_info_update to verify strict sessionId filtering.
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: ${JSON.stringify(PARENT_ID)}, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "STRAY_PARENT_TEXT" } } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "CHILD_REPLY_TEXT" } } } });
    } else if (sid === ${JSON.stringify(GRANDCHILD_ID)}) {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "GRANDCHILD_REPLY_TEXT" } } } });
    }
    return send({ jsonrpc: "2.0", id: m.id, result: {} });
  }
  return send({ jsonrpc: "2.0", id: m.id, result: {} });
});
`,
    );
    await chmod(peerBin, 0o755);
    vi.stubEnv("GEMINI_HOME", f.root);
    vi.stubEnv("CLOUD_CODE_URL", "http://127.0.0.1:1");
    vi.stubEnv("ANTIGRAVITY_ACP_PATH", peerBin);

    const reader = new AntigravitySessionReader({
      projectPath: f.project,
      sessionsDir: f.conversationsDir,
    });
    try {
      // Unauthorized child belonging to OTHER_PARENT_ID MUST be rejected BEFORE ACP starts.
      expect(
        await reader.getAgentSession(FOREIGN_CHILD_ID, PARENT_ID),
      ).toBeNull();
      expect(await reader.getAgentSession(PARENT_ID, PARENT_ID)).toBeNull();
      expect(await reader.getAgentSession(CHILD_ID)).toBeNull();
      expect(await readFile(spyLog, "utf8").catch(() => "")).toBe("");

      // Before cold getSession, getAgentMappings never spawns ACP.
      expect(await reader.getAgentMappings(PARENT_ID)).toEqual([]);
      expect(await readFile(spyLog, "utf8").catch(() => "")).toBe("");

      // Cold getSession enriches spawn_agent tool_result with verified childId.
      const projectId = toUrlProjectId(f.project);
      const loadedParent = await reader.getSession(PARENT_ID, projectId);
      expect(loadedParent).not.toBeNull();
      const parentMsgs = loadedParent!.data.session.messages;
      const resultMsg = parentMsgs.find((m) => m.uuid === "cold-tc-1:result");
      expect(resultMsg).toBeDefined();
      const block = Array.isArray(resultMsg?.message?.content)
        ? resultMsg.message.content[0]
        : undefined;
      expect(
        block && typeof block === "object" && block.type === "tool_result"
          ? parseSpawnAgentResultId(block.content)
          : undefined,
      ).toBe(CHILD_ID);

      // Now getAgentMappings returns the verified mapping from cached coldReads without another ACP spawn!
      const loadsBeforeMappings = await readFile(spyLog, "utf8");
      expect(await reader.getAgentMappings(PARENT_ID)).toEqual([
        {
          toolUseId: "cold-tc-1",
          agentId: CHILD_ID,
          agentType: "research",
          description: "Code Researcher",
          spawnDepth: 1,
        },
      ]);
      expect(await readFile(spyLog, "utf8")).toBe(loadsBeforeMappings);

      // Running child MUST NOT start a competing ACP session/load; it serves a
      // bounded read-only projection from brain/<childId>/.../transcript.jsonl.
      const loadsBeforeRunningChild = await readFile(spyLog, "utf8");
      const childSession = await reader.getAgentSession(CHILD_ID, PARENT_ID);
      expect(childSession?.status).toBe("running");
      expect(JSON.stringify(childSession?.messages)).toContain(
        "RUNNING_READ_ONLY_PROGRESS",
      );
      expect(await readFile(spyLog, "utf8")).toBe(loadsBeforeRunningChild);

      // Once settled IDLE, child replays via session/load and filters stray parent frames.
      const settleChild = f.db.prepare(
        "UPDATE conversation_summaries SET status = 'CASCADE_RUN_STATUS_IDLE', not_fully_idle = 0 WHERE conversation_id = ?",
      );
      try {
        settleChild.run(CHILD_ID);
      } finally {
        settleChild.finalize();
      }
      const settledChild = await reader.getAgentSession(CHILD_ID, PARENT_ID);
      expect(settledChild?.status).toBe("completed");
      const childText = JSON.stringify(settledChild?.messages);
      expect(childText).toContain("CHILD_REPLY_TEXT");
      expect(childText).not.toContain("STRAY_PARENT_TEXT");

      // Authorized nested grandchild also replays cleanly with completed status.
      const grandchildSession = await reader.getAgentSession(
        GRANDCHILD_ID,
        PARENT_ID,
      );
      expect(grandchildSession?.status).toBe("completed");
      expect(JSON.stringify(grandchildSession?.messages)).toContain(
        "GRANDCHILD_REPLY_TEXT",
      );

      // Reparenting a settled child away BEFORE returning (even when cached in
      // coldReads) or mid-read MUST refuse playback under the old parent!
      const moveChild = f.db.prepare(
        "UPDATE conversation_summaries SET parent_conversation_id = ? WHERE conversation_id = ?",
      );
      try {
        moveChild.run(OTHER_PARENT_ID, CHILD_ID);
      } finally {
        moveChild.finalize();
      }
      const loadsBeforeReparentCheck = await readFile(spyLog, "utf8");
      expect(await reader.getAgentSession(CHILD_ID, PARENT_ID)).toBeNull();
      expect(await readFile(spyLog, "utf8")).toBe(loadsBeforeReparentCheck);

      // Reparenting mid-read (between initial lineage check and session/load)
      // must abort before calling session/load.
      const restoreChild = f.db.prepare(
        "UPDATE conversation_summaries SET parent_conversation_id = ? WHERE conversation_id = ?",
      );
      try {
        restoreChild.run(PARENT_ID, CHILD_ID);
      } finally {
        restoreChild.finalize();
      }
      // Clear coldReads so CHILD_ID would otherwise have to run session/load.
      (
        reader as unknown as { coldReads: Map<string, unknown> }
      ).coldReads.clear();
      const origMetadata = (
        reader as unknown as { metadata(id: string): Promise<unknown> }
      ).metadata.bind(reader);
      const metadataSpy = vi
        .spyOn(
          reader as unknown as { metadata(id: string): Promise<unknown> },
          "metadata",
        )
        .mockImplementationOnce(async (id: string) => {
          const res = await origMetadata(id);
          const reparentMidFlight = f.db.prepare(
            "UPDATE conversation_summaries SET parent_conversation_id = ? WHERE conversation_id = ?",
          );
          try {
            reparentMidFlight.run(OTHER_PARENT_ID, CHILD_ID);
          } finally {
            reparentMidFlight.finalize();
          }
          return res;
        });
      try {
        const loadsBeforeMidFlight = await readFile(spyLog, "utf8");
        expect(await reader.getAgentSession(CHILD_ID, PARENT_ID)).toBeNull();
        expect(await readFile(spyLog, "utf8")).toBe(loadsBeforeMidFlight);
      } finally {
        metadataSpy.mockRestore();
      }

      // Combined 8-read cap MUST apply identically when 8 agent reads precede getSession.
      const agentReadsMap = (
        reader as unknown as { agentReads: Map<string, Promise<unknown>> }
      ).agentReads;
      for (let i = 0; i < 8; i++) {
        agentReadsMap.set(`fake:${i}`, new Promise(() => {}));
      }
      try {
        await expect(reader.getSession(PARENT_ID, projectId)).rejects.toThrow(
          "Too many Antigravity history reads",
        );
      } finally {
        for (let i = 0; i < 8; i++) {
          agentReadsMap.delete(`fake:${i}`);
        }
      }

      // readActiveDirectChildren discovers running direct children independently of tool-call linking.
      const summariesReader = new AntigravitySummariesReader(
        join(f.root, "antigravity-cli", "conversation_summaries.db"),
      );
      try {
        // Restore CHILD_ID under PARENT_ID as IDLE + not_fully_idle = 1.
        const markBusy = f.db.prepare(
          "UPDATE conversation_summaries SET parent_conversation_id = ?, status = 'CASCADE_RUN_STATUS_IDLE', not_fully_idle = 1, killed = 0 WHERE conversation_id = ?",
        );
        try {
          markBusy.run(PARENT_ID, CHILD_ID);
        } finally {
          markBusy.finalize();
        }
        expect(
          summariesReader.readActiveDirectChildren(PARENT_ID),
        ).toMatchObject({
          children: [
            {
              conversationId: CHILD_ID,
              title: "Child Research",
              agentName: "research",
              status: "CASCADE_RUN_STATUS_IDLE",
              notFullyIdle: true,
            },
          ],
          truncated: false,
        });
        // Repeated call on unchanged DB/WAL hits cache (returns identical result object).
        const firstActive = summariesReader.readActiveDirectChildren(PARENT_ID);
        expect(summariesReader.readActiveDirectChildren(PARENT_ID)).toBe(
          firstActive,
        );
        // A status-only index (without parent_conversation_id) MUST NOT bypass
        // the unindexed maxScanRows cap, and bounded cursor continuation MUST
        // discover the running child past the first page and then skip rescanning
        // once the full pass completes for that DB version!
        f.db.exec(
          "CREATE INDEX idx_status_only ON conversation_summaries(status)",
        );
        const page1 = summariesReader.readActiveDirectChildren(PARENT_ID, {
          maxScanRows: 1,
        });
        expect(page1).toMatchObject({
          children: [],
          truncated: true,
          nextCursorRowId: 1,
        });
        let cursor = page1?.nextCursorRowId ?? 0;
        let completedVersion: string | undefined;
        const discovered: string[] = [];
        let pages = 0;
        while (cursor > 0 && pages < 10) {
          pages++;
          const next = summariesReader.readActiveDirectChildren(PARENT_ID, {
            maxScanRows: 1,
            afterRowId: cursor,
          });
          for (const c of next?.children ?? []) {
            discovered.push(c.conversationId);
          }
          if (next?.truncated && next.nextCursorRowId) {
            cursor = next.nextCursorRowId;
          } else {
            completedVersion = next?.versionKey;
            cursor = 0;
          }
        }
        expect(discovered).toEqual([CHILD_ID]);
        expect(completedVersion).toBeTruthy();
        // Passing knownCompletedVersion on an unchanged multi-page DB skips
        // scanning immediately instead of rescanning page 1!
        const skipped = summariesReader.readActiveDirectChildren(PARENT_ID, {
          maxScanRows: 1,
          afterRowId: 0,
          knownCompletedVersion: completedVersion,
        });
        expect(skipped).toEqual({
          children: [],
          truncated: false,
          versionKey: completedVersion,
          skippedUnchanged: true,
        });
        const resetIdle = f.db.prepare(
          "UPDATE conversation_summaries SET status = 'CASCADE_RUN_STATUS_IDLE', not_fully_idle = 0 WHERE conversation_id = ?",
        );
        try {
          resetIdle.run(CHILD_ID);
        } finally {
          resetIdle.finalize();
        }
        expect(
          summariesReader.readActiveDirectChildren(PARENT_ID),
        ).toMatchObject({
          children: [],
          truncated: false,
        });
      } finally {
        summariesReader.close();
      }

      // 12 concurrent getSessionSummary calls MUST coalesce into 1 ACP session/list spawn.
      await Promise.all(
        Array.from({ length: 12 }, () =>
          reader.getSessionSummary(PARENT_ID, projectId),
        ),
      );
      const listCount = (await readFile(listLog, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean).length;
      expect(listCount).toBe(1);

      // Two-store isolation with the SAME UUID:
      // 1. Reader bound to Store B refuses ACP replay when active runtime targets Store A.
      // 2. With GEMINI_HOME set and CLOUD_CODE_URL unset, `agy acp` omits `--gemini-dir`
      //    (opening OS home instead of GEMINI_HOME), so Store A reader MUST also refuse replay!
      const storeB = await createSubagentFixture();
      await writeFile(join(storeB.conversationsDir, `${PARENT_ID}.db`), "p-b");
      await writeFile(join(storeB.conversationsDir, `${CHILD_ID}.db`), "c-b");
      storeB.insert.run(
        PARENT_ID,
        "Store B Parent",
        storeB.projectUri,
        "",
        "",
        0,
        "CASCADE_RUN_STATUS_IDLE",
        0,
        0,
        "2026-11-21 17:00:00+00:00",
      );
      storeB.insert.run(
        CHILD_ID,
        "Store B Child",
        storeB.projectUri,
        "research",
        PARENT_ID,
        1,
        "CASCADE_RUN_STATUS_IDLE",
        0,
        0,
        "2026-11-21 17:01:00+00:00",
      );
      const readerB = new AntigravitySessionReader({
        projectPath: storeB.project,
        sessionsDir: storeB.conversationsDir,
      });
      try {
        const loadsBeforeStoreB = await readFile(spyLog, "utf8");
        expect(await readerB.getAgentSession(CHILD_ID, PARENT_ID)).toBeNull();
        expect(
          await readerB.getSession(PARENT_ID, toUrlProjectId(storeB.project)),
        ).toBeNull();
        expect(await readFile(spyLog, "utf8")).toBe(loadsBeforeStoreB);

        // Resume revalidation across lazy iterator start: authorize Store A in
        // startSession(), switch GEMINI_HOME to Store B before advancing the
        // iterator, and verify run() rejects BEFORE spawning ACP session/load!
        const provider = new AntigravityProvider();
        const physicalStoreA = await realpath(f.conversationsDir);
        const resumed = await provider.startSession({
          cwd: f.project,
          resumeSessionId: PARENT_ID,
          nativeResumeSource: {
            native: nativeSessionRef(
              "antigravity",
              physicalStoreA,
              parseNativeSessionId(PARENT_ID),
            ),
            filePath: join(physicalStoreA, `${PARENT_ID}.db`),
            projectId,
          },
        });
        vi.stubEnv("GEMINI_HOME", storeB.root);
        try {
          const first = await resumed.iterator.next();
          expect(first.value).toMatchObject({
            type: "error",
            error:
              "Antigravity continuation requires its original native store and project",
          });
          expect(await readFile(spyLog, "utf8")).toBe(loadsBeforeStoreB);
        } finally {
          await resumed.abort();
          vi.stubEnv("GEMINI_HOME", f.root);
        }

        // Unset CLOUD_CODE_URL while GEMINI_HOME still points to f.root: `agy`
        // no longer passes `--gemini-dir`, so reader AND live namespace MUST
        // derive the OS-home store (never f.root) and refuse cold replay!
        (
          reader as unknown as { coldReads: Map<string, unknown> }
        ).coldReads.clear();
        vi.stubEnv("CLOUD_CODE_URL", "");
        expect(await reader.getAgentSession(CHILD_ID, PARENT_ID)).toBeNull();
        expect(await readFile(spyLog, "utf8")).toBe(loadsBeforeStoreB);
        const { antigravitySessionsDir } = await import(
          "../../src/sdk/providers/antigravity-runtime.js"
        );
        expect(antigravitySessionsDir()).not.toBe(f.conversationsDir);
        vi.stubEnv("CLOUD_CODE_URL", "http://127.0.0.1:1");
      } finally {
        await readerB.close();
      }

      // Mid-replay store rebind: swapping a symlinked sessionsDir from Store A
      // to Store B during session/load MUST discard the replay (return null)
      // and NEVER cache Store A's messages under Store B!
      const rebindLink = join(f.root, "rebind-conversations");
      await symlink(f.conversationsDir, rebindLink);
      const rebindReader = new AntigravitySessionReader({
        projectPath: f.project,
        sessionsDir: rebindLink,
      });
      try {
        const origMeta = (
          rebindReader as unknown as { metadata(id: string): Promise<unknown> }
        ).metadata.bind(rebindReader);
        let metaCalls = 0;
        const metaSpy = vi
          .spyOn(
            rebindReader as unknown as {
              metadata(id: string): Promise<unknown>;
            },
            "metadata",
          )
          .mockImplementation(async (id: string) => {
            metaCalls++;
            // Call 1 is pre-load metadata(CHILD_ID); Call 2 is post-load metadata(CHILD_ID).
            if (metaCalls === 2) {
              await unlink(rebindLink);
              await symlink(storeB.conversationsDir, rebindLink);
            }
            return origMeta(id);
          });
        try {
          // Make Store B match f.project so post-load metadata(CHILD_ID) resolves in Store B!
          const fixB = storeB.db.prepare(
            "UPDATE conversation_summaries SET workspace_uris = ?",
          );
          try {
            fixB.run(f.projectUri);
          } finally {
            fixB.finalize();
          }
          expect(
            await rebindReader.getAgentSession(CHILD_ID, PARENT_ID),
          ).toBeNull();
          // coldReads MUST NOT contain any entry for Store B!
          expect(
            (rebindReader as unknown as { coldReads: Map<string, unknown> })
              .coldReads.size,
          ).toBe(0);
        } finally {
          metaSpy.mockRestore();
        }

        // Mid-summary store rebind: if the symlink flips from Store A to Store B
        // while nativeList() is in flight, Store A's ACP title ("Listed Parent")
        // MUST be discarded and NEVER combined with Store B's metadata!
        await unlink(rebindLink);
        await symlink(f.conversationsDir, rebindLink);
        const origSummaryMeta = (
          rebindReader as unknown as { metadata(id: string): Promise<unknown> }
        ).metadata.bind(rebindReader);
        let summaryMetaCalls = 0;
        const summaryMetaSpy = vi
          .spyOn(
            rebindReader as unknown as {
              metadata(id: string): Promise<unknown>;
            },
            "metadata",
          )
          .mockImplementation(async (id: string) => {
            summaryMetaCalls++;
            if (summaryMetaCalls === 2) {
              await unlink(rebindLink);
              await symlink(storeB.conversationsDir, rebindLink);
            }
            return origSummaryMeta(id);
          });
        try {
          const reboundSummary = await rebindReader.getSessionSummary(
            PARENT_ID,
            projectId,
          );
          expect(reboundSummary?.title).toBe("Store B Parent");
          expect(reboundSummary?.title).not.toBe("Listed Parent");
        } finally {
          summaryMetaSpy.mockRestore();
        }
      } finally {
        await rebindReader.close();
      }
    } finally {
      await reader.close();
    }
  });

  it("pins ACP launch to the verified physical profile path and advances transcript anchor on ordinary turns through AntigravityProvider", async () => {
    if (process.platform === "win32") return;
    const f = await createSubagentFixture();
    const storeB = await createSubagentFixture();
    const physicalStoreARoot = await realpath(f.root);
    const physicalStoreAConv = await realpath(f.conversationsDir);
    await writeFile(join(f.conversationsDir, `${PARENT_ID}.db`), "parent-a");
    await writeFile(
      join(storeB.conversationsDir, `${PARENT_ID}.db`),
      "parent-b",
    );
    f.insert.run(
      PARENT_ID,
      "Parent A",
      f.projectUri,
      "",
      "",
      0,
      "CASCADE_RUN_STATUS_IDLE",
      0,
      0,
      "2026-11-21 17:00:00+00:00",
    );

    // Mutable symlink profileLink -> storeA; ACP launch MUST receive the
    // resolved physicalStoreARoot in --gemini-dir and GEMINI_HOME even if
    // profileLink is later rebound to storeB!
    const profileLink = join(f.root, "mutable-profile-link");
    await symlink(f.root, profileLink);
    const argvLog = join(f.root, "pinned-argv.json");
    const brainTranscript = join(
      f.brainDir,
      PARENT_ID,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    await mkdir(join(f.brainDir, PARENT_ID, ".system_generated", "logs"), {
      recursive: true,
    });

    const mockAgy = join(f.root, "agy");
    await writeFile(
      mockAgy,
      `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify({ argv: process.argv.slice(2), geminiHome: process.env.GEMINI_HOME }));
const send = (v) => process.stdout.write(JSON.stringify(v) + "\\n");
let turn = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentInfo: { version: "1.5.14" } } });
  }
  if (m.method === "session/new" || m.method === "session/load") {
    return send({ jsonrpc: "2.0", id: m.id, result: { sessionId: ${JSON.stringify(PARENT_ID)}, models: { currentModelId: "m1", availableModels: [{ modelId: "m1", name: "M1" }] }, modes: { currentModeId: "default", availableModes: [{ id: "default" }] } } });
  }
  if (m.method === "session/prompt") {
    turn++;
    const sid = m.params.sessionId;
    if (turn === 1) {
      // Prompt 1 (initial): ordinary prompt with NO subagents; emit progress chunk FIRST
      // (before USER_INPUT has even been written!), then flush USER_INPUT AND
      // >4.3 MiB of response output TOGETHER, then signal ready-for-steer so
      // controls.steer() captures startByte at ~4.3 MiB before Prompt 2 flushes!
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Ordinary reply" } } } });
      setTimeout(() => {
        fs.appendFileSync(
          ${JSON.stringify(brainTranscript)},
          JSON.stringify({ step_index: 0, type: "USER_INPUT", status: "DONE", content: "Ordinary turn 1" }) + "\\n" +
          JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", content: "x".repeat(4_300_000) }) + "\\n",
        );
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " READY_FOR_STEER" } } } });
        setTimeout(() => {
          send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
        }, 40);
      }, 40);
      return;
    }
    if (turn === 2) {
      // Prompt 2 (steer submitted mid-Turn 1): ALSO flushes USER_INPUT + >4.3 MiB
      // together after progress, testing that controls.steer() captures startByte!
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Steer reply" } } } });
      setTimeout(() => {
        fs.appendFileSync(
          ${JSON.stringify(brainTranscript)},
          JSON.stringify({ step_index: 2, type: "USER_INPUT", status: "DONE", content: "Steered turn 1" }) + "\\n" +
          JSON.stringify({ step_index: 3, type: "PLANNER_RESPONSE", status: "DONE", content: "z".repeat(4_300_000) }) + "\\n",
        );
        send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
      }, 100);
      return;
    }
    if (turn === 3) {
      // Turn 2: spawns CHILD_ID via invoke_subagent (ACP strips rawOutput ID).
      fs.appendFileSync(${JSON.stringify(brainTranscript)}, JSON.stringify({ step_index: 4, type: "USER_INPUT", status: "DONE", content: "Spawn child turn 2" }) + "\\n");
      fs.appendFileSync(${JSON.stringify(brainTranscript)}, JSON.stringify({ step_index: 5, type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "invoke_subagent", args: { Role: "\\"Tail Researcher\\"", TypeName: "\\"research\\"", Prompt: "\\"Check tail\\"" } }] }) + "\\n");
      fs.appendFileSync(${JSON.stringify(brainTranscript)}, JSON.stringify({ step_index: 6, type: "GENERIC", status: "DONE", content: "Created the following subagent:\\n{\\"conversationId\\":\\"${CHILD_ID}\\"}" }) + "\\n");
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call", toolCallId: "t2-sub-1", name: "invoke_subagent", title: "Run invoke_subagent", status: "in_progress", rawInput: { Role: "Tail Researcher", TypeName: "research", Prompt: "Check tail" } } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call_update", toolCallId: "t2-sub-1", status: "completed", rawOutput: "" } } });
      return send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
    }
  }
  return send({ jsonrpc: "2.0", id: m.id, result: {} });
});
`,
    );
    await chmod(mockAgy, 0o755);
    vi.stubEnv("GEMINI_HOME", profileLink);
    vi.stubEnv("CLOUD_CODE_URL", "http://127.0.0.1:1");
    vi.stubEnv("ANTIGRAVITY_ACP_PATH", mockAgy);

    const provider = new AntigravityProvider();
    const projectId = toUrlProjectId(f.project);
    const session = await provider.startSession({
      cwd: f.project,
      resumeSessionId: PARENT_ID,
      nativeResumeSource: {
        native: nativeSessionRef(
          "antigravity",
          physicalStoreAConv,
          parseNativeSessionId(PARENT_ID),
        ),
        filePath: join(physicalStoreAConv, `${PARENT_ID}.db`),
        projectId,
      },
      initialMessage: { text: "Ordinary turn 1" },
    });
    const iter = session.iterator;
    try {
      // Wait for Turn 1 (including a delayed-flush steering prompt!) to finish.
      let turn1Done = false;
      let steered = false;
      while (!turn1Done) {
        const next = await iter.next();
        if (next.done) break;
        if (
          !steered &&
          next.value.type === "assistant" &&
          JSON.stringify(next.value.message?.content ?? "").includes(
            "READY_FOR_STEER",
          )
        ) {
          steered = true;
          expect(await session.steer?.({ text: "Steered turn 1" })).toBe(true);
        }
        if (next.value.type === "result") turn1Done = true;
      }
      expect(steered).toBe(true);
      // Verify ACP was spawned with the PINNED physical path (NOT profileLink)!
      const launched = JSON.parse(await readFile(argvLog, "utf8")) as {
        argv: string[];
        geminiHome: string;
      };
      const flagIdx = launched.argv.indexOf("--gemini-dir");
      expect(flagIdx).toBeGreaterThanOrEqual(0);
      expect(launched.argv[flagIdx + 1]).toBe(physicalStoreARoot);
      expect(launched.geminiHome).toBe(physicalStoreARoot);

      // Rebinding profileLink to storeB after launch has zero effect on the
      // already-pinned runtime or Turn 2's anchor/linking.
      await unlink(profileLink);
      await symlink(storeB.root, profileLink);

      // Submit Turn 2 after Turn 1 pushed step 0 beyond the 4 MiB tail budget!
      session.queue.push({ text: "Spawn child turn 2" });
      let linkedChildId: string | undefined;
      let turn2Done = false;
      while (!turn2Done) {
        const next = await iter.next();
        if (next.done) break;
        const msg = next.value;
        if (
          msg.uuid === "t2-sub-1:result" &&
          Array.isArray(msg.message?.content)
        ) {
          const blk = msg.message.content[0];
          if (blk && typeof blk === "object" && blk.type === "tool_result") {
            linkedChildId = parseSpawnAgentResultId(blk.content);
          }
        }
        if (msg.type === "result") turn2Done = true;
      }
      expect(linkedChildId).toBe(CHILD_ID);
    } finally {
      await session.abort();
    }

    // Symlink BELOW the profile directory (`<profile>/antigravity-cli` ->
    // differently named directory) CANNOT be pinned via `--gemini-dir`, so
    // AntigravityProvider MUST reject the launch before spawning ACP!
    const nestedProfile = join(f.root, "nested-symlink-profile");
    const altStoreTarget = join(f.root, "alt-store-target");
    await mkdir(join(altStoreTarget, "conversations"), { recursive: true });
    await writeFile(
      join(altStoreTarget, "conversations", `${PARENT_ID}.db`),
      "alt-parent",
    );
    await mkdir(nestedProfile, { recursive: true });
    await symlink(altStoreTarget, join(nestedProfile, "antigravity-cli"));
    const physicalAltConv = await realpath(
      join(altStoreTarget, "conversations"),
    );
    const rejectedArgvLog = join(f.root, "should-not-spawn.json");
    const rejectMockAgy = join(f.root, "reject-bin", "agy");
    await mkdir(join(f.root, "reject-bin"), { recursive: true });
    await writeFile(
      rejectMockAgy,
      `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(rejectedArgvLog)}, "spawned");
process.exit(0);
`,
    );
    await chmod(rejectMockAgy, 0o755);
    vi.stubEnv("GEMINI_HOME", nestedProfile);
    vi.stubEnv("ANTIGRAVITY_ACP_PATH", rejectMockAgy);
    const unpinnable = await provider.startSession({
      cwd: f.project,
      resumeSessionId: PARENT_ID,
      nativeResumeSource: {
        native: nativeSessionRef(
          "antigravity",
          physicalAltConv,
          parseNativeSessionId(PARENT_ID),
        ),
        filePath: join(physicalAltConv, `${PARENT_ID}.db`),
        projectId,
      },
    });
    try {
      const first = await unpinnable.iterator.next();
      expect(first.value).toMatchObject({
        type: "error",
        error:
          "Antigravity continuation requires its original native store and project",
      });
      expect(await readFile(rejectedArgvLog, "utf8").catch(() => "")).toBe("");
    } finally {
      await unpinnable.abort();
    }
  });
});
