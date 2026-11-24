import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  MAX_REVIEW_COMMENTS,
  type ReviewCommentAnchor,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ReviewCaptureService,
  SOURCE_REVIEW_CAPTURE_REF,
} from "../../src/review/ReviewCaptureService.js";
import {
  ReviewCommentService,
  type ReviewCommentServiceOptions,
} from "../../src/review/ReviewCommentService.js";
import { ProjectStoragePolicy } from "../../src/projects/projectStoragePolicy.js";

const execFileAsync = promisify(execFile);
const projectStoragePolicy = new ProjectStoragePolicy({
  dataDir: tmpdir(),
  getMode: () => "project",
});

function anchor(
  overrides: Partial<ReviewCommentAnchor> = {},
): ReviewCommentAnchor {
  return {
    path: "src/a.ts",
    revision: { kind: "uncommitted", savedAt: "2026-07-26T00:00:00Z" },
    side: "new",
    oldLine: null,
    newLine: 12,
    snippet: "added line",
    ...overrides,
  };
}

/** A service with a fixed clock and counter ids, for stable assertions. */
function makeService(extra: ReviewCommentServiceOptions = {}) {
  let n = 0;
  return new ReviewCommentService({
    now: () => "2026-07-26T12:00:00.000Z",
    newId: () => `id-${++n}`,
    storagePolicy: projectStoragePolicy,
    ...extra,
  });
}

describe("ReviewCommentService", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yep-review-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("adds a pending comment and lists it", async () => {
    const svc = makeService();
    const created = await svc.addComment(dir, {
      anchor: anchor(),
      text: "why?",
    });
    expect(created).toMatchObject({
      id: "id-1",
      text: "why?",
      status: "pending",
      createdAt: "2026-07-26T12:00:00.000Z",
    });
    const pending = await svc.listPending(dir);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe("id-1");
  });

  it("stores an exact capture at creation and refreshes it with an anchor edit", async () => {
    let captured = 0;
    const svc = makeService({
      captureWriter: {
        async capture(_projectPath, projection) {
          captured++;
          return {
            status: "captured",
            captureBlobId: String(captured).padStart(40, "a"),
            projection,
          };
        },
      },
    });
    const projected = anchor({
      projection: { kind: "worktree", path: "src/a.ts", side: "new" },
    });
    const created = await svc.addComment(dir, {
      anchor: projected,
      text: "captured",
    });
    await svc.updateComment(dir, created.id, {
      anchor: {
        ...projected,
        projection: { kind: "index", path: "src/a.ts", side: "new" },
      },
    });

    const entry = (await svc.getStoreFile(dir)).sites[0]?.entries[0];
    expect(captured).toBe(2);
    expect(entry?.capture).toMatchObject({
      status: "captured",
      projection: { kind: "index" },
    });
  });

  it("writes to {projectPath}/.yep/review-comments.json", async () => {
    const svc = makeService();
    await svc.addComment(dir, { anchor: anchor(), text: "x" });
    const raw = await readFile(
      join(dir, ".yep", "review-comments.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(2);
    expect(parsed.sites).toHaveLength(1);
    expect(parsed.drafts).toHaveLength(1);
  });

  it("keeps two projects' drafts isolated", async () => {
    const other = await mkdtemp(join(tmpdir(), "yep-review-b-"));
    try {
      const svc = makeService();
      await svc.addComment(dir, { anchor: anchor(), text: "in A" });
      expect(await svc.listComments(other)).toHaveLength(0);
      await svc.addComment(other, { anchor: anchor(), text: "in B" });
      expect(await svc.listComments(dir)).toHaveLength(1);
      expect(await svc.listComments(other)).toHaveLength(1);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("updates a pending comment's text; refuses unknown/archived", async () => {
    const svc = makeService();
    const created = await svc.addComment(dir, { anchor: anchor(), text: "a" });
    const updated = await svc.updateComment(dir, created.id, { text: "b" });
    expect(updated?.text).toBe("b");
    expect(await svc.updateComment(dir, "nope", { text: "z" })).toBeNull();

    await svc.archiveComments(dir, {
      commentIds: [created.id],
      targetSessionId: "sess-1",
    });
    // archived comments are frozen
    expect(await svc.updateComment(dir, created.id, { text: "c" })).toBeNull();
  });

  it("deletes a pending comment; delete is idempotent-false after", async () => {
    const svc = makeService();
    const created = await svc.addComment(dir, { anchor: anchor(), text: "a" });
    expect(await svc.deleteComment(dir, created.id)).toBe(true);
    expect(await svc.listComments(dir)).toHaveLength(0);
    expect(await svc.deleteComment(dir, created.id)).toBe(false);
  });

  it("archives pending comments into a batch that records its target", async () => {
    const svc = makeService();
    const c1 = await svc.addComment(dir, { anchor: anchor(), text: "one" });
    const c2 = await svc.addComment(dir, { anchor: anchor(), text: "two" });

    const batch = await svc.archiveComments(dir, {
      commentIds: [c1.id, c2.id],
      targetSessionId: "sess-42",
    });
    expect(batch.targetSessionId).toBe("sess-42");
    expect(batch.commentIds.sort()).toEqual([c1.id, c2.id].sort());

    expect(await svc.listPending(dir)).toHaveLength(0);
    const all = await svc.listComments(dir);
    for (const comment of all) {
      expect(comment.status).toBe("archived");
      expect(comment.batchId).toBe(batch.id);
      expect(comment.targetSessionId).toBe("sess-42");
      expect(comment.archivedAt).toBe("2026-07-26T12:00:00.000Z");
    }

    const file = await svc.getFile(dir);
    expect(file.batches).toHaveLength(1);
  });

  it("freezes, fsyncs, and accepts a client-keyed submission", async () => {
    const svc = makeService();
    const created = await svc.addComment(dir, {
      anchor: anchor(),
      text: "freeze this",
    });
    const relocation = {
      status: "relocated" as const,
      path: "src/a.ts",
      line: 12,
      snippet: "added line",
      currentSha: null,
      moved: false,
    };
    const request = await svc.prepareSubmission(dir, {
      submissionId: "submission-1",
      name: "Naming cleanup",
      commentIds: [created.id],
      requestedTarget: "new",
      relocations: new Map([[created.id, relocation]]),
    });

    expect(request).toMatchObject({
      version: 1,
      submissionId: "submission-1",
      name: "Naming cleanup",
      entries: [{ entryId: created.id, relocation }],
    });
    expect(await svc.listPending(dir)).toHaveLength(1);
    expect(
      JSON.parse(
        await readFile(
          join(dir, ".yep", "source-review", "submission-1", "request.json"),
          "utf-8",
        ),
      ),
    ).toEqual(request);

    const accepted = await svc.acceptSubmission(dir, {
      submissionId: "submission-1",
      deliveryStatus: "queued",
      responseTurnLimit: 8,
    });
    expect(accepted).toMatchObject({
      id: "submission-1",
      status: "accepted",
      deliveryStatus: "queued",
      responseTurnsObserved: 0,
      responseTurnLimit: 8,
    });
    expect(accepted?.targetSessionId).toBeUndefined();
    expect(await svc.listPending(dir)).toHaveLength(0);

    const delivered = await svc.acceptSubmission(dir, {
      submissionId: "submission-1",
      targetSessionId: "session-1",
      deliveryStatus: "delivered",
      responseTurnLimit: 8,
    });
    expect(delivered).toMatchObject({
      deliveryStatus: "delivered",
      targetSessionId: "session-1",
    });
  });

  it("recovers a prepared manifest across restart without changing it", async () => {
    const svc = makeService();
    const created = await svc.addComment(dir, {
      anchor: anchor(),
      text: "retry once",
    });
    const input = {
      submissionId: "submission-retry",
      commentIds: [created.id],
      requestedTarget: "session-1" as const,
      relocations: new Map([
        [
          created.id,
          {
            status: "gone" as const,
            path: "src/a.ts",
            citeSha: null,
            snippet: "added line",
          },
        ],
      ]),
    };
    const first = await svc.prepareSubmission(dir, input);
    const restarted = makeService();
    const retry = await restarted.prepareSubmission(dir, input);
    expect(retry).toEqual(first);
    expect((await restarted.getStoreFile(dir)).submissions).toHaveLength(1);
  });

  it("rebuilds a truncated unaccepted submission manifest", async () => {
    const svc = makeService();
    const created = await svc.addComment(dir, {
      anchor: anchor(),
      text: "retry after crash",
    });
    const input = {
      submissionId: "submission-truncated",
      commentIds: [created.id],
      requestedTarget: "session-1" as const,
      relocations: new Map([
        [
          created.id,
          {
            status: "gone" as const,
            path: "src/a.ts",
            citeSha: null,
            snippet: "added line",
          },
        ],
      ]),
    };
    const first = await svc.prepareSubmission(dir, input);
    await writeFile(svc.requestPathFor(dir, input.submissionId), "{", "utf-8");

    const restarted = makeService();
    const recovered = await restarted.prepareSubmission(dir, input);

    expect(recovered).toEqual(first);
    expect(
      JSON.parse(
        await readFile(
          restarted.requestPathFor(dir, input.submissionId),
          "utf-8",
        ),
      ),
    ).toEqual(first);
    expect((await restarted.getStoreFile(dir)).submissions).toHaveLength(1);
  });

  it("does not replace a truncated accepted submission manifest", async () => {
    const svc = makeService();
    const created = await svc.addComment(dir, {
      anchor: anchor(),
      text: "accepted history",
    });
    const input = {
      submissionId: "submission-accepted-truncated",
      commentIds: [created.id],
      requestedTarget: "session-1" as const,
      relocations: new Map([
        [
          created.id,
          {
            status: "gone" as const,
            path: "src/a.ts",
            citeSha: null,
            snippet: "added line",
          },
        ],
      ]),
    };
    await svc.prepareSubmission(dir, input);
    await svc.acceptSubmission(dir, {
      submissionId: input.submissionId,
      targetSessionId: "session-1",
      deliveryStatus: "delivered",
      responseTurnLimit: 8,
    });
    await writeFile(svc.requestPathFor(dir, input.submissionId), "{", "utf-8");

    const restarted = makeService();
    await expect(restarted.prepareSubmission(dir, input)).rejects.toThrow(
      "Submission request manifest is invalid",
    );
    expect(
      await readFile(
        restarted.requestPathFor(dir, input.submissionId),
        "utf-8",
      ),
    ).toBe("{");
  });

  it("archive consumes only currently-pending ids", async () => {
    const svc = makeService();
    const c1 = await svc.addComment(dir, { anchor: anchor(), text: "one" });
    await svc.archiveComments(dir, {
      commentIds: [c1.id],
      targetSessionId: "s1",
    });
    // Re-archiving the same (now archived) id consumes nothing.
    const second = await svc.archiveComments(dir, {
      commentIds: [c1.id, "ghost"],
      targetSessionId: "s2",
    });
    expect(second.commentIds).toEqual([]);
    // c1 stays with its original batch/target.
    const c1After = await svc.getComment(dir, c1.id);
    expect(c1After?.targetSessionId).toBe("s1");
  });

  it("survives a service restart (state persisted, cache dropped)", async () => {
    const svc = makeService();
    const c1 = await svc.addComment(dir, {
      anchor: anchor(),
      text: "persist me",
    });
    await svc.archiveComments(dir, {
      commentIds: [c1.id],
      targetSessionId: "s1",
    });

    // A brand-new instance = fresh in-memory cache, same files on disk.
    const restarted = makeService();
    const all = await restarted.listComments(dir);
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe("archived");
    expect((await restarted.getFile(dir)).batches).toHaveLength(1);
  });

  it.each(["project", "app-data"] as const)(
    "keeps dirty comment captures addressable through restart and Git GC in %s mode",
    async (mode) => {
      const dataDir = await mkdtemp(join(tmpdir(), "yep-review-data-"));
      const storagePolicy = new ProjectStoragePolicy({
        dataDir,
        getMode: () => mode,
      });
      try {
        await execFileAsync("git", ["-C", dir, "init"]);
        await mkdir(join(dir, "src"), { recursive: true });
        await writeFile(join(dir, "src", "a.ts"), "const original = 1;\n");
        await execFileAsync("git", ["-C", dir, "add", "--", "src/a.ts"]);
        await execFileAsync("git", [
          "-C",
          dir,
          "-c",
          "user.email=test@example.com",
          "-c",
          "user.name=Test",
          "commit",
          "-m",
          "fixture",
        ]);
        await writeFile(join(dir, "src", "a.ts"), "const reviewed = 2;\n");

        const captureWriter = new ReviewCaptureService({ storagePolicy });
        const service = makeService({ storagePolicy, captureWriter });
        const created = await service.addComment(dir, {
          anchor: anchor({
            path: "src/a.ts",
            newLine: 1,
            snippet: "const reviewed = 2;",
            projection: { kind: "worktree", path: "src/a.ts", side: "new" },
          }),
          text: "Keep this exact dirty version",
        });
        const capture = (await service.getStoreFile(dir)).sites[0]?.entries[0]
          ?.capture;
        expect(capture?.status).toBe("captured");
        if (capture?.status !== "captured") return;

        const statePath = storagePolicy.writePath(dir, "review-comments.json");
        expect(await readFile(statePath, "utf-8")).toContain(created.id);
        if (mode === "project") {
          await expect(
            readFile(
              storagePolicy.writePath(
                dir,
                "source-review",
                "captures",
                capture.captureBlobId,
              ),
            ),
          ).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          expect(
            await readFile(
              storagePolicy.writePath(
                dir,
                "source-review",
                "captures",
                capture.captureBlobId,
              ),
              "utf-8",
            ),
          ).toBe("const reviewed = 2;\n");
          await expect(
            readFile(join(dir, ".yep", "review-comments.json")),
          ).rejects.toMatchObject({ code: "ENOENT" });
        }

        await writeFile(join(dir, "src", "a.ts"), "const later = 3;\n");
        await execFileAsync("git", ["-C", dir, "gc", "--prune=now"]);

        const restartedCaptureReader = new ReviewCaptureService({
          storagePolicy,
        });
        const restarted = makeService({
          storagePolicy,
          captureWriter: restartedCaptureReader,
        });
        expect((await restarted.getComment(dir, created.id))?.text).toBe(
          "Keep this exact dirty version",
        );
        await expect(
          restartedCaptureReader.readExcerpt(dir, capture, {
            ...created.anchor,
            newLine: 1,
          }),
        ).resolves.toMatchObject({
          status: "captured",
          captureBlobId: capture.captureBlobId,
          content: "const reviewed = 2;\n",
          highlightLine: 1,
        });

        if (mode === "project") {
          await expect(
            execFileAsync("git", [
              "-C",
              dir,
              "cat-file",
              "-e",
              `${capture.captureBlobId}^{blob}`,
            ]),
          ).resolves.toBeTruthy();
          await expect(
            execFileAsync("git", [
              "-C",
              dir,
              "show-ref",
              "--verify",
              SOURCE_REVIEW_CAPTURE_REF,
            ]),
          ).resolves.toBeTruthy();
        } else {
          await expect(
            execFileAsync("git", [
              "-C",
              dir,
              "cat-file",
              "-e",
              `${capture.captureBlobId}^{blob}`,
            ]),
          ).rejects.toBeTruthy();
          await expect(
            execFileAsync("git", [
              "-C",
              dir,
              "show-ref",
              "--verify",
              SOURCE_REVIEW_CAPTURE_REF,
            ]),
          ).rejects.toBeTruthy();
        }
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    },
    // Real Git GC and disk persistence took 9.6 s on Ubuntu CI (45419932464).
    20_000,
  );

  it("reads legacy project state without copying it until a future write", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "yep-review-data-"));
    const storagePolicy = new ProjectStoragePolicy({
      dataDir,
      getMode: () => "app-data",
    });
    const legacyPath = join(dir, ".yep", "review-comments.json");
    await mkdir(join(dir, ".yep"), { recursive: true });
    await writeFile(
      legacyPath,
      JSON.stringify({
        version: 1,
        comments: [
          {
            id: "old-draft",
            anchor: anchor(),
            text: "legacy",
            status: "pending",
            createdAt: "2026-07-25T00:00:00Z",
          },
        ],
        batches: [],
      }),
    );

    try {
      const service = makeService({ storagePolicy });
      expect(await service.listComments(dir)).toHaveLength(1);
      const appDataPath = service.filePathFor(dir);
      await expect(readFile(appDataPath, "utf-8")).rejects.toMatchObject({
        code: "ENOENT",
      });

      await service.addComment(dir, { anchor: anchor(), text: "new" });
      expect(JSON.parse(await readFile(appDataPath, "utf-8")).version).toBe(2);
      expect(JSON.parse(await readFile(legacyPath, "utf-8")).version).toBe(1);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("migrates version-1 state before persisting another edit", async () => {
    await mkdir(join(dir, ".yep"), { recursive: true });
    await writeFile(
      join(dir, ".yep", "review-comments.json"),
      JSON.stringify({
        version: 1,
        comments: [
          {
            id: "old-draft",
            anchor: anchor(),
            text: "old pending",
            status: "pending",
            createdAt: "2026-07-25T00:00:00Z",
          },
          {
            id: "old-history",
            anchor: anchor(),
            text: "old archived",
            status: "archived",
            createdAt: "2026-07-24T00:00:00Z",
            archivedAt: "2026-07-25T00:00:00Z",
            batchId: "old-batch",
            targetSessionId: "old-session",
          },
        ],
        batches: [
          {
            id: "old-batch",
            submittedAt: "2026-07-25T00:00:00Z",
            targetSessionId: "old-session",
            commentIds: ["old-history"],
          },
        ],
      }),
    );

    const svc = makeService();
    expect(await svc.listComments(dir)).toHaveLength(2);
    const canonical = await svc.getStoreFile(dir);
    expect(canonical.version).toBe(2);
    expect(canonical.sites).toHaveLength(2);
    expect(canonical.submissions).toHaveLength(1);
    expect(canonical.sites[1]?.entries[0]?.capture).toEqual({
      status: "legacy-missing",
    });

    const beforeEdit = JSON.parse(
      await readFile(join(dir, ".yep", "review-comments.json"), "utf-8"),
    );
    expect(beforeEdit.version).toBe(1);

    await svc.addComment(dir, { anchor: anchor(), text: "new draft" });
    const persisted = JSON.parse(
      await readFile(join(dir, ".yep", "review-comments.json"), "utf-8"),
    );
    expect(persisted.version).toBe(2);
    expect(persisted.comments).toBeUndefined();
  });

  it("caps active drafts without counting archived history", async () => {
    const comments = Array.from(
      { length: MAX_REVIEW_COMMENTS },
      (_, index) => ({
        id: `archived-${index}`,
        anchor: anchor(),
        text: `history-${index}`,
        status: "archived",
        createdAt: "2026-07-25T00:00:00Z",
        archivedAt: "2026-07-26T00:00:00Z",
      }),
    );
    await mkdir(join(dir, ".yep"), { recursive: true });
    await writeFile(
      join(dir, ".yep", "review-comments.json"),
      JSON.stringify({ version: 1, comments, batches: [] }),
    );
    const svc = makeService();
    await svc.addComment(dir, { anchor: anchor(), text: "new" });
    expect(await svc.listPending(dir)).toHaveLength(1);
    expect((await svc.getStoreFile(dir)).sites).toHaveLength(
      MAX_REVIEW_COMMENTS + 1,
    );
  });

  it("degrades a corrupt drafts file to an empty store", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await mkdir(join(dir, ".yep"), { recursive: true });
    await writeFile(
      join(dir, ".yep", "review-comments.json"),
      "{ not valid json",
      "utf-8",
    );
    const svc = makeService();
    expect(await svc.listComments(dir)).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    // and it can recover by writing fresh state
    await svc.addComment(dir, { anchor: anchor(), text: "fresh" });
    expect(await svc.listComments(dir)).toHaveLength(1);
    warn.mockRestore();
  });

  describe("git exclude on first visit", () => {
    async function initRepo(repoDir: string): Promise<void> {
      await execFileAsync("git", ["-C", repoDir, "init"]);
    }
    async function readExclude(repoDir: string): Promise<string> {
      try {
        return await readFile(
          join(repoDir, ".git", "info", "exclude"),
          "utf-8",
        );
      } catch {
        return "";
      }
    }

    it("excludes .yep/ when it creates the dir in a git repo", async () => {
      await initRepo(dir);
      const svc = makeService();
      await svc.addComment(dir, { anchor: anchor(), text: "x" });
      expect(await readExclude(dir)).toContain(".yep/");
    });

    it("leaves an existing .yep/ alone (respects a user un-exclude)", async () => {
      await initRepo(dir);
      // Simulate a project that deliberately keeps .yep/ (dir already present,
      // not excluded): the service must not add an exclude entry.
      await mkdir(join(dir, ".yep"), { recursive: true });
      const svc = makeService();
      await svc.addComment(dir, { anchor: anchor(), text: "x" });
      expect(await readExclude(dir)).not.toContain(".yep/");
    });

    it("does not fail draft writes outside a git repo", async () => {
      const svc = makeService();
      await expect(
        svc.addComment(dir, { anchor: anchor(), text: "x" }),
      ).resolves.toBeTruthy();
    });
  });
});

describe("ReviewCommentService draft cap", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yep-review-cap-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses a comment past MAX_REVIEW_COMMENTS with a 413 HttpError", async () => {
    const service = makeService();
    // Seed the store at the cap via the persisted file — the load parser
    // accepts exactly MAX_REVIEW_COMMENTS entries, so one more must refuse
    // rather than persist a draft the next load would silently drop.
    const comments = Array.from({ length: MAX_REVIEW_COMMENTS }, (_, i) => ({
      id: `seed-${i}`,
      anchor: anchor(),
      text: `c${i}`,
      status: "pending",
      createdAt: "2026-07-26T00:00:00Z",
    }));
    await mkdir(join(dir, ".yep"), { recursive: true });
    await writeFile(
      join(dir, ".yep", "review-comments.json"),
      JSON.stringify({ version: 1, comments, batches: [] }),
    );

    await expect(
      service.addComment(dir, { anchor: anchor(), text: "one too many" }),
    ).rejects.toMatchObject({ name: "HttpError", status: 413 });
  });
});
