import { THEMES, getThemeLabel, useTheme } from "../../../hooks/useTheme";
import type { OnboardingStepProps } from "../types";

/**
 * Onboarding step for selecting a theme.
 * Shows visual previews of each theme option.
 */
export function ThemeStep({ onNext, onSkip, isLastStep }: OnboardingStepProps) {
  const { theme, setTheme } = useTheme();

  return (
    <div className="onboarding-step-content">
      <p className="onboarding-step-description">
        Choose your preferred color scheme. You can change this later in
        Settings.
      </p>

      <div className="onboarding-theme-grid">
        {THEMES.map((t) => (
          <button
            key={t}
            type="button"
            className={`onboarding-theme-option ${theme === t ? "selected" : ""}`}
            onClick={() => setTheme(t)}
          >
            <div className={`onboarding-theme-preview theme-preview-${t}`} />
            <span className="onboarding-theme-label">{getThemeLabel(t)}</span>
          </button>
        ))}
      </div>

      <div className="onboarding-step-actions">
        <button type="button" className="btn-secondary" onClick={onSkip}>
          Skip
        </button>
        <button type="button" className="btn-primary" onClick={onNext}>
          {isLastStep ? "Finish" : "Next"}
        </button>
      </div>
    </div>
  );
}
