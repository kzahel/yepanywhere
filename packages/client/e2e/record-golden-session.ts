/**
 * Record a golden session fixture from a real SDK interaction.
 *
 * This script:
 * 1. Launches a browser against your running Yep Anywhere server
 * 2. Intercepts and records all API calls and SSE events
 * 3. Saves them to a fixture file for E2E test replay
 *
 * Usage:
 *   # Start your real server first (not mock):
 *   PORT=3400 pnpm dev
 *
 *   # In another terminal, run this script:
 *   pnpm -F client exec tsx e2e/record-golden-session.ts
 *
 *   # Or specify options:
 *   pnpm -F client exec tsx e2e/record-golden-session.ts --url http://localhost:3400 --output my-fixture.json
 *
 * The script will:
 * - Open a browser window
 * - Navigate to the app
 * - Let you interact normally (create session, send message)
 * - Record all network activity
 * - Press Ctrl+C when done to save the fixture
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface RecordedSSEEvent {
  type: string;
  data: unknown;
  /** Milliseconds since recording started */
  timestampOffset: number;
}

interface RecordedAPICall {
  method: string;
  url: string;
  body?: unknown;
  response: unknown;
  timestampOffset: number;
}

interface RecordedFixture {
  description: string;
  recordedAt: string;
  baseUrl: string;
  apiCalls: RecordedAPICall[];
  sseEvents: RecordedSSEEvent[];
}

// Parse command line args
const args = process.argv.slice(2);
const getArg = (name: string, defaultValue: string): string => {
  const idx = args.findIndex((a) => a.startsWith(`--${name}=`));
  if (idx >= 0) return args[idx].split("=")[1];
  const flagIdx = args.findIndex((a) => a === `--${name}`);
  if (flagIdx >= 0 && args[flagIdx + 1]) return args[flagIdx + 1];
  return defaultValue;
};

const BASE_URL = getArg("url", "http://localhost:3400");
const OUTPUT_FILE = getArg(
  "output",
  join(__dirname, "fixtures", "recorded-session.json"),
);

async function main() {
  console.log(`Recording session from ${BASE_URL}`);
  console.log(`Output will be saved to ${OUTPUT_FILE}`);
  console.log("");

  const browser = await chromium.launch({
    headless: false,
    // Slow down for visibility
    slowMo: 50,
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  const startTime = Date.now();
  const apiCalls: RecordedAPICall[] = [];
  const sseEvents: RecordedSSEEvent[] = [];

  // Track active SSE connections for cleanup logging
  const activeSSEUrls = new Set<string>();

  // Intercept API calls (non-SSE)
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    // Skip SSE endpoints - we capture those differently
    if (url.pathname.includes("/stream")) {
      await route.continue();
      return;
    }

    try {
      const response = await route.fetch();
      const responseBody = await response.json().catch(() => null);

      apiCalls.push({
        method: request.method(),
        url: url.pathname + url.search,
        body: request.postDataJSON(),
        response: responseBody,
        timestampOffset: Date.now() - startTime,
      });

      console.log(
        `[API] ${request.method()} ${url.pathname} -> ${response.status()}`,
      );

      await route.fulfill({ response });
    } catch (err) {
      console.error(`[API Error] ${url.pathname}:`, err);
      await route.continue();
    }
  });

  // Inject SSE recording into the page
  // We wrap EventSource to capture events as they arrive
  await page.addInitScript(() => {
    const originalEventSource = window.EventSource;

    // @ts-expect-error - extending EventSource
    window.EventSource = class RecordingEventSource extends (
      originalEventSource
    ) {
      constructor(url: string | URL, eventSourceInitDict?: EventSourceInit) {
        super(url, eventSourceInitDict);

        const urlStr = typeof url === "string" ? url : url.toString();

        // Notify recording script that SSE connected
        window.dispatchEvent(
          new CustomEvent("sse-connected", { detail: { url: urlStr } }),
        );

        // Wrap addEventListener to capture all event types
        const originalAddEventListener = this.addEventListener.bind(this);
        this.addEventListener = (
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: boolean | AddEventListenerOptions,
        ) => {
          const wrappedListener = (event: Event) => {
            if (event instanceof MessageEvent) {
              // Send event data to our recording
              window.dispatchEvent(
                new CustomEvent("sse-event", {
                  detail: {
                    url: urlStr,
                    type,
                    data: event.data,
                  },
                }),
              );
            }
            // Call original listener
            if (typeof listener === "function") {
              listener(event);
            } else {
              listener.handleEvent(event);
            }
          };
          return originalAddEventListener(type, wrappedListener, options);
        };
      }
    };
  });

  // Listen for SSE events from the page
  await page.exposeFunction(
    "__recordSSEEvent",
    (type: string, data: string) => {
      try {
        const parsed = JSON.parse(data);
        sseEvents.push({
          type,
          data: parsed,
          timestampOffset: Date.now() - startTime,
        });
        console.log(`[SSE] ${type}: ${data.slice(0, 100)}...`);
      } catch {
        // Non-JSON data
        sseEvents.push({
          type,
          data,
          timestampOffset: Date.now() - startTime,
        });
        console.log(`[SSE] ${type}: ${data.slice(0, 100)}...`);
      }
    },
  );

  // Bridge custom events to our exposed function
  await page.evaluate(() => {
    window.addEventListener("sse-event", ((e: CustomEvent) => {
      // @ts-expect-error - exposed function
      window.__recordSSEEvent(e.detail.type, e.detail.data);
    }) as EventListener);

    window.addEventListener("sse-connected", ((e: CustomEvent) => {
      console.log("[Recording] SSE connected:", e.detail.url);
    }) as EventListener);
  });

  // Navigate to the app
  await page.goto(BASE_URL);
  console.log("");
  console.log("=".repeat(60));
  console.log("Browser is open. Interact with the app to record a session.");
  console.log("When finished, press Ctrl+C to save the fixture.");
  console.log("=".repeat(60));
  console.log("");

  // Wait for Ctrl+C
  await new Promise<void>((resolve) => {
    const cleanup = () => {
      console.log("\nSaving fixture...");
      resolve();
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    // Also allow closing the browser window to trigger save
    page.on("close", cleanup);
  });

  // Save the fixture
  const fixture: RecordedFixture = {
    description: "Recorded session - edit this description",
    recordedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    apiCalls,
    sseEvents,
  };

  // Ensure fixtures directory exists
  mkdirSync(dirname(OUTPUT_FILE), { recursive: true });
  writeFileSync(OUTPUT_FILE, JSON.stringify(fixture, null, 2));
  console.log(`\nFixture saved to ${OUTPUT_FILE}`);
  console.log(`  - ${apiCalls.length} API calls recorded`);
  console.log(`  - ${sseEvents.length} SSE events recorded`);

  await browser.close();
}

main().catch((err) => {
  console.error("Recording failed:", err);
  process.exit(1);
});
