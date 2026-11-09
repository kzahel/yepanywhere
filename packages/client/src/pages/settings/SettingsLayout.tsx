import {
  BROWSER_SETTINGS_BACKUP_CAPABILITY,
  type ServerCapabilitySource,
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
import { ButtonBase } from "../../components/ui/Button";
import { useRemoteBasePath } from "../../hooks/useRemoteBasePath";
import { useActingPrincipal } from "../../hooks/useActingPrincipal";
import { useVersion } from "../../hooks/useVersion";
import { limitedUserMaySeeSettingsCategory } from "../../lib/limitedUserSettings";
import { useI18n } from "../../i18n";
import { getSettingsCategories } from "../../i18n-settings";
import { MainContent, useNavigationLayout } from "../../layouts";
import { SettingsBackupActions } from "./SettingsBackupActions";
import { SettingsCategoryItem } from "./SettingsCategoryItem";
import { SettingsClipboardTransfer } from "./SettingsClipboardTransfer";
import { SettingsPane } from "./SettingsPane";
import {
  SettingsSearchBar,
  useSettingsSearchMatchValues,
} from "./SettingsSearchBar";
import { SettingsJumpTargetProvider } from "./SettingsSearchContext";
import { SettingsSearchResults } from "./SettingsSearchResults";
import { SettingsSection } from "./SettingsSection";
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
  "browser-extension": lazy(() =>
    import("./BrowserExtensionSettings").then((m) => ({
      default: m.BrowserExtensionSettings,
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
  users: lazy(() =>
    import("./UsersSettings").then((m) => ({ default: m.UsersSettings })),
  ),
  "project-templates": lazy(() =>
    import("./ProjectTemplatesSettings").then((m) => ({
      default: m.ProjectTemplatesSettings,
    })),
  ),
  apps: lazy(() =>
    import("./AppsSettings").then((m) => ({ default: m.AppsSettings })),
  ),
  "server-connections": lazy(() =>
    import("./ServerConnectionsSettings").then((m) => ({
      default: m.ServerConnectionsSettings,
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

/** Whether the connected server serves this settings category's pane. */
function settingsCategoryServed(
  category: SettingsCategory,
  versionInfo: ServerCapabilitySource | null | undefined,
): boolean {
  return (
    !category.requires ||
    category.requires.anyCapability.some((capability) =>
      serverHasCapability(versionInfo, capability),
    )
  );
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
  const { isWideScreen } = useNavigationLayout();
  const [settingsContainerRef, settingsContainerWidth] =
    useSettingsContainerWidth();
  const settingsScrollContainerRef = useRef<HTMLElement | null>(null);
  const useTwoColumnSettings = shouldUseSettingsTwoColumn(
    settingsContainerWidth,
  );
  const { version: versionInfo, loading: versionLoading } = useVersion();
  const { principal: actingPrincipal, resolved: principalResolved } =
    useActingPrincipal();
  const serverBacksUpBrowserSettings = serverHasCapability(
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

  const allCategories = useMemo(
    () => getSettingsCategories((key) => t(key as never)),
    [t],
  );
  const categories = useMemo(
    () =>
      allCategories.filter((item) => settingsCategoryServed(item, versionInfo)),
    [allCategories, versionInfo],
  );
  // A limited user keeps only the categories they can actually operate; the
  // rest are inert or never finish loading for them. topics/limited-users.md
  // § Delivery v1. Until the server names the principal, its placeholder is
  // the superuser, so no category is offered or mounted: a superuser-only
  // pane would otherwise send its refused requests first.
  const actingAsLimitedUser = actingPrincipal.username !== null;
  const visibleCategories = useMemo(
    () =>
      !principalResolved
        ? []
        : actingAsLimitedUser
          ? categories.filter((item) =>
              limitedUserMaySeeSettingsCategory(item.id),
            )
          : categories,
    [principalResolved, actingAsLimitedUser, categories],
  );
  // The backup slot is server-wide and `/api/browser-settings-backup` is
  // denied for a limited user, so the buttons would only ever fail for them.
  const canBackUpBrowserSettings =
    serverBacksUpBrowserSettings && principalResolved && !actingAsLimitedUser;

  // Two-column settings can fit before the persistent app sidebar can.
  const effectiveCategory =
    category || (useTwoColumnSettings ? visibleCategories[0]?.id : undefined);

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

  const handleCategoryClick = useCallback(
    (categoryId: string, jumpToItemId?: string) => {
      setSearchQuery("");
      const openedFromList =
        !category || shouldPopSettingsDetailBack(location.state);
      const navigationState =
        createSettingsDetailNavigationState(openedFromList);
      navigate(`${basePath}/settings/${categoryId}`, {
        replace: shouldReplaceSettingsCategoryNavigation({
          currentCategory: category,
          useTwoColumnSettings,
        }),
        state: jumpToItemId
          ? { ...navigationState, settingsJumpTarget: jumpToItemId }
          : navigationState,
      });
    },
    [basePath, category, location.state, navigate, useTwoColumnSettings],
  );

  const searchBar = (
    <SettingsSearchBar
      query={searchQuery}
      onQueryChange={setSearchQuery}
      matchValues={matchValues}
      onMatchValuesChange={setMatchValues}
    />
  );

  // The first key must not mount every settings pane on the urgent input
  // update. Enter search only once its deferred query is ready as well.
  const searchResults =
    searchActive && deferredSearchQuery !== "" && principalResolved ? (
      <SettingsSearchResults
        categories={visibleCategories}
        components={CATEGORY_COMPONENTS}
        query={deferredSearchQuery}
        matchValues={matchValues}
        onJumpToItem={handleCategoryClick}
        onOpenCategory={handleCategoryClick}
      />
    ) : null;

  const handleBack = () => {
    navigateToSettingsRoot();
  };

  // A category withheld from this principal does not render even when its URL
  // is typed directly: the pane behind it cannot load for them. A category the
  // server does not serve answers a typed URL with its own unsupported-server
  // message, and its pane never mounts to send requests that server lacks.
  // Until the version arrives, "unsupported" is not yet known.
  const withheldFromPrincipal =
    actingAsLimitedUser &&
    effectiveCategory !== undefined &&
    !limitedUserMaySeeSettingsCategory(effectiveCategory);
  const unservedCategory =
    principalResolved && !withheldFromPrincipal
      ? allCategories.find(
          (c) =>
            c.id === effectiveCategory &&
            !settingsCategoryServed(c, versionInfo),
        )
      : undefined;
  const activeCategory =
    visibleCategories.find((c) => c.id === effectiveCategory) ??
    unservedCategory;
  const CategoryComponent =
    effectiveCategory &&
    principalResolved &&
    !withheldFromPrincipal &&
    !unservedCategory
      ? CATEGORY_COMPONENTS[effectiveCategory]
      : null;
  const unservedCategoryAnswer =
    !unservedCategory?.requires ? null : !versionInfo && versionLoading ? (
      <SettingsSection description={t("loading")} />
    ) : (
      <SettingsSection
        title={unservedCategory.label}
        description={unservedCategory.description}
      >
        <p className="settings-hint">
          {unservedCategory.requires.unsupportedMessage}
        </p>
      </SettingsSection>
    );
  const categoryPane = CategoryComponent ? (
    <CategoryComponent />
  ) : (
    unservedCategoryAnswer
  );

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
      <ButtonBase
        className="session-title settings-breadcrumb-root"
        onClick={handleSettingsTitleClick}
      >
        {t("pageTitleSettings")}
      </ButtonBase>
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
          />
          <main
            ref={setSettingsScrollContainerRef}
            className="page-scroll-container"
          >
            <div className="page-content-inner settings-category-list-shell">
              {searchBar}
              {searchResults ?? (
                <div className="settings-category-list">
                  {visibleCategories.map((cat) => (
                    <SettingsCategoryItem
                      key={cat.id}
                      category={cat}
                      isActive={false}
                      onClick={() => handleCategoryClick(cat.id)}
                    />
                  ))}
                  {canBackUpBrowserSettings && <SettingsBackupActions />}
                  {principalResolved && <SettingsClipboardTransfer />}
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
                    {categoryPane}
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
              {visibleCategories.map((cat) => (
                <SettingsCategoryItem
                  key={cat.id}
                  category={cat}
                  isActive={!searchActive && effectiveCategory === cat.id}
                  onClick={() => handleCategoryClick(cat.id)}
                />
              ))}
              {canBackUpBrowserSettings && <SettingsBackupActions />}
              {principalResolved && <SettingsClipboardTransfer />}
            </div>
          </nav>
          <div className="settings-content-panel">
            {searchResults ?? (
              <SettingsJumpTargetProvider value={jumpTargetValue}>
                <SettingsPaneTitleProvider value={setPaneTitle}>
                  <SettingsUndoProvider value={setUndoRegistration}>
                    <SettingsPane key={effectiveCategory}>
                      {categoryPane}
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
