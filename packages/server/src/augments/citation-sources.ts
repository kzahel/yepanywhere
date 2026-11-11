/** Source facts come only from tool results, never assistant/user prose. */
export interface CitationSource {
  url: string;
  title: string;
}
export interface CitationRenderOptions {
  citationSources?: ReadonlyMap<string, CitationSource | null>;
}

const SOURCE_ID = /^turn\d+[a-z]+\d+$/i;
const CITATION = /\uE200cite\uE202([^\uE201]*)\uE201/g;
const PAGE =
  /^([^\n]+)\s+\((https?:\/\/[^\s]+)\)\r?\n(?:【(turn\d+[a-z]+\d+)】|\uE200cite\uE202(turn\d+[a-z]+\d+)\uE201)/gm;
const MAX_SOURCES = 1024;
const MAX_BYTES = 512 * 1024;
const MAX_SCAN_CHARS = 4 * 1024 * 1024;

export function citationIds(text: string): string[] {
  if (!text.includes("\uE200cite\uE202")) return [];
  const ids = new Set<string>();
  for (const match of text.matchAll(CITATION)) {
    for (const field of (match[1] ?? "").split("\uE202")) {
      if (SOURCE_ID.test(field)) ids.add(field);
    }
  }
  return [...ids];
}

/** Snapshot only this block's facts: bounded cache keys and no async map races. */
export function citationOptionsForText(
  text: string,
  options: CitationRenderOptions | undefined,
): CitationRenderOptions {
  const ids = citationIds(text);
  return ids.length
    ? {
        citationSources: new Map(
          ids.map((id) => [id, options?.citationSources?.get(id) ?? null]),
        ),
      }
    : { citationSources: undefined };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Per response/subscription; FIFO bounded by entries and UTF-16 retained bytes. */
export class CitationSources {
  readonly sources = new Map<string, CitationSource | null>();
  private bytes = 0;
  private readonly seen = new WeakSet<object>();

  private add(id: string, url: string, title: string): void {
    if (!SOURCE_ID.test(id) || id.length > 96 || url.length > 4096) return;
    try {
      const parsed = new URL(url);
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password
      )
        return;
    } catch {
      return;
    }
    const old = this.sources.get(id);
    if (this.sources.has(id)) {
      // A colliding reference is ambiguous; never silently cite another URL.
      if (old && old.url !== url) {
        this.bytes -= 2 * (old.url.length + old.title.length);
        this.sources.set(id, null);
      }
      return;
    }
    const source = { url, title: title.slice(0, 512) };
    const size = 2 * (id.length + source.url.length + source.title.length);
    while (this.sources.size >= MAX_SOURCES || this.bytes + size > MAX_BYTES) {
      const first = this.sources.entries().next().value;
      if (!first) break;
      this.sources.delete(first[0]);
      this.bytes -=
        2 *
        (first[0].length +
          (first[1]?.url.length ?? 0) +
          (first[1]?.title.length ?? 0));
    }
    this.sources.set(id, source);
    this.bytes += size;
  }

  observeMessage(message: object): void {
    if (this.seen.has(message)) return;
    this.seen.add(message);
    const msg = record(message);
    if (!msg) return;
    const nested = record(msg.message);
    const content = nested?.content ?? msg.content;
    const results: unknown[] = [];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (record(block)?.type === "tool_result")
          results.push(record(block)?.content);
      }
    }
    // Normalized Web results keep refs here after cleaning the display text.
    if (results.length) results.push(msg.toolUseResult, msg.tool_use_result);
    let remaining = MAX_SCAN_CHARS;
    let nodes = 4096;
    const visit = (value: unknown, depth: number): void => {
      if (depth > 12 || --nodes < 0 || remaining <= 0) return;
      if (typeof value === "string") {
        const text = value.slice(0, remaining);
        remaining -= text.length;
        // Also finds IDs inside JSON with escaped Unicode marker delimiters.
        if (!/turn\d+[a-z]+\d+/i.test(text)) return;
        for (const match of text.matchAll(PAGE)) {
          this.add(
            match[3] ?? match[4] ?? "",
            match[2] ?? "",
            match[1]?.trim() ?? "",
          );
        }
        // MCP/code-mode output can be JSON, or several printed JSON values.
        // Decode only JSON-looking lines, never parse the whole transcript.
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
          try {
            visit(JSON.parse(trimmed), depth + 1);
          } catch {
            /* Plain tool text. */
          }
        }
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (nodes <= 0 || remaining <= 0) break;
          visit(item, depth + 1);
        }
      } else {
        const obj = record(value);
        if (!obj) return;
        if (typeof obj.ref === "string" && typeof obj.url === "string") {
          this.add(
            obj.ref,
            obj.url,
            typeof obj.title === "string" ? obj.title : "",
          );
        }
        for (const key in obj) {
          if (nodes <= 0 || remaining <= 0) break;
          if (Object.hasOwn(obj, key)) visit(obj[key], depth + 1);
        }
      }
    };
    for (const result of results) visit(result, 0);
  }
}

export function citationOptionsForMessages(
  messages: readonly object[],
  options?: CitationRenderOptions,
): CitationRenderOptions {
  if (options?.citationSources) return options;
  const sources = new CitationSources();
  for (const message of messages) sources.observeMessage(message);
  return { citationSources: sources.sources };
}
