import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewCommentAnchor } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectStoragePolicy } from "../../src/projects/projectStoragePolicy.js";
import {
  ReviewCommentService,
  type ReviewCommentServiceOptions,
} from "../../src/review/ReviewCommentService.js";

const projectStoragePolicy = new ProjectStoragePolicy({
  dataDir: tmpdir(),
  getMode: () => "project",
});

function anchor(path: string): ReviewCommentAnchor {
  return {
    path,
    revision: { kind: "uncommitted", savedAt: "2026-07-26T00:00:00Z" },
    side: "new",
    oldLine: null,
    newLine: 12,
    snippet: "added line",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("review store retention", () => {
  let root: string;
  let clock: { value: number };
  const projects: string[] = [];

  function makeService(
    extra: ReviewCommentServiceOptions = {},
  ): ReviewCommentService {
    let n = 0;
    return new ReviewCommentService({
      now: () => "2026-07-26T12:00:00.000Z",
      newId: () => `id-${++n}`,
      storagePolicy: projectStoragePolicy,
      monotonicNowMs: () => clock.value,
      ...extra,
    });
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "yep-review-retention-"));
    clock = { value: 1_000_000 };
    projects.length = 0;
    for (let index = 0; index < 6; index += 1) {
      const path = join(root, `p${index}`);
      await mkdir(path, { recursive: true });
      projects.push(path);
    }
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("releases clean stores once past the byte budget", async () => {
    const service = makeService({ maxRetainedStoreBytes: 1 });

    for (const project of projects) {
      await service.getStoreFile(project);
    }

    const metrics = service.getRetentionMetrics();
    // Only the store touched by the last call is pinned.
    expect(metrics.retainedStores).toBe(1);
    expect(metrics.releases).toBe(projects.length - 1);
  });

  it("keeps every store while it fits the budget", async () => {
    const service = makeService({ maxRetainedStoreBytes: 8 * 1024 * 1024 });

    for (const project of projects) {
      await service.getStoreFile(project);
    }

    const metrics = service.getRetentionMetrics();
    expect(metrics.retainedStores).toBe(projects.length);
    expect(metrics.releases).toBe(0);
  });

  it("releases a store untouched past the age budget", async () => {
    const service = makeService({ maxRetainedStoreAgeMs: 60_000 });
    const [first, second] = projects as [string, string];
    await service.getStoreFile(first);

    clock.value += 60_001;
    await service.getStoreFile(second);

    const metrics = service.getRetentionMetrics();
    expect(metrics.releasesByAge).toBe(1);
    expect(metrics.retainedStores).toBe(1);
  });

  it("preserves state through a release and reload", async () => {
    const service = makeService({ maxRetainedStoreBytes: 1 });
    const [first, second] = projects as [string, string];

    const added = await service.addComment(first, {
      anchor: anchor("src/a.ts"),
      text: "please rename",
    });
    // Touching another project evicts the first under a 1-byte budget.
    await service.getStoreFile(second);
    expect(service.getRetentionMetrics().releases).toBeGreaterThan(0);

    const reloaded = await service.listComments(first);
    expect(reloaded.map((comment) => comment.text)).toEqual(["please rename"]);
    expect(reloaded[0]?.id).toBe(added.id);
    expect(service.getRetentionMetrics().reloadsAfterRelease).toBeGreaterThan(
      0,
    );
  });

  it("pins deferred capture and its competing mutation under eviction pressure", async () => {
    const captureStarted = deferred<void>();
    const captureFinished = deferred<{
      status: "captured";
      captureBlobId: string;
      projection: { kind: "worktree"; path: string; side: "new" };
    }>();
    const service = makeService({
      maxRetainedStoreBytes: 1,
      captureWriter: {
        async capture() {
          captureStarted.resolve();
          return captureFinished.promise;
        },
      },
    });
    const [first, second] = projects as [string, string];
    const projectedAnchor = {
      ...anchor("src/a.ts"),
      projection: {
        kind: "worktree" as const,
        path: "src/a.ts",
        side: "new" as const,
      },
    };

    const deferredMutation = service.addComment(first, {
      anchor: projectedAnchor,
      text: "capturing",
    });
    await captureStarted.promise;

    // Loading another project enforces the one-byte budget while the first
    // store is awaiting its capture. A second mutation must queue on that same
    // pinned owner rather than reloading a competing copy from disk.
    await service.getStoreFile(second);
    expect(service.getRetentionMetrics().retainedStores).toBe(2);
    let competingSettled = false;
    const competingMutation = service
      .addComment(first, {
        anchor: anchor("src/b.ts"),
        text: "queued behind capture",
      })
      .finally(() => {
        competingSettled = true;
      });
    await Promise.resolve();
    expect(competingSettled).toBe(false);

    captureFinished.resolve({
      status: "captured",
      captureBlobId: "a".repeat(40),
      projection: projectedAnchor.projection,
    });
    await Promise.all([deferredMutation, competingMutation]);

    const restarted = makeService({ maxRetainedStoreBytes: 1 });
    expect(
      (await restarted.listComments(first)).map((comment) => comment.text),
    ).toEqual(["capturing", "queued behind capture"]);
  });

  it("reloads filesystem state after a mutation save fails", async () => {
    const dataDir = join(root, "app-data");
    const displacedDataDir = join(root, "app-data-before-failure");
    await mkdir(dataDir);
    const service = makeService({
      storagePolicy: new ProjectStoragePolicy({
        dataDir,
        getMode: () => "app-data",
      }),
    });
    const [first] = projects as [string];

    await service.addComment(first, {
      anchor: anchor("src/durable.ts"),
      text: "durable",
    });
    await rename(dataDir, displacedDataDir);
    await writeFile(dataDir, "not a directory", "utf-8");

    const failedMutations = await Promise.allSettled([
      service.addComment(first, {
        anchor: anchor("src/failed.ts"),
        text: "must not remain in memory",
      }),
      service.addComment(first, {
        anchor: anchor("src/queued.ts"),
        text: "must not run on the failed owner",
      }),
    ]);
    expect(failedMutations.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);

    await rm(dataDir);
    await rename(displacedDataDir, dataDir);
    expect(
      (await service.listComments(first)).map((comment) => comment.text),
    ).toEqual(["durable"]);
    expect(service.getRetentionMetrics().reloadsAfterRelease).toBeGreaterThan(
      0,
    );
  });

  it("bumps the state revision only on accepted mutations", async () => {
    const service = makeService();
    const [first] = projects as [string];

    const before = service.inbox.revision;
    await service.getStoreFile(first);
    expect(service.inbox.revision).toBe(before);

    await service.addComment(first, {
      anchor: anchor("src/a.ts"),
      text: "changes state",
    });
    expect(service.inbox.revision).toBeGreaterThan(before);
  });
});
