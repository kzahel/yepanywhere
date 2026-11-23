// Plan 195 step 6: when a turn's last brain-log record appears against the
// turn's end, on real `agy` with a scripted model. Run by hand from
// packages/server (no inference, no network, owned profile):
//   pnpm exec tsx --conditions source ../../scripts/perf-repro/antigravity-turn-end-probe.mjs \
//     [--agy <path>] [--out <report.json>] [--keep] [--verbose]
// For each turn it reports the prompt's return (or, for a detached wake,
// its last ACP update), every record the turn wrote with its first
// observation time, the delay from the end to the last record, and the
// USER_INPUT records a steer and `/compact` leave.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bounded,
  call,
  createScope,
  defaultAgy,
  endExchange,
  logsDir,
  makeProfile,
  nextRequest,
  now,
  sendParts,
  sleep,
  startAgy,
  startModel,
  watchLog,
} from "./antigravity-probe-support.mjs";

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);
const agy = option("agy") ?? defaultAgy();
const verbose = flag("verbose");

async function probe() {
  const model = await startModel();
  const profile = makeProfile(model);
  const scope = createScope();
  const report = { agy, node: process.version, turns: [] };
  const t0 = now();
  const work = (async () => {
    const agent = await startAgy(scope, profile, { agy, t0, verbose });
    report.agyVersion = agent.initialize()?.agentInfo?.version;
    const { sessionId: id } = await agent.runtime.call("session/new", {
      cwd: profile.project,
      mcpServers: [],
    });
    report.sessionId = id;
    writeFileSync(join(profile.project, "a.txt"), "A_CONTENT\n");
    writeFileSync(join(profile.project, "b.txt"), "B_CONTENT\n");
    const log = watchLog(
      scope,
      join(logsDir(profile.store, id), "transcript_full.jsonl"),
      t0,
    );
    const lastUpdate = () => agent.updates.at(-1)?.t ?? 0;
    const sends = [];
    report.sends = sends;
    const send = (text) => {
      const sentAt = now() - t0;
      sends.push({ text, sentAt: Math.round(sentAt) });
      const turn = agent.runtime
        .call(
          "session/prompt",
          { sessionId: id, prompt: [{ type: "text", text }] },
          0,
        )
        .then((response) => ({
          returnedAt: now() - t0,
          stopReason: response?.stopReason,
        }));
      return { sentAt, turn };
    };
    const next = (label) => nextRequest(model, label);
    /** Records seen after `from`, once the log has been quiet for `quietMs`. */
    const settleLog = async (quietMs = 1500) => {
      let count = log.seen.length;
      for (let quiet = 0; quiet < quietMs; quiet += 50) {
        await sleep(50);
        if (log.seen.length !== count) {
          count = log.seen.length;
          quiet = 0;
        }
      }
    };
    const record = async (name, startCount, endAt, extra = {}) => {
      await settleLog();
      const records = log.seen.slice(startCount).map((entry) => ({
        step: entry.step,
        type: entry.type,
        status: entry.status,
        at: Math.round(entry.t),
        afterEndMs: Math.round(entry.t - endAt),
        ...(entry.type === "USER_INPUT"
          ? { content: String(entry.record.content).slice(0, 200) }
          : {}),
      }));
      const last = records.at(-1);
      report.turns.push({
        name,
        endAt: Math.round(endAt),
        lastRecordAfterEndMs: last ? last.afterEndMs : null,
        records,
        ...extra,
      });
    };

    // PLAIN: one reply.
    let start = log.seen.length;
    let sent = send("PLAIN_PROMPT");
    (await next("plain")).finish("PLAIN_DONE");
    let done = await bounded(sent.turn, "PLAIN", 60_000);
    await record("plain", start, done.returnedAt);

    // TOOLS: two reads in one response, a command, then a reply.
    start = log.seen.length;
    sent = send("TOOLS_PROMPT");
    let exchange = await next("tools-1");
    sendParts(
      exchange,
      [
        call("read_file", { Path: join(profile.project, "a.txt") }),
        call("read_file", { Path: join(profile.project, "b.txt") }),
      ],
      true,
    );
    endExchange(exchange);
    exchange = await next("tools-2");
    sendParts(
      exchange,
      [
        call("run_command", {
          CommandLine: "echo TOOLS_CMD",
          WaitMsBeforeAsync: 5000,
          toolSummary: "probe",
        }),
      ],
      true,
    );
    endExchange(exchange);
    exchange = await next("tools-3");
    exchange.partial("TOOLS_FINAL_START ");
    await sleep(200);
    exchange.finish("TOOLS_DONE");
    done = await bounded(sent.turn, "TOOLS", 60_000);
    await record("tools", start, done.returnedAt);

    // STEER: a second prompt while the first reply streams.
    start = log.seen.length;
    sent = send("STEER_FIRST_PROMPT");
    exchange = await next("steer-1");
    exchange.partial("STEER_PARTIAL ");
    await sleep(300);
    const steer = send("STEER_SECOND_PROMPT");
    await sleep(300);
    exchange.finish("STEER_FIRST_DONE");
    const followUp = await bounded(next("steer-2"), "steer follow-up", 10_000)
      .then((request) => {
        request.finish("STEER_SECOND_DONE");
        return true;
      })
      .catch(() => false);
    const [first, second] = await Promise.all([
      bounded(sent.turn, "STEER first", 60_000),
      bounded(steer.turn, "STEER second", 60_000),
    ]);
    await record(
      "steer",
      start,
      Math.max(first.returnedAt, second.returnedAt),
      {
        followUpRequest: followUp,
        firstReturnedAt: Math.round(first.returnedAt),
        secondReturnedAt: Math.round(second.returnedAt),
        stopReasons: [first.stopReason, second.stopReason],
      },
    );

    // STOP: cancel mid-reply.
    start = log.seen.length;
    sent = send("STOP_PROMPT");
    exchange = await next("stop-1");
    exchange.partial("STOP_PARTIAL ");
    await sleep(300);
    agent.runtime.cancel(id);
    done = await bounded(sent.turn, "STOP", 60_000);
    await bounded(exchange.cancelled, "cancelled stream", 10_000).catch(
      () => {},
    );
    await record("stop", start, done.returnedAt, {
      stopReason: done.stopReason,
    });

    // COMPACT: the command as YA sends it.
    start = log.seen.length;
    sent = send("/compact keep the probe markers");
    (await next("compact-summary")).finish(
      "<analysis>Probe.</analysis><summary>COMPACT_SUMMARY</summary>",
    );
    (await next("compact-continuation")).finish("COMPACT_CONTINUE_DONE");
    done = await bounded(sent.turn, "COMPACT", 60_000);
    await record("compact", start, done.returnedAt);

    // WAKE: a background command's end wakes the session after the turn.
    start = log.seen.length;
    sent = send("WAKE_PROMPT");
    exchange = await next("wake-1");
    sendParts(
      exchange,
      [
        call("run_command", {
          CommandLine: "sleep 1; echo WAKE_BG_DONE",
          WaitMsBeforeAsync: 100,
          toolSummary: "probe background",
        }),
      ],
      true,
    );
    endExchange(exchange);
    (await next("wake-2")).finish("WAKE_TURN_DONE");
    done = await bounded(sent.turn, "WAKE", 60_000);
    await record("wake-turn", start, done.returnedAt);
    start = log.seen.length;
    const wake = await bounded(next("wake-reply"), "wake request", 10_000);
    wake.partial("WAKE_REPLY_START ");
    await sleep(200);
    wake.finish("WAKE_REPLY_DONE");
    await sleep(500);
    await record("wake-reply", start, lastUpdate(), {
      endIs: "last ACP update",
    });

    // MIDWAKE: a prompt sent after a wake's first chunk, before its end.
    start = log.seen.length;
    sent = send("MIDWAKE_TURN");
    exchange = await next("midwake-1");
    sendParts(
      exchange,
      [
        call("run_command", {
          CommandLine: "sleep 1; echo MIDWAKE_BG_DONE",
          WaitMsBeforeAsync: 100,
          toolSummary: "probe background",
        }),
      ],
      true,
    );
    endExchange(exchange);
    (await next("midwake-2")).finish("MIDWAKE_TURN_DONE");
    done = await bounded(sent.turn, "MIDWAKE", 60_000);
    await record("midwake-turn", start, done.returnedAt);
    start = log.seen.length;
    const midWake = await bounded(
      next("midwake-reply"),
      "wake request",
      10_000,
    );
    midWake.partial("MW_HEAD ");
    await sleep(200);
    const during = send("MIDWAKE_PROMPT");
    await sleep(300);
    midWake.finish("MW_TAIL");
    (await bounded(next("midwake-prompt"), "midwake prompt", 10_000)).finish(
      "MIDWAKE_DONE",
    );
    done = await bounded(during.turn, "MIDWAKE_PROMPT", 60_000);
    await record("midwake-prompt", start, done.returnedAt);

    // CHILD: a detached subagent, then the parent's wake on its report.
    start = log.seen.length;
    sent = send("CHILD_PARENT_PROMPT");
    exchange = await next("child-parent-1");
    sendParts(
      exchange,
      [
        call("invoke_subagent", {
          TypeName: "research",
          Role: "Probe researcher",
          Prompt: "CHILD_TASK",
        }),
      ],
      true,
    );
    endExchange(exchange);
    // Answer every request (the parent's continuation, the child's, the
    // parent's wake on the child's report) until the turn has returned and
    // nothing has been asked for three seconds.
    const answered = [];
    let childDone;
    void sent.turn.then((value) => {
      childDone = value;
    });
    for (let quiet = 0; !childDone || quiet < 3000; ) {
      const request = await bounded(model.next(), "child", 1000).catch(
        () => undefined,
      );
      if (!request) {
        quiet += 1000;
        if (!childDone && answered.length > 8) break;
        continue;
      }
      quiet = 0;
      const body = JSON.stringify(request.body);
      const reply =
        body.includes("CHILD_TASK") && !body.includes("CHILD_PARENT_PROMPT")
          ? "CHILD_REPORT"
          : `CHILD_PARENT_${answered.length}`;
      answered.push({ at: Math.round(now() - t0), reply });
      request.finish(reply);
    }
    await record("child", start, childDone?.returnedAt ?? lastUpdate(), {
      answered,
      lastUpdateAt: Math.round(lastUpdate()),
    });
    log.stop();
    await agent.runtime.close();
    report.modelFailures = model.failures;
    report.updates = agent.updates.map((update) => ({
      t: Math.round(update.t),
      kind: update.kind,
      text: update.text.slice(0, 24),
    }));
    report.log = log.seen.map((entry) => ({
      t: Math.round(entry.t),
      step: entry.step,
      type: entry.type,
      status: entry.status,
      calls: Array.isArray(entry.record.tool_calls)
        ? entry.record.tool_calls.length
        : 0,
    }));
    return report;
  })();
  work.catch(() => {});
  try {
    return await Promise.race([work, scope.failure]);
  } finally {
    try {
      await scope.close();
    } finally {
      await model.close();
      if (!flag("keep")) {
        const { rmSync } = await import("node:fs");
        rmSync(profile.root, { recursive: true, force: true });
      } else report.profile = profile.root;
    }
  }
}

const report = await probe();
const out = option("out");
if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
for (const turn of report.turns)
  console.log(
    `${turn.name}: last record ${turn.lastRecordAfterEndMs} ms after end; ${turn.records
      .map(
        (r) =>
          `${r.step}:${r.type}${r.afterEndMs >= 0 ? `(+${r.afterEndMs})` : `(${r.afterEndMs})`}`,
      )
      .join(" ")}`,
  );
