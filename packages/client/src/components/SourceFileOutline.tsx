import {
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { TranslationFn } from "../i18n";
import { suppressSourceKeyboardTooltips } from "../hooks/useSourceKeyboard";
import styles from "./SourceFileOutline.module.css";
import { SourceFileStatusBadge } from "./SourceFileRow";
import { Badge } from "./ui/Badge";
import { ButtonBase } from "./ui/Button";

const FALLBACK_VISIBLE_ROWS = 14;
const ESTIMATED_ROW_HEIGHT = 29;

export interface SourceOutlineItem<T> {
  id: string;
  path: string;
  displayPath: string;
  statuses?: string[];
  value: T;
}

export interface SourceOutlinePathProps {
  "data-source-outline-id": string;
  "data-source-outline-path": string;
}

export interface SourceOutlineDirectory {
  path: string;
  pending: boolean;
  truncated: boolean;
}

const EMPTY_OUTLINE_DIRECTORIES: readonly SourceOutlineDirectory[] = [];

type SourceOutlineEntry<T> =
  | {
      kind: "file";
      item: SourceOutlineItem<T>;
      visiblePath: string;
      pathProps: SourceOutlinePathProps;
    }
  | {
      kind: "group";
      key: string;
      path: string;
      items: SourceOutlineItem<T>[];
      children: SourceOutlineEntry<T>[];
      statuses: string[];
      count: number;
      directory?: SourceOutlineDirectory;
    };

interface PathNode<T> {
  files: T[];
  directories: Map<string, PathNode<T>>;
  directory?: SourceOutlineDirectory;
}

/** Files in the same depth-first order used by the rendered outline. */
export function sourceOutlineDisplayOrder<T extends { path: string }>(
  items: readonly T[],
): T[] {
  return collectItems(buildPathTree(items, EMPTY_OUTLINE_DIRECTORIES));
}

export function SourceFileSectionDivider({
  children,
  expanded,
  onToggle,
}: {
  children: ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  if (onToggle) {
    return (
      <ButtonBase
        className={`${styles.sectionDivider} ${styles.sectionDividerButton}`}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className={styles.sectionDisclosure} aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        <span>{children}</span>
      </ButtonBase>
    );
  }
  return (
    <div className={styles.sectionDivider}>
      <span>{children}</span>
    </div>
  );
}

/**
 * Shared path-compression outline for every Source Control file corpus. Paths
 * are grouped only after the caller has filtered and semantically partitioned
 * its files. The complete display path stays attached to each rendered row.
 */
export function SourceFileOutline<T>({
  items,
  directories = EMPTY_OUTLINE_DIRECTORIES,
  expandedDirectories,
  onToggleDirectory,
  scopeKey,
  query,
  className,
  activeItemId,
  focusRequest = 0,
  toggleAllOnEnter = false,
  renderFile,
  t,
  onKeyDown: onListKeyDown,
  ...listProps
}: Omit<HTMLAttributes<HTMLUListElement>, "children"> & {
  items: SourceOutlineItem<T>[];
  directories?: readonly SourceOutlineDirectory[];
  expandedDirectories?: ReadonlySet<string>;
  onToggleDirectory?: (path: string, expanded: boolean) => void;
  scopeKey: string;
  query?: string;
  activeItemId?: string | null;
  focusRequest?: number;
  toggleAllOnEnter?: boolean;
  renderFile: (
    item: SourceOutlineItem<T>,
    visiblePath: string,
    pathProps: SourceOutlinePathProps,
  ) => ReactNode;
  t: TranslationFn;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const handledFocusRequest = useRef(0);
  const pendingFocusItem = useRef<string | null>(null);
  const automaticExpansion = useRef(new Map<string, boolean>());
  const [explicitExpansion, setExplicitExpansion] = useState<
    Record<string, boolean>
  >({});
  const [availableRows, setAvailableRows] = useState(FALLBACK_VISIBLE_ROWS);
  const searching = (query?.trim().length ?? 0) > 0;
  const entries = useMemo(
    () =>
      searching
        ? items.map(
            (item): SourceOutlineEntry<T> => ({
              kind: "file",
              item,
              visiblePath: item.displayPath,
              pathProps: outlinePathProps(item),
            }),
          )
        : buildSourceOutline(items, directories, scopeKey),
    [directories, items, scopeKey, searching],
  );

  useLayoutEffect(() => {
    automaticExpansion.current.clear();
    setExplicitExpansion({});
  }, []);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const viewport = findScrollViewport(list);
    const measureHeight = () => {
      const height = viewport?.clientHeight ?? list.clientHeight;
      if (height > 0) {
        setAvailableRows(
          Math.max(1, Math.floor(height / ESTIMATED_ROW_HEIGHT)),
        );
      }
    };
    measureHeight();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureHeight);
    observer.observe(viewport ?? list);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const groups = collectGroups(entries).filter((group) => !group.directory);
    if (groups.length === 0) return;
    const list = listRef.current;
    const measuredHeight = list
      ? (findScrollViewport(list)?.clientHeight ?? list.clientHeight)
      : 0;
    const rowBudget =
      measuredHeight > 0
        ? Math.max(1, Math.floor(measuredHeight / ESTIMATED_ROW_HEIGHT))
        : availableRows;
    let remainingRows = Math.max(0, rowBudget - entries.length);
    let changed = false;
    for (const group of groups) {
      if (automaticExpansion.current.has(group.key)) continue;
      const childRows = group.children.length;
      const expanded = childRows <= remainingRows;
      automaticExpansion.current.set(group.key, expanded);
      if (expanded) remainingRows -= childRows;
      changed = true;
    }
    if (changed) setExplicitExpansion((current) => ({ ...current }));
  }, [availableRows, entries]);

  useLayoutEffect(() => {
    if (
      focusRequest <= handledFocusRequest.current ||
      activeItemId === null ||
      activeItemId === undefined ||
      !items.some((item) => item.id === activeItemId)
    ) {
      return;
    }
    handledFocusRequest.current = focusRequest;
    pendingFocusItem.current = activeItemId;
    const containingGroups = collectGroups(entries).filter(
      (group) =>
        !group.directory &&
        group.items.some((item) => item.id === activeItemId),
    );
    if (containingGroups.length === 0) return;
    setExplicitExpansion((current) => ({
      ...current,
      ...Object.fromEntries(containingGroups.map((group) => [group.key, true])),
    }));
  }, [activeItemId, entries, focusRequest, items]);

  useLayoutEffect(() => {
    const itemId = pendingFocusItem.current;
    const list = listRef.current;
    if (!itemId || !list) return;
    const path = Array.from(
      list.querySelectorAll<HTMLElement>("[data-source-outline-id]"),
    ).find((candidate) => candidate.dataset.sourceOutlineId === itemId);
    const row = path?.closest<HTMLElement>("[data-source-list-item]");
    if (!row) return;
    pendingFocusItem.current = null;
    row.focus({ preventScroll: true });
    revealRowWithinViewport(row, findScrollViewport(list));
  });

  const handleKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (
      toggleAllOnEnter &&
      event.key === "Enter" &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      event.target instanceof HTMLElement &&
      event.target.closest("[data-source-list-item]")
    ) {
      event.preventDefault();
      suppressSourceKeyboardTooltips();
      if (event.repeat) return;
      const groups = collectGroups(entries).filter((group) => !group.directory);
      const expandAll = groups.some(
        (group) =>
          !(
            explicitExpansion[group.key] ??
            automaticExpansion.current.get(group.key) ??
            false
          ),
      );
      if (groups.length > 0) {
        setExplicitExpansion((current) => ({
          ...current,
          ...Object.fromEntries(
            groups.map((group) => [
              group.key,
              expandAll || group.items.some((item) => item.id === activeItemId),
            ]),
          ),
        }));
      }
      return;
    }
    onListKeyDown?.(event);
  };

  return (
    <ul
      {...listProps}
      ref={listRef}
      className={[styles.outline, className].filter(Boolean).join(" ")}
      onKeyDown={handleKeyDown}
    >
      {renderEntries(
        entries,
        explicitExpansion,
        automaticExpansion.current,
        (key, expanded) =>
          setExplicitExpansion((current) => ({
            ...current,
            [key]: !expanded,
          })),
        expandedDirectories,
        onToggleDirectory,
        renderFile,
        t,
      )}
    </ul>
  );
}

function buildSourceOutline<T>(
  items: SourceOutlineItem<T>[],
  directories: readonly SourceOutlineDirectory[],
  scopeKey: string,
): SourceOutlineEntry<T>[] {
  return emitNode(buildPathTree(items, directories), "", scopeKey);
}

function buildPathTree<T extends { path: string }>(
  items: readonly T[],
  directories: readonly SourceOutlineDirectory[],
): PathNode<T> {
  const root: PathNode<T> = { files: [], directories: new Map() };
  for (const item of items) {
    const segments = item.path.split("/").filter(Boolean);
    if (segments.length <= 1) {
      root.files.push(item);
      continue;
    }
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let child = node.directories.get(segment);
      if (!child) {
        child = { files: [], directories: new Map() };
        node.directories.set(segment, child);
      }
      node = child;
    }
    node.files.push(item);
  }
  for (const directory of directories) {
    const segments = directory.path.split("/").filter(Boolean);
    if (segments.length === 0) continue;
    let node = root;
    for (const segment of segments) {
      let child = node.directories.get(segment);
      if (!child) {
        child = { files: [], directories: new Map() };
        node.directories.set(segment, child);
      }
      node = child;
    }
    node.directory = directory;
  }
  return root;
}

function emitNode<T>(
  node: PathNode<SourceOutlineItem<T>>,
  prefix: string,
  scopeKey: string,
): SourceOutlineEntry<T>[] {
  const entries: SourceOutlineEntry<T>[] = node.files.map((item) => ({
    kind: "file",
    item,
    visiblePath: relativeDisplayPath(item, prefix),
    pathProps: outlinePathProps(item),
  }));
  for (const [segment, initialChild] of node.directories) {
    let child = initialChild;
    let groupPath = `${prefix}${segment}/`;
    while (
      !child.directory &&
      child.files.length === 0 &&
      child.directories.size === 1
    ) {
      const next = child.directories.entries().next().value as
        | [string, PathNode<SourceOutlineItem<T>>]
        | undefined;
      if (!next) break;
      groupPath += `${next[0]}/`;
      child = next[1];
    }
    const descendants = collectItems(child);
    entries.push({
      kind: "group",
      key: `${scopeKey}\0${groupPath}`,
      path: groupPath,
      items: descendants,
      children: emitNode(child, groupPath, scopeKey),
      statuses: collectStatuses(descendants),
      count: child.directory ? child.files.length : descendants.length,
      ...(child.directory ? { directory: child.directory } : {}),
    });
  }
  return entries;
}

function outlinePathProps<T>(
  item: SourceOutlineItem<T>,
): SourceOutlinePathProps {
  return {
    "data-source-outline-id": item.id,
    "data-source-outline-path": item.displayPath,
  };
}

function relativeDisplayPath<T>(item: SourceOutlineItem<T>, prefix: string) {
  if (!prefix) return item.displayPath;
  return item.displayPath
    .split(" → ")
    .map((part) => (part.startsWith(prefix) ? part.slice(prefix.length) : part))
    .join(" → ");
}

function collectItems<T>(node: PathNode<T>): T[] {
  return [
    ...node.files,
    ...Array.from(node.directories.values()).flatMap(collectItems),
  ];
}

function collectStatuses<T>(items: SourceOutlineItem<T>[]) {
  const statuses: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    for (const status of item.statuses ?? []) {
      if (!seen.has(status)) {
        seen.add(status);
        statuses.push(status);
      }
    }
  }
  return statuses;
}

function collectGroups<T>(
  entries: SourceOutlineEntry<T>[],
): Array<Extract<SourceOutlineEntry<T>, { kind: "group" }>> {
  return entries.flatMap((entry) =>
    entry.kind === "group" ? [entry, ...collectGroups(entry.children)] : [],
  );
}

function renderEntries<T>(
  entries: SourceOutlineEntry<T>[],
  explicitExpansion: Record<string, boolean>,
  automaticExpansion: ReadonlyMap<string, boolean>,
  toggle: (key: string, expanded: boolean) => void,
  expandedDirectories: ReadonlySet<string> | undefined,
  onToggleDirectory: ((path: string, expanded: boolean) => void) | undefined,
  renderFile: (
    item: SourceOutlineItem<T>,
    visiblePath: string,
    pathProps: SourceOutlinePathProps,
  ) => ReactNode,
  t: TranslationFn,
): ReactNode[] {
  return entries.map((entry) => {
    if (entry.kind === "file") {
      return renderFile(entry.item, entry.visiblePath, entry.pathProps);
    }
    const controlled = Boolean(
      entry.directory && expandedDirectories && onToggleDirectory,
    );
    const expanded =
      controlled && entry.directory
        ? expandedDirectories?.has(entry.directory.path) === true
        : (explicitExpansion[entry.key] ??
          automaticExpansion.get(entry.key) ??
          false);
    const loading = entry.directory?.pending === true && expanded;
    const label = entry.directory
      ? t(
          loading
            ? "sourceLoadingUntrackedFolder"
            : expanded
              ? "sourceCollapseDirectory"
              : "sourceExpandDirectory",
          { path: entry.path },
        )
      : t(expanded ? "sourceCollapsePathGroup" : "sourceExpandPathGroup", {
          path: entry.path,
          count: entry.count,
        });
    return (
      <li key={entry.key} className={styles.group}>
        <ButtonBase
          className={styles.groupButton}
          data-source-list-item
          aria-expanded={expanded}
          aria-label={label}
          title={label}
          onClick={() => {
            if (controlled && entry.directory && onToggleDirectory) {
              onToggleDirectory(entry.directory.path, !expanded);
            } else {
              toggle(entry.key, expanded);
            }
          }}
        >
          <span className={styles.disclosure} aria-hidden="true">
            {loading ? "…" : expanded ? "▾" : "▸"}
          </span>
          <span className={styles.groupLabel}>{entry.path}</span>
          {entry.statuses.length > 0 && (
            <span className={styles.groupStatuses}>
              {entry.statuses.map((status) => (
                <SourceFileStatusBadge key={status} status={status} t={t} />
              ))}
            </span>
          )}
          {!entry.directory?.pending && (
            <SourceFolderCount
              className={styles.groupCount}
              count={entry.count}
              truncated={entry.directory?.truncated}
              t={t}
            />
          )}
        </ButtonBase>
        {expanded && entry.children.length > 0 && (
          <ul className={styles.children}>
            {renderEntries(
              entry.children,
              explicitExpansion,
              automaticExpansion,
              toggle,
              expandedDirectories,
              onToggleDirectory,
              renderFile,
              t,
            )}
          </ul>
        )}
      </li>
    );
  });
}

/** A folder's file count; `+` and a tooltip when its listing was cut. */
export function SourceFolderCount({
  count,
  truncated,
  className,
  t,
}: {
  count: number | undefined;
  truncated?: boolean;
  className?: string;
  t: TranslationFn;
}) {
  if (count === undefined) return null;
  return (
    <Badge
      shape="count"
      size="small"
      className={className}
      tooltip={
        truncated ? t("sourceUntrackedFolderTruncated", { count }) : undefined
      }
    >
      {count}
      {truncated ? "+" : ""}
    </Badge>
  );
}

function findScrollViewport(element: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = element;
  while (current) {
    const overflowY = getComputedStyle(current).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return current;
    current = current.parentElement;
  }
  return element.parentElement;
}

function revealRowWithinViewport(
  row: HTMLElement,
  viewport: HTMLElement | null,
) {
  if (!viewport) return;
  const rowBounds = row.getBoundingClientRect();
  const viewportBounds = viewport.getBoundingClientRect();
  if (rowBounds.top < viewportBounds.top) {
    viewport.scrollTop -= viewportBounds.top - rowBounds.top;
  } else if (rowBounds.bottom > viewportBounds.bottom) {
    viewport.scrollTop += rowBounds.bottom - viewportBounds.bottom;
  }
}
