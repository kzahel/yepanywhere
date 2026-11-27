import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Hono } from "hono";
import { ProjectStoragePolicy } from "../src/projects/projectStoragePolicy.js";
import type { ProjectScanner } from "../src/projects/scanner.js";
import {
  ReviewCommentService as ReviewCommentServiceClass,
  type ReviewCommentService,
} from "../src/review/ReviewCommentService.js";
import { ReviewInboxSources } from "../src/review/ReviewInboxSources.js";
import { createReviewInboxRoutes } from "../src/routes/review-inbox.js";

const PROJECTS = 2_000;
const RETENTION_PROJECTS = 200;
const REQUESTS = 20;
const SITES_PER_PROJECT = 40;
const ENTRIES_PER_SITE = 5;
const UNREAD_PROJECT = "/projects/p7";

type ScannerProjects = Awaited<ReturnType<ProjectScanner["listProjects"]>>;
type StoreFile = Awaited<ReturnType<ReviewCommentService["getStoreFile"]>>;

const projects = Array.from({ length: PROJECTS }, (_, index) => ({
  id: `p${index}`,
  name: `Project ${index}`,
  path: `/projects/p${index}`,
}));

/**
 * A review store big enough that cloning it per request is the real cost.
 * getStoreFile deep-clones canonical state on every call.
 */
function buildStore(projectPath: string): Record<string, unknown> {
  const unread = projectPath === UNREAD_PROJECT;
  const sites = Array.from({ length: SITES_PER_PROJECT }, (_, siteIndex) => ({
    id: `site-${siteIndex}`,
    path: `src/module-${siteIndex}.ts`,
    createdAt: "2026-08-01T00:00:00.000Z",
    entries: Array.from({ length: ENTRIES_PER_SITE }, (_, entryIndex) => ({
      id: `entry-${siteIndex}-${entryIndex}`,
      text: `reviewer note ${siteIndex}-${entryIndex} with enough prose to matter`,
      createdAt: "2026-08-01T00:00:00.000Z",
    })),
    outcomes: [
      {
        entryId: `entry-${siteIndex}-0`,
        disposition: "accepted",
        text: `outcome ${siteIndex}`,
        observedAt: "2026-08-02T00:00:00.000Z",
      },
    ],
  }));
  return {
    sites,
    drafts: [],
    submissions: unread
      ? [
          {
            id: "submission-1",
            name: "unread submission",
            targetSessionId: "session-1",
            responseRevision: 2,
            acknowledgedRevision: 1,
            entryRefs: [{ siteId: "site-0", entryId: "entry-0-0" }],
          },
        ]
      : [],
  };
}

const canonicalStores = new Map<string, Record<string, unknown>>();
for (const project of projects) {
  canonicalStores.set(project.path, buildStore(project.path));
}

interface Measurement {
  durationMs: number;
  projectListings: number;
  storeLoads: number;
  clonedBytes: number;
}

function makeApp(retained: boolean, counters: Measurement): Hono {
  const app = new Hono();
  const sources = () =>
    new ReviewInboxSources(
      async (projectPath) => {
        counters.storeLoads++;
        const store = canonicalStores.get(projectPath);
        if (retained) return store as unknown as StoreFile;
        const raw = JSON.stringify(store);
        counters.clonedBytes += raw.length;
        return JSON.parse(raw) as StoreFile;
      },
      () => [],
      () => true,
    );
  const retainedSources = sources();
  app.route(
    "/api",
    createReviewInboxRoutes({
      scanner: {
        readRetainedProjects: async () => {
          counters.projectListings++;
          return {
            projects: projects as unknown as ScannerProjects,
            complete: true,
            refreshing: false,
          };
        },
        listProjects: async () => {
          throw new Error("Unexpected full project listing");
        },
      },
      inbox: {
        revision: 0,
        read: (projects) =>
          (retained ? retainedSources : sources()).read(projects),
      },
      isEnabled: () => true,
      projectSetTtlMs: retained ? 60_000 : 0,
      now: () => 1_000_000,
    }),
  );
  return app;
}

async function measure(retained: boolean): Promise<Measurement> {
  const counters: Measurement = {
    durationMs: 0,
    projectListings: 0,
    storeLoads: 0,
    clonedBytes: 0,
  };
  const app = makeApp(retained, counters);
  const startedAt = performance.now();
  for (let request = 0; request < REQUESTS; request += 1) {
    const response = await app.request("/api/review/inbox");
    const body = (await response.json()) as { items: unknown[] };
    if (body.items.length !== 1) {
      throw new Error(`Expected one unread item, got ${body.items.length}`);
    }
  }
  counters.durationMs = performance.now() - startedAt;
  return counters;
}

async function measureFiltered(): Promise<Measurement> {
  const counters: Measurement = {
    durationMs: 0,
    projectListings: 0,
    storeLoads: 0,
    clonedBytes: 0,
  };
  const app = makeApp(true, counters);
  await app.request("/api/review/inbox");
  counters.storeLoads = 0;
  counters.projectListings = 0;
  counters.clonedBytes = 0;
  const startedAt = performance.now();
  for (let request = 0; request < REQUESTS; request += 1) {
    await app.request("/api/review/inbox?projectId=p7");
  }
  counters.durationMs = performance.now() - startedAt;
  return counters;
}

/**
 * Real service over real project directories: how much store state stays
 * resident after one Inbox-style pass touches every project.
 */
async function measureStoreRetention(
  maxRetainedStoreBytes: number,
): Promise<{ retainedStores: number; retainedBytes: number }> {
  const root = await mkdtemp(join(tmpdir(), "review-inbox-bench-"));
  try {
    const storagePolicy = new ProjectStoragePolicy({
      dataDir: root,
      getMode: () => "app-data",
    });
    const service = new ReviewCommentServiceClass({
      storagePolicy,
      maxRetainedStoreBytes,
    });
    for (let index = 0; index < RETENTION_PROJECTS; index += 1) {
      const projectPath = join(root, `p${index}`);
      await mkdir(projectPath, { recursive: true });
      await service.addComment(projectPath, {
        anchor: {
          path: `src/module-${index}.ts`,
          revision: { kind: "uncommitted", savedAt: "2026-08-01T00:00:00Z" },
          side: "new",
          oldLine: null,
          newLine: 10,
          snippet: `line ${index}`,
        },
        text: `reviewer note ${index} with enough prose to occupy real bytes`,
      });
    }
    const metrics = service.getRetentionMetrics();
    return {
      retainedStores: metrics.retainedStores,
      retainedBytes: metrics.retainedBytes,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function measureEmptyProjects() {
  const root = await mkdtemp(join(tmpdir(), "review-inbox-presence-"));
  try {
    let pathChecks = 0;
    class MeasuredPolicy extends ProjectStoragePolicy {
      override readPaths(project: string, ...segments: string[]) {
        pathChecks++;
        return super.readPaths(project, ...segments);
      }
    }
    const storagePolicy = new MeasuredPolicy({
      dataDir: root,
      getMode: () => "app-data",
    });
    const service = new ReviewCommentServiceClass({ storagePolicy });
    const projects = Array.from({ length: 251 }, (_, i) => ({
      id: String(i),
      name: String(i),
      path: join(root, "p" + i),
    }));
    await Promise.all(projects.map((project) => mkdir(project.path)));
    const readEmpty = async () => {
      if ((await service.inbox.read(projects)).length !== 0)
        throw new Error("Unexpected unread review");
    };
    await readEmpty();
    const initial = pathChecks;
    await readEmpty();
    const repeated = pathChecks - initial;
    if (
      initial !== projects.length ||
      repeated !== 0 ||
      service.getRetentionMetrics().retainedStores !== 0
    ) {
      throw new Error("Empty Inbox performed unexpected project/store work");
    }
    return { initial, repeated };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const emptyProjects = await measureEmptyProjects();
const legacy = await measure(false);
const retained = await measure(true);
const filtered = await measureFiltered();
const unboundedStores = await measureStoreRetention(Number.MAX_SAFE_INTEGER);
const boundedStores = await measureStoreRetention(64 * 1024);

console.log(
  [
    "REVIEW_INBOX:",
    `empty_project_presence_checks_first=${emptyProjects.initial}`,
    `empty_project_presence_checks_next=${emptyProjects.repeated}`,
    `projects=${PROJECTS}`,
    `requests=${REQUESTS}`,
    `legacy_project_listings=${legacy.projectListings}`,
    `retained_project_listings=${retained.projectListings}`,
    `legacy_store_loads=${legacy.storeLoads}`,
    `retained_store_loads=${retained.storeLoads}`,
    `avoided_store_loads_percent=${(
      100 * (1 - retained.storeLoads / legacy.storeLoads)
    ).toFixed(2)}`,
    `legacy_cloned_bytes=${legacy.clonedBytes}`,
    `retained_cloned_bytes=${retained.clonedBytes}`,
    `legacy_ms=${legacy.durationMs.toFixed(2)}`,
    `retained_ms=${retained.durationMs.toFixed(2)}`,
    `speedup=${(legacy.durationMs / retained.durationMs).toFixed(2)}x`,
    `filtered_store_loads=${filtered.storeLoads}`,
    `filtered_ms=${filtered.durationMs.toFixed(2)}`,
    `retention_projects=${RETENTION_PROJECTS}`,
    `unbounded_retained_stores=${unboundedStores.retainedStores}`,
    `bounded_retained_stores=${boundedStores.retainedStores}`,
    `unbounded_retained_bytes=${unboundedStores.retainedBytes}`,
    `bounded_retained_bytes=${boundedStores.retainedBytes}`,
    `retained_bytes_reduction_percent=${(
      100 * (1 - boundedStores.retainedBytes / unboundedStores.retainedBytes)
    ).toFixed(2)}`,
  ].join(" "),
);
