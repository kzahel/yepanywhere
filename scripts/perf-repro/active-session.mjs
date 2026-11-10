#!/usr/bin/env node
// Background cost of a browser tab open on a long, active session.
//
// Builds an isolated world (a synthetic Claude store, or copy-on-write clones
// of real provider stores and a profile), starts one passive production
// server on it with the inspector, opens headless Chromium on the session,
// appends to the session at a provider-like pace, and records what the
// server and the tab spent: process CPU and per-thread CPU, a main-thread
// CPU profile, every API request the tab made, WebSocket frames, and the
// tab's own task time (optionally its CPU profile).
//
// It is a diagnostic, not a gate: timings depend on the host, so compare
// builds on the same host, interleaved, on fresh worlds. The inspector is
// attached and the CPU profiler samples every millisecond, which adds a little
// to every figure. Runs on macOS and Linux (per-thread CPU from `ps -M` or
// /proc), not Windows.
//
//   node scripts/perf-repro/active-session.mjs --label base \
//     [--server-dist packages/server/dist] [--client-dist packages/client/dist] \
//     [--seconds 180] [--pages session,all] [--browser-profile] \
//     [--world synthetic --projects 40 --sessions 3000 --long-turns 3000] \
//     [--world clone --profile ~/.yep-anywhere --claude ~/.claude/projects \
//        --codex ~/.codex/sessions --long <session id> --keep 0.85]
//
// The clone world reads the live profile only: each SQLite file is copied with
// `sqlite3 -readonly … VACUUM INTO`, and the rest is cloned
// (copy-on-write where possible). In the copy, stored native identities move
// to the cloned store paths, the catalog is emptied to be rebuilt from the
// clones, and the profile is made passive (no updates, host-awake, relay,
// project queue or push). The held-back tail of the long session is then
// replayed at its recorded pace (gaps capped at --cap seconds). Results go to
// <work>/results/<label>/. Never point --work at a live profile.
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  realpathSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encodeProjectPath, transcriptRows } from "../perf-suite/core.mjs";

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const args = parseArgs(process.argv.slice(2));
const work = path.resolve(args.work ?? "/tmp/ya-active-session-repro");
const label = args.label ?? "run";
const port = Number(args.port ?? 3420);
const inspectPort = port + 1000;
const seconds = Number(args.seconds ?? 180);
const world = path.join(work, "world");
const out = path.join(work, "results", label);

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

function syntheticWorld() {
  const projects = Number(args.projects ?? 40);
  const sessions = Number(args.sessions ?? 3000);
  const longTurns = Number(args["long-turns"] ?? 3000);
  const store = path.join(world, "claude-projects");
  const projectPaths = [];
  for (let p = 0; p < projects; p++) {
    const projectPath = path.join(world, "projects", `project-${p}`);
    mkdirSync(projectPath, { recursive: true });
    mkdirSync(path.join(store, encodeProjectPath(projectPath)), {
      recursive: true,
    });
    projectPaths.push(projectPath);
  }
  const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  for (let s = 0; s < sessions; s++) {
    const projectPath = projectPaths[s % projects];
    const sessionId = uuid(s + 1);
    writeFileSync(
      path.join(store, encodeProjectPath(projectPath), `${sessionId}.jsonl`),
      transcriptRows({
        projectPath,
        sessionId,
        startTurn: 0,
        turns: 2 + (s % 5),
        payloadBytes: 400,
      }),
    );
  }
  const projectPath = projectPaths[0];
  const sessionId = uuid(sessions + 1);
  const file = path.join(
    store,
    encodeProjectPath(projectPath),
    `${sessionId}.jsonl`,
  );
  writeFileSync(
    file,
    agentTurns({ projectPath, sessionId, from: 0, turns: longTurns }),
  );
  return { store, projectPath, sessionId, file, nextTurn: longTurns };
}

/** Agent-shaped turns: prompt, tool call, tool result, markdown answer. */
function agentTurns({ projectPath, sessionId, from, turns }) {
  const rows = [];
  const base = {
    cwd: projectPath,
    sessionId,
    isSidechain: false,
    version: "2.1.223",
    gitBranch: "main",
  };
  let parentUuid = from === 0 ? null : `${sessionId}-a2-${from - 1}`;
  for (let turn = from; turn < from + turns; turn++) {
    const at = (k) =>
      new Date(
        Date.UTC(2026, 7, 8, 12, 0, 0) + (turn * 4 + k) * 1000,
      ).toISOString();
    const ids = ["u", "a1", "r", "a2"].map((k) => `${sessionId}-${k}-${turn}`);
    rows.push(
      {
        ...base,
        type: "user",
        uuid: ids[0],
        parentUuid,
        timestamp: at(0),
        message: {
          role: "user",
          content: `Turn ${turn}: check the parser in src/parser-${turn % 50}.ts and fix the failing case.`,
        },
      },
      {
        ...base,
        type: "assistant",
        uuid: ids[1],
        parentUuid: ids[0],
        timestamp: at(1),
        requestId: `req_${ids[1]}`,
        message: {
          id: `msg_${ids[1]}`,
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [
            { type: "text", text: "Reading the parser first." },
            {
              type: "tool_use",
              id: `toolu_${turn}`,
              name: "Bash",
              input: {
                command: `rg -n "parse" src/parser-${turn % 50}.ts`,
                description: "Find parse calls",
              },
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 1200, output_tokens: 80 },
        },
      },
      {
        ...base,
        type: "user",
        uuid: ids[2],
        parentUuid: ids[1],
        timestamp: at(2),
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: `toolu_${turn}`,
              content: Array.from(
                { length: 30 },
                (_, i) =>
                  `src/parser-${turn % 50}.ts:${i + 1}: const node${i} = parse(input${i});`,
              ).join("\n"),
            },
          ],
        },
        toolUseResult: { stdout: "…", stderr: "", interrupted: false },
      },
      {
        ...base,
        type: "assistant",
        uuid: ids[3],
        parentUuid: ids[2],
        timestamp: at(3),
        requestId: `req_${ids[3]}`,
        message: {
          id: `msg_${ids[3]}`,
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [
            {
              type: "text",
              text: `## Turn ${turn}\n\nThe failing case is an **empty input**. Changed \`parse\` to return early:\n\n\`\`\`ts\nif (input.length === 0) return [];\n\`\`\`\n\n- updated src/parser-${turn % 50}.ts\n- added a test`,
            },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 1500, output_tokens: 120 },
        },
      },
    );
    parentUuid = ids[3];
  }
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

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

async function startServer(w) {
  const logs = path.join(work, "run", "logs");
  const empty = path.join(work, "run", "empty");
  mkdirSync(logs, { recursive: true });
  mkdirSync(empty, { recursive: true });
  const dist = path.resolve(
    args["server-dist"] ?? path.join(repo, "packages/server/dist"),
  );
  const env = {
    HOME: homedir(),
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
    CODEX_SESSIONS_DIR: existsSync(path.join(world, "codex-sessions"))
      ? path.join(world, "codex-sessions")
      : empty,
    GEMINI_SESSIONS_DIR: empty,
    GROK_SESSIONS_DIR: empty,
    PI_SESSIONS_DIR: empty,
    CLIENT_DIST_PATH: path.resolve(
      args["client-dist"] ?? path.join(repo, "packages/client/dist"),
    ),
  };
  mkdirSync(env.YEP_DATA_DIR, { recursive: true });
  // A fresh profile discovers only the provider families its install has
  // started; the synthetic store is Claude's.
  if (!existsSync(path.join(env.YEP_DATA_DIR, "install.json")))
    writeFileSync(
      path.join(env.YEP_DATA_DIR, "install.json"),
      JSON.stringify({
        version: 2,
        installId: "00000000-0000-4000-8000-000000000001",
        createdAt: "2026-01-01T00:00:00.000Z",
        catalogFamilies: ["claude"],
        catalogMetadataMigrationComplete: true,
      }),
    );
  const child = spawn(
    process.execPath,
    [`--inspect=127.0.0.1:${inspectPort}`, path.join(dist, "index.js")],
    {
      env,
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    },
  );
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 600; i++) {
    await sleep(1000);
    if (child.exitCode !== null)
      throw new Error("server exited during startup");
    try {
      const body = await (
        await fetch(`${base}/api/sessions?summaryMode=retained&limit=1`, {
          headers: { "X-Yep-Anywhere": "true" },
        })
      ).text();
      if (body.includes('"complete":true')) return { child, base };
    } catch {}
  }
  throw new Error("catalog never completed");
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
  return {
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        pending.set(++id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      }),
    close: () => ws.close(),
  };
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

// --- appender ---------------------------------------------------------------

async function append(w, until) {
  let writes = 0;
  if (args.world === "clone") {
    const lines = readFileSync(path.join(world, "replay.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean);
    const at = (line) => Date.parse(JSON.parse(line).timestamp ?? "") || null;
    const cap = Number(args.cap ?? 8) * 1000;
    let previous = null;
    for (let i = 0; i < lines.length && Date.now() < until; ) {
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
      writes++;
      previous = t0 ?? previous;
      i += batch.length;
    }
    return writes;
  }
  // Synthetic: one agent turn, in four writes, every --interval seconds.
  const interval = Number(args.interval ?? 2.5) * 1000;
  let turn = w.nextTurn;
  while (Date.now() < until) {
    for (const row of agentTurns({
      projectPath: w.projectPath,
      sessionId: w.sessionId,
      from: turn,
      turns: 1,
    })
      .trim()
      .split("\n")) {
      appendFileSync(w.file, `${row}\n`);
      writes++;
      await sleep(interval / 4);
    }
    turn++;
  }
  return writes;
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
rmSync(world, { recursive: true, force: true });
mkdirSync(world, { recursive: true });
mkdirSync(out, { recursive: true });
const w = args.world === "clone" ? cloneWorld() : syntheticWorld();
const { child, base } = await startServer(w);
// Stop the detached server however this run ends.
const stopServer = () => {
  try {
    process.kill(-child.pid, "SIGINT");
  } catch {}
};
process.on("exit", stopServer);
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
const requests = [];
const ws = { frames: 0, bytes: 0, types: {} };
let measuring = false;
const pages = [];
for (const name of String(args.pages ?? "session").split(",")) {
  const page = await context.newPage();
  page.on("websocket", (socket) =>
    socket.on("framereceived", (frame) => {
      if (!measuring) return;
      const payload =
        typeof frame.payload === "string"
          ? frame.payload
          : frame.payload.toString("latin1");
      ws.frames++;
      ws.bytes += payload.length;
      const type = /"type":"([^"]+)"/.exec(payload)?.[1] ?? "binary";
      ws.types[type] = (ws.types[type] ?? 0) + 1;
    }),
  );
  page.on("requestfinished", (request) => {
    if (measuring && request.url().includes("/api/"))
      requests.push({
        page: name,
        method: request.method(),
        url: request.url().slice(base.length),
        ms: request.timing().responseEnd,
      });
  });
  await page.goto(base + urls[name]);
  pages.push({ name, page, cdp: await context.newCDPSession(page) });
}
for (const p of pages) await p.cdp.send("Performance.enable");
await sleep(Number(args.settle ?? 25) * 1000);

const server = await inspector();
const serverPid = (
  await server.send("Runtime.evaluate", {
    expression: "process.pid",
    returnByValue: true,
  })
).result.value;
if (serverPid !== child.pid)
  throw new Error(`inspector reached pid ${serverPid}, not ${child.pid}`);
const probe = async () =>
  JSON.parse(
    (
      await server.send("Runtime.evaluate", {
        expression: "JSON.stringify(process.cpuUsage())",
        returnByValue: true,
      })
    ).result.value,
  );
const metrics = async () =>
  Object.fromEntries(
    await Promise.all(
      pages.map(async (p) => [
        p.name,
        Object.fromEntries(
          (await p.cdp.send("Performance.getMetrics")).metrics.map((m) => [
            m.name,
            m.value,
          ]),
        ),
      ]),
    ),
  );
await server.send("Profiler.enable");
await server.send("Profiler.setSamplingInterval", { interval: 1000 });
await server.send("Profiler.start");
if (args["browser-profile"])
  for (const p of pages) {
    await p.cdp.send("Profiler.enable");
    await p.cdp.send("Profiler.start");
  }
const cpu0 = await probe();
const threads0 = threadTimes(child.pid);
const metrics0 = await metrics();
const started = Date.now();
measuring = true;
const writes = await append(w, started + seconds * 1000);
const wall = (Date.now() - started) / 1000;
measuring = false;
const cpu1 = await probe();
const threads1 = threadTimes(child.pid);
const metrics1 = await metrics();
writeFileSync(
  path.join(out, "server.cpuprofile"),
  JSON.stringify((await server.send("Profiler.stop")).profile),
);
if (args["browser-profile"])
  for (const p of pages)
    writeFileSync(
      path.join(out, `browser-${p.name}.cpuprofile`),
      JSON.stringify((await p.cdp.send("Profiler.stop")).profile),
    );
server.close();

const routes = {};
for (const r of requests) {
  const [pathname, query] = r.url.split("?");
  const key = `${r.page} ${r.method} ${pathname.replace(/[A-Za-z0-9_-]{20,}/g, ":id")}${query ? `?${[...new URLSearchParams(query).keys()].sort().join("&")}` : ""}`;
  routes[key] ??= { count: 0, totalMs: 0 };
  const entry = routes[key];
  entry.count++;
  entry.totalMs = Math.round(entry.totalMs + r.ms);
}
const processCpuS = (cpu1.user + cpu1.system - cpu0.user - cpu0.system) / 1e6;
const mainThreadS = threads1.length
  ? threads1[0] - (threads0[0] ?? 0)
  : undefined;
const summary = {
  label,
  world: args.world ?? "synthetic",
  wallS: wall,
  writes,
  server: {
    processCpuS: +processCpuS.toFixed(1),
    processCpuPercent: +((processCpuS / wall) * 100).toFixed(1),
    mainThreadCpuS:
      mainThreadS === undefined ? undefined : +mainThreadS.toFixed(1),
  },
  tabs: Object.fromEntries(
    pages.map((p) => [
      p.name,
      {
        taskS: +(
          metrics1[p.name].TaskDuration - metrics0[p.name].TaskDuration
        ).toFixed(2),
        scriptS: +(
          metrics1[p.name].ScriptDuration - metrics0[p.name].ScriptDuration
        ).toFixed(2),
        heapMB: Math.round(metrics1[p.name].JSHeapUsedSize / 1048576),
      },
    ]),
  ),
  webSocket: ws,
  requests: requests.length,
  routes: Object.fromEntries(
    Object.entries(routes).sort((a, b) => b[1].totalMs - a[1].totalMs),
  ),
};
writeFileSync(
  path.join(out, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));
await browser.close();
stopServer();
