import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import {
  readHostCapacity,
  readHostSample,
  summarizeHostWindow,
  assessHostEligibility,
} from "../perf-suite/host-profile.mjs";
import { resolveHostEligibilityPolicy } from "../perf-suite/ratchet-evaluation.mjs";

export function parseDarwinSwap(text) {
  const bytes = (name) => {
    const match = new RegExp(name + "\\s*=\\s*([0-9.]+)([KMGT])").exec(text);
    return match
      ? Number(match[1]) * 1024 ** ("KMGT".indexOf(match[2]) + 1)
      : null;
  };
  const total = bytes("total"),
    used = bytes("used");
  return { total, free: total === null || used === null ? null : total - used };
}
export async function measuredHostSample(capacity) {
  const sample = await readHostSample(capacity);
  if (process.platform === "darwin") {
    const counters = os.cpus().map((cpu) => cpu.times);
    sample.cpuCounters = {
      idle: counters.reduce((n, cpu) => n + cpu.idle, 0),
      total: counters.reduce(
        (n, cpu) => n + Object.values(cpu).reduce((a, b) => a + b, 0),
        0,
      ),
    };
    sample.cpuSource = "node-os-cpus-times";
    try {
      const swap = parseDarwinSwap(
        execFileSync("sysctl", ["-n", "vm.swapusage"], { encoding: "utf8" }),
      );
      sample.memory.swapTotalBytes = swap.total;
      sample.memory.swapFreeBytes = swap.free;
      sample.memory.swapSource = "sysctl-vm.swapusage";
    } catch {
      sample.memory.swapSource = "unavailable";
    }
  }
  return sample;
}
export async function startHostEvidence(large) {
  const capacity = await readHostCapacity();
  const config = JSON.parse(
    readFileSync(new URL("../perf-suite/config.json", import.meta.url), "utf8"),
  );
  const policy = resolveHostEligibilityPolicy(config, "built-client");
  if (large)
    policy.minimumEffectiveAvailableMemoryMiB = Math.max(
      8192,
      policy.minimumEffectiveAvailableMemoryMiB,
    );
  const start = await measuredHostSample(capacity);
  await new Promise((resolve) =>
    setTimeout(resolve, policy.baselineSampleMs ?? 3000),
  );
  const end = await measuredHostSample(capacity);
  const baseline = summarizeHostWindow(capacity, start, end);
  return {
    capacity,
    policy,
    baseline,
    baselineSamples: { start, end },
    eligibility: assessHostEligibility(capacity, baseline, policy),
  };
}
export async function hostWindow(host, start) {
  const end = await measuredHostSample(host.capacity);
  return {
    start,
    end,
    summary: summarizeHostWindow(host.capacity, start, end),
  };
}
export function parseServerTiming(header = "") {
  return Object.fromEntries(
    [...header.matchAll(/(?:^|,)\s*([\w-]+);dur=([\d.]+)/g)].map((match) => [
      match[1],
      Number(match[2]),
    ]),
  );
}
/** Data events count bytes while a response is open, including NDJSON streams. */
export async function observePageNetwork(cdp, phase) {
  const pending = new Map(); // Run-owned requests, retired by loadingFinished/Failed.
  const chunks = [],
    timings = [];
  await cdp.send("Network.enable");
  cdp.on("Network.responseReceived", ({ requestId, response }) => {
    const url = new URL(response.url);
    if (!url.pathname.startsWith("/api/")) return;
    const route = url.pathname;
    pending.set(requestId, route);
    const header = Object.entries(response.headers).find(
      ([name]) => name.toLowerCase() === "server-timing",
    )?.[1];
    if (header)
      timings.push({
        phase: phase(),
        at: Date.now(),
        route,
        ms: parseServerTiming(String(header)),
      });
  });
  cdp.on(
    "Network.dataReceived",
    ({ requestId, dataLength, encodedDataLength }) => {
      const route = pending.get(requestId);
      if (route)
        chunks.push({
          phase: phase(),
          route,
          decodedBytes: dataLength,
          encodedBytes: encodedDataLength,
        });
    },
  );
  for (const name of ["Network.loadingFinished", "Network.loadingFailed"])
    cdp.on(name, ({ requestId }) => pending.delete(requestId));
  return { chunks, timings };
}
export async function typeDuringWrites(page, seconds) {
  const samples = [],
    errors = [];
  const text = "Keep typing across updates";
  const start = performance.now();
  // Probe early, near the expected compaction, and late. Short smoke runs use one burst.
  const offsets =
    seconds >= 30
      ? [5, seconds / 2, seconds - 8]
      : [Math.min(2, Math.max(0, seconds - 5))];
  for (const offset of [...new Set(offsets)]) {
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, offset * 1000 - (performance.now() - start)),
      ),
    );
    try {
      await page.bringToFront();
      const input = page.locator("textarea[data-composer-input]");
      await input.waitFor({ state: "visible", timeout: 5000 });
      await input.focus();
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.press("Backspace");
      let expected = "";
      for (const character of text) {
        expected += character;
        const at = performance.now();
        await page.keyboard.type(character);
        const actual = await input.evaluate(
          (node) =>
            new Promise((resolve) =>
              requestAnimationFrame(() => resolve(node.value)),
            ),
        );
        const ms = performance.now() - at;
        samples.push({ offset, expected, actual, ms });
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, 110 - ms)),
        );
      }
    } catch (error) {
      errors.push(String(error));
    }
  }
  return {
    samples,
    errors,
    maxMs: samples.length
      ? Math.max(...samples.map((sample) => sample.ms))
      : null,
    pass:
      !errors.length &&
      samples.length === text.length * new Set(offsets).size &&
      samples.every(
        (sample) => sample.actual === sample.expected && sample.ms <= 100,
      ),
  };
}

/** Missing clocks or an ineligible host cannot become a passing performance gate. */
export function targetChecks(summary, requests) {
  const active = summary.phases.active,
    idle = summary.phases.idle;
  const check = (metric, actual, max, note) => ({
    metric,
    actual: actual ?? null,
    max,
    status: !Number.isFinite(actual)
      ? "unmeasured"
      : actual <= max
        ? "observed-pass"
        : "miss",
    ...(note ? { note } : {}),
  });
  const listReloads = active
    ? requests.filter(
        (r) =>
          r.phase === "active" &&
          r.method === "GET" &&
          (/^\/api\/(?:sessions(?:\/stats)?|inbox|projects|project-queue)(?:\?|$)/.test(
            r.url,
          ) ||
            /^\/api\/projects\/[^/]+\/sessions(?:\?|$)/.test(r.url)),
      ).length
    : undefined;
  const detailFetches =
    active?.writes > 0
      ? requests.filter(
          (r) =>
            r.phase === "active" &&
            r.method === "GET" &&
            /^\/api\/projects\/[^/]+\/sessions\/[^/?]+(?:\?|$)/.test(r.url),
        ).length / active.writes
      : undefined;
  const typing = summary.phases.typing?.typing ?? active?.typing;
  const listTimes = Object.values(summary.phases.lists ?? {})
    .map((value) => value.medianMs)
    .filter((value) => typeof value === "number");
  const checks = [
    check(
      "server.mainThreadMsPerWrite",
      active?.server.mainThreadMsPerWrite,
      5,
    ),
    check("server.processMsPerWrite", active?.server.processMsPerWrite, 15),
    check("server.loopDelayP99Ms", active?.server.loopDelayMs.p99, 50),
    check("collections.listReloads", listReloads, 0),
    check("transcript.detailFetchesPerWrite", detailFetches, 1),
    check("tab.taskMsPerWrite", active?.tabs.session?.taskMsPerWrite, 5),
    check(
      "tab.cpuPercent",
      active ? (active.tabs.session?.taskS / active.wallS) * 100 : undefined,
      1,
    ),
    check("writeToVisible.p95Ms", active?.writeToVisibleMs?.p95, 250),
    check("writeToVisible.missing", active?.writeToVisibleMs?.missing, 0),
    check(
      "typing.maxMs",
      typing?.samples.length && typing.errors.length === 0
        ? typing.maxMs
        : undefined,
      100,
    ),
    check(
      "typing.badPrefixes",
      typing
        ? typing.samples.filter((sample) => sample.actual !== sample.expected)
            .length + typing.errors.length
        : undefined,
      0,
    ),
    check("idle.rssMiB", idle?.server.rssMB, 300),
    check(
      "lists.loopbackMedianMaxMs",
      listTimes.length ? Math.max(...listTimes) : undefined,
      10,
      "Loopback wall time is an upper bound, not a pure server clock.",
    ),
    check(
      "coldOpen.firstPaintMs",
      summary.phases.open?.firstPaintMs,
      300,
      "Contextual DOM insertion clock, not presented paint or the server-only target.",
    ),
    check(
      "restart.listsCompleteMs",
      summary.phases.restart?.listsCompleteMs,
      1000,
    ),
  ];
  const coldTimings = Object.values(summary.phases.open?.network ?? {})
    .flatMap((network) => network.serverTimings)
    .filter((timing) => /\/sessions\/[^/]+$/.test(timing.route))
    .map((timing) => timing.ms["ya-total"])
    .filter((value) => typeof value === "number");
  checks.push(
    check(
      "coldOpen.firstDetailServerMs",
      coldTimings[0],
      300,
      "Server-Timing route clock; excludes browser and response serialization.",
    ),
  );
  const extra = summary.phases.additionalTab;
  checks.push(
    check(
      "additionalTab.processMsPerWriteDelta",
      extra && active
        ? extra.server.processMsPerWrite - active.server.processMsPerWrite
        : undefined,
      1,
      "Sequential one/two-tab diagnostic; repeat before certifying a 1 ms delta.",
    ),
  );
  const phaseWindows = [
    "idle",
    "active",
    "additionalTab",
    "typing",
    "lists",
    "restart",
    "open",
  ]
    .filter((name) => summary.phases[name] !== undefined)
    .map((name) => summary.phases[name]);
  const resourceWindowsPass = Boolean(
    summary.host?.capacity &&
      summary.host?.policy &&
      phaseWindows.length &&
      phaseWindows.every(
        (phase) =>
          phase?.host?.summary &&
          assessHostEligibility(
            summary.host.capacity,
            phase.host.summary,
            summary.host.policy,
          ).pass,
      ),
  );
  return {
    checks,
    baselineHostEligible: summary.host?.eligibility.pass === true,
    resourceWindowsPass,
    hostEligible:
      summary.host?.eligibility.pass === true && resourceWindowsPass,
    allObservedPass: checks.every((item) => item.status === "observed-pass"),
    runtimeUnchanged: summary.runtimeIdentity?.unchanged === true,
    observedGatePass:
      summary.runtimeIdentity?.unchanged === true &&
      summary.host?.eligibility.pass === true &&
      resourceWindowsPass &&
      !summary.args["cpu-profile"] &&
      !summary.args["browser-profile"] &&
      checks.every((item) => item.status === "observed-pass"),
    complete: false,
    pass: false,
    open: [
      "Idle CPU has no numeric target; compare scale and attribute recurring work.",
      "Flatness needs repeated controls across session count/history length.",
      "Live-stream few-KB delivery and no whole-history parse need source/byte attribution.",
      "Sequential additional-tab deltas need interleaved repetitions.",
      "No list discovery/rescan on restart needs source attribution.",
      "Cold server-only critical path and parsed long-session peak retention need separate attribution.",
    ],
  };
}
