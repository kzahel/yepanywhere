import { describe, expect, it } from "vitest";
import type { AgentContentMap } from "../../hooks/useSession";
import type { Message } from "../../types";
import {
  addMessageToAgentContent,
  extractAgentId,
  groupMessagesByAgentId,
  isSubagentMessage,
  updateAgentStatus,
} from "../subagentRouting";

describe("isSubagentMessage", () => {
  it("returns true for messages with isSubagent: true and session_id", () => {
    const msg = { isSubagent: true, session_id: "agent-abc123" };
    expect(isSubagentMessage(msg)).toBe(true);
  });

  it("returns false when isSubagent is false", () => {
    const msg = { isSubagent: false, session_id: "agent-abc123" };
    expect(isSubagentMessage(msg)).toBe(false);
  });

  it("returns false when isSubagent is missing", () => {
    const msg = { session_id: "agent-abc123" };
    expect(isSubagentMessage(msg)).toBe(false);
  });

  it("returns false when session_id is missing", () => {
    const msg = { isSubagent: true };
    expect(isSubagentMessage(msg)).toBe(false);
  });

  it("returns false for main session messages", () => {
    const msg = { isSubagent: false, session_id: "main-session-id" };
    expect(isSubagentMessage(msg)).toBe(false);
  });
});

describe("extractAgentId", () => {
  it("extracts session_id as agentId", () => {
    const msg = { session_id: "agent-abc123" };
    expect(extractAgentId(msg)).toBe("agent-abc123");
  });

  it("returns null when session_id is missing", () => {
    const msg = {};
    expect(extractAgentId(msg)).toBeNull();
  });

  it("returns null when session_id is not a string", () => {
    const msg = { session_id: 123 as unknown as string };
    expect(extractAgentId(msg)).toBeNull();
  });
});

describe("addMessageToAgentContent", () => {
  it("adds message to empty agent content", () => {
    const agentContent: AgentContentMap = {};
    const message: Message = {
      id: "msg-1",
      type: "assistant",
      content: "hello",
    };

    const result = addMessageToAgentContent(agentContent, "agent-a", message);
    const agentA = result["agent-a"];

    expect(agentA).toBeDefined();
    expect(agentA?.messages).toHaveLength(1);
    expect(agentA?.messages[0]?.id).toBe("msg-1");
    expect(agentA?.status).toBe("running");
  });

  it("appends message to existing agent", () => {
    const agentContent: AgentContentMap = {
      "agent-a": {
        messages: [{ id: "msg-1", type: "assistant" }],
        status: "running",
      },
    };
    const message: Message = {
      id: "msg-2",
      type: "assistant",
      content: "world",
    };

    const result = addMessageToAgentContent(agentContent, "agent-a", message);
    const agentA = result["agent-a"];

    expect(agentA?.messages).toHaveLength(2);
    expect(agentA?.messages[1]?.id).toBe("msg-2");
  });

  it("deduplicates by message ID", () => {
    const agentContent: AgentContentMap = {
      "agent-a": {
        messages: [{ id: "msg-1", type: "assistant" }],
        status: "running",
      },
    };
    const message: Message = {
      id: "msg-1",
      type: "assistant",
      content: "duplicate",
    };

    const result = addMessageToAgentContent(agentContent, "agent-a", message);

    expect(result["agent-a"]?.messages).toHaveLength(1);
    // Should return same reference when no change
    expect(result).toBe(agentContent);
  });

  it("preserves other agents when adding to one", () => {
    const agentContent: AgentContentMap = {
      "agent-a": {
        messages: [{ id: "msg-1", type: "assistant" }],
        status: "running",
      },
      "agent-b": {
        messages: [{ id: "msg-2", type: "assistant" }],
        status: "completed",
      },
    };
    const message: Message = { id: "msg-3", type: "assistant" };

    const result = addMessageToAgentContent(agentContent, "agent-a", message);

    expect(result["agent-a"]?.messages).toHaveLength(2);
    expect(result["agent-b"]?.messages).toHaveLength(1);
    expect(result["agent-b"]?.status).toBe("completed");
  });

  it("is immutable - does not modify original", () => {
    const agentContent: AgentContentMap = {
      "agent-a": {
        messages: [{ id: "msg-1", type: "assistant" }],
        status: "running",
      },
    };
    const message: Message = { id: "msg-2", type: "assistant" };

    const result = addMessageToAgentContent(agentContent, "agent-a", message);

    expect(agentContent["agent-a"]?.messages).toHaveLength(1);
    expect(result["agent-a"]?.messages).toHaveLength(2);
    expect(result).not.toBe(agentContent);
  });
});

describe("groupMessagesByAgentId", () => {
  it("groups messages by session_id", () => {
    const messages = [
      { id: "1", type: "assistant" as const, session_id: "agent-a" },
      { id: "2", type: "assistant" as const, session_id: "agent-b" },
      { id: "3", type: "assistant" as const, session_id: "agent-a" },
    ];

    const result = groupMessagesByAgentId(messages);

    expect(Object.keys(result)).toHaveLength(2);
    expect(result["agent-a"]?.messages).toHaveLength(2);
    expect(result["agent-b"]?.messages).toHaveLength(1);
  });

  it("skips messages without session_id", () => {
    const messages = [
      { id: "1", type: "assistant" as const, session_id: "agent-a" },
      { id: "2", type: "assistant" as const }, // No session_id
      { id: "3", type: "assistant" as const, session_id: "agent-a" },
    ];

    const result = groupMessagesByAgentId(messages);

    expect(Object.keys(result)).toHaveLength(1);
    expect(result["agent-a"]?.messages).toHaveLength(2);
  });

  it("returns empty object for empty input", () => {
    const result = groupMessagesByAgentId([]);
    expect(result).toEqual({});
  });

  it("sets status to running for all groups", () => {
    const messages = [
      { id: "1", type: "assistant" as const, session_id: "agent-a" },
      { id: "2", type: "assistant" as const, session_id: "agent-b" },
    ];

    const result = groupMessagesByAgentId(messages);

    expect(result["agent-a"]?.status).toBe("running");
    expect(result["agent-b"]?.status).toBe("running");
  });
});

describe("updateAgentStatus", () => {
  it("updates status for existing agent", () => {
    const agentContent: AgentContentMap = {
      "agent-a": {
        messages: [{ id: "msg-1", type: "assistant" }],
        status: "running",
      },
    };

    const result = updateAgentStatus(agentContent, "agent-a", "completed");

    expect(result["agent-a"]?.status).toBe("completed");
    expect(result["agent-a"]?.messages).toHaveLength(1);
  });

  it("returns same object if agent not found", () => {
    const agentContent: AgentContentMap = {
      "agent-a": {
        messages: [{ id: "msg-1", type: "assistant" }],
        status: "running",
      },
    };

    const result = updateAgentStatus(agentContent, "agent-b", "completed");

    expect(result).toBe(agentContent);
  });

  it("preserves other agents when updating one", () => {
    const agentContent: AgentContentMap = {
      "agent-a": { messages: [], status: "running" },
      "agent-b": { messages: [], status: "running" },
    };

    const result = updateAgentStatus(agentContent, "agent-a", "failed");

    expect(result["agent-a"]?.status).toBe("failed");
    expect(result["agent-b"]?.status).toBe("running");
  });

  it("is immutable - does not modify original", () => {
    const agentContent: AgentContentMap = {
      "agent-a": { messages: [], status: "running" },
    };

    const result = updateAgentStatus(agentContent, "agent-a", "completed");

    expect(agentContent["agent-a"]?.status).toBe("running");
    expect(result["agent-a"]?.status).toBe("completed");
  });
});
