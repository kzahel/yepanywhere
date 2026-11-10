import { type HTMLAttributes, useMemo } from "react";
import { useInnerHtml } from "../hooks/useInnerHtml";
import { prepareShikiHtml } from "../lib/shikiHtml";
import styles from "./ShikiHtml.module.css";

type ShikiHtmlProps = {
  html: string;
  /** The highlighted source text, to carry exact source offsets into the DOM. */
  source?: string;
  className?: string;
} & Omit<
  HTMLAttributes<HTMLDivElement>,
  "children" | "className" | "dangerouslySetInnerHTML"
>;

/**
 * Render server-highlighted Shiki HTML.
 *
 * Owning the newline compaction and the block-per-line layout together keeps
 * them from drifting apart: the compaction deletes the only text separating
 * two lines, and this container's styles are what put them back on separate
 * rows. `prepareShikiHtml` is the only compactor, and its output is meant for
 * this component alone. Callers add their own class for surface-specific
 * treatment, and may pass handlers for links inside the markup.
 */
export function ShikiHtml({
  html,
  source,
  className,
  ...containerProps
}: ShikiHtmlProps) {
  const prepared = useMemo(
    () => prepareShikiHtml(html, source),
    [html, source],
  );
  const innerHtml = useInnerHtml(prepared);
  return (
    <div
      {...containerProps}
      className={`${styles.container}${className ? ` ${className}` : ""}`}
      data-shiki-container
      // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
      dangerouslySetInnerHTML={innerHtml}
    />
  );
}
