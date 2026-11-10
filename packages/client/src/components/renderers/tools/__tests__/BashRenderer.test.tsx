import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { SessionMetadataProvider } from "../../../../contexts/SessionMetadataContext";
import { I18nProvider } from "../../../../i18n";
import { UI_KEYS } from "../../../../lib/storageKeys";
import { bashRenderer } from "../BashRenderer";
import { recordFromLegacyArgs } from "../prepareDisplay";
import type { BashResult } from "../types";

vi.mock("../../../../contexts/SchemaValidationContext", () => ({
  useSchemaValidationContext: () => ({
    enabled: false,
    reportValidationError: vi.fn(),
    isToolIgnored: vi.fn(() => false),
  }),
}));

vi.mock("../../../ui/Modal", () => ({
  Modal: ({
    title,
    children,
  }: {
    title: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <div>
      <div>{title}</div>
      <div>{children}</div>
    </div>
  ),
}));

const renderContext = {
  isStreaming: false,
  provider: "codex",
  theme: "dark" as const,
};

describe("BashRenderer", () => {
  beforeEach(() => {
    window.localStorage.setItem(UI_KEYS.tooltipMode, "themed");
  });

  afterEach(() => {
    cleanup();
    window.localStorage.removeItem(UI_KEYS.tooltipMode);
  });

  it("unwraps exec_command envelopes before rendering ANSI output", () => {
    const output = `Chunk ID: ff710e
Wall time: 0.0518 seconds
Process exited with code 0
Output:
plain
[32mgreen bold[0m
`;

    const { container } = render(
      <MemoryRouter>
        <I18nProvider>
          {bashRenderer
            .prepare(
              recordFromLegacyArgs(
                { command: "printf '...'" },
                output as unknown as BashResult,
                false,
              ),
            )
            .renderCollapsedPreview(renderContext)}
        </I18nProvider>
      </MemoryRouter>,
    );

    expect(container.textContent).not.toContain("Chunk ID:");
    expect(screen.getByText(/plain/)).toBeDefined();

    expect(screen.queryByRole("button", { name: "Copy command" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy output" })).toBeDefined();

    fireEvent.click(
      screen.getByRole("button", { name: "View bash command output" }),
    );

    expect(container.textContent).not.toContain("Chunk ID:");
    expect(container.querySelector(".ansi-fg-green")).not.toBeNull();
    expect(
      screen.getAllByRole("button", { name: "Copy command" }),
    ).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Copy output" }).length).toBe(
      2,
    );
  });

  it("shows a compact count of output lines omitted from a collapsed preview", () => {
    const output = ["one", "two", "three", "four"].join("\n");

    render(
      <div>
        {bashRenderer
          .prepare(
            recordFromLegacyArgs(
              { command: "printf lines" },
              {
                stdout: output,
                stderr: "",
                interrupted: false,
                isImage: false,
              } as BashResult,
              false,
            ),
          )
          .renderCollapsedPreview(renderContext)}
      </div>,
    );

    const badge = screen.getByText("+2");
    const copyButton = screen.getByRole("button", { name: "Copy output" });
    expect(copyButton.nextElementSibling).toBe(badge);
    expect(badge.getAttribute("data-tooltip")).toBe("...\nthree\nfour");
    expect(badge.getAttribute("title")).toBeNull();
  });

  it("uses red only when the collapsed preview is showing stderr", () => {
    const { container } = render(
      <div>
        {bashRenderer
          .prepare(
            recordFromLegacyArgs(
              { command: "writes both channels" },
              {
                stdout: "ordinary stdout",
                stderr: "authenticated stderr",
                interrupted: false,
                isImage: false,
                exitCode: 1,
              } as BashResult,
              true,
            ),
          )
          .renderCollapsedPreview(renderContext)}
      </div>,
    );

    expect(screen.getByText("authenticated stderr")).toBeDefined();
    expect(screen.queryByText("ordinary stdout")).toBeNull();
    expect(container.querySelector("[data-bash-preview-error]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Copy stderr" })).toBeDefined();
  });

  it("renders ANSI-colored git diff markdown tables in expanded output", () => {
    const output = [
      "\u001b[1mdiff --git a/notes.md b/notes.md\u001b[0m",
      "@@ -1,4 +1,4 @@",
      " | name | value |",
      " | --- | --- |",
      "\u001b[1;31m-\u001b[m\u001b[1;31m| old | $x^2$ |\u001b[m",
      "\u001b[1;32m+\u001b[m\u001b[1;32m| new | $y^2$ |\u001b[m",
    ].join("\n");

    const { container } = render(
      <div>
        {bashRenderer
          .prepare(
            recordFromLegacyArgs(
              undefined,
              {
                stdout: output,
                stderr: "",
                interrupted: false,
                isImage: false,
              },
              false,
              "complete",
            ),
          )
          .renderToolResult(renderContext)}
      </div>,
    );

    expect(screen.getByRole("table")).toBeDefined();
    expect(screen.getByText("old")).toBeDefined();
    expect(screen.getByText("new")).toBeDefined();
    const gutters = Array.from(
      container.querySelectorAll(".fixed-font-diff-gutter"),
    ).map((node) => node.textContent);
    expect(gutters).toContain("-");
    expect(gutters).toContain("+");
  });

  it("renders markdown tables in collapsed bash previews", () => {
    const output = [
      "| name | value |",
      "| --- | --- |",
      "\u001b[1;31m-\u001b[m\u001b[1;31m| old | $x^2$ |\u001b[m",
      "\u001b[1;32m+\u001b[m\u001b[1;32m| new | $y^2$ |\u001b[m",
    ].join("\n");

    const { container } = render(
      <div>
        {bashRenderer
          .prepare(
            recordFromLegacyArgs(
              { command: "git diff -- notes.md" },
              {
                stdout: output,
                stderr: "",
                interrupted: false,
                isImage: false,
              } as unknown as BashResult,
              false,
            ),
          )
          .renderCollapsedPreview({ ...renderContext, provider: "claude" })}
      </div>,
    );

    expect(screen.getByRole("table")).toBeDefined();
    expect(screen.getByText("old")).toBeDefined();
    expect(screen.getByText("new")).toBeDefined();
    const gutters = Array.from(
      container.querySelectorAll(".fixed-font-diff-gutter"),
    ).map((node) => node.textContent);
    expect(gutters).toContain("-");
    expect(gutters).toContain("+");
  });

  it("renders markdown tables from research diffs with compact alignment cells", () => {
    const output = [
      "<turn_aborted>",
      "The user interrupted the previous turn on purpose.",
      "</turn_aborted>",
      "diff --git a/research/conditioned-diversity.md b/research/conditioned-diversity.md",
      "index 1978253..c3050d3 100644",
      "--- a/research/conditioned-diversity.md",
      "+++ b/research/conditioned-diversity.md",
      "@@ -820,6 +820,30 @@ not live only in task/backlog state.",
      "+Pilot rows are entered here immediately even when `N < 1000`; they are scheduling signals,",
      "+not final paper claims. Every row below is `data/eng-pol/dev` head-200, scored with",
      "+MetricX-24 hybrid-large; lower is better.",
      "+",
      "+| Ref | Direction | Model / condition | N | MetricX(↓) | Decode speed / output tokens | Artifacts | Scale-up comment |",
      "+|-----|-----------|-------------------|--:|-----------:|------------------------------|-----------|------------------|",
      "+| `POL-P2E-EURO-BASE` | `pl->en` | EuroLLM-9B base | 200 | **3.1677** | 70.49 tok/s / 5,787 tok | [decode] | scale later |",
    ].join("\n");

    const { container } = render(
      <div>
        {bashRenderer
          .prepare(
            recordFromLegacyArgs(
              undefined,
              {
                stdout: output,
                stderr: "",
                interrupted: false,
                isImage: false,
              },
              false,
              "complete",
            ),
          )
          .renderToolResult(renderContext)}
      </div>,
    );

    expect(screen.getByRole("table")).toBeDefined();
    expect(screen.getByText("POL-P2E-EURO-BASE")).toBeDefined();
    expect(container.querySelector("strong")?.textContent).toBe("3.1677");
  });

  it("renders markdown links in diff tables as project file links", () => {
    const output = [
      "diff --git a/research/conditioned-diversity.md b/research/conditioned-diversity.md",
      "--- a/research/conditioned-diversity.md",
      "+++ b/research/conditioned-diversity.md",
      "@@ -1,3 +1,3 @@",
      "+| Ref | Artifacts |",
      "+| --- | --- |",
      "+| `PILOT` | [decode](../untracked/pilot.meta.md) |",
    ].join("\n");

    render(
      <MemoryRouter>
        <I18nProvider>
          <SessionMetadataProvider
            projectId="project-1"
            projectPath="/repo"
            sessionId="session-1"
          >
            {bashRenderer
              .prepare(
                recordFromLegacyArgs(
                  { command: "git diff -- research/conditioned-diversity.md" },
                  {
                    stdout: output,
                    stderr: "",
                    interrupted: false,
                    isImage: false,
                  },
                  false,
                  "complete",
                ),
              )
              .renderToolResult(renderContext)}
          </SessionMetadataProvider>
        </I18nProvider>
      </MemoryRouter>,
    );

    const link = screen.getByRole("link", { name: "decode" });
    expect(link.getAttribute("data-fixed-font-file-path")).toBe(
      "untracked/pilot.meta.md",
    );
    expect(link.getAttribute("href")).toContain(
      "/projects/project-1/file?path=untracked%2Fpilot.meta.md",
    );
  });
});

describe("BashRenderer nested harness launch link", () => {
  const CHILD = "28dad9a6-9c40-4d90-af7e-84d0ed4db9a4";

  function renderCommand(command: string) {
    return render(
      <MemoryRouter>
        <I18nProvider>
          <SessionMetadataProvider
            projectId="project-1"
            projectPath="/repo"
            sessionId="9f073ea3-fc47-459e-bf7b-46e04fd5a094"
          >
            {bashRenderer
              .prepare({ input: { command }, status: "pending" })
              .renderToolUse(renderContext)}
          </SessionMetadataProvider>
        </I18nProvider>
      </MemoryRouter>,
    );
  }

  afterEach(cleanup);

  it("links a backgrounded resume to the session it runs", () => {
    renderCommand(
      `claude --resume ${CHILD} --model claude-opus-5 --print < tasks/intake.md`,
    );

    const link = screen.getByRole("link", { name: /Nested session/ });
    expect(link.getAttribute("href")).toBe(
      `/projects/project-1/sessions/${CHILD}`,
    );
    expect(link.textContent).toContain("28dad9a6");
  });

  it("leaves an ordinary command alone", () => {
    renderCommand("rg -n 'claude --resume' packages/server/src");

    expect(screen.queryByRole("link")).toBeNull();
  });
});
