import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectScanner } from "../../src/projects/scanner.js";
import { claudeCwdProjectDirectory } from "../../src/projects/claude-project-directory.js";
import { encodeProjectId } from "../../src/projects/paths.js";
import { RetainedSessionCollections } from "../../src/services/RetainedSessionCollections.js";
import {
  closeTestDiscoveryDatabases,
  openTestDiscoveryDatabase,
} from "../utils/session-metadata-database.js";
import { AntigravitySessionCatalogAdapter } from "../../src/sessions/catalog-adapters/antigravity-catalog-adapter.js";
import { collectionCatalogAdapters } from "../../src/sessions/catalog-adapters/collection-catalog-adapters.js";
import { nativeCatalogAdapters } from "../../src/sessions/catalog-adapters/native-catalog-registry.js";
import { PiSessionCatalogAdapter } from "../../src/sessions/catalog-adapters/pi-catalog-adapter.js";
import { OpenCodeSessionCatalogAdapter } from "../../src/sessions/catalog-adapters/opencode-catalog-adapter.js";
import { ClaudeSessionReader } from "../../src/sessions/reader.js";
import { EventBus } from "../../src/watcher/EventBus.js";

let root: string;
let scanner: ProjectScanner;
let collections: RetainedSessionCollections;
let release = () => {};
const id = "11111111-2222-3333-4444-555555555555";
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "ya-native-projects-")));
});
afterEach(async () => {
  release();
  await collections?.dispose();
  await scanner?.dispose();
  vi.restoreAllMocks();
  closeTestDiscoveryDatabases();
  await rm(root, { recursive: true, force: true });
});

async function seed() {
  const agy = join(root, "agy");
  const pi = join(root, "pi");
  const mixed = join(root, "mixed");
  const only = join(root, "only-agy");
  await Promise.all(
    [agy, pi, mixed, only].map((dir) => mkdir(dir, { recursive: true })),
  );
  for (const [sessionId, cwd] of [
    [id, mixed],
    [id.replace(/^1/, "2"), only],
  ]) {
    await writeFile(join(agy, `${sessionId}.meta`), JSON.stringify({ cwd }));
    await writeFile(join(agy, `${sessionId}.db`), "opaque native history");
  }
  await mkdir(join(pi, "flattened"));
  await writeFile(
    join(pi, "flattened", `2026-11-03T00-00-00-000Z_${id}.jsonl`),
    `${JSON.stringify({ type: "session", id, cwd: mixed })}\n`,
  );
  return { agy, pi, mixed, only };
}

function setup(agy: string, pi: string) {
  const eventBus = new EventBus();
  const getCatalogFamilies = () => ["claude", "antigravity", "pi"] as const;
  const nativeOptions = { antigravitySessionsDir: agy, piSessionsDir: pi };
  scanner = new ProjectScanner({
    projectsDir: join(root, "claude"),
    enableCodex: false,
    enableGemini: false,
    eventBus,
    catalogProjects: {
      read: (refresh) => collections.readProjects(refresh),
      peek: () => collections.peekProjects(),
    },
  });
  collections = new RetainedSessionCollections({
    dataDir: join(root, "data"),
    database: openTestDiscoveryDatabase(join(root, "data")),
    eventBus,
    projectStores: () =>
      nativeCatalogAdapters(getCatalogFamilies(), nativeOptions),
    adapters: (rows, signal, paths, sources) =>
      collectionCatalogAdapters(
        {
          scanner,
          getCatalogFamilies,
          ...nativeOptions,
          readerFactory: (project) =>
            new ClaudeSessionReader({ sessionDir: project.sessionDir }),
        },
        rows,
        signal,
        paths,
        sources,
      ),
  });
  return eventBus;
}

it("joins one native inventory across project and collection consumers without an await cycle", async () => {
  const { agy, pi, mixed, only } = await seed();
  const agyScan = vi.spyOn(AntigravitySessionCatalogAdapter.prototype, "scan");
  const piScan = vi.spyOn(PiSessionCatalogAdapter.prototype, "scan");
  const unused = vi.spyOn(OpenCodeSessionCatalogAdapter.prototype, "scan");
  const bus = setup(agy, pi);
  const baseScan = vi.spyOn(scanner, "listFileCatalogProjects");
  const projects = await scanner.listProjects();
  expect(projects).toHaveLength(2);
  expect(projects.find((project) => project.path === mixed)).toMatchObject({
    sessionCount: 2,
    sessionCountsByProvider: { antigravity: 1, pi: 1 },
  });
  expect(await scanner.getProject(encodeProjectId(only))).toMatchObject({
    path: only,
    provider: "antigravity",
    sessionCount: 1,
  });
  expect((await scanner.readRetainedProjects()).complete).toBe(true);
  expect((await collections.read()).rows).toHaveLength(3);
  await scanner.listProjects();
  expect(agyScan).toHaveBeenCalledTimes(1);
  expect(piScan).toHaveBeenCalledTimes(1);
  expect(unused).not.toHaveBeenCalled();
  expect(baseScan).toHaveBeenCalledTimes(1);
  const wal = join(agy, `${id}.db-wal`);
  await writeFile(wal, "new native activity");
  bus.emit({
    type: "file-change",
    provider: "antigravity",
    path: wal,
    relativePath: `${id}.db-wal`,
    changeType: "create",
    fileType: "session",
    timestamp: new Date().toISOString(),
  });
  await collections.refresh();
  expect(agyScan).toHaveBeenCalledTimes(2);
  expect(piScan).toHaveBeenCalledTimes(1);
  expect(baseScan).toHaveBeenCalledTimes(1);
  expect(scanner.cachedProjects()).toHaveLength(2);
});

it("cold retained reads return incomplete promptly while native discovery is blocked", async () => {
  const { agy, pi } = await seed();
  setup(agy, pi);
  const original = AntigravitySessionCatalogAdapter.prototype.scan;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(
    AntigravitySessionCatalogAdapter.prototype,
    "scan",
  ).mockImplementation(async function (context) {
    await blocked;
    return original.call(this, context);
  });
  const work = scanner.refreshRetainedProjects();
  const retained = await scanner.readRetainedProjects();
  expect(retained.complete).toBe(false);
  expect(retained.refreshing).toBe(true);
  release();
  await work;
  expect((await scanner.readRetainedProjects()).projects).toHaveLength(2);
  expect((await scanner.readRetainedProjects()).complete).toBe(true);
});

it("retains empty native-store coverage through a targeted Claude publication", async () => {
  const cwd = join(root, "claude-only");
  const directory = join(root, "claude", claudeCwdProjectDirectory(cwd));
  await mkdir(cwd);
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${id}.jsonl`);
  const user = {
    type: "user",
    uuid: "first",
    sessionId: id,
    cwd,
    timestamp: "2026-11-03T00:00:00.000Z",
    message: { role: "user", content: "first turn" },
  };
  await writeFile(file, `${JSON.stringify(user)}\n`);
  const agyScan = vi.spyOn(AntigravitySessionCatalogAdapter.prototype, "scan");
  const bus = setup(join(root, "missing-agy"), join(root, "missing-pi"));
  await scanner.listProjects();
  expect(collections.peekProjects().complete).toBe(true);
  await writeFile(
    file,
    `${JSON.stringify(user)}\n${JSON.stringify({ ...user, uuid: "second", timestamp: "2026-11-03T01:00:00.000Z" })}\n`,
  );
  bus.emit({
    type: "file-change",
    provider: "claude",
    path: file,
    relativePath: `${claudeCwdProjectDirectory(cwd)}/${id}.jsonl`,
    changeType: "modify",
    fileType: "session",
    timestamp: new Date().toISOString(),
  });
  await collections.refresh();
  expect((await collections.readProjects()).complete).toBe(true);
  expect(agyScan).toHaveBeenCalledTimes(1);
});
