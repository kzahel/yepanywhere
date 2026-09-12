import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentContentProvider,
  useAgentContent,
} from "../../contexts/AgentContentContext";
import { SchemaValidationProvider } from "../../contexts/SchemaValidationContext";
import { SessionMetadataProvider } from "../../contexts/SessionMetadataContext";
import { ToastProvider } from "../../contexts/ToastContext";
import type { AgentContent, AgentContentMap } from "../../hooks/useSession";
import { I18nProvider } from "../../i18n";
import { compileTranscriptProjection } from "@yep-anywhere/shared/transcript/compiler";
import type { Message } from "../../types";
import { RenderItemComponent } from "../RenderItemComponent";

const apiMocks = vi.hoisted(() => ({
  getAgentSession: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: apiMocks,
}));

// Sample agent messages for testing
const sampleAgentMessages: Message[] = [
  {
    id: "msg-1",
    type: "assistant",
    role: "assistant",
    content: [{ type: "text", text: "Searching for tree files..." }],
  },
  {
    id: "msg-2",
    type: "assistant",
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "tool-1",
        name: "Grep",
        input: { pattern: "tree" },
      },
    ],
  },
  {
    id: "msg-3",
    type: "user",
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "tool-1",
        content: "Found 5 matches",
      },
    ],
  },
];

// Wrapper component with AgentContentProvider and SessionMetadataProvider
function TestWrapper({
  children,
  agentContent = {},
  toolUseToAgent = new Map(),
  mergeLoadedAgentContent = () => {},
}: {
  children: React.ReactNode;
  agentContent?: AgentContentMap;
  toolUseToAgent?: Map<string, string>;
  mergeLoadedAgentContent?: (agentId: string, content: AgentContent) => void;
}) {
  return (
    <I18nProvider>
      <MemoryRouter>
        <SessionMetadataProvider
          projectId="proj-1"
          projectPath="/test/project"
          sessionId="session-1"
        >
          <ToastProvider>
            <SchemaValidationProvider>
              <AgentContentProvider
                agentContent={agentContent}
                mergeLoadedAgentContent={mergeLoadedAgentContent}
                toolUseToAgent={toolUseToAgent}
                projectId="proj-1"
                sessionId="session-1"
              >
                {children}
              </AgentContentProvider>
            </SchemaValidationProvider>
          </ToastProvider>
        </SessionMetadataProvider>
      </MemoryRouter>
    </I18nProvider>
  );
}

function LoadAgentContentButton({ agentId }: { agentId: string }) {
  const context = useAgentContent();
  return (
    <button
      type="button"
      onClick={() => {
        void context.loadAgentContent("proj-1", "session-1", agentId);
      }}
    >
      Load agent
    </button>
  );
}

beforeEach(() => {
  apiMocks.getAgentSession.mockReset();
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
      }),
      clear: vi.fn(() => {
        store.clear();
      }),
    },
  });
});

describe("AgentContentProvider", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders children correctly", () => {
    render(
      <TestWrapper>
        <div data-testid="test-child">Hello</div>
      </TestWrapper>,
    );

    expect(screen.getByTestId("test-child")).toBeDefined();
  });

  it("provides agent content through context", () => {
    const agentContent: AgentContentMap = {
      "agent-abc123": {
        messages: sampleAgentMessages,
        status: "completed",
      },
    };

    render(
      <TestWrapper agentContent={agentContent}>
        <div>Test</div>
      </TestWrapper>,
    );

    // Provider renders without error
    expect(screen.getByText("Test")).toBeDefined();
  });

  it("provides empty content for unknown agent", () => {
    const agentContent: AgentContentMap = {};

    render(
      <TestWrapper agentContent={agentContent}>
        <div>Test</div>
      </TestWrapper>,
    );

    // Provider renders without error even with empty content
    expect(screen.getByText("Test")).toBeDefined();
  });

  it("routes lazy-loaded agent content through the merge wrapper", async () => {
    const loadedContent: AgentContent = {
      messages: sampleAgentMessages,
      status: "completed",
    };
    apiMocks.getAgentSession.mockResolvedValueOnce(loadedContent);
    const mergeLoadedAgentContent = vi.fn();

    render(
      <TestWrapper mergeLoadedAgentContent={mergeLoadedAgentContent}>
        <LoadAgentContentButton agentId="agent-abc123" />
      </TestWrapper>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Load agent" }));

    await waitFor(() =>
      expect(mergeLoadedAgentContent).toHaveBeenCalledWith(
        "agent-abc123",
        loadedContent,
      ),
    );
    expect(apiMocks.getAgentSession).toHaveBeenCalledWith(
      "proj-1",
      "session-1",
      "agent-abc123",
    );
  });
});

describe("AgentContent data structures", () => {
  it("tracks agent messages correctly", () => {
    const agentContent: AgentContentMap = {
      "agent-1": {
        messages: [
          { id: "m1", type: "assistant", content: "Hello" },
          { id: "m2", type: "assistant", content: "World" },
        ],
        status: "running",
      },
      "agent-2": {
        messages: [{ id: "m3", type: "assistant", content: "Done" }],
        status: "completed",
      },
    };

    expect(agentContent["agent-1"]?.messages.length).toBe(2);
    expect(agentContent["agent-2"]?.status).toBe("completed");
    expect(agentContent["agent-3"]).toBeUndefined();
  });

  it("supports different agent statuses", () => {
    const statuses = ["pending", "running", "completed", "failed"] as const;

    for (const status of statuses) {
      const content: AgentContentMap = {
        agent: { messages: [], status },
      };
      expect(content.agent?.status).toBe(status);
    }
  });
});

describe("Task rendering", () => {
  it("renders persisted Agent summaries when expanded without lazy-loaded subagent content", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Agent",
            input: {
              description: "Explore codebase for refactoring",
              prompt: "Find cleanup opportunities",
              subagent_type: "Explore",
            },
          },
        ],
      },
      {
        id: "msg-2",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: [
              {
                type: "text",
                text: "## Comprehensive Cleanup and Refactoring Opportunities Report",
              },
              {
                type: "text",
                text: "agentId: summary123\n<usage>total_tokens: 200\ntool_uses: 3\nduration_ms: 1000</usage>",
              },
            ],
          },
        ],
      },
    ];
    const [item] = compileTranscriptProjection(messages);

    expect(item?.type).toBe("tool_call");
    if (item?.type !== "tool_call") {
      throw new Error("Expected a tool_call render item");
    }
    const itemWithoutAgentLookup = {
      ...item,
      toolResult: item.toolResult
        ? {
            ...item.toolResult,
            structured:
              item.toolResult.structured &&
              typeof item.toolResult.structured === "object"
                ? {
                    ...(item.toolResult.structured as Record<string, unknown>),
                    agentId: undefined,
                  }
                : item.toolResult.structured,
          }
        : item.toolResult,
    };

    render(
      <TestWrapper>
        <RenderItemComponent
          item={itemWithoutAgentLookup}
          isStreaming={false}
          thinkingExpanded={false}
          toggleThinkingExpanded={() => {}}
        />
      </TestWrapper>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Explore codebase for refactoring/i }),
    );

    expect(
      screen.getByText(/Comprehensive Cleanup and Refactoring Opportunities/i),
    ).toBeDefined();
    expect(screen.queryByText(/agentId:\s*summary123/i)).toBeNull();
  });

  it("renders provider reasoning result blocks as toggleable thinking", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Agent",
            input: {
              description: "Explore codebase for refactoring",
              prompt: "Find cleanup opportunities",
              subagent_type: "Explore",
            },
          },
        ],
      },
      {
        id: "msg-2",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: [
              {
                type: "reasoning",
                summary: [
                  {
                    type: "summary_text",
                    text: "Checking the task result renderer",
                  },
                ],
              },
              {
                type: "text",
                text: "agentId: summary456\n<usage>total_tokens: 200\ntool_uses: 3\nduration_ms: 1000</usage>",
              },
            ],
          },
        ],
      },
    ];
    const [item] = compileTranscriptProjection(messages);

    expect(item?.type).toBe("tool_call");
    if (item?.type !== "tool_call") {
      throw new Error("Expected a tool_call render item");
    }
    const itemWithoutAgentLookup = {
      ...item,
      toolResult: item.toolResult
        ? {
            ...item.toolResult,
            structured:
              item.toolResult.structured &&
              typeof item.toolResult.structured === "object"
                ? {
                    ...(item.toolResult.structured as Record<string, unknown>),
                    agentId: undefined,
                  }
                : item.toolResult.structured,
          }
        : item.toolResult,
    };

    render(
      <TestWrapper>
        <RenderItemComponent
          item={itemWithoutAgentLookup}
          isStreaming={false}
          thinkingExpanded={false}
          toggleThinkingExpanded={() => {}}
        />
      </TestWrapper>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Explore codebase for refactoring/i }),
    );

    expect(screen.getByRole("button", { name: /Thinking/i })).toBeDefined();
    expect(document.querySelector(".fallback-block")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Thinking/i }));

    expect(screen.getByText("Checking the task result renderer")).toBeDefined();
  });
});

describe("Codex spawn_agent rendering", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders spawn_agent rows as expandable subagent transcripts", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-spawn-1",
            name: "spawn_agent",
            input: {
              role: "reviewer",
              prompt: "Inspect the implementation",
            },
          },
        ],
      },
      {
        id: "msg-2",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-spawn-1",
            content: JSON.stringify({
              agent_id: "child-thread",
              nickname: "Parfit",
            }),
          },
        ],
      },
    ];
    const [item] = compileTranscriptProjection(messages);

    expect(item?.type).toBe("tool_call");
    if (item?.type !== "tool_call") {
      throw new Error("Expected a tool_call render item");
    }

    render(
      <TestWrapper
        agentContent={{
          "child-thread": {
            messages: sampleAgentMessages,
            status: "completed",
          },
        }}
      >
        <RenderItemComponent
          item={item}
          isStreaming={false}
          thinkingExpanded={false}
          toggleThinkingExpanded={() => {}}
        />
      </TestWrapper>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Parfit/i }));

    expect(screen.getByText("Searching for tree files...")).toBeDefined();
  });

  it("keeps failed spawn_agent rows non-expandable with raw output", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-spawn-failed",
            name: "spawn_agent",
            input: {
              agent_type: "worker",
              message: "Demo subagent task",
            },
          },
        ],
      },
      {
        id: "msg-2",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-spawn-failed",
            content:
              "Full-history forked agents inherit the parent agent type, model, and reasoning effort.",
          },
        ],
      },
    ];
    const [item] = compileTranscriptProjection(messages);

    expect(item?.type).toBe("tool_call");
    if (item?.type !== "tool_call") {
      throw new Error("Expected a tool_call render item");
    }

    render(
      <TestWrapper>
        <RenderItemComponent
          item={item}
          isStreaming={false}
          thinkingExpanded={false}
          toggleThinkingExpanded={() => {}}
        />
      </TestWrapper>,
    );

    expect(screen.queryByRole("button", { name: /Demo subagent task/i })).toBe(
      null,
    );
    expect(
      screen.getByText(/Full-history forked agents inherit/i),
    ).toBeDefined();
    expect(screen.queryByText("No agent session found")).toBe(null);
  });
});
