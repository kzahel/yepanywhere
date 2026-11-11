import type MarkdownIt from "markdown-it";
import type { CitationRenderOptions } from "./citation-sources.js";
import { escapeHtml } from "./markdown-html-escaping.js";

const OPEN = "\uE200cite\uE202";
const CLOSE = "\uE201";
const SOURCE_ID = /^turn\d+[a-z]+\d+$/i;

/** Inline rule respects Markdown code spans/fences and never nests anchors. */
export function installMarkdownCitations(
  md: ReturnType<typeof MarkdownIt>,
  options: () => CitationRenderOptions,
): void {
  const textRule = md.inline.ruler.getRules("")[0];
  if (!textRule) throw new Error("Missing Markdown inline text rule");
  const nextMarker = new WeakMap<object, number>();
  md.inline.ruler.at("text", (state, silent) => {
    let start = nextMarker.get(state);
    if (start === undefined || (start >= 0 && start < state.pos)) {
      start = state.src.indexOf(OPEN, state.pos);
      nextMarker.set(state, start);
    }
    if (start < 0 || start >= state.posMax || state.linkLevel > 0)
      return textRule(state, silent);
    if (start > state.pos) {
      const end = state.posMax;
      state.posMax = start;
      try {
        return textRule(state, silent);
      } finally {
        state.posMax = end;
      }
    }
    const end = state.src.indexOf(CLOSE, start + OPEN.length);
    if (end < 0 || end >= state.posMax || end - start > 2048)
      return textRule(state, silent);
    const fields = state.src.slice(start + OPEN.length, end).split("\uE202");
    const locator = fields.at(-1)?.match(/^L\d+(?:-L\d+)?$/)
      ? fields.pop()
      : undefined;
    if (!fields.length || !fields.every((field) => SOURCE_ID.test(field)))
      return textRule(state, silent);
    if (!silent) {
      const token = state.push("ya_citation", "", 0);
      token.meta = { ids: fields, locator };
    }
    state.pos = end + CLOSE.length;
    return true;
  });
  md.renderer.rules.ya_citation = (tokens, index) => {
    const { ids, locator } = tokens[index]!.meta as {
      ids: string[];
      locator?: string;
    };
    return ids
      .map((id) => {
        const source = options().citationSources?.get(id);
        if (!source)
          return `[${escapeHtml(id)}${locator ? ` ${escapeHtml(locator)}` : ""}]`;
        let url: URL;
        try {
          url = new URL(source.url);
        } catch {
          return `[${escapeHtml(id)}]`;
        }
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          return `[${escapeHtml(id)}]`;
        const label = url.hostname.replace(/^www\./, "");
        const title = `${source.title || label}${locator ? ` · ${locator}` : ""}`;
        return `<a href="${escapeHtml(source.url)}" title="${escapeHtml(title)}">[${escapeHtml(label)}]</a>`;
      })
      .join(" ");
  };
}
