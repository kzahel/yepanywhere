// Preload only in the disposable server. A sample is work completed since the
// previous snapshot. Finished requests and their detached work are distinct.
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { Server } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join, sep } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { DatabaseSync, StatementSync } from "node:sqlite";

import threads from "node:worker_threads";

const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
const inFlight = new Set();
const context = new AsyncLocalStorage();
function window() {
  return {
    lanes: {},
    requests: {},
    worker: {
      starts: 0,
      requests: 0,
      ready: 0,
      releases: 0,
      retired: 0,
      nativeCloses: 0,
      nativeCloseMs: 0,
      maxNativeCloseMs: 0,
      maxReadyMs: 0,
      maxReleaseAckMs: 0,
    },
    fullReadStacks: [],
    statStarts: { claude: 0, codex: 0 },
    statStacks: { claude: [], codex: [] },
    cpu: process.cpuUsage(),
    start: performance.now(),
  };
}
let sample = window();
function laneMetrics() {
  const request = context.getStore();
  const lane = request && !request.finished ? request.route : "background";
  sample.lanes[lane] ??= {};
  return sample.lanes[lane];
}
function count(key, amount = 1) {
  const metrics = laneMetrics();
  metrics[key] = (metrics[key] ?? 0) + amount;
}
function packageStack() {
  const limit = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = 24;
    return new Error().stack
      .replaceAll("\\", "/")
      .split("\n")
      .filter((frame) => frame.includes("/packages/"))
      .slice(0, 15)
      .map((frame) =>
        frame.trim().replace(/(?:file:\/\/)?[^ (]*\/packages\//g, "packages/"),
      );
  } finally {
    Error.stackTraceLimit = limit;
  }
}
const queries = new WeakMap();
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql) {
  const statement = prepare.call(this, sql);
  const normalized = sql.replace(/\s+/g, " ").trim();
  if (
    /FROM session_catalog c LEFT JOIN session_catalog_text/i.test(normalized)
  ) {
    if (/WHERE c\.deleted\s*=\s*0 ORDER BY c\.id$/i.test(normalized))
      queries.set(statement, "full");
    else if (/AND c\.native_id\s*=\s*\? ORDER BY c\.id$/i.test(normalized))
      queries.set(statement, "candidate");
    else queries.set(statement, "otherCatalogProjection");
  } else if (
    /^SELECT id, family, store_key, native_id, row_hash, deleted FROM session_catalog$/i.test(
      normalized,
    )
  ) {
    queries.set(statement, "hashInventory");
  } else if (/^INSERT INTO session_catalog \(/i.test(normalized)) {
    queries.set(statement, "catalogUpsert");
  } else if (/FROM threads INDEXED BY idx_threads_updated_at/i.test(normalized))
    queries.set(
      statement,
      this.location() ===
        join(dirname(process.env.CODEX_SESSIONS_DIR), "state_5.sqlite")
        ? "threadHint"
        : "otherThreadHint",
    );
  else if (/\bFROM threads\b/i.test(normalized))
    queries.set(statement, "thread");
  else if (
    /^SELECT key,unstable FROM collection_query_\d+_sources WHERE unstable>0$/i.test(
      normalized,
    )
  )
    queries.set(statement, "unstableSource");
  else if (/^SELECT .*\bFROM session_catalog\b/i.test(normalized))
    queries.set(statement, "otherCatalogSelect");
  return statement;
};
for (const method of ["all", "get", "run"]) {
  const original = StatementSync.prototype[method];
  StatementSync.prototype[method] = function (...args) {
    const query = queries.get(this);
    if (!query) return original.apply(this, args);
    const start = performance.now();
    const rows = original.apply(this, args);
    count(query + "SqlMs", performance.now() - start);
    if (query === "catalogUpsert") {
      count("catalogUpserts", Number(rows.changes));
    } else {
      count(query + "Reads");
      count(
        query + "Rows",
        method === "all" ? rows.length : Number(rows !== undefined),
      );
      if (query === "full" && sample.fullReadStacks.length < 3)
        sample.fullReadStacks.push(packageStack());
    }
    return rows;
  };
}
const roots = [
  ["codex", process.env.CODEX_SESSIONS_DIR + sep],
  ["claude", process.env.CLAUDE_SESSIONS_DIR + sep],
];
function provider(file) {
  return (
    typeof file === "string" &&
    roots.find(([, prefix]) => file.startsWith(prefix))?.[0]
  );
}
for (const name of ["stat", "readdir", "open", "readFile"]) {
  const original = fsp[name];
  fsp[name] = async function (file, ...args) {
    if (
      name === "stat" &&
      typeof file === "string" &&
      basename(file) === "review-comments.json"
    )
      count("reviewFileChecks");
    const source = provider(file);
    if (source && name === "stat") {
      const ordinal = sample.statStarts[source]++;
      if (ordinal % 512 === 0 && sample.statStacks[source].length < 16)
        sample.statStacks[source].push(packageStack());
    }
    const result = await original.call(this, file, ...args);
    if (!source) return result;
    count(source + "." + name);
    const bytes = source + ".readBytes";
    if (name === "readFile") count(bytes, Buffer.byteLength(result));
    if (name === "open") {
      for (const method of ["read", "readFile"]) {
        const read = result[method];
        result[method] = async function (...args) {
          const value = await read.apply(this, args);
          count(
            bytes,
            method === "read" ? value.bytesRead : Buffer.byteLength(value),
          );
          return value;
        };
      }
    }
    return result;
  };
}
const stream = fs.createReadStream;
fs.createReadStream = function (file, ...args) {
  const result = stream.call(this, file, ...args);
  const source = provider(file);
  if (source)
    result.once("close", () => count(source + ".readBytes", result.bytesRead));
  return result;
};
// Time the synchronous native close itself; a blocked main thread can have
// very little process CPU. Wrap only watches below this cell's provider roots.
const watch = fs.watch;
fs.watch = function (file, ...args) {
  const handle = watch.call(this, file, ...args);
  const source = provider(file);
  if (source) {
    count(source + ".watchOpens");
    const close = handle.close;
    handle.close = function (...args) {
      const started = performance.now();
      try {
        return close.apply(this, args);
      } finally {
        const elapsed = performance.now() - started;
        count(source + ".watchCloses");
        count(source + ".watchCloseMs", elapsed);
        const lane = laneMetrics();
        const field = source + ".longestCloseMs";
        lane[field] = Math.max(lane[field] ?? 0, elapsed);
      }
    };
  }
  return handle;
};
let activeWorkers = 0;
const attached = new Set();
const workerPreload = new URL(
  "./mixed-navigation-worker-probe.mjs",
  import.meta.url,
).href;
threads.Worker = class extends threads.Worker {
  constructor(url, options) {
    const focused =
      url instanceof URL &&
      url.pathname.endsWith("/focused-directory-worker.mjs");
    super(
      url,
      focused ? { ...options, execArgv: ["--import", workerPreload] } : options,
    );
    if (!focused) return;
    activeWorkers++;
    sample.worker.starts++;
    const opened = new Map();
    const released = new Map();
    const post = this.postMessage;
    this.postMessage = function (msg, ...args) {
      if (msg.path) {
        sample.worker.requests++;
        opened.set(msg.id, {
          at: performance.now(),
          provider: provider(msg.path),
        });
      } else {
        sample.worker.releases++;
        released.set(msg.id, performance.now());
        attached.delete(opened.get(msg.id));
      }
      return post.call(this, msg, ...args);
    };
    this.on("message", ({ id, type, ms }) => {
      const metrics = sample.worker;
      if (type === "ready") {
        metrics.ready++;
        if (!released.has(id)) attached.add(opened.get(id));
        metrics.maxReadyMs = Math.max(
          metrics.maxReadyMs,
          performance.now() - opened.get(id).at,
        );
      } else if (type === "released") {
        metrics.retired++;
        metrics.maxReleaseAckMs = Math.max(
          metrics.maxReleaseAckMs,
          performance.now() - released.get(id),
        );
        opened.delete(id);
        released.delete(id);
      } else if (type === "probe-native-close") {
        metrics.nativeCloses++;
        metrics.nativeCloseMs += ms;
        metrics.maxNativeCloseMs = Math.max(metrics.maxNativeCloseMs, ms);
      }
    });
    this.once("exit", () => {
      activeWorkers--;
      for (const entry of opened.values()) attached.delete(entry);
    });
  }
};
syncBuiltinESMExports();

// A cold append can time out before the settled arrival cases. Distinguish
// an observed write from one that never reached the catalog's event bus.
const firstAppendPlan = join(
  process.env.YEP_DATA_DIR,
  "mixed-first-append.json",
);
if (fs.existsSync(firstAppendPlan)) {
  const target = JSON.parse(fs.readFileSync(firstAppendPlan, "utf8"));
  const { EventBus } = await import(
    "../../packages/server/src/watcher/EventBus.ts"
  );
  const emit = EventBus.prototype.emit;
  EventBus.prototype.emit = function (event) {
    if (event.type === "file-change" && event.path === target)
      count("firstAppendFileEvents");
    if (event.type === "session-catalog-updated") count("catalogPublications");
    return emit.call(this, event);
  };
}
let freshness;
const freshnessPlan = join(process.env.YEP_DATA_DIR, "mixed-freshness.json");
if (fs.existsSync(freshnessPlan)) {
  const { installFreshnessProbe } = await import(
    "./mixed-navigation-freshness-probe.mjs"
  );
  const mark = (kind, stack = false) => {
    sample.freshness ??= {};
    sample.freshness[kind] ??= {
      count: 0,
      first: Date.now(),
      ...(stack ? { stack: packageStack() } : {}),
    };
    const point = sample.freshness[kind];
    point.count++;
    point.last = Date.now();
  };
  freshness = await installFreshnessProbe(
    JSON.parse(fs.readFileSync(freshnessPlan, "utf8")),
    mark,
    packageStack,
  );
}
const { ReviewCommentService } = await import(
  "../../packages/server/src/review/ReviewCommentService.ts"
);
for (const method of ["getStoreFile", "getStore", "load"]) {
  const original = ReviewCommentService.prototype[method];
  ReviewCommentService.prototype[method] = function (...args) {
    count("review." + method);
    return original.apply(this, args);
  };
}
function requests(route) {
  sample.requests[route] ??= {
    count: 0,
    completed: 0,
    closed: 0,
    status: {},
    maxMs: 0,
  };
  return sample.requests[route];
}
// The diagnostic control adds an independent shared lease for each of the
// active transcript directories. The normal browser subscriptions still run.
const { watchSharedDirectory } = await import(
  "../../packages/server/src/watcher/SharedDirectoryWatcher.ts"
);
const leases = [];
const emit = Server.prototype.emit;
Server.prototype.emit = function (name, ...args) {
  if (name !== "request") return emit.call(this, name, ...args);
  const [req, res] = args;
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (
    ["PUT", "DELETE"].includes(req.method) &&
    pathname === "/__mixed_navigation_leases"
  ) {
    const plan = join(process.env.YEP_DATA_DIR, "mixed-watch-directories.json");
    if (!fs.existsSync(plan)) {
      res.writeHead(404).end();
      return true;
    }
    if (req.method === "DELETE") {
      for (const lease of leases.splice(0)) lease.close();
    } else if (!leases.length) {
      for (const dir of JSON.parse(fs.readFileSync(plan, "utf8"))) {
        leases.push(
          watchSharedDirectory(dir, { focused: true }, () => {}).unref(),
        );
      }
    }
    res.end(JSON.stringify({ leases: leases.length }));
    return true;
  }
  if (freshness && pathname === "/__mixed_freshness_baselines") {
    res.end(JSON.stringify(freshness.status()));
    return true;
  }
  if (
    freshness &&
    req.method === "POST" &&
    pathname === "/__mixed_freshness_hint"
  ) {
    res.end(JSON.stringify({ delivered: freshness.hint() }));
    return true;
  }
  if (pathname === "/__mixed_navigation_workers") {
    res.end(
      JSON.stringify({
        activeWorkers,
        attached: [...new Set([...attached].map((reg) => reg.provider))],
      }),
    );
    return true;
  }
  if (pathname === "/__mixed_navigation_sample") {
    // Atomically cut only between finite requests. The application maintains
    // a separate long-poll, whose starts and finishes can span windows.
    const pending = [...inFlight]
      .filter((r) => !r.longPoll)
      .map((r) => r.route);
    if (pending.length) {
      res.end(JSON.stringify({ pending }));
      return true;
    }
    const { cpu, start, ...result } = sample;
    const usage = process.cpuUsage(cpu);
    res.end(
      JSON.stringify({
        ...result,
        cpuMs: Math.round((usage.user + usage.system) / 1000),
        elapsedMs: Math.round(performance.now() - start),
        longPollsInFlight: inFlight.size,
        loopMaxMs: loop.count ? loop.max / 1e6 : null,
        loopP99Ms: loop.count ? loop.percentile(99) / 1e6 : null,
      }),
    );
    sample = window();
    loop.reset();
    return true;
  }
  if (!pathname.startsWith("/api/")) return emit.call(this, name, ...args);
  const route = req.method + " " + pathname.replace(/[\w-]{26,}/g, "@");
  requests(route).count++;
  const state = {
    route,
    finished: false,
    longPoll: pathname === "/api/drafts/changes",
  };
  const start = performance.now();
  inFlight.add(state);
  function finish(closed) {
    if (state.finished) return;
    state.finished = true;
    inFlight.delete(state);
    const entry = requests(route);
    if (closed) {
      entry.closed++;
      return;
    }
    entry.completed++;
    entry.status[res.statusCode] = (entry.status[res.statusCode] ?? 0) + 1;
    entry.maxMs = Math.max(entry.maxMs, Math.round(performance.now() - start));
  }
  res.once("finish", () => finish(false));
  res.once("close", () => finish(true));
  return context.run(state, () => emit.call(this, name, ...args));
};
