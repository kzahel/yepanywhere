import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  isLocalFilePath,
  localMediaApiUrl,
  parseMarkdownSourceSpans,
  renderSafeMarkdown,
} from "../../src/augments/safe-markdown.js";

describe("Markdown plugin dependency resolution", () => {
  it("uses YA's exact markdown-it and KaTeX runtimes", () => {
    const serverRequire = createRequire(import.meta.url);
    const pluginRequire = createRequire(
      serverRequire.resolve("@mdit/plugin-katex"),
    );

    expect(serverRequire("markdown-it/package.json").version).toBe("15.0.0");
    expect(serverRequire("katex/package.json").version).toBe("0.16.45");
    expect(realpathSync(pluginRequire.resolve("markdown-it"))).toBe(
      realpathSync(serverRequire.resolve("markdown-it")),
    );
    expect(realpathSync(pluginRequire.resolve("katex"))).toBe(
      realpathSync(serverRequire.resolve("katex")),
    );
  });
});

describe("renderSafeMarkdown — math", () => {
  it("renders inline $…$ through katex", () => {
    const html = renderSafeMarkdown("price: $x^2 + 1$ end");
    // placeholder is substituted with katex HTML
    expect(html).not.toContain("yepkatex-placeholder");
    expect(html).toContain('class="katex"');
    expect(html).toContain("end</p>");
  });

  it("renders block $$…$$ in display mode", () => {
    const html = renderSafeMarkdown("$$\n\\frac{1}{2}\n$$");
    expect(html).toContain("katex-display");
    expect(html).not.toContain("yepkatex-placeholder");
  });

  it("renders bracket-delimited inline and display math through katex", () => {
    const html = renderSafeMarkdown(String.raw`
For each token \(t\), it formed only a local emission score:

\[
e_t(y)=(Wh_t+b)_y
\]
`);

    expect(html.match(/class="katex"/g)).toHaveLength(2);
    expect(html).toContain('class="katex-display"');
    expect(html).toContain('class="msupsub"');
    expect(html).not.toContain("\\(t\\)");
    expect(html).not.toContain("\\[");
  });

  it("keeps escaped, empty, and unclosed bracket delimiters literal", () => {
    const escaped = renderSafeMarkdown(String.raw`literal \\(x\\) and \\[y\\]`);
    const empty = renderSafeMarkdown("\\[\n\n\\]");
    const unclosed = renderSafeMarkdown(String.raw`unclosed \(x`);

    expect(escaped).not.toContain('class="katex"');
    expect(empty).not.toContain('class="katex"');
    expect(unclosed).not.toContain('class="katex"');
  });

  it("keeps unclosed display-math delimiters literal", () => {
    const dollars = renderSafeMarkdown("$$\nx + y");
    const brackets = renderSafeMarkdown("\\[\nx + y");

    expect(dollars).not.toContain('class="katex"');
    expect(dollars).toContain("$$");
    expect(brackets).not.toContain('class="katex"');
    expect(brackets).toContain("x + y");
  });

  it("does not close bracketed math at escaped closing delimiters", () => {
    const html = renderSafeMarkdown(String.raw`
\[
x \\] + y
\]
`);

    expect(html.match(/class="katex"/g)).toHaveLength(1);
    expect(html).toContain('class="katex-display"');
    expect(html).not.toContain("<p>+ y");
  });

  it("keeps bracket delimiters literal inside code", () => {
    const html = renderSafeMarkdown(
      "inline `\\(x_t\\)`\n\n```text\n\\[\nx_t\n\\]\n```",
    );

    expect(html).not.toContain('class="katex"');
    expect(html).toContain("<code>\\(x_t\\)</code>");
    expect(html).toContain("\\[\nx_t\n\\]");
  });

  it("does not treat currency-like $100 and $200 as math", () => {
    const html = renderSafeMarkdown("price is $100 and $200 total");
    expect(html).not.toContain("katex");
    expect(html).toContain("$100");
    expect(html).toContain("$200");
  });

  it("does not treat $ with trailing space as inline math", () => {
    const html = renderSafeMarkdown("single dollar $ followed by text$");
    expect(html).not.toContain("katex");
  });

  it("escapes katex-invalid input as an error span rather than crashing", () => {
    const html = renderSafeMarkdown("bad: $\\undefinedmacro{x}$ done");
    // katex prints the error span itself (has class "katex-error") when
    // throwOnError: false; our sanitize pass strips style attrs it
    // disallows but keeps span+class.
    expect(html).toContain("done");
  });

  it("blocks javascript: hrefs in katex \\href (trust: false)", () => {
    // If trust were left enabled, \href could emit a dangerous link.
    const html = renderSafeMarkdown("$\\href{javascript:alert(1)}{x}$");
    // The rendered output must not produce an executable link href.
    expect(html).not.toMatch(/href="javascript:/i);
  });

  it("still renders non-math markdown unchanged", () => {
    const html = renderSafeMarkdown("**bold** and `code`");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
  });

  it("links existing project files in assistant inline code", () => {
    const html = renderSafeMarkdown(
      "See `topics/security.md:12` and `topics/missing.md`.",
      {
        projectFileLinks: {
          projectId: "project-1",
          projectPath: "/workspace/project",
          fileExists: (_absolutePath, relativePath) =>
            relativePath === "topics/security.md",
        },
      },
    );

    expect(html).toContain(
      'href="/projects/project-1/file?path=topics%2Fsecurity.md&amp;line=12"',
    );
    expect(html).toContain('class="fixed-font-file-link"');
    expect(html).toContain('data-ya-resource="project-file"');
    expect(html).toContain('data-ya-project-id="project-1"');
    expect(html).toContain('data-ya-path="topics/security.md"');
    expect(html).toContain('data-ya-line="12"');
    expect(html).toContain('data-ya-private-project-file-link="true"');
    expect(html).toContain("<code>topics/security.md:12</code>");
    expect(html).toContain("<code>topics/missing.md</code>");
    expect(html).not.toContain("topics%2Fmissing.md");
  });

  it("decides inline-code links from the path trie, not a filesystem call", () => {
    const asked: string[] = [];
    const html = renderSafeMarkdown(
      "See `topics/security.md:12` and `topics/deleted.md`.",
      {
        projectFileLinks: {
          projectId: "project-1",
          projectPath: "/workspace/project",
          index: {
            findExisting: async () => new Set<string>(),
            has: async () => false,
            knownFile: (path: string) => {
              asked.push(path);
              return path === "topics/security.md";
            },
            release: () => undefined,
            sourceRevision: () => 1,
          },
        },
      },
    );

    // Both answers came from the trie, so neither reference reached `statSync`
    // on a path a rendered turn is streaming through.
    expect(asked).toEqual(["topics/security.md", "topics/deleted.md"]);
    expect(html).toContain(
      'href="/projects/project-1/file?path=topics%2Fsecurity.md&amp;line=12"',
    );
    expect(html).toContain("<code>topics/deleted.md</code>");
    expect(html).not.toContain("topics%2Fdeleted.md");
  });

  it("falls back to the filesystem for a path the trie cannot prove", () => {
    // An unproven answer — no live watcher above it — must re-ask rather than
    // silently drop a link the reader sees today.
    const html = renderSafeMarkdown("See `topics/unproven.md`.", {
      projectFileLinks: {
        projectId: "project-1",
        projectPath: "/workspace/project",
        index: {
          findExisting: async () => new Set<string>(),
          has: async () => false,
          knownFile: () => undefined,
          release: () => undefined,
          sourceRevision: () => 1,
        },
        fileExists: (_absolutePath, relativePath) =>
          relativePath === "topics/unproven.md",
      },
    });

    expect(html).toContain("path=topics%2Funproven.md");
  });

  it("leaves inline code unlinked without authenticated project context", () => {
    const html = renderSafeMarkdown("See `topics/security.md`.");

    expect(html).toContain("<code>topics/security.md</code>");
    expect(html).not.toContain("/projects/");
    expect(html).not.toContain("fixed-font-file-link");
  });

  it("strips inline HTML in surrounding prose", () => {
    const html = renderSafeMarkdown("plain <script>bad()</script> $y$ end");
    expect(html).not.toContain("<script>");
    expect(html).toContain('class="katex"');
  });

  it("handles multiple inline math spans in a single call", () => {
    const html = renderSafeMarkdown("$a$ and $b$ and $c$");
    // three independent katex renders
    const count = (html.match(/class="katex"/g) ?? []).length;
    expect(count).toBe(3);
  });

  it("renders inline math inside markdown list items", () => {
    const html = renderSafeMarkdown("- first $x^2$\n- second $y^2$");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>first ");
    const count = (html.match(/class="katex"/g) ?? []).length;
    expect(count).toBe(2);
  });

  it("renders inline math inside markdown table cells", () => {
    const html = renderSafeMarkdown(
      "| expr | value |\n| --- | --- |\n| $x^2$ | $\\frac{1}{2}$ |",
    );
    expect(html).toContain("<table>");
    expect(html).toContain("<td>");
    const count = (html.match(/class="katex"/g) ?? []).length;
    expect(count).toBe(2);
  });

  it("does not leave rendered formulas HTML-escaped in markdown output", () => {
    const html = renderSafeMarkdown("row: $x^2$");
    expect(html).toContain('class="katex"');
    expect(html).not.toContain("&lt;span class=&quot;katex&quot;");
    expect(html).not.toContain("$x^2$");
  });
});

describe("renderSafeMarkdown — embedded HTML", () => {
  it("keeps grouped table spans", () => {
    const html = renderSafeMarkdown(`
<table>
  <thead>
    <tr><th rowspan="2">Runtime</th><th colspan="2">Latency</th></tr>
    <tr><th>Cold</th><th>Warm</th></tr>
  </thead>
  <tbody>
    <tr><td rowspan="2">Desktop</td><td>120 ms</td><td>45 ms</td></tr>
    <tr><td colspan="2">Stable</td></tr>
  </tbody>
</table>
`);

    expect(html).toContain('<th rowspan="2">Runtime</th>');
    expect(html).toContain('<th colspan="2">Latency</th>');
    expect(html).toContain('<td rowspan="2">Desktop</td>');
    expect(html).toContain('<td colspan="2">Stable</td>');
  });

  it("removes active and disallowed markup from embedded HTML", () => {
    const html = renderSafeMarkdown(`
<table onclick="alert(1)">
  <tr>
    <td style="background: url(javascript:alert(1))" onmouseover="alert(1)">
      <a href="javascript:alert(1)">unsafe link</a>
      <img src="data:text/html;base64,PHNjcmlwdD4=" alt="unsafe image">
    </td>
  </tr>
</table>
<script>alert(1)</script>
<iframe src="https://example.com"></iframe>
`);

    expect(html).toContain("unsafe link");
    expect(html).not.toMatch(/<(?:script|iframe)\b/i);
    expect(html).not.toMatch(/\s(?:on\w+|style)=/i);
    expect(html).not.toMatch(/(?:href|src)="(?:javascript|data):/i);
  });

  it("does not admit SVG animation links", () => {
    const html = renderSafeMarkdown(`
<svg>
  <a href="#safe">
    <animate
      attributeName="href"
      values="#safe;javascript:alert(1)"
      dur="1ms"
      fill="freeze"
    ></animate>
    <text>open</text>
  </a>
</svg>
`);

    expect(html).not.toMatch(/<(?:svg|animate|text)\b/i);
  });

  it("does not admit raw-text tags that can bypass sanitizer parsing", () => {
    const html = renderSafeMarkdown(`
<textarea></textarea/><img src=x onerror="alert(document.domain)">
<xmp></xmp/><img src=x onerror="alert(document.domain)">
`);

    expect(html).not.toMatch(/<(?:textarea|xmp|img)\b/i);
    expect(html).toContain("&lt;textarea&gt;");
    expect(html).toContain("&lt;xmp&gt;");
  });
});

describe("parseMarkdownSourceSpans", () => {
  it("maps headings, table rows, references, and math to exact source lines", () => {
    const markdown = [
      "# Heading",
      "",
      "paragraph",
      "",
      "| a | b |",
      "| - | - |",
      "| c | d |",
      "",
      "[later][ref]",
      "",
      "[ref]: https://example.com",
      "",
      "\\[",
      "x + y",
      "\\]",
    ].join("\n");

    const spans = parseMarkdownSourceSpans(markdown);
    expect(
      spans
        .filter((span) =>
          [
            "heading_open",
            "paragraph_open",
            "table_open",
            "tr_open",
            "reference_definition",
            "math_block",
          ].includes(span.type),
        )
        .map(({ type, startLine, endLine }) => ({ type, startLine, endLine })),
    ).toEqual([
      { type: "heading_open", startLine: 1, endLine: 1 },
      { type: "paragraph_open", startLine: 3, endLine: 3 },
      { type: "table_open", startLine: 5, endLine: 7 },
      { type: "tr_open", startLine: 5, endLine: 5 },
      { type: "tr_open", startLine: 7, endLine: 7 },
      { type: "paragraph_open", startLine: 9, endLine: 9 },
      { type: "reference_definition", startLine: 11, endLine: 11 },
      { type: "math_block", startLine: 13, endLine: 15 },
    ]);
  });

  it("keeps one-based line maps accurate across CRLF and Unicode", () => {
    const spans = parseMarkdownSourceSpans("α heading\r\n\r\nβ paragraph\r\n");
    const paragraphs = spans.filter((span) => span.type === "paragraph_open");

    expect(paragraphs).toMatchObject([
      { startLine: 1, endLine: 1 },
      { startLine: 3, endLine: 3 },
    ]);
  });
});

describe("renderSafeMarkdown — local file links", () => {
  it("routes local Quarto Markdown links through rendered file viewing", () => {
    const html = renderSafeMarkdown("[report](/tmp/report.qmd)");

    expect(html).toContain(
      'href="/api/local-file?path=%2Ftmp%2Freport.qmd&amp;render=1"',
    );
    expect(html).toContain('data-ya-render-markdown="true"');
  });

  it("routes local markdown links through the rendered text file endpoint", () => {
    const html = renderSafeMarkdown("[notes](/tmp/session-notes.md)");

    expect(html).toContain(
      'href="/api/local-file?path=%2Ftmp%2Fsession-notes.md&amp;render=1"',
    );
    expect(html).toContain('data-ya-resource="local-file"');
    expect(html).toContain('data-ya-path="/tmp/session-notes.md"');
    expect(html).toContain('data-ya-render-markdown="true"');
    expect(html).not.toContain("/api/local-image");
  });

  it("keeps line hints out of local markdown link paths", () => {
    const html = renderSafeMarkdown("[notes](/tmp/session-notes.md:8)");

    expect(html).toContain(
      'href="/api/local-file?path=%2Ftmp%2Fsession-notes.md&amp;render=1&amp;line=8"',
    );
    expect(html).toContain('title="/tmp/session-notes.md:8"');
    expect(html).toContain('data-ya-line="8"');
    expect(html).not.toContain("session-notes.md%3A8");
  });

  it("adds semantic metadata to local text file links", () => {
    const html = renderSafeMarkdown(
      "[probe json](C:/tmp/playbox-zero-g-compare.json:12:4)",
    );

    expect(html).toContain(
      'href="/api/local-file?path=C%3A%2Ftmp%2Fplaybox-zero-g-compare.json&amp;line=12&amp;column=4"',
    );
    expect(html).toContain('data-ya-resource="local-file"');
    expect(html).toContain('data-ya-path="C:/tmp/playbox-zero-g-compare.json"');
    expect(html).toContain('data-ya-line="12"');
    expect(html).toContain('data-ya-column="4"');
    expect(html).toContain('data-ya-render-markdown="false"');
  });

  it("keeps local media links on the media endpoint", () => {
    const html = renderSafeMarkdown("[shot](/tmp/screenshot.png)");

    expect(html).toContain(
      'href="/api/local-image?path=%2Ftmp%2Fscreenshot.png"',
    );
    expect(html).toContain('class="local-media-link"');
    expect(html).toContain('class="local-media-inline-toggle"');
    expect(html).toContain('class="local-media-inline-preview"');
    expect(html).toContain('data-expanded="false"');
    expect(html).toContain('aria-label="Expand image"');
    expect(html).toContain('data-ya-resource="local-media"');
    expect(html).toContain('data-ya-path="/tmp/screenshot.png"');
    expect(html).toContain('data-ya-media-type="image"');
  });

  it("starts local video media placeholders collapsed", () => {
    const html = renderSafeMarkdown("[clip](/tmp/demo.mp4)");

    expect(html).toContain('href="/api/local-image?path=%2Ftmp%2Fdemo.mp4"');
    expect(html).toContain('class="local-media-link"');
    expect(html).toContain('data-media-type="video"');
    expect(html).toContain('data-expanded="false"');
    expect(html).toContain('aria-label="Expand video"');
    expect(html).toContain('data-ya-media-type="video"');
  });

  it.each([
    ["apng", "image"],
    ["avif", "image"],
    ["bmp", "image"],
    ["gif", "image"],
    ["ico", "image"],
    ["jpeg", "image"],
    ["jpg", "image"],
    ["png", "image"],
    ["svg", "image"],
    ["tif", "image"],
    ["tiff", "image"],
    ["webp", "image"],
    ["avi", "video"],
    ["mkv", "video"],
    ["mov", "video"],
    ["mp4", "video"],
    ["ogv", "video"],
    ["webm", "video"],
  ])("recognizes .%s as local %s media", (extension, mediaType) => {
    const html = renderSafeMarkdown(
      `[asset](/tmp/rendered-media.${extension})`,
    );

    expect(html).toContain('data-ya-resource="local-media"');
    expect(html).toContain(`data-ya-media-type="${mediaType}"`);
  });

  it("resolves relative local file links against a base directory", () => {
    const html = renderSafeMarkdown("[peer](docs/peer.md)", {
      localFileBasePath: "/workspace/project",
    });

    expect(html).toContain(
      'href="/api/local-file?path=%2Fworkspace%2Fproject%2Fdocs%2Fpeer.md&amp;render=1"',
    );
    expect(html).toContain('title="/workspace/project/docs/peer.md"');
    expect(html).toContain('data-ya-path="/workspace/project/docs/peer.md"');
  });

  it("preserves line hints on relative local file links", () => {
    const html = renderSafeMarkdown("[peer](docs/peer.md:12)", {
      localFileBasePath: "/workspace/project",
    });

    expect(html).toContain(
      'href="/api/local-file?path=%2Fworkspace%2Fproject%2Fdocs%2Fpeer.md&amp;render=1&amp;line=12"',
    );
    expect(html).toContain('title="/workspace/project/docs/peer.md:12"');
  });

  it("routes project-contained authored links through FileViewer", () => {
    const html = renderSafeMarkdown("[peer](docs/peer.md:12)", {
      localFileBasePath: "/workspace/project",
      projectFileLinks: {
        projectId: "project-1",
        projectPath: "/workspace/project",
        fileExists: (_absolutePath, relativePath) =>
          relativePath === "docs/peer.md",
      },
    });

    expect(html).toContain(
      'href="/projects/project-1/file?path=docs%2Fpeer.md&amp;line=12"',
    );
    expect(html).toContain('data-ya-resource="project-file"');
    expect(html).toContain('data-ya-path="docs/peer.md"');
    expect(html).not.toContain("data-ya-private-project-file-link");
    expect(html).not.toContain("/api/local-file");
  });

  it("resolves relative local images as inline media placeholders", () => {
    const html = renderSafeMarkdown("![diagram](assets/diagram.svg)", {
      localFileBasePath: "/workspace/project/docs",
    });

    expect(html).toContain(
      'href="/api/local-image?path=%2Fworkspace%2Fproject%2Fdocs%2Fassets%2Fdiagram.svg"',
    );
    expect(html).toContain(
      'data-media-path="/workspace/project/docs/assets/diagram.svg"',
    );
    expect(html).toContain('class="local-media-inline-preview"');
  });

  it("resolves extensionless document images to bounded format candidates", () => {
    const probed: string[] = [];
    const options = {
      localFileBasePath: "/workspace/project/docs",
      projectFileLinks: {
        projectId: "project-1",
        projectPath: "/workspace/project",
        fileExists: (_absolutePath: string, relativePath: string) => {
          probed.push(relativePath);
          return relativePath === "docs/assets/frontier.png";
        },
      },
    };

    const placeholder = renderSafeMarkdown(
      "![frontier](assets/frontier)",
      options,
    );
    const direct = renderSafeMarkdown("![frontier](assets/frontier)", {
      ...options,
      inlineLocalImages: true,
    });

    expect(probed.slice(0, 2)).toEqual([
      "docs/assets/frontier.svg",
      "docs/assets/frontier.png",
    ]);
    expect(placeholder).toContain(
      'data-media-path="/workspace/project/docs/assets/frontier.png"',
    );
    expect(direct).toContain(
      'src="/api/local-image?path=%2Fworkspace%2Fproject%2Fdocs%2Fassets%2Ffrontier.png"',
    );
    expect(direct).toContain(
      'data-ya-path="/workspace/project/docs/assets/frontier.png"',
    );
  });

  it("prefers SVG when an extensionless document image has several formats", () => {
    const html = renderSafeMarkdown("![frontier](assets/frontier)", {
      localFileBasePath: "/workspace/project/docs",
      projectFileLinks: {
        projectId: "project-1",
        projectPath: "/workspace/project",
        fileExists: (_absolutePath, relativePath) =>
          relativePath === "docs/assets/frontier.svg" ||
          relativePath === "docs/assets/frontier.png",
      },
    });

    expect(html).toContain(
      'data-media-path="/workspace/project/docs/assets/frontier.svg"',
    );
    expect(html).not.toContain("frontier.png");
  });

  it("can emit direct local images for standalone rendered documents", () => {
    const html = renderSafeMarkdown("![diagram](assets/diagram.svg)", {
      localFileBasePath: "/workspace/project/docs",
      inlineLocalImages: true,
    });

    expect(html).toContain(
      '<img src="/api/local-image?path=%2Fworkspace%2Fproject%2Fdocs%2Fassets%2Fdiagram.svg" alt="diagram"',
    );
    expect(html).toContain(
      'data-ya-path="/workspace/project/docs/assets/diagram.svg"',
    );
    expect(html).toContain('data-ya-resource="local-media"');
    expect(html).not.toContain("local-media-inline-preview");
  });

  it("rewrites Windows drive paths with forward slashes to local media links", () => {
    const html = renderSafeMarkdown(
      "[Sample image](C:/tmp/playbox-autocollider-provider-fit.png)",
    );

    expect(html).toContain('class="local-media-link"');
    expect(html).toContain('data-media-type="image"');
    expect(html).toContain(
      "path=C%3A%2Ftmp%2Fplaybox-autocollider-provider-fit.png",
    );
  });

  it("recognizes Windows drive paths with backslashes", () => {
    const filePath = String.raw`C:\tmp\playbox-autocollider-provider-fit.png`;

    expect(isLocalFilePath(filePath)).toBe(true);
    expect(localMediaApiUrl(filePath)).toBe(
      "/api/local-image?path=C%3A%5Ctmp%5Cplaybox-autocollider-provider-fit.png",
    );
  });

  it("repairs backslash drive paths before Markdown consumes escapes", () => {
    const html = renderSafeMarkdown(
      String.raw`[capture](D:\repo\.artifacts\ui-testing\capture.png)`,
    );

    expect(html).toContain(
      "path=D%3A%2Frepo%2F.artifacts%2Fui-testing%2Fcapture.png",
    );
    expect(html).toContain(
      'data-ya-path="D:/repo/.artifacts/ui-testing/capture.png"',
    );
    expect(html).not.toContain("repo.artifacts");
  });

  it("repairs angle-enclosed image paths with spaces on any drive", () => {
    const html = renderSafeMarkdown(
      String.raw`![capture](<E:\folder with spaces\.artifacts\capture.png>)`,
    );

    expect(html).toContain(
      "path=E%3A%2Ffolder%20with%20spaces%2F.artifacts%2Fcapture.png",
    );
    expect(html).toContain(
      'data-ya-path="E:/folder with spaces/.artifacts/capture.png"',
    );
  });

  it("preserves line hints and titles on repaired local-file links", () => {
    const html = renderSafeMarkdown(
      String.raw`[report](F:\repo\.artifacts\report.md:12:4 "details")`,
    );

    expect(html).toContain(
      "path=F%3A%2Frepo%2F.artifacts%2Freport.md&amp;render=1&amp;line=12&amp;column=4",
    );
    expect(html).toContain('title="details"');
    expect(html).toContain('data-ya-line="12"');
    expect(html).toContain('data-ya-column="4"');
  });

  it("repairs drive paths supplied by reference definitions", () => {
    const html = renderSafeMarkdown(String.raw`[capture][artifact]

[artifact]: G:\repo\.artifacts\capture.png`);

    expect(html).toContain("path=G%3A%2Frepo%2F.artifacts%2Fcapture.png");
    expect(html).toContain('data-ya-path="G:/repo/.artifacts/capture.png"');
  });

  it("does not rewrite Windows-looking links inside code", () => {
    const markdown = [
      "Inline: `[capture](H:\\repo\\.artifacts\\capture.png)`",
      "",
      "```text",
      "[capture](H:\\repo\\.artifacts\\capture.png)",
      "```",
    ].join("\n");
    const html = renderSafeMarkdown(markdown);

    expect(html).toContain(
      String.raw`<code>[capture](H:\repo\.artifacts\capture.png)</code>`,
    );
    expect(html).toContain(
      String.raw`[capture](H:\repo\.artifacts\capture.png)`,
    );
    expect(html).not.toContain("/api/local-image?path=H");
  });

  it("does not broaden drive-path handling to UNC paths", () => {
    const html = renderSafeMarkdown(
      String.raw`[capture](\\server\share\.artifacts\capture.png)`,
    );

    expect(html).not.toContain("/api/local-image");
    expect(html).not.toContain("data-ya-resource");
  });
});

describe("renderSafeMarkdown — Quarto includes", () => {
  const projectOptions = {
    localFileBasePath: "/workspace/project/chapters",
    projectFileLinks: {
      projectId: "project-1",
      projectPath: "/workspace/project",
      fileExists: (_absolutePath: string, relativePath: string) =>
        relativePath === "chapters/_introduction.qmd" ||
        relativePath === "shared/_methods.md",
    },
    quartoMarkdown: true,
  };

  it("renders a document-relative include as a project FileViewer link", () => {
    const html = renderSafeMarkdown(
      "{{< include _introduction.qmd >}}",
      projectOptions,
    );

    expect(html).toContain("<p>Include: ");
    expect(html).toContain(
      'href="/projects/project-1/file?path=chapters%2F_introduction.qmd"',
    );
    expect(html).toContain('data-ya-resource="project-file"');
    expect(html).toContain("<code>_introduction.qmd</code>");
  });

  it("resolves a leading slash from the Quarto project root", () => {
    const html = renderSafeMarkdown(
      "{{< include /shared/_methods.md >}}",
      projectOptions,
    );

    expect(html).toContain(
      'href="/projects/project-1/file?path=shared%2F_methods.md"',
    );
    expect(html).toContain("<code>/shared/_methods.md</code>");
  });

  it("leaves the include syntax inert outside Quarto documents", () => {
    const html = renderSafeMarkdown("{{< include _introduction.qmd >}}", {
      ...projectOptions,
      quartoMarkdown: false,
    });

    expect(html).toContain("{{&lt; include _introduction.qmd &gt;}}");
    expect(html).not.toContain("data-ya-resource");
  });

  it("does not recognize includes inside fenced code or prose", () => {
    const fenced = renderSafeMarkdown(
      "```markdown\n{{< include _introduction.qmd >}}\n```",
      projectOptions,
    );
    const prose = renderSafeMarkdown(
      "Before\n{{< include _introduction.qmd >}}\nAfter",
      projectOptions,
    );

    expect(fenced).toContain("{{&lt; include _introduction.qmd &gt;}}");
    expect(fenced).not.toContain("data-ya-resource");
    expect(prose).toContain("{{&lt; include _introduction.qmd &gt;}}");
    expect(prose).not.toContain("data-ya-resource");
  });

  it("keeps unauthorized and non-file targets literal", () => {
    for (const target of [
      "missing.qmd",
      "../private.qmd",
      "/../private.qmd",
      "https://x.test/a.qmd",
    ]) {
      const html = renderSafeMarkdown(
        `{{< include ${target} >}}`,
        projectOptions,
      );

      expect(html).toContain(`<code>{{&lt; include ${target} &gt;}}</code>`);
      expect(html).not.toContain("data-ya-resource");
      expect(html).not.toContain("/api/local-file");
    }
  });
});
