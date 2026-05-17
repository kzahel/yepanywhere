import {
  Marked,
  type RendererObject,
  type RendererThis,
  type Tokens,
} from "marked";
import sanitizeHtml from "sanitize-html";
import { isLikelyFilePath } from "@yep-anywhere/shared";

const ALLOWED_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const ALLOWED_IMAGE_PROTOCOLS = new Set(["http:", "https:"]);

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tiff",
  "tif",
  "svg",
]);

const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "avi", "mkv", "ogv"]);

const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);

/**
 * Check if a string looks like a local file path.
 * Accepts both absolute paths and repo-relative file paths.
 */
function isLocalFilePath(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("//")) return false;
  if (/^(?:https?|file|ftp|mailto|tel|data):/i.test(trimmed)) return false;
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../")
  ) {
    const basename = trimmed.split("/").pop() ?? "";
    return basename.includes(".") || isLikelyFilePath(trimmed);
  }
  return isLikelyFilePath(trimmed);
}

/**
 * Get the file extension from a path (lowercase, without the dot).
 */
function getExtension(path: string): string {
  return (path.split(".").pop() ?? "").toLowerCase();
}

/**
 * Get the filename from a path.
 */
function getFileName(path: string): string {
  return path.trim().split("/").pop() ?? path;
}

/**
 * Rewrite a local file path to the local-image API endpoint.
 */
function localFileApiUrl(path: string): string {
  return `/api/local-image?path=${encodeURIComponent(path.trim())}`;
}

function renderLocalFileLink(
  path: string,
  label: string,
  title?: string | null,
  line?: number,
): string {
  const escapedLabel = escapeHtml(label || getFileName(path));
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  const dataAttrs = [
    `data-file-path="${escapeHtml(path.trim())}"`,
    line !== undefined ? `data-line="${line}"` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return `<a href="#" class="file-link local-file-link" ${dataAttrs}${titleAttr}>${escapedLabel}</a>`;
}

/**
 * Render a local media file as a clickable placeholder link.
 * The client intercepts clicks on .local-media-link to open a modal.
 */
function renderLocalMediaLink(
  path: string,
  label: string,
  ext: string,
): string {
  const apiUrl = escapeHtml(localFileApiUrl(path));
  const escapedLabel = escapeHtml(label || getFileName(path));
  const mediaType = VIDEO_EXTENSIONS.has(ext) ? "video" : "image";
  const typeLabel = VIDEO_EXTENSIONS.has(ext) ? "video" : "image";
  return `<a href="${apiUrl}" class="local-media-link" data-media-type="${mediaType}">${escapedLabel}<span class="local-media-type">(${typeLabel})</span></a>`;
}

const MARKDOWN_SANITIZE_OPTIONS = {
  allowedTags: [
    "a",
    "blockquote",
    "br",
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
      "data-file-path",
      "data-line",
    ],
    code: ["class"],
    img: ["src", "alt", "title"],
    input: ["type", "checked", "disabled"],
    ol: ["start"],
    span: ["class"],
    td: ["align"],
    th: ["align"],
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

const renderer: RendererObject<string, string> = {
  html({ text }) {
    // Disable raw HTML passthrough from markdown by escaping it.
    return escapeHtml(text);
  },
  link(
    this: RendererThis<string, string>,
    { href, title, tokens }: Tokens.Link,
  ) {
    // Check for local file paths first — rewrite to clickable media placeholder
    if (isLocalFilePath(href)) {
      const ext = getExtension(href);
      const renderedText = this.parser.parseInline(tokens);

      if (MEDIA_EXTENSIONS.has(ext)) {
        return renderLocalMediaLink(href, renderedText, ext);
      }
      return renderLocalFileLink(href, renderedText, title);
    }

    const safeHref = sanitizeUrl(href);
    const renderedText = this.parser.parseInline(tokens);

    if (!safeHref) {
      // Keep readable text when URL protocol is unsafe.
      return renderedText;
    }

    const escapedHref = escapeHtml(safeHref);
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<a href="${escapedHref}"${titleAttr}>${renderedText}</a>`;
  },
  image({ href, title, text }: Tokens.Image) {
    // Check for local file paths first — rewrite to clickable media placeholder
    if (isLocalFilePath(href)) {
      const ext = getExtension(href);

      if (MEDIA_EXTENSIONS.has(ext)) {
        return renderLocalMediaLink(href, text, ext);
      }
      return renderLocalFileLink(href, text || getFileName(href), title);
    }

    const safeSrc = sanitizeUrl(href, ALLOWED_IMAGE_PROTOCOLS);
    if (!safeSrc) {
      return escapeHtml(text);
    }

    const escapedSrc = escapeHtml(safeSrc);
    const altAttr = text ? ` alt="${escapeHtml(text)}"` : ' alt=""';
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<img src="${escapedSrc}"${altAttr}${titleAttr}>`;
  },
};

const markdownRenderer = new Marked({
  async: false,
  gfm: true,
});

markdownRenderer.use({ renderer });

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

/**
 * Render markdown to sanitized HTML with raw HTML disabled.
 */
export function renderSafeMarkdown(markdown: string): string {
  const rendered = markdownRenderer.parse(markdown, { async: false });
  const html = typeof rendered === "string" ? rendered : "";
  const sanitized = sanitizeHtml(html, MARKDOWN_SANITIZE_OPTIONS);
  return sanitized.trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export {
  IMAGE_EXTENSIONS,
  MEDIA_EXTENSIONS,
  VIDEO_EXTENSIONS,
  isLocalFilePath,
  localFileApiUrl,
  renderLocalFileLink,
};
