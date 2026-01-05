/**
 * File path detection utility.
 *
 * Detects file paths in text and provides functionality to split text into
 * segments that can be rendered with clickable file links.
 *
 * This module is shared between server and client for consistent file path
 * detection in both streaming and reload rendering paths.
 */

/**
 * A detected file path with optional line/column information.
 */
export interface DetectedFilePath {
  /** The original matched string */
  match: string;
  /** The file path portion (without line/column) */
  filePath: string;
  /** Optional line number */
  lineNumber?: number;
  /** Optional column number */
  columnNumber?: number;
  /** Start index in the original text */
  startIndex: number;
  /** End index in the original text */
  endIndex: number;
}

/**
 * A segment of text that is either plain text or a file path.
 */
export type TextSegment =
  | { type: "text"; content: string }
  | { type: "filePath"; detected: DetectedFilePath };

/**
 * Common file extensions that indicate a file path.
 */
const FILE_EXTENSIONS = new Set([
  // TypeScript/JavaScript
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "mts",
  "cts",
  // Web
  "html",
  "htm",
  "css",
  "scss",
  "sass",
  "less",
  "vue",
  "svelte",
  // Data/Config
  "json",
  "yaml",
  "yml",
  "toml",
  "xml",
  "csv",
  "env",
  // Documentation
  "md",
  "mdx",
  "txt",
  "rst",
  // Python
  "py",
  "pyi",
  "pyx",
  "ipynb",
  // Ruby
  "rb",
  "erb",
  "rake",
  // Go
  "go",
  "mod",
  "sum",
  // Rust
  "rs",
  "toml",
  // Java/Kotlin
  "java",
  "kt",
  "kts",
  "gradle",
  // C/C++
  "c",
  "h",
  "cpp",
  "hpp",
  "cc",
  "cxx",
  "hxx",
  // Shell
  "sh",
  "bash",
  "zsh",
  "fish",
  // Other
  "sql",
  "graphql",
  "gql",
  "proto",
  "swift",
  "php",
  "lua",
  "vim",
  "el",
  "ex",
  "exs",
  "erl",
  "hrl",
  "hs",
  "lhs",
  "ml",
  "mli",
  "fs",
  "fsx",
  "fsi",
  "clj",
  "cljs",
  "cljc",
  "edn",
  "scala",
  "sbt",
  "r",
  "R",
  "rmd",
  "jl",
  "pl",
  "pm",
  "t",
  "dart",
  "zig",
  "nim",
  "cr",
  "v",
  "tf",
  "tfvars",
  "dockerfile",
  "makefile",
  "cmake",
  "lock",
  "log",
]);

/**
 * Known filenames that are common in codebases.
 */
const KNOWN_FILENAMES = new Set([
  // Config files
  "Dockerfile",
  "Makefile",
  "CMakeLists.txt",
  "Rakefile",
  "Gemfile",
  "Procfile",
  "Vagrantfile",
  ".gitignore",
  ".gitattributes",
  ".npmrc",
  ".nvmrc",
  ".prettierrc",
  ".eslintrc",
  ".editorconfig",
  "package.json",
  "tsconfig.json",
  "jsconfig.json",
  "biome.json",
  "vitest.config.ts",
  "vite.config.ts",
  "webpack.config.js",
  "rollup.config.js",
  "babel.config.js",
  "jest.config.js",
  "tailwind.config.js",
  "postcss.config.js",
  "next.config.js",
  "nuxt.config.js",
  "svelte.config.js",
  "astro.config.mjs",
  "README.md",
  "CLAUDE.md",
  "LICENSE",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "requirements.txt",
  "setup.py",
  "pyproject.toml",
  "poetry.lock",
  "Pipfile",
  "Pipfile.lock",
]);

/**
 * Regex pattern for detecting file paths.
 *
 * Matches:
 * - Absolute paths: /path/to/file.ts
 * - Relative paths: ./src/file.ts, src/file.ts
 * - Paths with line numbers: file.ts:42
 * - Paths with line and column: file.ts:42:10
 *
 * Excludes:
 * - URLs (http://, https://, file://)
 * - Email-like patterns (user@domain)
 * - Paths that are clearly prose
 */
const FILE_PATH_PATTERN =
  /(?<!\S)(?:\.{0,2}\/)?(?:[a-zA-Z0-9_@-]+\/)*[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+(?::\d+(?::\d+)?)?(?!\S)|(?<!\S)\/(?:[a-zA-Z0-9_@.-]+\/)+[a-zA-Z0-9_.-]+(?::\d+(?::\d+)?)?(?!\S)/g;

/**
 * Check if a string looks like a URL.
 */
function looksLikeUrl(str: string): boolean {
  return /^(?:https?|file|ftp|mailto|tel|data):/.test(str.toLowerCase());
}

/**
 * Check if a string looks like an email.
 */
function looksLikeEmail(str: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);
}

/**
 * Check if a string is likely a valid file path.
 */
export function isLikelyFilePath(str: string): boolean {
  // Skip URLs
  if (looksLikeUrl(str)) return false;

  // Skip emails
  if (looksLikeEmail(str)) return false;

  // Skip if it contains URL-like patterns
  if (str.includes("://")) return false;

  // Extract the path portion (without line/column numbers)
  const pathPortion = str.replace(/:\d+(?::\d+)?$/, "");

  // Get the filename
  const parts = pathPortion.split("/");
  const filename = parts[parts.length - 1] ?? "";

  // Check for known filenames
  if (filename && KNOWN_FILENAMES.has(filename)) return true;

  // Check for file extension
  const extMatch = filename.match(/\.([a-zA-Z0-9]+)$/);
  if (extMatch?.[1]) {
    const ext = extMatch[1].toLowerCase();
    if (FILE_EXTENSIONS.has(ext)) return true;
  }

  // If the path has directory components and looks like a reasonable path
  // be more lenient (e.g., packages/client/src/...)
  if (parts.length >= 2 && filename && /^[a-zA-Z0-9_.-]+$/.test(filename)) {
    // Check if it has a common directory pattern
    const commonDirs = [
      "src",
      "lib",
      "test",
      "tests",
      "spec",
      "app",
      "components",
      "pages",
      "api",
      "routes",
      "utils",
      "hooks",
      "styles",
      "assets",
      "public",
      "static",
      "dist",
      "build",
      "node_modules",
      "packages",
    ];
    if (parts.some((p) => commonDirs.includes(p))) {
      return true;
    }
  }

  return false;
}

/**
 * Parse line and column numbers from a file path string.
 */
export function parseLineColumn(str: string): {
  path: string;
  line?: number;
  column?: number;
} {
  const match = str.match(/^(.+?):(\d+)(?::(\d+))?$/);
  if (match?.[1] && match[2]) {
    return {
      path: match[1],
      line: Number.parseInt(match[2], 10),
      column: match[3] ? Number.parseInt(match[3], 10) : undefined,
    };
  }
  return { path: str };
}

/**
 * Detect file paths in a text string.
 *
 * @param text - The text to search for file paths
 * @returns Array of detected file paths with positions
 */
export function detectFilePaths(text: string): DetectedFilePath[] {
  const results: DetectedFilePath[] = [];
  const pattern = new RegExp(FILE_PATH_PATTERN.source, "g");

  for (
    let match = pattern.exec(text);
    match !== null;
    match = pattern.exec(text)
  ) {
    const matchStr = match[0];

    // Validate that this looks like a real file path
    if (!isLikelyFilePath(matchStr)) continue;

    // Parse line/column
    const { path, line, column } = parseLineColumn(matchStr);

    results.push({
      match: matchStr,
      filePath: path,
      lineNumber: line,
      columnNumber: column,
      startIndex: match.index,
      endIndex: match.index + matchStr.length,
    });
  }

  return results;
}

/**
 * Split text into segments of plain text and file paths.
 *
 * @param text - The text to process
 * @returns Array of text segments
 */
export function splitTextWithFilePaths(text: string): TextSegment[] {
  const detected = detectFilePaths(text);

  if (detected.length === 0) {
    return [{ type: "text", content: text }];
  }

  const segments: TextSegment[] = [];
  let lastIndex = 0;

  for (const fp of detected) {
    // Add text before this file path
    if (fp.startIndex > lastIndex) {
      segments.push({
        type: "text",
        content: text.slice(lastIndex, fp.startIndex),
      });
    }

    // Add the file path segment
    segments.push({
      type: "filePath",
      detected: fp,
    });

    lastIndex = fp.endIndex;
  }

  // Add remaining text after last file path
  if (lastIndex < text.length) {
    segments.push({
      type: "text",
      content: text.slice(lastIndex),
    });
  }

  return segments;
}

/**
 * Transform text by replacing file paths with HTML links.
 * Used for server-side rendering of file path links.
 *
 * @param text - The text to process
 * @param escapeHtml - Function to escape HTML in non-link text
 * @returns HTML string with file paths as anchor tags
 */
export function transformFilePathsToHtml(
  text: string,
  escapeHtml: (s: string) => string,
): string {
  const segments = splitTextWithFilePaths(text);

  return segments
    .map((segment) => {
      if (segment.type === "text") {
        return escapeHtml(segment.content);
      }

      const { detected } = segment;
      const dataAttrs = [
        `data-file-path="${escapeHtml(detected.filePath)}"`,
        detected.lineNumber !== undefined
          ? `data-line="${detected.lineNumber}"`
          : "",
        detected.columnNumber !== undefined
          ? `data-column="${detected.columnNumber}"`
          : "",
      ]
        .filter(Boolean)
        .join(" ");

      return `<a class="file-link" ${dataAttrs}>${escapeHtml(detected.match)}</a>`;
    })
    .join("");
}
