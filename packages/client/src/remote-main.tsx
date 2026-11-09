/**
 * Remote client entry point.
 *
 * This is a separate entry point for the remote (static) client that:
 * - Uses SecureConnection for all communication (SRP + NaCl encryption)
 * - Shows a login page before connecting
 * - Does NOT use cookie-based auth (uses SRP instead)
 *
 * Route structure:
 * - UnauthenticatedGate: wraps login routes, redirects to app if already connected
 * - ConnectionGate: wraps direct-mode app routes (no relay username in URL)
 * - RelayConnectionGate: wraps relay-mode app routes (/-/relay/:relayUsername/...)
 *
 * ConnectionGate and RelayConnectionGate share the same APP_ROUTES.
 * This avoids duplicating route definitions or provider wrapping.
 */

console.log("[RemoteClient] Loading remote-main.tsx entry point");

import "./lib/developmentPerformanceBootstrap";
import { Fragment, lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";

// Toggle to disable StrictMode for easier debugging (avoids double renders)
const STRICT_MODE = false;
const Wrapper = STRICT_MODE ? StrictMode : Fragment;

import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { PrebootComposerRetirement } from "./components/PrebootComposerRetirement";
import { RouteModule, routeModule } from "./components/RouteModule";
import { ConfirmDialogHost } from "./components/ui/ConfirmDialog";
import { TooltipLayer } from "./components/ui/TooltipLayer";
import { isExtensionPage } from "./extension/chrome";
import { initializeContentMaxWidth } from "./hooks/useContentMaxWidth";
import { initializeFontSize } from "./hooks/useFontSize";
import { initializeSidebarSpacing } from "./hooks/useSidebarSpacing";
import { initializeOutputAppearance } from "./hooks/useOutputAppearance";
import { initializeTabSize } from "./hooks/useTabSize";
import { initializeTheme } from "./hooks/useTheme";
import { initializeTooltipAppearance } from "./hooks/useTooltipAppearance";
import { initializeUnicodeProseMath } from "./lib/unicodeProseMath";
import { I18nProvider } from "./i18n";
import {
  getInitialRemoteRouteModuleKeys,
  type RemoteRouteModuleKey,
} from "./lib/remoteRoutePreload";
import { installModifierChordTracking } from "./lib/modifierChords";
import { installFontDiagnostics } from "./lib/diagnostics/fontDiagnostics";
import { loadSessionCoreModules } from "./lib/sessionRouteModules";
import { preloadableComponent } from "./lib/preloadableComponent";
import "./styles/index.css";

function cachedModule<T>(load: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined;
  return () => {
    promise ??= load();
    return promise;
  };
}

const loadRemoteAppModule = cachedModule(() => import("./RemoteApp"));
const loadLayoutsModule = cachedModule(() => import("./layouts"));
const loadActivityPageModule = cachedModule(
  () => import("./pages/ActivityPage"),
);
const loadAgentsPageModule = cachedModule(() => import("./pages/AgentsPage"));
const loadBangCommandsPageModule = cachedModule(
  () => import("./pages/BangCommandsPage"),
);
const loadDirectLoginPageModule = cachedModule(
  () => import("./pages/DirectLoginPage"),
);
const loadEmulatorPageModule = cachedModule(
  () => import("./pages/EmulatorPage"),
);
const loadFilePageModule = cachedModule(() => import("./pages/FilePage"));
const loadLocalSourcePageModule = cachedModule(
  () => import("./pages/LocalSourcePage"),
);
const loadGitStatusPageModule = cachedModule(
  () => import("./pages/GitStatusPage"),
);
const loadGlobalSessionsPageModule = cachedModule(
  () => import("./pages/GlobalSessionsPage"),
);
const loadHostPickerPageModule = cachedModule(
  () => import("./pages/HostPickerPage"),
);
const loadInboxPageModule = cachedModule(() => import("./pages/InboxPage"));
const loadIssuesPageModule = cachedModule(() => import("./pages/IssuesPage"));
const loadLegacyRelayRouteRedirectModule = cachedModule(
  () => import("./pages/LegacyRelayRouteRedirect"),
);
const ConversationPreviewPage = lazy(() =>
  import("./pages/ConversationPreviewPage").then(
    ({ ConversationPreviewPage }) => ({ default: ConversationPreviewPage }),
  ),
);
const loadMultiHostMonitorPageModule = cachedModule(
  () => import("./pages/MultiHostMonitorPage"),
);
const loadProjectSessionsRedirectModule = cachedModule(
  () => import("./pages/ProjectSessionsRedirect"),
);
const loadNewSessionPageModule = cachedModule(
  () => import("./pages/NewSessionPage"),
);
const loadProjectsPageModule = cachedModule(
  () => import("./pages/ProjectsPage"),
);
const loadPublicShareFilePageModule = cachedModule(
  () => import("./pages/PublicShareFilePage"),
);
const loadPublicSharePageModule = cachedModule(
  () => import("./pages/PublicSharePage"),
);
const loadRelayConnectionGateModule = cachedModule(
  () => import("./pages/RelayConnectionGate"),
);
const loadRelayLoginPageModule = cachedModule(
  () => import("./pages/RelayLoginPage"),
);
const loadSessionPageModule = cachedModule(() => import("./pages/SessionPage"));
const loadProviderChildSessionPageModule = cachedModule(
  () => import("./pages/ProviderChildSessionPage"),
);
const loadSettingsModule = cachedModule(() => import("./pages/settings"));

const ConnectionGate = preloadableComponent(async () => ({
  default: (await loadRemoteAppModule()).ConnectionGate,
}));
const RemoteApp = preloadableComponent(async () => ({
  default: (await loadRemoteAppModule()).RemoteApp,
}));
const UnauthenticatedGate = lazy(() =>
  loadRemoteAppModule().then(({ UnauthenticatedGate }) => ({
    default: UnauthenticatedGate,
  })),
);
const NavigationLayout = preloadableComponent(async () => ({
  default: (await loadLayoutsModule()).NavigationLayout,
}));
const SessionDomLingerRouteMarker = lazy(() =>
  loadLayoutsModule().then(({ SessionDomLingerRouteMarker }) => ({
    default: SessionDomLingerRouteMarker,
  })),
);

const ActivityPage = lazy(() =>
  loadActivityPageModule().then(({ ActivityPage }) => ({
    default: ActivityPage,
  })),
);
const AgentsPage = lazy(() =>
  loadAgentsPageModule().then(({ AgentsPage }) => ({
    default: AgentsPage,
  })),
);
const BangCommandsPage = lazy(() =>
  loadBangCommandsPageModule().then(({ BangCommandsPage }) => ({
    default: BangCommandsPage,
  })),
);
const DirectLoginPage = lazy(() =>
  loadDirectLoginPageModule().then(({ DirectLoginPage }) => ({
    default: DirectLoginPage,
  })),
);
const EmulatorPage = lazy(() =>
  loadEmulatorPageModule().then(({ EmulatorPage }) => ({
    default: EmulatorPage,
  })),
);
const FilePage = lazy(() =>
  loadFilePageModule().then(({ FilePage }) => ({ default: FilePage })),
);
const LocalSourcePage = lazy(() =>
  loadLocalSourcePageModule().then(({ LocalSourcePage }) => ({
    default: LocalSourcePage,
  })),
);
const ViewerModePage = lazy(() =>
  import("./pages/ViewerModePage").then(({ ViewerModePage }) => ({
    default: ViewerModePage,
  })),
);
const GitStatusPage = lazy(() =>
  loadGitStatusPageModule().then(({ GitStatusPage }) => ({
    default: GitStatusPage,
  })),
);
const GlobalSessionsPage = lazy(() =>
  loadGlobalSessionsPageModule().then(({ GlobalSessionsPage }) => ({
    default: GlobalSessionsPage,
  })),
);
const HostPickerPage = lazy(() =>
  loadHostPickerPageModule().then(({ HostPickerPage }) => ({
    default: HostPickerPage,
  })),
);
const InboxPage = lazy(() =>
  loadInboxPageModule().then(({ InboxPage }) => ({
    default: InboxPage,
  })),
);
const IssuesPage = lazy(() =>
  loadIssuesPageModule().then(({ IssuesPage }) => ({ default: IssuesPage })),
);
const LegacyRelayRouteRedirect = lazy(() =>
  loadLegacyRelayRouteRedirectModule().then(({ LegacyRelayRouteRedirect }) => ({
    default: LegacyRelayRouteRedirect,
  })),
);
const MultiHostMonitorPage = lazy(() =>
  loadMultiHostMonitorPageModule().then(({ MultiHostMonitorPage }) => ({
    default: MultiHostMonitorPage,
  })),
);
const ProjectSessionsRedirect = lazy(() =>
  loadProjectSessionsRedirectModule().then(({ ProjectSessionsRedirect }) => ({
    default: ProjectSessionsRedirect,
  })),
);
const NewSessionPage = preloadableComponent(async () => ({
  default: (await loadNewSessionPageModule()).NewSessionPage,
}));
const ProjectAppPage = lazy(() =>
  import("./pages/ProjectAppPage").then(({ ProjectAppPage }) => ({
    default: ProjectAppPage,
  })),
);
const ProjectsPage = lazy(() =>
  loadProjectsPageModule().then(({ ProjectsPage }) => ({
    default: ProjectsPage,
  })),
);
const PublicShareFilePage = lazy(() =>
  loadPublicShareFilePageModule().then(({ PublicShareFilePage }) => ({
    default: PublicShareFilePage,
  })),
);
const PublicSharePage = lazy(() =>
  loadPublicSharePageModule().then(({ PublicSharePage }) => ({
    default: PublicSharePage,
  })),
);
const RelayConnectionGate = preloadableComponent(async () => ({
  default: (await loadRelayConnectionGateModule()).RelayConnectionGate,
}));
const RelayLoginPage = lazy(() =>
  loadRelayLoginPageModule().then(({ RelayLoginPage }) => ({
    default: RelayLoginPage,
  })),
);
const SessionPage = lazy(() =>
  loadSessionPageModule().then(({ SessionPage }) => ({
    default: SessionPage,
  })),
);
const ProviderChildSessionPage = lazy(() =>
  loadProviderChildSessionPageModule().then(({ ProviderChildSessionPage }) => ({
    default: ProviderChildSessionPage,
  })),
);
const SettingsLayout = lazy(() =>
  loadSettingsModule().then(({ SettingsLayout }) => ({
    default: SettingsLayout,
  })),
);
const ProviderSignInPage = lazy(() =>
  import("./pages/ProviderSignInPage").then((m) => ({
    default: m.ProviderSignInPage,
  })),
);

// Only the Chrome extension's app tab mirrors saved hosts and takes
// navigation from the side panel (docs/tactical/151).
const ExtensionAppBridge = isExtensionPage()
  ? lazy(() => import("./extension/AppBridge"))
  : null;

const initialRemoteModuleLoaders: Record<
  RemoteRouteModuleKey,
  () => Promise<unknown>
> = {
  activityPage: loadActivityPageModule,
  agentsPage: loadAgentsPageModule,
  bangCommandsPage: loadBangCommandsPageModule,
  directLoginPage: loadDirectLoginPageModule,
  emulatorPage: loadEmulatorPageModule,
  filePage: loadFilePageModule,
  localSourcePage: loadLocalSourcePageModule,
  gitStatusPage: loadGitStatusPageModule,
  globalSessionsPage: loadGlobalSessionsPageModule,
  hostPickerPage: loadHostPickerPageModule,
  inboxPage: loadInboxPageModule,
  issuesPage: loadIssuesPageModule,
  layouts: loadLayoutsModule,
  legacyRelayRouteRedirect: loadLegacyRelayRouteRedirectModule,
  multiHostMonitorPage: loadMultiHostMonitorPageModule,
  newSessionPage: loadNewSessionPageModule,
  projectSessionsRedirect: loadProjectSessionsRedirectModule,
  projectsPage: loadProjectsPageModule,
  publicShareFilePage: loadPublicShareFilePageModule,
  publicSharePage: loadPublicSharePageModule,
  relayConnectionGate: loadRelayConnectionGateModule,
  relayLoginPage: loadRelayLoginPageModule,
  remoteApp: loadRemoteAppModule,
  sessionCore: loadSessionCoreModules,
  sessionPage: loadSessionPageModule,
  settings: loadSettingsModule,
};

const initialRouteModuleKeys = getInitialRemoteRouteModuleKeys(
  window.location.pathname,
  import.meta.env.BASE_URL,
);
void Promise.allSettled(
  initialRouteModuleKeys.map((key) => initialRemoteModuleLoaders[key]()),
);
// Downloading a module does not resolve React.lazy's component wrapper.
// The inline composer holds typing until the entire initial New Session path
// can mount without committing module fallbacks and their minimum duration.
const initialModules = initialRouteModuleKeys.includes("newSessionPage")
  ? Promise.all([
      RemoteApp.preload(),
      NavigationLayout.preload(),
      NewSessionPage.preload(),
      initialRouteModuleKeys.includes("relayConnectionGate")
        ? RelayConnectionGate.preload()
        : ConnectionGate.preload(),
    ])
  : undefined;

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

// Get base URL for router (Vite sets this based on --base flag)
// Remove trailing slash for BrowserRouter basename
const basename = import.meta.env.BASE_URL.replace(/\/$/, "") || undefined;

/**
 * Shared app routes used by both direct mode (ConnectionGate) and
 * relay mode (RelayConnectionGate). Uses relative paths so they resolve
 * correctly under both "/" and "/-/relay/:relayUsername/".
 */
const APP_ROUTES = (
  <>
    <Route index element={<Navigate to="projects" replace />} />

    {/* IMPORTANT: Keep routes in sync with main.tsx — adding a route here? Add it there too! */}
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
                  progressiveRenderPauseSignal={progressiveRenderPauseSignal}
                />
              </RouteModule>
            )}
          />
        </RouteModule>
      }
    >
      <Route path="projects" element={routeModule(<ProjectsPage />)} />
      <Route
        path="projects/:projectId/app"
        element={routeModule(<ProjectAppPage />)}
      />
      <Route
        path="projects/:projectId"
        element={routeModule(<ProjectSessionsRedirect />)}
      />
      <Route path="sessions" element={routeModule(<GlobalSessionsPage />)} />
      <Route path="agents" element={routeModule(<AgentsPage />)} />
      <Route path="inbox" element={routeModule(<InboxPage />)} />
      <Route path="issues" element={routeModule(<IssuesPage />)} />
      <Route path="git-status" element={routeModule(<GitStatusPage />)} />
      <Route path="bang-commands" element={routeModule(<BangCommandsPage />)} />
      <Route path="devices" element={routeModule(<EmulatorPage />)} />
      <Route path="devices/:deviceId" element={routeModule(<EmulatorPage />)} />
      <Route
        path="provider-sign-in/:provider"
        element={routeModule(<ProviderSignInPage />)}
      />
      <Route path="settings" element={routeModule(<SettingsLayout />)} />
      <Route
        path="settings/:category"
        element={routeModule(<SettingsLayout />)}
      />
      <Route path="new-session" element={routeModule(<NewSessionPage />)} />
      <Route
        path="projects/:projectId/file"
        element={routeModule(<FilePage />)}
      />
      <Route
        path="projects/:projectId/browse"
        element={routeModule(<LocalSourcePage />)}
      />
      <Route path="file-view" element={routeModule(<ViewerModePage />)} />
      <Route
        path="projects/:projectId/sessions/:sessionId"
        element={routeModule(<SessionDomLingerRouteMarker />)}
      />
      <Route
        path="projects/:projectId/sessions/:sessionId/agents/:agentId"
        element={routeModule(<ProviderChildSessionPage />)}
      />
    </Route>

    {/* Pages with custom layouts */}
    <Route path="activity" element={routeModule(<ActivityPage />)} />

    {/* Catch-all redirect to projects (must use ../ to escape splat route's relative resolution) */}
    <Route path="*" element={<Navigate to="../projects" replace />} />
  </>
);

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

const app = (
  <Wrapper>
    <TooltipLayer />
    <BrowserRouter basename={basename}>
      <PrebootComposerRetirement />
      {ExtensionAppBridge && (
        <Suspense fallback={null}>
          <ExtensionAppBridge />
        </Suspense>
      )}
      <I18nProvider>
        <ConfirmDialogHost />
        <Routes>
          <Route
            path="/share/:secret/file"
            element={routeModule(<PublicShareFilePage />)}
          />
          <Route
            path="/share/:secret"
            element={routeModule(<PublicSharePage />)}
          />
          <Route
            path="/remote/share/:secret/file"
            element={routeModule(<PublicShareFilePage />)}
          />
          <Route
            path="/remote/share/:secret"
            element={routeModule(<PublicSharePage />)}
          />
          <Route
            path="/-/preview"
            element={routeModule(<ConversationPreviewPage />)}
          />
          <Route
            path="/-/monitor"
            element={routeModule(<MultiHostMonitorPage />)}
          />
          <Route
            path="*"
            element={
              <RouteModule>
                <RemoteApp>
                  <Routes>
                    {/* Login routes — redirect to app if already connected */}
                    <Route element={routeModule(<UnauthenticatedGate />)}>
                      <Route
                        path="/login"
                        element={routeModule(<HostPickerPage />)}
                      />
                      <Route
                        path="/login/direct"
                        element={routeModule(<DirectLoginPage />)}
                      />
                      <Route
                        path="/login/relay"
                        element={routeModule(<RelayLoginPage />)}
                      />
                    </Route>

                    {/* Direct mode — requires connection, no relay username in URL */}
                    <Route element={routeModule(<ConnectionGate />)}>
                      {APP_ROUTES}
                    </Route>

                    {/* Canonical relay routes live under a reserved namespace. */}
                    <Route
                      path="/-/relay/:relayUsername"
                      element={routeModule(<RelayConnectionGate />)}
                    >
                      {APP_ROUTES}
                    </Route>

                    {/* Old username-at-root links redirect only when unambiguous. */}
                    <Route
                      path="/:legacyRelayUsername/*"
                      element={routeModule(<LegacyRelayRouteRedirect />)}
                    />
                  </Routes>
                </RemoteApp>
              </RouteModule>
            }
          />
        </Routes>
      </I18nProvider>
    </BrowserRouter>
  </Wrapper>
);
const renderApp = () => createRoot(rootElement).render(app);
if (initialModules) void initialModules.then(renderApp, renderApp);
else renderApp();
