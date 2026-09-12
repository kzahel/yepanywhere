import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewCommentAnchor } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectStoragePolicy } from "../../src/projects/projectStoragePolicy.js";
import { ReviewCommentService } from "../../src/review/ReviewCommentService.js";
import type { ProjectDirectoryStorage } from "../../src/services/ServerSettingsService.js";

function anchor(path = "src/a.ts"): ReviewCommentAnchor {
  return {
    path,
    revision: { kind: "uncommitted", savedAt: "2026-08-06T00:00:00Z" },
    side: "new",
    oldLine: null,
    newLine: 1,
    snippet: "const value = 1;",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

describe("Source Review storage transitions", () => {
  let projectPath: string;
  let dataDir: string;
  let outsidePath: string;
  let mode: ProjectDirectoryStorage;
  let policy: ProjectStoragePolicy;

  beforeEach(async () => {
    projectPath = await mkdtemp(
      join(tmpdir(), "ya-review-transition-project-"),
    );
    dataDir = await mkdtemp(join(tmpdir(), "ya-review-transition-data-"));
    outsidePath = await mkdtemp(
      join(tmpdir(), "ya-review-transition-outside-"),
    );
    mode = "app-data";
    policy = new ProjectStoragePolicy({ dataDir, getMode: () => mode });
  });

  afterEach(async () => {
    await Promise.all(
      [projectPath, dataDir, outsidePath].map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  function makeService() {
    return new ReviewCommentService({
      storagePolicy: policy,
      listProjectPaths: async () => [projectPath],
    });
  }

  async function changeMode(targetMode: ProjectDirectoryStorage) {
    return policy.transitionMode(targetMode, async () => {
      mode = targetMode;
      return targetMode;
    });
  }

  it("preserves the newest logical revision across repeated toggles", async () => {
    const service = makeService();
    policy.registerTransitionParticipant(service);

    await service.addComment(projectPath, { anchor: anchor(), text: "app A" });
    await changeMode("project");
    await service.addComment(projectPath, {
      anchor: anchor("src/b.ts"),
      text: "project B",
    });
    await changeMode("app-data");
    await service.addComment(projectPath, {
      anchor: anchor("src/c.ts"),
      text: "app C",
    });
    await changeMode("project");

    const restarted = makeService();
    expect(
      (await restarted.listComments(projectPath)).map(
        (comment) => comment.text,
      ),
    ).toEqual(["app A", "project B", "app C"]);

    const appDataState = JSON.parse(
      await readFile(
        policy.writePathFor("app-data", projectPath, "review-comments.json"),
        "utf-8",
      ),
    ) as { yaStorage: { logicalRevision: number } };
    const projectState = JSON.parse(
      await readFile(
        policy.writePathFor("project", projectPath, "review-comments.json"),
        "utf-8",
      ),
    ) as { yaStorage: { logicalRevision: number } };
    expect(projectState.yaStorage.logicalRevision).toBe(
      appDataState.yaStorage.logicalRevision,
    );
    await expect(stat(policy.transitionJournalPath())).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("retries an interrupted transition from the old selected mode", async () => {
    const service = makeService();
    policy.registerTransitionParticipant(service);
    await service.addComment(projectPath, { anchor: anchor(), text: "before" });

    await expect(
      policy.transitionMode("project", async () => {
        throw new Error("settings persistence failed");
      }),
    ).rejects.toThrow("settings persistence failed");
    expect(mode).toBe("app-data");
    await expect(stat(policy.transitionJournalPath())).resolves.toBeTruthy();

    await service.addComment(projectPath, {
      anchor: anchor("src/after.ts"),
      text: "after failed toggle",
    });
    await changeMode("project");

    const restarted = makeService();
    expect(
      (await restarted.listComments(projectPath)).map(
        (comment) => comment.text,
      ),
    ).toEqual(["before", "after failed toggle"]);
    await expect(stat(policy.transitionJournalPath())).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects equal-revision divergence before persisting the new mode", async () => {
    const original = makeService();
    const unregister = policy.registerTransitionParticipant(original);
    await original.addComment(projectPath, {
      anchor: anchor(),
      text: "authoritative",
    });
    await expect(
      policy.transitionMode("project", async () => {
        throw new Error("interrupt after destination copy");
      }),
    ).rejects.toThrow("interrupt after destination copy");
    unregister();

    const projectFile = policy.writePathFor(
      "project",
      projectPath,
      "review-comments.json",
    );
    const divergent = JSON.parse(await readFile(projectFile, "utf-8")) as {
      sites: Array<{ entries: Array<{ text: string }> }>;
      yaStorage: { stateSha256: string };
      [key: string]: unknown;
    };
    const firstEntry = divergent.sites[0]?.entries[0];
    if (!firstEntry) throw new Error("missing fixture entry");
    firstEntry.text = "divergent";
    const { yaStorage, ...state } = divergent;
    yaStorage.stateSha256 = createHash("sha256")
      .update(JSON.stringify(state))
      .digest("hex");
    await writeFile(
      projectFile,
      `${JSON.stringify({ ...state, yaStorage }, null, 2)}\n`,
      "utf-8",
    );

    const restarted = makeService();
    await expect(restarted.listComments(projectPath)).rejects.toThrow(
      "conflicting copies at the same logical revision",
    );
    policy.registerTransitionParticipant(restarted);
    let persisted = false;
    await expect(
      policy.transitionMode("project", async () => {
        persisted = true;
        mode = "project";
      }),
    ).rejects.toThrow("conflicting copies at the same logical revision");
    expect(persisted).toBe(false);
    expect(mode).toBe("app-data");
  });

  it("waits for an active review writer before copying and committing", async () => {
    const captureStarted = deferred<void>();
    const captureFinished = deferred<{
      status: "captured";
      captureBlobId: string;
      projection: { kind: "worktree"; path: string; side: "new" };
    }>();
    const service = new ReviewCommentService({
      storagePolicy: policy,
      listProjectPaths: async () => [projectPath],
      captureWriter: {
        capture: async () => {
          captureStarted.resolve();
          return captureFinished.promise;
        },
      },
    });
    policy.registerTransitionParticipant(service);
    const projection = {
      kind: "worktree" as const,
      path: "src/deferred.ts",
      side: "new" as const,
    };
    const writing = service.addComment(projectPath, {
      anchor: { ...anchor(projection.path), projection },
      text: "deferred writer",
    });
    await captureStarted.promise;

    let committed = false;
    const transitioning = policy.transitionMode("project", async () => {
      committed = true;
      mode = "project";
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(committed).toBe(false);

    captureFinished.resolve({
      status: "captured",
      captureBlobId: "a".repeat(40),
      projection,
    });
    await Promise.all([writing, transitioning]);
    expect(mode).toBe("project");
    expect((await makeService().listComments(projectPath))[0]?.text).toBe(
      "deferred writer",
    );
  });

  it("keeps an existing submission pinned to its manifest directory", async () => {
    const service = makeService();
    policy.registerTransitionParticipant(service);
    const comment = await service.addComment(projectPath, {
      anchor: anchor(),
      text: "review request",
    });
    const submissionId = "submission-pinned";
    await service.prepareSubmission(projectPath, {
      submissionId,
      commentIds: [comment.id],
      requestedTarget: "new",
      relocations: new Map([
        [
          comment.id,
          {
            status: "relocated",
            path: comment.anchor.path,
            line: 1,
            snippet: comment.anchor.snippet,
            currentSha: null,
            moved: false,
          },
        ],
      ]),
    });
    const appDataDirectory = policy.writePathFor(
      "app-data",
      projectPath,
      "source-review",
      submissionId,
    );
    expect(
      await service.existingSubmissionDirectoryFor(projectPath, submissionId),
    ).toBe(appDataDirectory);

    await changeMode("project");

    expect(
      await service.existingSubmissionDirectoryFor(projectPath, submissionId),
    ).toBe(appDataDirectory);
    await expect(
      stat(
        policy.writePathFor(
          "project",
          projectPath,
          "source-review",
          submissionId,
          "request.json",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not materialize storage for a scanned project with no state", async () => {
    const service = makeService();
    policy.registerTransitionParticipant(service);

    await changeMode("project");

    await expect(stat(join(projectPath, ".yep"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps the old mode selected when the destination is unsafe", async () => {
    const service = makeService();
    policy.registerTransitionParticipant(service);
    await service.addComment(projectPath, { anchor: anchor(), text: "safe" });
    await symlink(
      outsidePath,
      join(projectPath, ".yep"),
      process.platform === "win32" ? "junction" : "dir",
    );
    let persisted = false;

    await expect(
      policy.transitionMode("project", async () => {
        persisted = true;
        mode = "project";
      }),
    ).rejects.toThrow("symlinked project storage path");
    expect(persisted).toBe(false);
    expect(mode).toBe("app-data");
  });
});
