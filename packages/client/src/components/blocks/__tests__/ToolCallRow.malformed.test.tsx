import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRememberedDisclosureStateRegistry,
  RememberedDisclosureStateProvider,
} from "../../../contexts/RememberedDisclosureStateContext";
import { SchemaValidationProvider } from "../../../contexts/SchemaValidationContext";
import { SessionMetadataProvider } from "../../../contexts/SessionMetadataContext";
import { ToastProvider } from "../../../contexts/ToastContext";
import { I18nProvider } from "../../../i18n";
import { validateToolResult } from "../../../lib/validateToolResult";
import { toolRegistry } from "../../renderers/tools";
import { registry as contentRegistry } from "../../renderers";
import { ToolCallRow } from "../ToolCallRow";
import { ToolDisplayBoundary } from "../ToolDisplayBoundary";

type RowProps = ComponentProps<typeof ToolCallRow>;
const question = {
  question: "Q?",
  header: "Q",
  options: [{ label: "A", description: "A" }],
  multiSelect: false,
};
const readInput = { file_path: "/tmp/a" };
const editInput = { ...readInput, old_string: "a", new_string: "b" };
const file = {
  filePath: "/tmp/a",
  content: "hello",
  numLines: 1,
  startLine: 1,
  totalLines: 1,
};
const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 };

function providers(node: ReactNode, expanded = false) {
  const registry = createRememberedDisclosureStateRegistry();
  for (const key of [
    "tool-result",
    "inline-tool-result",
    "interactive-summary",
  ]) {
    registry.write("malformed", key, false, expanded);
  }
  return (
    <RememberedDisclosureStateProvider registry={registry}>
      <MemoryRouter>
        <I18nProvider>
          <ToastProvider>
            <SchemaValidationProvider>
              <SessionMetadataProvider
                projectId="L3RtcA"
                projectPath="/tmp"
                sessionId="test"
                provider="claude"
              >
                {node}
              </SessionMetadataProvider>
            </SchemaValidationProvider>
          </ToastProvider>
        </I18nProvider>
      </MemoryRouter>
    </RememberedDisclosureStateProvider>
  );
}

function row(props: Omit<RowProps, "id">) {
  return <ToolCallRow id="malformed" {...props} />;
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("tool display boundary", () => {
  it("keeps a failed Shell poll readable with its actual exit status", () => {
    // Sanitized from the failed push shown in the same incident session.
    const output = "Push rejected: remote contains newer commits.\n";
    const { container } = render(
      providers(
        row({
          toolName: "WriteStdin",
          toolInput: { session_id: 42, chars: "" },
          toolResult: {
            content: output,
            structured: {
              chunk_id: "failure",
              wall_time_seconds: 0.1,
              exit_code: 1,
              output,
              stdout: output,
            },
            isError: true,
          },
          status: "error",
        }),
        true,
      ),
    );
    expect(container.querySelector('[data-tool-display="raw"]')).toBeNull();
    expect(
      container.querySelector('[data-tool-status="error"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("rc=1");
    expect(container.textContent).toContain(output.trim());
    expect(container.textContent).not.toContain("chunk_id");
  });

  // This input/error pair is reduced from the unmodified live SDK and child
  // JSONL reproduction of #124. Invalid tool arguments are valid records.
  const rejectedWrite = {
    content:
      "InputValidationError: Write failed: The required parameter `file_path` is missing",
    isError: true,
  };
  it.each([false, true])(
    "keeps the live rejected Write inspectable (expanded=%s)",
    (expanded) => {
      const html = renderToStaticMarkup(
        providers(
          <>
            {row({
              toolName: "Write",
              toolInput: { content: "validation-test" },
              toolResult: rejectedWrite,
              status: "error",
            })}
            <p>Following assistant message</p>
          </>,
          expanded,
        ),
      );
      expect(html).toContain('data-tool-display="raw"');
      expect(html).toContain("file_path");
      expect(html).toContain("validation-test");
      expect(html).toContain("Following assistant message");
      expect(html).toContain("Failed");
    },
  );

  it.each(["pending", "incomplete", "aborted", "error", "complete"] as const)(
    "tolerates missing Write content with status %s",
    (status) => {
      const html = renderToStaticMarkup(
        providers(
          row({ toolName: "Write", toolInput: readInput, status }),
          true,
        ),
      );
      expect(html).toContain('data-tool-display="raw"');
      expect(html).toContain("/tmp/a");
    },
  );

  const partialResults = [
    {
      toolName: "Read",
      input: readInput,
      result: {
        type: "text",
        file: { content: "hello", numLines: 1, startLine: 1, totalLines: 1 },
      },
    },
    {
      toolName: "Edit",
      input: editInput,
      result: {
        filePath: "/tmp/a",
        oldString: "a",
        newString: "b",
        originalFile: "a",
        structuredPatch: [hunk],
      },
    },
    {
      toolName: "AskUserQuestion",
      input: { questions: [question] },
      result: { questions: [{ question: "Q?", header: "Q" }], answers: {} },
    },
  ];
  it.each(partialResults)(
    "preserves schema-valid partial $toolName results without rich rendering",
    ({ toolName, input, result }) => {
      expect(validateToolResult(toolName, result).valid).toBe(true);
      for (const expanded of [false, true]) {
        const html = renderToStaticMarkup(
          providers(
            row({
              toolName,
              toolInput: input,
              toolResult: { content: "", structured: result, isError: false },
              status: "complete",
            }),
            expanded,
          ),
        );
        expect(html).toContain('data-tool-display="raw"');
        expect(html).toContain("Completed");
      }
    },
  );

  it.each([
    { toolName: "Read", input: readInput, result: { type: "text", file } },
    {
      toolName: "Read",
      input: readInput,
      result: { type: "text", file: { filePath: "/tmp/a" } },
    },
    {
      toolName: "Write",
      input: { ...readInput, content: "hello" },
      result: { type: "text", file },
    },
    {
      toolName: "Edit",
      input: editInput,
      result: {
        filePath: "/tmp/a",
        oldString: "a",
        newString: "b",
        originalFile: "a",
        structuredPatch: [{ ...hunk, lines: ["-a", "+b"] }],
      },
    },
    {
      toolName: "AskUserQuestion",
      input: { questions: [question] },
      result: { questions: [question], answers: { "Q?": "A" } },
    },
  ])(
    "preserves supported rich $toolName results",
    ({ toolName, input, result }) => {
      for (const expanded of [false, true]) {
        const html = renderToStaticMarkup(
          providers(
            row({
              toolName,
              toolInput: input,
              toolResult: { content: "", structured: result, isError: false },
              status: "complete",
            }),
            expanded,
          ),
        );
        expect(html).not.toContain('data-tool-display="raw"');
      }
    },
  );

  it.each([
    { toolName: "view_image", input: {} },
    { toolName: "Read", input: { file_path: {} } },
    { toolName: "Agent", input: { prompt: {} } },
    { toolName: "spawn_agent", input: { message: {} } },
    {
      toolName: "AskUserQuestion",
      input: { questions: [{ ...question, options: {} }] },
    },
  ])(
    "handles invalid $toolName arguments before invoking React",
    ({ toolName, input }) => {
      const html = renderToStaticMarkup(
        providers(
          row({ toolName, toolInput: input, status: "incomplete" }),
          true,
        ),
      );
      expect(html).toContain('data-tool-display="raw"');
    },
  );

  it("validates standalone registry rendering as well as combined rows", () => {
    const html = renderToStaticMarkup(
      providers(
        toolRegistry.renderToolUse(
          "Write",
          {},
          { isStreaming: false, theme: "dark" },
        ),
      ),
    );
    expect(html).toContain("{}");
  });

  it("keeps standalone summaries safe for malformed tool arguments", () => {
    expect(
      contentRegistry.getRenderer({ type: "tool_use" }).getSummary?.({
        type: "tool_use",
        id: "missing-path",
        name: "Write",
        input: { content: "validation-test" },
      }),
    ).toBe("Write");
  });

  it("keeps standalone result rendering available without the original input", () => {
    const html = renderToStaticMarkup(
      providers(
        toolRegistry.renderToolResult("Read", { type: "text", file }, false, {
          isStreaming: false,
          theme: "dark",
        }),
      ),
    );
    expect(html).not.toContain("tool-fallback");
    expect(html).toContain("hello");
  });

  it("contains an unexpected renderer exception and retries when the record changes", () => {
    const error = new Error("unexpected renderer failure");
    const onCaughtError = vi.fn();
    function BrokenRenderer(): ReactNode {
      throw error;
    }
    const record = {
      id: "broken",
      toolName: "FutureTool",
      toolInput: {},
      status: "pending" as const,
    };
    const view = (child: ReactNode, input = record.toolInput) => (
      <I18nProvider>
        <ToolDisplayBoundary {...record} toolInput={input}>
          {child}
        </ToolDisplayBoundary>
        <p>Unaffected next row</p>
      </I18nProvider>
    );
    // React's supported caught-error observer asserts this intentional failure
    // without emitting an expected stack as a test-run runtime warning.
    const { rerender } = render(view(<BrokenRenderer />), { onCaughtError });
    expect(onCaughtError).toHaveBeenCalledWith(error, expect.anything());
    expect(screen.getByText("Unaffected next row")).toBeTruthy();
    expect(screen.getByText(error.message)).toBeTruthy();
    rerender(view(<p>Still the same record</p>));
    expect(screen.queryByText("Still the same record")).toBeNull();
    rerender(
      view(<p>Recovered tool preview</p>, { message: "complete arguments" }),
    );
    expect(screen.getByText("Recovered tool preview")).toBeTruthy();
    expect(screen.queryByText(error.message)).toBeNull();
  });
});
