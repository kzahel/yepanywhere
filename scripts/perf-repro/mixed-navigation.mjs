import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  startYaServerProcess,
  disposeYaServerProcess,
} from "../../packages/client/e2e/support/ya-server-process.ts";
import { catalogFileVersion } from "../../packages/server/src/sessions/catalog-adapters/row.ts";
import { measuredHostSample, hostWindow } from "./active-session-metrics.mjs";
import { readHostCapacity } from "../perf-suite/host-profile.mjs";
import { fingerprintTree } from "./active-session-build.mjs";
import { mixedFixture } from "./mixed-navigation-fixture.mjs";

const { chromium, expect } = createRequire(
  new URL("../../packages/client/package.json", import.meta.url),
)("@playwright/test");
const { values } = parseArgs({
  options: {
    case: { type: "string", default: "navigation" },
    population: { type: "string", default: "50" },
    projects: { type: "string", default: "1" },
    indexless: { type: "boolean" },
    "pin-watches": { type: "boolean" },
    out: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "mixed-navigation.mjs --case navigation|arrival|review [--population 50] [--projects 1] [--indexless] [--pin-watches] [--out NEW.json]\nPopulation is the number of unrelated sessions, projects the number of archive projects. See the plan 190 mixed-provider navigation audit for build and replay.",
  );
  process.exit(0);
}
const scenario = values.case;
const population = Number(values.population);
const projects = Number(values.projects);
const indexed = !values.indexless;
const pinWatches = values["pin-watches"] ?? false;
assert(
  !pinWatches || scenario === "navigation",
  "--pin-watches requires navigation",
);
assert(
  ["navigation", "arrival", "review"].includes(scenario),
  "Choose --case navigation, arrival or review",
);
assert(
  Number.isInteger(population) &&
    population >= 2 &&
    population <= 100000 &&
    population % 2 === 0,
  "Use an even population from 2 to 100000",
);
assert(
  Number.isInteger(projects) && projects >= 1 && projects <= population / 2,
);
const client = join(process.env.YEP_E2E_RUN_DIR ?? "", "client-dist");
assert(
  process.env.YEP_E2E_RUN_DIR && existsSync(join(client, "index.html")),
  "Build client-dist in YEP_E2E_RUN_DIR using the mixed-profile replay recipe",
);
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const out = values.out
  ? resolve(values.out)
  : join(mkdtempSync(join(tmpdir(), "mixed-results-")), "result.json");
// Reserve the file exclusively. Failed runs leave an explicit incomplete result.
const capacity = await readHostCapacity();
const hostStart = await measuredHostSample(capacity);
const result = {
  complete: false,
  scenario,
  population,
  projects,
  indexed,
  pinWatches,
  node: process.version,
  revision: git("rev-parse", "HEAD"),
  dirty: git("status", "--porcelain").length > 0,
  clientSha256: fingerprintTree(client).sha256,
  harnessSha256: Object.fromEntries(
    [
      "mixed-navigation.mjs",
      "mixed-navigation-probe.mjs",
      "mixed-navigation-fixture.mjs",
      "scenario-transcripts.mjs",
    ].map((name) => [
      name,
      createHash("sha256")
        .update(readFileSync(new URL(name, import.meta.url)))
        .digest("hex"),
    ]),
  ),
  pageErrors: [],
  capacity: capacity.capacityKey,
  opens: [],
  phases: {},
};
writeFileSync(out, JSON.stringify(result), { flag: "wx" });
console.log(out);
const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "ya-mixed-")));
const fixture = mixedFixture({ population, projects, indexed });
const profileDir = join(tempDir, "profile");
const abort = new AbortController();
const interrupt = () => abort.abort(new Error("Mixed-profile run interrupted"));
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, interrupt);
let server, browser, db;
try {
  server = await startYaServerProcess({
    label: "mixed navigation",
    standalone: {},
    serveBuiltClient: true,
    profilePaths: {
      tempDir,
      profileDir,
      dataDir: join(profileDir, "yep-anywhere"),
      claudeSessionsDir: join(profileDir, "claude", "projects"),
      // Keep the experimental store separate from native CLI startup in CODEX_HOME.
      codexSessionsDir: join(tempDir, "rollouts", "sessions"),
      geminiSessionsDir: join(profileDir, ".gemini", "tmp"),
    },
    serverPreload: new URL("./mixed-navigation-probe.mjs", import.meta.url)
      .href,
    startupDeadline: Date.now() + 300000,
    setupProfile: async (paths) => {
      await fixture.setup(paths);
      if (pinWatches)
        writeFileSync(
          join(paths.dataDir, "mixed-watch-directories.json"),
          JSON.stringify([
            ...new Set(fixture.active.map((s) => dirname(s.file))),
          ]),
        );
    },
  });
  async function get(path, method = "GET") {
    const response = await fetch(server.baseUrl + path, {
      headers: { "X-Yep-Anywhere": "true" },
      signal: abort.signal,
      method,
    });
    assert.equal(response.status, 200, path);
    return response.json();
  }
  async function snapshot(label) {
    let record;
    await expect
      .poll(
        async () => {
          record = await get("/__mixed_navigation_sample");
          return record.pending ?? [];
        },
        { timeout: 30000, intervals: [25, 50, 100] },
      )
      .toEqual([]);
    result.phases[label] = record;
    writeFileSync(out, JSON.stringify(result, null, 2));
    const lanes = Object.values(record.lanes);
    console.log(
      label,
      "requests",
      Object.values(record.requests).reduce((n, r) => n + r.count, 0),
      "full rows",
      lanes.reduce((n, r) => n + (r.fullRows ?? 0), 0),
      "cpu ms",
      record.cpuMs,
    );
    for (const [route, entry] of Object.entries(record.requests)) {
      for (const code of Object.keys(entry.status)) {
        if (+code >= 400) console.warn(label, route, "HTTP", code);
      }
    }
    assert.deepEqual(result.pageErrors, [], "Browser page errors");
    return record;
  }
  const projectId = Buffer.from(fixture.paths.project).toString("base64url");
  async function counts(active) {
    await expect
      .poll(
        async () => {
          const { catalog, projects: list } = await get(
            "/api/projects?summaryMode=retained",
          );
          return (
            catalog?.complete &&
            !catalog.refreshing &&
            list.length === projects + 1 &&
            list.find((p) => p.id === projectId)?.sessionCount === active &&
            list.reduce((n, p) => n + p.sessionCount, 0) === population + active
          );
        },
        { timeout: 180000 },
      )
      .toBe(true);
  }
  await counts(10);
  await snapshot("discovery");
  db = new DatabaseSync(join(fixture.paths.dataDir, "discovery.sqlite"), {
    readOnly: true,
  });
  const lookup = db.prepare(
    "SELECT source_version,project_id FROM session_catalog WHERE family=? AND native_id=? AND deleted=0",
  );
  function row(s) {
    return lookup.get(s.provider, s.id);
  }
  async function append(s) {
    const before = row(s);
    assert(before?.source_version);
    fixture.append(s);
    const expectedVersion = catalogFileVersion(statSync(s.file));
    assert.notEqual(expectedVersion, before.source_version);
    await expect
      .poll(
        () => {
          const after = row(s);
          return (
            after &&
            after.project_id === before.project_id &&
            after.source_version === expectedVersion
          );
        },
        { timeout: 120000 },
      )
      .toBe(true);
  }
  browser = await chromium.launch({
    chromiumSandbox: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  const page = await browser.newPage({
    serviceWorkers: "block",
    viewport: { width: 1280, height: 800 },
  });
  page.on("pageerror", (error) => result.pageErrors.push(error.message));
  const card = (s) =>
    page
      .locator(
        '[data-session-list-item--card] a[href$="/sessions/' + s.id + '"]',
      )
      .first();
  const firstReview = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/review/inbox",
  );
  await page.goto(server.baseUrl + "/inbox");
  assert.deepEqual((await (await firstReview).json()).items, []);
  await expect(card(fixture.active[0])).toBeVisible({ timeout: 30000 });
  await snapshot("first-inbox");
  async function open(s) {
    abort.signal.throwIfAborted();
    const start = performance.now();
    const [draft] = await Promise.all([
      page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === "/api/drafts/read" &&
          r.request().postDataJSON()?.slot?.sessionId === s.id,
      ),
      card(s).click({ timeout: 30000 }),
    ]);
    assert.equal(draft.status(), 200, "Browser session draft");
    assert("recovery" in (await draft.json()), "Missing draft recovery state");
    await expect(page).toHaveURL(new RegExp("/sessions/" + s.id + "$"));
    await expect(
      page.locator("main").getByText(new RegExp(s.marker)).last(),
    ).toBeInViewport({ timeout: 30000 });
    result.opens.push({
      id: s.id,
      provider: s.provider,
      marker: s.marker,
      elapsedMs: Math.round(performance.now() - start),
    });
    await page.locator('a[href="/inbox"]:visible').first().click();
    await expect(page).toHaveURL(/\/inbox$/);
  }
  if (scenario === "navigation") {
    if (pinWatches) {
      const expected = new Set(fixture.active.map((s) => dirname(s.file))).size;
      assert.equal(
        (await get("/__mixed_navigation_leases", "PUT")).leases,
        expected,
      );
      await snapshot("pin-focused-directories");
    }
    for (const pass of ["first-ten", "repeat-ten"]) {
      for (const s of fixture.active) await open(s);
      await snapshot(pass);
    }
    await append(fixture.archive);
    await snapshot("accepted-unrelated-append");
    for (const name of ["post-write", "stable-revisit"]) {
      await open(fixture.active[0]);
      await snapshot(name);
    }
    if (pinWatches) {
      await page.close();
      await snapshot("close-browser");
      assert.equal(
        (await get("/__mixed_navigation_leases", "DELETE")).leases,
        0,
      );
      await snapshot("release-focused-directories");
    }
  }
  if (scenario === "review") {
    for (let i = 1; i <= 3; i++) {
      // Enter the next five-second route-cache bucket, then repeat inside it.
      await delay(5050 - (Date.now() % 5000));
      const bucket = Math.floor(Date.now() / 5000);
      for (const kind of ["fresh", "repeat"]) {
        assert.deepEqual((await get("/api/review/inbox")).items, []);
        assert.equal(
          Math.floor(Date.now() / 5000),
          bucket,
          "Review request crossed cache bucket",
        );
        await snapshot(kind + "-" + i);
      }
    }
  }
  if (scenario === "arrival") {
    // Keep the watcher window free of browser/list polling after warming Inbox.
    await page.close();
    // First Inbox discovery may schedule a 300 ms background refresh. Allow
    // debounce, then join a complete retained read before measuring mutations.
    await delay(1200);
    await counts(10);
    await snapshot("settled-inbox");
    // The first watcher update may overlap startup reconciliation. Report it
    // separately before the two provider append controls.
    await append(fixture.active[0]);
    await snapshot("first-watcher-update");

    // A second client pings a cheap route, one outstanding request at a time.
    // Measure client round trips including queueing before Node handles them.
    result.statusPings = {};
    async function observe(label, work) {
      let finished = false;
      const times = [];
      const ping = async () => {
        do {
          const start = performance.now();
          await get("/api/auth/status");
          times.push(performance.now() - start);
          await delay(40);
        } while (!finished);
      };
      const measure = async () => {
        try {
          await work();
        } finally {
          finished = true;
        }
      };
      await Promise.all([ping(), measure()]);
      result.statusPings[label] = {
        count: times.length,
        maxMs: Math.round(Math.max(...times)),
        medianMs: Math.round(
          times.sort((a, b) => a - b)[Math.floor(times.length / 2)],
        ),
      };
      await snapshot(label);
    }
    await observe("quiet", () => delay(1000));
    for (const s of fixture.active.slice(0, 2)) {
      await observe("append-" + s.provider, () => append(s));
    }
    let active = 10;
    for (const [label, numbers] of [
      ["new-claude", [200000]],
      ["new-codex-1", [200001]],
      ["new-codex-2", [200003]],
      ["codex-burst", [200005, 200007, 200009]],
    ]) {
      let added;
      await observe(label, async () => {
        added = numbers.map((n) =>
          fixture.make(n, fixture.paths.project, Date.now(), 4),
        );
        const expected = added.map((s) => catalogFileVersion(statSync(s.file)));
        await expect
          .poll(
            () =>
              added.every((s, i) => {
                const accepted = row(s);
                return (
                  accepted?.project_id === projectId &&
                  accepted.source_version === expected[i]
                );
              }),
            {
              timeout: 120000,
            },
          )
          .toBe(true);
      });
      active += added.length;
      await counts(active);
      // Read the same detail route as a session open. Check every new final answer
      // separately from the mutation window, including all three burst members.
      for (const s of added) {
        const detail = await get(
          "/api/projects/" + projectId + "/sessions/" + s.id,
        );
        assert.equal(detail.session.id, s.id);
        assert(
          JSON.stringify(detail.messages).includes(s.marker),
          s.id + " latest answer",
        );
      }
      await snapshot(label + "-verified");
    }
    result.finalActiveCount = active;
    const hintReads = Object.values(result.phases)
      .flatMap((p) => Object.values(p.lanes))
      .reduce((n, l) => n + (l.threadHintReads ?? 0), 0);
    assert.equal(
      existsSync(join(tempDir, "rollouts", "state_5.sqlite")),
      indexed,
      "Native index presence changed",
    );
    assert.equal(
      hintReads > 0,
      indexed,
      "Expected successful watcher queries against the selected native index only in the indexed cell",
    );
  }
} finally {
  try {
    try {
      await browser?.close();
    } finally {
      if (server) await disposeYaServerProcess(server);
    }
  } finally {
    db?.close();
    fixture.close();
    // Keep the harness recovery records when disposal of its child fails.
    if (!existsSync(join(tempDir, "process.json")))
      rmSync(tempDir, { recursive: true, force: true });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
      process.off(signal, interrupt);
  }
}
abort.signal.throwIfAborted();
result.host = await hostWindow({ capacity }, hostStart);
result.complete = true;
writeFileSync(out, JSON.stringify(result, null, 2));
