import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";

interface OnboardingState {
  /** Whether to show the wizard (not complete or manually reset) */
  showWizard: boolean;
  /** Whether we're still fetching initial state from server */
  isLoading: boolean;
}

/**
 * Hook to manage onboarding wizard state.
 * Fetches completion status from server and provides methods to complete/reset.
 */
export function useOnboarding() {
  const [state, setState] = useState<OnboardingState>({
    showWizard: false,
    isLoading: true,
  });

  // Fetch initial onboarding status from server
  useEffect(() => {
    let cancelled = false;

    async function fetchStatus() {
      try {
        const { complete } = await api.getOnboardingStatus();
        if (!cancelled) {
          setState({ showWizard: !complete, isLoading: false });
        }
      } catch (error) {
        // If API fails (e.g., endpoint not available), don't show wizard
        console.warn("Failed to fetch onboarding status:", error);
        if (!cancelled) {
          setState({ showWizard: false, isLoading: false });
        }
      }
    }

    fetchStatus();
    return () => {
      cancelled = true;
    };
  }, []);

  // Mark onboarding as complete
  const completeOnboarding = useCallback(async () => {
    try {
      await api.completeOnboarding();
      setState((prev) => ({ ...prev, showWizard: false }));
    } catch (error) {
      console.error("Failed to complete onboarding:", error);
      // Still hide wizard on error to avoid blocking user
      setState((prev) => ({ ...prev, showWizard: false }));
    }
  }, []);

  // Reset onboarding to show wizard again
  const resetOnboarding = useCallback(async () => {
    try {
      await api.resetOnboarding();
      setState((prev) => ({ ...prev, showWizard: true }));
    } catch (error) {
      console.error("Failed to reset onboarding:", error);
    }
  }, []);

  return {
    showWizard: state.showWizard,
    isLoading: state.isLoading,
    completeOnboarding,
    resetOnboarding,
  };
}
