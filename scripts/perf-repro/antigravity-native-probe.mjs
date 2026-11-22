// Plan 195 step 2: measure what real `agy` writes, with a scripted model.
// Run by hand from packages/server (no inference, no network, owned profile):
//   pnpm exec tsx --conditions source ../../scripts/perf-repro/antigravity-native-probe.mjs \
//     <measure|resume-large|coverage> [--agy <path>] [--out <report.json>]
//     [--turns 300] [--compact-every 40] [--calls 4] [--file-kb 8] [--keep]
// measure:      log trail behind ACP by record type, tool call IDs, step_index
//               across cancel and compaction, and what load/resume rewrite.
// resume-large: build a compacted conversation with real agy, then time
//               session/resume and session/load (agy RSS, files touched,
//               prior context in the next model request).
// coverage:     read-only census of a local store: database step types the
//               log omits and whether step_index increases. Copies each
//               database first; reads plain columns only, never protobuf.
// Generated profiles stay under the OS temp directory and out of git.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const server = join(repo, "packages/server");
const { modelServer, syntheticKey } = await import(
  join(server, "test/native-provider/model-server.ts")
);
const { AntigravityRuntime } = await import(
  join(server, "src/sdk/providers/antigravity-runtime.ts")
);

const argv = process.argv.slice(2);
const mode = argv[0];
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index > 0 ? argv[index + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);
const agy =
  option("agy") ??
  join(
    repo,
    "node_modules/.cache/ya-native-provider-tests",
    `${process.platform}-${process.arch}`,
    "antigravity/1.5.13/agy",
  );
const run = promisify(execFile);
const now = () => performance.now();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ---------------------------------------------------------------- profile ---

function makeProfile(model) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ya-agy-probe-")));
  const home = join(root, "home");
  const gemini = join(home, ".gemini");
  const store = join(gemini, "antigravity-cli");
  const project = join(root, "project");
  mkdirSync(store, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "notes.txt"), "OWNED_TOOL_CONTENT\n");
  writeFileSync(
    join(store, "settings.json"),
    JSON.stringify({
      modelProvider: "gemini",
      auth: { type: "gemini-api-key" },
    }),
  );
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    GEMINI_HOME: gemini,
    GEMINI_API_KEY: syntheticKey,
    GOOGLE_GEMINI_BASE_URL: model.url,
    HTTP_PROXY: model.url,
    HTTPS_PROXY: model.url,
    ALL_PROXY: model.url,
    http_proxy: model.url,
    https_proxy: model.url,
    grpc_proxy: model.url,
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
    AGY_CLI_DISABLE_AUTO_UPDATE: "1",
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0",
  };
  // AntigravityRuntime spawns with process.env; give it only the owned profile.
  for (const name of Object.keys(process.env))
    if (!(name in env)) delete process.env[name];
  Object.assign(process.env, env);
  return { root, gemini, store, project };
}

async function startModel() {
  return modelServer("gemini", {
    blockedHosts: ["play.googleapis.com:443"],
    auxiliary: (_body, path) =>
      path.endsWith("/gemini-3.1-flash-lite-preview:streamGenerateContent")
        ? "title"
        : undefined,
  });
}

/** One `agy acp` process with timestamped ACP updates. */
async function startAgy(profile, { skipPermissions = false, t0 } = {}) {
  const runtime = new AntigravityRuntime();
  const updates = [];
  const permissions = [];
  runtime.onUpdate = (update, sessionId, isReplay) => {
    updates.push({
      t: now() - t0,
      sessionId,
      isReplay,
      kind: update.sessionUpdate,
      toolCallId: update.toolCallId,
      status: update.status,
      title: update.title,
      text: typeof update.content?.text === "string" ? update.content.text : "",
      bytes: JSON.stringify(update).length,
    });
  };
  runtime.onPermission = async (params) => {
    if (flag("verbose")) console.error("permission", JSON.stringify(params));
    permissions.push({
      t: now() - t0,
      toolCallId: params.toolCall?.toolCallId,
      title: params.toolCall?.title,
    });
    const allow = params.options?.find((entry) => entry.kind === "allow_once");
    return { outcome: { outcome: "selected", optionId: allow?.optionId } };
  };
  let initialize;
  const receive = runtime.receive.bind(runtime);
  runtime.receive = (message) => {
    if (
      flag("verbose") &&
      message.method &&
      message.method !== "session/update"
    )
      console.error("frame", JSON.stringify(message));
    // agy 1.5.13 sends permission requests with string JSON-RPC IDs, which
    // YA's transport refuses (see the permission-ID gap). Answer them here.
    if (
      message.method === "session/request_permission" &&
      typeof message.id === "string"
    ) {
      permissions.stringIds = (permissions.stringIds ?? 0) + 1;
      void runtime
        .onPermission(message.params ?? {})
        .then((result) =>
          runtime.send({ jsonrpc: "2.0", id: message.id, result }),
        );
      return;
    }
    return receive(message);
  };
  const call = runtime.call.bind(runtime);
  runtime.call = async (method, params, timeout) => {
    const result = await call(method, params, timeout);
    if (method === "initialize") initialize = result;
    return result;
  };
  await runtime.connect(agy, profile.project, [
    "acp",
    "--gemini-dir",
    profile.gemini,
    ...(skipPermissions ? ["--dangerously-skip-permissions"] : []),
  ]);
  return { runtime, updates, permissions, initialize: () => initialize };
}

// --------------------------------------------------------- native files ----

const logsDir = (store, id) =>
  join(store, "brain", id, ".system_generated", "logs");

/** Tails one log by polling appended bytes; records first sight per step. */
function watchLog(path, t0) {
  const seen = [];
  let offset = 0;
  let partial = "";
  const poll = () => {
    if (!existsSync(path)) return;
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      if (size < offset) throw new Error(`${path} shrank`);
      if (size === offset) return;
      const buffer = Buffer.alloc(size - offset);
      readSync(fd, buffer, 0, buffer.length, offset);
      offset = size;
      const t = now() - t0;
      const lines = (partial + buffer.toString("utf8")).split("\n");
      partial = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const record = JSON.parse(line);
        seen.push({
          t,
          step: record.step_index,
          type: record.type,
          status: record.status,
          record,
        });
      }
    } finally {
      closeSync(fd);
    }
  };
  const timer = setInterval(poll, 1);
  return {
    seen,
    poll,
    stop() {
      clearInterval(timer);
      poll();
    },
  };
}

function walk(directory, out = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/** Size, mtime and content hash of every file under the store. */
function snapshot(store) {
  const files = {};
  for (const path of walk(store)) {
    const info = statSync(path);
    files[relative(store, path)] = {
      size: info.size,
      mtimeMs: info.mtimeMs,
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    };
  }
  return files;
}

function diff(before, after) {
  const changes = [];
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[name];
    const b = after[name];
    if (!a) changes.push({ file: name, change: "created", size: b.size });
    else if (!b) changes.push({ file: name, change: "deleted" });
    else if (a.sha256 !== b.sha256)
      changes.push({
        file: name,
        change: "content",
        size: `${a.size}->${b.size}`,
      });
    else if (a.mtimeMs !== b.mtimeMs)
      changes.push({ file: name, change: "mtime-only", size: b.size });
  }
  return changes.sort((x, y) => x.file.localeCompare(y.file));
}

/** Plain step columns from a private copy of a conversation database. */
function databaseSteps(databasePath) {
  const scratch = mkdtempSync(join(tmpdir(), "ya-agy-db-"));
  try {
    const copy = join(scratch, "copy.db");
    copyFileSync(databasePath, copy);
    for (const suffix of ["-wal", "-shm"])
      if (existsSync(databasePath + suffix))
        copyFileSync(databasePath + suffix, copy + suffix);
    const db = new DatabaseSync(copy);
    try {
      return db
        .prepare("SELECT idx, step_type, status FROM steps ORDER BY idx")
        .all()
        .map((row) => ({
          idx: Number(row.idx),
          type: Number(row.step_type),
          status: Number(row.status),
        }));
    } finally {
      db.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function readLog(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Database steps the log omits, and whether step_index strictly increases. */
function coverageOf(store, id) {
  const steps = databaseSteps(join(store, "conversations", `${id}.db`));
  const records = readLog(join(logsDir(store, id), "transcript_full.jsonl"));
  const logged = new Set(records.map((record) => record.step_index));
  let increasing = true;
  for (let i = 1; i < records.length; i++)
    if (!(records[i].step_index > records[i - 1].step_index))
      increasing = false;
  const typeByLogType = {};
  const stepType = new Map(steps.map((step) => [step.idx, step.type]));
  for (const record of records) {
    const key = `${record.type}`;
    typeByLogType[key] ??= {};
    const type = stepType.get(record.step_index);
    typeByLogType[key][type] = (typeByLogType[key][type] ?? 0) + 1;
  }
  return {
    databaseSteps: steps.length,
    logRecords: records.length,
    increasing,
    contiguous: records.every(
      (record, i) =>
        i === 0 || record.step_index === records[i - 1].step_index + 1,
    ),
    unlogged: steps.filter((step) => !logged.has(step.idx)),
    loggedWithoutStep: records
      .filter((record) => !stepType.has(record.step_index))
      .map((record) => record.step_index),
    databaseTypeByLogType: typeByLogType,
  };
}

// --------------------------------------------------------- model script ----

/** Emit a raw Gemini SSE chunk; `final` closes the candidate. */
function gemini(exchange, parts, final) {
  exchange.start();
  exchange.gemini(parts, final);
}
function endExchange(exchange) {
  exchange.end();
}

// ------------------------------------------------------------ measure -------

async function measure() {
  const model = await startModel();
  const profile = makeProfile(model);
  const t0 = now();
  const report = { agy, mode: "measure", agyVersion: undefined };
  const marks = [];
  const mark = (name, extra = {}) => {
    marks.push({ t: now() - t0, name, ...extra });
    if (flag("verbose"))
      console.error(
        `${Math.round(now() - t0)} ${name} ${JSON.stringify(extra)}`,
      );
  };
  try {
    let agent = await startAgy(profile, { t0 });
    report.initialize = agent.initialize();
    report.agyVersion = report.initialize?.agentInfo?.version;
    const setup = await agent.runtime.call("session/new", {
      cwd: profile.project,
      mcpServers: [],
    });
    const id = setup.sessionId;
    report.sessionId = id;
    const full = watchLog(
      join(logsDir(profile.store, id), "transcript_full.jsonl"),
      t0,
    );
    const short = watchLog(
      join(logsDir(profile.store, id), "transcript.jsonl"),
      t0,
    );
    const prompt = (text) => {
      mark("prompt-sent", { text });
      return agent.runtime
        .call(
          "session/prompt",
          { sessionId: id, prompt: [{ type: "text", text }] },
          0,
        )
        .then((response) => {
          mark("prompt-returned", { text, stopReason: response?.stopReason });
          return response;
        });
    };
    const next = async (label) => {
      const exchange = await model.next();
      mark("model-request", {
        label,
        bytes: JSON.stringify(exchange.body).length,
      });
      return exchange;
    };
    const finish = (exchange, label, text) => {
      exchange.finish(text);
      mark("model-end", { label });
    };

    // Turn A: thinking + held text + a tool call, then two calls in one
    // response (one needs permission), then held final text.
    let turn = prompt("ALPHA_PROMPT");
    let exchange = await next("alpha-1");
    gemini(exchange, [{ text: "ALPHA_THOUGHT", thought: true }], false);
    exchange.partial("ALPHA_PARTIAL ");
    mark("model-first-text", { label: "alpha-1" });
    await sleep(400);
    gemini(
      exchange,
      [
        {
          functionCall: {
            name: "read_file",
            args: { Path: join(profile.project, "notes.txt") },
          },
        },
      ],
      true,
    );
    endExchange(exchange);
    mark("model-end", { label: "alpha-1" });
    exchange = await next("alpha-2");
    gemini(
      exchange,
      [
        {
          functionCall: {
            name: "read_file",
            args: { Path: join(profile.project, "notes.txt") },
          },
        },
        {
          functionCall: {
            name: "write_file",
            args: {
              Path: join(profile.project, "written.txt"),
              Content: "WRITTEN_BY_PROBE\n",
              Overwrite: true,
            },
          },
        },
      ],
      true,
    );
    endExchange(exchange);
    mark("model-end", { label: "alpha-2" });
    exchange = await next("alpha-3");
    exchange.partial("ALPHA_FINAL_START ");
    mark("model-first-text", { label: "alpha-3" });
    await sleep(400);
    finish(exchange, "alpha-3", "ALPHA_FINAL_END");
    await turn;

    // Turn B: a background command whose RUNNING record is never rewritten.
    turn = prompt("BRAVO_PROMPT");
    exchange = await next("bravo-1");
    gemini(
      exchange,
      [
        {
          functionCall: {
            name: "run_command",
            args: {
              CommandLine: "sleep 1.5; echo BG_DONE",
              WaitMsBeforeAsync: 100,
              toolSummary: "probe background",
            },
          },
        },
      ],
      true,
    );
    endExchange(exchange);
    mark("model-end", { label: "bravo-1" });
    exchange = await next("bravo-2");
    finish(exchange, "bravo-2", "BRAVO_DONE");
    await turn;
    // The task's end can wake the root: answer whatever arrives.
    const wakes = [];
    const wakeDeadline = now() + 4000;
    while (now() < wakeDeadline) {
      const pending = model.requests.length;
      await sleep(100);
      if (model.requests.length > pending) {
        const wake = await next("bravo-wake");
        wakes.push(JSON.stringify(wake.body).includes("BG_DONE"));
        finish(wake, "bravo-wake", `WAKE_REPLY_${wakes.length}`);
      }
    }
    report.backgroundWakes = wakes;

    // Turn C: cancel mid-stream.
    turn = prompt("CHARLIE_PROMPT");
    exchange = await next("charlie-1");
    exchange.partial("CHARLIE_PARTIAL ");
    mark("model-first-text", { label: "charlie-1" });
    await sleep(300);
    agent.runtime.cancel(id);
    mark("cancel-sent");
    report.cancelStop = (await turn)?.stopReason;
    await exchange.cancelled.catch(() => {});

    // Turn D: an ordinary turn after the cancel.
    turn = prompt("DELTA_PROMPT");
    exchange = await next("delta-1");
    finish(exchange, "delta-1", "DELTA_DONE");
    await turn;

    // Turn E: compaction with a recognizable summary.
    turn = prompt("/compact keep the probe markers");
    exchange = await next("compact-summary");
    report.compactSummaryRequestHasAlpha = JSON.stringify(
      exchange.body,
    ).includes("ALPHA_PROMPT");
    finish(
      exchange,
      "compact-summary",
      "<analysis>Probe.</analysis><summary>COMPACTION_SUMMARY_MARKER</summary>",
    );
    exchange = await next("compact-continuation");
    finish(exchange, "compact-continuation", "COMPACT_CONTINUE_DONE");
    await turn;

    // Turn F: the next request after compaction.
    turn = prompt("ECHO_PROMPT");
    exchange = await next("echo-1");
    const echoBody = JSON.stringify(exchange.body);
    report.afterCompaction = {
      hasSummary: echoBody.includes("COMPACTION_SUMMARY_MARKER"),
      hasAlphaPrompt: echoBody.includes("ALPHA_PROMPT"),
      hasDeltaDone: echoBody.includes("DELTA_DONE"),
      requestBytes: echoBody.length,
    };
    finish(exchange, "echo-1", "ECHO_DONE");
    await turn;
    await sleep(500);
    full.stop();
    short.stop();
    await agent.runtime.close();
    mark("agy-closed");

    report.timeline = mergeTimeline(
      marks,
      agent.updates,
      full.seen,
      agent.permissions,
    );
    report.trail = trailByType(marks, agent.updates, full.seen);
    report.shortLogSameAppearance = full.seen.map((entry, i) => ({
      step: entry.step,
      fullT: Math.round(entry.t),
      shortT: Math.round(short.seen[i]?.t ?? Number.NaN),
    }));
    report.toolCallIds = toolCallIds(
      id,
      agent.updates,
      agent.permissions,
      full.seen,
    );
    report.records = full.seen.map(({ step, type, status, record }) => ({
      step,
      type,
      status,
      source: record.source,
      keys: Object.keys(record),
      ...(record.error ? { error: String(record.error).slice(0, 160) } : {}),
      ...(type === "PLANNER_RESPONSE" && record.content
        ? { content: String(record.content).slice(0, 60) }
        : {}),
    }));
    report.coverage = coverageOf(profile.store, id);
    const runningSteps = full.seen.filter(
      (entry) => entry.status === "RUNNING",
    );
    report.runningRecords = runningSteps.map((entry) => entry.step);

    // Skip-permissions IDs, in a second conversation.
    agent = await startAgy(profile, { t0, skipPermissions: true });
    const skip = await agent.runtime.call("session/new", {
      cwd: profile.project,
      mcpServers: [],
    });
    turn = agent.runtime.call(
      "session/prompt",
      {
        sessionId: skip.sessionId,
        prompt: [{ type: "text", text: "SKIP_PROMPT" }],
      },
      0,
    );
    exchange = await model.next();
    gemini(
      exchange,
      [
        {
          functionCall: {
            name: "run_command",
            args: {
              CommandLine: "echo SKIP",
              WaitMsBeforeAsync: 5000,
              toolSummary: "s",
            },
          },
        },
      ],
      true,
    );
    endExchange(exchange);
    (await model.next()).finish("SKIP_DONE");
    await turn;
    await agent.runtime.close();
    await sleep(300);
    report.skipPermissionToolCallIds = toolCallIds(
      skip.sessionId,
      agent.updates,
      agent.permissions,
      readLog(
        join(logsDir(profile.store, skip.sessionId), "transcript_full.jsonl"),
      ).map((record) => ({
        step: record.step_index,
        type: record.type,
        record,
      })),
    );

    // Q2: does session/load or session/resume rewrite native files?
    const before = snapshot(profile.store);
    report.reopen = {};
    for (const method of ["session/load", "session/resume", "session/load"]) {
      const reopenAgent = await startAgy(profile, { t0 });
      const started = now();
      let response;
      let error;
      try {
        response = await reopenAgent.runtime.call(method, {
          sessionId: id,
          cwd: profile.project,
          mcpServers: [],
        });
      } catch (cause) {
        error = String(cause?.message ?? cause);
      }
      const elapsed = now() - started;
      await sleep(300);
      const replayed = reopenAgent.updates.filter(
        (update) => update.sessionId === id,
      );
      await reopenAgent.runtime.close();
      await sleep(300);
      const after = snapshot(profile.store);
      const key = report.reopen[method] ? `${method} (again)` : method;
      report.reopen[key] = {
        error,
        ms: Math.round(elapsed),
        responseKeys: response ? Object.keys(response) : undefined,
        updates: replayed.length,
        updateKinds: countBy(replayed, (update) => update.kind),
        replayFlagged: replayed.filter((update) => update.isReplay).length,
        changes: diff(before, after),
      };
      Object.assign(before, after);
      for (const name of Object.keys(before))
        if (!after[name]) delete before[name];
    }

    // Q3 (short): resume, then prompt; prior context in the next request.
    const resumed = await startAgy(profile, { t0 });
    await resumed.runtime.call("session/resume", {
      sessionId: id,
      cwd: profile.project,
      mcpServers: [],
    });
    turn = resumed.runtime.call(
      "session/prompt",
      { sessionId: id, prompt: [{ type: "text", text: "FOXTROT_PROMPT" }] },
      0,
    );
    exchange = await model.next();
    const foxtrot = JSON.stringify(exchange.body);
    report.resumeNextRequest = {
      hasEchoDone: foxtrot.includes("ECHO_DONE"),
      hasSummary: foxtrot.includes("COMPACTION_SUMMARY_MARKER"),
      hasAlphaPrompt: foxtrot.includes("ALPHA_PROMPT"),
      bytes: foxtrot.length,
    };
    exchange.finish("FOXTROT_DONE");
    await turn;
    await resumed.runtime.close();
    await sleep(300);
    const afterPrompt = readLog(
      join(logsDir(profile.store, id), "transcript_full.jsonl"),
    );
    report.afterResumePrompt = {
      lastSteps: afterPrompt
        .slice(-3)
        .map((record) => [record.step_index, record.type]),
      increasing: afterPrompt.every(
        (record, i) =>
          i === 0 || record.step_index > afterPrompt[i - 1].step_index,
      ),
    };
    report.coverageAfterResume = coverageOf(profile.store, id);

    // Stop the owner mid-stream (YA's close: SIGTERM to the group), then
    // resume and prompt: which steps does that leave in database and log?
    const killed = await startAgy(profile, { t0 });
    await killed.runtime.call("session/resume", {
      sessionId: id,
      cwd: profile.project,
      mcpServers: [],
    });
    turn = killed.runtime
      .call(
        "session/prompt",
        { sessionId: id, prompt: [{ type: "text", text: "GOLF_PROMPT" }] },
        0,
      )
      .catch((error) => String(error?.message ?? error));
    exchange = await model.next();
    exchange.partial("GOLF_PARTIAL ");
    await sleep(300);
    await killed.runtime.close();
    await turn;
    await exchange.cancelled.catch(() => {});
    await sleep(300);
    const afterKill = coverageOf(profile.store, id);
    const continued = await startAgy(profile, { t0 });
    await continued.runtime.call("session/resume", {
      sessionId: id,
      cwd: profile.project,
      mcpServers: [],
    });
    turn = continued.runtime.call(
      "session/prompt",
      { sessionId: id, prompt: [{ type: "text", text: "HOTEL_PROMPT" }] },
      0,
    );
    exchange = await model.next();
    report.afterKill = {
      nextRequestHasGolfPartial: JSON.stringify(exchange.body).includes(
        "GOLF_PARTIAL",
      ),
      nextRequestHasGolfPrompt: JSON.stringify(exchange.body).includes(
        "GOLF_PROMPT",
      ),
    };
    exchange.finish("HOTEL_DONE");
    await turn;
    await continued.runtime.close();
    await sleep(300);
    const afterContinue = coverageOf(profile.store, id);
    const tail = readLog(
      join(logsDir(profile.store, id), "transcript_full.jsonl"),
    )
      .slice(-6)
      .map((record) => [record.step_index, record.type, record.status]);
    report.afterKill = {
      ...report.afterKill,
      killedOwner: {
        steps: afterKill.databaseSteps,
        records: afterKill.logRecords,
        unlogged: afterKill.unlogged,
      },
      afterResumedPrompt: {
        steps: afterContinue.databaseSteps,
        records: afterContinue.logRecords,
        increasing: afterContinue.increasing,
        unlogged: afterContinue.unlogged,
        logTail: tail,
        databaseTail: databaseSteps(
          join(profile.store, "conversations", `${id}.db`),
        ).slice(-6),
      },
    };
    report.modelFailures = model.failures;
    return report;
  } finally {
    await model.close();
    if (!flag("keep")) rmSync(profile.root, { recursive: true, force: true });
    else report.profile = profile.root;
  }
}

function countBy(items, key) {
  const out = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
}

function mergeTimeline(marks, updates, seen, permissions) {
  return [
    ...marks.map((entry) => ({
      t: entry.t,
      what: `mark ${entry.name} ${entry.label ?? entry.text ?? ""}`.trim(),
    })),
    ...updates
      .filter((entry) => entry.kind !== "usage_update")
      .map((entry) => ({
        t: entry.t,
        what: `acp ${entry.kind} ${entry.status ?? ""} ${entry.toolCallId ?? ""} ${entry.text.slice(0, 30)}`.trim(),
      })),
    ...permissions.map((entry) => ({
      t: entry.t,
      what: `acp permission ${entry.toolCallId}`,
    })),
    ...seen.map((entry) => ({
      t: entry.t,
      what: `log step ${entry.step} ${entry.type} ${entry.status}`,
    })),
  ]
    .sort((a, b) => a.t - b.t)
    .map((entry) => `${entry.t.toFixed(1).padStart(8)} ${entry.what}`);
}

/**
 * How long after its ACP event each record appeared. Anchors:
 *  USER_INPUT       prompt sent;
 *  PLANNER_RESPONSE first ACP update of that model response, and the model's end;
 *  GENERIC          the matching terminal tool_call_update (in order);
 *  CHECKPOINT       the end of the summary response;
 *  SYSTEM_MESSAGE   the nearest preceding ACP update.
 */
function trailByType(marks, updates, seen) {
  const out = [];
  const prompts = marks.filter((entry) => entry.name === "prompt-sent");
  const modelEnds = marks.filter(
    (entry) => entry.name === "model-end" || entry.name === "cancel-sent",
  );
  const responseStarts = marks.filter(
    (entry) => entry.name === "model-request",
  );
  const terminal = updates.filter(
    (entry) =>
      entry.kind === "tool_call_update" &&
      ["completed", "failed"].includes(entry.status),
  );
  let promptIndex = 0;
  let toolIndex = 0;
  for (const entry of seen) {
    let anchor;
    let anchorName;
    if (entry.type === "USER_INPUT") {
      anchor = prompts[promptIndex++]?.t;
      anchorName = "prompt sent";
    } else if (
      entry.type === "PLANNER_RESPONSE" ||
      entry.type === "CHECKPOINT"
    ) {
      const end = [...modelEnds].reverse().find((mark) => mark.t <= entry.t);
      const start = [...responseStarts]
        .reverse()
        .find((mark) => mark.t <= entry.t);
      const first = updates.find(
        (update) =>
          start &&
          update.t >= start.t &&
          ["agent_message_chunk", "agent_thought_chunk", "tool_call"].includes(
            update.kind,
          ),
      );
      out.push({
        step: entry.step,
        type: entry.type,
        afterFirstAcpUpdateMs: first
          ? Math.round(entry.t - first.t)
          : undefined,
        afterModelEndMs: end ? Math.round(entry.t - end.t) : undefined,
        label: end?.label,
      });
      continue;
    } else if (entry.type === "GENERIC") {
      const match = terminal[toolIndex++];
      anchor = match?.t;
      anchorName = `tool_call_update ${match?.status}`;
    } else {
      const previous = [...updates]
        .reverse()
        .find((update) => update.t <= entry.t);
      anchor = previous?.t;
      anchorName = `last ACP ${previous?.kind}`;
    }
    out.push({
      step: entry.step,
      type: entry.type,
      status: entry.status,
      afterAnchorMs:
        anchor === undefined ? undefined : Math.round(entry.t - anchor),
      anchor: anchorName,
    });
  }
  return out;
}

function toolCallIds(sessionId, updates, permissions, seen) {
  const calls = [];
  for (const update of updates)
    if (
      update.kind === "tool_call" &&
      !calls.some((call) => call.id === update.toolCallId)
    )
      calls.push({ id: update.toolCallId, title: update.title });
  const plannerSteps = seen
    .filter(
      (entry) =>
        entry.type === "PLANNER_RESPONSE" && entry.record?.tool_calls?.length,
    )
    .map((entry) => entry.step);
  return {
    plannerStepsWithCalls: plannerSteps,
    calls: calls.map((call) => ({
      ...call,
      matchesSessionStep: call.id?.startsWith(`${sessionId}:`) ?? false,
      viaPermission: permissions.some((entry) => entry.toolCallId === call.id),
    })),
    permissionIds: permissions.map((entry) => entry.toolCallId),
  };
}

// ------------------------------------------------------- resume-large -------

async function rssOfGroup(pid) {
  const { stdout } = await run("ps", ["-A", "-o", "pid=,pgid=,rss="]);
  let kib = 0;
  for (const line of stdout.split("\n")) {
    const [, pgid, rss] = line.trim().split(/\s+/).map(Number);
    if (pgid === pid) kib += rss;
  }
  return kib;
}

function sampleRss(pid) {
  let peak = 0;
  let stopped = false;
  const done = (async () => {
    while (!stopped) {
      peak = Math.max(peak, await rssOfGroup(pid).catch(() => 0));
      await sleep(25);
    }
  })();
  return async () => {
    stopped = true;
    await done;
    return peak;
  };
}

async function resumeLarge() {
  const turns = Number(option("turns", 300));
  const compactEvery = Number(option("compact-every", 40));
  const callsPerTurn = Number(option("calls", 4));
  const fileKb = Number(option("file-kb", 8));
  const model = await startModel();
  const profile = makeProfile(model);
  const t0 = now();
  const report = {
    agy,
    mode: "resume-large",
    turns,
    compactEvery,
    callsPerTurn,
    fileKb,
  };
  try {
    for (let file = 0; file < callsPerTurn; file++)
      writeFileSync(
        join(profile.project, `big-${file}.txt`),
        `BIG_FILE_${file} `
          .repeat(Math.ceil((fileKb * 1024) / 12))
          .slice(0, fileKb * 1024),
      );
    let agent = await startAgy(profile, { t0, skipPermissions: true });
    report.agyVersion = agent.initialize()?.agentInfo?.version;
    const { sessionId: id } = await agent.runtime.call("session/new", {
      cwd: profile.project,
      mcpServers: [],
    });
    report.sessionId = id;
    const build = now();
    let compactions = 0;
    let maxRequest = 0;
    const turnMs = [];
    for (let turn = 1; turn <= turns; turn++) {
      const started = now();
      const compacting = turn % compactEvery === 0;
      const text = compacting
        ? `/compact keep TURN_${turn}`
        : `TURN_${turn}_PROMPT`;
      const done = agent.runtime.call(
        "session/prompt",
        { sessionId: id, prompt: [{ type: "text", text }] },
        0,
      );
      if (compacting) {
        const summary = await model.next();
        maxRequest = Math.max(maxRequest, JSON.stringify(summary.body).length);
        summary.finish(
          `<analysis>a</analysis><summary>SUMMARY_MARKER_${++compactions} after TURN_${turn}</summary>`,
        );
        (await model.next()).finish(`COMPACTED_${compactions}`);
      } else {
        const first = await model.next();
        maxRequest = Math.max(maxRequest, JSON.stringify(first.body).length);
        gemini(
          first,
          Array.from({ length: callsPerTurn }, (_, file) => ({
            functionCall: {
              name: "read_file",
              args: { Path: join(profile.project, `big-${file}.txt`) },
            },
          })),
          true,
        );
        endExchange(first);
        const reply = await model.next();
        maxRequest = Math.max(maxRequest, JSON.stringify(reply.body).length);
        reply.finish(`TURN_${turn}_REPLY ${"answer ".repeat(64)}`);
      }
      await done;
      turnMs.push(now() - started);
      if (turn % 50 === 0)
        console.error(
          `turn ${turn}/${turns}: ${Math.round(now() - build)} ms, last ${Math.round(turnMs.at(-1))} ms`,
        );
    }
    await agent.runtime.close();
    await sleep(500);
    const logPath = join(logsDir(profile.store, id), "transcript_full.jsonl");
    const records = readLog(logPath);
    report.built = {
      ms: Math.round(now() - build),
      steps: records.length,
      checkpoints: records.filter((record) => record.type === "CHECKPOINT")
        .length,
      logBytes: statSync(logPath).size,
      shortLogBytes: statSync(
        join(logsDir(profile.store, id), "transcript.jsonl"),
      ).size,
      databaseBytes:
        statSync(join(profile.store, "conversations", `${id}.db`)).size +
        (existsSync(join(profile.store, "conversations", `${id}.db-wal`))
          ? statSync(join(profile.store, "conversations", `${id}.db-wal`)).size
          : 0),
      maxModelRequestBytes: maxRequest,
      medianTurnMs: Math.round(
        turnMs.slice().sort((a, b) => a - b)[turnMs.length >> 1],
      ),
      lastTurnMs: Math.round(turnMs.at(-1)),
    };
    report.coverage = coverageOf(profile.store, id);
    delete report.coverage.databaseTypeByLogType;

    report.reopen = {};
    for (const method of ["session/resume", "session/load"]) {
      const before = snapshot(profile.store);
      agent = await startAgy(profile, { t0, skipPermissions: true });
      const idleRss = await rssOfGroup(agent.runtime.pid);
      const stopRss = sampleRss(agent.runtime.pid);
      const started = now();
      await agent.runtime.call(
        method,
        { sessionId: id, cwd: profile.project, mcpServers: [] },
        300_000,
      );
      const responded = now() - started;
      // agy can stream history after its load response.
      let quiet = agent.updates.length;
      for (;;) {
        await sleep(500);
        if (agent.updates.length === quiet) break;
        quiet = agent.updates.length;
      }
      const lastUpdate = agent.updates.at(-1)?.t ?? 0;
      const peakRss = await stopRss();
      // Before the prompt, so only the reopen's own writes count.
      const reopenChanges = diff(before, snapshot(profile.store));
      const done = agent.runtime.call(
        "session/prompt",
        { sessionId: id, prompt: [{ type: "text", text: `AFTER_${method}` }] },
        0,
      );
      const request = await model.next();
      const body = JSON.stringify(request.body);
      // The newest reply that no compaction has summarized yet, if any.
      const lastTurn = turns % compactEvery === 0 ? undefined : turns;
      request.finish("REOPEN_DONE");
      await done;
      await agent.runtime.close();
      await sleep(500);
      const historyUpdates = agent.updates.filter(
        (update) =>
          update.sessionId === id &&
          update.t < lastUpdate + 1 &&
          update.kind !== "usage_update",
      );
      report.reopen[method] = {
        responseMs: Math.round(responded),
        streamEndMs: Math.round(Math.max(0, lastUpdate - (started - t0))),
        agyIdleRssKiB: idleRss,
        agyPeakRssKiB: peakRss,
        historyUpdates: historyUpdates.length,
        historyBytes: historyUpdates.reduce(
          (sum, update) => sum + update.bytes,
          0,
        ),
        nextRequest: {
          bytes: body.length,
          hasLastTurn:
            lastTurn === undefined
              ? null
              : body.includes(`TURN_${lastTurn}_REPLY`),
          hasLastSummary: body.includes(`SUMMARY_MARKER_${compactions}`),
          hasFirstTurn: body.includes("TURN_1_PROMPT"),
        },
        changes: reopenChanges,
      };
    }
    return report;
  } finally {
    await model.close();
    if (!flag("keep")) rmSync(profile.root, { recursive: true, force: true });
    else report.profile = profile.root;
  }
}

// ----------------------------------------------------------- coverage -------

function coverageCensus() {
  const store = resolve(
    option("store", join(homedir(), ".gemini/antigravity-cli")),
  );
  const conversations = join(store, "conversations");
  const out = { store, conversations: [] };
  const missingTypes = {};
  for (const name of readdirSync(conversations)) {
    if (!name.endsWith(".db")) continue;
    const id = name.slice(0, -3);
    const logPath = join(logsDir(store, id), "transcript_full.jsonl");
    if (!existsSync(logPath)) {
      out.conversations.push({ id, log: false });
      continue;
    }
    const coverage = coverageOf(store, id);
    for (const step of coverage.unlogged)
      missingTypes[step.type] = (missingTypes[step.type] ?? 0) + 1;
    out.conversations.push({
      id,
      steps: coverage.databaseSteps,
      records: coverage.logRecords,
      increasing: coverage.increasing,
      contiguous: coverage.contiguous,
      unlogged: coverage.unlogged,
      loggedWithoutStep: coverage.loggedWithoutStep.length,
    });
  }
  out.unloggedStepTypes = missingTypes;
  out.allIncreasing = out.conversations.every(
    (entry) => entry.increasing !== false,
  );
  return out;
}

// --------------------------------------------------------------- main -------

assert(existsSync(agy) || mode === "coverage", `Missing agy at ${agy}`);
const report =
  mode === "measure"
    ? await measure()
    : mode === "resume-large"
      ? await resumeLarge()
      : mode === "coverage"
        ? coverageCensus()
        : (() => {
            throw new Error("Pass measure, resume-large or coverage");
          })();
const output = option("out");
if (output) writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
