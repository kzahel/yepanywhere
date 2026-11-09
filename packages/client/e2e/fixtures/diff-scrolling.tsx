import type { GitDiffResult, PatchHunk } from "@yep-anywhere/shared";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { FileRevisionLink } from "../../src/components/FileRevisionLink";
import { I18nProvider, useI18n } from "../../src/i18n";
import { GitDiffBody } from "../../src/pages/GitStatusDiffPreview";
import { SideBySideDiff } from "../../src/pages/SideBySideDiff";
import { UnifiedDiff } from "../../src/pages/UnifiedDiff";
import "../../src/styles/index.css";

const long =
  " | the control socket is up; the router records account, model, program and HTTP outcome | ".repeat(
    4,
  );
const patch: PatchHunk[] = [
  {
    oldStart: 18,
    oldLines: 5,
    newStart: 18,
    newLines: 6,
    lines: [
      " router" + long,
      " quota" + long,
      "+cyber-access" + long,
      " rejection" + long,
      " request" + long,
      " binding" + long,
    ],
  },
  {
    oldStart: 36,
    oldLines: 70,
    newStart: 37,
    newLines: 70,
    lines: Array.from(
      { length: 70 },
      (_, i) =>
        ` ${i}: ${[1, 2, 3, 20, 44, 45].includes(i) ? "record" + long : "short context line"}`,
    ),
  },
];
const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const html = `<pre class="shiki"><code>${patch
  .flatMap((hunk) => hunk.lines)
  .map(
    (line, index) =>
      `<span class="line ${line.startsWith("+") ? "line-inserted" : "line-context"}" data-diff-line="${index}"><span class="diff-prefix">${escapeHtml(line[0]!)}</span>${escapeHtml(line.slice(1))}</span>`,
  )
  .join("")}</code></pre>`;

declare global {
  interface Window {
    diffScrollingFixture: GitDiffResult;
  }
}
window.diffScrollingFixture = { diffHtml: html, structuredPatch: patch };

function Workbench() {
  const { t } = useI18n();
  return (
    <div
      className="git-diff-preview-body"
      style={{ height: "100dvh", overflowY: "auto" }}
    >
      <GitDiffBody
        projectId="diff-fixture"
        fileKey="events"
        file={{
          path: "docs/events.md",
          status: "M",
          staged: false,
          linesAdded: 1,
          linesDeleted: 0,
        }}
        paneHeader={{ title: "events.md", path: "docs/events.md" }}
        t={t}
      />
    </div>
  );
}

function Fixture() {
  const [paired, setPaired] = useState(window.innerWidth > 600);
  const [comment, setComment] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 50);
    return () => clearInterval(timer);
  }, []);
  const Diff = paired ? SideBySideDiff : UnifiedDiff;
  return (
    <div
      style={{
        height: "100dvh",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-surface)",
        color: "var(--text-primary)",
      }}
    >
      <div
        style={{
          padding: "12px",
          display: "flex",
          flexWrap: "wrap",
          gap: "12px",
        }}
      >
        <strong>docs / events.md</strong>
        <FileRevisionLink
          projectId="diff-fixture"
          path="docs/events.md"
          rev="e3e1c26"
          dirtyLabel="dirty"
          uncommittedLabel="uncommitted"
          showAuthor
        />
        <label>
          <input
            type="checkbox"
            checked={paired}
            onChange={(event) => setPaired(event.target.checked)}
          />{" "}
          Side by side
        </label>
        <button type="button" onClick={() => setComment((value) => !value)}>
          Comment
        </button>
        <span data-tick={tick} />
      </div>
      <div
        id="diff-scrollport"
        style={{ flex: 1, minHeight: 0, overflowY: "auto" }}
        className="diff-gutter-aligned"
      >
        <Diff
          diffHtml={html}
          structuredPatch={patch}
          splitAfterLine={comment ? 26 : undefined}
          editor={
            comment ? (
              <textarea aria-label="Review comment" style={{ width: "100%" }} />
            ) : undefined
          }
        />
      </div>
    </div>
  );
}
document.documentElement.dataset.theme = "light";
createRoot(document.getElementById("root")!).render(
  <MemoryRouter>
    <I18nProvider>
      {location.search.includes("workbench") ? <Workbench /> : <Fixture />}
    </I18nProvider>
  </MemoryRouter>,
);
