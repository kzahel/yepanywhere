import {
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { BackArrowIcon } from "../../src/components/BackArrowIcon";
import "../../src/styles/purposeGlobals";
import styles from "./Breadcrumbs.module.css";

const PAPER = "research/speech-recognition/transcript-scoring/papers/";
const PROJECT = "/home/graehl/draft/";

interface Entry {
  name: string;
  size?: string;
  age?: string;
  status?: "M" | "?";
}

/** Fixture listings, keyed by project-relative folder with trailing slash. */
const listings: Record<string, Entry[]> = {
  [`${PAPER}asr-meaning-scoring/sections/`]: [
    { name: "_00-abstract.qmd", size: "2 kb", age: "3d" },
    { name: "_10-introduction.qmd", size: "6 kb", age: "3d" },
    { name: "_20-related-work.qmd", size: "9 kb", age: "5d" },
    { name: "_30-method.qmd", size: "14 kb", age: "23h", status: "M" },
    { name: "_40-data.qmd", size: "7 kb", age: "2d" },
    { name: "_50-experiments.qmd", size: "12 kb", age: "23h" },
    { name: "_60-results.qmd", size: "10 kb", age: "23h", status: "M" },
    { name: "_70-analysis.qmd", size: "8 kb", age: "4d" },
    { name: "_80-limitations.qmd", size: "3 kb", age: "6d" },
    { name: "_90-conclusion.qmd", size: "2 kb", age: "6d" },
    { name: "_95-work-plan.qmd", size: "11 kb", age: "23h" },
    { name: "_99-appendix.qmd", size: "5 kb", age: "1w" },
    {
      name: "_scratch-reviewer-notes.md",
      size: "1 kb",
      age: "2h",
      status: "?",
    },
  ],
  [`${PAPER}asr-meaning-scoring/`]: [
    { name: "_output/" },
    { name: "figures/" },
    { name: "sections/" },
    { name: "_quarto.yml", size: "1 kb", age: "3d" },
    { name: "paper.qmd", size: "2 kb", age: "3d" },
    { name: "references.bib", size: "18 kb", age: "5d" },
  ],
  [PAPER]: [
    { name: "asr-meaning-scoring/" },
    { name: "wer-critique/" },
    { name: "README.md", size: "1 kb", age: "2w" },
  ],
};

function listing(folder: string): Entry[] {
  const known = listings[folder];
  if (known) return known;
  // Unlisted fixture folders show only the child on the current path.
  const child = initialFile.slice(folder.length).split("/")[0];
  return [
    { name: `${child}/` },
    { name: "README.md", size: "2 kb", age: "1w" },
  ];
}

const initialFile = `${PAPER}asr-meaning-scoring/sections/_95-work-plan.qmd`;

const isFolder = (entry: Entry) => entry.name.endsWith("/");

function sorted(entries: Entry[]): Entry[] {
  return [...entries].sort(
    (a, b) =>
      Number(isFolder(b)) - Number(isFolder(a)) || a.name.localeCompare(b.name),
  );
}

function parentOf(folder: string): string | null {
  if (folder === "") return null;
  const trimmed = folder.slice(0, -1);
  const slash = trimmed.lastIndexOf("/");
  return slash < 0 ? "" : trimmed.slice(0, slash + 1);
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

function CopyGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <path d="M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3" />
    </svg>
  );
}

type Menu = {
  kind: "folder" | "file";
  target: string;
  x: number;
  y: number;
};

type Popover = { folder: string; segment: number };

function Proposal() {
  const [file, setFile] = useState(initialFile);
  const [popover, setPopover] = useState<Popover | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [notice, setNotice] = useState(
    "Mockup: listings and menu actions are illustrative.",
  );
  const infoRef = useRef<HTMLDivElement>(null);
  const segmentRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const [popoverPlace, setPopoverPlace] = useState({ left: 0, top: 0 });

  const parts = file.split("/");
  const fileName = parts.at(-1) ?? file;
  const folders = parts.slice(0, -1);
  const prefix = (index: number) => `${folders.slice(0, index + 1).join("/")}/`;
  const currentFolder = prefix(folders.length - 1);

  useLayoutEffect(() => {
    if (!popover || !infoRef.current) return;
    const anchor = segmentRefs.current[popover.segment];
    if (!anchor) return;
    const info = infoRef.current.getBoundingClientRect();
    const segment = anchor.getClientRects();
    const last = segment[segment.length - 1] ?? anchor.getBoundingClientRect();
    const width = Math.min(360, info.width);
    setPopoverPlace({
      left: Math.max(0, Math.min(last.left - info.left, info.width - width)),
      top: last.bottom - info.top + 4,
    });
  }, [popover]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenu(null);
      setPopover(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openFolder = (folder: string, segment: number) => {
    setMenu(null);
    setPopover((open) =>
      open?.folder === folder && open.segment === segment
        ? null
        : { folder, segment },
    );
  };

  const openMenu = (
    event: ReactMouseEvent,
    kind: Menu["kind"],
    target: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setPopover(null);
    setMenu({ kind, target, x: event.clientX, y: event.clientY });
  };

  const openFile = (path: string) => {
    setFile(path);
    setPopover(null);
    setNotice(`Opened ${path.split("/").at(-1)}`);
  };

  const siblings = sorted(listing(currentFolder)).filter((e) => !isFolder(e));
  const index = siblings.findIndex((entry) => entry.name === fileName);
  const previous = index > 0 ? siblings[index - 1] : undefined;
  const next = index >= 0 ? siblings[index + 1] : undefined;

  const act = (label: string) => {
    setMenu(null);
    setNotice(`${label} — illustrative.`);
  };

  return (
    <main className={styles.page}>
      <h1>Clickable path segments</h1>
      <p className={styles.caption}>
        Click a folder to list it · right-click a folder for folder actions ·
        “/” is not a target · the filename keeps today’s file menu
      </p>
      <section className={styles.viewer}>
        <header className={styles.header}>
          <div className={styles.identity}>
            <button
              className={styles.button}
              type="button"
              title="Back"
              aria-label="Back"
            >
              <BackArrowIcon />
            </button>
            <div className={styles.info} ref={infoRef}>
              {/* biome-ignore lint/a11y/noStaticElementInteractions: right-click on the filename or a "/" keeps today's file menu */}
              <span
                className={styles.path}
                title={file}
                onContextMenu={(event) => openMenu(event, "file", file)}
              >
                {folders.map((name, i) => {
                  const folder = prefix(i);
                  const active =
                    (popover?.segment === i && popover.folder === folder) ||
                    (menu?.kind === "folder" && menu.target === folder);
                  return (
                    <span key={folder}>
                      {/* An inline span, not a button, so a long segment can wrap mid-name as today's path does. */}
                      <span
                        ref={(node) => {
                          segmentRefs.current[i] = node;
                        }}
                        role="button"
                        tabIndex={0}
                        aria-haspopup="dialog"
                        aria-expanded={popover?.segment === i}
                        data-active={active || undefined}
                        className={styles.segment}
                        onClick={() => openFolder(folder, i)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            openFolder(folder, i);
                          }
                        }}
                        onContextMenu={(event) =>
                          openMenu(event, "folder", folder)
                        }
                      >
                        {name}
                      </span>
                      <span className={styles.slash}>/</span>
                      <wbr />
                    </span>
                  );
                })}
                <span className={styles.fileName} aria-current="page">
                  {fileName}
                </span>
              </span>
              <span className={styles.meta}>
                <a href="#revision">954a3bbc7</a> (23h ago) · 11 kb · 66 lines
              </span>
              {popover && (
                <FolderPopover
                  folder={popover.folder}
                  file={file}
                  place={popoverPlace}
                  previous={previous?.name}
                  next={next?.name}
                  isCurrentFolder={popover.folder === currentFolder}
                  onFolder={(folder) =>
                    setPopover((open) => open && { ...open, folder })
                  }
                  onFile={openFile}
                />
              )}
            </div>
          </div>
        </header>
        <div className={styles.body}>
          <h2>{fileName}</h2>
          <p>{notice}</p>
        </div>
      </section>
      {(menu || popover) && (
        <button
          type="button"
          className={styles.overlay}
          aria-label="Dismiss"
          onClick={() => {
            setMenu(null);
            setPopover(null);
          }}
        />
      )}
      {menu && <PathMenu menu={menu} onAct={act} />}
    </main>
  );
}

function FolderPopover({
  folder,
  file,
  place,
  previous,
  next,
  isCurrentFolder,
  onFolder,
  onFile,
}: {
  folder: string;
  file: string;
  place: { left: number; top: number };
  previous?: string;
  next?: string;
  isCurrentFolder: boolean;
  onFolder: (folder: string) => void;
  onFile: (path: string) => void;
}) {
  const entries = sorted(listing(folder));
  const parent = parentOf(folder);
  const rowsRef = useRef<HTMLUListElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-center when the listed folder changes
  useLayoutEffect(() => {
    const rows = rowsRef.current;
    const current = rows?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!rows) return;
    // Open with the current file centered, without scrolling the page.
    rows.scrollTop = current
      ? current.offsetTop - rows.clientHeight / 2 + current.offsetHeight / 2
      : 0;
  }, [folder]);
  const title = folder === "" ? "(project root)" : folder.split("/").at(-2);
  return (
    <div
      className={styles.popover}
      role="dialog"
      aria-label={`Folder ${folder || "project root"}`}
      style={place}
    >
      <div className={styles.popoverHead}>
        <span className={styles.popoverTitle}>{title}/</span>
        <span className={styles.count}>{entries.length} items</span>
        {isCurrentFolder && (
          <span className={styles.stepper}>
            <button
              type="button"
              className={styles.step}
              disabled={!previous}
              title={previous ? `Previous: ${previous}` : "No previous file"}
              aria-label="Previous file"
              onClick={() => previous && onFile(folder + previous)}
            >
              ‹
            </button>
            <button
              type="button"
              className={styles.step}
              disabled={!next}
              title={next ? `Next: ${next}` : "No next file"}
              aria-label="Next file"
              onClick={() => next && onFile(folder + next)}
            >
              ›
            </button>
          </span>
        )}
      </div>
      <ul className={styles.rows} ref={rowsRef}>
        {parent !== null && (
          <li>
            <button
              type="button"
              className={styles.row}
              onClick={() => onFolder(parent)}
            >
              <Glyph folder />
              <span className={styles.name}>../</span>
            </button>
          </li>
        )}
        {entries.map((entry) => {
          const path = folder + entry.name;
          const current = path === file;
          return (
            <li key={entry.name}>
              <button
                type="button"
                className={styles.row}
                aria-current={current ? "page" : undefined}
                onClick={() =>
                  isFolder(entry) ? onFolder(path) : onFile(path)
                }
              >
                <Glyph folder={isFolder(entry)} />
                <span className={styles.name}>{entry.name}</span>
                {entry.status && (
                  <span
                    className={styles.status}
                    data-status={entry.status}
                    title={entry.status === "M" ? "Modified" : "Untracked"}
                  >
                    {entry.status}
                  </span>
                )}
                <span className={styles.size}>{entry.size}</span>
                <span className={styles.age}>{entry.age}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const folderItems = [
  ["Open"],
  ["New session"],
  ["Open in Source Control"],
  null,
  ["Copy project-relative path", "copy"],
  ["Copy absolute path", "copy"],
  ["Copy listing", "copy"],
  ["Copy GitHub link", "copy"],
] as const;

const fileItems = [
  ["Open ›"],
  ["New session"],
  ["Open in Source Control"],
  null,
  ["Copy project-relative path", "copy"],
  ["Copy absolute file path", "copy"],
  ["Copy viewer link", "copy"],
  ["Copy contents", "copy"],
  ["Copy rendered contents", "copy"],
  ["Copy GitHub link", "copy"],
] as const;

function PathMenu({
  menu,
  onAct,
}: {
  menu: Menu;
  onAct: (label: string) => void;
}) {
  const items = menu.kind === "folder" ? folderItems : fileItems;
  const left = Math.min(menu.x, window.innerWidth - 248);
  const top = Math.min(menu.y, window.innerHeight - 340);
  return (
    <div
      className={styles.menu}
      role="menu"
      style={{ left: Math.max(8, left), top: Math.max(8, top) }}
    >
      {menu.kind === "folder" && (
        <div className={styles.menuTarget} title={PROJECT + menu.target}>
          {/* Truncate from the left; keep the path itself left-to-right. */}
          <bdi dir="ltr">{menu.target}</bdi>
        </div>
      )}
      {items.map((item, i) =>
        item === null ? (
          <div key={`separator-${i}`} className={styles.separator} />
        ) : (
          <button
            key={item[0]}
            type="button"
            role="menuitem"
            onClick={() => onAct(item[0])}
          >
            <span className={styles.menuLabel}>
              {item[1] === "copy" && <CopyGlyph />}
              {item[0]}
            </span>
          </button>
        ),
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Proposal />);
