// Plan 195 step 7: which native files each `agy` writer changes, and when,
// on real `agy` with a scripted model. Run by hand from packages/server (no
// inference, no network, owned profile):
//   pnpm exec tsx --conditions source ../../scripts/perf-repro/antigravity-writer-probe.mjs \
//     [--agy <path>] [--out <report.json>] [--keep] [--verbose]
// It polls the size, modification time and inode of two conversations'
// databases, sidecars and logs, the summaries index and the presence
// directory every millisecond, and labels each change with the phase that
// made it: an owner's turns, Stop, `/compact`, a wake, idle time and close;
// a resume and a load with no prompt; an outside turn in a stopped
// conversation; and two `agy` processes on one conversation.
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
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

/** Polls file facts every millisecond and records each change. */
function watchFiles(scope, store, t0) {
  const paths = new Set();
  const dirs = [join(store, "conversations"), join(store, "presence")];
  const last = new Map();
  const changes = [];
  let phase = "setup";
  const facts = (path) => {
    try {
      const info = statSync(path);
      return `${info.ino}:${info.size}:${info.mtimeMs}`;
    } catch {
      return "missing";
    }
  };
  const poll = () => {
    for (const dir of dirs) {
      let names = [];
      try {
        names = readdirSync(dir);
      } catch {}
      for (const name of names) paths.add(join(dir, name));
    }
    for (const path of paths) {
      const current = facts(path);
      const previous = last.get(path);
      if (previous === current) continue;
      last.set(path, current);
      if (previous === undefined && phase === "setup") continue;
      const [, size] = current.split(":");
      changes.push({
        t: Math.round((now() - t0) * 10) / 10,
        phase,
        file: relative(store, path),
        change:
          current === "missing"
            ? "deleted"
            : previous === undefined || previous === "missing"
              ? "created"
              : previous.split(":")[0] !== current.split(":")[0]
                ? "replaced"
                : "modified",
        size: current === "missing" ? null : Number(size),
      });
    }
  };
  const timer = setInterval(poll, 1);
  scope.defer(() => clearInterval(timer));
  return {
    changes,
    track(path) {
      paths.add(path);
      last.set(path, facts(path));
    },
    phase(name) {
      poll();
      phase = name;
      changes.push({ t: Math.round((now() - t0) * 10) / 10, mark: name });
    },
    poll,
  };
}

async function probe() {
  const model = await startModel();
  const profile = makeProfile(model);
  const scope = createScope();
  const report = { agy, node: process.version, phases: {} };
  const t0 = now();
  const work = (async () => {
    const files = watchFiles(scope, profile.store, t0);
    const summaries = join(profile.store, "conversation_summaries.db");
    for (const suffix of ["", "-wal", "-shm"]) files.track(summaries + suffix);
    const owner = await startAgy(scope, profile, { agy, t0, verbose });
    report.agyVersion = owner.initialize()?.agentInfo?.version;
    const open = async (agent) =>
      (
        await agent.runtime.call("session/new", {
          cwd: profile.project,
          mcpServers: [],
        })
      ).sessionId;
    const x = await open(owner);
    const y = await open(owner);
    report.x = x;
    report.y = y;
    for (const id of [x, y]) {
      const db = join(profile.store, "conversations", `${id}.db`);
      for (const suffix of ["", "-wal", "-shm"]) files.track(db + suffix);
      files.track(join(logsDir(profile.store, id), "transcript_full.jsonl"));
    }
    const logX = watchLog(
      scope,
      join(logsDir(profile.store, x), "transcript_full.jsonl"),
      t0,
    );
    const prompt = (agent, id, text) =>
      agent.runtime
        .call(
          "session/prompt",
          { sessionId: id, prompt: [{ type: "text", text }] },
          0,
        )
        .then((response) => ({
          at: now() - t0,
          stopReason: response?.stopReason,
        }));
    const mark = (name) => {
      files.phase(name);
      report.phases[name] = Math.round(now() - t0);
    };
    const plain = async (agent, id, label) => {
      const turn = prompt(agent, id, `${label}_PROMPT`);
      (await nextRequest(model, label)).finish(`${label}_DONE`);
      return bounded(turn, label, 60_000);
    };

    mark("owner-first-turns");
    await plain(owner, x, "X1");
    await plain(owner, y, "Y1");
    mark("owner-idle-after-turn");
    await sleep(6000);

    mark("owner-tool-turn");
    let turn = prompt(owner, x, "X_TOOL_PROMPT");
    let exchange = await nextRequest(model, "x-tool-1");
    sendParts(
      exchange,
      [
        call("run_command", {
          CommandLine: "echo X",
          WaitMsBeforeAsync: 5000,
          toolSummary: "probe",
        }),
      ],
      true,
    );
    endExchange(exchange);
    (await nextRequest(model, "x-tool-2")).finish("X_TOOL_DONE");
    await bounded(turn, "tool turn", 60_000);
    mark("owner-idle-after-tool-turn");
    await sleep(3000);

    mark("owner-stop");
    turn = prompt(owner, x, "X_STOP_PROMPT");
    exchange = await nextRequest(model, "x-stop");
    exchange.partial("X_STOP_PARTIAL ");
    await sleep(300);
    owner.runtime.cancel(x);
    await bounded(turn, "stop turn", 60_000);
    mark("owner-idle-after-stop");
    await sleep(3000);

    mark("owner-compact");
    turn = prompt(owner, x, "/compact keep markers");
    (await nextRequest(model, "compact-summary")).finish(
      "<analysis>Probe.</analysis><summary>X_SUMMARY</summary>",
    );
    (await nextRequest(model, "compact-continue")).finish("X_COMPACT_DONE");
    await bounded(turn, "compact", 60_000);
    mark("owner-idle-after-compact");
    await sleep(3000);

    mark("owner-wake-turn");
    turn = prompt(owner, x, "X_WAKE_PROMPT");
    exchange = await nextRequest(model, "wake-1");
    sendParts(
      exchange,
      [
        call("run_command", {
          CommandLine: "sleep 1; echo WAKE_DONE",
          WaitMsBeforeAsync: 100,
          toolSummary: "probe background",
        }),
      ],
      true,
    );
    endExchange(exchange);
    (await nextRequest(model, "wake-2")).finish("X_WAKE_TURN_DONE");
    await bounded(turn, "wake turn", 60_000);
    mark("owner-idle-before-wake");
    const wake = await nextRequest(model, "wake-reply", 15_000);
    mark("owner-wake-reply");
    wake.finish("X_WAKE_REPLY");
    await sleep(1000);
    mark("owner-idle-after-wake");
    await sleep(5000);

    mark("owner-close");
    await owner.runtime.close();
    mark("after-owner-exit");
    await sleep(5000);

    mark("ya-resume");
    const resumed = await startAgy(scope, profile, { agy, t0 });
    await resumed.runtime.call("session/resume", {
      sessionId: x,
      cwd: profile.project,
      mcpServers: [],
    });
    mark("ya-resume-idle");
    await sleep(3000);
    mark("ya-resume-close");
    await resumed.runtime.close();
    mark("after-ya-resume-exit");
    await sleep(3000);

    mark("ya-load");
    const loaded = await startAgy(scope, profile, { agy, t0 });
    await loaded.runtime.call("session/load", {
      sessionId: x,
      cwd: profile.project,
      mcpServers: [],
    });
    mark("ya-load-idle");
    await sleep(3000);
    mark("ya-load-close");
    await loaded.runtime.close();
    mark("after-ya-load-exit");
    await sleep(3000);

    mark("outside-start");
    const outside = await startAgy(scope, profile, { agy, t0 });
    await outside.runtime.call("session/resume", {
      sessionId: x,
      cwd: profile.project,
      mcpServers: [],
    });
    mark("outside-turn");
    await plain(outside, x, "OUTSIDE");
    mark("outside-idle");
    await sleep(2000);
    mark("outside-close");
    await outside.runtime.close();
    mark("after-outside-exit");
    await sleep(3000);

    // Two processes on one conversation: an owner resumed first, then a
    // second writer resumes the same conversation and takes turns with it.
    mark("two-owner-resume");
    const first = await startAgy(scope, profile, { agy, t0 });
    await first.runtime.call("session/resume", {
      sessionId: x,
      cwd: profile.project,
      mcpServers: [],
    });
    mark("two-second-resume");
    const second = await startAgy(scope, profile, { agy, t0 });
    report.secondResume = await second.runtime
      .call("session/resume", {
        sessionId: x,
        cwd: profile.project,
        mcpServers: [],
      })
      .then(
        () => "ok",
        (error) => String(error?.message ?? error),
      );
    mark("two-second-turn");
    report.secondTurn = await plain(second, x, "SECOND_A").catch((error) =>
      String(error?.message ?? error),
    );
    mark("two-first-turn");
    report.firstTurn = await plain(first, x, "FIRST_A").catch((error) =>
      String(error?.message ?? error),
    );
    mark("two-second-turn-again");
    report.secondTurnAgain = await plain(second, x, "SECOND_B").catch((error) =>
      String(error?.message ?? error),
    );
    mark("two-idle");
    await sleep(2000);
    mark("two-close");
    await second.runtime.close();
    await first.runtime.close();
    mark("after-two-exit");
    await sleep(3000);
    files.phase("end");
    logX.stop();
    report.logX = logX.seen.map((entry) => ({
      t: Math.round(entry.t),
      step: entry.step,
      type: entry.type,
      content:
        entry.type === "USER_INPUT"
          ? String(entry.record.content).match(/[A-Z_0-9]+_PROMPT/)?.[0]
          : entry.type === "PLANNER_RESPONSE"
            ? String(entry.record.content ?? "").slice(0, 24)
            : undefined,
    }));
    report.changes = files.changes;
    report.modelFailures = model.failures;
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

/** Per phase and file: how many changes, and the first and last offsets. */
function summarize(report) {
  const out = {};
  let phaseStart = 0;
  for (const entry of report.changes) {
    if (entry.mark) {
      phaseStart = entry.t;
      continue;
    }
    const file = entry.file
      .replace(report.x, "X")
      .replace(report.y, "Y")
      .replace(/^brain\/[^/]+\/\.system_generated\/logs\//, "log:");
    const key = `${entry.phase} ${file}`;
    out[key] ??= {
      changes: 0,
      kinds: new Set(),
      firstMs: entry.t - phaseStart,
      lastMs: 0,
      sizes: new Set(),
    };
    const row = out[key];
    row.changes++;
    row.kinds.add(entry.change);
    row.lastMs = Math.round(entry.t - phaseStart);
    row.sizes.add(entry.size);
  }
  return Object.entries(out).map(([key, row]) => ({
    key,
    changes: row.changes,
    kinds: [...row.kinds].join(","),
    firstMs: Math.round(row.firstMs),
    lastMs: row.lastMs,
    sizes: [...row.sizes].slice(0, 6).join(","),
  }));
}

const report = await probe();
report.summary = summarize(report);
const out = option("out");
if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(`agy ${report.agyVersion}`);
for (const row of report.summary)
  console.log(
    `${row.key}: ${row.changes}x ${row.kinds} +${row.firstMs}..+${row.lastMs} ms sizes ${row.sizes}`,
  );
console.log(
  "second resume:",
  report.secondResume,
  "turns:",
  JSON.stringify([report.secondTurn, report.firstTurn, report.secondTurnAgain]),
);
console.log(
  "log X:",
  report.logX.map((r) => `${r.step}:${r.type}:${r.content ?? ""}`).join(" "),
);
