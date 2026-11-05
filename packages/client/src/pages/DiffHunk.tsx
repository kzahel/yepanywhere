import { type CSSProperties, useLayoutEffect, useRef, useState } from "react";
import { InnerHtml } from "../components/ui/InnerHtml";
import { useI18n } from "../i18n";
import { OUTPUT_APPEARANCE_CHANGE_EVENT } from "../hooks/useOutputAppearance";
import styles from "./DiffHunk.module.css";

export type DiffDisplayRow =
  | { type: "header"; text: string }
  | { type: "line"; cells: (string | null)[] };

/** Horizontal scrolling shared by unified and paired diff hunks. */
export function DiffHunks({ rows }: { rows: DiffDisplayRow[] }) {
  const hunks: { header?: string; rows: (string | null)[][] }[] = [];
  for (const row of rows) {
    if (row.type === "header") hunks.push({ header: row.text, rows: [] });
    else {
      if (!hunks.length) hunks.push({ rows: [] });
      hunks[hunks.length - 1]?.rows.push(row.cells);
    }
  }
  return hunks.map((hunk, index) => (
    <DiffHunk key={index} header={hunk.header} rows={hunk.rows} />
  ));
}

interface ScrollGroup {
  start: number;
  end: number;
  width: number;
  overflow: number;
}

function DiffHunk({
  header,
  rows,
}: {
  header?: string;
  rows: (string | null)[][];
}) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<{
    tall: boolean;
    groups: ScrollGroup[];
  }>({
    tall: false,
    groups: [{ start: 0, end: rows.length, width: 0, overflow: 0 }],
  });

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let scrollport = root.parentElement;
    while (
      scrollport &&
      !/auto|scroll/.test(getComputedStyle(scrollport).overflowY)
    ) {
      scrollport = scrollport.parentElement;
    }
    const measure = () => {
      if (root.clientWidth === 0) return;
      const elements = [
        ...root.querySelectorAll<HTMLElement>("[data-diff-scroll-row]"),
      ];
      const height = elements.reduce(
        (sum, row) => sum + row.getBoundingClientRect().height,
        0,
      );
      const headerHeight =
        root.querySelector<HTMLElement>("[data-diff-hunk-header]")
          ?.offsetHeight ?? 0;
      const availableHeight =
        Math.min(
          scrollport?.clientHeight || window.innerHeight,
          window.innerHeight,
        ) -
        (Number.parseFloat(
          getComputedStyle(root).getPropertyValue("--diff-sticky-top"),
        ) || 0);
      const tall = height + headerHeight > availableHeight;
      // Reserve the run controls before measuring overflow; their presence must
      // not change which rows qualify as long on the next observer callback.
      if (tall !== layout.tall) {
        setLayout((previous) => ({ ...previous, tall }));
        return;
      }
      const groups: ScrollGroup[] = [];
      const range = document.createRange();
      elements.forEach((row, index) => {
        let width = 0;
        let overflow = 0;
        for (const [column, html] of rows[index]!.entries()) {
          if (html === null) continue;
          const cell = row.children[column] as HTMLElement;
          const line = cell.querySelector<HTMLElement>("[data-diff-line]");
          if (!line) continue;
          range.selectNodeContents(line);
          const css = getComputedStyle(line);
          const naturalWidth = Math.ceil(
            range.getBoundingClientRect().width +
              Number.parseFloat(css.paddingLeft || "0") +
              Number.parseFloat(css.paddingRight || "0"),
          );
          width = Math.max(width, naturalWidth);
          overflow = Math.max(overflow, naturalWidth - cell.clientWidth);
        }
        overflow = Math.max(0, overflow);
        const previous = groups[groups.length - 1];
        if (previous && (!tall || previous.overflow > 0 === overflow > 0)) {
          previous.end = index + 1;
          previous.width = Math.max(previous.width, width);
          previous.overflow = Math.max(previous.overflow, overflow);
        } else groups.push({ start: index, end: index + 1, width, overflow });
      });
      setLayout((previous) =>
        previous.tall === tall &&
        JSON.stringify(previous.groups) === JSON.stringify(groups)
          ? previous
          : { tall, groups },
      );
    };
    measure();
    let frame = 0;
    const scheduleMeasure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(root);
    if (scrollport) observer.observe(scrollport);
    for (const row of root.querySelectorAll("[data-diff-scroll-row]"))
      observer.observe(row);
    window.addEventListener("resize", scheduleMeasure);
    window.addEventListener(OUTPUT_APPEARANCE_CHANGE_EVENT, scheduleMeasure);
    document.fonts?.addEventListener("loadingdone", scheduleMeasure);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      window.removeEventListener(
        OUTPUT_APPEARANCE_CHANGE_EVENT,
        scheduleMeasure,
      );
      document.fonts?.removeEventListener("loadingdone", scheduleMeasure);
    };
  }, [rows, layout.tall]);

  const groups =
    layout.groups.at(-1)?.end === rows.length
      ? layout.groups
      : [{ start: 0, end: rows.length, width: 0, overflow: 0 }];
  return (
    <div
      ref={rootRef}
      className={`${styles.hunk} ${layout.tall ? styles.tall : ""}`}
      data-diff-hunk=""
      data-diff-scroll-mode={layout.tall ? "runs" : "hunk"}
    >
      {layout.tall && header && (
        <div className={`${styles.header} line-hunk`} data-diff-hunk-header="">
          {header}
        </div>
      )}
      {groups.map((group) => (
        <DiffScrollGroup
          key={group.start}
          group={group}
          rows={rows.slice(group.start, group.end)}
          paired={rows[0]?.length === 2}
          tall={layout.tall}
          header={layout.tall ? undefined : header}
          label={t(layout.tall ? "sourceScrollLines" : "sourceScrollHunk")}
        />
      ))}
    </div>
  );
}

function DiffScrollGroup({
  group,
  rows,
  paired,
  tall,
  header,
  label,
}: {
  group: ScrollGroup;
  rows: (string | null)[][];
  paired: boolean;
  tall: boolean;
  header?: string;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const position = useRef(0);
  const scrollTo = (left: number) => {
    const offset = Math.max(0, Math.min(group.overflow, left));
    position.current = offset;
    for (const cell of ref.current?.querySelectorAll<HTMLElement>(
      "[data-diff-scroll-cell]",
    ) ?? []) {
      if (Math.abs(cell.scrollLeft - offset) > 0.5) cell.scrollLeft = offset;
    }
    if (sliderRef.current) sliderRef.current.value = String(offset);
  };
  useLayoutEffect(() => {
    scrollTo(position.current);
  });
  const control = group.overflow > 0 && (
    <label className={styles.control}>
      <span>{tall ? "↔" : label}</span>
      <input
        ref={sliderRef}
        type="range"
        min={0}
        max={group.overflow}
        defaultValue={0}
        aria-label={label}
        title={label}
        onChange={(event) => scrollTo(Number(event.currentTarget.value))}
      />
    </label>
  );
  return (
    <div
      ref={ref}
      className={styles.group}
      data-diff-scroll-group=""
      style={{ "--diff-scroll-width": `${group.width}px` } as CSSProperties}
    >
      {!tall && (header || control) && (
        <div
          className={`${styles.header} ${header ? "line-hunk" : ""}`}
          data-diff-hunk-header=""
        >
          <span>{header}</span>
          {control}
        </div>
      )}
      <div className={styles.body}>
        <div className={styles.rows}>
          {rows.map((cells, index) => (
            <div
              key={group.start + index}
              className={`${styles.row} ${paired ? styles.paired : ""}`}
              data-diff-scroll-row=""
            >
              {cells.map((html, column) => (
                <div
                  key={column}
                  className={styles.cell}
                  data-diff-scroll-cell=""
                  data-diff-col={
                    paired ? (column === 0 ? "old" : "new") : undefined
                  }
                  tabIndex={group.overflow > 0 ? 0 : undefined}
                  onScroll={(event) => {
                    // Ignore queued scroll events from our own synchronized writes.
                    if (
                      Math.abs(
                        event.currentTarget.scrollLeft - position.current,
                      ) > 0.5
                    )
                      scrollTo(event.currentTarget.scrollLeft);
                  }}
                >
                  <InnerHtml
                    className={`${styles.content} highlighted-diff`}
                    trustedHtml={`<pre class="shiki"><code>${html ?? '<span class="line"> </span>'}</code></pre>`}
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
        {tall && <div className={styles.rail}>{control}</div>}
      </div>
    </div>
  );
}
