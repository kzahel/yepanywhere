import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ReviewCommentAnchor } from "@yep-anywhere/shared";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { ProjectStoragePolicy } from "../../src/projects/projectStoragePolicy.js";
import { ReviewCommentService } from "../../src/review/ReviewCommentService.js";
import { ReviewCaptureService } from "../../src/review/ReviewCaptureService.js";
import { createReviewInboxRoutes } from "../../src/routes/review-inbox.js";
import { createReviewSubmissionsRoutes } from "../../src/routes/review-submissions.js";
import type { Project } from "../../src/supervisor/types.js";

const execFileAsync = promisify(execFile);

function anchor(captured = false): ReviewCommentAnchor {
  return {
    path: "src/a.ts",
    revision: { kind: "uncommitted", savedAt: "2026-08-01T00:00:00Z" },
    side: "new",
    oldLine: null,
    newLine: 3,
    snippet: "line",
    ...(captured
      ? {
          projection: {
            kind: "worktree" as const,
            path: "src/a.ts",
            side: "new" as const,
          },
        }
      : {}),
  };
}

function projectFor(projectPath: string): Project {
  return {
    id: toUrlProjectId(projectPath),
    path: projectPath,
    name: "fixture",
    sessionCount: 0,
    sessionDir: join(projectPath, ".sessions"),
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
  };
}

describe("review submission routes", () => {
  let dir: string;
  let project: Project;
  let scanner: ProjectScanner;
  let service: ReviewCommentService;
  let captureService: ReviewCaptureService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yep-review-submission-route-"));
    project = projectFor(dir);
    scanner = {
      async getProject(id: string) {
        return id === project.id ? project : null;
      },
      async listProjects() {
        return [project];
      },
    } as unknown as ProjectScanner;
    await execFileAsync("git", ["-C", dir, "init"]);
    await execFileAsync("git", [
      "-C",
      dir,
      "config",
      "user.email",
      "test@example.com",
    ]);
    await execFileAsync("git", ["-C", dir, "config", "user.name", "Test"]);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "a.ts"), "before\nother\nline\nafter\n");
    await execFileAsync("git", ["-C", dir, "add", "--", "src/a.ts"]);
    await execFileAsync("git", ["-C", dir, "commit", "-m", "fixture"]);
    captureService = new ReviewCaptureService();
    service = new ReviewCommentService({ captureWriter: captureService });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("pages submission summaries and returns canonical site detail", async () => {
    const comment = await service.addComment(dir, {
      anchor: anchor(),
      text: "review this",
    });
    const batch = await service.archiveComments(dir, {
      commentIds: [comment.id],
      targetSessionId: "session-1",
    });
    const routes = createReviewSubmissionsRoutes({
      scanner,
      service,
      captureReader: captureService,
      isEnabled: () => true,
    });

    const list = await routes.request(
      `/${project.id}/review/submissions?limit=1&includeSiteStates=1`,
    );
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      submissions: [{ id: batch.id, targetSessionId: "session-1" }],
      nextCursor: null,
      siteStates: [
        {
          siteId: expect.any(String),
          path: "src/a.ts",
          state: "open",
          changeStatus: "unavailable",
        },
      ],
    });

    const detail = await routes.request(
      `/${project.id}/review/submissions/${batch.id}`,
    );
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody.sites[0].entries[0]).toMatchObject({
      id: comment.id,
      capture: { status: "legacy-missing" },
    });
  });

  it("creates fresh follow-ups, resolves sites, and acknowledges explicitly", async () => {
    const comment = await service.addComment(dir, {
      anchor: anchor(),
      text: "first",
    });
    const submissionId = "submission-1";
    await service.prepareSubmission(dir, {
      submissionId,
      commentIds: [comment.id],
      requestedTarget: "session-1",
      relocations: new Map([
        [
          comment.id,
          {
            status: "relocated" as const,
            path: "src/a.ts",
            line: 3,
            snippet: "line",
            currentSha: null,
            moved: false,
          },
        ],
      ]),
    });
    const batch = await service.acceptSubmission(dir, {
      submissionId,
      targetSessionId: "session-1",
      deliveryStatus: "delivered",
      responseTurnLimit: 8,
    });
    if (!batch) throw new Error("fixture submission was not accepted");
    const siteId = (await service.getStoreFile(dir)).sites[0]!.id;
    const routes = createReviewSubmissionsRoutes({
      scanner,
      service,
      captureReader: captureService,
      isEnabled: () => true,
    });

    const resolved = await routes.request(
      `/${project.id}/review/sites/${siteId}/resolve`,
      { method: "POST" },
    );
    expect(resolved.status).toBe(200);

    const followUp = await routes.request(
      `/${project.id}/review/sites/${siteId}/follow-ups`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "please revisit" }),
      },
    );
    expect(followUp.status).toBe(201);
    const store = await service.getStoreFile(dir);
    expect(store.sites[0]?.entries).toHaveLength(2);
    expect(store.sites[0]?.entries[1]?.capture.status).toBe("captured");
    expect(store.sites[0]?.resolvedAt).toBeUndefined();
    expect(store.drafts).toHaveLength(1);

    await expect(service.resolveSite(dir, siteId)).rejects.toMatchObject({
      status: 409,
    });

    const detail = await routes.request(
      `/${project.id}/review/submissions/${batch.id}`,
    );
    expect(await detail.json()).toMatchObject({
      capturedSources: [
        {
          changeStatus: "unavailable",
          source: { status: "legacy-missing" },
        },
        {
          entryId: store.sites[0]?.entries[1]?.id,
          changeStatus: "unchanged",
          source: {
            status: "captured",
            content: expect.stringContaining("line"),
          },
        },
      ],
    });

    const acknowledged = await routes.request(
      `/${project.id}/review/submissions/${batch.id}/acknowledge`,
      { method: "POST" },
    );
    expect(acknowledged.status).toBe(200);

    const refreshed = await routes.request(
      `/${project.id}/review/submissions/${batch.id}/refresh-response`,
      { method: "POST" },
    );
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toMatchObject({ responseStatus: "missing" });
  });

  it("rejects the new workflow while its server setting is off", async () => {
    const routes = createReviewSubmissionsRoutes({
      scanner,
      service,
      captureReader: captureService,
      isEnabled: () => false,
    });
    const response = await routes.request(`/${project.id}/review/submissions`);
    expect(response.status).toBe(409);
  });

  it("lists unread submissions globally without acknowledging them", async () => {
    await mkdir(join(dir, ".yep"), { recursive: true });
    await writeFile(
      join(dir, ".yep", "review-comments.json"),
      JSON.stringify({
        version: 2,
        sites: [
          {
            id: "site-1",
            path: "src/a.ts",
            createdAt: "2026-08-01T09:00:00Z",
            entries: [
              {
                id: "entry-1",
                text: "Review this",
                anchor: anchor(),
                capture: { status: "legacy-missing" },
                createdAt: "2026-08-01T09:00:00Z",
                submittedAt: "2026-08-01T10:00:00Z",
                submissionId: "unread-1",
              },
            ],
            outcomes: [
              {
                submissionId: "unread-1",
                entryId: "entry-1",
                disposition: "wont_fix",
                text: "The compatibility contract requires this shape.",
                observedAt: "2026-08-01T10:05:00Z",
                responseHash: "a".repeat(64),
                sessionId: "session-1",
              },
            ],
          },
        ],
        drafts: [],
        submissions: [
          {
            id: "unread-1",
            name: "Check source review",
            submittedAt: "2026-08-01T10:00:00Z",
            requestedTarget: "session-1",
            targetSessionId: "session-1",
            entryRefs: [{ siteId: "site-1", entryId: "entry-1" }],
            status: "accepted",
            responseRevision: 2,
            acknowledgedRevision: 1,
          },
        ],
      }),
    );
    const storagePolicy = new ProjectStoragePolicy({
      dataDir: join(dir, "app-data"),
      getMode: () => "app-data",
    });
    const paths = vi.spyOn(storagePolicy, "readPaths");
    const inboxService = new ReviewCommentService({
      storagePolicy,
      maxRetainedStoreBytes: 1,
    });
    const empty = Array.from({ length: 250 }, (_, i) =>
      projectFor(join(dir, "empty-" + i)),
    );
    let visible = [...empty];
    let now = 0;
    const routes = createReviewInboxRoutes({
      scanner: {
        readRetainedProjects: async () => ({
          projects: visible,
          complete: true,
          refreshing: false,
        }),
        listProjects: async () => {
          throw new Error("unexpected full project scan");
        },
      },
      now: () => now,
      inbox: inboxService.inbox,
      isEnabled: () => true,
    });

    const read = async () => (await routes.request("/review/inbox")).json();
    expect(await read()).toEqual({ items: [] });
    expect(inboxService.getRetentionMetrics().retainedStores).toBe(0);
    expect(paths).toHaveBeenCalledTimes(250);
    paths.mockClear();
    now += 5000;
    expect(await read()).toEqual({ items: [] });
    expect(paths).not.toHaveBeenCalled();
    visible.push(project);
    now += 5000;
    const response = await routes.request("/review/inbox");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [
        {
          projectId: project.id,
          submissionId: "unread-1",
          responseRevision: 2,
          outcomes: [
            {
              siteId: "site-1",
              path: "src/a.ts",
              disposition: "wont_fix",
              text: "The compatibility contract requires this shape.",
            },
          ],
        },
      ],
    });
    expect(
      (await inboxService.getStoreFile(dir)).submissions[0]
        ?.acknowledgedRevision,
    ).toBe(1);
    expect(inboxService.getRetentionMetrics().retainedStores).toBe(1);
    await inboxService.getStoreFile(empty[0]!.path);
    expect(inboxService.getRetentionMetrics().releases).toBeGreaterThan(0);
    visible = [{ ...project, name: "Renamed" }];
    now += 5000;
    expect(await read()).toMatchObject({ items: [{ projectName: "Renamed" }] });
    await inboxService.acknowledgeSubmission(dir, "unread-1");
    expect(await read()).toEqual({ items: [] });
  });
});
