import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import {
  SUITE_VERSION,
  assertCount,
  bodyArray,
  bytesToMiB,
  round,
  summarize,
} from "./core.mjs";
import {
  createFixture,
  findPortPair,
  readProcessManifest,
  requestJson,
  startServer,
  stopServer,
} from "./process-fixture.mjs";
import {
  addBuiltClientReadinessObserver,
  browserMarkDuration,
  selectedFixtureTarget,
  waitForFinalDisplay,
} from "./telemetry.mjs";

export async function measureServerUsefulReadiness({
  config,
  expectedMessages,
  server,
  target,
}) {
  const requestStartedAtMs = performance.now();
  const response = await requestJson(target.apiUrl, {
    needle: target.marker,
    timeoutMs: config.server.requestTimeoutMs,
  });
  if (typeof response.needleMs !== "number") {
    throw new Error(
      "selected-session response omitted the expected tail marker",
    );
  }
  assertCount(
    bodyArray(response.body, "messages", "useful-readiness detail").length,
    expectedMessages,
    "useful-readiness message count",
  );
  return {
    requestMs: round(response.ms),
    responseBytes: response.bytes,
    responseNeedleMs: round(response.needleMs),
    startupToReadableMs: round(
      requestStartedAtMs + response.needleMs - server.processStartedAtMs,
    ),
  };
}

export async function measureBuiltClientColdReadiness({
  checkout,
  config,
  generalizedProjectPathsSupported,
  runMarker,
  server,
  target,
}) {
  const versionResponse = await requestJson(`${server.baseUrl}/api/version`, {
    timeoutMs: config.server.requestTimeoutMs,
  });
  const capabilities = Array.isArray(versionResponse.body?.capabilities)
    ? versionResponse.body.capabilities
    : [];
  const glossarySupported = capabilities.includes("glossary-tooltips");
  const playwrightPath = path.join(
    checkout,
    "packages/client/node_modules/@playwright/test/index.mjs",
  );
  const { chromium } = await import(pathToFileURL(playwrightPath).href);
  const browser = await chromium.launch({
    chromiumSandbox: true,
    env: { ...process.env, PERF_RUN_ID: runMarker },
    headless: true,
  });
  await appendFile(
    server.processManifestPath,
    `${JSON.stringify({
      recordedAt: new Date().toISOString(),
      role: "Playwright Chromium process tree",
      pid: null,
      pgid: null,
      marker: runMarker,
      tracking: "PERF_RUN_ID environment; perf-sweep is authoritative",
    })}\n`,
  );
  let context = null;
  try {
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    await addBuiltClientReadinessObserver(context, target, {
      glossarySupported,
      projectPathsSupported: generalizedProjectPathsSupported,
    });
    const page = await context.newPage();
    const navigationStartedAtMs = performance.now();
    await page.goto(target.url, { waitUntil: "domcontentloaded" });
    await waitForFinalDisplay(page, target, {
      glossarySupported,
      projectPathsSupported: generalizedProjectPathsSupported,
      started: navigationStartedAtMs,
      timeoutMs: config.server.requestTimeoutMs,
    });
    const observationReadStartedAtMs = performance.now();
    const observation = await page.evaluate(() => ({
      ...window.__yaPerfBuiltClientReadiness,
      browserNowMs: performance.now(),
    }));
    const observationReadEndedAtMs = performance.now();
    if (!observation || typeof observation.readableTailAtMs !== "number") {
      throw new Error("built-client readiness observer missed readable tail");
    }
    if (
      glossarySupported &&
      typeof observation.glossaryHighlightAtMs !== "number"
    ) {
      throw new Error(
        "built-client readiness observer missed glossary display",
      );
    }
    if (
      generalizedProjectPathsSupported &&
      typeof observation.projectPathHighlightAtMs !== "number"
    ) {
      throw new Error(
        "built-client readiness observer missed project-path display",
      );
    }
    const milestones = {
      readableTailMs: browserMarkDuration(
        observation,
        "readableTailAtMs",
        navigationStartedAtMs,
        observationReadStartedAtMs,
        observationReadEndedAtMs,
      ),
      glossaryHighlightMs: browserMarkDuration(
        observation,
        "glossaryHighlightAtMs",
        navigationStartedAtMs,
        observationReadStartedAtMs,
        observationReadEndedAtMs,
      ),
      projectPathHighlightMs: browserMarkDuration(
        observation,
        "projectPathHighlightAtMs",
        navigationStartedAtMs,
        observationReadStartedAtMs,
        observationReadEndedAtMs,
      ),
    };
    milestones.finalHighlightMs = Math.max(
      milestones.readableTailMs,
      milestones.glossaryHighlightMs ?? 0,
      milestones.projectPathHighlightMs ?? 0,
    );
    return {
      correctness: {
        glossarySupported,
        projectPathsRendered: generalizedProjectPathsSupported,
        readableTail: true,
      },
      milestones,
      observationClock: {
        source: "browser-performance-now-mutation-observer",
        nodeAlignment: "evaluate-midpoint-minus-browser-elapsed",
      },
    };
  } finally {
    try {
      await context?.close();
    } finally {
      await browser.close();
    }
  }
}

export async function measureBuiltClientRepetition({
  checkout,
  config,
  executionRevision,
  fixtureConfig,
  generalizedProjectPathsSupported,
  label,
  repetition,
  runMarker,
  scenario,
  scenarioName,
  workRoot,
}) {
  const repetitionRoot = path.join(workRoot, `rep-${repetition}`);
  await mkdir(repetitionRoot, { recursive: true });
  const fixture = await createFixture(repetitionRoot, scenario, fixtureConfig);
  const expectedMessages = scenario.initialTurns * 2;
  const basePort = config.server.portBase + repetition * 6;

  const serverLegRoot = path.join(repetitionRoot, "server-useful-readiness");
  await mkdir(serverLegRoot, { recursive: true });
  const serverLeg = await startServer({
    checkout,
    driver: "built-client",
    fixture,
    port: await findPortPair(basePort),
    root: serverLegRoot,
    config,
    runMarker,
  });
  let serverReadiness;
  let serverTarget;
  let serverManifest;
  try {
    serverTarget = selectedFixtureTarget(serverLeg, fixture, scenario);
    serverReadiness = await measureServerUsefulReadiness({
      config,
      expectedMessages,
      server: serverLeg,
      target: serverTarget,
    });
    serverManifest = await readProcessManifest(serverLeg.processManifestPath);
  } finally {
    serverLeg.log.end();
    await stopServer(serverLeg.child, serverLeg.providerHostRuntimeDir);
  }

  const browserLegRoot = path.join(repetitionRoot, "built-client-cold");
  await mkdir(browserLegRoot, { recursive: true });
  const browserLeg = await startServer({
    checkout,
    driver: "built-client",
    fixture,
    port: await findPortPair(basePort + 3),
    root: browserLegRoot,
    config,
    runMarker,
  });
  let browserReadiness;
  let browserManifest;
  try {
    const browserTarget = selectedFixtureTarget(browserLeg, fixture, scenario);
    browserReadiness = await measureBuiltClientColdReadiness({
      checkout,
      config,
      generalizedProjectPathsSupported,
      runMarker,
      server: browserLeg,
      target: browserTarget,
    });
    browserManifest = await readProcessManifest(browserLeg.processManifestPath);
  } finally {
    browserLeg.log.end();
    await stopServer(browserLeg.child, browserLeg.providerHostRuntimeDir);
  }

  return {
    schemaVersion: 2,
    suiteVersion: SUITE_VERSION,
    identity: {
      executionRevision,
      fixtureRevision: fixture.fixtureRevision,
    },
    label,
    repetition,
    scenario: scenarioName,
    parameters: scenario,
    runtime: {
      driver: "built-client",
      node: process.version,
      providerExecutionBoundary: {
        discovery: "disabled-by-enabled-providers-filter",
        liveProviderAllowed: false,
        sessionLaunch: "in-process-mock",
      },
      processManifest: {
        builtClient: browserManifest,
        serverUsefulReadiness: serverManifest,
      },
      serverLog: {
        builtClient: browserLeg.logPath,
        serverUsefulReadiness: serverLeg.logPath,
      },
      serverStartupMs: round(serverLeg.startupMs),
      serverStartupToSelectedSessionReadableMs:
        serverReadiness.startupToReadableMs,
      builtClientServerStartupMs: round(browserLeg.startupMs),
    },
    correctness: {
      initialMessagesPerSession: expectedMessages,
      selectedProjectPath: serverTarget.projectPath,
      selectedSessionId: serverTarget.detail.sessionId,
      serverSelectedSessionReadable: true,
      ...browserReadiness.correctness,
      fixtureRevision: fixture.fixtureRevision,
      providerCatalogFamilies: config.fixture.providerCatalogFamilies,
    },
    latency: {
      serverSelectedSessionRequest: summarize([serverReadiness.requestMs]),
      builtClientColdTail: summarize([
        browserReadiness.milestones.readableTailMs,
      ]),
      builtClientColdGlossaryHighlight: summarize(
        [browserReadiness.milestones.glossaryHighlightMs].filter(
          (value) => typeof value === "number",
        ),
      ),
      builtClientColdProjectPathHighlight: summarize(
        [browserReadiness.milestones.projectPathHighlightMs].filter(
          (value) => typeof value === "number",
        ),
      ),
      builtClientColdFinalHighlight: summarize([
        browserReadiness.milestones.finalHighlightMs,
      ]),
    },
    browser: {
      builtClientColdStart: browserReadiness,
    },
    responseMiB: {
      serverSelectedSession: bytesToMiB(serverReadiness.responseBytes),
    },
    memory: null,
  };
}
