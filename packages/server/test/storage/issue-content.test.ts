import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { IssueSettings } from "@yep-anywhere/shared";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import { IssueStore } from "../../src/services/issues/IssueStore.js";
import { IssueContentRefresher } from "../../src/services/issues/content.js";
import { IssueCredentials } from "../../src/services/issues/credentials.js";
import { IssueIndexer } from "../../src/services/issues/IssueIndexer.js";
import { createIssueRoutes } from "../../src/routes/issues.js";
import { ServerSettingsService } from "../../src/services/ServerSettingsService.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
function fixture(fetcher: typeof fetch) {
  const dir = mkdtempSync(join(tmpdir(), "issue-content-"));
  const db = new DiscoverySqliteService({ dataDir: dir });
  const settings: IssueSettings = {
    enabled: true,
    scope: "viewed",
    recentDays: 7,
    confirmation: {
      enabled: true,
      jiraSite: "https://example.atlassian.net",
      jiraEmail: "owner@test",
    },
  };
  const store = new IssueStore(db.getDatabase(), () => settings);
  let now = 1800000000000;
  const credentials = new IssueCredentials({
    env: { JIRA_API_TOKEN: "secret" },
    cliToken: async () => null,
  });
  const content = new IssueContentRefresher(store, {
    settings: () => settings,
    credentials,
    fetch: fetcher,
    now: () => now,
    intervalMs: 0,
  });
  const indexer = new IssueIndexer(store, {
    settings: () => settings,
    changes: async () => ({
      mark: { catalogEpoch: "e", catalogGeneration: 1 },
      full: true,
      rows: [],
      removed: [],
      excluded: [],
    }),
    row: async () => undefined,
    read: async () => null,
  });
  const app = new Hono().route(
    "/api",
    createIssueRoutes(
      indexer,
      new ServerSettingsService({ dataDir: dir }),
      async () => ({ available: true }),
      credentials,
      undefined,
      async () => [],
      undefined,
      content,
    ),
  );
  cleanups.push(async () => {
    await content.close();
    await indexer.close();
    db.close();
    rmSync(dir, { recursive: true });
  });
  return {
    app,
    store,
    content,
    settings,
    advance: (ms: number) => {
      now += ms;
    },
    capture: (url: string) =>
      store.capture(
        { sessionId: "old-session", projectId: "p" },
        { id: url, text: url },
      ),
    refresh: async (force = false) => {
      expect(
        (
          await app.request("/api/issues/refresh", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ force }),
          })
        ).status,
      ).toBe(202);
      await content.drain();
    },
  };
}

it("fetches Jira description and smart links, searches through HTTP, and conditionally refreshes", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json(
        {
          fields: {
            summary: "Lao ASR",
            description: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "text",
                      text: "A description-only needle 50%_done.",
                    },
                  ],
                },
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "inlineCard",
                      attrs: {
                        url: "https://huggingface.co/SiangLao/hubert-lao-asr",
                      },
                    },
                  ],
                },
              ],
            },
          },
        },
        { headers: { etag: '"v1"' } },
      ),
    )
    .mockImplementation(async () => new Response(null, { status: 304 }));
  const h = fixture(fetcher);
  h.capture("https://example.atlassian.net/browse/ASR-7");
  await h.refresh();
  expect(fetcher.mock.calls[0]?.[0]).toContain("fields=summary,description");
  expect(
    new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("Authorization"),
  ).toBe(`Basic ${Buffer.from("owner@test:secret").toString("base64")}`);
  for (const q of ["DESCRIPTION-ONLY", "50%_done", "SiangLao"]) {
    const response = await h.app.request(
      `/api/issues?q=${encodeURIComponent(q)}`,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toBe("Lao ASR");
    expect(body.items[0].body).toBeUndefined();
  }
  expect(h.store.list("50XXdone")).toHaveLength(0);
  const id = h.store.list()[0]!.id;
  const details = await (
    await h.app.request(`/api/issues/content?id=${encodeURIComponent(id)}`)
  ).json();
  expect(details.content.body).toContain("description-only needle");
  await h.refresh();
  expect(fetcher).toHaveBeenCalledTimes(1);
  await h.refresh(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(
    new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("If-None-Match"),
  ).toBe('"v1"');
  expect(h.store.list("description-only")).toHaveLength(1);
  h.advance(14 * 86400_000 + 1);
  await h.refresh();
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("negative-caches misses, scans new historical mentions, and never forwards Jira credentials to another site", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(null, { status: 404 }));
  const h = fixture(fetcher);
  h.capture("https://other.atlassian.net/browse/ASR-7");
  await h.refresh();
  expect(
    new Headers(fetcher.mock.calls[0]?.[1]?.headers).has("Authorization"),
  ).toBe(false);
  await h.refresh();
  expect(fetcher).toHaveBeenCalledTimes(1);
  h.capture("https://example.atlassian.net/browse/ASR-8");
  await h.refresh();
  expect(fetcher).toHaveBeenCalledTimes(2);
  await h.refresh(true);
  expect(fetcher).toHaveBeenCalledTimes(4);
});

it("coalesces refreshes, preserves acquired text on failure, and enforces persisted rate backoff even when forced", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ title: "Subject", body: "Keep this body" }),
    )
    .mockImplementation(
      async () =>
        new Response(null, { status: 429, headers: { "retry-after": "600" } }),
    );
  const h = fixture(fetcher);
  h.capture("https://github.com/o/r/issues/1");
  h.content.start();
  h.content.start();
  await h.content.drain();
  expect(fetcher).toHaveBeenCalledTimes(1);
  await h.refresh(true);
  expect(h.store.list("Keep this body")).toHaveLength(1);
  h.capture("https://github.com/o/r/issues/2");
  await h.refresh(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(h.content.status().error).toContain("rate limit");
  h.advance(600_001);
  await h.refresh(true);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("does not save missing description as a successful empty body, or publish an in-flight response after disable", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ fields: { summary: "Subject" } }));
  const h = fixture(fetcher);
  h.capture("https://example.atlassian.net/browse/ASR-7");
  await h.refresh();
  expect(h.content.status().failed).toBe(1);
  h.advance(300_001);
  fetcher.mockImplementationOnce(async () => {
    h.settings.enabled = false;
    return Response.json({
      fields: { summary: "Do not save", description: null },
    });
  });
  await h.refresh(true);
  expect(h.store.list("Do not save")).toHaveLength(0);
});

it("applies the content TTL to both trackers, with one-second and never-expire endpoints", async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
    Response.json({
      title: "Subject",
      body: "Body",
      fields: { summary: "Subject", description: "Body" },
    }),
  );
  const h = fixture(fetcher);
  h.settings.contentTtlSeconds = 1;
  h.settings.statusCommentTtlSeconds = 300;
  h.capture("https://example.atlassian.net/browse/ASR-7");
  h.capture("https://github.com/o/r/issues/1");
  await h.refresh();
  expect(fetcher).toHaveBeenCalledTimes(2);
  h.advance(999);
  await h.refresh();
  expect(fetcher).toHaveBeenCalledTimes(2);
  h.advance(1);
  await h.refresh();
  expect(fetcher).toHaveBeenCalledTimes(4);
  h.settings.contentTtlSeconds = null;
  h.advance(365 * 86400_000);
  await h.refresh();
  expect(fetcher).toHaveBeenCalledTimes(4);
  await h.refresh(true);
  expect(fetcher).toHaveBeenCalledTimes(6);
  h.settings.enabled = false;
  expect((await h.app.request("/api/issues/content?id=any")).status).toBe(403);
  expect(
    (await h.app.request("/api/issues/refresh", { method: "POST" })).status,
  ).toBe(403);
});
