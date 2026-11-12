import { describe, expect, it } from "vitest";
import { toUrlProjectId } from "@yep-anywhere/shared";
import {
  preparePublicMarkdownCopy,
  renderPublicMarkdownCopy,
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
