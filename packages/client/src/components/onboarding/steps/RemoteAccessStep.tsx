import { useNavigate } from "react-router-dom";
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
  const navigate = useNavigate();

  const handleGoToSettings = () => {
    onNext(); // Complete onboarding first
    navigate("/settings/remote");
  };

  return (
    <div className="onboarding-step-content">
      <p className="onboarding-step-description">
        Access yepanywhere from anywhere using a secure relay connection. This
        lets you supervise Claude agents from your phone while away from your
        computer.
      </p>

      <div className="onboarding-info-box">
        <h4>What you'll need:</h4>
        <ul>
          <li>A relay server URL (self-hosted or provided by your admin)</li>
          <li>A username to identify your server</li>
          <li>A password for secure authentication</li>
        </ul>
      </div>

      <p className="onboarding-step-hint">
        You can skip this for now and set it up later in Settings.
      </p>

      <div className="onboarding-step-actions">
        <button type="button" className="btn-secondary" onClick={onSkip}>
          {isLastStep ? "Skip & Finish" : "Skip"}
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={handleGoToSettings}
        >
          Set Up Remote Access
        </button>
      </div>
    </div>
  );
}
