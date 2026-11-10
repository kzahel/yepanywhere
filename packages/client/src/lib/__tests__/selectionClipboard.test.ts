import { afterEach, describe, expect, it } from "vitest";
import {
  extractMarkdownSnippetsFromSelection,
  registerMarkdownCopySource,
} from "../markdownSelectionCopy";
import { getSelectionPlainText } from "../selectionClipboard";

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

function select(html: string, markdown: string) {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  registerMarkdownCopySource(root, markdown);
  const range = document.createRange();
  range.selectNodeContents(root);
  document.getSelection()?.addRange(range);
  return extractMarkdownSnippetsFromSelection(root);
}

describe("visible selection clipboard", () => {
  it("omits Markdown while preserving paragraph breaks and literal punctuation", () => {
    const snippets = select(
      "<blockquote><p>Continue <code>/Users/project</code> and <strong>read AGENTS.md</strong>.</p><p>Keep x &gt; 2.<br>Next line.</p></blockquote>",
      "> Continue `/Users/project` and **read AGENTS.md**.\n>\n> Keep x > 2.\n> Next line.",
    );
    expect(getSelectionPlainText(snippets)).toBe(
      "Continue /Users/project and read AGENTS.md.\n\nKeep x > 2.\nNext line.",
    );
    expect(snippets[0]?.markdown).toContain("> Continue");
  });

  it("keeps code indentation and excludes embedded controls", () => {
    expect(
      getSelectionPlainText(
        select(
          '<pre><code>if (x > 2) {\n\n\n  run();\n}</code></pre><div data-markdown-copy-ignore="true">Reply editor</div>',
          "```js\nif (x > 2) {\n\n\n  run();\n}\n```",
        ),
      ),
    ).toBe("if (x > 2) {\n\n\n  run();\n}");
  });

  it("excludes duplicate math presentation and source annotations", () => {
    expect(
      getSelectionPlainText(
        select(
          '<p>Value <span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>x</mi><mn>2</mn></mrow><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span><span class="katex-html">x2</span></span>.</p>',
          "Value $x^2$.",
        ),
      ),
    ).toBe("Value x2.");
  });

  it("copies raw source syntax literally", () => {
    expect(
      getSelectionPlainText(
        select(
          "<pre data-text-block-source>&gt; **literal** `source`</pre>",
          "> **literal** `source`",
        ),
      ),
    ).toBe("> **literal** `source`");
  });
});
