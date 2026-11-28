import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import type { ReviewCommentService } from "../../src/review/ReviewCommentService.js";
import { ReviewInboxSources } from "../../src/review/ReviewInboxSources.js";
import { createReviewInboxRoutes } from "../../src/routes/review-inbox.js";

type ScannerProjects = Awaited<ReturnType<ProjectScanner["listProjects"]>>;
type StoreFile = Awaited<ReturnType<ReviewCommentService["getStoreFile"]>>;

interface StoreShape {
  submissions: Array<{
    id: string;
    name: string;
    targetSessionId: string;
    responseRevision: number;
    acknowledgedRevision: number;
    entryRefs: Array<{ siteId: string; entryId: string }>;
  }>;
  sites: Array<{
    id: string;
    path: string;
    outcomes: Array<{ entryId: string; disposition: string }>;
  }>;
}

function unreadStore(submissionId: string): StoreShape {
  return {
    submissions: [
      {
        id: submissionId,
        name: `submission ${submissionId}`,
        targetSessionId: `session-${submissionId}`,
        responseRevision: 2,
        acknowledgedRevision: 1,
        entryRefs: [{ siteId: "site-1", entryId: "entry-1" }],
      },
    ],
    sites: [
      {
        id: "site-1",
        path: "src/index.ts",
        outcomes: [{ entryId: "entry-1", disposition: "accepted" }],
      },
    ],
  };
}

function emptyStore(): StoreShape {
  return { submissions: [], sites: [] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fixtureRoutes(options: {
  scanner: Pick<ProjectScanner, "listProjects">;
  service: Pick<ReviewCommentService, "getStoreFile"> & {
    getStateRevision(): number;
  };
  isEnabled: () => boolean;
  projectSetTtlMs?: number;
  now?: () => number;
}) {
  const sources = new ReviewInboxSources(
    options.service.getStoreFile,
    () => [],
    () => true,
  );
  return createReviewInboxRoutes({
    ...options,
    scanner: {
      ...options.scanner,
      readRetainedProjects: async () => ({
        projects: await options.scanner.listProjects(),
        complete: true,
        refreshing: false,
      }),
    },
    inbox: {
      get revision() {
        return options.service.getStateRevision();
      },
      read: (projects) => sources.read(projects),
    },
  });
}

function harness(options: { projects?: number } = {}) {
  const projectCount = options.projects ?? 200;
  const projects = Array.from({ length: projectCount }, (_, index) => ({
    id: `p${index}`,
    name: `Project ${index}`,
    path: `/projects/p${index}`,
  }));
  const counts = { listProjects: 0, storeLoads: 0 };
  const clock = { value: 1_000_000 };
  const unread = new Set(["/projects/p7"]);
  const sources = new ReviewInboxSources(
    async (path) => {
      counts.storeLoads++;
      return (unread.has(path)
        ? unreadStore(path)
        : emptyStore()) as unknown as StoreFile;
    },
    () => [],
    () => true,
    () => clock.value,
  );
  const app = new Hono();
  app.route(
    "/api",
    createReviewInboxRoutes({
      scanner: {
        readRetainedProjects: async () => {
          counts.listProjects++;
          return {
            projects: projects as unknown as ScannerProjects,
            complete: true,
            refreshing: false,
          };
        },
        listProjects: async () => {
          throw new Error("unexpected full project listing");
        },
      },
      inbox: sources,
      isEnabled: () => true,
      projectSetTtlMs: 5000,
      now: () => clock.value,
    }),
  );

  return {
    app,
    counts,
    clock,
    markUnread: (path: string) => {
      unread.add(path);
      sources.changed(path);
    },
    get: async (query = "") => {
      const response = await app.request(`/api/review/inbox${query}`);
      return (await response.json()) as { items: Array<{ projectId: string }> };
    },
  };
}

describe("review inbox retention", () => {
  it("builds the projection once for repeated unchanged requests", async () => {
    const test = harness({ projects: 200 });

    const first = await test.get();
    expect(first.items).toHaveLength(1);
    expect(test.counts.listProjects).toBe(1);
    expect(test.counts.storeLoads).toBe(200);

    await test.get();
    await test.get();

    expect(test.counts.listProjects).toBe(1);
    expect(test.counts.storeLoads).toBe(200);
  });

  it("serves concurrent requests from one build", async () => {
    const test = harness({ projects: 50 });

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => test.get()),
    );

    expect(responses.every((body) => body.items.length === 1)).toBe(true);
    expect(test.counts.listProjects).toBe(1);
    expect(test.counts.storeLoads).toBe(50);
  });

  it.each(["older-first", "newer-first"] as const)(
    "returns the newest projection when $completionOrder completes",
    async (completionOrder) => {
      const firstStarted = deferred<void>();
      const secondStarted = deferred<void>();
      const firstProjects = deferred<ScannerProjects>();
      const secondProjects = deferred<ScannerProjects>();
      let revision = 0;
      let listCalls = 0;
      const app = new Hono();
      app.route(
        "/api",
        fixtureRoutes({
          scanner: {
            listProjects: async () => {
              listCalls += 1;
              if (listCalls === 1) {
                firstStarted.resolve();
                return firstProjects.promise;
              }
              secondStarted.resolve();
              return secondProjects.promise;
            },
          },
          service: {
            getStoreFile: async (projectPath: string) =>
              unreadStore(
                projectPath.includes("new") ? "new" : "old",
              ) as unknown as StoreFile,
            getStateRevision: () => revision,
          },
          isEnabled: () => true,
          projectSetTtlMs: 5_000,
          now: () => 1_000_000,
        }),
      );
      const get = async (): Promise<{
        items: Array<{ projectId: string }>;
      }> => {
        const response = await app.request("/api/review/inbox");
        return response.json();
      };
      const oldProjects = [
        { id: "old", name: "Old", path: "/projects/old" },
      ] as unknown as ScannerProjects;
      const newProjects = [
        { id: "new", name: "New", path: "/projects/new" },
      ] as unknown as ScannerProjects;

      const oldRequest = get();
      await firstStarted.promise;
      revision = 1;
      const newRequest = get();
      await secondStarted.promise;

      if (completionOrder === "older-first") {
        let oldSettled = false;
        void oldRequest.then(() => {
          oldSettled = true;
        });
        firstProjects.resolve(oldProjects);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(oldSettled).toBe(false);
        expect(listCalls).toBe(2);
        secondProjects.resolve(newProjects);
      } else {
        secondProjects.resolve(newProjects);
        await expect(newRequest).resolves.toEqual({
          items: [expect.objectContaining({ projectId: "new" })],
        });
        firstProjects.resolve(oldProjects);
      }

      await expect(oldRequest).resolves.toEqual({
        items: [expect.objectContaining({ projectId: "new" })],
      });
      await expect(newRequest).resolves.toEqual({
        items: [expect.objectContaining({ projectId: "new" })],
      });
      expect(listCalls).toBe(2);
    },
  );

  it("follows the retained newer projection after an obsolete build fails", async () => {
    const oldStarted = deferred<void>();
    const oldProjects = deferred<ScannerProjects>();
    let revision = 0;
    let listCalls = 0;
    const app = new Hono();
    app.route(
      "/api",
      fixtureRoutes({
        scanner: {
          listProjects: async () => {
            listCalls += 1;
            if (listCalls === 1) {
              oldStarted.resolve();
              return oldProjects.promise;
            }
            return [
              { id: "new", name: "New", path: "/projects/new" },
            ] as unknown as ScannerProjects;
          },
        },
        service: {
          getStoreFile: async () => unreadStore("new") as unknown as StoreFile,
          getStateRevision: () => revision,
        },
        isEnabled: () => true,
        projectSetTtlMs: 5_000,
        now: () => 1_000_000,
      }),
    );

    const oldRequest = app.request("/api/review/inbox");
    await oldStarted.promise;
    revision = 1;
    const newResponse = await app.request("/api/review/inbox");
    expect(newResponse.status).toBe(200);
    await expect(newResponse.json()).resolves.toEqual({
      items: [expect.objectContaining({ projectId: "new" })],
    });

    oldProjects.reject(new Error("obsolete project read failed"));
    const oldResponse = await oldRequest;
    expect(oldResponse.status).toBe(200);
    await expect(oldResponse.json()).resolves.toEqual({
      items: [expect.objectContaining({ projectId: "new" })],
    });
    expect(listCalls).toBe(2);
  });

  it("propagates a failure from the current source version", async () => {
    let listCalls = 0;
    const app = new Hono();
    app.onError((error, c) => c.json({ error: error.message }, 500));
    app.route(
      "/api",
      fixtureRoutes({
        scanner: {
          listProjects: async () => {
            listCalls += 1;
            throw new Error("current project read failed");
          },
        },
        service: {
          getStoreFile: async () => emptyStore() as unknown as StoreFile,
          getStateRevision: () => 0,
        },
        isEnabled: () => true,
      }),
    );

    const response = await app.request("/api/review/inbox");

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "current project read failed",
    });
    expect(listCalls).toBe(1);
  });

  it("bounds retargeting when the source version never stabilizes", async () => {
    let revision = 0;
    let listCalls = 0;
    const app = new Hono();
    app.onError((error, c) => c.json({ error: error.message }, 500));
    app.route(
      "/api",
      fixtureRoutes({
        scanner: {
          listProjects: async () => {
            listCalls += 1;
            revision += 1;
            return [];
          },
        },
        service: {
          getStoreFile: async () => emptyStore() as unknown as StoreFile,
          getStateRevision: () => revision,
        },
        isEnabled: () => true,
        projectSetTtlMs: 5_000,
        now: () => 1_000_000,
      }),
    );

    const response = await app.request("/api/review/inbox");

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Review Inbox source version kept changing",
    });
    expect(listCalls).toBe(4);
  });

  it("rebuilds once after an accepted review mutation", async () => {
    const test = harness({ projects: 20 });
    await test.get();

    test.markUnread("/projects/p3");
    expect((await test.get()).items.map((i) => i.projectId)).toEqual([
      "p3",
      "p7",
    ]);
    await test.get();

    expect(test.counts.listProjects).toBe(2);
    expect(test.counts.storeLoads).toBe(22);
  });

  it("rebuilds after the project-set backstop window", async () => {
    const test = harness({ projects: 20 });
    await test.get();

    test.clock.value += 5_001;
    await test.get();

    expect(test.counts.listProjects).toBe(2);
  });

  it("rechecks previously empty projects after the presence window", async () => {
    const test = harness({ projects: 20 });
    await test.get();
    test.clock.value += 5001;
    await test.get();
    expect(test.counts.storeLoads).toBe(21);
    test.clock.value += 600001;
    await test.get();
    expect(test.counts.storeLoads).toBe(41);
  });

  it("a racing save invalidates only the affected project's in-flight empty result", async () => {
    const projects = ["a", "b"].map((id) => ({
      id,
      name: id,
      path: "/projects/" + id,
    }));
    const started = deferred<void>();
    const pending = deferred<StoreFile>();
    let calls = 0;
    const sources = new ReviewInboxSources(
      async (path) => {
        calls++;
        if (calls === 2) {
          started.resolve();
          return pending.promise;
        }
        return (calls > 2
          ? unreadStore(path)
          : emptyStore()) as unknown as StoreFile;
      },
      () => [],
      () => true,
    );
    const initial = sources.read(projects);
    await started.promise;
    sources.changed("/projects/./b");
    pending.resolve(emptyStore() as unknown as StoreFile);
    expect(await initial).toEqual([]);
    expect(await sources.read(projects)).toMatchObject([{ projectId: "b" }]);
    expect(calls).toBe(3);
  });

  it.each([{ complete: false }, { complete: true, refreshError: "failed" }])(
    "uses complete discovery when the retained view is unavailable (%j)",
    async (view) => {
      let listings = 0;
      const routes = createReviewInboxRoutes({
        scanner: {
          readRetainedProjects: async () => ({
            ...view,
            projects: [],
            refreshing: false,
          }),
          listProjects: async () => {
            listings++;
            return [];
          },
        },
        inbox: { revision: 0, read: async () => [] },
        isEnabled: () => true,
      });
      expect((await routes.request("/review/inbox")).status).toBe(200);
      expect(listings).toBe(1);
    },
  );

  it("filters by project without rebuilding the projection", async () => {
    const test = harness({ projects: 20 });
    await test.get();
    const loadsAfterFirst = test.counts.storeLoads;

    const matched = await test.get("?projectId=p7");
    const missed = await test.get("?projectId=p3");

    expect(matched.items.map((item) => item.projectId)).toEqual(["p7"]);
    expect(missed.items).toEqual([]);
    expect(test.counts.storeLoads).toBe(loadsAfterFirst);
    expect(test.counts.listProjects).toBe(1);
  });

  it("does no project or store work while the feature is disabled", async () => {
    const counts = { listProjects: 0, storeLoads: 0 };
    const app = new Hono();
    app.route(
      "/api",
      fixtureRoutes({
        scanner: {
          listProjects: async () => {
            counts.listProjects += 1;
            return [];
          },
        },
        service: {
          getStoreFile: async () => {
            counts.storeLoads += 1;
            return emptyStore() as unknown as StoreFile;
          },
          getStateRevision: () => 0,
        },
        isEnabled: () => false,
      }),
    );

    const response = await app.request("/api/review/inbox");

    expect(response.status).toBe(409);
    expect(counts).toEqual({ listProjects: 0, storeLoads: 0 });
  });
});
