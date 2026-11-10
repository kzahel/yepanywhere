import { recordFromLegacyArgs } from "../prepareDisplay";
import type { CodexWebRunResult } from "@yep-anywhere/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UI_KEYS } from "../../../../lib/storageKeys";
import { webRenderer } from "../WebRenderer";

const renderContext = {
  isStreaming: false,
  theme: "dark" as const,
};

const openResult: CodexWebRunResult = {
  durationSeconds: 0.8,
  pages: [
    {
      title: "README.md · facebook/covost2 at main",
      url: "https://huggingface.co/datasets/facebook/covost2/blob/main/README.md",
      ref: "turn1view0",
      wordLimit: 200,
      contentType: "text/html",
      totalLines: 1174,
      lines: [
        { n: 37, text: "# Datasets:" },
        { n: 38, text: "" },
        { n: 39, text: "CoVoST 2 covers translations from 21 languages." },
      ],
    },
  ],
};

const searchResult: CodexWebRunResult = {
  durationSeconds: 1.2,
  pages: [
    {
      title: "First hit",
      url: "https://arxiv.org/abs/2412.04205",
      ref: "turn0academia12",
      published: "1.6 years ago",
      text: "Snippet prose.",
    },
    {
      title: "Second hit",
      url: "https://github.com/facebookresearch/covost",
      ref: "turn0search0",
      text: "More prose.",
    },
  ],
};

describe("WebRenderer", () => {
  beforeEach(() => {
    window.localStorage.setItem(UI_KEYS.tooltipMode, "themed");
  });

  afterEach(() => {
    cleanup();
    document.getSelection()?.removeAllRanges();
    window.localStorage.removeItem(UI_KEYS.tooltipMode);
  });

  it("summarizes a single opened page with time, wordlim, lines, and host", () => {
    expect(
      webRenderer
        .prepare(
          recordFromLegacyArgs(
            {
              open: [{ ref_id: "turn0search4" }],
            },
            openResult,
            false,
            "complete",
          ),
        )
        .getResultSummary() ?? "",
    ).toBe("0.8s · wordlim 200 · 1174 lines · huggingface.co");
  });

  it("summarizes search results by hit count", () => {
    expect(
      webRenderer
        .prepare(
          recordFromLegacyArgs(
            {
              search_query: [{ q: "covost2" }],
            },
            searchResult,
            false,
            "complete",
          ),
        )
        .getResultSummary() ?? "",
    ).toBe("1.2s · 2 results");
  });

  it("summarizes the requested operations for tool use", () => {
    expect(
      webRenderer
        .prepare({
          input: {
            search_query: [{ q: "covost2 download" }, { q: "common voice" }],
          },
          status: "pending",
        })
        .getUseSummary() ?? "",
    ).toBe('search "covost2 download" (+1 more)');
    expect(
      webRenderer
        .prepare({
          input: {
            open: [{ ref_id: "turn0search4" }],
            find: [{ ref_id: "turn0search4", pattern: "zh-CN" }],
          },
          status: "pending",
        })
        .getUseSummary() ?? "",
    ).toBe('open turn0search4 · find "zh-CN"');
  });

  it("renders page lines in prose with a linked title", () => {
    render(
      <div>
        {webRenderer
          .prepare(
            recordFromLegacyArgs(undefined, openResult, false, "complete"),
          )
          .renderToolResult(renderContext)}
      </div>,
    );
    const link = screen.getByRole("link", {
      name: "README.md · facebook/covost2 at main",
    });
    expect(link.getAttribute("href")).toBe(
      "https://huggingface.co/datasets/facebook/covost2/blob/main/README.md",
    );
    expect(
      screen.getByText(/CoVoST 2 covers translations from 21 languages\./),
    ).toBeDefined();
    expect(screen.getByText("1174 lines")).toBeDefined();
    expect(screen.getByText("wordlim 200")).toBeDefined();
  });

  it("renders collapsed preview rows as hostname links", () => {
    render(
      <div>
        {webRenderer
          .prepare(recordFromLegacyArgs({}, searchResult, false))
          .renderCollapsedPreview(renderContext)}
      </div>,
    );
    const link = screen.getByRole("link", { name: "arxiv.org" });
    expect(link.getAttribute("href")).toBe("https://arxiv.org/abs/2412.04205");
    expect(screen.getByText("Second hit")).toBeDefined();
  });

  it("keeps a selected preview collapsed", () => {
    render(
      <div>
        {webRenderer
          .prepare(recordFromLegacyArgs({}, searchResult, false))
          .renderCollapsedPreview(renderContext)}
      </div>,
    );
    const preview = screen.getByRole("button", {
      name: "View web page content",
    });
    const selectedText = screen.getByText(/Snippet prose/);
    const range = document.createRange();
    range.selectNodeContents(selectedText);
    document.getSelection()?.addRange(range);

    fireEvent.click(preview);

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows shell-style preview affordances for long content", () => {
    const longResult: CodexWebRunResult = {
      durationSeconds: 0.9,
      pages: [
        {
          title: "Long page",
          url: "https://example.org/long",
          ref: "turn0view0",
          totalLines: 40,
          lines: Array.from({ length: 40 }, (_, i) => ({
            n: i,
            text: `content line ${i}`,
          })),
        },
      ],
    };
    render(
      <div>
        {webRenderer
          .prepare(recordFromLegacyArgs({}, longResult, false))
          .renderCollapsedPreview(renderContext)}
      </div>,
    );
    expect(screen.getByText(/content line 0/)).toBeDefined();
    // Hidden-line badge and copy button match the shell-output preview.
    const badge = screen.getByText(/^\+\d+$/);
    expect(badge.getAttribute("data-tooltip")).toMatch(/^\.\.\.\n/);
    expect(badge.getAttribute("title")).toBeNull();
    const fadedOutput = badge
      .closest("[data-webrun-preview-output-row]")
      ?.querySelector("[data-webrun-preview-output]");
    expect(fadedOutput?.getAttribute("data-tooltip")).toBe(
      badge.getAttribute("data-tooltip"),
    );
    expect(
      screen.getByRole("button", { name: "Copy page text" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "View web page content" }),
    ).toBeDefined();
  });

  it("shows full unfaded page text when its preview is off-screen", () => {
    const shortResult: CodexWebRunResult = {
      pages: [
        {
          title: "Short page",
          url: "https://example.org/short",
          ref: "turn0view0",
          totalLines: 1,
          lines: [{ n: 0, text: "Short page body." }],
        },
      ],
    };
    const { container } = render(
      <div>
        {webRenderer
          .prepare(recordFromLegacyArgs({}, shortResult, false))
          .renderCollapsedPreview(renderContext)}
      </div>,
    );
    expect(container.querySelector("[data-webrun-preview-fade]")).toBeNull();
    const preview = container.querySelector<HTMLElement>(
      "[data-webrun-preview-output]",
    );
    const renderedText = container.querySelector<HTMLElement>(
      "[data-webrun-preview-output-text]",
    );
    expect(preview).toBeTruthy();
    expect(renderedText).toBeTruthy();
    Object.defineProperties(renderedText, {
      clientWidth: { configurable: true, value: 300 },
      clientHeight: { configurable: true, value: 40 },
      scrollWidth: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 40 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({
          x: 0,
          y: window.innerHeight - 20,
          left: 0,
          top: window.innerHeight - 20,
          right: 300,
          bottom: window.innerHeight + 20,
          width: 300,
          height: 40,
          toJSON: () => ({}),
        }),
      },
    });

    fireEvent.pointerEnter(preview as HTMLElement);

    expect(preview?.getAttribute("data-tooltip")).toContain("Short page body.");
    expect(preview?.getAttribute("title")).toBeNull();
  });

  it("surfaces the failure reason for pages without a URL", () => {
    const errorResult: CodexWebRunResult = {
      pages: [
        {
          title: "Internal Error ()",
          ref: "turn22view0",
          totalLines: 1,
          lines: [{ n: 0, text: "URL https://x is not safe to open" }],
        },
      ],
    };
    render(
      <div>
        {webRenderer
          .prepare(recordFromLegacyArgs({}, errorResult, false))
          .renderCollapsedPreview(renderContext)}
      </div>,
    );
    expect(
      screen.getByText(/Internal Error \(\) — URL https:\/\/x is not safe/),
    ).toBeDefined();
  });

  it("falls back to plain text for unstructured results", () => {
    render(
      <div>
        {webRenderer
          .prepare(
            recordFromLegacyArgs(
              undefined,
              "raw text output",
              false,
              "complete",
            ),
          )
          .renderToolResult(renderContext)}
      </div>,
    );
    expect(screen.getByText("raw text output")).toBeDefined();
  });
});
