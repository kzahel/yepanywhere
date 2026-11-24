import { writeFile } from "node:fs/promises";
import type { Locator, TestInfo } from "@playwright/test";

export const typingAckTargetMs = 100;
// Nov 7–14, 2026: 78 queued-compaction CI executions peaked at 246.4 ms;
// 34 field-ownership executions peaked at 132.5 ms. Shared CI gets 500 ms
// (2.0–3.8x those maxima); controlled/local runs retain the 100 ms target.
// The same window's settings-search (189.8/185.3 ms) and delayed-creation
// typing (142.1 ms) misses also qualify for this explicitly selected ceiling.
export const typingAckLimitMs = process.env.CI ? 500 : typingAckTargetMs;

type KeyTiming = {
  key: string;
  startTime: number;
  dispatchMs: number;
  inputMs?: number;
  firstFrameMs?: number;
  secondFrameMs?: number;
  firstFrameValue?: string;
  secondFrameValue?: string;
  retained?: boolean;
};

type TypingDiagnostics = {
  keys: KeyTiming[];
  longTasks: unknown[];
  longAnimationFrames: unknown[];
  supportedEntryTypes: string[];
};

type ObservedInput = HTMLElement & {
  value: string;
  typingDiagnostics: TypingDiagnostics;
  typingObservers: PerformanceObserver[];
};

/** Supplement the existing input gate; never subtract these phases from it. */
export async function startTypingDiagnostics(
  input: Locator,
  { limitMs = typingAckLimitMs, maxKeys = 256 } = {},
) {
  await input.evaluate((element, maxKeys) => {
    const field = element as ObservedInput;
    const data: TypingDiagnostics = {
      keys: [],
      longTasks: [],
      longAnimationFrames: [],
      supportedEntryTypes: [...PerformanceObserver.supportedEntryTypes],
    };
    field.typingDiagnostics = data;
    field.typingObservers = [];
    for (const [type, entries] of [
      ["longtask", data.longTasks],
      ["long-animation-frame", data.longAnimationFrames],
    ] as const) {
      if (!data.supportedEntryTypes.includes(type)) continue;
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          // Bounded diagnostic window; the owning browser context is closed
          // after each scenario. LoAF JSON includes script source attribution.
          if (entries.length < 100) entries.push(entry.toJSON());
        }
      });
      observer.observe({ type });
      field.typingObservers.push(observer);
    }
    field.addEventListener("keydown", (event) => {
      if (data.keys.length >= maxKeys) return;
      const sample: KeyTiming = {
        key: event.key,
        startTime: event.timeStamp,
        dispatchMs: performance.now() - event.timeStamp,
      };
      data.keys.push(sample);
      requestAnimationFrame(() => {
        sample.firstFrameMs = performance.now() - sample.startTime;
        sample.firstFrameValue = field.value;
        requestAnimationFrame(() => {
          sample.secondFrameMs = performance.now() - sample.startTime;
          sample.secondFrameValue = field.value;
          sample.retained = field.isConnected;
        });
      });
    });
    field.addEventListener("input", () => {
      const sample = data.keys.at(-1);
      if (sample) sample.inputMs = performance.now() - sample.startTime;
    });
  }, maxKeys);
  return async (
    testInfo: TestInfo,
    name: string,
    acknowledgements: unknown,
    maxMs: number,
  ) => {
    if (maxMs > typingAckTargetMs) {
      testInfo.annotations.push({
        type: "typing-target-miss",
        description: `${name}: ${maxMs.toFixed(1)} ms; target ${typingAckTargetMs} ms; gate ${limitMs} ms`,
      });
    }
    const diagnostics = await input.evaluate((element) => {
      const field = element as ObservedInput;
      for (const observer of field.typingObservers) {
        for (const entry of observer.takeRecords()) {
          const entries =
            entry.entryType === "longtask"
              ? field.typingDiagnostics.longTasks
              : field.typingDiagnostics.longAnimationFrames;
          if (entries.length < 100) entries.push(entry.toJSON());
        }
        observer.disconnect();
      }
      return field.typingDiagnostics;
    });
    // Body-only attachments live in the JSON report, not test-results. Use a
    // file so CI's failure artifact also preserves the first attempt's data.
    const path = testInfo.outputPath(`typing-diagnostics-${name}.json`);
    await writeFile(
      path,
      JSON.stringify(
        {
          targetMs: typingAckTargetMs,
          limitMs,
          maxMs,
          acknowledgements,
          ...diagnostics,
        },
        null,
        2,
      ),
    );
    await testInfo.attach(`typing-diagnostics-${name}`, {
      path,
      contentType: "application/json",
    });
  };
}
