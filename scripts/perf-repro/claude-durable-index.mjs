// Isolated reader/SQL restart diagnostic. No browser, provider process or watcher.
// node scripts/run-with-safe-home.js --temporary-home node --expose-gc \
//   scripts/perf-repro/claude-durable-index.mjs --server-dist <external dist> \
//   --work <fresh scratch> --compactions 20 [--turns 55 --durable 1]
// Each measured phase is a fresh process; source generation is outside timings.
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { rm, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import { claudeSession } from "./scenario-transcripts.mjs";
import {
  readHostCapacity,
  readHostSample,
  summarizeHostWindow,
} from "../perf-suite/host-profile.mjs";
const args = Object.fromEntries(
  Array.from({ length: (process.argv.length - 2) / 2 }, (_, n) => [
    process.argv[2 + n * 2].replace(/^--/, ""),
    process.argv[3 + n * 2],
  ]),
);
assert(args["server-dist"] && args.work, "Pass --server-dist and fresh --work");
const work = resolve(args.work),
  dist = resolve(args["server-dist"]),
  native = join(work, "native"),
  profile = join(work, "profile"),
  id = "12345678-1234-4000-8000-123456789012",
  file = join(native, `${id}.jsonl`);
const load = (file) => import(pathToFileURL(join(dist, file)).href);
if (args.phase) {
  const { openDiscoveryDatabase } = await load("storage/discovery-sqlite.js");
  const { claudeTranscriptCache, createClaudeTranscriptCache } = await load(
    "sessions/claude-transcript-cache.js",
  );
  const { SessionReader } = await load("sessions/reader.js");
  const { normalizeSession } = await load("sessions/normalization.js");
  const db = openDiscoveryDatabase({
    dataDir: profile,
    probeNetworkFilesystem: () => undefined,
  });
  const cache =
    args.durable === "1"
      ? createClaudeTranscriptCache(db)
      : claudeTranscriptCache;
  const reader = new SessionReader({
    sessionDir: native,
    transcriptCache: cache,
  });
  const calls = [];
  const read = async (after) => {
    const start = performance.now();
    let loaded = await reader.getSession(id, "project", after, {
      tailCompactions: 2,
    });
    assert(loaded);
    let normalized = normalizeSession(loaded);
    assert(normalized.messages.length);
    const result = {
      ms: performance.now() - start,
      messages: normalized.messages.length,
      last: normalized.messages.at(-1).uuid ?? normalized.messages.at(-1).id,
      indexed: !!loaded.projectedMessages,
      sql: !!loaded.harnessHistorySource,
    };
    loaded = null;
    normalized = null;
    return result;
  };
  const first = await read();
  calls.push(first);
  if (args.phase === "append") {
    let cursor = first.last;
    for (const chunk of JSON.parse(
      readFileSync(join(work, "appends.json"), "utf8"),
    )) {
      appendFileSync(file, chunk);
      const result = await read(cursor);
      calls.push(result);
      cursor = result.last;
    }
  }
  if (global.gc) {
    for (let n = 0; n < 3; n++) global.gc();
  }
  const memory = process.memoryUsage();
  const result = {
    phase: args.phase,
    durable: args.durable === "1",
    calls,
    memory,
    cache: cache.getStats(),
  };
  writeFileSync(
    join(work, `${args.phase}.json`),
    JSON.stringify(result, null, 2) + "\n",
  );
  await reader.close();
  await cache.close?.();
  db.close();
} else {
  // Refuse existing roots before acquiring cleanup ownership.
  mkdirSync(work, { recursive: false });
  try {
    mkdirSync(native);
    mkdirSync(profile);
    const count = Number(args.compactions ?? 20),
      turns = Number(args.turns ?? 55),
      samples = Number(args.samples ?? 8);
    const generator = claudeSession({
      sessionId: id,
      projectPath: join(work, "project"),
    });
    let at = Date.UTC(2026, 10, 10);
    writeFileSync(file, "");
    for (let n = 0; n < count; n++) {
      for (let turn = 0; turn < turns * 4; turn++)
        appendFileSync(file, generator.next(at++).rows.join("\n") + "\n");
      appendFileSync(file, generator.compact(at++).join("\n") + "\n");
    }
    for (let n = 0; n < 12; n++)
      appendFileSync(file, generator.next(at++).rows.join("\n") + "\n");
    const sourceBytes = (await stat(file)).size;
    const appends = Array.from(
      { length: samples },
      () => generator.next(at++).rows.join("\n") + "\n",
    );
    writeFileSync(join(work, "appends.json"), JSON.stringify(appends));
    const capacity = await readHostCapacity(),
      start = await readHostSample(capacity);
    const nativeSample = () => ({
      cpus: os.cpus().map((c) => c.times),
      swap:
        process.platform === "darwin"
          ? spawnSync("/usr/sbin/sysctl", ["-n", "vm.swapusage"], {
              encoding: "utf8",
            }).stdout
          : null,
    });
    const nativeStart = nativeSample();
    const phases = [];
    for (const phase of ["build", "reopen", "append"]) {
      const child = spawnSync(
        process.execPath,
        [
          "--expose-gc",
          fileURLToPath(import.meta.url),
          "--server-dist",
          dist,
          "--work",
          work,
          "--durable",
          args.durable ?? "0",
          "--phase",
          phase,
        ],
        { encoding: "utf8", env: process.env },
      );
      writeFileSync(join(work, `${phase}.log`), child.stdout + child.stderr);
      assert.equal(child.status, 0, `${phase}: ${child.stderr}`);
      phases.push(
        JSON.parse(readFileSync(join(work, `${phase}.json`), "utf8")),
      );
    }
    const end = await readHostSample(capacity),
      nativeEnd = nativeSample();
    const files = [
      "sessions/claude-source-index.js",
      "sessions/claude-transcript-cache.js",
      "sessions/claude-durable-index.js",
      "sessions/reader.js",
      "storage/discovery-sqlite.js",
    ];
    const fingerprints = Object.fromEntries(
      files.map((file) => {
        try {
          return [
            file,
            createHash("sha256")
              .update(readFileSync(join(dist, file)))
              .digest("hex"),
          ];
        } catch {
          return [file, null];
        }
      }),
    );
    const result = {
      sourceBytes,
      compactions: count,
      turns,
      samples,
      durable: args.durable === "1",
      runtime: {
        node: process.version,
        v8: process.versions.v8,
        platform: process.platform,
        arch: process.arch,
      },
      host: {
        capacity,
        start,
        end,
        qualification: summarizeHostWindow(capacity, start, end),
        nativeStart,
        nativeEnd,
      },
      fingerprints,
      phases,
    };
    writeFileSync(
      join(work, "result.json"),
      JSON.stringify(result, null, 2) + "\n",
    );
    console.log(
      JSON.stringify({
        sourceBytes,
        durable: result.durable,
        phases: phases.map((p) => ({
          phase: p.phase,
          first: p.calls[0].ms,
          updates: p.calls.slice(1).map((c) => c.ms),
          heapMiB: p.memory.heapUsed / 2 ** 20,
          rssMiB: p.memory.rss / 2 ** 20,
          cache: p.cache,
        })),
      }),
    );
  } finally {
    await rm(native, { recursive: true, force: true });
    await rm(profile, { recursive: true, force: true });
    await rm(join(work, "appends.json"), { force: true });
  }
}
