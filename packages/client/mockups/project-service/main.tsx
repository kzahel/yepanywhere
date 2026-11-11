import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { ProjectCard } from "../../src/components/ProjectCard";
import { ViewerWindowActions } from "../../src/components/ViewerWindowActions";
import headerStyles from "../../src/components/ViewerHeader.module.css";
import windowStyles from "../../src/components/ViewerWindowActions.module.css";
import { I18nProvider } from "../../src/i18n";
import type { Project } from "../../src/types";
import "../../src/styles/purposeGlobals";
import styles from "./Service.module.css";

const project: Project = {
  id: "scooter",
  name: "archer/scooter parkour",
  path: "~/archer/scooter-parkour",
  caption: {
    text: "A typing toy for the browser. Type a little world, then ride across it.",
    source: "readme",
  },
  sessionCount: 1,
  activeOwnedCount: 0,
  activeExternalCount: 0,
  lastActivity: null,
};

function ServiceMockup() {
  const [view, setView] = useState("app");
  const [limited, setLimited] = useState(true);
  const [vhosts, setVhosts] = useState(true);
  const [target, setTarget] = useState("service");
  const [running, setRunning] = useState(true);
  const [reserved, setReserved] = useState(true);
  const [serving, setServing] = useState(false);
  const [hostname, setHostname] = useState("archer-scooter");
  const [hidden, setHidden] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [words, setWords] = useState("make small things feel big");
  const [notice, setNotice] = useState("");
  const [voice, setVoice] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [message, setMessage] = useState("");
  const [paneExpanded, setPaneExpanded] = useState(false);
  const [smartTurn, setSmartTurn] = useState(true);
  const newSession = (microphone: boolean) => {
    setView("session");
    setVoice(microphone);
    setPaneExpanded(false);
    setNotice("");
  };
  const status =
    target === "service" ? (running ? "Running" : "Stopped") : "Ready";
  const openApp = () => {
    setView("app");
    setNotice("");
  };
  const settings = () => {
    setView("settings");
    setNotice("");
  };
  return (
    <div className={styles.shell}>
      <details className={styles.review}>
        <summary aria-label="Mockup scenarios" title="Mockup scenarios">
          ◈
        </summary>
        <div>
          <strong>Layout mockup · No real recording or requests</strong>
          <label>
            View{" "}
            <select
              aria-label="Preview view"
              value={view}
              onChange={(e) => setView(e.target.value)}
            >
              <option value="app">Main-pane app</option>
              <option value="session">Session + app</option>
              <option value="settings">Project settings</option>
              <option value="projects">Projects</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={limited}
              onChange={(e) => setLimited(e.target.checked)}
            />
            Limited user
          </label>
          <label>
            <input
              type="checkbox"
              checked={vhosts}
              onChange={(e) => setVhosts(e.target.checked)}
            />
            Vhosts enabled
          </label>
          <label>
            Content{" "}
            <select
              aria-label="Content scenario"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="service">Project service</option>
              <option value="static">Static app</option>
              <option value="artifact">Latest artifact only</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={smartTurn}
              onChange={(e) => setSmartTurn(e.target.checked)}
            />
            Grok Smart Turn enabled
          </label>
        </div>
      </details>
      <aside className={styles.sidebar}>
        <span className={styles.brand}>Y</span>
        <button
          type="button"
          title="Projects"
          aria-label="Projects"
          onClick={() => setView("projects")}
        >
          ⌂
        </button>
        <button
          type="button"
          title="New session"
          aria-label="New project session"
          onClick={() => newSession(false)}
        >
          ＋
        </button>
        <button
          type="button"
          title="Project settings"
          aria-label="Project settings"
          onClick={settings}
        >
          ⚙
        </button>
      </aside>
      <main className={styles.main}>
        {(view === "projects" || view === "settings") && (
          <header className={styles.header}>
            <button
              type="button"
              className={styles.back}
              onClick={() => setView("projects")}
            >
              ‹ Projects
            </button>
            <strong>scooter parkour</strong>
            <span className={styles.owner}>archer</span>
            <button
              type="button"
              className={styles.gear}
              onClick={view === "settings" ? openApp : settings}
            >
              {view === "settings" ? "Open app ↗" : "⚙ Settings"}
            </button>
          </header>
        )}
        {view === "projects" ? (
          <section className={styles.projectList}>
            <h1>Projects</h1>
            {hidden && limited ? (
              <div className={styles.empty}>
                <h2>Project removed from your view</h2>
                <p>
                  Files and history remain. Your administrator can restore it.
                </p>
              </div>
            ) : (
              <>
                <ul>
                  <ProjectCard
                    project={project}
                    needsAttentionCount={0}
                    thinkingCount={0}
                    onOpenSettings={settings}
                    onDeleteProject={
                      limited
                        ? () => {
                            settings();
                            setConfirm(true);
                          }
                        : undefined
                    }
                  />
                </ul>
                <div className={styles.cardActions}>
                  <span className={styles.status}>{status}</span>
                  <button
                    type="button"
                    className={styles.primary}
                    onClick={openApp}
                  >
                    Open app →
                  </button>
                </div>
                {hidden && !limited && (
                  <div className={styles.audit}>
                    <strong>Removed from archer’s view</strong>
                    <p>
                      Today, 16:20 · by archer. Project, sessions and app
                      address retained.
                    </p>
                    <button type="button" onClick={() => setHidden(false)}>
                      Restore to archer’s projects
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        ) : view === "settings" ? (
          <section className={styles.settings}>
            <h1>Project settings</h1>
            <section className={styles.section}>
              <div className={styles.row}>
                <h2>App</h2>
                <span className={styles.status}>{status}</span>
              </div>
              <div className={styles.row}>
                <div>
                  <strong>
                    {target === "artifact"
                      ? "Latest artifact"
                      : "Scooter parkour"}
                  </strong>
                  <p>
                    {target === "service"
                      ? "Project server · Runs in this project’s sandbox"
                      : target === "static"
                        ? "Built app · No server process needed"
                        : "skate-study.html · From the latest project session"}
                  </p>
                </div>
                <div className={styles.actions}>
                  <button type="button" onClick={openApp}>
                    Open app
                  </button>
                  {target === "service" && (
                    <button type="button" onClick={() => setRunning(!running)}>
                      {running ? "Stop" : "Start"}
                    </button>
                  )}
                </div>
              </div>
              <details className={styles.details}>
                <summary>App details</summary>
                <dl>
                  <dt>Entry</dt>
                  <dd>
                    {target === "static"
                      ? "dist/index.html"
                      : target === "artifact"
                        ? "skate-study.html"
                        : "/"}
                  </dd>
                  <dt>Start</dt>
                  <dd>
                    {target === "service" ? "npm run start" : "No process"}
                  </dd>
                  <dt>Status</dt>
                  <dd>
                    {target === "service"
                      ? "HTTP /health · 200"
                      : "File available"}
                  </dd>
                  <dt>Stop</dt>
                  <dd>
                    {target === "service"
                      ? "Stop this app’s process"
                      : "Not applicable"}
                  </dd>
                </dl>
              </details>
            </section>
            {vhosts && (
              <section className={styles.section} aria-label="App address">
                <div className={styles.row}>
                  <h2>App address</h2>
                  <span className={styles.badge}>
                    {reserved
                      ? serving && running
                        ? "Serving"
                        : "Reserved"
                      : "Not reserved"}
                  </span>
                </div>
                {reserved ? (
                  <>
                    <strong className={styles.hostname}>
                      {hostname}.apps.example.com
                    </strong>
                    <p>
                      Previously reserved for this project · Private link
                      required
                    </p>
                    <div className={styles.row}>
                      <span className={styles.subtle}>
                        {serving
                          ? "Serving this app at its saved address."
                          : "Not currently serving at this address."}
                      </span>
                      {!limited && (
                        <button
                          type="button"
                          onClick={() => setServing(!serving)}
                        >
                          {serving ? "Stop serving" : "Serve at this address"}
                        </button>
                      )}
                    </div>
                    {limited && (
                      <p className={styles.note}>
                        Your administrator can enable serving at this address.
                        Open app works without it.
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <p>
                      Reserve an address for this project. This does not publish
                      it.
                    </p>
                    <div className={styles.reservation}>
                      <label>
                        App name
                        <input
                          value={hostname}
                          onChange={(e) => setHostname(e.target.value)}
                        />
                      </label>
                      <span>.apps.example.com</span>
                      <button
                        type="button"
                        disabled={!/^[a-z][a-z0-9-]*$/.test(hostname)}
                        onClick={() => setReserved(true)}
                      >
                        Reserve address
                      </button>
                    </div>
                  </>
                )}
              </section>
            )}
            {limited && (
              <section className={styles.remove}>
                <div>
                  <strong>Remove from my projects</strong>
                  <p>
                    Only hides this project from your view. Files and history
                    stay with the administrator.
                  </p>
                </div>
                <button type="button" onClick={() => setConfirm(true)}>
                  Remove…
                </button>
              </section>
            )}
            {confirm && (
              <div
                className={styles.confirm}
                role="dialog"
                aria-label="Remove from my projects"
              >
                <h2>Remove from your projects?</h2>
                <p>
                  The administrator will still see this project and its history.
                  Its app and reserved address are kept.
                </p>
                <div className={styles.actions}>
                  <button type="button" onClick={() => setConfirm(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setHidden(true);
                      setConfirm(false);
                      setView("projects");
                    }}
                  >
                    Remove from my view
                  </button>
                </div>
              </div>
            )}
            <details className={styles.fixture}>
              <summary>More preview states</summary>
              <label>
                <input
                  type="checkbox"
                  checked={reserved}
                  onChange={(e) => setReserved(e.target.checked)}
                />{" "}
                Existing reservation
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={running}
                  onChange={(e) => setRunning(e.target.checked)}
                />{" "}
                Service running
              </label>
            </details>
          </section>
        ) : (
          <div
            data-pane-expanded={paneExpanded}
            className={
              view === "session" ? styles.sessionLayout : styles.appLayout
            }
          >
            {view === "session" && (
              <section
                className={styles.conversation}
                aria-label="New project session"
              >
                <div className={styles.sessionHeader}>
                  <button type="button" onClick={() => setPaneExpanded(true)}>
                    App
                  </button>
                  <span>scooter parkour · New session</span>
                </div>
                <div className={styles.transcript}>
                  <p>What would you like to change?</p>
                  <small>Your app stays attached to this session.</small>
                </div>
                <div className={styles.composer}>
                  <textarea
                    aria-label="Message"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder={voice ? "Listening…" : "Message…"}
                    rows={3}
                  />
                  <div className={styles.composerBar}>
                    <span>Codex · Default</span>
                    <span
                      className={voice ? styles.recording : styles.speechMethod}
                    >
                      Grok{smartTurn ? " · Smart Turn" : ""}
                      {voice ? " · listening" : ""}
                    </span>
                    <button
                      type="button"
                      aria-label={
                        voice
                          ? "Stop composer recording"
                          : "Start composer recording"
                      }
                      title={voice ? "Stop recording" : "Record"}
                      onClick={() => setVoice(!voice)}
                    >
                      {voice ? "■" : "●"}
                    </button>
                    <button
                      type="button"
                      aria-label="Send message"
                      disabled={!message.trim()}
                      onClick={() =>
                        setNotice(
                          "Mockup only — production uses the ordinary composer send path.",
                        )
                      }
                    >
                      ↑
                    </button>
                  </div>
                </div>
              </section>
            )}
            <section
              className={styles.viewer}
              aria-label={
                view === "session"
                  ? "Session right-pane app"
                  : "Project main-pane app"
              }
            >
              <header className={`${headerStyles.header} ${styles.toolbar}`}>
                <div className={windowStyles.actions}>
                  <button
                    type="button"
                    aria-label={
                      view === "session"
                        ? "Back to session"
                        : "Back to projects"
                    }
                    title={
                      view === "session"
                        ? "Back to session"
                        : "Back to projects"
                    }
                    onClick={() =>
                      view === "session"
                        ? setPaneExpanded(false)
                        : setView("projects")
                    }
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      aria-hidden="true"
                    >
                      <path d="m10 3-5 5 5 5" />
                    </svg>
                  </button>
                </div>
                <span
                  className={`${headerStyles.identity} ${styles.toolbarIdentity}`}
                >
                  <span className={styles.viewerTitle}>
                    {target === "artifact"
                      ? "skate-study.html"
                      : "scooter parkour"}
                  </span>
                </span>
                <div className={headerStyles.actions}>
                  <div className={windowStyles.actions}>
                    <button
                      type="button"
                      aria-label={
                        voice && view === "session"
                          ? "Stop recording"
                          : "Start a new session with microphone"
                      }
                      title={
                        voice && view === "session"
                          ? "Stop recording · Grok"
                          : "Dictate · New project session"
                      }
                      aria-pressed={voice && view === "session"}
                      className={
                        voice && view === "session"
                          ? styles.activeMic
                          : undefined
                      }
                      onClick={() =>
                        view === "session" ? setVoice(!voice) : newSession(true)
                      }
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        aria-hidden="true"
                      >
                        <rect x="9" y="2" width="6" height="12" rx="3" />
                        <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      aria-label="New session with app"
                      title="New session with app"
                      onClick={() => newSession(false)}
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        aria-hidden="true"
                      >
                        <path d="M8 3v10M3 8h10" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      aria-label="Share"
                      title="Share"
                      aria-expanded={sharing}
                      onClick={() => setSharing(!sharing)}
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        aria-hidden="true"
                      >
                        <path d="M8 10V2m-3 3 3-3 3 3M3 8v6h10V8" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      aria-label="App settings"
                      title="App settings"
                      onClick={settings}
                    >
                      ⋯
                    </button>
                  </div>
                  <ViewerWindowActions
                    url="./index.html"
                    onReload={() => setNotice("Mockup reloaded")}
                    reloadLabel="Reload app"
                    onMoveOut={() =>
                      setNotice("Opened the mockup in a new tab")
                    }
                    onClose={() => setView("projects")}
                    closeLabel="Back to projects"
                  />
                </div>
              </header>
              {sharing && (
                <div className={styles.share}>
                  <h2>Share {target === "artifact" ? "artifact" : "app"}</h2>
                  {target !== "service" ? (
                    <>
                      <p>
                        Create a public-reachable link. Anyone with the link can
                        view it until it expires.
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          setNotice(
                            "Preview only — would create an expiring artifact link.",
                          )
                        }
                      >
                        Create artifact link
                      </button>
                    </>
                  ) : vhosts ? (
                    <>
                      <p>
                        {reserved
                          ? `${hostname}.apps.example.com · Previously reserved`
                          : "Reserve an app address to serve this project."}
                      </p>
                      <p>
                        {limited
                          ? "Your administrator must enable serving. No address was changed."
                          : "Private link required by default. Review access before serving."}
                      </p>
                      <button type="button" onClick={settings}>
                        Review app address
                      </button>
                    </>
                  ) : (
                    <p>
                      Sharing this service is unavailable on this server. You
                      can still open it inside YA.
                    </p>
                  )}
                </div>
              )}
              {target === "service" && !running ? (
                <div className={styles.empty}>
                  <h2>Your app is stopped</h2>
                  <p>Start it to open Scooter parkour.</p>
                  <button
                    type="button"
                    className={styles.primary}
                    onClick={() => setRunning(true)}
                  >
                    Start app
                  </button>
                </div>
              ) : (
                <div className={styles.canvas}>
                  <div className={styles.appTitle}>
                    <span>SCOOTER PARKOUR</span>
                    <small>
                      {target === "artifact"
                        ? "A study in small jumps"
                        : "Type a world. Take it for a ride."}
                    </small>
                  </div>
                  <svg
                    viewBox="0 0 780 235"
                    role="img"
                    aria-label="A scooter rider jumping across letters"
                    className={styles.drawing}
                  >
                    <path
                      d="M0 199H780 M40 66h90m510-30h70m-170 52h100"
                      fill="none"
                      stroke="#cbd9ce"
                      strokeWidth="2"
                    />
                    <path
                      d="M0 200Q150 160 290 200T580 200T780 200V235H0"
                      fill="#e1e9de"
                    />
                    <text
                      x="35"
                      y="185"
                      fill="#467264"
                      fontSize="38"
                      fontFamily="Georgia,serif"
                    >
                      {words || "your words go here"}
                    </text>
                    <g transform="translate(350 42) rotate(-12)">
                      <circle
                        cx="0"
                        cy="115"
                        r="12"
                        fill="#f9fcf6"
                        stroke="#314e46"
                        strokeWidth="4"
                      />
                      <circle
                        cx="90"
                        cy="115"
                        r="12"
                        fill="#f9fcf6"
                        stroke="#314e46"
                        strokeWidth="4"
                      />
                      <path
                        d="M0 115h80l-8-68h-15"
                        fill="none"
                        stroke="#dc865a"
                        strokeWidth="6"
                        strokeLinecap="round"
                      />
                      <circle cx="38" cy="4" r="13" fill="#e5ba8b" />
                      <path d="M28 4q0-23 24-7" fill="#367663" />
                      <path
                        d="m35 23-8 35 27 24-16 29m-10-52-20 37 19 16m8-82 20 22 16-3"
                        fill="none"
                        stroke="#314e46"
                        strokeWidth="8"
                        strokeLinecap="round"
                      />
                      <path
                        d="m36 23-8 34"
                        stroke="#db9566"
                        strokeWidth="20"
                        strokeLinecap="round"
                      />
                    </g>
                    <path
                      d="m311 140 12-6m-23-8 17-5m182 62 7-12m4 22 12-5"
                      stroke="#9bbaab"
                      strokeWidth="2"
                    />
                  </svg>
                  <label className={styles.typing}>
                    Your world
                    <input
                      value={words}
                      onChange={(e) => setWords(e.target.value)}
                      placeholder="Type something to ride across…"
                    />
                  </label>
                  <span className={styles.canvasHint}>
                    ← → ride &nbsp; · &nbsp; Space to jump
                  </span>
                </div>
              )}
            </section>
          </div>
        )}
        {notice && (
          <p className={styles.notice} role="status">
            {notice}
          </p>
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <I18nProvider>
    <MemoryRouter>
      <ServiceMockup />
    </MemoryRouter>
  </I18nProvider>,
);
