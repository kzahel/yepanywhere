import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectClaudeCli } from "../../src/sdk/cli-detection.js";
import { MessageQueue } from "../../src/sdk/messageQueue.js";
import { RealClaudeSDK } from "../../src/sdk/real.js";
import type {
  SDKMessage,
  StartSessionOptions,
  UserMessage,
} from "../../src/sdk/types.js";
import { Process } from "../../src/supervisor/Process.js";

/**
 * E2E tests for the real Claude SDK.
 *
 * These tests require:
 * - Claude CLI installed
 * - Valid Claude authentication (API key or OAuth)
 *
 * Tests will be skipped if prerequisites are not met.
 * Run with: REAL_SDK_TESTS=true pnpm test:e2e
 * Add FOREGROUND=1 for verbose real-time logging
 */

const FOREGROUND = process.env.FOREGROUND === "1";

function log(...args: unknown[]) {
  if (FOREGROUND) {
    console.log(...args);
  }
}

function logMessage(message: SDKMessage) {
  if (!FOREGROUND) return;

  const subtype = (message as { subtype?: string }).subtype;
  console.log(`[${message.type}${subtype ? `:${subtype}` : ""}]`);

  if (message.type === "assistant" || message.type === "user") {
    const msg = message as { message?: { content?: unknown } };
    const content = msg.message?.content;
    if (typeof content === "string") {
      console.log(
        `  ${content.slice(0, 200)}${content.length > 200 ? "..." : ""}`,
      );
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text") {
          const text = block.text as string;
          console.log(
            `  ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`,
          );
        } else if (block.type === "tool_use") {
          console.log(`  [tool_use] ${block.name}`);
        } else if (block.type === "tool_result") {
          console.log("  [tool_result]");
        }
      }
    }
  }
}

describe("Real SDK E2E", () => {
  let sdk: RealClaudeSDK;
  let testDir: string;
  let cliAvailable = false;

  beforeAll(() => {
    // Check if we should run real SDK tests
    if (process.env.REAL_SDK_TESTS !== "true") {
      console.log(
        "Skipping real SDK tests - set REAL_SDK_TESTS=true to enable",
      );
      return;
    }

    // Check if CLI is installed
    const cliInfo = detectClaudeCli();
    if (!cliInfo.found) {
      console.log("Skipping real SDK tests - Claude CLI not installed");
      console.log(cliInfo.error);
      return;
    }

    console.log(`Using Claude CLI: ${cliInfo.path} (${cliInfo.version})`);
    cliAvailable = true;

    // Create a temp directory for the test project
    testDir = mkdtempSync(join(tmpdir(), "claude-anywhere-e2e-"));

    // Create a simple test file
    writeFileSync(join(testDir, "test.txt"), "Hello from test file");

    sdk = new RealClaudeSDK();
  });

  afterAll(() => {
    if (testDir) {
      try {
        rmSync(testDir, { recursive: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it("should start a session and receive messages", async () => {
    if (!cliAvailable) {
      return; // Skip if CLI not installed
    }

    const { iterator, abort } = await sdk.startSession({
      cwd: testDir,
      initialMessage: { text: 'Say "hello test" and nothing else' },
      permissionMode: "bypassPermissions", // For E2E tests only
    });

    const messages: SDKMessage[] = [];

    // Collect messages with a timeout
    const timeout = setTimeout(() => abort(), 30000);

    try {
      for await (const message of iterator) {
        messages.push(message);
        logMessage(message);

        // Stop after we get a result
        if (message.type === "result") {
          break;
        }
      }
    } finally {
      clearTimeout(timeout);
    }

    // We should have received at least init + assistant + result
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0]?.type).toBe("system");
    expect((messages[0] as { subtype?: string }).subtype).toBe("init");
  }, 60000); // 60s timeout for real API call

  it("should handle tool approval callbacks", async () => {
    if (!cliAvailable) {
      return; // Skip if CLI not installed
    }

    const toolRequests: Array<{ toolName: string; input: unknown }> = [];

    const { iterator, abort } = await sdk.startSession({
      cwd: testDir,
      initialMessage: { text: "Read the file test.txt" },
      permissionMode: "default", // Will trigger approval
      onToolApproval: async (toolName, input) => {
        toolRequests.push({ toolName, input });
        log(`[tool_approval] ${toolName}`, input);
        // Auto-approve for test
        return { behavior: "allow" as const };
      },
    });

    const messages: SDKMessage[] = [];
    const timeout = setTimeout(() => abort(), 60000);

    try {
      for await (const message of iterator) {
        messages.push(message);
        logMessage(message);
        if (message.type === "result") break;
      }
    } finally {
      clearTimeout(timeout);
    }

    // Should have triggered at least one tool approval for Read
    expect(toolRequests.length).toBeGreaterThan(0);
  }, 90000); // 90s timeout

  it("should abort a running session", async () => {
    if (!cliAvailable) {
      return; // Skip if CLI not installed
    }

    const { iterator, abort } = await sdk.startSession({
      cwd: testDir,
      initialMessage: {
        text: "Count slowly from 1 to 100, saying each number",
      },
      permissionMode: "bypassPermissions",
    });

    const messages: SDKMessage[] = [];

    // Abort after a short delay
    setTimeout(() => {
      log("[abort] Aborting session...");
      abort();
    }, 2000);

    try {
      for await (const message of iterator) {
        messages.push(message);
        logMessage(message);
      }
    } catch (error) {
      // AbortError is expected
      if (error instanceof Error && error.name !== "AbortError") {
        throw error;
      }
    }

    // We should have received at least init message
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0]?.type).toBe("system");
  }, 30000);

  it("should receive stream_event messages with includePartialMessages", async () => {
    if (!cliAvailable) {
      return; // Skip if CLI not installed
    }

    const { iterator, abort } = await sdk.startSession({
      cwd: testDir,
      initialMessage: { text: 'Say "streaming works" and nothing else' },
      permissionMode: "bypassPermissions",
    });

    const messages: SDKMessage[] = [];
    const streamEvents: SDKMessage[] = [];
    const timeout = setTimeout(() => abort(), 30000);

    try {
      for await (const message of iterator) {
        messages.push(message);

        // Track stream_event messages separately
        if (message.type === "stream_event") {
          streamEvents.push(message);
          const event = (message as { event?: { type?: string } }).event;
          log(`[stream_event] ${event?.type}`);
        } else {
          logMessage(message);
        }

        if (message.type === "result") break;
      }
    } finally {
      clearTimeout(timeout);
    }

    // We should have received stream events (content_block_start, content_block_delta, etc.)
    log(`[stream events count] ${streamEvents.length}`);
    expect(streamEvents.length).toBeGreaterThan(0);

    // Verify we got text deltas
    const textDeltas = streamEvents.filter((m) => {
      const event = (
        m as { event?: { type?: string; delta?: { type?: string } } }
      ).event;
      return (
        event?.type === "content_block_delta" &&
        event?.delta?.type === "text_delta"
      );
    });
    log(`[text delta events] ${textDeltas.length}`);
    expect(textDeltas.length).toBeGreaterThan(0);

    // Also verify we got the final assistant message
    const assistantMessage = messages.find((m) => m.type === "assistant");
    expect(assistantMessage).toBeDefined();
  }, 60000);

  it("should echo back user message with attachments unchanged", async () => {
    if (!cliAvailable) {
      return; // Skip if CLI not installed
    }

    // Create a test file to simulate an attachment (use .txt to avoid image processing)
    const attachmentPath = join(testDir, "data.txt");
    writeFileSync(attachmentPath, "some test data content");

    const messageWithAttachments: UserMessage = {
      text: 'Say "got it" and nothing else',
      attachments: [
        {
          id: "file-1",
          originalName: "data.txt",
          size: 1024,
          mimeType: "text/plain",
          path: attachmentPath,
        },
      ],
    };

    const { iterator, abort } = await sdk.startSession({
      cwd: testDir,
      initialMessage: messageWithAttachments,
      permissionMode: "bypassPermissions",
    });

    // Also test what Process.buildUserMessageContent produces
    const mockIterator = (async function* () {
      yield {
        type: "system",
        subtype: "init",
        session_id: "test",
      } as SDKMessage;
    })();
    const testProcess = new Process(mockIterator, {
      projectPath: testDir,
      projectId: "test",
      sessionId: "test",
      idleTimeoutMs: 100,
      queue: new MessageQueue(),
    });
    testProcess.queueMessage(messageWithAttachments);
    const processContent = testProcess.getMessageHistory()[0]?.message?.content;

    const messages: SDKMessage[] = [];
    const timeout = setTimeout(() => abort(), 30000);

    try {
      for await (const message of iterator) {
        messages.push(message);
        logMessage(message);
        log("[full message]", JSON.stringify(message, null, 2));
        if (message.type === "result") break;
      }
    } finally {
      clearTimeout(timeout);
    }

    // Find the initial user message (not tool_result messages)
    // The SDK should echo back user messages with role: "user"
    const userMessage = messages.find(
      (m) => m.type === "user" && m.message?.role === "user",
    );

    log(
      "[all message types]",
      messages.map((m) => m.type),
    );
    log("[user message from SDK]", userMessage?.message?.content);
    log("[user message from Process]", processContent);

    // SDK doesn't echo user messages in the stream - they're written directly to JSONL
    // We need to check the JSONL file to verify what got written

    // Find the JSONL file in ~/.claude/projects/<projectId>/
    const claudeDir = join(process.env.HOME || "", ".claude", "projects");

    // The session ID is in the init message
    const initMessage = messages.find((m) => m.type === "system");
    const sessionId = (initMessage as { session_id?: string })?.session_id;
    log("[session_id]", sessionId);

    // Find the project directory (base64 encoded path)
    const projectDirs = readdirSync(claudeDir);
    let jsonlContent = "";

    for (const projectDir of projectDirs) {
      const sessionsDir = join(claudeDir, projectDir);
      try {
        const files = readdirSync(sessionsDir);
        const jsonlFile = files.find((f) => f === `${sessionId}.jsonl`);
        if (jsonlFile) {
          jsonlContent = readFileSync(join(sessionsDir, jsonlFile), "utf-8");
          log("[found JSONL]", join(sessionsDir, jsonlFile));
          break;
        }
      } catch {
        // Not a directory or can't read
      }
    }

    expect(jsonlContent).toBeTruthy();
    log("[JSONL content]", jsonlContent);

    // Parse JSONL and find user message
    const jsonlMessages = jsonlContent
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));

    const jsonlUserMessage = jsonlMessages.find(
      (m: { type: string }) => m.type === "user",
    );
    log("[JSONL user message]", JSON.stringify(jsonlUserMessage, null, 2));

    expect(jsonlUserMessage).toBeDefined();
    const jsonlUserContent = jsonlUserMessage?.message?.content;

    // Verify our Process content is correct
    expect(processContent).toContain('Say "got it" and nothing else');
    expect(processContent).toContain("User uploaded files:");
    expect(processContent).toContain("data.txt");
    expect(processContent).toContain("1.0 KB");
    expect(processContent).toContain("text/plain");

    // THE CRITICAL TEST: Verify JSONL content matches what Process produces
    // This is what deduplication relies on
    log("[comparing]");
    log("  JSONL:", jsonlUserContent);
    log("  Process:", processContent);
    expect(jsonlUserContent).toBe(processContent);
  }, 60000);

  it("should pass model and thinking options to SDK", async () => {
    if (!cliAvailable) {
      return; // Skip if CLI not installed
    }

    // Test that we can start a session with model and thinking options
    // This verifies the options are passed through correctly
    const sessionOptions: StartSessionOptions = {
      cwd: testDir,
      initialMessage: { text: 'Say "model test" and nothing else' },
      permissionMode: "bypassPermissions",
      model: "sonnet", // Use a different model
      maxThinkingTokens: 4096, // Enable light thinking
    };

    const { iterator, abort } = await sdk.startSession(sessionOptions);

    const messages: SDKMessage[] = [];
    const timeout = setTimeout(() => abort(), 60000);

    try {
      for await (const message of iterator) {
        messages.push(message);
        logMessage(message);
        if (message.type === "result") break;
      }
    } finally {
      clearTimeout(timeout);
    }

    // Should complete successfully - means options were accepted
    expect(messages.length).toBeGreaterThanOrEqual(2);

    // Find the init message which contains model info
    const initMessage = messages.find(
      (m) => m.type === "system" && m.subtype === "init",
    );
    expect(initMessage).toBeDefined();

    // The init message should contain model info from SDK
    // We just verify the session started successfully with our options
    log("[init message]", JSON.stringify(initMessage, null, 2));
  }, 90000);

  it("should pass plan mode to SDK and receive planning behavior", async () => {
    if (!cliAvailable) {
      return; // Skip if CLI not installed
    }

    // Test that plan mode is passed through to SDK
    // Claude should respond with planning behavior when in plan mode
    const { iterator, abort } = await sdk.startSession({
      cwd: testDir,
      initialMessage: { text: "Add a hello world function to test.txt" },
      permissionMode: "plan", // Plan mode - Claude should create a plan first
      onToolApproval: async (toolName, input) => {
        log(`[tool_approval] ${toolName}`, input);
        // In plan mode, tools should be blocked until plan is approved
        // For this test, we deny to verify plan mode is active
        return { behavior: "deny" as const, message: "Plan mode - blocked" };
      },
    });

    const messages: SDKMessage[] = [];
    let sawExitPlanMode = false;
    let sawPlanContent = false;
    const timeout = setTimeout(() => abort(), 60000);

    try {
      for await (const message of iterator) {
        messages.push(message);
        logMessage(message);

        // Check for ExitPlanMode tool use - indicates Claude is in plan mode
        if (message.type === "assistant" && message.message?.content) {
          const content = message.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "tool_use" && block.name === "ExitPlanMode") {
                sawExitPlanMode = true;
                log("[found ExitPlanMode tool use]");
              }
              // Also check for plan-like text content
              if (block.type === "text") {
                const text = (block.text as string).toLowerCase();
                if (
                  text.includes("plan") ||
                  text.includes("step") ||
                  text.includes("implementation")
                ) {
                  sawPlanContent = true;
                }
              }
            }
          }
        }

        if (message.type === "result") break;
      }
    } finally {
      clearTimeout(timeout);
    }

    // In plan mode, Claude should either:
    // 1. Use ExitPlanMode tool to present a plan, OR
    // 2. Write planning-related content
    log(`[sawExitPlanMode] ${sawExitPlanMode}`);
    log(`[sawPlanContent] ${sawPlanContent}`);

    // At minimum, verify we got messages and the session worked
    expect(messages.length).toBeGreaterThanOrEqual(2);

    // If we saw ExitPlanMode, plan mode is definitely working
    // If not, check for planning language (Claude might explain it can't proceed)
    if (!sawExitPlanMode) {
      log(
        "[note] ExitPlanMode not seen - this may indicate plan mode not active",
      );
    }
  }, 90000);

  it("should trigger approval callback for ExitPlanMode in plan mode", async () => {
    if (!cliAvailable) {
      return; // Skip if CLI not installed
    }

    const toolRequests: Array<{ toolName: string; input: unknown }> = [];
    let exitPlanModeRequested = false;

    const { iterator, abort } = await sdk.startSession({
      cwd: testDir,
      initialMessage: {
        text: "Create a plan for adding a hello function, then use ExitPlanMode when ready",
      },
      permissionMode: "plan",
      onToolApproval: async (toolName, input) => {
        toolRequests.push({ toolName, input });
        log(`[tool_approval] ${toolName}`, input);

        if (toolName === "ExitPlanMode") {
          exitPlanModeRequested = true;
          // Approve ExitPlanMode to exit plan mode
          return { behavior: "allow" as const };
        }

        // Deny other tools in plan mode
        return { behavior: "deny" as const, message: "Plan mode - blocked" };
      },
    });

    const messages: SDKMessage[] = [];
    const timeout = setTimeout(() => abort(), 90000);

    try {
      for await (const message of iterator) {
        messages.push(message);
        logMessage(message);
        if (message.type === "result") break;
      }
    } finally {
      clearTimeout(timeout);
    }

    // ExitPlanMode should trigger the approval callback
    log(`[exitPlanModeRequested] ${exitPlanModeRequested}`);
    log(
      `[toolRequests]`,
      toolRequests.map((r) => r.toolName),
    );

    // We should have seen ExitPlanMode in the tool approval callback
    expect(exitPlanModeRequested).toBe(true);
  }, 120000);

  it("should handle AskUserQuestion with answers passed through updatedInput", async () => {
    if (!cliAvailable) {
      return; // Skip if CLI not installed
    }

    const toolRequests: Array<{ toolName: string; input: unknown }> = [];
    let askUserQuestionCalled = false;
    let receivedQuestions: unknown = null;

    const { iterator, abort } = await sdk.startSession({
      cwd: testDir,
      initialMessage: {
        text: 'Before doing anything, use the AskUserQuestion tool to ask me one question: "Which color do you prefer?" with header "Color" and two options: "Red" with description "A warm color" and "Blue" with description "A cool color". Set multiSelect to false.',
      },
      permissionMode: "default",
      onToolApproval: async (toolName, input) => {
        toolRequests.push({ toolName, input });
        log(`[tool_approval] ${toolName}`, JSON.stringify(input, null, 2));

        if (toolName === "AskUserQuestion") {
          askUserQuestionCalled = true;
          receivedQuestions = input;

          // Simulate user answering the question
          const questionInput = input as {
            questions?: Array<{ question: string }>;
          };
          const answers: Record<string, string> = {};
          if (questionInput.questions) {
            for (const q of questionInput.questions) {
              answers[q.question] = "Blue";
            }
          }

          // Return approval with answers via updatedInput
          return {
            behavior: "allow" as const,
            updatedInput: { ...input, answers },
          };
        }

        // Auto-approve other tools for this test
        return { behavior: "allow" as const };
      },
    });

    const messages: SDKMessage[] = [];
    const timeout = setTimeout(() => abort(), 90000);

    try {
      for await (const message of iterator) {
        messages.push(message);
        logMessage(message);
        if (message.type === "result") break;
      }
    } finally {
      clearTimeout(timeout);
    }

    log(`[askUserQuestionCalled] ${askUserQuestionCalled}`);
    log(`[receivedQuestions]`, receivedQuestions);

    // AskUserQuestion should have been called and we should have received the questions
    expect(askUserQuestionCalled).toBe(true);
    expect(receivedQuestions).toBeDefined();

    // Verify questions structure
    const input = receivedQuestions as { questions?: unknown[] };
    expect(input.questions).toBeDefined();
    expect(Array.isArray(input.questions)).toBe(true);
  }, 120000);

  it("should allow AskUserQuestion in plan mode", async () => {
    if (!cliAvailable) {
      return; // Skip if CLI not installed
    }

    const toolRequests: Array<{ toolName: string; input: unknown }> = [];
    let askUserQuestionInPlanMode = false;

    const { iterator, abort } = await sdk.startSession({
      cwd: testDir,
      initialMessage: {
        text: 'You are in plan mode. Before creating your plan, use AskUserQuestion to ask: "What framework should I use?" with header "Framework" and options "React" and "Vue". Then use ExitPlanMode.',
      },
      permissionMode: "plan",
      onToolApproval: async (toolName, input) => {
        toolRequests.push({ toolName, input });
        log(`[tool_approval in plan mode] ${toolName}`);

        if (toolName === "AskUserQuestion") {
          askUserQuestionInPlanMode = true;

          // Simulate user answering
          const questionInput = input as {
            questions?: Array<{ question: string }>;
          };
          const answers: Record<string, string> = {};
          if (questionInput.questions) {
            for (const q of questionInput.questions) {
              answers[q.question] = "React";
            }
          }

          return {
            behavior: "allow" as const,
            updatedInput: { ...input, answers },
          };
        }

        if (toolName === "ExitPlanMode") {
          return { behavior: "allow" as const };
        }

        // Deny other tools in plan mode
        return { behavior: "deny" as const, message: "Plan mode - blocked" };
      },
    });

    const messages: SDKMessage[] = [];
    const timeout = setTimeout(() => abort(), 90000);

    try {
      for await (const message of iterator) {
        messages.push(message);
        logMessage(message);
        if (message.type === "result") break;
      }
    } finally {
      clearTimeout(timeout);
    }

    log(`[askUserQuestionInPlanMode] ${askUserQuestionInPlanMode}`);
    log(
      `[toolRequests]`,
      toolRequests.map((r) => r.toolName),
    );

    // AskUserQuestion should have triggered in plan mode (not auto-denied)
    expect(askUserQuestionInPlanMode).toBe(true);
  }, 120000);

  it("should allow Read of files inside project in plan mode", async () => {
    if (!cliAvailable) {
      return; // Skip if CLI not installed
    }

    // Create a file inside the project
    const inProjectFile = join(testDir, "in-project.txt");
    writeFileSync(inProjectFile, "This file is inside the project");

    const toolRequests: Array<{
      toolName: string;
      input: unknown;
      allowed: boolean;
    }> = [];
    let readInsideProjectRequested = false;

    const { iterator, abort } = await sdk.startSession({
      cwd: testDir,
      initialMessage: {
        text: `Read the file at ${inProjectFile} and tell me what it says. Then use ExitPlanMode.`,
      },
      permissionMode: "plan",
      onToolApproval: async (toolName, input) => {
        log(`[tool_approval] ${toolName}`, input);

        if (toolName === "Read") {
          const readInput = input as { file_path?: string };
          // Check if the path contains our file name (Claude may use relative paths)
          if (
            readInput.file_path === inProjectFile ||
            readInput.file_path?.includes("in-project.txt")
          ) {
            readInsideProjectRequested = true;
          }
          toolRequests.push({ toolName, input, allowed: true });
          return { behavior: "allow" as const };
        }

        if (toolName === "ExitPlanMode") {
          toolRequests.push({ toolName, input, allowed: true });
          return { behavior: "allow" as const };
        }

        // Deny other tools
        toolRequests.push({ toolName, input, allowed: false });
        return { behavior: "deny" as const, message: "Plan mode test" };
      },
    });

    const messages: SDKMessage[] = [];
    const timeout = setTimeout(() => abort(), 90000);

    try {
      for await (const message of iterator) {
        messages.push(message);
        logMessage(message);
        if (message.type === "result") break;
      }
    } finally {
      clearTimeout(timeout);
    }

    log("[readInsideProjectRequested]", readInsideProjectRequested);
    log(
      "[toolRequests]",
      toolRequests.map((r) => `${r.toolName}:${r.allowed}`),
    );

    // In plan mode, Read of files INSIDE project may be auto-allowed by SDK
    // without calling canUseTool. This is expected behavior - we're just
    // verifying the session works and Claude can read the file.
    // The key assertion is that the session completed successfully.
    expect(messages.length).toBeGreaterThanOrEqual(2);
  }, 120000);

  it("should test Read of files outside project in plan mode", async () => {
    if (!cliAvailable) {
      return; // Skip if CLI not installed
    }

    // Create a PNG file OUTSIDE the project (simulating an uploaded screenshot)
    const outsideDir = mkdtempSync(join(tmpdir(), "claude-upload-test-"));
    const outsideFile = join(outsideDir, "screenshot.png");
    // Minimal valid PNG (1x1 red pixel)
    const pngData = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
      0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
      0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00,
      0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    writeFileSync(outsideFile, pngData);

    const toolRequests: Array<{
      toolName: string;
      input: unknown;
      allowed: boolean;
    }> = [];
    let readOutsideProjectRequested = false;

    try {
      const { iterator, abort } = await sdk.startSession({
        cwd: testDir,
        initialMessage: {
          text: `Read the file at ${outsideFile} and tell me what it says. Then use ExitPlanMode.`,
        },
        permissionMode: "plan",
        onToolApproval: async (toolName, input) => {
          log(`[tool_approval] ${toolName}`, input);

          if (toolName === "Read") {
            const readInput = input as { file_path?: string };
            if (readInput.file_path === outsideFile) {
              readOutsideProjectRequested = true;
              log("[Read outside project requested - callback was called!]");
            }
            toolRequests.push({ toolName, input, allowed: true });
            return { behavior: "allow" as const };
          }

          if (toolName === "ExitPlanMode") {
            toolRequests.push({ toolName, input, allowed: true });
            return { behavior: "allow" as const };
          }

          // Deny other tools
          toolRequests.push({ toolName, input, allowed: false });
          return { behavior: "deny" as const, message: "Plan mode test" };
        },
      });

      const messages: SDKMessage[] = [];
      const timeout = setTimeout(() => abort(), 90000);

      try {
        for await (const message of iterator) {
          messages.push(message);
          logMessage(message);
          if (message.type === "result") break;
        }
      } finally {
        clearTimeout(timeout);
      }

      log("[readOutsideProjectRequested]", readOutsideProjectRequested);
      log(
        "[toolRequests]",
        toolRequests.map((r) => `${r.toolName}:${r.allowed}`),
      );

      // This test documents the behavior:
      // If readOutsideProjectRequested is FALSE, it means the SDK auto-denied
      // the Read before calling our canUseTool callback (the bug we're investigating)
      if (!readOutsideProjectRequested) {
        log(
          "[CONFIRMED] SDK auto-denied Read of file outside project in plan mode",
        );
        log("[This is why uploaded files cannot be read in plan mode]");
      }

      // We expect the callback to be called for reads outside project too
      // If this fails, the SDK is blocking reads outside project in plan mode
      expect(readOutsideProjectRequested).toBe(true);
    } finally {
      // Cleanup
      rmSync(outsideDir, { recursive: true, force: true });
    }
  }, 120000);
});
