import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BackArrowIcon } from "../../src/components/BackArrowIcon";
import { PencilIcon } from "../../src/components/PencilIcon";
import {
  FileDiffViewLinks,
  type FileViewSelection,
} from "../../src/components/FileDiffViewLinks";
import { ViewerWindowActions } from "../../src/components/ViewerWindowActions";
import { I18nProvider } from "../../src/i18n";
import "../../src/styles/purposeGlobals";
import styles from "./Header.module.css";

const path = "gaps/sketches/patient-topic-shift.md";
const file = {
  path,
  status: "M" as const,
  staged: false,
  linesAdded: 12,
  linesDeleted: 2,
};
const tools = [
  ["Comment", "M2 2h12v9H6l-4 3z"],
  ["Edit source", ""],
  ["Reload", "M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3.2h-3.2"],
  ["Select all", "M6 2H2v4M10 2h4v4M14 10v4h-4M6 14H2v-4M5 5h6v6H5z"],
  ["Copy contents", "M5 5h9v9H5zM11 5V2H2v9h3"],
  [
    "Share",
    "m6 10-1 1a3 3 0 0 1-4-4l3-3a3 3 0 0 1 4 0M10 6l1-1a3 3 0 0 1 4 4l-3 3a3 3 0 0 1-4 0M5 11l6-6",
  ],
  ["Download", "M8 2v8m-4-4 4 4 4-4M2 12v2h12v-2"],
  ["Fullscreen", "M6 2H2v4M10 2h4v4M14 10v4h-4M6 14H2v-4"],
] as const;

function Icon({ d }: { d: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

function HeaderProposal() {
  const [view, setView] = useState<FileViewSelection>("source");
  const [textSize, setTextSize] = useState(14);
  const [notice, setNotice] = useState(
    "Layout proposal — file actions are illustrative.",
  );
  return (
    <main className={styles.page}>
      <h1>Compact file viewer header</h1>
      <p className={styles.caption}>
        749 px viewer · Back before the filename · one control row when it fits
      </p>
      <section className={styles.viewer}>
        <header className={styles.header}>
          <div className={styles.identity}>
            <button
              className={styles.button}
              type="button"
              title="Back"
              aria-label="Back"
              onClick={() => setNotice("Back returns to the conversation.")}
            >
              <BackArrowIcon />
            </button>
            <span className={styles.path}>{path}</span>
            <span className={styles.meta}>
              <a href="#revision">8ec7d542c</a> (9m ago) · 8 kb · 140 lines
            </span>
          </div>
          <div className={styles.actions}>
            <FileDiffViewLinks
              activeView={view}
              availability={{
                supported: true,
                loading: false,
                relativePath: path,
                worktreeFile: file,
                cumulativeFile: file,
              }}
              projectId="example"
              onSelect={setView}
              variant="header"
            />
            <button
              className={styles.button}
              type="button"
              title="Raw source"
              aria-label="Raw source"
              aria-pressed={view === "source"}
              onClick={() => setView("source")}
            >
              <Icon d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4M9.5 2.5l-3 11" />
            </button>
            {tools.slice(0, 3).map(([label, d]) => (
              <button
                className={styles.button}
                type="button"
                key={label}
                title={label}
                aria-label={label}
                onClick={() => setNotice(`${label}: illustrative control.`)}
              >
                {label === "Edit source" ? <PencilIcon /> : <Icon d={d} />}
              </button>
            ))}
            <span className={styles.zoom}>
              <button
                type="button"
                className={styles.button}
                title="Smaller text"
                aria-label="Smaller text"
                onClick={() => setTextSize((size) => Math.max(10, size - 1))}
              >
                <span className={styles.operator}>−</span>
                <span className={styles.smallLetter}>a</span>
              </button>
              <button
                type="button"
                className={styles.button}
                title="Larger text"
                aria-label="Larger text"
                onClick={() => setTextSize((size) => Math.min(24, size + 1))}
              >
                <span className={styles.largeLetter}>A</span>
                <span className={styles.operator}>+</span>
              </button>
            </span>
            {tools.slice(3).map(([label, d]) => (
              <button
                className={styles.button}
                type="button"
                key={label}
                title={label}
                aria-label={label}
                onClick={() => setNotice(`${label}: illustrative control.`)}
              >
                <Icon d={d} />
              </button>
            ))}
            <ViewerWindowActions
              className={styles.window}
              url="#file"
              onMinimize={() =>
                setNotice(
                  "Minimize keeps the file available in the conversation.",
                )
              }
              onClose={() => setNotice("Close returns to the conversation.")}
              onMoveOut={() => setNotice("Open in a separate tab.")}
            />
          </div>
        </header>
        <div className={styles.body} style={{ fontSize: textSize }}>
          <h2>Patient topic shift</h2>
          <p>
            {view === "source"
              ? "Source"
              : view === "worktree"
                ? "HEAD → working tree"
                : "HEAD’s first parent → working tree"}
          </p>
          <p>{notice}</p>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <I18nProvider>
    <HeaderProposal />
  </I18nProvider>,
);
