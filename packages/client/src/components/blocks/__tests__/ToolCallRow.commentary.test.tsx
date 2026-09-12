import { toolRegistry } from "../../renderers/tools";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionMetadataProvider } from "../../../contexts/SessionMetadataContext";
import { SchemaValidationProvider } from "../../../contexts/SchemaValidationContext";
import { ToastProvider } from "../../../contexts/ToastContext";
import { I18nProvider } from "../../../i18n";
import { getSourceRuntimeRegistry } from "../../../lib/sourceRuntime";
import { LOCAL_CLIENT_SUMMARY_SOURCE_KEY } from "../../../lib/clientSummaryStore";
import { UI_KEYS } from "../../../lib/storageKeys";
import { SessionViewerProvider } from "../../SessionManagedViewer";
import { ToolCallRow } from "../ToolCallRow";
import { compileTranscriptProjection } from "@yep-anywhere/shared/transcript/compiler";
import { assistant, call, result } from "../../../../test-fixtures/workflow";

const version = vi.hoisted(() => ({ value: { current: "0.8.2" } }));
vi.mock("../../../hooks/useVersion", () => ({
  useRetainedVersionInfo: () => version.value,
}));

const banner = "# acli: 1 complete +commentary\n";
const note = (text: string) =>
  JSON.stringify({ _acli: { commentary: [{ text }] } });

function row(
  stdout: string,
  pending = false,
  overrides: Partial<ComponentProps<typeof ToolCallRow>> = {},
) {
  return (
    <I18nProvider>
      <MemoryRouter>
        <SessionMetadataProvider
          projectId="project"
          projectPath="/workspace"
          sessionId="session"
        >
          <ToastProvider>
            <SchemaValidationProvider>
              <SessionViewerProvider sessionId="session">
                <ToolCallRow
                  id="command"
                  toolName="Bash"
                  toolInput={
                    overrides.toolName === "Exec"
                      ? {
                          source:
                            "text(await tools.exec_command({cmd: 'report --jsonl'}))",
                          calls: [
                            {
                              toolName: "exec_command",
                              input: { cmd: "report --jsonl" },
                            },
                          ],
                        }
                      : { command: "report --jsonl" }
                  }
                  status={pending ? "pending" : "complete"}
                  toolResult={{
                    content: stdout,
                    isError: false,
                    structured: {
                      stdout,
                      stderr: banner,
                      interrupted: false,
                      isImage: false,
                    },
                  }}
                  {...overrides}
                />
              </SessionViewerProvider>
            </SchemaValidationProvider>
          </ToastProvider>
        </SessionMetadataProvider>
      </MemoryRouter>
    </I18nProvider>
  );
}

describe("ToolCallRow commentary integration", () => {
  it.each(["Bash", "Exec"])(
    "composes %s workflow summaries with rich prose and original-output recovery",
    async (toolName) => {
      const stdout =
        banner +
        note("[build] [Report](./report.md) ready.\nHidden prose.") +
        '\n{"value":1}\n[build] Raw progress.\n';
      const content =
        toolName === "Exec"
          ? JSON.stringify([
              {
                type: "text",
                text: JSON.stringify({
                  chunk_id: "chunk",
                  exit_code: 0,
                  wall_time_seconds: 1,
                  output: stdout,
                }),
              },
            ])
          : stdout;
      const schema = {
        type: "tagged-stages/1",
        id: "test/1",
        key: "work",
        title: "Work",
        toolOutput: {
          containsTags: true,
          closed: true,
          view: "matching-lines",
        },
        stages: [{ key: "build", title: "Build" }],
      };
      const messages = [
        assistant(
          "activate",
          "@@visualization-schema/1 /schema.json\n[workflow][start] id=x schema=test/1\n[work] Begin.",
        ),
        call("command", toolName),
        result("command", content),
        assistant("end", "[workflow][end] id=x status=completed Finished."),
      ];
      const compiled = compileTranscriptProjection(messages, {
        workflowTags: true,
        workflowSchemaFiles: { "/schema.json": JSON.stringify(schema) },
      });
      const tool = compiled.find((item) => item.id === "command")!;
      if (tool.type !== "tool_call") throw new Error("Missing tool");
      const fetch = vi
        .spyOn(
          getSourceRuntimeRegistry().getOrCreateSourceRuntime(
            LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
          ).transport,
          "fetch",
        )
        .mockImplementation(async (_path, options) => {
          const { texts } = JSON.parse(options?.body as string);
          expect(texts.join("\n")).not.toContain("Hidden prose");
          return {
            html: texts.map(
              () => '<p><a href="./report.md">Report</a> ready.</p>',
            ),
          };
        });
      const view = render(
        row(content, false, {
          toolName,
          toolResult: tool.toolResult,
          workflow: tool.workflow,
        }),
      );
      await screen.findByRole("link", { name: "Report" });
      const preview = view.container.querySelector(
        '[data-workflow-output="true"]',
      )!;
      expect(preview.textContent).toContain("Raw progress.");
      expect(preview.textContent).not.toContain("_acli");
      expect(preview.textContent).not.toContain("value");
      expect(
        view.container.querySelectorAll('[data-workflow-path="[work][build]"]'),
      ).toHaveLength(2);
      expect(view.container.textContent).not.toContain("Hidden prose");
      fireEvent.click(
        screen.getByRole("button", { name: "Expand original output" }),
      );
      expect(
        view.container.querySelector('[data-workflow-original="true"]')
          ?.textContent,
      ).toContain("_acli");
      expect(compiled.at(-1)?.workflow?.markers[0]?.kind).toBe("end");
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["Bash", "Exec"])(
    "preserves %s error status through commentary when the result flag is absent",
    async (toolName) => {
      const prepare = vi.spyOn(toolRegistry, "prepare");
      const output = `${banner}{"value":"failed output"}`;
      const content =
        toolName === "Exec"
          ? JSON.stringify([{ type: "text", text: output }])
          : output;
      const toolResult = { content, isError: false };
      Reflect.deleteProperty(toolResult, "isError");
      render(row(content, false, { toolName, status: "error", toolResult }));
      await waitFor(() => {
        const calls = prepare.mock.calls.filter(
          ([name, record]) => name === toolName && record.status === "error",
        );
        expect(calls.length).toBeGreaterThan(0);
        for (const [, record] of calls)
          expect(record.isError ?? record.status === "error").toBe(true);
      });
    },
  );

  beforeEach(() => {
    version.value = { current: "0.8.2" };
    localStorage.removeItem(UI_KEYS.acliCommentary);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem(UI_KEYS.acliCommentary);
  });

  it.each([
    ["# acli: 1 +commentary\n", true],
    ["# acli-capabilities: commentary/1\n", true],
    ["# acli: 1 complete +commentary\r\n", true],
    ["# acli: 1\n", false],
    ["# acli-capabilities: commentary/2\n", false],
    ["Diagnostic first\n# acli: 1 +commentary\n", false],
    [`# acli: 1 ${"x".repeat(4096)} +commentary\n`, false],
  ])(
    "matches the spec's first-line declaration: %s",
    async (stderr, active) => {
      const fetch = vi
        .spyOn(
          getSourceRuntimeRegistry().getOrCreateSourceRuntime(
            LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
          ).transport,
          "fetch",
        )
        .mockResolvedValue({ html: ["<p>Declared note</p>"] });
      render(
        row("", false, {
          toolResult: {
            content: "",
            isError: false,
            structured: { stdout: note("Declared note"), stderr },
          },
        }),
      );
      if (active) await screen.findByText("Declared note");
      else
        expect(
          screen.queryByRole("button", { name: "Open tool output" }),
        ).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(active ? 1 : 0);
    },
  );

  it("renders declared stdout lines with preceding text context", async () => {
    const fetch = vi
      .spyOn(
        getSourceRuntimeRegistry().getOrCreateSourceRuntime(
          LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
        ).transport,
        "fetch",
      )
      .mockImplementation(async (_url, options) => ({
        html: (JSON.parse(options!.body as string).texts as string[]).map(
          (text) => `<p>${text}</p>`,
        ),
      }));
    const stdout =
      "# acli-capabilities: commentary-lines/1\nfirst row\nsecond row\n# _acli.commentary: Report ready\n";
    const view = render(
      row(stdout, false, {
        toolResult: {
          content: stdout,
          isError: false,
          structured: { stdout, stderr: "" },
        },
      }),
    );
    await screen.findByText("Report ready");
    expect(view.container.textContent).not.toContain("_acli");
    fireEvent.click(
      screen.getByRole("button", { name: "Show commentary context" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Show commentary context" })
        .textContent,
    ).toContain("first row\nsecond row\n");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["stderr", "combined"])(
    "keeps %s line commentary unsequenced",
    async (channel) => {
      const fetch = vi
        .spyOn(
          getSourceRuntimeRegistry().getOrCreateSourceRuntime(
            LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
          ).transport,
          "fetch",
        )
        .mockResolvedValue({ html: ["<p>Unsequenced note</p>"] });
      const lines =
        "# acli-capabilities: commentary-lines/1\ndiagnostic\n# _acli.commentary: Unsequenced note\n";
      const result =
        channel === "stderr"
          ? {
              content: "ordinary stdout\n",
              isError: false,
              structured: { stdout: "ordinary stdout\n", stderr: lines },
            }
          : {
              content: JSON.stringify([
                {
                  type: "text",
                  text: JSON.stringify({
                    output: lines,
                    exit_code: 0,
                    wall_time_seconds: 1,
                    chunk_id: "chunk",
                  }),
                },
              ]),
              isError: false,
            };
      const view = render(
        row("", false, {
          toolName: channel === "stderr" ? "Bash" : "Exec",
          toolResult: result,
        }),
      );
      await screen.findByText("Unsequenced note");
      expect(
        screen.queryByRole("button", { name: "Show commentary context" }),
      ).toBeNull();
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Open tool output" }),
        );
      });
      await screen.findByText("Original output");
      expect(screen.getAllByText(/diagnostic/).length).toBeGreaterThan(0);
      await act(async () => view.unmount());
      version.value = { current: "0.8.1" };
      render(
        row("", false, {
          toolName: channel === "stderr" ? "Bash" : "Exec",
          toolResult: result,
        }),
      );
      expect(
        screen.queryByText("Unsequenced note", { exact: true }),
      ).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps old servers and the disabled setting on raw output without requests", () => {
    const fetch = vi.spyOn(
      getSourceRuntimeRegistry().getOrCreateSourceRuntime(
        LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
      ).transport,
      "fetch",
    );
    version.value = { current: "0.8.1" };
    const view = render(row(note("Unrendered")));
    expect(
      screen.queryByRole("button", { name: "Open tool output" }),
    ).toBeNull();
    expect(view.container.textContent).toContain(
      "acli: 1 complete +commentary",
    );
    expect(fetch).not.toHaveBeenCalled();
    version.value = { current: "0.8.2" };
    localStorage.setItem(UI_KEYS.acliCommentary, "false");
    view.rerender(row(note("Disabled")));
    expect(view.container.textContent).toContain(
      "acli: 1 complete +commentary",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("renders complete records once, pins context, and opens the minimizable output viewer", async () => {
    const fetch = vi
      .spyOn(
        getSourceRuntimeRegistry().getOrCreateSourceRuntime(
          LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
        ).transport,
        "fetch",
      )
      .mockImplementation(async (_url, options) => ({
        html: (JSON.parse(options!.body as string).texts as string[]).map(
          (text) => `<p>${text}</p>`,
        ),
      }));
    const source = `${note("Root note")}\n{"value":7}\n${note("Result note")}\n`;
    const view = render(row(source.slice(0, 15), true));
    expect(view.container.textContent).not.toContain("_acli");
    expect(fetch).not.toHaveBeenCalled();
    view.rerender(row(source));
    await screen.findByText("Root note");
    expect(view.container.textContent).not.toContain("_acli");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe(
      "/projects/project/tool-commentary/render",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Show commentary context" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Show commentary context" })
        .textContent,
    ).toContain('{"value":7}');
    fireEvent.click(
      screen.getByRole("button", { name: "Close commentary context" }),
    );
    const root = screen.getByRole("button", { name: "Open tool output" });
    expect(root.title).toBe("report --jsonl");
    fireEvent.click(root);
    await screen.findByRole("button", { name: /minimize/i });
    expect(screen.getByText("Original output")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /minimize/i }));
    await act(async () => {
      view.rerender(row(source));
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("Root note")).toHaveLength(1);
  });

  it("replaces source generations without showing raw metadata or duplicating prose", async () => {
    const fetch = vi
      .spyOn(
        getSourceRuntimeRegistry().getOrCreateSourceRuntime(
          LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
        ).transport,
        "fetch",
      )
      .mockImplementation(async (_url, options) => ({
        html: (JSON.parse(options!.body as string).texts as string[]).map(
          (text) => `<p>${text}</p>`,
        ),
      }));
    const view = render(row(`${note("Before")}\n`, true));
    await screen.findByText("Before");
    view.rerender(row(`${note("After")}\n`));
    expect(view.container.textContent).not.toContain("_acli");
    await screen.findByText("After");
    await waitFor(() => expect(screen.queryByText("Before")).toBeNull());
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps declared data-only output in the ordinary box without rendering requests", () => {
    const fetch = vi.spyOn(
      getSourceRuntimeRegistry().getOrCreateSourceRuntime(
        LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
      ).transport,
      "fetch",
    );
    const view = render(row('{"value":7}\n'));
    expect(view.container.textContent).toContain('{"value":7}');
    expect(
      screen.queryByRole("button", { name: "Open tool output" }),
    ).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("presents code-mode command leaves outside the collapsed row with separate contexts", async () => {
    const fetch = vi
      .spyOn(
        getSourceRuntimeRegistry().getOrCreateSourceRuntime(
          LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
        ).transport,
        "fetch",
      )
      .mockImplementation(async (_url, options) => ({
        html: (JSON.parse(options!.body as string).texts as string[]).map(
          (text) => `<p>${text}</p>`,
        ),
      }));
    const command = (output: string) => ({
      chunk_id: "chunk",
      wall_time_seconds: 0.2,
      exit_code: 0,
      output,
    });
    const result = {
      content: JSON.stringify([
        { type: "text", text: "Script completed\nWall time: 1s\nOutput:\n" },
        {
          type: "text",
          text: JSON.stringify(
            command(
              `${banner}${note("First root")}\n{"value":7}\n${note("First context")}\n`,
            ),
          ),
        },
        {
          type: "text",
          text: JSON.stringify({
            i: 1,
            status: "fulfilled",
            value: command(`${banner}${note("Second root")}\n`),
          }),
        },
      ]),
      isError: false,
    };
    const overrides = {
      toolName: "Exec",
      toolInput: {
        calls: [],
        source: "text(await tools.exec_command({cmd: 'capture'}))",
      },
      toolResult: result,
    };
    const view = render(
      row("", true, {
        ...overrides,
        toolResult: {
          ...result,
          content: JSON.stringify(JSON.parse(result.content).slice(0, 2)),
        },
      }),
    );
    expect(view.container.textContent).not.toContain("_acli");
    await screen.findByText("First context");
    expect(fetch).toHaveBeenCalledTimes(1);
    view.rerender(row("", false, overrides));
    await screen.findByText("Second root");
    expect(
      screen.getAllByRole("button", { name: "Open tool output" }),
    ).toHaveLength(2);
    expect(
      screen.getAllByRole("button", { name: "Open tool output" })[1]?.title,
    ).toBe(overrides.toolInput.source);
    expect(view.container.textContent!.indexOf("First root")).toBeLessThan(
      view.container.textContent!.indexOf("Second root"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Show commentary context" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Show commentary context" })
        .textContent,
    ).toContain('{"value":7}');
    fireEvent.click(
      screen.getByRole("button", { name: "Close commentary context" }),
    );
    await act(async () => {
      view.rerender(row("", false, overrides));
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    view.unmount();
    const replay = render(row("", false, overrides));
    await screen.findByText("Second root");
    expect(fetch).toHaveBeenCalledTimes(2);
    replay.unmount();
    version.value = { current: "0.8.1" };
    render(row("", false, overrides));
    expect(screen.queryByText("First root", { exact: true })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
