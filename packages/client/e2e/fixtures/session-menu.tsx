import sidebarStyles from "../../src/components/Sidebar.module.css";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { SessionListItem } from "../../src/components/SessionListItem";
import { I18nProvider } from "../../src/i18n";
import "../../src/styles/purposeGlobals";

function Fixture() {
  const location = useLocation();
  return (
    <main
      style={{
        width: 310,
        maxWidth: "100%",
        padding: 12,
        boxSizing: "border-box",
        background: "var(--bg-surface)",
      }}
    >
      <h2>Starred</h2>
      <ul className={sidebarStyles.sidebarSessionList}>
        {Array.from({ length: 16 }, (_, index) => (
          <SessionListItem
            key={index}
            sessionId={`session-${index}`}
            projectId="project"
            title={`Investigate mobile session menus ${index}`}
            mode="compact"
            provider="claude"
            isStarred
            lastAgentText="Completed investigation."
            projectName={index % 2 ? "yepanywhere" : "machine-control"}
            showProjectName
          />
        ))}
      </ul>
      <ul style={{ listStyle: "none", padding: 0 }}>
        <SessionListItem
          sessionId="card"
          projectId="project"
          title="Session card"
          lastAgentText="Completed investigation."
          mode="card"
          provider="claude"
        />
      </ul>
      <output aria-label="Opened session">{location.pathname}</output>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <I18nProvider>
    <MemoryRouter>
      <Fixture />
    </MemoryRouter>
  </I18nProvider>,
);
