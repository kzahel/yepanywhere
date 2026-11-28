import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import { IssueStore } from "../../src/services/issues/IssueStore.js";
import type { IssueItem, IssueSettings } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import { IssueCredentials } from "../../src/services/issues/credentials.js";
import { IssueStatusRefresher } from "../../src/services/issues/status.js";

const MERGED = "github:github.com:o/app:1";
const DRAFT = "github:github.com:o/app:2";
const CLOSED = "github:github.com:o/lib:3";
const MISSING = "github:github.com:o/gone:4";
const JIRA = "jira:t.test:ABC-1";

function item(id: string): IssueItem {
  return {
    id,
    key: id,
    title: null,
    url: null,
    provider: id.startsWith("jira") ? "jira" : "github",
    kind: "pr",
    sessionCount: 1,
    unresolved: false,
  };
}

/** GitHub's answer shape: one field per repository, one per number inside. */
function graphql(answers: Record<string, unknown>) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const query = JSON.parse(String(init?.body)).query as string;
    const data: Record<string, Record<string, unknown> | null> = {};
    let repo = "";
    let alias = "";
    for (const field of query.matchAll(
      /(r\d+): repository\(owner: "(\w+)", name: "(\w+)"\)|(i\d+): issueOrPullRequest\(number: (\d+)\)/g,
    )) {
      if (field[1]) {
        [alias, repo] = [field[1], `${field[2]}/${field[3]}`];
        data[alias] = field[3] === "gone" ? null : {};
      } else if (data[alias])
        data[alias]![field[4]!] = answers[`${repo}#${field[5]}`] ?? null;
    }
    return new Response(JSON.stringify({ data }));
  });
}

function harness(
  answers: Record<string, unknown>,
  store?: IssueStore,
  clockStep = 0,
) {
  let now = Date.parse("2026-10-13T10:00:00Z");
  let settings: IssueSettings = {
    enabled: true,
    scope: "viewed",
    recentDays: 7,
    confirmation: { enabled: true, jiraSite: "", jiraEmail: "" },
  };
  const fetch = graphql(answers);
  const refresher = new IssueStatusRefresher({
    settings: () => settings,
    store,
    credentials: new IssueCredentials({
      env: { GITHUB_TOKEN: "gh-secret" },
      cliToken: async () => null,
    }),
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => (now += clockStep),
  });
  return {
    fetch,
    refresher,
    advance: (ms: number) => {
      now += ms;
    },
    set: (next: Partial<IssueSettings>) => {
      settings = { ...settings, ...next };
    },
    read: (...ids: string[]) => refresher.annotate(ids.map(item)),
  };
}

describe("tracker status refresh", () => {
  it("honors short TTLs when the clock advances during a successful fetch", async () => {
    const h = harness({ "o/app#2": { state: "OPEN" } }, undefined, 1);
    h.set({ statusCommentTtlSeconds: 1 });
    h.read(DRAFT);
    await h.refresher.settled();
    h.advance(1000);
    expect(h.read(DRAFT).refreshing).toBe(true);
    await h.refresher.settled();
    expect(h.fetch).toHaveBeenCalledTimes(2);
    h.fetch.mockRejectedValueOnce(new Error("offline"));
    h.advance(1000);
    h.read(DRAFT);
    await h.refresher.settled();
    h.advance(1000);
    expect(h.read(DRAFT).refreshing).toBe(false);
    expect(h.fetch).toHaveBeenCalledTimes(3);
    await h.refresher.close();
  });
  it("uses its own TTL on reads without a stale-triggered loop, including one second and never expire", async () => {
    const h = harness({
      "o/app#2": { __typename: "PullRequest", state: "OPEN", isDraft: true },
    });
    h.set({ contentTtlSeconds: 1209600, statusCommentTtlSeconds: 1 });
    h.read(DRAFT);
    await h.refresher.settled();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    h.advance(999);
    expect(h.read(DRAFT).refreshing).toBe(false);
    h.advance(1);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.read(DRAFT).refreshing).toBe(true);
    await h.refresher.settled();
    expect(h.fetch).toHaveBeenCalledTimes(2);
    h.set({ statusCommentTtlSeconds: null });
    h.advance(365 * 86400_000);
    expect(h.read(DRAFT).refreshing).toBe(false);
    await h.refresher.settled();
    expect(h.fetch).toHaveBeenCalledTimes(2);
    h.refresher.clear();
    expect(h.read(DRAFT).refreshing).toBe(true);
    await h.refresher.settled();
    expect(h.fetch).toHaveBeenCalledTimes(3);
    await h.refresher.close();
  });
  it("asks once per batch, reports states, and asks again only when stale and unmerged", async () => {
    const h = harness({
      "o/app#1": { __typename: "PullRequest", state: "MERGED", isDraft: false },
      "o/app#2": { __typename: "PullRequest", state: "OPEN", isDraft: true },
      "o/lib#3": { __typename: "Issue", state: "CLOSED" },
    });
    const ids = [MERGED, DRAFT, CLOSED, MISSING, JIRA];
    const first = h.read(...ids);
    expect(first.refreshing).toBe(true);
    expect(first.items.some((x) => x.trackerStatus)).toBe(false);
    // A second reader joins the pass instead of starting its own.
    expect(h.read(...ids).refreshing).toBe(true);
    await h.refresher.settled();
    expect(h.fetch).toHaveBeenCalledTimes(1);

    const second = h.read(...ids);
    expect(second.refreshing).toBe(false);
    expect(second.items.map((x) => x.trackerStatus?.state)).toEqual([
      "merged",
      "draft",
      "closed",
      undefined,
      undefined,
    ]);
    expect(second.items[0]!.trackerStatus!.checkedAt).toBe(
      "2026-10-13T10:00:00.000Z",
    );

    // Fresh answers and recent failures are reused; nothing is asked.
    h.advance(60_000);
    expect(h.read(...ids).refreshing).toBe(false);
    await h.refresher.settled();
    expect(h.fetch).toHaveBeenCalledTimes(1);

    // Past five minutes the unmerged ones are asked again, merged never.
    h.advance(5 * 60_000);
    expect(h.read(...ids).refreshing).toBe(true);
    await h.refresher.settled();
    expect(h.fetch).toHaveBeenCalledTimes(2);
    const query = JSON.parse(String(h.fetch.mock.calls[1]![1]!.body)).query;
    expect(query).not.toContain("number: 1)");
    expect(query).toContain("number: 2)");
  });

  it("keeps the last state through a failed lookup and asks nothing while off", async () => {
    const h = harness({
      "o/app#2": { __typename: "PullRequest", state: "OPEN", isDraft: false },
    });
    h.read(DRAFT);
    await h.refresher.settled();
    h.fetch.mockRejectedValueOnce(new Error("offline"));
    h.advance(5 * 60_000);
    h.read(DRAFT);
    await h.refresher.settled();
    expect(h.read(DRAFT).items[0]!.trackerStatus).toEqual({
      state: "open",
      checkedAt: "2026-10-13T10:00:00.000Z",
    });
    expect(h.fetch).toHaveBeenCalledTimes(2);

    h.set({ confirmation: { enabled: false, jiraSite: "", jiraEmail: "" } });
    h.advance(5 * 60_000);
    expect(h.read(DRAFT).refreshing).toBe(false);
    expect(h.read(DRAFT).items[0]?.trackerStatus?.state).toBe("open");
    await h.refresher.settled();
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
  it("retains merge facts and retry backoff across a real SQLite close/reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ya-status-restart-"));
    let db = new DiscoverySqliteService({ dataDir: dir });
    try {
      let store = new IssueStore(db.getDatabase());
      for (const n of [1, 2, 4])
        store.captureManual(
          { projectId: "p", sessionId: "s" },
          `https://github.com/${n === 4 ? "o/gone" : "o/app"}/pull/${n}`,
          "",
        );
      const first = harness(
        {
          "o/app#1": {
            __typename: "PullRequest",
            state: "MERGED",
            id: "PR_stable",
            mergedAt: "2026-10-12T09:00:00Z",
            mergeCommit: { oid: "abcdef123456" },
          },
          "o/app#2": { __typename: "PullRequest", state: "OPEN" },
        },
        store,
      );
      first.read(MERGED, DRAFT, MISSING);
      await first.refresher.settled();
      await first.refresher.close();
      db.close();
      db = new DiscoverySqliteService({ dataDir: dir });
      store = new IssueStore(db.getDatabase());
      const second = harness({}, store);
      expect(second.read(MERGED).items[0]?.trackerStatus).toMatchObject({
        state: "merged",
        mergedAt: "2026-10-12T09:00:00Z",
        mergeCommitSha: "abcdef123456",
        nodeId: "PR_stable",
      });
      expect(second.read(DRAFT, MISSING).refreshing).toBe(false);
      await second.refresher.settled();
      expect(second.fetch).not.toHaveBeenCalled();
      second.advance(6 * 60_000);
      second.read(MERGED, DRAFT);
      await second.refresher.settled();
      expect(second.fetch).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(String(second.fetch.mock.calls[0]?.[1]?.body)).query,
      ).not.toContain("number: 1)");
      expect(second.read(DRAFT).items[0]?.trackerStatus?.state).toBe("open");
      second.set({ githubStatusEnabled: false });
      expect(second.read(MERGED).items[0]?.trackerStatus?.state).toBe("merged");
      second.refresher.clear();
      expect(second.read(MERGED).items[0]?.trackerStatus).toBeUndefined();
      expect(store.list()).toHaveLength(3);
      await second.refresher.close();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not republish a response cleared or disabled while in flight", async () => {
    const h = harness({});
    let complete!: (response: Response) => void;
    h.fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    h.read(MERGED);
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
    h.refresher.clear();
    complete(
      new Response(
        JSON.stringify({ data: { r0: { i0: { state: "MERGED" } } } }),
      ),
    );
    await h.refresher.settled();
    h.set({ githubStatusEnabled: false });
    expect(h.read(MERGED).items[0]?.trackerStatus).toBeUndefined();
    h.set({
      githubStatusEnabled: true,
      confirmation: { enabled: false, jiraSite: "", jiraEmail: "" },
    });
    expect(h.read(MERGED).refreshing).toBe(true);
    await h.refresher.settled();
    expect(h.fetch).toHaveBeenCalledTimes(2);
    await h.refresher.close();
  });
});
