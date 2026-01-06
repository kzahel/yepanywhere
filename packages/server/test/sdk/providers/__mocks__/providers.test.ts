/**
 * Parameterized tests for mock providers.
 *
 * Tests run against all provider types (Claude, Codex, Gemini) to ensure
 * consistent behavior across implementations.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MOCK_PROVIDER_TYPES,
  type MockAgentProvider,
  type MockScenario,
  createMockProvider,
  createMultiTurnScenario,
  createStandardScenario,
  createToolUseScenario,
} from "../../../../src/sdk/providers/__mocks__/index.js";
import type { ProviderName } from "../../../../src/sdk/providers/types.js";
import type { SDKMessage } from "../../../../src/sdk/types.js";

/**
 * Collect all messages from an async iterator.
 */
async function collect(
  iterator: AsyncIterableIterator<SDKMessage>,
): Promise<SDKMessage[]> {
  const messages: SDKMessage[] = [];
  for await (const msg of iterator) {
    messages.push(msg);
    if (msg.type === "result" || msg.type === "error") break;
  }
  return messages;
}

describe.each(MOCK_PROVIDER_TYPES)("%s mock provider", (providerType) => {
  let provider: MockAgentProvider;

  beforeEach(() => {
    provider = createMockProvider(providerType);
  });

  afterEach(() => {
    provider.reset();
  });

  describe("basic properties", () => {
    it("has correct name", () => {
      expect(provider.name).toBe(providerType);
    });

    it("has a display name", () => {
      expect(typeof provider.displayName).toBe("string");
      expect(provider.displayName.length).toBeGreaterThan(0);
    });

    it("reports as installed by default", async () => {
      expect(await provider.isInstalled()).toBe(true);
    });

    it("reports as authenticated by default", async () => {
      expect(await provider.isAuthenticated()).toBe(true);
    });
  });

  describe("auth status", () => {
    it("returns complete auth status object", async () => {
      const status = await provider.getAuthStatus();

      expect(typeof status.installed).toBe("boolean");
      expect(typeof status.authenticated).toBe("boolean");
      expect(typeof status.enabled).toBe("boolean");
    });

    it("can be configured as not installed", async () => {
      const notInstalled = createMockProvider(providerType, {
        installed: false,
      });
      expect(await notInstalled.isInstalled()).toBe(false);
    });

    it("can be configured as not authenticated", async () => {
      const notAuth = createMockProvider(providerType, {
        authenticated: false,
      });
      expect(await notAuth.isAuthenticated()).toBe(false);
    });
  });

  describe("session streaming", () => {
    it("streams messages with no scenarios", async () => {
      const session = await provider.startSession({
        cwd: "/test",
        initialMessage: { text: "test" },
      });

      const messages = await collect(session.iterator);

      // Should have init, assistant, and result messages
      expect(messages.length).toBeGreaterThanOrEqual(3);
      expect(messages[0]?.type).toBe("system");
      expect(messages[0]?.subtype).toBe("init");
      expect(messages[messages.length - 1]?.type).toBe("result");
    });

    it("streams messages from a scenario", async () => {
      const scenario = createStandardScenario("test-session", "Hello!");
      provider.addScenario(scenario);

      const session = await provider.startSession({
        cwd: "/test",
        initialMessage: { text: "hi" },
      });

      const messages = await collect(session.iterator);

      expect(messages.length).toBe(3);
      expect(messages[0]?.session_id).toBe("test-session");
      expect(messages[1]?.type).toBe("assistant");
    });

    it("cycles through scenarios", async () => {
      provider.addScenario(createStandardScenario("session-1", "First"));
      provider.addScenario(createStandardScenario("session-2", "Second"));

      // First session
      const session1 = await provider.startSession({
        cwd: "/test",
        initialMessage: { text: "1" },
      });
      const msgs1 = await collect(session1.iterator);
      expect(msgs1[0]?.session_id).toBe("session-1");

      // Second session
      const session2 = await provider.startSession({
        cwd: "/test",
        initialMessage: { text: "2" },
      });
      const msgs2 = await collect(session2.iterator);
      expect(msgs2[0]?.session_id).toBe("session-2");

      // Third session - cycles back
      const session3 = await provider.startSession({
        cwd: "/test",
        initialMessage: { text: "3" },
      });
      const msgs3 = await collect(session3.iterator);
      expect(msgs3[0]?.session_id).toBe("session-1");
    });
  });

  describe("abort handling", () => {
    it("stops streaming when aborted", async () => {
      // Create a scenario with many messages
      const scenario: MockScenario = {
        messages: Array.from({ length: 20 }, (_, i) => ({
          type: "assistant",
          session_id: "abort-test",
          message: { role: "assistant", content: `Message ${i}` },
        })),
        delayMs: 50,
        sessionId: "abort-test",
      };
      provider.addScenario(scenario);

      const session = await provider.startSession({
        cwd: "/test",
        initialMessage: { text: "test" },
      });

      const messages: SDKMessage[] = [];
      const iterator = session.iterator;

      // Get a few messages then abort
      for await (const msg of iterator) {
        messages.push(msg);
        if (messages.length >= 3) {
          session.abort();
          break;
        }
      }

      expect(messages.length).toBeLessThan(20);
    });
  });

  describe("session interface", () => {
    it("returns queue and abort function", async () => {
      const session = await provider.startSession({
        cwd: "/test",
      });

      expect(session.queue).toBeDefined();
      expect(typeof session.abort).toBe("function");
      expect(session.iterator).toBeDefined();
    });

    it("tracks session count", async () => {
      expect(provider.sessionCount).toBe(0);

      await provider.startSession({ cwd: "/test" });
      expect(provider.sessionCount).toBe(1);

      await provider.startSession({ cwd: "/test" });
      expect(provider.sessionCount).toBe(2);
    });

    it("reset clears session count", async () => {
      await provider.startSession({ cwd: "/test" });
      expect(provider.sessionCount).toBe(1);

      provider.reset();
      expect(provider.sessionCount).toBe(0);
    });
  });

  describe("scenario management", () => {
    it("setScenarios replaces all scenarios", () => {
      provider.addScenario(createStandardScenario("1", "One"));
      provider.addScenario(createStandardScenario("2", "Two"));

      provider.setScenarios([createStandardScenario("new", "New")]);

      expect(provider.scenarioIndex).toBe(0);
    });

    it("reset clears all scenarios", async () => {
      provider.addScenario(createStandardScenario("1", "One"));
      provider.reset();

      const session = await provider.startSession({
        cwd: "/test",
        initialMessage: { text: "test" },
      });
      const messages = await collect(session.iterator);

      // Should get default response, not the scenario
      expect(messages[0]?.session_id).not.toBe("1");
    });
  });
});

describe("Cross-provider scenarios", () => {
  it.each(MOCK_PROVIDER_TYPES)(
    "%s handles tool use scenarios",
    async (providerType) => {
      const provider = createMockProvider(providerType);
      provider.addScenario(
        createToolUseScenario(
          "tool-session",
          "Read",
          { file_path: "/test.txt" },
          "file contents",
          "Done reading!",
        ),
      );

      const session = await provider.startSession({
        cwd: "/test",
        initialMessage: { text: "read file" },
      });

      const messages = await collect(session.iterator);

      // Should have: init, assistant (tool_use), user (tool_result), assistant (final), result
      expect(messages.length).toBe(5);

      // Find tool use message
      const toolUseMsg = messages.find(
        (m) =>
          m.type === "assistant" &&
          Array.isArray(m.message?.content) &&
          m.message.content.some((b: any) => b.type === "tool_use"),
      );
      expect(toolUseMsg).toBeDefined();
    },
  );

  it.each(MOCK_PROVIDER_TYPES)(
    "%s handles multi-turn scenarios",
    async (providerType) => {
      const provider = createMockProvider(providerType);
      provider.addScenario(
        createMultiTurnScenario("multi-turn", [
          { user: "Hello", assistant: "Hi there!" },
          { user: "How are you?", assistant: "I'm doing well!" },
        ]),
      );

      const session = await provider.startSession({
        cwd: "/test",
        initialMessage: { text: "start" },
      });

      const messages = await collect(session.iterator);

      // Should have: init, user, assistant, user, assistant, result
      expect(messages.length).toBe(6);

      const userMsgs = messages.filter((m) => m.type === "user");
      const assistantMsgs = messages.filter((m) => m.type === "assistant");
      expect(userMsgs.length).toBe(2);
      expect(assistantMsgs.length).toBe(2);
    },
  );

  it.each(MOCK_PROVIDER_TYPES)(
    "%s preserves session_id across messages",
    async (providerType) => {
      const provider = createMockProvider(providerType);
      provider.addScenario(
        createStandardScenario("persistent-session", "response"),
      );

      const session = await provider.startSession({
        cwd: "/test",
        initialMessage: { text: "test" },
      });

      const messages = await collect(session.iterator);

      // All messages should have the same session_id
      const sessionIds = new Set(messages.map((m) => m.session_id));
      expect(sessionIds.size).toBe(1);
      expect(sessionIds.has("persistent-session")).toBe(true);
    },
  );
});
