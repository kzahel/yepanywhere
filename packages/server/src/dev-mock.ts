import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { MockClaudeSDK, createMockScenario } from "./sdk/mock.js";
import { setupMockProjects } from "./testing/mockProjectData.js";

// Ensure mock data exists
setupMockProjects();

// Create mock SDK with canned scenarios
// Use longer delays to give the client time to connect to SSE before messages are emitted
const mockSdk = new MockClaudeSDK([
  // Session 1
  {
    messages: [
      { type: "system", subtype: "init", session_id: "test-session-001" },
      {
        type: "assistant",
        message: {
          content: "Hello! I received your message. How can I help you today?",
          role: "assistant",
        },
      },
      { type: "result", session_id: "test-session-001" },
    ],
    delayMs: 200, // Enough time for client to connect to SSE
  },
  // Session 2
  {
    messages: [
      { type: "system", subtype: "init", session_id: "test-session-002" },
      {
        type: "assistant",
        message: {
          content: "I understand. Let me help you with that.",
          role: "assistant",
        },
      },
      { type: "result", session_id: "test-session-002" },
    ],
    delayMs: 200,
  },
  // Session 3
  {
    messages: [
      { type: "system", subtype: "init", session_id: "test-session-003" },
      {
        type: "assistant",
        message: {
          content: "Got it. Here's what I can do.",
          role: "assistant",
        },
      },
      { type: "result", session_id: "test-session-003" },
    ],
    delayMs: 200,
  },
  // Session 4
  {
    messages: [
      { type: "system", subtype: "init", session_id: "test-session-004" },
      {
        type: "assistant",
        message: { content: "Processing your request.", role: "assistant" },
      },
      { type: "result", session_id: "test-session-004" },
    ],
    delayMs: 200,
  },
  // Session 5
  {
    messages: [
      { type: "system", subtype: "init", session_id: "test-session-005" },
      {
        type: "assistant",
        message: { content: "Here you go!", role: "assistant" },
      },
      { type: "result", session_id: "test-session-005" },
    ],
    delayMs: 200,
  },
]);

// Create app with mock SDK
const app = createApp({
  sdk: mockSdk,
  idleTimeoutMs: 60000, // 1 minute for testing
});

serve({ fetch: app.fetch, port: 3400 }, () => {
  console.log("Mock server running at http://localhost:3400");
  console.log("Using MockClaudeSDK with canned responses");
});
