/**
 * Golden session replay tests.
 *
 * These tests replay recorded SSE events from fixture files to verify
 * that the UI renders correctly for real SDK conversations.
 *
 * To create a new fixture:
 *   1. Start real server: PORT=3400 pnpm dev
 *   2. Run: pnpm exec tsx scripts/record-golden-session.ts
 *   3. Interact with the app, then Ctrl+C to save
 *   4. Edit the fixture description and add assertions below
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface RecordedSSEEvent {
  type: string;
  data: unknown;
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

/**
 * Build SSE response body from recorded events.
 * SSE format: "event: <type>\ndata: <json>\n\n"
 */
function buildSSEBody(events: RecordedSSEEvent[]): string {
  return events
    .map((e) => {
      const data = typeof e.data === "string" ? e.data : JSON.stringify(e.data);
      return `event: ${e.type}\ndata: ${data}\n\n`;
    })
    .join("");
}

/**
 * Helper to set up route mocking for a fixture.
 * Returns a function to set up SSE streaming with delays.
 */
async function setupFixtureMocking(
  page: Awaited<ReturnType<(typeof test)["__getPage"]>>,
  fixture: RecordedFixture,
  options: { streamWithDelays?: boolean } = {},
) {
  // Group API calls by URL pattern for mocking
  const apiCallsByUrl = new Map<string, RecordedAPICall[]>();
  for (const call of fixture.apiCalls) {
    // Normalize URL (remove query params for grouping)
    const baseUrl = call.url.split("?")[0];
    const existing = apiCallsByUrl.get(baseUrl) || [];
    existing.push(call);
    apiCallsByUrl.set(baseUrl, existing);
  }

  // Track which response to return for each endpoint (for sequential calls)
  const responseIndex = new Map<string, number>();

  // Mock API endpoints
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;

    // Handle SSE stream endpoint specially
    if (pathname.includes("/stream")) {
      const sseBody = buildSSEBody(fixture.sseEvents);

      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
        body: sseBody,
      });
      return;
    }

    // Find matching recorded API call
    const baseUrl = pathname;
    const calls = apiCallsByUrl.get(baseUrl);
    if (calls && calls.length > 0) {
      const idx = responseIndex.get(baseUrl) || 0;
      const call = calls[idx % calls.length];
      responseIndex.set(baseUrl, idx + 1);

      // Only match if method matches
      if (call.method === request.method()) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(call.response),
        });
        return;
      }
    }

    // Fall through to real server for unrecorded endpoints
    // (In E2E tests this will hit the mock server)
    await route.continue();
  });
}

// Load fixtures from the fixtures directory
const fixturesDir = join(__dirname, "fixtures");
const fixtureFiles = existsSync(fixturesDir)
  ? readdirSync(fixturesDir).filter((f) => f.endsWith(".json"))
  : [];

// Golden session replay tests
test.describe("Golden Session Replay", () => {
  // When no fixtures exist, create a placeholder test that explains how to create them
  if (fixtureFiles.length === 0) {
    test("no fixtures found - run recording script first", async () => {
      test.skip(
        true,
        "No fixture files found. Run: pnpm exec tsx scripts/record-golden-session.ts",
      );
    });
    return;
  }

  for (const fixtureFile of fixtureFiles) {
    const fixturePath = join(fixturesDir, fixtureFile);
    const fixtureName = fixtureFile.replace(".json", "");

    test.describe(`Fixture: ${fixtureName}`, () => {
      let fixture: RecordedFixture;

      test.beforeAll(() => {
        fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));
      });

      test("loads and displays messages correctly", async ({ page }) => {
        await setupFixtureMocking(page, fixture);

        // Find the session URL from recorded API calls
        // Look for session creation or session detail calls
        const sessionCall = fixture.apiCalls.find(
          (c) =>
            c.url.includes("/sessions") &&
            c.response &&
            typeof c.response === "object" &&
            "sessionId" in (c.response as Record<string, unknown>),
        );

        const sessionDetailCall = fixture.apiCalls.find(
          (c) =>
            c.method === "GET" &&
            c.url.match(/\/sessions\/[^/]+$/) &&
            c.response &&
            typeof c.response === "object" &&
            "session" in (c.response as Record<string, unknown>),
        );

        // Extract project and session IDs
        let projectId: string | undefined;
        let sessionId: string | undefined;

        if (sessionCall?.response) {
          const resp = sessionCall.response as Record<string, unknown>;
          sessionId = resp.sessionId as string;
          // Extract projectId from URL
          const match = sessionCall.url.match(/\/projects\/([^/]+)\//);
          projectId = match?.[1];
        }

        if (!projectId || !sessionId) {
          // Try to extract from session detail call
          if (sessionDetailCall) {
            const match = sessionDetailCall.url.match(
              /\/projects\/([^/]+)\/sessions\/([^/]+)/,
            );
            projectId = match?.[1];
            sessionId = match?.[2];
          }
        }

        if (!projectId || !sessionId) {
          throw new Error(
            "Could not determine project/session IDs from fixture",
          );
        }

        // Navigate directly to the session page
        // The route mocking will intercept all API calls
        await page.goto(`/projects/${projectId}/sessions/${sessionId}`);

        // Wait for the message list to load
        await page.waitForSelector(".message-list", { timeout: 10000 });

        // Check that messages are rendered
        // User messages have data-render-type="user_prompt"
        const hasUserMessage = fixture.sseEvents.some(
          (e) =>
            e.type === "message" &&
            typeof e.data === "object" &&
            e.data !== null &&
            (e.data as Record<string, unknown>).type === "user",
        );

        if (hasUserMessage) {
          await expect(
            page.locator('[data-render-type="user_prompt"]'),
          ).toBeVisible({ timeout: 5000 });
        }

        // Check that assistant response is rendered
        const hasAssistantMessage = fixture.sseEvents.some(
          (e) =>
            e.type === "message" &&
            typeof e.data === "object" &&
            e.data !== null &&
            (e.data as Record<string, unknown>).type === "assistant",
        );

        if (hasAssistantMessage) {
          await expect(page.locator('[data-render-type="text"]')).toBeVisible({
            timeout: 5000,
          });
        }

        // Take a screenshot for visual comparison
        await expect(page.locator(".message-list")).toHaveScreenshot(
          `${fixtureName}-messages.png`,
          {
            // Allow some variance for fonts/rendering
            maxDiffPixelRatio: 0.05,
          },
        );
      });

      test("shows correct number of messages", async ({ page }) => {
        await setupFixtureMocking(page, fixture);

        // Extract IDs (same logic as above)
        const sessionCall = fixture.apiCalls.find(
          (c) =>
            c.url.includes("/sessions") &&
            c.response &&
            typeof c.response === "object" &&
            "sessionId" in (c.response as Record<string, unknown>),
        );
        const sessionDetailCall = fixture.apiCalls.find(
          (c) =>
            c.method === "GET" &&
            c.url.match(/\/sessions\/[^/]+$/) &&
            c.response &&
            typeof c.response === "object" &&
            "session" in (c.response as Record<string, unknown>),
        );

        let projectId: string | undefined;
        let sessionId: string | undefined;

        if (sessionCall?.response) {
          const resp = sessionCall.response as Record<string, unknown>;
          sessionId = resp.sessionId as string;
          const match = sessionCall.url.match(/\/projects\/([^/]+)\//);
          projectId = match?.[1];
        }
        if (!projectId || !sessionId) {
          if (sessionDetailCall) {
            const match = sessionDetailCall.url.match(
              /\/projects\/([^/]+)\/sessions\/([^/]+)/,
            );
            projectId = match?.[1];
            sessionId = match?.[2];
          }
        }
        if (!projectId || !sessionId) {
          throw new Error(
            "Could not determine project/session IDs from fixture",
          );
        }

        await page.goto(`/projects/${projectId}/sessions/${sessionId}`);
        await page.waitForSelector(".message-list", { timeout: 10000 });

        // Count user messages in fixture
        const userMessageCount = fixture.sseEvents.filter(
          (e) =>
            e.type === "message" &&
            typeof e.data === "object" &&
            e.data !== null &&
            (e.data as Record<string, unknown>).type === "user",
        ).length;

        // Count assistant messages in fixture
        const assistantMessageCount = fixture.sseEvents.filter(
          (e) =>
            e.type === "message" &&
            typeof e.data === "object" &&
            e.data !== null &&
            (e.data as Record<string, unknown>).type === "assistant",
        ).length;

        // Verify counts match rendered elements
        if (userMessageCount > 0) {
          await expect(
            page.locator('[data-render-type="user_prompt"]'),
          ).toHaveCount(userMessageCount);
        }

        if (assistantMessageCount > 0) {
          // Assistant messages become text blocks
          const textBlocks = page.locator('[data-render-type="text"]');
          const count = await textBlocks.count();
          expect(count).toBeGreaterThanOrEqual(assistantMessageCount);
        }
      });
    });
  }
});
