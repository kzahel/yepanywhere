/**
 * Shiki-based syntax highlighting service.
 *
 * Uses CSS variables for theming so client can switch light/dark without
 * re-rendering. Pre-loads common languages for fast highlighting.
 */

import {
  type BundledLanguage,
  type Highlighter,
  bundledLanguages,
  createHighlighter,
} from "shiki";
import { createCssVariablesTheme } from "shiki/core";

/** Maximum lines to highlight (avoid blocking on huge files) */
const MAX_LINES = 2000;

/** Languages to pre-load on startup */
const PRELOADED_LANGUAGES: BundledLanguage[] = [
  "javascript",
  "typescript",
  "tsx",
  "jsx",
  "python",
  "bash",
  "shell",
  "json",
  "css",
  "html",
  "yaml",
  "sql",
  "go",
  "rust",
  "java",
  "c",
  "cpp",
  "markdown",
  "diff",
];

/** CSS variables theme - outputs `style="color: var(--shiki-...)"` */
const cssVarsTheme = createCssVariablesTheme({
  name: "css-variables",
  variablePrefix: "--shiki-",
  fontStyle: true,
});

/** Extension to Shiki language mapping */
const EXTENSION_TO_LANG: Record<string, BundledLanguage> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  scala: "scala",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cc: "cpp",
  cs: "csharp",
  swift: "swift",
  m: "objective-c",
  mm: "objective-c",
  php: "php",
  pl: "perl",
  pm: "perl",
  lua: "lua",
  r: "r",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  elm: "elm",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hrl: "erlang",
  hs: "haskell",
  clj: "clojure",
  cljs: "clojure",
  cljc: "clojure",
  ml: "ocaml",
  mli: "ocaml",
  fs: "fsharp",
  fsx: "fsharp",
  dart: "dart",
  nim: "nim",
  zig: "zig",
  sol: "solidity",
  proto: "protobuf",
  prisma: "prisma",
  dockerfile: "dockerfile",
  makefile: "makefile",
  cmake: "cmake",
  gradle: "groovy",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  ps1: "powershell",
  json: "json",
  jsonc: "jsonc",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  md: "markdown",
  markdown: "markdown",
  diff: "diff",
  patch: "diff",
};

let highlighterPromise: Promise<Highlighter> | null = null;
let loadedLanguages: Set<string> = new Set();

/**
 * Get or create the singleton highlighter instance.
 */
async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [cssVarsTheme],
      langs: PRELOADED_LANGUAGES,
    }).then((h) => {
      loadedLanguages = new Set(PRELOADED_LANGUAGES);
      return h;
    });
  }
  return highlighterPromise;
}

/**
 * Get the Shiki language for a file path based on extension.
 * Returns null if the extension is unknown.
 */
export function getLanguageForPath(filePath: string): BundledLanguage | null {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (!ext) return null;

  const lang = EXTENSION_TO_LANG[ext];
  if (lang && lang in bundledLanguages) {
    return lang;
  }
  return null;
}

export interface HighlightResult {
  html: string;
  language: string;
  lineCount: number;
  truncated: boolean;
}

/**
 * Highlight code with syntax highlighting.
 *
 * @param code - The code to highlight
 * @param language - The language (Shiki language id or file extension)
 * @returns Highlighted HTML or null if language is unsupported
 */
export async function highlightCode(
  code: string,
  language: string,
): Promise<HighlightResult | null> {
  const highlighter = await getHighlighter();

  // Resolve language from extension if needed
  let lang: BundledLanguage | null = null;
  if (language in bundledLanguages) {
    lang = language as BundledLanguage;
  } else {
    lang = EXTENSION_TO_LANG[language.toLowerCase()] ?? null;
  }

  if (!lang) {
    return null;
  }

  // Load language if not already loaded
  if (!loadedLanguages.has(lang)) {
    try {
      await highlighter.loadLanguage(lang);
      loadedLanguages.add(lang);
    } catch {
      return null;
    }
  }

  // Check line count and truncate if needed
  const lines = code.split("\n");
  const truncated = lines.length > MAX_LINES;
  const codeToHighlight = truncated
    ? lines.slice(0, MAX_LINES).join("\n")
    : code;

  try {
    const html = highlighter.codeToHtml(codeToHighlight, {
      lang,
      theme: "css-variables",
    });

    return {
      html,
      language: lang,
      lineCount: lines.length,
      truncated,
    };
  } catch {
    return null;
  }
}

/**
 * Highlight a file's content.
 *
 * @param content - File content
 * @param filePath - File path (used to determine language)
 * @returns Highlighted HTML or null if language is unsupported
 */
export async function highlightFile(
  content: string,
  filePath: string,
): Promise<HighlightResult | null> {
  const lang = getLanguageForPath(filePath);
  if (!lang) {
    return null;
  }

  return highlightCode(content, lang);
}
