import diffStyles from "../components/renderers/DiffOutput.module.css";
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

interface HunkLayout {
  tall: boolean;
  groups: ScrollGroup[];
  /**
   * Rows whose trailing cell yields width to a run control: the run's own
   * rows, plus any following rows a control taller than its run overlaps.
   */
  reserved: number[];
}

interface MeasuredRow {
  height: number;
  /** Natural content width per populated column. */
  natural: (number | null)[];
  /** Cell width with no control reservation. */
  full: (number | null)[];
}

/**
 * Splits a tall hunk into fixed rows and long-line runs. Long rows are judged
 * against the full width so a control never makes a fitting row scroll; only
 * rows a control overlaps lose its width, and an overlapped row that then
 * overflows joins the run.
 */
function runLayout(
  measured: MeasuredRow[],
  reservePx: number,
  controlHeight: number,
): Omit<HunkLayout, "tall"> {
  const last = (measured[0]?.natural.length ?? 1) - 1;
  const overflows = (row: MeasuredRow, reserved: boolean) =>
    row.natural.some(
      (natural, column) =>
        natural !== null &&
        natural >
          (row.full[column] ?? 0) -
            (reserved && column === last ? reservePx : 0) +
            0.5,
    );
  const runs: { start: number; end: number; reserveEnd: number }[] = [];
  let index = 0;
  while (index < measured.length) {
    if (!overflows(measured[index]!, false)) {
      index++;
      continue;
    }
    const start = index;
    let end = index + 1;
    let reserveEnd = end;
    for (;;) {
      while (end < measured.length && overflows(measured[end]!, false)) end++;
      let covered = measured
        .slice(start, end)
        .reduce((sum, row) => sum - row.height, controlHeight);
      reserveEnd = end;
      while (covered > 0.5 && reserveEnd < measured.length) {
        if (overflows(measured[reserveEnd]!, true)) break;
        covered -= measured[reserveEnd]!.height;
        reserveEnd++;
      }
      if (covered > 0.5 && reserveEnd < measured.length) {
        end = reserveEnd + 1;
        continue;
      }
      break;
    }
    runs.push({ start, end, reserveEnd });
    index = reserveEnd;
  }

  const groups: ScrollGroup[] = [];
  const reserved: number[] = [];
  const widthOf = (rows: MeasuredRow[]) =>
    Math.max(0, ...rows.flatMap((row) => row.natural.map((w) => w ?? 0)));
  const pushFixed = (start: number, end: number) => {
    if (end > start) {
      groups.push({
        start,
        end,
        width: widthOf(measured.slice(start, end)),
        overflow: 0,
      });
    }
  };
  let cursor = 0;
  for (const run of runs) {
    pushFixed(cursor, run.start);
    const rows = measured.slice(run.start, run.end);
    const overflow = Math.max(
      0,
      ...rows.flatMap((row) =>
        row.natural.map((natural, column) =>
          natural === null
            ? 0
            : natural -
              ((row.full[column] ?? 0) - (column === last ? reservePx : 0)),
        ),
      ),
    );
    groups.push({
      start: run.start,
      end: run.end,
      width: widthOf(rows),
      overflow: Math.ceil(overflow),
    });
    for (let row = run.start; row < run.reserveEnd; row++) reserved.push(row);
    cursor = run.end;
  }
  pushFixed(cursor, measured.length);
  return { groups, reserved };
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
  const [layout, setLayout] = useState<HunkLayout>({
    tall: false,
    groups: [{ start: 0, end: rows.length, width: 0, overflow: 0 }],
    reserved: [],
  });
  const reservedRef = useRef(layout.reserved);
  reservedRef.current = layout.reserved;

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
      // Settle the scroll mode first; run membership is then measured against
      // full widths, so reserving control space cannot change it.
      if (tall !== layout.tall) {
        setLayout((previous) => ({ ...previous, tall, reserved: [] }));
        return;
      }
      const reservedNow = new Set(reservedRef.current);
      const probe = root.querySelector<HTMLElement>(
        "[data-diff-control-probe]",
      );
      const reservePx = probe?.offsetWidth ?? 0;
      const range = document.createRange();
      const measured: MeasuredRow[] = elements.map((row, index) => {
        const cells = rows[index]!;
        const natural: (number | null)[] = [];
        const full: (number | null)[] = [];
        for (const [column, html] of cells.entries()) {
          const cell = row.children[column] as HTMLElement;
          const line = cell?.querySelector<HTMLElement>("[data-diff-line]");
          if (html === null || !line) {
            natural.push(null);
            full.push(null);
            continue;
          }
          range.selectNodeContents(line);
          const css = getComputedStyle(line);
          natural.push(
            Math.ceil(
              range.getBoundingClientRect().width +
                Number.parseFloat(css.paddingLeft || "0") +
                Number.parseFloat(css.paddingRight || "0"),
            ),
          );
          full.push(
            cell.clientWidth +
              (reservedNow.has(index) && column === cells.length - 1
                ? reservePx
                : 0),
          );
        }
        return { height: row.getBoundingClientRect().height, natural, full };
      });
      let next: Omit<HunkLayout, "tall">;
      if (tall) {
        next = runLayout(measured, reservePx, probe?.offsetHeight ?? 0);
      } else {
        let width = 0;
        let overflow = 0;
        for (const row of measured) {
          for (const [column, natural] of row.natural.entries()) {
            if (natural === null) continue;
            width = Math.max(width, natural);
            overflow = Math.max(overflow, natural - (row.full[column] ?? 0));
          }
        }
        next = {
          groups: [{ start: 0, end: rows.length, width, overflow }],
          reserved: [],
        };
      }
      setLayout((previous) =>
        previous.tall === tall &&
        JSON.stringify(previous.groups) === JSON.stringify(next.groups) &&
        JSON.stringify(previous.reserved) === JSON.stringify(next.reserved)
          ? previous
          : { tall, ...next },
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
  const reserved = new Set(layout.tall ? layout.reserved : []);
  return (
    <div
      ref={rootRef}
      className={`${styles.hunk} ${layout.tall ? styles.tall : ""}`}
      data-diff-hunk=""
      data-diff-scroll-mode={layout.tall ? "runs" : "hunk"}
    >
      {layout.tall && (
        <div className={styles.controlProbe} data-diff-control-probe="" />
      )}
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
          reserved={rows
            .slice(group.start, group.end)
            .map((_, index) => reserved.has(group.start + index))}
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
  reserved,
  paired,
  tall,
  header,
  label,
}: {
  group: ScrollGroup;
  rows: (string | null)[][];
  reserved: boolean[];
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
      {tall && control && <div className={styles.rail}>{control}</div>}
      <div className={styles.rows}>
        {rows.map((cells, index) => (
          <div
            key={group.start + index}
            className={`${styles.row} ${paired ? styles.paired : ""} ${reserved[index] ? styles.reserved : ""}`}
            data-diff-scroll-row=""
            data-diff-reserved={reserved[index] ? "" : undefined}
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
                  className={`${styles.content} ${diffStyles.highlightedDiff}`}
                  data-highlighted-diff
                  trustedHtml={`<pre class="shiki"><code>${html ?? '<span class="line"> </span>'}</code></pre>`}
                />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
