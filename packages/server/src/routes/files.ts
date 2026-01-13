import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, normalize, resolve } from "node:path";
import {
  type FileContentResponse,
  type FileMetadata,
  type PatchHunk,
  isUrlProjectId,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import { computeEditAugment } from "../augments/edit-augments.js";
import { renderMarkdownToHtml } from "../augments/markdown-augments.js";
import { highlightFile } from "../highlighting/index.js";
import type { ProjectScanner } from "../projects/scanner.js";

export interface FilesDeps {
  scanner: ProjectScanner;
}

/** Maximum file size to include content inline (1MB) */
const MAX_INLINE_SIZE = 1024 * 1024;

/** MIME type mappings by extension */
const MIME_TYPES: Record<string, string> = {
  // Text/code files
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
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
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/** Extensions that are considered text files */
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
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
  return MIME_TYPES[ext] || "application/octet-stream";
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
  const fileName = filePath.split("/").pop() || filePath;
  return TEXT_DOTFILES.has(fileName.toLowerCase());
}

/**
 * Validate and resolve file path, preventing directory traversal.
 * Returns null if the path is invalid or escapes the project root.
 */
function resolveFilePath(
  projectRoot: string,
  relativePath: string,
): string | null {
  // Normalize the path to handle . and ..
  const normalized = normalize(relativePath);

  // Reject absolute paths
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    return null;
  }

  // Reject paths that try to escape (after normalization, should not start with ..)
  if (normalized.startsWith("..")) {
    return null;
  }

  // Resolve to absolute path
  const resolved = resolve(projectRoot, normalized);

  // Verify the resolved path is still within project root
  const normalizedRoot = resolve(projectRoot);
  if (
    !resolved.startsWith(`${normalizedRoot}/`) &&
    resolved !== normalizedRoot
  ) {
    return null;
  }

  return resolved;
}

export function createFilesRoutes(deps: FilesDeps): Hono {
  const routes = new Hono();

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

    // Validate project ID format
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    // Validate path parameter
    if (!relativePath) {
      return c.json({ error: "Missing path parameter" }, 400);
    }

    // Get project
    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    // Get the project's working directory
    const projectRoot = project.path;

    // Resolve and validate file path
    const filePath = resolveFilePath(projectRoot, relativePath);
    if (!filePath) {
      return c.json({ error: "Invalid file path" }, 400);
    }

    // Check file exists and get stats
    let stats: Stats;
    try {
      stats = await stat(filePath);
    } catch {
      return c.json({ error: "File not found" }, 404);
    }

    // Must be a file, not a directory
    if (!stats.isFile()) {
      return c.json({ error: "Path is not a file" }, 400);
    }

    const mimeType = getMimeType(filePath);
    const isText = isTextFile(filePath);

    const metadata: FileMetadata = {
      path: relativePath,
      size: stats.size,
      mimeType,
      isText,
    };

    // Build raw URL
    const rawUrl = `/api/projects/${projectId}/files/raw?path=${encodeURIComponent(relativePath)}`;

    const response: FileContentResponse = {
      metadata,
      rawUrl,
    };

    // For text files under size limit, include content
    if (isText && stats.size <= MAX_INLINE_SIZE) {
      try {
        const content = await readFile(filePath, "utf-8");
        response.content = content;

        // Add syntax highlighting if requested
        if (highlight) {
          const result = await highlightFile(content, relativePath);
          if (result) {
            response.highlightedHtml = result.html;
            response.highlightedLanguage = result.language;
            response.highlightedTruncated = result.truncated;
          }

          // Render markdown preview for .md files
          const ext = extname(relativePath).toLowerCase();
          if (ext === ".md" || ext === ".markdown") {
            try {
              response.renderedMarkdownHtml =
                await renderMarkdownToHtml(content);
            } catch {
              // Ignore markdown rendering errors
            }
          }
        }
      } catch {
        // If we can't read as text, just omit content
      }
    }

    return c.json(response);
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

    // Validate project ID format
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    // Validate path parameter
    if (!relativePath) {
      return c.json({ error: "Missing path parameter" }, 400);
    }

    // Get project
    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    // Get the project's working directory
    const projectRoot = project.path;

    // Resolve and validate file path
    const filePath = resolveFilePath(projectRoot, relativePath);
    if (!filePath) {
      return c.json({ error: "Invalid file path" }, 400);
    }

    // Check file exists and get stats
    let stats: Stats;
    try {
      stats = await stat(filePath);
    } catch {
      return c.json({ error: "File not found" }, 404);
    }

    // Must be a file, not a directory
    if (!stats.isFile()) {
      return c.json({ error: "Path is not a file" }, 400);
    }

    // Read file content
    let content: Buffer;
    try {
      content = await readFile(filePath);
    } catch {
      return c.json({ error: "Failed to read file" }, 500);
    }

    const mimeType = getMimeType(filePath);
    const fileName = relativePath.split("/").pop() || "file";

    // Set headers
    const headers: Record<string, string> = {
      "Content-Type": mimeType,
      "Content-Length": String(content.length),
    };

    if (download) {
      headers["Content-Disposition"] = `attachment; filename="${fileName}"`;
    } else {
      headers["Content-Disposition"] = `inline; filename="${fileName}"`;
    }

    // Convert Buffer to Uint8Array for Response compatibility
    return new Response(new Uint8Array(content), { headers });
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
    // Parse body
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
