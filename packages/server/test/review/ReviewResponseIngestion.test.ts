import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewCommentAnchor } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReviewCommentService } from "../../src/review/ReviewCommentService.js";

function anchor(path: string): ReviewCommentAnchor {
  return {
    path,
    revision: { kind: "uncommitted", savedAt: "2026-08-01T00:00:00Z" },
    side: "new",
    oldLine: 1,
    newLine: 1,
    snippet: "const value = 1;",
  };
}

function service() {
  let id = 0;
  let tick = 0;
  return new ReviewCommentService({
    newId: () => `entry-${++id}`,
    now: () => `2026-08-01T00:00:${String(++tick).padStart(2, "0")}.000Z`,
  });
}

async function accept(
  svc: ReviewCommentService,
  projectPath: string,
  submissionId: string,
  sessionId: string,
  responseTurnLimit = 8,
) {
  const entries = await acceptEntries(
    svc,
    projectPath,
    submissionId,
    sessionId,
    1,
    responseTurnLimit,
  );
  const entry = entries[0];
  if (!entry) throw new Error("fixture request has no entry");
  return entry;
}

async function acceptEntries(
  svc: ReviewCommentService,
  projectPath: string,
  submissionId: string,
  sessionId: string,
  count: number,
  responseTurnLimit = 8,
  acceptedSessionId: string | null = sessionId,
) {
  const comments = [];
  for (let index = 0; index < count; index++) {
    comments.push(
      await svc.addComment(projectPath, {
        anchor: anchor(`src/${submissionId}-${index}.ts`),
        text: `Review ${submissionId} ${index}`,
      }),
    );
  }
  const request = await svc.prepareSubmission(projectPath, {
    submissionId,
    commentIds: comments.map((comment) => comment.id),
    requestedTarget: sessionId,
    relocations: new Map(
      comments.map((comment) => [
        comment.id,
        {
          status: "relocated" as const,
          path: comment.anchor.path,
          line: 1,
          snippet: comment.anchor.snippet,
          currentSha: null,
          moved: false,
        },
      ]),
    ),
  });
  await svc.acceptSubmission(projectPath, {
    submissionId,
    ...(acceptedSessionId ? { targetSessionId: acceptedSessionId } : {}),
    deliveryStatus: "delivered",
    responseTurnLimit,
  });
  return request.entries;
}

async function writeResponse(
  svc: ReviewCommentService,
  projectPath: string,
  submissionId: string,
  response: unknown,
) {
  await mkdir(svc.submissionDirectoryFor(projectPath, submissionId), {
    recursive: true,
  });
  await writeFile(
    svc.responsePathFor(projectPath, submissionId),
    JSON.stringify(response),
  );
}

describe("review response ingestion", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yep-review-response-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("accepts only complete snapshots and appends changed outcomes", async () => {
    const svc = service();
    const entry = await accept(svc, dir, "submission-1", "session-1");
    const complete = {
      version: 1,
      submissionId: "submission-1",
      outcomes: [
        {
          siteId: entry.siteId,
          entryId: entry.entryId,
          disposition: "done",
          text: "Implemented the requested change.",
        },
      ],
    };
    await writeResponse(svc, dir, "submission-1", complete);
    await expect(svc.observeAssistantTurn(dir, "session-1")).resolves.toEqual([
      { submissionId: "submission-1", status: "ingested" },
    ]);
    await expect(svc.observeAssistantTurn(dir, "session-1")).resolves.toEqual([
      { submissionId: "submission-1", status: "unchanged" },
    ]);

    await writeResponse(svc, dir, "submission-1", {
      ...complete,
      outcomes: [],
    });
    await expect(svc.observeAssistantTurn(dir, "session-1")).resolves.toEqual([
      { submissionId: "submission-1", status: "invalid" },
    ]);
    await writeFile(svc.responsePathFor(dir, "submission-1"), "{not json");
    await expect(svc.observeAssistantTurn(dir, "session-1")).resolves.toEqual([
      { submissionId: "submission-1", status: "invalid" },
    ]);
    await writeFile(
      svc.responsePathFor(dir, "submission-1"),
      "x".repeat(256 * 1024 + 1),
    );
    await expect(svc.observeAssistantTurn(dir, "session-1")).resolves.toEqual([
      { submissionId: "submission-1", status: "invalid" },
    ]);

    await writeResponse(svc, dir, "submission-1", {
      ...complete,
      outcomes: [{ ...complete.outcomes[0], text: "Revised explanation." }],
    });
    await expect(svc.observeAssistantTurn(dir, "session-1")).resolves.toEqual([
      { submissionId: "submission-1", status: "ingested" },
    ]);
    await expect(svc.observeAssistantTurn(dir, "session-1")).resolves.toEqual([
      { submissionId: "submission-1", status: "unchanged" },
    ]);
    await expect(svc.observeAssistantTurn(dir, "session-1")).resolves.toEqual([
      { submissionId: "submission-1", status: "unchanged" },
    ]);
    await expect(svc.observeAssistantTurn(dir, "session-1")).resolves.toEqual(
      [],
    );
    const store = await svc.getStoreFile(dir);
    expect(store.submissions[0]).toMatchObject({
      responseRevision: 2,
      responseTurnsObserved: 8,
    });
    expect(store.sites[0]?.outcomes.map((outcome) => outcome.text)).toEqual([
      "Implemented the requested change.",
      "Revised explanation.",
    ]);
  });

  it("rejects duplicate entry outcomes even when the response count matches", async () => {
    const svc = service();
    const entries = await acceptEntries(
      svc,
      dir,
      "submission-duplicates",
      "session-1",
      2,
    );
    const first = entries[0];
    if (!first) throw new Error("fixture request has no entry");
    const duplicate = {
      siteId: first.siteId,
      entryId: first.entryId,
      disposition: "done",
      text: "Handled once.",
    };
    await writeResponse(svc, dir, "submission-duplicates", {
      version: 1,
      submissionId: "submission-duplicates",
      outcomes: [duplicate, duplicate],
    });

    await expect(svc.observeAssistantTurn(dir, "session-1")).resolves.toEqual([
      { submissionId: "submission-duplicates", status: "invalid" },
    ]);
    const store = await svc.getStoreFile(dir);
    expect(store.submissions[0]?.responseRevision).toBe(0);
    expect(store.sites.flatMap((site) => site.outcomes)).toEqual([]);
  });

  it("links an early explicit response when queued delivery gains its session", async () => {
    const svc = service();
    const entries = await acceptEntries(
      svc,
      dir,
      "submission-queued",
      "new",
      1,
      8,
      null,
    );
    const entry = entries[0];
    if (!entry) throw new Error("fixture request has no entry");
    await writeResponse(svc, dir, "submission-queued", {
      version: 1,
      submissionId: "submission-queued",
      outcomes: [
        {
          siteId: entry.siteId,
          entryId: entry.entryId,
          disposition: "done",
          text: "Handled before YA recorded the canonical session.",
        },
      ],
    });

    expect(await svc.refreshSubmissionResponse(dir, "submission-queued")).toBe(
      "ingested",
    );
    expect((await svc.getStoreFile(dir)).sites[0]?.outcomes[0]?.sessionId).toBe(
      undefined,
    );
    await svc.acceptSubmission(dir, {
      submissionId: "submission-queued",
      targetSessionId: "canonical-session",
      deliveryStatus: "delivered",
      responseTurnLimit: 8,
    });
    expect((await svc.getStoreFile(dir)).sites[0]?.outcomes[0]?.sessionId).toBe(
      "canonical-session",
    );
  });

  it("persists independent windows under one public id and refreshes late", async () => {
    const svc = service();
    const first = await accept(svc, dir, "submission-a", "public-session", 2);
    await accept(svc, dir, "submission-b", "public-session", 3);
    await svc.observeAssistantTurn(dir, "public-session");

    const restarted = service();
    await restarted.observeAssistantTurn(dir, "public-session");
    expect(
      (await restarted.getStoreFile(dir)).submissions.map((item) => [
        item.id,
        item.responseTurnsObserved,
      ]),
    ).toEqual([
      ["submission-a", 2],
      ["submission-b", 2],
    ]);

    expect(
      await restarted.observeAssistantTurn(dir, "unknown-session"),
    ).toEqual([]);
    await restarted.observeAssistantTurn(dir, "public-session");
    expect(
      (await restarted.getStoreFile(dir)).submissions.map((item) => [
        item.id,
        item.responseTurnsObserved,
      ]),
    ).toEqual([
      ["submission-a", 2],
      ["submission-b", 3],
    ]);

    await writeResponse(restarted, dir, "submission-a", {
      version: 1,
      submissionId: "submission-a",
      outcomes: [
        {
          siteId: first.siteId,
          entryId: first.entryId,
          disposition: "wont_fix",
          text: "Kept unchanged because the API contract requires it.",
        },
      ],
    });
    expect(await restarted.observeAssistantTurn(dir, "public-session")).toEqual(
      [],
    );
    expect(await restarted.refreshSubmissionResponse(dir, "submission-a")).toBe(
      "ingested",
    );
    expect((await restarted.getStoreFile(dir)).submissions[0]).toMatchObject({
      responseRevision: 1,
      responseTurnsObserved: 2,
    });

    const persisted = JSON.parse(
      await readFile(restarted.filePathFor(dir), "utf-8"),
    );
    expect(persisted.submissions[0].targetSessionId).toBe("public-session");
  });
});
