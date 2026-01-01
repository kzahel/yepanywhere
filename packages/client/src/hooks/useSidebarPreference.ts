import { useCallback, useState } from "react";

const STORAGE_KEY = "sidebar-expanded";

/**
 * Hook to manage sidebar expanded/collapsed preference.
 * Persists to localStorage.
 */
export function useSidebarPreference(): {
  isExpanded: boolean;
  setIsExpanded: (expanded: boolean) => void;
  toggleExpanded: () => void;
} {
  const [isExpanded, setIsExpandedState] = useState(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem(STORAGE_KEY);
      // Default to expanded if no preference saved
      return stored === null ? true : stored === "true";
    }
    return true;
  });

  const setIsExpanded = useCallback((expanded: boolean) => {
    setIsExpandedState(expanded);
    localStorage.setItem(STORAGE_KEY, String(expanded));
  }, []);

  const toggleExpanded = useCallback(() => {
    setIsExpanded(!isExpanded);
  }, [isExpanded, setIsExpanded]);

  return { isExpanded, setIsExpanded, toggleExpanded };
}
