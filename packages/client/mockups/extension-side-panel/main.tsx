import type { IssueItem, ProviderName } from "@yep-anywhere/shared";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProviderBadge } from "../../src/components/ProviderBadge";
import { NotificationBadge } from "../../src/components/StatusBadge";
import { ThinkingIndicator } from "../../src/components/ThinkingIndicator";
import { I18nProvider } from "../../src/i18n";
import { IssueTypeBadge } from "../../src/pages/IssueTypeBadge";
import { SettingsItem } from "../../src/pages/settings/SettingsItem";
import { SettingsSection } from "../../src/pages/settings/SettingsSection";
import "../../src/styles/purposeGlobals";
import styles from "./Panel.module.css";

type View = "pr" | "off" | "elsewhere" | "options";

const VIEWS: { id: View; label: string }[] = [
  { id: "pr", label: "Panel · on a PR" },
  { id: "off", label: "Panel · site not enabled" },
  { id: "elsewhere", label: "Panel · other page" },
  { id: "options", label: "Options" },
];

const PR_URL = "github.com/TomFitAG/tomfit-api/pull/482/files";
const OTHER_URL =
  "developer.chrome.com/docs/extensions/reference/api/sidePanel";

type SessionState = "approval" | "question" | "running" | "idle";

interface PanelSession {
  id: string;
  title: string;
  project: string;
  host: string;
  provider: ProviderName;
  model: string;
  state: SessionState;
  age: string;
  activity: string;
  mentions?: string;
}

const PR_SESSIONS: PanelSession[] = [
  {
    id: "a",
    title: "Implement sync retry budget",
    project: "tomfit-api",
    host: "work-mbp",
    provider: "claude",
    model: "opus",
    state: "approval",
    age: "2m",
    activity: "Wants to run git push origin retry-budget. Approve?",
    mentions: "Mentioned 6× · opened this PR",
  },
  {
    id: "b",
    title: "Review PR #482 feedback",
    project: "tomfit-api",
    host: "work-mbp",
    provider: "codex",
    model: "gpt-5.5",
    state: "running",
    age: "now",
    activity:
      "Addressing the review comment about jitter: capping backoff at 30 s and adding a test for the 429 path.",
    mentions: "Mentioned 2× · last 4m ago",
  },
  {
    id: "c",
    title: "Sync worker flakiness investigation",
    project: "tomfit-api",
    host: "kyle-mini",
    provider: "claude",
    model: "sonnet",
    state: "idle",
    age: "3d",
    activity:
      "Root cause: retries are unbounded when upstream returns 429, so one stuck tenant starves the queue.",
    mentions: "Mentioned 1× · 3d ago",
  },
];

const ATTENTION: { heading: string; sessions: PanelSession[] }[] = [
  {
    heading: "Needs you",
    sessions: [
      PR_SESSIONS[0]!,
      {
        id: "d",
        title: "Chrome extension options page",
        project: "yepanywhere",
        host: "kyle-mini",
        provider: "claude",
        model: "fable",
        state: "question",
        age: "6m",
        activity: "Should passive lookup run when only the side panel is open?",
      },
    ],
  },
  {
    heading: "Running",
    sessions: [
      PR_SESSIONS[1]!,
      {
        id: "e",
        title: "Nightly import dedupe",
        project: "tomfit-etl",
        host: "work-mbp",
        provider: "claude",
        model: "opus",
        state: "running",
        age: "now",
        activity:
          "Running the import against yesterday's snapshot (step 3 of 5).",
      },
    ],
  },
  {
    heading: "Recent",
    sessions: [
      PR_SESSIONS[2]!,
      {
        id: "f",
        title: "Relay origin policy for extension ids",
        project: "yepanywhere",
        host: "kyle-mini",
        provider: "codex",
        model: "gpt-5.5",
        state: "idle",
        age: "5h",
        activity: "Deployed; 26 public origin probes pass.",
      },
    ],
  },
];

const PR_ITEM = {
  provider: "github",
  kind: "pr",
} as IssueItem;

function StateBadge({ state }: { state: SessionState }) {
  if (state === "approval")
    return <NotificationBadge variant="needs-input" label="Approval Needed" />;
  if (state === "question")
    return <NotificationBadge variant="needs-input" label="Question" />;
  if (state === "running") return <ThinkingIndicator variant="pill" />;
  return null;
}

function SessionRow({
  session,
  onOpen,
}: {
  session: PanelSession;
  onOpen: (session: PanelSession) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={styles.row}
        aria-label={`Open ${session.title}`}
        onClick={() => onOpen(session)}
      >
        <span className={styles.rowTop}>
          <span className={styles.rowTitle}>{session.title}</span>
          <span className={styles.age}>{session.age}</span>
        </span>
        <span className={styles.rowMeta}>
          <StateBadge state={session.state} />
          <ProviderBadge provider={session.provider} model={session.model} />
          <span>
            {session.project} · {session.host}
          </span>
        </span>
        <span className={styles.activity}>{session.activity}</span>
        {session.mentions && (
          <span className={styles.mentions}>{session.mentions}</span>
        )}
      </button>
    </li>
  );
}

function PanelHeader({ onOptions }: { onOptions: () => void }) {
  return (
    <header className={styles.panelHeader}>
      <span className={styles.logo} aria-hidden="true">
        Y
      </span>
      <strong>Yep Anywhere</strong>
      <span className={styles.hosts} title="Active hosts">
        <span className={styles.hostChip}>
          <span className={styles.online} aria-hidden="true" />
          work-mbp
        </span>
        <span className={styles.hostChip}>
          <span className={styles.online} aria-hidden="true" />
          kyle-mini
        </span>
      </span>
      <button
        type="button"
        className={styles.iconButton}
        aria-label="Extension options"
        onClick={onOptions}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
        </svg>
      </button>
    </header>
  );
}

function PrPanel({ onOpen }: { onOpen: (session: PanelSession) => void }) {
  const [target, setTarget] = useState("tomfit-api · work-mbp");
  const [note, setNote] = useState("");
  return (
    <>
      <section className={styles.context} aria-label="This page">
        <div className={styles.contextKey}>
          <IssueTypeBadge item={PR_ITEM} />
          <span>TomFitAG/tomfit-api#482</span>
        </div>
        <h2>Add retry budget to sync worker</h2>
        <p>3 sessions on 2 hosts · looked up just now</p>
      </section>
      <ul className={styles.list}>
        {PR_SESSIONS.map((session) => (
          <SessionRow key={session.id} session={session} onOpen={onOpen} />
        ))}
      </ul>
      <section className={styles.newSession}>
        <button
          type="button"
          className={styles.primary}
          onClick={() =>
            setNote(
              `Would open a new-session draft in ${target}, with the PR link in the composer.`,
            )
          }
        >
          + New session about this PR
        </button>
        <select
          aria-label="Project for the new session"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
        >
          <option>tomfit-api · work-mbp</option>
          <option>tomfit-api · kyle-mini</option>
          <option>tomfit-web · work-mbp</option>
        </select>
        {note && <p className={styles.inlineNote}>{note}</p>}
      </section>
      <p className={styles.coverage}>
        Indexed on both hosts: sessions active in the last 7 days. A session
        that mentions this PR but was never indexed will not appear.
      </p>
    </>
  );
}

function OffPanel({ onLookup }: { onLookup: () => void }) {
  const [granted, setGranted] = useState(false);
  return (
    <>
      <section className={styles.context} aria-label="This page">
        <div className={styles.contextKey}>
          <IssueTypeBadge item={PR_ITEM} />
          <span>TomFitAG/tomfit-api#482</span>
        </div>
        <p>Automatic lookup is off for github.com.</p>
      </section>
      <div className={styles.offActions}>
        <button type="button" className={styles.primary} onClick={onLookup}>
          Look up this page
        </button>
        <p className={styles.hint}>
          One lookup using this click. No access to the site is kept.
        </p>
        <button type="button" onClick={() => setGranted(true)}>
          Look up github.com pages automatically…
        </button>
        <p className={styles.hint}>
          Chrome will ask to let the extension read and change data on
          github.com. It only reads page addresses; it never injects into the
          page.
        </p>
        {granted && (
          <p className={styles.inlineNote} role="status">
            Chrome's permission prompt would appear here. No permission was
            requested in this mockup.
          </p>
        )}
      </div>
    </>
  );
}

function AttentionPanel({
  onOpen,
}: {
  onOpen: (session: PanelSession) => void;
}) {
  return (
    <>
      <section className={styles.context} aria-label="This page">
        <p>No issue or PR on this page. Showing sessions across your hosts.</p>
      </section>
      {ATTENTION.map((group) => (
        <section key={group.heading} aria-label={group.heading}>
          <h3 className={styles.groupHeading}>
            {group.heading}
            <span>{group.sessions.length}</span>
          </h3>
          <ul className={styles.list}>
            {group.sessions.map((session) => (
              <SessionRow key={session.id} session={session} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      ))}
      <p className={styles.coverage}>
        home-linux is not active. Activate it in options to include it.
      </p>
    </>
  );
}

function FakePage({ view }: { view: View }) {
  if (view === "elsewhere")
    return (
      <div className={styles.fakePage} aria-hidden="true">
        <span className={styles.fakeTitle}>chrome.sidePanel</span>
        <span className={styles.bar} />
        <span className={styles.bar} />
        <span className={styles.barShort} />
        <span className={styles.block} />
        <span className={styles.bar} />
        <span className={styles.barShort} />
      </div>
    );
  return (
    <div className={styles.fakePage} aria-hidden="true">
      <span className={styles.fakeTitle}>
        Add retry budget to sync worker <em>#482</em>
      </span>
      <span className={styles.fakeTabs}>
        <span>Conversation</span>
        <span>Commits 4</span>
        <span className={styles.fakeTabActive}>Files changed 6</span>
      </span>
      <span className={styles.diff}>
        <span className={styles.bar} />
        <span className={styles.added} />
        <span className={styles.added} />
        <span className={styles.removed} />
        <span className={styles.barShort} />
        <span className={styles.bar} />
        <span className={styles.added} />
      </span>
    </div>
  );
}

function Toggle({
  id,
  label,
  checked,
  onChange,
}: {
  id?: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <span className="toggle-switch">
      <input
        id={id}
        type="checkbox"
        aria-label={label}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="toggle-slider" />
    </span>
  );
}

interface HostOption {
  name: string;
  relay: string;
  online: boolean;
  active: boolean;
  connection: string;
}

interface SiteOption {
  site: string;
  source: string;
}

function Options({ onSaved }: { onSaved: (text: string) => void }) {
  const [hosts, setHosts] = useState<HostOption[]>([
    {
      name: "work-mbp",
      relay: "kyle-work",
      online: true,
      active: true,
      connection: "When needed",
    },
    {
      name: "kyle-mini",
      relay: "kzahel",
      online: true,
      active: true,
      connection: "When needed",
    },
    {
      name: "home-linux",
      relay: "kzahel-linux",
      online: false,
      active: false,
      connection: "When needed",
    },
  ]);
  const [defaultHost, setDefaultHost] = useState("work-mbp");
  const [passive, setPassive] = useState(true);
  const [sites, setSites] = useState<SiteOption[]>([
    { site: "github.com", source: "Access granted" },
    {
      site: "tomfit.atlassian.net",
      source: "Access granted · learned by work-mbp (TF, PLAT)",
    },
  ]);
  const [newSite, setNewSite] = useState("");
  const [allowlist, setAllowlist] = useState("TomFitAG/*\nkzahel/*\nTF");
  const [dismissed, setDismissed] = useState(false);
  const [syncHosts, setSyncHosts] = useState(false);
  const saved = (what: string) => onSaved(`${what} Saved in this browser.`);

  return (
    <div className={styles.optionsPage}>
      <SettingsSection
        title="Hosts"
        description="Saved hosts the extension may use outside the YA tab: for the side panel, page lookups and the toolbar badge. Each part of the extension connects on its own when it needs a host."
      >
        <ul className={styles.hostList}>
          {hosts.map((host) => (
            <li key={host.name} className={styles.hostRow}>
              <span className={styles.hostName}>
                <span
                  className={host.online ? styles.online : styles.offline}
                  aria-hidden="true"
                />
                <strong>{host.name}</strong>
                <span>relay · {host.relay}</span>
              </span>
              <label
                className={styles.inlineControl}
                htmlFor={`active-${host.name}`}
              >
                <Toggle
                  id={`active-${host.name}`}
                  label={`Use ${host.name}`}
                  checked={host.active}
                  onChange={(active) => {
                    setHosts(
                      hosts.map((item) =>
                        item.name === host.name ? { ...item, active } : item,
                      ),
                    );
                    saved(`${host.name} ${active ? "activated" : "paused"}.`);
                  }}
                />
                Active
              </label>
              <label className={styles.inlineControl}>
                <input
                  type="radio"
                  name="default-host"
                  checked={defaultHost === host.name}
                  disabled={!host.active}
                  onChange={() => {
                    setDefaultHost(host.name);
                    saved(`${host.name} is the default host.`);
                  }}
                />
                Default
              </label>
              <select
                aria-label={`Connection for ${host.name}`}
                value={host.connection}
                disabled={!host.active}
                onChange={(event) => {
                  setHosts(
                    hosts.map((item) =>
                      item.name === host.name
                        ? { ...item, connection: event.target.value }
                        : item,
                    ),
                  );
                  saved(`${host.name} connection changed.`);
                }}
              >
                <option>When needed</option>
                <option>Keep connected</option>
              </select>
            </li>
          ))}
        </ul>
        <p className={styles.hint}>
          The default host receives “new session about this page”. “When needed”
          connects for a lookup and lets Chrome stop the background worker when
          idle; “Keep connected” holds a connection while Chrome runs.
        </p>
      </SettingsSection>

      <SettingsSection
        title="Issue and PR lookup"
        description="Find sessions that mention the GitHub issue, PR or Jira ticket in the current tab."
      >
        <SettingsItem
          label="Look up pages automatically"
          description="Look up each page on the sites below as you browse, and show the count on the toolbar badge. When off, look up a page from the side panel or the toolbar."
        >
          <Toggle
            label="Look up pages automatically"
            checked={passive}
            onChange={(value) => {
              setPassive(value);
              saved(`Automatic lookup ${value ? "on" : "off"}.`);
            }}
          />
        </SettingsItem>
        <ul className={styles.siteList} aria-label="Sites">
          {sites.map((site) => (
            <li key={site.site}>
              <span>
                <strong>{site.site}</strong>
                <span>{site.source}</span>
              </span>
              <button
                type="button"
                onClick={() => {
                  setSites(sites.filter((item) => item.site !== site.site));
                  saved(`Access to ${site.site} removed.`);
                }}
              >
                Remove access
              </button>
            </li>
          ))}
          <li className={styles.addSite}>
            <input
              aria-label="Add a site"
              placeholder="github.example.com"
              value={newSite}
              onChange={(event) => setNewSite(event.target.value)}
            />
            <button
              type="button"
              disabled={!newSite.trim()}
              onClick={() => {
                const site = newSite.trim();
                setSites([...sites, { site, source: "Access granted" }]);
                setNewSite("");
                saved(
                  `Chrome would ask for access to ${site}; this mockup granted it locally.`,
                );
              }}
            >
              Grant access…
            </button>
          </li>
        </ul>
        <p className={styles.hint}>
          Suggested from your hosts: no other Jira sites learned yet.
        </p>
        <label className={styles.allowlist}>
          <span>
            <strong>Only look up these repositories and Jira projects</strong>
            <span>
              One per line. Leave empty to look up anything your hosts have
              indexed. Other pages are never sent to a host.
            </span>
          </span>
          <textarea
            aria-label="Repositories and Jira projects to look up"
            rows={5}
            value={allowlist}
            onChange={(event) => setAllowlist(event.target.value)}
            onBlur={() => saved("Lookup list updated.")}
          />
        </label>
        <SettingsItem
          label="Include dismissed associations"
          description="Show sessions whose link to the issue was dismissed on the Issues page."
        >
          <Toggle
            label="Include dismissed associations"
            checked={dismissed}
            onChange={(value) => {
              setDismissed(value);
              saved("Dismissed associations setting changed.");
            }}
          />
        </SettingsItem>
      </SettingsSection>

      <SettingsSection title="Toolbar and side panel">
        <SettingsItem label="Toolbar button">
          <select
            aria-label="Toolbar button"
            defaultValue="panel"
            onChange={() => saved("Toolbar button changed.")}
          >
            <option value="panel">Open the side panel</option>
            <option value="tab">Open or focus the YA tab</option>
            <option value="lookup">Look up this page</option>
          </select>
        </SettingsItem>
        <SettingsItem
          label="Toolbar badge"
          description="Counts come from automatic lookups and from sessions waiting for input on active hosts."
        >
          <select
            aria-label="Toolbar badge"
            defaultValue="page"
            onChange={() => saved("Toolbar badge changed.")}
          >
            <option value="page">Sessions for this page</option>
            <option value="attention">Sessions that need you</option>
            <option value="off">Off</option>
          </select>
        </SettingsItem>
        <SettingsItem label="When a page has no issue or PR">
          <select
            aria-label="When a page has no issue or PR"
            defaultValue="attention"
            onChange={() => saved("Side panel fallback changed.")}
          >
            <option value="attention">Show sessions that need you</option>
            <option value="recent">Show recent sessions</option>
            <option value="none">Show nothing</option>
          </select>
        </SettingsItem>
        <SettingsItem label="Open sessions in">
          <select
            aria-label="Open sessions in"
            defaultValue="existing"
            onChange={() => saved("Session opening changed.")}
          >
            <option value="existing">The existing YA tab</option>
            <option value="new">A new YA tab</option>
          </select>
        </SettingsItem>
      </SettingsSection>

      <SettingsSection title="Storage">
        <SettingsItem
          label="Sync the host list with Chrome sync"
          description="Host names and relay usernames follow your Chrome profile to other computers. Saved logins never sync."
        >
          <Toggle
            label="Sync the host list with Chrome sync"
            checked={syncHosts}
            onChange={(value) => {
              setSyncHosts(value);
              saved(`Host list sync ${value ? "on" : "off"}.`);
            }}
          />
        </SettingsItem>
      </SettingsSection>
    </div>
  );
}

function App() {
  const [view, setView] = useState<View>("pr");
  const [status, setStatus] = useState("");
  const open = (session: PanelSession) =>
    setStatus(
      `Opened “${session.title}” on ${session.host} in the existing YA tab.`,
    );
  const panelView = view !== "options";
  const url =
    view === "options"
      ? "chrome-extension://dgeameddpnggdeenoekpiaacfghdodch/settings/extension"
      : view === "elsewhere"
        ? OTHER_URL
        : PR_URL;
  const badge = view === "pr" ? "3" : view === "elsewhere" ? "2" : null;

  return (
    <div className={styles.page}>
      <div className={styles.mockbar}>
        <span>Proposal · Chrome extension side panel and options</span>
        <nav aria-label="Mockup views">
          {VIEWS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={view === item.id}
              onClick={() => {
                setView(item.id);
                setStatus("");
              }}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </div>
      <div className={styles.browser}>
        <div className={styles.addressRow}>
          <span className={styles.address}>{url}</span>
          <span className={styles.action} title="Yep Anywhere">
            Y{badge && <span className={styles.badge}>{badge}</span>}
          </span>
        </div>
        {panelView ? (
          <div className={styles.split}>
            <FakePage view={view} />
            <aside
              className={styles.panel}
              aria-label="Yep Anywhere side panel"
            >
              <PanelHeader onOptions={() => setView("options")} />
              <div className={styles.panelBody}>
                {view === "pr" && <PrPanel onOpen={open} />}
                {view === "off" && <OffPanel onLookup={() => setView("pr")} />}
                {view === "elsewhere" && <AttentionPanel onOpen={open} />}
              </div>
            </aside>
          </div>
        ) : (
          <div className={styles.optionsShell}>
            <nav className={styles.settingsNav} aria-label="Settings">
              <span>Appearance</span>
              <span>Notifications</span>
              <span>Remote Access</span>
              <span>Issues &amp; PRs</span>
              <span className={styles.selected}>Browser extension</span>
            </nav>
            <main className={styles.optionsMain}>
              <h1>Browser extension</h1>
              <p className={styles.lede}>
                These settings belong to this Chrome profile's extension, not to
                any host.
              </p>
              <Options onSaved={setStatus} />
            </main>
          </div>
        )}
      </div>
      <p className={styles.status} role="status">
        {status}
      </p>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <I18nProvider>
    <App />
  </I18nProvider>,
);
