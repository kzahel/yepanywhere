/** Diagnostic metadata/SQL probe; never replays the parent body for children. */
import assert from "node:assert/strict";
import nodeFs from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeSessionRef, parseNativeSessionId } from "@yep-anywhere/shared";
import { iterateJsonlLines } from "../src/utils/jsonl.js";
import { CodexSessionReader } from "../src/sessions/codex-reader.js";
import { ProviderChildRelationshipService } from "../src/sessions/ProviderChildRelationshipService.js";
import { DiscoverySqliteService } from "../src/storage/discovery-sqlite.js";

// Shared with the performance suite; dynamic URL also works from a Windows checkout.
const { readHostCapacity, readHostSample, summarizeHostWindow } = await import(
  new URL("../../../scripts/perf-suite/host-profile.mjs", import.meta.url).href
);
const capacity = await readHostCapacity();
const hostBefore = await readHostSample(capacity);
const root = await realpath(
  await mkdtemp(join(tmpdir(), "ya-codex-child-metadata-")),
);
const scope = join(root, "sessions"),
  project = join(root, "project");
let readers: CodexSessionReader[] = [];
let profile: DiscoverySqliteService | undefined;
let service: ProviderChildRelationshipService | undefined;
const originalStream = nodeFs.createReadStream;
let bodyStreams = 0;
try {
  await mkdir(scope);
  await mkdir(project);
  const parentId = "owned-parent",
    count = 205,
    callers = 20;
  const header = (id: string, parent?: string) =>
    JSON.stringify({
      type: "session_meta",
      payload: {
        id,
        cwd: project,
        timestamp: "2026-11-05T00:00:00Z",
        ...(parent
          ? {
              source: {
                subagent: { thread_spawn: { parent_thread_id: parent } },
              },
            }
          : {}),
      },
    }) + "\n";
  const parentPath = join(scope, `rollout-${parentId}.jsonl`);
  await writeFile(
    parentPath,
    header(parentId) + "x".repeat(8 * 1024 * 1024) + "\n",
  );
  for (let i = 0; i < count; i++)
    await writeFile(
      join(scope, `rollout-child-${i}.jsonl`),
      header(`child-${i}`, parentId),
    );
  readers = Array.from(
    { length: callers },
    () => new CodexSessionReader({ sessionsDir: scope, projectPath: project }),
  );
  const profilePath = join(root, "profile");
  profile = new DiscoverySqliteService({
    dataDir: profilePath,
    probeNetworkFilesystem: () => undefined,
  });
  let published!: () => void;
  let failed!: (error: Error) => void;
  const commit = new Promise<void>((resolve, reject) => {
    published = resolve;
    failed = reject;
  });
  const errors: unknown[] = [];
  service = new ProviderChildRelationshipService(
    profile.getDatabase(),
    "benchmark",
    () => published(),
    (e) => {
      errors.push(e);
      published();
    },
  );
  nodeFs.createReadStream = (...args: Parameters<typeof originalStream>) => {
    bodyStreams++;
    return originalStream(...args);
  };
  syncBuiltinESMExports();
  const probePath = join(root, "counter-probe.jsonl");
  await writeFile(probePath, "{}\n");
  for await (const _line of iterateJsonlLines(probePath)) break;
  const bodyCounterSupported = bodyStreams === 1;
  if (!process.versions.bun)
    assert(bodyCounterSupported, "Stream counter negative control failed");
  bodyStreams = 0;
  const coldAccepted = readers[0]!.listAcceptedProviderChildSessions(parentId);
  assert.equal(coldAccepted, undefined);
  let started = performance.now();
  const children = await Promise.all(
    readers.map((r) => r.listProviderChildSessions(parentId)),
  );
  const concurrentMetadataMs = performance.now() - started;
  assert(children.every((c) => c.length === count));
  assert(
    readers.every(
      (r) =>
        r.getAgentMappingCacheStats().sessions === 0 &&
        r.getEntryCacheStats().sessions === 0,
    ),
  );
  if (bodyCounterSupported) assert.equal(bodyStreams, 0);
  const parent = nativeSessionRef(
    "codex",
    scope,
    parseNativeSessionId(parentId),
  );
  started = performance.now();
  service.demand(
    parent,
    { sessionId: "public-parent" },
    readers[0]!.getProviderChildSource(parent)!,
  );
  const deadline = setTimeout(
    () =>
      failed(
        new Error("Metadata publication did not settle within 30 seconds"),
      ),
    30_000,
  );
  try {
    await commit;
  } finally {
    clearTimeout(deadline);
  }
  assert.deepEqual(errors, []);
  const publishMs = performance.now() - started;
  const reads: number[] = [];
  for (let i = 0; i < 25; i++) {
    started = performance.now();
    assert.equal(service.accepted(parent, "public-parent")?.length, count);
    reads.push(performance.now() - started);
  }
  const transcriptCaches = readers.reduce(
    (total, r) =>
      total +
      r.getEntryCacheStats().sessions +
      r.getAgentMappingCacheStats().sessions,
    0,
  );
  assert.equal(transcriptCaches, 0);
  await service.close();
  await Promise.all(readers.map((r) => r.close()));
  profile.close();
  await rm(scope, { recursive: true });
  profile = new DiscoverySqliteService({
    dataDir: profilePath,
    probeNetworkFilesystem: () => undefined,
  });
  service = new ProviderChildRelationshipService(
    profile.getDatabase(),
    "benchmark",
    () => {},
  );
  started = performance.now();
  assert.equal(service.accepted(parent, "public-parent")?.length, count);
  const reopenMs = performance.now() - started;
  if (bodyCounterSupported) assert.equal(bodyStreams, 0);
  console.log(
    JSON.stringify({
      runtime: process.versions.bun
        ? `Bun ${process.versions.bun}`
        : process.version,
      parentPaddingMiB: 8,
      children: count,
      concurrentCallers: callers,
      concurrentMetadataMs,
      publishMs,
      sqlReadMedianMs: reads.toSorted((a, b) => a - b)[12],
      reopenWithoutNativeMs: reopenMs,
      parentBodyStreams: bodyCounterSupported ? bodyStreams : null,
      bodyCounterSupported,
      transcriptCaches,
      host: summarizeHostWindow(
        capacity,
        hostBefore,
        await readHostSample(capacity),
      ),
    }),
  );
} finally {
  nodeFs.createReadStream = originalStream;
  syncBuiltinESMExports();
  await service?.close();
  await Promise.all(readers.map((r) => r.close()));
  profile?.close();
  await rm(root, { recursive: true, force: true });
}
