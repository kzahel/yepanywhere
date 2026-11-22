// Plan 195 step 3: compare the brain-log projection with ACP replay. Run by
// hand from packages/server:
//   pnpm exec tsx --conditions source ../../scripts/perf-repro/antigravity-log-census.mjs \
//     census [--store <antigravity-cli>] [--agy <path>] [--out <report.json>]
//   pnpm exec tsx --conditions source ../../scripts/perf-repro/antigravity-log-census.mjs \
//     project <transcript_full.jsonl> [--repeat 3]
//
// census: copies the store (default ~/.gemini/antigravity-cli) into an owned
// profile, so no session/load ever runs against a conversation another
// process may own. For each conversation with a full log it projects the
// copy's log, replays the copy through `agy acp` session/load into YA's
// AntigravityTranscript, and reports bytes read, records decoded and every
// mismatch class left after the expected differences documented in
// packages/server/test/utils/antigravity-projection-compare.ts. The report
// names steps and classes only, never content.
//
// project: projects one log and reports records and MB per second.
import {
  cpSync,
  createReadStream,
  existsSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const server = join(repo, "packages/server");
const { antigravityLogLines, projectAntigravityLog } = await import(
  join(server, "src/sessions/antigravity-log-projection.ts")
);
const { compareProjectionWithReplay } = await import(
  join(server, "test/utils/antigravity-projection-compare.ts")
);

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};

/** Streams one log through the projection, counting bytes read. */
async function projectFile(path, conversationId) {
  let bytes = 0;
  const stream = createReadStream(path, { highWaterMark: 1 << 20 });
  stream.on("data", (chunk) => {
    bytes += chunk.length;
  });
  const result = await projectAntigravityLog(antigravityLogLines(stream), {
    conversationId,
    ownerLive: false,
  });
  stream.destroy();
  return { ...result, bytes };
}

if (argv[0] === "project") {
  const path = resolve(argv[1]);
  const repeat = Number(option("repeat", 3));
  const runs = [];
  let peakRss = 0;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 50);
  let last;
  for (let run = 0; run < repeat; run++) {
    const started = performance.now();
    last = await projectFile(path, "census");
    const seconds = (performance.now() - started) / 1000;
    runs.push({
      seconds: Math.round(seconds * 100) / 100,
      recordsPerSecond: Math.round(last.records / seconds),
      megabytesPerSecond: Math.round(last.bytes / 1e6 / seconds),
    });
    last.messageCount = last.messages?.length;
    last.messages = undefined;
  }
  clearInterval(sampler);
  console.log(
    JSON.stringify(
      {
        path,
        bytes: last.bytes,
        records: last.records,
        status: last.status,
        reason: last.reason,
        messages: last.messageCount,
        runs,
        peakRssMB: Math.round(peakRss / 1e6),
        node: process.version,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (argv[0] !== "census") {
  console.error("Usage: census [--store <dir>] [--agy <path>] | project <log>");
  process.exit(2);
}

const support = await import(
  join(repo, "scripts/perf-repro/antigravity-probe-support.mjs")
);
const { AntigravityTranscript } = await import(
  join(server, "src/sdk/providers/antigravity-transcript.ts")
);
const { loadAntigravityReplay } = await import(
  join(server, "src/sdk/providers/antigravity-replay.ts")
);

const source = resolve(
  option("store", join(homedir(), ".gemini", "antigravity-cli")),
);
const agy = option("agy", support.defaultAgy());
const model = await support.startModel();
const profile = support.makeProfile(model);
const scope = support.createScope();
const report = { source, agy, conversations: {}, totals: {} };
try {
  // Only the conversation files and the index; never the runtime's own state.
  for (const entry of ["conversations", "brain", "conversation_summaries.db"])
    if (existsSync(join(source, entry)))
      cpSync(join(source, entry), join(profile.store, entry), {
        recursive: true,
        preserveTimestamps: true,
      });
  const conversations = join(profile.store, "conversations");
  const ids = readdirSync(join(profile.store, "brain")).filter((id) =>
    existsSync(
      join(support.logsDir(profile.store, id), "transcript_full.jsonl"),
    ),
  );
  const totals = {
    conversations: ids.length,
    bytes: 0,
    records: 0,
    projectSeconds: 0,
    unknown: 0,
    replayFailed: 0,
    classes: {},
  };
  for (const id of ids) {
    const log = join(
      support.logsDir(profile.store, id),
      "transcript_full.jsonl",
    );
    const started = performance.now();
    const projected = await projectFile(log, id);
    const projectSeconds = (performance.now() - started) / 1000;
    totals.bytes += projected.bytes;
    totals.records += projected.records;
    totals.projectSeconds += projectSeconds;
    const entry = {
      logBytes: statSync(log).size,
      bytesRead: projected.bytes,
      recordsDecoded: projected.records,
      projectMs: Math.round(projectSeconds * 1000),
      status: projected.status,
      ...(projected.reason ? { reason: projected.reason } : {}),
    };
    report.conversations[id] = entry;
    if (projected.status !== "known") {
      totals.unknown++;
      continue;
    }
    entry.projectedMessages = projected.messages.length;
    const transcript = new AntigravityTranscript(id);
    const agent = await support.startAgy(scope, profile, {
      agy,
      t0: support.now(),
    });
    try {
      const loaded = await support.bounded(
        loadAntigravityReplay({
          runtime: agent.runtime,
          scope: conversations,
          params: { sessionId: id, cwd: profile.project, mcpServers: [] },
          transcript,
        }),
        `session/load ${id}`,
        60_000,
      );
      entry.replayComplete = loaded?.complete ?? false;
    } catch (error) {
      // YA's reader would refuse this replay; what arrived is still compared.
      entry.replayError = String(error?.message ?? error);
      totals.replayFailed++;
    } finally {
      await agent.runtime.close();
    }
    entry.replayMessages = transcript.messages.length;
    const compared = compareProjectionWithReplay(
      projected.messages,
      transcript.messages,
    );
    entry.comparedItems = {
      projection: compared.projection.length,
      replay: compared.replay.length,
    };
    entry.mismatches = {};
    for (const mismatch of compared.mismatches) {
      const kind = mismatch.kind;
      const step =
        mismatch.projection === undefined
          ? undefined
          : compared.projection[mismatch.projection].step;
      const at =
        step === undefined ? `replay item ${mismatch.replay}` : `step ${step}`;
      entry.mismatches[kind] ??= { count: 0, first: [] };
      entry.mismatches[kind].count++;
      if (entry.mismatches[kind].first.length < 5)
        entry.mismatches[kind].first.push(at);
      totals.classes[kind] = (totals.classes[kind] ?? 0) + 1;
    }
  }
  totals.projectSeconds = Math.round(totals.projectSeconds * 100) / 100;
  report.totals = totals;
} finally {
  await scope.close();
  await model.close();
  rmSync(profile.root, { recursive: true, force: true });
}
const text = JSON.stringify(report, null, 2);
const out = option("out");
if (out) writeFileSync(out, text);
console.log(text);
