import { type ReactNode, useEffect, useRef } from "react";
import { useI18n } from "../i18n";
import styles from "./ProjectFileCompletionMenu.module.css";
import { Badge } from "./ui/Badge";

/** What a path completion source exposes to its sheet. */
export interface PathCompletionMenuModel<Entry extends { path: string }> {
  visible: boolean;
  entries: readonly Entry[];
  selected?: string;
  select?: (entry: Entry) => void;
  accept: (entry: Entry) => void;
  pending?: boolean;
  truncated: boolean;
  error?: string;
}

type Span = readonly [number, number];

const kindBadge = (entry: { path: string; kind?: string }) =>
  entry.kind === "directory" ? "dir" : "file";

/** `text` (starting at `offset` in the whole path) with matched spans marked. */
function highlighted(text: string, offset: number, spans: readonly Span[]) {
  const pieces: ReactNode[] = [];
  let cursor = 0;
  for (const [spanStart, spanEnd] of spans) {
    const start = Math.max(spanStart - offset, cursor);
    const end = Math.min(spanEnd - offset, text.length);
    if (end <= start) continue;
    if (start > cursor) pieces.push(text.slice(cursor, start));
    pieces.push(
      <mark key={start} className={styles.match}>
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  }
  if (cursor < text.length) pieces.push(text.slice(cursor));
  return pieces;
}

/**
 * The composer's path completion sheet, shared by `@` (insert a path) and
 * `/v` (open a file). It floats above the composer; optional props add the
 * `/v` finder parts: groups, matched spans, per-row actions, a preview of the
 * highlighted row, and a footer action. See `topics/view-command.md`.
 */
export function ProjectFileCompletionMenu<
  Entry extends { path: string; kind?: string },
>({
  completion,
  badge = kindBadge,
  spans,
  group,
  rowAction,
  preview,
  footer,
  emptyLabel,
}: {
  completion: PathCompletionMenuModel<Entry>;
  /** The short trailing label for a row; `dir`/`file` by default. */
  badge?: (entry: Entry) => string;
  /** Matched `[start, end)` offsets into the row's path, to highlight. */
  spans?: (entry: Entry) => readonly Span[] | undefined;
  /** Section heading for a row; consecutive rows sharing one are grouped. */
  group?: (entry: Entry) => string;
  /** A control beside the row (never inside its option button). */
  rowAction?: (entry: Entry) => ReactNode;
  /** Shown beside the list on wide screens, under it on narrow ones. */
  preview?: ReactNode;
  footer?: ReactNode;
  /** Status text when the settled result is empty. */
  emptyLabel?: string;
}) {
  const { t } = useI18n();
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!completion.selected) return;
    menu.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [completion.selected]);
  if (!completion.visible) return null;

  const sections: { label?: string; entries: Entry[] }[] = [];
  for (const entry of completion.entries) {
    const label = group?.(entry);
    const last = sections.at(-1);
    if (last && last.label === label) last.entries.push(entry);
    else sections.push({ label, entries: [entry] });
  }

  const row = (entry: Entry) => {
    const path = entry.path.replace(/\/$/, "");
    const slash = path.lastIndexOf("/");
    const parent = slash >= 0 ? path.slice(0, slash + 1) : "";
    const basename = path.slice(slash + 1);
    const matched = spans?.(entry) ?? [];
    const label = badge(entry);
    return (
      <div key={entry.path} className={styles.rowWrap}>
        <button
          type="button"
          role="option"
          aria-selected={entry.path === completion.selected}
          className={styles.row}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => completion.select?.(entry)}
          onClick={() => completion.accept(entry)}
        >
          <span className={styles.basename}>
            {highlighted(basename, slash + 1, matched)}
          </span>
          <span className={styles.parent}>
            {highlighted(parent, 0, matched)}
          </span>
          {label && (
            <Badge size="small" className={styles.kind}>
              {label}
            </Badge>
          )}
        </button>
        {rowAction?.(entry)}
      </div>
    );
  };

  return (
    <div className={styles.sheet} data-preview={preview ? "" : undefined}>
      <div
        ref={menu}
        className={styles.menu}
        role="listbox"
        aria-label={t("fileCompletionLabel")}
      >
        {sections.map((section, index) =>
          section.label ? (
            <div
              key={`${section.label}-${index}`}
              role="group"
              aria-label={section.label}
            >
              <div className={styles.groupLabel} aria-hidden="true">
                {section.label}
              </div>
              {section.entries.map(row)}
            </div>
          ) : (
            section.entries.map(row)
          ),
        )}
        {(completion.pending ||
          completion.error ||
          completion.entries.length === 0 ||
          completion.truncated) && (
          <div className={styles.status} role="status">
            {completion.error
              ? t("fileCompletionUnavailable")
              : completion.pending
                ? t("fileCompletionSearching")
                : completion.truncated
                  ? t("fileCompletionMore")
                  : (emptyLabel ?? t("fileCompletionEmpty"))}
          </div>
        )}
        {footer}
      </div>
      {preview && <div className={styles.preview}>{preview}</div>}
    </div>
  );
}
