import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadSqliteDriver } from "../../src/storage/sqlite.js";
import { writeAntigravitySummaries } from "./antigravity-store.js";

/**
 * Writes a synthetic `agy` conversation at any size for plan 195's scale
 * target (about 500 MB and 100,000 steps). Record keys, key order, field
 * types, tool pairing, background launches and their wakes, truncation
 * markers and step skips copy what real `agy` 1.5.13 and 1.5.14 write; see
 * topics/antigravity-native-storage.md. The file always ends on a complete
 * tool group unless interrupted groups are requested.
 * Text is filler. Real `agy` cannot load the result: the conversation
 * database holds only the plain `idx`, `step_type` and `status` columns.
 */
export interface AntigravityScaleOptions {
  /** The `antigravity-cli` directory. */
  store: string;
  id: string;
  cwd: string;
  /** Database steps, including the few the log skips. */
  steps: number;
  /** Approximate size of `transcript_full.jsonl`. */
  targetBytes: number;
  /** Steps between compaction checkpoints; 0 for none. */
  checkpointEvery?: number;
  /** Steps between interrupted planner steps the log omits; 0 for none. */
  skipEvery?: number;
  /**
   * Steps between interrupted tool groups: a planner record with k calls
   * followed by fewer than k results and then the next turn's USER_INPUT,
   * the missing results being database-only steps. 0 (default) for none.
   */
  interruptedGroupEvery?: number;
  /** Also write the shortened `transcript.jsonl` (default true). */
  shortLog?: boolean;
  /** Replace the store's summaries index with this conversation (default true). */
  summaries?: boolean;
  seed?: number;
}

export interface AntigravityScaleResult {
  fullPath: string;
  shortPath?: string;
  fullBytes: number;
  shortBytes: number;
  records: number;
  checkpoints: number;
  skipped: number[];
  /** Groups whose last `calls - logged` results are database-only. */
  interruptedGroups: Array<{ planner: number; calls: number; logged: number }>;
  wakes: number;
  lastStep: number;
}

/** Database `step_type` per log `type`, as observed (not decoded). */
export const ANTIGRAVITY_STEP_TYPES = {
  USER_INPUT: 14,
  PLANNER_RESPONSE: 15,
  ERROR_MESSAGE: 17,
  CHECKPOINT: 23,
  SYSTEM_MESSAGE: 101,
  GENERIC: 132,
} as const;

// The log's DONE records sit on database status 3; omitted steps on 6.
const DONE_STATUS = 3;
const INTERRUPTED_STATUS = 6;
const TRUNCATE_ABOVE = 4096;
const SYSTEM_PREFIX =
  "The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n";
const TRUNCATE_KEEP = 2048;

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCABULARY = (() => {
  const words =
    "the agent read file line function returns value test passes change server client session history step tool result native log record build error".split(
      " ",
    );
  const random = prng(7);
  let text = "";
  while (text.length < 1 << 17) {
    text += words[Math.floor(random() * words.length)];
    text += random() < 0.08 ? "\n" : " ";
  }
  return text;
})();

function timestamp(base: number, step: number): string {
  return new Date(base + step * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function shorten(record: Record<string, unknown>): Record<string, unknown> {
  const truncated: string[] = [];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && value.length > TRUNCATE_ABOVE) {
      const head = value.slice(0, TRUNCATE_KEEP);
      const tail = value.slice(-TRUNCATE_KEEP);
      const removed =
        Buffer.byteLength(value) -
        Buffer.byteLength(head) -
        Buffer.byteLength(tail);
      out[key] = `${head}\n<truncated ${removed} bytes>\n${tail}`;
      truncated.push(key);
    } else out[key] = value;
  }
  if (truncated.length) out.truncated_fields = truncated;
  return out;
}

class Sink {
  private parts: string[] = [];
  private size = 0;
  bytes = 0;
  private constructor(
    private readonly file: Awaited<ReturnType<typeof open>>,
  ) {}
  static async open(path: string): Promise<Sink> {
    return new Sink(await open(path, "w"));
  }
  async write(line: string): Promise<void> {
    this.parts.push(line);
    this.size += line.length;
    if (this.size >= 1 << 22) await this.flush();
  }
  async flush(): Promise<void> {
    if (!this.parts.length) return;
    const buffer = Buffer.from(this.parts.join(""), "utf8");
    this.parts = [];
    this.size = 0;
    this.bytes += buffer.length;
    await this.file.write(buffer);
  }
  async close(): Promise<void> {
    await this.flush();
    await this.file.close();
  }
}

export async function writeAntigravityScaleConversation(
  options: AntigravityScaleOptions,
): Promise<AntigravityScaleResult> {
  const random = prng(options.seed ?? 195);
  const checkpointEvery = options.checkpointEvery ?? 2000;
  const skipEvery = options.skipEvery ?? 25_000;
  const interruptedGroupEvery = options.interruptedGroupEvery ?? 0;
  const logs = join(
    options.store,
    "brain",
    options.id,
    ".system_generated",
    "logs",
  );
  await mkdir(logs, { recursive: true });
  await mkdir(join(options.store, "conversations"), { recursive: true });
  const fullPath = join(logs, "transcript_full.jsonl");
  const shortPath =
    options.shortLog === false ? undefined : join(logs, "transcript.jsonl");
  const full = await Sink.open(fullPath);
  const short = shortPath ? await Sink.open(shortPath) : undefined;
  // Fixed fields plus filler: about 260 bytes per record before filler.
  const filler = Math.max(
    16,
    options.targetBytes / Math.max(1, options.steps) - 260,
  );
  let cursor = 0;
  // Steers the filler so the full log lands near targetBytes.
  let written = 0;
  let correction = 1;
  const text = (marker: string, scale = 1): string => {
    const length = Math.floor(
      filler * correction * scale * (0.2 + 1.6 * random()),
    );
    if (cursor + length > VOCABULARY.length) cursor = 0;
    const body = VOCABULARY.slice(cursor, cursor + length);
    cursor += length;
    return `${marker} ${body}`;
  };
  const base = Date.UTC(2026, 10, 1);
  const types: Array<[number, number, number]> = [];
  const skipped: number[] = [];
  const interruptedGroups: AntigravityScaleResult["interruptedGroups"] = [];
  let wakes = 0;
  let checkpoints = 0;
  let records = 0;
  let step = 0;
  const emit = async (record: Record<string, unknown>, type: number) => {
    types.push([step, type, DONE_STATUS]);
    const line = `${JSON.stringify(record)}\n`;
    written += line.length;
    await full.write(line);
    if (short) await short.write(`${JSON.stringify(shorten(record))}\n`);
    records++;
    step++;
  };
  const head = (type: string, source: string, status = "DONE") => ({
    step_index: step,
    source,
    type,
    status,
    created_at: timestamp(base, step),
  });
  const usage = () => ({
    model: "gemini-3.1-pro-low",
    input_tokens: 1000 + Math.floor(random() * 9000),
    cache_read_tokens: Math.floor(random() * 500_000),
    output_tokens: 10 + Math.floor(random() * 2000),
  });
  const taskLog = (task: string) =>
    `file://${options.store}/brain/${options.id}/.system_generated/tasks/${task}.log`;
  const remaining = () => options.steps - step;
  let turn = 0;
  let nextSkip = skipEvery;
  let nextInterrupted = interruptedGroupEvery || Number.POSITIVE_INFINITY;
  while (remaining() > 0) {
    turn++;
    if (step > 0)
      correction = Math.min(
        4,
        Math.max(
          0.25,
          (correction * (options.targetBytes * step)) /
            (options.steps * written),
        ),
      );
    await emit(
      {
        ...head("USER_INPUT", "USER_EXPLICIT"),
        content: `<USER_REQUEST>\n${text(`TURN_${turn}_PROMPT STEP_${step}`, 0.2)}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: ${timestamp(base, step)}.\n</ADDITIONAL_METADATA>`,
      },
      ANTIGRAVITY_STEP_TYPES.USER_INPUT,
    );
    if (random() < 0.3 && remaining() > 0)
      await emit(
        {
          ...head("SYSTEM_MESSAGE", "SYSTEM"),
          content: `${SYSTEM_PREFIX}${text(`STEP_${step} Reminder:`, 0.5)}\n</SYSTEM_MESSAGE>`,
        },
        ANTIGRAVITY_STEP_TYPES.SYSTEM_MESSAGE,
      );
    const tasks: Array<{ task: string; command: string }> = [];
    let interrupted = false;
    const rounds = 1 + Math.floor(random() * 6);
    for (let round = 0; round < rounds && remaining() > 0; round++) {
      if (skipEvery > 0 && step >= nextSkip) {
        nextSkip += skipEvery;
        // An interrupted planner step: in the database, never in the log.
        types.push([
          step,
          ANTIGRAVITY_STEP_TYPES.PLANNER_RESPONSE,
          INTERRUPTED_STATUS,
        ]);
        skipped.push(step);
        step++;
        continue;
      }
      // Never start a group that cannot be completed within the budget.
      let calls = Math.min(1 + Math.floor(random() * 4), remaining() - 1);
      if (calls < 1) break;
      // An interrupted group, as in a real log: its last results are
      // database steps with status 6, and the next record is USER_INPUT.
      let logged = calls;
      if (step >= nextInterrupted && remaining() >= 4) {
        nextInterrupted += interruptedGroupEvery;
        calls = Math.min(Math.max(calls, 3), remaining() - 1);
        logged = 1 + Math.floor(random() * (calls - 1));
        interrupted = true;
      }
      const planner = step;
      const commands: string[] = [];
      await emit(
        {
          ...head("PLANNER_RESPONSE", "MODEL"),
          ...usage(),
          thinking: text(`STEP_${step} thinking`, 0.6),
          tool_calls: Array.from({ length: calls }, (_, call) => {
            const command = `pnpm test step-${step}-${call}`;
            commands.push(command);
            return call % 2
              ? {
                  name: "run_command",
                  args: {
                    CommandLine: command,
                    WaitMsBeforeAsync: 5000,
                    toolSummary: "run tests",
                  },
                }
              : {
                  name: "read_file",
                  args: {
                    Path: join(options.cwd, `src/file-${step}-${call}.ts`),
                  },
                };
          }),
        },
        ANTIGRAVITY_STEP_TYPES.PLANNER_RESPONSE,
      );
      for (let call = 0; call < logged; call++) {
        const failed = random() < 0.02;
        const running = !failed && call % 2 === 1 && random() < 0.05;
        const at = timestamp(base, step);
        if (running) {
          // A background launch: no completion line; its end is a later wake.
          const task = `${options.id}/task-${step}`;
          tasks.push({ task, command: commands[call]! });
          await emit(
            {
              ...head("GENERIC", "MODEL", "RUNNING"),
              content: `Created At: ${at}\nTool is running as a background task with task id: ${task}\nTask Description: ${commands[call]}\nTask logs are available at: ${taskLog(`task-${step}`)}`,
            },
            ANTIGRAVITY_STEP_TYPES.GENERIC,
          );
          continue;
        }
        const content = `Created At: ${at}\nCompleted At: ${at}\n${text(`STEP_${step} result`, 1.6)}`;
        await emit(
          failed
            ? {
                // Real error records put `error` before `created_at`.
                step_index: step,
                source: "MODEL",
                type: "GENERIC",
                status: "ERROR",
                error: `Encountered error in step execution STEP_${step}`,
                created_at: at,
                content,
              }
            : { ...head("GENERIC", "MODEL"), content },
          ANTIGRAVITY_STEP_TYPES.GENERIC,
        );
      }
      if (interrupted) {
        for (let call = logged; call < calls; call++) {
          types.push([
            step,
            ANTIGRAVITY_STEP_TYPES.GENERIC,
            INTERRUPTED_STATUS,
          ]);
          step++;
        }
        interruptedGroups.push({ planner, calls, logged });
        break;
      }
    }
    if (interrupted) continue;
    if (remaining() > 0)
      await emit(
        {
          ...head("PLANNER_RESPONSE", "MODEL"),
          ...usage(),
          content: text(`TURN_${turn}_REPLY STEP_${step}`),
        },
        ANTIGRAVITY_STEP_TYPES.PLANNER_RESPONSE,
      );
    // Each finished background task wakes the conversation, as observed.
    for (const { task } of tasks) {
      if (remaining() < 2) break;
      const at = timestamp(base, step);
      await emit(
        {
          ...head("SYSTEM_MESSAGE", "SYSTEM"),
          content: `${SYSTEM_PREFIX}[Message] timestamp=${at} sender=${task} priority=MESSAGE_PRIORITY_HIGH content=Task id "${task}" finished with result:\nCommand exited with code 0.\n\nCommand output:\n${text(`STEP_${step} output`, 0.5)}\n\nLog: ${taskLog(task.split("/")[1]!)}\n</SYSTEM_MESSAGE>`,
        },
        ANTIGRAVITY_STEP_TYPES.SYSTEM_MESSAGE,
      );
      wakes++;
      await emit(
        {
          ...head("PLANNER_RESPONSE", "MODEL"),
          ...usage(),
          content: text(`WAKE_REPLY STEP_${step}`, 0.3),
        },
        ANTIGRAVITY_STEP_TYPES.PLANNER_RESPONSE,
      );
    }
    if (
      checkpointEvery > 0 &&
      step >= (checkpoints + 1) * checkpointEvery &&
      remaining() > 0
    ) {
      checkpoints++;
      const { model: _model, ...tokens } = usage();
      await emit(
        {
          ...head("CHECKPOINT", "SYSTEM"),
          ...tokens,
          content: `# Resuming from a compaction\n\nSUMMARY_MARKER_${checkpoints} STEP_${step}\n${text("summary", 6)}`,
        },
        ANTIGRAVITY_STEP_TYPES.CHECKPOINT,
      );
    }
  }
  await full.close();
  await short?.close();
  await writeStepsDatabase(
    join(options.store, "conversations", `${options.id}.db`),
    types,
  );
  if (options.summaries !== false)
    await writeAntigravitySummaries(options.store, [
      { id: options.id, cwd: options.cwd, title: "Scale target" },
    ]);
  return {
    fullPath,
    shortPath,
    fullBytes: full.bytes,
    shortBytes: short?.bytes ?? 0,
    records,
    checkpoints,
    skipped,
    interruptedGroups,
    wakes,
    lastStep: step - 1,
  };
}

async function writeStepsDatabase(
  path: string,
  steps: ReadonlyArray<[number, number, number]>,
): Promise<void> {
  await rm(path, { force: true });
  const db = loadSqliteDriver()!.open(path);
  try {
    db.exec(
      "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER)",
    );
    const insert = db.prepare("INSERT INTO steps VALUES (?, ?, ?)");
    db.exec("BEGIN");
    for (const [idx, type, status] of steps) insert.run(idx, type, status);
    db.exec("COMMIT");
    insert.finalize();
  } finally {
    db.close();
  }
}
