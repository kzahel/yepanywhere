import codeStyles from "../renderers/CodeOutput.module.css";
import {
  buildProjectFileViewerHref,
  type CitedFilePosition,
  citedProjectPathTokenExtent,
  containsLinkifiableUrl,
  findProjectPathTokens,
  normalizeTexForKatex,
  paperKatexMacros,
  parseToonDocument,
  type ProjectPathLinkTarget,
  splitUrlSegments,
} from "@yep-anywhere/shared";
import katex from "katex";
import {
  type ClipboardEventHandler,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  buildPublicShareFileHref,
  type PublicShareContextValue,
  usePublicShareContext,
} from "../../contexts/PublicShareContext";
import { useGlossaryArtifact } from "../../contexts/GlossaryContext";
import { useProjectPathLinkSettings } from "../../contexts/ProjectPathLinkSettingsContext";
import { annotateProjectPathLinksHtml } from "../../lib/projectPathLinks";
import {
  type RenderMode,
  useRenderModeToggle,
} from "../../contexts/RenderModeContext";
import { useOptionalSessionMetadata } from "../../contexts/SessionMetadataContext";
import { useRemoteBasePath } from "../../hooks/useRemoteBasePath";
import {
  getTextTooltipAttributes,
  useTooltipMode,
} from "../../hooks/useTooltipAppearance";
import { toBrowserAppHref } from "../../lib/appHref";
import { profileRenderWork } from "../../lib/diagnostics/renderProfiler";
import { annotateGlossaryHtml } from "../../lib/glossary/annotateGlossaryHtml";
import {
  extractMarkdownSnippetsFromSelection,
  registerMarkdownCopySource,
} from "../../lib/markdownSelectionCopy";
import { useScrollPreservingToggle } from "../../lib/scrollAnchor";
import { copySemanticHtmlSelectionToClipboard } from "../../lib/semanticHtmlClipboard";
import { getSelectionPlainText } from "../../lib/selectionClipboard";
import { makeDisplayPath } from "../../lib/text";
import { presentToolOutput } from "../../lib/toolOutputPresentation";
import { FileViewerModal } from "../FilePathLink";
import { createPublicShareFileViewerSource } from "../publicShareFileViewerSource";
import { IconButton } from "./Button";
import toggleStyles from "./FixedFontRenderToggle.module.css";
import { RenderModeGlyph } from "./RenderModeGlyph";

interface FixedFontMathToggleProps {
  sourceText: string;
  sourceView: ReactNode;
  renderRenderedView: (html: string) => ReactNode;
  initialMode?: RenderMode;
  diffAware?: boolean;
  baseFilePath?: string;
  precomputedRendered?: RenderedMathResult;
  renderMode?: FixedFontRenderMode;
  projectPathLinks?: readonly ProjectPathLinkTarget[];
}

export interface RenderedMathResult {
  html: string;
  changed: boolean;
}

export type FixedFontRenderMode = "rich" | "math";

interface DiffAwareLine {
  prefix: "" | " " | "+" | "-";
  content: string;
}

interface RenderOptions {
  diffAware?: boolean;
  projectId?: string;
  baseFilePath?: string;
  basePath?: string;
  projectPath?: string;
  publicShare?: PublicShareContextValue | null;
  projectPathLinks?: readonly ProjectPathLinkTarget[];
  /** Render bare URLs in plain text as external links. */
  linkifyUrls?: boolean;
}

interface MathRenderOptions {
  diffAware?: boolean;
}

// biome-ignore lint/complexity/useRegexLiterals: constructor form avoids noControlCharactersInRegex noise for deliberate ANSI control escapes
const ANSI_ESCAPE_RE = new RegExp(
  String.raw`\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-Z\\-_])`,
  "g",
);

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeHtmlAttribute(text: string): string {
  return escapeHtml(text).replaceAll("\n", "&#10;");
}

export function stripAnsiEscapes(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

function stripDiffPathPrefix(filePath: string): string {
  return filePath.replace(/^[ab]\//, "");
}

function inferBaseFilePathFromDiff(sourceText: string): string | undefined {
  const lines = sourceText.replace(/\r\n/g, "\n").split("\n");

  for (const line of lines) {
    const match = /^\+\+\+\s+(?!\/dev\/null)(?:[ab]\/)?(.+?)\s*$/.exec(line);
    if (match?.[1]) {
      return stripDiffPathPrefix(match[1].trim());
    }
  }

  for (const line of lines) {
    const match = /^---\s+(?!\/dev\/null)(?:[ab]\/)?(.+?)\s*$/.exec(line);
    if (match?.[1]) {
      return stripDiffPathPrefix(match[1].trim());
    }
  }

  for (const line of lines) {
    const match = /^diff --git\s+a\/(.+?)\s+b\/(.+?)\s*$/.exec(line);
    if (match?.[2]) {
      return stripDiffPathPrefix(match[2].trim());
    }
    if (match?.[1]) {
      return stripDiffPathPrefix(match[1].trim());
    }
  }

  return undefined;
}

function normalizeProjectPath(filePath: string): string | null {
  const normalized: string[] = [];
  for (const part of filePath.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      if (normalized.length === 0) {
        return null;
      }
      normalized.pop();
      continue;
    }
    normalized.push(part);
  }
  return normalized.join("/");
}

function resolveMarkdownFileLink(
  href: string,
  baseFilePath?: string,
): string | null {
  const trimmed = href.trim();
  if (
    !trimmed ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
  ) {
    return null;
  }

  const pathOnly = trimmed.split(/[?#]/, 1)[0] ?? "";
  if (!pathOnly) {
    return null;
  }

  if (pathOnly.startsWith("/")) {
    return normalizeProjectPath(pathOnly.slice(1));
  }

  const baseDir = baseFilePath?.includes("/")
    ? baseFilePath.slice(0, baseFilePath.lastIndexOf("/"))
    : "";
  return normalizeProjectPath(baseDir ? `${baseDir}/${pathOnly}` : pathOnly);
}

function renderMarkdownFileLink(
  label: string,
  href: string,
  options: RenderOptions = {},
): { html: string; changed: boolean } | null {
  const filePath = resolveMarkdownFileLink(href, options.baseFilePath);
  if (!filePath) {
    return null;
  }

  const labelHtml = escapeHtml(label || href);
  if (!options.projectId) {
    return {
      html: labelHtml,
      changed: true,
    };
  }

  const rawUrl =
    options.publicShare &&
    buildPublicShareFileHref(options.publicShare, { filePath });
  const fileUrl =
    rawUrl ??
    toBrowserAppHref(
      `${options.basePath ?? ""}${buildProjectFileViewerHref({ projectId: options.projectId, filePath })}`,
    );
  // normalizeProjectPath strips the leading / from absolute paths; restore it
  // so makeDisplayPath can apply project-relative or ~/… shortening.
  const absoluteFilePath = `/${filePath}`;
  const titlePath = makeDisplayPath(absoluteFilePath, options.projectPath);
  return {
    html: `<a class="fixed-font-file-link" href="${escapeHtmlAttribute(fileUrl)}" data-fixed-font-file-path="${escapeHtmlAttribute(filePath)}" data-tooltip="${escapeHtmlAttribute(titlePath)}">${labelHtml}</a>`,
    changed: true,
  };
}

function renderUrlText(text: string, options: RenderOptions): string {
  if (!options.linkifyUrls || !containsLinkifiableUrl(text))
    return escapeHtml(text);
  return splitUrlSegments(text)
    .map((segment) =>
      segment.type === "url" && segment.href
        ? `<a href="${escapeHtmlAttribute(segment.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(segment.text)}</a>`
        : escapeHtml(segment.text),
    )
    .join("");
}

function renderConfirmedProjectPathText(
  text: string,
  options: RenderOptions,
): RenderedMathResult {
  if (!options.projectId || !options.projectPathLinks?.length) {
    const html = renderUrlText(text, options);
    return { html, changed: html !== escapeHtml(text) };
  }

  const targets = new Map(
    options.projectPathLinks.map((target) => [target.text, target.filePath]),
  );
  const matches = findProjectPathTokens(text).filter((token) =>
    targets.has(token.text),
  );
  if (matches.length === 0) {
    const html = renderUrlText(text, options);
    return { html, changed: html !== escapeHtml(text) };
  }

  let html = "";
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue;
    const filePath = targets.get(match.text)!;
    const { pathEnd, end, position } = citedProjectPathTokenExtent(
      text,
      match,
      filePath,
    );
    const pathLink = renderConfirmedFileLink(
      options.projectId,
      filePath,
      text.slice(match.start, pathEnd),
      options,
    );
    if (!pathLink) {
      // Outside the share's project, so the share cannot serve it: plain text.
      html += renderUrlText(text.slice(cursor, end), options);
      cursor = end;
      continue;
    }
    html += renderUrlText(text.slice(cursor, match.start), options);
    html += pathLink;
    if (position) {
      html +=
        renderConfirmedFileLink(
          options.projectId,
          filePath,
          position.text,
          options,
          position,
        ) ?? escapeHtml(position.text);
    }
    cursor = end;
  }
  html += renderUrlText(text.slice(cursor), options);
  return { html, changed: true };
}

/** One confirmed file link; with a position, the `:42` that opens at it. */
function renderConfirmedFileLink(
  projectId: string,
  filePath: string,
  label: string,
  options: RenderOptions,
  position?: CitedFilePosition,
): string | null {
  const coordinates = {
    filePath,
    lineNumber: position?.lineNumber,
    lineEnd: position?.lineEnd,
    columnNumber: position?.columnNumber,
  };
  const fileUrl = options.publicShare
    ? buildPublicShareFileHref(options.publicShare, coordinates)
    : toBrowserAppHref(
        `${options.basePath ?? ""}${buildProjectFileViewerHref({ projectId, ...coordinates })}`,
      );
  if (!fileUrl) return null;
  const titlePath = `${makeDisplayPath(filePath, options.projectPath)}${position?.text ?? ""}`;
  const positionAttributes = position
    ? ` data-ya-line="${position.lineNumber}"${position.lineEnd ? ` data-ya-line-end="${position.lineEnd}"` : ""}`
    : "";
  return `<a class="fixed-font-file-link" href="${escapeHtmlAttribute(fileUrl)}" data-fixed-font-file-path="${escapeHtmlAttribute(filePath)}"${positionAttributes} data-tooltip="${escapeHtmlAttribute(titlePath)}">${escapeHtml(label)}</a>`;
}

function renderKatexHtml(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(normalizeTexForKatex(tex), {
      throwOnError: false,
      displayMode,
      macros: paperKatexMacros(),
      output: "htmlAndMathml",
      strict: "ignore",
      trust: false,
    });
  } catch {
    const wrapped = displayMode ? `$$${tex}$$` : `$${tex}$`;
    return `<span>${escapeHtml(wrapped)}</span>`;
  }
}

function isEscapedDelimiter(sourceText: string, start: number): boolean {
  let precedingBackslashes = 0;
  for (let index = start - 1; index >= 0; index -= 1) {
    if (sourceText[index] !== "\\") break;
    precedingBackslashes += 1;
  }
  return precedingBackslashes % 2 === 1;
}

function findUnescapedDelimiter(
  sourceText: string,
  delimiter: string,
  start: number,
): number {
  let cursor = start;
  while (cursor < sourceText.length) {
    const match = sourceText.indexOf(delimiter, cursor);
    if (match < 0 || !isEscapedDelimiter(sourceText, match)) {
      return match;
    }
    cursor = match + delimiter.length;
  }
  return -1;
}

function tryMatchBlockMath(
  sourceText: string,
  start: number,
): { end: number; html: string } | null {
  const delimiters = sourceText.startsWith("$$", start)
    ? { close: "$$", open: "$$" }
    : sourceText.startsWith("\\[", start) &&
        !isEscapedDelimiter(sourceText, start)
      ? { close: "\\]", open: "\\[" }
      : null;
  if (!delimiters) {
    return null;
  }

  const end = findUnescapedDelimiter(
    sourceText,
    delimiters.close,
    start + delimiters.open.length,
  );
  if (end < 0) {
    return null;
  }

  const tex = sourceText.slice(start + delimiters.open.length, end).trim();
  if (!tex) {
    return null;
  }

  return {
    end: end + delimiters.close.length,
    html: renderKatexHtml(tex, true),
  };
}

function tryMatchInlineMath(
  sourceText: string,
  start: number,
): { end: number; html: string } | null {
  if (
    sourceText.startsWith("\\(", start) &&
    !isEscapedDelimiter(sourceText, start)
  ) {
    const end = findUnescapedDelimiter(sourceText, "\\)", start + 2);
    if (end < 0) {
      return null;
    }
    const tex = sourceText.slice(start + 2, end).trim();
    if (!tex || tex.includes("\n")) {
      return null;
    }
    return {
      end: end + 2,
      html: renderKatexHtml(tex, false),
    };
  }

  if (sourceText[start] !== "$") {
    return null;
  }

  const next = sourceText[start + 1];
  if (!next || /\s/.test(next)) {
    return null;
  }

  let end = start + 1;
  while (end < sourceText.length) {
    const char = sourceText[end];
    if (char === "\n") {
      return null;
    }
    if (char === "$") {
      break;
    }
    end += 1;
  }

  if (end >= sourceText.length || sourceText[end] !== "$") {
    return null;
  }

  const prev = sourceText[end - 1];
  if (!prev || /\s/.test(prev)) {
    return null;
  }

  const after = sourceText[end + 1];
  if (after && (/\d/.test(after) || after === "$")) {
    return null;
  }

  const tex = sourceText.slice(start + 1, end);
  if (!tex) {
    return null;
  }

  // Reject patterns that look like shell variable spans ($VAR >>$OTHER).
  // Real math has at least one of: \ ^ { } + or a digit.
  if (!/[\\^{}+]/.test(tex) && !/\d/.test(tex)) {
    return null;
  }

  return {
    end: end + 1,
    html: renderKatexHtml(tex, false),
  };
}

function getProfileSize(sourceText: string): { chars: number; lines: number } {
  return {
    chars: sourceText.length,
    lines: sourceText.length === 0 ? 0 : sourceText.split("\n").length,
  };
}

function renderFixedFontMathInner(sourceText: string): RenderedMathResult {
  let html = "";
  let changed = false;
  let plainStart = 0;
  let cursor = 0;

  while (cursor < sourceText.length) {
    const blockMatch = tryMatchBlockMath(sourceText, cursor);
    const inlineMatch = blockMatch
      ? null
      : tryMatchInlineMath(sourceText, cursor);
    const match = blockMatch ?? inlineMatch;

    if (!match) {
      cursor += 1;
      continue;
    }

    html += escapeHtml(sourceText.slice(plainStart, cursor));
    html += match.html;
    changed = true;
    cursor = match.end;
    plainStart = cursor;
  }

  html += escapeHtml(sourceText.slice(plainStart));
  return { html, changed };
}

export function renderFixedFontMath(
  sourceText: string,
  options: MathRenderOptions = {},
): RenderedMathResult {
  return profileRenderWork(
    "fixed-font-math",
    () => ({
      ...getProfileSize(sourceText),
      diffAware: options.diffAware ?? false,
    }),
    () =>
      options.diffAware
        ? renderDiffAwareMath(sourceText)
        : renderFixedFontMathInner(sourceText),
  );
}

function looksLikeUnifiedDiff(sourceText: string): boolean {
  const lines = sourceText.replace(/\r\n/g, "\n").split("\n");
  if (
    lines.some((line) => line.startsWith("@@ ")) ||
    lines.some((line) => line.startsWith("diff --git ")) ||
    (lines.some((line) => line.startsWith("--- ")) &&
      lines.some((line) => line.startsWith("+++ ")))
  ) {
    return true;
  }

  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return added > 0 && removed > 0 && added + removed >= 2;
}

function splitDiffAwareLine(line: string, diffAware: boolean): DiffAwareLine {
  if (
    diffAware &&
    line.length > 0 &&
    (line[0] === " " ||
      (line[0] === "+" && !line.startsWith("+++")) ||
      (line[0] === "-" && !line.startsWith("---")))
  ) {
    return {
      prefix: line[0] as DiffAwareLine["prefix"],
      content: line.slice(1),
    };
  }

  return { prefix: "", content: line };
}

function isMarkdownTableRow(content: string): boolean {
  const trimmed = content.trim();
  return (
    trimmed.startsWith("|") &&
    trimmed.endsWith("|") &&
    trimmed.split("|").length >= 4
  );
}

function getMarkdownTableCells(content: string): string[] {
  const trimmed = content.trim();
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function isMarkdownTableSeparator(content: string): boolean {
  if (!isMarkdownTableRow(content)) return false;
  const cells = getMarkdownTableCells(content);
  return (
    cells.length > 0 &&
    cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s+/g, "")))
  );
}

function getCellAlignment(separatorCell: string): string | null {
  const normalized = separatorCell.replace(/\s+/g, "");
  const left = normalized.startsWith(":");
  const right = normalized.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

function renderInlineFixedFontContent(
  sourceText: string,
  options: RenderOptions = {},
): RenderedMathResult {
  let html = "";
  let changed = false;
  let plainStart = 0;
  let cursor = 0;

  const flushPlain = (end: number) => {
    if (end > plainStart) {
      const rendered = renderConfirmedProjectPathText(
        sourceText.slice(plainStart, end),
        options,
      );
      html += rendered.html;
      if (rendered.changed) changed = true;
    }
  };

  while (cursor < sourceText.length) {
    const char = sourceText[cursor];

    if (char === "`") {
      const end = sourceText.indexOf("`", cursor + 1);
      if (end > cursor + 1) {
        flushPlain(cursor);
        const rendered = renderConfirmedProjectPathText(
          sourceText.slice(cursor + 1, end),
          options,
        );
        html += `<code>${rendered.html}</code>`;
        changed = true;
        cursor = end + 1;
        plainStart = cursor;
        continue;
      }
    }

    if (char === "[") {
      const labelEnd = sourceText.indexOf("]", cursor + 1);
      if (labelEnd > cursor + 1 && sourceText[labelEnd + 1] === "(") {
        const hrefEnd = sourceText.indexOf(")", labelEnd + 2);
        if (hrefEnd > labelEnd + 2) {
          const label = sourceText.slice(cursor + 1, labelEnd);
          const href = sourceText.slice(labelEnd + 2, hrefEnd);
          const link = renderMarkdownFileLink(label, href, options);
          if (link) {
            flushPlain(cursor);
            html += link.html;
            changed = true;
            cursor = hrefEnd + 1;
            plainStart = cursor;
            continue;
          }
        }
      }
    }

    const blockMath = tryMatchBlockMath(sourceText, cursor);
    const inlineMath = blockMath
      ? null
      : tryMatchInlineMath(sourceText, cursor);
    const math = blockMath ?? inlineMath;
    if (math) {
      flushPlain(cursor);
      html += math.html;
      changed = true;
      cursor = math.end;
      plainStart = cursor;
      continue;
    }

    const strongMarker = sourceText.startsWith("**", cursor)
      ? "**"
      : sourceText.startsWith("__", cursor)
        ? "__"
        : null;
    if (strongMarker) {
      const end = sourceText.indexOf(strongMarker, cursor + 2);
      if (end > cursor + 2) {
        flushPlain(cursor);
        const inner = renderInlineFixedFontContent(
          sourceText.slice(cursor + 2, end),
          options,
        );
        html += `<strong>${inner.html}</strong>`;
        changed = true;
        cursor = end + 2;
        plainStart = cursor;
        continue;
      }
    }

    cursor += 1;
  }

  flushPlain(sourceText.length);
  return { html, changed };
}

function diffClass(prefix: DiffAwareLine["prefix"]): string {
  if (prefix === "+") return "fixed-font-diff-added";
  if (prefix === "-") return "fixed-font-diff-removed";
  if (prefix === " ") return "";
  return "";
}

function renderDiffGutter(prefix: DiffAwareLine["prefix"]): string {
  const visible =
    prefix === "" || prefix === " " ? "&nbsp;" : escapeHtml(prefix);
  return `<span class="fixed-font-diff-gutter">${visible}</span>`;
}

function renderMarkdownTable(
  lines: DiffAwareLine[],
  start: number,
  options: RenderOptions = {},
): { end: number; html: string } | null {
  const header = lines[start];
  const separator = lines[start + 1];
  if (!header || !isMarkdownTableRow(header.content)) {
    return null;
  }

  const hasHeader = !!separator && isMarkdownTableSeparator(separator.content);
  let end = hasHeader ? start + 2 : start + 1;
  while (end < lines.length && isMarkdownTableRow(lines[end]?.content ?? "")) {
    if (
      end + 1 < lines.length &&
      isMarkdownTableSeparator(lines[end + 1]?.content ?? "")
    ) {
      break;
    }
    end += 1;
  }

  if (!hasHeader && end - start < 2) {
    return null;
  }

  const alignments = hasHeader
    ? getMarkdownTableCells(separator.content).map(getCellAlignment)
    : [];
  const bodyRows = hasHeader
    ? lines
        .slice(start + 2, end)
        .filter((line) => !isMarkdownTableSeparator(line.content))
    : lines.slice(start, end);
  const hasDiffGutter = lines
    .slice(start, end)
    .some((line) => line.prefix !== "");

  const renderCell = (
    tag: "th" | "td",
    value: string,
    index: number,
  ): string => {
    const align = alignments[index];
    const alignAttr = align ? ` style="text-align: ${align}"` : "";
    return `<${tag}${alignAttr}>${renderInlineFixedFontContent(value, options).html}</${tag}>`;
  };

  const headerHtml = hasHeader
    ? (() => {
        const headerCells = getMarkdownTableCells(header.content)
          .map((cell, index) => renderCell("th", cell, index))
          .join("");
        const headerGutter = hasDiffGutter
          ? `<th class="fixed-font-diff-gutter-cell">${renderDiffGutter(header.prefix)}</th>`
          : "";
        return `<thead><tr class="${diffClass(header.prefix)}">${headerGutter}${headerCells}</tr></thead>`;
      })()
    : "";

  const bodyHtml = bodyRows
    .map((line) => {
      const cells = getMarkdownTableCells(line.content)
        .map((cell, index) => renderCell("td", cell, index))
        .join("");
      const gutter = hasDiffGutter
        ? `<td class="fixed-font-diff-gutter-cell">${renderDiffGutter(line.prefix)}</td>`
        : "";
      return `<tr class="${diffClass(line.prefix)}">${gutter}${cells}</tr>`;
    })
    .join("");

  return {
    end,
    html: `<div class="fixed-font-markdown-block"><table class="fixed-font-markdown-table">${headerHtml}<tbody>${bodyHtml}</tbody></table></div>`,
  };
}

/**
 * A TOON flat table (acli's opt-in tabular format) at this position renders
 * as a real table, sharing the markdown-table styling. Gated on a strict
 * header + row-count parse so ordinary output never misfires.
 */
function renderToonBlock(
  lines: DiffAwareLine[],
  start: number,
  diffAware: boolean,
): { end: number; html: string } | null {
  if (diffAware) return null;
  const headerLine = lines[start]?.content.trim() ?? "";
  const headerMatch = headerLine.match(/^[\w.-]+\[(\d+)\]\{[^}]*\}:$/);
  if (!headerMatch) return null;
  const end = start + 1 + Number(headerMatch[1]);
  if (end > lines.length) return null;
  const tables = parseToonDocument(
    lines
      .slice(start, end)
      .map((line) => line.content)
      .join("\n"),
  );
  const table = tables?.length === 1 ? tables[0] : undefined;
  if (!table) return null;
  const headerHtml = `<thead><tr>${table.columns
    .map((column) => `<th>${escapeHtml(column)}</th>`)
    .join("")}</tr></thead>`;
  const bodyHtml = table.rows
    .map(
      (row) =>
        `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join("")}</tr>`,
    )
    .join("");
  return {
    end,
    html: `<div class="fixed-font-markdown-block"><table class="fixed-font-markdown-table">${headerHtml}<tbody>${bodyHtml}</tbody></table></div>`,
  };
}

function renderMarkdownLineContent(
  content: string,
  options: RenderOptions = {},
): {
  html: string;
  changed: boolean;
  className?: string;
  style?: string;
} {
  const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(content);
  if (heading?.[1] && heading[2]) {
    return {
      html: renderInlineFixedFontContent(heading[2], options).html,
      changed: true,
      className: `fixed-font-markdown-heading fixed-font-markdown-heading-${heading[1].length}`,
    };
  }

  if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(content)) {
    return {
      html: '<span class="fixed-font-markdown-rule" aria-hidden="true"></span>',
      changed: true,
      className: "",
    };
  }

  const blockquote = /^\s{0,3}>\s?(.*)$/.exec(content);
  if (blockquote) {
    return {
      html: renderInlineFixedFontContent(blockquote[1] ?? "", options).html,
      changed: true,
      className: "fixed-font-markdown-blockquote",
    };
  }

  const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.+)$/.exec(content);
  if (listItem?.[2] && listItem[3]) {
    const leadingColumns = listItem[1]?.length ?? 0;
    const markerColumns = listItem[2].length + 1;
    const markerHtml = /^\d/.test(listItem[2])
      ? escapeHtml(listItem[2])
      : "&bull;";
    return {
      html: `<span class="fixed-font-markdown-list-marker">${markerHtml}</span><span class="fixed-font-markdown-list-body">${renderInlineFixedFontContent(listItem[3], options).html}</span>`,
      changed: true,
      className: "fixed-font-markdown-list-line",
      style: `--fixed-font-list-indent-ch:${leadingColumns};--fixed-font-list-marker-ch:${markerColumns};`,
    };
  }

  const leadingSpaces = /^(\s+)(\S[\s\S]*)$/.exec(content);
  if (leadingSpaces?.[1] && leadingSpaces[2]) {
    const inline = renderInlineFixedFontContent(leadingSpaces[2], options);
    return {
      html: `<span class="fixed-font-leading-indent" style="--fixed-font-leading-ch:${leadingSpaces[1].length};"></span>${inline.html}`,
      changed: inline.changed,
    };
  }

  const inline = renderInlineFixedFontContent(content, options);
  return inline;
}

function renderStandaloneDisplayMath(
  lines: DiffAwareLine[],
  start: number,
  diffAware: boolean,
): { end: number; html: string } | null {
  const opening = lines[start]?.content.trim();
  const closing = opening === "$$" ? "$$" : opening === "\\[" ? "\\]" : null;
  if (!closing) return null;

  let end = start + 1;
  while (end < lines.length && lines[end]?.content.trim() !== closing) {
    end += 1;
  }
  if (end >= lines.length) return null;

  const tex = lines
    .slice(start + 1, end)
    .map((line) => line.content)
    .join("\n")
    .trim();
  if (!tex) return null;

  const mathHtml = renderKatexHtml(tex, true);
  if (diffAware) {
    const blockLines = lines.slice(start, end + 1);
    const prefix = blockLines[0]?.prefix ?? "";
    if (blockLines.some((line) => line.prefix !== prefix)) {
      return null;
    }
    return {
      end: end + 1,
      html: renderRichLine(
        { content: "", prefix },
        {
          changed: true,
          className: "",
          html: mathHtml,
        },
      ),
    };
  }

  return {
    end: end + 1,
    html: mathHtml,
  };
}

function renderRichLine(
  line: DiffAwareLine,
  rendered: ReturnType<typeof renderMarkdownLineContent>,
): string {
  const classes = [
    "fixed-font-rendered-line",
    diffClass(line.prefix),
    rendered.className,
  ]
    .filter(Boolean)
    .join(" ");
  const styleAttr = rendered.style ? ` style="${rendered.style}"` : "";
  return `<div class="${classes}">${renderDiffGutter(line.prefix)}<div class="fixed-font-rendered-line__content"${styleAttr}>${rendered.html}</div></div>`;
}

function renderDiffAwareMath(sourceText: string): RenderedMathResult {
  const lines = stripAnsiEscapes(sourceText)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => splitDiffAwareLine(line, true));
  let html = "";
  let changed = false;
  let index = 0;

  while (index < lines.length) {
    const displayMath = renderStandaloneDisplayMath(lines, index, true);
    if (displayMath) {
      html += displayMath.html;
      changed = true;
      index = displayMath.end;
      continue;
    }

    const line = lines[index];
    if (!line) {
      index += 1;
      continue;
    }
    const rendered = renderFixedFontMathInner(line.content);
    html += renderRichLine(line, rendered);
    if (rendered.changed) {
      changed = true;
    }
    index += 1;
  }

  return { html, changed };
}

function renderFixedFontRichContentInner(
  sourceText: string,
  options: RenderOptions = {},
): RenderedMathResult {
  const renderText = stripAnsiEscapes(sourceText);
  const baseFilePath =
    options.baseFilePath ?? inferBaseFilePathFromDiff(renderText);
  const diffAware = options.diffAware ?? looksLikeUnifiedDiff(renderText);
  // Structured output owns its strings. Markdown and math inside JSON are
  // data unless a separately declared renderer explicitly interprets them.
  if (
    !diffAware &&
    presentToolOutput(renderText).some((part) => part.kind !== "text")
  ) {
    return { html: escapeHtml(renderText), changed: false };
  }
  const renderOptions: RenderOptions = {
    ...options,
    baseFilePath,
    diffAware,
  };
  const lines = renderText
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => splitDiffAwareLine(line, diffAware));

  let html = "";
  let changed = false;
  let index = 0;

  while (index < lines.length) {
    const displayMath = renderStandaloneDisplayMath(lines, index, diffAware);
    if (displayMath) {
      html += displayMath.html;
      if (displayMath.end < lines.length) html += "\n";
      changed = true;
      index = displayMath.end;
      continue;
    }

    const toon = renderToonBlock(lines, index, diffAware);
    if (toon) {
      html += toon.html;
      changed = true;
      index = toon.end;
      continue;
    }

    const table = renderMarkdownTable(lines, index, renderOptions);
    if (table) {
      html += table.html;
      changed = true;
      index = table.end;
      continue;
    }

    const line = lines[index];
    if (!line) {
      index += 1;
      continue;
    }
    const rendered = renderMarkdownLineContent(line.content, renderOptions);
    if (rendered.changed) changed = true;

    if (diffAware) {
      html += renderRichLine(line, rendered);
    } else {
      html += rendered.html;
      if (index < lines.length - 1) html += "\n";
    }
    index += 1;
  }

  return { html, changed };
}

export function renderFixedFontRichContent(
  sourceText: string,
  options: RenderOptions = {},
): RenderedMathResult {
  return profileRenderWork(
    "fixed-font-rich-content",
    () => ({
      ...getProfileSize(sourceText),
      diffAware: options.diffAware ?? null,
      hasProjectId: Boolean(options.projectId),
      hasBaseFilePath: Boolean(options.baseFilePath),
    }),
    () => renderFixedFontRichContentInner(sourceText, options),
  );
}

export function mayHaveFixedFontRichContent(sourceText: string): boolean {
  if (!sourceText) {
    return false;
  }

  if (
    sourceText.includes("$") ||
    sourceText.includes("\\(") ||
    sourceText.includes("\\[") ||
    sourceText.includes("`") ||
    sourceText.includes("[") ||
    sourceText.includes("**") ||
    sourceText.includes("__")
  ) {
    return true;
  }

  return /(^|\n)\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+|[-*_]{3,}\s*$|\|.*\|)/.test(
    sourceText,
  );
}

export function hasFixedFontRichContent(
  sourceText: string,
  options: RenderOptions = {},
): boolean {
  return renderFixedFontRichContent(sourceText, options).changed;
}

function applyRenderedTooltipMode(
  html: string,
  tooltipMode: "themed" | "native",
): string {
  return tooltipMode === "themed"
    ? html
    : html.replace(
        / data-tooltip="([^"]*)"/g,
        (_match, text: string) => ` title="${text}"`,
      );
}

export function FixedFontMathToggle({
  sourceText,
  sourceView,
  renderRenderedView,
  diffAware,
  baseFilePath,
  initialMode,
  precomputedRendered,
  renderMode = "rich",
  projectPathLinks,
}: FixedFontMathToggleProps) {
  const sessionMetadata = useOptionalSessionMetadata();
  const publicShare = usePublicShareContext();
  const basePath = useRemoteBasePath();
  const tooltipMode = useTooltipMode();
  const { projectPaths, mentionedDirectories } = useProjectPathLinkSettings();
  const glossary = useGlossaryArtifact(baseFilePath);
  const [viewerLink, setViewerLink] = useState<{
    filePath: string;
    href: string | null;
    lineNumber?: number;
    lineEnd?: number;
  } | null>(null);
  const copySourceRef = useRef<HTMLDivElement | null>(null);
  const quoteSourceText = useMemo(
    () => stripAnsiEscapes(sourceText),
    [sourceText],
  );
  const publicShareFileViewerSource = useMemo(
    () =>
      publicShare ? createPublicShareFileViewerSource(publicShare) : undefined,
    [publicShare],
  );
  const rendered = useMemo(
    () =>
      precomputedRendered ??
      (renderMode === "math"
        ? renderFixedFontMath(sourceText, { diffAware })
        : renderFixedFontRichContent(sourceText, {
            diffAware,
            projectId: sessionMetadata?.projectId,
            projectPath: sessionMetadata?.projectPath ?? undefined,
            baseFilePath,
            basePath,
            publicShare,
            projectPathLinks,
          })),
    [
      precomputedRendered,
      sourceText,
      renderMode,
      diffAware,
      sessionMetadata?.projectId,
      sessionMetadata?.projectPath,
      baseFilePath,
      basePath,
      publicShare,
      projectPathLinks,
    ],
  );
  const { showRendered, toggleLocalMode } = useRenderModeToggle(
    rendered.changed,
    {
      initialMode,
      renderWhenDisabled: false,
      resetDependencies: [sourceText, renderMode],
    },
  );
  const { btnRef: toggleBtnRef, handleClick: handleToggleClick } =
    useScrollPreservingToggle(showRendered, toggleLocalMode);
  const presentedHtml = useMemo(() => {
    const linkedHtml = annotateProjectPathLinksHtml(
      rendered.html,
      undefined,
      sessionMetadata?.projectId,
      publicShare,
      { projectPaths, mentionedDirectories },
    ).html;
    const tooltipHtml = applyRenderedTooltipMode(linkedHtml, tooltipMode);
    return annotateGlossaryHtml(
      tooltipHtml,
      glossary.state === "ready" && glossary.result?.status === "ready"
        ? glossary.result.artifact
        : undefined,
    ).html;
  }, [
    glossary,
    rendered.html,
    tooltipMode,
    projectPaths,
    mentionedDirectories,
    sessionMetadata?.projectId,
    publicShare,
  ]);

  useEffect(() => {
    const element = copySourceRef.current;
    if (!element || !quoteSourceText.trim()) {
      return;
    }
    return registerMarkdownCopySource(
      element,
      quoteSourceText,
      undefined,
      showRendered && rendered.changed ? "rendered" : "literal",
    );
  }, [quoteSourceText, showRendered, rendered.changed]);

  const handleRenderedClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const link = (event.target as Element | null)?.closest?.(
        "a[data-fixed-font-file-path]",
      ) as HTMLAnchorElement | null;
      if (!link) {
        return;
      }
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setViewerLink({
        filePath: link.dataset.fixedFontFilePath ?? "",
        href: link.getAttribute("href"),
        lineNumber: Number(link.dataset.yaLine) || undefined,
        lineEnd: Number(link.dataset.yaLineEnd) || undefined,
      });
    },
    [],
  );
  const handleRenderedCopy: ClipboardEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      const sourceRoot = copySourceRef.current;
      const text = sourceRoot
        ? getSelectionPlainText(
            extractMarkdownSnippetsFromSelection(sourceRoot),
          )
        : "";
      const copied = copySemanticHtmlSelectionToClipboard(
        event.nativeEvent,
        event.currentTarget,
      );
      if (copied && text) {
        event.clipboardData.setData("text/plain", text);
      }
    },
    [],
  );
  const viewerProjectId =
    sessionMetadata?.projectId ?? publicShare?.projectId ?? "";

  return (
    <div
      ref={copySourceRef}
      className={codeStyles.fixedFontRenderToggle}
      data-fixed-font-render-toggle
      data-render-mode={
        showRendered && rendered.changed ? "rendered" : "source"
      }
    >
      {showRendered && rendered.changed ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: click is delegated to rendered file links inside the HTML
        // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard activation remains on descendant links
        <div onClick={handleRenderedClick} onCopy={handleRenderedCopy}>
          {renderRenderedView(presentedHtml)}
        </div>
      ) : (
        sourceView
      )}
      {rendered.changed && (
        <IconButton
          variant="outline"
          elevated
          size="dense"
          ref={toggleBtnRef}
          className={toggleStyles.button}
          data-fixed-font-toggle=""
          onClick={handleToggleClick}
          label={showRendered ? "Show source" : "Show rendered view"}
          {...getTextTooltipAttributes(
            showRendered ? "Show source" : "Show rendered view",
            tooltipMode,
          )}
          aria-pressed={showRendered}
        >
          <RenderModeGlyph />
        </IconButton>
      )}
      {viewerLink && viewerProjectId !== "" && (
        <FileViewerModal
          projectId={viewerProjectId}
          filePath={viewerLink.filePath}
          lineNumber={viewerLink.lineNumber}
          lineEnd={viewerLink.lineEnd}
          source={publicShareFileViewerSource}
          openInNewTabUrl={viewerLink.href}
          onClose={() => setViewerLink(null)}
        />
      )}
    </div>
  );
}
