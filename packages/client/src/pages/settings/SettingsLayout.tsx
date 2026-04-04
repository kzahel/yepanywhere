import { useNavigate, useParams } from "react-router-dom";
import { PageHeader } from "../../components/PageHeader";
import { useReloadNotifications } from "../../hooks/useReloadNotifications";
import { useRemoteBasePath } from "../../hooks/useRemoteBasePath";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import {
  getDevelopmentCategory,
  getEmulatorCategory,
  getSettingsCategories,
} from "../../i18n-settings";
import { useNavigationLayout } from "../../layouts";
import { AboutSettings } from "./AboutSettings";
import { AgentContextSettings } from "./AgentContextSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { DevelopmentSettings } from "./DevelopmentSettings";
import { DevicesSettings } from "./DevicesSettings";
import { EmulatorSettings } from "./EmulatorSettings";
import { LifecycleWebhooksSettings } from "./LifecycleWebhooksSettings";
import { LocalAccessSettings } from "./LocalAccessSettings";
import { ModelSettings } from "./ModelSettings";
import { NotificationsSettings } from "./NotificationsSettings";
import { ProvidersSettings } from "./ProvidersSettings";
import { RemoteAccessSettings } from "./RemoteAccessSettings";
import { RemoteExecutorsSettings } from "./RemoteExecutorsSettings";
import type { SettingsCategory } from "./types";

// Map category IDs to their components
const CATEGORY_COMPONENTS: Record<string, React.ComponentType> = {
  appearance: AppearanceSettings,
  model: ModelSettings,
  "agent-context": AgentContextSettings,
  notifications: NotificationsSettings,
  webhooks: LifecycleWebhooksSettings,
  devices: DevicesSettings,
  "local-access": LocalAccessSettings,
  remote: RemoteAccessSettings,
  providers: ProvidersSettings,
  "remote-executors": RemoteExecutorsSettings,
  emulator: EmulatorSettings,
  about: AboutSettings,
  development: DevelopmentSettings,
};

interface SettingsCategoryItemProps {
  category: SettingsCategory;
  isActive: boolean;
  onClick: () => void;
}

function SettingsCategoryItem({
  category,
  isActive,
  onClick,
}: SettingsCategoryItemProps) {
  return (
    <button
      type="button"
      className={`settings-category-item ${isActive ? "active" : ""}`}
      onClick={onClick}
    >
      <span className="settings-category-icon">{category.icon}</span>
      <div className="settings-category-text">
        <span className="settings-category-label">{category.label}</span>
        <span className="settings-category-description">
          {category.description}
        </span>
      </div>
      <span className="settings-category-chevron">›</span>
    </button>
  );
}

export function SettingsLayout() {
  const { t } = useI18n();
  const { category } = useParams<{ category?: string }>();
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();
  const { isManualReloadMode } = useReloadNotifications();
  const { version: versionInfo } = useVersion();
  const capabilities = versionInfo?.capabilities ?? [];

  // Build the list of categories, conditionally including emulator and dev
  const categories: SettingsCategory[] = [
    ...getSettingsCategories((key) => t(key as never)),
  ];
  if (
    capabilities.includes("deviceBridge") ||
    capabilities.includes("deviceBridge-download") ||
    capabilities.includes("deviceBridge-available")
  ) {
    // Insert before "about"
    const aboutIndex = categories.findIndex((c) => c.id === "about");
    categories.splice(
      aboutIndex >= 0 ? aboutIndex : categories.length,
      0,
      getEmulatorCategory((key) => t(key as never)),
    );
  }
  if (isManualReloadMode) {
    categories.push(getDevelopmentCategory((key) => t(key as never)));
  }

  // On wide screen, default to first category if none selected
  const effectiveCategory =
    category || (isWideScreen ? categories[0]?.id : undefined);

  const handleCategoryClick = (categoryId: string) => {
    navigate(`${basePath}/settings/${categoryId}`);
  };

  const handleBack = () => {
    navigate(`${basePath}/settings`);
  };

  // Get the component for the current category
  const CategoryComponent = effectiveCategory
    ? CATEGORY_COMPONENTS[effectiveCategory]
    : null;

  // Mobile: category list OR category detail (not both)
  if (!isWideScreen) {
    if (!category) {
      // Show category list
      return (
        <div className="main-content-mobile">
          <div className="main-content-mobile-inner">
            <PageHeader
              title={t("pageTitleSettings")}
              onOpenSidebar={openSidebar}
              onToggleSidebar={toggleSidebar}
              isWideScreen={isWideScreen}
              isSidebarCollapsed={isSidebarCollapsed}
            />
            <main className="page-scroll-container">
              <div className="page-content-inner">
                <div className="settings-category-list">
                  {categories.map((cat) => (
                    <SettingsCategoryItem
                      key={cat.id}
                      category={cat}
                      isActive={false}
                      onClick={() => handleCategoryClick(cat.id)}
                    />
                  ))}
                </div>
              </div>
            </main>
          </div>
        </div>
      );
    }

    // Show category detail with back button
    const currentCategory = categories.find((c) => c.id === category);
    return (
      <div className="main-content-mobile">
        <div className="main-content-mobile-inner">
          <PageHeader
            title={currentCategory?.label || t("pageTitleSettings")}
            onOpenSidebar={openSidebar}
            showBack
            onBack={handleBack}
          />
          <main className="page-scroll-container">
            <div className="page-content-inner">
              {CategoryComponent && <CategoryComponent />}
            </div>
          </main>
        </div>
      </div>
    );
  }

  // Desktop: two-column layout with category list on left, content on right
  return (
    <div className="main-content-wrapper">
      <div className="main-content-constrained">
        <PageHeader
          title={t("pageTitleSettings")}
          onOpenSidebar={openSidebar}
          onToggleSidebar={toggleSidebar}
          isWideScreen={isWideScreen}
          isSidebarCollapsed={isSidebarCollapsed}
        />
        <main className="page-scroll-container">
          <div className="settings-two-column">
            <nav className="settings-category-nav">
              <div className="settings-category-list">
                {categories.map((cat) => (
                  <SettingsCategoryItem
                    key={cat.id}
                    category={cat}
                    isActive={effectiveCategory === cat.id}
                    onClick={() => handleCategoryClick(cat.id)}
                  />
                ))}
              </div>
            </nav>
            <div className="settings-content-panel">
              {CategoryComponent && <CategoryComponent />}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
