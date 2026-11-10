import { performance } from "node:perf_hooks";
import {
  bytesToMiB,
  getMetric,
  percentile,
  round,
  summarize,
} from "./core.mjs";

const EXTERNAL_SUMMARY_COUNTER_FIELDS = [
  "enqueuedTasks",
  "deduplicatedTasks",
  "clearedTasks",
  "batchesStarted",
  "batchesCompleted",
  "tasksStarted",
  "tasksSucceeded",
  "tasksFailed",
  "totalTaskDurationMs",
  "totalBatchDurationMs",
];
const EXPECTED_GLOSSARY_TITLE =
  "glossary-tooltips: Glossary tooltips enrich every Markdown-render-eligible view with subtle, copyable definition hints from one governing current GLOSSARY.md and its project-contained include graph, using an in-memory compiled phrase automaton to keep matching linear in rendered text.";
const EXPECTED_PROJECT_PATHS = [
  "topics/glossary-tooltips.md",
  "packages/server/src/augments/project-path-links.ts",
  "README.md",
];
const NEGATIVE_PROJECT_PATHS = [
  "runs/perf-absent.jsonl",
  "text/plain",
  "v2.1.223",
];

export function requestProfile(response) {
  const header = response.headers?.["server-timing"];
  const serverTimings = {};
  const serverTimingDescriptions = {};
  if (typeof header === "string") {
    for (const entry of header.split(",")) {
      const match = /^\s*([^;\s]+);dur=([0-9.]+)(?:;desc="([^"]*)")?\s*$/.exec(
        entry,
      );
      if (match) {
        serverTimings[match[1]] = Number(match[2]);
        if (match[3] !== undefined)
          serverTimingDescriptions[match[1]] = match[3];
      }
    }
  }
  const augmentDescription = serverTimingDescriptions["ya-augment"];
  const augmentCounts = Object.fromEntries(
    typeof augmentDescription === "string"
      ? augmentDescription
          .split(" ")
          .map((part) => /^([^=]+)=([0-9]+)$/.exec(part))
          .filter((match) => match !== null)
          .map((match) => [match[1], Number(match[2])])
      : [],
  );
  const augmentation = [
    "messages",
    "changed",
    "cache-hit",
    "cache-join",
    "cache-miss",
  ].every((name) => Number.isFinite(augmentCounts[name]))
    ? {
        inputMessages: augmentCounts.messages,
        changedMessages: augmentCounts.changed,
        cacheHits: augmentCounts["cache-hit"],
        cacheJoins: augmentCounts["cache-join"],
        cacheMisses: augmentCounts["cache-miss"],
      }
    : null;
  const owners = [
    "ya-project",
    "ya-read",
    "ya-normalize",
    "ya-route",
    "ya-augment",
  ];
  // Older execution revisions have no separate metadata clock.
  if (typeof serverTimings["ya-metadata"] === "number")
    owners.push("ya-metadata");
  const serverTotalMs = serverTimings["ya-total"];
  const ownerValues = owners.map((name) => serverTimings[name]);
  const hasServerProfile =
    typeof serverTotalMs === "number" &&
    ownerValues.every((value) => typeof value === "number");
  const markedServerMs = hasServerProfile
    ? ownerValues.reduce((sum, value) => sum + value, 0)
    : null;
  const frameworkSerializeLoopbackMs = hasServerProfile
    ? Math.max(0, response.firstByteMs - serverTotalMs)
    : null;
  const serverPhaseResidualMs = hasServerProfile
    ? Math.max(0, serverTotalMs - markedServerMs)
    : null;
  const nonOverlappingPhases = hasServerProfile
    ? {
        projectMs: serverTimings["ya-project"],
        readMs: serverTimings["ya-read"],
        normalizeMs: serverTimings["ya-normalize"],
        routeMs: serverTimings["ya-route"],
        ...(typeof serverTimings["ya-metadata"] === "number"
          ? { metadataMs: serverTimings["ya-metadata"] }
          : {}),
        augmentMs: serverTimings["ya-augment"],
        serverResidualMs: serverPhaseResidualMs,
        frameworkSerializeLoopbackMs,
        bodyTransferMs: response.bodyTransferMs,
        jsonParseMs: response.jsonParseMs,
      }
    : null;
  const coveredMs = nonOverlappingPhases
    ? sumAvailablePhases(nonOverlappingPhases)
    : null;
  const harnessResidualMs =
    coveredMs === null ? null : Math.max(0, response.ms - coveredMs);
  if (nonOverlappingPhases && harnessResidualMs !== null) {
    nonOverlappingPhases.harnessResidualMs = harnessResidualMs;
  }
  return {
    available: hasServerProfile,
    bodyTransferMs: response.bodyTransferMs,
    coverage:
      coveredMs !== null && response.ms > 0
        ? {
            coveredMs: round(coveredMs + harnessResidualMs),
            fraction: round((coveredMs + harnessResidualMs) / response.ms),
            totalMs: round(response.ms),
          }
        : null,
    frameworkSerializeLoopbackMs,
    jsonParseMs: response.jsonParseMs,
    markedServerMs,
    nonOverlappingPhases,
    serverPhaseResidualMs,
    augmentation,
    serverTimingDescriptions,
    serverTimings,
  };
}

export function memoryView(sample) {
  const caches = sample.diagnostics?.caches ?? null;
  const knownCacheSourceBytes = caches
    ? (caches.claudeTranscript?.retainedSourceBytes ?? 0) +
      (caches.markdownAugments?.retainedBytes ?? 0) +
      (caches.projectPaths?.retainedBytes ?? 0)
    : null;
  return {
    heapUsedMiB: bytesToMiB(sample.heapUsedBytes),
    heapTotalMiB: bytesToMiB(sample.heapTotalBytes),
    rssMiB: bytesToMiB(sample.rssBytes),
    externalMiB: bytesToMiB(sample.externalBytes),
    arrayBuffersMiB: bytesToMiB(sample.arrayBuffersBytes),
    knownCaches: caches,
    relay: sample.diagnostics?.relay ?? null,
    background: sample.diagnostics?.background ?? null,
    residuals: {
      heapUsedLessKnownCacheSourceMiB:
        knownCacheSourceBytes === null
          ? null
          : bytesToMiB(sample.heapUsedBytes - knownCacheSourceBytes),
    },
    v8: sample.v8,
  };
}

export function externalSessionSummaryDiagnostics(sample) {
  return sample.diagnostics?.background?.externalSessionTracker
    ?.sessionSummaryBatch;
}

export function batchProcessorWindowState(diagnostics) {
  return {
    pendingTasks: diagnostics.pendingTasks,
    processing: diagnostics.processing,
    inFlightTasks: diagnostics.inFlightTasks,
    flushScheduled: diagnostics.flushScheduled,
    oldestPendingAgeMs: diagnostics.oldestPendingAgeMs,
  };
}

export function summarizeExternalSessionSummaryWindow(
  beforeSample,
  afterSample,
  window,
) {
  const before = externalSessionSummaryDiagnostics(beforeSample);
  const after = externalSessionSummaryDiagnostics(afterSample);
  if (!before || !after) {
    return { available: false, window };
  }

  const counters = Object.fromEntries(
    EXTERNAL_SUMMARY_COUNTER_FIELDS.map((field) => [
      field,
      round(
        Math.max(
          0,
          (after.counters?.[field] ?? 0) - (before.counters?.[field] ?? 0),
        ),
      ),
    ]),
  );
  const recentBatches = (after.recentBatches ?? []).filter(
    (batch) => batch.sequence > (before.lastBatchSequence ?? 0),
  );
  const summarizeBatchField = (field) =>
    summarize(
      recentBatches
        .map((batch) => batch[field])
        .filter((value) => typeof value === "number"),
    );

  return {
    available: true,
    window,
    start: batchProcessorWindowState(before),
    end: batchProcessorWindowState(after),
    counters,
    recentBatchesTruncated: counters.batchesCompleted > recentBatches.length,
    queueDelay: summarizeBatchField("queueDelayMs"),
    batchDuration: summarizeBatchField("durationMs"),
    maxTaskDuration: summarizeBatchField("maxTaskDurationMs"),
    recentBatches,
  };
}

export function summarizeRequestProfiles(profiles) {
  const available = profiles.filter((profile) => profile.available);
  const values = (selector, source = profiles) =>
    source
      .map(selector)
      .filter((value) => typeof value === "number" && Number.isFinite(value));
  return {
    availableCount: available.length,
    sampleCount: profiles.length,
    bodyTransfer: summarize(values((profile) => profile.bodyTransferMs)),
    jsonParse: summarize(values((profile) => profile.jsonParseMs)),
    phaseCoverage: phaseCoverageReport(available),
    server: {
      project: summarize(
        values((profile) => profile.serverTimings["ya-project"], available),
      ),
      read: summarize(
        values((profile) => profile.serverTimings["ya-read"], available),
      ),
      metadata: summarize(
        values((profile) => profile.serverTimings["ya-metadata"], available),
      ),
      normalize: summarize(
        values((profile) => profile.serverTimings["ya-normalize"], available),
      ),
      route: summarize(
        values((profile) => profile.serverTimings["ya-route"], available),
      ),
      augment: summarize(
        values((profile) => profile.serverTimings["ya-augment"], available),
      ),
      total: summarize(
        values((profile) => profile.serverTimings["ya-total"], available),
      ),
      marked: summarize(values((profile) => profile.markedServerMs, available)),
      residual: summarize(
        values((profile) => profile.serverPhaseResidualMs, available),
      ),
    },
    augmentation: {
      inputMessages: summarize(
        values((profile) => profile.augmentation?.inputMessages),
      ),
      changedMessages: summarize(
        values((profile) => profile.augmentation?.changedMessages),
      ),
      cacheHits: summarize(
        values((profile) => profile.augmentation?.cacheHits),
      ),
      cacheJoins: summarize(
        values((profile) => profile.augmentation?.cacheJoins),
      ),
      cacheMisses: summarize(
        values((profile) => profile.augmentation?.cacheMisses),
      ),
    },
    frameworkSerializeLoopback: summarize(
      values((profile) => profile.frameworkSerializeLoopbackMs, available),
    ),
  };
}

export async function clientTelemetry(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Performance.enable");
    const [client, nativeDom, performanceMetrics] = await Promise.all([
      page.evaluate(async () => {
        const memory = performance.memory;
        const detailStore = await import(
          "/src/lib/sessionDetail/sessionDetailStore.ts"
        );
        return {
          memory: memory
            ? {
                usedJSHeapMiB: memory.usedJSHeapSize / (1024 * 1024),
                totalJSHeapMiB: memory.totalJSHeapSize / (1024 * 1024),
                limitMiB: memory.jsHeapSizeLimit / (1024 * 1024),
              }
            : null,
          dom: {
            nodes: document.getElementsByTagName("*").length,
            messageRows: document.querySelectorAll("[data-message-render-row]")
              .length,
            streamingBlocks:
              document.querySelectorAll(".streaming-block").length,
            toolRows: document.querySelectorAll("[data-tool-row]").length,
          },
          transcriptMemory: detailStore.getSessionTranscriptMemoryStats(),
        };
      }),
      cdp.send("Memory.getDOMCounters"),
      cdp.send("Performance.getMetrics"),
    ]);
    const metrics = Object.fromEntries(
      performanceMetrics.metrics.map(({ name, value }) => [name, value]),
    );
    return {
      ...client,
      browserNative: {
        documents: nativeDom.documents,
        eventListeners: nativeDom.jsEventListeners,
        layoutObjects: metrics.LayoutObjects ?? null,
        nodes: nativeDom.nodes,
      },
    };
  } finally {
    await cdp.detach();
  }
}

export function sessionBrowserTarget(server, detail, turn) {
  return {
    detail,
    marker: `[${detail.sessionId}:assistant:${turn}]`,
    url:
      `${server.baseUrl}/projects/${encodeURIComponent(detail.projectId)}` +
      `/sessions/${encodeURIComponent(detail.sessionId)}`,
  };
}

export function selectedFixtureTarget(server, fixture, scenario) {
  const fixtureSession = fixture.sessionFiles[0];
  const project = server.readyProjects.find(
    (candidate) => candidate.path === fixtureSession.projectPath,
  );
  if (!project || typeof project.id !== "string") {
    throw new Error(
      `readiness project list omitted fixture path ${fixtureSession.projectPath}`,
    );
  }
  const detail = {
    projectId: project.id,
    sessionId: fixtureSession.sessionId,
  };
  return {
    ...sessionBrowserTarget(server, detail, scenario.initialTurns - 1),
    apiUrl:
      `${server.baseUrl}/api/projects/${encodeURIComponent(project.id)}` +
      `/sessions/${encodeURIComponent(fixtureSession.sessionId)}` +
      "?fullHistory=1&fullHistoryReason=performance-useful-readiness",
    projectPath: fixtureSession.projectPath,
  };
}

export async function addBuiltClientReadinessObserver(
  context,
  target,
  { glossarySupported, projectPathsSupported },
) {
  await context.addInitScript(
    ({
      expectedPaths,
      glossaryTitle,
      marker,
      observeGlossary,
      observePaths,
    }) => {
      localStorage.setItem("yep-anywhere-glossary-hints-enabled", "true");
      const state = {
        glossaryHighlightAtMs: null,
        marker,
        projectPathHighlightAtMs: null,
        readableTailAtMs: null,
      };
      window.__yaPerfBuiltClientReadiness = state;
      const inspect = () => {
        const row = [
          ...document.querySelectorAll("[data-message-render-row]"),
        ].find((candidate) => candidate.textContent?.includes(marker));
        if (
          state.readableTailAtMs === null &&
          document.body?.innerText.includes(marker)
        ) {
          state.readableTailAtMs = performance.now();
        }
        if (
          observeGlossary &&
          state.glossaryHighlightAtMs === null &&
          [...(row?.querySelectorAll("[data-glossary-term]") ?? [])].some(
            (term) =>
              (term.getAttribute("data-tooltip") ||
                term.getAttribute("title")) === glossaryTitle,
          )
        ) {
          state.glossaryHighlightAtMs = performance.now();
        }
        if (observePaths && state.projectPathHighlightAtMs === null && row) {
          const actualPaths = [
            ...row.querySelectorAll('a[data-ya-resource="local-file"]'),
          ].map((anchor) => anchor.getAttribute("data-ya-path") ?? "");
          if (
            expectedPaths.every((expected) =>
              actualPaths.some(
                (actual) =>
                  actual === expected || actual.endsWith(`/${expected}`),
              ),
            )
          ) {
            state.projectPathHighlightAtMs = performance.now();
          }
        }
        if (
          state.readableTailAtMs !== null &&
          (!observeGlossary || state.glossaryHighlightAtMs !== null) &&
          (!observePaths || state.projectPathHighlightAtMs !== null)
        ) {
          window.__yaPerfBuiltClientReadinessObserver?.disconnect();
        }
      };
      const install = () => {
        if (!document.documentElement) return false;
        const observer = new MutationObserver(inspect);
        observer.observe(document.documentElement, {
          attributes: true,
          childList: true,
          subtree: true,
        });
        window.__yaPerfBuiltClientReadinessObserver = observer;
        inspect();
        return true;
      };
      if (!install()) {
        document.addEventListener("readystatechange", install, { once: true });
      }
    },
    {
      expectedPaths: EXPECTED_PROJECT_PATHS,
      glossaryTitle: EXPECTED_GLOSSARY_TITLE,
      marker: target.marker,
      observeGlossary: glossarySupported,
      observePaths: projectPathsSupported,
    },
  );
}

export function browserMarkDuration(
  observation,
  field,
  navigationStartedAtMs,
  observationReadStartedAtMs,
  observationReadEndedAtMs,
) {
  const mark = observation[field];
  if (typeof mark !== "number") return null;
  const browserNowAtNodeMidpointMs =
    (observationReadStartedAtMs + observationReadEndedAtMs) / 2;
  const markAtNodeMs =
    browserNowAtNodeMidpointMs - (observation.browserNowMs - mark);
  const duration = markAtNodeMs - navigationStartedAtMs;
  if (duration < 0) {
    throw new Error(`${field} preceded built-client navigation`);
  }
  return round(duration);
}

export async function waitForReadableTail(page, marker, timeoutMs) {
  await page.waitForFunction(
    (needle) => document.body?.innerText.includes(needle),
    marker,
    { timeout: timeoutMs },
  );
}

export async function waitForFinalDisplay(
  page,
  target,
  {
    glossarySupported,
    preparedAppendObservation = false,
    projectPathsSupported,
    started,
    timeoutMs,
  },
) {
  await waitForReadableTail(page, target.marker, timeoutMs);
  const browserTiming = {
    readableTailAtMs: await page.evaluate(() => performance.now()),
    glossaryHighlightAtMs: null,
    projectPathHighlightAtMs: null,
    finalDisplayAtMs: null,
  };
  const milestones = {
    readableTailMs: performance.now() - started,
    glossaryHighlightMs: null,
    projectPathHighlightMs: null,
  };
  Object.defineProperty(milestones, "browserTiming", {
    enumerable: false,
    value: browserTiming,
  });
  if (glossarySupported) {
    try {
      await page.waitForFunction(
        ({ marker, title }) => {
          const row = [
            ...document.querySelectorAll("[data-message-render-row]"),
          ].find((candidate) => candidate.textContent?.includes(marker));
          return [
            ...(row?.querySelectorAll("[data-glossary-term]") ?? []),
          ].some(
            (term) =>
              (term.getAttribute("data-tooltip") ||
                term.getAttribute("title")) === title,
          );
        },
        { marker: target.marker, title: EXPECTED_GLOSSARY_TITLE },
        { timeout: timeoutMs },
      );
    } catch (error) {
      const diagnosis = await page.evaluate((marker) => {
        const row = [
          ...document.querySelectorAll("[data-message-render-row]"),
        ].find((candidate) => candidate.textContent?.includes(marker));
        return {
          enabled: localStorage.getItem("yep-anywhere-glossary-hints-enabled"),
          rowGlossaryTitles: [
            ...(row?.querySelectorAll("[data-glossary-term]") ?? []),
          ].map((term) => ({
            themed: term.getAttribute("data-tooltip"),
            title: term.getAttribute("title"),
          })),
          rowText: row?.textContent?.slice(0, 500) ?? null,
        };
      }, target.marker);
      throw new Error(
        `glossary final display missing: ${JSON.stringify(diagnosis)}`,
        { cause: error },
      );
    }
    milestones.glossaryHighlightMs = performance.now() - started;
    browserTiming.glossaryHighlightAtMs = await page.evaluate(() =>
      performance.now(),
    );
  }
  if (projectPathsSupported) {
    await page.waitForFunction(
      ({ expectedPaths, marker }) => {
        const row = [
          ...document.querySelectorAll("[data-message-render-row]"),
        ].find((candidate) => candidate.textContent?.includes(marker));
        if (!row) return false;
        const paths = [
          ...row.querySelectorAll('a[data-ya-resource="local-file"]'),
        ].map((anchor) => anchor.getAttribute("data-ya-path") ?? "");
        return expectedPaths.every((expected) =>
          paths.some(
            (actual) => actual === expected || actual.endsWith(`/${expected}`),
          ),
        );
      },
      { expectedPaths: EXPECTED_PROJECT_PATHS, marker: target.marker },
      { timeout: timeoutMs },
    );
    milestones.projectPathHighlightMs = performance.now() - started;
    browserTiming.projectPathHighlightAtMs = await page.evaluate(() =>
      performance.now(),
    );
    const wronglyLinked = await page.evaluate(
      ({ marker, negativePaths }) => {
        const row = [
          ...document.querySelectorAll("[data-message-render-row]"),
        ].find((candidate) => candidate.textContent?.includes(marker));
        if (!row) return negativePaths;
        const linkedText = [
          ...row.querySelectorAll('a[data-ya-resource="local-file"]'),
        ].map((anchor) => anchor.textContent ?? "");
        return negativePaths.filter((negative) =>
          linkedText.some((text) => text.includes(negative)),
        );
      },
      { marker: target.marker, negativePaths: NEGATIVE_PROJECT_PATHS },
    );
    if (wronglyLinked.length > 0) {
      throw new Error(
        `project-path negative controls were linked: ${wronglyLinked.join(", ")}`,
      );
    }
  }
  milestones.finalHighlightMs = Math.max(
    milestones.readableTailMs,
    milestones.glossaryHighlightMs ?? 0,
    milestones.projectPathHighlightMs ?? 0,
  );
  browserTiming.finalDisplayAtMs =
    browserTiming.projectPathHighlightAtMs ??
    browserTiming.glossaryHighlightAtMs ??
    browserTiming.readableTailAtMs;
  if (preparedAppendObservation) {
    const observed = await page.evaluate((marker) => {
      const state = window.__yaPerfAppendDisplay;
      if (!state || state.marker !== marker) return null;
      window.__yaPerfAppendDisplayObserver?.disconnect();
      return {
        glossaryHighlightAtMs: state.glossaryHighlightAtMs,
        projectPathHighlightAtMs: state.projectPathHighlightAtMs,
        readableTailAtMs: state.readableTailAtMs,
        startedAtMs: state.startedAtMs,
      };
    }, target.marker);
    if (
      !observed ||
      typeof observed.readableTailAtMs !== "number" ||
      (glossarySupported &&
        typeof observed.glossaryHighlightAtMs !== "number") ||
      (projectPathsSupported &&
        typeof observed.projectPathHighlightAtMs !== "number")
    ) {
      throw new Error("prepared append display observer missed a milestone");
    }
    browserTiming.readableTailAtMs = observed.readableTailAtMs;
    browserTiming.glossaryHighlightAtMs = observed.glossaryHighlightAtMs;
    browserTiming.projectPathHighlightAtMs = observed.projectPathHighlightAtMs;
    browserTiming.finalDisplayAtMs = Math.max(
      observed.readableTailAtMs,
      observed.glossaryHighlightAtMs ?? 0,
      observed.projectPathHighlightAtMs ?? 0,
    );
    milestones.readableTailMs =
      observed.readableTailAtMs - observed.startedAtMs;
    milestones.glossaryHighlightMs =
      observed.glossaryHighlightAtMs === null
        ? null
        : observed.glossaryHighlightAtMs - observed.startedAtMs;
    milestones.projectPathHighlightMs =
      observed.projectPathHighlightAtMs === null
        ? null
        : observed.projectPathHighlightAtMs - observed.startedAtMs;
    milestones.finalHighlightMs =
      browserTiming.finalDisplayAtMs - observed.startedAtMs;
  }
  return milestones;
}

export async function navigateSpa(page, url) {
  await page.evaluate((nextUrl) => {
    history.pushState(null, "", nextUrl);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, url);
}

export async function navigateProfiledSpa(page, url) {
  await page.evaluate((nextUrl) => {
    window.__yaPerfMarks = [];
    window.__yaPerfNavigationStartMs = performance.now();
    performance.clearResourceTimings();
    history.pushState(null, "", nextUrl);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, url);
}

export function phaseDuration(start, end) {
  if (typeof start !== "number" || typeof end !== "number" || end < start) {
    return null;
  }
  return round(end - start);
}

export function sumAvailablePhases(phases) {
  const values = Object.values(phases);
  return values.every((value) => typeof value === "number")
    ? round(values.reduce((sum, value) => sum + value, 0))
    : null;
}

export function phaseCoverageReport(profiles) {
  const available = profiles.filter(
    (profile) => profile.available && profile.coverage?.totalMs > 0,
  );
  const totalMs = available.reduce(
    (sum, profile) => sum + profile.coverage.totalMs,
    0,
  );
  if (totalMs <= 0) {
    return {
      explainedFraction: null,
      individuallySignificant: [],
      rankedPhases: [],
      smallestSetAt80Percent: [],
    };
  }
  const totals = new Map();
  for (const profile of available) {
    for (const [name, duration] of Object.entries(
      profile.nonOverlappingPhases,
    )) {
      totals.set(name, (totals.get(name) ?? 0) + duration);
    }
  }
  const rankedPhases = [...totals.entries()]
    .map(([name, duration]) => ({
      fraction: round(duration / totalMs),
      meanMs: round(duration / available.length),
      name,
    }))
    .sort((left, right) => right.fraction - left.fraction);
  const smallestSetAt80Percent = [];
  let explainedFraction = 0;
  for (const phase of rankedPhases) {
    if (explainedFraction >= 0.8) break;
    smallestSetAt80Percent.push(phase.name);
    explainedFraction += phase.fraction;
  }
  return {
    explainedFraction: round(explainedFraction),
    individuallySignificant: rankedPhases
      .filter((phase) => phase.fraction >= 0.1)
      .map((phase) => phase.name),
    rankedPhases,
    smallestSetAt80Percent,
  };
}

export async function collectClientNavigationProfile(
  page,
  target,
  milestones,
  timeoutMs,
) {
  const expectedPath =
    `/api/projects/${encodeURIComponent(target.detail.projectId)}` +
    `/sessions/${encodeURIComponent(target.detail.sessionId)}`;
  try {
    await page.waitForFunction(
      (path) =>
        performance
          .getEntriesByType("resource")
          .some((entry) => new URL(entry.name).pathname === path),
      expectedPath,
      { timeout: timeoutMs },
    );
  } catch (error) {
    const diagnosis = await page.evaluate(() => ({
      marks: window.__yaPerfMarks ?? [],
      resources: performance
        .getEntriesByType("resource")
        .map((entry) => entry.name),
    }));
    throw new Error(
      `session detail Resource Timing missing for ${expectedPath}: ${JSON.stringify(diagnosis)}`,
      { cause: error },
    );
  }
  const observed = await page.evaluate(
    ({ path, sessionId }) => {
      const marks = window.__yaPerfMarks ?? [];
      const resource = performance
        .getEntriesByType("resource")
        .find((entry) => new URL(entry.name).pathname === path);
      return {
        marks,
        navigationStartAtMs: window.__yaPerfNavigationStartMs ?? 0,
        resource: resource
          ? {
              responseEnd: resource.responseEnd,
              responseStart: resource.responseStart,
              startTime: resource.startTime,
            }
          : null,
        sessionId,
      };
    },
    { path: expectedPath, sessionId: target.detail.sessionId },
  );
  const browserTiming = milestones.browserTiming;
  if (typeof browserTiming?.finalDisplayAtMs !== "number") {
    return {
      available: false,
      reason: "final-display browser timestamp unavailable",
    };
  }
  const start = observed.marks.find(
    (mark) =>
      mark.name === "session_initial_load_start" &&
      mark.detail?.sessionId === observed.sessionId,
  );
  if (!start || !observed.resource) {
    return {
      available: false,
      reason: !start
        ? "session load marks unavailable"
        : "session detail resource timing unavailable",
    };
  }
  const marksAfterStart = observed.marks.filter(
    (mark) => mark.atMs >= start.atMs,
  );
  const dataReady = marksAfterStart.find(
    (mark) => mark.name === "session_initial_load_data_ready",
  );
  const stateQueued = marksAfterStart.find(
    (mark) => mark.name === "session_initial_messages_state_queued",
  );
  const commit = stateQueued
    ? marksAfterStart.find(
        (mark) =>
          mark.name === "message_list_commit_effect" &&
          mark.atMs >= stateQueued.atMs,
      )
    : null;
  if (!stateQueued || !commit) {
    return {
      available: false,
      reason: !stateQueued
        ? "session state-queued mark unavailable"
        : "MessageList commit mark unavailable",
    };
  }
  const restoredFromSnapshot = start.detail?.restoredFromSnapshot === true;
  const resource = observed.resource;
  const requestPhases = {
    loadStartToRequestStartMs: phaseDuration(start.atMs, resource.startTime),
    requestToResponseStartMs: phaseDuration(
      resource.startTime,
      resource.responseStart,
    ),
    responseTransferMs: phaseDuration(
      resource.responseStart,
      resource.responseEnd,
    ),
    responseEndToDataReadyMs: phaseDuration(
      resource.responseEnd,
      dataReady?.atMs,
    ),
    dataReadyToStateQueuedMs: phaseDuration(dataReady?.atMs, stateQueued.atMs),
  };
  const finalDisplayPhases = {
    commitToReadableTailMs: phaseDuration(
      commit.atMs,
      browserTiming.readableTailAtMs,
    ),
    ...(typeof browserTiming.glossaryHighlightAtMs === "number"
      ? {
          readableTailToGlossaryHighlightMs: phaseDuration(
            browserTiming.readableTailAtMs,
            browserTiming.glossaryHighlightAtMs,
          ),
        }
      : {}),
    ...(typeof browserTiming.projectPathHighlightAtMs === "number"
      ? {
          [typeof browserTiming.glossaryHighlightAtMs === "number"
            ? "glossaryToProjectPathHighlightMs"
            : "readableTailToProjectPathHighlightMs"]: phaseDuration(
            browserTiming.glossaryHighlightAtMs ??
              browserTiming.readableTailAtMs,
            browserTiming.projectPathHighlightAtMs,
          ),
        }
      : {}),
  };
  const revealPhases = {
    navigationToLoadStartMs: phaseDuration(
      observed.navigationStartAtMs,
      start.atMs,
    ),
    ...(restoredFromSnapshot
      ? {
          loadStartToStateQueuedMs: phaseDuration(start.atMs, stateQueued.atMs),
        }
      : requestPhases),
    stateQueuedToCommitMs: phaseDuration(stateQueued.atMs, commit.atMs),
    ...finalDisplayPhases,
  };
  const preprocessEnd = marksAfterStart
    .filter(
      (mark) =>
        mark.name === "message_list_preprocess_end" &&
        mark.atMs >= stateQueued.atMs &&
        mark.atMs <= commit.atMs,
    )
    .at(-1);
  const groupEnd = marksAfterStart
    .filter(
      (mark) =>
        mark.name === "message_list_group_end" &&
        mark.atMs >= stateQueued.atMs &&
        mark.atMs <= commit.atMs,
    )
    .at(-1);
  const preprocessMs =
    typeof preprocessEnd?.detail?.durationMs === "number"
      ? round(preprocessEnd.detail.durationMs)
      : null;
  const groupMs =
    typeof groupEnd?.detail?.durationMs === "number"
      ? round(groupEnd.detail.durationMs)
      : null;
  const queuedToCommitMs = revealPhases.stateQueuedToCommitMs;
  const renderOtherMs =
    typeof queuedToCommitMs === "number" &&
    typeof preprocessMs === "number" &&
    typeof groupMs === "number"
      ? round(Math.max(0, queuedToCommitMs - preprocessMs - groupMs))
      : null;
  const phaseTotalMs = sumAvailablePhases(revealPhases);
  const navigationToFinalDisplayMs = phaseDuration(
    observed.navigationStartAtMs,
    browserTiming.finalDisplayAtMs,
  );
  return {
    available: phaseTotalMs !== null,
    branch: restoredFromSnapshot
      ? "warm-cache-reveal-with-overlapping-refresh"
      : "network-before-reveal",
    coverage:
      phaseTotalMs !== null && navigationToFinalDisplayMs > 0
        ? {
            coveredMs: phaseTotalMs,
            fraction: round(phaseTotalMs / navigationToFinalDisplayMs),
            totalMs: navigationToFinalDisplayMs,
          }
        : null,
    messageListWithinQueuedToCommit: {
      groupMs,
      preprocessMs,
      renderOtherMs,
    },
    nonOverlappingPhases: revealPhases,
    refresh: {
      completedAfterFinalDisplay:
        resource.responseEnd > browserTiming.finalDisplayAtMs,
      phases: requestPhases,
      responseEndRelativeToFinalDisplayMs: round(
        resource.responseEnd - browserTiming.finalDisplayAtMs,
      ),
    },
  };
}

export async function prepareClientAppendProfile(
  page,
  target,
  { glossarySupported, projectPathsSupported },
) {
  await page.evaluate(
    ({ expectedPaths, glossaryTitle, marker, needsGlossary, needsPaths }) => {
      window.__yaPerfAppendDisplayObserver?.disconnect();
      const startedAtMs = performance.now();
      window.__yaPerfAppendStartMs = startedAtMs;
      const state = {
        glossaryHighlightAtMs: null,
        marker,
        projectPathHighlightAtMs: null,
        readableTailAtMs: null,
        startedAtMs,
      };
      window.__yaPerfAppendDisplay = state;
      const check = () => {
        const row = [
          ...document.querySelectorAll("[data-message-render-row]"),
        ].find((candidate) => candidate.textContent?.includes(marker));
        if (!row) return;
        const nowMs = performance.now();
        state.readableTailAtMs ??= nowMs;
        if (needsGlossary && state.glossaryHighlightAtMs === null) {
          const highlighted = [
            ...row.querySelectorAll("[data-glossary-term]"),
          ].some(
            (term) =>
              (term.getAttribute("data-tooltip") ||
                term.getAttribute("title")) === glossaryTitle,
          );
          if (highlighted) state.glossaryHighlightAtMs = nowMs;
        }
        if (needsPaths && state.projectPathHighlightAtMs === null) {
          const paths = [
            ...row.querySelectorAll('a[data-ya-resource="local-file"]'),
          ].map((anchor) => anchor.getAttribute("data-ya-path") ?? "");
          if (
            expectedPaths.every((expected) =>
              paths.some(
                (actual) =>
                  actual === expected || actual.endsWith(`/${expected}`),
              ),
            )
          ) {
            state.projectPathHighlightAtMs = nowMs;
          }
        }
        if (
          (!needsGlossary || state.glossaryHighlightAtMs !== null) &&
          (!needsPaths || state.projectPathHighlightAtMs !== null)
        ) {
          window.__yaPerfAppendDisplayObserver?.disconnect();
        }
      };
      const observer = new MutationObserver(check);
      window.__yaPerfAppendDisplayObserver = observer;
      observer.observe(document.body, {
        attributes: true,
        childList: true,
        subtree: true,
      });
      window.__yaPerfMarks = [];
      check();
    },
    {
      expectedPaths: EXPECTED_PROJECT_PATHS,
      glossaryTitle: EXPECTED_GLOSSARY_TITLE,
      marker: target.marker,
      needsGlossary: glossarySupported,
      needsPaths: projectPathsSupported,
    },
  );
}

export async function collectClientAppendProfile(page, milestones) {
  const observed = await page.evaluate(() => ({
    appendStartAtMs: window.__yaPerfAppendStartMs,
    marks: window.__yaPerfMarks ?? [],
  }));
  const browserTiming = milestones.browserTiming;
  const preprocessStart = observed.marks.find(
    (mark) => mark.name === "message_list_preprocess_start",
  );
  const changeReceived = observed.marks.find(
    (mark) =>
      mark.name === "session_file_change_received" &&
      mark.detail?.deduped !== true,
  );
  const fetchRequested = observed.marks.find(
    (mark) =>
      mark.name === "session_incremental_fetch_requested" &&
      mark.atMs >= (changeReceived?.atMs ?? Number.POSITIVE_INFINITY),
  );
  const requestStart = observed.marks.find(
    (mark) =>
      mark.name === "session_incremental_fetch_request_start" &&
      mark.atMs >= (fetchRequested?.atMs ?? Number.POSITIVE_INFINITY),
  );
  const requestId = requestStart?.detail?.requestId;
  const dataReady = observed.marks.find(
    (mark) =>
      mark.name === "session_incremental_fetch_data_ready" &&
      mark.detail?.requestId === requestId,
  );
  const stateQueued = observed.marks.find(
    (mark) =>
      mark.name === "session_incremental_fetch_state_queued" &&
      mark.detail?.requestId === requestId,
  );
  const preprocessEnd = observed.marks.find(
    (mark) =>
      mark.name === "message_list_preprocess_end" &&
      mark.atMs >= (preprocessStart?.atMs ?? Number.POSITIVE_INFINITY),
  );
  const groupEnd = observed.marks.find(
    (mark) =>
      mark.name === "message_list_group_end" &&
      mark.atMs >= (preprocessEnd?.atMs ?? Number.POSITIVE_INFINITY),
  );
  const commit = observed.marks.find(
    (mark) =>
      mark.name === "message_list_commit_effect" &&
      mark.atMs >= (groupEnd?.atMs ?? Number.POSITIVE_INFINITY),
  );
  const eventPathAvailable = Boolean(
    changeReceived &&
      fetchRequested &&
      requestStart &&
      dataReady &&
      stateQueued &&
      preprocessStart,
  );
  const eventPath = eventPathAvailable
    ? {
        available: true,
        browserClock: "performance.now",
        nonOverlappingPhases: {
          receivedToFetchRequestedMs: phaseDuration(
            changeReceived.atMs,
            fetchRequested.atMs,
          ),
          fetchRequestedToRequestStartMs: phaseDuration(
            fetchRequested.atMs,
            requestStart.atMs,
          ),
          requestToDataReadyMs: phaseDuration(
            requestStart.atMs,
            dataReady.atMs,
          ),
          dataReadyToStateQueuedMs: phaseDuration(
            dataReady.atMs,
            stateQueued.atMs,
          ),
          stateQueuedToPreprocessMs: phaseDuration(
            stateQueued.atMs,
            preprocessStart.atMs,
          ),
        },
        sourceFacts: {
          route: changeReceived.detail?.route,
          eventSource: changeReceived.detail?.eventSource,
          changeVersion: changeReceived.detail?.changeVersion,
          sourceObservedAt: changeReceived.detail?.sourceObservedAt,
          eventTimestamp: changeReceived.detail?.eventTimestamp,
          mtimeMs: changeReceived.detail?.mtimeMs,
          size: changeReceived.detail?.size,
          wallClock: "server-wall-clock; do not subtract from browser marks",
        },
      }
    : {
        available: false,
        reason: "append file-change/fetch phase marks unavailable",
      };
  if (
    typeof observed.appendStartAtMs !== "number" ||
    !preprocessStart ||
    !preprocessEnd ||
    !groupEnd ||
    !commit ||
    typeof browserTiming?.finalDisplayAtMs !== "number"
  ) {
    return {
      available: false,
      eventPath,
      reason: "append MessageList phase marks unavailable",
    };
  }
  const groupDurationMs =
    typeof groupEnd.detail?.durationMs === "number"
      ? groupEnd.detail.durationMs
      : 0;
  const groupStartAtMs = groupEnd.atMs - groupDurationMs;
  const phases = {
    appendStartToPreprocessMs: phaseDuration(
      observed.appendStartAtMs,
      preprocessStart.atMs,
    ),
    preprocessMs: phaseDuration(preprocessStart.atMs, preprocessEnd.atMs),
    preprocessToGroupMs: phaseDuration(preprocessEnd.atMs, groupStartAtMs),
    groupMs: phaseDuration(groupStartAtMs, groupEnd.atMs),
    groupToCommitMs: phaseDuration(groupEnd.atMs, commit.atMs),
    commitToReadableTailMs: phaseDuration(
      commit.atMs,
      browserTiming.readableTailAtMs,
    ),
    ...(typeof browserTiming.glossaryHighlightAtMs === "number"
      ? {
          readableTailToGlossaryHighlightMs: phaseDuration(
            browserTiming.readableTailAtMs,
            browserTiming.glossaryHighlightAtMs,
          ),
        }
      : {}),
    ...(typeof browserTiming.projectPathHighlightAtMs === "number"
      ? {
          [typeof browserTiming.glossaryHighlightAtMs === "number"
            ? "glossaryToProjectPathHighlightMs"
            : "readableTailToProjectPathHighlightMs"]: phaseDuration(
            browserTiming.glossaryHighlightAtMs ??
              browserTiming.readableTailAtMs,
            browserTiming.projectPathHighlightAtMs,
          ),
        }
      : {}),
  };
  const coveredMs = sumAvailablePhases(phases);
  const totalMs = phaseDuration(
    observed.appendStartAtMs,
    browserTiming.finalDisplayAtMs,
  );
  return {
    available: coveredMs !== null,
    coverage:
      coveredMs !== null && totalMs > 0
        ? { coveredMs, fraction: round(coveredMs / totalMs), totalMs }
        : null,
    nonOverlappingPhases: phases,
    eventPath,
  };
}

export function summarizeClientAppendProfiles(profiles) {
  const available = profiles.filter((profile) => profile.available);
  const eventPathAvailable = profiles.filter(
    (profile) => profile.eventPath?.available,
  );
  const names = [
    ...new Set(
      available.flatMap((profile) =>
        Object.keys(profile.nonOverlappingPhases ?? {}),
      ),
    ),
  ];
  const eventPathPhaseNames = [
    ...new Set(
      eventPathAvailable.flatMap((profile) =>
        Object.keys(profile.eventPath.nonOverlappingPhases ?? {}),
      ),
    ),
  ];
  return {
    availableCount: available.length,
    coverage: {
      minimumFraction:
        available.length > 0
          ? round(
              Math.min(
                ...available.map((profile) => profile.coverage?.fraction ?? 0),
              ),
            )
          : null,
      medianFraction:
        available.length > 0
          ? round(
              percentile(
                available.map((profile) => profile.coverage?.fraction ?? 0),
                0.5,
              ),
            )
          : null,
    },
    nonOverlappingPhases: Object.fromEntries(
      names.map((name) => [
        name,
        summarize(
          available
            .map((profile) => profile.nonOverlappingPhases[name])
            .filter((value) => typeof value === "number"),
        ),
      ]),
    ),
    eventPath: {
      availableCount: eventPathAvailable.length,
      nonOverlappingPhases: Object.fromEntries(
        eventPathPhaseNames.map((name) => [
          name,
          summarize(
            eventPathAvailable
              .map((profile) => profile.eventPath.nonOverlappingPhases[name])
              .filter((value) => typeof value === "number"),
          ),
        ]),
      ),
      routeCounts: Object.fromEntries(
        [
          ...new Set(
            eventPathAvailable.map(
              (profile) => profile.eventPath.sourceFacts.route,
            ),
          ),
        ].map((route) => [
          route ?? "unknown",
          eventPathAvailable.filter(
            (profile) => profile.eventPath.sourceFacts.route === route,
          ).length,
        ]),
      ),
      sampleCount: profiles.length,
      unavailableCount: profiles.length - eventPathAvailable.length,
    },
    phaseCoverage: phaseCoverageReport(available),
    sampleCount: profiles.length,
    unavailableCount: profiles.length - available.length,
  };
}

export function summarizeClientNavigationProfiles(profiles) {
  const available = profiles.filter((profile) => profile.available);
  const phaseSummary = (path) =>
    summarize(
      available
        .map((profile) => getMetric(profile, path))
        .filter((value) => typeof value === "number"),
    );
  const branches = Object.fromEntries(
    [...new Set(available.map((profile) => profile.branch))].map((branch) => [
      branch,
      available.filter((profile) => profile.branch === branch).length,
    ]),
  );
  const phaseNames = [
    ...new Set(
      available.flatMap((profile) =>
        Object.keys(profile.nonOverlappingPhases ?? {}),
      ),
    ),
  ];
  const refreshPhaseNames = [
    ...new Set(
      available.flatMap((profile) =>
        Object.keys(profile.refresh?.phases ?? {}),
      ),
    ),
  ];
  return {
    availableCount: available.length,
    branches,
    coverage: {
      minimumFraction:
        available.length > 0
          ? round(
              Math.min(
                ...available.map((profile) => profile.coverage?.fraction ?? 0),
              ),
            )
          : null,
      medianFraction:
        available.length > 0
          ? round(
              percentile(
                available.map((profile) => profile.coverage?.fraction ?? 0),
                0.5,
              ),
            )
          : null,
    },
    messageListWithinQueuedToCommit: Object.fromEntries(
      ["groupMs", "preprocessMs", "renderOtherMs"].map((name) => [
        name,
        phaseSummary(`messageListWithinQueuedToCommit.${name}`),
      ]),
    ),
    nonOverlappingPhases: Object.fromEntries(
      phaseNames.map((name) => [
        name,
        phaseSummary(`nonOverlappingPhases.${name}`),
      ]),
    ),
    phaseCoverage: phaseCoverageReport(available),
    refresh: {
      completedAfterFinalDisplayCount: available.filter(
        (profile) => profile.refresh.completedAfterFinalDisplay,
      ).length,
      phases: Object.fromEntries(
        refreshPhaseNames.map((name) => [
          name,
          phaseSummary(`refresh.phases.${name}`),
        ]),
      ),
      responseEndRelativeToFinalDisplayMs: phaseSummary(
        "refresh.responseEndRelativeToFinalDisplayMs",
      ),
    },
    sampleCount: profiles.length,
    unavailableReasons: Object.fromEntries(
      [
        ...new Set(
          profiles
            .filter((profile) => !profile.available)
            .map((profile) => profile.reason),
        ),
      ].map((reason) => [
        reason,
        profiles.filter((profile) => profile.reason === reason).length,
      ]),
    ),
  };
}
