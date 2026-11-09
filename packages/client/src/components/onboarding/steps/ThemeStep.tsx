import { getThemeLabel, THEMES, useTheme } from "../../../hooks/useTheme";
import { useI18n } from "../../../i18n";
import { Button } from "../../ui/Button";
import { SegmentedControl } from "../../ui/SegmentedControl";
import type { OnboardingStepProps } from "../types";

/**
 * Onboarding step for selecting a theme.
 * Shows visual previews of each theme option.
 */
export function ThemeStep() {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();

  return (
    <div className="onboarding-step-content">
      <p className="onboarding-step-description">
        {t("onboardingThemeDescription")}
      </p>

      <SegmentedControl
        variant="cards"
        layout="stack"
        aria-label={t("appearanceThemeTitle")}
        options={THEMES.map((themeName) => ({
          value: themeName,
          label: getThemeLabel(themeName),
          icon: (
            <span
              className={`onboarding-theme-preview theme-preview-${themeName}`}
            />
          ),
        }))}
        value={theme}
        onChange={setTheme}
      />
    </div>
  );
}

export function ThemeStepActions({
  onNext,
  onSkip,
  isLastStep,
}: OnboardingStepProps) {
  return (
    <>
      <Button onClick={onSkip}>Skip</Button>
      <Button variant="primary" onClick={onNext}>
        {isLastStep ? "Finish" : "Next"}
      </Button>
    </>
  );
}
