import { useNavigate } from "react-router-dom";
import { useRemoteBasePath } from "../../../hooks/useRemoteBasePath";
import { useI18n } from "../../../i18n";
import { Button } from "../../ui/Button";
import type { OnboardingStepProps } from "../types";

/**
 * Onboarding step explaining remote access.
 * Provides info and option to configure remote access in settings.
 */
export function RemoteAccessStep({
  onNext,
  onSkip,
  isLastStep,
}: OnboardingStepProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();

  const handleGoToSettings = () => {
    onNext(); // Complete onboarding first
    navigate(`${basePath}/settings/remote`);
  };

  return (
    <div className="onboarding-step-content">
      <p className="onboarding-step-description">
        {t("onboardingRemoteDescription")}
      </p>

      <div className="onboarding-info-box">
        <h4>{t("onboardingRemoteRequirementsTitle")}</h4>
        <ul>
          <li>{t("onboardingRemoteRequirementRelayUrl")}</li>
          <li>{t("onboardingRemoteRequirementUsername")}</li>
          <li>{t("onboardingRemoteRequirementPassword")}</li>
        </ul>
      </div>

      <p className="onboarding-step-hint">{t("onboardingRemoteHint")}</p>

      <div className="onboarding-step-actions">
        <Button onClick={onSkip}>
          {isLastStep ? "Skip & Finish" : "Skip"}
        </Button>
        <Button variant="primary" onClick={handleGoToSettings}>
          Set Up Remote Access
        </Button>
      </div>
    </div>
  );
}
