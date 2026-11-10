// Isolated retained list/Inbox query comparison. No provider/browser/server.
// Run through run-with-safe-home.js --temporary-home. Builds stay outside the
// shared tree. --server-dist <dist> --work <scratch> --label <unique>
// [--sessions 50000 --projects 200 --samples 12]. Compare interleaved fresh
// profiles, profiler off. Reports query+serialization, initial projection cost,
// metadata touches, memory and host evidence; not a portable timing gate.
// --verify-archive true adds a post-measurement clock/SQL-counter round trip.
import assert from "node:assert/strict";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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
  projects = Number(args.projects ?? 200),
  samples = Number(args.samples ?? 12);
const out = resolve(args.work, args.label),
  profile = join(out, "profile");
await mkdir(out, { recursive: false });
await mkdir(profile);
const fromDist = async (file) =>
  import(pathToFileURL(resolve(args["server-dist"], file)).href);
const capacity = await readHostCapacity(),
  start = await readHostSample(capacity);
const nativeSample = () => ({
  at: new Date().toISOString(),
  cpus: os.cpus().map((c) => c.times),
  swap:
    process.platform === "darwin"
      ? execFileSync("/usr/sbin/sysctl", ["-n", "vm.swapusage"])
          .toString()
          .trim()
      : null,
});
const nativeStart = nativeSample();
await new Promise((r) => setTimeout(r, 3000));
const baselineEnd = await readHostSample(capacity);
const baseline = summarizeHostWindow(capacity, start, baselineEnd);
const eligibility = assessHostEligibility(capacity, baseline, {
  maximumBaselineCpuBusyFraction: 0.8,
  maximumBaselineLoadPerEffectiveCpu: 2,
  maximumBaselineSwapGrowthMiB: 16,
  minimumEffectiveAvailableMemoryMiB: 1024,
  minimumEffectiveLogicalCpuCount: 2,
  minimumIdleLogicalCpuCount: 1,
});
const { openDiscoveryDatabase } = await fromDist("storage/discovery-sqlite.js");
const { SessionCatalogService } = await fromDist(
  "services/SessionCatalogService.js",
);
const { RetainedSessionCollections } = await fromDist(
  "services/RetainedSessionCollections.js",
);
const { SessionMetadataService } = await fromDist(
  "metadata/SessionMetadataService.js",
);
const { NotificationService } = await fromDist(
  "notifications/NotificationService.js",
);
const { createGlobalSessionsRoutes } = await fromDist(
  "routes/global-sessions.js",
);
const { createInboxRoutes } = await fromDist("routes/inbox.js");
const db = openDiscoveryDatabase({
  dataDir: profile,
  probeNetworkFilesystem: () => undefined,
});
const metadata = new SessionMetadataService({ dataDir: profile, database: db });
await metadata.initialize();
const notifications = new NotificationService({ dataDir: profile });
await notifications.initialize();
const now = Date.now();
let rows = Array.from({ length: count }, (_, i) => {
  const projectPath = join(out, "projects", `p${i % projects}`);
  const family = i % 2 ? "claude" : "codex";
  const scope = join(out, "native", family);
  return {
    catalogFamily: family,
    storeKey: scope,
    nativeStorageScope: scope,
    sessionId: `session-${i}`,
    projectId: Buffer.from(projectPath).toString("base64url"),
    projectPath,
    projectIdentityKey: projectPath,
    provider: family,
    updatedAt: new Date(now - i * 300000).toISOString(),
    title: `Session ${i} ${"context ".repeat(8)}`,
    fidelity: "head",
    sourceVersion: "v1",
    location: { kind: "provider", recordId: `session-${i}` },
  };
});
const adapters = () =>
  ["claude", "codex"].map((family) => ({
    catalogFamily: family,
    storeKey: join(out, "native", family),
    scan: async () => ({
      sourceVersion: "fixture",
      rows: rows.filter((r) => r.catalogFamily === family),
    }),
  }));
const seed = new SessionCatalogService({ database: db });
await seed.initialize();
await seed.reconcile(adapters());
seed.stop();
const collections = new RetainedSessionCollections({
  dataDir: profile,
  database: db,
  adapters: async () => adapters(),
});
await collections.refresh();
const deps = {
  retainedCollections: collections,
  sessionMetadataService: metadata,
  notificationService: notifications,
  sessionAutoArchiveDays: args["verify-archive"] ? 365 : 0,
  scanner: {
    listProjects: () => {
      throw new Error("query entered discovery");
    },
  },
  readerFactory: () => {
    throw new Error("query entered provider history");
  },
};
const lists = createGlobalSessionsRoutes(deps),
  inbox = createInboxRoutes(deps);
let expectedActive = count;
const request = async (kind) => {
  const start = performance.now();
  const response = await (kind === "list" ? lists : inbox).request(
    kind === "list"
      ? "/?summaryMode=retained&limit=50"
      : "/?summaryMode=retained",
  );
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  if (kind === "list") assert.equal(body.stats.totalCount, expectedActive);
  return { ms: performance.now() - start, body };
};
const result = {
  scenario: {
    sessions: count,
    projects,
    claudeShare: 0.5,
    metadataInitiallyEmpty: true,
    providerProcesses: 0,
    browser: false,
  },
  runtime: {
    node: process.version,
    bun: process.versions.bun ?? null,
    v8: process.versions.v8,
  },
  revision: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(),
  capacity,
  baseline,
  eligibility,
  nativeStart,
  initial: {},
  warm: {},
  metadataTouches: {},
  memory: [],
  forcedGc: Boolean(globalThis.gc || globalThis.Bun?.gc),
  buildFiles: {},
};
try {
  for (const kind of ["list", "inbox"])
    result.initial[kind] = (await request(kind)).ms;
  for (const kind of ["list", "inbox"]) {
    const times = [];
    for (let i = 0; i < samples; i++) times.push((await request(kind)).ms);
    result.warm[kind] = times;
  }
  const getMetadata = metadata.getMetadata.bind(metadata);
  let touches = 0;
  metadata.getMetadata = (id) => {
    touches++;
    return getMetadata(id);
  };
  for (const kind of ["list", "inbox"]) {
    touches = 0;
    await request(kind);
    result.metadataTouches[kind] = touches;
  }
  metadata.getMetadata = getMetadata;
  for (let i = 0; i < 7; i++) {
    if (globalThis.gc) globalThis.gc();
    else globalThis.Bun?.gc(true);
    result.memory.push(process.memoryUsage());
  }
  const first = (await request("list")).body.sessions[0].id;
  await metadata.setStarred(first, true);
  const changed = await request("list");
  assert.equal(changed.body.stats.starredCount, 1);
  result.metadataMutationQueryMs = changed.ms;
  if (args["verify-archive"]) {
    const realNow = Date.now;
    try {
      Date.now = () => now + 400 * 86400_000;
      expectedActive = 0;
      const archived = (await request("list")).body.stats.archivedCount;
      assert.equal(archived, count);
      Date.now = realNow;
      expectedActive = count;
      const restored = (await request("list")).body.stats.totalCount;
      result.archiveRoundtrip = { archived, restored };
    } finally {
      Date.now = realNow;
    }
  }
  const queryTables = db.prepare(
    "SELECT name FROM sqlite_temp_master WHERE type='table' AND name LIKE 'collection_query_%_rows'",
  );
  const tables = queryTables.all();
  queryTables.finalize();
  result.queryOwners = tables.length;
  if (tables.length) {
    const table = tables[0].name;
    const plan = db.prepare(
      `EXPLAIN QUERY PLAN SELECT id FROM ${table} WHERE archived=0 AND attention=0 AND active=1 ORDER BY updated_ms DESC,id LIMIT 20`,
    );
    result.activeTierPlan = plan.all();
    plan.finalize();
  }
  for (const file of [
    "routes/global-sessions.js",
    "routes/inbox.js",
    "services/retained-session-query.js",
    "services/session-collection-sql.js",
  ]) {
    try {
      result.buildFiles[file] = createHash("sha256")
        .update(await readFile(resolve(args["server-dist"], file)))
        .digest("hex");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  result.nativeEnd = nativeSample();
  result.hostEnd = await readHostSample(capacity);
  result.hostWindow = summarizeHostWindow(capacity, start, result.hostEnd);
  await writeFile(
    join(out, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  for (const kind of ["list", "inbox"]) {
    const sorted = [...result.warm[kind]].sort((a, b) => a - b);
    console.log(
      kind,
      "median",
      sorted[Math.floor(sorted.length / 2)].toFixed(2),
      "p95",
      sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(2),
      "ms",
      "metadata touches",
      result.metadataTouches[kind],
    );
  }
  console.log("saved", join(out, "result.json"));
} finally {
  await collections.dispose();
  await metadata.flushPendingWrites();
  await notifications.flush();
  db.close();
  await rm(profile, { recursive: true, force: true });
}
