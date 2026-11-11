// Full sidebar session-feed refresh diagnostic, using isolated profile SQL and
// canonical HTTP routes. No provider histories/processes or browser are used.
// Run through run-with-safe-home.js --temporary-home. --counts is attribution
// only; timing runs leave the SQL adapter unwrapped. Builds stay outside the tree.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  measuredHostSample,
  startHostEvidence,
} from "./active-session-metrics.mjs";
import { summarizeHostWindow } from "../perf-suite/host-profile.mjs";
const args = {};
for (let i = 2; i < process.argv.length; i += 2)
  args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
assert(
  args["server-dist"] && args.work && args.label,
  "Pass --server-dist, --work and --label",
);
const count = Number(args.sessions ?? 50000),
  samples = Number(args.samples ?? 100),
  projects = 200;
assert(
  Number.isInteger(count) &&
    count >= 400 &&
    Number.isInteger(samples) &&
    samples > 0,
);
const out = resolve(args.work, args.label),
  profile = join(out, "profile");
await mkdir(out, { recursive: false });
const load = (file) =>
  import(pathToFileURL(resolve(args["server-dist"], file)).href);
const host = await startHostEvidence(false);
const capacity = host.capacity;
const { openDiscoveryDatabase } = await load("storage/discovery-sqlite.js");
const { SessionCatalogService } = await load(
  "services/SessionCatalogService.js",
);
const { RetainedSessionCollections } = await load(
  "services/RetainedSessionCollections.js",
);
const { SessionMetadataService } = await load(
  "metadata/SessionMetadataService.js",
);
const { NotificationService } = await load(
  "notifications/NotificationService.js",
);
const { createGlobalSessionsRoutes } = await load("routes/global-sessions.js");
const db = openDiscoveryDatabase({
  dataDir: profile,
  probeNetworkFilesystem: () => undefined,
});
const sqlCounts = new Map();
let tracking = false;
if (args.counts === "true") {
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const statement = prepare(sql);
    const key = sql.replace(/collection_query_\d+/g, "collection_query");
    const wrapped = {};
    for (const method of ["get", "all", "run"])
      wrapped[method] = (...values) => {
        if (!tracking) return statement[method](...values);
        const start = performance.now();
        const value = statement[method](...values);
        const entry = sqlCounts.get(key) ?? { calls: 0, rows: 0, ms: 0 };
        entry.calls++;
        entry.rows += Array.isArray(value)
          ? value.length
          : method === "get" && value
            ? 1
            : 0;
        entry.ms += performance.now() - start;
        sqlCounts.set(key, entry);
        return value;
      };
    wrapped.finalize = () => statement.finalize();
    return wrapped;
  };
}
const metadata = new SessionMetadataService({ dataDir: profile, database: db });
await metadata.initialize();
const seen = new NotificationService({ dataDir: profile, database: db });
await seen.initialize();
const id = (i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
const now = Date.now();
let seedRows = Array.from({ length: count }, (_, i) => {
  const path = join("/fixture-sidebar", "projects", `project-${i % projects}`),
    family = i % 2 ? "claude" : "codex";
  return {
    catalogFamily: family,
    storeKey: join("/fixture-sidebar", "native", family),
    nativeStorageScope: join("/fixture-sidebar", "native", family),
    sessionId: id(i),
    projectId: Buffer.from(path).toString("base64url"),
    projectPath: path,
    projectIdentityKey: path,
    provider: family,
    title: `Session ${i} ${"context ".repeat(32)}`,
    createdAt: new Date(now - i * 300000).toISOString(),
    updatedAt: new Date(now - i * 300000).toISOString(),
    lastHumanTurnAt: new Date(now - i * 300000).toISOString(),
    fidelity: "head",
    sourceVersion: "fixture-v1",
    location: { kind: "provider", recordId: id(i) },
  };
});
const expected = { recent: [], starred: [], categorized: [] };
for (let i = 0; i < count; i++) {
  if (i < 50) expected.recent.push(id(i));
  if (i % 997 === 0) {
    await metadata.setStarred(id(i), true);
    if (expected.starred.length < 50) expected.starred.push(id(i));
  }
  if (i % 613 === 0) {
    await metadata.updateMetadata(id(i), {
      sidebarCategory: `Category ${i % 3}`,
    });
    if (expected.categorized.length < 50) expected.categorized.push(id(i));
  }
}
await metadata.flushPendingWrites();
const adapters = () =>
  ["claude", "codex"].map((family) => ({
    catalogFamily: family,
    storeKey: join("/fixture-sidebar", "native", family),
    scan: async () => {
      assert(seedRows, "Warm refresh entered provider discovery");
      return {
        sourceVersion: "fixture",
        rows: seedRows.filter((row) => row.catalogFamily === family),
      };
    },
  }));
const collections = new RetainedSessionCollections({
  dataDir: profile,
  database: db,
  adapters: async () => adapters(),
});
const deps = {
  retainedCollections: collections,
  sessionMetadataService: metadata,
  notificationService: seen,
  scanner: {
    listProjects() {
      throw Error("Sidebar entered provider discovery");
    },
  },
  readerFactory() {
    throw Error("Sidebar entered transcript reads");
  },
};
const route = createGlobalSessionsRoutes(deps);
const queries = {
  recent: "",
  starred: "&starred=true",
  categorized: "&categorized=true",
};
const request = async () => {
  const start = performance.now(),
    bodies = {},
    bytes = {};
  if (args.snapshot === "true") {
    const response = await route.request(
      "/sidebar?recentLimit=50&starredLimit=50&categorizedLimit=50",
    );
    assert.equal(response.status, 200, await response.clone().text());
    const text = await response.text();
    const snapshot = JSON.parse(text),
      rows = new Map(snapshot.rows.map((row) => [row.id, row]));
    bytes.snapshot = Buffer.byteLength(text);
    for (const name of Object.keys(queries)) {
      const window = snapshot.windows[name];
      assert.deepEqual(window.ids, expected[name]);
      bodies[name] = {
        sessions: window.ids.map((id) => rows.get(id)),
        hasMore: window.hasMore,
      };
    }
    return {
      ms: performance.now() - start,
      bytes,
      bodies,
      serverTiming: response.headers.get("Server-Timing"),
    };
  }
  for (const [name, filter] of Object.entries(queries)) {
    const response = await route.request(
      `/?summaryMode=retained&includeStats=false&limit=50${filter}`,
    );
    assert.equal(response.status, 200);
    const text = await response.text();
    bytes[name] = Buffer.byteLength(text);
    bodies[name] = JSON.parse(text);
    assert.deepEqual(
      bodies[name].sessions.map((row) => row.id),
      expected[name],
    );
  }
  return { ms: performance.now() - start, bytes, bodies };
};
let result;
try {
  await collections.refresh();
  const cold = await request();
  seedRows = null;
  for (let i = 0; i < 5; i++) await request();
  for (let i = 0; i < 3; i++) globalThis.gc?.();
  const memoryBefore = process.memoryUsage();
  const phaseStart = await measuredHostSample(capacity);
  const cpuStart = process.cpuUsage();
  const times = [];
  let last;
  tracking = args.counts === "true";
  for (let i = 0; i < (tracking ? 1 : samples); i++) {
    last = await request();
    times.push(last.ms);
  }
  tracking = false;
  const cpu = process.cpuUsage(cpuStart),
    hostEnd = await measuredHostSample(capacity);
  await metadata.setStarred(id(0), false);
  expected.starred.shift();
  if (Math.floor((count - 1) / 997) >= 50) expected.starred.push(id(50 * 997));
  const mutation = await request();
  assert(!mutation.bodies.starred.sessions.some((row) => row.id === id(0)));
  for (let i = 0; i < 3; i++) globalThis.gc?.();
  result = {
    scenario: {
      count,
      projects,
      feeds: 3,
      limit: 50,
      samples,
      snapshot: args.snapshot === "true",
      providerHistory: false,
      browser: false,
    },
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      bun: process.versions.bun ?? null,
      executable: process.execPath,
      executableSha256: createHash("sha256")
        .update(await readFile(process.execPath))
        .digest("hex"),
    },
    attributionOnly: args.counts === "true",
    coldMs: cold.ms,
    timesMs: times,
    totalProcessCpuMs: (cpu.user + cpu.system) / 1000,
    serverTiming: last.serverTiming,
    bytes: last.bytes,
    totalBytes: Object.values(last.bytes).reduce((a, b) => a + b, 0),
    mutationMs: mutation.ms,
    sql: [...sqlCounts].map(([sql, value]) => ({ sql, ...value })),
    memoryBefore,
    memoryAfter: process.memoryUsage(),
    capacity,
    host,
    baseline: host.baseline,
    hostSamples: { start: phaseStart, end: hostEnd },
    hostWindow: summarizeHostWindow(capacity, phaseStart, hostEnd),
    catalogWorkingSet: collections.catalog?.getWorkingSetMetrics?.(),
    sourceFiles: {},
  };
  for (const file of [
    "routes/global-sessions.js",
    "services/retained-session-query.js",
    "services/session-collection-sql.js",
  ])
    result.sourceFiles[file] = createHash("sha256")
      .update(await readFile(resolve(args["server-dist"], file)))
      .digest("hex");
  result.artifacts = {};
  for (const [name, directory] of Object.entries({
    server: args["server-dist"],
    shared: resolve(args["server-dist"], "../../shared/dist"),
  })) {
    const hash = createHash("sha256");
    for (const file of (await readdir(directory, { recursive: true }))
      .filter((file) => file.endsWith(".js"))
      .sort()) {
      hash.update(file);
      hash.update(await readFile(join(directory, file)));
    }
    result.artifacts[name] = hash.digest("hex");
  }
  result.artifacts.harness = createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex");
  result.artifacts.metrics = createHash("sha256")
    .update(
      await readFile(new URL("./active-session-metrics.mjs", import.meta.url)),
    )
    .digest("hex");
  await writeFile(
    join(out, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  const sorted = [...times].sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      label: args.label,
      coldMs: cold.ms,
      medianMs: sorted[Math.floor(sorted.length / 2)],
      totalBytes: result.totalBytes,
      sqlCalls: result.sql.reduce((sum, row) => sum + row.calls, 0),
      mutationMs: mutation.ms,
    }),
  );
} finally {
  await collections.dispose();
  await metadata.flushPendingWrites();
  seen.dispose();
  db.close();
  await rm(profile, { recursive: true, force: true });
}
