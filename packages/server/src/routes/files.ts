import { createReadStream, type Dirent, type Stats } from "node:fs";
import {
  open,
  readdir,
  readFile,
  realpath,
  stat,
  type FileHandle,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from "node:path";
import { createInterface } from "node:readline";
import {
  type FileContentResponse,
  type FileMetadata,
  type FolderEntry,
  type FolderListingResponse,
  isUrlProjectId,
  type PatchHunk,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import { PRINCIPAL_VARIABLE, type Principal } from "../auth/principal.js";
import { computeEditAugment } from "../augments/edit-augments.js";
import { renderMarkdownFilePreview } from "../augments/markdown-file-preview.js";
import { highlightFile } from "../highlighting/index.js";
import { linkifyProjectPaths } from "../augments/project-path-links.js";
import { getLogger } from "../logging/logger.js";
import { getProjectPathIndex } from "../projects/projectPathIndex.js";
import type { ProjectScanner } from "../projects/scanner.js";
import {
  openProjectRelativeFile,
  readFileHandleBounded,
} from "../utils/projectFileAccess.js";
import { isLikelyUtf8Text } from "../utils/utf8Text.js";
import { expandHomePath } from "../utils/expandHomePath.js";
import { createLocalResourcePathPolicy } from "./local-resource-policy.js";
import {
  createMutableFileCacheMetadata,
  createMutableFileResponse,
  mutableFileCacheHeaders,
  type MutableFileOpener,
  openMutableFileSnapshot,
} from "./mutable-file-cache.js";
import { createUntrustedFileResponseHeaders } from "./untrusted-file-response.js";

export interface FilesDeps {
  scanner: ProjectScanner;
  /**
   * Allowed (non-project) prefixes for absolute/`~` paths. When provided, the
   * absolute-path branch is gated through the shared file-access policy (the
   * same allow-set the media doors enforce). Relative in-project paths are
   * always project-scoped regardless. Omitted = no scoping (test/embedding).
   */
  allowedPaths?: string[] | (() => string[]);
  /** Whether scanned project paths are part of the allow-set (default: true). */
  includeProjects?: () => boolean;
  /** Fail closed unless relative project files can remain descriptor-bound. */
  strictProjectFileAccess?: boolean;
  /** File opener used to bind mutable response metadata and bytes. */
  openFile?: MutableFileOpener;
}

type LocalResourcePathPolicy = ReturnType<typeof createLocalResourcePathPolicy>;

/** Maximum text file size to include content inline (100MB) */
const MAX_INLINE_SIZE = 100 * 1024 * 1024;
/** Syntax highlighting and targeted windows stay bounded (1MB) */
const MAX_HIGHLIGHT_SIZE = 1024 * 1024;
// Self-contained HTML documents carry embedded assets, unlike source previews.
const MAX_INLINE_HTML_SIZE = 200 * 1024 * 1024;
const MAX_TARGET_WINDOW_SIZE = MAX_HIGHLIGHT_SIZE;
const MAX_EMBEDDED_MARKDOWN_MEDIA_BYTES = 8 * 1024 * 1024;
const MAX_EMBEDDED_MARKDOWN_MEDIA_FILE_BYTES = 2 * 1024 * 1024;
const TEXT_SNIFF_BYTES = 8192;

/** MIME type mappings by extension */
const MIME_TYPES: Record<string, string> = {
  // Text/code files
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".qmd": "text/markdown",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".js": "text/javascript",
  ".jsx": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".scss": "text/x-scss",
  ".sass": "text/x-sass",
  ".less": "text/x-less",
  ".xml": "application/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/x-toml",
  ".ini": "text/x-ini",
  ".conf": "text/plain",
  ".cfg": "text/plain",
  ".sh": "text/x-shellscript",
  ".bash": "text/x-shellscript",
  ".zsh": "text/x-shellscript",
  ".fish": "text/x-shellscript",
  ".ps1": "text/x-powershell",
  ".bat": "text/x-batch",
  ".cmd": "text/x-batch",
  ".py": "text/x-python",
  ".rb": "text/x-ruby",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".java": "text/x-java",
  ".kt": "text/x-kotlin",
  ".scala": "text/x-scala",
  ".c": "text/x-c",
  ".h": "text/x-c",
  ".cpp": "text/x-c++",
  ".hpp": "text/x-c++",
  ".cc": "text/x-c++",
  ".cs": "text/x-csharp",
  ".swift": "text/x-swift",
  ".m": "text/x-objectivec",
  ".mm": "text/x-objectivec",
  ".php": "text/x-php",
  ".pl": "text/x-perl",
  ".pm": "text/x-perl",
  ".lua": "text/x-lua",
  ".r": "text/x-r",
  ".R": "text/x-r",
  ".sql": "text/x-sql",
  ".graphql": "text/x-graphql",
  ".gql": "text/x-graphql",
  ".vue": "text/x-vue",
  ".svelte": "text/x-svelte",
  ".astro": "text/x-astro",
  ".elm": "text/x-elm",
  ".ex": "text/x-elixir",
  ".exs": "text/x-elixir",
  ".erl": "text/x-erlang",
  ".hrl": "text/x-erlang",
  ".hs": "text/x-haskell",
  ".lhs": "text/x-haskell",
  ".clj": "text/x-clojure",
  ".cljs": "text/x-clojure",
  ".cljc": "text/x-clojure",
  ".ml": "text/x-ocaml",
  ".mli": "text/x-ocaml",
  ".fs": "text/x-fsharp",
  ".fsx": "text/x-fsharp",
  ".dart": "text/x-dart",
  ".nim": "text/x-nim",
  ".zig": "text/x-zig",
  ".v": "text/x-v",
  ".sol": "text/x-solidity",
  ".proto": "text/x-protobuf",
  ".prisma": "text/x-prisma",
  ".dockerfile": "text/x-dockerfile",
  ".makefile": "text/x-makefile",
  ".cmake": "text/x-cmake",
  ".gradle": "text/x-gradle",
  ".env": "text/plain",
  ".gitignore": "text/plain",
  ".editorconfig": "text/plain",
  ".prettierrc": "application/json",
  ".eslintrc": "application/json",
  ".babelrc": "application/json",
  // Image files
  ".apng": "image/apng",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".avif": "image/avif",
  // Other binary
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".ogv": "video/ogg",
};

/** Extensions that are considered text files */
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".qmd",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonl",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".conf",
  ".cfg",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".bat",
  ".cmd",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".scala",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cc",
  ".cs",
  ".swift",
  ".m",
  ".mm",
  ".php",
  ".pl",
  ".pm",
  ".lua",
  ".r",
  ".R",
  ".sql",
  ".graphql",
  ".gql",
  ".vue",
  ".svelte",
  ".astro",
  ".elm",
  ".ex",
  ".exs",
  ".erl",
  ".hrl",
  ".hs",
  ".lhs",
  ".clj",
  ".cljs",
  ".cljc",
  ".ml",
  ".mli",
  ".fs",
  ".fsx",
  ".dart",
  ".nim",
  ".zig",
  ".v",
  ".sol",
  ".proto",
  ".prisma",
  ".dockerfile",
  ".makefile",
  ".cmake",
  ".gradle",
  ".svg", // SVG is XML-based, can be treated as text
]);

/**
 * Get MIME type from file extension.
 */
function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  if (ext) {
    return MIME_TYPES[ext] || "application/octet-stream";
  }
  return (
    MIME_TYPES[basename(filePath).toLowerCase()] || "application/octet-stream"
  );
}

function parsePositiveIntegerQuery(
  value: string | undefined,
): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function getLineRange(
  lineNumber: number | undefined,
  lineEnd: number | undefined,
): { end: number; start: number } | null {
  if (lineNumber === undefined) {
    return null;
  }
  return {
    end: Math.max(lineNumber, lineEnd ?? lineNumber),
    start: lineNumber,
  };
}

interface TextContentSlice {
  content: string;
  endLine: number;
  startLine: number;
  totalLines?: number;
  truncated: boolean;
}

type FileViewMode = "full" | "range";
type FileReadSource = string | FileHandle;

function createTextReadStream(source: FileReadSource) {
  return typeof source === "string"
    ? createReadStream(source, { encoding: "utf8" })
    : source.createReadStream({
        autoClose: false,
        encoding: "utf8",
        start: 0,
      });
}

async function readUtf8Bounded(
  source: FileReadSource,
  maxBytes: number,
): Promise<string | null> {
  if (typeof source === "string") {
    const content = await readFile(source);
    return content.byteLength <= maxBytes ? content.toString("utf8") : null;
  }
  const content = await readFileHandleBounded(source, maxBytes);
  return content?.toString("utf8") ?? null;
}

interface LineEntry {
  bytes: number;
  lineNumber: number;
  text: string;
}

function lineBytes(text: string): number {
  return Buffer.byteLength(`${text}\n`, "utf8");
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  return Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
}

function trimLineWindowToBudget(
  lines: LineEntry[],
  byteBudget: number,
): number {
  let bytes = lines.reduce((total, line) => total + line.bytes, 0);
  while (bytes > byteBudget && lines.length > 0) {
    const removed = lines.shift();
    bytes -= removed?.bytes ?? 0;
  }
  return bytes;
}

async function readTargetedTextWindow(
  source: FileReadSource,
  range: { end: number; start: number },
): Promise<TextContentSlice> {
  const beforeLines: LineEntry[] = [];
  const targetLines: LineEntry[] = [];
  const afterLines: LineEntry[] = [];
  let beforeBytes = 0;
  let targetBytes = 0;
  let afterBytes = 0;
  let lineNumber = 0;
  let completed = true;

  const stream = createTextReadStream(source);
  const reader = createInterface({
    crlfDelay: Number.POSITIVE_INFINITY,
    input: stream,
  });

  try {
    for await (const line of reader) {
      lineNumber += 1;
      const entry: LineEntry = {
        bytes: lineBytes(line),
        lineNumber,
        text: line,
      };

      if (lineNumber < range.start) {
        beforeLines.push(entry);
        beforeBytes += entry.bytes;
        beforeBytes = trimLineWindowToBudget(
          beforeLines,
          Math.floor(MAX_TARGET_WINDOW_SIZE / 2),
        );
        continue;
      }

      if (lineNumber <= range.end) {
        const remainingTargetBytes = MAX_TARGET_WINDOW_SIZE - targetBytes;
        if (remainingTargetBytes <= 0) {
          completed = false;
          break;
        }
        if (entry.bytes > remainingTargetBytes) {
          beforeLines.length = 0;
          afterLines.length = 0;
          beforeBytes = 0;
          afterBytes = 0;
          if (targetLines.length === 0) {
            const text = truncateUtf8(entry.text, MAX_TARGET_WINDOW_SIZE);
            targetLines.push({
              bytes: Buffer.byteLength(text, "utf8"),
              lineNumber,
              text,
            });
            targetBytes = targetLines[0]?.bytes ?? 0;
          }
          completed = false;
          break;
        }

        targetLines.push(entry);
        targetBytes += entry.bytes;
        const beforeBudget = Math.max(
          0,
          Math.floor((MAX_TARGET_WINDOW_SIZE - targetBytes) / 2),
        );
        beforeBytes = trimLineWindowToBudget(beforeLines, beforeBudget);
        if (targetBytes >= MAX_TARGET_WINDOW_SIZE) {
          beforeLines.length = 0;
          beforeBytes = 0;
          completed = false;
          break;
        }
        continue;
      }

      const remaining =
        MAX_TARGET_WINDOW_SIZE - beforeBytes - targetBytes - afterBytes;
      if (remaining <= 0 || entry.bytes > remaining) {
        completed = false;
        break;
      }
      afterLines.push(entry);
      afterBytes += entry.bytes;
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  const included = [...beforeLines, ...targetLines, ...afterLines];
  if (included.length === 0) {
    return {
      content: "",
      endLine: lineNumber,
      startLine: 1,
      totalLines: completed ? lineNumber : undefined,
      truncated: true,
    };
  }

  const startLine = included[0]?.lineNumber ?? 1;
  const endLine = included.at(-1)?.lineNumber ?? startLine;
  return {
    content: included.map((line) => line.text).join("\n"),
    endLine,
    startLine,
    totalLines: completed ? lineNumber : undefined,
    truncated: startLine > 1 || !completed,
  };
}

function sliceContentToRange(
  content: string,
  range: { end: number; start: number },
): TextContentSlice {
  const lines = content.split("\n");
  const startIndex = Math.max(0, range.start - 1);
  const endIndex = Math.min(lines.length, range.end);
  const selected = lines.slice(startIndex, endIndex);
  const endLine =
    selected.length > 0 ? range.start + selected.length - 1 : range.start;
  return {
    content: selected.join("\n"),
    endLine,
    startLine: range.start,
    totalLines: lines.length,
    truncated: range.start > 1 || endLine < lines.length,
  };
}

async function readExactTextRange(
  source: FileReadSource,
  range: { end: number; start: number },
): Promise<TextContentSlice> {
  const selected: LineEntry[] = [];
  let bytes = 0;
  let lineNumber = 0;
  let completed = true;

  const stream = createTextReadStream(source);
  const reader = createInterface({
    crlfDelay: Number.POSITIVE_INFINITY,
    input: stream,
  });

  try {
    for await (const line of reader) {
      lineNumber += 1;
      if (lineNumber < range.start) {
        continue;
      }
      if (lineNumber > range.end) {
        completed = false;
        break;
      }

      const entry: LineEntry = {
        bytes: lineBytes(line),
        lineNumber,
        text: line,
      };
      if (bytes + entry.bytes > MAX_TARGET_WINDOW_SIZE) {
        if (selected.length === 0) {
          const text = truncateUtf8(entry.text, MAX_TARGET_WINDOW_SIZE);
          selected.push({
            bytes: Buffer.byteLength(text, "utf8"),
            lineNumber,
            text,
          });
        }
        completed = false;
        break;
      }
      selected.push(entry);
      bytes += entry.bytes;
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  const startLine = selected[0]?.lineNumber ?? range.start;
  const endLine = selected.at(-1)?.lineNumber ?? startLine;
  return {
    content: selected.map((line) => line.text).join("\n"),
    endLine,
    startLine,
    totalLines: completed ? lineNumber : undefined,
    truncated: startLine > 1 || !completed,
  };
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function collectRenderedMarkdownMediaPaths(html: string): string[] {
  const paths = new Set<string>();
  const dataMediaPathPattern = /\bdata-media-path\s*=\s*(["'])(.*?)\1/gi;
  const localImageSrcPattern = /\bsrc\s*=\s*(["'])(.*?)\1/gi;

  for (const match of html.matchAll(dataMediaPathPattern)) {
    const rawPath = match[2];
    if (rawPath) {
      paths.add(decodeHtmlAttribute(rawPath));
    }
  }

  for (const match of html.matchAll(localImageSrcPattern)) {
    const rawSrc = match[2];
    if (!rawSrc) {
      continue;
    }
    try {
      const url = new URL(decodeHtmlAttribute(rawSrc), "http://local");
      if (
        url.origin === "http://local" &&
        url.pathname === "/api/local-image"
      ) {
        const rawPath = url.searchParams.get("path");
        if (rawPath) {
          paths.add(rawPath);
        }
      }
    } catch {
      // Ignore malformed generated HTML references.
    }
  }

  return Array.from(paths);
}

async function collectEmbeddedMarkdownMedia(
  html: string,
  projectRoot: string,
  strictProjectFileAccess: boolean,
): Promise<FileContentResponse["embeddedMedia"] | undefined> {
  const mediaPaths = collectRenderedMarkdownMediaPaths(html);
  if (mediaPaths.length === 0) {
    return undefined;
  }

  const realRoot = await realpath(projectRoot).catch(() => null);
  if (!realRoot) {
    return undefined;
  }

  let totalBytes = 0;
  const embeddedMedia: NonNullable<FileContentResponse["embeddedMedia"]> = {};
  for (const rawPath of mediaPaths) {
    if (
      !rawPath ||
      !isAbsolute(rawPath) ||
      !isPathInsideDirectory(rawPath, realRoot)
    ) {
      continue;
    }

    const relativePath = relative(realRoot, rawPath);
    const opened = strictProjectFileAccess
      ? await openProjectRelativeFile(realRoot, relativePath)
      : null;
    const realPath = opened
      ? opened.filePath
      : strictProjectFileAccess
        ? null
        : await realpath(rawPath).catch(() => null);
    if (!realPath || !isPathInsideDirectory(realPath, realRoot)) {
      await opened?.handle.close();
      continue;
    }

    const mediaHandle = opened?.handle ?? (await open(realPath, "r"));
    try {
      const stats = opened?.stats ?? (await mediaHandle.stat());
      if (
        !stats.isFile() ||
        stats.size > MAX_EMBEDDED_MARKDOWN_MEDIA_FILE_BYTES ||
        totalBytes + stats.size > MAX_EMBEDDED_MARKDOWN_MEDIA_BYTES
      ) {
        continue;
      }

      const mimeType = getMimeType(realPath);
      if (!mimeType.startsWith("image/")) {
        continue;
      }

      const content = await readFileHandleBounded(
        mediaHandle,
        MAX_EMBEDDED_MARKDOWN_MEDIA_FILE_BYTES,
      );
      if (!content) continue;
      const value = { data: content.toString("base64"), mimeType };
      totalBytes += content.byteLength;
      embeddedMedia[rawPath] = value;
      embeddedMedia[realPath] = value;
      embeddedMedia[relative(realRoot, realPath).replaceAll("\\", "/")] = value;
    } finally {
      await mediaHandle.close();
    }
  }

  return Object.keys(embeddedMedia).length > 0 ? embeddedMedia : undefined;
}

/** Dotfiles (files starting with .) that are text files */
const TEXT_DOTFILES = new Set([
  ".env",
  ".gitignore",
  ".gitattributes",
  ".gitmodules",
  ".editorconfig",
  ".prettierrc",
  ".prettierignore",
  ".eslintrc",
  ".eslintignore",
  ".babelrc",
  ".npmrc",
  ".nvmrc",
  ".dockerignore",
  ".browserslistrc",
  ".stylelintrc",
]);

/**
 * Check if file is a text file based on extension.
 */
function isTextFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  if (ext) {
    return TEXT_EXTENSIONS.has(ext);
  }
  // Handle dotfiles (files with no extension but starting with .)
  return TEXT_DOTFILES.has(basename(filePath).toLowerCase());
}

function isSniffableUnknownTextCandidate(
  filePath: string,
  mimeType: string,
): boolean {
  return mimeType === "application/octet-stream" && !isTextFile(filePath);
}

async function isSniffedTextFile(
  source: FileReadSource,
  stats: Stats,
): Promise<boolean> {
  if (stats.size === 0) {
    return true;
  }

  const bytesToRead = Math.min(stats.size, TEXT_SNIFF_BYTES);
  const buffer = Buffer.alloc(bytesToRead);
  const file = typeof source === "string" ? await open(source, "r") : source;
  try {
    const { bytesRead } = await file.read(buffer, 0, bytesToRead, 0);
    return isLikelyUtf8Text(buffer.subarray(0, bytesRead));
  } catch {
    return false;
  } finally {
    if (typeof source === "string") await file.close();
  }
}

/**
 * Validate and resolve a file path for authenticated project file APIs.
 *
 * Relative paths stay project-contained and symlink-safe. Absolute and
 * home-relative paths are intentionally allowed here because the authenticated
 * YA operator can already inspect host files through provider actions. Public
 * share file routes use separate share-scoped resolution.
 */
async function resolveFilePath(
  projectRoot: string,
  relativePath: string,
  pathPolicy?: LocalResourcePathPolicy,
): Promise<string | null> {
  // Normalize the path to handle . and ..
  const normalized = normalize(expandHomePath(relativePath));

  if (isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    const resolved =
      (await realpath(normalized).catch(() => null)) ?? normalized;
    // When a file-access policy is configured, absolute/`~` paths must fall
    // inside an allowed prefix (projects ∪ uploads ∪ temp ∪ home ∪ custom).
    // Without a policy (tests/embedding) the legacy any-readable-path behavior
    // is preserved.
    if (pathPolicy) {
      const allowed = await pathPolicy.getAllowedPaths();
      const ok = allowed.some((prefix) =>
        isPathInsideDirectory(resolved, prefix),
      );
      if (!ok) {
        return null;
      }
    }
    return resolved;
  }

  // Reject paths that try to escape (after normalization, should not start with ..)
  if (normalized.startsWith("..")) {
    return null;
  }

  // Resolve to absolute path
  const resolved = resolve(projectRoot, normalized);

  // Verify the resolved path is still within project root
  const normalizedRoot = resolve(projectRoot);
  if (!isPathInsideDirectory(resolved, normalizedRoot)) {
    return null;
  }

  const realRoot = await realpath(normalizedRoot).catch(() => null);
  if (!realRoot) {
    return null;
  }

  const realResolved = await realpath(resolved).catch(() => null);
  if (!realResolved) {
    return resolved;
  }

  // The lexical check above blocks ordinary traversal. This second check is
  // the security boundary for symlinks inside a project; keeping it here keeps
  // the file API simple while allowing normal in-project symlinks.
  if (!isPathInsideDirectory(realResolved, realRoot)) {
    return null;
  }

  return realResolved;
}

/** Most entries one folder listing returns; the rest are reported truncated. */
const MAX_FOLDER_LISTING_ENTRIES = 2000;

/**
 * One listed entry, classified after following a symlink so a linked folder
 * reads as a folder. Whether the target may be opened is decided again when it
 * is listed or read, by the same containment check as any other path.
 */
async function describeFolderEntry(
  folder: string,
  name: string,
): Promise<FolderEntry> {
  try {
    const stats = await stat(join(folder, name));
    const modifiedAt = Math.round(stats.mtimeMs);
    if (stats.isDirectory()) return { name, kind: "folder", modifiedAt };
    if (stats.isFile()) {
      return { name, kind: "file", size: stats.size, modifiedAt };
    }
  } catch {
    // A dangling link or an entry removed since readdir.
  }
  return { name, kind: "other" };
}

function isPathInsideDirectory(filePath: string, directory: string): boolean {
  const relativePath = relative(resolve(directory), resolve(filePath));
  return (
    relativePath === "" ||
    (relativePath !== "" &&
      !relativePath.startsWith("..") &&
      !isAbsolute(relativePath))
  );
}

interface DeferredFilePathDiscovery {
  html: string;
  projectId: string;
  projectPath: string;
  resolveAbsoluteFilePaths?: (
    paths: readonly string[],
  ) => Promise<ReadonlySet<string>>;
  selfAbsolutePath: string;
  selfRelativePath: string;
}

function scheduleFilePathDiscovery({
  html,
  projectId,
  projectPath,
  resolveAbsoluteFilePaths,
  selfAbsolutePath,
  selfRelativePath,
}: DeferredFilePathDiscovery): void {
  const handle = setImmediate(() => {
    void (async () => {
      const index = await getProjectPathIndex(projectPath);
      try {
        await linkifyProjectPaths(html, {
          projectId,
          projectPath,
          index,
          resolveAbsoluteFilePaths,
          selfAbsolutePath,
          selfRelativePath,
        });
      } finally {
        index.release();
      }
    })().catch((error: unknown) => {
      getLogger().debug(
        { error, projectId, selfRelativePath },
        "FILE_VIEWER_PATH_DISCOVERY: deferred annotation failed",
      );
    });
  });
  handle.unref();
}

export function createFilesRoutes(deps: FilesDeps): Hono {
  const routes = new Hono();

  // Shared file-access policy for absolute/`~` paths (same allow-set as the
  // media doors). Undefined when no allow-list is configured (legacy behavior).
  const pathPolicy =
    deps.allowedPaths !== undefined
      ? createLocalResourcePathPolicy({
          allowedPaths: deps.allowedPaths,
          scanner: deps.scanner,
          includeProjects: deps.includeProjects,
        })
      : undefined;

  /**
   * GET /api/projects/:projectId/files
   * Get file metadata and content.
   * Query params:
   *   - path: relative path to file (required)
   *   - highlight: if "true", include syntax-highlighted HTML
   */
  routes.get("/:projectId/files", async (c) => {
    const projectId = c.req.param("projectId");
    const relativePath = c.req.query("path");
    const highlight = c.req.query("highlight") === "true";
    // A freshness probe: the same authorization and metadata, no content read.
    const metadataOnly = c.req.query("metadata") === "only";
    const viewMode: FileViewMode =
      c.req.query("view") === "range" ? "range" : "full";
    const requestedRange = getLineRange(
      parsePositiveIntegerQuery(c.req.query("line")),
      parsePositiveIntegerQuery(c.req.query("lineEnd")),
    );

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    if (!relativePath) {
      return c.json({ error: "Missing path parameter" }, 400);
    }

    const project = await deps.scanner.getProject(projectId, {
      allowStaleSnapshot: true,
    });
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const projectRoot = project.path;

    let filePath: string;
    let stats: Stats;
    let fileHandle: FileHandle | undefined;
    if (deps.strictProjectFileAccess) {
      const opened = await openProjectRelativeFile(projectRoot, relativePath);
      if (!opened) {
        return c.json({ error: "File not found" }, 404);
      }
      filePath = opened.filePath;
      stats = opened.stats;
      fileHandle = opened.handle;
    } else {
      const resolved = await resolveFilePath(
        projectRoot,
        relativePath,
        pathPolicy,
      );
      if (!resolved) {
        return c.json({ error: "Invalid file path" }, 400);
      }
      filePath = resolved;
      try {
        stats = await stat(filePath);
      } catch {
        return c.json({ error: "File not found" }, 404);
      }
      if (!stats.isFile()) {
        return c.json({ error: "Path is not a file" }, 400);
      }
    }

    const readSource = fileHandle ?? filePath;
    try {
      const mimeType = getMimeType(filePath);
      // A targeted link into a file past the highlight bound gets a window
      // around its target, which the bounded highlighting can still cover.
      const inlineLimit =
        mimeType === "text/html"
          ? MAX_INLINE_HTML_SIZE
          : requestedRange
            ? MAX_TARGET_WINDOW_SIZE
            : MAX_INLINE_SIZE;
      const knownText = isTextFile(filePath);
      const isText =
        knownText ||
        (isSniffableUnknownTextCandidate(filePath, mimeType) &&
          (await isSniffedTextFile(readSource, stats)));

      const metadata: FileMetadata = {
        path: relativePath,
        size: stats.size,
        mimeType,
        isText,
        modifiedAt: Math.round(stats.mtimeMs),
      };

      const rawUrl = `/api/projects/${projectId}/files/raw?path=${encodeURIComponent(relativePath)}`;

      const response: FileContentResponse = {
        metadata,
        rawUrl,
      };
      if (metadataOnly) return c.json(response);
      let deferredPathDiscoveryHtml: string | undefined;

      // For text files under size limit, include the whole file unless the link
      // explicitly asks for a compact range view. For targeted links into larger
      // files, include a bounded window centered on the target.
      if (isText && (stats.size <= inlineLimit || requestedRange)) {
        try {
          const fullInlineContent =
            stats.size <= inlineLimit
              ? ((await readUtf8Bounded(readSource, inlineLimit)) ?? undefined)
              : undefined;
          const slice =
            viewMode === "range" && requestedRange
              ? fullInlineContent !== undefined
                ? sliceContentToRange(fullInlineContent, requestedRange)
                : await readExactTextRange(readSource, requestedRange)
              : fullInlineContent !== undefined
                ? {
                    content: fullInlineContent,
                    endLine: undefined,
                    startLine: 1,
                    totalLines: undefined,
                    truncated: false,
                  }
                : await readTargetedTextWindow(readSource, requestedRange!);
          const { content } = slice;
          response.content = content;
          response.contentStartLine = slice.startLine;
          if (slice.endLine !== undefined) {
            response.contentEndLine = slice.endLine;
          }
          if (slice.totalLines !== undefined) {
            response.contentTotalLines = slice.totalLines;
          }
          if (slice.truncated) {
            response.contentTruncated = true;
          }

          if (highlight) {
            // Keep source rendering bounded even when the document preview
            // needs all embedded assets. A minified HTML line can be huge.
            const highlightContent = truncateUtf8(content, MAX_HIGHLIGHT_SIZE);
            const result = await highlightFile(highlightContent, relativePath);
            if (result) {
              // A path in this file's text is a link when it names a real file
              // here, so an agent handing over a JSON manifest of run outputs
              // becomes navigable without the reader copying paths out.
              const pathIndex = await getProjectPathIndex(projectRoot);
              try {
                response.highlightedHtml = await linkifyProjectPaths(
                  result.html,
                  {
                    projectId,
                    projectPath: projectRoot,
                    index: pathIndex,
                    knownAbsoluteFilePaths:
                      deps.strictProjectFileAccess === true
                        ? undefined
                        : pathPolicy?.findKnownAllowedFilePaths,
                    pathDiscovery: "known-only",
                    selfAbsolutePath: filePath,
                    selfRelativePath: relativePath,
                    resolveAbsoluteFilePaths:
                      deps.strictProjectFileAccess === true
                        ? undefined
                        : pathPolicy?.findAllowedFilePaths,
                  },
                );
              } finally {
                pathIndex.release();
              }
              deferredPathDiscoveryHtml = result.html;
              response.highlightedLanguage = result.language;
              response.highlightedTruncated =
                result.truncated || highlightContent.length < content.length;
            }

            // Render Markdown preview for supported document files.
            const ext = extname(relativePath).toLowerCase();
            if (ext === ".md" || ext === ".markdown" || ext === ".qmd") {
              try {
                const largeRangePreviewSlice =
                  fullInlineContent === undefined &&
                  viewMode === "range" &&
                  requestedRange
                    ? await readTargetedTextWindow(readSource, requestedRange)
                    : undefined;
                const previewContent =
                  fullInlineContent !== undefined && requestedRange
                    ? fullInlineContent
                    : (largeRangePreviewSlice?.content ?? content);
                const previewStartLine =
                  fullInlineContent !== undefined && requestedRange
                    ? 1
                    : (largeRangePreviewSlice?.startLine ?? slice.startLine);
                const previewPathIndex = await getProjectPathIndex(projectRoot);
                let renderedMarkdownHtml: string;
                try {
                  renderedMarkdownHtml = await renderMarkdownFilePreview(
                    previewContent,
                    {
                      localFileBasePath: dirname(filePath),
                      quartoMarkdown: ext === ".qmd",
                      projectFileLinks: {
                        projectId,
                        projectPath: projectRoot,
                        index: previewPathIndex,
                        knownAbsoluteFilePaths:
                          deps.strictProjectFileAccess === true
                            ? undefined
                            : pathPolicy?.findKnownAllowedFilePaths,
                        pathDiscovery: "known-only",
                        resolveAbsoluteFilePaths:
                          deps.strictProjectFileAccess === true
                            ? undefined
                            : pathPolicy?.findAllowedFilePaths,
                      },
                    },
                    previewStartLine,
                    requestedRange,
                    viewMode,
                  );
                } finally {
                  previewPathIndex.release();
                }
                response.renderedMarkdownHtml = renderedMarkdownHtml;
                response.embeddedMedia = await collectEmbeddedMarkdownMedia(
                  renderedMarkdownHtml,
                  projectRoot,
                  deps.strictProjectFileAccess ?? false,
                );
              } catch {
                // Ignore markdown rendering errors
              }
            }
          }
        } catch {
          // If we can't read as text, just omit content
        }
      }

      const result = c.json(response);
      if (deferredPathDiscoveryHtml) {
        scheduleFilePathDiscovery({
          html: deferredPathDiscoveryHtml,
          projectId,
          projectPath: projectRoot,
          resolveAbsoluteFilePaths:
            deps.strictProjectFileAccess === true
              ? undefined
              : pathPolicy?.findAllowedFilePaths,
          selfAbsolutePath: filePath,
          selfRelativePath: relativePath,
        });
      }
      return result;
    } finally {
      await fileHandle?.close();
    }
  });

  /**
   * GET /api/projects/:projectId/files/raw
   * Get raw file content with appropriate Content-Type.
   * Query params:
   *   - path: relative path to file (required)
   *   - download: if "true", set Content-Disposition to attachment
   */
  routes.get("/:projectId/files/raw", async (c) => {
    const projectId = c.req.param("projectId");
    const relativePath = c.req.query("path");
    const download = c.req.query("download") === "true";

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    if (!relativePath) {
      return c.json({ error: "Missing path parameter" }, 400);
    }

    const project = await deps.scanner.getProject(projectId, {
      allowStaleSnapshot: true,
    });
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const projectRoot = project.path;

    let filePath: string;
    let stats: Stats;
    let fileHandle: FileHandle | undefined;
    if (deps.strictProjectFileAccess) {
      const opened = await openProjectRelativeFile(projectRoot, relativePath);
      if (!opened) {
        return c.json({ error: "File not found" }, 404);
      }
      filePath = opened.filePath;
      stats = opened.stats;
      fileHandle = opened.handle;
    } else {
      const resolved = await resolveFilePath(
        projectRoot,
        relativePath,
        pathPolicy,
      );
      if (!resolved) {
        return c.json({ error: "Invalid file path" }, 400);
      }
      filePath = resolved;
      try {
        const snapshot = await openMutableFileSnapshot(filePath, deps.openFile);
        if (!snapshot) {
          return c.json({ error: "Path is not a file" }, 400);
        }
        stats = snapshot.stats;
        fileHandle = snapshot.handle;
      } catch {
        return c.json({ error: "File not found" }, 404);
      }
    }

    const mimeType = getMimeType(filePath);
    const fileName = relativePath.split("/").pop() || "file";
    const cacheMetadata = createMutableFileCacheMetadata(stats);
    const headers = createUntrustedFileResponseHeaders({
      baseHeaders: {
        ...mutableFileCacheHeaders(cacheMetadata),
        "Content-Length": String(stats.size),
      },
      contentType: mimeType,
      disposition: download ? "attachment" : "inline",
      filePath: fileName,
    });

    return createMutableFileResponse(
      c.req.raw.headers,
      { handle: fileHandle, stats },
      cacheMetadata,
      headers,
    );
  });

  /**
   * GET /api/projects/:projectId/files/list?path=<folder>
   * The direct children of one folder, for the File Viewer's path segments.
   * Resolution and containment are the file read's: a relative folder stays
   * inside the project, `""` names its root. A host path outside the project
   * is the superuser's alone, as for the Working Tree browser's `root=`
   * listing. A share-scoped instance never lists: a public file grant names
   * files, not folders.
   */
  routes.get("/:projectId/files/list", async (c) => {
    const projectId = c.req.param("projectId");
    const requested = c.req.query("path");
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }
    if (requested === undefined) {
      return c.json({ error: "Missing path parameter" }, 400);
    }
    if (deps.strictProjectFileAccess) {
      return c.json({ error: "Folder listing is unavailable" }, 404);
    }
    const folderPath = requested === "" ? "." : requested;
    const normalized = normalize(expandHomePath(folderPath));
    if (isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
      // This router is untyped; the principal middleware sets the variable.
      const principal = c.get(PRINCIPAL_VARIABLE as never) as
        | Principal
        | undefined;
      if (principal && principal.kind !== "superuser") {
        return c.json({ error: "Superuser required" }, 403);
      }
    }
    const project = await deps.scanner.getProject(projectId, {
      allowStaleSnapshot: true,
    });
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    const folder = await resolveFilePath(project.path, folderPath, pathPolicy);
    if (!folder) {
      return c.json({ error: "Invalid folder path" }, 400);
    }
    let dirents: Dirent[];
    try {
      dirents = await readdir(folder, { withFileTypes: true });
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOTDIR"
        ? c.json({ error: "Path is not a folder" }, 400)
        : c.json({ error: "Folder not found" }, 404);
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const entries = await Promise.all(
      dirents
        .slice(0, MAX_FOLDER_LISTING_ENTRIES)
        .map((dirent) => describeFolderEntry(folder, dirent.name)),
    );
    const response: FolderListingResponse = {
      path: requested,
      entries,
      truncated: dirents.length > MAX_FOLDER_LISTING_ENTRIES,
    };
    return c.json(response);
  });

  /**
   * POST /api/projects/:projectId/diff/expand
   * Compute an expanded diff with full file context.
   *
   * Uses originalFile from the SDK's Edit tool result directly - the SDK never
   * truncates this field (verified up to 150KB+ files).
   *
   * Body:
   *   - filePath: path to file (for syntax highlighting detection)
   *   - oldString: the original text being replaced
   *   - newString: the new text to insert
   *   - originalFile: complete file content from SDK Edit result
   */
  routes.post("/:projectId/diff/expand", async (c) => {
    let body: {
      filePath: string;
      oldString: string;
      newString: string;
      originalFile: string;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { filePath, oldString, newString, originalFile } = body;

    if (
      !filePath ||
      typeof oldString !== "string" ||
      typeof newString !== "string" ||
      typeof originalFile !== "string"
    ) {
      return c.json(
        {
          error:
            "Missing required fields: filePath, oldString, newString, originalFile",
        },
        400,
      );
    }

    // Compute the new file content by applying the edit
    const newFullContent = originalFile.replace(oldString, newString);

    // Compute augment with large context (entire file)
    const augment = await computeEditAugment(
      "expand",
      {
        file_path: filePath,
        old_string: originalFile,
        new_string: newFullContent,
      },
      999999, // Full file context
    );

    return c.json({
      structuredPatch: augment.structuredPatch as PatchHunk[],
      diffHtml: augment.diffHtml,
    });
  });

  return routes;
}
