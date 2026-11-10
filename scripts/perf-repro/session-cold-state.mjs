// Canonical cold metadata/seen ownership diagnostic. Run through safe-home.
// --server-dist <dist> --work <scratch> --label <unique> [--sessions 50000]
// Fresh profile, one-time seen import, warm restart, sweep/miss pressure and
// point writes. No server/browser/provider; compare interleaved profiler-off.
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import {
  readHostCapacity,
  readHostSample,
  summarizeHostWindow,
  assessHostEligibility,
} from "../perf-suite/host-profile.mjs";
const args = Object.fromEntries(
  Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [
    process.argv[2 + i * 2].replace(/^--/, ""),
    process.argv[3 + i * 2],
  ]),
);
assert(
  args["server-dist"] && args.work && args.label,
  "Pass --server-dist, --work and --label",
);
const count = Number(args.sessions ?? 50000),
  promptBytes = Number(args["prompt-bytes"] ?? 1024);
assert(Number.isSafeInteger(count) && count > 0);
const out = resolve(args.work, args.label),
  profile = join(out, "profile");
if (!args["seed-only"]) {
  await mkdir(out, { recursive: false });
  await mkdir(profile);
}
const fromDist = (file) =>
  import(pathToFileURL(resolve(args["server-dist"], file)).href);
const { openDiscoveryDatabase } = await fromDist("storage/discovery-sqlite.js");
const { SessionMetadataService } = await fromDist(
  "metadata/SessionMetadataService.js",
);
const { SessionMetadataRows, encodeMetadata } = await fromDist(
  "metadata/session-metadata-rows.js",
);
const { NotificationService } = await fromDist(
  "notifications/NotificationService.js",
);
const open = () =>
  openDiscoveryDatabase({
    dataDir: profile,
    probeNetworkFilesystem: () => undefined,
  });
const now = new Date().toISOString();
let db;
async function seed() {
  const metadata = new SessionMetadataService({
    database: db,
    dataDir: profile,
  });
  await metadata.initialize();
  const rows = new SessionMetadataRows(db);
  try {
    db.transaction(() => {
      for (let i = 0; i < count; i++)
        rows.write(
          `s-${i}`,
          encodeMetadata({
            provider: i % 2 ? "claude" : "codex",
            customTitle: `Session ${i}`,
            initialPrompt: `${i}:` + "p".repeat(promptBytes),
            isStarred: i % 97 === 0,
          }),
        );
    });
  } finally {
    rows.dispose();
  }
  const entries = Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `s-${i}`,
      { timestamp: now, messageId: `m-${i}` },
    ]),
  );
  await writeFile(
    join(profile, "notifications.json"),
    JSON.stringify({ version: 1, lastSeen: entries }),
  );
  const seen = new NotificationService({ database: db, dataDir: profile });
  const t = performance.now();
  await seen.initialize();
  const firstSeenImportMs = performance.now() - t;
  seen.dispose?.();
  return firstSeenImportMs;
}
if (args["seed-only"]) {
  db = open();
  try {
    const firstSeenImportMs = await seed();
    await writeFile(
      join(out, "seed-result.json"),
      JSON.stringify({ firstSeenImportMs }),
    );
  } finally {
    db.close();
  }
  process.exit(0);
}
const capacity = await readHostCapacity(),
  hostStart = await readHostSample(capacity);
const native = () => ({
  at: new Date().toISOString(),
  cpus: os.cpus().map((c) => c.times),
  swap:
    process.platform === "darwin"
      ? execFileSync("/usr/sbin/sysctl", ["-n", "vm.swapusage"])
          .toString()
          .trim()
      : null,
});
const nativeStart = native();
await new Promise((r) => setTimeout(r, 3000));
const baseline = summarizeHostWindow(
  capacity,
  hostStart,
  await readHostSample(capacity),
);
const eligibility = assessHostEligibility(capacity, baseline, {
  maximumBaselineCpuBusyFraction: 0.8,
  maximumBaselineLoadPerEffectiveCpu: 2,
  maximumBaselineSwapGrowthMiB: 16,
  minimumEffectiveAvailableMemoryMiB: 1024,
  minimumEffectiveLogicalCpuCount: 2,
  minimumIdleLogicalCpuCount: 1,
});
// The seed/import high-water mark belongs to another process. RSS below is
// ordinary restart residency, not the V8 arena left behind by fixture creation.
const seeded = spawnSync(
  process.execPath,
  [
    fileURLToPath(import.meta.url),
    ...process.argv.slice(2),
    "--seed-only",
    "true",
  ],
  { encoding: "utf8" },
);
assert.equal(seeded.status, 0, seeded.stdout + seeded.stderr);
const { firstSeenImportMs } = JSON.parse(
  await readFile(join(out, "seed-result.json"), "utf8"),
);
db = open();
const gc = () => {
  if (globalThis.gc) globalThis.gc();
  else globalThis.Bun?.gc(true);
};
const memory = () =>
  Array.from({ length: 7 }, () => {
    gc();
    return process.memoryUsage();
  });
const result = {
  scenario: {
    sessions: count,
    promptBytes,
    seenEntries: count,
    browser: false,
    providerProcesses: 0,
  },
  runtime: {
    node: process.version,
    bun: process.versions.bun ?? null,
    v8: process.versions.v8,
  },
  harnessRevision: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(),
  capacity,
  baseline,
  eligibility,
  nativeStart,
  firstSeenImportMs,
  separateSeedProcess: true,
  memory: { before: memory() },
  forcedGc: Boolean(globalThis.gc || globalThis.Bun?.gc),
  buildFiles: {},
};
const metadata = new SessionMetadataService({ database: db, dataDir: profile }),
  seen = new NotificationService({ database: db, dataDir: profile });
try {
  let parses = 0,
    parseCharacters = 0;
  const parse = JSON.parse;
  JSON.parse = function (text, ...rest) {
    parses++;
    parseCharacters += text.length;
    return parse.call(this, text, ...rest);
  };
  try {
    let t = performance.now();
    await metadata.initialize();
    result.metadataRestartMs = performance.now() - t;
    t = performance.now();
    await seen.initialize();
    result.seenRestartMs = performance.now() - t;
  } finally {
    JSON.parse = parse;
  }
  result.restartParsing = { calls: parses, characters: parseCharacters };
  result.memory.initialized = memory();
  let t = performance.now();
  for (let i = 0; i < count; i++) {
    const id = `s-${i}`;
    assert.equal(metadata.getMetadata(id)?.customTitle, `Session ${i}`);
    assert(metadata.getMetadata(id)?.initialPrompt.startsWith(`${i}:`));
    assert.equal(seen.getLastSeen(id)?.messageId, `m-${i}`);
  }
  result.sweepMs = performance.now() - t;
  for (let i = 0; i < count; i++)
    assert.equal(metadata.getMetadata(`missing-${i}`), undefined);
  result.workingSet = metadata.getWorkingSetMetrics?.() ?? null;
  if (result.workingSet) {
    assert(result.workingSet.entries <= result.workingSet.entryBudget);
    assert(
      result.workingSet.estimatedPayloadBytes <=
        result.workingSet.payloadByteBudget,
    );
  }
  result.residentSeenEntries = Object.keys(seen.state?.lastSeen ?? {}).length;
  result.memory.swept = memory();
  result.seenWritesMs = [];
  for (let i = 0; i < 12; i++) {
    t = performance.now();
    await seen.markSeen(
      "s-0",
      new Date(Date.now() + 60000 + i * 1000).toISOString(),
      `new-${i}`,
    );
    result.seenWritesMs.push(performance.now() - t);
  }
  assert.equal(seen.getLastSeen("s-0")?.messageId, "new-11");
  await seen.clearSession("s-0");
  assert(seen.hasUnread("s-0", now));
  await metadata.setStarred("s-1", true);
  await metadata.flushPendingWrites();
  await seen.flush();
  result.memory.afterWrites = memory();
  const cold = new SessionMetadataService({ database: db, dataDir: profile });
  await cold.initialize();
  const coldSeen = new NotificationService({ database: db, dataDir: profile });
  await coldSeen.initialize();
  assert.equal(cold.getMetadata("s-1")?.isStarred, true);
  assert.equal(coldSeen.getLastSeen("s-0"), undefined);
  coldSeen.dispose?.();
  for (const file of [
    "metadata/SessionMetadataService.js",
    "metadata/session-metadata-rows.js",
    "metadata/metadata-working-set.js",
    "notifications/NotificationService.js",
    "notifications/session-last-seen.js",
    "storage/migrations/032-session-cold-state.js",
  ]) {
    try {
      result.buildFiles[file] = createHash("sha256")
        .update(await readFile(resolve(args["server-dist"], file)))
        .digest("hex");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  result.nativeEnd = native();
  result.hostEnd = await readHostSample(capacity);
  result.hostWindow = summarizeHostWindow(capacity, hostStart, result.hostEnd);
  await writeFile(
    join(out, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      restartMs: [result.metadataRestartMs, result.seenRestartMs],
      parse: result.restartParsing,
      workingSet: result.workingSet,
      seenWriteMedianMs: [...result.seenWritesMs].sort((a, b) => a - b)[6],
      heapMiB: result.memory.swept.at(-1).heapUsed / 1024 ** 2,
    }),
  );
} finally {
  seen.dispose?.();
  db.close();
  await rm(profile, { recursive: true, force: true });
}
