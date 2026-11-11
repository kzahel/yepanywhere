import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { ProjectCard } from "../../src/components/ProjectCard";
import { I18nProvider } from "../../src/i18n";
import { UI_KEYS } from "../../src/lib/storageKeys";
import type { Project } from "../../src/types";
import "../../src/styles/purposeGlobals";
import styles from "./Projects.module.css";

const names = [
  "Yep Anywhere",
  "Documentation",
  "Mobile companion",
  "Relay service",
  "Design references",
  "Release notes",
  "Session archive",
  "Source review",
  "Provider adapters",
  "Browser tools",
  "Project queue",
  "Accessibility",
  "Local development",
  "Integration tests",
  "Translations",
  "Field notes",
];
/** Every third project keeps its caption and code name empty, so the card's
 * title-only shape is exercised beside the fully populated one. */
const projects: Project[] = names.map((name, index) => {
  const slug = name.toLowerCase().replaceAll(" ", "-");
  const sparse = index % 3 === 2;
  return {
    id: `fixture-${index}`,
    name,
    path: sparse
      ? `/workspace/${slug}`
      : `/workspace/long-enough-to-truncate/nested/${slug}`,
    codeName: sparse ? undefined : slug.slice(0, 3),
    caption: sparse
      ? undefined
      : {
          text: `What ${name.toLowerCase()} is for, in the one line a README or manifest gives us.`,
          source: index % 2 === 0 ? "readme" : "manifest",
        },
    sessionCount: 3 + index,
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
  };
});

function Projects() {
  const [selected, setSelected] = useState(
    new URLSearchParams(location.search).get("state") === "selected"
      ? "Yep Anywhere"
      : "",
  );
  const [removing, setRemoving] = useState("");
  const [items, setItems] = useState(projects);
  const route = useLocation();

  /** Inline edits stay in this preview; no project service is contacted. */
  const editProject = (id: string, change: Partial<Project>) =>
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, ...change } : item)),
    );
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Yep Anywhere · UI fixture</p>
          <h1>Project review</h1>
          <p>
            Real project cards with sample data. Use a card’s gear button to
            review its settings.
          </p>
        </div>
        <a href="./ya-mockup.json">Export manifest</a>
      </header>
      <p className={styles.feedback} role="status">
        {route.pathname !== "/"
          ? `Preview navigation: ${route.pathname}${route.search}`
          : selected
            ? `Settings selected: ${selected}`
            : removing
              ? `Removal requested: ${removing}. Nothing is removed in this preview.`
              : "Choose a project to review. Changes stay in this preview."}
      </p>
      <ul className={styles.grid} aria-label="Sample projects">
        {items.map((project, index) => (
          <ProjectCard
            key={project.id}
            project={project}
            needsAttentionCount={index === 0 ? 2 : 0}
            thinkingCount={0}
            queueCount={index === 0 ? 3 : 0}
            onOpenSettings={(item) => setSelected(item.name)}
            onDeleteProject={(item) => setRemoving(item.name)}
            onUpdateCodeName={async (item, codeName) => {
              editProject(item.id, { codeName });
            }}
            onUpdateCaption={async (item, caption) => {
              editProject(item.id, {
                caption: caption
                  ? { text: caption, source: "override" }
                  : undefined,
              });
            }}
          />
        ))}
      </ul>
      <footer className={styles.footer}>
        End of sample projects. No provider or project service is connected.
      </footer>
    </main>
  );
}

localStorage.setItem(UI_KEYS.locale, "en");
createRoot(document.getElementById("root")!).render(
  <I18nProvider>
    <MemoryRouter>
      <Projects />
    </MemoryRouter>
  </I18nProvider>,
);
