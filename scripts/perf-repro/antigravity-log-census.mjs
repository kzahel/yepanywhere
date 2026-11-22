// Plan 195 step 3: compare the brain-log projection with ACP replay. Run by
// hand from packages/server:
//   pnpm exec tsx --conditions source ../../scripts/perf-repro/antigravity-log-census.mjs \
//     census [--store <antigravity-cli>] [--agy <path>] [--out <report.json>]
//   pnpm exec tsx --conditions source ../../scripts/perf-repro/antigravity-log-census.mjs \
//     project <transcript_full.jsonl> [--repeat 3]
//
// census: stages each conversation of a store (default
// ~/.gemini/antigravity-cli) into an owned profile as independent regular
// files (antigravity-store-staging.mjs): the database with its WAL and the
// brain directory, checked unchanged across the copy, else inconclusive.
// A link in the source is refused, and agy never starts while anything in
// the profile resolves outside it, so no session/load can reach a
// conversation another process may own. For each conversation it projects
// the copy's log, replays the copy through `agy acp` session/load into
// YA's AntigravityTranscript, and reports bytes read, records decoded, the
// replay's raw tool frames and normalized ordinary tool_result rows, and
// every mismatch class left after the expected differences documented in
// packages/server/test/utils/antigravity-projection-compare.ts. The report
// names steps and classes only, never content.
//
// project: projects one log and reports records and MB per second.
import {
  createReadStream,
  readdirSync,
  realpathSync,
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

const staging = await import(
  join(repo, "scripts/perf-repro/antigravity-store-staging.mjs")
);
const { isAntigravityInvokeSubagent } = await import(
  join(server, "src/sessions/antigravity-subagent-links.ts")
);

const source = realpathSync(
  resolve(option("store", join(homedir(), ".gemini", "antigravity-cli"))),
);
const agy = option("agy", support.defaultAgy());
const brain = join(source, "brain");
const ids = readdirSync(brain, { withFileTypes: true })
  .filter(
    (entry) =>
      /^[0-9a-f-]{36}$/.test(entry.name) &&
      staging.identity(
        join(support.logsDir(source, entry.name), "transcript_full.jsonl"),
      ) !== null,
  )
  .map((entry) => entry.name);
const model = await support.startModel();
const profile = support.makeProfile(model);
const scope = support.createScope();
const report = { source, agy, conversations: {}, totals: {} };
/** Stages until the source did not change during the copy, three tries;
 * the last attempt's result. */
const coherently = (stage) => {
  let result;
  for (let attempt = 0; attempt < 3; attempt++) {
    result = stage();
    if (result.coherent) break;
  }
  return result;
};
try {
  if (!coherently(() => staging.stageSummaries(source, profile.store)).coherent)
    throw new Error("the summaries index changed during every copy");
  const conversations = join(profile.store, "conversations");
  const totals = {
    conversations: ids.length,
    inconclusive: 0,
    bytes: 0,
    records: 0,
    projectSeconds: 0,
    unknown: 0,
    replayFailed: 0,
    frames: {
      ordinaryToolCalls: 0,
      failedToolCalls: 0,
      withRawOutput: {},
      ordinaryToolCallUpdates: 0,
      subagentToolCalls: 0,
      subagentToolCallUpdates: 0,
    },
    normalizedOrdinaryResults: 0,
    classes: {},
  };
  for (const id of ids) {
    const entry = {};
    report.conversations[id] = entry;
    // Database, WAL and log from one persisted state, or nothing. A
    // conversation whose database or log is gone since enumeration is
    // reported here; a refused link still stops the census.
    const staged = coherently(() =>
      staging.stageConversation(source, profile.store, id),
    );
    const log = join(
      support.logsDir(profile.store, id),
      "transcript_full.jsonl",
    );
    if (!staged.coherent || staging.identity(log) === null) {
      entry.inconclusive = staged.missing
        ? `gone since enumeration: ${staged.missing.join(", ")}`
        : staged.coherent
          ? "the full log was not staged"
          : "the conversation changed during every copy";
      totals.inconclusive++;
      continue;
    }
    const started = performance.now();
    const projected = await projectFile(log, id);
    const projectSeconds = (performance.now() - started) / 1000;
    totals.bytes += projected.bytes;
    totals.records += projected.records;
    totals.projectSeconds += projectSeconds;
    Object.assign(entry, {
      logBytes: statSync(log).size,
      bytesRead: projected.bytes,
      recordsDecoded: projected.records,
      projectMs: Math.round(projectSeconds * 1000),
      status: projected.status,
      ...(projected.reason ? { reason: projected.reason } : {}),
    });
    if (projected.status !== "known") {
      totals.unknown++;
      continue;
    }
    entry.projectedMessages = projected.messages.length;
    const transcript = new AntigravityTranscript(id);
    const frames = totals.frames;
    // An update may carry only the call's ID and status, so a subagent is
    // recognized by the ID its call announced as well as by its own name.
    const subagentIds = new Set();
    const count = (update) => {
      if (
        update.sessionUpdate !== "tool_call" &&
        update.sessionUpdate !== "tool_call_update"
      )
        return;
      if (
        isAntigravityInvokeSubagent(update) ||
        subagentIds.has(update.toolCallId)
      ) {
        if (update.toolCallId) subagentIds.add(update.toolCallId);
        if (update.sessionUpdate === "tool_call") frames.subagentToolCalls++;
        else frames.subagentToolCallUpdates++;
        return;
      }
      if (update.sessionUpdate === "tool_call_update") {
        frames.ordinaryToolCallUpdates++;
        return;
      }
      frames.ordinaryToolCalls++;
      if (update.status === "failed") frames.failedToolCalls++;
      if (update.rawOutput !== undefined)
        frames.withRawOutput[update.kind ?? "none"] =
          (frames.withRawOutput[update.kind ?? "none"] ?? 0) + 1;
    };
    // Never start agy while anything in the profile leads outside it.
    staging.assertContained(profile.root);
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
          onUpdate: count,
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
      // Late frames still reach the transcript and the counts.
      await support.sleep(500);
      await agent.runtime.close();
    }
    entry.replayMessages = transcript.messages.length;
    const spawns = new Set(
      transcript.messages.flatMap((message) =>
        Array.isArray(message.message?.content)
          ? message.message.content
              .filter(
                (block) =>
                  block.type === "tool_use" && block.name === "spawn_agent",
              )
              .map((block) => block.id)
          : [],
      ),
    );
    entry.normalizedOrdinaryResults = transcript.messages.filter(
      (message) =>
        Array.isArray(message.message?.content) &&
        message.message.content.some(
          (block) =>
            block.type === "tool_result" && !spawns.has(block.tool_use_id),
        ),
    ).length;
    totals.normalizedOrdinaryResults += entry.normalizedOrdinaryResults;
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
