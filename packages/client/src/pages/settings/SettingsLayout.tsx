import {
  SERVER_CAPABILITIES,
  DEVICE_BRIDGE_AVAILABLE_CAPABILITY,
  DEVICE_BRIDGE_CAPABILITY,
  DEVICE_BRIDGE_DOWNLOAD_CAPABILITY,
  BROWSER_SETTINGS_BACKUP_CAPABILITY,
  GIT_SOURCE_REVIEW_SUBMISSIONS_CAPABILITY,
  serverHasCapability,
} from "@yep-anywhere/shared";
import {
  lazy,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { PageHeader } from "../../components/PageHeader";
import { useRemoteBasePath } from "../../hooks/useRemoteBasePath";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import {
  getEmulatorCategory,
  getSettingsCategories,
} from "../../i18n-settings";
import { MainContent, useNavigationLayout } from "../../layouts";
import { SettingsBackupActions } from "./SettingsBackupActions";
import { SettingsCategoryItem } from "./SettingsCategoryItem";
import { SettingsPane } from "./SettingsPane";
import {
  SettingsSearchBar,
  useSettingsSearchMatchValues,
} from "./SettingsSearchBar";
import { SettingsJumpTargetProvider } from "./SettingsSearchContext";
import { SettingsSearchResults } from "./SettingsSearchResults";
import {
  SettingsPaneTitleProvider,
  useSettingsPaneTitleRegistration,
} from "./SettingsPaneTitleContext";
import {
  SettingsUndoProvider,
  useSettingsUndoRegistration,
} from "./SettingsUndoContext";
import { SettingsUndoButton } from "./SettingsUndoButton";
import type { SettingsCategory } from "./types";

// Map category IDs to their components
const CATEGORY_COMPONENTS: Record<string, React.ComponentType> = {
  appearance: lazy(() =>
    import("./AppearanceSettings").then((m) => ({
      default: m.AppearanceSettings,
    })),
  ),
  performance: lazy(() =>
    import("./PerformanceSettings").then((m) => ({
      default: m.PerformanceSettings,
    })),
  ),
  toolbar: lazy(() =>
    import("./ToolbarSettings").then((m) => ({ default: m.ToolbarSettings })),
  ),
  model: lazy(() =>
    import("./ModelSettings").then((m) => ({ default: m.ModelSettings })),
  ),
  "cache-miss-billing": lazy(() =>
    import("./CacheMissBillingSettings").then((m) => ({
      default: m.CacheMissBillingSettings,
    })),
  ),
  "message-delivery": lazy(() =>
    import("./MessageDeliverySettings").then((m) => ({
      default: m.MessageDeliverySettings,
    })),
  ),
  "source-control": lazy(() =>
    import("./SourceControlSettings").then((m) => ({
      default: m.SourceControlSettings,
    })),
  ),
  issues: lazy(() =>
    import("./IssueSettings").then((m) => ({ default: m.IssueSettings })),
  ),
  "computer-control": lazy(() =>
    import("./ComputerControlSettings").then((m) => ({
      default: m.ComputerControlSettings,
    })),
  ),
  storage: lazy(() =>
    import("./StorageSettings").then((m) => ({ default: m.StorageSettings })),
  ),
  "agent-context": lazy(() =>
    import("./AgentContextSettings").then((m) => ({
      default: m.AgentContextSettings,
    })),
  ),
  notifications: lazy(() =>
    import("./NotificationsSettings").then((m) => ({
      default: m.NotificationsSettings,
    })),
  ),
  webhooks: lazy(() =>
    import("./LifecycleWebhooksSettings").then((m) => ({
      default: m.LifecycleWebhooksSettings,
    })),
  ),
  devices: lazy(() =>
    import("./DevicesSettings").then((m) => ({ default: m.DevicesSettings })),
  ),
  "local-access": lazy(() =>
    import("./LocalAccessSettings").then((m) => ({
      default: m.LocalAccessSettings,
    })),
  ),
  remote: lazy(() =>
    import("./RemoteAccessSettings").then((m) => ({
      default: m.RemoteAccessSettings,
    })),
  ),
  providers: lazy(() =>
    import("./ProvidersSettings").then((m) => ({
      default: m.ProvidersSettings,
    })),
  ),
  speech: lazy(() =>
    import("./SpeechSettings").then((m) => ({ default: m.SpeechSettings })),
  ),
  "remote-executors": lazy(() =>
    import("./RemoteExecutorsSettings").then((m) => ({
      default: m.RemoteExecutorsSettings,
    })),
  ),
  emulator: lazy(() =>
    import("./EmulatorSettings").then((m) => ({ default: m.EmulatorSettings })),
  ),
  environment: lazy(() =>
    import("./EnvironmentSettings").then((m) => ({
      default: m.EnvironmentSettings,
    })),
  ),
  about: lazy(() =>
    import("./AboutSettings").then((m) => ({ default: m.AboutSettings })),
  ),
  development: lazy(() =>
    import("./DevelopmentSettings").then((m) => ({
      default: m.DevelopmentSettings,
    })),
  ),
};

// 700px leaves 685px after the stable scrollbar gutter: 32px shell padding,
// 251px current intrinsic category rail, 16px gap, and 386px detail content.
export const SETTINGS_TWO_COLUMN_MIN_WIDTH = 700;

export function shouldUseSettingsTwoColumn(availableWidth: number): boolean {
  return availableWidth >= SETTINGS_TWO_COLUMN_MIN_WIDTH;
}

interface SettingsDetailNavigationState {
  settingsDetailOpenedFromList?: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

export function createSettingsDetailNavigationState(
  openedFromList: boolean,
): SettingsDetailNavigationState | undefined {
  return openedFromList ? { settingsDetailOpenedFromList: true } : undefined;
}

export function shouldPopSettingsDetailBack(state: unknown): boolean {
  return isRecord(state) && state.settingsDetailOpenedFromList === true;
}

export function shouldReplaceSettingsCategoryNavigation({
  currentCategory,
  useTwoColumnSettings,
}: {
  currentCategory: string | undefined;
  useTwoColumnSettings: boolean;
}): boolean {
  return useTwoColumnSettings && !!currentCategory;
}

function getInitialSettingsWidth(): number {
  return typeof window === "undefined" ? 1200 : window.innerWidth;
}

function useSettingsContainerWidth(): [
  (element: HTMLDivElement | null) => void,
  number,
] {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(getInitialSettingsWidth);

  useLayoutEffect(() => {
    if (!container) {
      return;
    }

    const updateWidth = () => {
      setWidth(container.clientWidth);
    };
    updateWidth();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateWidth);
      return () => window.removeEventListener("resize", updateWidth);
    }

    const observer = new ResizeObserver(updateWidth);
    observer.observe(container);
    return () => observer.disconnect();
  }, [container]);

  return [setContainer, width];
}

function scrollElementToTop(element: HTMLElement): void {
  if (typeof element.scrollTo === "function") {
    element.scrollTo({ top: 0, behavior: "auto" });
    return;
  }

  element.scrollTop = 0;
}

export function SettingsLayout() {
  const { t } = useI18n();
  const { category } = useParams<{ category?: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const basePath = useRemoteBasePath();
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();
  const [settingsContainerRef, settingsContainerWidth] =
    useSettingsContainerWidth();
  const settingsScrollContainerRef = useRef<HTMLElement | null>(null);
  const useTwoColumnSettings = shouldUseSettingsTwoColumn(
    settingsContainerWidth,
  );
  const { version: versionInfo } = useVersion();
  const canBackUpBrowserSettings = serverHasCapability(
    versionInfo,
    BROWSER_SETTINGS_BACKUP_CAPABILITY,
  );
  const {
    registration: undoRegistration,
    setRegistration: setUndoRegistration,
  } = useSettingsUndoRegistration();
  const { title: paneTitle, setTitle: setPaneTitle } =
    useSettingsPaneTitleRegistration();
  const [searchQuery, setSearchQuery] = useState("");
  const [matchValues, setMatchValues] = useSettingsSearchMatchValues();
  const deferredSearchQuery = useDeferredValue(searchQuery.trim());
  const searchActive = searchQuery.trim() !== "";

  // One-shot jump target: a search result's jump link navigates to the
  // category pane with the row id in navigation state; the matching
  // SettingsItem scrolls itself into view, flashes, and consumes it.
  const [jumpTarget, setJumpTarget] = useState<string | null>(null);
  useEffect(() => {
    const state: unknown = location.state;
    if (isRecord(state) && typeof state.settingsJumpTarget === "string") {
      setJumpTarget(state.settingsJumpTarget);
    }
  }, [location.state]);
  const consumeJumpTarget = useCallback(() => setJumpTarget(null), []);
  const jumpTargetValue = useMemo(
    () => ({ target: jumpTarget, consume: consumeJumpTarget }),
    [jumpTarget, consumeJumpTarget],
  );

  const categories: SettingsCategory[] = [
    ...getSettingsCategories((key) => t(key as never)),
  ];
  if (
    !serverHasCapability(versionInfo, SERVER_CAPABILITIES.computerControl.name)
  ) {
    const index = categories.findIndex(
      (item) => item.id === "computer-control",
    );
    if (index >= 0) categories.splice(index, 1);
  }
  if (
    !serverHasCapability(versionInfo, GIT_SOURCE_REVIEW_SUBMISSIONS_CAPABILITY)
  ) {
    const sourceControlIndex = categories.findIndex(
      (item) => item.id === "source-control",
    );
    if (sourceControlIndex >= 0) categories.splice(sourceControlIndex, 1);
  }
  if (
    serverHasCapability(versionInfo, DEVICE_BRIDGE_CAPABILITY) ||
    serverHasCapability(versionInfo, DEVICE_BRIDGE_DOWNLOAD_CAPABILITY) ||
    serverHasCapability(versionInfo, DEVICE_BRIDGE_AVAILABLE_CAPABILITY)
  ) {
    const aboutIndex = categories.findIndex((c) => c.id === "about");
    categories.splice(
      aboutIndex >= 0 ? aboutIndex : categories.length,
      0,
      getEmulatorCategory((key) => t(key as never)),
    );
  }
  if (
    !serverHasCapability(
      versionInfo,
      SERVER_CAPABILITIES.issueSessionAssociations.name,
    )
  ) {
    const index = categories.findIndex((item) => item.id === "issues");
    if (index >= 0) categories.splice(index, 1);
  }
  // Two-column settings can fit before the persistent app sidebar can.
  const effectiveCategory =
    category || (useTwoColumnSettings ? categories[0]?.id : undefined);

  const setSettingsScrollContainerRef = useCallback(
    (element: HTMLElement | null) => {
      settingsScrollContainerRef.current = element;
    },
    [],
  );

  const scrollSettingsToTop = useCallback(() => {
    const element = settingsScrollContainerRef.current;
    if (element) {
      scrollElementToTop(element);
    }
  }, []);

  useLayoutEffect(() => {
    void location.key;
    scrollSettingsToTop();
  }, [location.key, scrollSettingsToTop]);

  const navigateToSettingsRoot = () => {
    if (shouldPopSettingsDetailBack(location.state)) {
      navigate(-1);
    } else {
      navigate(`${basePath}/settings`, { replace: !!category });
    }
    scrollSettingsToTop();
  };

  const handleSettingsTitleClick = () => {
    if (category) {
      navigateToSettingsRoot();
      return;
    }

    navigate(`${basePath}/settings`, { replace: true });
    scrollSettingsToTop();
  };

  const handleCategoryClick = (categoryId: string, jumpToItemId?: string) => {
    setSearchQuery("");
    const openedFromList =
      !category || shouldPopSettingsDetailBack(location.state);
    const navigationState = createSettingsDetailNavigationState(openedFromList);
    navigate(`${basePath}/settings/${categoryId}`, {
      replace: shouldReplaceSettingsCategoryNavigation({
        currentCategory: category,
        useTwoColumnSettings,
      }),
      state: jumpToItemId
        ? { ...navigationState, settingsJumpTarget: jumpToItemId }
        : navigationState,
    });
  };

  const handleSearchOpenCategory = (categoryId: string) => {
    handleCategoryClick(categoryId);
  };

  const handleSearchJumpToItem = (categoryId: string, itemId: string) => {
    handleCategoryClick(categoryId, itemId);
  };

  const searchBar = (
    <SettingsSearchBar
      query={searchQuery}
      onQueryChange={setSearchQuery}
      matchValues={matchValues}
      onMatchValuesChange={setMatchValues}
    />
  );

  const searchResults = searchActive ? (
    <SettingsSearchResults
      categories={categories}
      components={CATEGORY_COMPONENTS}
      query={deferredSearchQuery || searchQuery.trim()}
      matchValues={matchValues}
      onJumpToItem={handleSearchJumpToItem}
      onOpenCategory={handleSearchOpenCategory}
    />
  ) : null;

  const handleBack = () => {
    navigateToSettingsRoot();
  };

  const CategoryComponent = effectiveCategory
    ? CATEGORY_COMPONENTS[effectiveCategory]
    : null;
  const activeCategory = categories.find((c) => c.id === effectiveCategory);

  // Top-strip title for the open pane: the pane registers it via
  // useSettingsPaneTitle; fall back to the category label until that
  // registers (and for the rare pane that sets nothing).
  const resolvedPaneTitle =
    paneTitle ?? activeCategory?.label ?? t("pageTitleSettings");
  const breadcrumbDescription =
    effectiveCategory === "model"
      ? t("modelSettingsSessionDefaultsDescription")
      : null;

  // Settings breadcrumb shown in the header strip (two-column): a clickable
  // "Settings" root plus the active pane title, so the strip names the page
  // instead of just "Settings".
  const settingsBreadcrumb = (
    <span className="settings-breadcrumb">
      <button
        type="button"
        className="session-title settings-breadcrumb-root"
        onClick={handleSettingsTitleClick}
      >
        {t("pageTitleSettings")}
      </button>
      <span className="settings-breadcrumb-sep" aria-hidden="true">
        ›
      </span>
      <span className="settings-breadcrumb-current">{resolvedPaneTitle}</span>
      {breadcrumbDescription && (
        <span className="settings-breadcrumb-description">
          {breadcrumbDescription}
        </span>
      )}
    </span>
  );

  // The single per-pane Undo affordance: panes register via useSettingsUndo.
  // Keep the button's header footprint even while hidden so settings rows do
  // not shift when a field first becomes undoable.
  const undoButton = (
    <SettingsUndoButton
      registration={undoRegistration}
      paneTitle={resolvedPaneTitle}
    />
  );

  // Narrow settings: category list OR category detail (not both)
  if (!useTwoColumnSettings) {
    if (!category) {
      // Show category list
      return (
        <MainContent
          isWideScreen={isWideScreen}
          innerRef={settingsContainerRef}
        >
          <PageHeader
            title={t("pageTitleSettings")}
            onTitleClick={handleSettingsTitleClick}
            onOpenSidebar={openSidebar}
            onToggleSidebar={toggleSidebar}
            isWideScreen={isWideScreen}
            isSidebarCollapsed={isSidebarCollapsed}
          />
          <main
            ref={setSettingsScrollContainerRef}
            className="page-scroll-container"
          >
            <div className="page-content-inner settings-category-list-shell">
              {searchBar}
              {searchResults ?? (
                <div className="settings-category-list">
                  {categories.map((cat) => (
                    <SettingsCategoryItem
                      key={cat.id}
                      category={cat}
                      isActive={false}
                      onClick={() => handleCategoryClick(cat.id)}
                    />
                  ))}
                  {canBackUpBrowserSettings && <SettingsBackupActions />}
                </div>
              )}
            </div>
          </main>
        </MainContent>
      );
    }

    // Show category detail with back button
    return (
      <MainContent isWideScreen={isWideScreen} innerRef={settingsContainerRef}>
        <PageHeader
          title={resolvedPaneTitle}
          onOpenSidebar={openSidebar}
          showBack
          onBack={handleBack}
          actions={undoButton}
        />
        <main
          ref={setSettingsScrollContainerRef}
          className="page-scroll-container"
        >
          <div className="page-content-inner">
            <SettingsJumpTargetProvider value={jumpTargetValue}>
              <SettingsPaneTitleProvider value={setPaneTitle}>
                <SettingsUndoProvider value={setUndoRegistration}>
                  <SettingsPane key={effectiveCategory}>
                    {CategoryComponent && <CategoryComponent />}
                  </SettingsPane>
                </SettingsUndoProvider>
              </SettingsPaneTitleProvider>
            </SettingsJumpTargetProvider>
          </div>
        </main>
      </MainContent>
    );
  }

  // Desktop: two-column layout with category list on left, content on right
  return (
    <MainContent isWideScreen={isWideScreen} innerRef={settingsContainerRef}>
      <PageHeader
        title={resolvedPaneTitle}
        titleElement={settingsBreadcrumb}
        onOpenSidebar={openSidebar}
        onToggleSidebar={toggleSidebar}
        isWideScreen={isWideScreen}
        isSidebarCollapsed={isSidebarCollapsed}
        actions={undoButton}
      />
      <main
        ref={setSettingsScrollContainerRef}
        className="page-scroll-container"
      >
        <div className="settings-two-column">
          <nav className="settings-category-nav">
            {searchBar}
            <div className="settings-category-list">
              {categories.map((cat) => (
                <SettingsCategoryItem
                  key={cat.id}
                  category={cat}
                  isActive={!searchActive && effectiveCategory === cat.id}
                  onClick={() => handleCategoryClick(cat.id)}
                />
              ))}
              {canBackUpBrowserSettings && <SettingsBackupActions />}
            </div>
          </nav>
          <div className="settings-content-panel">
            {searchResults ?? (
              <SettingsJumpTargetProvider value={jumpTargetValue}>
                <SettingsPaneTitleProvider value={setPaneTitle}>
                  <SettingsUndoProvider value={setUndoRegistration}>
                    <SettingsPane key={effectiveCategory}>
                      {CategoryComponent && <CategoryComponent />}
                    </SettingsPane>
                  </SettingsUndoProvider>
                </SettingsPaneTitleProvider>
              </SettingsJumpTargetProvider>
            )}
          </div>
        </div>
      </main>
    </MainContent>
  );
}
