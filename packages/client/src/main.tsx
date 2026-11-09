import "./lib/developmentPerformanceBootstrap";
import { Fragment, lazy, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

// Toggle to disable StrictMode for easier debugging (avoids double renders)
const STRICT_MODE = false;
const Wrapper = STRICT_MODE ? StrictMode : Fragment;
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { PrebootComposerRetirement } from "./components/PrebootComposerRetirement";
import { RouteModule, routeModule } from "./components/RouteModule";
import { ConfirmDialogHost } from "./components/ui/ConfirmDialog";
import { TooltipLayer } from "./components/ui/TooltipLayer";
import { initializeFontSize } from "./hooks/useFontSize";
import { initializeSidebarSpacing } from "./hooks/useSidebarSpacing";
import { initializeContentMaxWidth } from "./hooks/useContentMaxWidth";
import { initializeOutputAppearance } from "./hooks/useOutputAppearance";
import { initializeTabSize } from "./hooks/useTabSize";
import { initializeTheme } from "./hooks/useTheme";
import { initializeTooltipAppearance } from "./hooks/useTooltipAppearance";
import { initializeUnicodeProseMath } from "./lib/unicodeProseMath";
import { I18nProvider, useI18n } from "./i18n";
import { installFontDiagnostics } from "./lib/diagnostics/fontDiagnostics";
import { installModifierChordTracking } from "./lib/modifierChords";
import { preloadableComponent } from "./lib/preloadableComponent";
import "./styles/index.css";

const App = preloadableComponent(async () => ({
  default: (await import("./App")).App,
}));
const ConversationPreviewPage = lazy(() =>
  import("./pages/ConversationPreviewPage").then(
    ({ ConversationPreviewPage }) => ({ default: ConversationPreviewPage }),
  ),
);

/** The experimental client owns its connections without the full app runtime. */
function LocalAppShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return /^\/-\/preview\/?$/.test(pathname) ? children : <App>{children}</App>;
}
const NavigationLayout = preloadableComponent(async () => ({
  default: (await import("./layouts")).NavigationLayout,
}));
const SessionDomLingerRouteMarker = lazy(() =>
  import("./layouts").then(({ SessionDomLingerRouteMarker }) => ({
    default: SessionDomLingerRouteMarker,
  })),
);
const ActivityPage = lazy(() =>
  import("./pages/ActivityPage").then(({ ActivityPage }) => ({
    default: ActivityPage,
  })),
);
const AgentsPage = lazy(() =>
  import("./pages/AgentsPage").then(({ AgentsPage }) => ({
    default: AgentsPage,
  })),
);
const IssuesPage = lazy(() =>
  import("./pages/IssuesPage").then((m) => ({ default: m.IssuesPage })),
);
const BangCommandsPage = lazy(() =>
  import("./pages/BangCommandsPage").then(({ BangCommandsPage }) => ({
    default: BangCommandsPage,
  })),
);
const EmulatorPage = lazy(() =>
  import("./pages/EmulatorPage").then(({ EmulatorPage }) => ({
    default: EmulatorPage,
  })),
);
const FilePage = lazy(() =>
  import("./pages/FilePage").then(({ FilePage }) => ({ default: FilePage })),
);
const LocalSourcePage = lazy(() =>
  import("./pages/LocalSourcePage").then(({ LocalSourcePage }) => ({
    default: LocalSourcePage,
  })),
);
const ViewerModePage = lazy(() =>
  import("./pages/ViewerModePage").then(({ ViewerModePage }) => ({
    default: ViewerModePage,
  })),
);
const GitStatusPage = lazy(() =>
  import("./pages/GitStatusPage").then(({ GitStatusPage }) => ({
    default: GitStatusPage,
  })),
);
const GlobalSessionsPage = lazy(() =>
  import("./pages/GlobalSessionsPage").then(({ GlobalSessionsPage }) => ({
    default: GlobalSessionsPage,
  })),
);
const InboxPage = lazy(() =>
  import("./pages/InboxPage").then(({ InboxPage }) => ({
    default: InboxPage,
  })),
);
const LoginPage = lazy(() =>
  import("./pages/LoginPage").then(({ LoginPage }) => ({
    default: LoginPage,
  })),
);
const NewSessionPage = preloadableComponent(async () => ({
  default: (await import("./pages/NewSessionPage")).NewSessionPage,
}));
const ProjectAppPage = lazy(() =>
  import("./pages/ProjectAppPage").then(({ ProjectAppPage }) => ({
    default: ProjectAppPage,
  })),
);
const ProjectsPage = lazy(() =>
  import("./pages/ProjectsPage").then(({ ProjectsPage }) => ({
    default: ProjectsPage,
  })),
);
const SessionPage = lazy(() =>
  import("./pages/SessionPage").then(({ SessionPage }) => ({
    default: SessionPage,
  })),
);
const ProviderChildSessionPage = lazy(() =>
  import("./pages/ProviderChildSessionPage").then(
    ({ ProviderChildSessionPage }) => ({
      default: ProviderChildSessionPage,
    }),
  ),
);
const SettingsLayout = lazy(() =>
  import("./pages/settings").then(({ SettingsLayout }) => ({
    default: SettingsLayout,
  })),
);
const ProviderSignInPage = lazy(() =>
  import("./pages/ProviderSignInPage").then((m) => ({
    default: m.ProviderSignInPage,
  })),
);
/**
 * Dev-only notice shown when the app is loaded directly from the Vite dev port
 * instead of through the main server. Rendered before theme init, so it uses
 * self-contained inline styles rather than relying on app CSS variables.
 */
function WrongPortNotice({ backendUrl }: { backendUrl: string }) {
  const { t } = useI18n();
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        boxSizing: "border-box",
        fontFamily: "system-ui, -apple-system, sans-serif",
        background: "#0f1115",
        color: "#e6e6e6",
      }}
    >
      <div
        style={{
          maxWidth: 460,
          width: "100%",
          border: "1px solid #2a2f3a",
          borderRadius: 12,
          padding: "28px 28px 24px",
          background: "#161a22",
          boxShadow: "0 8px 30px rgba(0,0,0,0.35)",
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: 0.4,
            color: "#8aa0ff",
            textTransform: "uppercase",
            marginBottom: 10,
          }}
        >
          {t("wrongPortLabel")}
        </div>
        <h1 style={{ fontSize: 20, fontWeight: 650, margin: "0 0 10px" }}>
          {t("wrongPortTitle")}
        </h1>
        <p
          style={{
            fontSize: 14,
            lineHeight: 1.55,
            margin: "0 0 20px",
            color: "#b6bcc8",
          }}
        >
          {t("wrongPortBody", { port: __VITE_DEV_PORT__ })}
        </p>
        <a
          href={backendUrl}
          style={{
            display: "inline-block",
            padding: "10px 16px",
            borderRadius: 8,
            background: "#3b6cf6",
            color: "#fff",
            fontSize: 14,
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          {t("wrongPortOpen")}
        </a>
        <div
          style={{
            marginTop: 14,
            fontSize: 12.5,
            color: "#7a8290",
            wordBreak: "break-all",
          }}
        >
          {backendUrl}
        </div>
      </div>
    </div>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

// Direct access to the Vite dev server port (e.g. localhost:3402) serves the SPA
// shell but has no backend/API — the first /api fetch returns index.html and the
// app dies with a confusing "Unexpected token '<'" JSON error. The main server
// (port 3400) proxies to Vite, so when accessed correctly window.location.port is
// the backend port, not the Vite port. Detect the wrong-port case and show a
// pointer to the real app instead. Stripped from production via import.meta.env.DEV.
if (import.meta.env.DEV && window.location.port === String(__VITE_DEV_PORT__)) {
  const backendUrl = `${window.location.protocol}//${window.location.hostname}:${__BACKEND_PORT__}${window.location.pathname}${window.location.search}${window.location.hash}`;
  createRoot(rootElement).render(
    <I18nProvider>
      <WrongPortNotice backendUrl={backendUrl} />
    </I18nProvider>,
  );
} else {
  installModifierChordTracking();
  // Apply saved preferences before React renders to avoid flash
  initializeTheme();
  initializeFontSize();
  initializeSidebarSpacing();
  initializeOutputAppearance();
  installFontDiagnostics();
  initializeTabSize();
  initializeContentMaxWidth();
  initializeTooltipAppearance();
  initializeUnicodeProseMath();

  // Register SW at startup so PWA install is available without visiting settings
  void import("./lib/registerServiceWorker").then(
    ({ registerServiceWorkerAtStartup }) => registerServiceWorkerAtStartup(),
  );

  if (import.meta.env.VITE_E2E_SOURCE_TRANSPORT_SMOKE === "true") {
    void import("./lib/e2e/sourceTransportCoexistenceSmoke").then(
      ({ installSourceTransportCoexistenceSmoke }) => {
        installSourceTransportCoexistenceSmoke();
      },
    );
  }

  // SSE activity stream connection is managed by useActivityBusConnection hook
  // in App.tsx, which connects only when authenticated (or auth is disabled)

  // Get base URL for router (Vite sets this based on --base flag)
  // Remove trailing slash for BrowserRouter basename
  const basename = import.meta.env.BASE_URL.replace(/\/$/, "") || undefined;

  const initialPath = basename
    ? window.location.pathname.slice(basename.length)
    : window.location.pathname;
  let initialModules: Promise<unknown> | undefined;
  // Start independent downloads before lazy ancestors can serialize them.
  // Route error boundaries retain ownership of any import failure's UI.
  if (/^\/settings(?:\/|$)/.test(initialPath)) {
    void Promise.allSettled([
      import("./App"),
      import("./layouts"),
      import("./pages/settings"),
    ]);
  } else if (/^\/new-session\/?$/.test(initialPath)) {
    initialModules = Promise.all([
      App.preload(),
      NavigationLayout.preload(),
      NewSessionPage.preload(),
    ]);
  }

  const app = (
    <Wrapper>
      <ErrorBoundary>
        <TooltipLayer />
        <BrowserRouter basename={basename}>
          <PrebootComposerRetirement />
          <I18nProvider>
            <ConfirmDialogHost />
            <RouteModule>
              <LocalAppShell>
                <Routes>
                  <Route
                    path="/-/preview"
                    element={routeModule(<ConversationPreviewPage local />)}
                  />
                  <Route
                    path="/"
                    element={<Navigate to="/projects" replace />}
                  />
                  {/* Login page (no layout wrapper) */}
                  <Route path="/login" element={routeModule(<LoginPage />)} />
                  {/* IMPORTANT: Keep routes in sync with remote-main.tsx — adding a route here? Add it there too! */}
                  <Route
                    element={
                      <RouteModule>
                        <NavigationLayout
                          sessionElement={(
                            route,
                            { parked, progressiveRenderPauseSignal },
                          ) => (
                            <RouteModule key={route.key}>
                              <SessionPage
                                projectId={route.projectId}
                                sessionId={route.sessionId}
                                routeLocation={route.location}
                                isDomLingerParked={parked}
                                progressiveRenderPauseSignal={
                                  progressiveRenderPauseSignal
                                }
                              />
                            </RouteModule>
                          )}
                        />
                      </RouteModule>
                    }
                  >
                    <Route
                      path="/projects"
                      element={routeModule(<ProjectsPage />)}
                    />
                    <Route
                      path="/sessions"
                      element={routeModule(<GlobalSessionsPage />)}
                    />
                    <Route
                      path="/agents"
                      element={routeModule(<AgentsPage />)}
                    />
                    <Route
                      path="/issues"
                      element={routeModule(<IssuesPage />)}
                    />
                    <Route path="/inbox" element={routeModule(<InboxPage />)} />
                    <Route
                      path="/settings"
                      element={routeModule(<SettingsLayout />)}
                    />
                    <Route
                      path="/settings/:category"
                      element={routeModule(<SettingsLayout />)}
                    />
                    {/* Project-scoped pages */}
                    <Route
                      path="/projects/:projectId/app"
                      element={routeModule(<ProjectAppPage />)}
                    />
                    <Route
                      path="/projects/:projectId"
                      element={<Navigate to="/sessions" replace />}
                    />
                    <Route
                      path="/git-status"
                      element={routeModule(<GitStatusPage />)}
                    />
                    <Route
                      path="/provider-sign-in/:provider"
                      element={routeModule(<ProviderSignInPage />)}
                    />
                    <Route
                      path="/bang-commands"
                      element={routeModule(<BangCommandsPage />)}
                    />
                    <Route
                      path="/devices"
                      element={routeModule(<EmulatorPage />)}
                    />
                    <Route
                      path="/devices/:deviceId"
                      element={routeModule(<EmulatorPage />)}
                    />
                    <Route
                      path="/new-session"
                      element={routeModule(<NewSessionPage />)}
                    />
                    <Route
                      path="/projects/:projectId/file"
                      element={routeModule(<FilePage />)}
                    />
                    <Route
                      path="/projects/:projectId/browse"
                      element={routeModule(<LocalSourcePage />)}
                    />
                    <Route
                      path="/file-view"
                      element={routeModule(<ViewerModePage />)}
                    />
                    <Route
                      path="/projects/:projectId/sessions/:sessionId"
                      element={routeModule(<SessionDomLingerRouteMarker />)}
                    />
                    <Route
                      path="/projects/:projectId/sessions/:sessionId/agents/:agentId"
                      element={routeModule(<ProviderChildSessionPage />)}
                    />
                  </Route>
                  {/* Activity page has its own layout */}
                  <Route
                    path="/activity"
                    element={routeModule(<ActivityPage />)}
                  />
                </Routes>
              </LocalAppShell>
            </RouteModule>
          </I18nProvider>
        </BrowserRouter>
      </ErrorBoundary>
    </Wrapper>
  );
  // The inline composer holds input while code loads. Mounting ready route
  // components avoids React's minimum fallback display delay on a fresh tab.
  const renderApp = () => createRoot(rootElement).render(app);
  if (initialModules) void initialModules.then(renderApp, renderApp);
  else renderApp();
}
