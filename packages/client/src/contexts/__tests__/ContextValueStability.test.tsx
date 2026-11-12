import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { memo, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentContentProvider, useAgentContent } from "../AgentContentContext";
import {
  SessionMetadataProvider,
  useOptionalSessionMetadata,
} from "../SessionMetadataContext";
import {
  SchemaValidationProvider,
  useSchemaValidationContext,
} from "../SchemaValidationContext";
import { ToastProvider, useToastContext } from "../ToastContext";

const EMPTY_AGENT_CONTENT = {};
const EMPTY_TOOL_USE_TO_AGENT = new Map<string, string>();
const mergeLoadedAgentContent = () => {};

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("context value stability", () => {
  it("does not notify toast consumers when only the toast list changes", () => {
    let renderCount = 0;
    const ToastConsumer = memo(function ToastConsumer() {
      renderCount += 1;
      const { showToast } = useToastContext();
      return (
        <button type="button" onClick={() => showToast("Saved")}>
          Show toast
        </button>
      );
    });

    render(
      <ToastProvider>
        <ToastConsumer />
      </ToastProvider>,
    );
    const settledRenderCount = renderCount;

    fireEvent.click(screen.getByRole("button", { name: "Show toast" }));

    expect(screen.getByText("Saved")).toBeDefined();
    expect(renderCount).toBe(settledRenderCount);
  });

  it("does not notify schema consumers on an unchanged parent render", () => {
    let renderCount = 0;
    const SchemaConsumer = memo(function SchemaConsumer() {
      renderCount += 1;
      const { enabled } = useSchemaValidationContext();
      return <span>{enabled ? "enabled" : "disabled"}</span>;
    });

    function SchemaHarness() {
      const [, setTick] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setTick((tick) => tick + 1)}>
            Parent render
          </button>
          <SchemaValidationProvider>
            <SchemaConsumer />
          </SchemaValidationProvider>
        </>
      );
    }

    render(
      <ToastProvider>
        <SchemaHarness />
      </ToastProvider>,
    );
    const settledRenderCount = renderCount;

    fireEvent.click(screen.getByRole("button", { name: "Parent render" }));

    expect(renderCount).toBe(settledRenderCount);
  });

  it("keeps the existing agent-content context guard in place", () => {
    let renderCount = 0;
    const AgentContentConsumer = memo(function AgentContentConsumer() {
      renderCount += 1;
      useAgentContent();
      return <span>agent content</span>;
    });

    function AgentContentHarness() {
      const [, setTick] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setTick((tick) => tick + 1)}>
            Parent render
          </button>
          <AgentContentProvider
            agentContent={EMPTY_AGENT_CONTENT}
            mergeLoadedAgentContent={mergeLoadedAgentContent}
            toolUseToAgent={EMPTY_TOOL_USE_TO_AGENT}
            projectId="proj-1"
            sessionId="session-1"
          >
            <AgentContentConsumer />
          </AgentContentProvider>
        </>
      );
    }

    render(<AgentContentHarness />);
    const settledRenderCount = renderCount;

    fireEvent.click(screen.getByRole("button", { name: "Parent render" }));

    expect(renderCount).toBe(settledRenderCount);
  });

  it("does not notify session-metadata consumers when a session update rebuilds thinking or renames the session", () => {
    // Every transcript text block consumes this context; a new value on each
    // session update re-rendered the whole transcript under typing.
    let renderCount = 0;
    const TranscriptRow = memo(function TranscriptRow() {
      renderCount += 1;
      return <span>{useOptionalSessionMetadata()?.projectId}</span>;
    });

    function SessionHarness() {
      const [title, setTitle] = useState("First title");
      return (
        <>
          <button type="button" onClick={() => setTitle(`${title}!`)}>
            Rename
          </button>
          <span>{title}</span>
          <SessionMetadataProvider
            projectId="proj-1"
            projectPath="/repo"
            sessionId="session-1"
            provider="codex"
            thinking={{ type: "adaptive", display: "summarized" }}
            effort="high"
          >
            <TranscriptRow />
          </SessionMetadataProvider>
        </>
      );
    }

    render(<SessionHarness />);
    const settledRenderCount = renderCount;

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    expect(screen.getByText("First title!!")).toBeDefined();
    expect(renderCount).toBe(settledRenderCount);
  });
});
