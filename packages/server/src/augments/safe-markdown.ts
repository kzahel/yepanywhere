import { readFileSync, statSync } from "node:fs";
import { isAbsolute, normalize, posix, win32 } from "node:path";
import { katex as markdownItKatex } from "@mdit/plugin-katex";
import katex from "katex";
import {
  buildProjectFileViewerHref,
  type LocalResourceMediaType,
  linkifyToHtml,
  normalizeTexForKatex,
  paperKatexMacros,
  parseLineColumn,
} from "@yep-anywhere/shared";
import MarkdownIt, {
  type Env,
  type Renderer,
  type RendererRule,
  type StateBlock,
  type StateCore,
  type Token,
} from "markdown-it";
import sanitizeHtml from "sanitize-html";
import type { CitationRenderOptions } from "./citation-sources.js";
import { installMarkdownCitations } from "./markdown-citations.js";
import { escapeHtml } from "./markdown-html-escaping.js";
export { escapeHtml } from "./markdown-html-escaping.js";
import type { ProjectPathIndex } from "../projects/projectPathIndex.js";
import { renderUnicodeScripts } from "./unicode-math.js";
import {
  findUnicodeMath,
  loadUnicodeMathParams,
  type UnicodeMathParams,
  unicodeMathToKatexSource,
} from "./unicode-math-recognizer.js";

const ALLOWED_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const ALLOWED_IMAGE_PROTOCOLS = new Set(["http:", "https:"]);

const IMAGE_EXTENSIONS = new Set([
  "apng",
  "avif",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "tiff",
  "tif",
  "svg",
]);

const EXTENSIONLESS_IMAGE_CANDIDATES = [
  "svg",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
] as const;

const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "avi", "mkv", "ogv"]);

const AUDIO_EXTENSIONS = new Set([
  "wav",
  "mp3",
  "ogg",
  "oga",
  "opus",
  "m4a",
  "aac",
  "flac",
]);

const MEDIA_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
]);

function localMediaType(ext: string): LocalResourceMediaType {
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  return "image";
}
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "qmd"]);

export interface SafeMarkdownRenderOptions extends CitationRenderOptions {
  /**
   * Directory that relative local markdown links are resolved against.
   *
   * Links and images may climb out of it with `..`; the project, local-file
   * and share endpoints they reach perform their own access checks. Quarto
   * includes, which inline the target's text, stay within it.
   */
  localFileBasePath?: string;
  /**
   * Emit direct <img> tags for local images instead of the interactive YA
   * inline-media placeholder. Used by standalone rendered documents that do
   * not run the React inline-preview hydrator.
   */
  inlineLocalImages?: boolean;
  /** Interpret supported Quarto Markdown syntax without executing Quarto. */
  quartoMarkdown?: boolean;
  /**
   * Keep relative and fragment link and image references as written. A
   * document served by URL beside the files it names, as a file vhost serves
   * one, lets the browser resolve them, and its server decides what each
   * reaches.
   */
  siteRelativeReferences?: boolean;
  /**
   * Render as a whole document whose in-page links work: headings get slug
   * ids, author `id`/`name` targets survive, and `#fragment` links point at
   * them, all under `DOCUMENT_ANCHOR_ID_PREFIX`. Off for message fragments,
   * which share one page and would collide.
   */
  documentAnchors?: DocumentAnchorOptions;
  /**
   * Project context for turning assistant inline-code filename references into
   * project-file viewer links. Public shares supply it too, with `publicShare`
   * set and no absolute-path resolver.
   */
  projectFileLinks?: ProjectFileLinkOptions;
}

/**
 * Prefix on every id a rendered document defines, as GitHub uses, so a
 * document's `root` or `app` cannot collide with or clobber the page's own
 * elements.
 */
export const DOCUMENT_ANCHOR_ID_PREFIX = "user-content-";

export interface DocumentAnchorOptions {
  /**
   * Base heading slugs of the same document's earlier text, in order, when
   * the document is rendered in parts; duplicate headings then keep the ids
   * a whole-document render gives them.
   */
  precedingHeadingSlugs?: readonly string[];
}

let activeRenderOptions: SafeMarkdownRenderOptions = {};
let projectFileCodeLinkCache = new Map<string, ProjectFileCodeLink | null>();

export interface ProjectFileLinkOptions {
  projectId: string;
  projectPath: string;
  /** Bare-path annotation may use only facts already cached in the index. */
  pathDiscovery?: "known-only" | "resolve";
  /**
   * Watcher-backed membership oracle for this project.
   *
   * Supplying it makes the trie the authority for "is this a file", so an
   * inline-code reference and a bare prose path are decided by one cache rather
   * than by two that can disagree. `statSync` stays only as the backstop for
   * what the trie cannot prove.
   */
  index?: ProjectPathIndex;
  fileExists?: (absolutePath: string, relativePath: string) => boolean;
  /**
   * Resolve bounded batches of absolute-path tokens through the authenticated
   * local-file allow-set. Omit for every public-share rendering path.
   */
  resolveAbsoluteFilePaths?: (
    paths: readonly string[],
  ) => Promise<ReadonlySet<string>>;
  /** Positive allow-set facts already resolved without starting new I/O. */
  knownAbsoluteFilePaths?: (paths: readonly string[]) => ReadonlySet<string>;
  /** Marks a synchronous filesystem fallback that cannot back retained HTML. */
  onUnversionedLookup?: () => void;
  /**
   * Render for a public share viewer rather than the authenticated owner.
   *
   * A share already serves the project files its session mentions, through its
   * own share-scoped endpoint, so an in-project link is one the viewer can
   * follow. The href keeps its `/projects/:id/file` form — the share client
   * rewrites that to a share file URL — and drops the private marker that
   * client unwraps back into plain code. Absolute-path resolution stays absent
   * for shares, so nothing outside the project becomes a link.
   */
  publicShare?: boolean;
}

interface LocalPathReference {
  filePath: string;
  lineNumber?: number;
  columnNumber?: number;
}

interface LocalResourceAttributeOptions {
  mediaType?: LocalResourceMediaType;
  renderMarkdown?: boolean;
}

interface ProjectFileCodeLink {
  absolutePath: string;
  columnNumber?: number;
  lineNumber?: number;
  relativePath: string;
}

function stripHrefSuffix(href: string): string {
  return href.split(/[?#]/, 1)[0] ?? "";
}

function parseLocalPathReference(path: string): LocalPathReference {
  const parsed = parseLineColumn(stripHrefSuffix(path.trim()));
  return {
    filePath: parsed.path,
    lineNumber: parsed.line,
    columnNumber: parsed.column,
  };
}

function toLocalPathReference(
  reference: LocalPathReference | string,
): LocalPathReference {
  return typeof reference === "string"
    ? parseLocalPathReference(reference)
    : reference;
}

function formatLocalPathReference(reference: LocalPathReference): string {
  let display = reference.filePath;
  if (reference.lineNumber !== undefined) {
    display += `:${reference.lineNumber}`;
    if (reference.columnNumber !== undefined) {
      display += `:${reference.columnNumber}`;
    }
  }
  return display;
}

/**
 * Check if a string looks like an absolute local file path.
 * Must be a POSIX or Windows absolute path and contain a file extension.
 */
function isLocalFilePath(href: string): boolean {
  const trimmed = parseLocalPathReference(href).filePath;
  const isPosixAbsolute = trimmed.startsWith("/") && !trimmed.startsWith("//");
  const isWindowsDriveAbsolute = isWindowsDriveAbsolutePath(trimmed);
  if (!isPosixAbsolute && !isWindowsDriveAbsolute) return false;

  // Must have a file extension after the last path separator.
  const basename = trimmed.split(/[\\/]/).pop() ?? "";
  return basename.includes(".");
}

/**
 * Get the file extension from a path (lowercase, without the dot).
 */
function getExtension(path: string): string {
  return (
    parseLocalPathReference(path).filePath.split(".").pop() ?? ""
  ).toLowerCase();
}

/**
 * Get the filename from a path.
 */
function getFileName(path: string): string {
  return parseLocalPathReference(path).filePath.split(/[\\/]/).pop() ?? path;
}

function isMarkdownExtension(ext: string): boolean {
  return MARKDOWN_EXTENSIONS.has(ext);
}

function isWindowsDriveAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path);
}

interface RawMarkdownDestination {
  enclosed: boolean;
  pathStart: number;
}

function findRawWindowsDriveDestination(
  raw: string,
  kind: "definition" | "inline",
): RawMarkdownDestination | null {
  const match =
    kind === "definition"
      ? /^ {0,3}\[(?:\\.|[^\]\\])+\]:[ \t]*(<?)([A-Za-z]:[\\/])/.exec(raw)
      : /\]\([ \t]*(<?)([A-Za-z]:[\\/])/.exec(raw);
  if (!match || match.index === undefined) {
    return null;
  }

  const drivePrefix = match[2];
  if (!drivePrefix) {
    return null;
  }

  return {
    enclosed: match[1] === "<",
    pathStart: match.index + match[0].length - drivePrefix.length,
  };
}

function canonicalizeRawWindowsDriveDestination(
  raw: string,
  kind: "definition" | "inline",
): string | null {
  const destination = findRawWindowsDriveDestination(raw, kind);
  if (!destination) {
    return null;
  }

  let pathEnd = destination.pathStart;
  let parenthesisDepth = 0;
  while (pathEnd < raw.length) {
    const character = raw[pathEnd];
    if (destination.enclosed) {
      if (character === ">") break;
    } else {
      if (/\s/.test(character ?? "") && parenthesisDepth === 0) break;
      if (character === "(") {
        parenthesisDepth += 1;
      } else if (character === ")") {
        if (parenthesisDepth === 0) break;
        parenthesisDepth -= 1;
      }
    }
    pathEnd += 1;
  }

  const filePath = raw.slice(destination.pathStart, pathEnd);
  if (!filePath.includes("\\") || !isWindowsDriveAbsolutePath(filePath)) {
    return null;
  }

  return filePath.replace(/\\+/g, "/");
}

function repairWindowsDriveInlineDestinations(source: string): string {
  let result = "";
  let cursor = 0;

  while (cursor < source.length) {
    if (source[cursor] === "`") {
      let markerEnd = cursor + 1;
      while (source[markerEnd] === "`") markerEnd += 1;
      const marker = source.slice(cursor, markerEnd);
      const closing = source.indexOf(marker, markerEnd);
      if (closing >= 0) {
        const end = closing + marker.length;
        result += source.slice(cursor, end);
        cursor = end;
        continue;
      }
      result += marker;
      cursor = markerEnd;
      continue;
    }

    const remainder = source.slice(cursor);
    const destination = findRawWindowsDriveDestination(remainder, "inline");
    if (!destination) {
      result += remainder;
      break;
    }

    const nextBacktick = source.indexOf("`", cursor);
    if (nextBacktick >= 0 && nextBacktick - cursor < destination.pathStart) {
      result += source.slice(cursor, nextBacktick);
      cursor = nextBacktick;
      continue;
    }

    const corrected = canonicalizeRawWindowsDriveDestination(
      remainder,
      "inline",
    );
    if (!corrected) {
      result += remainder;
      break;
    }

    const pathStart = cursor + destination.pathStart;
    let pathEnd = pathStart;
    let parenthesisDepth = 0;
    while (pathEnd < source.length) {
      const character = source[pathEnd];
      if (destination.enclosed) {
        if (character === ">") break;
      } else {
        if (/\s/.test(character ?? "") && parenthesisDepth === 0) break;
        if (character === "(") {
          parenthesisDepth += 1;
        } else if (character === ")") {
          if (parenthesisDepth === 0) break;
          parenthesisDepth -= 1;
        }
      }
      pathEnd += 1;
    }

    result += source.slice(cursor, pathStart);
    result += corrected;
    cursor = pathEnd;
  }

  return result;
}

/**
 * Repair drive-letter destinations before markdown-it consumes backslash
 * escapes. Block parsing has already excluded fenced/indented code; the inline
 * scanner additionally skips matching backtick spans.
 */
function repairWindowsDriveMarkdownDestinations(state: StateCore): void {
  const seenReferences = new Set<string>();
  let lineStarts: number[] | undefined;

  for (const token of state.tokens) {
    if (token.type === "inline") {
      token.content = repairWindowsDriveInlineDestinations(token.content);
      continue;
    }

    if (token.type !== "reference_definition" || !token.map) continue;
    const label = token.meta?.label;
    if (typeof label !== "string" || seenReferences.has(label)) continue;
    seenReferences.add(label);

    lineStarts ??= sourceLineStartOffsets(state.src);
    const start = lineStarts[token.map[0]] ?? state.src.length;
    const end = lineStarts[token.map[1]] ?? state.src.length;
    const raw = state.src.slice(start, end);
    const corrected = canonicalizeRawWindowsDriveDestination(raw, "definition");
    const reference = state.env.references?.[label];
    if (corrected && reference) {
      reference.href = corrected;
    }
  }
}

function sourceLineStartOffsets(source: string): number[] {
  const starts = [0];
  let newline = source.indexOf("\n");
  while (newline >= 0) {
    starts.push(newline + 1);
    newline = source.indexOf("\n", newline + 1);
  }
  if (starts[starts.length - 1] !== source.length) {
    starts.push(source.length);
  }
  return starts;
}

const LITERAL_MATH_META = "yaLiteralMath";

function preserveUnclosedMathBlocks(state: StateCore): void {
  let lineStarts: number[] | undefined;
  for (const token of state.tokens) {
    if (token.type !== "math_block" || !token.map) continue;
    lineStarts ??= sourceLineStartOffsets(state.src);
    const start = lineStarts[token.map[0]] ?? state.src.length;
    const end = lineStarts[token.map[1]] ?? state.src.length;
    const raw = state.src.slice(start, end);
    const closing = token.markup === "\\[" ? "\\]" : token.markup;
    const trimmed = raw.trimEnd();
    if (trimmed.length > closing.length && trimmed.endsWith(closing)) continue;

    token.meta ??= {};
    token.meta[LITERAL_MATH_META] = raw;
  }
}

function getProjectPathFlavor(path: string): "posix" | "windows" {
  return isWindowsDriveAbsolutePath(path) || path.includes("\\")
    ? "windows"
    : "posix";
}

function isProjectAbsolutePath(
  path: string,
  flavor: "posix" | "windows",
): boolean {
  return flavor === "windows" ? win32.isAbsolute(path) : posix.isAbsolute(path);
}

function resolveProjectPath(
  basePath: string,
  path: string,
  flavor: "posix" | "windows",
): string {
  return flavor === "windows"
    ? win32.resolve(basePath, path)
    : posix.resolve(basePath, path.replaceAll("\\", "/"));
}

function relativeProjectPath(
  fromPath: string,
  toPath: string,
  flavor: "posix" | "windows",
): string {
  return flavor === "windows"
    ? win32.relative(fromPath, toPath)
    : posix.relative(fromPath, toPath);
}

function isPathInsideProject(
  absolutePath: string,
  projectRoot: string,
  flavor: "posix" | "windows",
): boolean {
  const relativePath = relativeProjectPath(projectRoot, absolutePath, flavor);
  return (
    relativePath !== "" &&
    !relativePath.startsWith("..") &&
    !isProjectAbsolutePath(relativePath, flavor)
  );
}

function resolveLocalRelativePath(
  basePath: string,
  relativePath: string,
): string {
  if (isWindowsDriveAbsolutePath(basePath) || basePath.includes("\\")) {
    return win32.resolve(basePath, relativePath);
  }
  return posix.resolve(basePath, relativePath.replaceAll("\\", "/"));
}

/**
 * Rewrite a local media path to the local-image API endpoint.
 */
function localMediaApiUrl(path: string): string {
  return `/api/local-image?path=${encodeURIComponent(
    parseLocalPathReference(path).filePath,
  )}`;
}

/**
 * Rewrite a local text file path to the local-file API endpoint.
 */
function localFileApiUrl(
  reference: LocalPathReference | string,
  options: { renderMarkdown?: boolean } = {},
): string {
  const parsed = toLocalPathReference(reference);
  let url = `/api/local-file?path=${encodeURIComponent(parsed.filePath)}`;
  if (options.renderMarkdown) {
    url += "&render=1";
  }
  if (parsed.lineNumber !== undefined) {
    url += `&line=${parsed.lineNumber}`;
  }
  if (parsed.columnNumber !== undefined) {
    url += `&column=${parsed.columnNumber}`;
  }
  return url;
}

function localResourceDataAttributes(
  kind: "local-file" | "local-media",
  reference: LocalPathReference | string,
  options: LocalResourceAttributeOptions = {},
): string {
  const parsed = toLocalPathReference(reference);
  const attributes: Array<[string, string]> = [
    ["data-ya-resource", kind],
    ["data-ya-path", parsed.filePath],
  ];

  if (parsed.lineNumber !== undefined) {
    attributes.push(["data-ya-line", String(parsed.lineNumber)]);
  }
  if (parsed.columnNumber !== undefined) {
    attributes.push(["data-ya-column", String(parsed.columnNumber)]);
  }
  if (options.renderMarkdown !== undefined) {
    attributes.push([
      "data-ya-render-markdown",
      options.renderMarkdown ? "true" : "false",
    ]);
  }
  if (options.mediaType) {
    attributes.push(["data-ya-media-type", options.mediaType]);
  }

  return attributes
    .map(([name, value]) => `${name}="${escapeHtml(value)}"`)
    .join(" ");
}

function renderLocalFileLink(
  reference: LocalPathReference | string,
  labelHtml: string,
  options: { renderMarkdown?: boolean; title?: string } = {},
): string {
  return `${renderLocalFileLinkOpen(reference, options)}${labelHtml}</a>`;
}

function renderLocalFileLinkOpen(
  reference: LocalPathReference | string,
  options: { renderMarkdown?: boolean; title?: string } = {},
): string {
  const parsed = toLocalPathReference(reference);
  const apiUrl = escapeHtml(
    localFileApiUrl(parsed, { renderMarkdown: options.renderMarkdown }),
  );
  const title = options.title ?? formatLocalPathReference(parsed);
  const titleAttr = ` title="${escapeHtml(title)}"`;
  const resourceAttrs = localResourceDataAttributes("local-file", parsed, {
    renderMarkdown: options.renderMarkdown,
  });
  return `<a href="${apiUrl}"${titleAttr} ${resourceAttrs}>`;
}

function defaultProjectFileExists(absolutePath: string): boolean {
  try {
    return statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether this reference names a file, preferring the watcher-backed trie.
 *
 * The trie answers from cache with no filesystem call, and `undefined` means it
 * proves nothing — which includes every path under a directory whose watch was
 * lost. That degrades to the `statSync` this resolver used before the trie
 * existed, so an unproven path re-asks rather than going unlinked.
 */
function projectFileExists(
  options: ProjectFileLinkOptions,
  absolutePath: string,
  relativePath: string,
): boolean {
  const known = options.index?.knownFile(relativePath);
  if (known !== undefined) return known;
  if (options.pathDiscovery === "known-only") return false;
  options.onUnversionedLookup?.();
  return options.fileExists
    ? options.fileExists(absolutePath, relativePath)
    : defaultProjectFileExists(absolutePath);
}

function localMarkdownImageExists(absolutePath: string): boolean {
  const projectOptions = activeRenderOptions.projectFileLinks;
  if (!projectOptions) {
    return defaultProjectFileExists(absolutePath);
  }

  const flavor = getProjectPathFlavor(projectOptions.projectPath);
  const projectRoot = resolveProjectPath(
    projectOptions.projectPath,
    "",
    flavor,
  );
  const normalizedPath = resolveProjectPath(absolutePath, "", flavor);
  if (!isPathInsideProject(normalizedPath, projectRoot, flavor)) {
    return defaultProjectFileExists(normalizedPath);
  }

  const relativePath = relativeProjectPath(
    projectRoot,
    normalizedPath,
    flavor,
  ).replaceAll("\\", "/");
  return projectFileExists(projectOptions, normalizedPath, relativePath);
}

function resolveLocalMarkdownImage(
  reference: LocalPathReference,
): { ext: string; reference: LocalPathReference } | null {
  const exactExtension = getExtension(reference.filePath);
  if (MEDIA_EXTENSIONS.has(exactExtension)) {
    return { ext: exactExtension, reference };
  }

  const fileName = getFileName(reference.filePath);
  if (fileName.includes(".")) {
    return null;
  }

  for (const ext of EXTENSIONLESS_IMAGE_CANDIDATES) {
    const candidate = {
      ...reference,
      filePath: `${reference.filePath}.${ext}`,
    };
    if (localMarkdownImageExists(candidate.filePath)) {
      return { ext, reference: candidate };
    }
  }
  return null;
}

function resolveProjectFileCodeReference(
  text: string,
  options: ProjectFileLinkOptions,
): ProjectFileCodeLink | null {
  const trimmed = text.trim();
  if (
    !trimmed ||
    trimmed.includes("\n") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("//")
  ) {
    return null;
  }

  const parsed = parseLocalPathReference(trimmed);
  const filePath = parsed.filePath;
  if (
    !filePath ||
    filePath === "." ||
    filePath.endsWith("/") ||
    filePath.endsWith("\\") ||
    (/^[a-z][a-z0-9+.-]*:/i.test(filePath) &&
      !isWindowsDriveAbsolutePath(filePath))
  ) {
    return null;
  }

  const cacheKey = `${options.projectId}\0${options.projectPath}\0${trimmed}`;
  // The trie invalidates on a watch event; this module-level map never does. So
  // it memoizes only the `statSync` oracle it was built for — layering it over
  // the trie would let an answer outlive the fact behind it.
  const memoize = !options.index;
  if (memoize && projectFileCodeLinkCache.has(cacheKey)) {
    return projectFileCodeLinkCache.get(cacheKey) ?? null;
  }

  const flavor = getProjectPathFlavor(options.projectPath);
  const projectRoot = resolveProjectPath(options.projectPath, "", flavor);
  const absolutePath = isProjectAbsolutePath(filePath, flavor)
    ? resolveProjectPath(filePath, "", flavor)
    : resolveProjectPath(projectRoot, filePath, flavor);

  if (!isPathInsideProject(absolutePath, projectRoot, flavor)) {
    if (memoize) projectFileCodeLinkCache.set(cacheKey, null);
    return null;
  }

  const relativePath = relativeProjectPath(
    projectRoot,
    absolutePath,
    flavor,
  ).replaceAll("\\", "/");
  if (!relativePath || relativePath.startsWith("..")) {
    if (memoize) projectFileCodeLinkCache.set(cacheKey, null);
    return null;
  }

  const exists = projectFileExists(options, absolutePath, relativePath);
  if (!exists) {
    if (memoize) projectFileCodeLinkCache.set(cacheKey, null);
    return null;
  }

  const target: ProjectFileCodeLink = {
    absolutePath,
    relativePath,
    lineNumber: parsed.lineNumber,
    columnNumber: parsed.columnNumber,
  };
  if (memoize) projectFileCodeLinkCache.set(cacheKey, target);
  return target;
}

function renderProjectFileLinkOpen(
  options: ProjectFileLinkOptions,
  target: ProjectFileCodeLink,
  linkOptions: {
    className?: string;
    privateReference?: boolean;
    title?: string;
  } = {},
): string {
  const attributes: Array<[string, string]> = [
    [
      "href",
      buildProjectFileViewerHref({
        projectId: options.projectId,
        filePath: target.relativePath,
        lineNumber: target.lineNumber,
        columnNumber: target.columnNumber,
      }),
    ],
    ["data-ya-resource", "project-file"],
    ["data-ya-project-id", options.projectId],
    ["data-ya-path", target.relativePath],
    [
      "title",
      linkOptions.title ??
        `${target.relativePath}${target.lineNumber !== undefined ? `:${target.lineNumber}` : ""}\nClick to view, or use a browser link gesture to open this file`,
    ],
  ];
  if (linkOptions.className) {
    attributes.unshift(["class", linkOptions.className]);
  }
  if (linkOptions.privateReference) {
    attributes.push(["data-ya-private-project-file-link", "true"]);
  }
  if (target.lineNumber !== undefined) {
    attributes.push(["data-ya-line", String(target.lineNumber)]);
  }
  if (target.columnNumber !== undefined) {
    attributes.push(["data-ya-column", String(target.columnNumber)]);
  }

  const attrs = attributes
    .map(([name, value]) => `${name}="${escapeHtml(value)}"`)
    .join(" ");
  return `<a ${attrs}>`;
}

/** Render one already-authorized path through the project FileViewer route. */
export function renderProjectFileViewerLink(
  projectId: string,
  target: { filePath: string; lineNumber?: number; columnNumber?: number },
  label: string,
): string {
  const { filePath, lineNumber, columnNumber } = target;
  const open = renderProjectFileLinkOpen(
    { projectId, projectPath: "" },
    {
      absolutePath: filePath,
      relativePath: filePath,
      lineNumber,
      columnNumber,
    },
    { privateReference: true },
  );
  return `${open}${escapeHtml(label)}</a>`;
}

function renderProjectFileCodeLink(text: string): string | null {
  const options = activeRenderOptions.projectFileLinks;
  if (!options) {
    return null;
  }

  const target = resolveProjectFileCodeReference(text, options);
  if (!target) {
    return null;
  }
  const open = renderProjectFileLinkOpen(options, target, {
    className: "fixed-font-file-link",
    privateReference: !options.publicShare,
  });
  return `${open}<code>${escapeHtml(text)}</code></a>`;
}

/**
 * Render a local media file as a clickable placeholder link.
 * The client intercepts clicks on .local-media-link to open a modal.
 */
function renderLocalMediaLink(
  reference: LocalPathReference | string,
  label: string,
  ext: string,
): string {
  const parts = renderLocalMediaLinkParts(reference, ext);
  const parsed = toLocalPathReference(reference);
  const escapedLabel = escapeHtml(label || getFileName(parsed.filePath));
  return `${parts.open}${escapedLabel}${parts.close}`;
}

function renderLocalMediaLinkParts(
  reference: LocalPathReference | string,
  ext: string,
): { close: string; open: string } {
  const parsed = toLocalPathReference(reference);
  const apiUrl = escapeHtml(localMediaApiUrl(parsed.filePath));
  const escapedPath = escapeHtml(parsed.filePath);
  const mediaType = localMediaType(ext);
  const typeLabel = mediaType;
  const defaultExpanded = false;
  const toggleVerb = defaultExpanded ? "Collapse" : "Expand";
  const toggleTitle = defaultExpanded
    ? "Collapse inline preview"
    : "Expand inline preview";
  const toggleText = defaultExpanded ? "-" : "+";
  const resourceAttrs = localResourceDataAttributes("local-media", parsed, {
    mediaType,
  });
  return {
    open: `<span class="local-media-link-group"><button type="button" class="local-media-inline-toggle" data-media-path="${escapedPath}" data-media-type="${mediaType}" data-expanded="${defaultExpanded}" aria-label="${toggleVerb} ${mediaType}" aria-expanded="${defaultExpanded}" title="${toggleTitle}">${toggleText}</button><a href="${apiUrl}" class="local-media-link" data-media-type="${mediaType}" ${resourceAttrs}>`,
    close: `<span class="local-media-type">(${typeLabel})</span></a></span><span class="local-media-inline-preview" data-media-path="${escapedPath}" data-media-type="${mediaType}" data-expanded="${defaultExpanded}"></span>`,
  };
}

function renderDirectLocalImage(path: string, altText: string, title?: string) {
  const src = escapeHtml(localMediaApiUrl(path));
  const parsed = parseLocalPathReference(path);
  const mediaType = localMediaType(getExtension(path));
  const altAttr = altText ? ` alt="${escapeHtml(altText)}"` : ' alt=""';
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  const resourceAttrs = localResourceDataAttributes("local-media", parsed, {
    mediaType,
  });
  return `<img src="${src}"${altAttr}${titleAttr} ${resourceAttrs}>`;
}

/**
 * `href` as written when rendering with `siteRelativeReferences` and it names
 * a path or fragment on the serving site; null otherwise.
 */
function siteRelativeReference(href: string): string | null {
  if (!activeRenderOptions.siteRelativeReferences) return null;
  const trimmed = href.trim();
  if (
    !trimmed ||
    /[\p{C}\s]/u.test(trimmed) ||
    trimmed.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
  )
    return null;
  return trimmed;
}

/**
 * The local file a relative reference names. `..` segments are followed only
 * with `parentSegments`, as a link or image is: a reader's endpoint decides
 * what they reach. An include, which inlines the target's text, stays within
 * the base directory.
 */
function resolveLocalMarkdownHref(
  href: string,
  options: { parentSegments?: boolean } = {},
): LocalPathReference | null {
  const normalizedHref = href.trim();
  let trimmed = normalizedHref;
  try {
    trimmed = decodeURIComponent(normalizedHref);
  } catch {
    // Preserve malformed percent sequences as literal path characters.
  }
  if (!trimmed) {
    return null;
  }

  if (isLocalFilePath(trimmed)) {
    return parseLocalPathReference(trimmed);
  }

  const basePath = activeRenderOptions.localFileBasePath;
  if (!basePath) {
    return null;
  }

  if (
    isAbsolute(trimmed) ||
    trimmed.startsWith("#") ||
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
  ) {
    return null;
  }

  const parsed = parseLocalPathReference(trimmed);
  const normalized = normalize(parsed.filePath);
  const segments = normalized.split(/[\\/]+/);
  if (
    !normalized ||
    normalized === "." ||
    (!options.parentSegments && segments.some((segment) => segment === ".."))
  ) {
    return null;
  }

  return {
    filePath: resolveLocalRelativePath(basePath, normalized),
    lineNumber: parsed.lineNumber,
    columnNumber: parsed.columnNumber,
  };
}

// Presentation MathML, which browsers render natively. Paper extracts keep
// MathML inside raw HTML tables, where TeX delimiters would not be rendered.
// `annotation` holds only text and is hidden inside `semantics`;
// `annotation-xml` is excluded because it can carry arbitrary markup.
const MATHML_TAGS = [
  "math",
  "semantics",
  "annotation",
  "mrow",
  "mi",
  "mn",
  "mo",
  "ms",
  "mtext",
  "mspace",
  "msub",
  "msup",
  "msubsup",
  "munder",
  "mover",
  "munderover",
  "mmultiscripts",
  "mprescripts",
  "none",
  "mfrac",
  "msqrt",
  "mroot",
  "mstyle",
  "mpadded",
  "mphantom",
  "menclose",
  "mtable",
  "mtr",
  "mtd",
  "merror",
];
const MATHML_LAYOUT_ATTRIBUTES = [
  "display",
  "displaystyle",
  "scriptlevel",
  "mathvariant",
  "stretchy",
  "fence",
  "separator",
  "form",
  "largeop",
  "movablelimits",
  "accent",
  "accentunder",
  "lspace",
  "rspace",
  "width",
  "height",
  "depth",
  "linethickness",
  "notation",
  "columnalign",
  "rowalign",
  "columnspan",
  "rowspan",
];

const MARKDOWN_SANITIZE_OPTIONS = {
  allowedTags: [
    ...MATHML_TAGS,
    "a",
    "blockquote",
    "br",
    "button",
    "code",
    "del",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "img",
    "input",
    "li",
    "ol",
    "p",
    "pre",
    "span",
    "strong",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "ul",
  ],
  allowedAttributes: {
    a: [
      "href",
      "title",
      "class",
      "data-media-type",
      "data-ya-resource",
      "data-ya-path",
      "data-ya-project-id",
      "data-ya-private-project-file-link",
      "data-ya-line",
      "data-ya-line-end",
      "data-ya-column",
      "data-ya-render-markdown",
      "data-ya-download",
      "data-ya-media-type",
    ],
    button: [
      "type",
      "class",
      "data-media-path",
      "data-media-type",
      "data-expanded",
      "aria-label",
      "aria-expanded",
      "title",
    ],
    code: ["class"],
    img: [
      "src",
      "alt",
      "title",
      "data-ya-resource",
      "data-ya-path",
      "data-ya-media-type",
    ],
    input: ["type", "checked", "disabled"],
    ol: ["start"],
    span: [
      "class",
      "data-media-path",
      "data-media-type",
      "data-expanded",
      "data-ya-script",
    ],
    td: ["align", "colspan", "rowspan"],
    th: ["align", "colspan", "rowspan"],
    ...Object.fromEntries(
      MATHML_TAGS.filter((tag) => tag !== "annotation").map((tag) => [
        tag,
        MATHML_LAYOUT_ATTRIBUTES,
      ]),
    ),
    annotation: ["encoding"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: {
    a: ["http", "https", "mailto"],
    img: ["http", "https"],
  },
  allowedSchemesAppliedToAttributes: ["href", "src"],
  allowProtocolRelative: false,
  disallowedTagsMode: "escape" as const,
};

const DOCUMENT_ANCHOR_TAGS = ["a", "h1", "h2", "h3", "h4", "h5", "h6"];

/** An id or fragment usable as written: non-empty, no whitespace or controls. */
function isDocumentAnchorName(name: string): boolean {
  return name !== "" && !/[\p{C}\s]/u.test(name);
}

function documentAnchorId(name: string): string {
  return name.startsWith(DOCUMENT_ANCHOR_ID_PREFIX)
    ? name
    : `${DOCUMENT_ANCHOR_ID_PREFIX}${name}`;
}

/**
 * Keep a target's `id`, or a legacy `<a name>`, as one prefixed `id`, and aim
 * a `#fragment` href at it. Every id and fragment in a document render passes
 * here, generated heading slugs and Markdown links included, so the prefix
 * has one owner.
 */
function prefixDocumentAnchorId(
  tagName: string,
  attribs: sanitizeHtml.Attributes,
): sanitizeHtml.Tag {
  const { id, name, ...rest } = attribs;
  const anchor = id ?? (tagName === "a" ? name : undefined);
  if (anchor !== undefined && isDocumentAnchorName(anchor)) {
    rest.id = documentAnchorId(anchor);
  }
  const fragment = rest.href?.startsWith("#") ? rest.href.slice(1) : null;
  if (fragment !== null && isDocumentAnchorName(fragment)) {
    rest.href = `#${documentAnchorId(fragment)}`;
  }
  return { tagName, attribs: rest };
}

const markdownAllowedAttributes: Record<string, string[]> =
  MARKDOWN_SANITIZE_OPTIONS.allowedAttributes;

const DOCUMENT_SANITIZE_OPTIONS = {
  ...MARKDOWN_SANITIZE_OPTIONS,
  allowedAttributes: {
    ...markdownAllowedAttributes,
    ...Object.fromEntries(
      DOCUMENT_ANCHOR_TAGS.map((tag) => [
        tag,
        [...(markdownAllowedAttributes[tag] ?? []), "id"],
      ]),
    ),
  },
  transformTags: Object.fromEntries(
    DOCUMENT_ANCHOR_TAGS.map((tag) => [tag, prefixDocumentAnchorId]),
  ),
};

const LINK_SUFFIXES: unique symbol = Symbol("safeMarkdownLinkSuffixes");
const HEADING_SLUGGER: unique symbol = Symbol("safeMarkdownHeadingSlugger");

interface SafeMarkdownEnvironment extends Env {
  [LINK_SUFFIXES]?: string[];
  [HEADING_SLUGGER]?: HeadingSlugger;
}

/** GitHub's heading slug: lowercase, punctuation dropped, spaces to `-`. */
function headingSlugBase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** Repeated slugs become `x-1`, `x-2`, skipping any already taken. */
class HeadingSlugger {
  private readonly occurrences = new Map<string, number>();

  slug(base: string): string {
    let slug = base;
    while (this.occurrences.has(slug)) {
      const count = (this.occurrences.get(base) ?? 0) + 1;
      this.occurrences.set(base, count);
      slug = `${base}-${count}`;
    }
    this.occurrences.set(slug, 0);
    return slug;
  }
}

/** Heading text as a reader sees it, including inline code. */
function inlinePlainText(tokens: readonly Token[]): string {
  return tokens
    .map((token) => {
      if (token.type === "text" || token.type === "code_inline") {
        return token.content;
      }
      if (token.type === "softbreak" || token.type === "hardbreak") {
        return " ";
      }
      return token.children ? inlinePlainText(token.children) : "";
    })
    .join("");
}

function headingSlugBaseAt(tokens: readonly Token[], index: number): string {
  const inline = tokens[index + 1];
  return inline?.type === "inline"
    ? headingSlugBase(inlinePlainText(inline.children ?? []))
    : "";
}

function renderHeadingOpen(
  tokens: Token[],
  index: number,
  options: Parameters<RendererRule>[2],
  environment: Env | undefined,
  renderer: Renderer,
): string {
  const token = tokens[index];
  if (!token) return "";
  const slugger = (environment as SafeMarkdownEnvironment | undefined)?.[
    HEADING_SLUGGER
  ];
  const base = slugger ? headingSlugBaseAt(tokens, index) : "";
  // Unprefixed: the document sanitizer prefixes every id it keeps.
  if (slugger && base) token.attrSet("id", slugger.slug(base));
  return renderer.renderToken(tokens, index, options);
}

/**
 * A `#fragment` link kept as written when rendering a whole document; the
 * document sanitizer then aims it at the prefixed id.
 */
function documentFragmentHref(href: string): string | null {
  if (!activeRenderOptions.documentAnchors) return null;
  const trimmed = href.trim();
  return trimmed.startsWith("#") && isDocumentAnchorName(trimmed.slice(1))
    ? trimmed
    : null;
}

// KaTeX output is generated inside the markdown renderer and stashed in
// this buffer; the renderer emits placeholder spans that survive
// sanitize-html unchanged, and we substitute the real HTML back in
// after sanitization. This keeps katex's complex span/svg markup out
// of the sanitize allowlist while still running the rest of the
// markdown through strict sanitization.
//
// Safe as module state because `renderSafeMarkdown` is synchronous and
// Node is single-threaded — no interleaving is possible between reset
// and substitute.
let katexBuffer: string[] = [];

function storeKatexPlaceholder(html: string, _displayMode: boolean): string {
  const id = katexBuffer.length;
  katexBuffer.push(html);
  return `<span class="yepkatex-placeholder yepkatex-id-${id}"></span>`;
}

// Trained recognizer parameters (binary "UMB1", about 5 KB), copied into
// dist by scripts/copy-server-assets.mjs. Read on first use, like the
// other server assets, so importing this module does no file I/O.
let unicodeMathParams: UnicodeMathParams | undefined;
function unicodeMathParamsOnce(): UnicodeMathParams {
  unicodeMathParams ??= loadUnicodeMathParams(
    readFileSync(new URL("./unicode-math-params.bin", import.meta.url)),
  );
  return unicodeMathParams;
}

// Inference is optional decoration; neither its arrays nor KaTeX's potentially
// quadratic glyph combining may scale to arbitrary generated text blocks.
const MAX_INFERRED_MATH_TEXT_UNITS = 16_384;
const MAX_INFERRED_MATH_REGION_UNITS = 2_048;

/**
 * KaTeX HTML for a recognised region, or null when KaTeX rejects it or has
 * no metrics for one of its glyphs (it reports those only through
 * console.warn, so the warning is captured for this synchronous call).
 */
function typesetUnicodeMath(region: string): string | null {
  if (region.length > MAX_INFERRED_MATH_REGION_UNITS) return null;
  const warn = console.warn;
  let missingGlyph = false;
  console.warn = () => {
    missingGlyph = true;
  };
  try {
    const html = katex.renderToString(unicodeMathToKatexSource(region), {
      output: "html",
      throwOnError: true,
      strict: false,
      trust: false,
      maxExpand: 1000,
    });
    return missingGlyph ? null : html;
  } catch {
    return null;
  } finally {
    console.warn = warn;
  }
}

/**
 * One prose text run as HTML. Undelimited math the recognizer finds is
 * emitted twice: the authored text (with the Unicode script redraw) shown
 * by default, and a KaTeX rendering hidden until the client's Unicode math
 * setting reveals it. A region KaTeX rejects stays plain text.
 */
function renderProseText(text: string): string {
  if (text.length > MAX_INFERRED_MATH_TEXT_UNITS) {
    return renderUnicodeScripts(text);
  }
  const regions = findUnicodeMath(unicodeMathParamsOnce(), text);
  if (!regions.length) return renderUnicodeScripts(text);
  let html = "";
  let last = 0;
  for (const [start, end] of regions) {
    const typeset = typesetUnicodeMath(text.slice(start, end));
    if (typeset === null) continue;
    const region = text.slice(start, end);
    html += renderUnicodeScripts(text.slice(last, start));
    html += `<span class="ya-umath"><span class="ya-umath__text">${renderUnicodeScripts(region)}</span><span class="ya-umath__tex">${storeKatexPlaceholder(typeset, false)}</span></span>`;
    last = end;
  }
  return html + renderUnicodeScripts(text.slice(last));
}

function renderLinkOpen(
  tokens: Token[],
  index: number,
  _options: Parameters<RendererRule>[2],
  environment: Env | undefined,
): string {
  const token = tokens[index];
  if (!token) return "";
  const href = String(token.attrGet("href") ?? "");
  const titleValue = token.attrGet("title");
  const title = titleValue === null ? undefined : String(titleValue);
  const siteHref = documentFragmentHref(href) ?? siteRelativeReference(href);
  const localPath =
    siteHref === null
      ? resolveLocalMarkdownHref(href, { parentSegments: true })
      : null;
  let open = "";
  let close = "";

  if (localPath) {
    const ext = getExtension(localPath.filePath);
    if (MEDIA_EXTENSIONS.has(ext)) {
      const parts = renderLocalMediaLinkParts(localPath, ext);
      open = parts.open;
      close = parts.close;
    } else {
      const projectOptions = activeRenderOptions.projectFileLinks;
      const projectTarget = projectOptions
        ? resolveProjectFileCodeReference(
            formatLocalPathReference(localPath),
            projectOptions,
          )
        : null;
      open =
        projectOptions && projectTarget
          ? renderProjectFileLinkOpen(projectOptions, projectTarget, {
              title: title ?? formatLocalPathReference(localPath),
            })
          : renderLocalFileLinkOpen(localPath, {
              renderMarkdown: isMarkdownExtension(ext),
              title: title ?? formatLocalPathReference(localPath),
            });
      close = "</a>";
    }
  } else {
    const safeHref = siteHref ?? sanitizeUrl(href);
    if (safeHref) {
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      open = `<a href="${escapeHtml(safeHref)}"${titleAttr}>`;
      close = "</a>";
    }
  }

  const safeEnvironment = environment as SafeMarkdownEnvironment | undefined;
  const suffixes = safeEnvironment?.[LINK_SUFFIXES] ?? [];
  suffixes.push(close);
  if (safeEnvironment) safeEnvironment[LINK_SUFFIXES] = suffixes;
  return open;
}

function renderLinkClose(
  _tokens: Token[],
  _index: number,
  _options: Parameters<RendererRule>[2],
  environment: Env | undefined,
): string {
  const suffixes = (environment as SafeMarkdownEnvironment | undefined)?.[
    LINK_SUFFIXES
  ];
  return suffixes?.pop() ?? "";
}

/**
 * Escape code text, turning bare `http(s)` URLs into anchors.
 *
 * Prose autolinks already, so a URL that lands in a fenced block or inline
 * code was the one thing on screen that had to be selected and copied. The
 * text still reads exactly as written; only the anchor is added, and only for
 * a URL the shared linkifier accepts.
 *
 * The anchor stays in the same document, like every other link this renderer
 * emits: `MARKDOWN_SANITIZE_OPTIONS` allows neither `target` nor `rel` on an
 * anchor, so asking for a new tab here would be markup the sanitizer drops.
 */
function escapeCodeWithLinks(text: string): string {
  return linkifyToHtml(text, { external: false }, escapeHtml);
}

function renderCodeInline(tokens: Token[], index: number): string {
  const text = tokens[index]?.content ?? "";
  return (
    renderProjectFileCodeLink(text) ??
    `<code>${escapeCodeWithLinks(text)}</code>`
  );
}

/** Fenced and indented blocks, linkified the same way inline code is. */
function renderCodeBlock(tokens: Token[], index: number): string {
  const token = tokens[index];
  if (!token) return "";
  const info = token.info ? token.info.trim().split(/\s+/)[0] : "";
  const language = info && /^[\w.+-]+$/.test(info) ? info : "";
  const open = language
    ? `<pre><code class="language-${escapeHtml(language)}">`
    : "<pre><code>";
  return `${open}${escapeCodeWithLinks(token.content)}</code></pre>\n`;
}

function renderImage(
  tokens: Token[],
  index: number,
  options: Parameters<RendererRule>[2],
  environment: Env | undefined,
  renderer: Renderer,
): string {
  const token = tokens[index];
  if (!token) return "";
  const href = String(token.attrGet("src") ?? "");
  const titleValue = token.attrGet("title");
  const title = titleValue === null ? undefined : String(titleValue);
  const text = renderer.renderInlineAsText(
    token.children ?? [],
    options,
    environment,
  );
  const siteSrc = siteRelativeReference(href);
  if (siteSrc !== null) {
    const altAttr = text ? ` alt="${escapeHtml(text)}"` : ' alt=""';
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<img src="${escapeHtml(siteSrc)}"${altAttr}${titleAttr}>`;
  }
  const localPath = resolveLocalMarkdownHref(href, { parentSegments: true });
  if (localPath) {
    const resolvedImage = resolveLocalMarkdownImage(localPath);
    if (resolvedImage) {
      const { ext, reference } = resolvedImage;
      if (activeRenderOptions.inlineLocalImages && IMAGE_EXTENSIONS.has(ext)) {
        return renderDirectLocalImage(reference.filePath, text, title);
      }
      return renderLocalMediaLink(reference, text, ext);
    }
    return escapeHtml(text || getFileName(localPath.filePath));
  }

  const safeSrc = sanitizeUrl(href, ALLOWED_IMAGE_PROTOCOLS);
  if (!safeSrc) return escapeHtml(text);
  const altAttr = text ? ` alt="${escapeHtml(text)}"` : ' alt=""';
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return `<img src="${escapeHtml(safeSrc)}"${altAttr}${titleAttr}>`;
}

function parseQuartoIncludeTarget(line: string): string | null {
  const match =
    /^\{\{<\s*include\s+(?:"([^"]+)"|'([^']+)'|([^\s"'<>]+))\s*>\}\}$/.exec(
      line.trim(),
    );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function tokenizeQuartoInclude(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  if (
    !activeRenderOptions.quartoMarkdown ||
    state.parentType !== "root" ||
    (startLine > 0 && !state.isEmpty(startLine - 1)) ||
    (startLine + 1 < endLine && !state.isEmpty(startLine + 1))
  ) {
    return false;
  }

  const start = state.bMarks[startLine] ?? 0;
  const end = state.eMarks[startLine] ?? start;
  const source = state.src.slice(start, end);
  const target = parseQuartoIncludeTarget(source);
  if (!target) return false;
  if (silent) return true;

  const token = state.push("quarto_include", "", 0);
  token.block = true;
  token.content = target;
  token.info = source.trim();
  token.map = [startLine, startLine + 1];
  state.line = startLine + 1;
  return true;
}

function resolveQuartoIncludeTarget(target: string): LocalPathReference | null {
  const projectOptions = activeRenderOptions.projectFileLinks;
  if (
    projectOptions &&
    /^[\\/]/.test(target) &&
    !isWindowsDriveAbsolutePath(target)
  ) {
    const relativePath = target.replace(/^[\\/]+/, "");
    if (!relativePath) return null;
    const flavor = getProjectPathFlavor(projectOptions.projectPath);
    return {
      filePath: resolveProjectPath(
        projectOptions.projectPath,
        relativePath,
        flavor,
      ),
    };
  }
  return resolveLocalMarkdownHref(target);
}

function renderQuartoInclude(tokens: Token[], index: number): string {
  const token = tokens[index];
  if (!token) return "";
  const target = token.content;
  const localPath = resolveQuartoIncludeTarget(target);
  if (!localPath) {
    return `<p><code>${escapeHtml(token.info)}</code></p>\n`;
  }

  const projectOptions = activeRenderOptions.projectFileLinks;
  const projectTarget = projectOptions
    ? resolveProjectFileCodeReference(
        formatLocalPathReference(localPath),
        projectOptions,
      )
    : null;
  const title = formatLocalPathReference(localPath);
  let open: string;
  if (projectOptions) {
    if (!projectTarget) {
      return `<p><code>${escapeHtml(token.info)}</code></p>\n`;
    }
    open = renderProjectFileLinkOpen(projectOptions, projectTarget, { title });
  } else {
    open = renderLocalFileLinkOpen(localPath, {
      renderMarkdown: isMarkdownExtension(getExtension(localPath.filePath)),
      title,
    });
  }
  return `<p>Include: ${open}<code>${escapeHtml(target)}</code></a></p>\n`;
}

function renderTableCellOpen(
  tokens: Token[],
  index: number,
  options: Parameters<RendererRule>[2],
  _environment: Env | undefined,
  renderer: Renderer,
): string {
  const token = tokens[index];
  if (!token) return "";
  const styleIndex = token.attrIndex("style");
  if (styleIndex >= 0 && token.attrs) {
    const style = String(token.attrs[styleIndex]?.[1] ?? "");
    const alignment = /^text-align:(left|center|right)$/.exec(style)?.[1];
    token.attrs.splice(styleIndex, 1);
    if (alignment) token.attrSet("align", alignment);
  }
  return renderer.renderToken(tokens, index, options);
}

function renderTaskListItems(state: StateCore): void {
  const pendingItems: boolean[] = [];
  for (const token of state.tokens) {
    if (token.type === "list_item_open") {
      pendingItems.push(true);
      continue;
    }
    if (token.type === "list_item_close") {
      pendingItems.pop();
      continue;
    }
    if (
      token.type !== "inline" ||
      pendingItems.length === 0 ||
      !pendingItems[pendingItems.length - 1]
    ) {
      continue;
    }

    pendingItems[pendingItems.length - 1] = false;
    const first = token.children?.[0];
    if (first?.type !== "text") continue;
    const match = /^\[([ xX])\]\s+/.exec(first.content);
    if (!match) continue;

    first.content = first.content.slice(match[0].length);
    const checkbox = new state.Token("html_inline", "", 0);
    checkbox.content = `<input${match[1]?.toLowerCase() === "x" ? ' checked=""' : ""} disabled="" type="checkbox"> `;
    token.children?.unshift(checkbox);
  }
}

const markdownRenderer = new MarkdownIt({
  breaks: false,
  html: true,
  linkify: true,
  typographer: false,
  xhtmlOut: false,
}).disable("strip_references");

// Let the normal inline parser handle code and links, but stop its plain-text
// scan at Codex's artifact marker so JSON paths never become Markdown syntax.
const inlineTextRule = markdownRenderer.inline.ruler.getRules("")[0];
if (!inlineTextRule) throw new Error("Missing Markdown inline text rule");
const VISUALIZE_OPEN = "\uE200visualize\uE202";
const VISUALIZE_CLOSE = "\uE201";
const nextVisualizeMarker = new WeakMap<object, number>();
markdownRenderer.inline.ruler.at("text", (state, silent) => {
  let start = nextVisualizeMarker.get(state);
  if (start === undefined || (start >= 0 && start < state.pos)) {
    start = state.src.indexOf(VISUALIZE_OPEN, state.pos);
    nextVisualizeMarker.set(state, start);
  }
  if (
    start < 0 ||
    start >= state.posMax ||
    state.linkLevel > 0 ||
    activeRenderOptions.projectFileLinks?.publicShare
  ) {
    return inlineTextRule(state, silent);
  }
  if (start > state.pos) {
    const end = state.posMax;
    state.posMax = start;
    try {
      return inlineTextRule(state, silent);
    } finally {
      state.posMax = end;
    }
  }
  const end = state.src.indexOf(VISUALIZE_CLOSE, start + VISUALIZE_OPEN.length);
  if (end >= 0 && end < state.posMax) {
    try {
      const value: unknown = JSON.parse(
        state.src.slice(start + VISUALIZE_OPEN.length, end),
      );
      const path =
        value && typeof value === "object" && "path" in value
          ? value.path
          : undefined;
      if (
        typeof path === "string" &&
        (path.startsWith("/") || isWindowsDriveAbsolutePath(path)) &&
        !path.startsWith("//") &&
        !/\p{C}/u.test(path) &&
        /\.html?$/i.test(path)
      ) {
        if (!silent) state.push("ya_visualize", "", 0).content = path;
        state.pos = end + VISUALIZE_CLOSE.length;
        return true;
      }
    } catch {
      // Incomplete or malformed markers remain readable provider text.
    }
  }
  return inlineTextRule(state, silent);
});
markdownRenderer.renderer.rules.ya_visualize = (tokens, index) => {
  const path = tokens[index]?.content ?? "";
  return renderLocalFileLink(
    { filePath: path },
    escapeHtml(path.split(/[\\/]/).pop() ?? path),
  );
};

installMarkdownCitations(markdownRenderer, () => activeRenderOptions);

markdownRenderer.use(markdownItKatex, {
  allowInlineWithSpace: false,
  delimiters: "all",
  logger: (): "ignore" => "ignore",
  // The plugin copies this table for each document render, so a \gdef
  // persists within one document but never reaches another.
  macros: paperKatexMacros(),
  mathFence: false,
  maxExpand: 1000,
  output: "html",
  throwOnError: false,
  transformer: storeKatexPlaceholder,
  trust: false,
});

function preserveEmptyMath(
  rendererRule: RendererRule,
  displayMode: boolean,
): RendererRule {
  return (tokens, index, options, environment, renderer) => {
    const token = tokens[index];
    if (!token) return "";
    const literalSource = token.meta?.[LITERAL_MATH_META];
    if (typeof literalSource === "string") {
      const literal = escapeHtml(literalSource);
      return displayMode ? `<p>${literal}</p>\n` : literal;
    }
    if (token.content.trim()) {
      const original = token.content;
      token.content = normalizeTexForKatex(original);
      try {
        return rendererRule(tokens, index, options, environment, renderer);
      } finally {
        token.content = original;
      }
    }

    const opening = token.markup || (displayMode ? "$$" : "$");
    const closing =
      opening === "\\[" ? "\\]" : opening === "\\(" ? "\\)" : opening;
    const literal = escapeHtml(`${opening}${closing}`);
    return displayMode ? `<p>${literal}</p>\n` : literal;
  };
}

const pluginMathInlineRenderer = markdownRenderer.renderer.rules.math_inline;
const pluginMathBlockRenderer = markdownRenderer.renderer.rules.math_block;
if (!pluginMathInlineRenderer || !pluginMathBlockRenderer) {
  throw new Error("@mdit/plugin-katex did not register its renderer rules");
}
markdownRenderer.renderer.rules.math_inline = preserveEmptyMath(
  pluginMathInlineRenderer,
  false,
);
markdownRenderer.renderer.rules.math_block = preserveEmptyMath(
  pluginMathBlockRenderer,
  true,
);

// Parse every link, including unsafe schemes, so the renderer can keep its
// readable label while dropping the unsafe destination.
markdownRenderer.validateLink = () => true;
markdownRenderer.block.ruler.before(
  "paragraph",
  "ya_quarto_include",
  tokenizeQuartoInclude,
);
markdownRenderer.core.ruler.after(
  "block",
  "ya_windows_drive_paths",
  repairWindowsDriveMarkdownDestinations,
);
markdownRenderer.core.ruler.after(
  "block",
  "ya_unclosed_math_blocks",
  preserveUnclosedMathBlocks,
);
markdownRenderer.core.ruler.after(
  "text_join",
  "ya_task_list_items",
  renderTaskListItems,
);
markdownRenderer.renderer.rules.text = (tokens, index) =>
  renderProseText(tokens[index]?.content ?? "");
markdownRenderer.renderer.rules.link_open = renderLinkOpen;
markdownRenderer.renderer.rules.link_close = renderLinkClose;
markdownRenderer.renderer.rules.code_inline = renderCodeInline;
markdownRenderer.renderer.rules.fence = renderCodeBlock;
markdownRenderer.renderer.rules.code_block = renderCodeBlock;
markdownRenderer.renderer.rules.image = renderImage;
markdownRenderer.renderer.rules.quarto_include = renderQuartoInclude;
markdownRenderer.renderer.rules.heading_open = renderHeadingOpen;
markdownRenderer.renderer.rules.th_open = renderTableCellOpen;
markdownRenderer.renderer.rules.td_open = renderTableCellOpen;

/**
 * Return a safe absolute URL for markdown links, or null for unsupported schemes.
 */
export function sanitizeUrl(
  url: string,
  allowedProtocols: ReadonlySet<string> = ALLOWED_LINK_PROTOCOLS,
): string | null {
  const trimmed = url.trim();
  if (!trimmed || /\p{C}/u.test(trimmed)) {
    return null;
  }

  const normalized = trimmed.replace(/\s+/g, "");
  if (!normalized) {
    return null;
  }

  try {
    const parsed = new URL(normalized);
    if (!allowedProtocols.has(parsed.protocol.toLowerCase())) {
      return null;
    }
  } catch {
    return null;
  }

  return normalized;
}

export interface MarkdownSourceSpan {
  endLine: number;
  level: number;
  nesting: -1 | 0 | 1;
  startLine: number;
  type: string;
}

/**
 * Parse Markdown into the block/source spans used by aligned projections.
 * Lines are one-based and inclusive; closing-only tokens have no source map
 * and are omitted.
 */
export function parseMarkdownSourceSpans(
  markdown: string,
): MarkdownSourceSpan[] {
  const tokens = markdownRenderer.parse(markdown, {});
  const spans: MarkdownSourceSpan[] = [];
  for (const token of tokens) {
    if (!token.map) continue;
    spans.push({
      endLine: token.map[1],
      level: token.level,
      nesting: token.nesting,
      startLine: token.map[0] + 1,
      type: token.type,
    });
  }
  return spans;
}

/**
 * Base heading slugs in document order, for rendering the text that follows
 * with `documentAnchors.precedingHeadingSlugs`.
 */
export function collectMarkdownHeadingSlugs(markdown: string): string[] {
  const tokens = markdownRenderer.parse(markdown, {});
  const slugs: string[] = [];
  tokens.forEach((token, index) => {
    if (token.type !== "heading_open") return;
    const base = headingSlugBaseAt(tokens, index);
    if (base) slugs.push(base);
  });
  return slugs;
}

/**
 * Render Markdown, including embedded HTML, through the shared sanitizer.
 */
export function renderSafeMarkdown(
  markdown: string,
  options: SafeMarkdownRenderOptions = {},
): string {
  activeRenderOptions = options;
  projectFileCodeLinkCache = new Map();
  katexBuffer = [];
  try {
    const environment: SafeMarkdownEnvironment = {};
    const documentAnchors = options.documentAnchors;
    if (documentAnchors) {
      const slugger = new HeadingSlugger();
      for (const base of documentAnchors.precedingHeadingSlugs ?? []) {
        slugger.slug(base);
      }
      environment[HEADING_SLUGGER] = slugger;
    }
    const html = markdownRenderer.render(markdown, environment);
    const sanitized = sanitizeHtml(
      html,
      documentAnchors ? DOCUMENT_SANITIZE_OPTIONS : MARKDOWN_SANITIZE_OPTIONS,
    );
    const substituted = sanitized.replace(
      /<span class="yepkatex-placeholder yepkatex-id-(\d+)"><\/span>/g,
      (_match, idxStr) => katexBuffer[Number(idxStr)] ?? "",
    );
    return substituted.trim();
  } finally {
    katexBuffer = [];
    projectFileCodeLinkCache = new Map();
    activeRenderOptions = {};
  }
}

export {
  getExtension as getLocalPathExtension,
  IMAGE_EXTENSIONS,
  isLocalFilePath,
  localFileApiUrl,
  localMediaApiUrl,
  localResourceDataAttributes,
  MEDIA_EXTENSIONS,
  renderLocalFileLink,
  renderLocalFileLinkOpen,
  renderLocalMediaLink,
  VIDEO_EXTENSIONS,
};
