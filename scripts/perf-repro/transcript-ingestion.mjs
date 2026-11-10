// Isolated real-reader + Hono detail diagnostic. No provider process/browser.
// --server-dist <external dist> --work <scratch> --label <unique>
// [--provider codex|claude --compactions 20 --turns 42 --samples 8]
// Run through run-with-safe-home.js --temporary-home, profiler off. Full long
// Claude normalization remains an explicit gap; this probe never certifies it.
import assert from "node:assert/strict";
import { mkdir, rm, writeFile, readFile, stat } from "node:fs/promises";
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { createHash } from "node:crypto";
import { codexSession, claudeSession } from "./scenario-transcripts.mjs";
import {
  readHostCapacity,
  readHostSample,
  summarizeHostWindow,
} from "../perf-suite/host-profile.mjs";
const args = Object.fromEntries(
  Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [
    process.argv[2 + i * 2].replace(/^--/, ""),
    process.argv[3 + i * 2],
  ]),
);
assert(
  args["server-dist"] && args.work && args.label,
  "Pass external --server-dist, --work, --label",
);
const out = resolve(args.work, args.label),
  profile = join(out, "profile"),
  source = join(out, "native"),
  projectPath = join(out, "project");
await mkdir(out, { recursive: false });
await Promise.all([profile, source, projectPath].map((p) => mkdir(p)));
const load = (file) =>
  import(pathToFileURL(resolve(args["server-dist"], file)).href);
const provider = args.provider ?? "codex",
  count = Number(args.compactions ?? 20),
  turns = Number(args.turns ?? 42),
  samples = Number(args.samples ?? 8);
const capacity = await readHostCapacity(),
  hostStart = await readHostSample(capacity);
const rawHost = () => ({
  at: new Date().toISOString(),
  cpus: os.cpus().map((c) => c.times),
  swap:
    process.platform === "darwin"
      ? execFileSync("/usr/sbin/sysctl", ["-n", "vm.swapusage"])
          .toString()
          .trim()
      : null,
});
const nativeStart = rawHost();
const id = "12345678-1234-4000-8000-123456789012";
const file = join(
  source,
  provider === "codex"
    ? `rollout-2026-11-10T00-00-00-${id}.jsonl`
    : `${id}.jsonl`,
);
let at = Date.now() - 24 * 3600_000;
const generator = (provider === "codex" ? codexSession : claudeSession)({
  sessionId: id,
  projectPath,
});
writeFileSync(file, provider === "codex" ? generator.head(at++) + "\n" : "");
for (let i = 0; i < count; i++) {
  for (let n = 0; n < turns * 4; n++)
    appendFileSync(file, generator.next(at++).rows.join("\n") + "\n");
  appendFileSync(file, generator.compact(at++).join("\n") + "\n");
}
for (let n = 0; n < 12; n++)
  appendFileSync(file, generator.next(at++).rows.join("\n") + "\n");
const { openDiscoveryDatabase } = await load("storage/discovery-sqlite.js");
const { SessionMetadataService } = await load(
  "metadata/SessionMetadataService.js",
);
const { encodeProjectId } = await load("projects/paths.js");
const { createSessionsRoutes } = await load("routes/sessions.js");
const { SessionReader } = await load("sessions/reader.js");
const { CodexSessionReader } = await load("sessions/codex-reader.js");
const projectId = encodeProjectId(projectPath);
const project = {
  id: projectId,
  path: projectPath,
  name: "Mixed provider project",
  provider: "claude",
  sessionDir: source,
  sessionCount: 1,
  activeOwnedCount: 0,
  activeExternalCount: 0,
  lastActivity: null,
};
const db = openDiscoveryDatabase({
  dataDir: profile,
  probeNetworkFilesystem: () => undefined,
});
const metadata = new SessionMetadataService({ dataDir: profile, database: db });
await metadata.initialize();
const reader =
  provider === "codex"
    ? new CodexSessionReader({ sessionsDir: source, projectPath })
    : new SessionReader({ sessionDir: source });
let native, identity;
try {
  native = await reader.getNativeSessionRef(id);
  assert(native, "Native source must resolve");
  identity = metadata.identities.adoptDiscovered({
    native,
    provider,
    projectId,
    createdAt: new Date(at).toISOString(),
  });
  const summary = await reader.getSessionSummary(id, projectId);
  assert(summary);
  const routes = createSessionsRoutes({
    readerFactory: () => reader,
    scanner: { getOrCreateProject: async () => project },
    supervisor: {
      getProcessForSession: () => undefined,
      wasEverOwned: () => false,
    },
    sessionMetadataService: metadata,
    sessionIndexService: {
      getCachedSessionSummary: async () => summary,
      getSessionSummaryWithCache: async () => summary,
    },
  });
  const request = async (cursor) => {
    const began = performance.now();
    const response = await routes.request(
      `/projects/${projectId}/sessions/${identity.sessionId}?${cursor ? "afterMessageId=" + encodeURIComponent(cursor) : "tailCompactions=2"}`,
    );
    if (response.status !== 200) throw new Error(await response.text());
    const body = await response.json();
    return { ms: performance.now() - began, body };
  };
  const first = await request();
  let cursor =
    first.body.messages.at(-1)?.uuid ?? first.body.messages.at(-1)?.id;
  assert(cursor);
  const rows = [];
  for (let i = 0; i < samples; i++) {
    const write = generator.next(at++);
    appendFileSync(file, write.rows.join("\n") + "\n");
    const result = await request(cursor);
    rows.push({ ms: result.ms, returnedMessages: result.body.messages.length });
    const last = result.body.messages.at(-1);
    if (last) cursor = last.uuid ?? last.id;
  }
  const nativeEnd = rawHost(),
    hostEnd = await readHostSample(capacity);
  const buildFiles = {};
  for (const name of [
    "routes/session-detail-routes.js",
    "sessions/codex-reader.js",
    "sessions/bound-session-reader.js",
    "sessions/codex-rollout-window.js",
    "sessions/claude-transcript-cache.js",
    "sessions/transcript-ingestion.js",
    "sessions/claude-summary-projection.js",
    "sessions/codex-entry-ingestion.js",
  ]) {
    try {
      buildFiles[name] = createHash("sha256")
        .update(await readFile(resolve(args["server-dist"], name)))
        .digest("hex");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const result = {
    scenario: {
      provider,
      compactions: count,
      turns,
      samples,
      projectDefault: "claude",
      fileBytes: (await stat(file)).size,
    },
    buildFiles,
    runtime: process.versions,
    revision: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(),
    capacity,
    nativeStart,
    nativeEnd,
    hostWindow: summarizeHostWindow(capacity, hostStart, hostEnd),
    firstMs: first.ms,
    updates: rows,
  };
  await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ firstMs: result.firstMs, updates: rows }));
} finally {
  await reader.close?.();
  await metadata.flushPendingWrites();
  db.close();
  await Promise.all(
    [profile, source, projectPath].map((p) =>
      rm(p, { recursive: true, force: true }),
    ),
  );
}
