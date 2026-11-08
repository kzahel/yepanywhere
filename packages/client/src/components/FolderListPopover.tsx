import type { FolderEntry, FolderListingResponse } from "@yep-anywhere/shared";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { formatFileSize } from "../lib/formatFileSize";
import styles from "./FolderListPopover.module.css";
import { ButtonBase, IconButton } from "./ui/Button";

/** A folder path's parent in the same form, or null at a root we can name. */
export function parentFolderPath(folder: string): string | null {
  if (folder === "" || folder === "/" || folder === "~") return null;
  const trimmed = folder.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  if (slash < 0) return "";
  return slash === 0 ? "/" : trimmed.slice(0, slash);
}

/** A child of `folder`, in the folder's own relative or absolute form. */
export function childPath(folder: string, name: string): string {
  if (folder === "") return name;
  return folder.endsWith("/") ? `${folder}${name}` : `${folder}/${name}`;
}

/** Folders first, then by name. */
export function sortFolderEntries(entries: FolderEntry[]): FolderEntry[] {
  return [...entries].sort(
    (a, b) =>
      Number(b.kind === "folder") - Number(a.kind === "folder") ||
      a.name.localeCompare(b.name),
  );
}

/** Compact age for a listing column: 5m, 23h, 3d, 2mo, 1y. */
function briefAge(modifiedAt: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - modifiedAt) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return days < 365
    ? `${Math.floor(days / 30)}mo`
    : `${Math.floor(days / 365)}y`;
}

function folderLabel(folder: string, rootLabel: string): string {
  if (folder === "") return `${rootLabel}/`;
  const trimmed = folder.replace(/\/+$/, "");
  return trimmed === ""
    ? "/"
    : `${trimmed.slice(trimmed.lastIndexOf("/") + 1)}/`;
}

function Glyph({ folder }: { folder: boolean }) {
  return (
    <svg
      className={styles.glyph}
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path
        d={
          folder
            ? "M1.5 4.5v8h13v-7H7.5l-1.5-2h-4.5z"
            : "M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3"
        }
      />
    </svg>
  );
}

type Listing =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; response: FolderListingResponse };

interface FolderListPopoverProps {
  /** The folder to list first: "" is the project root. */
  folder: string;
  /** Shown for the project root's own name. */
  rootLabel: string;
  /** The open file, in the same form as `folder`'s children. */
  currentPath: string;
  anchor: HTMLElement;
  load: (folder: string) => Promise<FolderListingResponse>;
  /** A file row's URL, so a middle or modified click opens it in a new tab. */
  fileHref: (path: string) => string;
  /** A folder row's URL: its own listing, opened in a new tab. */
  folderHref: (folder: string) => string;
  onOpenFile: (path: string) => void;
  onClose: () => void;
}

/** A plain primary click; anything else is left to the browser's link handling. */
function isPlainClick(event: ReactMouseEvent): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

const ROW_TARGETS = "a[href], button:not(:disabled)";

/**
 * A listing row that is a real link: a plain click acts in place, and the
 * browser keeps middle, modified and context-menu clicks for a new tab.
 */
function RowLink({
  activate,
  children,
  current,
  href,
  label,
}: {
  activate: () => void;
  children: ReactNode;
  current?: boolean;
  href: string;
  label?: string;
}) {
  return (
    <a
      href={href}
      className={styles.row}
      aria-label={label}
      aria-current={current ? "page" : undefined}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        activate();
      }}
      onKeyDown={(event) => {
        if (event.key !== " ") return;
        event.preventDefault();
        activate();
      }}
    >
      {children}
    </a>
  );
}

/**
 * One folder's entries under a path segment: the open file is marked, folders
 * open in place, and ‹ › step through the open file's siblings.
 */
export function FolderListPopover({
  folder: initialFolder,
  rootLabel,
  currentPath,
  anchor,
  load,
  fileHref,
  folderHref,
  onOpenFile,
  onClose,
}: FolderListPopoverProps) {
  const { t } = useI18n();
  const [folder, setFolder] = useState(initialFolder);
  const [listing, setListing] = useState<Listing>({ state: "loading" });
  const [place, setPlace] = useState<{
    left: number;
    top: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const rowsRef = useRef<HTMLUListElement>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let cancelled = false;
    setListing({ state: "loading" });
    loadRef.current(folder).then(
      (response) => {
        if (!cancelled) setListing({ state: "ready", response });
      },
      () => {
        if (!cancelled) setListing({ state: "error" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [folder]);

  useLayoutEffect(() => {
    const measure = () => {
      const rects = anchor.getClientRects();
      const rect = rects[rects.length - 1] ?? anchor.getBoundingClientRect();
      const width = Math.min(360, window.innerWidth - 16);
      const top = rect.bottom + 4;
      setPlace({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top,
        width,
        maxHeight: Math.max(160, Math.min(380, window.innerHeight - top - 8)),
      });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [anchor]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      anchor.focus();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [anchor, onClose]);

  const entries =
    listing.state === "ready"
      ? sortFolderEntries(listing.response.entries)
      : [];
  const currentFolder = parentFolderPath(currentPath) ?? "";
  const siblings =
    folder === currentFolder ? entries.filter((e) => e.kind === "file") : [];
  const index = siblings.findIndex(
    (entry) => childPath(folder, entry.name) === currentPath,
  );
  const previous = index > 0 ? siblings[index - 1] : undefined;
  const next = index >= 0 ? siblings[index + 1] : undefined;
  const parent = parentFolderPath(folder);

  // Open with the current file in view and focused, else the first row; once
  // per loaded listing.
  useLayoutEffect(() => {
    const rows = rowsRef.current;
    if (!rows || listing.state !== "ready") return;
    const current =
      rows.querySelector<HTMLElement>('[aria-current="page"]') ??
      rows.querySelector<HTMLElement>(ROW_TARGETS);
    if (!current) return;
    rows.scrollTop =
      current.offsetTop - rows.clientHeight / 2 + current.offsetHeight / 2;
    current.focus({ preventScroll: true });
  }, [listing]);

  const handleRowsKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const targets = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(ROW_TARGETS),
    ];
    const at = targets.indexOf(document.activeElement as HTMLElement);
    const target = targets[at + (event.key === "ArrowDown" ? 1 : -1)];
    if (!target) return;
    event.preventDefault();
    target.focus();
  };

  const now = Date.now();
  const label = folderLabel(folder, rootLabel);
  return createPortal(
    <>
      <ButtonBase
        className={styles.overlay}
        aria-label={t("fileLinkDismissMenu" as never)}
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div
        className={styles.popover}
        role="dialog"
        aria-label={t("folderListLabel" as never, { path: label })}
        style={place ?? { visibility: "hidden" }}
      >
        <div className={styles.head}>
          <span className={styles.title}>{label}</span>
          <span className={styles.count}>
            {listing.state === "ready"
              ? t(
                  (listing.response.truncated
                    ? "folderListTruncated"
                    : "folderListItems") as never,
                  { count: entries.length },
                )
              : null}
          </span>
          {siblings.length > 0 && index >= 0 ? (
            <span className={styles.stepper}>
              <IconButton
                size="small"
                label={
                  previous
                    ? t("folderListPrevious" as never, { name: previous.name })
                    : t("folderListNoPrevious" as never)
                }
                disabled={!previous}
                onClick={() =>
                  previous && onOpenFile(childPath(folder, previous.name))
                }
              >
                ‹
              </IconButton>
              <IconButton
                size="small"
                label={
                  next
                    ? t("folderListNext" as never, { name: next.name })
                    : t("folderListNoNext" as never)
                }
                disabled={!next}
                onClick={() => next && onOpenFile(childPath(folder, next.name))}
              >
                ›
              </IconButton>
            </span>
          ) : null}
        </div>
        <ul ref={rowsRef} className={styles.rows} onKeyDown={handleRowsKeyDown}>
          {parent !== null ? (
            <li>
              <RowLink
                href={folderHref(parent)}
                label={t("folderListParent" as never)}
                activate={() => setFolder(parent)}
              >
                <Glyph folder />
                <span className={styles.name}>../</span>
              </RowLink>
            </li>
          ) : null}
          {listing.state === "loading" ? (
            <li className={styles.status}>{t("folderListLoading" as never)}</li>
          ) : listing.state === "error" ? (
            <li className={styles.status}>{t("folderListError" as never)}</li>
          ) : entries.length === 0 ? (
            <li className={styles.status}>{t("folderListEmpty" as never)}</li>
          ) : (
            entries.map((entry) => {
              const path = childPath(folder, entry.name);
              const isFolder = entry.kind === "folder";
              const cells = (
                <>
                  <Glyph folder={isFolder} />
                  <span className={styles.name}>
                    {isFolder ? `${entry.name}/` : entry.name}
                  </span>
                  <span className={styles.size}>
                    {entry.size !== undefined ? formatFileSize(entry.size) : ""}
                  </span>
                  <span className={styles.age}>
                    {entry.modifiedAt !== undefined
                      ? briefAge(entry.modifiedAt, now)
                      : ""}
                  </span>
                </>
              );
              return (
                <li key={entry.name}>
                  {entry.kind === "other" ? (
                    <ButtonBase className={styles.row} disabled>
                      {cells}
                    </ButtonBase>
                  ) : (
                    <RowLink
                      href={isFolder ? folderHref(path) : fileHref(path)}
                      current={path === currentPath}
                      activate={() =>
                        isFolder ? setFolder(path) : onOpenFile(path)
                      }
                    >
                      {cells}
                    </RowLink>
                  )}
                </li>
              );
            })
          )}
        </ul>
      </div>
    </>,
    document.body,
  );
}
