// Plan 195 step 2: measure what real `agy` writes, with a scripted model.
// Run by hand from packages/server (no inference, no network, owned profile):
//   pnpm exec tsx --conditions source ../../scripts/perf-repro/antigravity-native-probe.mjs \
//     <measure|resume-large|coverage> [--agy <path>] [--out <report.json>]
//     [--turns 1005] [--compact-every 40] [--calls 4] [--file-kb 16]
//     [--store <antigravity-cli>] [--keep] [--verbose]
// measure:      when each log record appears against its ACP event, tool
//               call IDs, step_index across cancel, compaction and a
//               stopped owner, and what load and resume write.
// resume-large: build a compacted conversation with real agy, then reopen
//               an identical copy of it per leg: session/resume and
//               session/load time, agy RSS, files touched by phase, and
//               prior context in the next model request.
// coverage:     read-only census of a store: database steps the log omits,
//               step_index order and tool-result groups. Streams each log
//               and reads a private database copy's plain columns only.
// Generated profiles stay under the OS temp directory and out of git.
import assert from "node:assert/strict";
import {
  existsSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  bounded,
  call,
  coverageOf,
  createScope,
  databaseSteps,
  defaultAgy,
  endExchange,
  logsDir,
  makeProfile,
  nextRequest,
  now,
  phaseDiffs,
  restoreStore,
  rssOfGroup,
  sampleRss,
  saveStore,
  sendParts,
  sleep,
  snapshot,
  startAgy,
  startModel,
  watchLog,
} from "./antigravity-probe-support.mjs";

const argv = process.argv.slice(2);
const mode = argv[0];
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index > 0 ? argv[index + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);
const agy = option("agy") ?? defaultAgy();
const verbose = flag("verbose");

/** Model, profile and cleanup owner for one probe run. */
async function withProfile(body) {
  const model = await startModel();
  const profile = makeProfile(model);
  const scope = createScope();
  const report = { agy, node: process.version };
  try {
    return await body({ model, profile, scope, report });
  } finally {
    try {
      await scope.close();
    } finally {
      await model.close();
      if (flag("keep")) report.profile = profile.root;
      else rmSync(profile.root, { recursive: true, force: true });
    }
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

const contextText = (body) => JSON.stringify(body.contents ?? []);

// ------------------------------------------------------------ measure -------

async function measure() {
  return withProfile(async ({ model, profile, scope, report }) => {
    report.mode = "measure";
    const t0 = now();
    const marks = [];
    const mark = (name, extra = {}) => {
      marks.push({ t: now() - t0, name, ...extra });
      if (verbose)
        console.error(
          `${Math.round(now() - t0)} ${name} ${JSON.stringify(extra)}`,
        );
    };
    for (const name of ["alpha-1", "alpha-2"])
      writeFileSync(
        join(profile.project, `${name}.txt`),
        `${name.toUpperCase()}_CONTENT\n`,
      );
    let agent = await startAgy(scope, profile, { agy, t0, verbose });
    report.initialize = agent.initialize();
    report.agyVersion = report.initialize?.agentInfo?.version;
    const { sessionId: id } = await agent.runtime.call("session/new", {
      cwd: profile.project,
      mcpServers: [],
    });
    report.sessionId = id;
    const full = watchLog(
      scope,
      join(logsDir(profile.store, id), "transcript_full.jsonl"),
      t0,
    );
    const short = watchLog(
      scope,
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
    const settle = (turn, label) => bounded(turn, `prompt "${label}"`, 60_000);
    const next = async (label) => {
      const exchange = await nextRequest(model, label);
      mark("model-request", {
        label,
        bytes: JSON.stringify(exchange.body).length,
      });
      return exchange;
    };
    const end = (exchange, marker) => {
      endExchange(exchange);
      mark("model-end", { marker });
    };
    const finish = (exchange, text) => {
      exchange.finish(text);
      mark("model-end", { marker: text });
    };
    const path = (name) => join(profile.project, name);

    // A: thinking and held text with a call; two calls in one response, one
    // asking permission; held final text.
    let turn = prompt("ALPHA_PROMPT");
    let exchange = await next("alpha-1");
    sendParts(exchange, [{ text: "ALPHA_THOUGHT", thought: true }], false);
    exchange.partial("ALPHA_PARTIAL ");
    await sleep(400);
    sendParts(
      exchange,
      [call("read_file", { Path: path("alpha-1.txt") })],
      true,
    );
    end(exchange, "ALPHA_PARTIAL");
    exchange = await next("alpha-2");
    sendParts(
      exchange,
      [
        call("read_file", { Path: path("alpha-2.txt") }),
        call("write_file", {
          Path: path("written.txt"),
          Content: "WRITTEN_BY_PROBE\n",
          Overwrite: true,
        }),
      ],
      true,
    );
    end(exchange, "alpha-2.txt");
    exchange = await next("alpha-3");
    exchange.partial("ALPHA_FINAL_START ");
    await sleep(400);
    finish(exchange, "ALPHA_FINAL_END");
    await settle(turn, "ALPHA");

    // B: a background command, then the wake its end causes.
    turn = prompt("BRAVO_PROMPT");
    exchange = await next("bravo-1");
    sendParts(
      exchange,
      [
        call("run_command", {
          CommandLine: "sleep 1.5; echo BG_DONE_MARK",
          WaitMsBeforeAsync: 100,
          toolSummary: "probe background",
        }),
      ],
      true,
    );
    end(exchange, "BG_DONE_MARK");
    finish(await next("bravo-2"), "BRAVO_DONE");
    await settle(turn, "BRAVO");
    const wakes = [];
    const wakeDeadline = now() + 4000;
    while (now() < wakeDeadline) {
      const pending = model.requests.length;
      await sleep(100);
      if (model.requests.length > pending) {
        const wake = await next("bravo-wake");
        wakes.push(contextText(wake.body).includes("BG_DONE_MARK"));
        finish(wake, `WAKE_REPLY_${wakes.length}`);
      }
    }
    report.backgroundWakes = wakes;

    // L: a two-second foreground command.
    turn = prompt("LONGTOOL_PROMPT");
    exchange = await next("long-1");
    sendParts(
      exchange,
      [
        call("run_command", {
          CommandLine: "sleep 2; echo LONG_DONE_MARK",
          WaitMsBeforeAsync: 10000,
          toolSummary: "probe foreground",
        }),
      ],
      true,
    );
    end(exchange, "LONG_DONE_MARK");
    finish(await next("long-2"), "LONGTOOL_DONE");
    await settle(turn, "LONGTOOL");

    // C: cancel mid-stream; D: an ordinary turn after it.
    turn = prompt("CHARLIE_PROMPT");
    exchange = await next("charlie-1");
    exchange.partial("CHARLIE_PARTIAL ");
    await sleep(300);
    agent.runtime.cancel(id);
    mark("cancel-sent", { marker: "CHARLIE_PARTIAL" });
    report.cancelStop = (await settle(turn, "CHARLIE"))?.stopReason;
    await bounded(exchange.cancelled, "cancelled model stream", 10_000);
    turn = prompt("DELTA_PROMPT");
    finish(await next("delta-1"), "DELTA_DONE");
    await settle(turn, "DELTA");

    // E: compaction; F: the next request.
    turn = prompt("/compact keep the probe markers");
    finish(
      await next("compact-summary"),
      "<analysis>Probe.</analysis><summary>COMPACTION_SUMMARY_MARKER</summary>",
    );
    marks.at(-1).marker = "COMPACTION_SUMMARY_MARKER";
    finish(await next("compact-continuation"), "COMPACT_CONTINUE_DONE");
    await settle(turn, "compact");
    turn = prompt("ECHO_PROMPT");
    exchange = await next("echo-1");
    report.afterCompaction = markers(exchange.body, [
      "COMPACTION_SUMMARY_MARKER",
      "ALPHA_PROMPT",
      "ALPHA_FINAL_END",
      "DELTA_DONE",
    ]);
    finish(exchange, "ECHO_DONE");
    await settle(turn, "ECHO");
    await sleep(1500);
    full.stop();
    short.stop();
    await agent.runtime.close();

    report.timeline = timeline(
      marks,
      agent.updates,
      full.seen,
      agent.permissions,
    );
    report.delays = pairRecords(full.seen, agent.updates, marks);
    const shortBySteps = new Map(
      short.seen.map((entry) => [entry.step, entry.t]),
    );
    const gaps = full.seen.map(
      (entry) => shortBySteps.get(entry.step) - entry.t,
    );
    report.shortLog = {
      records: short.seen.length,
      minMinusFullMs: Math.min(...gaps),
      maxMinusFullMs: Math.max(...gaps),
    };
    report.recheck = { full: full.recheck(), short: short.recheck() };
    report.toolCallIds = toolCallIds(id, agent.updates, agent.permissions);
    report.permissionStringIds = agent.permissions.stringIds ?? 0;
    report.records = full.seen.map(({ step, type, status, record }) => ({
      step,
      type,
      status,
      source: record.source,
      keys: Object.keys(record),
      ...(record.error ? { error: String(record.error).slice(0, 160) } : {}),
      ...(record.content
        ? { content: String(record.content).slice(0, 700) }
        : {}),
    }));
    report.coverage = await coverageOf(profile.store, id);

    // Bypass-mode tool call IDs, in a second conversation.
    agent = await startAgy(scope, profile, { agy, t0, skipPermissions: true });
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
    exchange = await nextRequest(model, "skip-1");
    sendParts(
      exchange,
      [
        call("run_command", {
          CommandLine: "echo SKIP",
          WaitMsBeforeAsync: 5000,
          toolSummary: "s",
        }),
      ],
      true,
    );
    endExchange(exchange);
    (await nextRequest(model, "skip-2")).finish("SKIP_DONE");
    await bounded(turn, "prompt SKIP", 60_000);
    await agent.runtime.close();
    report.bypassToolCallIds = toolCallIds(
      skip.sessionId,
      agent.updates,
      agent.permissions,
    );

    // Load and resume, each from an identical copy of the stopped store.
    await sleep(500);
    const pristine = saveStore(profile);
    report.reopen = {};
    for (const method of ["session/load", "session/resume"]) {
      report.reopen[method] = await reopenLeg({
        scope,
        profile,
        pristine,
        method,
        id,
        t0,
      });
      restoreStore(profile, pristine);
      const context = await startAgy(scope, profile, { agy, t0 });
      await context.runtime.call(method, {
        sessionId: id,
        cwd: profile.project,
        mcpServers: [],
      });
      turn = context.runtime.call(
        "session/prompt",
        { sessionId: id, prompt: [{ type: "text", text: "REOPEN_PROMPT" }] },
        0,
      );
      exchange = await nextRequest(model, `after ${method}`);
      report.reopen[method].nextRequestContext = markers(exchange.body, [
        "ECHO_DONE",
        "COMPACTION_SUMMARY_MARKER",
        "ALPHA_PROMPT",
        "ALPHA_FINAL_END",
      ]);
      exchange.finish("REOPEN_DONE");
      await bounded(turn, `prompt after ${method}`, 60_000);
      await context.runtime.close();
    }

    // Stop the owner mid-stream the way YA does (SIGTERM to the group),
    // then resume and prompt: which steps does that leave behind?
    restoreStore(profile, pristine);
    const killed = await startAgy(scope, profile, { agy, t0 });
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
    exchange = await nextRequest(model, "golf-1");
    exchange.partial("GOLF_PARTIAL ");
    await sleep(300);
    await killed.runtime.close();
    await bounded(turn, "prompt GOLF", 10_000);
    await bounded(exchange.cancelled, "GOLF stream close", 10_000);
    await sleep(300);
    const afterKill = await coverageOf(profile.store, id);
    const continued = await startAgy(scope, profile, { agy, t0 });
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
    exchange = await nextRequest(model, "hotel-1");
    const hotel = markers(exchange.body, ["GOLF_PROMPT", "GOLF_PARTIAL"]);
    exchange.finish("HOTEL_DONE");
    await bounded(turn, "prompt HOTEL", 60_000);
    await continued.runtime.close();
    await sleep(300);
    const afterContinue = await coverageOf(profile.store, id);
    report.stoppedOwner = {
      nextRequestContext: hotel,
      afterStop: pick(afterKill),
      afterResumedPrompt: {
        ...pick(afterContinue),
        databaseTail: databaseSteps(
          join(profile.store, "conversations", `${id}.db`),
        ).slice(-6),
      },
    };
    report.modelFailures = model.failures;
    return report;
  });
}

const pick = (coverage) => ({
  inconclusive: coverage.inconclusive,
  steps: coverage.databaseSteps,
  records: coverage.logRecords,
  increasing: coverage.increasing,
  unlogged: coverage.unlogged,
});

/** Distinct markers in the request's conversation contents (not its system instruction). */
function markers(body, names) {
  const contents = contextText(body);
  const system = JSON.stringify(body.systemInstruction ?? {});
  return {
    contentsBytes: contents.length,
    inContents: Object.fromEntries(
      names.map((name) => [name, contents.includes(name)]),
    ),
    inSystemInstruction: names.filter((name) => system.includes(name)),
  };
}

/**
 * One reopen of an identical stopped store, with snapshots before launch,
 * after initialize, after the reopen's stream goes quiet and after exit.
 * Matching snapshots show that the files matched at those moments only.
 */
async function reopenLeg({
  scope,
  profile,
  pristine,
  method,
  id,
  t0,
  timeout = 30_000,
}) {
  restoreStore(profile, pristine);
  const snapshots = { prelaunch: snapshot(profile.store) };
  const agent = await startAgy(scope, profile, {
    agy,
    t0,
    skipPermissions: true,
  });
  snapshots.initialized = snapshot(profile.store);
  const idleRss = await rssOfGroup(agent.runtime.pid);
  const stopRss = sampleRss(scope, agent.runtime.pid);
  const started = now();
  let error;
  let response;
  try {
    response = await agent.runtime.call(
      method,
      { sessionId: id, cwd: profile.project, mcpServers: [] },
      timeout,
    );
  } catch (cause) {
    error = String(cause?.message ?? cause);
  }
  const responded = now() - started;
  // agy can stream history after its response; wait for 500 ms of quiet.
  let count = agent.updates.length;
  for (let waited = 0; waited < 60_000; waited += 500) {
    await sleep(500);
    if (agent.updates.length === count) break;
    count = agent.updates.length;
  }
  const peakRss = await stopRss();
  const history = agent.updates.filter(
    (update) => update.sessionId === id && update.kind !== "usage_update",
  );
  const lastUpdate = history.at(-1)?.t;
  snapshots.reopened = snapshot(profile.store);
  await agent.runtime.close();
  await sleep(300);
  snapshots.exited = snapshot(profile.store);
  return {
    error,
    responseKeys: response ? Object.keys(response) : undefined,
    responseMs: Math.round(responded),
    streamEndMs:
      lastUpdate === undefined
        ? undefined
        : Math.round(lastUpdate - (started - t0)),
    agyIdleRssKiB: idleRss,
    agyPeakRssKiB: peakRss,
    updates: history.length,
    updateKinds: countBy(history, (update) => update.kind),
    updateBytes: history.reduce((sum, update) => sum + update.bytes, 0),
    replayFlagged: history.filter((update) => update.isReplay).length,
    changes: phaseDiffs(snapshots),
  };
}

function countBy(items, key) {
  const out = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
}

function timeline(marks, updates, seen, permissions) {
  return [
    ...marks.map((entry) => ({
      t: entry.t,
      what: `mark ${entry.name} ${entry.label ?? entry.marker ?? entry.text ?? ""}`.trim(),
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
 * Pairs each record with the event it reports, by identity rather than
 * position: the prompt text in USER_INPUT, the scripted markers in model
 * output, and for tool results the ACP tool call whose input equals the
 * record's call arguments. Delays are first-observation differences: they
 * include the 1 ms log poll and ACP dispatch to this process.
 */
function pairRecords(seen, updates, marks) {
  const callsByInput = new Map();
  for (const update of updates)
    if (
      update.kind === "tool_call" &&
      update.rawInput &&
      !callsByInput.has(canonical(JSON.parse(update.rawInput)))
    )
      callsByInput.set(
        canonical(JSON.parse(update.rawInput)),
        update.toolCallId,
      );
  const firstUpdate = (id, test) =>
    updates.find((update) => update.toolCallId === id && test(update));
  // agy can report a call only once, as a completed `tool_call`.
  const terminal = (id) =>
    firstUpdate(id, (update) =>
      ["completed", "failed"].includes(update.status),
    );
  const markFor = (record) =>
    marks.find(
      (entry) =>
        (entry.name === "model-end" || entry.name === "cancel-sent") &&
        entry.marker &&
        JSON.stringify(record).includes(entry.marker),
    );
  const rows = [];
  let group;
  let running;
  let lastUserInput;
  for (const entry of seen) {
    const { record } = entry;
    const row = { step: entry.step, type: entry.type, status: entry.status };
    const since = (t) =>
      t === undefined ? undefined : Math.round(entry.t - t);
    if (entry.type === "USER_INPUT") {
      const sent = marks.find(
        (item) =>
          item.name === "prompt-sent" &&
          String(record.content).includes(`<USER_REQUEST>\n${item.text}\n`),
      );
      Object.assign(row, {
        anchor: "session/prompt sent",
        delayMs: since(sent?.t),
      });
      lastUserInput = entry;
    } else if (entry.type === "PLANNER_RESPONSE") {
      const text = `${record.content ?? ""}${record.thinking ?? ""}`;
      const chunks = updates.filter(
        (update) =>
          (update.kind === "agent_message_chunk" ||
            update.kind === "agent_thought_chunk") &&
          update.text.trim() &&
          text.includes(update.text.trim()),
      );
      const calls = (record.tool_calls ?? []).map((item) =>
        callsByInput.get(canonical(item.args)),
      );
      const firstCall = calls
        .map((id) => firstUpdate(id, (update) => update.kind === "tool_call"))
        .filter(Boolean)[0];
      const ended = markFor(record);
      Object.assign(row, {
        anchor:
          ended?.name === "cancel-sent"
            ? "session/cancel sent"
            : "model response ended",
        delayMs: since(ended?.t),
        afterLastChunkMs: chunks.length
          ? since(Math.max(...chunks.map((chunk) => chunk.t)))
          : undefined,
        afterFirstChunkMs: chunks.length
          ? since(Math.min(...chunks.map((chunk) => chunk.t)))
          : undefined,
        beforeAcpToolCallMs: firstCall
          ? Math.round(firstCall.t - entry.t)
          : undefined,
      });
      group = record.tool_calls?.length
        ? { calls: record.tool_calls, next: 0 }
        : undefined;
    } else if (entry.type === "GENERIC") {
      const args = group?.calls[group.next++]?.args;
      const id = args ? callsByInput.get(canonical(args)) : undefined;
      if (entry.status === "RUNNING") {
        running = id;
        const launched = firstUpdate(
          id,
          (update) => update.kind === "tool_call",
        );
        const done = terminal(id);
        Object.assign(row, {
          anchor: "ACP tool_call (launch)",
          delayMs: since(launched?.t),
          beforeAcpCompletionMs: done
            ? Math.round(done.t - entry.t)
            : undefined,
        });
      } else
        Object.assign(row, {
          anchor: "same call ID reported completed",
          delayMs: since(terminal(id)?.t),
          paired: Boolean(id),
        });
    } else if (entry.type === "SYSTEM_MESSAGE") {
      if (/task id/i.test(String(record.content)) && running) {
        Object.assign(row, {
          anchor: "background call reported completed",
          delayMs: since(terminal(running)?.t),
        });
      } else
        Object.assign(row, {
          anchor: "the preceding USER_INPUT record",
          delayMs: since(lastUserInput?.t),
        });
    } else if (entry.type === "CHECKPOINT") {
      const ended = markFor(record);
      Object.assign(row, {
        anchor: "summary response ended",
        delayMs: since(ended?.t),
        summaryInRecord: Boolean(ended),
      });
    } else if (entry.type === "ERROR_MESSAGE") {
      const cancel = marks.find(
        (item) => item.name === "cancel-sent" && item.t <= entry.t,
      );
      Object.assign(row, {
        anchor: "session/cancel sent",
        delayMs: since(cancel?.t),
      });
    }
    rows.push(row);
  }
  return rows;
}

function toolCallIds(sessionId, updates, permissions) {
  const ids = [
    ...new Set(
      updates
        .filter((update) => update.kind === "tool_call")
        .map((update) => update.toolCallId),
    ),
  ];
  return ids.map((id) => ({
    id,
    uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      id,
    ),
    namesSessionStep: id.startsWith(`${sessionId}:`),
    viaPermission: permissions.some((entry) => entry.toolCallId === id),
  }));
}

// ------------------------------------------------------- resume-large -------

async function resumeLarge() {
  return withProfile(async ({ model, profile, scope, report }) => {
    const turns = Number(option("turns", 1005));
    const compactEvery = Number(option("compact-every", 40));
    const callsPerTurn = Number(option("calls", 4));
    const fileKb = Number(option("file-kb", 16));
    Object.assign(report, {
      mode: "resume-large",
      turns,
      compactEvery,
      callsPerTurn,
      fileKb,
    });
    const t0 = now();
    for (let file = 0; file < callsPerTurn; file++)
      writeFileSync(
        join(profile.project, `big-${file}.txt`),
        `BIG_FILE_${file} `
          .repeat(Math.ceil((fileKb * 1024) / 12))
          .slice(0, fileKb * 1024),
      );
    const agent = await startAgy(scope, profile, {
      agy,
      t0,
      skipPermissions: true,
    });
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
    const take = async (label) => {
      const exchange = await nextRequest(model, label, 120_000);
      maxRequest = Math.max(maxRequest, JSON.stringify(exchange.body).length);
      // The scripted model keeps every body; each holds the whole context.
      model.requests.length = 0;
      return exchange;
    };
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
        (await take(`summary ${turn}`)).finish(
          `<analysis>a</analysis><summary>SUMMARY_MARKER_${++compactions} after TURN_${turn}</summary>`,
        );
        (await take(`continuation ${turn}`)).finish(`COMPACTED_${compactions}`);
      } else {
        const first = await take(`turn ${turn}`);
        sendParts(
          first,
          Array.from({ length: callsPerTurn }, (_, file) =>
            call("read_file", {
              Path: join(profile.project, `big-${file}.txt`),
            }),
          ),
          true,
        );
        endExchange(first);
        (await take(`reply ${turn}`)).finish(
          `TURN_${turn}_REPLY ${"answer ".repeat(64)}`,
        );
      }
      await bounded(done, `prompt ${turn}`, 120_000);
      turnMs.push(now() - started);
      if (turn % 50 === 0)
        console.error(
          `turn ${turn}/${turns}: ${Math.round(now() - build)} ms, last ${Math.round(turnMs.at(-1))} ms`,
        );
    }
    await agent.runtime.close();
    await sleep(500);
    const coverage = await coverageOf(profile.store, id);
    const logs = logsDir(profile.store, id);
    const database = join(profile.store, "conversations", `${id}.db`);
    report.built = {
      ms: Math.round(now() - build),
      steps: coverage.logRecords,
      checkpoints: coverage.types.CHECKPOINT ?? 0,
      logBytes: statSync(join(logs, "transcript_full.jsonl")).size,
      shortLogBytes: statSync(join(logs, "transcript.jsonl")).size,
      databaseBytes: statSync(database).size,
      databaseWalBytes: existsSync(`${database}-wal`)
        ? statSync(`${database}-wal`).size
        : null,
      maxModelRequestBytes: maxRequest,
      firstTurnMs: Math.round(turnMs[0]),
      medianTurnMs: Math.round(
        turnMs.slice().sort((a, b) => a - b)[turnMs.length >> 1],
      ),
      lastTurnMs: Math.round(turnMs.at(-1)),
    };
    report.coverage = pick(coverage);
    const pristine = saveStore(profile);
    const lastTurn = turns % compactEvery === 0 ? undefined : turns;
    const names = [
      ...(lastTurn ? [`TURN_${lastTurn}_REPLY`] : []),
      `SUMMARY_MARKER_${compactions}`,
      `SUMMARY_MARKER_${Math.max(1, compactions - 1)}`,
      "TURN_1_PROMPT",
    ];
    report.reopen = {};
    for (const method of ["session/resume", "session/load"]) {
      const leg = await reopenLeg({
        scope,
        profile,
        pristine,
        method,
        id,
        t0,
        timeout: 300_000,
      });
      restoreStore(profile, pristine);
      const context = await startAgy(scope, profile, {
        agy,
        t0,
        skipPermissions: true,
      });
      await context.runtime.call(
        method,
        { sessionId: id, cwd: profile.project, mcpServers: [] },
        300_000,
      );
      const done = context.runtime.call(
        "session/prompt",
        { sessionId: id, prompt: [{ type: "text", text: `AFTER_${method}` }] },
        0,
      );
      const request = await take(`after ${method}`);
      leg.nextRequestContext = {
        ...markers(request.body, names),
        bytes: JSON.stringify(request.body).length,
      };
      request.finish("REOPEN_DONE");
      await bounded(done, `prompt after ${method}`, 60_000);
      await context.runtime.close();
      report.reopen[method] = leg;
    }
    return report;
  });
}

// ----------------------------------------------------------- coverage -------

async function coverageCensus() {
  const store = resolve(
    option("store", join(homedir(), ".gemini/antigravity-cli")),
  );
  const out = {
    store,
    databases: 0,
    withLog: 0,
    withoutLog: 0,
    conversations: [],
  };
  const unloggedTypes = {};
  const shortGroups = [];
  for (const name of readdirSync(join(store, "conversations"))) {
    if (!name.endsWith(".db")) continue;
    out.databases++;
    const id = name.slice(0, -3);
    if (!existsSync(join(logsDir(store, id), "transcript_full.jsonl"))) {
      out.withoutLog++;
      out.conversations.push({ id, log: false });
      continue;
    }
    out.withLog++;
    const coverage = await coverageOf(store, id);
    if (!coverage.inconclusive) {
      for (const step of coverage.unlogged) {
        const key = `${step.type}/${step.status}`;
        unloggedTypes[key] = (unloggedTypes[key] ?? 0) + 1;
      }
      for (const group of coverage.groups.short)
        shortGroups.push({ id, ...group });
    }
    out.conversations.push({
      id,
      inconclusive: coverage.inconclusive,
      steps: coverage.databaseSteps,
      records: coverage.logRecords,
      increasing: coverage.increasing,
      contiguous: coverage.contiguous,
      unlogged: coverage.unlogged,
      loggedWithoutStep: coverage.loggedWithoutStep.length,
      completeGroups: coverage.groups.complete,
      shortGroups: coverage.groups.short.length,
      openGroupAtEnd: coverage.groups.openAtEnd ?? null,
      orphanResults: coverage.groups.orphanResults,
    });
  }
  const conclusive = out.conversations.filter(
    (entry) => entry.log !== false && !entry.inconclusive,
  );
  out.inconclusive = out.conversations
    .filter((entry) => entry.inconclusive)
    .map((entry) => entry.id);
  out.unloggedByTypeAndStatus = unloggedTypes;
  out.allIncreasing = conclusive.every((entry) => entry.increasing);
  out.completeGroups = conclusive.reduce(
    (sum, entry) => sum + entry.completeGroups,
    0,
  );
  out.shortGroups = shortGroups;
  out.orphanResults = conclusive.reduce(
    (sum, entry) => sum + entry.orphanResults,
    0,
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
        ? await coverageCensus()
        : (() => {
            throw new Error("Pass measure, resume-large or coverage");
          })();
const output = option("out");
if (output) writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
