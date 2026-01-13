import type { ComponentType } from "react";

/**
 * Props passed to each onboarding step component.
 */
export interface OnboardingStepProps {
  /** Advance to the next step (or complete if last step) */
  onNext: () => void;
  /** Skip the current step (advances to next or completes) */
  onSkip: () => void;
  /** Whether this is the final step in the wizard */
  isLastStep: boolean;
}

/**
 * Configuration for an onboarding step.
 * Used to define the step registry in OnboardingWizard.
 */
export interface OnboardingStepConfig {
  /** Unique identifier for the step */
  id: string;
  /** Title displayed at the top of the step */
  title: string;
  /** The step component to render */
  component: ComponentType<OnboardingStepProps>;
}
