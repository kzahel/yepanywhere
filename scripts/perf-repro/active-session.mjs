#!/usr/bin/env node
// Cost of a browser tab open on a long, active session (plan 190's scenario).
//
// Builds an isolated world, starts one passive production server on it with
// the inspector, opens headless Chromium on the session, and runs phases:
//
//   idle     nothing written; what a quiet host costs
//   active   one write a second to the long session, crossing a compaction
//            (due every --compact-every writes, the first half way, taken
//            between turns), after --warmup seconds of writes
//   lists    each list route the tab used, fetched directly, timed
//   restart  tabs closed, the server restarts with nothing changed: time to
//            usable lists and the CPU spent through 30 s after
//   open     a fresh tab opens the long session (cold, after a restart):
//            time until a write from the last two turns is shown
//
// Phases run in that order; the server must settle (under 10% of a core
// for 10 s) between them. Per-write figures are lower bounds when the server
// is saturated: work queues behind earlier writes, and the server log's
// SESSION_DETAIL timings give each request's own cost.
//
// For each phase it records process and main-thread CPU, event-loop delay
// (p50/p99/max), the tab's requests and bytes, WebSocket frames, the tab's
// task time and memory, all also divided per write. In the active phase each
// visible write carries a marker, and the tab reports when it appeared, which
// gives write-to-visible latency.
//
// Worlds:
//
//   synthetic (default)  --sessions idle sessions, --codex-share of them Codex
//                        rollouts in date directories and the rest Claude
//                        transcripts, over --projects projects; plus one long
//                        session (--long-provider claude|codex) of
//                        --compactions compactions of --compaction-turns turns.
//                        The idle sessions are generated once into
//                        <work>/seed/<key> and cloned (copy-on-write) per run.
//   clone                copy-on-write clones of real provider stores and a
//                        profile (--profile, --claude, --codex, --long <id>,
//                        --keep); the held-back tail of --long is replayed at
//                        its recorded pace (gaps capped at --cap seconds).
//
// By default it is a diagnostic. --check-targets guards the numeric subset,
// never full plan acceptance. Timings depend on the host, so compare
// builds on the same host, interleaved, on fresh worlds. The inspector stays
// attached for CPU and event-loop probes; the 1 ms CPU profiler is opt-in
// (--cpu-profile) because it adds to every figure. Runs on macOS and Linux
// (per-thread CPU from `ps -M` or /proc), not Windows.
//
//   node scripts/perf-repro/active-session.mjs --label base \
//     [--server-dist packages/server/dist] [--client-dist packages/client/dist] \
//     [--phases idle,active,lists,restart,open] [--idle-seconds 180] \
//     [--seconds 180] [--warmup 20] [--interval 1] [--compact-every 300] \
//     [--visible-wait 120] [--typing --typing-seconds 60] [--additional-tab]
//     [--check-targets] \
//     [--pages session] [--cpu-profile] [--browser-profile] \
//     [--env KEY=VALUE,...] [--codex-index false] \
//     [--projects 200 --sessions 50000 --codex-share 0.5 \
//      --long-provider claude --compactions 200 \
//      --compaction-turns 55 (claude) or 42 (codex)] \
//     [--world clone --profile ~/.yep-anywhere --claude ~/.claude/projects \
//        --codex ~/.codex/sessions --long <session id> --keep 0.85]
//
// The clone world reads the live profile only: each SQLite file is copied with
// `sqlite3 -readonly … VACUUM INTO`, and the rest is cloned. In the copy,
// stored native identities move to the cloned store paths, the catalog is
// emptied to be rebuilt from the clones, and the profile is made passive (no
// updates, host-awake, relay, project queue or push). Results go to
// <work>/results/<label>/ (summary.json records the arguments and the repo
// HEAD). The clone world has no Codex thread index (the real one names the
// real rollout paths), so its Codex tree is rescanned periodically. Never
// point --work at a live profile.
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  encodeProjectPath,
  percentile,
  transcriptRows,
} from "../perf-suite/core.mjs";
import {
  claudeSession,
  codexRollout,
  codexSession,
  GENERATOR_VERSION,
} from "./scenario-transcripts.mjs";

import {
  startHostEvidence,
  measuredHostSample,
  hostWindow,
  observePageNetwork,
  typeDuringWrites,
  targetChecks,
} from "./active-session-metrics.mjs";
import { createHash } from "node:crypto";
import { runtimeIdentity } from "./active-session-build.mjs";

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const args = parseArgs(process.argv.slice(2));
const work = path.resolve(args.work ?? "/tmp/ya-active-session-repro");
const label = args.label ?? "run";
const port = Number(args.port ?? 3420);
const inspectPort = port + 1000;
const world = path.join(work, "world");
const out = path.join(work, "results", label);
const phases = new Set(
  String(args.phases ?? "idle,active,lists,restart,open").split(","),
);

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) parsed[key] = true;
    else parsed[key] = argv[++i];
  }
  return parsed;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const expand = (p) => path.resolve(p.replace(/^~(?=$|\/)/, homedir()));
const log = (...parts) =>
  console.error(`[${new Date().toISOString().slice(11, 19)}]`, ...parts);
const round = (value, digits = 1) =>
  value === undefined || Number.isNaN(value)
    ? undefined
    : +value.toFixed(digits);

/** Copy-on-write where the filesystem allows (APFS, Btrfs, XFS), else a copy. */
function cloneTree(from, to) {
  try {
    execFileSync(
      "cp",
      process.platform === "darwin"
        ? ["-cR", from, to]
        : ["-R", "--reflink=auto", from, to],
    );
  } catch {
    cpSync(from, to, { recursive: true });
  }
}

const sqlText = (value) => `'${String(value).replaceAll("'", "''")}'`;

// --- worlds ---------------------------------------------------------------

const scenario = {
  projects: Number(args.projects ?? 200),
  sessions: Number(args.sessions ?? 50000),
  codexShare: Number(args["codex-share"] ?? 0.5),
  longProvider: String(args["long-provider"] ?? "claude"),
  compactions: Number(args.compactions ?? 200),
};
// About 2.3 MB and 750-900 rows per compaction for either provider (about
// 460 MB and 150,000-180,000 rows over 200), as agent turns with sizeable
// tool output; Codex rows are larger, so fewer turns per compaction.
scenario.compactionTurns = Number(
  args["compaction-turns"] ?? (scenario.longProvider === "codex" ? 42 : 55),
);

/**
 * The idle sessions, generated once per (projects, sessions, share) into a
 * seed directory that runs clone. Claude transcripts sit in per-project
 * directories; Codex rollouts in date directories, mapped to projects by cwd.
 */
function idleSeed() {
  const key = `g${GENERATOR_VERSION}-p${scenario.projects}-s${scenario.sessions}-c${scenario.codexShare}`;
  const seed = path.join(work, "seed", key);
  if (existsSync(path.join(seed, "done")))
    return {
      seed,
      ...JSON.parse(readFileSync(path.join(seed, "done"), "utf8")),
    };
  rmSync(seed, { recursive: true, force: true });
  log(`generating ${scenario.sessions} idle sessions into ${seed}`);
  const claudeStore = path.join(seed, "claude-projects");
  const codexStore = path.join(seed, "codex-sessions");
  const codexCount = Math.round(scenario.sessions * scenario.codexShare);
  const claudeCount = scenario.sessions - codexCount;
  const projectPath = (p) => path.join(world, "projects", `project-${p}`);
  for (let p = 0; p < scenario.projects; p++)
    mkdirSync(path.join(claudeStore, encodeProjectPath(projectPath(p))), {
      recursive: true,
    });
  const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  // Spread over the past year, oldest first, so the long session is newest.
  const start = Date.now() - 400 * 86_400_000;
  const span = 365 * 86_400_000;
  for (let s = 0; s < claudeCount; s++) {
    const file = path.join(
      claudeStore,
      encodeProjectPath(projectPath(s % scenario.projects)),
      `${uuid(s + 1)}.jsonl`,
    );
    writeFileSync(
      file,
      transcriptRows({
        projectPath: projectPath(s % scenario.projects),
        sessionId: uuid(s + 1),
        startTurn: 0,
        turns: 2 + (s % 5),
        payloadBytes: 400,
      }),
    );
    const at = new Date(start + (span * s) / claudeCount);
    utimesSync(file, at, at);
  }
  const dirs = new Set();
  for (let s = 0; s < codexCount; s++) {
    const startedAt = start + (span * s) / codexCount;
    const { id, relativePath } = codexRollout(s + 1, startedAt);
    const file = path.join(codexStore, relativePath);
    const dir = path.dirname(file);
    if (!dirs.has(dir)) {
      mkdirSync(dir, { recursive: true });
      dirs.add(dir);
    }
    const session = codexSession({
      sessionId: id,
      projectPath: projectPath(s % scenario.projects),
      resultLines: 4,
      answerBytes: 200,
    });
    const rows = [session.head(startedAt)];
    for (let w = 0; w < 4 * (2 + (s % 5)); w++)
      rows.push(...session.next(startedAt + w * 1000).rows);
    writeFileSync(file, `${rows.join("\n")}\n`);
    const at = new Date(startedAt + 60_000);
    utimesSync(file, at, at);
  }
  writeFileSync(path.join(seed, "done"), JSON.stringify({ start, span }));
  return { seed, start, span };
}

// Codex's sessions root and its thread index sit in a `codex` home, as in
// ~/.codex, so the server finds the index beside `sessions/`.
const codexHome = path.join(world, "codex");
const codexStore = path.join(codexHome, "sessions");

function syntheticWorld() {
  const { seed, start, span } = idleSeed();
  cloneTree(
    path.join(seed, "claude-projects"),
    path.join(world, "claude-projects"),
  );
  mkdirSync(codexHome, { recursive: true });
  cloneTree(path.join(seed, "codex-sessions"), codexStore);
  for (let p = 0; p < scenario.projects; p++)
    mkdirSync(path.join(world, "projects", `project-${p}`), {
      recursive: true,
    });
  const projectPath = path.join(world, "projects", "project-0");
  // Full segments each closed by a compaction, then half a segment: a live
  // session is usually part way between compactions.
  const tailTurns = Math.floor(scenario.compactionTurns / 2);
  const writes =
    (scenario.compactions * scenario.compactionTurns + tailTurns) * 4 +
    scenario.compactions;
  // History ends an hour ago at one write a second.
  let at = Date.now() - 3_600_000 - writes * 1000;
  let session;
  let file;
  if (scenario.longProvider === "codex") {
    const rollout = codexRollout(9_000_001, at);
    session = codexSession({ sessionId: rollout.id, projectPath });
    file = path.join(codexStore, rollout.relativePath);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${session.head(at)}\n`);
    session.sessionId = rollout.id;
  } else {
    const sessionId = "00000000-0000-4000-8000-900000000001";
    session = claudeSession({ sessionId, projectPath });
    file = path.join(
      world,
      "claude-projects",
      encodeProjectPath(projectPath),
      `${sessionId}.jsonl`,
    );
    writeFileSync(file, "");
    session.sessionId = sessionId;
  }
  log(
    `generating the long ${scenario.longProvider} session: ${scenario.compactions} compactions of ${scenario.compactionTurns} turns`,
  );
  for (let c = 0; c <= scenario.compactions; c++) {
    const chunk = [];
    const turns =
      c < scenario.compactions ? scenario.compactionTurns : tailTurns;
    for (let t = 0; t < turns * 4; t++) {
      chunk.push(...session.next(at).rows);
      at += 1000;
    }
    if (c < scenario.compactions) {
      chunk.push(...session.compact(at));
      at += 1000;
    }
    appendFileSync(file, `${chunk.join("\n")}\n`);
  }
  if (args["codex-index"] !== "false")
    codexThreadIndex(session, file, start, span);
  const bytes = Number(execFileSync("stat", statArgs(file)).toString().trim());
  const lines = Number(
    execFileSync("wc", ["-l", file]).toString().trim().split(/\s+/)[0],
  );
  return {
    store: path.join(world, "claude-projects"),
    projectPath,
    sessionId: session.sessionId,
    file,
    session,
    longBytes: bytes,
    longLines: lines,
  };
}

/**
 * Codex's thread index (`state_5.sqlite`), reduced to the columns and indexes
 * YA reads: a row per rollout whose `updated_at` Codex bumps as it persists.
 * Without it the server falls back to periodic full rescans of the tree
 * (`--codex-index false` models a host whose index is unreadable).
 */
function codexThreadIndex(session, longFile, start, span) {
  const codexCount = Math.round(scenario.sessions * scenario.codexShare);
  const root = realpathSync(codexStore);
  const rows = [];
  for (let s = 0; s < codexCount; s++) {
    const startedAt = start + (span * s) / codexCount;
    const { id, relativePath } = codexRollout(s + 1, startedAt);
    rows.push([id, path.join(root, relativePath), startedAt + 60_000]);
  }
  if (scenario.longProvider === "codex")
    rows.push([
      session.sessionId,
      path.join(root, path.relative(codexStore, longFile)),
      Date.now() - 3_600_000,
    ]);
  const sql = [
    "PRAGMA journal_mode = WAL;",
    "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_at_ms INTEGER, source TEXT NOT NULL, model_provider TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL);",
    "CREATE INDEX idx_threads_updated_at ON threads(updated_at DESC, id DESC);",
    "CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL);",
    "CREATE INDEX idx_thread_spawn_edges_parent_status ON thread_spawn_edges(parent_thread_id, status);",
    "BEGIN;",
    ...rows.map(
      ([id, rollout, ms]) =>
        `INSERT INTO threads VALUES (${sqlText(id)}, ${sqlText(rollout)}, ${Math.floor(ms / 1000)}, ${Math.floor(ms / 1000)}, ${Math.floor(ms)}, 'cli', 'openai', '', '');`,
    ),
    "COMMIT;",
  ].join("\n");
  const sqlFile = path.join(work, "run", "codex-index.sql");
  mkdirSync(path.dirname(sqlFile), { recursive: true });
  writeFileSync(sqlFile, sql);
  execFileSync("sqlite3", [
    path.join(codexHome, "state_5.sqlite"),
    `.read ${sqlFile}`,
  ]);
}

/** As Codex does: bump the thread's index row at most every five seconds. */
function touchCodexThread(w) {
  if (
    scenario.longProvider !== "codex" ||
    args["codex-index"] === "false" ||
    Date.now() - (w.indexTouchedAt ?? 0) < 5000
  )
    return;
  w.indexTouchedAt = Date.now();
  execFileSync("sqlite3", [
    path.join(codexHome, "state_5.sqlite"),
    `UPDATE threads SET updated_at = ${Math.floor(Date.now() / 1000)}, updated_at_ms = ${Date.now()} WHERE id = ${sqlText(w.sessionId)};`,
  ]);
}

const statArgs = (file) =>
  process.platform === "darwin" ? ["-f", "%z", file] : ["-c", "%s", file];

function cloneWorld() {
  const profile = expand(args.profile ?? "~/.yep-anywhere");
  const claude = expand(args.claude ?? "~/.claude/projects");
  const codex = args.codex ? expand(args.codex) : undefined;
  const longId = args.long;
  if (!longId) throw new Error("--world clone needs --long <session id>");
  const store = path.join(world, "claude-projects");
  cloneTree(claude, store);
  if (codex) cloneTree(codex, path.join(world, "codex-sessions"));
  const dataDir = path.join(world, "profile");
  mkdirSync(dataDir, { recursive: true });
  for (const name of readdirSync(profile)) {
    if (
      /^(logs|session-catalog|push-subscriptions\.json)$|\.sqlite(-|$)/.test(
        name,
      )
    )
      continue;
    cloneTree(path.join(profile, name), path.join(dataDir, name));
  }
  // A consistent copy of each live database, opened read-only.
  for (const name of readdirSync(profile).filter((n) => n.endsWith(".sqlite")))
    execFileSync("sqlite3", [
      "-readonly",
      path.join(profile, name),
      `VACUUM INTO ${sqlText(path.join(dataDir, name))}`,
    ]);
  // In the copy only: identities follow the cloned stores, and the catalog is
  // emptied so the first scan rebuilds it from the clones rather than serving
  // rows that point at the real stores.
  const real = (p) => realpathSync(p);
  const moves = [
    ["claude", claude, store],
    ...(codex ? [["codex", codex, path.join(world, "codex-sessions")]] : []),
  ];
  const sql = [
    ...moves.map(
      ([family, from, to]) =>
        `UPDATE session_identities SET native_scope = ${sqlText(real(to))} || substr(native_scope, length(${sqlText(real(from))}) + 1) WHERE native_family = ${sqlText(family)} AND substr(native_scope, 1, length(${sqlText(real(from))})) = ${sqlText(real(from))};`,
    ),
    "DELETE FROM session_catalog_text; DELETE FROM session_catalog; DELETE FROM catalog_sources; DELETE FROM catalog_state;",
  ].join("\n");
  execFileSync("sqlite3", [path.join(dataDir, "discovery.sqlite"), sql]);
  passiveProfile(dataDir);
  const file = readdirSync(store)
    .map((dir) => path.join(store, dir, `${longId}.jsonl`))
    .find((candidate) => existsSync(candidate));
  if (!file) throw new Error(`no transcript for ${longId}`);
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const keep = Math.floor(lines.length * Number(args.keep ?? 0.85));
  writeFileSync(file, `${lines.slice(0, keep).join("\n")}\n`);
  writeFileSync(
    path.join(world, "replay.jsonl"),
    `${lines.slice(keep).join("\n")}\n`,
  );
  const projectPath = JSON.parse(
    lines.find((l) => l.includes('"cwd"')) ?? "{}",
  ).cwd;
  return { store, projectPath, sessionId: longId, file, dataDir };
}

function passiveProfile(dataDir) {
  const edit = (name, change) => {
    const file = path.join(dataDir, name);
    if (!existsSync(file)) return;
    const value = JSON.parse(readFileSync(file, "utf8"));
    change(value);
    writeFileSync(file, JSON.stringify(value));
  };
  edit("server-settings.json", (s) => {
    s.settings ??= {};
    const settings = s.settings;
    Object.assign(settings, {
      codexUpdatePolicy: "off",
      hostAwakeMode: "off",
      gatewayServiceExportEnabled: false,
    });
  });
  edit("remote-access.json", (r) => {
    delete r.relay;
    r.enabled = false;
  });
  edit("project-queues.json", (q) => {
    q.items = [];
  });
}

// --- server ---------------------------------------------------------------

function serverEnv(w) {
  const logs = path.join(work, "run", "logs");
  const empty = path.join(work, "run", "empty");
  mkdirSync(logs, { recursive: true });
  mkdirSync(empty, { recursive: true });
  const home = path.join(work, "run", "home");
  mkdirSync(home, { recursive: true });
  const env = {
    HOME: home,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    USER: process.env.USER ?? "",
    PATH: process.env.PATH ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: "en_US.UTF-8",
    NODE_ENV: "production",
    YEP_DATA_DIR: w.dataDir ?? path.join(world, "profile"),
    LOG_TO_FILE: "true",
    LOG_DIR: logs,
    LOG_FILE_LEVEL: "debug",
    PORT: String(port),
    HOST: "127.0.0.1",
    CLI_HOST_OVERRIDE: "true",
    YEP_PROVIDER_HOST_ENABLED: "false",
    YEP_PEER_API_ENABLED: "false",
    MAINTENANCE_PORT: "0",
    AUTH_DISABLED: "true",
    PI_CODING_AGENT_DIR: path.join(work, "run", "pi"),
    CLAUDE_SESSIONS_DIR: w.store,
    CODEX_SESSIONS_DIR:
      [codexStore, path.join(world, "codex-sessions")].find((dir) =>
        existsSync(dir),
      ) ?? empty,
    GEMINI_SESSIONS_DIR: empty,
    GROK_SESSIONS_DIR: empty,
    PI_SESSIONS_DIR: empty,
    CLIENT_DIST_PATH: path.resolve(
      args["client-dist"] ?? path.join(repo, "packages/client/dist"),
    ),
  };
  // --env KEY=VALUE[,KEY=VALUE]: extra server settings for one run.
  for (const pair of String(args.env ?? "")
    .split(",")
    .filter(Boolean)) {
    const at = pair.indexOf("=");
    if (at < 1) throw new Error(`--env expects KEY=VALUE, got ${pair}`);
    env[pair.slice(0, at)] = pair.slice(at + 1);
  }
  mkdirSync(env.YEP_DATA_DIR, { recursive: true });
  // A fresh profile discovers only the provider families its install has
  // started.
  if (!existsSync(path.join(env.YEP_DATA_DIR, "install.json")))
    writeFileSync(
      path.join(env.YEP_DATA_DIR, "install.json"),
      JSON.stringify({
        version: 2,
        installId: "00000000-0000-4000-8000-000000000001",
        createdAt: "2026-01-01T00:00:00.000Z",
        catalogFamilies: ["claude", "codex"],
        catalogMetadataMigrationComplete: true,
      }),
    );
  return env;
}

/** Starts the server and waits until the retained list reports complete. */
async function startServer(w) {
  const dist = path.resolve(
    args["server-dist"] ?? path.join(repo, "packages/server/dist"),
  );
  const startedAt = Date.now();
  const child = spawn(
    process.execPath,
    [`--inspect=127.0.0.1:${inspectPort}`, path.join(dist, "index.js")],
    {
      env: serverEnv(w),
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    },
  );
  // Known to the exit handlers from the moment it exists.
  current = child;
  const base = `http://127.0.0.1:${port}`;
  let listening;
  for (let i = 0; i < 12000; i++) {
    await sleep(100);
    if (child.exitCode !== null)
      throw new Error("server exited during startup");
    try {
      const body = await (
        await fetch(`${base}/api/sessions?summaryMode=retained&limit=1`, {
          headers: { "X-Yep-Anywhere": "true" },
        })
      ).text();
      listening ??= Date.now();
      if (body.includes('"complete":true'))
        return {
          child,
          base,
          listeningMs: listening - startedAt,
          completeMs: Date.now() - startedAt,
        };
    } catch {}
  }
  throw new Error("catalog never completed");
}

async function stopAndWait(child) {
  try {
    process.kill(-child.pid, "SIGINT");
  } catch {}
  for (let i = 0; i < 300 && child.exitCode === null; i++) await sleep(100);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
    await sleep(500);
  }
}

async function inspector() {
  const [target] = await (
    await fetch(`http://127.0.0.1:${inspectPort}/json/list`)
  ).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    if (exceptionDetails)
      throw new Error(
        `server evaluate failed: ${JSON.stringify(exceptionDetails)}`,
      );
    return result.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

/**
 * Per-thread user+system seconds, main thread first: `ps -M` on macOS (its
 * first row, which also names the command, is the main thread), the task
 * stats on Linux; empty elsewhere. Threads are matched by position, so one
 * that exits mid-run shifts the attribution of later ones.
 */
function threadTimes(pid) {
  if (process.platform === "linux") {
    try {
      const tasks = readdirSync(`/proc/${pid}/task`).sort((a, b) =>
        a === String(pid) ? -1 : b === String(pid) ? 1 : Number(a) - Number(b),
      );
      return tasks.map((task) => {
        const stat = readFileSync(`/proc/${pid}/task/${task}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        return (Number(fields[11]) + Number(fields[12])) / 100;
      });
    } catch {
      return [];
    }
  }
  if (process.platform !== "darwin") return [];
  try {
    return execFileSync("ps", ["-M", "-p", String(pid)])
      .toString()
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => {
        // STIME and UTIME; the main thread's row also carries the command.
        const [system = "0:0", user = "0:0"] =
          line.match(/\b\d+:\d+\.\d+\b/g) ?? [];
        const t = (value) =>
          value.split(":").reduce((sum, part) => sum * 60 + Number(part), 0);
        return t(system) + t(user);
      });
  } catch {
    return [];
  }
}

/** Process CPU seconds and RSS from `ps`, which works before the inspector. */
function psProcess(pid) {
  try {
    const [time, rss] = execFileSync("ps", [
      "-o",
      "time=,rss=",
      "-p",
      String(pid),
    ])
      .toString()
      .trim()
      .split(/\s+/);
    const seconds = time
      .split(/[:-]/)
      .reduce((sum, part) => sum * 60 + Number(part), 0);
    return { cpuS: seconds, rssMB: Math.round(Number(rss) / 1024) };
  } catch {
    return { cpuS: undefined, rssMB: undefined };
  }
}

// --- writes ---------------------------------------------------------------

/** Writes the clone world's held-back tail at its recorded pace. */
async function replay(w, until, onWrite) {
  const lines = readFileSync(path.join(world, "replay.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean);
  const at = (line) => Date.parse(JSON.parse(line).timestamp ?? "") || null;
  const cap = Number(args.cap ?? 8) * 1000;
  let previous = null;
  for (let i = w.replayed ?? 0; i < lines.length && Date.now() < until; ) {
    const batch = [lines[i]];
    const t0 = at(lines[i]) ?? previous;
    while (i + batch.length < lines.length) {
      const t = at(lines[i + batch.length]);
      if (t !== null && t0 !== null && t - t0 > 50) break;
      batch.push(lines[i + batch.length]);
    }
    if (previous !== null && t0 !== null)
      await sleep(Math.min(Math.max(t0 - previous, 0), cap));
    appendFileSync(w.file, `${batch.join("\n")}\n`);
    onWrite(null);
    previous = t0 ?? previous;
    i += batch.length;
    w.replayed = i;
  }
}

/**
 * One write every --interval seconds to the long session; a compaction is
 * due every --compact-every writes, the first half way (so a three-minute
 * active phase after warm-up crosses one), and is taken at the next turn
 * boundary, as a provider compacts between turns. Each visible write's
 * marker is reported.
 */
async function writeLong(w, until, onWrite) {
  if (args.world === "clone") return replay(w, until, onWrite);
  const interval = Number(args.interval ?? 1) * 1000;
  const compactEvery = Number(args["compact-every"] ?? 300);
  w.nextCompactionAt ??= Math.floor(compactEvery / 2);
  let next = Date.now();
  while (Date.now() < until) {
    w.liveWrites = (w.liveWrites ?? 0) + 1;
    if (w.liveWrites >= w.nextCompactionAt && w.session.atTurnStart) {
      appendFileSync(w.file, `${w.session.compact(Date.now()).join("\n")}\n`);
      w.nextCompactionAt += compactEvery;
      w.liveCompactions = (w.liveCompactions ?? 0) + 1;
      onWrite(null);
    } else {
      const { rows, marker } = w.session.next(Date.now());
      appendFileSync(w.file, `${rows.join("\n")}\n`);
      onWrite(marker);
    }
    touchCodexThread(w);
    next += interval;
    await sleep(Math.max(0, next - Date.now()));
  }
}

// --- run --------------------------------------------------------------------

// A server left by an earlier run would answer in place of this one.
for (const busy of [port, inspectPort])
  if (
    await fetch(`http://127.0.0.1:${busy}/`).then(
      () => true,
      () => false,
    )
  )
    throw new Error(`port ${busy} is in use; stop the earlier server first`);
const runtimeStart = runtimeIdentity(
  path.resolve(args["server-dist"] ?? "packages/server/dist"),
  path.resolve(args["client-dist"] ?? "packages/client/dist"),
);
const host = await startHostEvidence(
  scenario.sessions >= 50000 && scenario.compactions >= 200,
);
rmSync(world, { recursive: true, force: true });
mkdirSync(world, { recursive: true });
mkdirSync(out, { recursive: true });
const w = args.world === "clone" ? cloneWorld() : syntheticWorld();
log(
  w.longBytes
    ? `long session ${w.sessionId}: ${Math.round(w.longBytes / 1e6)} MB, ${w.longLines} lines`
    : `long session ${w.sessionId}`,
);
// Stop the detached server however this run ends, including a failed start.
let current;
process.on("exit", () => {
  try {
    if (current) process.kill(-current.pid, "SIGINT");
  } catch {}
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, () => process.exit(130));
let server = await startServer(w);
log(`catalog complete after ${server.completeMs} ms`);
const projectId = Buffer.from(w.projectPath).toString("base64url");
const urls = {
  session: `/projects/${projectId}/sessions/${w.sessionId}`,
  all: "/sessions",
  inbox: "/inbox",
};
const { chromium } = await import(
  pathToFileURL(
    path.join(repo, "packages/client/node_modules/@playwright/test/index.mjs"),
  ).href
);
const browser = await chromium.launch({
  headless: true,
  chromiumSandbox: true,
});
const context = await browser.newContext({
  viewport: { width: 1400, height: 1000 },
});
// Each tab records when a write's marker first appears in its DOM.
await context.addInitScript(() => {
  const marks = {};
  window.__yaMarks = marks;
  const pattern = /mk(\d+)z/g;
  const scan = (text) => {
    if (!text?.includes("mk")) return;
    const now = Date.now();
    for (const match of text.matchAll(pattern)) marks[match[1]] ??= now;
  };
  const observe = () =>
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "characterData") scan(record.target.textContent);
        else for (const node of record.addedNodes) scan(node.textContent);
      }
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  if (document.documentElement) observe();
  else document.addEventListener("DOMContentLoaded", observe);
});

let phase = "settle";
const requests = [];
const frames = [];
const pages = [];
const allPages = [];
async function openTab(name, url) {
  const page = await context.newPage();
  page.on("websocket", (socket) =>
    socket.on("framereceived", (frame) => {
      const payload =
        typeof frame.payload === "string"
          ? frame.payload
          : frame.payload.toString("latin1");
      frames.push({
        phase,
        page: name,
        bytes: payload.length,
        type: /"type":"([^"]+)"/.exec(payload)?.[1] ?? "binary",
      });
    }),
  );
  // A request belongs to the phase it started in, however long it takes.
  const startedIn = new WeakMap();
  page.on("request", (request) => startedIn.set(request, phase));
  page.on("requestfinished", async (request) => {
    if (!request.url().includes("/api/")) return;
    const entry = {
      phase: startedIn.get(request) ?? phase,
      page: name,
      method: request.method(),
      url: request.url().slice(server.base.length),
      ms: request.timing().responseEnd,
      bytes: 0,
    };
    requests.push(entry);
    try {
      entry.bytes = (await request.sizes()).responseBodySize;
    } catch {}
  });
  const tab = { name, page, cdp: await context.newCDPSession(page) };
  tab.network = await observePageNetwork(tab.cdp, () => phase);
  await tab.cdp.send("Performance.enable");
  await page.goto(server.base + url);
  pages.push(tab);
  allPages.push(tab);
  return tab;
}
for (const name of String(args.pages ?? "session").split(","))
  await openTab(name, urls[name]);

let ins = await inspector();
async function attachInspector() {
  const pid = await ins.evaluate("process.pid");
  if (pid !== current.pid)
    throw new Error(`inspector reached pid ${pid}, not ${current.pid}`);
  await ins.evaluate(
    "globalThis.__yaLoop ??= process.getBuiltinModule('node:perf_hooks').monitorEventLoopDelay({ resolution: 5 }), globalThis.__yaLoop.enable(), 1",
  );
}
await attachInspector();

/**
 * Waits until the server's CPU stays under 10% of a core for 10 s (at most
 * `seconds`): after startup, and between phases so one phase's backlog is not
 * billed to the next. A host whose idle cost is above that never settles.
 */
async function quiesce(seconds) {
  const deadline = Date.now() + seconds * 1000;
  let last = psProcess(current.pid).cpuS;
  let quietFor = 0;
  while (Date.now() < deadline && quietFor < 10) {
    await sleep(5000);
    const now = psProcess(current.pid).cpuS;
    quietFor = now - last < 0.5 ? quietFor + 5 : 0;
    last = now;
  }
  return quietFor >= 10;
}

async function snapshot() {
  const [cpu, memory, tabs] = await Promise.all([
    ins.evaluate("JSON.stringify(process.cpuUsage())").then(JSON.parse),
    ins.evaluate("JSON.stringify(process.memoryUsage())").then(JSON.parse),
    Promise.all(
      pages.map(async (p) => [
        p.name,
        Object.fromEntries(
          (await p.cdp.send("Performance.getMetrics")).metrics.map((m) => [
            m.name,
            m.value,
          ]),
        ),
      ]),
    ).then(Object.fromEntries),
  ]);
  return {
    at: Date.now(),
    cpu,
    memory,
    threads: threadTimes(current.pid),
    tabs,
  };
}

async function loopDelay(reset) {
  const value = JSON.parse(
    await ins.evaluate(
      "JSON.stringify({ p50: __yaLoop.percentile(50) / 1e6, p99: __yaLoop.percentile(99) / 1e6, max: __yaLoop.max / 1e6 })",
    ),
  );
  if (reset) await ins.evaluate("__yaLoop.reset(), 1");
  return value;
}

function routeKey(r) {
  const [pathname, query] = r.url.split("?");
  return `${r.method} ${pathname.replace(/[A-Za-z0-9_-]{20,}/g, ":id")}${query ? `?${[...new URLSearchParams(query).keys()].sort().join("&")}` : ""}`;
}

/** Runs `body` as phase `name` and returns its totals and per-write ratios. */
async function measure(name, body) {
  const hostStart = await measuredHostSample(host.capacity);
  if (args["cpu-profile"]) {
    await ins.send("Profiler.enable");
    await ins.send("Profiler.setSamplingInterval", { interval: 1000 });
    await ins.send("Profiler.start");
  }
  if (args["browser-profile"])
    for (const p of pages) {
      await p.cdp.send("Profiler.enable");
      await p.cdp.send("Profiler.start");
    }
  await loopDelay(true);
  const before = await snapshot();
  phase = name;
  const extra = (await body()) ?? {};
  phase = `${name}-done`;
  const after = await snapshot();
  const loop = await loopDelay(true);
  if (args["cpu-profile"])
    writeFileSync(
      path.join(out, `server-${name}.cpuprofile`),
      JSON.stringify((await ins.send("Profiler.stop")).profile),
    );
  if (args["browser-profile"])
    for (const p of pages)
      writeFileSync(
        path.join(out, `browser-${name}-${p.name}.cpuprofile`),
        JSON.stringify((await p.cdp.send("Profiler.stop")).profile),
      );
  const wallS = (after.at - before.at) / 1000;
  const processS =
    (after.cpu.user + after.cpu.system - before.cpu.user - before.cpu.system) /
    1e6;
  const mainS = after.threads.length
    ? after.threads[0] - (before.threads[0] ?? 0)
    : undefined;
  const mine = requests.filter((r) => r.phase === name);
  const routes = {};
  for (const r of mine) {
    const key = `${r.page} ${routeKey(r)}`;
    routes[key] ??= { count: 0, totalMs: 0, kB: 0 };
    routes[key].count++;
    routes[key].totalMs += r.ms;
    routes[key].kB += r.bytes / 1024;
  }
  for (const route of Object.values(routes)) {
    route.totalMs = Math.round(route.totalMs);
    route.kB = round(route.kB);
  }
  const ws = { frames: 0, kB: 0, types: {} };
  for (const f of frames.filter((f) => f.phase === name)) {
    ws.frames++;
    ws.kB += f.bytes / 1024;
    ws.types[f.type] = (ws.types[f.type] ?? 0) + 1;
  }
  ws.kB = Math.round(ws.kB);
  const writes = extra.writes ?? 0;
  const perWrite = (value, digits = 1) =>
    writes ? round((value * 1000) / writes, digits) : undefined;
  const tabs = Object.fromEntries(
    pages
      .filter((p) => before.tabs[p.name])
      .map((p) => {
        const taskS =
          after.tabs[p.name].TaskDuration - before.tabs[p.name].TaskDuration;
        return [
          p.name,
          {
            taskS: round(taskS, 2),
            scriptS: round(
              after.tabs[p.name].ScriptDuration -
                before.tabs[p.name].ScriptDuration,
              2,
            ),
            taskMsPerWrite: perWrite(taskS),
            heapMB: Math.round(after.tabs[p.name].JSHeapUsedSize / 1048576),
          },
        ];
      }),
  );
  const result = {
    wallS: round(wallS),
    writes,
    server: {
      processCpuS: round(processS),
      processCpuPercent: round((processS / wallS) * 100),
      mainThreadCpuS: round(mainS),
      processMsPerWrite: perWrite(processS),
      mainThreadMsPerWrite: mainS === undefined ? undefined : perWrite(mainS),
      loopDelayMs: {
        p50: round(loop.p50),
        p99: round(loop.p99),
        max: round(loop.max),
      },
      heapMB: Math.round(after.memory.heapUsed / 1048576),
      rssMB: Math.round(after.memory.rss / 1048576),
    },
    tabs,
    requests: mine.length,
    requestsPerWrite: writes ? round(mine.length / writes, 2) : undefined,
    kBPerWrite: writes
      ? round(mine.reduce((s, r) => s + r.bytes, 0) / 1024 / writes)
      : undefined,
    webSocket: ws,
    host: await hostWindow(host, hostStart),
    network: Object.fromEntries(
      allPages.map((p) => [
        p.name,
        {
          chunks: p.network.chunks.filter((chunk) => chunk.phase === name),
          serverTimings: p.network.timings.filter(
            (timing) => timing.phase === name,
          ),
        },
      ]),
    ),
    routes: Object.fromEntries(
      Object.entries(routes).sort((a, b) => b[1].totalMs - a[1].totalMs),
    ),
    ...extra,
  };
  log(
    `${name}: ${result.wallS} s, ${writes} writes, process ${result.server.processCpuS} s (${result.server.processMsPerWrite ?? "-"} ms/write), main ${result.server.mainThreadCpuS} s (${result.server.mainThreadMsPerWrite ?? "-"} ms/write), loop p99 ${result.server.loopDelayMs.p99} ms, ${mine.length} requests`,
  );
  return result;
}

const gitSha = (() => {
  try {
    return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"])
      .toString()
      .trim();
  } catch {
    return undefined;
  }
})();
const summary = {
  label,
  world: args.world ?? "synthetic",
  args,
  repoHead: gitSha,
  generatorVersion: GENERATOR_VERSION,
  host,
  runtimeIdentity: { start: runtimeStart },
  harnessSha256: Object.fromEntries(
    [
      "scripts/perf-repro/active-session.mjs",
      "scripts/perf-repro/active-session-metrics.mjs",
      "scripts/perf-repro/active-session-build.mjs",
      "scripts/perf-repro/scenario-transcripts.mjs",
      "scripts/perf-suite/core.mjs",
      "scripts/perf-suite/host-profile.mjs",
      "scripts/perf-suite/ratchet-evaluation.mjs",
      "scripts/perf-suite/config.json",
    ].map((name) => [
      name,
      createHash("sha256")
        .update(readFileSync(path.join(repo, name)))
        .digest("hex"),
    ]),
  ),
  scenario: args.world === "clone" ? undefined : scenario,
  longSession: {
    id: w.sessionId,
    MB: w.longBytes ? Math.round(w.longBytes / 1e6) : undefined,
    lines: w.longLines,
  },
  startup: {
    pid: current.pid,
    listeningMs: server.listeningMs,
    catalogCompleteMs: server.completeMs,
  },
  phases: {},
};
const writeSummary = () => {
  summary.targetAssessment = targetChecks(summary, requests);
  writeFileSync(
    path.join(out, "requests.json"),
    `${JSON.stringify(requests, null, 2)}\n`,
  );
  writeFileSync(
    path.join(out, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
};

summary.startup.quiet = await quiesce(Number(args.quiet ?? 300));
await sleep(Number(args.settle ?? 10) * 1000);

if (phases.has("idle"))
  summary.phases.idle = await measure("idle", async () => {
    await sleep(Number(args["idle-seconds"] ?? 180) * 1000);
  });

async function activePhase(name, options = {}) {
  const seconds = options.seconds ?? Number(args.seconds ?? 180);
  w.nextCompactionAt =
    (w.liveWrites ?? 0) +
    (options.typing
      ? Math.floor(
          (Number(args.warmup ?? 20) + seconds / 2) /
            Number(args.interval ?? 1),
        )
      : Math.floor(Number(args["compact-every"] ?? 300) / 2));
  // Warm-up writes are not measured: the first write after a quiet spell
  // pays for caches the steady state keeps.
  await writeLong(w, Date.now() + Number(args.warmup ?? 20) * 1000, () => {});
  const written = [];
  const compactionsBefore = w.liveCompactions ?? 0;
  summary.phases[name] = await measure(name, async () => {
    const typing = options.typing
      ? typeDuringWrites(pages.find((p) => p.name === "session").page, seconds)
      : undefined;
    let writes = 0;
    await writeLong(w, Date.now() + seconds * 1000, (marker) => {
      writes++;
      if (marker) written.push({ marker, at: Date.now() });
    });
    return {
      writes,
      compactions: (w.liveCompactions ?? 0) - compactionsBefore,
      ...(typing ? { typing: await typing } : {}),
    };
  });
  const tab = pages.find((p) => p.name === "session");
  if (tab) {
    // Wait (up to --visible-wait s) for every write to show, so slow ones are
    // counted rather than censored.
    let marks = {};
    const deadline = Date.now() + Number(args["visible-wait"] ?? 120) * 1000;
    do {
      marks = await tab.page.evaluate(() => window.__yaMarks);
      if (written.every(({ marker }) => marks[marker.slice(2, -1)])) break;
      await sleep(1000);
    } while (Date.now() < deadline);
    const latencies = [];
    summary.phases[name].visibleSamples = [];
    let missing = 0;
    for (const { marker, at } of written) {
      const seen = marks[marker.slice(2, -1)];
      summary.phases[name].visibleSamples.push({
        marker,
        appendedAt: at,
        seenAt: seen ?? null,
      });
      if (seen === undefined) missing++;
      else latencies.push(seen - at);
    }
    summary.phases[name].writeToVisibleMs = {
      count: latencies.length,
      missing,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: latencies.length ? Math.max(...latencies) : undefined,
    };
    log("write to visible", summary.phases[name].writeToVisibleMs);
  }
  writeSummary();
}

if (phases.has("active")) {
  await activePhase("active");
  if (args["additional-tab"]) {
    await openTab("session-2", urls.session);
    await activePhase("additionalTab");
    const extra = pages.find((p) => p.name === "session-2");
    await extra.page.close();
    pages.splice(pages.indexOf(extra), 1);
  }
  if (args.typing) {
    await quiesce(60);
    await activePhase("typing", {
      typing: true,
      seconds: Number(args["typing-seconds"] ?? 60),
    });
  }
}

if (phases.has("lists")) {
  summary.phases.listsSettled = await quiesce(180);
  // Each list route the tabs used, fetched alone and timed (not the drafts
  // long poll, which waits by design).
  const listHostStart = await measuredHostSample(host.capacity);
  const seen = new Map();
  for (const r of requests)
    if (
      r.method === "GET" &&
      !r.url.includes("/sessions/") &&
      !r.url.includes("/drafts/changes") &&
      !seen.has(routeKey(r))
    )
      seen.set(routeKey(r), r.url);
  const timings = {};
  for (const [key, url] of seen) {
    const ms = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      try {
        await (
          await fetch(server.base + url, {
            headers: { "X-Yep-Anywhere": "true" },
          })
        ).arrayBuffer();
        ms.push(performance.now() - t0);
      } catch (error) {
        timings[key] = { error: String(error.cause ?? error) };
      }
    }
    if (!ms.length) continue;
    timings[key] = {
      medianMs: round(percentile(ms, 0.5)),
      maxMs: round(Math.max(...ms)),
    };
  }
  summary.phases.lists = {
    ...timings,
    host: await hostWindow(host, listHostStart),
  };
  log("lists", timings);
  writeSummary();
}

if (phases.has("restart")) {
  // Tabs are closed first, so what the restart costs is the server's own
  // work, not tabs reconnecting and reloading.
  for (const tab of pages.splice(0)) await tab.page.close();
  const restartHostStart = await measuredHostSample(host.capacity);
  await quiesce(60);
  ins.close();
  await stopAndWait(current);
  server = await startServer(w);
  const atComplete = psProcess(current.pid);
  await sleep(30_000);
  const after30 = psProcess(current.pid);
  ins = await inspector();
  await attachInspector();
  const t0 = performance.now();
  await (
    await fetch(`${server.base}/api/sessions?summaryMode=retained&limit=50`, {
      headers: { "X-Yep-Anywhere": "true" },
    })
  ).arrayBuffer();
  summary.phases.restart = {
    pid: current.pid,
    listeningMs: server.listeningMs,
    listsCompleteMs: server.completeMs,
    cpuSAtComplete: atComplete.cpuS,
    // CPU from process start to 30 s after the lists were complete.
    cpuSToCompletePlus30s: after30.cpuS,
    rssMB: after30.rssMB,
    firstListPageMs: round(performance.now() - t0),
    host: await hostWindow(host, restartHostStart),
  };
  log("restart", summary.phases.restart);
  writeSummary();
}

if (phases.has("open")) {
  // After a restart this is a cold open on a server that has not read the
  // session; without one, the server has served it before.
  summary.phases.openSettled = await quiesce(180);
  summary.phases.openAfterRestart = phases.has("restart");
  summary.phases.open = await measure("open", async () => {
    const t0 = Date.now();
    const tab = await openTab("open", urls.session);
    let shownAt;
    // The newest visible write is near the end; wait for any marker within
    // the last two turns.
    for (let i = 0; i < 1200 && shownAt === undefined; i++) {
      const marks = await tab.page.evaluate(() => window.__yaMarks);
      const latest = Object.keys(marks)
        .map(Number)
        .sort((a, b) => b - a)[0];
      if (
        latest !== undefined &&
        (!w.session || latest >= w.session.writes - 8)
      )
        shownAt = marks[latest];
      else await sleep(50);
    }
    await sleep(3000);
    await tab.page.close();
    pages.splice(pages.indexOf(tab), 1);
    return {
      firstPaintMs: shownAt === undefined ? undefined : shownAt - t0,
    };
  });
  writeSummary();
}

writeSummary();
ins.close();
await browser.close();
await stopAndWait(current);
const runtimeEnd = runtimeIdentity(
  runtimeStart.server.root,
  runtimeStart.client.root,
);
summary.runtimeIdentity.end = runtimeEnd;
summary.runtimeIdentity.unchanged =
  JSON.stringify(runtimeStart) === JSON.stringify(runtimeEnd);
writeSummary();
console.log(JSON.stringify(summary, null, 2));

// Opt-in numeric guard; a passing subset still does not certify open qualitative gates.
if (args["check-targets"] && !summary.targetAssessment.observedGatePass)
  process.exitCode = 1;
