import { appendFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { sampleChromiumProcessMemory } from "./browser-memory.mjs";
import { assertCount, round, summarize } from "./core.mjs";
import { wait } from "./process-fixture.mjs";
import {
  clientTelemetry,
  collectClientAppendProfile,
  collectClientNavigationProfile,
  navigateProfiledSpa,
  navigateSpa,
  prepareClientAppendProfile,
  sessionBrowserTarget,
  summarizeClientAppendProfiles,
  summarizeClientNavigationProfiles,
  waitForFinalDisplay,
} from "./telemetry.mjs";

export function waitWithTimeout(promise, timeoutMs, description) {
  return Promise.race([
    promise,
    wait(timeoutMs).then(() => {
      throw new Error(`${description} timed out after ${timeoutMs} ms`);
    }),
  ]);
}

function summarizeLongTasks(tasks) {
  return {
    count: tasks.length,
    maxMs: round(Math.max(0, ...tasks.map((task) => task.durationMs))),
    totalMs: round(tasks.reduce((total, task) => total + task.durationMs, 0)),
  };
}

function summarizeInteractionMetric(trials, select) {
  const values = trials
    .map(select)
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  return values.length > 0 ? summarize(values) : null;
}

export function summarizeInteractionTrials(trials) {
  const sidebarSwitchValues = trials.flatMap((trial) =>
    (trial.sidebarSwitch?.switches ?? []).map((entry) => entry.nextPaintMs),
  );
  const sidebarSwitchRetainedValues = trials.flatMap((trial) =>
    (trial.sidebarSwitch?.switches ?? [])
      .filter((entry) => entry.dom?.reused === true)
      .map((entry) => entry.nextPaintMs),
  );
  return {
    conversation: {
      typingKeyToFrameP95: summarizeInteractionMetric(
        trials,
        (trial) => trial.conversation?.typing.keyToFrameP95Ms,
      ),
      scrollFrameP95: summarizeInteractionMetric(
        trials,
        (trial) => trial.conversation?.scroll.frameP95Ms,
      ),
      scrollMissedFrameFraction: summarizeInteractionMetric(
        trials,
        (trial) => trial.conversation?.scroll.missedFrameFraction,
      ),
    },
    full: {
      typingKeyToFrameP95: summarizeInteractionMetric(
        trials,
        (trial) => trial.full?.typing.keyToFrameP95Ms,
      ),
      scrollFrameP95: summarizeInteractionMetric(
        trials,
        (trial) => trial.full?.scroll.frameP95Ms,
      ),
      scrollMissedFrameFraction: summarizeInteractionMetric(
        trials,
        (trial) => trial.full?.scroll.missedFrameFraction,
      ),
    },
    hoverCardWorkAfterDelay: summarizeInteractionMetric(
      trials,
      (trial) => trial.hoverCard?.workAfterDelayMs,
    ),
    olderHistoryNextPaint: summarizeInteractionMetric(
      trials,
      (trial) => trial.olderHistory?.nextPaintMs,
    ),
    projectionNextPaint: summarizeInteractionMetric(
      trials,
      (trial) => trial.projectionTransition?.nextPaintMs,
    ),
    sidebarSwitchNextPaint:
      sidebarSwitchValues.length > 0 ? summarize(sidebarSwitchValues) : null,
    sidebarSwitchRetainedNextPaint:
      sidebarSwitchRetainedValues.length > 0
        ? summarize(sidebarSwitchRetainedValues)
        : null,
    tooltipWorkAfterDelay: summarizeInteractionMetric(
      trials,
      (trial) => trial.tooltip?.workAfterDelayMs,
    ),
  };
}

async function twoAnimationFrames(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}

async function resetInteractionProbe(page) {
  await page.evaluate(() => {
    window.__yaPerfInteraction.keySamples = [];
    window.__yaPerfInteraction.longTasks = [];
  });
}

async function interactionProbeResult(page) {
  return page.evaluate(() => ({
    keySamples: window.__yaPerfInteraction.keySamples,
    longTasks: window.__yaPerfInteraction.longTasks,
  }));
}

async function recordSemanticMeasurement(page, name, valueMs) {
  await page.evaluate(
    ({ measurementName, measurementValueMs }) => {
      const harness = window.__YA_SEMANTIC_UI_ACTIONS__;
      if (harness?.kind !== "semantic-ui-action-harness") return;
      harness.recordMeasurement({
        side: "client",
        name: measurementName,
        valueMs: measurementValueMs,
      });
    },
    { measurementName: name, measurementValueMs: valueMs },
  );
}

async function collectInteractionState(
  page,
  cdp,
  { collectGarbage = false } = {},
) {
  if (collectGarbage) {
    await cdp.send("HeapProfiler.collectGarbage");
    await twoAnimationFrames(page);
  }
  const metrics = await cdp.send("Performance.getMetrics");
  const byName = Object.fromEntries(
    metrics.metrics.map((metric) => [metric.name, metric.value]),
  );
  return page.evaluate((cdpMetrics) => {
    const harness = window.__YA_SEMANTIC_UI_ACTIONS__;
    return {
      bodyTextLength: document.body?.innerText.length ?? 0,
      domElements: document.querySelectorAll("*").length,
      renderRows: document.querySelectorAll("[data-render-id]").length,
      heap: performance.memory
        ? {
            totalBytes: performance.memory.totalJSHeapSize,
            usedBytes: performance.memory.usedJSHeapSize,
          }
        : null,
      cdp: {
        documents: cdpMetrics.Documents,
        eventListeners: cdpMetrics.JSEventListeners,
        jsHeapTotalBytes: cdpMetrics.JSHeapTotalSize,
        jsHeapUsedBytes: cdpMetrics.JSHeapUsedSize,
        layoutObjects: cdpMetrics.LayoutObjects,
        nodes: cdpMetrics.Nodes,
      },
      semantic:
        harness?.kind === "semantic-ui-action-harness"
          ? {
              actions: harness.snapshot().actions.length,
              divergences: harness.snapshot().divergences.length,
              measurements: harness.snapshot().measurements.length,
              observedAnchorCount: harness.snapshot().observedAnchorCount,
              observedEvents: harness.snapshot().observedEvents.length,
            }
          : null,
    };
  }, byName);
}

async function measureComposerTyping(page, label) {
  const composer = page.locator("[data-composer-input]");
  await composer.fill("");
  await composer.focus();
  await resetInteractionProbe(page);
  const startedAtMs = await page.evaluate(() => performance.now());
  await composer.pressSequentially(
    "draft-1 The quick brown fox keeps composer input responsive.",
    { delay: 5 },
  );
  await twoAnimationFrames(page);
  const finishedAtMs = await page.evaluate(() => performance.now());
  const probe = await interactionProbeResult(page);
  await composer.fill("");
  const dispatch = probe.keySamples.map((sample) => sample.dispatchMs);
  const keyToFrame = probe.keySamples.map((sample) => sample.keyToFrameMs);
  if (dispatch.length === 0 || keyToFrame.length === 0) {
    throw new Error("composer typing produced no key-to-frame samples");
  }
  const result = {
    dispatchP95Ms: summarize(dispatch).p95Ms,
    elapsedMs: round(finishedAtMs - startedAtMs),
    keySamples: keyToFrame.length,
    keyToFrameMaxMs: round(Math.max(0, ...keyToFrame)),
    keyToFrameP50Ms: summarize(keyToFrame).medianMs,
    keyToFrameP95Ms: summarize(keyToFrame).p95Ms,
    longTasks: summarizeLongTasks(probe.longTasks),
  };
  await recordSemanticMeasurement(
    page,
    `performance-sprint.${label}.typing-key-to-frame-p95`,
    result.keyToFrameP95Ms,
  );
  return result;
}

async function measureTranscriptScroll(page, label) {
  await resetInteractionProbe(page);
  const result = await page.evaluate(async () => {
    const list = document.querySelector(".message-list");
    const scroll = list?.parentElement;
    if (!(scroll instanceof HTMLElement)) {
      throw new Error("message-list scroll owner was not available");
    }
    const maximum = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    if (maximum === 0) {
      throw new Error("message-list scroll owner had no scroll range");
    }
    const startingScrollTop = scroll.scrollTop;
    const frameIntervals = [];
    let priorFrameAt = null;
    const stepTo = async (target) => {
      for (let step = 1; step <= 120; step += 1) {
        const frameAt = await new Promise((resolve) =>
          requestAnimationFrame(resolve),
        );
        if (priorFrameAt !== null) frameIntervals.push(frameAt - priorFrameAt);
        priorFrameAt = frameAt;
        scroll.scrollTop =
          startingScrollTop + (target - startingScrollTop) * (step / 120);
      }
    };
    await stepTo(0);
    const topScrollTop = scroll.scrollTop;
    priorFrameAt = null;
    for (let step = 1; step <= 120; step += 1) {
      const frameAt = await new Promise((resolve) =>
        requestAnimationFrame(resolve),
      );
      if (priorFrameAt !== null) frameIntervals.push(frameAt - priorFrameAt);
      priorFrameAt = frameAt;
      scroll.scrollTop = maximum * (step / 120);
    }
    scroll.scrollTop = startingScrollTop;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return {
      finalScrollTop: scroll.scrollTop,
      frameIntervals,
      maximum,
      startingScrollTop,
      topScrollTop,
    };
  });
  const probe = await interactionProbeResult(page);
  if (result.frameIntervals.length === 0) {
    throw new Error("transcript scroll produced no animation-frame samples");
  }
  const missedFrames = result.frameIntervals.filter(
    (duration) => duration > 20,
  ).length;
  const measurement = {
    finalScrollTop: round(result.finalScrollTop),
    frameCount: result.frameIntervals.length,
    frameMaxMs: round(Math.max(...result.frameIntervals)),
    frameP50Ms: summarize(result.frameIntervals).medianMs,
    frameP95Ms: summarize(result.frameIntervals).p95Ms,
    longTasks: summarizeLongTasks(probe.longTasks),
    maximumScrollTop: round(result.maximum),
    missedFrameFraction: round(missedFrames / result.frameIntervals.length),
    missedFrames,
    restoredStartingEdge:
      Math.abs(result.finalScrollTop - result.startingScrollTop) <= 1,
    reachedTop: result.topScrollTop <= 1,
  };
  await recordSemanticMeasurement(
    page,
    `performance-sprint.${label}.scroll-frame-p95`,
    measurement.frameP95Ms,
  );
  return measurement;
}

async function markFirstVisibleTarget(page, selector, marker) {
  const found = await page.evaluate(
    ({ candidateSelector, markerAttribute }) => {
      const candidate = [...document.querySelectorAll(candidateSelector)].find(
        (element) => {
          const rect = element.getBoundingClientRect();
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            getComputedStyle(element).visibility !== "hidden"
          );
        },
      );
      if (!candidate) return false;
      candidate.setAttribute(markerAttribute, "true");
      return true;
    },
    { candidateSelector: selector, markerAttribute: marker },
  );
  if (!found)
    throw new Error(`no visible interaction target matched ${selector}`);
  return page.locator(`[${marker}="true"]`);
}

async function measureTooltip(page, configuredDelayMs) {
  await page.mouse.move(2, 2);
  await page.waitForSelector("#ya-global-tooltip", { state: "detached" });
  const target = await markFirstVisibleTarget(
    page,
    '[data-tooltip]:not([data-tooltip=""]):not(.session-list-item *)',
    "data-ya-perf-tooltip-target",
  );
  await resetInteractionProbe(page);
  const startedAtMs = await page.evaluate(() => performance.now());
  await target.hover();
  await page.waitForSelector("#ya-global-tooltip", { state: "visible" });
  const visibleAtMs = await page.evaluate(() => performance.now());
  const probe = await interactionProbeResult(page);
  const totalMs = round(visibleAtMs - startedAtMs);
  await page.mouse.move(2, 2);
  await page.waitForSelector("#ya-global-tooltip", { state: "detached" });
  await page.waitForTimeout(configuredDelayMs * 6 + 50);
  const result = {
    configuredDelayMs,
    longTasks: summarizeLongTasks(probe.longTasks),
    totalMs,
    workAfterDelayMs: round(Math.max(0, totalMs - configuredDelayMs)),
  };
  await recordSemanticMeasurement(
    page,
    "performance-sprint.tooltip-work-after-delay",
    result.workAfterDelayMs,
  );
  return result;
}

async function measureSessionHoverCard(page, configuredDelayMs) {
  let openedSidebar = false;
  const visibleRows = page.locator(".session-list-item:visible");
  if ((await visibleRows.count()) === 0) {
    const openSidebar = page.getByRole("button", {
      exact: true,
      name: "Open sidebar",
    });
    if ((await openSidebar.count()) !== 1) {
      throw new Error("SessionHoverCard target and sidebar opener were absent");
    }
    await openSidebar.click();
    await visibleRows.first().waitFor({ state: "visible" });
    openedSidebar = true;
  }
  const target = await markFirstVisibleTarget(
    page,
    ".session-list-item",
    "data-ya-perf-hover-card-target",
  );
  await page.mouse.move(2, 2);
  await page.waitForSelector("[data-session-hovercard-id]", {
    state: "detached",
  });
  await resetInteractionProbe(page);
  const startedAtMs = await page.evaluate(() => performance.now());
  await target.hover();
  await page.waitForSelector("[data-session-hovercard-id]", {
    state: "visible",
  });
  const visibleAtMs = await page.evaluate(() => performance.now());
  const providerBadgeVisible = await page
    .locator("[data-session-hovercard-id] .provider-badge")
    .isVisible();
  if (!providerBadgeVisible) {
    throw new Error("SessionHoverCard omitted its provider/model badge");
  }
  const probe = await interactionProbeResult(page);
  const totalMs = round(visibleAtMs - startedAtMs);
  await page.mouse.move(2, 2);
  await page.waitForSelector("[data-session-hovercard-id]", {
    state: "detached",
  });
  if (openedSidebar) {
    await page
      .getByRole("button", { exact: true, name: "Close sidebar" })
      .first()
      .click();
  }
  const result = {
    configuredDelayMs,
    longTasks: summarizeLongTasks(probe.longTasks),
    providerBadgeVisible,
    totalMs,
    workAfterDelayMs: round(Math.max(0, totalMs - configuredDelayMs)),
  };
  await recordSemanticMeasurement(
    page,
    "performance-sprint.hover-card-work-after-delay",
    result.workAfterDelayMs,
  );
  return result;
}

async function measureProjectionTransition(page) {
  const button = page.getByRole("button", {
    exact: true,
    name: "Show the full activity transcript",
  });
  if ((await button.count()) !== 1) {
    throw new Error("Conversation View transition control was not unique");
  }
  const beforeRows = await page.locator("[data-render-id]").count();
  await page.evaluate(() => {
    window.__yaPerfInteraction.rowChangeAtMs = null;
    window.__yaPerfInteraction.rowObserver?.disconnect();
    window.__yaPerfInteraction.rowObserver = new MutationObserver(() => {
      const rows = document.querySelectorAll("[data-render-id]").length;
      if (rows !== window.__yaPerfInteraction.rowCountBefore) {
        window.__yaPerfInteraction.rowChangeAtMs ??= performance.now();
      }
    });
    window.__yaPerfInteraction.rowCountBefore =
      document.querySelectorAll("[data-render-id]").length;
    const messageList = document.querySelector(".message-list");
    if (messageList) {
      window.__yaPerfInteraction.rowObserver.observe(messageList, {
        childList: true,
        subtree: true,
      });
    }
  });
  await resetInteractionProbe(page);
  const startedAtMs = await page.evaluate(() => performance.now());
  await button.click();
  await page
    .getByRole("button", {
      exact: true,
      name: "Show Conversation view and condense routine activity",
    })
    .waitFor({ state: "visible" });
  await twoAnimationFrames(page);
  const outcome = await page.evaluate((start) => {
    window.__yaPerfInteraction.rowObserver?.disconnect();
    return {
      firstRowChangeMs:
        window.__yaPerfInteraction.rowChangeAtMs === null
          ? null
          : window.__yaPerfInteraction.rowChangeAtMs - start,
      nextPaintMs: performance.now() - start,
    };
  }, startedAtMs);
  const probe = await interactionProbeResult(page);
  const result = {
    afterRows: await page.locator("[data-render-id]").count(),
    beforeRows,
    firstRowChangeMs:
      outcome.firstRowChangeMs === null
        ? null
        : round(outcome.firstRowChangeMs),
    longTasks: summarizeLongTasks(probe.longTasks),
    nextPaintMs: round(outcome.nextPaintMs),
  };
  await recordSemanticMeasurement(
    page,
    "performance-sprint.projection-next-paint",
    result.nextPaintMs,
  );
  return result;
}

async function measureOlderHistoryDisclosure(page) {
  const button = page.getByRole("button", {
    exact: true,
    name: "Load older messages",
  });
  if ((await button.count()) === 0) return null;
  const beforeRows = await page.locator("[data-render-id]").count();
  await resetInteractionProbe(page);
  const startedAtMs = await page.evaluate(() => performance.now());
  await button.click();
  await page.waitForFunction(
    (priorRows) =>
      document.querySelectorAll("[data-render-id]").length !== priorRows,
    beforeRows,
  );
  await twoAnimationFrames(page);
  const finishedAtMs = await page.evaluate(() => performance.now());
  const probe = await interactionProbeResult(page);
  const result = {
    afterRows: await page.locator("[data-render-id]").count(),
    beforeRows,
    longTasks: summarizeLongTasks(probe.longTasks),
    nextPaintMs: round(finishedAtMs - startedAtMs),
  };
  await recordSemanticMeasurement(
    page,
    "performance-sprint.older-history-next-paint",
    result.nextPaintMs,
  );
  return result;
}

async function ensureSidebarSessionLinks(page) {
  const visibleLinks = page.locator(".session-list-item__link:visible");
  if ((await visibleLinks.count()) < 2) {
    const openSidebar = page.getByRole("button", {
      exact: true,
      name: "Open sidebar",
    });
    if ((await openSidebar.count()) !== 1) {
      throw new Error("sidebar switch trace could not open the session list");
    }
    await openSidebar.click();
    await page.waitForFunction(
      () => document.querySelectorAll(".session-list-item__link").length >= 2,
    );
  }
  return visibleLinks;
}

async function measureSidebarSwitches(
  page,
  cdp,
  trace,
  expectedAssistantTurnIndex,
  expectedCatchUpAssistantTurnIndex = expectedAssistantTurnIndex,
) {
  const initialLinks = await ensureSidebarSessionLinks(page);
  const sessionPaths = [
    ...new Set(
      await initialLinks.evaluateAll((links) =>
        links.map((link) => new URL(link.href).pathname),
      ),
    ),
  ];
  const initialPath = new URL(page.url()).pathname;
  const alternatePath = sessionPaths.find(
    (pathName) => pathName !== initialPath,
  );
  if (!alternatePath || !sessionPaths.includes(initialPath)) {
    throw new Error("sidebar switch trace requires two fixture session links");
  }
  const targetPaths = Array.from(
    { length: trace.sidebarSwitchRounds * 2 },
    (_, index) => (index % 2 === 0 ? alternatePath : initialPath),
  );
  const switches = [];
  for (const targetPath of targetPaths) {
    const links = await ensureSidebarSessionLinks(page);
    const targetIndex = await links.evaluateAll(
      (elements, pathName) =>
        elements.findIndex(
          (element) => new URL(element.href).pathname === pathName,
        ),
      targetPath,
    );
    if (targetIndex < 0) {
      throw new Error(`sidebar switch target was absent: ${targetPath}`);
    }
    const fromPath = new URL(page.url()).pathname;
    const sessionId = decodeURIComponent(
      targetPath.split("/sessions/")[1]?.split("/")[0] ?? "",
    );
    if (!sessionId)
      throw new Error(`sidebar target omitted session: ${targetPath}`);
    const marker = `[${sessionId}:assistant:${expectedAssistantTurnIndex}]`;
    const catchUpMarker = `[${sessionId}:assistant:${expectedCatchUpAssistantTurnIndex}]`;
    await resetInteractionProbe(page);
    const { finishedAtMs, markIndex, readableAtMs, startedAtMs } = await links
      .nth(targetIndex)
      .evaluate(
        async (link, { expectedMarker, fromPathName, targetPathName }) => {
          const interaction = window.__yaPerfInteraction;
          const activeLayer = document.querySelector(
            '[data-session-dom-linger="active"]',
          );
          if (activeLayer) {
            let layerId = interaction.sessionLayerIds.get(activeLayer);
            if (!layerId) {
              layerId = interaction.nextSessionLayerId;
              interaction.nextSessionLayerId += 1;
              interaction.sessionLayerIds.set(activeLayer, layerId);
            }
            interaction.lastSessionLayerIdByPath[fromPathName] = layerId;
          }
          const startedAtMs = performance.now();
          window.__YA_RELOAD_PERF_PROBE__?.mark("sidebar_switch_route_click", {
            pathName: fromPathName,
          });
          const markIndex = (window.__yaPerfMarks ?? []).length - 1;
          link.click();

          const deadline = startedAtMs + 30_000;
          let readableAtMs = null;
          while (performance.now() < deadline) {
            await new Promise(requestAnimationFrame);
            const nextActiveLayer = document.querySelector(
              '[data-session-dom-linger="active"]',
            );
            if (
              window.location.pathname === targetPathName &&
              nextActiveLayer?.textContent?.includes(expectedMarker) === true
            ) {
              readableAtMs = performance.now();
              break;
            }
          }
          if (readableAtMs === null) {
            throw new Error(
              `sidebar target did not become readable: ${targetPathName}`,
            );
          }
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          return {
            finishedAtMs: performance.now(),
            markIndex,
            readableAtMs,
            startedAtMs,
          };
        },
        {
          expectedMarker: marker,
          fromPathName: fromPath,
          targetPathName: targetPath,
        },
      );
    await page.waitForURL((url) => url.pathname === targetPath);
    await page.waitForFunction(
      (expectedMarker) =>
        document
          .querySelector('[data-session-dom-linger="active"]')
          ?.textContent?.includes(expectedMarker) === true,
      marker,
    );
    const probe = await interactionProbeResult(page);
    const confirmationPaintMs = round(finishedAtMs - startedAtMs);
    const nextPaintMs = round(readableAtMs - startedAtMs);
    const diagnostics = await page.evaluate(
      ({
        endAtMs,
        marksFromIndex,
        readableAtMs,
        targetPath,
        targetSessionId,
      }) => {
        const interaction = window.__yaPerfInteraction;
        const activeLayer = document.querySelector(
          '[data-session-dom-linger="active"]',
        );
        let activeLayerId = null;
        if (activeLayer) {
          activeLayerId = interaction.sessionLayerIds.get(activeLayer) ?? null;
          if (!activeLayerId) {
            activeLayerId = interaction.nextSessionLayerId;
            interaction.nextSessionLayerId += 1;
            interaction.sessionLayerIds.set(activeLayer, activeLayerId);
          }
        }
        const previousLayerId =
          interaction.lastSessionLayerIdByPath[targetPath] ?? null;
        if (activeLayerId) {
          interaction.lastSessionLayerIdByPath[targetPath] = activeLayerId;
        }

        const allMarks = window.__yaPerfMarks ?? [];
        const marks = allMarks
          .slice(marksFromIndex)
          .filter((mark) => mark.atMs <= endAtMs);
        const visualSwap = marks.find(
          (mark) =>
            mark.name === "session_dom_linger_visual_swap" &&
            mark.detail?.sessionId === targetSessionId,
        );
        const loadStart = marks.find(
          (mark) =>
            mark.name === "session_initial_load_start" &&
            mark.detail?.sessionId === targetSessionId,
        );
        const snapshotLookupStart = marks.find(
          (mark) =>
            mark.name === "session_snapshot_lookup_start" &&
            mark.detail?.sessionId === targetSessionId,
        );
        const snapshotLookupComplete = snapshotLookupStart
          ? marks.find(
              (mark) =>
                mark.name === "session_snapshot_lookup_complete" &&
                mark.detail?.sessionId === targetSessionId &&
                mark.atMs >= snapshotLookupStart.atMs,
            )
          : null;
        const snapshotHydration = snapshotLookupComplete
          ? marks.find(
              (mark) =>
                mark.name === "session_snapshot_hydration_installed" &&
                mark.detail?.sessionId === targetSessionId &&
                mark.atMs >= snapshotLookupComplete.atMs,
            )
          : null;
        const stateQueued = loadStart
          ? marks.find(
              (mark) =>
                mark.name === "session_initial_messages_state_queued" &&
                mark.atMs >= loadStart.atMs,
            )
          : null;
        const commit = stateQueued
          ? marks.find(
              (mark) =>
                mark.name === "message_list_commit_effect" &&
                mark.atMs >= stateQueued.atMs,
            )
          : null;
        const preprocessEnd = commit
          ? marks
              .filter(
                (mark) =>
                  mark.name === "message_list_preprocess_end" &&
                  mark.atMs >= stateQueued.atMs &&
                  mark.atMs <= commit.atMs,
              )
              .at(-1)
          : null;
        const groupEnd = commit
          ? marks
              .filter(
                (mark) =>
                  mark.name === "message_list_group_end" &&
                  mark.atMs >= stateQueued.atMs &&
                  mark.atMs <= commit.atMs,
              )
              .at(-1)
          : null;
        const latestBackgroundEffects = new Map();
        for (const mark of allMarks) {
          if (
            mark.name === "session_background_effects_changed" &&
            typeof mark.detail?.sessionId === "string"
          ) {
            latestBackgroundEffects.set(mark.detail.sessionId, mark.detail);
          }
        }
        const activeSessionConsumerIds = [...latestBackgroundEffects.values()]
          .filter((detail) => detail.mounted === true && detail.paused !== true)
          .map((detail) => detail.sessionId)
          .sort();
        const sessionLayerRenders = marks.filter(
          (mark) => mark.name === "session_dom_linger_layer_render",
        );
        const sessionLayerRenderBySession = {};
        for (const mark of sessionLayerRenders) {
          const sessionId = mark.detail?.sessionId;
          if (typeof sessionId !== "string") continue;
          sessionLayerRenderBySession[sessionId] =
            Math.round(
              ((sessionLayerRenderBySession[sessionId] ?? 0) +
                (mark.detail?.actualDuration ?? 0)) *
                10,
            ) / 10;
        }
        const duration = (start, end) =>
          typeof start === "number" && typeof end === "number"
            ? Math.round((end - start) * 10) / 10
            : null;
        return {
          activeSessionConsumerCount:
            latestBackgroundEffects.size > 0
              ? activeSessionConsumerIds.length
              : null,
          activeSessionConsumerIds:
            latestBackgroundEffects.size > 0 ? activeSessionConsumerIds : null,
          dom: {
            activeLayers: document.querySelectorAll(
              '[data-session-dom-linger="active"]',
            ).length,
            layerCount: document.querySelectorAll("[data-session-dom-linger]")
              .length,
            parkedLayers: document.querySelectorAll(
              '[data-session-dom-linger="parked"]',
            ).length,
            reused:
              previousLayerId !== null && previousLayerId === activeLayerId,
          },
          phaseProfile: {
            commitToReadableMs: duration(commit?.atMs, readableAtMs),
            groupMs:
              typeof groupEnd?.detail?.durationMs === "number"
                ? groupEnd.detail.durationMs
                : null,
            loadStartToStateQueuedMs: duration(
              loadStart?.atMs,
              stateQueued?.atMs,
            ),
            preprocessMs:
              typeof preprocessEnd?.detail?.durationMs === "number"
                ? preprocessEnd.detail.durationMs
                : null,
            remounted: Boolean(loadStart),
            restoredFromSnapshot:
              loadStart?.detail?.restoredFromSnapshot === true,
            snapshotHit: snapshotLookupComplete?.detail?.hit === true,
            snapshotLookupMs: duration(
              snapshotLookupStart?.atMs,
              snapshotLookupComplete?.atMs,
            ),
            snapshotMessagesIdentityPreserved:
              snapshotHydration?.detail?.messagesIdentityPreserved === true,
            routeClickToLoadStartMs: duration(marks[0]?.atMs, loadStart?.atMs),
            routeClickToVisualSwapMs: duration(
              marks[0]?.atMs,
              visualSwap?.atMs,
            ),
            stateQueuedToCommitMs: duration(stateQueued?.atMs, commit?.atMs),
            readableToConfirmationMs: duration(readableAtMs, endAtMs),
            sessionLayerRenderMs:
              Math.round(
                sessionLayerRenders.reduce(
                  (total, mark) => total + (mark.detail?.actualDuration ?? 0),
                  0,
                ) * 10,
              ) / 10,
            sessionLayerRenderBySession,
            sessionLayerRenderEvents: sessionLayerRenders.map((mark) => ({
              actualDurationMs:
                Math.round((mark.detail?.actualDuration ?? 0) * 10) / 10,
              afterClickMs: duration(marks[0]?.atMs, mark.atMs),
              phase: mark.detail?.phase ?? null,
              sessionId: mark.detail?.sessionId ?? null,
              subtreeParked: mark.detail?.subtreeParked ?? null,
            })),
          },
        };
      },
      {
        endAtMs: finishedAtMs,
        marksFromIndex: markIndex,
        readableAtMs,
        targetPath,
        targetSessionId: sessionId,
      },
    );
    let settledActiveSessionConsumerIds = diagnostics.activeSessionConsumerIds;
    if (settledActiveSessionConsumerIds !== null) {
      await page.waitForFunction((expectedSessionId) => {
        const latestBackgroundEffects = new Map();
        for (const mark of window.__yaPerfMarks ?? []) {
          if (
            mark.name === "session_background_effects_changed" &&
            typeof mark.detail?.sessionId === "string"
          ) {
            latestBackgroundEffects.set(mark.detail.sessionId, mark.detail);
          }
        }
        const activeIds = [...latestBackgroundEffects.values()]
          .filter((detail) => detail.mounted === true && detail.paused !== true)
          .map((detail) => detail.sessionId);
        return activeIds.length === 1 && activeIds[0] === expectedSessionId;
      }, sessionId);
      settledActiveSessionConsumerIds = [sessionId];
    }
    let catchUpNextPaintMs = null;
    if (expectedCatchUpAssistantTurnIndex !== expectedAssistantTurnIndex) {
      await page.waitForFunction(
        (expectedMarker) =>
          document
            .querySelector('[data-session-dom-linger="active"]')
            ?.textContent?.includes(expectedMarker) === true,
        catchUpMarker,
      );
      await twoAnimationFrames(page);
      const catchUpFinishedAtMs = await page.evaluate(() => performance.now());
      catchUpNextPaintMs = round(catchUpFinishedAtMs - startedAtMs);
    }
    await recordSemanticMeasurement(
      page,
      "performance-sprint.sidebar-switch-next-paint",
      nextPaintMs,
    );
    switches.push({
      cache: (await clientTelemetry(page)).transcriptMemory,
      ...diagnostics,
      catchUpNextPaintMs,
      confirmationPaintMs,
      settledActiveSessionConsumerCount:
        settledActiveSessionConsumerIds?.length ?? null,
      settledActiveSessionConsumerIds,
      fromPath,
      longTasks: summarizeLongTasks(probe.longTasks),
      nextPaintMs,
      state: await collectInteractionState(page, cdp, {
        collectGarbage: true,
      }),
      targetPath,
    });
  }
  if (
    trace.requireRetainedAfterFirstSwitch &&
    switches.slice(1).some((entry) => entry.dom.reused !== true)
  ) {
    throw new Error(
      "sidebar switch trace remounted after both sessions were warm",
    );
  }
  return {
    initialPath,
    rounds: trace.sidebarSwitchRounds,
    switches,
  };
}

async function measureBrowserInteractionTrace(
  page,
  scenario,
  trace,
  expectedAssistantTurnIndex = scenario.initialTurns - 1,
  expectedCatchUpAssistantTurnIndex = expectedAssistantTurnIndex,
) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  try {
    const initial = await collectInteractionState(page, cdp, {
      collectGarbage: true,
    });
    if (trace.scope === "sidebar-switch") {
      const sidebarSwitch = await measureSidebarSwitches(
        page,
        cdp,
        trace,
        expectedAssistantTurnIndex,
        expectedCatchUpAssistantTurnIndex,
      );
      return {
        final: await collectInteractionState(page, cdp, {
          collectGarbage: true,
        }),
        initial,
        sidebarSwitch,
      };
    }
    const conversation = {
      typing: await measureComposerTyping(page, "conversation"),
      scroll: await measureTranscriptScroll(page, "conversation"),
    };
    if (trace.scope === "scale-control") {
      return {
        conversation,
        final: await collectInteractionState(page, cdp, {
          collectGarbage: true,
        }),
        initial,
      };
    }
    const tooltip = await measureTooltip(page, trace.tooltipDelayMs);
    const hoverCard = await measureSessionHoverCard(
      page,
      trace.hoverCardDelayMs,
    );
    const projectionTransition = await measureProjectionTransition(page);
    const full = {
      typing: await measureComposerTyping(page, "full"),
      scroll: await measureTranscriptScroll(page, "full"),
    };
    const olderHistory = await measureOlderHistoryDisclosure(page);
    const final = await collectInteractionState(page, cdp, {
      collectGarbage: true,
    });
    return {
      conversation,
      final,
      full,
      hoverCard,
      initial,
      olderHistory,
      projectionTransition,
      tooltip,
    };
  } finally {
    await cdp.detach();
  }
}

export async function runCacheRefreshProof({
  cacheBudgetMiB,
  config,
  page,
  target,
  glossarySupported,
  projectPathsSupported,
}) {
  const expectedPath =
    `/api/projects/${encodeURIComponent(target.detail.projectId)}` +
    `/sessions/${encodeURIComponent(target.detail.sessionId)}`;
  let interceptedUrl = null;
  let releaseRequest;
  let requestSeen;
  let requestContinued;
  const releasePromise = new Promise((resolve) => {
    releaseRequest = resolve;
  });
  const requestSeenPromise = new Promise((resolve) => {
    requestSeen = resolve;
  });
  const requestContinuedPromise = new Promise((resolve) => {
    requestContinued = resolve;
  });
  const routePattern = "**/api/projects/**/sessions/**";
  const handler = async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== expectedPath || interceptedUrl) {
      await route.continue();
      return;
    }
    interceptedUrl = url;
    requestSeen();
    await releasePromise;
    await route.continue();
    requestContinued();
  };
  await page.route(routePattern, handler);
  try {
    const started = performance.now();
    let milestones = null;
    let visibleBeforeRelease = false;
    await navigateSpa(page, target.url);
    await waitWithTimeout(
      requestSeenPromise,
      config.fixture.cacheProofTimeoutMs,
      "cache proof detail request",
    );
    if (cacheBudgetMiB > 0) {
      milestones = await waitForFinalDisplay(page, target, {
        glossarySupported,
        projectPathsSupported,
        started,
        timeoutMs: config.fixture.cacheProofTimeoutMs,
      });
      visibleBeforeRelease = true;
    } else {
      await wait(config.fixture.cacheDisabledObservationMs);
      visibleBeforeRelease = await page.evaluate(
        (marker) => document.body?.innerText.includes(marker) ?? false,
        target.marker,
      );
      if (visibleBeforeRelease) {
        throw new Error(
          "cache-disabled revisit rendered transcript before refresh release",
        );
      }
    }
    releaseRequest();
    await waitWithTimeout(
      requestContinuedPromise,
      config.server.requestTimeoutMs,
      "cache proof request release",
    );
    if (!milestones) {
      milestones = await waitForFinalDisplay(page, target, {
        glossarySupported,
        projectPathsSupported,
        started,
        timeoutMs: config.server.requestTimeoutMs,
      });
    }
    const requestHadCursor = interceptedUrl.searchParams.has("afterMessageId");
    if (cacheBudgetMiB > 0 && !requestHadCursor) {
      throw new Error(
        "cache-enabled revisit made a cursorless refresh request",
      );
    }
    if (cacheBudgetMiB === 0 && requestHadCursor) {
      throw new Error(
        "cache-disabled revisit unexpectedly sent a cache cursor",
      );
    }
    return {
      milestones,
      readableBeforeRefresh: visibleBeforeRelease,
      requestHadCursor,
      requestWasHeld: true,
    };
  } finally {
    releaseRequest();
    await page.unroute(routePattern, handler);
  }
}

export async function measureBrowserMode({
  checkout,
  config,
  details,
  generalizedProjectPathsSupported,
  glossarySupported,
  repetition,
  runMarker,
  scenario,
  server,
}) {
  const playwrightPath = path.join(
    checkout,
    "packages/client/node_modules/@playwright/test/index.mjs",
  );
  const { chromium } = await import(pathToFileURL(playwrightPath).href);
  const browser = await chromium.launch({
    chromiumSandbox: true,
    args: ["--enable-precise-memory-info"],
    env: { ...process.env, PERF_RUN_ID: runMarker },
    headless: true,
  });
  const browserCdp = await browser.newBrowserCDPSession();
  const processMemory = { samples: [] };
  const captureProcessMemory = async (phase) => {
    processMemory.samples.push({
      phase,
      sampledAt: new Date().toISOString(),
      ...(await sampleChromiumProcessMemory(browserCdp)),
    });
  };
  await captureProcessMemory("startup");
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
  const budgets = scenario.browserCacheBudgetsMiB ?? [0, 24];
  const orderedBudgets = budgets.map(
    (_, index) => budgets[(index + repetition) % budgets.length],
  );
  const modes = [];
  const livePages = [];
  const causalArm = scenario.interactionTrace?.alternateCausalArms
    ? repetition % 2 === 0
      ? "idle"
      : "activity"
    : null;
  const workingSetSessionCount =
    scenario.browserWorkingSetSessions ?? config.fixture.workingSetSessions;
  const detailsByProjectMap = new Map();
  for (const detail of details) {
    const projectDetails = detailsByProjectMap.get(detail.projectId) ?? [];
    projectDetails.push(detail);
    detailsByProjectMap.set(detail.projectId, projectDetails);
  }
  const detailsByProject = [...detailsByProjectMap.values()];
  if (
    detailsByProject.some(
      (projectDetails) => projectDetails.length < workingSetSessionCount,
    )
  ) {
    throw new Error(
      `browser working set requires ${workingSetSessionCount} sessions per project`,
    );
  }
  const workingSets = Array.from(
    { length: scenario.concurrentClients },
    (_, pageIndex) => {
      const projectDetails =
        detailsByProject[pageIndex % detailsByProject.length];
      return Array.from(
        { length: workingSetSessionCount },
        (_, offset) =>
          projectDetails[(pageIndex + offset) % projectDetails.length],
      ).map((detail) =>
        sessionBrowserTarget(server, detail, scenario.initialTurns - 1),
      );
    },
  );

  try {
    for (const cacheBudgetMiB of orderedBudgets) {
      const context = await browser.newContext({
        viewport: scenario.browserViewport ?? { width: 1280, height: 800 },
      });
      await context.addInitScript(
        ({ budget, interactionTrace, settings }) => {
          for (const [key, value] of Object.entries(settings)) {
            localStorage.setItem(key, value);
          }
          localStorage.setItem("yep-anywhere-glossary-hints-enabled", "true");
          localStorage.setItem(
            "yep-anywhere-session-transcript-cache-enabled",
            String(budget > 0),
          );
          localStorage.setItem(
            "yep-anywhere-session-transcript-cache-budget-mb",
            String(budget),
          );
          localStorage.setItem(
            "yep-anywhere-developer-mode",
            JSON.stringify({ remoteLogCollectionEnabled: true }),
          );
          window.__yaPerfTelemetry = [];
          window.__yaPerfMarks = [];
          window.__yaPerfNavigationStartMs = 0;
          if (interactionTrace?.enabled) {
            window.__YA_SEMANTIC_UI_ACTIONS__ = {
              schemaVersion: 1,
              gather: true,
              replay: true,
            };
            window.__yaPerfInteraction = {
              keySamples: [],
              lastSessionLayerIdByPath: {},
              longTasks: [],
              nextSessionLayerId: 1,
              rowChangeAtMs: null,
              rowCountBefore: 0,
              rowObserver: null,
              sessionLayerIds: new WeakMap(),
            };
            new PerformanceObserver((entries) => {
              for (const entry of entries.getEntries()) {
                window.__yaPerfInteraction.longTasks.push({
                  durationMs: entry.duration,
                  startTime: entry.startTime,
                });
              }
            }).observe({ type: "longtask", buffered: true });
            window.addEventListener(
              "keydown",
              (event) => {
                const target = event.target;
                if (!(target instanceof HTMLElement)) return;
                if (
                  !(
                    target.matches("textarea, input") ||
                    target.isContentEditable
                  )
                ) {
                  return;
                }
                const receivedAtMs = performance.now();
                const dispatchMs = Math.max(0, receivedAtMs - event.timeStamp);
                requestAnimationFrame(() => {
                  window.__yaPerfInteraction.keySamples.push({
                    dispatchMs,
                    keyToFrameMs: Math.max(0, performance.now() - receivedAtMs),
                  });
                });
              },
              true,
            );
          }
          performance.setResourceTimingBufferSize(5000);
          window.__YA_RELOAD_PERF_PROBE__ = {
            mark(name, detail) {
              window.__yaPerfMarks.push({
                atMs: performance.now(),
                detail,
                name,
              });
            },
          };
          const originalFetch = window.fetch.bind(window);
          window.fetch = async (input, init) => {
            const url = typeof input === "string" ? input : input.url;
            if (
              url.includes("/client-logs") &&
              typeof init?.body === "string"
            ) {
              try {
                const payload = JSON.parse(init.body);
                for (const entry of payload.entries ?? []) {
                  if (entry.prefix !== "[ClientTelemetry]") continue;
                  const marker = "[ClientTelemetry] ";
                  const offset = entry.message.indexOf(marker);
                  if (offset >= 0) {
                    window.__yaPerfTelemetry.push(
                      JSON.parse(entry.message.slice(offset + marker.length)),
                    );
                  }
                }
              } catch {
                // The real request remains authoritative.
              }
            }
            return originalFetch(input, init);
          };
        },
        {
          budget: cacheBudgetMiB,
          interactionTrace: scenario.interactionTrace ?? null,
          settings: scenario.browserSettings ?? {},
        },
      );

      const pages = [];
      const coldMilestones = [];
      const coldProfiles = [];
      const warmMilestones = [];
      const warmProfiles = [];
      const warmCacheTelemetry = [];
      const cacheProofs = [];
      const appendTargets = [];
      for (let index = 0; index < scenario.concurrentClients; index += 1) {
        pages.push(await context.newPage());
      }

      await Promise.all(
        pages.map(async (page, index) => {
          const workingSet = workingSets[index];
          for (
            let targetIndex = 0;
            targetIndex < workingSet.length;
            targetIndex += 1
          ) {
            const target = workingSet[targetIndex];
            const started = performance.now();
            if (targetIndex === 0) {
              await page.goto(target.url, { waitUntil: "domcontentloaded" });
            } else {
              await navigateProfiledSpa(page, target.url);
            }
            const milestones = await waitForFinalDisplay(page, target, {
              glossarySupported,
              projectPathsSupported: generalizedProjectPathsSupported,
              started,
              timeoutMs: config.server.requestTimeoutMs,
            });
            coldMilestones.push(milestones);
            coldProfiles.push(
              await collectClientNavigationProfile(
                page,
                target,
                milestones,
                config.server.requestTimeoutMs,
              ),
            );
          }

          if (scenario.interactionTraceOnly) {
            appendTargets[index] = workingSet[0];
            return;
          }

          await navigateSpa(page, `${server.baseUrl}/projects`);
          await page.waitForFunction(
            () => !document.querySelector(".message-list"),
            undefined,
            { timeout: config.server.requestTimeoutMs },
          );
          const cacheTelemetry = await clientTelemetry(page);
          warmCacheTelemetry.push(cacheTelemetry);
          const expectedWarmEntries =
            cacheBudgetMiB === 0 ? 0 : workingSet.length;
          assertCount(
            cacheTelemetry.transcriptMemory.warmCacheEntryCount,
            expectedWarmEntries,
            `${cacheBudgetMiB} MiB browser working-set cache entries`,
          );
          if (cacheBudgetMiB === 0) {
            assertCount(
              cacheTelemetry.transcriptMemory.warmCacheBytes,
              0,
              "disabled browser transcript-cache warm bytes",
            );
          } else {
            if (cacheTelemetry.transcriptMemory.warmCacheBytes < 1) {
              throw new Error(
                `browser transcript cache ${cacheBudgetMiB} MiB retained no bytes`,
              );
            }
            if (
              cacheTelemetry.transcriptMemory.warmCacheBytes >
              cacheBudgetMiB * 1024 * 1024
            ) {
              throw new Error(
                `browser transcript cache exceeded ${cacheBudgetMiB} MiB budget`,
              );
            }
          }

          for (const target of workingSet) {
            const started = performance.now();
            await navigateProfiledSpa(page, target.url);
            const milestones = await waitForFinalDisplay(page, target, {
              glossarySupported,
              projectPathsSupported: generalizedProjectPathsSupported,
              started,
              timeoutMs: config.server.requestTimeoutMs,
            });
            warmMilestones.push(milestones);
            warmProfiles.push(
              await collectClientNavigationProfile(
                page,
                target,
                milestones,
                config.server.requestTimeoutMs,
              ),
            );
          }

          const proofTarget = workingSet[0];
          await navigateSpa(page, `${server.baseUrl}/projects`);
          await page.waitForFunction(
            () => !document.querySelector(".message-list"),
            undefined,
            { timeout: config.server.requestTimeoutMs },
          );
          cacheProofs.push(
            await runCacheRefreshProof({
              cacheBudgetMiB,
              config,
              glossarySupported,
              page,
              projectPathsSupported: generalizedProjectPathsSupported,
              target: proofTarget,
            }),
          );
          appendTargets[index] = proofTarget;
        }),
      );

      const telemetryDeadline = performance.now() + 17_000;
      let yaTelemetry = [];
      while (performance.now() < telemetryDeadline) {
        yaTelemetry = (
          await Promise.all(
            pages.map((page) =>
              page.evaluate(() => window.__yaPerfTelemetry ?? []),
            ),
          )
        )
          .flat()
          .filter((entry) => entry.path?.includes("/sessions/"));
        if (yaTelemetry.length >= pages.length) break;
        await wait(250);
      }
      const directTelemetry = await Promise.all(pages.map(clientTelemetry));
      await captureProcessMemory(`cache-${cacheBudgetMiB}-loaded`);
      const milestoneSummary = (samples, field) =>
        summarize(
          samples
            .map((sample) => sample[field])
            .filter((value) => typeof value === "number"),
        );
      modes.push({
        cacheBudgetMiB,
        correctness: {
          cacheProofs,
          cacheProofsSkippedForInteractionTrace:
            scenario.interactionTraceOnly === true,
          glossaryHintsRendered: glossarySupported,
          projectPathsRendered: generalizedProjectPathsSupported,
          workingSetSessions: workingSetSessionCount,
        },
        latency: {
          coldTail: milestoneSummary(coldMilestones, "readableTailMs"),
          coldGlossaryHighlight: milestoneSummary(
            coldMilestones,
            "glossaryHighlightMs",
          ),
          coldProjectPathHighlight: milestoneSummary(
            coldMilestones,
            "projectPathHighlightMs",
          ),
          coldFinalHighlight: milestoneSummary(
            coldMilestones,
            "finalHighlightMs",
          ),
          warmTail: milestoneSummary(warmMilestones, "readableTailMs"),
          warmGlossaryHighlight: milestoneSummary(
            warmMilestones,
            "glossaryHighlightMs",
          ),
          warmProjectPathHighlight: milestoneSummary(
            warmMilestones,
            "projectPathHighlightMs",
          ),
          warmFinalHighlight: milestoneSummary(
            warmMilestones,
            "finalHighlightMs",
          ),
        },
        profiles: {
          coldNavigation: summarizeClientNavigationProfiles(coldProfiles),
          warmNavigation: summarizeClientNavigationProfiles(warmProfiles),
        },
        telemetry: directTelemetry,
        warmCacheTelemetry,
        yaTelemetry,
        liveMilestones: [],
        liveProfiles: [],
      });
      livePages.push({
        appendTargets,
        context,
        mode: modes.at(-1),
        pages,
      });
    }

    return {
      modes,
      livePages,
      processMemory,
      async prepareAppend() {
        await Promise.all(
          livePages.flatMap(({ appendTargets, mode, pages }) =>
            pages.map(async (page, index) => {
              if (scenario.interactionTrace?.beforeAndAfterAppend) {
                const fresh = await measureBrowserInteractionTrace(
                  page,
                  scenario,
                  scenario.interactionTrace,
                  scenario.initialTurns - 1,
                );
                let idle = null;
                if (causalArm !== "activity") {
                  await wait(
                    scenario.interactionTrace.idleBeforeSecondSwitchMs,
                  );
                  idle = await measureBrowserInteractionTrace(
                    page,
                    scenario,
                    scenario.interactionTrace,
                    scenario.initialTurns - 1,
                  );
                }
                mode.interactionTraceBeforeAppend ??= [];
                mode.interactionTraceBeforeAppend.push({
                  causalArm,
                  fresh,
                  ...(idle && { idle }),
                });
              }
              return prepareClientAppendProfile(
                page,
                sessionBrowserTarget(
                  server,
                  appendTargets[index].detail,
                  scenario.initialTurns + scenario.newTurns - 1,
                ),
                {
                  glossarySupported,
                  projectPathsSupported: generalizedProjectPathsSupported,
                },
              );
            }),
          ),
        );
      },
      async observeAppend() {
        const started = performance.now();
        await Promise.all(
          livePages.flatMap(({ appendTargets, mode, pages }) =>
            pages.map(async (page, index) => {
              const target = sessionBrowserTarget(
                server,
                appendTargets[index].detail,
                scenario.initialTurns + scenario.newTurns - 1,
              );
              const milestones = await waitForFinalDisplay(page, target, {
                glossarySupported,
                preparedAppendObservation: true,
                projectPathsSupported: generalizedProjectPathsSupported,
                started,
                timeoutMs: config.server.requestTimeoutMs,
              });
              mode.liveMilestones.push(milestones);
              mode.liveProfiles.push(
                await collectClientAppendProfile(page, milestones),
              );
            }),
          ),
        );
        const milestoneSummary = (samples, field) =>
          summarize(
            samples
              .map((sample) => sample[field])
              .filter((value) => typeof value === "number"),
          );
        for (const mode of modes) {
          mode.latency.appendedLiveTail = milestoneSummary(
            mode.liveMilestones,
            "readableTailMs",
          );
          mode.latency.appendedLiveGlossaryHighlight = milestoneSummary(
            mode.liveMilestones,
            "glossaryHighlightMs",
          );
          mode.latency.appendedLiveProjectPathHighlight = milestoneSummary(
            mode.liveMilestones,
            "projectPathHighlightMs",
          );
          mode.latency.appendedLiveFinalHighlight = milestoneSummary(
            mode.liveMilestones,
            "finalHighlightMs",
          );
          mode.profiles.append = summarizeClientAppendProfiles(
            mode.liveProfiles,
          );
          delete mode.liveMilestones;
          delete mode.liveProfiles;
        }
        if (scenario.interactionTrace?.enabled && causalArm !== "idle") {
          await Promise.all(
            livePages.map(async ({ mode, pages }) => {
              const trials = await Promise.all(
                pages.map(async (page) => {
                  await twoAnimationFrames(page);
                  return measureBrowserInteractionTrace(
                    page,
                    scenario,
                    scenario.interactionTrace,
                    scenario.initialTurns - 1,
                    scenario.initialTurns + scenario.newTurns - 1,
                  );
                }),
              );
              mode.interactionTrace = {
                aggregate: summarizeInteractionTrials(trials),
                causalArm,
                trials,
              };
            }),
          );
        }
        await captureProcessMemory("appended");
      },
      async close() {
        await Promise.all(livePages.map(({ context }) => context.close()));
        await browserCdp.detach();
        await browser.close();
      },
    };
  } catch (error) {
    await Promise.all(livePages.map(({ context }) => context.close()));
    await browserCdp.detach();
    await browser.close();
    throw error;
  }
}
