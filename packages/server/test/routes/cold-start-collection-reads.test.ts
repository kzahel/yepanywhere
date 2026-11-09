import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toUrlProjectId, type UrlProjectId } from "@yep-anywhere/shared";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionIndexService } from "../../src/indexes/index.js";
import { createGlobalSessionsRoutes } from "../../src/routes/global-sessions.js";
import { createInboxRoutes } from "../../src/routes/inbox.js";
import { ClaudeSessionReader } from "../../src/sessions/reader.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import type { Project } from "../../src/supervisor/types.js";
import { EventBus } from "../../src/watcher/index.js";
import {
  closeTestDiscoveryDatabases,
  openTestDiscoveryDatabase,
} from "../utils/session-metadata-database.js";

const PROJECTS = 6;
const SESSIONS_PER_PROJECT = 4;

/**
 * Milestone 8's cold-restart scenario, end to end rather than per slice.
 *
 * A fresh browser against a just-started server issues its navigation reads at
 * once, and both of the collection routes enumerate every project. The question
 * this file answers is what that burst costs *below* the routes: whether each
 * transcript is parsed once for the whole burst, or once per route per project.
 *
 * `SessionIndexService` is the real one, over a real temporary store with no
 * persisted index — the actual cold state, not a stub of it.
 */
describe("cold start collection reads", () => {
  let testDir: string;
  let projectsDir: string;
  let indexService: SessionIndexService;
  let projects: Project[];

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "ya-cold-start-"));
    projectsDir = join(testDir, "projects");
    projects = [];

    for (let index = 0; index < PROJECTS; index += 1) {
      const name = `project-${index}`;
      const sessionDir = join(projectsDir, name);
      await mkdir(sessionDir, { recursive: true });
      for (let session = 0; session < SESSIONS_PER_PROJECT; session += 1) {
        const id = `${name}-s${session}`;
        const line = JSON.stringify({
          type: "user",
          message: { content: `hello from ${id}` },
          uuid: `msg-${id}`,
          timestamp: new Date().toISOString(),
        });
        await writeFile(join(sessionDir, `${id}.jsonl`), `${line}\n`);
      }
      projects.push({
        id: toUrlProjectId(`/work/${name}`),
        path: `/work/${name}`,
        name,
        sessionCount: SESSIONS_PER_PROJECT,
        sessionDir,
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
        provider: "claude",
      });
    }

    indexService = new SessionIndexService({
      database: openTestDiscoveryDatabase(testDir),
      dataDir: join(testDir, "indexes"),
      projectsDir,
    });
    await indexService.initialize();
  });

  afterEach(async () => {
    closeTestDiscoveryDatabases();
    await rm(testDir, { recursive: true });
  });

  function buildRoutes(): { sessions: Hono; inbox: Hono } {
    const scanner = {
      listProjects: async () => projects,
    } as unknown as ProjectScanner;
    const readerFactory = (project: Project) =>
      new ClaudeSessionReader({ sessionDir: project.sessionDir });
    const eventBus = new EventBus();

    return {
      sessions: createGlobalSessionsRoutes({
        scanner,
        readerFactory,
        sessionIndexService: indexService,
        eventBus,
      }),
      inbox: createInboxRoutes({
        scanner,
        readerFactory,
        sessionIndexService: indexService,
        eventBus,
      }),
    };
  }

  it("parses each transcript once for a fresh browser's opening burst", async () => {
    const { sessions, inbox } = buildRoutes();

    // Both collection routes at once, as a fresh tab issues them.
    const [sessionsResponse, inboxResponse] = await Promise.all([
      sessions.request("/"),
      inbox.request("/"),
    ]);
    expect(sessionsResponse.status).toBe(200);
    expect(inboxResponse.status).toBe(200);

    const rows = (await sessionsResponse.json()) as { sessions: unknown[] };
    expect(rows.sessions).toHaveLength(PROJECTS * SESSIONS_PER_PROJECT);

    // One parse per transcript for the whole burst. Two routes reading the
    // same cold store must not mean two parses of every file: the shared
    // index service joins the in-flight load per project.
    const stats = indexService.getDebugStats();
    expect(stats.parseCalls).toBe(PROJECTS * SESSIONS_PER_PROJECT);
  });

  it("costs no further parses once the index is warm", async () => {
    const { sessions, inbox } = buildRoutes();
    await Promise.all([sessions.request("/"), inbox.request("/")]);
    const afterCold = indexService.getDebugStats().parseCalls;

    // A second burst — a reconnect, or another tab — reads the same
    // unchanged store. Route-level retention is per instance and is not what
    // is being measured here; this is the layer beneath it.
    const fresh = buildRoutes();
    await Promise.all([fresh.sessions.request("/"), fresh.inbox.request("/")]);

    expect(indexService.getDebugStats().parseCalls).toBe(afterCold);
  });

  it("touches no project outside the requested filter", async () => {
    const { inbox } = buildRoutes();
    const target = projects[0] as Project;

    const response = await inbox.request(
      `/?projectId=${encodeURIComponent(target.id as UrlProjectId)}`,
    );
    expect(response.status).toBe(200);

    // A filtered read is the unused-provider question in miniature: storage
    // outside the request must not be enumerated merely because the route
    // knows it exists.
    expect(indexService.getDebugStats().parseCalls).toBe(SESSIONS_PER_PROJECT);
  });
});
