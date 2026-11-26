// From the repo root: node scripts/run-with-safe-home.js --temporary-home tsx
// --conditions=source scripts/perf-repro/project-card-counts.mjs [population ...]
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../../packages/server/src/app.ts";
import { ProjectMetadataService } from "../../packages/server/src/metadata/ProjectMetadataService.ts";
import { SessionMetadataService } from "../../packages/server/src/metadata/SessionMetadataService.ts";
import { NotificationService } from "../../packages/server/src/notifications/NotificationService.ts";
import { encodeProjectId } from "../../packages/server/src/projects/paths.ts";
import { SessionCatalogSqliteStore } from "../../packages/server/src/services/session-catalog-sqlite.ts";
import { DiscoverySqliteService } from "../../packages/server/src/storage/discovery-sqlite.ts";
import {
  readHostCapacity,
  summarizeHostWindow,
} from "../perf-suite/host-profile.mjs";
import { measuredHostSample } from "./active-session-metrics.mjs";
import { codexRollout, codexSession } from "./scenario-transcripts.mjs";

async function seedRollouts(population, projects, sessionsDir) {
  const start = Date.now() - 86400000;
  for (let i = 0; i < population; i++) {
    const at = start + i;
    const { id, relativePath } = codexRollout(i + 1, at);
    const session = codexSession({
      sessionId: id,
      projectPath: projects[i % projects.length],
      resultLines: 2,
      answerBytes: 30,
    });
    const file = join(sessionsDir, relativePath);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      [session.head(at), ...session.next(at + 1000).rows, ""].join("\n"),
    );
  }
}

async function measure(app, metadata, projects, population) {
  const read = async (path) => {
    const response = await app.app.request(path, {
      headers: { "X-Yep-Anywhere": "true" },
    });
    assert.equal(response.status, 200, path);
    return response.json();
  };
  const expected = new Map(
    projects.map((path, i) => [
      encodeProjectId(path),
      1 + Math.floor((population + projects.length - 1 - i) / projects.length),
    ]),
  );
  // An empty native catalog publishes the scanner's zero-session home card.
  const homeId = encodeProjectId(homedir());
  if (!population) expected.set(homeId, 0);
  const listPath = "/api/projects?summaryMode=retained";
  await app.scanner.refreshRetainedProjects();
  const deadline = Date.now() + 120000;
  let previousVersion;
  for (;;) {
    await metadata.flushPendingWrites();
    const { catalog } = await read("/api/inbox?summaryMode=retained");
    const result = await read(listPath);
    const ready =
      (population === 0 || (catalog.complete && result.catalog?.complete)) &&
      !catalog.refreshing &&
      !result.catalog?.refreshing &&
      result.projects.filter((p) => expected.get(p.id) === p.sessionCount)
        .length === expected.size;
    const version = JSON.stringify([
      catalog.catalogEpoch,
      catalog.catalogGeneration,
    ]);
    // Counts can already match while the retained query is adopting its first
    // native identities. Measure after two settled reads of one publication.
    if (ready && previousVersion === version) break;
    previousVersion = ready ? version : undefined;
    assert.ok(
      Date.now() < deadline,
      "catalog did not publish the generated rollouts",
    );
    await delay(100);
  }

  // Attribute only the route's own work. Background catalog and watcher tasks
  // may still run during the same wall-clock interval.
  const requests = new AsyncLocalStorage();
  const counts = {
    fullReads: 0,
    nativeRows: 0,
    metadataIds: 0,
    creationLists: 0,
  };
  const restores = [];
  function observe(target, method, count) {
    const original = target[method];
    target[method] = function (...args) {
      const result = original.apply(this, args);
      if (requests.getStore()) count(args, result);
      return result;
    };
    restores.push(() => {
      target[method] = original;
    });
  }
  observe(
    SessionCatalogSqliteStore.prototype,
    "readRowsWithHashes",
    (_, rows) => {
      counts.fullReads++;
      counts.nativeRows += rows.length;
    },
  );
  observe(metadata, "getMetadataBatch", ([ids]) => {
    counts.metadataIds += ids.length;
  });
  observe(metadata, "getMetadata", () => {
    counts.metadataIds++;
  });
  observe(metadata.creations, "listProjections", () => {
    counts.creationLists++;
  });
  try {
    const capacity = await readHostCapacity();
    const before = await measuredHostSample(capacity);
    const times = [];
    for (let i = 0; i < 30; i++) {
      const start = performance.now();
      await requests.run(true, async () => {
        const list = i % 3 === 0;
        const result = list
          ? await read(listPath)
          : await read(
              "/api/projects/" + encodeProjectId(projects[i % projects.length]),
            );
        const cards = list ? result.projects : [result.project];
        if (list) {
          assert.deepEqual(
            cards.map((card) => card.id).sort(),
            [...expected.keys()].sort(),
          );
        } else {
          assert.equal(
            cards[0].id,
            encodeProjectId(projects[i % projects.length]),
          );
        }
        for (const card of cards) {
          assert.equal(card.sessionCount, expected.get(card.id));
          assert.deepEqual(
            card.sessionCountsByProvider,
            card.id === homeId
              ? { claude: 0 }
              : { codex: expected.get(card.id) },
          );
        }
      });
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        capacityKey: capacity.capacityKey,
        host: summarizeHostWindow(
          capacity,
          before,
          await measuredHostSample(capacity),
        ),
        population,
        projects: projects.length,
        requests: times.length,
        ...counts,
        medianMs: times[15],
        p95Ms: times[28],
      }),
    );
    assert.deepEqual(counts, {
      fullReads: 0,
      nativeRows: 0,
      metadataIds: 0,
      creationLists: 0,
    });
  } finally {
    for (const restore of restores) restore();
    requests.disable();
  }
}

async function run(population) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "ya-project-cards-")),
  );
  const dataDir = join(root, "profile"),
    codexSessionsDir = join(root, "codex", "sessions");
  const storage = new DiscoverySqliteService({
    dataDir,
    probeNetworkFilesystem: () => undefined,
  });
  let app;
  try {
    const projects = Array.from({ length: 10 }, (_, i) =>
      join(root, "projects", String(i)),
    );
    for (const project of projects) await mkdir(project, { recursive: true });
    await seedRollouts(population, projects, codexSessionsDir);
    const options = { dataDir, database: storage.getDatabase() };
    const metadata = new SessionMetadataService(options);
    const names = new ProjectMetadataService({ dataDir });
    const seen = new NotificationService(options);
    await metadata.initialize();
    await names.initialize();
    await seen.initialize();
    for (const [i, path] of projects.entries()) {
      metadata.creations.admit({
        requestId: "project_card_fixture_" + i,
        context: {
          owner: { kind: "superuser" },
          source: { kind: "request", provenance: { surface: "desktop" } },
        },
        request: {
          provider: "codex",
          projectId: encodeProjectId(path),
          projectPath: path,
          message: "saved",
          settings: {
            permissionMode: "default",
            requestedModel: null,
            thinking: null,
            effort: null,
            serviceTier: null,
          },
        },
      });
    }
    app = createApp({
      dataDir,
      projectsDir: join(root, "claude"),
      codexSessionsDir,
      geminiSessionsDir: join(root, "gemini"),
      piSessionsDir: join(root, "pi"),
      grokSessionsDir: join(root, "grok"),
      provider: null,
      discoverySqlite: storage,
      sessionMetadataService: metadata,
      projectMetadataService: names,
      notificationService: seen,
      getCatalogFamilies: () => ["codex"],
      getLatestVersion: async () => null,
    });
    await measure(app, metadata, projects, population);
    await metadata.flushPendingWrites();
    await seen.flush();
  } finally {
    await app?.disposeSessionReaders();
    storage.close();
    await rm(root, { recursive: true, force: true });
  }
}
const requested = process.argv.slice(2);
for (const size of requested.length ? requested.map(Number) : [50, 500, 2000]) {
  assert.ok(
    Number.isSafeInteger(size) && size >= 0,
    "population must be a nonnegative integer",
  );
  await run(size);
}
