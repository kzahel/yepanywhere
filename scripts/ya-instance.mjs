#!/usr/bin/env node

/**
 * Find, start and stop local YA server instances by verified identity.
 *
 * Every YA server publishes `{dataDir}/server-instance.json` once it listens
 * (topics/server-runtime.md#local-instance-record). This tool acts only on a
 * process whose PID and start time match that record, so it never stops a
 * different server whose command line merely looks the same.
 */

import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RECORD_FILE = "server-instance.json";
const START_TIME_TOLERANCE_MS = 5_000;
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `Usage: pnpm ya:instance <command> [options]

Commands:
  list                      Show YA instances recorded in ~/.yep-anywhere*
  start --profile NAME      Start a source server in the background on its own
                            data directory (~/.yep-anywhere-NAME); prints its URL
  stop  --profile NAME      Stop the instance serving that data directory

Target options (start/stop):
  --profile NAME            Data directory ~/.yep-anywhere-NAME
  --data-dir DIR            Explicit data directory
  --port N                  stop: the instance listening on N
                            start: port to bind (default 0 = any free port)

Other options:
  --json                    list: machine-readable output
  --timeout-ms N            start/stop: how long to wait (default 90000/30000)
  --kill                    stop: SIGKILL survivors after the timeout
  --allow-default           stop: permit stopping the default ~/.yep-anywhere

stop refuses the default data directory unless --allow-default is given, and
always refuses an instance that this command is running under (stopping it
would kill the agent or terminal that asked). A dev-wrapper instance is
stopped through its wrapper, which ends the whole lifetime; a backend killed
alone is restarted by the wrapper.`;

function fail(message) {
  console.error(`ya:instance: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, dataDirs: [] };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    const value = () => {
      const next = rest[++index];
      if (next === undefined) fail(`${arg} needs a value`);
      return next;
    };
    if (arg === "--profile") options.profile = value();
    else if (arg === "--data-dir") options.dataDirs.push(resolve(value()));
    else if (arg === "--port") options.port = value();
    else if (arg === "--timeout-ms") options.timeoutMs = Number(value());
    else if (arg === "--json") options.json = true;
    else if (arg === "--kill") options.kill = true;
    else if (arg === "--allow-default") options.allowDefault = true;
    else if (arg === "-h" || arg === "--help") options.command = "help";
    else fail(`unknown option ${arg}\n\n${USAGE}`);
  }
  if (options.port !== undefined && !/^\d+$/.test(options.port)) {
    fail(`--port must be a number, got ${options.port}`);
  }
  if (
    options.timeoutMs !== undefined &&
    !(Number.isFinite(options.timeoutMs) && options.timeoutMs > 0)
  ) {
    fail("--timeout-ms must be a positive number");
  }
  return options;
}

const defaultDataDir = () => join(homedir(), ".yep-anywhere");

function profileDataDir(profile) {
  if (!profile || /[/\\]/.test(profile) || profile.startsWith(".")) {
    fail(`invalid profile name: ${JSON.stringify(profile)}`);
  }
  return join(homedir(), `.yep-anywhere-${profile}`);
}

/** The one data directory a start/stop request names, if any. */
function namedDataDir(options) {
  const named = [
    ...(options.profile !== undefined ? [profileDataDir(options.profile)] : []),
    ...options.dataDirs,
  ];
  if (named.length > 1) fail("give only one of --profile or --data-dir");
  return named[0];
}

function knownDataDirs(extra = []) {
  const dirs = new Set(extra);
  let names = [];
  try {
    names = readdirSync(homedir());
  } catch {
    // An unreadable home lists only explicit directories.
  }
  for (const name of names) {
    if (name === ".yep-anywhere" || name.startsWith(".yep-anywhere-")) {
      const path = join(homedir(), name);
      try {
        if (statSync(path).isDirectory()) dirs.add(path);
      } catch {
        // Raced removal.
      }
    }
  }
  return [...dirs];
}

function readRecord(dataDir) {
  let text;
  try {
    text = readFileSync(join(dataDir, RECORD_FILE), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
  try {
    const record = JSON.parse(text);
    if (record?.version !== 1 || !Number.isInteger(record.pid)) return null;
    return { ...record, recordDataDir: dataDir };
  } catch {
    return null;
  }
}

function parseElapsedSeconds(text) {
  // ps etime: [[dd-]hh:]mm:ss
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!match) return null;
  const [, days = "0", hours = "0", minutes, seconds] = match;
  return (
    ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 +
    Number(seconds)
  );
}

/**
 * One `ps` snapshot: start time and parent of every process. Null where `ps`
 * is unavailable (Windows), where identity cannot be verified.
 */
function processSnapshot() {
  if (process.platform === "win32") return null;
  const output = execFileSync("ps", ["-A", "-o", "pid=,ppid=,etime=,stat="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  const takenAt = Date.now();
  const processes = new Map();
  for (const line of output.split("\n")) {
    const [pid, ppid, etime, stat] = line.trim().split(/\s+/);
    const elapsed = etime ? parseElapsedSeconds(etime) : null;
    // A zombie has exited; only its parent's bookkeeping remains.
    if (!pid || elapsed === null || stat?.startsWith("Z")) continue;
    processes.set(Number(pid), {
      ppid: Number(ppid),
      startedAt: takenAt - elapsed * 1000,
    });
  }
  return processes;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** running | gone | reused (PID now names another process) | unverified */
function identity(snapshot, pid, startedAt) {
  if (!snapshot) return pidAlive(pid) ? "unverified" : "gone";
  const entry = snapshot.get(pid);
  if (!entry) return "gone";
  // etime truncates to whole seconds, so ps reports a start up to 1s late.
  return Math.abs(entry.startedAt - startedAt) <= START_TIME_TOLERANCE_MS
    ? "running"
    : "reused";
}

function inspect(snapshot, record) {
  const backend = identity(snapshot, record.pid, record.startedAt);
  const supervisor = record.supervisor
    ? identity(snapshot, record.supervisor.pid, record.supervisor.startedAt)
    : null;
  return { backend, supervisor };
}

function ancestors(snapshot) {
  const chain = new Set();
  let pid = process.pid;
  while (snapshot?.has(pid) && !chain.has(pid) && pid > 1) {
    chain.add(pid);
    pid = snapshot.get(pid).ppid;
  }
  return chain;
}

function describe(record) {
  return record.profile
    ? `profile ${record.profile}`
    : record.recordDataDir === defaultDataDir()
      ? "default profile"
      : record.recordDataDir;
}

function list(options) {
  const snapshot = processSnapshot();
  const rows = [];
  for (const dataDir of knownDataDirs(options.dataDirs)) {
    const record = readRecord(dataDir);
    if (!record) continue;
    const state = inspect(snapshot, record);
    const live = state.backend === "running" || state.backend === "unverified";
    rows.push({
      status: live ? state.backend : "stale",
      dataDir,
      profile: record.profile,
      url: record.url,
      pid: record.pid,
      supervisor: record.supervisor
        ? { ...record.supervisor, status: state.supervisor }
        : null,
    });
  }
  if (options.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log("No recorded YA instances.");
    return;
  }
  for (const row of rows) {
    const supervisor = row.supervisor
      ? ` dev-wrapper=${row.supervisor.pid}`
      : "";
    console.log(
      `${row.status.padEnd(10)} ${row.url.padEnd(24)} pid=${row.pid}${supervisor}  ${row.dataDir}`,
    );
  }
}

function stopTarget(options, snapshot) {
  const dataDir = namedDataDir(options);
  if (dataDir) {
    const record = readRecord(dataDir);
    if (!record) fail(`no instance record in ${dataDir}`);
    if (options.port !== undefined && record.port !== Number(options.port)) {
      fail(`${dataDir} is serving port ${record.port}, not ${options.port}`);
    }
    return record;
  }
  if (options.port === undefined) {
    fail(`stop needs --profile, --data-dir or --port\n\n${USAGE}`);
  }
  const matches = knownDataDirs()
    .map(readRecord)
    .filter(
      (record) =>
        record?.port === Number(options.port) &&
        inspect(snapshot, record).backend !== "gone",
    );
  if (matches.length === 0) {
    fail(
      `no recorded instance on port ${options.port}; a server started from another data directory needs --data-dir`,
    );
  }
  if (matches.length > 1) {
    fail(
      `several records claim port ${options.port}: ${matches.map((r) => r.recordDataDir).join(", ")}`,
    );
  }
  return matches[0];
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  return true;
}

async function stop(options) {
  const snapshot = processSnapshot();
  if (!snapshot) {
    fail("stop cannot verify process identity on this platform");
  }
  const record = stopTarget(options, snapshot);
  const state = inspect(snapshot, record);
  const label = `${describe(record)} (port ${record.port})`;
  const targets = [];
  if (state.backend === "running") {
    targets.push({ pid: record.pid, startedAt: record.startedAt });
  }
  if (state.supervisor === "running") {
    targets.push({
      pid: record.supervisor.pid,
      startedAt: record.supervisor.startedAt,
    });
  }
  if (targets.length === 0) {
    console.log(`${label} is not running (stale record).`);
    return;
  }
  if (record.recordDataDir === defaultDataDir() && !options.allowDefault) {
    fail(
      `refusing to stop the default instance ${label}; it is usually the YA you are using. Pass --allow-default if that is intended.`,
    );
  }
  const chain = ancestors(snapshot);
  if (targets.some((target) => chain.has(target.pid))) {
    fail(
      `refusing to stop ${label}: this command is running under it, so stopping it would end the session that asked.`,
    );
  }
  // The wrapper ends the whole YA lifetime; signalling only its backend would
  // just get the backend replaced.
  const signalled =
    state.supervisor === "running" ? record.supervisor.pid : record.pid;
  console.log(`Stopping ${label}: SIGTERM to pid ${signalled}`);
  process.kill(signalled, "SIGTERM");
  const stillRunning = () => {
    const now = processSnapshot();
    return targets.filter(
      (target) => identity(now, target.pid, target.startedAt) === "running",
    );
  };
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (await waitUntil(() => stillRunning().length === 0, timeoutMs)) {
    console.log(`Stopped ${label}.`);
    return;
  }
  if (!options.kill) {
    fail(
      `${label} still running after ${timeoutMs}ms (pids ${stillRunning()
        .map((target) => target.pid)
        .join(", ")}); rerun with --kill to force it`,
    );
  }
  for (const target of stillRunning()) {
    console.log(`Forcing pid ${target.pid} with SIGKILL`);
    process.kill(target.pid, "SIGKILL");
  }
  if (!(await waitUntil(() => stillRunning().length === 0, 5_000))) {
    fail(`${label} survived SIGKILL`);
  }
  console.log(`Stopped ${label} (forced).`);
}

async function start(options) {
  const dataDir = namedDataDir(options);
  if (!dataDir) fail(`start needs --profile or --data-dir\n\n${USAGE}`);
  if (dataDir === defaultDataDir()) {
    fail("start runs side instances; use pnpm dev for the default profile");
  }
  const existing = readRecord(dataDir);
  if (existing) {
    const state = inspect(processSnapshot(), existing).backend;
    if (state === "running" || state === "unverified") {
      fail(
        `${dataDir} is already served at ${existing.url} (pid ${existing.pid})`,
      );
    }
  }

  const logDir = join(dataDir, "logs");
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const logPath = join(logDir, "instance-launch.log");
  const logFd = openSync(logPath, "a");
  const env = { ...process.env };
  // A fresh, standalone server: no inherited wrapper, generation, provider
  // host or data-directory selection from whatever launched this command.
  for (const key of Object.keys(env)) {
    if (
      /^YEP_(DEV_|SERVER_GENERATION$|PROVIDER_RUNTIME_|PROVIDER_HOST_RUNTIME_DIR$|DATA_DIR$|PROFILE$)/.test(
        key,
      ) ||
      /^YEP_ANYWHERE_(DATA_DIR|PROFILE)$/.test(key) ||
      key === "PORT_FILE"
    ) {
      delete env[key];
    }
  }
  env.PORT = options.port ?? "0";
  if (options.profile !== undefined) env.YEP_PROFILE = options.profile;
  else env.YEP_DATA_DIR = dataDir;

  const launchedAt = Date.now();
  const child = spawn(
    process.execPath,
    [
      join(rootDir, "scripts/run-with-safe-home.js"),
      "tsx",
      "--conditions",
      "source",
      "src/index.ts",
    ],
    {
      cwd: join(rootDir, "packages/server"),
      env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    },
  );
  closeSync(logFd);
  let exited = null;
  child.once("exit", (code, signal) => {
    exited = { code, signal };
  });

  const timeoutMs = options.timeoutMs ?? 90_000;
  let record = null;
  const ready = await waitUntil(() => {
    if (exited) return true;
    const candidate = readRecord(dataDir);
    if (candidate && candidate.writtenAt >= launchedAt) record = candidate;
    return record !== null;
  }, timeoutMs);
  const tail = () =>
    readFileSync(logPath, "utf8").split("\n").slice(-30).join("\n");
  if (!record) {
    if (!exited && !ready) {
      try {
        process.kill(process.platform === "win32" ? child.pid : -child.pid);
      } catch {
        // Exited meanwhile.
      }
    }
    fail(
      `${exited ? `server exited (code=${exited.code}, signal=${exited.signal})` : `server did not listen within ${timeoutMs}ms`}; log ${logPath}:\n${tail()}`,
    );
  }
  child.unref();
  const target =
    options.profile !== undefined
      ? `--profile ${options.profile}`
      : `--data-dir ${dataDir}`;
  console.log(
    [
      `Started YA at ${record.url} (pid ${record.pid})`,
      `  data dir: ${dataDir}`,
      `  log:      ${logPath}`,
      `  stop:     pnpm ya:instance stop ${target}`,
    ].join("\n"),
  );
}

const options = parseArgs(process.argv.slice(2));
switch (options.command) {
  case "list":
    list(options);
    break;
  case "start":
    await start(options);
    break;
  case "stop":
    await stop(options);
    break;
  case "help":
  case undefined:
    console.log(USAGE);
    break;
  default:
    fail(`unknown command ${options.command}\n\n${USAGE}`);
}
