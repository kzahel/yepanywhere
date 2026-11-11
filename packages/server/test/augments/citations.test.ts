import { describe, expect, it } from "vitest";
import {
  CitationSources,
  citationOptionsForText,
} from "../../src/augments/citation-sources.js";
import {
  augmentTextBlocks,
  renderMarkdownToHtml,
  observeMarkdownAugmentCache,
} from "../../src/augments/markdown-augments.js";
import { augmentPersistedSessionMessages } from "../../src/sessions/persisted-augments.js";
import { createStreamAugmenter } from "../../src/augments/stream-augmenter.js";
import type { Message } from "../../src/supervisor/types.js";

const ref = "turn553176search1";
const marker = `\uE200cite\uE202${ref}\uE201`;
const url =
  "https://docs.cloud.google.com/appengine/docs/standard/testing-and-deploying-your-app?tab=go";
const raw = `Test and deploy your application (${url})\n【${ref}】 [wordlim: 200] Crawled: last week; During deployment, Cloud Build builds a container.`;
const result = (content: unknown, structured?: unknown): Message => ({
  uuid: "result",
  type: "user",
  message: {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "web", content: content as string },
    ],
  },
  ...(structured ? { toolUseResult: structured } : {}),
});
const answer = (
  text = `App Engine builds a container. ${marker}`,
): Message => ({
  uuid: "answer",
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const htmlOf = (message: Message) =>
  (message.message!.content as Array<{ _html?: string }>)[0]?._html;

describe("web citations through real markdown augmentation", () => {
  it("resolves code-mode/MCP JSON and normalized Web pages in persisted and direct batch rendering", async () => {
    const encoded = JSON.stringify({
      content: [{ type: "text", text: raw }],
    }).replace(
      /[\u0080-\uffff]/g,
      (character) =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
    const printed = `Script completed\nOutput:\n${encoded}\n${JSON.stringify({ output: "unrelated" })}`;
    const messages = [result(printed), answer()];
    await augmentPersistedSessionMessages(messages);
    expect(htmlOf(messages[1]!)).toContain(`href="${url}"`);
    expect(htmlOf(messages[1]!)).toContain(
      'title="Test and deploy your application"',
    );
    expect(htmlOf(messages[1]!)).toContain("[docs.cloud.google.com]</a>");
    const normalized = [
      result("marker-cleaned prose", {
        pages: [{ ref, url, title: "Normalized title" }],
      }),
      answer(),
    ];
    await augmentTextBlocks(normalized);
    expect(htmlOf(normalized[1]!)).toContain('title="Normalized title"');
    expect(htmlOf(normalized[1]!)).not.toContain("\uE200");
  });

  it("resolves split streamed markers and the finalized answer identically", async () => {
    const html: string[] = [];
    const stream = await createStreamAugmenter({
      onMarkdownAugment: (e) => html.push(e.html),
      onPending: () => {},
    });
    await stream.processMessage(
      result(raw) as unknown as Record<string, unknown>,
    );
    await stream.processStreamingMessage({
      type: "assistant",
      uuid: "live",
      _isStreaming: true,
      content: "Claim. \uE200ci",
    });
    await stream.processStreamingMessage({
      type: "assistant",
      uuid: "live",
      _isStreaming: true,
      content: `Claim. ${marker}`,
    });
    await stream.flush();
    const final = answer(`Claim. ${marker}`);
    const augmented = await stream.processFinalizedMessage(
      final as unknown as Record<string, unknown>,
    );
    expect(html.join("")).toContain(`href="${url}"`);
    expect(augmented?.html).toBe(html.at(-1));
  });

  it("isolates cached source facts, caches only referenced sources, and resolves a previously missing source", async () => {
    const sources = new CitationSources();
    const text = `Cache isolation ${marker}`;
    const missing = await renderMarkdownToHtml(text, {
      citationSources: sources.sources,
    });
    expect(missing).toContain(`[${ref}]`);
    sources.observeMessage(result(raw));
    const first = await renderMarkdownToHtml(text, {
      citationSources: sources.sources,
    });
    expect(first).toContain(`href="${url}"`);
    const other = new Map([
      [ref, { url: "https://example.com/other", title: "Other session" }],
    ]);
    expect(
      await renderMarkdownToHtml(text, { citationSources: other }),
    ).toContain('href="https://example.com/other"');
    sources.observeMessage(
      result(
        `Unrelated (https://example.com/unrelated)\n【turn9search9】 snippet`,
      ),
    );
    const cache: string[] = [];
    await observeMarkdownAugmentCache(
      (hit) => cache.push(hit),
      () => renderMarkdownToHtml(text, { citationSources: sources.sources }),
    );
    expect(cache).toEqual(["hit"]);
    expect(
      citationOptionsForText("No citation", {
        citationSources: sources.sources,
      }).citationSources,
    ).toBeUndefined();
  });

  it("preserves code, multiple sources and locators; escapes titles; rejects unsafe/ambiguous URLs and prose source spoofing", async () => {
    const sources = new CitationSources();
    sources.observeMessage(answer(raw));
    expect(sources.sources.size).toBe(0);
    sources.observeMessage(result(raw));
    sources.observeMessage(
      result(
        `Unsafe (https://user:secret@example.com/)\n【turn1search0】 snippet`,
      ),
    );
    sources.observeMessage(
      result("", {
        pages: [
          { ref: "turn2search0", url: "javascript:alert(1)", title: "Unsafe" },
          {
            ref: "turn3search0",
            url: "https://example.com/",
            title: '"><script>alert(1)</script>',
          },
        ],
      }),
    );
    const many = `\uE200cite\uE202${ref}\uE202turn3search0\uE202L8-L13\uE201`;
    const html = await renderMarkdownToHtml(
      `Claim ${many}\n\n\`${marker}\`\n\n\`\`\`text\n${marker}\n\`\`\`\n\nMissing \uE200cite\uE202turn1search0\uE201`,
      { citationSources: sources.sources },
    );
    expect(html.match(/<a /g)).toHaveLength(2);
    expect(html).toContain("L8-L13");
    expect(html).toContain(`<code>${marker}</code>`);
    expect(html).not.toContain("<script>");
    expect(html).toContain("[turn1search0]");
    expect(sources.sources.has("turn2search0")).toBe(false);
    sources.observeMessage(
      result(`Collision (https://example.com/collision)\n【${ref}】 snippet`),
    );
    expect(
      await renderMarkdownToHtml(marker, { citationSources: sources.sources }),
    ).toBe(`<p>[${ref}]</p>`);
  });

  it("bounds retained sources and accepts private-use source headers", () => {
    const sources = new CitationSources();
    for (let i = 0; i < 1100; i++)
      sources.observeMessage(
        result(
          `Page (https://example.com/${i})\n\uE200cite\uE202turn0search${i}\uE201 snippet`,
        ),
      );
    expect(sources.sources.size).toBe(1024);
    expect(sources.sources.has("turn0search0")).toBe(false);
    expect(sources.sources.has("turn0search1099")).toBe(true);
  });
});
