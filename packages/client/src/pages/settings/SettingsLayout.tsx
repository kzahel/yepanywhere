import { useNavigate, useParams } from "react-router-dom";
import { PageHeader } from "../../components/PageHeader";
import { useReloadNotifications } from "../../hooks/useReloadNotifications";
import { useNavigationLayout } from "../../layouts";
import { AboutSettings } from "./AboutSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { DevelopmentSettings } from "./DevelopmentSettings";
import { ModelSettings } from "./ModelSettings";
import { NotificationsSettings } from "./NotificationsSettings";
import { ProvidersSettings } from "./ProvidersSettings";
import { RemoteAccessSettings } from "./RemoteAccessSettings";
import { SecuritySettings } from "./SecuritySettings";
import {
  DEV_CATEGORY,
  SETTINGS_CATEGORIES,
  type SettingsCategory,
} from "./types";

// Map category IDs to their components
const CATEGORY_COMPONENTS: Record<string, React.ComponentType> = {
  appearance: AppearanceSettings,
  model: ModelSettings,
  notifications: NotificationsSettings,
  security: SecuritySettings,
  remote: RemoteAccessSettings,
  providers: ProvidersSettings,
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
  const { category } = useParams<{ category?: string }>();
  const navigate = useNavigate();
  const { openSidebar, isWideScreen } = useNavigationLayout();
  const { isManualReloadMode } = useReloadNotifications();

  // Build the list of categories, including dev category if in dev mode
  const categories = isManualReloadMode
    ? [...SETTINGS_CATEGORIES, DEV_CATEGORY]
    : SETTINGS_CATEGORIES;

  // On wide screen, default to first category if none selected
  const effectiveCategory =
    category || (isWideScreen ? categories[0]?.id : undefined);

  const handleCategoryClick = (categoryId: string) => {
    navigate(`/settings/${categoryId}`);
  };

  const handleBack = () => {
    navigate("/settings");
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
            <PageHeader title="Settings" onOpenSidebar={openSidebar} />
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
            title={currentCategory?.label || "Settings"}
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
        <PageHeader title="Settings" onOpenSidebar={openSidebar} />
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
