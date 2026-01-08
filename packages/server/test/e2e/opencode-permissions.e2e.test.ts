import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * E2E test for OpenCode permission/approval flow.
 *
 * This test:
 * 1. Spawns an OpenCode server with permissions set to "ask" for all tools
 * 2. Creates a session and sends a message that requires file editing
 * 3. Watches for permission request events
 * 4. Tests approval/rejection flow
 *
 * Run with: OPENCODE_PERMISSION_TESTS=true pnpm test:e2e
 * Add FOREGROUND=1 for verbose logging
 */

const FOREGROUND = process.env.FOREGROUND === "1";

function log(...args: unknown[]) {
  if (FOREGROUND) {
    console.log("[test]", ...args);
  }
}

interface OpenCodeSSEEvent {
  type: string;
  properties?: Record<string, unknown>;
}

function parseSSEEvent(data: string): OpenCodeSSEEvent | null {
  try {
    return JSON.parse(data) as OpenCodeSSEEvent;
  } catch {
    return null;
  }
}

async function waitForServer(baseUrl: string, timeoutMs = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/session`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return true;
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

describe("OpenCode Permissions E2E", () => {
  let serverProcess: ChildProcess | null = null;
  let testDir: string;
  let baseUrl: string;
  const port = 14200 + Math.floor(Math.random() * 100);

  beforeAll(async () => {
    if (process.env.OPENCODE_PERMISSION_TESTS !== "true") {
      console.log("Skipping OpenCode permission tests - set OPENCODE_PERMISSION_TESTS=true to enable");
      return;
    }

    // Create temp directory
    testDir = mkdtempSync(join(tmpdir(), "opencode-perm-test-"));
    writeFileSync(join(testDir, "test.txt"), "original content");

    // Create opencode config with all permissions set to "ask"
    // Must explicitly override "read" since OpenCode defaults it to "allow"
    const opencodeConfig = {
      permission: {
        "*": "ask",
        "read": "ask",
        "edit": "ask",
        "bash": "ask",
        "glob": "ask",
        "grep": "ask",
      },
    };
    writeFileSync(join(testDir, "opencode.json"), JSON.stringify(opencodeConfig, null, 2));

    log("Test directory:", testDir);
    log("OpenCode config:", opencodeConfig);

    // Start OpenCode server
    baseUrl = `http://127.0.0.1:${port}`;
    log("Starting OpenCode server on port", port);

    serverProcess = spawn("opencode", ["serve", "--port", String(port), "--print-logs"], {
      cwd: testDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Log server output
    serverProcess.stdout?.on("data", (data) => {
      log("[opencode stdout]", data.toString());
    });
    serverProcess.stderr?.on("data", (data) => {
      log("[opencode stderr]", data.toString());
    });
    serverProcess.on("error", (err) => {
      log("[opencode error]", err);
    });

    const ready = await waitForServer(baseUrl);
    if (!ready) {
      throw new Error("OpenCode server failed to start");
    }
    log("OpenCode server ready");
  }, 30000);

  afterAll(() => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill("SIGTERM");
    }
    if (testDir) {
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("should emit permission request events when tools need approval", async () => {
    if (process.env.OPENCODE_PERMISSION_TESTS !== "true") {
      return;
    }

    // Create a session
    const sessionRes = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Permission Test" }),
    });
    expect(sessionRes.ok).toBe(true);
    const { id: sessionId } = (await sessionRes.json()) as { id: string };
    log("Created session:", sessionId);

    // Connect to SSE stream
    const sseController = new AbortController();
    const events: OpenCodeSSEEvent[] = [];
    const permissionRequests: OpenCodeSSEEvent[] = [];

    const ssePromise = (async () => {
      try {
        const sseRes = await fetch(`${baseUrl}/event`, {
          headers: { Accept: "text/event-stream" },
          signal: sseController.signal,
        });

        if (!sseRes.ok || !sseRes.body) {
          log("SSE connection failed:", sseRes.status);
          return;
        }

        const reader = sseRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!sseController.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const event = parseSSEEvent(line.slice(6));
            if (event) {
              events.push(event);
              log("SSE event:", event.type, event.properties);

              // Look for permission.asked events specifically
              if (event.type === "permission.asked") {
                permissionRequests.push(event);
                log(">>> PERMISSION EVENT:", JSON.stringify(event, null, 2));
              }
              // Also log any permission-related events
              if (event.type.includes("permission")) {
                log(">>> permission event type:", event.type);
              }
            }
          }
        }
      } catch (err) {
        if (!sseController.signal.aborted) {
          log("SSE error:", err);
        }
      }
    })();

    // Wait a bit for SSE to connect
    await new Promise((r) => setTimeout(r, 500));

    // Send a message that should trigger a tool use (and permission request)
    // Use a very direct command that requires reading the file
    // Note: Don't await - the message endpoint may block until AI responds
    log("Sending message to trigger file read...");
    const msgPromise = fetch(`${baseUrl}/session/${sessionId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: "Read the contents of test.txt and tell me what it says. Use the read tool." }],
      }),
    });
    log("Message request initiated (not awaiting)");

    // Wait for permission request event (with timeout)
    const timeout = 60000;
    const start = Date.now();
    log("Starting wait loop for permission events...");
    while (Date.now() - start < timeout) {
      // Log current state periodically
      if ((Date.now() - start) % 5000 < 200) {
        log(`Waiting... events=${events.length}, permissionRequests=${permissionRequests.length}`);
      }

      // Check if we got a permission request
      if (permissionRequests.length > 0) {
        log("Got permission request!");
        break;
      }

      // Check if session went idle (completed without permission request - shouldn't happen with ask mode)
      const idleEvent = events.find((e) => e.type === "session.idle");
      if (idleEvent) {
        log("Session went idle without permission request - unexpected!");
        break;
      }

      await new Promise((r) => setTimeout(r, 200));
    }

    log(`Found ${permissionRequests.length} permission requests after ${Date.now() - start}ms`);

    // Stop SSE first (before checking message result, which might hang)
    sseController.abort();
    await ssePromise;

    // Log all events for debugging
    log("\n=== All events received ===");
    for (const event of events) {
      log(event.type, JSON.stringify(event.properties ?? {}).slice(0, 200));
    }

    log("\n=== Permission requests ===");
    for (const pr of permissionRequests) {
      log(JSON.stringify(pr, null, 2));
    }

    // Check what we got
    expect(events.length).toBeGreaterThan(0);
    expect(permissionRequests.length).toBeGreaterThan(0);

    // Test the approval flow
    const permReq = permissionRequests[0];
    const permId = (permReq.properties as { id: string }).id;
    log("Approving permission request:", permId);

    // Approve with "once" - API expects { reply: "once" | "always" | "reject" }
    const approveRes = await fetch(`${baseUrl}/permission/${permId}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply: "once" }),
    });
    log("Approval response status:", approveRes.status);
    if (approveRes.ok) {
      const approveData = await approveRes.json();
      log("Approval response:", JSON.stringify(approveData, null, 2));
    } else {
      const errorText = await approveRes.text();
      log("Approval error:", errorText);
    }
    expect(approveRes.ok).toBe(true);
  }, 90000);

  it("should list pending permissions via GET /permission", async () => {
    if (process.env.OPENCODE_PERMISSION_TESTS !== "true") {
      return;
    }

    const res = await fetch(`${baseUrl}/permission`);
    log("GET /permission status:", res.status);
    if (res.ok) {
      const data = await res.json();
      log("Pending permissions:", JSON.stringify(data, null, 2));
    }
  });
});
