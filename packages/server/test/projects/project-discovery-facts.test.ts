import { ProjectMetadataService } from "../../src/metadata/ProjectMetadataService.js";
import {
  appendFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectScanner } from "../../src/projects/scanner.js";
import { CodexSessionScanner } from "../../src/projects/codex-scanner.js";
import { claudeCwdProjectDirectory } from "../../src/projects/claude-project-directory.js";
import { encodeProjectId } from "../../src/projects/paths.js";
import { ClaudeSessionReader } from "../../src/sessions/reader.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import { createCollectionCatalogAdapters } from "../../src/sessions/catalog-adapters/collection-catalog-adapters.js";
import { RetainedSessionCollections } from "../../src/services/RetainedSessionCollections.js";
import { EventBus, type FileChangeEvent } from "../../src/watcher/EventBus.js";
import {
  closeTestDiscoveryDatabases,
  openTestDiscoveryDatabase,
} from "../utils/session-metadata-database.js";

const id = "11111111-2222-4333-8444-555555555555";
let root: string;
let scanner: ProjectScanner;
let collections: RetainedSessionCollections;
let unblock = () => {};
afterEach(async () => {
  unblock();
  await collections?.dispose();
  await scanner?.dispose();
  vi.restoreAllMocks();
  closeTestDiscoveryDatabases();
  if (root) await rm(root, { recursive: true, force: true });
});
async function setup() {
  root = await realpath(await mkdtemp(join(tmpdir(), "project-facts-")));
  const projectsDir = join(root, "claude"),
    codexRoot = join(root, "codex"),
    path = join(root, "project");
  const claudeDir = join(projectsDir, claudeCwdProjectDirectory(path));
  await Promise.all([
    mkdir(claudeDir, { recursive: true }),
    mkdir(codexRoot),
    mkdir(path),
  ]);
  const claudeFile = join(claudeDir, `${id}.jsonl`);
  await writeFile(
    claudeFile,
    JSON.stringify({
      type: "user",
      uuid: id,
      cwd: path,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "hello" },
    }) + "\n",
  );
  const codexFile = join(codexRoot, `rollout-2026-01-01T00-00-00-${id}.jsonl`);
  await writeFile(
    codexFile,
    JSON.stringify({
      type: "session_meta",
      timestamp: "2026-01-01T00:00:00.000Z",
      payload: { id, cwd: path, timestamp: "2026-01-01T00:00:00.000Z" },
    }) + "\n",
  );
  const bus = new EventBus(),
    database = openTestDiscoveryDatabase(join(root, "data"));
  const codexScanner = new CodexSessionScanner({ sessionsDir: codexRoot });
  let epoch: number | null = 1;
  scanner = new ProjectScanner({
    projectsDir,
    codexSessionsDir: codexRoot,
    codexScanner,
    enableGemini: false,
    eventBus: bus,
    projectFactsDatabase: database,
    getProviderObservationEpoch: () => epoch,
    cacheTtlMs: 0,
    catalogProjects: {
      invalidate: () => collections.invalidate(),
      read: (refresh) => collections.readProjects(refresh),
      peek: () => collections.peekProjects(),
      peekProject: (projectId) => collections.peekProject(projectId),
    },
  });
  collections = new RetainedSessionCollections({
    dataDir: join(root, "data"),
    database,
    eventBus: bus,
    adapters: createCollectionCatalogAdapters({
      scanner,
      codexScanner,
      codexSessionsDir: codexRoot,
      readerFactory: (project) => {
        const reader = new ClaudeSessionReader({
          sessionDir: project.sessionDir,
        });
        return reader;
      },
      codexReaderFactory: (projectPath) => {
        const reader = new CodexSessionReader({
          sessionsDir: codexRoot,
          projectPath,
        });
        return reader;
      },
      getCatalogFamilies: () => ["claude", "codex"],
    }),
  });
  await scanner.refreshRetainedProjects();
  await collections.refresh();
  const rebuild = async () => {
    const full = new ProjectScanner({
      projectsDir,
      codexSessionsDir: codexRoot,
      enableGemini: false,
      cacheTtlMs: 0,
    });
    try {
      return JSON.parse(
        JSON.stringify(await full.getProject(encodeProjectId(path))),
      );
    } finally {
      await full.dispose();
    }
  };
  const event = (
    provider: "claude" | "codex",
    file: string,
    changeType: FileChangeEvent["changeType"] = "modify",
  ) =>
    bus.emit({
      type: "file-change",
      provider,
      path: file,
      relativePath: file,
      changeType,
      fileType: "session",
      timestamp: new Date().toISOString(),
    });
  return {
    path,
    claudeFile,
    claudeDir,
    codexFile,
    codexRoot,
    projectsDir,
    bus,
    database,
    codexScanner,
    rebuild,
    event,
    observationEpoch: (value: number | null) => {
      epoch = value;
    },
  };
}
it("shares accepted project facts across point/list reads; both providers' appends match full discovery without regrouping", async () => {
  const world = await setup();
  const group = vi.spyOn(world.codexScanner, "listProjects");
  const dirs = vi.spyOn(
    scanner as unknown as {
      getProjectDirInfo: (path: string) => Promise<unknown>;
    },
    "getProjectDirInfo",
  );
  const inventory = vi.spyOn(scanner, "listFileCatalogProjects");
  for (const [provider, file] of [
    ["claude", world.claudeFile],
    ["codex", world.codexFile],
  ] as const) {
    await appendFile(
      file,
      JSON.stringify({
        type: "event_msg",
        timestamp: new Date().toISOString(),
        payload: { type: "user_message", message: "append" },
      }) + "\n",
    );
    const time = new Date(Date.now() + 2000);
    await utimes(file, time, time);
    world.event(provider, file);
    const actual = JSON.parse(
      JSON.stringify(await scanner.getProject(encodeProjectId(world.path))),
    );
    expect(actual).toEqual(await world.rebuild());
    await collections.refresh();
    expect(
      (await scanner.readRetainedProjects()).projects.find(
        (p) => p.id === actual.id,
      )?.lastActivity,
    ).toBe(actual.lastActivity);
  }
  expect(group).not.toHaveBeenCalled();
  expect(dirs).not.toHaveBeenCalled();
  expect(inventory).not.toHaveBeenCalled();
});
it("structural changes re-enter discovery and preserve exact native counts/provider precedence", async () => {
  const world = await setup();
  await rm(world.claudeFile);
  world.event("claude", world.claudeFile, "delete");
  await scanner.refreshRetainedProjects();
  await collections.refresh();
  expect(
    JSON.parse(
      JSON.stringify(await scanner.getProject(encodeProjectId(world.path))),
    ),
  ).toEqual(await world.rebuild());
  expect(
    (await scanner.getProject(encodeProjectId(world.path)))?.provider,
  ).toBe("codex");
  await writeFile(
    world.claudeFile,
    JSON.stringify({
      type: "user",
      uuid: id,
      cwd: world.path,
      message: { role: "user", content: "new" },
    }) + "\n",
  );
  world.event("claude", world.claudeFile, "create");
  await scanner.refreshRetainedProjects();
  await collections.refresh();
  expect(
    JSON.parse(
      JSON.stringify(await scanner.getProject(encodeProjectId(world.path))),
    ),
  ).toEqual(await world.rebuild());
  expect(
    (await scanner.getProject(encodeProjectId(world.path)))
      ?.sessionCountsByProvider,
  ).toEqual({ claude: 1, codex: 1 });
});

it("disposal drains an observed batch and prevents a late SQL publication", async () => {
  const world = await setup();
  const facts = (
    scanner as unknown as {
      projectFacts: { append: (event: FileChangeEvent) => Promise<unknown> };
    }
  ).projectFacts;
  const original = facts.append.bind(facts);
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  vi.spyOn(facts, "append").mockImplementation(async (event) => {
    const observation = await original(event);
    entered();
    await gate;
    return observation;
  });
  const before = world.database.prepare(
    "SELECT payload FROM project_discovery_facts",
  );
  const payload = before.get<{ payload: string }>()!.payload;
  before.finalize();
  const changes: string[] = [];
  world.bus.subscribe((event) => {
    if (event.type === "projects-changed") changes.push(...event.projectIds);
  });
  await appendFile(world.codexFile, "\n");
  const time = new Date(Date.now() + 2000);
  await utimes(world.codexFile, time, time);
  world.event("codex", world.codexFile);
  await started;
  let settled = false;
  const disposal = scanner.dispose().then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  unblock();
  await disposal;
  expect(changes).toEqual([]);
  const after = world.database.prepare(
    "SELECT payload FROM project_discovery_facts",
  );
  expect(after.get<{ payload: string }>()!.payload).toBe(payload);
  after.finalize();
});
it("SQL restores retained identity but cannot certify an unchanged complete read before native startup reconciliation", async () => {
  const world = await setup();
  await collections.dispose();
  await scanner.dispose();
  const secondId = "21111111-2222-4333-8444-555555555555";
  await writeFile(
    join(world.claudeDir, `${secondId}.jsonl`),
    JSON.stringify({
      type: "user",
      uuid: secondId,
      cwd: world.path,
      message: { role: "user", content: "new while stopped" },
    }) + "\n",
  );
  scanner = new ProjectScanner({
    projectsDir: world.projectsDir,
    codexSessionsDir: world.codexRoot,
    enableGemini: false,
    projectFactsDatabase: world.database,
  });
  const retained = await scanner.readRetainedProjects();
  expect(
    retained.projects.find((project) => project.path === world.path)
      ?.sessionCount,
  ).toBe(2);
  const actual = await scanner.getProject(encodeProjectId(world.path));
  expect(actual?.sessionCountsByProvider).toEqual({ claude: 2, codex: 1 });
  expect(JSON.parse(JSON.stringify(actual))).toEqual(await world.rebuild());
});

it("point reads apply current ownership and hidden metadata without waiting for native rediscovery", async () => {
  const world = await setup();
  const metadata = new ProjectMetadataService({
    dataDir: join(root, "metadata"),
  });
  await metadata.initialize();
  await metadata.addProject(encodeProjectId(world.path), world.path, "owner-a");
  scanner.setProjectMetadataService(metadata);
  await scanner.refreshRetainedProjects();
  expect(
    (await scanner.getProject(encodeProjectId(world.path)))?.ownerUsername,
  ).toBe("owner-a");
  await metadata.addProject(encodeProjectId(world.path), world.path, "owner-b");
  expect(
    (await scanner.getProject(encodeProjectId(world.path)))?.ownerUsername,
  ).toBe("owner-b");
  await metadata.hideProject(encodeProjectId(world.path), world.path);
  expect(await scanner.getProject(encodeProjectId(world.path))).toBeNull();
  expect(
    (await scanner.readRetainedProjects()).projects.some(
      (project) => project.path === world.path,
    ),
  ).toBe(false);
});

it("retained consumers do not schedule a delayed full discovery after an accepted append", async () => {
  const world = await setup();
  const group = vi.spyOn(world.codexScanner, "listProjects");
  const discovery = vi.spyOn(scanner, "listFileCatalogProjects");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await appendFile(world.codexFile, "\n");
    world.event("codex", world.codexFile);
    await scanner.getProject(encodeProjectId(world.path));
    await collections.refresh();
    await scanner.readRetainedProjects();
    await vi.advanceTimersByTimeAsync(350);
    expect(group).not.toHaveBeenCalled();
    expect(discovery).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("malformed derived retention rebuilds from native files instead of poisoning initialization", async () => {
  const world = await setup();
  await collections.dispose();
  await scanner.dispose();
  world.database.exec("UPDATE project_discovery_facts SET payload='not JSON'");
  scanner = new ProjectScanner({
    projectsDir: world.projectsDir,
    codexSessionsDir: world.codexRoot,
    enableGemini: false,
    projectFactsDatabase: world.database,
  });
  expect((await scanner.readRetainedProjects()).complete).toBe(false);
  expect(
    JSON.parse(
      JSON.stringify(await scanner.getProject(encodeProjectId(world.path))),
    ),
  ).toEqual(await world.rebuild());
});

it("watcher gaps revoke accepted inventory and a new epoch cannot certify the previous enumeration", async () => {
  const world = await setup();
  const group = vi.spyOn(world.codexScanner, "listProjects");
  world.observationEpoch(null);
  const secondId = "31111111-2222-4333-8444-555555555555";
  await writeFile(
    join(world.claudeDir, `${secondId}.jsonl`),
    JSON.stringify({
      type: "user",
      uuid: secondId,
      cwd: world.path,
      message: { role: "user", content: "created during observer gap" },
    }) + "\n",
  );
  expect(
    (await scanner.getProject(encodeProjectId(world.path)))
      ?.sessionCountsByProvider,
  ).toEqual({ claude: 2, codex: 1 });
  expect(group).toHaveBeenCalled();
  world.observationEpoch(2);
  await scanner.getProject(encodeProjectId(world.path));
  group.mockClear();
  await scanner.getProject(encodeProjectId(world.path));
  expect(group).not.toHaveBeenCalled();
});

it("unwatched nonempty roots retain the complete-read TTL fallback", async () => {
  const world = await setup();
  world.observationEpoch(null);
  await scanner.getProject(encodeProjectId(world.path));
  const secondId = "41111111-2222-4333-8444-555555555555";
  await writeFile(
    join(world.claudeDir, `${secondId}.jsonl`),
    JSON.stringify({
      type: "user",
      uuid: secondId,
      cwd: world.path,
      message: { role: "user", content: "no observer notification" },
    }) + "\n",
  );
  expect(
    (await scanner.getProject(encodeProjectId(world.path)))
      ?.sessionCountsByProvider,
  ).toEqual({ claude: 2, codex: 1 });
});

it("disposal during a freshness check cannot resume native discovery afterward", async () => {
  const world = await setup();
  const facts = (
    scanner as unknown as { projectFacts: { isFresh: () => Promise<boolean> } }
  ).projectFacts;
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  vi.spyOn(facts, "isFresh").mockImplementation(async () => {
    entered();
    await gate;
    return true;
  });
  const group = vi.spyOn(world.codexScanner, "listProjects");
  const reading = scanner.getProject(encodeProjectId(world.path));
  await started;
  await scanner.dispose();
  unblock();
  await expect(reading).rejects.toThrow("Project scanner is disposed");
  expect(group).not.toHaveBeenCalled();
});

it("registered-only directories retain live existence checks while native point reads remain scoped", async () => {
  const world = await setup();
  const metadata = new ProjectMetadataService({
    dataDir: join(root, "metadata"),
  });
  await metadata.initialize();
  scanner.setProjectMetadataService(metadata);
  await scanner.refreshRetainedProjects();
  const registered = join(root, "registered");
  const registeredId = encodeProjectId(registered);
  await mkdir(registered);
  await metadata.addProject(registeredId, registered);
  expect((await scanner.getProject(registeredId))?.sessionCount).toBe(0);
  const group = vi.spyOn(world.codexScanner, "listProjects");
  await rm(registered, { recursive: true });
  await scanner.getProject(encodeProjectId(world.path));
  expect(group).not.toHaveBeenCalled();
  expect(await scanner.getProject(registeredId)).toBeNull();
  expect(group).toHaveBeenCalledTimes(1);
  group.mockClear();
  expect(await scanner.getProject(registeredId)).toBeNull();
  expect(group).not.toHaveBeenCalled();
  await mkdir(registered);
  expect((await scanner.getProject(registeredId))?.sessionCount).toBe(0);
  expect(group).toHaveBeenCalledTimes(1);
  group.mockClear();
  expect((await scanner.getProject(registeredId))?.sessionCount).toBe(0);
  expect(group).not.toHaveBeenCalled();
  // Native history survives disappearance of its registered working directory.
  await metadata.addProject(encodeProjectId(world.path), world.path);
  await scanner.getProject(encodeProjectId(world.path));
  group.mockClear();
  await rm(world.path, { recursive: true });
  expect(
    (await scanner.getProject(encodeProjectId(world.path)))?.sessionCount,
  ).toBe(2);
  expect(group).not.toHaveBeenCalled();
});

it.each([false, true])(
  "structural invalidation cannot erase observer handover evidence (epoch changes during capture: %s)",
  async (duringCapture) => {
    const world = await setup();
    world.observationEpoch(null);
    await scanner.getProject(encodeProjectId(world.path));
    const secondId = "51111111-2222-4333-8444-555555555555";
    await writeFile(
      join(world.claudeDir, `${secondId}.jsonl`),
      JSON.stringify({
        type: "user",
        uuid: secondId,
        cwd: world.path,
        message: { role: "user", content: "created during gap" },
      }) + "\n",
    );
    if (duringCapture) {
      const facts = (
        scanner as unknown as {
          projectFacts: { beginObservation: () => Promise<unknown> };
        }
      ).projectFacts;
      const capture = facts.beginObservation.bind(facts);
      vi.spyOn(facts, "beginObservation").mockImplementation(async () => {
        world.observationEpoch(2);
        return capture();
      });
    } else world.observationEpoch(2);
    // An unrelated provider event used to discard the old coverage proof while
    // allowing Claude's old directory inventory to survive the next scan.
    world.event("codex", world.codexFile, "create");
    expect(
      (await scanner.getProject(encodeProjectId(world.path)))
        ?.sessionCountsByProvider,
    ).toEqual({ claude: 2, codex: 1 });
    expect(
      JSON.parse(
        JSON.stringify(await scanner.getProject(encodeProjectId(world.path))),
      ),
    ).toEqual(await world.rebuild());
  },
);

it("membership lookup uses the file path as its leading SQL search key", async () => {
  const world = await setup();
  const prepare = vi.spyOn(world.database, "prepare");
  await appendFile(world.claudeFile, "\n");
  world.event("claude", world.claudeFile);
  await scanner.getProject(encodeProjectId(world.path));
  const sql = prepare.mock.calls
    .map(([sql]) => sql)
    .find((sql) =>
      sql.startsWith(
        "SELECT project_id,project_key,source_version FROM session_catalog",
      ),
    );
  expect(sql).toBeDefined();
  const plan = world.database.prepare(`EXPLAIN QUERY PLAN ${sql}`);
  try {
    expect(
      plan
        .all<{ detail: string }>("claude", world.claudeFile)
        .map((row) => row.detail)
        .join("\n"),
    ).toMatch(/location_path=\?/);
  } finally {
    plan.finalize();
  }
});
