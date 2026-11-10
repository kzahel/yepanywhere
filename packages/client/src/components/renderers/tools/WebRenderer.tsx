import expandStyles from "../ExpandOutput.module.css";
import styles from "./WebRenderer.module.css";
import { toolDisplayContracts } from "./toolDisplayContracts";
import { defineTool } from "./defineTool";
import { type CSSProperties, useCallback, useMemo, useState } from "react";
import { useOutputToolPreviewLineCount } from "../../../hooks/useOutputAppearance";
import {
  useTextTooltipAttributes,
  useVisibilityAwareTextTooltip,
} from "../../../hooks/useTooltipAppearance";
import { selectionIntersectsElement } from "../../../lib/domSelection";
import { ActivityDetailModal } from "../../ActivityDetailModal";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { HiddenContentBadge } from "../../ui/HiddenContentBadge";
import {
  getHiddenOutputLineCount,
  getOutputTailTooltip,
  getPreviewLimits,
  OutputCopyButton,
  truncateOutput,
} from "./outputPreview";

const MAX_PAGE_LINES = 24;
const MAX_PREVIEW_PAGES = 3;
const MAX_TOOLTIP_PAGES = 20;

/**
 * Web tool (Codex `web.run`) — one call batches browsing commands: search
 * queries, page opens, in-page finds, link clicks. The server normalizes the
 * provider's text blob into CodexWebRunResult; page content is prose, so it
 * renders in the prose output font rather than the code font, while the
 * collapsed preview mirrors the shell-output affordances (first-N-lines
 * clip, tail tooltip, +N badge, copy button, click-for-full-content modal).
 */
export type WebInput = import("zod").z.output<
  typeof toolDisplayContracts.Web.input
>;
type WebResult = import("zod").z.output<typeof toolDisplayContracts.Web.result>;
type CodexWebRunResult = Exclude<WebResult, string>;
type CodexWebRunPage = CodexWebRunResult["pages"][number];
function isWebRunResult(
  result: WebResult | undefined,
): result is CodexWebRunResult {
  return typeof result === "object" && result !== null;
}

function hostnameOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function formatSeconds(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined;
  return `${seconds.toFixed(1)}s`;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function describeOps(input: WebInput | undefined): string {
  if (!input || typeof input !== "object") return "";
  const parts: string[] = [];
  const queries = [...(input.search_query ?? []), ...(input.image_query ?? [])];
  if (queries.length > 0 && queries[0]?.q) {
    const more = queries.length > 1 ? ` (+${queries.length - 1} more)` : "";
    parts.push(`search "${truncate(queries[0].q, 40)}"${more}`);
  }
  if (input.open?.length) {
    const first = input.open[0]?.ref_id;
    parts.push(
      input.open.length === 1 && first
        ? `open ${truncate(first, 40)}`
        : `open ×${input.open.length}`,
    );
  }
  if (input.find?.length) {
    const pattern = input.find[0]?.pattern;
    parts.push(pattern ? `find "${truncate(pattern, 30)}"` : "find");
  }
  if (input.click?.length) {
    parts.push(`click ${input.click.map((c) => `#${c.id ?? "?"}`).join(" ")}`);
  }
  return parts.join(" · ");
}

function pageLabel(page: CodexWebRunPage): string {
  return page.title || hostnameOf(page.url) || page.ref || "(untitled)";
}

function pageContentText(page: CodexWebRunPage): string {
  if (page.lines && page.lines.length > 0) {
    // Providers window short DOM fragments as many blank-separated lines;
    // collapse blank runs so prose reads as paragraphs, not gaps.
    return page.lines
      .map((line) => line.text)
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");
  }
  return page.text ?? "";
}

/** Content-only flatten backing the preview clamp, tail tooltip, and +N. */
function contentOnlyText(result: CodexWebRunResult): string {
  if (result.pages.length === 0) return result.text ?? "";
  return result.pages.map(pageContentText).filter(Boolean).join("\n\n").trim();
}

/** Self-describing flatten (titles and URLs included) for the copy button. */
function flattenWebRunText(result: CodexWebRunResult): string {
  if (result.pages.length === 0) return result.text ?? "";
  return result.pages
    .map((page) => {
      const header = page.url
        ? `${pageLabel(page)} (${page.url})`
        : pageLabel(page);
      const content = pageContentText(page);
      return content ? `${header}\n${content}` : header;
    })
    .join("\n\n");
}

function pageBadges(page: CodexWebRunPage): string[] {
  const badges: string[] = [];
  if (page.wordLimit !== undefined) badges.push(`wordlim ${page.wordLimit}`);
  if (page.totalLines !== undefined) badges.push(`${page.totalLines} lines`);
  if (page.lines && page.lines.length > 0) {
    const first = page.lines[0]?.n;
    const last = page.lines[page.lines.length - 1]?.n;
    if (first !== undefined && last !== undefined && last > first) {
      badges.push(`L${first}–L${last}`);
    }
  }
  if (page.contentType) badges.push(page.contentType);
  if (page.published) badges.push(`published ${page.published}`);
  return badges;
}

function PageTitleLink({ page }: { page: CodexWebRunPage }) {
  const label = pageLabel(page);
  if (!page.url)
    return (
      <span className={styles.webrunTitle} data-webrun-title>
        {label}
      </span>
    );
  return (
    <a
      href={page.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`${styles.webrunTitle} ${styles.webrunLink}`}
      data-webrun-title
      data-webrun-link
    >
      {label}
    </a>
  );
}

function WebRunPageView({
  page,
  collapsible = true,
}: {
  page: CodexWebRunPage;
  collapsible?: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const lines = page.lines ?? [];
  const needsCollapse = collapsible && lines.length > MAX_PAGE_LINES;
  const displayLines =
    needsCollapse && !isExpanded ? lines.slice(0, MAX_PAGE_LINES) : lines;
  const contentText =
    lines.length > 0
      ? displayLines
          .map((line) => line.text)
          .join("\n")
          .replace(/\n{3,}/g, "\n\n")
      : (page.text ?? "");

  return (
    <div className={styles.webrunPage} data-webrun-page>
      <div className={styles.webrunPageHeader} data-webrun-page-header>
        <PageTitleLink page={page} />
        {pageBadges(page).map((badge) => (
          <Badge key={badge} size="small">
            {badge}
          </Badge>
        ))}
        <OutputCopyButton text={pageContentText(page)} label="Copy page text" />
      </div>
      {page.redirectedUrl && (
        <div className={styles.webrunRedirect} data-webrun-redirect>
          → {page.redirectedUrl}
        </div>
      )}
      {contentText && (
        <div className={styles.webrunText} data-webrun-text>
          {contentText}
        </div>
      )}
      {needsCollapse && (
        <Button
          variant="ghost"
          size="small"
          className={expandStyles.expandButton}
          data-expand-button
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {isExpanded ? "Show less" : `Show all ${lines.length} lines`}
        </Button>
      )}
    </div>
  );
}

function WebModalContent({ result }: { result: CodexWebRunResult }) {
  if (result.pages.length === 0) {
    return (
      <div className={styles.webrunText} data-webrun-text>
        {result.text || "No content"}
      </div>
    );
  }
  return (
    <div className={styles.webrunResult} data-webrun-result>
      {result.pages.map((page, index) => (
        <WebRunPageView
          key={`${page.ref ?? page.url ?? index}`}
          page={page}
          collapsible={false}
        />
      ))}
    </div>
  );
}

function WebPreviewPageRow({ page }: { page: CodexWebRunPage }) {
  const host = page.url ? (hostnameOf(page.url) ?? page.url) : page.ref;
  // For a failed open the provider titles the page "Internal Error ()" with
  // the reason as its only content line; surface that reason inline.
  const detail =
    !page.url && page.lines?.[0]?.text
      ? `${page.title} — ${page.lines[0].text}`
      : page.title !== host
        ? page.title
        : "";
  return (
    <div className={styles.webrunPreviewRow} data-webrun-preview-row>
      {page.url ? (
        <a
          href={page.url}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.webrunLink}
          data-webrun-link
        >
          {host}
        </a>
      ) : (
        <span className={styles.webrunLink} data-webrun-link>
          {host}
        </span>
      )}
      {detail && (
        <span className={styles.webrunPreviewTitle} data-webrun-preview-title>
          {detail}
        </span>
      )}
    </div>
  );
}

function WebCollapsedPreview({
  input,
  result,
}: {
  input: WebInput | undefined;
  result: CodexWebRunResult;
}) {
  const outputToolPreviewLineCount = useOutputToolPreviewLineCount();
  const [isModalOpen, setIsModalOpen] = useState(false);

  const contentText = useMemo(() => contentOnlyText(result), [result]);
  const copyText = useMemo(() => flattenWebRunText(result), [result]);
  const { text: previewText, truncated } = truncateOutput(
    contentText,
    getPreviewLimits(outputToolPreviewLineCount),
  );
  const hiddenLineCount = getHiddenOutputLineCount(
    contentText,
    outputToolPreviewLineCount,
  );
  const outputTailTooltip = getOutputTailTooltip(
    contentText,
    outputToolPreviewLineCount,
  );
  const outputTooltipAttributes = useVisibilityAwareTextTooltip<HTMLDivElement>(
    contentText,
    outputTailTooltip,
    "[data-webrun-preview-output-text]",
  );

  const visiblePages = result.pages.slice(0, MAX_PREVIEW_PAGES);
  const omittedPages = result.pages.slice(MAX_PREVIEW_PAGES);
  const omittedTooltip = omittedPages
    .slice(0, MAX_TOOLTIP_PAGES)
    .map((page) => {
      const host = page.url ? (hostnameOf(page.url) ?? page.url) : page.ref;
      const label = pageLabel(page);
      return label && label !== host ? `${host} — ${label}` : `${host}`;
    })
    .join("\n");
  const omittedTooltipAttributes = useTextTooltipAttributes(omittedTooltip);

  const handleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element | null;
    if (target?.closest?.("button,a")) {
      return;
    }
    if (selectionIntersectsElement(event.currentTarget)) {
      return;
    }
    setIsModalOpen(true);
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) {
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setIsModalOpen(true);
      }
    },
    [],
  );

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-label="View web page content"
        className={styles.webrunCollapsedPreview}
        data-webrun-collapsed-preview
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      >
        {visiblePages.map((page, index) => (
          <WebPreviewPageRow
            key={`${page.ref ?? page.url ?? index}`}
            page={page}
          />
        ))}
        {omittedPages.length > 0 && (
          <div
            className={`${styles.webrunPreviewRow} ${styles.webrunPreviewMore}`}
            data-webrun-preview-row
            data-webrun-preview-more
            {...omittedTooltipAttributes}
          >
            +{omittedPages.length} more
          </div>
        )}
        {previewText && (
          <div
            className={`${styles.webrunPreviewRow} ${styles.webrunPreviewOutputRow}`}
            data-webrun-preview-row
            data-webrun-preview-output-row
          >
            <div
              className={styles.webrunPreviewOutput}
              data-webrun-preview-output
              {...outputTooltipAttributes}
            >
              <div
                className={styles.webrunPreviewOutputText}
                data-webrun-preview-output-text
                style={
                  {
                    "--webrun-preview-line-count": String(
                      outputToolPreviewLineCount,
                    ),
                  } as CSSProperties
                }
              >
                {previewText}
              </div>
              {truncated && (
                <div
                  className={styles.webrunPreviewFade}
                  data-webrun-preview-fade
                />
              )}
            </div>
            <OutputCopyButton text={copyText} label="Copy page text" />
            {hiddenLineCount > 0 && (
              <HiddenContentBadge
                className={styles.webrunPreviewMoreBadge}
                data-webrun-preview-more-badge
                count={hiddenLineCount}
                tooltip={outputTailTooltip ?? contentText}
              />
            )}
          </div>
        )}
      </div>
      {isModalOpen && (
        <ActivityDetailModal
          title={describeOps(input) || "Web"}
          label={describeOps(input) || "Web"}
          onClose={() => setIsModalOpen(false)}
        >
          <WebModalContent result={result} />
        </ActivityDetailModal>
      )}
    </>
  );
}

function WebToolResult({
  result,
  isError,
}: {
  result: WebResult;
  isError: boolean;
}) {
  if (isError) {
    return (
      <div className={styles.webrunError} data-webrun-error>
        {typeof result === "string" ? result : "Web browse failed"}
      </div>
    );
  }
  if (isWebRunResult(result)) {
    if (result.pages.length === 0) {
      return (
        <div className={styles.webrunText} data-webrun-text>
          {result.text || "No content"}
        </div>
      );
    }
    return (
      <div className={styles.webrunResult} data-webrun-result>
        {result.pages.map((page, index) => (
          <WebRunPageView
            key={`${page.ref ?? page.url ?? index}`}
            page={page}
          />
        ))}
      </div>
    );
  }
  if (typeof result === "string" && result) {
    return (
      <div className={styles.webrunText} data-webrun-text>
        {result}
      </div>
    );
  }
  return (
    <div className={styles.webrunText} data-webrun-text>
      No content
    </div>
  );
}

export const webRenderer = defineTool(toolDisplayContracts.Web, {
  tool: "Web",
  displayName: "Web",
  pendingDisplayName: "Browsing",

  renderToolUse(input, _context) {
    const summary = describeOps(input);
    return (
      <div className={styles.webrunToolUse} data-webrun-tool-use>
        {summary || "web.run"}
      </div>
    );
  },

  renderToolResult(result, isError, _context) {
    return <WebToolResult result={result} isError={isError} />;
  },

  renderCollapsedPreview(input, result, isError, _context) {
    if (isError || !isWebRunResult(result) || result.pages.length === 0) {
      return null;
    }
    return <WebCollapsedPreview input={input} result={result} />;
  },

  getUseSummary(input) {
    return describeOps(input) || "web.run";
  },

  getResultSummary(result, isError, input) {
    if (isError) return "failed";
    if (!isWebRunResult(result)) return "done";
    const duration = formatSeconds(result.durationSeconds);
    const pages = result.pages;
    if (pages.length === 0) {
      return duration ?? "done";
    }
    if (pages.length === 1 && pages[0]) {
      const page = pages[0];
      return [
        duration,
        page.wordLimit !== undefined ? `wordlim ${page.wordLimit}` : undefined,
        page.totalLines !== undefined ? `${page.totalLines} lines` : undefined,
        hostnameOf(page.url),
      ]
        .filter(Boolean)
        .join(" · ");
    }
    const isSearch =
      pages.every((page) => !page.lines) &&
      (input?.search_query?.length ?? 0) > 0;
    const noun = isSearch ? "results" : "pages";
    return [duration, `${pages.length} ${noun}`].filter(Boolean).join(" · ");
  },
});
