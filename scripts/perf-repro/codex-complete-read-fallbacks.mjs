// Codex complete-reader fallback census (provider-history-facts step 3).
// Read-only: walks a Codex sessions root and asks the server's own window
// reader what an uncursored compact-tail open would do for each rollout. No
// server, watcher or provider process, and it writes no files: all output,
// including --json, goes to stdout.
//
//   pnpm exec tsx --conditions source \
//     scripts/perf-repro/codex-complete-read-fallbacks.mjs \
//     [--sessions ~/.codex/sessions] [--json] [--list-largest N] \
//     [--getsession-check N]
//
// Default output is aggregate only. --list-largest prints local paths; do not
// commit its output. --getsession-check runs CodexSessionReader.getSession on
// the N largest rollouts of each outcome and checks readWindow agrees. Every
// reference-backed fork is checked through getSession in the main run.
import assert from "node:assert/strict";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { zstdDecompress } from "node:zlib";

function fail(message) {
  console.error(`codex-complete-read-fallbacks: ${message}`);
  process.exit(2);
}
const FLAGS = {
  sessions: "path",
  json: "flag",
  "list-largest": "count",
  "getsession-check": "count",
};
const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const name = process.argv[i].replace(/^--/, "");
  const kind = process.argv[i].startsWith("--") ? FLAGS[name] : undefined;
  if (!kind) fail(`unknown argument ${process.argv[i]}`);
  if (kind === "flag") {
    args[name] = true;
    continue;
  }
  const value = process.argv[++i];
  if (value === undefined || value.startsWith("--"))
    fail(`--${name} needs a value`);
  if (kind === "count" && !/^\d+$/.test(value))
    fail(`--${name} needs a non-negative integer`);
  args[name] = kind === "count" ? Number(value) : value;
}
const sessionsDir = resolve(
  (args.sessions ?? "~/.codex/sessions").replace(/^~(?=\/|$)/, homedir()),
);

const src = new URL("../../packages/server/src/", import.meta.url);
const load = (path) => import(new URL(path, src).href);
// The reader logs local paths; keep stdout to this script's aggregate output.
const { initLogger } = await load("logging/logger.ts");
initLogger({ consoleLevel: "silent", fileLevel: "silent", logToFile: false });
const { CodexRolloutWindowReader } = await load(
  "sessions/codex-rollout-window.ts",
);
const { readCodexSessionMeta, resolveCodexRolloutLineage } = await load(
  "sessions/codex-rollout-lineage.ts",
);
const { readCodexIncrementalSnapshot } = await load(
  "sessions/codex-incremental-snapshot.ts",
);
const { codexRootFileIndex } = await load("sessions/codex-root-file-index.ts");
const { isSubagentSessionMeta } = await load("sessions/codex-discovery.ts");
const { normalizeSession } = await load("sessions/normalization.ts");
const { CodexSessionReader } = await load("sessions/codex-reader.ts");
const files = await load("utils/codexRolloutFiles.ts");
const { parseCodexSessionEntry } = await load("../../shared/src/index.ts");

// What each path really requests on an initial open: the session page sends
// DEFAULT_SESSION_INITIAL_HISTORY_COMPACTIONS (2, also the route's default) and
// v0 conversation defaults tailCompactions to 2. Catch-up reuses the detail N.
const PATHS = [
  { name: "detail open", compactions: 2 },
  { name: "v0 conversation", compactions: 2 },
];
const ESTIMATE_BYTES_PER_BOUNDARY = 2 * 1024 * 1024; // codex-rollout-window.ts
const MB = 1e6;
const O = {
  bounded: "bounded compact tail",
  fork: "reference-backed fork",
  compressed: "compressed rollout",
  small: "at or below size estimate",
  fewer: "fewer boundaries than requested",
  byteZero: "Nth boundary at byte 0",
  notCompacted: "range does not begin with compacted",
  fails: "open fails: unreadable meta or lineage",
};
const OUTCOMES = Object.values(O);

const traversalErrors = [];
async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      await walk(path, out).catch((error) =>
        traversalErrors.push(error.code ?? error.message),
      );
    else if (entry.isFile() && files.isCodexRolloutFileName(entry.name))
      out.push(path);
  }
  return out;
}
const rootFiles = await walk(sessionsDir).catch((error) =>
  fail(`cannot read sessions root ${sessionsDir}: ${error.code ?? error}`),
);
// The server's own resolver (CodexSessionReader.findRolloutPathById) decides
// whether an archive root is searched.
async function resolveRolloutPath(id) {
  const index = codexRootFileIndex(sessionsDir);
  const lookup = index.readVersion();
  const path = await index.findRolloutPath(id, enumerate);
  return index.accepts(lookup) ? path : resolveRolloutPath(id);
}
const enumerate = async (dir) =>
  files.preferPlainCodexRollouts(
    dir === sessionsDir
      ? rootFiles
      : await walk(dir).catch((error) => {
          if (error.code !== "ENOENT")
            traversalErrors.push(error.code ?? error.message);
          return [];
        }),
  );

// Plain read of an exact range, like CodexSessionReader.readFileRange, with
// the backward boundary scan's bytes counted apart from everything else.
let phase = "window";
const read = { scan: 0, window: 0 };
async function readExactRange(filePath, start, length) {
  read[phase] += length;
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    for (let filled = 0; filled < length; ) {
      const { bytesRead } = await handle.read(
        buffer,
        filled,
        length - filled,
        start + filled,
      );
      assert(bytesRead > 0, "rollout changed during read");
      filled += bytesRead;
    }
    return buffer;
  } finally {
    await handle.close();
  }
}
const windowReader = new CodexRolloutWindowReader(readExactRange);
// Spy on the real backward scan so null (no Nth boundary) and 0 are told apart.
const realScan = windowReader.findCompactWindowStart.bind(windowReader);
let located;
windowReader.findCompactWindowStart = async (...scanArgs) => {
  phase = "scan";
  try {
    located = await realScan(...scanArgs);
    return located;
  } finally {
    phase = "window";
  }
};
// The same real boundary finder over decompressed bytes held in memory.
let memory = Buffer.alloc(0);
const memoryReader = new CodexRolloutWindowReader(
  async (_path, start, length) => memory.subarray(start, start + length),
);

function lineAt(buffer, start) {
  const end = buffer.indexOf(0x0a, start);
  return buffer.toString("utf8", start, end < 0 ? buffer.length : end);
}
async function firstLineAt(filePath, start) {
  const handle = await open(filePath, "r");
  try {
    const chunks = [];
    for (let at = start; ; ) {
      const buffer = Buffer.alloc(1024 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, at);
      const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
      chunks.push(buffer.subarray(0, newline < 0 ? bytesRead : newline));
      if (newline >= 0 || bytesRead === 0) break;
      at += bytesRead;
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await handle.close();
  }
}

const hint = (id) => ({
  id,
  projectId: "census",
  provider: "codex",
  updatedAt: new Date(0).toISOString(),
});
/** Real getSession with a valid hint; null when the id resolves elsewhere. */
async function openThroughReader(file, compactions) {
  const id = file.meta?.payload.id;
  // A fresh reader per file: no warm cache, no dataDir, no watcher.
  const reader = new CodexSessionReader({ sessionsDir });
  try {
    if (!id || (await reader.getSessionFilePath(id)) !== file.path) return null;
    return await reader.getSession(id, "census", undefined, {
      tailCompactions: compactions,
      summaryHint: hint(id),
    });
  } finally {
    await reader.close();
  }
}

/** One rollout, one requested boundary count, in getSession's order. */
async function classify(file, compactions) {
  const { path, size, meta, lineage } = file;
  // getSession throws: an open that fails, not a complete read.
  if (!meta || lineage === "error")
    return { outcome: O.fails, complete: 0, scan: 0, checked: false };
  if (meta.payload.history_base) {
    // getSession decides this before the window reader; ask it directly.
    const loaded = await openThroughReader(file, compactions);
    if (loaded) assert(!loaded.readWindow, `fork took a window: ${path}`);
    return {
      outcome: O.fork,
      complete: (file.decompressed ?? size) + lineage.ancestorBytes,
      scan: 0,
      checked: Boolean(loaded),
    };
  }
  read.scan = read.window = 0;
  located = undefined;
  const verdict = await windowReader.readCompactTailSnapshot(
    path,
    file.stats,
    compactions,
  );
  const scan = read.scan;
  let outcome;
  if (files.isCompressedCodexRolloutPath(path)) outcome = O.compressed;
  else if (size <= ESTIMATE_BYTES_PER_BOUNDARY * compactions) outcome = O.small;
  else if (located === null) {
    outcome = O.fewer;
    assert.equal(scan, size, "a missing boundary must scan to byte 0");
  } else if (located === 0) outcome = O.byteZero;
  else {
    const first = parseCodexSessionEntry(await firstLineAt(path, located));
    outcome = first?.type === "compacted" ? O.bounded : O.notCompacted;
  }
  if (outcome === O.compressed || outcome === O.small)
    assert(located === undefined && scan === 0, `${outcome} must not scan`);
  // The label must agree with the real reader's taken/not-taken verdict.
  assert.equal(outcome === O.bounded, verdict !== null, `${outcome}: ${path}`);
  if (verdict) {
    assert.equal(verdict.startByte, located);
    return {
      outcome,
      bounded: size - located,
      complete: 0,
      scan,
      checked: true,
      catchUp: await catchUp(file, compactions, verdict),
    };
  }
  return {
    outcome,
    complete: outcome === O.compressed ? file.decompressed : size,
    // A rejected located range was parsed before the reader gave up.
    scan: scan + read.window,
    checked: true,
  };
}

/** Incremental catch-up with the newest cursor, through the real validator. */
async function catchUp(file, compactions, window) {
  const summary = hint(file.meta.payload.id);
  const messages = normalizeSession({
    summary,
    transcriptSnapshotUpdatedAt: window.transcriptSnapshotUpdatedAt,
    data: { provider: "codex", session: { entries: window.entries } },
  }).messages;
  const last = messages.at(-1);
  const cursor = last && (last.uuid ?? last.id);
  if (!cursor) return "no cursor in window";
  const snapshot = await readCodexIncrementalSnapshot(
    {
      readEntries: async (_id, path, { startByte }) => ({
        ...(await windowReader.readEntryRange(
          path,
          startByte,
          file.size - startByte,
        )),
        transcriptSnapshotUpdatedAt: window.transcriptSnapshotUpdatedAt,
      }),
      windowReader,
    },
    file.meta.payload.id,
    file.path,
    file.stats,
    compactions,
    cursor,
    summary,
  );
  return snapshot ? "bounded" : "complete: result needs omitted tool context";
}

/** What-if: would the compact-tail finder bound this rollout uncompressed? */
async function compressedWhatIf(file, compactions) {
  const start = await memoryReader.findCompactTailStart(
    files.plainCodexRolloutPath(file.path),
    { size: memory.length, mtimeMs: 0, ctimeMs: 0 },
    compactions,
  );
  return start !== null &&
    parseCodexSessionEntry(lineAt(memory, start))?.type === "compacted"
    ? memory.length - start
    : null;
}

function emptyRow() {
  return {
    files: 0,
    fileBytes: 0,
    completeBytes: 0,
    boundedBytes: 0,
    scanBytes: 0,
  };
}
function add(row, file, result) {
  row.files += 1;
  row.fileBytes += file.size;
  row.completeBytes += result.complete;
  row.boundedBytes += result.bounded ?? 0;
  row.scanBytes += result.scan;
}

const started = performance.now();
const all = files.preferPlainCodexRollouts(rootFiles);
const counts = [...new Set(PATHS.map((p) => p.compactions))];
const BANDS = [
  ["all", -1],
  [">10 MB", 10 * MB],
  [">50 MB", 50 * MB],
];
const tables = Object.fromEntries(
  counts.map((n) => [
    n,
    Object.fromEntries(
      BANDS.map(([band]) => [
        band,
        Object.fromEntries(OUTCOMES.map((o) => [o, emptyRow()])),
      ]),
    ),
  ]),
);
const catchUps = Object.fromEntries(counts.map((n) => [n, {}]));
const whatIf = Object.fromEntries(
  counts.map((n) => [
    n,
    {
      compressed: { files: 0, decompressedBytes: 0 },
      wouldBound: { files: 0, decompressedBytes: 0, windowBytes: 0 },
    },
  ]),
);
const subagent = emptyRow();
const largest = Object.fromEntries(counts.map((n) => [n, []]));
let checked = 0;
let unchecked = 0;
let totalBytes = 0;

for (const path of all) {
  const stats = await stat(path);
  const file = { path, stats, size: stats.size };
  totalBytes += file.size;
  file.meta = await readCodexSessionMeta(path).catch(() => null);
  if (file.meta?.payload.history_base) {
    file.lineage = await resolveCodexRolloutLineage({
      requestedSessionId: file.meta.payload.id,
      leafFilePath: path,
      resolveRolloutPath,
    })
      .then((lineage) => ({
        ancestorBytes: lineage.segments
          .slice(0, -1)
          .reduce((sum, s) => sum + s.end.end_byte_offset, 0),
      }))
      .catch(() => "error");
  }
  // One decompressed rollout at a time; released before the next file.
  memory = files.isCompressedCodexRolloutPath(path)
    ? await promisify(zstdDecompress)(await readFile(path))
    : Buffer.alloc(0);
  if (memory.length) file.decompressed = memory.length;
  if (file.meta && isSubagentSessionMeta(file.meta.payload))
    add(subagent, file, { complete: file.decompressed ?? file.size, scan: 0 });
  for (const n of counts) {
    const result = await classify(file, n);
    if (result.checked) checked += 1;
    else unchecked += 1;
    for (const [band, min] of BANDS)
      if (file.size > min) add(tables[n][band][result.outcome], file, result);
    if (result.catchUp)
      catchUps[n][result.catchUp] = (catchUps[n][result.catchUp] ?? 0) + 1;
    if (result.outcome === O.compressed) {
      const w = whatIf[n];
      w.compressed.files += 1;
      w.compressed.decompressedBytes += memory.length;
      const window = await compressedWhatIf(file, n);
      if (window !== null) {
        w.wouldBound.files += 1;
        w.wouldBound.decompressedBytes += memory.length;
        w.wouldBound.windowBytes += window;
      }
    }
    largest[n].push({ path, size: file.size, outcome: result.outcome, file });
  }
  memory = Buffer.alloc(0);
}
const wallSeconds = (performance.now() - started) / 1000;
if (traversalErrors.length) process.exitCode = 1;

const fmt = (bytes) => (bytes / MB).toFixed(0).padStart(8);
const pct = (part, whole) =>
  `${whole ? ((100 * part) / whole).toFixed(1) : "0.0"}%`.padStart(7);
function printTable(rows) {
  const total = Object.values(rows).reduce((t, r) => {
    for (const k of Object.keys(t)) t[k] += r[k];
    return t;
  }, emptyRow());
  console.log(
    `  ${"outcome".padEnd(40)} files   file MB  share  complete MB bounded MB  boundary scan MB`,
  );
  for (const [outcome, r] of [...Object.entries(rows), ["total", total]]) {
    if (!r.files) continue;
    console.log(
      `  ${outcome.padEnd(40)}${String(r.files).padStart(6)}${fmt(r.fileBytes)}  ${pct(r.fileBytes, total.fileBytes)}${fmt(r.completeBytes)}   ${fmt(r.boundedBytes)}  ${fmt(r.scanBytes)}`,
    );
  }
}

if (args.json) {
  console.log(
    JSON.stringify(
      {
        rollouts: all.length,
        bytesOnDisk: totalBytes,
        wallSeconds,
        checked,
        unchecked,
        traversalErrors,
        paths: PATHS,
        tables,
        catchUps,
        whatIf,
        subagent,
      },
      null,
      2,
    ),
  );
} else {
  console.log(
    `Codex complete-reader fallbacks: ${all.length} rollouts (plain preferred over zstd), ${fmt(totalBytes).trim()} MB on disk; ${wallSeconds.toFixed(1)} s.`,
  );
  console.log(
    `Verdict checks: ${checked} rollouts checked against the real reader, ${unchecked} classified without a verdict check.`,
  );
  if (traversalErrors.length)
    console.log(
      `Traversal errors below the root: ${traversalErrors.length} (${[...new Set(traversalErrors)].join(", ")}).`,
    );
  console.log(
    "Assumes a valid summary hint (present and not newer than the file).",
  );
  console.log(
    "complete MB = bytes the complete reader parses (decompressed for zstd, plus ancestor prefixes for forks);",
  );
  console.log(
    "bounded MB = file size minus the compact-tail start; boundary scan MB = bytes the backward compact-boundary scan reads (excludes session_meta and lineage reads).",
  );
  for (const n of counts) {
    const names = PATHS.filter((p) => p.compactions === n).map((p) => p.name);
    for (const [band, rows] of Object.entries(tables[n])) {
      console.log(
        `\n${names.join(" and ")} (tailCompactions=${n}), files ${band}:`,
      );
      printTable(rows);
    }
    console.log(
      `\nIncremental catch-up with the newest cursor (bounded opens only, N=${n}):`,
    );
    for (const [k, v] of Object.entries(catchUps[n]))
      console.log(`  ${k}: ${v}`);
    const w = whatIf[n];
    console.log(
      `\nWhat-if, not a reader outcome: compressed non-fork rollouts through the real boundary finder after decompression (N=${n}):`,
    );
    console.log(
      `  all compressed:   ${String(w.compressed.files).padStart(6)} files ${fmt(w.compressed.decompressedBytes)} MB decompressed`,
    );
    console.log(
      `  would be bounded: ${String(w.wouldBound.files).padStart(6)} files ${fmt(w.wouldBound.decompressedBytes)} MB decompressed, ${fmt(w.wouldBound.windowBytes).trim()} MB window`,
    );
  }
  console.log(
    `\nSubagent rollouts (getAgentSession takes a complete read): ${subagent.files} files, ${fmt(subagent.completeBytes).trim()} MB parsed.`,
  );
}

if (args["list-largest"]) {
  console.log(`\nLargest per outcome (local paths, do not commit):`);
  for (const outcome of OUTCOMES)
    for (const l of largest[counts[0]]
      .filter((x) => x.outcome === outcome)
      .sort((a, b) => b.size - a.size)
      .slice(0, args["list-largest"]))
      console.log(`  ${outcome}: ${fmt(l.size).trim()} MB ${l.path}`);
}
if (args["getsession-check"]) {
  const n = counts[0];
  for (const outcome of OUTCOMES) {
    for (const l of largest[n]
      .filter((x) => x.outcome === outcome)
      .sort((a, b) => b.size - a.size)
      .slice(0, args["getsession-check"])) {
      const loaded = await openThroughReader(l.file, n);
      if (!loaded) continue;
      assert.equal(Boolean(loaded.readWindow), outcome === O.bounded, outcome);
      console.log(
        `getSession check: ${outcome}, ${fmt(l.size).trim()} MB, readWindow ${loaded.readWindow ? `from byte ${loaded.readWindow.startByte}` : "absent"}, ${loaded.data.session.entries.length} entries`,
      );
    }
  }
}
