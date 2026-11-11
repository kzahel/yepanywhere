import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { AddProjectForm } from "../../src/components/AddProjectForm";
import { I18nProvider } from "../../src/i18n";
import { SettingsSection } from "../../src/pages/settings/SettingsSection";
import "../../src/styles/purposeGlobals";
import styles from "./Templates.module.css";
import { AppReservations } from "./AppReservations";

type Screen = "create" | "users" | "limited" | "apps";
type Permission = "selected" | "any" | "none";

const templateExamples = [
  {
    id: "app-canvas",
    title: "App canvas",
    summary: "Drawing, games and interactive apps.",
    detail: "A working canvas for drawing, games and little interactive apps.",
    source: "Vite + TypeScript · YA default",
  },
  {
    id: "web-page",
    title: "Web page",
    summary: "A site for an idea, story or collection.",
    detail:
      "A home for your words, stories and media, with room for interaction.",
    source: "Vite + TypeScript · Content & stories",
  },
];

function Proposal() {
  const requested = new URLSearchParams(location.search).get("screen");
  const [screen, setScreen] = useState<Screen>(
    requested === "users" || requested === "limited" || requested === "apps"
      ? requested
      : "create",
  );
  const [mode, setMode] = useState("template");
  const [permission, setPermission] = useState<Permission>("selected");
  const [allowed, setAllowed] = useState(true);
  const [multiple, setMultiple] = useState(false);
  const [pageAllowed, setPageAllowed] = useState(true);
  const [chosenTemplate, setChosenTemplate] = useState("app-canvas");
  const [name, setName] = useState("");
  const [intent, setIntent] = useState("");
  const [parent, setParent] = useState("~/projects");
  const [userRoot, setUserRoot] = useState("~/alex");
  const [projectOnly, setProjectOnly] = useState(false);
  const [stage, setStage] = useState("form");
  const [notice, setNotice] = useState("");
  const limited = screen === "limited";
  const targetRoot = limited ? userRoot : parent;
  const inventory = multiple ? templateExamples : templateExamples.slice(0, 1);
  const permitted = inventory.filter(
    (item) =>
      permission === "any" ||
      (permission === "selected" &&
        (item.id === "app-canvas" ? allowed : pageAllowed)),
  );
  const choices = limited ? permitted : inventory;
  const canCreate = choices.length > 0;
  const selected =
    choices.find((item) => item.id === chosenTemplate) ??
    choices[0] ??
    templateExamples[0]!;
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const changeScreen = (next: Screen) => {
    setScreen(next);
    setStage("form");
    setNotice("");
  };
  return (
    <div className={styles.page}>
      <nav className={styles.review} aria-label="Mockup views">
        <span>Design preview</span>
        {(
          [
            ["create", "New project"],
            ["users", "User settings"],
            ["limited", "As limited user"],
            ["apps", "App names"],
          ] as const
        ).map(([key, title]) => (
          <button
            key={key}
            type="button"
            aria-pressed={screen === key}
            onClick={() => changeScreen(key)}
          >
            {title}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={multiple}
          onClick={() => {
            setMultiple(!multiple);
            setStage("form");
          }}
        >
          Show template choices
        </button>
      </nav>
      {multiple && (
        <p className={styles.sampleNotice}>
          Preview scenario: App canvas and Web page are both enabled.
        </p>
      )}
      <header className={styles.header}>
        <strong>Yep Anywhere</strong>
        <span>
          {screen === "users"
            ? "Settings / Users / alex"
            : screen === "apps"
              ? "Settings / Apps"
              : "Projects / New project"}
        </span>
      </header>
      {screen === "apps" ? (
        <AppReservations />
      ) : screen === "users" ? (
        <main className={styles.settings}>
          <h1>Edit alex</h1>
          <p className={styles.muted}>
            Limited user · Sessions always run sandboxed
          </p>
          <details className={styles.account}>
            <summary>
              Account &amp; session settings{" "}
              <small>
                Password, provider/model/effort locks, join freshness
              </small>
            </summary>
            <label className={styles.field}>
              New password
              <input
                type="password"
                placeholder="Leave blank to keep current password"
                autoComplete="new-password"
              />
            </label>
            <label className={styles.field}>
              Provider lock
              <select defaultValue="">
                <option value="">Not locked</option>
                <option>Codex</option>
                <option>Claude</option>
              </select>
            </label>
            <label className={styles.field}>
              Model lock
              <input placeholder="Not locked" />
            </label>
            <label className={styles.field}>
              Effort lock
              <select defaultValue="">
                <option value="">Not locked</option>
                <option>low</option>
                <option>medium</option>
                <option>high</option>
              </select>
            </label>
            <label className={styles.field}>
              Join freshness offset (minutes)
              <input type="number" defaultValue={0} min={-5} max={60} />
            </label>
          </details>
          <details className={styles.account}>
            <summary>
              Project access{" "}
              <small>One view-only grant · Own projects remain available</small>
            </summary>
            <label className={styles.field}>
              morgan / Space game
              <select defaultValue="view">
                <option value="none">No access</option>
                <option value="view">View only</option>
                <option value="join">Join existing sessions</option>
                <option value="new">Start sessions</option>
              </select>
            </label>
            <p className={styles.muted}>
              These grants control YA project and session access. In Current
              project only mode, a Start sessions grant also permits writes in
              that project, even outside the personal directory.
            </p>
          </details>
          <SettingsSection
            title="Workspace & sandbox"
            description="One personal directory for new projects and the default writable workspace."
          >
            <label className={styles.field}>
              Create in
              <input
                value={userRoot}
                onChange={(e) => setUserRoot(e.target.value)}
              />
              <small>
                Defaults to ~/username. You can choose another directory.
              </small>
            </label>
            <fieldset className={styles.permissions}>
              <legend>Session write access</legend>
              <label className={styles.option}>
                <input
                  type="radio"
                  name="sandbox"
                  checked={!projectOnly}
                  onChange={() => setProjectOnly(false)}
                />
                <span>
                  <strong>Personal directory</strong>
                  <small>
                    Can work across projects in{" "}
                    {userRoot || "the configured directory"}.
                  </small>
                </span>
              </label>
              <label className={styles.option}>
                <input
                  type="radio"
                  name="sandbox"
                  checked={projectOnly}
                  onChange={() => setProjectOnly(true)}
                />
                <span>
                  <strong>Current project only</strong>
                  <small>A stricter boundary for each session.</small>
                </span>
              </label>
            </fieldset>
            <p className={styles.note}>
              {projectOnly
                ? "Writes stay inside the active project, including an outside project with a new-session grant."
                : `Writes stay inside ${userRoot || "the configured directory"}.`}{" "}
              Other host files remain readable. This setting is locked for every
              session.
            </p>
          </SettingsSection>
          <SettingsSection
            title="New projects"
            description="Choose what alex can create. Existing project access is managed separately."
          >
            <fieldset className={styles.permissions}>
              <legend>Allowed templates</legend>
              {(
                [
                  ["none", "None", "Cannot create projects."],
                  [
                    "selected",
                    "Selected templates",
                    "Only the templates checked below.",
                  ],
                  [
                    "any",
                    "Any configured template",
                    "Includes templates you enable later.",
                  ],
                ] as const
              ).map(([value, title, hint]) => (
                <label key={value} className={styles.option}>
                  <input
                    type="radio"
                    name="permission"
                    value={value}
                    checked={permission === value}
                    onChange={() => {
                      setPermission(value);
                      setNotice("");
                    }}
                  />
                  <span>
                    <strong>{title}</strong>
                    <small>{hint}</small>
                  </span>
                </label>
              ))}
            </fieldset>
            {permission === "selected" && (
              <label className={styles.templateCheck}>
                <input
                  type="checkbox"
                  checked={allowed}
                  onChange={(e) => setAllowed(e.target.checked)}
                />
                <span>
                  <strong>App canvas</strong>
                  <small>YA default · Static app; add a server later</small>
                </span>
              </label>
            )}
            {permission === "selected" && multiple && (
              <label className={styles.templateCheck}>
                <input
                  type="checkbox"
                  checked={pageAllowed}
                  onChange={(e) => setPageAllowed(e.target.checked)}
                />
                <span>
                  <strong>Web page</strong>
                  <small>Content &amp; stories · Optional server</small>
                </span>
              </label>
            )}
            <p className={styles.note}>
              {permitted.length === 0
                ? "Alex cannot create new projects. Existing access stays unchanged."
                : permission === "selected"
                  ? permitted.length === 1
                    ? `${permitted[0]!.title} is applied automatically: alex will only enter a name and description.`
                    : "Alex can choose between the selected templates."
                  : "Alex can choose from every enabled template, including future additions."}
            </p>
            <p className={styles.muted}>
              New limited users start with App canvas selected.
            </p>
            <button
              className={styles.primary}
              type="button"
              onClick={() =>
                setNotice(
                  "Saved in this preview. Open “As limited user” to try these permissions.",
                )
              }
            >
              Save changes
            </button>
          </SettingsSection>
        </main>
      ) : (
        <main>
          <div className={styles.heading}>
            <h1>
              {stage === "form" ? (
                "New project"
              ) : (
                <>
                  {limited && <span className={styles.muted}>alex / </span>}
                  {name}
                </>
              )}
            </h1>
            <p className={styles.muted}>
              {limited
                ? "Creating as alex"
                : "Start with a working app, or connect a directory you already have."}
            </p>
          </div>
          {!canCreate ? (
            <div className={styles.panel}>
              <h2>Project creation is unavailable</h2>
              <p>Your administrator hasn’t enabled a template for you.</p>
            </div>
          ) : stage !== "form" ? (
            <div className={styles.result}>
              <section className={styles.panel}>
                <span className={styles.badge}>Starter available</span>
                <h2>{name}</h2>
                <p>{intent}</p>
                <figure
                  className={styles.canvas}
                  aria-label="Illustrative starter canvas"
                >
                  <svg
                    viewBox="0 0 360 170"
                    role="img"
                    aria-label="Colorful drawing"
                  >
                    <path
                      d="M35 130 Q65 10 110 90 T200 70 T320 115"
                      fill="none"
                      stroke="#b999ff"
                      strokeWidth="12"
                      strokeLinecap="round"
                    />
                    <path
                      d="M90 130 Q180 25 270 130"
                      fill="none"
                      stroke="#64c8a5"
                      strokeWidth="9"
                      strokeLinecap="round"
                    />
                  </svg>
                  <small>App preview · illustrative</small>
                </figure>
              </section>
              <section className={styles.panel}>
                <span className={styles.badge}>
                  {stage === "ready" ? "Ready to build" : "Preparing project…"}
                </span>
                <h2>First session</h2>
                <p>
                  The starter is already available while your agent prepares the
                  project.
                </p>
                <div className={styles.note}>
                  Customize the project instructions for:
                  <blockquote>{intent}</blockquote>Update the README summary,
                  verify run, tests and build, then report readiness.
                </div>
                <p className={styles.muted}>
                  Uses your session provider and model settings.
                </p>
                <button type="button" onClick={() => setStage("ready")}>
                  Simulate verification complete
                </button>
                <p>
                  <button type="button" onClick={() => setStage("form")}>
                    Back to form
                  </button>
                </p>
              </section>
            </div>
          ) : (
            <>
              {!limited && (
                <div className={styles.tabs}>
                  <button
                    type="button"
                    aria-pressed={mode === "template"}
                    onClick={() => setMode("template")}
                  >
                    From template
                  </button>
                  <button
                    type="button"
                    aria-pressed={mode === "existing"}
                    onClick={() => setMode("existing")}
                  >
                    Existing directory
                  </button>
                </div>
              )}
              {!limited && mode === "existing" ? (
                <div
                  className={styles.panel}
                  onClickCapture={(event) => {
                    const target = event.target;
                    if (
                      target instanceof Element &&
                      target.closest('button[type="submit"]')
                    ) {
                      event.preventDefault();
                      setNotice(
                        "Existing directory registration is simulated in this preview.",
                      );
                    }
                  }}
                >
                  <AddProjectForm
                    projects={[]}
                    chooseName
                    chooseCodeName
                    adding={false}
                    error={null}
                    onCancel={() => setMode("template")}
                    onSubmit={() =>
                      setNotice(
                        "Existing directory registration is simulated in this preview.",
                      )
                    }
                  />
                </div>
              ) : (
                <>
                  {choices.length > 1 && (
                    <fieldset className={styles.picker}>
                      <legend>Choose a template</legend>
                      <div className={styles.pickerCards}>
                        {choices.map((item) => (
                          <label
                            key={item.id}
                            className={styles.templateChoice}
                          >
                            <input
                              type="radio"
                              name="template"
                              checked={selected.id === item.id}
                              onChange={() => setChosenTemplate(item.id)}
                            />
                            <span>
                              <strong>{item.title}</strong>
                              <small>{item.summary}</small>
                            </span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  )}
                  <div
                    className={styles.columns}
                    data-choices={choices.length > 1}
                  >
                    <section className={styles.panel}>
                      <label className={styles.field}>
                        Project name
                        <input
                          required
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          placeholder="e.g. Sketch garden"
                        />
                      </label>
                      <label className={styles.field}>
                        What are you making?
                        <textarea
                          rows={2}
                          value={intent}
                          onChange={(e) => setIntent(e.target.value)}
                          placeholder="e.g. A drawing app with colorful brushes for making little gardens"
                        />
                      </label>
                      {!limited && (
                        <label className={styles.field}>
                          Create in
                          <input
                            required
                            value={parent}
                            onChange={(e) => setParent(e.target.value)}
                          />
                        </label>
                      )}
                      <p className={styles.path}>
                        {targetRoot}/{slug || "project-name"}
                      </p>
                      <p className={styles.note}>
                        Your app opens as soon as setup finishes. An agent then
                        uses your description to prepare the instructions and
                        verify run, tests and build.
                      </p>
                      <button
                        className={styles.primary}
                        type="button"
                        onClick={() => setStage("preparing")}
                        disabled={!slug || !targetRoot.trim()}
                      >
                        Create &amp; prepare
                      </button>
                    </section>
                    <aside className={styles.panel}>
                      <span className={styles.badge}>
                        {choices.length > 1
                          ? "Selected template"
                          : limited
                            ? "Applied automatically"
                            : "Included template"}
                      </span>
                      <h2>{selected.title}</h2>
                      <p>{selected.detail}</p>
                      <div className={styles.miniCanvas}>
                        <svg
                          viewBox="0 0 280 90"
                          role="img"
                          aria-label="Canvas illustration"
                        >
                          <path
                            d="M20 65 Q65 -10 115 50 T255 35"
                            fill="none"
                            stroke="#b999ff"
                            strokeWidth="10"
                            strokeLinecap="round"
                          />
                          <circle cx="220" cy="65" r="9" fill="#64c8a5" />
                        </svg>
                      </div>
                      <ul>
                        <li>Static app, ready to preview</li>
                        <li>Run, test and build included</li>
                        <li>Add a server when you need one</li>
                      </ul>
                      <p className={styles.muted}>{selected.source}</p>
                      <details>
                        <summary>How preparation works</summary>
                        <p>
                          Setup creates the working starter first. The first
                          agent turn adapts its AGENTS instructions and README
                          to your description, checks the commands, and reports
                          readiness to build your app.
                        </p>
                      </details>
                    </aside>
                  </div>
                </>
              )}
            </>
          )}
        </main>
      )}
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      <footer className={styles.footer}>
        Interactive mockup · Changes stay here. No projects or sessions are
        created.
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <I18nProvider>
    <MemoryRouter>
      <Proposal />
    </MemoryRouter>
  </I18nProvider>,
);
