import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  toUrlProjectId,
  truncateSessionTitle,
  nativeSessionRef,
  parseNativeSessionId,
  parseYaSessionId,
  type NativeSessionRef,
  type ProviderChildSessionSummary,
} from "@yep-anywhere/shared";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { ProviderChildRelationshipService } from "../../src/sessions/ProviderChildRelationshipService.js";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectMetadataService } from "../../src/metadata/ProjectMetadataService.js";
import { SessionCatalogService } from "../../src/services/SessionCatalogService.js";
import { RetainedSessionCollections } from "../../src/services/RetainedSessionCollections.js";
import {
  createGlobalSessionsRoutes,
  type GlobalSessionsResponse,
  type GlobalSessionItem,
} from "../../src/routes/global-sessions.js";
import { readRetainedSessionItems } from "../../src/routes/retained-session-collections.js";
import { createInboxRoutes } from "../../src/routes/inbox.js";
import { createRecentsRoutes } from "../../src/routes/recents.js";
import { RecentsService } from "../../src/recents/RecentsService.js";
import type {
  NativeSessionCatalogAdapter,
  SessionCatalogRow,
} from "../../src/sessions/catalog-types.js";
import { ProjectScanner } from "../../src/projects/scanner.js";
import { ClaudeSessionReader } from "../../src/sessions/reader.js";
import { EventBus } from "../../src/watcher/EventBus.js";
import { collectionCatalogAdapters } from "../../src/sessions/catalog-adapters/collection-catalog-adapters.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import {
  catalogFileVersion,
  catalogProjectIdentity,
} from "../../src/sessions/catalog-adapters/row.js";
import type { Project } from "../../src/supervisor/types.js";
import {
  readClaudeCatalogHead,
  readClaudeCatalogTail,
} from "../../src/sessions/claude-summary.js";

const readClaudeCatalogTitle = async (file: string) =>
  (await readClaudeCatalogHead(file)).title;
const readClaudeCatalogRecency = async (file: string) =>
  (await readClaudeCatalogTail(file)).updatedAt;

let dataDir: string;
let collections: RetainedSessionCollections | undefined;
let unblock = () => {};
afterEach(async () => {
  unblock();
  await collections?.dispose();
  if (dataDir) await rm(dataDir, { recursive: true });
  vi.restoreAllMocks();
});

it("serves a durable generation through collection routes while one shared refresh is blocked", async () => {
  dataDir = await mkdtemp(join(tmpdir(), "retained-collections-"));
  const projectId = toUrlProjectId("/work/project");
  const row: SessionCatalogRow = {
    catalogFamily: "claude",
    storeKey: "store",
    sessionId: "saved",
    projectId,
    projectPath: "/work/project",
    projectIdentityKey: "/work/project",
    projectName: "Project",
    updatedAt: new Date().toISOString(),
    title: "Saved title",
    fidelity: "head",
    sourceVersion: "v1",
    location: { kind: "provider", recordId: "saved" },
  };
  const adapter: NativeSessionCatalogAdapter = {
    catalogFamily: "claude",
    storeKey: "store",
    scan: async () => ({ sourceVersion: "v1", rows: [row] }),
  };
  const seed = new SessionCatalogService({ dataDir });
  await seed.initialize();
  const seeded = await seed.reconcile([adapter]);
  seed.stop();
  let starts = 0;
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const bus = new EventBus();
  const events: string[] = [];
  bus.subscribe((event) => events.push(event.type));
  collections = new RetainedSessionCollections({
    dataDir,
    eventBus: bus,
    adapters: async () => {
      starts++;
      entered();
      await blocked;
      return [adapter];
    },
  });
  // Optional PID/title projection does not initialize discovery or read an
  // unpublished owner, even when an older durable generation exists.
  expect((await collections.readPublishedRows()).rows).toEqual([]);
  expect(collections.getVersion()).toBeUndefined();
  expect(starts).toBe(0);
  const refresh = collections.refresh();
  await started;
  expect((await collections.readPublishedRows()).rows).toEqual([row]);
  expect(starts).toBe(1);
  const deps = {
    retainedCollections: collections,
    eventBus: bus,
    scanner: new ProjectScanner({
      projectsDir: join(dataDir, "no-provider-store"),
    }),
    readerFactory: () =>
      new ClaudeSessionReader({
        sessionDir: join(dataDir, "no-provider-store"),
      }),
  };
  const global = createGlobalSessionsRoutes(deps);
  const inbox = createInboxRoutes(deps);
  const recentsService = new RecentsService({ dataDir });
  await recentsService.initialize();
  await recentsService.recordVisit("saved", projectId);
  const recents = createRecentsRoutes({ ...deps, recentsService });
  const projectScan = vi.spyOn(deps.scanner, "listProjects");
  const reader = vi.spyOn(deps, "readerFactory");
  const responses = await Promise.all(
    Array.from({ length: 30 }, (_, index) =>
      index % 3 === 2
        ? recents
            .request("/?summaryMode=retained")
            .then((response) => response.json())
        : index % 3
          ? global
              .request("/?summaryMode=retained&knownGeneration=1")
              .then((response) => response.json())
          : inbox
              .request("/?summaryMode=retained")
              .then((response) => response.json()),
    ),
  );
  expect(starts).toBe(1);
  expect(projectScan).not.toHaveBeenCalled();
  expect(reader).not.toHaveBeenCalled();
  for (const response of responses) {
    expect(response.catalog).toMatchObject({
      catalogEpoch: seeded.snapshot.catalogEpoch,
      catalogGeneration: 1,
      complete: true,
      refreshing: true,
    });
    const item =
      response.sessions?.[0] ??
      response.recents?.[0] ??
      response.recentActivity[0];
    expect(item.title ?? item.sessionTitle).toBe("Saved title");
    expect(item).not.toHaveProperty("messageCount");
    // Transcript detail stays out, but the session's own words come along:
    // All Sessions matches these rows in the browser, so a row reduced to its
    // display title makes anything past that title unfindable.
    if (response.sessions) {
      expect(item.fullTitle).toBe("Saved title");
      expect(item.initialPrompt).toBe("Saved title");
    }
  }
  const starred = await global.request("/?summaryMode=retained&starred=true");
  expect((await starred.json()).sessions).toEqual([]);
  unblock();
  await refresh;
  expect(events).toContain("session-catalog-updated");
  expect((await collections.read()).catalog.refreshing).toBe(false);
});

it("publishes native heads before questions and refreshes only a modified session", async () => {
  dataDir = await mkdtemp(join(tmpdir(), "retained-native-"));
  const projectPath = join(dataDir, "project");
  const project: Project = {
    id: catalogProjectIdentity(projectPath).projectId,
    path: projectPath,
    name: "Project",
    provider: "codex",
    sessionDir: dataDir,
    sessionCount: 2,
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
  };
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ];
  const files = ids.map((id) =>
    join(dataDir, `rollout-2026-09-08T00-00-00-${id}.jsonl`),
  );
  for (const [index, file] of files.entries()) {
    await writeFile(
      file,
      `${[
        {
          type: "session_meta",
          timestamp: "2026-09-08T00:00:00.000Z",
          payload: {
            id: ids[index],
            cwd: projectPath,
            timestamp: "2026-09-08T00:00:00.000Z",
          },
        },
        {
          type: "event_msg",
          timestamp: "2026-09-08T00:01:00.000Z",
          payload: { type: "user_message", message: `Work ${index}` },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
    );
  }
  const scanner = new ProjectScanner({ projectsDir: join(dataDir, "unused") });
  const discovery = vi
    .spyOn(scanner, "listFileCatalogProjects")
    .mockResolvedValue([project]);
  const reader = new CodexSessionReader({ sessionsDir: dataDir, projectPath });
  const headReads = vi.spyOn(reader, "getSessionListSummary");
  const fileLists = vi.spyOn(reader, "listSessionFiles");
  const bus = new EventBus();
  const publications: Promise<
    Awaited<ReturnType<RetainedSessionCollections["read"]>>
  >[] = [];
  bus.subscribe((event) => {
    if (event.type === "session-catalog-updated" && event.catalog.refreshing) {
      publications.push(collections!.read());
    }
  });
  collections = new RetainedSessionCollections({
    dataDir,
    eventBus: bus,
    shouldReadQuestions: (row) => row.sessionId === ids[0],
    adapters: (rows, signal, paths) =>
      collectionCatalogAdapters(
        {
          scanner,
          readerFactory: () => {
            throw new Error("Unexpected Claude reader");
          },
          codexSessionsDir: dataDir,
          codexReaderFactory: () => reader,
          geminiScanner: {
            getHashToCwd: async () => {
              throw new Error("Unexpected Gemini lookup");
            },
          },
          getCatalogFamilies: () => ["codex"],
        },
        rows,
        signal,
        paths,
      ),
  });
  await collections.refresh();
  const base = await publications[0]!;
  expect(base.rows).toHaveLength(2);
  expect(base.rows.map((row) => row.createdAt)).toEqual([
    "2026-09-08T00:00:00.000Z",
    "2026-09-08T00:00:00.000Z",
  ]);
  expect(base.rows.every((row) => row.asyncQuestions === undefined)).toBe(true);
  const ready = await collections.read();
  expect(
    ready.rows.find((row) => row.sessionId === ids[0])?.asyncQuestions,
  ).toEqual({ questions: [], omitted: false });
  expect(
    ready.rows.find((row) => row.sessionId === ids[1])?.asyncQuestions,
  ).toBeUndefined();
  expect(headReads).toHaveBeenCalledTimes(2);
  discovery.mockClear();
  fileLists.mockClear();
  headReads.mockClear();
  await appendFile(
    files[0]!,
    `${JSON.stringify({
      type: "event_msg",
      timestamp: "2026-09-08T00:02:00.000Z",
      payload: { type: "user_message", message: "More work" },
    })}\n`,
  );
  bus.emit({
    type: "file-change",
    provider: "codex",
    path: files[0]!,
    relativePath: "rollout.jsonl",
    fileType: "session",
    changeType: "modify",
    timestamp: new Date().toISOString(),
  });
  await collections.refresh();
  expect(discovery).not.toHaveBeenCalled();
  expect(fileLists).not.toHaveBeenCalled();
  expect(headReads).toHaveBeenCalledTimes(1);
  expect(headReads.mock.calls[0]?.[0]).toBe(ids[0]);
  expect((await collections.read()).rows).toHaveLength(2);
  await collections.refresh();
  expect(headReads).toHaveBeenCalledTimes(1);
});

it("bounds Claude title discovery and uses the canonical command title", async () => {
  dataDir = await mkdtemp(join(tmpdir(), "retained-claude-"));
  const file = join(dataDir, "session.jsonl");
  const user = JSON.stringify({
    type: "user",
    message: {
      content:
        "<command-name>/review</command-name><command-args>the change</command-args>",
    },
  });
  await writeFile(file, `null\nmalformed\n${user}\n`);
  expect(await readClaudeCatalogTitle(file)).toBe("/review the change");
  await writeFile(
    file,
    `${JSON.stringify({ type: "system", content: "x".repeat(300 * 1024) })}\n${user}\n`,
  );
  expect(await readClaudeCatalogTitle(file)).toBeUndefined();

  // Whole, not display-length: All Sessions matches these words in the browser.
  const long = `${"Context before ".repeat(30)}quasarneedle`;
  await writeFile(
    file,
    `${JSON.stringify({ type: "user", message: { content: long } })}\n`,
  );
  expect(await readClaudeCatalogTitle(file)).toBe(long);
});

it("keeps a retained row's whole title searchable and truncates for display", async () => {
  const long = `${"Context before ".repeat(30)}quasarneedle ${"context after ".repeat(30)}`;
  dataDir = await mkdtemp(join(tmpdir(), "retained-title-"));
  const projectPath = join(dataDir, "project");
  const service = {
    read: async () => ({
      rows: [
        {
          catalogFamily: "claude" as const,
          storeKey: "store",
          sessionId: "session",
          ...catalogProjectIdentity(projectPath),
          projectId: catalogProjectIdentity(projectPath).projectId,
          updatedAt: "2026-09-08T00:00:00.000Z",
          title: long,
          fidelity: "head" as const,
          sourceVersion: "v1",
          location: {
            kind: "file" as const,
            path: join(projectPath, "session.jsonl"),
          },
        } satisfies SessionCatalogRow,
      ],
      catalog: {},
    }),
  } as unknown as RetainedSessionCollections;

  const { sessions } = await readRetainedSessionItems(
    service,
    {} as Parameters<typeof readRetainedSessionItems>[1],
  );

  const [row] = sessions;
  expect(row?.fullTitle).toBe(long);
  expect(row?.initialPrompt).toBe(long);
  expect(row?.title).toBe(truncateSessionTitle(long));
  expect(row?.title).not.toContain("quasarneedle");
});

it("names retained rows and the project filter by the project's current chosen name", async () => {
  dataDir = await mkdtemp(join(tmpdir(), "retained-project-name-"));
  const projectPath = join(dataDir, "yepanywhere");
  const identity = catalogProjectIdentity(projectPath);
  const projectMetadata = new ProjectMetadataService({ dataDir });
  await projectMetadata.initialize();
  await projectMetadata.setProjectNameOverride(identity.projectId, "YA");
  // A row stored before the rename still carries the directory name, and an
  // unchanged file is never read again to replace it.
  const service = {
    read: async () => ({
      rows: [
        {
          catalogFamily: "claude" as const,
          storeKey: "store",
          sessionId: "session",
          ...identity,
          projectName: "yepanywhere",
          updatedAt: "2026-09-08T00:00:00.000Z",
          fidelity: "head" as const,
          sourceVersion: "v1",
          location: {
            kind: "file" as const,
            path: join(projectPath, "session.jsonl"),
          },
        } satisfies SessionCatalogRow,
      ],
      catalog: {},
    }),
  } as unknown as RetainedSessionCollections;
  const deps = {
    projectDisplayName: (path: string) =>
      projectMetadata.getProjectDisplayName(path),
  } as Parameters<typeof readRetainedSessionItems>[1];

  const named = await readRetainedSessionItems(service, deps);
  expect(named.sessions[0]?.projectName).toBe("YA");
  expect(named.projects).toEqual([{ id: identity.projectId, name: "YA" }]);

  await projectMetadata.setProjectNameOverride(identity.projectId, null);
  const cleared = await readRetainedSessionItems(service, deps);
  expect(cleared.sessions[0]?.projectName).toBe("yepanywhere");
  expect(cleared.projects[0]?.name).toBe("yepanywhere");
});

it("bounds Claude recency discovery to the latest conversation row", async () => {
  dataDir = await mkdtemp(join(tmpdir(), "retained-claude-recency-"));
  const file = join(dataDir, "session.jsonl");
  const assistant = JSON.stringify({
    type: "assistant",
    uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    timestamp: "2026-09-08T00:00:00.000Z",
    message: { content: [{ type: "text", text: "done" }] },
  });
  await writeFile(file, `null\nmalformed\n${assistant}\n`);
  expect(await readClaudeCatalogRecency(file)).toBe("2026-09-08T00:00:00.000Z");

  // Shutdown metadata rows carry no conversation timestamp of their own.
  await appendFile(
    file,
    `${JSON.stringify({ type: "last-prompt", sessionId: "s", lastPrompt: "hi" })}\n`,
  );
  expect(await readClaudeCatalogRecency(file)).toBe("2026-09-08T00:00:00.000Z");

  // Past the tail window there is nothing to claim, so the caller's storage
  // fallback stays in charge rather than a wrong content time being invented.
  await writeFile(
    file,
    `${assistant}\n${JSON.stringify({ type: "system", content: "x".repeat(300 * 1024) })}\n`,
  );
  expect(await readClaudeCatalogRecency(file)).toBeUndefined();
});

it("reads a Claude session's creation time and last human turn without a summary", async () => {
  dataDir = await mkdtemp(join(tmpdir(), "retained-claude-times-"));
  const file = join(dataDir, "session.jsonl");
  const entries = [
    { type: "summary", summary: "no timestamp" },
    {
      type: "user",
      timestamp: "2026-09-08T00:00:00.000Z",
      message: { content: "Build the thing" },
    },
    {
      type: "assistant",
      timestamp: "2026-09-08T00:01:00.000Z",
      message: { content: [{ type: "tool_use", id: "t", name: "Read" }] },
    },
    // A tool result is a user row, not a turn a person wrote.
    {
      type: "user",
      timestamp: "2026-09-08T00:02:00.000Z",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }],
      },
    },
    {
      type: "user",
      timestamp: "2026-09-08T00:03:00.000Z",
      message: { content: "And test it" },
    },
    {
      type: "assistant",
      timestamp: "2026-09-08T00:04:00.000Z",
      message: { content: [{ type: "text", text: "Done" }] },
    },
  ];
  await writeFile(
    file,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  expect(await readClaudeCatalogHead(file)).toEqual({
    title: "Build the thing",
    createdAt: "2026-09-08T00:00:00.000Z",
  });
  expect(await readClaudeCatalogTail(file)).toEqual({
    updatedAt: "2026-09-08T00:04:00.000Z",
    lastHumanTurnAt: "2026-09-08T00:03:00.000Z",
  });

  // An opening prompt still being answered is itself the last human turn.
  await writeFile(
    file,
    `${entries
      .slice(0, 3)
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
  );
  expect((await readClaudeCatalogTail(file)).lastHumanTurnAt).toBe(
    "2026-09-08T00:00:00.000Z",
  );
});

it("keeps a reaped Claude session at its content time, not its shutdown mtime", async () => {
  dataDir = await mkdtemp(join(tmpdir(), "retained-claude-reap-"));
  const projectPath = join(dataDir, "project");
  const sessionDir = join(dataDir, "sessions");
  await mkdir(sessionDir, { recursive: true });
  const project: Project = {
    id: catalogProjectIdentity(projectPath).projectId,
    path: projectPath,
    name: "Project",
    provider: "claude",
    sessionDir,
    sessionCount: 1,
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
  };
  const sessionId = "33333333-3333-4333-8333-333333333333";
  const file = join(sessionDir, `${sessionId}.jsonl`);
  const contentAt = "2026-09-08T00:00:00.000Z";
  await writeFile(
    file,
    `${[
      {
        type: "user",
        uuid: "11111111-1111-4111-8111-111111111111",
        parentUuid: null,
        timestamp: "2026-09-07T23:59:00.000Z",
        message: { content: "Do the work" },
      },
      {
        type: "assistant",
        uuid: "22222222-2222-4222-8222-222222222222",
        parentUuid: "11111111-1111-4111-8111-111111111111",
        timestamp: contentAt,
        message: { content: [{ type: "text", text: "Done" }] },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
  );
  const scanner = new ProjectScanner({ projectsDir: join(dataDir, "unused") });
  vi.spyOn(scanner, "listFileCatalogProjects").mockResolvedValue([project]);
  const reader = new ClaudeSessionReader({ sessionDir });
  const bus = new EventBus();
  collections = new RetainedSessionCollections({
    dataDir,
    eventBus: bus,
    adapters: (rows, signal, paths) =>
      collectionCatalogAdapters(
        {
          scanner,
          readerFactory: () => reader,
          codexSessionsDir: join(dataDir, "unused-codex"),
          codexReaderFactory: () => {
            throw new Error("Unexpected Codex reader");
          },
          geminiScanner: {
            getHashToCwd: async () => {
              throw new Error("Unexpected Gemini lookup");
            },
          },
          getCatalogFamilies: () => ["claude"],
        },
        rows,
        signal,
        paths,
      ),
  });
  await collections.refresh();
  const row = (await collections.read()).rows.find(
    (candidate) => candidate.sessionId === sessionId,
  );
  expect(row?.updatedAt).toBe(contentAt);
  // With no cached summary the row still carries the times the sidebar files
  // it by; a live session being worked in rarely has a summary.
  expect(row?.createdAt).toBe("2026-09-07T23:59:00.000Z");
  expect(row?.lastHumanTurnAt).toBe("2026-09-07T23:59:00.000Z");
  const { sessions } = await readRetainedSessionItems(
    collections,
    {} as Parameters<typeof readRetainedSessionItems>[1],
  );
  expect(sessions[0]?.lastHumanTurnAt).toBe("2026-09-07T23:59:00.000Z");
  expect(sessions[0]?.createdAt).toBe("2026-09-07T23:59:00.000Z");

  // What an idle reap writes: the file moves without the conversation moving.
  await appendFile(
    file,
    `${JSON.stringify({
      type: "last-prompt",
      sessionId,
      lastPrompt: "Do the work",
      leafUuid: "22222222-2222-4222-8222-222222222222",
    })}\n`,
  );
  bus.emit({
    type: "file-change",
    provider: "claude",
    path: file,
    relativePath: `${sessionId}.jsonl`,
    fileType: "session",
    changeType: "modify",
    timestamp: new Date().toISOString(),
  });
  await collections.refresh();
  expect(
    (await collections.read()).rows.find((row) => row.sessionId === sessionId)
      ?.updatedAt,
  ).toBe(contentAt);
});

it("reads a row an older build stored for an unchanged file once more", async () => {
  dataDir = await mkdtemp(join(tmpdir(), "retained-row-format-"));
  const projectPath = join(dataDir, "project");
  const project: Project = {
    id: catalogProjectIdentity(projectPath).projectId,
    path: projectPath,
    name: "Project",
    provider: "codex",
    sessionDir: dataDir,
    sessionCount: 1,
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
  };
  const sessionId = "44444444-4444-4444-8444-444444444444";
  const file = join(dataDir, `rollout-2026-09-08T00-00-00-${sessionId}.jsonl`);
  const long = `${"Context before ".repeat(30)}quasarneedle`;
  const createdAt = "2026-09-08T00:00:00.000Z";
  await writeFile(
    file,
    `${[
      {
        type: "session_meta",
        timestamp: createdAt,
        payload: { id: sessionId, cwd: projectPath, timestamp: createdAt },
      },
      {
        type: "event_msg",
        timestamp: "2026-09-08T00:01:00.000Z",
        payload: { type: "user_message", message: long },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
  );
  // What a build before whole titles and summary creation times persisted for
  // this file: the display cut, no createdAt, and the file's current version.
  const stale: SessionCatalogRow = {
    catalogFamily: "codex",
    storeKey: dataDir,
    sessionId,
    ...catalogProjectIdentity(projectPath),
    projectName: "Project",
    provider: "codex",
    updatedAt: "2026-09-08T00:01:00.000Z",
    title: truncateSessionTitle(long),
    fidelity: "head",
    sourceVersion: catalogFileVersion(await stat(file)),
    location: { kind: "file", path: file },
  };
  const seed = new SessionCatalogService({ dataDir });
  await seed.initialize();
  await seed.reconcile([
    {
      catalogFamily: "codex",
      storeKey: dataDir,
      scan: async () => ({ sourceVersion: "old-build", rows: [stale] }),
    },
  ]);
  seed.stop();

  const scanner = new ProjectScanner({ projectsDir: join(dataDir, "unused") });
  vi.spyOn(scanner, "listFileCatalogProjects").mockResolvedValue([project]);
  const reader = new CodexSessionReader({ sessionsDir: dataDir, projectPath });
  const headReads = vi.spyOn(reader, "getSessionListSummary");
  collections = new RetainedSessionCollections({
    dataDir,
    eventBus: new EventBus(),
    adapters: (rows, signal, paths) =>
      collectionCatalogAdapters(
        {
          scanner,
          readerFactory: () => {
            throw new Error("Unexpected Claude reader");
          },
          codexSessionsDir: dataDir,
          codexReaderFactory: () => reader,
          geminiScanner: {
            getHashToCwd: async () => {
              throw new Error("Unexpected Gemini lookup");
            },
          },
          getCatalogFamilies: () => ["codex"],
        },
        rows,
        signal,
        paths,
      ),
  });
  await collections.refresh();
  const reread = (await collections.read()).rows.find(
    (row) => row.sessionId === sessionId,
  );
  expect(reread?.title).toBe(long);
  expect(reread?.createdAt).toBe(createdAt);
  expect(reread?.sourceVersion).toBe(stale.sourceVersion);
  expect(headReads).toHaveBeenCalledTimes(1);

  // Once current, an unchanged file is still answered from its row.
  headReads.mockClear();
  await collections.refresh();
  expect(headReads).not.toHaveBeenCalled();
  expect(
    (await collections.read()).rows.find((row) => row.sessionId === sessionId)
      ?.title,
  ).toBe(long);
});

it("rebuilds at once after an ordinary read finds its shard unreadable", async () => {
  dataDir = await mkdtemp(join(tmpdir(), "retained-reset-"));
  // Past the 8 MiB hot-set budget, so every list read streams the shard from
  // disk instead of answering from memory.
  const rows: SessionCatalogRow[] = Array.from({ length: 540 }, (_, index) => ({
    ...catalogProjectIdentity(join(dataDir, "project")),
    catalogFamily: "claude",
    storeKey: "store",
    sessionId: `saved-${index}`,
    updatedAt: new Date().toISOString(),
    title: "t".repeat(16_384),
    fidelity: "head",
    sourceVersion: "v1",
    location: { kind: "provider", recordId: `saved-${index}` },
  }));
  const adapters = vi.fn(
    async (): Promise<NativeSessionCatalogAdapter[]> => [
      {
        catalogFamily: "claude",
        storeKey: "store",
        scan: async () => ({ sourceVersion: "v1", rows }),
      },
    ],
  );
  collections = new RetainedSessionCollections({
    dataDir,
    eventBus: new EventBus(),
    adapters,
  });
  await collections.refresh();
  expect((await collections.read()).rows).toHaveLength(rows.length);
  adapters.mockClear();

  // No session file changes after this: only the reset itself can ask for
  // the rebuild.
  const generations = join(dataDir, "session-catalog", "generations");
  const [generation] = await readdir(generations);
  const [shard] = await readdir(join(generations, generation!));
  await writeFile(join(generations, generation!, shard!), "{ torn", "utf-8");
  const version = collections.getVersion();
  // Optional process enrichment cannot turn catalogue corruption into native
  // discovery. Advance the actual 300ms scheduling boundary without wall time.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await expect(collections.readPublishedRows()).rejects.toThrow(
      "Invalid session catalog row",
    );
    await vi.advanceTimersByTimeAsync(301);
    expect(adapters).not.toHaveBeenCalled();
    expect(collections.getVersion()).toBe(version);
  } finally {
    vi.useRealTimers();
  }
  // A normal consumer still owns lineage reset and native reconstruction.
  expect((await collections.read()).rows).toEqual([]);

  await vi.waitFor(() => expect(adapters).toHaveBeenCalled(), {
    timeout: 3_000,
    interval: 20,
  });
  await collections.refresh();
  expect((await collections.read()).rows).toHaveLength(rows.length);
}, 20_000);

it("keeps the last accepted rows on failure and stops publication after disposal", async () => {
  dataDir = await mkdtemp(join(tmpdir(), "retained-failure-"));
  const identity = catalogProjectIdentity(join(dataDir, "project"));
  const row: SessionCatalogRow = {
    ...identity,
    catalogFamily: "claude",
    storeKey: "store",
    sessionId: "saved",
    updatedAt: new Date().toISOString(),
    title: "Retained",
    fidelity: "head",
    sourceVersion: "v1",
    location: { kind: "provider", recordId: "saved" },
  };
  const adapters = vi.fn(
    async (): Promise<NativeSessionCatalogAdapter[]> => [
      {
        catalogFamily: "claude",
        storeKey: "store",
        scan: async () => ({ sourceVersion: "v1", rows: [row] }),
      },
    ],
  );
  const bus = new EventBus();
  const emitted = vi.spyOn(bus, "emit");
  collections = new RetainedSessionCollections({
    dataDir,
    eventBus: bus,
    adapters,
  });
  expect((await collections.read()).catalog).toMatchObject({
    complete: false,
    refreshing: true,
  });
  await collections.refresh();
  const before = await collections.read();
  adapters.mockRejectedValueOnce(new Error("Provider unavailable"));
  await collections.refresh();
  const after = await collections.read();
  expect(after.rows).toEqual(before.rows);
  expect(after.catalog).toMatchObject({
    catalogGeneration: before.catalog.catalogGeneration,
    complete: true,
    refreshing: false,
    refreshError: "Provider unavailable",
  });
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  adapters.mockImplementationOnce(async () => {
    entered();
    await blocked;
    return [];
  });
  const work = collections.refresh();
  await started;
  const disposal = collections.dispose();
  emitted.mockClear();
  unblock();
  await Promise.all([work, disposal]);
  expect(emitted).not.toHaveBeenCalled();
});

it("joins durable scoped children into retained global rows after SQL reopen while native refresh is blocked", async () => {
  dataDir = await realpath(
    await mkdtemp(join(tmpdir(), "retained-child-sql-")),
  );
  const nativeDir = join(dataDir, "native"),
    scopeA = join(nativeDir, "a"),
    scopeB = join(nativeDir, "b");
  await mkdir(scopeA, { recursive: true });
  await mkdir(scopeB, { recursive: true });
  const projectA = catalogProjectIdentity(join(dataDir, "project-a")),
    projectB = catalogProjectIdentity(join(dataDir, "project-b"));
  const now = new Date().toISOString();
  const parents = [
    {
      publicId: "public-a",
      native: nativeSessionRef(
        "claude",
        scopeA,
        parseNativeSessionId("same-parent"),
      ),
      project: projectA,
      title: "A child",
    },
    {
      publicId: "public-b",
      native: nativeSessionRef(
        "claude",
        scopeB,
        parseNativeSessionId("same-parent"),
      ),
      project: projectB,
      title: "B child",
    },
    {
      publicId: "public-empty",
      native: nativeSessionRef(
        "claude",
        scopeA,
        parseNativeSessionId("empty-parent"),
      ),
      project: projectA,
      title: undefined,
    },
    {
      publicId: "public-unknown",
      native: nativeSessionRef(
        "claude",
        scopeA,
        parseNativeSessionId("unknown-parent"),
      ),
      project: projectA,
      title: undefined,
    },
  ];
  let sql = new DiscoverySqliteService({
    dataDir,
    probeNetworkFilesystem: () => undefined,
  });
  let metadata = new SessionMetadataService({
    dataDir,
    database: sql.getDatabase(),
  });
  await metadata.initialize();
  const bus = new EventBus(),
    errors: unknown[] = [];
  let committed: () => void = () => {};
  const indexed = () =>
    new ProviderChildRelationshipService(
      sql.getDatabase(),
      metadata.relationships.serverId,
      (owner) => {
        bus.emit({
          type: "session-metadata-changed",
          sessionId: owner.sessionId,
          timestamp: new Date().toISOString(),
        });
        committed();
      },
      (e) => errors.push(e),
      () => metadata.relationships.index,
    );
  let index = indexed();
  const publish = async (
    parent: NativeSessionRef,
    publicId: string,
    title?: string,
  ) => {
    const done = new Promise<void>((resolve) => (committed = resolve));
    index.demand(
      parent,
      { sessionId: publicId },
      {
        observe: async () => ({
          version: title ?? "empty",
          state: "complete",
          children: title
            ? [
                {
                  native: nativeSessionRef(
                    "claude",
                    join(parent.storageScope, parent.id, "subagents"),
                    parseNativeSessionId("same-child"),
                  ),
                  summary: {
                    id: "same-child",
                    parentSessionId: parent.id,
                    title,
                    toolUseId: "call-" + publicId,
                    updatedAt: now,
                  } satisfies ProviderChildSessionSummary,
                },
              ]
            : [],
        }),
        isCurrent: async () => true,
      },
    );
    await done;
  };
  try {
    sql.getDatabase().transaction(() => {
      for (const p of parents) {
        metadata.identities.allocateWithinTransaction({
          sessionId: parseYaSessionId(p.publicId),
          provider: "claude",
          projectId: p.project.projectId,
          createdAt: now,
        });
        metadata.identities.bindWithinTransaction(
          parseYaSessionId(p.publicId),
          p.native,
        );
      }
    });
    for (const p of parents.slice(0, 3))
      await publish(p.native, p.publicId, p.title);
    const managed = metadata.creations.admit({
      requestId: "retained_managed_child_01",
      context: {
        owner: { kind: "superuser" },
        source: { kind: "request", provenance: { surface: "web" } },
      },
      request: {
        provider: "claude",
        projectId: projectA.projectId,
        projectPath: projectA.projectPath,
        message: "managed parent before native catalog publication",
        settings: {
          permissionMode: "default",
          requestedModel: null,
          thinking: null,
          effort: null,
          serviceTier: null,
        },
      },
    });
    const managedNative = nativeSessionRef(
      "claude",
      scopeA,
      parseNativeSessionId("managed-parent"),
    );
    const attempt = metadata.creations.beginDispatch(
      managed.attempt,
      managedNative,
    );
    metadata.creations.bindNative(attempt, managedNative);
    await publish(managedNative, managed.sessionId, "Managed child");
    await index.close();
    sql.close();
    await rm(nativeDir, { recursive: true });
    sql = new DiscoverySqliteService({
      dataDir,
      probeNetworkFilesystem: () => undefined,
    });
    metadata = new SessionMetadataService({
      dataDir,
      database: sql.getDatabase(),
    });
    await metadata.initialize();
    index = indexed();
    const rows: SessionCatalogRow[] = parents.map((p) => ({
      catalogFamily: "claude",
      storeKey: p.native.storageScope,
      nativeStorageScope: p.native.storageScope,
      sessionId: p.native.id,
      ...p.project,
      updatedAt: now,
      title: p.publicId,
      fidelity: "head",
      sourceVersion: "v1",
      location: { kind: "provider", recordId: p.native.id },
    }));
    rows.push({
      ...rows[0]!,
      storeKey: "unscoped-legacy",
      nativeStorageScope: undefined,
      title: "unscoped",
    });
    const adapters: NativeSessionCatalogAdapter[] = [
      ...new Set(rows.map((r) => r.storeKey)),
    ].map((storeKey) => ({
      catalogFamily: "claude",
      storeKey,
      scan: async () => ({
        sourceVersion: "v1",
        rows: rows.filter((r) => r.storeKey === storeKey),
      }),
    }));
    const seed = new SessionCatalogService({ dataDir });
    await seed.initialize();
    const seeded = await seed.reconcile(adapters);
    seed.stop();
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    collections = new RetainedSessionCollections({
      dataDir,
      eventBus: bus,
      adapters: async () => {
        entered();
        await blocked;
        return adapters;
      },
    });
    const refresh = collections.refresh();
    await started;
    const scanner = new ProjectScanner({
      projectsDir: join(dataDir, "missing-provider"),
    });
    const scan = vi.spyOn(scanner, "listProjects");
    const reader = vi.fn(() => {
      throw new Error(
        "Retained child projection must not acquire a provider reader",
      );
    });
    const demand = vi.spyOn(index, "demand");
    const routes = createGlobalSessionsRoutes({
      scanner,
      readerFactory: reader,
      retainedCollections: collections,
      sessionMetadataService: metadata,
      providerChildRelationships: index,
      eventBus: bus,
    });
    const read = async (): Promise<GlobalSessionsResponse> =>
      (await routes.request("/?summaryMode=retained&knownGeneration=1")).json();
    const first = await read();
    const byId = new Map<string, GlobalSessionItem>(
      first.sessions.map((r) => [r.id, r]),
    );
    expect(byId.get("public-a")?.providerChildren).toMatchObject([
      { id: "same-child", parentSessionId: "public-a", title: "A child" },
    ]);
    expect(byId.get("public-b")?.providerChildren).toMatchObject([
      { id: "same-child", parentSessionId: "public-b", title: "B child" },
    ]);
    expect(byId.get(managed.sessionId)?.providerChildren).toMatchObject([
      {
        id: "same-child",
        parentSessionId: managed.sessionId,
        title: "Managed child",
      },
    ]);
    expect(byId.get("public-empty")?.providerChildren).toEqual([]);
    expect(byId.get("public-unknown")).not.toHaveProperty("providerChildren");
    expect(byId.get("same-parent")).not.toHaveProperty("providerChildren");
    expect(first.catalog).toMatchObject({
      catalogEpoch: seeded.snapshot.catalogEpoch,
      catalogGeneration: 1,
      refreshing: true,
    });
    expect(demand).not.toHaveBeenCalled();
    for (const p of parents) expect(index.hasSource(p.native)).toBe(false);
    demand.mockRestore();
    await publish(parents[0]!.native, "public-a", "A updated child");
    const next = await read();
    expect(
      next.sessions.find((r) => r.id === "public-a")?.providerChildren?.[0]
        ?.title,
    ).toBe("A updated child");
    expect(next.catalog?.catalogGeneration).toBe(
      first.catalog?.catalogGeneration,
    );
    expect(next).not.toHaveProperty("unchanged");
    const accepted = vi.spyOn(index, "accepted");
    const page: GlobalSessionsResponse = await (
      await routes.request("/?summaryMode=retained&limit=1&q=public-a")
    ).json();
    expect(page.sessions.map((s) => s.id)).toEqual(["public-a"]);
    expect(accepted).toHaveBeenCalledExactlyOnceWith(
      parents[0]!.native,
      "public-a",
    );
    accepted.mockClear();
    const filtered: GlobalSessionsResponse = await (
      await routes.request(
        `/?summaryMode=retained&project=${projectA.projectId}`,
      )
    ).json();
    expect(filtered.sessions.some((r) => r.id === "public-b")).toBe(false);
    expect(
      accepted.mock.calls.some(([native]) => native.storageScope === scopeB),
    ).toBe(false);
    expect(scan).not.toHaveBeenCalled();
    expect(reader).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
    unblock();
    await refresh;
  } finally {
    unblock();
    await collections?.dispose();
    await index.close();
    sql.close();
  }
});
