import {
  getRangeSourceOffsets,
  type SourceOffsetRange,
} from "./sourceOffsetDom";
import { getVisibleSelectionText } from "./selectionClipboard";

const MARKDOWN_COPY_SOURCE_ATTR = "data-markdown-copy-source";
const QUOTE_SELECTION_ROOT_ATTR = "data-quote-selection-root";
const MARKDOWN_COPY_IGNORE_SELECTOR = '[data-markdown-copy-ignore="true"]';

export const QUOTE_SELECTION_ROOT_ATTRIBUTES = {
  [QUOTE_SELECTION_ROOT_ATTR]: "true",
} as const;

interface SourceLine {
  text: string;
  start: number;
  end: number;
}

interface VisibleCharSource {
  sourceIndex: number;
}

interface VisibleSourceMap {
  visible: string;
  charSources: Array<VisibleCharSource | null>;
}

interface NormalizedTextMap {
  text: string;
  map: number[];
}

interface RangeTextWithinElement {
  selectedText: string;
  sourceSelectedText: string;
  textBefore: string;
  preferExactSource: boolean;
  range: Range;
  sourceRange: SourceOffsetRange | null;
}

export interface MarkdownSelectionSnippet {
  markdown: string;
  selectedText: string;
  sourceElement: HTMLElement;
  range: Range;
  /** Literal displays already expose source syntax; no Markdown alternative. */
  isLiteral?: boolean;
  sourceStart?: number;
  sourceEnd?: number;
  sourceLocation?: SelectionSourceLocation;
}

export interface SelectionSourceLocation {
  projectId: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
}

export interface MarkdownCopySourceContext {
  projectId: string;
  filePath: string;
  /** One-indexed line represented by source offset zero. */
  contentStartLine?: number;
}

interface RegisteredMarkdownCopySource {
  source: string;
  context?: MarkdownCopySourceContext;
  mode: CopySourceMode;
}

export type CopySourceMode = "rendered" | "literal";

const markdownCopySources = new WeakMap<
  HTMLElement,
  RegisteredMarkdownCopySource
>();

function closestQuoteSelectionRoot(node: Node | null): HTMLElement | null {
  const element =
    node instanceof HTMLElement ? node : (node?.parentElement ?? null);
  return (
    element?.closest<HTMLElement>(`[${QUOTE_SELECTION_ROOT_ATTR}]`) ?? null
  );
}

/**
 * Resolve the UI surface that owns the current quoteable selection. The
 * transcript is the default root; portaled surfaces opt in explicitly so the
 * same selection/copy/reply controller can follow their registered text.
 */
export function getQuoteSelectionRoot(
  transcriptRoot: HTMLElement,
  selection: Selection | null = transcriptRoot.ownerDocument.getSelection(),
): HTMLElement | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }

  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    const portaledRoot =
      closestQuoteSelectionRoot(range.startContainer) ??
      closestQuoteSelectionRoot(range.endContainer);
    if (portaledRoot && rangeIntersectsNode(range, portaledRoot)) {
      return portaledRoot;
    }
    if (rangeIntersectsNode(range, transcriptRoot)) {
      return transcriptRoot;
    }
  }
  return null;
}

export function getQuoteSelectionRootForTarget(
  transcriptRoot: HTMLElement,
  target: EventTarget | null,
): HTMLElement | null {
  if (!(target instanceof Node)) {
    return null;
  }
  const portaledRoot = closestQuoteSelectionRoot(target);
  if (portaledRoot) {
    return portaledRoot;
  }
  return transcriptRoot.contains(target) ? transcriptRoot : null;
}

export function registerMarkdownCopySource(
  element: HTMLElement,
  source: string,
  context?: MarkdownCopySourceContext,
  mode: CopySourceMode = "rendered",
): () => void {
  element.setAttribute(MARKDOWN_COPY_SOURCE_ATTR, "true");
  markdownCopySources.set(element, { source, context, mode });

  return () => {
    markdownCopySources.delete(element);
    element.removeAttribute(MARKDOWN_COPY_SOURCE_ATTR);
  };
}

export function extractMarkdownSnippetsFromSelection(
  root: HTMLElement,
): MarkdownSelectionSnippet[] {
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return [];
  }

  const snippets: MarkdownSelectionSnippet[] = [];
  const sourceElements = [
    ...(root.hasAttribute(MARKDOWN_COPY_SOURCE_ATTR) ? [root] : []),
    ...root.querySelectorAll<HTMLElement>(`[${MARKDOWN_COPY_SOURCE_ATTR}]`),
  ];

  for (let rangeIndex = 0; rangeIndex < selection.rangeCount; rangeIndex += 1) {
    const range = selection.getRangeAt(rangeIndex);
    if (!rangeIntersectsNode(range, root)) {
      continue;
    }

    for (const element of sourceElements) {
      if (!rangeIntersectsNode(range, element)) {
        continue;
      }

      const registeredSource = markdownCopySources.get(element);
      if (!registeredSource) {
        continue;
      }
      const { source } = registeredSource;

      const rangeText = getRangeTextWithinElement(range, element);
      if (!rangeText?.selectedText.trim()) {
        continue;
      }

      const sourceRange = rangeText.sourceRange
        ? trimSourceRangeBoundaryNewlines(source, rangeText.sourceRange)
        : null;
      const exactSourceSelection = sourceRange
        ? source.slice(sourceRange.start, sourceRange.end)
        : null;
      const isLiteral =
        registeredSource.mode === "literal" ||
        rangeText.preferExactSource ||
        sourceRange !== null;
      const markdown =
        exactSourceSelection ??
        (isLiteral
          ? rangeText.selectedText
          : getMarkdownForVisibleSelection(
              source,
              rangeText.sourceSelectedText,
              {
                textBefore: rangeText.textBefore,
                preferExactSource: rangeText.preferExactSource,
                preferRenderedSource:
                  rangeText.sourceSelectedText !== rangeText.selectedText,
              },
            )) ??
        rangeText.selectedText;
      const normalized = trimBoundaryNewlines(markdown);
      if (normalized.trim()) {
        snippets.push({
          markdown: normalized,
          selectedText: exactSourceSelection ?? rangeText.selectedText,
          sourceElement: element,
          range: rangeText.range,
          isLiteral,
          sourceStart: sourceRange?.start,
          sourceEnd: sourceRange?.end,
          sourceLocation: sourceRange
            ? getSelectionSourceLocationForRange(
                source,
                sourceRange,
                registeredSource.context,
              )
            : getSelectionSourceLocation(
                source,
                normalized,
                registeredSource.context,
              ),
        });
      }
    }
  }

  return snippets;
}

export function getMarkdownSnippetForElement(
  element: HTMLElement,
): MarkdownSelectionSnippet | null {
  const registeredSource = markdownCopySources.get(element);
  const source = registeredSource?.source;
  if (!source?.trim()) {
    return null;
  }
  const range = createTextContentRange(element);
  return {
    markdown: trimBoundaryNewlines(source),
    selectedText: element.innerText || element.textContent || source,
    sourceElement: element,
    range,
    isLiteral: registeredSource?.mode === "literal",
    sourceLocation: getSelectionSourceLocation(
      source,
      trimBoundaryNewlines(source),
      registeredSource?.context,
    ),
  };
}

/**
 * Recover the markdown for one rendered block (paragraph/list/heading) nested
 * inside a registered copy-source element, so a per-paragraph quote circle can
 * quote just that block. Maps the block's visible text back to its source span
 * via the same visible-source map the copy/selection path uses.
 */
export function getMarkdownSnippetForSubElement(
  sourceElement: HTMLElement,
  blockElement: HTMLElement,
): MarkdownSelectionSnippet | null {
  const registeredSource = markdownCopySources.get(sourceElement);
  const source = registeredSource?.source;
  if (!source?.trim()) {
    return null;
  }
  const selectedText = blockElement.innerText || blockElement.textContent || "";
  if (!selectedText.trim()) {
    return null;
  }
  const doc = blockElement.ownerDocument;
  const range = createTextContentRange(blockElement);

  const beforeRange = doc.createRange();
  beforeRange.selectNodeContents(sourceElement);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  const textBefore = beforeRange.toString();

  const markdown =
    (registeredSource?.mode === "literal"
      ? selectedText
      : getMarkdownForVisibleSelection(source, selectedText, { textBefore })) ??
    selectedText;
  const normalized = trimBoundaryNewlines(markdown);
  if (!normalized.trim()) {
    return null;
  }
  return {
    markdown: normalized,
    selectedText,
    sourceElement,
    range,
    isLiteral: registeredSource?.mode === "literal",
    sourceLocation: getSelectionSourceLocation(
      source,
      normalized,
      registeredSource?.context,
    ),
  };
}

function getSelectionSourceLocation(
  source: string,
  selectedSource: string,
  context: MarkdownCopySourceContext | undefined,
): SelectionSourceLocation | undefined {
  if (!context || !selectedSource) {
    return undefined;
  }
  const sourceStart = source.indexOf(selectedSource);
  if (
    sourceStart < 0 ||
    source.indexOf(selectedSource, sourceStart + selectedSource.length) >= 0
  ) {
    return undefined;
  }
  const sourceEnd = sourceStart + selectedSource.length;
  return getSelectionSourceLocationForRange(
    source,
    { start: sourceStart, end: sourceEnd },
    context,
  );
}

function getSelectionSourceLocationForRange(
  source: string,
  sourceRange: SourceOffsetRange,
  context: MarkdownCopySourceContext | undefined,
): SelectionSourceLocation | undefined {
  if (!context || sourceRange.end <= sourceRange.start) return undefined;
  const contentStartLine = context.contentStartLine ?? 1;
  const lineStart =
    contentStartLine + countNewlines(source.slice(0, sourceRange.start));
  const lineEnd =
    contentStartLine +
    countNewlines(
      source.slice(0, Math.max(sourceRange.start, sourceRange.end - 1)),
    );
  return {
    projectId: context.projectId,
    filePath: context.filePath,
    lineStart,
    lineEnd,
  };
}

function trimSourceRangeBoundaryNewlines(
  source: string,
  sourceRange: SourceOffsetRange,
): SourceOffsetRange {
  let { start, end } = sourceRange;
  while (start < end && (source[start] === "\n" || source[start] === "\r")) {
    start += 1;
  }
  while (
    end > start &&
    (source[end - 1] === "\n" || source[end - 1] === "\r")
  ) {
    end -= 1;
  }
  return { start, end };
}

function countNewlines(value: string): number {
  let count = 0;
  for (const character of value) {
    if (character === "\n") count += 1;
  }
  return count;
}

function createTextContentRange(element: HTMLElement): Range {
  const range = element.ownerDocument.createRange();
  const walker = element.ownerDocument.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) =>
        node.textContent && node.textContent.length > 0
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT,
    },
  );
  const first = walker.nextNode();
  if (!first) {
    range.selectNodeContents(element);
    return range;
  }

  let last = first;
  for (let next = walker.nextNode(); next; next = walker.nextNode()) {
    last = next;
  }

  range.setStart(first, 0);
  range.setEnd(last, last.textContent?.length ?? 0);
  return range;
}

export function getMarkdownForVisibleSelection(
  source: string,
  selectedText: string,
  options: {
    textBefore?: string;
    preferExactSource?: boolean;
    preferRenderedSource?: boolean;
  } = {},
): string | null {
  const normalizedSource = normalizeLineEndings(source);
  const normalizedSelection = normalizeLineEndings(selectedText);
  if (!normalizedSelection.trim()) {
    return null;
  }

  const exactSelection = findExactSourceSelection(
    normalizedSource,
    normalizedSelection,
  );
  const quartoIncludeSelection = findQuartoIncludeSourceSelection(
    normalizedSource,
    normalizedSelection,
  );
  if (quartoIncludeSelection) {
    return quartoIncludeSelection;
  }
  if (options.preferRenderedSource) {
    const mathSelection = findDelimitedMathSourceSelection(
      normalizedSource,
      normalizedSelection,
    );
    if (mathSelection) {
      return mathSelection;
    }
  }
  if (
    exactSelection !== null &&
    (options.preferExactSource ||
      normalizedSource
        .split("\n")
        .some(
          (line) =>
            parseQuartoIncludeLine(line)?.target === normalizedSelection,
        ))
  ) {
    return exactSelection;
  }

  const sourceMap = buildVisibleSourceMap(normalizedSource);
  const selectionMap = buildVisibleSourceMap(normalizedSelection);
  const sourceMatch = normalizeTextForMatchWithMap(sourceMap.visible);
  const targetMatch = normalizeTextForMatch(selectionMap.visible);
  if (!targetMatch) {
    return exactSelection;
  }

  const preferredStart = options.textBefore
    ? normalizeTextForMatch(buildVisibleSourceMap(options.textBefore).visible)
        .length
    : 0;
  const matchIndex = findBestMatchIndex(
    sourceMatch.text,
    targetMatch,
    preferredStart,
  );
  if (matchIndex === -1) {
    return exactSelection;
  }

  const matchEndIndex = matchIndex + targetMatch.length - 1;
  const visibleStart = sourceMatch.map[matchIndex];
  const visibleEndChar = sourceMatch.map[matchEndIndex];
  if (visibleStart === undefined || visibleEndChar === undefined) {
    return exactSelection;
  }

  const visibleEnd = visibleEndChar + 1;
  let sourceStart = Number.POSITIVE_INFINITY;
  let sourceEnd = -1;

  for (
    let visibleIndex = visibleStart;
    visibleIndex < visibleEnd && visibleIndex < sourceMap.charSources.length;
    visibleIndex += 1
  ) {
    const charSource = sourceMap.charSources[visibleIndex];
    if (!charSource) {
      continue;
    }
    sourceStart = Math.min(sourceStart, charSource.sourceIndex);
    sourceEnd = Math.max(sourceEnd, charSource.sourceIndex + 1);
  }

  if (!Number.isFinite(sourceStart) || sourceEnd < sourceStart) {
    return exactSelection;
  }

  return trimBoundaryNewlines(
    splitSourceLines(normalizedSource)
      .filter((line) => line.end >= sourceStart && line.start < sourceEnd)
      .map((line) => {
        const prefix = getMarkdownBlockPrefix(line.text);
        const start = Math.max(prefix.contentStart, sourceStart - line.start);
        const end = Math.min(line.text.length, sourceEnd - line.start);
        return (
          line.text.slice(0, prefix.contentStart) +
          getFormattedSourceSlice(
            line.text.slice(prefix.contentStart),
            start - prefix.contentStart,
            end - prefix.contentStart,
          )
        );
      })
      .join("\n"),
  );
}

/** Retain enclosing inline syntax without adding unselected words. */
function getFormattedSourceSlice(
  source: string,
  start: number,
  end: number,
): string {
  const spans =
    /(`+)(.*?)\1|(!?\[)([^\]]+)\](\([^\n]*?\))|(\*\*|__|~~|\*|_)(?=\S)(.+?)\6/g;
  let result = "";
  let cursor = 0;
  const appendPlain = (from: number, to: number) => {
    result += source.slice(Math.max(start, from), Math.min(end, to));
  };
  for (const match of source.matchAll(spans)) {
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;
    appendPlain(cursor, matchStart);
    const opening = match[1] ?? match[3] ?? match[6] ?? "";
    const content = match[2] ?? match[4] ?? match[7] ?? "";
    const closing = match[3] ? `]${match[5]}` : opening;
    const contentStart = matchStart + opening.length;
    const contentEnd = contentStart + content.length;
    if (start < contentEnd && end > contentStart) {
      const innerStart = Math.max(0, start - contentStart);
      const innerEnd = Math.min(content.length, end - contentStart);
      const selected = match[1]
        ? content.slice(innerStart, innerEnd)
        : getFormattedSourceSlice(content, innerStart, innerEnd);
      result += opening + selected + closing;
    }
    cursor = matchEnd;
  }
  appendPlain(cursor, source.length);
  return result;
}

function findExactSourceSelection(
  source: string,
  selectedText: string,
): string | null {
  if (source.includes(selectedText)) {
    return selectedText;
  }

  const trimmed = trimBoundaryNewlines(selectedText);
  if (trimmed !== selectedText && source.includes(trimmed)) {
    return trimmed;
  }

  return null;
}

function findQuartoIncludeSourceSelection(
  source: string,
  selectedText: string,
): string | null {
  const trimmedSelection = trimBoundaryNewlines(selectedText).trim();
  for (const line of source.split("\n")) {
    const include = parseQuartoIncludeLine(line);
    if (include && trimmedSelection === `Include: ${include.target}`) {
      return line.trim();
    }
  }
  return null;
}

function findDelimitedMathSourceSelection(
  source: string,
  renderedSource: string,
): string | null {
  const expression = trimBoundaryNewlines(renderedSource).trim();
  if (!expression) return null;
  const candidates = [
    `$$${expression}$$`,
    `$${expression}$`,
    `\\(${expression}\\)`,
    `\\[${expression}\\]`,
  ];
  let match: string | null = null;
  for (const candidate of candidates) {
    const first = source.indexOf(candidate);
    if (first < 0) continue;
    if (source.indexOf(candidate, first + candidate.length) >= 0 || match) {
      return null;
    }
    match = candidate;
  }
  return match;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function trimBoundaryNewlines(value: string): string {
  return normalizeLineEndings(value).replace(/^\n+|\n+$/g, "");
}

function rangeIntersectsNode(range: Range, node: Node): boolean {
  try {
    return range.intersectsNode(node);
  } catch {
    return false;
  }
}

function getRangeTextWithinElement(
  range: Range,
  element: HTMLElement,
): RangeTextWithinElement | null {
  const elementRange = element.ownerDocument.createRange();
  elementRange.selectNodeContents(element);
  if (!rangeIntersectsNode(range, element)) {
    return null;
  }

  const clippedRange = range.cloneRange();
  if (range.compareBoundaryPoints(Range.START_TO_START, elementRange) < 0) {
    clippedRange.setStart(
      elementRange.startContainer,
      elementRange.startOffset,
    );
  }
  if (range.compareBoundaryPoints(Range.END_TO_END, elementRange) > 0) {
    clippedRange.setEnd(elementRange.endContainer, elementRange.endOffset);
  }

  const beforeRange = element.ownerDocument.createRange();
  beforeRange.setStart(elementRange.startContainer, elementRange.startOffset);
  beforeRange.setEnd(clippedRange.startContainer, clippedRange.startOffset);

  const sourceModeElements = Array.from(
    element.querySelectorAll<HTMLElement>("[data-text-block-source]"),
  );
  const selectedText = getRangeTextWithoutIgnoredContent(clippedRange);

  return {
    selectedText,
    sourceSelectedText:
      getRenderedSourceSelectionText(clippedRange) ?? selectedText,
    textBefore: getRangeTextWithoutIgnoredContent(beforeRange),
    preferExactSource: sourceModeElements.some((sourceElement) =>
      rangeIntersectsNode(clippedRange, sourceElement),
    ),
    range: clippedRange,
    sourceRange: getRangeSourceOffsets(element, clippedRange),
  };
}

function getRangeTextWithoutIgnoredContent(range: Range): string {
  return getVisibleSelectionText(range.cloneContents());
}

function getRenderedSourceSelectionText(range: Range): string | null {
  const startMath = closestKatexElement(range.startContainer);
  const endMath = closestKatexElement(range.endContainer);
  if (startMath && startMath === endMath) {
    return getKatexSource(startMath);
  }
  const doc = range.startContainer.ownerDocument ?? document;
  const wrapper = doc.createElement("div");
  wrapper.append(range.cloneContents());
  for (const ignored of wrapper.querySelectorAll(
    MARKDOWN_COPY_IGNORE_SELECTOR,
  )) {
    ignored.remove();
  }
  const mathElements = Array.from(
    wrapper.querySelectorAll<HTMLElement>(".katex"),
  );
  if (mathElements.length === 0) return null;
  for (const math of mathElements) {
    const source = getKatexSource(math);
    if (source === null) return null;
    math.replaceWith(math.ownerDocument.createTextNode(source));
  }
  return getVisibleSelectionText(wrapper);
}

function closestKatexElement(node: Node): HTMLElement | null {
  const element =
    node instanceof HTMLElement ? node : (node.parentElement ?? null);
  return element?.closest<HTMLElement>(".katex") ?? null;
}

function getKatexSource(element: HTMLElement): string | null {
  const annotation = element.querySelector(
    'annotation[encoding="application/x-tex"]',
  );
  return annotation?.textContent ?? null;
}

function splitSourceLines(source: string): SourceLine[] {
  const lines = source.split("\n");
  let start = 0;
  return lines.map((text) => {
    const end = start + text.length;
    const line = { text, start, end };
    start = end + 1;
    return line;
  });
}

function buildVisibleSourceMap(source: string): VisibleSourceMap {
  const normalizedSource = normalizeLineEndings(source);
  const sourceLines = splitSourceLines(normalizedSource);
  const charSources: Array<VisibleCharSource | null> = [];
  let visible = "";

  for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex += 1) {
    const sourceLine = sourceLines[lineIndex];
    if (!sourceLine) {
      continue;
    }

    const lineMap = buildVisibleLineMap(sourceLine.text, sourceLine.start);
    visible += lineMap.visible;
    charSources.push(
      ...lineMap.charSources.map((sourceIndex) => ({
        sourceIndex,
      })),
    );
    if (lineIndex < sourceLines.length - 1) {
      visible += "\n";
      charSources.push({ sourceIndex: sourceLine.end });
    }
  }

  return { visible, charSources };
}

function buildVisibleLineMap(
  line: string,
  sourceLineStart: number,
): {
  visible: string;
  charSources: number[];
} {
  const quartoInclude = buildQuartoIncludeLineMap(line, sourceLineStart);
  if (quartoInclude) {
    return quartoInclude;
  }

  const blockPrefix = getMarkdownBlockPrefix(line);
  const visibleParts: string[] = [];
  const charSources: number[] = [];

  const appendSourceChar = (index: number) => {
    visibleParts.push(line[index] ?? "");
    charSources.push(sourceLineStart + index);
  };

  for (let index = blockPrefix.contentStart; index < line.length; index += 1) {
    const escapedIndex = getEscapedMarkdownCharIndex(line, index);
    if (escapedIndex !== null) {
      appendSourceChar(escapedIndex);
      index = escapedIndex;
      continue;
    }

    const link = getInlineLinkSpan(line, index);
    if (link) {
      for (
        let textIndex = link.textStart;
        textIndex < link.textEnd;
        textIndex += 1
      ) {
        appendSourceChar(textIndex);
      }
      index = link.end;
      continue;
    }

    if (isInlineMarkdownDelimiter(line[index] ?? "")) {
      continue;
    }

    appendSourceChar(index);
  }

  return {
    visible: visibleParts.join(""),
    charSources,
  };
}

function buildQuartoIncludeLineMap(
  line: string,
  sourceLineStart: number,
): {
  visible: string;
  charSources: number[];
} | null {
  const include = parseQuartoIncludeLine(line);
  if (!include) return null;
  const { target, targetStart } = include;

  const label = "Include: ";
  const prefixLength = Math.max(1, targetStart);
  const charSources = Array.from(
    { length: label.length },
    (_, index) =>
      sourceLineStart +
      Math.min(
        prefixLength - 1,
        Math.floor((index * prefixLength) / label.length),
      ),
  );
  for (let index = 0; index < target.length; index += 1) {
    charSources.push(sourceLineStart + targetStart + index);
  }

  return {
    visible: `${label}${target}`,
    charSources,
  };
}

function parseQuartoIncludeLine(
  line: string,
): { target: string; targetStart: number } | null {
  const match =
    /^\s*\{\{<\s*include\s+(?:"([^"]+)"|'([^']+)'|([^\s"'<>]+))\s*>\}\}\s*$/.exec(
      line,
    );
  const target = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!match || !target) return null;

  const targetStart = match[0].lastIndexOf(target);
  if (targetStart < 0) return null;
  return { target, targetStart };
}

function getMarkdownBlockPrefix(line: string): {
  contentStart: number;
} {
  let contentStart = line.match(/^[ \t]{0,3}/)?.[0].length ?? 0;

  while (contentStart < line.length) {
    const rest = line.slice(contentStart);
    const blockquote = /^>\s?/.exec(rest);
    if (blockquote) {
      contentStart += blockquote[0].length;
      continue;
    }

    const heading = /^#{1,6}(?:\s+|$)/.exec(rest);
    if (heading) {
      contentStart += heading[0].length;
      continue;
    }

    const taskList = /^[-+*]\s+\[[ xX]\]\s+/.exec(rest);
    if (taskList) {
      contentStart += taskList[0].length;
      continue;
    }

    const orderedList = /^\d{1,9}[.)]\s+/.exec(rest);
    if (orderedList) {
      contentStart += orderedList[0].length;
      continue;
    }

    const unorderedList = /^(?:[-+*]|[•‣⁃])\s+/.exec(rest);
    if (unorderedList) {
      contentStart += unorderedList[0].length;
      continue;
    }

    break;
  }

  return { contentStart };
}

function getEscapedMarkdownCharIndex(
  line: string,
  index: number,
): number | null {
  if (line[index] !== "\\") {
    return null;
  }
  const nextIndex = index + 1;
  if (nextIndex >= line.length) {
    return null;
  }
  return "\\`*_{}[]()#+-.!~|>".includes(line[nextIndex] ?? "")
    ? nextIndex
    : null;
}

function getInlineLinkSpan(
  line: string,
  index: number,
): { textStart: number; textEnd: number; end: number } | null {
  const hasImageBang = line[index] === "!" && line[index + 1] === "[";
  const bracketIndex = hasImageBang ? index + 1 : index;
  if (line[bracketIndex] !== "[") {
    return null;
  }

  const textEnd = line.indexOf("]", bracketIndex + 1);
  if (textEnd === -1 || line[textEnd + 1] !== "(") {
    return null;
  }

  const urlEnd = line.indexOf(")", textEnd + 2);
  if (urlEnd === -1) {
    return null;
  }

  return {
    textStart: bracketIndex + 1,
    textEnd,
    end: urlEnd,
  };
}

function isInlineMarkdownDelimiter(char: string): boolean {
  return char === "`" || char === "*" || char === "_" || char === "~";
}

function normalizeTextForMatch(value: string): string {
  return normalizeTextForMatchWithMap(value).text;
}

function normalizeTextForMatchWithMap(value: string): NormalizedTextMap {
  const normalized = normalizeLineEndings(value).replace(/\u00a0/g, " ");
  const chars: string[] = [];
  const map: number[] = [];

  const removeTrailingHorizontalSpace = () => {
    if (chars[chars.length - 1] === " ") {
      chars.pop();
      map.pop();
    }
  };

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index] ?? "";
    if (char === "\n") {
      removeTrailingHorizontalSpace();
      if (chars.length > 0 && chars[chars.length - 1] !== "\n") {
        chars.push("\n");
        map.push(index);
      }
      continue;
    }

    if (/\s/.test(char)) {
      if (chars.length > 0) {
        const previous = chars[chars.length - 1];
        if (previous !== " " && previous !== "\n") {
          chars.push(" ");
          map.push(index);
        }
      }
      continue;
    }

    chars.push(char);
    map.push(index);
  }

  while (chars.length > 0 && /\s/.test(chars[chars.length - 1] ?? "")) {
    chars.pop();
    map.pop();
  }

  return { text: chars.join(""), map };
}

function findBestMatchIndex(
  source: string,
  target: string,
  preferredStart: number,
): number {
  let fallback = -1;
  let searchFrom = 0;
  const minimumPreferredStart = Math.max(0, preferredStart - 2);

  while (searchFrom <= source.length) {
    const index = source.indexOf(target, searchFrom);
    if (index === -1) {
      break;
    }
    if (fallback === -1) {
      fallback = index;
    }
    if (index >= minimumPreferredStart) {
      return index;
    }
    searchFrom = index + Math.max(1, target.length);
  }

  return fallback;
}
