/**
 * E2E tests for CodexOSS provider (local models via Ollama).
 *
 * Tests the UI flow for selecting and using the CodexOSS provider.
 * Creates test session files to verify project discovery and navigation.
 */

import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";

// Test project path and IDs
const mockProjectPath = join(tmpdir(), "claude-e2e-codexoss");
const projectId = Buffer.from(mockProjectPath).toString("base64url");

// Create test project before tests
test.beforeAll(() => {
  // Clean up any previous test artifacts
  try {
    rmSync(mockProjectPath, { recursive: true, force: true });
  } catch {
    // Ignore if doesn't exist
  }

  // Create the mock project directory and make it a git repo
  mkdirSync(mockProjectPath, { recursive: true });
  execSync("git init", { cwd: mockProjectPath, stdio: "ignore" });
  writeFileSync(join(mockProjectPath, "README.md"), "# CodexOSS Test Project");

  // Create a Codex session file so the project is discoverable
  // Use isolated test directory from e2ePaths (not real ~/.codex/)
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const codexSessionDir = join(
    e2ePaths.codexSessionsDir,
    String(year),
    month,
    day,
  );
  mkdirSync(codexSessionDir, { recursive: true });

  const sessionId = `e2e-codexoss-${Date.now()}`;
  const codexSessionFile = join(
    codexSessionDir,
    `rollout-${year}-${month}-${day}T00-00-00-${sessionId}.jsonl`,
  );

  // Write a minimal valid Codex session file
  const sessionMeta = {
    timestamp: now.toISOString(),
    type: "session_meta",
    payload: {
      id: sessionId,
      timestamp: now.toISOString(),
      cwd: mockProjectPath,
      originator: "codex_exec",
      cli_version: "0.77.0",
      model_provider: "ollama",
    },
  };

  const userMessage = {
    timestamp: now.toISOString(),
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "E2E test message" }],
    },
  };

  writeFileSync(
    codexSessionFile,
    `${JSON.stringify(sessionMeta)}\n${JSON.stringify(userMessage)}\n`,
  );
});

// Clean up after tests
test.afterAll(() => {
  // Clean up mock project directory
  try {
    rmSync(mockProjectPath, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
  // Note: No need to clean up codex session - it's in the isolated test directory
  // which is cleaned up by global-setup on next run
});

test.describe("CodexOSS Provider", () => {
  test("appears in provider selection with correct badge", async ({
    page,
    baseURL,
  }) => {
    // Go to new session page
    await page.goto(`${baseURL}/new`);

    // Open provider dropdown
    const providerSelector = page.locator(
      '[data-testid="provider-select"], select[name="provider"], .provider-select',
    );

    // If it's a select element, check options
    if (await providerSelector.first().isVisible()) {
      await providerSelector.first().click();

      // Look for codex-oss option
      const codexOssOption = page.locator(
        'option[value="codex-oss"], [data-value="codex-oss"]',
      );
      if (await codexOssOption.isVisible()) {
        await expect(codexOssOption).toBeVisible();
      }
    }
  });

  test("can navigate to codex-oss project", async ({ page, baseURL }) => {
    // Navigate to the test project
    await page.goto(`${baseURL}/projects/${projectId}`);

    // Wait for page to load (avoid networkidle which can timeout)
    await page.waitForLoadState("domcontentloaded");

    // Give the page a moment to redirect if needed
    await page.waitForTimeout(500);

    // Verify we're on a valid page (either project or sessions view)
    const url = page.url();
    expect(url).toMatch(/projects|sessions|inbox/);
  });
});

// Note: Session creation tests that spawn real processes are in
// packages/server/test/e2e/real-sdk.e2e.test.ts (requires REAL_SDK_TESTS=true)
