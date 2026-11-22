// Shared pieces of the plan 195 `agy` probe: an owned profile, a scripted
// model, `agy acp` processes and log tails under one cleanup owner, bounded
// waits, store snapshots, and a streaming, read-only step census.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  cpSync,
  createReadStream,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const server = join(repo, "packages/server");
const { modelServer, syntheticKey } = await import(
  join(server, "test/native-provider/model-server.ts")
);
const { AntigravityRuntime } = await import(
  join(server, "src/sdk/providers/antigravity-runtime.ts")
);

export const now = () => performance.now();
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const run = promisify(execFile);

export function defaultAgy() {
  return join(
    repo,
    "node_modules/.cache/ya-native-provider-tests",
    `${process.platform}-${process.arch}`,
    "antigravity/1.5.13/agy",
  );
}

/**
 * One owner for everything a probe starts. `close()` runs cleanups in
 * reverse order, even after a failure, and before the profile is removed.
 */
export function createScope() {
  const cleanups = [];
  return {
    defer(cleanup) {
      cleanups.push(cleanup);
    },
    async close() {
      const errors = [];
      while (cleanups.length) {
        try {
          await cleanups.pop()();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AggregateError(errors, "Probe cleanup failed");
    },
  };
}

/** Rejects with `label` when `promise` takes longer than `ms`. */
export async function bounded(promise, label, ms = 30_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not finish within ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function startModel() {
  return modelServer("gemini", {
    blockedHosts: ["play.googleapis.com:443"],
    auxiliary: (_body, path) =>
      path.endsWith("/gemini-3.1-flash-lite-preview:streamGenerateContent")
        ? "title"
        : undefined,
  });
}

/** The next scripted model request, or a diagnostic failure. */
export function nextRequest(model, label, ms = 30_000) {
  return bounded(model.next(), `model request "${label}"`, ms);
}

/** Raw Gemini SSE parts; `final` closes the candidate. */
export function sendParts(exchange, parts, final) {
  exchange.start();
  exchange.gemini(parts, final);
}
export function endExchange(exchange) {
  exchange.end();
}
export const call = (name, args) => ({ functionCall: { name, args } });

export function makeProfile(model) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ya-agy-probe-")));
  const home = join(root, "home");
  const gemini = join(home, ".gemini");
  const store = join(gemini, "antigravity-cli");
  const project = join(root, "project");
  mkdirSync(store, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(store, "settings.json"),
    JSON.stringify({
      modelProvider: "gemini",
      auth: { type: "gemini-api-key" },
    }),
  );
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    GEMINI_HOME: gemini,
    GEMINI_API_KEY: syntheticKey,
    GOOGLE_GEMINI_BASE_URL: model.url,
    HTTP_PROXY: model.url,
    HTTPS_PROXY: model.url,
    ALL_PROXY: model.url,
    http_proxy: model.url,
    https_proxy: model.url,
    grpc_proxy: model.url,
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
    AGY_CLI_DISABLE_AUTO_UPDATE: "1",
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0",
  };
  // AntigravityRuntime spawns with process.env; give it only the owned profile.
  for (const name of Object.keys(process.env))
    if (!(name in env)) delete process.env[name];
  Object.assign(process.env, env);
  return { root, gemini, store, project };
}

/** The stopped store, kept aside so every reopen leg starts identically. */
export function saveStore(profile) {
  const pristine = join(profile.root, "pristine-store");
  rmSync(pristine, { recursive: true, force: true });
  cpSync(profile.store, pristine, {
    recursive: true,
    preserveTimestamps: true,
  });
  return pristine;
}
export function restoreStore(profile, pristine) {
  rmSync(profile.store, { recursive: true, force: true });
  cpSync(pristine, profile.store, {
    recursive: true,
    preserveTimestamps: true,
  });
}

/**
 * One `agy acp` process with timestamped ACP updates, closed by `scope`.
 * Permission requests arrive with string JSON-RPC IDs, which YA's transport
 * refuses (see the permission-ID gap), so the probe answers them itself.
 */
export async function startAgy(
  scope,
  profile,
  { agy, t0, skipPermissions = false, verbose = false },
) {
  const runtime = new AntigravityRuntime();
  scope.defer(() => runtime.close());
  const updates = [];
  const permissions = [];
  runtime.onUpdate = (update, sessionId, isReplay) => {
    updates.push({
      t: now() - t0,
      sessionId,
      isReplay,
      kind: update.sessionUpdate,
      toolCallId: update.toolCallId,
      status: update.status,
      title: update.title,
      rawInput:
        update.rawInput === undefined
          ? undefined
          : JSON.stringify(update.rawInput),
      text: typeof update.content?.text === "string" ? update.content.text : "",
      bytes: JSON.stringify(update).length,
    });
  };
  const answer = async (params) => {
    permissions.push({
      t: now() - t0,
      toolCallId: params.toolCall?.toolCallId,
      title: params.toolCall?.title,
    });
    const allow = params.options?.find((entry) => entry.kind === "allow_once");
    return { outcome: { outcome: "selected", optionId: allow?.optionId } };
  };
  runtime.onPermission = answer;
  const receive = runtime.receive.bind(runtime);
  runtime.receive = (message) => {
    if (verbose && message.method && message.method !== "session/update")
      console.error("frame", JSON.stringify(message).slice(0, 400));
    if (
      message.method === "session/request_permission" &&
      typeof message.id === "string"
    ) {
      permissions.stringIds = (permissions.stringIds ?? 0) + 1;
      void answer(message.params ?? {}).then((result) => {
        if (runtime.alive)
          runtime.send({ jsonrpc: "2.0", id: message.id, result });
      });
      return;
    }
    return receive(message);
  };
  let initialize;
  const callMethod = runtime.call.bind(runtime);
  runtime.call = async (method, params, timeout) => {
    const result = await callMethod(method, params, timeout);
    if (method === "initialize") initialize = result;
    return result;
  };
  await runtime.connect(agy, profile.project, [
    "acp",
    "--gemini-dir",
    profile.gemini,
    ...(skipPermissions ? ["--dangerously-skip-permissions"] : []),
  ]);
  return { runtime, updates, permissions, initialize: () => initialize };
}

export const logsDir = (store, id) =>
  join(store, "brain", id, ".system_generated", "logs");

/**
 * Tails one log by polling appended bytes every millisecond, keeping each
 * record's raw line and the time it was first seen. Stopped by `scope`.
 */
export function watchLog(scope, path, t0) {
  const seen = [];
  let offset = 0;
  let partial = "";
  const poll = () => {
    if (!existsSync(path)) return;
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      if (size < offset) throw new Error(`${path} shrank`);
      if (size === offset) return;
      const buffer = Buffer.alloc(size - offset);
      readSync(fd, buffer, 0, buffer.length, offset);
      offset = size;
      const t = now() - t0;
      const lines = (partial + buffer.toString("utf8")).split("\n");
      partial = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const record = JSON.parse(line);
        seen.push({
          t,
          step: record.step_index,
          type: record.type,
          status: record.status,
          line,
          record,
        });
      }
    } finally {
      closeSync(fd);
    }
  };
  const timer = setInterval(poll, 1);
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    poll();
  };
  scope.defer(stop);
  return {
    seen,
    stop,
    /** Records whose bytes in the file now differ from what was first seen. */
    recheck() {
      const current = new Map();
      for (const line of readFileSync(path, "utf8").split("\n"))
        if (line) current.set(JSON.parse(line).step_index, line);
      return {
        records: current.size,
        rewritten: seen
          .filter((entry) => current.get(entry.step) !== entry.line)
          .map((entry) => entry.step),
      };
    },
  };
}

function walk(directory, out = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

function hashFile(path) {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(1 << 20);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** Size, mtime and SHA-256 of every file under the store, at one moment. */
export function snapshot(store) {
  const files = {};
  for (const path of walk(store)) {
    const info = statSync(path);
    files[relative(store, path)] = {
      size: info.size,
      mtimeMs: info.mtimeMs,
      sha256: hashFile(path),
    };
  }
  return files;
}

export function diff(before, after) {
  const changes = [];
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[name];
    const b = after[name];
    if (!a) changes.push({ file: name, change: "created", size: b.size });
    else if (!b) changes.push({ file: name, change: "deleted" });
    else if (a.sha256 !== b.sha256)
      changes.push({
        file: name,
        change: "content",
        size: `${a.size}->${b.size}`,
      });
    else if (a.mtimeMs !== b.mtimeMs)
      changes.push({ file: name, change: "mtime-only", size: b.size });
  }
  return changes.sort((x, y) => x.file.localeCompare(y.file));
}

/** Snapshots before and after each phase of a reopen, all before any prompt. */
export function phaseDiffs(snapshots) {
  const names = Object.keys(snapshots);
  const out = {};
  for (let i = 1; i < names.length; i++)
    out[`${names[i - 1]} -> ${names[i]}`] = diff(
      snapshots[names[i - 1]],
      snapshots[names[i]],
    );
  out[`${names[0]} -> ${names.at(-1)}`] = diff(
    snapshots[names[0]],
    snapshots[names.at(-1)],
  );
  return out;
}

export async function rssOfGroup(pid) {
  const { stdout } = await run("ps", ["-A", "-o", "pid=,pgid=,rss="]);
  let kib = 0;
  for (const line of stdout.split("\n")) {
    const [, pgid, rss] = line.trim().split(/\s+/).map(Number);
    if (pgid === pid) kib += rss;
  }
  return kib;
}

/** Peak resident memory of a process group, sampled every 25 ms. */
export function sampleRss(scope, pid) {
  let peak = 0;
  let stopped = false;
  const done = (async () => {
    while (!stopped) {
      peak = Math.max(peak, await rssOfGroup(pid).catch(() => 0));
      await sleep(25);
    }
  })();
  const stop = async () => {
    stopped = true;
    await done;
    return peak;
  };
  scope.defer(stop);
  return stop;
}

// ---------------------------------------------------------------- census ---

/** Plain step columns from a private copy of a conversation database. */
export function databaseSteps(databasePath) {
  const scratch = mkdtempSync(join(tmpdir(), "ya-agy-db-"));
  try {
    const copy = join(scratch, "copy.db");
    copyFileSync(databasePath, copy);
    for (const suffix of ["-wal", "-shm"])
      if (existsSync(databasePath + suffix))
        copyFileSync(databasePath + suffix, copy + suffix);
    // A private copy, so opening it read-write (to replay its WAL) is harmless.
    const db = new DatabaseSync(copy);
    try {
      const out = [];
      for (const row of db
        .prepare("SELECT idx, step_type, status FROM steps ORDER BY idx")
        .iterate())
        out.push({
          idx: Number(row.idx),
          type: Number(row.step_type),
          status: Number(row.status),
        });
      return out;
    } finally {
      db.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * One streaming pass over a log. Keeps step indexes, counts and short
 * groups; each record's payload is dropped after its fields are read.
 * A group is a planner record with k tool calls and the GENERIC records
 * that follow it. It is complete with k results, short when another
 * record type arrives first, and open when the file ends first.
 */
export async function scanLog(path) {
  const steps = [];
  const types = {};
  let increasing = true;
  let contiguous = true;
  let previous;
  let open;
  const groups = {
    complete: 0,
    short: [],
    openAtEnd: undefined,
    orphanResults: 0,
  };
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  stream.on("data", (chunk) => hash.update(chunk));
  for await (const line of createInterface({
    input: stream,
    crlfDelay: Infinity,
  })) {
    if (!line) continue;
    const record = JSON.parse(line);
    const step = record.step_index;
    const calls = Array.isArray(record.tool_calls)
      ? record.tool_calls.length
      : 0;
    if (previous !== undefined) {
      if (!(step > previous)) increasing = false;
      if (step !== previous + 1) contiguous = false;
    }
    previous = step;
    steps.push(step);
    types[record.type] = (types[record.type] ?? 0) + 1;
    if (record.type === "GENERIC") {
      if (open) {
        open.results++;
        open.lastResult = step;
        if (open.results === open.calls) {
          groups.complete++;
          open = undefined;
        }
      } else groups.orphanResults++;
      continue;
    }
    if (open) {
      groups.short.push({ ...open, next: { step, type: record.type } });
      open = undefined;
    }
    if (record.type === "PLANNER_RESPONSE" && calls > 0)
      open = { planner: step, calls, results: 0, lastResult: step };
  }
  if (open) groups.openAtEnd = open;
  return {
    steps,
    types,
    increasing,
    contiguous,
    groups,
    sha256: hash.digest("hex"),
  };
}

function fileFacts(path) {
  if (!existsSync(path)) return null;
  const info = statSync(path);
  return `${info.ino}:${info.size}:${info.mtimeMs}`;
}

/**
 * Database steps against the log for one conversation. The database (with
 * its WAL) and the log are not read atomically, so the result is
 * inconclusive when any of them changed while it was read.
 */
export async function coverageOf(store, id) {
  const database = join(store, "conversations", `${id}.db`);
  const logPath = join(logsDir(store, id), "transcript_full.jsonl");
  const watched = [database, `${database}-wal`, logPath];
  const before = watched.map(fileFacts);
  const steps = databaseSteps(database);
  const log = await scanLog(logPath);
  const after = watched.map(fileFacts);
  const inconclusive = before.some((facts, i) => facts !== after[i]);
  const logged = new Set(log.steps);
  const byIdx = new Map(steps.map((step) => [step.idx, step]));
  const short = log.groups.short.map((group) => {
    const missing = [];
    for (let idx = group.lastResult + 1; idx < group.next.step; idx++)
      missing.push(byIdx.get(idx) ?? { idx, type: null, status: null });
    return {
      ...group,
      missingSteps: missing,
      explainedByInterruptedResults:
        missing.length === group.calls - group.results &&
        missing.every((step) => step.type === 132 && step.status === 6),
    };
  });
  return {
    inconclusive,
    databaseSteps: steps.length,
    logRecords: log.steps.length,
    increasing: log.increasing,
    contiguous: log.contiguous,
    unlogged: steps.filter((step) => !logged.has(step.idx)),
    loggedWithoutStep: log.steps.filter((step) => !byIdx.has(step)),
    groups: {
      complete: log.groups.complete,
      short,
      openAtEnd: log.groups.openAtEnd,
      orphanResults: log.groups.orphanResults,
    },
    types: log.types,
  };
}
