import { describe, expect, it } from "vitest";
import { toUrlProjectId } from "@yep-anywhere/shared";
import {
  preparePublicMarkdownCopy,
  renderPublicMarkdownCopy,
  copyFileKey,
} from "../publicMarkdownCopy";

const projectId = toUrlProjectId("/work/project");
const otherId = toUrlProjectId("/work/other");
const projects = [
  { id: projectId, path: "/work/project" },
  { id: otherId, path: "/work/other" },
];
function prepare(markdown: string, html = "") {
  const element = document.createElement("div");
  element.innerHTML = html;
  return preparePublicMarkdownCopy(
    [
      {
        markdown,
        selectedText: markdown,
        sourceElement: element,
        range: document.createRange(),
      },
    ],
    projects,
    "https://ya.example/projects/p/sessions/s",
  );
}
const apps = new Map([
  [
    projectId,
    {
      baseUrl: "https://project.example/?ya_access=token",
      pathTemplate: "/view?path={pathQuery}",
    },
  ],
]);

describe("public Markdown copy", () => {
  it("keeps prose punctuation outside paths and decodes destinations only", () => {
    const result = renderPublicMarkdownCopy(
      prepare(
        "See (/work/project/a.md). [space](/work/project/a%20b.md) and `/work/project/a%20b.md`",
      ),
      apps,
    );
    expect(result.markdown).toContain(
      "See ([/work/project/a.md](<https://project.example/view?path=a.md&ya_access=token>)).",
    );
    expect(result.markdown).toContain(
      "[space](<https://project.example/view?path=a+b.md&ya_access=token>)",
    );
    expect(result.markdown).toContain("path=a%2520b.md");
  });
  it("leaves nested fences, indented code and foreign protocol-relative links alone", () => {
    for (const source of [
      "> ```sh\n> cat /work/project/a.md\n> ```",
      "- ```sh\n  cat /work/project/a.md\n  ```",
      "    cat /work/project/a.md",
      `[foreign](//foreign.example/projects/${projectId}/file?path=a.md)`,
    ])
      expect(renderPublicMarkdownCopy(prepare(source), apps).markdown).toBe(
        source,
      );
  });
  it("leaves ambiguous rendered aliases local instead of using another project's path", () => {
    const source = "`src/a.md` and `src/a.md`";
    const copy = prepare(
      source,
      `<a href="/projects/${projectId}/file?path=src/a.md">src/a.md</a><a href="/projects/${otherId}/file?path=src/a.md">src/a.md</a>`,
    );
    expect(renderPublicMarkdownCopy(copy, apps).markdown).toBe(source);
  });
  it("uses the file-share viewer's line query while retaining its routing fragment", () => {
    const copy = prepare("[range](/work/other/a.md:12-15)");
    const file = copy.references[0]!.file;
    const result = renderPublicMarkdownCopy(
      copy,
      apps,
      new Map([
        [
          copyFileKey(file),
          "https://ya.example/share/key/file?path=a.md#v=2&target=file",
        ],
      ]),
    );
    expect(result.markdown).toBe(
      "[range](<https://ya.example/share/key/file?path=a.md&line=12&lineEnd=15#v=2&target=file>)",
    );
  });
  it("rewrites viewer destinations, preserves labels and citations, and keeps unmapped paths local", () => {
    const source = `[the report](http://localhost:3400/projects/${projectId}/file?path=docs%2Freport.md&line=12&lineEnd=15) and [other](</work/other/note.md>)`;
    const result = renderPublicMarkdownCopy(prepare(source), apps);
    expect(result.markdown).toBe(
      "[the report](<https://project.example/view?path=docs%2Freport.md&ya_access=token#L12-L15>) and [other](</work/other/note.md>)",
    );
    expect(result.unresolved).toMatchObject([
      { projectId: otherId, path: "note.md" },
    ]);
    expect(result.appProjects).toEqual([projectId]);
  });
  it("recovers home aliases from rendered path metadata and preserves ordinary Markdown", () => {
    const result = renderPublicMarkdownCopy(
      prepare(
        "Use `~/project/docs/a.md` and **keep this**.",
        `<a href="/projects/${projectId}/file?path=docs%2Fa.md">~/project/docs/a.md</a>`,
      ),
      apps,
    );
    expect(result.markdown).toBe(
      "Use [`~/project/docs/a.md`](<https://project.example/view?path=docs%2Fa.md&ya_access=token>) and **keep this**.",
    );
  });
  it("does not turn code blocks, images, arbitrary external viewer lookalikes or revisions into live public links", () => {
    const source = `\`\`\`sh\ncat /work/project/a.md\n\`\`\`\n![image](/work/project/a.png)\n[external](https://other.example/projects/${projectId}/file?path=a.md)\n[revision](/projects/${projectId}/file?path=a.md&rev=HEAD~1)`;
    expect(renderPublicMarkdownCopy(prepare(source), apps).markdown).toBe(
      source,
    );
  });
  it("handles spaces and parentheses in destinations, query encoding and fragments", () => {
    const result = renderPublicMarkdownCopy(
      prepare(
        "[a](</work/project/docs/a (b).md#section>) and [b](/work/project/docs/a(b).md)",
      ),
      apps,
    );
    expect(result.markdown).toContain(
      "path=docs%2Fa+%28b%29.md&ya_access=token#section",
    );
    expect(result.markdown).toContain(
      "path=docs%2Fa%28b%29.md&ya_access=token",
    );
  });
  it("uses the deepest registered project and deduplicates repeated file shares", () => {
    const nested = toUrlProjectId("/work/project/sub");
    const element = document.createElement("div");
    const copy = preparePublicMarkdownCopy(
      [
        {
          markdown:
            "[one](/work/project/sub/a.md) [two](/work/project/sub/a.md)",
          selectedText: "one two",
          sourceElement: element,
          range: document.createRange(),
        },
      ],
      [...projects, { id: nested, path: "/work/project/sub" }],
      "https://ya.example",
    );
    const result = renderPublicMarkdownCopy(copy, apps);
    expect(result.unresolved).toMatchObject([
      { projectId: nested, path: "a.md" },
    ]);
    expect(result.appProjects).toEqual([]);
  });
  it("rewrites reference definitions without changing their labels or titles", () => {
    const result = renderPublicMarkdownCopy(
      prepare('[a][doc]\n\n[doc]: </work/project/a.md#part> "A title"'),
      apps,
    );
    expect(result.markdown).toBe(
      '[a][doc]\n\n[doc]: <https://project.example/view?path=a.md&ya_access=token#part> "A title"',
    );
  });
  it("keeps unfinished code fences literal and preserves viewer fragments", () => {
    const source = "```sh\ncat /work/project/a.md";
    expect(renderPublicMarkdownCopy(prepare(source), apps).markdown).toBe(
      source,
    );
    const href = `/projects/${projectId}/file?path=a.md#part`;
    expect(
      renderPublicMarkdownCopy(
        prepare(`[a](${href})`, `<a href="${href}">a</a>`),
        apps,
      ).markdown,
    ).toContain("#part>");
  });
});
