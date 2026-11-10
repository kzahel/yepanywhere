import styles from "./ThinkingText.module.css";
import {
  Fragment,
  memo,
  type ReactNode,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuoteableTextSource } from "../hooks/useQuoteableTextSource";
import { LinkifiedText } from "./ui/LinkifiedText";

interface ThinkingTextProps {
  text: string;
  isStreaming?: boolean;
}

interface ThinkingSection {
  key: string;
  heading: string;
  blocks: ThinkingContentBlock[];
  startOffset: number;
}

type ThinkingContentBlock =
  | { type: "paragraph"; text: string }
  | { type: "code"; text: string };

const thinkingHeadingPattern = /^\s*\*\*(.+?)\*\*\s*$/;
const htmlCommentOnlyLinePattern = /^\s*<!--[\s\S]*-->\s*$/;

function getThinkingHeading(line: string): string | null {
  const match = thinkingHeadingPattern.exec(line);
  const heading = match?.[1]?.trim();
  return heading ? heading : null;
}

function isDisplayOnlyPlaceholderLine(line: string): boolean {
  return htmlCommentOnlyLinePattern.test(line);
}

function stripDisplayOnlyPlaceholderLines(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const keptLines: string[] = [];
  let inFence = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const isFence = trimmed.startsWith("```");
    const isIndentedCode = line.startsWith("    ") || line.startsWith("\t");
    if (
      !inFence &&
      !isFence &&
      !isIndentedCode &&
      isDisplayOnlyPlaceholderLine(line)
    ) {
      continue;
    }

    keptLines.push(line);
    if (isFence) {
      inFence = !inFence;
    }
  }

  return keptLines.join("\n");
}

function splitThinkingBlocks(lines: string[]): ThinkingContentBlock[] {
  const blocks: ThinkingContentBlock[] = [];
  let current: string[] = [];

  const flushParagraph = () => {
    if (current.length > 0) {
      blocks.push({ type: "paragraph", text: current.join("\n") });
      current = [];
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      flushParagraph();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length) {
        const codeLine = lines[index] ?? "";
        if (codeLine.trim().startsWith("```")) break;
        codeLines.push(codeLine);
        index += 1;
      }
      blocks.push({ type: "code", text: codeLines.join("\n") });
      continue;
    }

    if (line.startsWith("    ") || line.startsWith("\t")) {
      flushParagraph();
      const codeLines = [line.replace(/^( {4}|\t)/, "")];
      while (index + 1 < lines.length) {
        const nextLine = lines[index + 1] ?? "";
        if (!nextLine.startsWith("    ") && !nextLine.startsWith("\t")) break;
        codeLines.push(nextLine.replace(/^( {4}|\t)/, ""));
        index += 1;
      }
      blocks.push({ type: "code", text: codeLines.join("\n") });
      continue;
    }

    if (isDisplayOnlyPlaceholderLine(line)) {
      flushParagraph();
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      continue;
    }
    current.push(line);
  }
  flushParagraph();

  return blocks;
}

interface ThinkingLine {
  text: string;
  startOffset: number;
}

interface ThinkingOutlineCache {
  text: string;
  sections: ThinkingSection[] | null;
}

function splitThinkingLines(text: string): ThinkingLine[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  const rawLines = normalized.split("\n");
  let offset = 0;
  return rawLines.map((line) => {
    const result = { text: line, startOffset: offset };
    offset += line.length + 1;
    return result;
  });
}

function parseThinkingOutlineFragment(
  text: string,
  options: { keyOffset?: number; startOffset?: number } = {},
): ThinkingSection[] {
  const lines = splitThinkingLines(text);
  const keyOffset = options.keyOffset ?? 0;
  const startOffset = options.startOffset ?? 0;

  const sections: Array<{
    heading: string;
    bodyLines: string[];
    startOffset: number;
  }> = [];

  let current: {
    heading: string;
    bodyLines: string[];
    startOffset: number;
  } | null = null;

  const flush = () => {
    if (current) {
      sections.push(current);
      current = null;
    }
  };

  for (const line of lines) {
    const heading = getThinkingHeading(line.text);
    if (heading) {
      flush();
      current = {
        heading,
        bodyLines: [],
        startOffset: startOffset + line.startOffset,
      };
      continue;
    }

    if (!current) continue;
    if (
      current.bodyLines.length === 0 &&
      (line.text.trim() === "" || isDisplayOnlyPlaceholderLine(line.text))
    ) {
      continue;
    }
    current.bodyLines.push(line.text);
  }
  flush();

  return sections.map((section, index) => ({
    key: `${keyOffset + index}:${section.heading}`,
    heading: section.heading,
    blocks: splitThinkingBlocks(section.bodyLines),
    startOffset: section.startOffset,
  }));
}

function parseThinkingOutline(text: string): ThinkingSection[] | null {
  const firstHeading = getThinkingHeading(
    splitThinkingLines(text)[0]?.text ?? "",
  );
  if (!firstHeading) return null;
  return parseThinkingOutlineFragment(text);
}

function updateStreamingThinkingOutline(
  previous: ThinkingOutlineCache | null,
  text: string,
): ThinkingOutlineCache {
  const previousSections = previous?.sections;
  if (
    !previous ||
    !previousSections ||
    previousSections.length === 0 ||
    !text.startsWith(previous.text)
  ) {
    return { text, sections: parseThinkingOutline(text) };
  }

  const reparseStart =
    previousSections[previousSections.length - 1]?.startOffset ?? 0;
  const stableSections = previousSections.slice(0, -1);
  const reparsedSections = parseThinkingOutlineFragment(
    text.slice(reparseStart),
    {
      keyOffset: stableSections.length,
      startOffset: reparseStart,
    },
  );
  return { text, sections: [...stableSections, ...reparsedSections] };
}

function useThinkingOutline(
  text: string,
  isStreaming: boolean,
): ThinkingSection[] | null {
  const streamingCacheRef = useRef<ThinkingOutlineCache | null>(null);
  return useMemo(() => {
    if (!isStreaming) {
      const sections = parseThinkingOutline(text);
      streamingCacheRef.current = { text, sections };
      return sections;
    }

    const next = updateStreamingThinkingOutline(
      streamingCacheRef.current,
      text,
    );
    streamingCacheRef.current = next;
    return next.sections;
  }, [isStreaming, text]);
}

function renderThinkingInline(text: string): ReactNode {
  const nodes: ReactNode[] = [];
  let index = 0;

  while (index < text.length) {
    const start = text.indexOf("`", index);
    if (start === -1) {
      nodes.push(text.slice(index));
      break;
    }

    const end = text.indexOf("`", start + 1);
    if (end === -1) {
      nodes.push(text.slice(index));
      break;
    }

    if (start > index) {
      nodes.push(text.slice(index, start));
    }

    const code = text.slice(start + 1, end);
    nodes.push(
      <code
        className={styles.thinkingInlineCode}
        data-thinking-inline-code
        key={`code-${start}`}
      >
        {code}
      </code>,
    );
    index = end + 1;
  }

  return nodes.map((node, nodeIndex) => (
    <Fragment key={typeof node === "string" ? `text-${nodeIndex}` : nodeIndex}>
      {typeof node === "string" ? <LinkifiedText text={node} /> : node}
    </Fragment>
  ));
}

const ThinkingOutlineSection = memo(function ThinkingOutlineSection({
  section,
  isOpen,
  onSectionToggle,
}: {
  section: ThinkingSection;
  isOpen: boolean;
  onSectionToggle: (sectionKey: string, isOpen: boolean) => void;
}) {
  return (
    <details
      className={styles.thinkingOutlineSection}
      data-thinking-outline-section
      key={section.key}
      open={isOpen}
      onToggle={(event) => {
        onSectionToggle(section.key, event.currentTarget.open);
      }}
    >
      <summary
        className={styles.thinkingOutlineHeading}
        data-thinking-outline-heading
      >
        <span
          className={styles.thinkingOutlineDot}
          data-thinking-outline-dot
          aria-hidden="true"
        />
        <strong>{renderThinkingInline(section.heading)}</strong>
      </summary>
      {section.blocks.length > 0 && (
        <div className={styles.thinkingOutlineBody} data-thinking-outline-body>
          {section.blocks.map((block, index) => (
            <Fragment key={index}>
              {block.type === "code" ? (
                <pre
                  className={styles.thinkingCodeBlock}
                  data-thinking-code-block
                >
                  <code>{block.text}</code>
                </pre>
              ) : (
                <p>{renderThinkingInline(block.text)}</p>
              )}
            </Fragment>
          ))}
        </div>
      )}
    </details>
  );
});

export const ThinkingText = memo(function ThinkingText({
  text,
  isStreaming = false,
}: ThinkingTextProps) {
  const displayText = useMemo(
    () => stripDisplayOnlyPlaceholderLines(text),
    [text],
  );
  const outline = useThinkingOutline(displayText, isStreaming);
  const plainRef = useQuoteableTextSource<HTMLSpanElement>(displayText);
  const outlineRef = useQuoteableTextSource<HTMLDivElement>(displayText);
  const [closedSections, setClosedSections] = useState<Set<string>>(
    () => new Set(),
  );
  const handleSectionToggle = useCallback(
    (sectionKey: string, nextOpen: boolean) => {
      setClosedSections((current) => {
        const next = new Set(current);
        if (nextOpen) {
          next.delete(sectionKey);
        } else {
          next.add(sectionKey);
        }
        return next;
      });
    },
    [],
  );

  if (!outline) {
    return (
      <span
        ref={plainRef}
        className={`${styles.thinkingTextPlain}`}
        data-thinking-text
        data-thinking-text-plain
      >
        <LinkifiedText text={displayText} />
      </span>
    );
  }

  return (
    <div
      ref={outlineRef}
      className={`${styles.thinkingOutline}`}
      data-thinking-text
      data-thinking-outline
    >
      {outline.map((section) => {
        const isOpen = !closedSections.has(section.key);
        return (
          <ThinkingOutlineSection
            key={section.key}
            section={section}
            isOpen={isOpen}
            onSectionToggle={handleSectionToggle}
          />
        );
      })}
    </div>
  );
});
