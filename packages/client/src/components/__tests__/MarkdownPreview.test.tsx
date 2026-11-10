import {
  cleanup,
  fireEvent,
  render as renderComponent,
  screen,
} from "@testing-library/react";
import type { ClipboardEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownPreview } from "../MarkdownPreview";
import { I18nProvider } from "../../i18n";

const render = (
  ui: Parameters<typeof renderComponent>[0],
  options?: Parameters<typeof renderComponent>[1],
) => renderComponent(ui, { wrapper: I18nProvider, ...options });

describe("MarkdownPreview", () => {
  it("selects whole inline items while leaving code blocks and linked menus alone", () => {
    const contextMenu = vi.fn();
    const { container } = render(
      <I18nProvider>
        <MarkdownPreview
          html={
            '<p><code>lo-teacher-v3-test</code> <code>docs/a file.md</code> <a href="/file"><code>linked.md</code></a></p><pre><code>block-word</code></pre>'
          }
          onContextMenu={contextMenu}
        />
      </I18nProvider>,
    );
    const code = container.querySelectorAll("code");
    fireEvent.doubleClick(code[0]!);
    expect(document.getSelection()?.toString()).toBe("lo-teacher-v3-test");
    fireEvent.doubleClick(code[1]!);
    expect(document.getSelection()?.toString()).toBe("docs/a file.md");
    fireEvent.doubleClick(code[3]!);
    expect(document.getSelection()?.toString()).toBe("docs/a file.md");
    document.getSelection()?.removeAllRanges();
    fireEvent.contextMenu(code[2]!);
    expect(contextMenu).toHaveBeenCalledOnce();
    fireEvent.contextMenu(code[0]!);
    expect(screen.getByRole("menuitem", { name: "Copy text" })).toBeTruthy();
    expect(contextMenu).toHaveBeenCalledOnce();
  });
  afterEach(() => {
    document.getSelection()?.removeAllRanges();
    cleanup();
  });

  it("leaves copy ownership to the containing document viewer", () => {
    const handleCopy = vi.fn((event: ClipboardEvent) => {
      expect(event.defaultPrevented).toBe(false);
    });
    render(
      <div onCopy={handleCopy}>
        <MarkdownPreview
          html={
            '<table class="source-table"><tbody><tr><th style="color: red">Header</th></tr></tbody></table>'
          }
        />
      </div>,
    );
    const preview = screen.getByRole("region", { name: "Markdown preview" });
    const rendered = preview.querySelector("[data-markdown-rendered]");
    if (!rendered) {
      throw new Error("Expected rendered Markdown content");
    }
    const range = document.createRange();
    range.selectNodeContents(rendered);
    document.getSelection()?.addRange(range);
    const setData = vi.fn();

    fireEvent.copy(rendered, {
      clipboardData: { setData },
    });

    expect(handleCopy).toHaveBeenCalledOnce();
    expect(setData).not.toHaveBeenCalled();
  });

  it("preserves imperatively mounted media when the HTML is unchanged", () => {
    const html = '<span class="local-media-inline-preview"></span>';
    const { container, rerender } = render(
      <MarkdownPreview ariaLabel="Initial preview" html={html} />,
    );
    const mediaRoot = container.querySelector(".local-media-inline-preview");
    if (!mediaRoot) {
      throw new Error("Expected inline media preview root");
    }
    const image = document.createElement("img");
    mediaRoot.append(image);

    rerender(<MarkdownPreview ariaLabel="Updated preview" html={html} />);

    expect(container.querySelector("img")).toBe(image);
  });
});
