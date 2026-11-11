import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { AddProjectForm } from "../../src/components/AddProjectForm";
import { I18nProvider } from "../../src/i18n";
import "../../src/styles/purposeGlobals";
import styles from "./Placement.module.css";

const templates = [
  {
    id: "app-canvas",
    title: "App canvas",
    description: "Drawing, games & interactive apps",
    mark: "M4 17 Q7 3 12 12 T21 6 M5 20h14",
  },
  {
    id: "web-page",
    title: "Web page",
    description: "Sites, articles & collections",
    mark: "M4 3h16v18H4z M7 7h10 M7 11h10 M7 15h6",
  },
  {
    id: "storybook",
    title: "Storybook",
    description: "Illustrated stories & picture books",
    mark: "M12 5Q6 2 2 5v15q4-3 10 0 6-3 10 0V5q-4-3-10 0z M12 5v15",
  },
];

function Placement() {
  const [screen, setScreen] = useState("project");
  const [mode, setMode] = useState("template");
  const [template, setTemplate] = useState("app-canvas");
  const [name, setName] = useState("");
  const [intent, setIntent] = useState("");
  const [parent, setParent] = useState("~/projects");
  const [project, setProject] = useState("Yep Anywhere");
  const [search, setSearch] = useState("");
  const [menu, setMenu] = useState(false);
  const [creating, setCreating] = useState(false);
  const [single, setSingle] = useState(false);
  const [notice, setNotice] = useState("");
  const session = screen === "session";
  const selected = templates.find((item) => item.id === template)!;
  const choices = single ? templates.slice(0, 1) : templates;
  const leaf = name.trim().replace(/\s+/g, "-");
  const expand = () => {
    if (search.trim()) setName(search.trim());
    setCreating(true);
    setMenu(false);
  };
  const palette = (
    <fieldset className={styles.palette}>
      <legend>Project template</legend>
      <div className={styles.cards}>
        {choices.map((item) => (
          <label key={item.id} className={styles.card}>
            <input
              type="radio"
              name="template"
              value={item.id}
              checked={item.id === template}
              onChange={() => setTemplate(item.id)}
            />
            <span className={styles.mark} aria-hidden="true">
              <svg
                width="24"
                height="24"
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d={item.mark} />
              </svg>
            </span>
            <span>
              <strong>{item.title}</strong>
              <small>{item.description}</small>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
  const projectFields = (
    <>
      <label className={styles.field}>
        Project name
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Sketch garden"
        />
      </label>
      {palette}
      <details className={styles.location}>
        <summary>
          Create in{" "}
          <span>
            {parent}/{leaf || "project-name"}
          </span>
        </summary>
        <label className={styles.field}>
          Parent directory
          <input
            value={parent}
            onChange={(event) => setParent(event.target.value)}
          />
        </label>
      </details>
    </>
  );
  return (
    <div className={styles.page}>
      <nav className={styles.review} aria-label="Mockup views">
        <span>Placement preview</span>
        <button
          type="button"
          aria-pressed={!session}
          onClick={() => {
            setScreen("project");
            setNotice("");
          }}
        >
          New project
        </button>
        <button
          type="button"
          aria-pressed={session}
          onClick={() => {
            setScreen("session");
            setNotice("");
          }}
        >
          New session
        </button>
        <label>
          <input
            type="checkbox"
            checked={single}
            onChange={(event) => {
              setSingle(event.target.checked);
              setTemplate("app-canvas");
            }}
          />{" "}
          One template
        </label>
      </nav>
      <header className={styles.header}>
        <strong>Yep Anywhere</strong>
        <span>
          Projects <span aria-hidden="true">/</span>{" "}
          {session ? "New session" : "New project"}
        </span>
      </header>
      <main className={styles.main}>
        <h1>{session ? "New session" : "New project"}</h1>
        {!session && (
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
        {!session && mode === "existing" ? (
          <AddProjectForm
            projects={[]}
            pathBase="~/projects"
            chooseName
            chooseCodeName
            adding={false}
            error={null}
            onCancel={() => setMode("template")}
            onSubmit={() =>
              setNotice("Preview only — no directory registered.")
            }
          />
        ) : (
          <div className={styles.panel}>
            {session ? (
              <>
                <div className={styles.projectRow}>
                  <div className={styles.chooser}>
                    <span className={styles.label}>Project</span>
                    <button
                      type="button"
                      className={styles.trigger}
                      aria-expanded={menu}
                      aria-controls="project-menu"
                      onClick={() => setMenu(!menu)}
                    >
                      <span>
                        {creating ? name || "New project" : project}
                        <small>
                          {creating ? `New · ${selected.title}` : "~/ya"}
                        </small>
                      </span>
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        aria-hidden="true"
                      >
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </button>
                    {menu && (
                      <div id="project-menu" className={styles.menu}>
                        <label className={styles.field}>
                          Find or name a project
                          <input
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            placeholder="Project name…"
                            onKeyDown={(event) => {
                              if (event.key === "Escape") setMenu(false);
                              if (event.key === "Enter" && search.trim())
                                expand();
                            }}
                          />
                        </label>
                        {["Yep Anywhere", "Garden journal"]
                          .filter((item) =>
                            item.toLowerCase().includes(search.toLowerCase()),
                          )
                          .map((item) => (
                            <button
                              type="button"
                              key={item}
                              onClick={() => {
                                setProject(item);
                                setCreating(false);
                                setMenu(false);
                              }}
                            >
                              {item}
                            </button>
                          ))}
                        <button
                          type="button"
                          className={styles.createOption}
                          onClick={expand}
                        >
                          +{" "}
                          {search.trim()
                            ? `Create “${search.trim()}”`
                            : "New project…"}
                        </button>
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    className={styles.quickCreate}
                    aria-expanded={creating}
                    onClick={() => {
                      setCreating(!creating);
                      setMenu(false);
                    }}
                  >
                    + New project
                  </button>
                </div>
                {creating && (
                  <section
                    className={styles.expansion}
                    aria-label="New project details"
                  >
                    <div className={styles.expansionHeading}>
                      <strong>New project</strong>
                      <button type="button" onClick={() => setCreating(false)}>
                        Use existing
                      </button>
                    </div>
                    {projectFields}
                  </section>
                )}
              </>
            ) : (
              projectFields
            )}
            <label className={styles.field}>
              {!session || creating ? "What are you making?" : "Message"}
              <textarea
                rows={3}
                value={intent}
                onChange={(event) => setIntent(event.target.value)}
                placeholder="e.g. A drawing app with colorful brushes for making little gardens"
              />
            </label>
            <div className={styles.options}>
              <label className={styles.field}>
                Provider
                <select defaultValue="Codex">
                  <option>Codex</option>
                  <option>Claude</option>
                </select>
              </label>
              <label className={styles.field}>
                Model
                <select defaultValue="Default">
                  <option>Default</option>
                </select>
              </label>
              <label className={styles.field}>
                Effort
                <select defaultValue="Medium">
                  <option>Medium</option>
                  <option>High</option>
                </select>
              </label>
            </div>
            {(!session || creating) && (
              <p className={styles.hint}>
                Creates the starter, then starts one session to prepare it using
                your description.
              </p>
            )}
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.primary}
                disabled={(!session || creating) && (!leaf || !parent.trim())}
                onClick={() =>
                  setNotice(
                    !session || creating
                      ? `Preview: create ${name} from ${selected.title}, then prepare it in one session.`
                      : `Preview: start a session in ${project}.`,
                  )
                }
              >
                {!session || creating ? "Create & prepare" : "Start session"}
              </button>
            </div>
          </div>
        )}
        {notice && (
          <p role="status" className={styles.notice}>
            {notice}
          </p>
        )}
        <p className={styles.footnote}>
          Interactive mockup · No projects or sessions are created. Symbols
          illustrate the proposed template icons; library thumbnails are a
          separate sketch.
        </p>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <I18nProvider>
    <MemoryRouter>
      <Placement />
    </MemoryRouter>
  </I18nProvider>,
);
