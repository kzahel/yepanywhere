import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRememberedDisclosureStateRegistry,
  RememberedDisclosureStateProvider,
} from "../../../contexts/RememberedDisclosureStateContext";
import { displayProviders } from "../../renderers/tools/__fixtures__/displayProviders";
import { toolRegistry } from "../../renderers/tools";
import { ToolCallRow } from "../ToolCallRow";

afterEach(cleanup);
const hunk = {
  oldStart: 1,
  oldLines: 1,
  newStart: 1,
  newLines: 1,
  lines: ["-before", "+after"],
};
const question = {
  question: "Choose a mode?",
  header: "Mode",
  options: [{ label: "Simple", description: "Use defaults" }],
  multiSelect: false,
};
const acknowledgement = [{ type: "input_text", text: "Plan updated" }];
const shellOutput = [
  {
    type: "input_text",
    text: "Script completed\nWall time 0.1 seconds\nOutput:\n",
  },
  {
    type: "input_text",
    text: JSON.stringify({
      chunk_id: "test",
      wall_time_seconds: 0.1,
      exit_code: 2,
      output: "Readable shell output\n",
    }),
  },
  { type: "input_text", text: "Following output" },
];
function mount(
  props: Omit<ComponentProps<typeof ToolCallRow>, "id">,
  expanded = true,
) {
  const registry = createRememberedDisclosureStateRegistry();
  for (const key of [
    "tool-result",
    "inline-tool-result",
    "interactive-summary",
  ])
    registry.write("audit", key, false, expanded);
  return render(
    displayProviders(
      <RememberedDisclosureStateProvider registry={registry}>
        <ToolCallRow id="audit" {...props} />
      </RememberedDisclosureStateProvider>,
    ),
  );
}
function result(structured: unknown, isError = false) {
  return {
    content:
      typeof structured === "string" ? structured : JSON.stringify(structured),
    structured,
    isError,
  };
}
function expectRich(container: HTMLElement) {
  expect(container.querySelector('[data-tool-display="raw"]')).toBeNull();
}

describe("tactical 126 observed display regressions", () => {
  // Sanitized witnesses, independent of the registry's schema-generated matrix.
  it("retains input-side Codex hunks with an acknowledgement array", () => {
    const { container } = mount({
      toolName: "Edit",
      toolInput: {
        file_path: "/tmp/example.txt",
        _structuredPatch: [hunk],
        _rawPatch:
          "*** Begin Patch\n*** Update File: /tmp/example.txt\n@@\n-before\n+after\n*** End Patch",
        changes: [{ path: "/tmp/example.txt" }],
      },
      toolResult: result([
        {
          type: "input_text",
          text: "Success. Updated the following files:\nM /tmp/example.txt",
        },
      ]),
      status: "complete",
    });
    expectRich(container);
    expect(container.textContent).toContain("before");
    expect(container.textContent).toContain("after");
  });
  it("retains both sides of a Claude edit with no original-file snapshot", () => {
    const { container } = mount({
      toolName: "Edit",
      toolInput: {
        file_path: "/tmp/example.txt",
        old_string: "before",
        new_string: "after",
      },
      toolResult: result({
        filePath: "/tmp/example.txt",
        originalFile: null,
        oldString: "before",
        newString: "after",
        structuredPatch: [hunk],
      }),
      status: "complete",
    });
    expectRich(container);
    expect(container.textContent).toContain("before");
    expect(container.textContent).toContain("after");
  });
  it.each([false, true])(
    "decodes Shell blocks in order with rc metadata (isError=%s)",
    (isError) => {
      const { container } = mount({
        toolName: "WriteStdin",
        toolInput: { cell_id: "42" },
        toolResult: result(shellOutput, isError),
        status: isError ? "error" : "complete",
      });
      expectRich(container);
      expect(container.textContent).toContain("rc=2");
      const raw = screen.getByText("Raw execution").closest("details");
      expect(raw?.open).toBe(false);
      const visible = container.cloneNode(true) as HTMLElement;
      for (const details of visible.querySelectorAll("details:not([open])"))
        details.remove();
      expect(visible.textContent).toContain("Readable shell output");
      expect(visible.textContent).toContain("Following output");
      expect(visible.textContent).not.toContain("chunk_id");
      expect(
        visible.textContent?.indexOf("Readable shell output"),
      ).toBeLessThan(visible.textContent?.indexOf("Following output") ?? -1);
    },
  );
  it("keeps a ViewImage filename action when the result has text but no stored media", () => {
    const { container } = mount(
      {
        toolName: "ViewImage",
        toolInput: { path: "/tmp/example.png" },
        toolResult: result([
          { type: "input_text", text: "Image displayed" },
          {
            type: "input_image",
            image_url: "data:image/png;base64,cG5n",
            detail: "original",
          },
        ]),
        status: "complete",
      },
      false,
    );
    expectRich(container);
    expect(
      screen.getByRole("button", { name: /example.png.*image/ }),
    ).toBeTruthy();
  });
  it("identifies unchanged Read results without inventing an empty file", () => {
    const { container } = mount({
      toolName: "Read",
      toolInput: { file_path: "/tmp/example.txt" },
      toolResult: result({
        type: "file_unchanged",
        file: { filePath: "/tmp/example.txt" },
      }),
      status: "complete",
    });
    expectRich(container);
    expect(container.textContent).toContain("example.txt");
    expect(container.textContent).toContain("unchanged");
    expect(container.textContent).not.toContain("0 lines");
  });
  it("shows the selected answer when the echoed question omits multiSelect", () => {
    const { multiSelect: _, ...echo } = question;
    const { container } = mount({
      toolName: "AskUserQuestion",
      toolInput: { questions: [question] },
      toolResult: result({
        questions: [echo],
        answers: { [question.question]: "Simple" },
      }),
      status: "complete",
    });
    expectRich(container);
    expect(screen.getByRole("listitem").textContent).toContain("●Simple");
  });
  it("retains plan steps and completion count with acknowledgement blocks", () => {
    const { container } = mount({
      toolName: "UpdatePlan",
      toolInput: {
        plan: [
          { step: "Inspect", status: "completed" },
          { step: "Verify", status: "pending" },
        ],
      },
      toolResult: result(acknowledgement),
      status: "complete",
    });
    expectRich(container);
    expect(container.textContent).toContain("1 out of 2 tasks completed");
    expect(container.textContent).toContain("Inspect");
    expect(container.textContent).toContain("Verify");
  });
  it.each([false, true])(
    "shows a failed spawn and its rejection despite native isError=%s",
    (isError) => {
      const rejection =
        "Full-history forked agents inherit the parent agent type, model, and reasoning effort; omit agent_type, model, and reasoning_effort, or spawn without a full-history fork.";
      const { container } = mount({
        toolName: "spawn_agent",
        toolInput: { message: "Inspect a fixture", agent_type: "worker" },
        toolResult: result(rejection, isError),
        status: isError ? "error" : "complete",
      });
      expectRich(container);
      expect(screen.getByText("failed", { exact: true })).toBeTruthy();
      expect(container.textContent).toContain(rejection);
      expect(container.textContent).not.toContain("Completed");
      expect(container.querySelector("a")).toBeNull();
    },
  );
  it.each([
    ["Edit", { file_path: "/tmp/example.txt" }],
    ["ViewImage", { path: "/tmp/example.png" }],
    ["WriteStdin", { cell_id: "42" }],
    ["UpdatePlan", { plan: [{ step: "Inspect", status: "pending" }] }],
  ] as const)(
    "keeps malformed acknowledgement blocks contained for %s",
    (toolName, toolInput) => {
      const { container } = mount({
        toolName,
        toolInput,
        toolResult: result([{ type: "input_text", text: 42 }]),
        status: "complete",
      });
      expect(
        container.querySelector('[data-tool-display="raw"]'),
      ).not.toBeNull();
      expect(container.querySelector("details")?.open).toBe(false);
      expect(container.querySelector("pre")?.textContent).toContain(
        '"text": 42',
      );
    },
  );

  it("keeps unsupported data collapsed and exactly inspectable", () => {
    const original = { nested: { unknown: ["one", "two"] } };
    const { container } = mount({
      toolName: "Write",
      toolInput: { content: "missing path" },
      toolResult: result(original, true),
      status: "error",
    });
    const raw = container.querySelector('[data-tool-display="raw"]');
    const details = raw?.querySelector("details");
    expect(details?.open).toBe(false);
    expect(raw?.querySelector('[data-status="error"]')?.textContent).toBe(
      "Failed",
    );
    fireEvent.click(
      screen.getByText("View original tool data (preview unavailable)"),
    );
    expect(details?.open).toBe(true);
    expect(raw?.querySelector("pre")?.textContent).toBe(
      JSON.stringify(original, null, 2),
    );
    expect(raw?.textContent).toContain("missing path");
  });
});

describe("supported-input controls (no native witness)", () => {
  it.each(["command", "cmd"])("retains Shell cellId and %s aliases", (key) => {
    const prepared = toolRegistry.prepare("WriteStdin", {
      input: { cellId: "cell-42", [key]: "echo audit" },
      status: "pending",
    });
    const { container } = render(
      displayProviders(
        prepared.renderToolUse({ isStreaming: false, theme: "dark" }),
      ),
    );
    expect(container.textContent).toContain("echo audit");
    expect(container.textContent).toContain("script cell cell-42");
  });
  it("retains a pending goal's camelCase token budget", () => {
    const { container } = mount({
      toolName: "create_goal",
      toolInput: { objective: "Verify fixture", tokenBudget: 1000 },
      status: "pending",
    });
    expectRich(container);
    expect(container.textContent).toContain("1,000");
  });
});
