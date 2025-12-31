import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { MockClaudeSDK, createMockScenario } from "../src/sdk/mock.js";
import { encodeProjectId } from "../src/supervisor/types.js";
import { EventBus } from "../src/watcher/EventBus.js";

describe("Activity Stream SSE", () => {
  let mockSdk: MockClaudeSDK;
  let testDir: string;
  let projectPath: string;
  let projectId: string;

  beforeEach(async () => {
    mockSdk = new MockClaudeSDK();
    testDir = join(tmpdir(), `claude-test-${randomUUID()}`);
    projectPath = "/home/user/myproject";
    projectId = encodeProjectId(projectPath);
    const encodedPath = projectPath.replaceAll("/", "-");

    await mkdir(join(testDir, "localhost", encodedPath), { recursive: true });
    await writeFile(
      join(testDir, "localhost", encodedPath, "sess-existing.jsonl"),
      `{"type":"user","cwd":"${projectPath}","message":{"content":"Hello"}}\n`,
    );
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("emits process-state-changed event when session starts", async () => {
    const eventBus = new EventBus();
    const app = createApp({ sdk: mockSdk, projectsDir: testDir, eventBus });

    // Set up a mock scenario
    mockSdk.addScenario(createMockScenario("test-session", "Hello response"));

    // Start the activity stream
    const streamRes = await app.request("/api/activity/stream", {
      headers: { "X-Claude-Anywhere": "true" },
    });

    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get("content-type")).toContain(
      "text/event-stream",
    );

    // Get the readable stream
    const reader = streamRes.body?.getReader();
    expect(reader).toBeDefined();

    // Read initial connection event
    const decoder = new TextDecoder();
    let buffer = "";
    const events: Array<{ event: string; data: unknown }> = [];

    // Helper to parse SSE events from buffer
    const parseEvents = () => {
      const lines = buffer.split("\n");
      let currentEvent = "";
      let currentData = "";

      for (const line of lines) {
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          currentData = line.slice(5).trim();
        } else if (line === "" && currentEvent && currentData) {
          try {
            events.push({ event: currentEvent, data: JSON.parse(currentData) });
          } catch {
            events.push({ event: currentEvent, data: currentData });
          }
          currentEvent = "";
          currentData = "";
        }
      }
    };

    // Read first chunk (should have connected event)
    if (!reader) throw new Error("No reader");
    const { value: chunk1 } = await reader.read();
    buffer += decoder.decode(chunk1, { stream: true });
    parseEvents();

    console.log("Events after connection:", events);
    expect(events.some((e) => e.event === "connected")).toBe(true);

    // Now start a session - this should emit process-state-changed
    const sessionRes = await app.request(
      `/api/projects/${projectId}/sessions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Claude-Anywhere": "true",
        },
        body: JSON.stringify({ message: "Hello" }),
      },
    );

    // Could be 200 (resumed) or 201 (created)
    expect([200, 201]).toContain(sessionRes.status);
    const sessionData = await sessionRes.json();
    console.log("Session created:", sessionData);

    // Give a small delay for events to be emitted
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Read more from the stream
    const readWithTimeout = async (timeoutMs: number) => {
      const timeoutPromise = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), timeoutMs),
      );
      const readPromise = reader.read();
      return Promise.race([readPromise, timeoutPromise]);
    };

    // Try to read a few more chunks
    for (let i = 0; i < 5; i++) {
      const result = await readWithTimeout(200);
      if (result && !result.done && result.value) {
        buffer += decoder.decode(result.value, { stream: true });
        parseEvents();
      }
    }

    console.log(
      "All events received:",
      events.map((e) => e.event),
    );
    console.log("Full events:", JSON.stringify(events, null, 2));

    // Check for process-state-changed event
    const processStateEvents = events.filter(
      (e) => e.event === "process-state-changed",
    );
    console.log("Process state events:", processStateEvents);

    // Also check for session-status-changed (which should definitely be there)
    const statusEvents = events.filter(
      (e) => e.event === "session-status-changed",
    );
    console.log("Session status events:", statusEvents);

    // Verify we got the session-status-changed event (this is the baseline that works)
    expect(statusEvents.length).toBeGreaterThanOrEqual(1);

    // Verify we got the process-state-changed event
    expect(processStateEvents.length).toBeGreaterThanOrEqual(1);
    expect(processStateEvents[0]?.data).toMatchObject({
      type: "process-state-changed",
      processState: "running",
    });

    // Cleanup
    reader.cancel();
  });
});
