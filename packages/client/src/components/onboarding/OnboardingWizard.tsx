import { useState } from "react";
import { Modal } from "../ui/Modal";
import { RemoteAccessStep, ThemeStep } from "./steps";
import type { OnboardingStepConfig } from "./types";

/**
 * Extensible step registry - add new steps here.
 * The order in this array determines the wizard flow.
 */
const ONBOARDING_STEPS: OnboardingStepConfig[] = [
  {
    id: "theme",
    title: "Choose Your Theme",
    component: ThemeStep,
  },
  {
    id: "remote-access",
    title: "Remote Access",
    component: RemoteAccessStep,
  },
];

interface OnboardingWizardProps {
  /** Called when onboarding is complete (finished or skipped) */
  onComplete: () => void;
}

/**
 * Multi-step onboarding wizard shown on first launch.
 * Guides users through initial setup: theme selection and remote access info.
 */
export function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);

  const currentStep = ONBOARDING_STEPS[currentStepIndex];

  // Guard against undefined (shouldn't happen in practice)
  if (!currentStep) {
    onComplete();
    return null;
  }

  const isLastStep = currentStepIndex === ONBOARDING_STEPS.length - 1;
  const StepComponent = currentStep.component;

  const handleNext = () => {
    if (isLastStep) {
      onComplete();
    } else {
      setCurrentStepIndex((prev) => prev + 1);
    }
  };

  const handleSkip = () => {
    if (isLastStep) {
      onComplete();
    } else {
      setCurrentStepIndex((prev) => prev + 1);
    }
  };

  const handleSkipAll = () => {
    onComplete();
  };

  const handleBack = () => {
    if (currentStepIndex > 0) {
      setCurrentStepIndex((prev) => prev - 1);
    }
  };

  const isFirstStep = currentStepIndex === 0;

  const modalTitle = (
    <div className="onboarding-modal-title">
      <span>Welcome to yepanywhere</span>
      <span className="onboarding-step-indicator">
        Step {currentStepIndex + 1} of {ONBOARDING_STEPS.length}
      </span>
    </div>
  );

  return (
    <Modal title={modalTitle} onClose={handleSkipAll}>
      <div className="onboarding-wizard">
        <h2 className="onboarding-step-title">{currentStep.title}</h2>

        <StepComponent
          onNext={handleNext}
          onSkip={handleSkip}
          isLastStep={isLastStep}
        />

        <div className="onboarding-footer">
          <button
            type="button"
            className="onboarding-skip-all"
            onClick={handleSkipAll}
          >
            Skip all
          </button>
          <div className="onboarding-footer-right">
            {!isFirstStep && (
              <button
                type="button"
                className="onboarding-back"
                onClick={handleBack}
              >
                Back
              </button>
            )}
            <div className="onboarding-progress">
              {ONBOARDING_STEPS.map((step, index) => (
                <span
                  key={step.id}
                  className={`onboarding-progress-dot ${
                    index === currentStepIndex ? "active" : ""
                  } ${index < currentStepIndex ? "completed" : ""}`}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
