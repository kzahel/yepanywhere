import { recordFromLegacyArgs } from "../prepareDisplay";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SessionMetadataProvider } from "../../../../contexts/SessionMetadataContext";
import { I18nProvider } from "../../../../i18n";
import { UI_KEYS } from "../../../../lib/storageKeys";
import { TooltipLayer } from "../../../ui/TooltipLayer";
import { editRenderer } from "../EditRenderer";
import type { RenderContext } from "../../types";

const mocks = vi.hoisted(() => ({
  useFileVersionControl: vi.fn(),
  getFile: vi.fn(),
  expandDiffContext: vi.fn(),
}));

vi.mock("../../../../hooks/useFileVersionControl", () => ({
  useFileVersionControl: mocks.useFileVersionControl,
}));

vi.mock("../../../../api/client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getFile: mocks.getFile,
      expandDiffContext: mocks.expandDiffContext,
    },
  };
});

vi.mock("../../../../contexts/SchemaValidationContext", () => ({
  useSchemaValidationContext: () => ({
    enabled: false,
    reportValidationError: vi.fn(),
    isToolIgnored: vi.fn(() => false),
    ignoreToolErrors: vi.fn(),
    clearIgnoredTools: vi.fn(),
    ignoredTools: [],
  }),
}));

const renderContext = {
  isStreaming: false,
  theme: "dark" as const,
};

function rect(top: number): DOMRect {
  return {
    bottom: top + 10,
    height: 10,
    left: 0,
    right: 10,
    top,
    width: 10,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}
if (!editRenderer.operations.includes("renderCollapsedPreview")) {
  throw new Error("Edit renderer must provide collapsed preview");
}
const renderCollapsedPreview = (
  input: unknown,
  result: unknown,
  isError: boolean,
  context: RenderContext,
) =>
  editRenderer
    .prepare(recordFromLegacyArgs(input, result, isError))
    .renderCollapsedPreview(context);

describe("EditRenderer collapsed preview fallback", () => {
  beforeEach(() => {
    window.localStorage.setItem(UI_KEYS.tooltipMode, "themed");
    mocks.getFile.mockReset();
    mocks.expandDiffContext.mockReset();
    mocks.getFile.mockResolvedValue({
      metadata: {
        path: "notes.md",
        size: 12,
        mimeType: "text/markdown",
        isText: true,
      },
      rawUrl: "",
      content: "",
    });
    mocks.expandDiffContext.mockResolvedValue({
      structuredPatch: [],
      diffHtml: "",
    });
    mocks.useFileVersionControl.mockImplementation(
      (_projectId: string, filePath: string) => ({
        cumulativeFile: null,
        loading: false,
        relativePath: filePath,
        supported: false,
        worktreeFile: null,
      }),
    );
  });

  afterEach(() => {
    document.getSelection()?.removeAllRanges();
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.removeItem(UI_KEYS.tooltipMode);
  });

  it("renders raw patch text for completed rows when structured patch is missing", () => {
    const input = {
      _rawPatch: [
        "*** Begin Patch",
        "*** Update File: src/example.ts",
        "@@",
        "-const x = 1;",
        "+const x = 2;",
        "*** End Patch",
      ].join("\n"),
    };

    render(
      <div>
        {renderCollapsedPreview(
          input as never,
          { ok: true } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.queryByText("Computing diff...")).toBeNull();
    expect(screen.getByText(/\*\*\* Begin Patch/)).toBeDefined();
  });

  it("renders a raw patch when a plain-text result arrives as undefined", () => {
    render(
      <div>
        {renderCollapsedPreview(
          { _rawPatch: "export const added = true;" } as never,
          undefined,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.queryByText("Computing diff...")).toBeNull();
    expect(screen.getByText(/export const added/)).toBeDefined();
  });

  it("keeps pending classic Edit rows on Computing diff...", () => {
    const input = {
      file_path: "src/example.ts",
      old_string: "const x = 1;",
      new_string: "const x = 2;",
    };

    render(
      <div>
        {renderCollapsedPreview(
          input as never,
          undefined,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.getByText("Computing diff...")).toBeDefined();
  });

  it("keeps structured diff rendering unchanged when structured patch exists", () => {
    const input = {
      _structuredPatch: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ["-const x = 1;", "+const x = 2;"],
        },
      ],
    };

    const { container } = render(
      <div>
        {renderCollapsedPreview(
          input as never,
          undefined,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.queryByText("Computing diff...")).toBeNull();
    expect(container.querySelector(".diff-removed")?.textContent).toBe(
      "-const x = 1;",
    );
    expect(container.querySelector(".diff-added")?.textContent).toBe(
      "+const x = 2;",
    );
  });

  it("reveals the omitted Edit tail from the fade and +N badge", () => {
    const lines = Array.from(
      { length: 16 },
      (_, index) => `+line ${index + 1}`,
    );
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: lines.length,
        lines,
      },
    ];

    const { container } = render(
      <div>
        {renderCollapsedPreview(
          { _structuredPatch: structuredPatch } as never,
          {
            filePath: "notes.txt",
            structuredPatch,
          } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    const badge = container.querySelector<HTMLElement>(".edit-preview-more");
    const fadedPreview = container.querySelector<HTMLElement>(
      ".diff-view-container",
    );
    expect(badge?.textContent).toBe("+4");
    expect(badge?.getAttribute("data-tooltip")).toBe(
      "...\n+line 5\n+line 6\n+line 7\n+line 8\n+line 9\n+line 10\n+line 11\n+line 12\n+line 13\n+line 14\n+line 15\n+line 16",
    );
    expect(fadedPreview?.getAttribute("data-tooltip")).toBe(
      badge?.getAttribute("data-tooltip"),
    );
    expect(badge?.getAttribute("title")).toBeNull();
    expect(fadedPreview?.getAttribute("title")).toBeNull();
  });

  it("uses only native attributes for an Edit tail in native mode", () => {
    window.localStorage.setItem(UI_KEYS.tooltipMode, "native");
    const lines = Array.from(
      { length: 13 },
      (_, index) => `+line ${index + 1}`,
    );
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: lines.length,
        lines,
      },
    ];

    const { container } = render(
      <div>
        {renderCollapsedPreview(
          { _structuredPatch: structuredPatch } as never,
          {
            filePath: "notes.txt",
            structuredPatch,
          } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    const badge = container.querySelector<HTMLElement>(".edit-preview-more");
    expect(badge?.getAttribute("title")).toMatch(/^\.\.\.\n\+line 2/);
    expect(badge?.getAttribute("data-tooltip")).toBeNull();
  });

  it("shows a full unfaded Edit preview when it is off-screen", () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 1,
        lines: ["+line 1"],
      },
    ];
    const { container } = render(
      <div>
        {renderCollapsedPreview(
          { _structuredPatch: structuredPatch } as never,
          {
            filePath: "notes.txt",
            structuredPatch,
          } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(container.querySelector(".edit-preview-more")).toBeNull();
    const preview = container.querySelector<HTMLElement>(
      ".diff-view-container",
    );
    expect(preview).toBeTruthy();
    expect(preview?.classList).not.toContain("truncated");
    Object.defineProperties(preview, {
      clientWidth: { configurable: true, value: 300 },
      clientHeight: { configurable: true, value: 20 },
      scrollWidth: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 20 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({
          x: 0,
          y: window.innerHeight - 10,
          left: 0,
          top: window.innerHeight - 10,
          right: 300,
          bottom: window.innerHeight + 10,
          width: 300,
          height: 20,
          toJSON: () => ({}),
        }),
      },
    });

    fireEvent.pointerEnter(preview as HTMLElement);

    expect(preview?.getAttribute("data-tooltip")).toContain("+line 1");
    expect(preview?.getAttribute("title")).toBeNull();
  });

  it("renders completed markdown table edits through the render toggle", () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        lines: [
          " | name | value |",
          " | --- | --- |",
          "-| old | $x^2$ |",
          "+| new | $y^2$ |",
        ],
      },
    ];

    const { container } = render(
      <div>
        {renderCollapsedPreview(
          {
            _structuredPatch: structuredPatch,
          } as never,
          {
            filePath: "notes.md",
            structuredPatch,
          } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.getByRole("table")).toBeDefined();
    expect(screen.getByText("old")).toBeDefined();
    expect(screen.getByText("new")).toBeDefined();
    expect(container.querySelector(".katex")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show source" }));

    expect(container.textContent).toContain("-| old | $x^2$ |");
  });

  it("renders bracket-delimited display math in completed edits", () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 3,
        lines: ["-old score", "+\\[", "+e_t(y)=(Wh_t+b)_y", "+\\]"],
      },
    ];

    const { container } = render(
      <div>
        {renderCollapsedPreview(
          {
            _structuredPatch: structuredPatch,
          } as never,
          {
            filePath: "notes.md",
            structuredPatch,
          } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(container.querySelector(".katex-display")).toBeTruthy();
    expect(container.querySelector(".katex .msupsub")).toBeTruthy();
    expect(
      container.querySelector(".fixed-font-diff-added .katex-display"),
    ).toBeTruthy();
    expect(
      Array.from(container.querySelectorAll(".fixed-font-diff-gutter")).map(
        (node) => node.textContent,
      ),
    ).toContain("+");
  });

  it("keeps bracketed display math diff-aware in non-Markdown edits", () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 3,
        lines: ["-old score", "+\\[", "+e_t(y)=(Wh_t+b)_y", "+\\]"],
      },
    ];

    const { container } = render(
      <div>
        {renderCollapsedPreview(
          {
            _structuredPatch: structuredPatch,
          } as never,
          {
            filePath: "model.py",
            structuredPatch,
          } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(
      container.querySelector(".fixed-font-diff-added .katex-display"),
    ).toBeTruthy();
    expect(container.querySelector(".katex .msupsub")).toBeTruthy();
    expect(
      Array.from(container.querySelectorAll(".fixed-font-diff-gutter")).map(
        (node) => node.textContent,
      ),
    ).toContain("+");
  });

  it("renders markdown headings and inline markup in completed edits", () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        lines: ["-old text", "+## Findings", "+- **win** in `dev`"],
      },
    ];

    const { container } = render(
      <div>
        {renderCollapsedPreview(
          {
            _structuredPatch: structuredPatch,
          } as never,
          {
            filePath: "notes.md",
            structuredPatch,
          } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.getByText("Findings")).toBeDefined();
    expect(
      container.querySelector(".fixed-font-markdown-heading"),
    ).toBeTruthy();
    expect(container.querySelector("strong")?.textContent).toBe("win");
    expect(container.querySelector("code")?.textContent).toBe("dev");
    const gutters = Array.from(
      container.querySelectorAll(".fixed-font-diff-gutter"),
    ).map((node) => node.textContent);
    expect(gutters).toContain("+");
    expect(gutters).toContain("-");
  });

  it("does not markdown-render backticks in non-Markdown edits", () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ["-const label = `old`;", "+const label = `dev`;"],
      },
    ];

    const { container } = render(
      <div>
        {renderCollapsedPreview(
          {
            _structuredPatch: structuredPatch,
          } as never,
          {
            filePath: "Widget.tsx",
            structuredPatch,
          } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(container.querySelector(".diff-added")?.textContent).toBe(
      "+const label = `dev`;",
    );
    expect(
      container.querySelector(".fixed-font-rendered__content code"),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Show source" })).toBeNull();
  });

  it("renders headerless markdown table edit hunks", () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 3,
        lines: [
          "@@ -1,2 +1,3 @@",
          "-| `POL-E2P-Q35-BASE` | `en->pl` | Qwen3.5-4B base | 200 | 3.1581 | 290.64 tok/s / 7,598 tok |",
          "-| `POL-E2P-TG4B-BASE` | `en->pl` | TranslateGemma-4B base | 200 | **2.7577** | 235.79 tok/s / 7,726 tok |",
          "+| `POL-E2P-EURO-BASE` | `en->pl` | EuroLLM-9B base | 200 | **2.5526** | 98.89 tok/s / 6,527 tok |",
          "+| `POL-E2P-Q35-BASE` | `en->pl` | Qwen3.5-4B base | 200 | 3.1581 | 290.64 tok/s / 7,598 tok |",
          "+| `POL-E2P-TG4B-BASE` | `en->pl` | TranslateGemma-4B base | 200 | 2.7577 | 235.79 tok/s / 7,726 tok |",
        ],
      },
    ];

    const { container } = render(
      <div>
        {renderCollapsedPreview(
          {
            _structuredPatch: structuredPatch,
          } as never,
          {
            filePath: "research/conditioned-diversity.md",
            structuredPatch,
          } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.getByRole("table")).toBeDefined();
    expect(screen.getByText("POL-E2P-EURO-BASE")).toBeDefined();
    expect(
      Array.from(container.querySelectorAll("strong")).map(
        (node) => node.textContent,
      ),
    ).toContain("2.5526");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(5);
  });

  it("resolves markdown links in edit table cells relative to the edited file", () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 3,
        lines: [
          "+| Ref | Artifacts |",
          "+| --- | --- |",
          "+| `PILOT` | [decode](../untracked/pilot.meta.md) |",
        ],
      },
    ];

    render(
      <SessionMetadataProvider
        projectId="project-1"
        projectPath="/repo"
        sessionId="session-1"
      >
        {renderCollapsedPreview(
          {
            _structuredPatch: structuredPatch,
          } as never,
          {
            filePath: "research/conditioned-diversity.md",
            structuredPatch,
          } as never,
          false,
          renderContext,
        )}
      </SessionMetadataProvider>,
    );

    const link = screen.getByRole("link", { name: "decode" });
    expect(link.getAttribute("data-fixed-font-file-path")).toBe(
      "untracked/pilot.meta.md",
    );
  });

  it("renders server-provided highlighted diff HTML when available", () => {
    const input = {
      _structuredPatch: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ["-const x = 1;", "+const x = 2;"],
        },
      ],
      _diffHtml:
        '<pre class="shiki"><code class="language-ts"><span class="line line-deleted"><span class="diff-prefix">-</span><span style="color:var(--shiki-token-keyword)">const</span> x = 1;</span>\n<span class="line line-inserted"><span class="diff-prefix">+</span><span style="color:var(--shiki-token-keyword)">const</span> x = 2;</span></code></pre>',
    };

    const { container } = render(
      <div>
        {renderCollapsedPreview(
          input as never,
          { ok: true } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.queryByText("Computing diff...")).toBeNull();
    expect(
      container.querySelector(".highlighted-diff .line-inserted"),
    ).toBeTruthy();
    expect(container.querySelector(".diff-gutter-aligned")).toBeTruthy();
    expect(screen.getAllByText(/const/)).toHaveLength(2);
  });

  it("keeps an empty Edit input inspectable without inventing a patch target", () => {
    const { container } = render(
      <I18nProvider>
        {renderCollapsedPreview({}, { ok: true }, false, renderContext)}
      </I18nProvider>,
    );
    expect(container.querySelector('[data-tool-display="raw"]')).not.toBeNull();
    expect(screen.queryByText("Computing diff...")).toBeNull();
    expect(container.textContent).toContain('"ok": true');
  });

  it("derives filename from raw patch when file_path is missing", () => {
    const summary =
      editRenderer
        .prepare({
          input: {
            _rawPatch: [
              "*** Begin Patch",
              "*** Update File: packages/client/src/components/Foo.tsx",
              "@@",
              "-const x = 1;",
              "+const x = 2;",
              "*** End Patch",
            ].join("\n"),
          } as never,
          status: "pending",
        })
        .getUseSummary() ?? "";

    expect(summary).toBe("Foo.tsx");
  });

  it("summarizes multi-file raw Codex patches without implying the previous read", () => {
    const summary =
      editRenderer
        .prepare({
          input: [
            "*** Begin Patch",
            "*** Update File: RegressionTests/AwesomeAlign/regtest-awesome-chi.yml",
            "@@",
            "+# checked chi",
            "*** Update File: RegressionTests/AwesomeAlign/regtest-xmt-awesomealign.yml",
            "@@",
            "+# checked align",
            "*** End Patch",
          ].join("\n") as never,
          status: "pending",
        })
        .getUseSummary() ?? "";

    expect(summary).toBe("regtest-awesome-chi.yml +1 files");
  });

  it("summarizes Codex fileChange inputs from changed paths", () => {
    const summary =
      editRenderer
        .prepare({
          input: {
            changes: [
              {
                path: "/repo/src/a.ts",
                kind: "update",
                diff: "@@ -1 +1 @@\n-a\n+b\n",
              },
              {
                path: "/repo/src/b.ts",
                kind: "update",
                diff: "@@ -1 +1 @@\n-c\n+d\n",
              },
            ],
          } as never,
          status: "pending",
        })
        .getUseSummary() ?? "";

    expect(summary).toBe("a.ts +1 files");
  });

  it("keeps completed apply_patch summaries specific before rich hydration", () => {
    const summary =
      editRenderer
        .prepare(
          recordFromLegacyArgs(
            [
              "*** Begin Patch",
              "*** Update File: src/a.ts",
              "@@",
              "+const a = 1;",
              "*** Update File: src/b.ts",
              "@@",
              "+const b = 1;",
              "*** End Patch",
            ].join("\n") as never,
            { ok: true } as never,
            false,
            "complete",
          ),
        )
        .getResultSummary() ?? "";

    expect(summary).toBe("a.ts +1 files");
  });

  it("shows raw patch filename in interactive summary when file_path is missing", () => {
    if (!editRenderer.operations.includes("renderInteractiveSummary")) {
      throw new Error("Edit renderer must provide interactive summary");
    }

    render(
      <div>
        {editRenderer
          .prepare(
            recordFromLegacyArgs(
              {
                _rawPatch: [
                  "*** Begin Patch",
                  "*** Update File: packages/client/src/components/Foo.tsx",
                  "@@",
                  "-const x = 1;",
                  "+const x = 2;",
                  "*** End Patch",
                ].join("\n"),
                _structuredPatch: [
                  {
                    oldStart: 1,
                    oldLines: 1,
                    newStart: 1,
                    newLines: 1,
                    lines: ["-const x = 1;", "+const x = 2;"],
                  },
                ],
              } as never,
              undefined,
              false,
            ),
          )
          .renderInteractiveSummary(renderContext)}
      </div>,
    );

    expect(screen.getByRole("button", { name: /Foo\.tsx/i })).toBeDefined();
  });

  it("links an Edit block to its exact worktree diff", () => {
    if (!editRenderer.operations.includes("renderInteractiveSummary")) {
      throw new Error("Edit renderer must provide interactive summary");
    }
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ["-const x = 1;", "+const x = 2;"],
      },
    ];
    mocks.useFileVersionControl.mockReturnValue({
      cumulativeFile: null,
      loading: false,
      relativePath: "src/example.ts",
      supported: true,
      worktreeFile: {
        path: "src/example.ts",
        status: "M",
        staged: false,
        linesAdded: 1,
        linesDeleted: 1,
      },
    });

    render(
      <MemoryRouter initialEntries={["/projects/project-1/sessions/session-1"]}>
        <SessionMetadataProvider
          projectId="project-1"
          projectPath="/repo"
          sessionId="session-1"
          sessionTitle="Fix polling"
          provider="codex"
          model="gpt-5.4"
          thinking={{ type: "adaptive", display: "summarized" }}
          effort="high"
        >
          <I18nProvider>
            <Routes>
              <Route
                path="/projects/:projectId/sessions/:sessionId"
                element={editRenderer
                  .prepare(
                    recordFromLegacyArgs(
                      {
                        file_path: "/repo/src/example.ts",
                        _structuredPatch: structuredPatch,
                      } as never,
                      undefined,
                      false,
                    ),
                  )
                  .renderInteractiveSummary(renderContext)}
              />
            </Routes>
          </I18nProvider>
        </SessionMetadataProvider>
      </MemoryRouter>,
    );

    const link = screen.getByRole("link", {
      name: "View HEAD to working tree diff for src/example.ts",
    });
    expect(link.getAttribute("href")).toBe(
      "/projects/project-1/file?path=src%2Fexample.ts&diff=worktree",
    );
  });

  it("puts all multi-file patch targets in the interactive summary title", () => {
    if (!editRenderer.operations.includes("renderInteractiveSummary")) {
      throw new Error("Edit renderer must provide interactive summary");
    }

    render(
      <SessionMetadataProvider
        projectId="project-1"
        projectPath="/repo"
        sessionId="session-1"
      >
        {editRenderer
          .prepare(
            recordFromLegacyArgs(
              {
                _rawPatch: [
                  "*** Begin Patch",
                  "*** Update File: /repo/src/a.ts",
                  "@@",
                  "+const a = 1;",
                  "*** Update File: /repo/src/b.ts",
                  "@@",
                  "+const b = 1;",
                  "*** End Patch",
                ].join("\n"),
                _structuredPatch: [
                  {
                    oldStart: 1,
                    oldLines: 0,
                    newStart: 1,
                    newLines: 1,
                    lines: ["+const a = 1;"],
                  },
                ],
              } as never,
              undefined,
              false,
            ),
          )
          .renderInteractiveSummary(renderContext)}
      </SessionMetadataProvider>,
    );

    const button = screen.getByRole("button", { name: /a\.ts \+1 files/i });
    expect(button.getAttribute("title")).toBe("src/a.ts\nsrc/b.ts");
  });

  it("keeps pending multi-file edit summaries title-backed and clickable", () => {
    if (!editRenderer.operations.includes("renderInteractiveSummary")) {
      throw new Error("Edit renderer must provide interactive summary");
    }

    render(
      <SessionMetadataProvider
        projectId="project-1"
        projectPath="/repo"
        sessionId="session-1"
      >
        <I18nProvider>
          {editRenderer
            .prepare(
              recordFromLegacyArgs(
                {
                  _rawPatch: [
                    "*** Begin Patch",
                    "*** Update File: /repo/src/a.ts",
                    "@@",
                    "+const a = 1;",
                    "*** Update File: /repo/src/b.ts",
                    "@@",
                    "+const b = 1;",
                    "*** End Patch",
                  ].join("\n"),
                } as never,
                undefined,
                false,
              ),
            )
            .renderInteractiveSummary(renderContext)}
        </I18nProvider>
      </SessionMetadataProvider>,
    );

    const button = screen.getByRole("button", { name: /a\.ts \+1 files/i });
    expect(button.getAttribute("title")).toBe("src/a.ts\nsrc/b.ts");

    fireEvent.click(button);

    expect(screen.getAllByTitle("src/a.ts").length).toBeGreaterThan(0);
    expect(screen.getAllByTitle("src/b.ts").length).toBeGreaterThan(0);
  });

  it("renders Codex Add File patches as created file content", () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 3,
        lines: ["+# Recent MT Adapter Progress", "+", "+- **win** in `dev`"],
      },
    ];

    const { container } = render(
      <div>
        {renderCollapsedPreview(
          {
            _rawPatch: [
              "*** Begin Patch",
              "*** Add File: /repo/research/progress-2026-05-18.md",
              "+# Recent MT Adapter Progress",
              "+",
              "+- **win** in `dev`",
              "*** End Patch",
            ].join("\n"),
            _structuredPatch: structuredPatch,
          } as never,
          { ok: true } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.queryByText(/\*\*\* Begin Patch/)).toBeNull();
    expect(screen.getByText("Recent MT Adapter Progress")).toBeDefined();
    expect(
      container.querySelector(".fixed-font-markdown-heading"),
    ).toBeTruthy();
    expect(container.querySelector("strong")?.textContent).toBe("win");
    expect(container.querySelector("code")?.textContent).toBe("dev");
  });

  it("copies only post-change diff text from the copy button", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 3,
        lines: [" context", "-old", "+new", "+tail"],
      },
    ];

    render(
      <div>
        {renderCollapsedPreview(
          {
            _structuredPatch: structuredPatch,
          } as never,
          {
            filePath: "notes.md",
            structuredPatch,
          } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Copy post-change text" }),
    );

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("context\nnew\ntail");
    });
  });

  it("opens full add-file modal with a fresh render toggle", () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 13,
        lines: [
          "+# Recent MT Adapter Progress",
          "+",
          "+- **win** in `dev`",
          "+- line 4",
          "+- line 5",
          "+- line 6",
          "+- line 7",
          "+- line 8",
          "+- line 9",
          "+- line 10",
          "+- line 11",
          "+- line 12",
          "+- line 13",
        ],
      },
    ];

    const { container } = render(
      <SessionMetadataProvider
        projectId="project-1"
        projectPath="/repo"
        sessionId="session-1"
      >
        <I18nProvider>
          {renderCollapsedPreview(
            {
              _structuredPatch: structuredPatch,
            } as never,
            {
              filePath: "research/progress-2026-05-18.md",
              structuredPatch,
            } as never,
            false,
            renderContext,
          )}
        </I18nProvider>
      </SessionMetadataProvider>,
    );

    expect(screen.getByText("+1")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Show full diff" }));

    const modal = document.body.querySelector(".modal");
    expect(modal?.textContent).toContain("Recent MT Adapter Progress");
    const titleLink = modal?.querySelector(
      ".modal-title a.file-path-link",
    ) as HTMLAnchorElement | null;
    expect(titleLink?.textContent).toContain("progress-2026-05-18.md");
    expect(titleLink?.getAttribute("href")).toBe(
      "/projects/project-1/file?path=research%2Fprogress-2026-05-18.md&line=1&lineEnd=13",
    );
    const pathLink = screen.getByRole("link", {
      name: /research\/progress-2026-05-18\.md\s*:1-13/,
    });
    expect(pathLink.getAttribute("href")).toBe(
      "/projects/project-1/file?path=research%2Fprogress-2026-05-18.md&line=1&lineEnd=13",
    );
    const copyPath = screen.getByRole("button", { name: "Copy path" });
    expect(copyPath.closest(".modal-header-actions")).not.toBeNull();
    expect(modal?.querySelector(".file-path-copy")).toBeNull();
    const modalToggle = within(modal as HTMLElement).getByRole("button", {
      name: "Show source",
    });
    expect(modalToggle).toBeTruthy();

    fireEvent.click(modalToggle as Element);
    expect(modal?.querySelector(".line-hunk")?.textContent).toContain(
      "@@ -1,0 +1,13 @@",
    );
    expect(container.textContent).toContain("Recent MT Adapter Progress");
  });

  it("does not open the full diff when a glossary term is activated", () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ["-old", "+oracle"],
      },
    ];
    const { container } = render(
      <>
        <TooltipLayer />
        {renderCollapsedPreview(
          { _structuredPatch: structuredPatch } as never,
          { filePath: "notes.md", structuredPatch } as never,
          false,
          renderContext,
        )}
      </>,
    );
    const preview = container.querySelector<HTMLElement>(".diff-tap-target");
    const term = document.createElement("span");
    term.dataset.glossaryTerm = "true";
    term.dataset.tooltip = "oracle — Best published system.";
    term.setAttribute("role", "button");
    term.tabIndex = 0;
    term.textContent = "oracle";
    preview?.append(term);

    fireEvent.click(term);

    expect(screen.getByRole("tooltip").textContent).toBe(
      "oracle — Best published system.",
    );
    expect(document.body.querySelector(".modal")).toBeNull();
  });

  it("counts only hidden rendered diff lines in the +N badge", () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 13,
        lines: Array.from({ length: 13 }, (_, index) => `+line ${index + 1}`),
      },
    ];

    render(
      <div>
        {editRenderer
          .prepare(
            recordFromLegacyArgs(
              undefined,
              { filePath: "notes.md", structuredPatch } as never,
              false,
              "complete",
            ),
          )
          .renderToolResult(renderContext)}
      </div>,
    );

    expect(screen.getByText("+1")).toBeDefined();
    expect(screen.queryByText("+2")).toBeNull();
  });

  it("transfers a diff selection into the full modal", async () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ["-old text", "+selected replacement text"],
      },
    ];

    render(
      <SessionMetadataProvider
        projectId="project-1"
        projectPath="/repo"
        sessionId="session-1"
      >
        <I18nProvider>
          <div>
            {renderCollapsedPreview(
              { _structuredPatch: structuredPatch } as never,
              { filePath: "notes.md", structuredPatch } as never,
              false,
              renderContext,
            )}
          </div>
        </I18nProvider>
      </SessionMetadataProvider>,
    );

    const selectedText = document.querySelector<HTMLElement>(".diff-added");
    const textNode = selectedText?.lastChild;
    if (!selectedText || !textNode) {
      throw new Error("Expected selectable diff text");
    }
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, "selected replacement".length);
    document.getSelection()?.addRange(range);

    fireEvent.click(selectedText);

    await waitFor(() => {
      const modal = document.body.querySelector(".modal");
      const selection = document.getSelection();
      expect(modal).not.toBeNull();
      expect(selection?.toString()).toBe("selected replacement");
      expect(
        selection?.anchorNode ? modal?.contains(selection.anchorNode) : false,
      ).toBe(true);
    });
  });

  it("opens the full modal in the preview mode before transferring a selection", async () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ["-old text", "+# Selected heading"],
      },
    ];

    render(
      <SessionMetadataProvider
        projectId="project-1"
        projectPath="/repo"
        sessionId="session-1"
      >
        <I18nProvider>
          <div>
            {renderCollapsedPreview(
              { _structuredPatch: structuredPatch } as never,
              { filePath: "notes.md", structuredPatch } as never,
              false,
              renderContext,
            )}
          </div>
        </I18nProvider>
      </SessionMetadataProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show source" }));
    const selectedText = document.querySelector<HTMLElement>(".diff-added");
    const prefixText = selectedText?.querySelector(".diff-prefix")?.firstChild;
    const contentText = selectedText?.lastChild;
    if (!selectedText || !prefixText || !contentText) {
      throw new Error("Expected selectable source diff text");
    }
    const range = document.createRange();
    range.setStart(prefixText, 0);
    range.setEnd(contentText, 1);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);

    fireEvent.click(selectedText);

    await waitFor(() => {
      const modal = document.body.querySelector(".modal");
      const selection = document.getSelection();
      expect(modal).not.toBeNull();
      expect(
        within(modal as HTMLElement).getByRole("button", {
          name: "Show rendered view",
        }),
      ).not.toBeNull();
      expect(selection?.toString()).toBe("+#");
      expect(
        selection?.anchorNode ? modal?.contains(selection.anchorNode) : false,
      ).toBe(true);
    });
  });

  it("expands a Grok-style edit to full context from the current file", async () => {
    const structuredPatch = [
      {
        oldStart: 2,
        oldLines: 1,
        newStart: 2,
        newLines: 2,
        lines: [" keep", "+added"],
      },
    ];
    mocks.getFile.mockResolvedValue({
      metadata: {
        path: "notes.md",
        size: 20,
        mimeType: "text/markdown",
        isText: true,
      },
      rawUrl: "",
      content: "keep\nadded\n",
    });
    mocks.expandDiffContext.mockResolvedValue({
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 2,
          lines: [" keep", "+added"],
        },
      ],
      diffHtml:
        '<pre class="shiki"><code><span class="line">keep</span></code></pre>',
    });

    render(
      <SessionMetadataProvider
        projectId="project-1"
        projectPath="/repo"
        sessionId="session-1"
      >
        <I18nProvider>
          {renderCollapsedPreview(
            {
              old_string: "",
              new_string: "added",
              _structuredPatch: structuredPatch,
            } as never,
            {
              filePath: "notes.md",
              oldString: "",
              newString: "added",
              originalFile: "",
              structuredPatch,
            } as never,
            false,
            renderContext,
          )}
        </I18nProvider>
      </SessionMetadataProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show full diff" }));
    const toggle = await screen.findByRole("button", {
      name: "Show full context",
    });
    const scrollRoot = document.querySelector<HTMLElement>(".modal-content");
    if (!scrollRoot) throw new Error("Expected modal scroll root");
    scrollRoot.scrollTop = 40;
    const rectSpy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        if (this === scrollRoot) return rect(20);
        if (
          this instanceof Element &&
          (this.classList.contains("line-inserted") ||
            this.classList.contains("fixed-font-diff-added"))
        ) {
          return rect(
            document.body.textContent?.includes("Show diff only") ? 140 : 80,
          );
        }
        return rect(0);
      });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(mocks.getFile).toHaveBeenCalledWith("project-1", "notes.md");
      expect(mocks.expandDiffContext).toHaveBeenCalledWith(
        "project-1",
        "notes.md",
        "keep\n",
        "keep\nadded\n",
        "keep\n",
      );
    });
    expect(
      await screen.findByRole("button", { name: "Show diff only" }),
    ).toBeDefined();
    expect(scrollRoot.scrollTop).toBe(100);
    rectSpy.mockRestore();
  });

  it("shows the current file without diff markers when the edit cannot be located", async () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ["-old", "+new"],
      },
    ];
    mocks.getFile.mockResolvedValue({
      metadata: {
        path: "notes.md",
        size: 9,
        mimeType: "text/markdown",
        isText: true,
      },
      rawUrl: "",
      content: "unrelated",
    });

    render(
      <SessionMetadataProvider
        projectId="project-1"
        projectPath="/repo"
        sessionId="session-1"
      >
        <I18nProvider>
          {renderCollapsedPreview(
            {
              old_string: "old",
              new_string: "new",
              _structuredPatch: structuredPatch,
            } as never,
            {
              filePath: "notes.md",
              oldString: "old",
              newString: "new",
              originalFile: "",
              structuredPatch,
            } as never,
            false,
            renderContext,
          )}
        </I18nProvider>
      </SessionMetadataProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show full diff" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Show full context" }),
    );

    await waitFor(() => {
      expect(screen.getByText("unrelated")).toBeDefined();
    });
    expect(mocks.expandDiffContext).not.toHaveBeenCalled();
    const modal = document.body.querySelector(".modal");
    expect(modal?.querySelector(".diff-added")).toBeNull();
    expect(modal?.textContent).not.toContain("+new");
  });
});
