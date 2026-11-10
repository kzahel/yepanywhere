import { recordFromLegacyArgs } from "../prepareDisplay";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeStdinRenderer } from "../WriteStdinRenderer";

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
  theme: "dark" as const,
};

describe("WriteStdinRenderer", () => {
  afterEach(() => {
    cleanup();
  });

  it("uses a concise display name", () => {
    expect(writeStdinRenderer.displayName).toBe("Shell");
  });

  it("renders poll intent for empty chars", () => {
    render(
      <div>
        {writeStdinRenderer
          .prepare({
            input: { session_id: 90210, chars: "" },
            status: "pending",
          })
          .renderToolUse(renderContext)}
      </div>,
    );

    expect(screen.getByText(/command session 90210/)).toBeDefined();
    expect(screen.getByText(/waiting for output/)).toBeDefined();
  });

  it("shows linked command when available", () => {
    render(
      <div>
        {writeStdinRenderer
          .prepare({
            input: {
              session_id: 90210,
              chars: "",
              linked_command:
                "pnpm vitest packages/server/test/api/sessions.test.ts",
            },
            status: "pending",
          })
          .renderToolUse(renderContext)}
      </div>,
    );

    expect(screen.getByText(/command: pnpm vitest/)).toBeDefined();
  });

  it("shows linked origin label for PTY-backed reads", () => {
    render(
      <div>
        {writeStdinRenderer
          .prepare({
            input: {
              session_id: 37863,
              chars: "",
              linked_tool_name: "Read",
              linked_file_path:
                "packages/client/src/hooks/useGlobalSessions.ts",
              linked_command:
                "sed -n '1,260p' packages/client/src/hooks/useGlobalSessions.ts",
            },
            status: "pending",
          })
          .renderToolUse(renderContext)}
      </div>,
    );

    expect(
      screen.getByText(/origin: Read via PTY: useGlobalSessions\.ts/),
    ).toBeDefined();
    expect(
      screen.getByText(
        /file: packages\/client\/src\/hooks\/useGlobalSessions\.ts/,
      ),
    ).toBeDefined();
  });

  it("summarizes a detached script poll as still running, not No output", () => {
    const detachEnvelope =
      "Script running with cell ID 53\nWall time 30.0 seconds\nOutput:\n";
    expect(
      writeStdinRenderer
        .prepare(
          recordFromLegacyArgs(undefined, detachEnvelope, false, "complete"),
        )
        .getResultSummary() ?? "",
    ).toBe("still running · 30s");

    render(
      <div>
        {writeStdinRenderer
          .prepare(
            recordFromLegacyArgs(undefined, detachEnvelope, false, "complete"),
          )
          .renderToolResult(renderContext)}
      </div>,
    );
    expect(
      screen.getByText(/Still running — output continues as script cell 53/),
    ).toBeDefined();
  });

  it("puts the runtime in the summary line whenever it is known", () => {
    expect(
      writeStdinRenderer
        .prepare(
          recordFromLegacyArgs(
            undefined,
            "Script completed\nWall time 27.0 seconds\nOutput:\nline one\nline two\n",
            false,
            "complete",
          ),
        )
        .getResultSummary() ?? "",
    ).toBe("2 lines · 27s");
    expect(
      writeStdinRenderer
        .prepare(
          recordFromLegacyArgs(
            undefined,
            "Wall time 30.0 seconds\nOutput:\n",
            false,
            "complete",
          ),
        )
        .getResultSummary() ?? "",
    ).toBe("No output · 30s");
  });

  it("suppresses exit 0 in the summary per the command-metadata contract", () => {
    const summary =
      writeStdinRenderer
        .prepare(
          recordFromLegacyArgs(
            undefined,
            "Chunk ID: ff710e\nProcess exited with code 0\nOutput:\nready\n",
            false,
            "complete",
          ),
        )
        .getResultSummary() ?? "";

    expect(summary).toBe("1 lines");
  });

  it("summarizes a nonzero envelope exit code with runtime", () => {
    const summary =
      writeStdinRenderer
        .prepare(
          recordFromLegacyArgs(
            undefined,
            "Chunk ID: ff710e\nWall time: 0.0518 seconds\nProcess exited with code 2\nOutput:\nboom\n",
            false,
            "complete",
          ),
        )
        .getResultSummary() ?? "";

    expect(summary).toBe("rc=2 in 0.0518 seconds");
  });

  it("renders a unified-exec chunk record as its output text with a meta line", () => {
    const { container } = render(
      <div>
        {writeStdinRenderer
          .prepare(
            recordFromLegacyArgs(
              undefined,
              {
                chunk_id: "d935b8",
                wall_time_seconds: 22.4,
                session_id: 40452,
                exit_code: 0,
                output: "hyp-tokens: first=85 min=42\n",
                stdout: "hyp-tokens: first=85 min=42\n",
              },
              false,
              "complete",
            ),
          )
          .renderToolResult(renderContext)}
      </div>,
    );

    expect(screen.getByText(/hyp-tokens: first=85 min=42/)).toBeDefined();
    expect(screen.queryByText(/chunk_id/)).toBeNull();
    expect(
      container.querySelector("[data-command-result-meta]")?.textContent,
    ).toBe("22.4s");
  });

  it("summarizes a failed chunk record as rc=N with runtime", () => {
    const summary =
      writeStdinRenderer
        .prepare(
          recordFromLegacyArgs(
            undefined,
            {
              chunk_id: "aa",
              wall_time_seconds: 30.0016,
              exit_code: 2,
              output: "boom\n",
              stdout: "boom\n",
            },
            false,
            "complete",
          ),
        )
        .getResultSummary() ?? "";

    expect(summary).toBe("rc=2 in 30s");
  });

  it("renders output text without JSON escaping artifacts", () => {
    render(
      <div>
        {writeStdinRenderer
          .prepare(
            recordFromLegacyArgs(
              undefined,
              "Chunk ID: ff710e\nWall time: 0.0518 seconds\nOutput:\nready\n",
              false,
              "complete",
            ),
          )
          .renderToolResult(renderContext)}
      </div>,
    );

    expect(screen.getByText(/ready/)).toBeDefined();
  });

  it("extracts output section from envelope metadata", () => {
    render(
      <div>
        {writeStdinRenderer
          .prepare(
            recordFromLegacyArgs(
              undefined,
              "Chunk ID: ff710e\nWall time: 0.0518 seconds\nProcess exited with code 0\nOutput:\nline 1\nline 2\n",
              false,
              "complete",
            ),
          )
          .renderToolResult(renderContext)}
      </div>,
    );

    expect(screen.queryByText(/Chunk ID: ff710e/)).toBeNull();
    expect(screen.queryByText(/Wall time: 0.0518 seconds/)).toBeNull();
    expect(screen.getByText(/line 1/)).toBeDefined();
    expect(screen.getByText(/line 2/)).toBeDefined();
  });

  it("renders ANSI escapes from extracted shell output", () => {
    const { container } = render(
      <div>
        {writeStdinRenderer
          .prepare(
            recordFromLegacyArgs(
              undefined,
              `Chunk ID: ff710e
Wall time: 0.0518 seconds
Process exited with code 0
Output:
plain
[32mgreen bold[0m
`,
              false,
              "complete",
            ),
          )
          .renderToolResult(renderContext)}
      </div>,
    );

    expect(screen.queryByText(/Chunk ID: ff710e/)).toBeNull();
    expect(container.querySelector(".ansi-fg-green")).not.toBeNull();
  });

  it("renders PTY-backed read output as a file modal opener", () => {
    const { container } = render(
      <div>
        {writeStdinRenderer
          .prepare(
            recordFromLegacyArgs(
              {
                session_id: 37863,
                linked_tool_name: "Read",
                linked_file_path:
                  "packages/client/src/hooks/useGlobalSessions.ts",
              },
              "Chunk ID: ff710e\nWall time: 0.0518 seconds\nProcess exited with code 0\nOutput:\nline 1\nline 2\n",
              false,
              "complete",
            ),
          )
          .renderToolResult(renderContext)}
      </div>,
    );

    const button = screen.getByRole("button", {
      name: /useGlobalSessions\.ts/i,
    });
    expect(button).toBeDefined();
    expect(screen.queryByText(/^line 1$/)).toBeNull();

    fireEvent.click(button);

    const modalCode = container.querySelector(
      "[data-file-content-modal] [data-line-content] code",
    );
    expect(modalCode?.textContent).toContain("line 1\nline 2");
  });
});
