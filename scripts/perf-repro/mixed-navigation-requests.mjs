import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export async function replayNavigationRequests({
  page,
  baseUrl,
  readRecents,
  fixture,
  result,
  open,
  snapshot,
  append,
  expect,
}) {
  const details = [];
  result.detailResponses = details;
  const pending = new Set();
  const recentIds = [];
  result.recentsResponses = recentIds;
  const newestFirst = fixture.active.map((s) => s.id).reverse();
  const digest = (text) =>
    createHash("sha256").update(text).digest("hex").slice(0, 16);
  let phase = "empty";
  assert.equal(fixture.archive.provider, "codex");
  const startedDuring = new WeakMap();
  const finite = new Set();
  let lastActivity = performance.now();
  const onRequest = (request) => {
    startedDuring.set(request, phase);
    const { pathname } = new URL(request.url());
    if (
      pathname.startsWith("/api/") &&
      pathname !== "/api/drafts/changes" &&
      request.resourceType() !== "eventsource"
    ) {
      finite.add(request);
      lastActivity = performance.now();
    }
  };
  const onEnd = (request) => {
    if (finite.delete(request)) lastActivity = performance.now();
  };
  page.on("request", onRequest);
  page.on("requestfinished", onEnd);
  page.on("requestfailed", onEnd);
  const isBundle = (url) =>
    url.pathname === "/api/settings" && url.searchParams.has("bootstrap");
  const collect = async (response) => {
    const url = new URL(response.url());
    const requestedDuring = startedDuring.get(response.request());
    if (response.request().method() !== "GET") return;
    if (isBundle(url) || url.pathname === "/api/recents") {
      let body;
      if (isBundle(url)) {
        const frame = (await response.text())
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)))
          .find((frame) => frame.part === "recents");
        assert.equal(frame?.status, 200);
        body = frame.body;
      } else {
        assert.equal(url.searchParams.get("summaryMode"), "retained");
        body = await response.json();
      }
      const { visits, recents, catalog } = body;
      assert.equal(catalog.complete, true);
      assert(!catalog.refreshError);
      for (const recent of recents) {
        const s = fixture.active.find((s) => s.id === recent.sessionId);
        assert(s);
        assert.equal(
          recent.projectId,
          Buffer.from(s.project).toString("base64url"),
        );
        assert.equal(recent.provider, s.provider);
      }
      recentIds.push({
        phase: requestedDuring,
        catalog: {
          epoch: catalog.catalogEpoch,
          generation: catalog.catalogGeneration,
          complete: catalog.complete,
          hasRefreshError: Boolean(catalog.refreshError),
        },
        enrichedHash: digest(JSON.stringify(recents)),
        visits: visits.map((v) => v.sessionId),
        enriched: recents.map((v) => v.sessionId),
      });
      return;
    }
    if (!/^\/api\/projects\/[^/]+\/sessions\/[^/]+$/.test(url.pathname)) return;
    const id = url.pathname.split("/").pop();
    const s = fixture.active.find((session) => session.id === id);
    assert(s, "Unexpected session detail");
    const record = {
      phase: requestedDuring,
      id,
      provider: s.provider,
      query: [...url.searchParams.keys()].sort(),
      requestKey: digest(response.url()),
      status: response.status(),
    };
    details.push(record);
    const body = await response.body();
    const { session, messages } = JSON.parse(body.toString());
    assert.equal(session.id, id);
    Object.assign(record, {
      bytes: body.length,
      messages: messages.length,
      messageHash: digest(JSON.stringify(messages)),
    });
  };
  const errors = [];
  const listener = (response) => {
    const task = collect(response).catch((error) => errors.push(error));
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };
  page.on("response", listener);
  const sample = async (name) => {
    await expect
      .poll(() => !finite.size && performance.now() - lastActivity >= 750, {
        timeout: 15000,
        intervals: [100],
      })
      .toBe(true);
    await snapshot(name);
    await Promise.all(pending);
    if (errors.length) throw errors[0];
  };
  const visitNewSession = async () => {
    const response = page.waitForResponse((r) => isBundle(new URL(r.url())));
    await page.goto(baseUrl + "/new-session");
    await response;
  };
  try {
    await visitNewSession();
    await sample("empty-new-session");
    assert.deepEqual(recentIds.at(-1)?.visits, []);
    await page.goto(baseUrl + "/inbox");
    for (const pass of ["first-ten", "repeat-ten"]) {
      phase = pass;
      for (const s of fixture.active) await open(s);
      await sample(pass);
    }
    phase = "populated";
    await visitNewSession();
    await sample("populated-new-session");
    for (const s of [...fixture.active.slice(0, 2), fixture.archive]) {
      phase = s === fixture.archive ? "unvisited-write" : s.provider + "-write";
      await Promise.all([
        page.waitForResponse(
          (r) => new URL(r.url()).pathname === "/api/recents",
        ),
        append(s),
      ]);
      await sample(phase);
      assert.equal(recentIds.filter((row) => row.phase === phase).length, 1);
    }
    phase = "inbox-control";
    await page.goto(baseUrl + "/inbox");
    await page.locator("[data-session-list-item--card]").first().waitFor();
    await sample("inbox-control-open");
    await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === "/api/inbox"),
      append(fixture.archive),
    ]);
    await sample("inbox-control-write");
    assert(!recentIds.some((row) => row.phase === "inbox-control"));
    assert(recentIds.some((row) => row.phase === "populated"));
    phase = "concurrent-writes";
    const before = await readRecents();
    const [during] = await Promise.all([
      readRecents(),
      append(fixture.active[0]),
      append(fixture.active[1]),
    ]);
    const after = await readRecents();
    for (const body of [during, after]) {
      assert.deepEqual(
        body.visits.map((v) => v.sessionId),
        newestFirst,
      );
      assert.equal(
        digest(JSON.stringify(body.recents)),
        recentIds.find((r) => r.phase === "populated").enrichedHash,
      );
      assert(body.catalog.complete && !body.catalog.refreshError);
    }
    assert(after.catalog.catalogGeneration > before.catalog.catalogGeneration);
    assert(after.catalog.catalogGeneration >= during.catalog.catalogGeneration);
    await sample(phase);
    for (const [name, route, expected] of [
      ["repeat-direct-recents", "GET /api/recents", 0],
      ["concurrent-writes", "GET /api/recents", 30],
      ["empty-new-session", "GET /api/settings", 0],
      ["populated-new-session", "GET /api/settings", 10],
      ...["claude-write", "codex-write", "unvisited-write"].map((name) => [
        name,
        "GET /api/recents",
        10,
      ]),
    ]) {
      const counts = result.phases[name].lanes[route] ?? {};
      assert.equal(counts.fullReads ?? 0, 0, name);
      assert.equal(counts.hashInventoryReads ?? 0, 0, name);
      assert.equal(counts.metadataFullReads ?? 0, 0, name);
      assert.equal(counts.recentSourceRows ?? 0, expected, name);
    }
    for (const row of recentIds.filter(
      (row) => row.phase === "populated" || row.phase.endsWith("-write"),
    )) {
      assert.equal(
        row.enrichedHash,
        recentIds.find((r) => r.phase === "populated").enrichedHash,
      );
      assert.deepEqual(row.visits, newestFirst);
      assert.deepEqual(row.enriched, newestFirst);
    }
  } finally {
    page.off("response", listener);
    page.off("request", onRequest);
    page.off("requestfinished", onEnd);
    page.off("requestfailed", onEnd);
  }
}
