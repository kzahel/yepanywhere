// Synthetic Claude transcripts and Codex rollouts for the active-session
// repro (plan 190's scenario), shaped after current provider output on the
// maintainer's host (Claude Code 2.1.3xx, Codex 0.16x):
//
// - Claude: rows chained by parentUuid; an assistant message split over
//   several rows sharing `message.id` (thinking, text, tool use); the
//   metadata rows Claude Code interleaves (queue-operation, last-prompt,
//   custom-title, mode, api-request, attachments, stop-hook summaries); and
//   compactions as a compact_boundary root (with `logicalParentUuid` and
//   `preservedSegment`) followed by a compact summary.
// - Codex: a session_meta head; per turn task_started, turn_context, the user
//   message as a response item and an `item_completed` UserMessage, reasoning,
//   commentary, `custom_tool_call` and its output beside a CommandExecution
//   item, token records, a final answer and task_complete; compactions as a
//   `compacted` item (replacement history with user and developer messages
//   and an encrypted `compaction` item, window ids) and a ContextCompaction
//   item.
//
// A long session is a sequence of writes, each a few rows as a provider
// appends them during a turn: a prompt, a tool call, its result, an answer.
// Visible writes carry a marker `mk<n>z` (n is the write's number) so a tab
// can report when that write became visible. A compaction is not a write
// number and is only taken between turns (`atTurnStart`).

/** Bump when generated content changes, so cached seeds are rebuilt. */
export const GENERATOR_VERSION = 2;

const pad = (n, width) => String(n).padStart(width, "0");

/** Deterministic filler text of roughly `bytes` bytes. */
function prose(bytes, seed) {
  const words = [
    "parser",
    "token",
    "branch",
    "commit",
    "index",
    "buffer",
    "window",
    "render",
    "socket",
    "stream",
    "worker",
    "cache",
  ];
  const out = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const word = words[(seed * 7 + i * 13) % words.length];
    out.push(word);
    size += word.length + 1;
  }
  return out.join(" ");
}

/** Base64-like opaque text, as encrypted reasoning and signatures are. */
const opaque = (bytes, seed) =>
  `gAAAAA${prose(bytes, seed).replaceAll(" ", "")}`.slice(0, bytes);

function toolOutput(lines, turn) {
  return Array.from(
    { length: lines },
    (_, i) =>
      `src/parser-${turn % 50}.ts:${i + 1}: const node${i} = parse(input${i}, { strict: true, offset: ${i * 17} });`,
  ).join("\n");
}

function answer(turn, marker, bytes) {
  return `## Turn ${turn} ${marker}\n\nThe failing case is an **empty input**. Changed \`parse\` to return early:\n\n\`\`\`ts\nif (input.length === 0) return [];\n\`\`\`\n\n- updated src/parser-${turn % 50}.ts\n- added a test\n\n${prose(bytes, turn)}`;
}

/**
 * A Claude session as successive writes. `next(at)` returns the next write's
 * serialized rows and its marker (null for a tool result, which a session page
 * folds into its call); `compact(at)` returns a compaction's rows.
 */
export function claudeSession({
  sessionId,
  projectPath,
  resultLines = 190,
  answerBytes = 1200,
}) {
  const base = {
    isSidechain: false,
    userType: "external",
    entrypoint: "sdk-ts",
    cwd: projectPath,
    sessionId,
    version: "2.1.318",
    gitBranch: "main",
  };
  let write = 0;
  let rowSeq = 0;
  let tip = null;
  let compactions = 0;
  const recent = [];
  const iso = (at) => new Date(at).toISOString();
  /** A row in the conversation chain. */
  const row = (fields, at) => {
    const seq = rowSeq++;
    const uuid = `${sessionId.slice(0, 8)}-${pad(seq % 10000, 4)}-4000-8000-${pad(seq, 12)}`;
    const value = {
      parentUuid: tip,
      ...base,
      ...fields,
      uuid,
      timestamp: iso(at),
    };
    tip = uuid;
    recent.push(uuid);
    if (recent.length > 3) recent.shift();
    return JSON.stringify(value);
  };
  /** A metadata row outside the chain. */
  const meta = (fields) => JSON.stringify({ ...fields, sessionId });
  const assistant = (n, at, blocks, stopReason) =>
    blocks.map((block) =>
      row(
        {
          type: "assistant",
          requestId: `req_${sessionId.slice(0, 8)}_${n}`,
          message: {
            id: `msg_${sessionId.slice(0, 8)}_${n}`,
            type: "message",
            role: "assistant",
            model: "claude-opus-5-5",
            content: [block],
            stop_reason: stopReason,
            usage: {
              input_tokens: 6,
              cache_read_input_tokens: 90000 + (n % 1000),
              output_tokens: 400,
            },
          },
        },
        at,
      ),
    );
  const apiRequest = (n, at) =>
    meta({
      type: "api-request",
      id: `${sessionId.slice(0, 8)}-api-${n}`,
      timestamp: iso(at),
      version: base.version,
      querySource: "sdk",
      params: {
        model: "claude-opus-5-5",
        max_tokens: 128000,
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "high" },
      },
      tail: [opaque(64, n), opaque(64, n + 1)],
    });
  return {
    next(at) {
      const n = write++;
      const turn = Math.floor(n / 4);
      const marker = `mk${n}z`;
      const step = n % 4;
      const callId = `toolu_${sessionId.slice(0, 8)}_${turn}`;
      if (step === 0) {
        const prompt = `Turn ${turn} ${marker}: check the parser in src/parser-${turn % 50}.ts and fix the failing case.`;
        const rows = [
          meta({
            type: "queue-operation",
            operation: "enqueue",
            timestamp: iso(at),
            content: prompt,
          }),
          row({ type: "user", message: { role: "user", content: prompt } }, at),
          row(
            {
              type: "attachment",
              attachment: { type: "date", date: iso(at).slice(0, 10) },
              rendered: [
                {
                  content: `<system-reminder>\nToday's date is ${iso(at).slice(0, 10)}.\n</system-reminder>`,
                },
              ],
              renderedRole: "system",
            },
            at,
          ),
        ];
        return {
          marker,
          rows: [
            ...rows,
            meta({ type: "last-prompt", lastPrompt: prompt, leafUuid: tip }),
            meta({ type: "custom-title", customTitle: "Parser fixes" }),
            meta({ type: "mode", mode: "normal" }),
            meta({ type: "atis-latch", atis: "" }),
            apiRequest(n, at),
          ],
        };
      }
      if (step === 1)
        return {
          marker,
          rows: assistant(
            n,
            at,
            [
              {
                type: "thinking",
                thinking: `Looking at parser ${turn % 50}.`,
                signature: opaque(600, n),
              },
              { type: "text", text: `Reading the parser first ${marker}.` },
              {
                type: "tool_use",
                id: callId,
                name: "Bash",
                input: {
                  command: `rg -n "parse" src/parser-${turn % 50}.ts`,
                  description: "Find parse calls",
                },
              },
            ],
            "tool_use",
          ),
        };
      if (step === 2) {
        const output = toolOutput(resultLines, turn);
        return {
          marker: null,
          rows: [
            row(
              {
                type: "user",
                message: {
                  role: "user",
                  content: [
                    {
                      type: "tool_result",
                      tool_use_id: callId,
                      content: output,
                    },
                  ],
                },
                toolUseResult: {
                  stdout: output,
                  stderr: "",
                  interrupted: false,
                  isImage: false,
                },
                sourceToolAssistantUUID: tip,
              },
              at,
            ),
            apiRequest(n, at),
          ],
        };
      }
      return {
        marker,
        rows: [
          ...assistant(
            n,
            at,
            [
              {
                type: "thinking",
                thinking: "Summarizing the fix.",
                signature: opaque(400, n),
              },
              { type: "text", text: answer(turn, marker, answerBytes) },
            ],
            "end_turn",
          ),
          row(
            {
              type: "system",
              subtype: "stop_hook_summary",
              hookCount: 1,
              hookInfos: [{ command: "callback" }],
              hookErrors: [],
              preventedContinuation: false,
              stopReason: "",
              hasOutput: false,
              level: "suggestion",
            },
            at,
          ),
        ],
      };
    },
    /** True between turns, where a compaction may be taken. */
    get atTurnStart() {
      return write % 4 === 0;
    },
    /** A compact boundary (a new root pointing back logically) and its summary. */
    compact(at) {
      compactions++;
      const logicalParentUuid = tip;
      const [headUuid, anchorUuid, tailUuid] = recent;
      tip = null;
      const boundary = row(
        {
          type: "system",
          subtype: "compact_boundary",
          content: "Conversation compacted",
          isMeta: false,
          level: "info",
          logicalParentUuid,
          compactMetadata: {
            trigger: "auto",
            preTokens: 180000,
            durationMs: 60000,
            preservedSegment: { headUuid, anchorUuid, tailUuid },
          },
        },
        at,
      );
      const summary = row(
        {
          type: "user",
          isCompactSummary: true,
          isVisibleInTranscriptOnly: true,
          message: {
            role: "user",
            content: `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n${prose(6000, compactions)}`,
          },
        },
        at,
      );
      return [boundary, summary];
    },
    get writes() {
      return write;
    },
  };
}

/** Codex session id (UUIDv7-shaped) and rollout path for session `n`. */
export function codexRollout(n, startedAt) {
  const id = `019a${pad(Math.floor(n / 65536) % 65536, 4)}-${pad(n % 10000, 4)}-7000-8000-${pad(n, 12)}`;
  const date = new Date(startedAt).toISOString();
  const dir = `${date.slice(0, 4)}/${date.slice(5, 7)}/${date.slice(8, 10)}`;
  const stamp = date.slice(0, 19).replaceAll(":", "-");
  return { id, relativePath: `${dir}/rollout-${stamp}-${id}.jsonl` };
}

/** A Codex rollout as successive writes, after its session_meta head. */
export function codexSession({
  sessionId,
  projectPath,
  resultLines = 160,
  answerBytes = 1200,
}) {
  let write = 0;
  let compactions = 0;
  let windowId = `${sessionId.slice(0, 8)}-0000-7000-a000-000000000000`;
  const userTexts = [];
  const short = sessionId.slice(0, 8);
  const iso = (at) => new Date(at).toISOString();
  const line = (at, type, payload) =>
    JSON.stringify({ timestamp: iso(at), type, payload });
  const turnId = (turn) =>
    `${short}-${pad(turn % 10000, 4)}-7000-9000-${pad(turn, 12)}`;
  const item = (at, turn, value) =>
    line(at, "event_msg", {
      type: "item_completed",
      thread_id: sessionId,
      turn_id: turnId(turn),
      item: value,
      started_at_ms: at - 500,
      completed_at_ms: at,
    });
  const usage = (n) => ({
    input_tokens: 30000 + (n % 1000),
    cached_input_tokens: 28000,
    cache_write_input_tokens: 0,
    output_tokens: 400,
    reasoning_output_tokens: 64,
    total_tokens: 30400 + (n % 1000),
  });
  const usageRecord = (at, n, turn) =>
    line(at, "token_usage_record", {
      thread_id: sessionId,
      turn_id: turnId(turn),
      session_id: sessionId,
      root_turn_id: turnId(turn),
      response_id: `resp_${short}_${n}`,
      usage: usage(n),
      turn_token_usage: usage(n * 3),
      thread_token_usage: usage(n * 7),
    });
  const tokenCount = (at, n) =>
    line(at, "event_msg", {
      type: "token_count",
      info: {
        total_token_usage: usage(n * 7),
        last_token_usage: usage(n),
        model_context_window: 258400,
      },
      rate_limits: {
        limit_id: "codex",
        primary: { used_percent: 12.0, window_minutes: 10080, resets_at: 0 },
        secondary: null,
        plan_type: "pro",
      },
    });
  const passthrough = (turn) => ({
    internal_chat_message_metadata_passthrough: {
      turn_id: turnId(turn),
      create_time: turn,
    },
  });
  return {
    head(at) {
      return line(at, "session_meta", {
        id: sessionId,
        session_id: sessionId,
        timestamp: iso(at),
        cwd: projectPath,
        originator: "codex_cli_rs",
        cli_version: "0.167.0",
        source: "cli",
        model_provider: "openai",
        base_instructions: { text: prose(4000, 1) },
      });
    },
    next(at) {
      const n = write++;
      const turn = Math.floor(n / 4);
      const marker = `mk${n}z`;
      const step = n % 4;
      const id = turnId(turn);
      const callId = `call_${short}_${turn}`;
      if (step === 0) {
        const text = `Turn ${turn} ${marker}: check the parser in src/parser-${turn % 50}.ts and fix the failing case.`;
        userTexts.push(text);
        if (userTexts.length > 12) userTexts.shift();
        return {
          marker,
          rows: [
            line(at, "event_msg", {
              type: "task_started",
              turn_id: id,
              root_turn_id: id,
              started_at: Math.floor(at / 1000),
              model_context_window: 258400,
              collaboration_mode_kind: "default",
            }),
            line(at, "turn_context", {
              turn_id: id,
              root_turn_id: id,
              cwd: projectPath,
              workspace_roots: [projectPath],
              current_date: iso(at).slice(0, 10),
              approval_policy: "never",
              sandbox_policy: { type: "danger-full-access" },
              model: "gpt-6.1",
              effort: "high",
              summary: "auto",
            }),
            line(at, "response_item", {
              type: "message",
              id: `msg_${short}_u${turn}`,
              role: "user",
              content: [{ type: "input_text", text }],
              ...passthrough(turn),
            }),
            item(at, turn, {
              type: "UserMessage",
              id: `${short}-user-${turn}`,
              content: [{ type: "text", text, text_elements: [] }],
            }),
          ],
        };
      }
      if (step === 1) {
        const commentary = `Reading the parser first ${marker}.`;
        const input = `text(await tools.exec_command({cmd:"rg -n 'parse' src/parser-${turn % 50}.ts"}));`;
        return {
          marker,
          rows: [
            item(at, turn, {
              type: "Reasoning",
              id: `rs_${short}_${turn}`,
              summary_text: [`**Reading parser ${turn % 50}**`],
              raw_content: [],
            }),
            line(at, "response_item", {
              type: "reasoning",
              id: `rs_${short}_${turn}`,
              summary: [
                {
                  type: "summary_text",
                  text: `**Reading parser ${turn % 50}**`,
                },
              ],
              encrypted_content: opaque(3600, turn),
              ...passthrough(turn),
            }),
            item(at, turn, {
              type: "AgentMessage",
              id: `msg_${short}_c${turn}`,
              content: [{ type: "Text", text: commentary }],
              phase: "commentary",
            }),
            line(at, "response_item", {
              type: "message",
              id: `msg_${short}_c${turn}`,
              role: "assistant",
              content: [{ type: "output_text", text: commentary }],
              phase: "commentary",
              ...passthrough(turn),
            }),
            line(at, "response_item", {
              type: "custom_tool_call",
              id: `ctc_${short}_${turn}`,
              status: "completed",
              call_id: callId,
              name: "exec",
              input,
              ...passthrough(turn),
            }),
            usageRecord(at, n, turn),
          ],
        };
      }
      if (step === 2) {
        const output = toolOutput(resultLines, turn);
        return {
          marker: null,
          rows: [
            item(at, turn, {
              type: "CommandExecution",
              id: `exec-${short}-${turn}`,
              process_id: String(1000 + (turn % 9000)),
              command: [
                "/bin/bash",
                "-lc",
                `rg -n 'parse' src/parser-${turn % 50}.ts`,
              ],
              cwd: `file://${projectPath}`,
              parsed_cmd: [
                {
                  type: "search",
                  cmd: `rg -n 'parse' src/parser-${turn % 50}.ts`,
                  query: "parse",
                  path: `src/parser-${turn % 50}.ts`,
                },
              ],
              source: "unified_exec_startup",
              status: "completed",
              stdout: output,
              stderr: "",
              aggregated_output: output,
              exit_code: 0,
            }),
            line(at, "response_item", {
              type: "custom_tool_call_output",
              id: `ctco_${short}_${turn}`,
              call_id: callId,
              output: [
                {
                  type: "input_text",
                  text: "Script completed\nWall time 0.4 seconds\nOutput:\n",
                },
                {
                  type: "input_text",
                  text: JSON.stringify({
                    chunk_id: pad(turn, 6),
                    wall_time_seconds: 0.04,
                    exit_code: 0,
                    output,
                  }),
                },
              ],
              ...passthrough(turn),
            }),
            tokenCount(at, n),
          ],
        };
      }
      const text = answer(turn, marker, answerBytes);
      return {
        marker,
        rows: [
          item(at, turn, {
            type: "AgentMessage",
            id: `msg_${short}_a${turn}`,
            content: [{ type: "Text", text }],
            phase: "final_answer",
          }),
          line(at, "response_item", {
            type: "message",
            id: `msg_${short}_a${turn}`,
            role: "assistant",
            content: [{ type: "output_text", text }],
            phase: "final_answer",
            ...passthrough(turn),
          }),
          usageRecord(at, n, turn),
          tokenCount(at, n),
          line(at, "event_msg", {
            type: "task_complete",
            turn_id: id,
            last_agent_message: text,
            started_at: Math.floor(at / 1000) - 4,
            completed_at: Math.floor(at / 1000),
            duration_ms: 4000,
          }),
        ],
      };
    },
    /** True between turns, where a compaction may be taken. */
    get atTurnStart() {
      return write % 4 === 0;
    },
    /** A compaction: the replacement history keeps recent user turns. */
    compact(at) {
      compactions++;
      const previous = windowId;
      windowId = `${short}-${pad(compactions % 10000, 4)}-7000-a000-${pad(compactions, 12)}`;
      const turn = Math.max(0, Math.floor(write / 4) - 1);
      return [
        line(at, "compacted", {
          message: "",
          replacement_history: [
            ...userTexts.map((text, i) => ({
              type: "message",
              id: `msg_${short}_r${compactions}_${i}`,
              role: "user",
              content: [{ type: "input_text", text }],
            })),
            {
              type: "message",
              id: `msg_${short}_d${compactions}`,
              role: "developer",
              content: [
                { type: "input_text", text: prose(12000, compactions) },
              ],
            },
            {
              type: "compaction",
              id: `cmp_${short}_${compactions}`,
              encrypted_content: opaque(45000, compactions),
            },
          ],
          window_number: compactions,
          previous_window_id: previous,
          window_id: windowId,
          compaction_response_id: `resp_${short}_cmp${compactions}`,
        }),
        item(at, turn, {
          type: "ContextCompaction",
          id: `${short}-compaction-${compactions}`,
        }),
      ];
    },
    get writes() {
      return write;
    },
  };
}
