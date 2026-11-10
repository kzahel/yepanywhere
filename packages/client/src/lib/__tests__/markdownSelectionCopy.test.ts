import { describe, expect, it } from "vitest";
import {
  extractMarkdownSnippetsFromSelection,
  getMarkdownForVisibleSelection,
  getMarkdownSnippetForSubElement,
  registerMarkdownCopySource,
} from "../markdownSelectionCopy";
import { prepareShikiHtml } from "../shikiHtml";

describe("getMarkdownForVisibleSelection", () => {
  it("maps Quarto include labels and paths back to their source", () => {
    const source = "{{< include _introduction.qmd >}}";

    expect(getMarkdownForVisibleSelection(source, "_introduction.qmd")).toBe(
      "_introduction.qmd",
    );
    expect(
      getMarkdownForVisibleSelection(source, "Include: _introduction.qmd"),
    ).toBe(source);
  });

  it("preserves original ordered-list markers for rendered selections", () => {
    expect(
      getMarkdownForVisibleSelection(
        "1. First item\n1. Second item",
        "First item\nSecond item",
      ),
    ).toBe("1. First item\n1. Second item");
  });

  it("uses the source numbering when copied browser text was renumbered", () => {
    expect(
      getMarkdownForVisibleSelection(
        "1. First item\n1. Second item",
        "1. First item\n2. Second item",
      ),
    ).toBe("1. First item\n1. Second item");
  });

  it("uses rendered prefix context to pick repeated list items", () => {
    expect(
      getMarkdownForVisibleSelection("1. Same\n2. Same", "Same", {
        textBefore: "Same\n",
      }),
    ).toBe("2. Same");
  });

  it("preserves formatting for partial selections without extra words", () => {
    expect(
      getMarkdownForVisibleSelection(
        "- `MCLONE_UI_V2_HIT_DEBUG=1` logs/overlays pointer",
        "MCLONE_UI_V2_HIT_DEBUG=1",
      ),
    ).toBe("- `MCLONE_UI_V2_HIT_DEBUG=1`");
    expect(getMarkdownForVisibleSelection("## Debug switches", "Debug")).toBe(
      "## Debug",
    );
  });

  it("preserves block markers for whole rendered line selections", () => {
    expect(
      getMarkdownForVisibleSelection(
        "- `MCLONE_UI_V2_HIT_DEBUG=1` logs/overlays pointer",
        "MCLONE_UI_V2_HIT_DEBUG=1 logs/overlays pointer",
      ),
    ).toBe("- `MCLONE_UI_V2_HIT_DEBUG=1` logs/overlays pointer");
    expect(
      getMarkdownForVisibleSelection("## Debug switches", "Debug switches"),
    ).toBe("## Debug switches");
  });

  it("retains enclosing formatting for short selections", () => {
    expect(
      getMarkdownForVisibleSelection("Use `long_command` here", "command"),
    ).toBe("`command`");
    expect(
      getMarkdownForVisibleSelection(
        "> Continue **the preview** today",
        "preview",
      ),
    ).toBe("> **preview**");
    expect(
      getMarkdownForVisibleSelection(
        "Read [the guide](https://example.com)",
        "guide",
      ),
    ).toBe("[guide](https://example.com)");
    expect(
      getMarkdownForVisibleSelection("First.\n\nSecond.", "First.\nSecond."),
    ).toBe("First.\n\nSecond.");
  });

  it("keeps plain partial selections narrow", () => {
    expect(getMarkdownForVisibleSelection("alpha beta gamma", "beta")).toBe(
      "beta",
    );
  });

  it("preserves exact source-mode selections", () => {
    expect(
      getMarkdownForVisibleSelection("The **bold** word", "**bold**", {
        preferExactSource: true,
      }),
    ).toBe("**bold**");
  });

  it("recovers original math delimiters from a rendered expression", () => {
    expect(
      getMarkdownForVisibleSelection("Value $x^2$.", "x^2", {
        preferRenderedSource: true,
      }),
    ).toBe("$x^2$");
    expect(
      getMarkdownForVisibleSelection("Display \\[x^2\\].", "x^2", {
        preferRenderedSource: true,
      }),
    ).toBe("\\[x^2\\]");
  });
});

describe("extractMarkdownSnippetsFromSelection", () => {
  it("restores reading-order newlines from tokenized Shiki selections", () => {
    const registeredSource = "alpha beta gamma\ndelta epsilon";
    const root = document.createElement("div");
    const source = document.createElement("div");
    source.innerHTML = prepareShikiHtml(
      '<pre class="shiki"><code><span class="line"><span>alpha </span><span>beta gamma</span></span><span class="line"><span>delta</span><span> epsilon</span></span></code></pre>',
      registeredSource,
    );
    root.append(source);
    document.body.append(root);
    const unregister = registerMarkdownCopySource(source, registeredSource, {
      projectId: "project-1",
      filePath: "src/example.ts",
      contentStartLine: 10,
    });
    const beta = source.querySelectorAll(".line > span")[1]?.firstChild;
    const delta = source.querySelectorAll(".line > span")[2]?.firstChild;
    expect(beta).toBeTruthy();
    expect(delta).toBeTruthy();
    const range = document.createRange();
    range.setStart(beta as Node, 0);
    range.setEnd(delta as Node, "delta".length);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(extractMarkdownSnippetsFromSelection(root)).toMatchObject([
      {
        markdown: "beta gamma\ndelta",
        selectedText: "beta gamma\ndelta",
        sourceStart: 6,
        sourceEnd: 22,
        sourceLocation: {
          projectId: "project-1",
          filePath: "src/example.ts",
          lineStart: 10,
          lineEnd: 11,
        },
      },
    ]);

    selection?.removeAllRanges();
    unregister();
    root.remove();
  });

  it("returns per-source markdown snippets for a covered selection", () => {
    const root = document.createElement("div");
    const source = document.createElement("div");
    source.textContent = "First item";
    root.append(source);
    document.body.append(root);
    const unregister = registerMarkdownCopySource(
      source,
      "1. First item\n1. Second item",
    );

    const range = document.createRange();
    range.selectNodeContents(source);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(extractMarkdownSnippetsFromSelection(root)).toMatchObject([
      {
        markdown: "1. First item",
        selectedText: "First item",
        sourceElement: source,
      },
    ]);

    selection?.removeAllRanges();
    unregister();
    root.remove();
  });

  it("splits a selection across eligible regions and skips separators", () => {
    const root = document.createElement("div");
    const firstSource = document.createElement("span");
    const separator = document.createElement("span");
    const secondSource = document.createElement("span");
    firstSource.textContent = "first quote";
    separator.textContent = " local chrome ";
    secondSource.textContent = "second quote";
    root.append(firstSource, separator, secondSource);
    document.body.append(root);
    const unregisterFirst = registerMarkdownCopySource(
      firstSource,
      "first quote",
    );
    const unregisterSecond = registerMarkdownCopySource(
      secondSource,
      "second quote",
    );

    const range = document.createRange();
    range.setStart(firstSource.firstChild as Node, 0);
    range.setEnd(secondSource.firstChild as Node, "second quote".length);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(extractMarkdownSnippetsFromSelection(root)).toMatchObject([
      {
        markdown: "first quote",
        selectedText: "first quote",
        sourceElement: firstSource,
      },
      {
        markdown: "second quote",
        selectedText: "second quote",
        sourceElement: secondSource,
      },
    ]);

    selection?.removeAllRanges();
    unregisterFirst();
    unregisterSecond();
    root.remove();
  });

  it("keeps a partial Show source selection exact instead of remapping it", () => {
    const root = document.createElement("div");
    const source = document.createElement("div");
    const raw = document.createElement("pre");
    raw.setAttribute("data-text-block-source", "");
    raw.textContent = "## Debug switches";
    source.append(raw);
    root.append(source);
    document.body.append(root);
    const unregister = registerMarkdownCopySource(source, "## Debug switches");
    const range = document.createRange();
    range.setStart(raw.firstChild!, 3);
    range.setEnd(raw.firstChild!, 8);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(extractMarkdownSnippetsFromSelection(root)).toMatchObject([
      { markdown: "Debug", selectedText: "Debug", sourceElement: source },
    ]);
    selection.removeAllRanges();
    unregister();
    root.remove();
  });

  it("copies only a selected inline token from a rendered list item", () => {
    const root = document.createElement("div");
    const source = document.createElement("div");
    source.textContent =
      "MCLONE_UI_V2_HIT_DEBUG=1 logs/overlays pointer, hovered rects";
    root.append(source);
    document.body.append(root);
    const unregister = registerMarkdownCopySource(
      source,
      "- `MCLONE_UI_V2_HIT_DEBUG=1` logs/overlays pointer, hovered rects",
    );

    const range = document.createRange();
    range.setStart(source.firstChild as Node, 0);
    range.setEnd(source.firstChild as Node, "MCLONE_UI_V2_HIT_DEBUG=1".length);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(extractMarkdownSnippetsFromSelection(root)).toMatchObject([
      {
        markdown: "- `MCLONE_UI_V2_HIT_DEBUG=1`",
        selectedText: "MCLONE_UI_V2_HIT_DEBUG=1",
        sourceElement: source,
      },
    ]);

    selection?.removeAllRanges();
    unregister();
    root.remove();
  });

  it("attaches file lines only for an unambiguous source span", () => {
    const root = document.createElement("div");
    const source = document.createElement("div");
    source.textContent = "selected line";
    root.append(source);
    document.body.append(root);
    const unregister = registerMarkdownCopySource(
      source,
      "before\nselected line\nafter",
      {
        projectId: "project-1",
        filePath: "src/example.ts",
        contentStartLine: 40,
      },
    );
    const range = document.createRange();
    range.selectNodeContents(source);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(
      extractMarkdownSnippetsFromSelection(root)[0]?.sourceLocation,
    ).toEqual({
      projectId: "project-1",
      filePath: "src/example.ts",
      lineStart: 41,
      lineEnd: 41,
    });

    unregister();
    const unregisterAmbiguous = registerMarkdownCopySource(
      source,
      "selected line\nselected line",
      {
        projectId: "project-1",
        filePath: "src/example.ts",
      },
    );
    expect(
      extractMarkdownSnippetsFromSelection(root)[0]?.sourceLocation,
    ).toBeUndefined();

    selection?.removeAllRanges();
    unregisterAmbiguous();
    root.remove();
  });

  it("maps a rendered KaTeX selection back to its original source", () => {
    const root = document.createElement("div");
    const source = document.createElement("div");
    source.innerHTML = `<span class="katex"><span class="katex-mathml"><math><semantics><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span><span class="katex-html"><span>rendered x²</span></span></span>`;
    root.append(source);
    document.body.append(root);
    const unregister = registerMarkdownCopySource(source, "Value $x^2$.");
    const visibleMath = source.querySelector(".katex-html span")?.firstChild;
    expect(visibleMath).toBeTruthy();
    const range = document.createRange();
    range.selectNodeContents(visibleMath as Node);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(extractMarkdownSnippetsFromSelection(root)[0]?.markdown).toBe(
      "$x^2$",
    );

    selection?.removeAllRanges();
    unregister();
    root.remove();
  });

  it("excludes an inline comment editor from repeated-source mapping", () => {
    const root = document.createElement("div");
    const source = document.createElement("div");
    source.innerHTML =
      '<p>Same paragraph.</p><div data-markdown-copy-ignore="true">Editor text that is not source.</div><p>Same paragraph.</p>';
    root.append(source);
    document.body.append(root);
    const unregister = registerMarkdownCopySource(
      source,
      "1. Same paragraph.\n2. Same paragraph.",
      { projectId: "project-1", filePath: "notes.md" },
    );
    const second = source.querySelectorAll("p")[1];
    const range = document.createRange();
    range.selectNodeContents(second!);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(extractMarkdownSnippetsFromSelection(root)[0]).toMatchObject({
      markdown: "2. Same paragraph.",
      sourceLocation: {
        filePath: "notes.md",
        lineStart: 2,
        lineEnd: 2,
      },
    });

    selection?.removeAllRanges();
    unregister();
    root.remove();
  });
});

describe("getMarkdownSnippetForSubElement", () => {
  it("recovers markdown for one paragraph of a multi-paragraph source", () => {
    const root = document.createElement("div");
    const content = document.createElement("div");
    const p1 = document.createElement("p");
    p1.textContent = "First paragraph.";
    const p2 = document.createElement("p");
    p2.textContent = "Second paragraph.";
    content.append(p1, p2);
    root.append(content);
    document.body.append(root);
    const unregister = registerMarkdownCopySource(
      content,
      "First paragraph.\n\nSecond paragraph.",
    );

    const snippet = getMarkdownSnippetForSubElement(content, p2);
    expect(snippet?.markdown).toBe("Second paragraph.");
    expect(snippet?.selectedText).toContain("Second paragraph.");
    expect(snippet?.sourceElement).toBe(content);
    expect(snippet?.range.startContainer.nodeType).toBe(Node.TEXT_NODE);
    expect(snippet?.range.endContainer.nodeType).toBe(Node.TEXT_NODE);
    expect(snippet?.range.toString()).toBe("Second paragraph.");

    unregister();
    root.remove();
  });

  it("returns null for an unregistered source element", () => {
    const content = document.createElement("div");
    const p = document.createElement("p");
    p.textContent = "Orphan paragraph.";
    content.append(p);
    expect(getMarkdownSnippetForSubElement(content, p)).toBeNull();
  });
});
