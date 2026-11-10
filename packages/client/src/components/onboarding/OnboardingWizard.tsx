import { useState } from "react";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import {
  RemoteAccessStep,
  RemoteAccessStepActions,
  ThemeStep,
  ThemeStepActions,
} from "./steps";
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
    actions: ThemeStepActions,
  },
  {
    id: "remote-access",
    title: "Remote Access",
    component: RemoteAccessStep,
    actions: RemoteAccessStepActions,
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
  const StepActions = currentStep.actions;

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

  return (
    <Dialog
      title="Welcome to yepanywhere"
      description={`Step ${currentStepIndex + 1} of ${ONBOARDING_STEPS.length}`}
      size="medium"
      onClose={handleSkipAll}
      footerStart={
        <>
          {/* The last step's own Skip finishes, so Skip all would repeat it. */}
          {!isLastStep && (
            // `onboarding-skip-all` is a hook: e2e specs dismiss the wizard by it.
            <Button
              variant="ghost"
              className="onboarding-skip-all"
              onClick={handleSkipAll}
            >
              Skip all
            </Button>
          )}
          {!isFirstStep && <Button onClick={handleBack}>Back</Button>}
        </>
      }
      footer={
        <StepActions
          onNext={handleNext}
          onSkip={handleSkip}
          isLastStep={isLastStep}
        />
      }
    >
      <h2 className="onboarding-step-title">{currentStep.title}</h2>
      <StepComponent />
    </Dialog>
  );
}
