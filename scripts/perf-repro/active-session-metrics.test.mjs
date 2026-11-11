import assert from "node:assert/strict";
import test from "node:test";
import {
  parseDarwinSwap,
  parseServerTiming,
  targetChecks,
  observePageNetwork,
} from "./active-session-metrics.mjs";

test("Darwin swap and server timing preserve explicit missing evidence", () => {
  assert.deepEqual(
    parseDarwinSwap("total = 3072.00M used = 249.75M free = 2822.25M"),
    { total: 3072 * 1024 ** 2, free: 2822.25 * 1024 ** 2 },
  );
  assert.deepEqual(parseDarwinSwap("unavailable"), { total: null, free: null });
  assert.deepEqual(
    parseServerTiming(
      'ya-read;dur=1.25, ya-augment;dur=2;desc="messages=1", ya-total;dur=3.5',
    ),
    { "ya-read": 1.25, "ya-augment": 2, "ya-total": 3.5 },
  );
});
test("an open collection stream counts data in its arrival phase and retires request state", async () => {
  const handlers = new Map();
  let phase = "idle";
  const observed = await observePageNetwork(
    { send: async () => {}, on: (name, fn) => handlers.set(name, fn) },
    () => phase,
  );
  handlers.get("Network.responseReceived")({
    requestId: "live",
    response: { url: "http://localhost/api/activity/collections", headers: {} },
  });
  phase = "active";
  handlers.get("Network.dataReceived")({
    requestId: "live",
    dataLength: 123,
    encodedDataLength: 80,
  });
  assert.deepEqual(observed.chunks, [
    {
      phase: "active",
      route: "/api/activity/collections",
      decodedBytes: 123,
      encodedBytes: 80,
    },
  ]);
  handlers.get("Network.loadingFinished")({ requestId: "live" });
  handlers.get("Network.dataReceived")({
    requestId: "live",
    dataLength: 999,
    encodedDataLength: 999,
  });
  assert.equal(observed.chunks.length, 1);
});
test("missing phases, missing typing and host failure never pass qualification", () => {
  const empty = targetChecks({ args: {}, phases: {} }, []);
  assert.equal(empty.pass, false);
  assert.equal(empty.hostEligible, false);
  assert.ok(empty.checks.every((check) => check.status === "unmeasured"));
  const summary = {
    args: {},
    host: { eligibility: { pass: true } },
    phases: {
      active: {
        server: {
          mainThreadMsPerWrite: 6,
          processMsPerWrite: 16,
          loopDelayMs: { p99: 51 },
        },
        tabs: { session: { taskS: 0.2, taskMsPerWrite: 7 } },
        wallS: 10,
        writeToVisibleMs: { p95: 251, missing: 1 },
        typing: {
          samples: [{ actual: "lost", expected: "typed" }],
          errors: [],
          maxMs: 101,
        },
      },
    },
  };
  const result = targetChecks(summary, [
    {
      phase: "active",
      method: "GET",
      url: "/api/projects?summaryMode=retained",
    },
  ]);
  assert.equal(result.pass, false);
  assert.equal(result.hostEligible, false);
  assert.equal(result.baselineHostEligible, true);
  for (const metric of [
    "server.mainThreadMsPerWrite",
    "server.processMsPerWrite",
    "server.loopDelayP99Ms",
    "collections.listReloads",
    "typing.maxMs",
    "typing.badPrefixes",
    "writeToVisible.missing",
  ])
    assert.equal(
      result.checks.find((check) => check.metric === metric).status,
      "miss",
    );
  assert.equal(result.complete, false);
});

function eligibleNumericExample() {
  const hostWindow = {
    summary: {
      cpuBusyFraction: 0.1,
      maximumLoadPerEffectiveCpu: 0.1,
      minimumEffectiveAvailableMemoryBytes: 16 * 1024 ** 3,
      swapUsedBytesAtStart: 0,
      swapUsedBytesAtEnd: 0,
    },
  };
  const active = {
    host: hostWindow,
    writes: 10,
    wallS: 10,
    server: {
      mainThreadMsPerWrite: 2,
      processMsPerWrite: 4,
      loopDelayMs: { p99: 10 },
    },
    tabs: { session: { taskS: 0.02, taskMsPerWrite: 2 } },
    writeToVisibleMs: { p95: 50, missing: 0 },
    typing: {
      samples: [{ expected: "a", actual: "a", ms: 20 }],
      errors: [],
      maxMs: 20,
    },
  };
  return {
    args: {},
    runtimeIdentity: { unchanged: true },
    host: {
      capacity: { cpu: { effectiveLogicalCpuCount: 4 } },
      policy: {
        minimumEffectiveAvailableMemoryMiB: 2048,
        minimumEffectiveLogicalCpuCount: 2,
        maximumBaselineCpuBusyFraction: 0.8,
        minimumIdleLogicalCpuCount: 1,
        maximumBaselineLoadPerEffectiveCpu: 2,
        maximumBaselineSwapGrowthMiB: 16,
      },
      eligibility: { pass: true },
    },
    phases: {
      active,
      idle: { host: hostWindow, server: { rssMB: 200 } },
      additionalTab: { host: hostWindow, server: { processMsPerWrite: 4.5 } },
      lists: { host: hostWindow, inbox: { medianMs: 3 } },
      restart: { host: hostWindow, listsCompleteMs: 500 },
      open: {
        host: hostWindow,
        firstPaintMs: 100,
        network: {
          open: {
            serverTimings: [
              { route: "/api/projects/p/sessions/s", ms: { "ya-total": 30 } },
            ],
          },
        },
      },
    },
  };
}
test("numeric subset can pass without certifying the goal; profilers and missing resource windows cannot", () => {
  const summary = eligibleNumericExample();
  const clean = targetChecks(summary, []);
  assert.equal(clean.observedGatePass, true);
  assert.equal(clean.pass, false);
  assert.equal(clean.complete, false);
  for (const flag of ["cpu-profile", "browser-profile"]) {
    summary.args = { [flag]: true };
    assert.equal(targetChecks(summary, []).observedGatePass, false);
  }
  summary.args = {};
  summary.runtimeIdentity.unchanged = false;
  assert.equal(targetChecks(summary, []).observedGatePass, false);
  summary.runtimeIdentity.unchanged = true;
  delete summary.phases.restart.host;
  assert.equal(targetChecks(summary, []).resourceWindowsPass, false);
  assert.equal(targetChecks(summary, []).observedGatePass, false);
});
test("duplicate incremental detail fetches fail the request budget despite zero list reloads", () => {
  const summary = eligibleNumericExample();
  const requests = Array.from({ length: 11 }, () => ({
    phase: "active",
    method: "GET",
    url: "/api/projects/p/sessions/s?afterMessageId=m",
  }));
  const result = targetChecks(summary, requests);
  assert.equal(
    result.checks.find((c) => c.metric === "collections.listReloads").status,
    "observed-pass",
  );
  assert.equal(
    result.checks.find((c) => c.metric === "transcript.detailFetchesPerWrite")
      .status,
    "miss",
  );
  assert.equal(result.observedGatePass, false);
});

test("runtime identity follows the server's shared workspace link and detects changed runtime bytes", async () => {
  const { mkdtemp, mkdir, writeFile, symlink, rm, realpath } = await import(
    "node:fs/promises"
  );
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { runtimeIdentity } = await import("./active-session-build.mjs");
  const root = await mkdtemp(join(tmpdir(), "active-session-build-"));
  try {
    const server = join(root, "server/dist"),
      client = join(root, "client"),
      shared = join(root, "workspace/shared");
    await Promise.all([
      mkdir(server, { recursive: true }),
      mkdir(client),
      mkdir(join(shared, "dist"), { recursive: true }),
      mkdir(join(root, "server/node_modules/@yep-anywhere"), {
        recursive: true,
      }),
    ]);
    await writeFile(join(server, "index.js"), "import '@yep-anywhere/shared';");
    await writeFile(join(client, "index.html"), "client");
    await writeFile(
      join(shared, "package.json"),
      JSON.stringify({
        name: "@yep-anywhere/shared",
        type: "module",
        exports: { import: "./dist/index.js" },
      }),
    );
    await writeFile(join(shared, "dist/index.js"), "export const value = 1;");
    await symlink(
      shared,
      join(root, "server/node_modules/@yep-anywhere/shared"),
      "junction",
    );
    const before = runtimeIdentity(server, client);
    assert.equal(before.shared.root, await realpath(join(shared, "dist")));
    await writeFile(join(shared, "dist/index.js"), "export const value = 2;");
    const after = runtimeIdentity(server, client);
    assert.notEqual(before.shared.sha256, after.shared.sha256);
    assert.deepEqual(before.server, after.server);
    assert.deepEqual(before.client, after.client);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
