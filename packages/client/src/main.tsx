import { Fragment, StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Toggle to disable StrictMode for easier debugging (avoids double renders)
const STRICT_MODE = false;
const Wrapper = STRICT_MODE ? StrictMode : Fragment;
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { App } from "./App";
import { initializeFontSize } from "./hooks/useFontSize";
import { initializeTheme } from "./hooks/useTheme";
import { NavigationLayout } from "./layouts";
import { ActivityPage } from "./pages/ActivityPage";
import { AgentsPage } from "./pages/AgentsPage";
import { BeadsPage } from "./pages/BeadsPage";
import { FilePage } from "./pages/FilePage";
import { GlobalSessionsPage } from "./pages/GlobalSessionsPage";
import { InboxPage } from "./pages/InboxPage";
import { LoginPage } from "./pages/LoginPage";
import { NewSessionPage } from "./pages/NewSessionPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { SessionPage } from "./pages/SessionPage";
import { SettingsPage } from "./pages/SettingsPage";
import "./styles/index.css";

// Apply saved preferences before React renders to avoid flash
initializeTheme();
initializeFontSize();

// SSE activity stream connection is managed by useActivityBusConnection hook
// in App.tsx, which connects only when authenticated (or auth is disabled)

// Get base URL for router (Vite sets this based on --base flag)
// Remove trailing slash for BrowserRouter basename
const basename = import.meta.env.BASE_URL.replace(/\/$/, "") || undefined;

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <Wrapper>
    <BrowserRouter basename={basename}>
      <App>
        <Routes>
          <Route path="/" element={<Navigate to="/projects" replace />} />
          {/* Login page (no layout wrapper) */}
          <Route path="/login" element={<LoginPage />} />
          {/* All pages share NavigationLayout for persistent sidebar */}
          <Route element={<NavigationLayout />}>
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/sessions" element={<GlobalSessionsPage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/tasks" element={<BeadsPage />} />
            <Route path="/inbox" element={<InboxPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            {/* Project-scoped pages */}
            <Route
              path="/projects/:projectId"
              element={<Navigate to="/sessions" replace />}
            />
            <Route path="/new-session" element={<NewSessionPage />} />
            <Route
              path="/projects/:projectId/sessions/:sessionId"
              element={<SessionPage />}
            />
          </Route>
          {/* File page has its own layout (no sidebar) */}
          <Route path="/projects/:projectId/file" element={<FilePage />} />
          {/* Activity page has its own layout */}
          <Route path="/activity" element={<ActivityPage />} />
        </Routes>
      </App>
    </BrowserRouter>
  </Wrapper>,
);
