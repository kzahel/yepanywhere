import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, expect, it } from "vitest";
import {
  type CatalogProjectsView,
  CatalogProjectsProjection,
  catalogProjects,
} from "../../src/projects/catalog-projects.js";
import { ProjectScanner } from "../../src/projects/scanner.js";
import {
  type SessionCatalogRow,
  sessionCatalogRowKey,
} from "../../src/sessions/catalog-types.js";
import { EventBus } from "../../src/watcher/EventBus.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

function row(
  sessionId: string,
  project: string,
  updatedAt: string,
  family: "claude" | "codex" = "codex",
  storeKey = "default",
): SessionCatalogRow {
  return {
    catalogFamily: family,
    storeKey,
    sessionId,
    projectId: `id-${project}` as UrlProjectId,
    projectPath: `/projects/${project}`,
    projectIdentityKey: `/projects/${project}`,
    updatedAt,
    fidelity: "identity",
    sourceVersion: `${sessionId}@${updatedAt}`,
    location: { kind: "file", path: `/store/${sessionId}.jsonl` },
  };
}

it("keeps the project view equal to a full fold across random changes", () => {
  const stores = [
    { catalogFamily: "codex", storeKey: "default" },
    { catalogFamily: "claude", storeKey: "default" },
  ] as const;
  // A store that is not eligible contributes nothing.
  const eligible = [stores[0], stores[1]];
  let seed = 7;
  const random = (bound: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % bound;
  };
  const rows = new Map<string, SessionCatalogRow>();
  const projection = new CatalogProjectsProjection();
  let view: CatalogProjectsView | undefined;
  for (let step = 0; step < 400; step += 1) {
    const changed: SessionCatalogRow[] = [];
    const removed: SessionCatalogRow[] = [];
    for (let edit = random(4); edit >= 0; edit -= 1) {
      const id = `s${random(30)}`;
      const existing = [...rows.values()].find((r) => r.sessionId === id);
      if (existing && random(4) === 0) {
        rows.delete(sessionCatalogRowKey(existing));
        removed.push(existing);
        continue;
      }
      const next = row(
        id,
        `p${random(6)}`,
        new Date(Date.UTC(2026, 0, 1 + random(90))).toISOString(),
        existing?.catalogFamily ?? (random(2) ? "codex" : "claude"),
        existing?.storeKey ?? (random(5) ? "default" : "ineligible"),
      );
      rows.set(sessionCatalogRowKey(next), next);
      changed.push(next);
    }
    // A key changed and removed in one read is reported once, as the log does.
    const changedKeys = new Set(changed.map(sessionCatalogRowKey));
    view = projection.apply(
      {
        full: step === 0,
        rows:
          step === 0
            ? [...rows.values()]
            : [...rows.values()].filter((r) =>
                changedKeys.has(sessionCatalogRowKey(r)),
              ),
        removed: removed.filter((r) => !rows.has(sessionCatalogRowKey(r))),
      },
      stores,
      eligible,
    );
    expect(view.version).toBe(
      catalogProjects([...rows.values()], stores, eligible).version,
    );
  }
  expect(view?.projects.length).toBeGreaterThan(0);
});

it("names only the projects whose facts changed in projects-changed", async () => {
  const projectsDir = await mkdtemp(join(tmpdir(), "catalog-projects-"));
  cleanup.push(() => rm(projectsDir, { recursive: true, force: true }));
  const eventBus = new EventBus();
  const published: string[][] = [];
  eventBus.subscribe((event) => {
    if (event.type === "projects-changed") published.push(event.projectIds);
  });
  const stores = [{ catalogFamily: "codex", storeKey: "default" }] as const;
  let rows = [
    row("a", "alpha", "2026-01-01T00:00:00.000Z"),
    row("b", "beta", "2026-01-01T00:00:00.000Z"),
    row("c", "gamma", "2026-01-01T00:00:00.000Z"),
  ];
  let view = catalogProjects(rows, stores, stores);
  const scanner = new ProjectScanner({
    projectsDir,
    enableCodex: false,
    enableGemini: false,
    eventBus,
    catalogProjects: { read: async () => view, peek: () => view },
  });
  cleanup.push(() => scanner.dispose());
  const announce = () =>
    eventBus.emit({
      type: "session-catalog-updated",
      catalog: {
        catalogEpoch: "e",
        catalogGeneration: published.length + 1,
        complete: true,
        refreshing: false,
      },
      timestamp: new Date().toISOString(),
    });
  const ids = () =>
    Object.fromEntries(scanner.cachedProjects().map((p) => [p.path, p.id]));

  announce();
  expect(published).toHaveLength(1);
  expect(published[0]).toHaveLength(3);

  // One session advanced: only its project's page needs to refetch.
  rows = [
    { ...rows[0]!, updatedAt: "2026-02-01T00:00:00.000Z" },
    ...rows.slice(1),
  ];
  view = catalogProjects(rows, stores, stores);
  announce();
  expect(published[1]).toEqual([ids()["/projects/alpha"]]);

  // A project that loses its last session is named as it leaves.
  const gamma = ids()["/projects/gamma"];
  rows = rows.slice(0, 2);
  view = catalogProjects(rows, stores, stores);
  announce();
  expect(published[2]).toEqual([gamma]);

  // A publication that leaves every project as it was announces nothing.
  view = { ...catalogProjects(rows, stores, stores), version: "same facts" };
  announce();
  expect(published).toHaveLength(3);

  // A view that only became complete still announces, naming nothing.
  view = { ...view, complete: false, version: "incomplete" };
  announce();
  view = { ...view, complete: true, version: "complete again" };
  announce();
  expect(published.slice(3)).toEqual([[], []]);
});
