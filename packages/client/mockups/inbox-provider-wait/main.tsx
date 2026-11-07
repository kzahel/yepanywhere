import type {
  ProviderWorkItem,
  SessionProviderPhase,
} from "@yep-anywhere/shared";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import inboxStyles from "../../src/components/InboxContent.module.css";
import { SessionListItem } from "../../src/components/SessionListItem";
import { ThinkingIndicator } from "../../src/components/ThinkingIndicator";
import { I18nProvider } from "../../src/i18n";
import "../../src/styles/index.css";
import styles from "./Inbox.module.css";

/**
 * Proposed `InboxItem.providerPhase`. Row `activity` stays "in-turn" for all
 * of these, so queued messages keep waiting; this only changes rendering.
 *   generating — provider output in the last few seconds
 *   waiting    — turn active, model blocked on a command, sleep or subagent
 *   quiet      — turn active, no provider output for a long time
 *   background — turn ended; provider work or a scheduled wake holds it
 */
type ProviderPhase = "generating" | "waiting" | "quiet" | "background";

interface FixtureRow {
  id: string;
  title: string;
  projectName: string;
  updatedAgoMs: number;
  phase: ProviderPhase;
  lastProgressAgoMs?: number;
  work?: (Omit<ProviderWorkItem, "startedAt" | "until"> & {
    startedAgoMs?: number;
    untilInMs?: number;
  })[];
  pendingInputType?: "tool-approval";
}

const MIN = 60_000;
const loadedAt = Date.now();

const attentionRows: FixtureRow[] = [
  {
    id: "attn-1",
    title: "Deploy the relay hotfix to staging",
    projectName: "yepanywhere",
    updatedAgoMs: 2 * MIN,
    phase: "waiting",
    pendingInputType: "tool-approval",
  },
];

const activeRows: FixtureRow[] = [
  {
    id: "gen-1",
    title: "Refactor inbox tier ordering for starred sessions",
    projectName: "yepanywhere",
    updatedAgoMs: 4_000,
    phase: "generating",
    lastProgressAgoMs: 2_000,
  },
  {
    id: "gen-2",
    title: "Summarize this week's Jira tickets for TF-1203",
    projectName: "tomfit-context",
    updatedAgoMs: 9_000,
    phase: "generating",
    lastProgressAgoMs: 1_000,
  },
  {
    id: "wait-cmd",
    title: "Fix flaky e2e login test on Android",
    projectName: "yepanywhere",
    updatedAgoMs: 72_000,
    phase: "waiting",
    work: [
      {
        id: "t1",
        kind: "shell",
        label: "pnpm test:e2e --project android",
        source: "task_started",
        startedAgoMs: 72_000,
      },
    ],
  },
  {
    id: "wait-agent",
    title: "Audit retention code paths for idle reaping",
    projectName: "yepanywhere",
    updatedAgoMs: 40_000,
    phase: "waiting",
    work: [
      {
        id: "a1",
        kind: "subagent",
        label: "Explore: find idle reaper callers",
        source: "task_started",
        startedAgoMs: 40_000,
      },
    ],
  },
  {
    id: "wait-sleep",
    title: "Watch the CI run on #412 and fix failures",
    projectName: "yepanywhere",
    updatedAgoMs: 2 * MIN,
    phase: "waiting",
    work: [
      {
        id: "s1",
        kind: "sleep",
        label: "clock.sleep",
        source: "item/started",
        untilInMs: 3 * MIN + 20_000,
      },
    ],
  },
  {
    id: "quiet-1",
    title: "Migrate the session index to SQLite",
    projectName: "yepanywhere",
    updatedAgoMs: 6 * MIN,
    phase: "quiet",
    lastProgressAgoMs: 6 * MIN,
  },
];

const backgroundRows: FixtureRow[] = [
  {
    id: "bg-shell",
    title:
      "bring up the review bot panel agent auth router dashboard so i can see it.",
    projectName: "tomfit-context",
    updatedAgoMs: 3 * MIN,
    phase: "background",
    work: [
      {
        id: "b1",
        kind: "shell",
        label:
          "Serve the review VM's AAR dashboard · infra/ci-hosts/review/aar-dashboard.py",
        source: "background_tasks_changed",
        startedAgoMs: 3 * MIN,
      },
    ],
  },
  {
    id: "bg-cron",
    title: "Remind me to check the release notes draft",
    projectName: "kylefit-docs",
    updatedAgoMs: 11 * MIN,
    phase: "background",
    work: [
      {
        id: "c1",
        kind: "cron",
        label: "Check the release notes draft",
        source: "stop_hook.session_crons",
        untilInMs: 19 * MIN,
      },
    ],
  },
  {
    id: "bg-multi",
    title: "Run the dev server and tell me when the build breaks",
    projectName: "yepanywhere",
    updatedAgoMs: 24 * MIN,
    phase: "background",
    work: [
      {
        id: "m1",
        kind: "shell",
        label: "pnpm dev",
        source: "background_tasks_changed",
        startedAgoMs: 24 * MIN,
      },
      {
        id: "m2",
        kind: "monitor",
        label: "watch build errors",
        source: "background_tasks_changed",
        startedAgoMs: 23 * MIN,
      },
    ],
  },
];

const recentRows: FixtureRow[] = [
  {
    id: "recent-1",
    title: "Explain the provider retention snapshot fields",
    projectName: "yepanywhere",
    updatedAgoMs: 14 * MIN,
    phase: "generating",
  },
];

function formatSpan(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return minutes < 10 && rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

const KIND_GLYPH: Record<ProviderWorkItem["kind"], string> = {
  shell: "$",
  monitor: "◉",
  subagent: "↳",
  workflow: "⇉",
  mcp: "⧉",
  cron: "◷",
  sleep: "◷",
  other: "•",
};

function workLabel(row: FixtureRow, now: number): string | null {
  const elapsed = now - loadedAt;
  if (row.phase === "quiet") {
    return `no output ${formatSpan((row.lastProgressAgoMs ?? 0) + elapsed)}`;
  }
  const [first, ...rest] = row.work ?? [];
  if (!first) return null;
  const glyph = KIND_GLYPH[first.kind];
  // Time first, so the ellipsis eats the label rather than the timer.
  let time: string | null = null;
  if (first.kind === "sleep" && first.untilInMs !== undefined) {
    return `${glyph} sleeping · wakes in ${formatSpan(first.untilInMs - elapsed)}`;
  } else if (first.untilInMs !== undefined) {
    time = `wakes ${formatClock(loadedAt + first.untilInMs)}`;
  } else if (first.startedAgoMs !== undefined) {
    time = formatSpan(first.startedAgoMs + elapsed);
  }
  return [
    glyph,
    [time, rest.length ? `${rest.length + 1} tasks` : null, first.label]
      .filter(Boolean)
      .join(" · "),
  ].join(" ");
}

function PhaseMark({ phase }: { phase: ProviderPhase }) {
  if (phase === "generating") return <ThinkingIndicator />;
  return (
    <span
      className={styles.ring}
      data-phase={phase}
      role="img"
      aria-label={
        phase === "waiting"
          ? "Waiting on work"
          : phase === "quiet"
            ? "No recent output"
            : "Held by background work"
      }
    />
  );
}

/** `?mode=shipped` renders rows through the shipped `providerPhase` prop. */
const shipped = new URLSearchParams(location.search).get("mode") === "shipped";

/** The fixture row as the server sends it; there is no shipped quiet phase. */
function shippedPhase(row: FixtureRow): SessionProviderPhase {
  const work = row.work?.map(({ startedAgoMs, untilInMs, ...item }) => ({
    ...item,
    ...(startedAgoMs !== undefined
      ? { startedAt: new Date(loadedAt - startedAgoMs).toISOString() }
      : {}),
    ...(untilInMs !== undefined
      ? { until: new Date(loadedAt + untilInMs).toISOString() }
      : {}),
  }));
  const phase = row.phase === "quiet" ? "generating" : row.phase;
  return work?.length && phase !== "generating" ? { phase, work } : { phase };
}

function Row({
  row,
  now,
  showMark,
}: {
  row: FixtureRow;
  now: number;
  showMark: boolean;
}) {
  if (shipped && !row.pendingInputType) {
    // The shipped row: the real phase mark and pill from `providerPhase`.
    return (
      <SessionListItem
        sessionId={row.id}
        projectId="fixture"
        title={row.title}
        projectName={row.projectName}
        updatedAt={new Date(loadedAt - row.updatedAgoMs).toISOString()}
        activity="in-turn"
        providerPhase={shippedPhase(row)}
        mode="card"
        showProjectName
        showTimestamp
        showMenu={false}
        showContextUsage={false}
        showStatusBadge={false}
        showActivityIndicator={showMark}
        basePath=""
      />
    );
  }
  const label = row.pendingInputType ? "Approval" : workLabel(row, now);
  const badgeClass = row.pendingInputType
    ? (inboxStyles.badgeApproval ?? "")
    : `${styles.workPill} ${styles[`pill-${row.phase}`] ?? ""}`;
  return (
    <SessionListItem
      sessionId={row.id}
      projectId="fixture"
      title={row.title}
      titleContent={
        <>
          {showMark && <PhaseMark phase={row.phase} />}
          <span>{row.title}</span>
        </>
      }
      projectName={row.projectName}
      updatedAt={new Date(loadedAt - row.updatedAgoMs).toISOString()}
      activity="in-turn"
      mode="card"
      showProjectName
      showTimestamp
      showMenu={false}
      showContextUsage={false}
      showStatusBadge={false}
      showActivityIndicator={false}
      customBadge={label ? { label, className: badgeClass } : null}
      basePath=""
    />
  );
}

function Section({
  title,
  tierClass,
  rows,
  now,
  showMark = true,
  note,
}: {
  title: string;
  tierClass: string;
  rows: FixtureRow[];
  now: number;
  showMark?: boolean;
  note?: string;
}) {
  return (
    <section className={`${inboxStyles.section} ${tierClass}`}>
      <h2 className={inboxStyles.sectionHeader}>
        {title}
        <span className={inboxStyles.sectionCount}>{rows.length}</span>
      </h2>
      {note && <p className={styles.sectionNote}>{note}</p>}
      <ul className="sessions-list">
        {rows.map((row) => (
          <Row key={row.id} row={row} now={now} showMark={showMark} />
        ))}
      </ul>
    </section>
  );
}

type Layout = "inline" | "grouped";

function InboxProposal() {
  const [layout, setLayout] = useState<Layout>(() =>
    new URLSearchParams(location.search).get("layout") === "grouped"
      ? "grouped"
      : "inline",
  );
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [now, setNow] = useState(loadedAt);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <main className={styles.page} data-shipped={shipped || undefined}>
      <header className={styles.intro}>
        <h1>Inbox: generating vs. waiting{shipped ? " (shipped)" : ""}</h1>
        <div className={styles.toggles}>
          <div className={styles.segmented} role="group" aria-label="Layout">
            {(["inline", "grouped"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={layout === value}
                onClick={() => setLayout(value)}
              >
                {value}
              </button>
            ))}
          </div>
          <div className={styles.segmented} role="group" aria-label="Theme">
            {(["dark", "light"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={theme === value}
                onClick={() => setTheme(value)}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
        <ul className={styles.legend}>
          <li>
            <PhaseMark phase="generating" /> generating
          </li>
          <li>
            <PhaseMark phase="waiting" /> turn open, waiting on work
          </li>
          <li>
            <PhaseMark phase="quiet" /> turn open, no output
          </li>
          <li>
            <PhaseMark phase="background" /> turn ended, held by background work
          </li>
        </ul>
      </header>
      <div className={inboxStyles.tiers}>
        <Section
          title="Needs Attention"
          tierClass={inboxStyles.tierAttention ?? ""}
          rows={attentionRows}
          now={now}
          showMark={false}
        />
        {layout === "inline" ? (
          <Section
            title="Active"
            tierClass={inboxStyles.tierActive ?? ""}
            rows={[...activeRows, ...backgroundRows]}
            now={now}
          />
        ) : (
          <>
            <Section
              title="Active"
              tierClass={inboxStyles.tierActive ?? ""}
              rows={activeRows}
              now={now}
            />
            <Section
              title="Background"
              tierClass={styles.tierBackground ?? ""}
              rows={backgroundRows}
              now={now}
              note="Turn finished. Messages you send queue until this work ends or you stop it."
            />
          </>
        )}
        <Section
          title="Recent Activity"
          tierClass={inboxStyles.tierRecent ?? ""}
          rows={recentRows}
          now={now}
          showMark={false}
        />
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <I18nProvider>
    <MemoryRouter>
      <InboxProposal />
    </MemoryRouter>
  </I18nProvider>,
);
