import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  isLocalFilePath,
  localMediaApiUrl,
  parseMarkdownSourceSpans,
  renderSafeMarkdown,
} from "../../src/augments/safe-markdown.js";

const serverRequire = createRequire(import.meta.url);

function releaseParts(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Whether an installed version satisfies a declared dependency spec. The
 * server declares either an exact pin or a caret range, and a caret pins the
 * leftmost nonzero component: `^0.18.6` admits 0.18.7 but not 0.19.0.
 */
function satisfiesDependencySpec(version: string, spec: string): boolean {
  if (!spec.startsWith("^")) return version === spec;
  const installed = releaseParts(version);
  const floor = releaseParts(spec.slice(1));
  if (!installed || !floor) return false;
  const leadingNonzero = floor.findIndex((part) => part !== 0);
  const pinned = leadingNonzero === -1 ? 2 : leadingNonzero;
  for (let i = 0; i <= pinned; i += 1) {
    if (installed[i] !== floor[i]) return false;
  }
  for (const i of [0, 1, 2] as const) {
    if (i > pinned && installed[i] !== floor[i]) {
      return installed[i] > floor[i];
    }
  }
  return true;
}

function declaredDependencySpec(name: string): string {
  const { dependencies } = serverRequire("../../package.json") as {
    dependencies: Record<string, string | undefined>;
  };
  const spec = dependencies[name];
  if (!spec) throw new Error(`${name} is not a declared server dependency`);
  return spec;
}

function installedVersion(name: string): string {
  return serverRequire(`${name}/package.json`).version as string;
}

describe("Markdown plugin dependency resolution", () => {
  it("admits an in-range refresh and rejects one outside the spec", () => {
    expect(satisfiesDependencySpec("0.18.7", "^0.18.6")).toBe(true);
    expect(satisfiesDependencySpec("0.18.5", "^0.18.6")).toBe(false);
    expect(satisfiesDependencySpec("0.19.0", "^0.18.6")).toBe(false);
    expect(satisfiesDependencySpec("1.3.0", "^1.2.3")).toBe(true);
    expect(satisfiesDependencySpec("2.0.0", "^1.2.3")).toBe(false);
    expect(satisfiesDependencySpec("15.0.0", "15.0.0")).toBe(true);
    expect(satisfiesDependencySpec("15.0.1", "15.0.0")).toBe(false);
  });

  it("uses YA's declared markdown-it and KaTeX runtimes", () => {
    const pluginRequire = createRequire(
      serverRequire.resolve("@mdit/plugin-katex"),
    );

    for (const name of ["markdown-it", "katex"]) {
      const spec = declaredDependencySpec(name);
      const version = installedVersion(name);
      expect(
        satisfiesDependencySpec(version, spec),
        `installed ${name} ${version} does not satisfy the declared ${spec}`,
      ).toBe(true);
      expect(realpathSync(pluginRequire.resolve(name))).toBe(
        realpathSync(serverRequire.resolve(name)),
      );
    }
  });
});

describe("renderSafeMarkdown — paper math", () => {
  // Samples from extracted research papers that KaTeX alone rejected.
  it("renders paper commands KaTeX lacks without an error span", () => {
    const html = renderSafeMarkdown(
      String.raw`\(\textsc{Rollout}(M)\) \(1\mbox{ step}\) \(\mathbbm{1}_x\) \(H\textsubscript{2}O\) \(\nicefrac{1}{2}\) \({\color[rgb]{0.7,0,0}\times}\)`,
    );
    expect(html).not.toContain("katex-error");
    expect(html).not.toContain("\\textsc");
    expect(html).toContain("#b30000");
  });

  it("does not let one document's \\gdef reach another document", () => {
    renderSafeMarkdown(String.raw`\(\gdef\alpha{\beta}\alpha\)`);
    expect(renderSafeMarkdown(String.raw`\(\alpha\)`)).toContain("α");
  });

  it("keeps presentation MathML inside raw HTML tables", () => {
    const html = renderSafeMarkdown(
      '<table><tr><th colspan="2">R@1 <math id="x" display="inline"><semantics><mo stretchy="false" onclick="x()">↑</mo><annotation encoding="application/x-tex">\\uparrow</annotation></semantics></math></th></tr></table>',
    );
    expect(html).toContain(
      '<math display="inline"><semantics><mo stretchy="false">↑</mo>',
    );
    expect(html).not.toContain("&lt;math");
    expect(html).not.toContain("onclick");
  });

  it("escapes annotation-xml, which can carry arbitrary markup", () => {
    const html = renderSafeMarkdown(
      '<math><semantics><mi>x</mi><annotation-xml encoding="text/html"><img src="https://e.test/a.png" onerror="alert(1)"></annotation-xml></semantics></math>',
    );
    expect(html).toContain("&lt;annotation-xml");
    expect(html).not.toContain("onerror");
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

describe("renderSafeMarkdown — Unicode scripts", () => {
  it("redraws script runs while keeping the authored glyphs", () => {
    const html = renderSafeMarkdown("compare ∫₁^∞ x⁻ˢ dx");
    expect(html).toContain(
      '<span class="ya-uscript ya-uscript--sub" data-ya-script="1"><span class="ya-uscript__source">₁</span></span>',
    );
    expect(html).toContain(
      '<span class="ya-uscript ya-uscript--sup" data-ya-script="−s"><span class="ya-uscript__source">⁻ˢ</span></span>',
    );
  });

  it("leaves code and plain text untouched", () => {
    expect(renderSafeMarkdown("`nˢ` and it's <b>")).toBe(
      "<p><code>nˢ</code> and it's &lt;b&gt;</p>",
    );
  });
});

describe("renderSafeMarkdown — undelimited Unicode math", () => {
  const regions = (html: string) =>
    [
      ...html.matchAll(
        /<span class="ya-umath__text">(.*?)<\/span><span class="ya-umath__tex">/g,
      ),
    ].map((m) => m[1]?.replace(/<[^>]+>/g, ""));

  it("pairs recognised math with a hidden KaTeX rendering", () => {
    const html = renderSafeMarkdown("Promote the λ=.05 checkpoint.");
    expect(regions(html)).toEqual(["λ=.05"]);
    expect(html).toContain('<span class="ya-umath__tex"><span class="katex">');
  });

  it("keeps the script redraw inside the authored text", () => {
    const html = renderSafeMarkdown(
      "ζ(s) = Σ_{n≥1} 1/nˢ = 1 + 1/2ˢ + 1/3ˢ + …",
    );
    expect(regions(html)).toEqual([
      "ζ(s) = Σ_{n≥1} 1/nˢ = 1 + 1/2ˢ + 1/3ˢ + …",
    ]);
    expect(html).toContain('data-ya-script="s"');
    // Σ with limits is typeset as a summation operator, not a letter.
    expect(html).toContain("op-symbol");
  });

  it("leaves oversized inferred regions intact while typesetting adjacent math", () => {
    const longRegion = "x+y+".repeat(600);
    const html = renderSafeMarkdown(`${longRegion}\n\nPromote λ=.05.`);
    expect(html).toContain(`<p>${longRegion}</p>`);
    expect(regions(html)).toEqual(["λ=.05"]);
  });

  it("skips inference for large prose tokens without losing text or explicit math", () => {
    const generatedText = "Ab9/xy+Z0".repeat(2_000);
    const html = renderSafeMarkdown(`${generatedText}\n\n$x^2$\n\nλ=.05`);
    expect(html).toContain(`<p>${generatedText}</p>`);
    expect(regions(html)).toEqual(["λ=.05"]);
    expect(html.match(/class="katex"/g)).toHaveLength(2);
  });

  it("leaves prose arrows, numeric typography and code alone", () => {
    for (const markdown of [
      "The pipeline goes TeX → UnicodeMath → MathML.",
      "Runs cost 4–6× more and recall rose ±2 points.",
      "Set `next_token = argmax(logits)` before decoding.",
      "The B′ mixture finished.",
    ]) {
      expect(renderSafeMarkdown(markdown)).not.toContain("ya-umath");
    }
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

    // Patched htmlparser2 recognizes the malformed closing tags and exposes
    // the following images to normal sanitization. Images are allowed; raw
    // text elements and executable attributes must still never survive.
    expect(html).not.toMatch(/<(?:textarea|xmp)\b/i);
    expect(html).not.toMatch(/\son\w+\s*=/i);
    expect(html).not.toContain("alert(document.domain)");
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

describe("renderSafeMarkdown — visualize artifacts", () => {
  const marker = (path: unknown) =>
    `\uE200visualize\uE202${JSON.stringify({ path, mode: "wide" })}\uE201`;

  it("links an artifact in prose without interpreting its JSON path as Markdown", () => {
    const path = '/tmp/review _draft_/panel [comparison] #1 & "notes".html';
    const html = renderSafeMarkdown(`Before ${marker(path)} after.`);
    expect(html).toContain(
      `href="/api/local-file?path=${encodeURIComponent(path)}"`,
    );
    expect(html).toContain('data-ya-resource="local-file"');
    expect(html).toContain(
      'panel [comparison] #1 &amp; "notes".html</a> after.',
    );
    expect(html).not.toContain("visualize");
    expect(html).not.toContain("<em>");
    expect(renderSafeMarkdown(marker("C:\\reports\\panel.html"))).toContain(
      'href="/api/local-file?path=C%3A%5Creports%5Cpanel.html"',
    );
  });

  it("keeps code, invalid destinations, incomplete markers and share output inert", () => {
    for (const source of [
      `\`${marker("/tmp/report.html")}\``,
      `\`\`\`text\n${marker("/tmp/report.html")}\n\`\`\``,
      `[${marker("/tmp/report.html")}](https://example.com)`,
      marker("javascript:alert(1)"),
      marker("//example.com/report.html"),
      marker("relative/report.html"),
      marker("/tmp/report.html\n"),
      marker(null),
      "\uE200visualize\uE202{bad json}\uE201",
      '\uE200visualize\uE202{"path":"/tmp/report.html"}',
    ]) {
      expect(renderSafeMarkdown(source)).not.toContain("/api/local-file");
    }
    expect(
      renderSafeMarkdown(marker("/tmp/report.html"), {
        projectFileLinks: {
          projectId: "project",
          projectPath: "/project",
          publicShare: true,
        },
      }),
    ).not.toContain("/api/local-file");
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
    ["aac", "audio"],
    ["flac", "audio"],
    ["m4a", "audio"],
    ["mp3", "audio"],
    ["oga", "audio"],
    ["ogg", "audio"],
    ["opus", "audio"],
    ["wav", "audio"],
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

  it("follows a link that climbs out of the document's folder", () => {
    const html = renderSafeMarkdown("[topic](../topics/speech-mt.md)", {
      localFileBasePath: "/workspace/project/research",
    });

    expect(html).toContain(
      'href="/api/local-file?path=%2Fworkspace%2Fproject%2Ftopics%2Fspeech-mt.md&amp;render=1"',
    );
  });

  it("keeps site-relative references as written for a served document", () => {
    const html = renderSafeMarkdown(
      "[topic](../topics/x.md#intro) ![fig](figs/a.png) [top](#top)",
      { siteRelativeReferences: true },
    );

    expect(html).toContain('href="../topics/x.md#intro"');
    expect(html).toContain('<img src="figs/a.png" alt="fig" />');
    expect(html).toContain('href="#top"');
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

describe("renderSafeMarkdown — URLs in fixed-font contexts", () => {
  it("links a URL inside a fenced block without altering the text", () => {
    const html = renderSafeMarkdown(
      "```\nopen http://artifacts.localhost:3400/a/tok/index.html now\n```",
    );
    expect(html).toContain(
      '<a href="http://artifacts.localhost:3400/a/tok/index.html">http://artifacts.localhost:3400/a/tok/index.html</a>',
    );
    expect(html).toContain("<pre><code>open ");
    expect(html).toContain(" now\n</code></pre>");
  });

  it("keeps the language class and escapes the rest of the block", () => {
    const html = renderSafeMarkdown(
      '```bash\ncurl "https://example.test/a?b=1&c=2" <x>\n```',
    );
    expect(html).toContain('<code class="language-bash">');
    expect(html).toContain(
      '<a href="https://example.test/a?b=1&amp;c=2">https://example.test/a?b=1&amp;c=2</a>',
    );
    expect(html).toContain("&lt;x&gt;");
  });

  it("links a URL in inline code", () => {
    const html = renderSafeMarkdown("try `https://example.test/x` first");
    expect(html).toContain(
      '<code><a href="https://example.test/x">https://example.test/x</a></code>',
    );
  });

  it("keeps a code anchor in the same document", () => {
    const html = renderSafeMarkdown("try `https://example.test/x` first");
    expect(html).not.toContain("target=");
    expect(html).not.toContain("rel=");
  });

  it("leaves a non-web scheme and ordinary code alone", () => {
    const html = renderSafeMarkdown(
      "```\njavascript:alert(1) and file:///etc/passwd and const x = 1;\n```",
    );
    expect(html).not.toContain("<a ");
    expect(html).toContain("const x = 1;");
  });
});

describe("renderSafeMarkdown — document anchors", () => {
  const asDocument = { documentAnchors: {} };

  it("links explicit targets and headings under the user-content prefix", () => {
    const html = renderSafeMarkdown(
      `| row | evidence |
| --- | --- |
| <a id="row-f"></a>F | [see](#evidence-for-f) |

## Evidence for \`f\`

Back to [the row](#row-f).
`,
      asDocument,
    );

    expect(html).toContain('<a id="user-content-row-f"></a>');
    expect(html).toContain('<h2 id="user-content-evidence-for-f">');
    expect(html).toContain('<a href="#user-content-evidence-for-f">see</a>');
    expect(html).toContain('<a href="#user-content-row-f">the row</a>');
  });

  it("numbers duplicate headings and continues preceding slugs", () => {
    const html = renderSafeMarkdown("# Notes\n\n# Notes\n\n# Notes-1\n", {
      documentAnchors: { precedingHeadingSlugs: ["notes"] },
    });

    expect(html).toContain('<h1 id="user-content-notes-1">');
    expect(html).toContain('<h1 id="user-content-notes-2">');
    expect(html).toContain('<h1 id="user-content-notes-1-1">');
  });

  it("prefixes hostile ids, legacy names and raw HTML fragment links", () => {
    const html = renderSafeMarkdown(
      `<a id="root"></a><a name="old"></a><h3 id="app">App</h3>

<a href="#root">raw</a> and <a id="has space" href="#">empty</a>
`,
      asDocument,
    );

    expect(html).toContain('<a id="user-content-root"></a>');
    expect(html).toContain('<a id="user-content-old"></a>');
    expect(html).toContain('<h3 id="user-content-app">');
    expect(html).toContain('<a href="#user-content-root">raw</a>');
    expect(html).toContain('<a href="#">empty</a>');
    expect(html).not.toMatch(/\sid="(?:root|app|has space)"/);
    expect(html).not.toContain("name=");
  });

  it("keeps message fragments free of ids", () => {
    const html = renderSafeMarkdown(
      '<a id="row-f"></a>\n\n## Heading\n\n[back](#row-f)\n',
    );

    expect(html).not.toContain("id=");
    expect(html).not.toContain('href="#');
    expect(html).toContain("back");
  });
});
