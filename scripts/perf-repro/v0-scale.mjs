import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  startYaServerProcess,
  disposeYaServerProcess,
} from "../../packages/client/e2e/support/ya-server-process.ts";
import { readHostCapacity } from "../perf-suite/host-profile.mjs";
import { hostWindow, measuredHostSample } from "./active-session-metrics.mjs";
import {
  mixedFixture,
  mixedProfilePaths,
} from "./mixed-navigation-fixture.mjs";

const { values } = parseArgs({
  options: {
    population: { type: "string", default: "50" },
    projects: { type: "string", default: "1" },
    "transcript-writes": { type: "string", default: "4" },
    samples: { type: "string", default: "15" },
    observe: { type: "boolean" },
    out: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "v0-scale.mjs [--population 50] [--projects 1] [--transcript-writes 4] [--samples 15] [--observe] [--out NEW.json]",
  );
  process.exit(0);
}
const population = Number(values.population);
const projects = Number(values.projects);
const transcriptWrites = Number(values["transcript-writes"]);
const samples = Number(values.samples);
assert(
  Number.isInteger(population) &&
    population >= 2 &&
    population <= 100000 &&
    population % 2 === 0,
);
assert(
  Number.isInteger(projects) && projects >= 1 && projects <= population / 2,
);
assert(
  Number.isInteger(transcriptWrites) &&
    transcriptWrites >= 4 &&
    transcriptWrites <= 20000,
);
assert(Number.isInteger(samples) && samples >= 3 && samples <= 1000);
const out = values.out
  ? resolve(values.out)
  : join(mkdtempSync(join(tmpdir(), "ya-v0-results-")), "result.json");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const capacity = await readHostCapacity();
const hostStart = await measuredHostSample(capacity);
const result = {
  complete: false,
  population,
  projects,
  transcriptWrites,
  samples,
  observe: values.observe ?? false,
  revision: git("rev-parse", "HEAD"),
  dirty: git("status", "--porcelain").length > 0,
  node: process.version,
  capacity: capacity.capacityKey,
  harnessSha256: Object.fromEntries(
    [
      "v0-scale.mjs",
      "mixed-navigation-fixture.mjs",
      "mixed-navigation-probe.mjs",
      "scenario-transcripts.mjs",
    ].map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(new URL(file, import.meta.url)))
        .digest("hex"),
    ]),
  ),
  phases: {},
};
writeFileSync(out, JSON.stringify(result), { flag: "wx" });
console.log(out);

const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "ya-v0-scale-")));
const fixture = mixedFixture({
  population,
  projects,
  indexed: true,
  transcriptWrites,
});
const abort = new AbortController();
const interrupt = () => abort.abort(new Error("v0 scale replay interrupted"));
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, interrupt);
let server;

try {
  server = await startYaServerProcess({
    label: "v0 scale",
    standalone: {},
    profilePaths: mixedProfilePaths(tempDir),
    serverPreload: new URL("./mixed-navigation-probe.mjs", import.meta.url)
      .href,
    startupDeadline: Date.now() + 300000,
    setupProfile: (paths) => fixture.setup(paths),
  });
  async function get(path, expected = 200) {
    const start = performance.now();
    const response = await fetch(server.baseUrl + path, {
      headers: { "X-Yep-Anywhere": "true" },
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(180000)]),
    });
    const text = await response.text();
    assert.equal(response.status, expected, `${path}: ${text.slice(0, 500)}`);
    return {
      body: JSON.parse(text),
      ms: performance.now() - start,
      bytes: Buffer.byteLength(text),
    };
  }
  async function snapshot() {
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      const { body } = await get("/__mixed_navigation_sample");
      if (!body.pending?.length) return body;
      await delay(25, undefined, { signal: abort.signal });
    }
    throw new Error("The server probe still has pending requests");
  }
  function save(phase, probe, timings) {
    result.phases[phase] = { probe, ...timings };
    writeFileSync(out, JSON.stringify(result, null, 2));
  }
  function report(requests) {
    const sorted = requests.map(({ ms }) => ms).sort((a, b) => a - b);
    const percentile = (p) => sorted[Math.ceil(p * sorted.length) - 1];
    return {
      medianMs: percentile(0.5),
      p95Ms: percentile(0.95),
      maxMs: sorted.at(-1),
      responseBytes: requests.reduce((n, r) => n + r.bytes, 0),
    };
  }
  async function repeat(request) {
    const runs = [];
    for (let i = 0; i < samples; i++) runs.push(await request());
    return report(runs);
  }
  const root = "/v0/servers/self/sessions";
  const projectId = Buffer.from(fixture.paths.project).toString("base64url");
  const readinessDeadline = Date.now() + 180000;
  for (;;) {
    const { body } = await get("/api/projects?summaryMode=retained");
    if (
      body.catalog.complete &&
      !body.catalog.refreshing &&
      body.projects.length === projects + 1 &&
      body.projects.reduce((n, p) => n + p.sessionCount, 0) === population + 10
    )
      break;
    assert(
      Date.now() < readinessDeadline,
      "The generated catalog did not become ready",
    );
    await delay(100, undefined, { signal: abort.signal });
  }
  save("discovery", await snapshot());
  const list = async (project, offset = 0) => {
    const query = new URLSearchParams({ limit: "1" });
    if (project) query.set("projectId", project);
    if (offset) query.set("cursor", String(offset));
    const response = await get(`${root}?${query}`);
    assert.equal(response.body.items.length, 1);
    assert.ok(response.body.catalog.complete);
    assert.equal(response.body.nextCursor, String(offset + 1));
    return response;
  };
  const cold = await list();
  assert.equal(cold.body.items[0].id, fixture.active[9].id);
  save("first-list", await snapshot(), { request: report([cold]) });
  async function phase(label, request, lane, concurrent = false) {
    let requestTiming, versionTiming;
    if (concurrent) {
      [requestTiming, versionTiming] = await Promise.all([
        repeat(request),
        repeat(() => get("/api/version")),
      ]);
    } else {
      requestTiming = await repeat(request);
    }
    const probe = await snapshot();
    save(label, probe, { request: requestTiming, version: versionTiming });
    assert.equal(probe.requests[lane]?.completed, samples, label);
    if (!values.observe)
      assert.equal(
        probe.lanes[lane]?.fullReads ?? 0,
        0,
        `${label} read the full catalog`,
      );
  }
  await phase(
    "version-baseline",
    () => get("/api/version"),
    "GET /api/version",
  );
  await phase("list", () => list(), "GET " + root, true);
  await phase(
    "project-page",
    async () => {
      const response = await list(projectId, 1);
      assert.equal(response.body.items[0].id, fixture.active[8].id);
      return response;
    },
    "GET " + root,
  );
  const detail = root + "/" + fixture.active[0].id;
  await phase(
    "detail",
    async () => {
      const response = await get(detail);
      assert.equal(response.body.id, fixture.active[0].id);
      return response;
    },
    "GET " + root + "/@",
  );
  await phase(
    "miss",
    async () => {
      const response = await get(root + "/v0-scale-absent", 404);
      assert.equal(response.body.error.code, "session_not_found");
      return response;
    },
    "GET " + root + "/v0-scale-absent",
    true,
  );
  for (const session of fixture.active.slice(0, 2)) {
    const conversation = `${root}/${session.id}/conversation`;
    const lane = "GET " + root + "/@/conversation";
    const read = async () => {
      const response = await get(conversation + "?maxMessages=1");
      assert.equal(response.body.sessionId, session.id);
      assert.equal(response.body.messages.length, 1);
      return response;
    };
    const first = await read();
    save(session.provider + "-first-conversation", await snapshot(), {
      request: report([first]),
      transcriptBytes: statSync(session.file).size,
    });
    await phase(session.provider + "-conversation", read, lane);
    const followPath = conversation + "/follow?maxMessages=1&waitMs=0";
    const { body } = await get(followPath);
    assert.equal(body.changed, true);
    assert.equal(body.conversation.sessionId, session.id);
    assert.equal(typeof body.cursor, "string");
    await snapshot();
    await phase(
      session.provider + "-unchanged-follow",
      async () => {
        const response = await get(
          followPath + "&after=" + encodeURIComponent(body.cursor),
        );
        assert.equal(response.body.changed, false);
        assert.equal(response.body.conversation, null);
        return response;
      },
      lane + "/follow",
      true,
    );
  }
} finally {
  try {
    if (server) await disposeYaServerProcess(server);
  } finally {
    fixture.close();
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
