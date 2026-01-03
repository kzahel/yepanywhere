/**
 * E2E tests for local model provider using Ollama.
 *
 * These tests use real local LLMs (Qwen 2.5 Coder via Ollama) to test
 * file operations and shell commands. They provide free, fast testing
 * without API costs.
 *
 * Prerequisites:
 * - Ollama installed: curl -fsSL https://ollama.com/install.sh | sh
 * - Model pulled: ollama pull qwen2.5-coder:7b
 * - Ollama running: ollama serve
 *
 * Run with: pnpm test:e2e:local
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type LocalModelConfig,
  LocalModelProvider,
} from "../../src/sdk/providers/local-model.js";
import type { SDKMessage } from "../../src/sdk/types.js";

/**
 * Check for verbose logging mode.
 */
const FOREGROUND = process.env.FOREGROUND === "1";

function log(...args: unknown[]) {
  if (FOREGROUND) {
    console.log(...args);
  }
}

/**
 * Collect messages from an async iterator until a result message is received.
 */
async function collectUntilResult(
  iterator: AsyncIterableIterator<SDKMessage>,
  timeout = 120000,
): Promise<SDKMessage[]> {
  const messages: SDKMessage[] = [];
  const timeoutId = setTimeout(() => {
    throw new Error("Timeout waiting for result");
  }, timeout);

  try {
    for await (const message of iterator) {
      messages.push(message);
      log(`[${message.type}]`, JSON.stringify(message).slice(0, 200));

      if (message.type === "result") {
        break;
      }
    }
  } finally {
    clearTimeout(timeoutId);
  }

  return messages;
}

/**
 * Get default model based on environment.
 */
function getDefaultModel(): string {
  // Use 32B for quality tests, 7B otherwise
  return process.env.LOCAL_MODEL_QUALITY === "true"
    ? "qwen2.5-coder:32b"
    : "qwen2.5-coder:7b";
}

describe("Local Model E2E", () => {
  let provider: LocalModelProvider;
  let testDir: string;
  let ollamaAvailable = false;

  beforeAll(async () => {
    const model = getDefaultModel();
    const config: LocalModelConfig = {
      model,
      timeout: 180000, // 3 minutes for slower models
    };

    provider = new LocalModelProvider(config);

    // Check if Ollama is running
    ollamaAvailable = await provider.isInstalled();
    if (!ollamaAvailable) {
      console.log("Skipping local model E2E tests - Ollama not running");
      console.log("Start Ollama with: ollama serve");
      return;
    }

    console.log(`Using local model: ${model}`);

    // Create temp test directory
    testDir = mkdtempSync(join(tmpdir(), "local-model-e2e-"));
    console.log(`Test directory: ${testDir}`);
  });

  afterAll(() => {
    if (testDir) {
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it("should detect Ollama availability", async () => {
    // This test always runs to verify detection logic
    const isInstalled = await provider.isInstalled();
    const authStatus = await provider.getAuthStatus();

    expect(typeof isInstalled).toBe("boolean");
    expect(authStatus.authenticated).toBe(true); // Local models don't need auth
    expect(authStatus.enabled).toBe(isInstalled);
  });

  it("should create a file when asked", async () => {
    if (!ollamaAvailable) {
      return;
    }

    const { iterator, abort } = await provider.startSession({
      cwd: testDir,
      initialMessage: {
        text: 'Create a file called hello.txt containing exactly "Hello World" (just those two words, nothing else).',
      },
    });

    try {
      const messages = await collectUntilResult(iterator);

      // Verify we got messages including init and result
      expect(messages.length).toBeGreaterThanOrEqual(2);
      expect(messages[0]?.type).toBe("system");
      expect(messages.some((m) => m.type === "result")).toBe(true);

      // Verify the file was created
      const filePath = join(testDir, "hello.txt");
      expect(existsSync(filePath)).toBe(true);

      const content = readFileSync(filePath, "utf-8");
      expect(content.toLowerCase()).toContain("hello");
    } finally {
      abort();
    }
  }, 180000);

  it("should read and modify an existing file", async () => {
    if (!ollamaAvailable) {
      return;
    }

    // Create initial file
    const filePath = join(testDir, "counter.txt");
    writeFileSync(filePath, "0", "utf-8");

    const { iterator, abort } = await provider.startSession({
      cwd: testDir,
      initialMessage: {
        text: "Read the file counter.txt, which contains a number. Increment that number by 1 and write the new number back to the file (just the number, nothing else).",
      },
    });

    try {
      const messages = await collectUntilResult(iterator);

      expect(messages.length).toBeGreaterThanOrEqual(2);
      expect(messages.some((m) => m.type === "result")).toBe(true);

      // Verify the file was modified
      const content = readFileSync(filePath, "utf-8").trim();
      log(`[counter content] "${content}"`);

      // Should be "1" (incremented from 0)
      expect(content).toBe("1");
    } finally {
      abort();
    }
  }, 180000);

  it("should execute shell commands", async () => {
    if (!ollamaAvailable) {
      return;
    }

    const { iterator, abort } = await provider.startSession({
      cwd: testDir,
      initialMessage: {
        text: 'Run the shell command "echo hello_from_shell" and tell me the output.',
      },
    });

    try {
      const messages = await collectUntilResult(iterator);

      expect(messages.length).toBeGreaterThanOrEqual(2);
      expect(messages.some((m) => m.type === "result")).toBe(true);

      // Check that some message contains the echo output
      const allContent = messages
        .map((m) => JSON.stringify(m))
        .join("\n")
        .toLowerCase();
      expect(allContent).toContain("hello_from_shell");
    } finally {
      abort();
    }
  }, 180000);

  it("should handle errors gracefully", async () => {
    if (!ollamaAvailable) {
      return;
    }

    const { iterator, abort } = await provider.startSession({
      cwd: testDir,
      initialMessage: {
        text: "Try to read a file called /definitely/does/not/exist/anywhere.txt and tell me what error occurred.",
      },
    });

    try {
      const messages = await collectUntilResult(iterator);

      // Should complete without throwing
      expect(messages.length).toBeGreaterThanOrEqual(2);
      expect(messages.some((m) => m.type === "result")).toBe(true);

      // Error should be mentioned in response
      const allContent = messages
        .map((m) => JSON.stringify(m))
        .join("\n")
        .toLowerCase();
      expect(
        allContent.includes("error") ||
          allContent.includes("not found") ||
          allContent.includes("does not exist") ||
          allContent.includes("no such file"),
      ).toBe(true);
    } finally {
      abort();
    }
  }, 180000);

  it("should edit a file using string replacement", async () => {
    if (!ollamaAvailable) {
      return;
    }

    // Create a file with known content
    const filePath = join(testDir, "edit-test.txt");
    writeFileSync(
      filePath,
      "The quick brown fox jumps over the lazy dog.",
      "utf-8",
    );

    const { iterator, abort } = await provider.startSession({
      cwd: testDir,
      initialMessage: {
        text: 'Edit the file edit-test.txt: replace the word "lazy" with "energetic".',
      },
    });

    try {
      const messages = await collectUntilResult(iterator);

      expect(messages.length).toBeGreaterThanOrEqual(2);
      expect(messages.some((m) => m.type === "result")).toBe(true);

      // Verify the edit
      const content = readFileSync(filePath, "utf-8");
      expect(content).toContain("energetic");
      expect(content).not.toContain("lazy");
    } finally {
      abort();
    }
  }, 180000);

  it("should create a file in a nested directory", async () => {
    if (!ollamaAvailable) {
      return;
    }

    const { iterator, abort } = await provider.startSession({
      cwd: testDir,
      initialMessage: {
        text: 'Create a file at nested/dir/deep/file.txt containing "nested content".',
      },
    });

    try {
      const messages = await collectUntilResult(iterator);

      expect(messages.length).toBeGreaterThanOrEqual(2);
      expect(messages.some((m) => m.type === "result")).toBe(true);

      // Verify nested file was created
      const filePath = join(testDir, "nested", "dir", "deep", "file.txt");
      expect(existsSync(filePath)).toBe(true);

      const content = readFileSync(filePath, "utf-8").toLowerCase();
      expect(content).toContain("nested");
    } finally {
      abort();
    }
  }, 180000);

  it("should abort a running session", async () => {
    if (!ollamaAvailable) {
      return;
    }

    const { iterator, abort } = await provider.startSession({
      cwd: testDir,
      initialMessage: {
        text: "Count from 1 to 100, creating a file for each number named count_1.txt, count_2.txt, etc.",
      },
    });

    const messages: SDKMessage[] = [];

    // Abort after receiving at least init message
    const abortTimer = setTimeout(() => {
      log("[aborting session]");
      abort();
    }, 2000);

    try {
      for await (const message of iterator) {
        messages.push(message);
        log(`[${message.type}]`);

        // If we already got a result, no need to wait for abort
        if (message.type === "result") {
          break;
        }
      }
    } finally {
      clearTimeout(abortTimer);
    }

    // Should have received at least init message
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0]?.type).toBe("system");
  }, 30000);

  it("should handle multi-step tasks", async () => {
    if (!ollamaAvailable) {
      return;
    }

    const { iterator, abort } = await provider.startSession({
      cwd: testDir,
      initialMessage: {
        text: `Complete these steps in order:
1. Create a file called step1.txt containing "Step 1 complete"
2. Read step1.txt to verify it was created
3. Create step2.txt containing "Step 2 complete"
4. List all .txt files in the current directory using ls command`,
      },
    });

    try {
      const messages = await collectUntilResult(iterator);

      expect(messages.length).toBeGreaterThanOrEqual(2);
      expect(messages.some((m) => m.type === "result")).toBe(true);

      // Verify both files exist
      expect(existsSync(join(testDir, "step1.txt"))).toBe(true);
      expect(existsSync(join(testDir, "step2.txt"))).toBe(true);
    } finally {
      abort();
    }
  }, 240000);

  it("should work with relative paths", async () => {
    if (!ollamaAvailable) {
      return;
    }

    const { iterator, abort } = await provider.startSession({
      cwd: testDir,
      initialMessage: {
        text: 'Create a file at ./relative-path-test.txt containing "relative path works".',
      },
    });

    try {
      const messages = await collectUntilResult(iterator);

      expect(messages.length).toBeGreaterThanOrEqual(2);
      expect(messages.some((m) => m.type === "result")).toBe(true);

      // Verify file was created
      const filePath = join(testDir, "relative-path-test.txt");
      expect(existsSync(filePath)).toBe(true);
    } finally {
      abort();
    }
  }, 180000);
});
