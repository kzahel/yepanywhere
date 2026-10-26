/** Real filesystem acceptance scenarios. Retain fixtures; never touch native user history. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  appendFile,
  rename,
  stat,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";

const root = await mkdtemp(join(tmpdir(), "ya-native-discovery-"));
const home = join(root, "home");
await mkdir(home, { recursive: true });
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  CODEX_HOME: join(home, ".codex"),
  CODEX_SESSIONS_DIR: join(home, ".codex", "sessions"),
  CLAUDE_CONFIG_DIR: join(home, ".claude"),
  CLAUDE_SESSIONS_DIR: join(home, ".claude", "projects"),
  GEMINI_SESSIONS_DIR: join(home, ".gemini", "tmp"),
  PI_SESSIONS_DIR: join(home, ".pi", "agent", "sessions"),
  GROK_SESSIONS_DIR: join(home, ".grok", "sessions"),
  YEP_DATA_DIR: join(root, "data"),
  LOG_PRETTY: "false",
  LOG_LEVEL: "warn",
});
const { CodexSessionScanner } = await import(
  "../src/projects/codex-scanner.js"
);
const { ProjectScanner } = await import("../src/projects/scanner.js");
const { ClaudeSessionReader } = await import("../src/sessions/reader.js");
const { CodexSessionReader } = await import("../src/sessions/codex-reader.js");
const {
  createCodexSessionDiscoveryIndex,
  readCodexRolloutMetadata,
  createCodexRolloutDiscoveryStats,
} = await import("../src/sessions/codex-discovery.js");
const { encodeProjectId, readCwdFromSessionFile } = await import(
  "../src/projects/paths.js"
);
const { readFirstLine } = await import("../src/utils/jsonl.js");
const { EventBus } = await import("../src/watcher/EventBus.js");
const { ProviderSessionWatcherRegistry } = await import(
  "../src/watcher/ProviderSessionWatcherRegistry.js"
);
const { normalizeSession } = await import("../src/sessions/normalization.js");
const { SessionIndexService } = await import(
  "../src/indexes/SessionIndexService.js"
);
const { getLogger } = await import("../src/logging/logger.js");
const timestamp = "2026-10-26T08:00:00.000Z";
const cwd = join(root, "project");
const projectId = encodeProjectId(cwd);
const id = "11111111-1111-4111-8111-111111111111";
const archivedId = "22222222-2222-4222-8222-222222222222";
const fileName = (sessionId = id) =>
  "rollout-2026-10-26T08-00-00-" + sessionId + ".jsonl";
const lines = (entries) =>
  entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
function codex(sessionId = id, path = cwd, text = "Explain the login flow") {
  return lines([
    {
      type: "session_meta",
      timestamp,
      payload: { id: sessionId, cwd: path, timestamp, source: "cli" },
    },
    {
      type: "event_msg",
      timestamp,
      payload: { type: "user_message", message: text },
    },
    {
      type: "response_item",
      timestamp,
      payload: {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "OAuth returns to the session list." },
        ],
      },
    },
  ]);
}
function claude(text = "Inspect the mobile layout") {
  return lines([
    {
      type: "user",
      uuid: "u1",
      parentUuid: null,
      timestamp,
      cwd,
      message: { role: "user", content: text },
    },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      timestamp,
      cwd,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Keep the content column bounded." }],
        model: "claude-sonnet-4-5",
      },
    },
  ]);
}
async function directory(name) {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  return path;
}
async function lockFile(path) {
  const script =
    "$s=[IO.File]::Open('" +
    path.replaceAll("'", "''") +
    "',[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); Write-Output 'LOCKED'; [Console]::ReadLine() | Out-Null; $s.Dispose();";
  const child = spawn("powershell.exe", ["-NoProfile", "-Command", script], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let error = "";
  child.stderr.on("data", (chunk) => {
    error += String(chunk);
  });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("LOCKED")) resolve();
    });
    child.once("error", reject);
    child.once("exit", () => reject(new Error(error || "Lock process exited")));
  });
  return async () => {
    child.stdin.end("\n");
    await exited;
  };
}

await test("cold native discovery and detail still work", async () => {
  const sessionsDir = await directory("normal/sessions");
  const path = join(sessionsDir, fileName());
  await writeFile(path, codex());
  const scanner = new CodexSessionScanner({ sessionsDir });
  const reader = new CodexSessionReader({ sessionsDir, projectPath: cwd });
  assert.equal((await scanner.listProjects()).length, 1);
  assert.equal(
    normalizeSession(await reader.getSession(id, projectId)).messages.length,
    2,
  );
  await reader.close();
});

await test("transient OS lock preserves accepted Codex discovery and retries", {
  skip: process.platform !== "win32",
}, async () => {
  const sessionsDir = await directory("lock/sessions");
  const path = join(sessionsDir, fileName());
  await writeFile(path, codex());
  const scanner = new CodexSessionScanner({ sessionsDir });
  assert.equal((await scanner.listProjects()).length, 1);
  const reader = new CodexSessionReader({ sessionsDir });
  assert.equal((await reader.listSessionFiles(sessionsDir)).length, 1);
  const unlock = await lockFile(path);
  try {
    await assert.rejects(readFirstLine(path), { code: "EBUSY" });
    scanner.invalidateCache(path);
    reader.invalidateCache();
    assert.equal((await scanner.listProjects()).length, 1);
    assert.equal((await reader.listSessionFiles(sessionsDir)).length, 1);
  } finally {
    await unlock();
  }
  await writeFile(path, codex(id, cwd + "-moved"));
  assert.equal(
    (await scanner.listProjects())[0].path,
    (cwd + "-moved").replaceAll("\\", "/"),
  );
  assert.equal(
    await reader.getSessionProjectPath(id),
    (cwd + "-moved").replaceAll("\\", "/"),
  );
  await reader.close();
});

await test("Claude project discovery distinguishes a lock from missing cwd", {
  skip: process.platform !== "win32",
}, async () => {
  const projectsDir = await directory("claude-lock/projects");
  const dir = join(projectsDir, "-test-project");
  await mkdir(dir);
  const path = join(dir, id + ".jsonl");
  await writeFile(path, claude());
  const bus = new EventBus();
  const scanner = new ProjectScanner({
    projectsDir,
    enableCodex: false,
    enableGemini: false,
    eventBus: bus,
    cacheTtlMs: 0,
  });
  assert.equal((await scanner.listProjects()).length, 1);
  const unlock = await lockFile(path);
  try {
    await assert.rejects(readCwdFromSessionFile(path), { code: "EBUSY" });
    bus.emit({
      type: "file-change",
      provider: "claude",
      path,
      relativePath: relative(projectsDir, path),
      changeType: "modify",
      timestamp,
      fileType: "session",
    });
    assert.equal((await scanner.listProjects()).length, 1);
  } finally {
    await unlock();
  }
  assert.equal((await scanner.listProjects()).length, 1);
  await scanner.dispose();
});

await test("empty and malformed Claude replicas do not hide the valid source", async () => {
  for (const prefix of ["", "{incomplete"]) {
    const first = await directory("replica-" + prefix.length + "/first");
    const second = await directory("replica-" + prefix.length + "/second");
    await writeFile(join(first, id + ".jsonl"), prefix);
    await writeFile(join(second, id + ".jsonl"), claude());
    const reader = new ClaudeSessionReader({
      sessionDir: first,
      additionalDirs: [second],
    });
    assert.equal((await reader.listSessions(projectId)).length, 1);
    assert.equal(
      (await reader.getSessionSummary(id, projectId)).title,
      "Inspect the mobile layout",
    );
    assert.equal(
      normalizeSession(await reader.getSession(id, projectId)).messages.length,
      2,
    );
    assert.equal(
      await reader.getSessionFilePath(id),
      join(second, id + ".jsonl"),
    );
    await reader.close();
  }
});

await test("same-length and growing replacements refresh persisted Codex metadata", async () => {
  const sessionsDir = await directory("rewrite/sessions");
  const path = join(sessionsDir, fileName());
  const dataDir = await directory("rewrite/data");
  await writeFile(path, codex(id, "/project-a"));
  const before = await stat(path);
  let discoveryIndex = createCodexSessionDiscoveryIndex(dataDir, sessionsDir);
  await readCodexRolloutMetadata({
    sessionsDir,
    filePath: path,
    discoveryIndex,
  });
  await discoveryIndex.flush();
  for (const [n, next] of ["/project-b", "/a-longer-project"].entries()) {
    await writeFile(path, codex(id, next));
    const future = new Date(Date.now() + 1000 * (n + 1));
    await utimes(path, future, future);
    discoveryIndex = createCodexSessionDiscoveryIndex(dataDir, sessionsDir);
    assert.equal((await stat(path)).ino, before.ino);
    assert.equal(
      (
        await readCodexRolloutMetadata({
          sessionsDir,
          filePath: path,
          discoveryIndex,
        })
      ).cwd,
      next,
    );
    await discoveryIndex.flush();
  }
  const metrics = createCodexRolloutDiscoveryStats();
  await readCodexRolloutMetadata({
    sessionsDir,
    filePath: path,
    discoveryIndex,
    metrics,
  });
  assert.equal(metrics.discoveryIndexHits, 1);
  assert.equal(metrics.firstLineReadsPlain, 0);
});

await test("archive-only installation supports project, list, detail, and plain/zstd precedence", async () => {
  const base = await directory("archive");
  const sessionsDir = join(base, "sessions");
  const archive = join(base, "archived_sessions");
  await mkdir(archive);
  const path = join(archive, fileName(archivedId));
  const text = codex(archivedId);
  await writeFile(path, text);
  await writeFile(path + ".zst", zstdCompressSync(Buffer.from(text)));
  const scanner = new CodexSessionScanner({ sessionsDir });
  const reader = new CodexSessionReader({ sessionsDir, projectPath: cwd });
  assert.equal((await scanner.listProjects())[0].sessionCount, 1);
  assert.equal((await reader.listSessions(projectId)).length, 1);
  assert.equal(
    normalizeSession(await reader.getSession(archivedId, projectId)).messages
      .length,
    2,
  );
  assert.equal(await reader.getSessionFilePath(archivedId), path);
  await reader.close();
});

await test("active copy wins and a warm reader follows native archive/unarchive moves", async () => {
  const sessionsDir = await directory("moves/sessions");
  const archive = await directory("moves/archived_sessions");
  const active = join(sessionsDir, fileName());
  const archived = join(archive, fileName());
  await writeFile(active, codex());
  await writeFile(archived, codex(id, cwd, "Older archived copy"));
  const reader = new CodexSessionReader({ sessionsDir });
  assert.equal((await reader.listSessions(projectId)).length, 1);
  assert.equal(await reader.getSessionFilePath(id), active);
  await rename(archived, archived + ".saved");
  await rename(active, archived);
  assert.equal(
    normalizeSession(await reader.getSession(id, projectId)).messages.length,
    2,
  );
  assert.equal(await reader.getSessionFilePath(id), archived);
  await rename(archived, active);
  assert.equal(
    normalizeSession(await reader.getSession(id, projectId)).messages.length,
    2,
  );
  assert.equal(await reader.getSessionFilePath(id), active);
  await reader.close();
});

await test("archive watcher emits changes but ignores unrelated Codex home files", async () => {
  const base = await directory("watch");
  const sessionsDir = join(base, "sessions");
  const archive = join(base, "archived_sessions");
  await mkdir(archive);
  const bus = new EventBus();
  const events = [];
  const reader = new CodexSessionReader({ sessionsDir, projectPath: cwd });
  const index = new SessionIndexService({
    dataDir: await directory("watch/data"),
    eventBus: bus,
    fullValidationIntervalMs: 60_000,
  });
  assert.equal(
    (await index.getSessionsWithCache(sessionsDir, projectId, reader)).length,
    0,
  );
  const registry = new ProviderSessionWatcherRegistry({
    eventBus: bus,
    specs: [
      {
        family: "codex",
        provider: "codex",
        watchDir: sessionsDir,
        debounceMs: 10,
      },
    ],
  });
  const stop = bus.subscribe((event) => {
    events.push(event);
    if (event.type === "file-change") reader.invalidateCache();
  });
  registry.activate(["codex"]);
  try {
    const path = join(archive, fileName());
    const observed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error("Archive watcher did not emit"));
      }, 5000);
      const unsubscribe = bus.subscribe((event) => {
        if (event.type === "file-change" && event.path === path) {
          clearTimeout(timer);
          unsubscribe();
          resolve(event);
        }
      });
    });
    await writeFile(join(base, "unrelated.jsonl"), "{}\n");
    await writeFile(path, codex());
    await observed;
    const deadline = Date.now() + 5000;
    let sessions = [];
    do {
      sessions = await index.getSessionsWithCache(
        sessionsDir,
        projectId,
        reader,
      );
      if (sessions.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    assert.equal(sessions[0]?.title, "Explain the login flow");
    assert.equal(
      events.some(
        (event) =>
          event.type === "file-change" &&
          event.path.endsWith("unrelated.jsonl"),
      ),
      false,
    );
    assert.equal(registry.getMetrics().activeWatchers, 1);
  } finally {
    stop();
    registry.stop();
    index.dispose();
    await reader.close();
  }
  assert.equal(registry.getMetrics().activeWatchers, 0);
});

await test("missing and invalid files remain absent; half-written Claude lines recover", async () => {
  const dir = await directory("partial");
  assert.equal(await readFirstLine(join(dir, "absent.jsonl")), null);
  const sessionsDir = await directory("invalid/sessions");
  await writeFile(join(sessionsDir, fileName()), "{}\n");
  const scanner = new CodexSessionScanner({ sessionsDir });
  const logger = getLogger();
  const warnings = [];
  const warn = logger.warn;
  logger.warn = (...args) => warnings.push(args);
  try {
    assert.equal((await scanner.listProjects()).length, 0);
  } finally {
    logger.warn = warn;
  }
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /parsed 0 sessions/);
  const path = join(dir, id + ".jsonl");
  await writeFile(path, claude());
  const reader = new ClaudeSessionReader({ sessionDir: dir });
  await reader.getSession(id, projectId);
  const next = lines([
    {
      type: "user",
      uuid: "u2",
      parentUuid: "a1",
      timestamp,
      cwd,
      message: { role: "user", content: "Continue" },
    },
  ]);
  await appendFile(path, next.slice(0, 20));
  assert.equal(
    normalizeSession(await reader.getSession(id, projectId)).messages.length,
    2,
  );
  await appendFile(path, next.slice(20));
  assert.equal(
    normalizeSession(await reader.getSession(id, projectId)).messages.length,
    3,
  );
  await reader.close();
});
await test("indexed visible lists retain locked summaries and recover without a second event", {
  skip: process.platform !== "win32",
}, async () => {
  for (const provider of ["claude", "codex"]) {
    const dir = await directory("indexed-" + provider + "/sessions");
    const path = join(dir, provider === "codex" ? fileName() : id + ".jsonl");
    const content = provider === "codex" ? codex() : claude();
    await writeFile(path, content);
    const reader =
      provider === "codex"
        ? new CodexSessionReader({ sessionsDir: dir })
        : new ClaudeSessionReader({ sessionDir: dir });
    const index = new SessionIndexService({
      dataDir: await directory("indexed-" + provider + "/data"),
      fullValidationIntervalMs: 0,
    });
    try {
      const before = await index.getSessionsWithCache(dir, projectId, reader);
      assert.equal(before.length, 1);
      await appendFile(path, "\n");
      const unlock = await lockFile(path);
      try {
        assert.equal(
          (await index.getSessionsWithCache(dir, projectId, reader))[0].title,
          before[0].title,
        );
        assert.equal(
          (await index.getSessionSummaryWithCache(dir, projectId, id, reader))
            .title,
          before[0].title,
        );
      } finally {
        await unlock();
      }
      await writeFile(
        path,
        provider === "codex"
          ? codex(id, cwd, "Recovered title")
          : claude("Recovered title"),
      );
      assert.equal(
        (await index.getSessionsWithCache(dir, projectId, reader))[0].title,
        "Recovered title",
      );
      await rename(path, path + ".saved");
      reader.invalidateCache?.();
      assert.equal(
        (await index.getSessionsWithCache(dir, projectId, reader)).length,
        0,
      );
    } finally {
      index.dispose();
      await reader.close();
    }
  }
});

await test("Claude indexed replicas use the same valid source as detail", async () => {
  const first = await directory("replica-index/first");
  const second = await directory("replica-index/second");
  await writeFile(join(first, id + ".jsonl"), "{incomplete");
  await writeFile(join(second, id + ".jsonl"), claude());
  const reader = new ClaudeSessionReader({
    sessionDir: first,
    additionalDirs: [second],
  });
  const index = new SessionIndexService({
    dataDir: await directory("replica-index/data"),
    fullValidationIntervalMs: 0,
  });
  try {
    assert.equal(
      (await index.getSessionsWithCache(first, projectId, reader))[0].title,
      "Inspect the mobile layout",
    );
    assert.equal(
      (await reader.listSessionFiles(first))[0].filePath,
      join(second, id + ".jsonl"),
    );
  } finally {
    index.dispose();
    await reader.close();
  }
});

await test("compressed-only archive persists discovery and custom roots stay isolated", async () => {
  const base = await directory("compressed-archive");
  const archive = join(base, "archived_sessions");
  await mkdir(archive);
  const sessionsDir = join(base, "sessions");
  const path = join(archive, fileName() + ".zst");
  await writeFile(path, zstdCompressSync(Buffer.from(codex())));
  const dataDir = await directory("compressed-archive/data");
  const reader = new CodexSessionReader({ sessionsDir, dataDir });
  try {
    assert.equal((await reader.listSessions(projectId)).length, 1);
    assert.equal(
      normalizeSession(await reader.getSession(id, projectId)).messages.length,
      2,
    );
  } finally {
    await reader.close();
  }
  const scanner = new CodexSessionScanner({ sessionsDir, dataDir });
  assert.equal((await scanner.listProjects())[0].sessionCount, 1);
  const isolated = new CodexSessionScanner({
    sessionsDir: join(base, "custom"),
  });
  assert.equal((await isolated.listProjects()).length, 0);
  await writeFile(path, Buffer.from("corrupt zstd"));
  assert.equal(await readFirstLine(path), null);
});

await test("incremental active removal exposes an existing archived duplicate", async () => {
  const sessionsDir = await directory("incremental/sessions");
  const archive = await directory("incremental/archived_sessions");
  const active = join(sessionsDir, fileName());
  const archived = join(archive, fileName());
  await writeFile(active, codex());
  await writeFile(archived, codex());
  const scanner = new CodexSessionScanner({ sessionsDir });
  assert.equal((await scanner.listProjects())[0].sessionCount, 1);
  await rename(active, active + ".saved");
  scanner.invalidateCache(active);
  assert.equal(
    (await scanner.getSessionsForProject(cwd))[0].filePath,
    archived,
  );
});
await test("real HTTP project and indexed-session routes retain a locked native archive", {
  skip: process.platform !== "win32",
}, async () => {
  const { Hono } = await import("hono");
  const { serve } = await import("@hono/node-server");
  const { createProjectsRoutes } = await import("../src/routes/projects.js");
  const base = await directory("http");
  const sessionsDir = join(base, "sessions");
  const archive = join(base, "archived_sessions");
  await mkdir(archive);
  const path = join(archive, fileName());
  await writeFile(path, codex());
  const codexScanner = new CodexSessionScanner({ sessionsDir });
  const scanner = new ProjectScanner({
    projectsDir: join(base, "claude"),
    codexScanner,
    enableGemini: false,
    cacheTtlMs: 0,
  });
  const index = new SessionIndexService({
    dataDir: join(base, "data"),
    fullValidationIntervalMs: 0,
  });
  const reader = new CodexSessionReader({ sessionsDir, projectPath: cwd });
  const app = new Hono();
  app.route(
    "/api/projects",
    createProjectsRoutes({
      scanner,
      sessionIndexService: index,
      codexScanner,
      codexSessionsDir: sessionsDir,
      codexReaderFactory: () => reader,
      readerFactory: () => reader,
      sessionAutoArchiveDays: 0,
    }),
  );
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((resolve) =>
    server.listening ? resolve() : server.once("listening", resolve),
  );
  const origin = "http://127.0.0.1:" + server.address().port;
  async function get(path) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200);
    return response.json();
  }
  try {
    const projects = (await get("/api/projects")).projects;
    const project = projects.find((p) => p.hasCodexSessions);
    assert.ok(project);
    const url = "/api/projects/" + project.id + "/sessions";
    assert.equal((await get(url)).sessions[0].title, "Explain the login flow");
    await appendFile(path, "\n");
    const unlock = await lockFile(path);
    try {
      assert.equal(
        (await get(url)).sessions[0].title,
        "Explain the login flow",
      );
    } finally {
      await unlock();
    }
    await writeFile(path, codex(id, cwd, "HTTP recovered history"));
    assert.equal((await get(url)).sessions[0].title, "HTTP recovered history");
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    index.dispose();
    await scanner.dispose();
    await reader.close();
  }
});
await test("Claude retained catalog selects the usable replica", async () => {
  const { collectionCatalogAdapters } = await import(
    "../src/sessions/catalog-adapters/collection-catalog-adapters.js"
  );
  const projectsDir = await directory("retained/projects");
  const first = join(projectsDir, "host-a", "-fixture-project");
  const second = join(projectsDir, "host-b", "-fixture-project");
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  await writeFile(join(first, id + ".jsonl"), "{partial");
  await writeFile(
    join(first, archivedId + ".jsonl"),
    claude("Keep project discoverable"),
  );
  await writeFile(join(second, id + ".jsonl"), claude());
  const scanner = new ProjectScanner({
    projectsDir,
    enableCodex: false,
    enableGemini: false,
  });
  try {
    const signal = new AbortController().signal;
    const adapters = await collectionCatalogAdapters(
      {
        scanner,
        getCatalogFamilies: () => ["claude"],
        readerFactory: (project) =>
          new ClaudeSessionReader({
            sessionDir: project.sessionDir,
            additionalDirs: project.mergedSessionDirs,
          }),
      },
      [],
      signal,
    );
    const rows = [];
    for (const adapter of adapters) {
      const scan = await adapter.scan({
        catalogEpoch: "test",
        targetGeneration: 1,
        mode: { kind: "complete" },
        signal,
      });
      for await (const row of scan.rows) rows.push(row);
    }
    const target = rows.filter((row) => row.sessionId === id);
    assert.ok(target.length > 0);
    for (const row of target) {
      assert.equal(row.title, "Inspect the mobile layout");
      assert.equal(row.location.path, join(second, id + ".jsonl"));
    }
  } finally {
    await scanner.dispose();
  }
});

await test("Claude TTL refresh preserves history and retries after a lock", {
  skip: process.platform !== "win32",
}, async () => {
  const projectsDir = await directory("ttl/projects");
  const dir = join(projectsDir, "-fixture");
  await mkdir(dir);
  const path = join(dir, id + ".jsonl");
  await writeFile(path, claude());
  const scanner = new ProjectScanner({
    projectsDir,
    enableCodex: false,
    enableGemini: false,
    cacheTtlMs: 0,
  });
  try {
    assert.equal((await scanner.listProjects()).length, 1);
    const unlock = await lockFile(path);
    try {
      assert.equal((await scanner.listProjects()).length, 1);
    } finally {
      await unlock();
    }
    await rename(path, path + ".saved");
    assert.equal(
      (await scanner.listProjects()).filter(
        (project) => project.sessionCount > 0,
      ).length,
      0,
    );
  } finally {
    await scanner.dispose();
  }
});
await test("incremental dirty indexes retry locked history without another watcher event", {
  skip: process.platform !== "win32",
}, async () => {
  for (const provider of ["claude", "codex"]) {
    const base = await directory("dirty-" + provider);
    const dir = join(base, "sessions");
    await mkdir(dir);
    const path = join(dir, provider === "codex" ? fileName() : id + ".jsonl");
    await writeFile(path, provider === "codex" ? codex() : claude());
    const reader =
      provider === "codex"
        ? new CodexSessionReader({ sessionsDir: dir, projectPath: cwd })
        : new ClaudeSessionReader({ sessionDir: dir });
    const bus = new EventBus();
    const index = new SessionIndexService({
      dataDir: join(base, "data"),
      projectsDir: base,
      eventBus: bus,
      fullValidationIntervalMs: 60_000,
    });
    try {
      const before = await index.getSessionsWithCache(dir, projectId, reader);
      assert.equal(before.length, 1);
      await writeFile(
        path,
        provider === "codex"
          ? codex(id, cwd, "Recovered without another event")
          : claude("Recovered without another event"),
      );
      const unlock = await lockFile(path);
      try {
        bus.emit({
          type: "file-change",
          provider,
          path,
          relativePath: relative(base, path),
          changeType: "modify",
          timestamp,
          fileType: "session",
        });
        assert.equal(
          (await index.getSessionsWithCache(dir, projectId, reader))[0]?.title,
          before[0].title,
        );
      } finally {
        await unlock();
      }
      assert.equal(
        (await index.getSessionsWithCache(dir, projectId, reader))[0]?.title,
        "Recovered without another event",
      );
    } finally {
      index.dispose();
      await reader.close();
    }
  }
});
console.log("Fixtures retained at " + root);
