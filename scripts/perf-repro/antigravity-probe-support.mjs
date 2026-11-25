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
 * A resource failing on its own callback (a log tail's timer) calls
 * `fail()`, which rejects `failure`; the probe awaits its body against
 * `failure`, so the error unwinds through the same cleanup.
 */
export function createScope() {
  const cleanups = [];
  let reject;
  const failure = new Promise((_, rejectFailure) => {
    reject = rejectFailure;
  });
  // Observed only when the probe races against it.
  failure.catch(() => {});
  return {
    failure,
    fail(error) {
      reject(error);
    },
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
    AGY_CLI_FORCE_FILE_TOKEN_STORAGE: "1",
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
 * `decide(params, signal)` may return an option kind for a permission
 * request (default `allow_once`), or "cancelled".
 */
export async function startAgy(
  scope,
  profile,
  { agy, t0, skipPermissions = false, verbose = false, decide },
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
  // YA's own transport answers permission requests; the probe allows once
  // unless `decide` says otherwise, and records each request's ID type.
  const idTypes = [];
  runtime.onPermission = async (params, signal) => {
    permissions.push({
      t: now() - t0,
      toolCallId: params.toolCall?.toolCallId,
      title: params.toolCall?.title,
    });
    const kind = (await decide?.(params, signal)) ?? "allow_once";
    if (kind === "cancelled") return { outcome: { outcome: "cancelled" } };
    const option = params.options?.find((entry) => entry.kind === kind);
    return { outcome: { outcome: "selected", optionId: option?.optionId } };
  };
  const receive = runtime.receive.bind(runtime);
  runtime.receive = (message) => {
    if (verbose && message.method && message.method !== "session/update")
      console.error("frame", JSON.stringify(message).slice(0, 400));
    if (message.method === "session/request_permission")
      idTypes.push(typeof message.id);
    return receive(message);
  };
  permissions.idTypes = idTypes;
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
  let failed;
  let stopped = false;
  // A failure stops the timer and rejects through the scope, so the probe
  // unwinds through its cleanup instead of dying on an uncaught throw.
  const guarded = () => {
    if (failed) return;
    try {
      poll();
    } catch (error) {
      failed = error;
      clearInterval(timer);
      scope.fail(error);
    }
  };
  const timer = setInterval(guarded, 1);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    guarded();
  };
  scope.defer(stop);
  return {
    seen,
    stop,
    /**
     * Records whose bytes in the file now differ from what was first seen.
     * Only meaningful after the tail stopped without a failure.
     */
    recheck() {
      if (failed) throw failed;
      if (!stopped) throw new Error(`${path} is still being tailed`);
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
 * One streaming pass over a log. Keeps step indexes, counts and tool groups;
 * each record's payload is dropped after its fields are read. Only records
 * ending in a newline count: a final line without one is reported as
 * `unterminatedTail` (an append in progress), not parsed.
 *
 * Tool groups are read by step index. A planner record at step P with k
 * calls owns steps P+1..P+k, and a GENERIC at P+1+i is call i's result:
 *  - complete: all k results present;
 *  - prefix: results at P+1..P+m (m < k), then a non-GENERIC record after
 *    P+k (the missing steps are the last calls' interrupted results);
 *  - gapped: results present with missing steps that are not a suffix,
 *    then a non-GENERIC record after P+k;
 *  - unknown: a non-GENERIC record inside P+1..P+k, or a GENERIC with no
 *    group owning its step (outside every range, or more results than
 *    calls);
 *  - open at end: the file ends before the group closes.
 */
export async function scanLog(path) {
  const steps = [];
  const types = {};
  let increasing = true;
  let contiguous = true;
  let previous;
  let open;
  let lastClosed;
  const groups = {
    complete: 0,
    prefix: [],
    gapped: [],
    unknown: [],
    openAtEnd: undefined,
  };
  const describe = (group) => ({
    planner: group.planner,
    calls: group.calls,
    results: group.present.length,
    missing: Array.from({ length: group.calls }, (_, i) => i)
      .filter((i) => !group.present.includes(i))
      .map((i) => group.planner + 1 + i),
  });
  const close = (next) => {
    const group = open;
    open = undefined;
    lastClosed = group;
    if (group.present.length === group.calls) {
      groups.complete++;
      return;
    }
    const isPrefix = group.present.every((offset, i) => offset === i);
    (isPrefix ? groups.prefix : groups.gapped).push({
      ...describe(group),
      next,
    });
  };
  const unknown = (reason, step) => {
    groups.unknown.push({
      reason,
      step,
      group: lastClosed ? describe(lastClosed) : null,
    });
  };
  const take = (line) => {
    const record = JSON.parse(line);
    const step = record.step_index;
    if (!Number.isSafeInteger(step) || typeof record.type !== "string")
      throw new Error(
        `record without step_index or type after step ${previous}`,
      );
    if (previous !== undefined) {
      if (!(step > previous)) increasing = false;
      if (step !== previous + 1) contiguous = false;
    }
    previous = step;
    steps.push(step);
    types[record.type] = (types[record.type] ?? 0) + 1;
    if (open && step > open.planner + open.calls)
      close({ step, type: record.type });
    if (record.type === "GENERIC") {
      if (open) {
        open.present.push(step - open.planner - 1);
        if (open.present.length === open.calls) close(undefined);
      } else unknown("GENERIC with no group owning its step", step);
      return;
    }
    if (open) {
      // Name the group whose steps this record is inside.
      lastClosed = open;
      open = undefined;
      unknown("non-GENERIC record inside a group's steps", step);
    }
    const calls = Array.isArray(record.tool_calls)
      ? record.tool_calls.length
      : 0;
    if (record.type === "PLANNER_RESPONSE" && calls > 0)
      open = { planner: step, calls, present: [] };
    else lastClosed = undefined;
  };
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  let endsWithNewline = false;
  stream.on("data", (chunk) => {
    hash.update(chunk);
    endsWithNewline = chunk[chunk.length - 1] === 0x0a;
  });
  // Each line is handled once the next one arrives, so the last line can be
  // held back when the file does not end with a newline.
  let held;
  for await (const line of createInterface({
    input: stream,
    crlfDelay: Infinity,
  })) {
    if (held !== undefined && held) take(held);
    held = line;
  }
  const unterminatedTail =
    held !== undefined && held !== "" && !endsWithNewline;
  if (held && !unterminatedTail) take(held);
  if (open) groups.openAtEnd = describe(open);
  return {
    steps,
    types,
    increasing,
    contiguous,
    groups,
    unterminatedTail,
    sha256: hash.digest("hex"),
  };
}

function fileFacts(path) {
  if (!existsSync(path)) return null;
  try {
    const info = statSync(path);
    return `${info.ino}:${info.size}:${info.mtimeMs}`;
  } catch {
    return null;
  }
}

/**
 * Database steps against the log for one conversation. The database (with
 * its WAL) and the log are not read atomically, so the result is
 * inconclusive when any of them changed while it was read, or when the log
 * ends in an unterminated record. A read that fails on files that did not
 * change is reported as that conversation's error.
 */
export async function coverageOf(store, id) {
  const database = join(store, "conversations", `${id}.db`);
  const logPath = join(logsDir(store, id), "transcript_full.jsonl");
  const watched = [database, `${database}-wal`, logPath];
  const before = watched.map(fileFacts);
  const changed = () =>
    watched.map(fileFacts).some((facts, i) => facts !== before[i]);
  let steps;
  let log;
  try {
    steps = databaseSteps(database);
    log = await scanLog(logPath);
  } catch (error) {
    const message = String(error?.message ?? error);
    return changed()
      ? {
          inconclusive: true,
          reason: `files changed during a failed read: ${message}`,
        }
      : { inconclusive: false, error: message };
  }
  const inconclusive = changed() || log.unterminatedTail;
  const logged = new Set(log.steps);
  const byIdx = new Map(steps.map((step) => [step.idx, step]));
  const withDatabase = (group) => {
    const missingSteps = group.missing.map(
      (idx) => byIdx.get(idx) ?? { idx, type: null, status: null },
    );
    return {
      ...group,
      missingSteps,
      missingAreInterruptedResults: missingSteps.every(
        (step) => step.type === 132 && step.status === 6,
      ),
    };
  };
  return {
    inconclusive,
    ...(log.unterminatedTail
      ? { reason: "the log ends in an unterminated record" }
      : {}),
    databaseSteps: steps.length,
    logRecords: log.steps.length,
    increasing: log.increasing,
    contiguous: log.contiguous,
    unlogged: steps.filter((step) => !logged.has(step.idx)),
    loggedWithoutStep: log.steps.filter((step) => !byIdx.has(step)),
    groups: {
      complete: log.groups.complete,
      prefix: log.groups.prefix.map(withDatabase),
      gapped: log.groups.gapped.map(withDatabase),
      unknown: log.groups.unknown,
      openAtEnd: log.groups.openAtEnd ?? null,
    },
    types: log.types,
  };
}
