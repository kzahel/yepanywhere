// Isolated catalog residency and point-publication diagnostic. Run with
// run-with-safe-home.js --temporary-home, --expose-gc and external builds.
// --server-dist <dist> --work <scratch> --label <unique> [--sessions 50000]
// Fresh subprocess after seed; no provider/server/browser or real stores.
import assert from "node:assert/strict";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  "Pass --server-dist, --work, --label",
);
const out = resolve(args.work, args.label),
  profile = join(out, "profile"),
  count = Number(args.sessions ?? 50000);
const load = (file) =>
  import(pathToFileURL(resolve(args["server-dist"], file)).href);
const { openDiscoveryDatabase } = await load("storage/discovery-sqlite.js");
const { SessionCatalogService } = await load(
  "services/SessionCatalogService.js",
);
const store = join(out, "native");
const row = (i) => ({
  catalogFamily: "claude",
  storeKey: store,
  nativeStorageScope: store,
  sessionId: `native-${i}`,
  projectId: "cHJvamVjdA",
  projectPath: "/project",
  projectIdentityKey: "/project",
  provider: "claude",
  updatedAt: "2026-11-10T12:00:00.000Z",
  title: `Session ${i} ${"context ".repeat(8)}`,
  fidelity: "head",
  sourceVersion: "v1",
  location: { kind: "file", path: join(store, `native-${i}.jsonl`) },
});
if (args.phase === "seed") {
  await mkdir(profile, { recursive: true });
  const db = openDiscoveryDatabase({
    dataDir: profile,
    probeNetworkFilesystem: () => undefined,
  });
  const catalog = new SessionCatalogService({ database: db });
  await catalog.initialize();
  await catalog.reconcile([
    {
      catalogFamily: "claude",
      storeKey: store,
      scan: async () => ({
        sourceVersion: "fixture",
        rows: Array.from({ length: count }, (_, i) => row(i)),
      }),
    },
  ]);
  catalog.stop();
  db.close();
} else if (args.phase === "measure") {
  const db = openDiscoveryDatabase({
    dataDir: profile,
    probeNetworkFilesystem: () => undefined,
  });
  const catalog = new SessionCatalogService({ database: db });
  const initialStart = performance.now();
  await catalog.initialize();
  const initializeMs = performance.now() - initialStart;
  const memory = [];
  for (let i = 0; i < 7; i++) {
    if (globalThis.gc) globalThis.gc();
    else globalThis.Bun?.gc(true);
    memory.push(process.memoryUsage());
  }
  const times = [];
  for (let i = 0; i < 12; i++) {
    const updated = { ...row(0), title: `changed-${i}` };
    const start = performance.now();
    await catalog.upsertRows([updated]);
    times.push(performance.now() - start);
  }
  assert.equal(catalog.getSnapshot().rowCount, count);
  const keyed = catalog.readRow?.(
    JSON.stringify(["claude", store, "native-0"]),
  );
  if (keyed) assert.equal(keyed.title, "changed-11");
  const hashes = {};
  for (const file of [
    "services/SessionCatalogService.js",
    "services/session-catalog-sqlite.js",
  ])
    hashes[file] = createHash("sha256")
      .update(await readFile(resolve(args["server-dist"], file)))
      .digest("hex");
  await writeFile(
    join(out, "measurement.json"),
    JSON.stringify(
      {
        initializeMs,
        memory,
        pointPublicationMs: times,
        workingSet: catalog.getWorkingSetMetrics?.() ?? null,
        runtime: process.versions,
        hashes,
      },
      null,
      2,
    ),
  );
  catalog.stop();
  db.close();
} else {
  await mkdir(out, { recursive: false });
  const nativeSample = () => ({
    at: new Date().toISOString(),
    cpus: os.cpus().map((c) => c.times),
    load: os.loadavg(),
    swap:
      process.platform === "darwin"
        ? execFileSync("/usr/sbin/sysctl", ["-n", "vm.swapusage"])
            .toString()
            .trim()
        : null,
  });
  const nativeStart = nativeSample();
  const capacity = await readHostCapacity(),
    start = await readHostSample(capacity);
  await new Promise((r) => setTimeout(r, 3000));
  const baseline = summarizeHostWindow(
    capacity,
    start,
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
  try {
    for (const phase of ["seed", "measure"]) {
      const child = spawnSync(
        process.execPath,
        [
          ...process.execArgv,
          process.argv[1],
          ...process.argv.slice(2),
          "--phase",
          phase,
        ],
        { stdio: "inherit", env: process.env },
      );
      assert.equal(child.status, 0, `Catalog ${phase} failed`);
    }
    const measurement = JSON.parse(
      await readFile(join(out, "measurement.json"), "utf8"),
    );
    const end = await readHostSample(capacity);
    const nativeEnd = nativeSample();
    const result = {
      nativeStart,
      nativeEnd,
      scenario: { sessions: count, providerProcesses: 0 },
      capacity,
      baseline,
      eligibility,
      hostWindow: summarizeHostWindow(capacity, start, end),
      ...measurement,
    };
    await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2));
    console.log(
      JSON.stringify({
        initializeMs: result.initializeMs,
        heapMiB: Math.min(...result.memory.map((m) => m.heapUsed)) / 2 ** 20,
        pointPublicationMs: result.pointPublicationMs,
      }),
    );
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}
