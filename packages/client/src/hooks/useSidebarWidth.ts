import { useCallback, useState } from "react";
import { UI_KEYS } from "../lib/storageKeys";

// ===== Configuration Constants (easy to tweak) =====
export const SIDEBAR_MIN_WIDTH = 280; // Current default, minimum allowed
export const SIDEBAR_MAX_WIDTH = 560; // 2x minimum
export const SIDEBAR_COLLAPSED_WIDTH = 56;
export const MIN_CONTENT_WIDTH = 600; // Minimum main content area width
// Desktop breakpoint must match CSS @media (min-width: 1100px) in NavigationLayout.module.css
export const DESKTOP_BREAKPOINT = 1100;

// Desktop mode when: viewport >= DESKTOP_BREAKPOINT
// Expanded sidebar when: viewport >= sidebarWidth + MIN_CONTENT_WIDTH

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function loadWidth(): number {
  if (typeof window === "undefined") return SIDEBAR_MIN_WIDTH;
  const stored = localStorage.getItem(UI_KEYS.sidebarWidth);
  if (stored === null) return SIDEBAR_MIN_WIDTH;
  const parsed = Number.parseInt(stored, 10);
  if (Number.isNaN(parsed)) return SIDEBAR_MIN_WIDTH;
  return clamp(parsed, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
}

function saveWidth(width: number): void {
  localStorage.setItem(UI_KEYS.sidebarWidth, String(width));
}

export interface UseSidebarWidthResult {
  /** Current sidebar width in pixels */
  width: number;
  /** Set sidebar width (clamped to min/max) */
  setWidth: (width: number) => void;
  /** Whether sidebar is currently being resized */
  isResizing: boolean;
  /** Set resizing state (disables transitions during drag) */
  setIsResizing: (resizing: boolean) => void;
  /** Check if viewport is wide enough for desktop layout (with collapsed sidebar) */
  canShowDesktop: (viewportWidth: number) => boolean;
  /** Check if viewport is wide enough to show expanded sidebar */
  canShowExpanded: (viewportWidth: number) => boolean;
}

export function useSidebarWidth(): UseSidebarWidthResult {
  const [width, setWidthState] = useState(loadWidth);
  const [isResizing, setIsResizing] = useState(false);

  const setWidth = useCallback((newWidth: number) => {
    const clamped = clamp(newWidth, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
    setWidthState(clamped);
    saveWidth(clamped);
  }, []);

  // Desktop layout is possible when viewport meets the desktop breakpoint
  const canShowDesktop = useCallback((viewportWidth: number) => {
    return viewportWidth >= DESKTOP_BREAKPOINT;
  }, []);

  // Expanded sidebar is possible if there's room for full width + content
  const canShowExpanded = useCallback(
    (viewportWidth: number) => {
      return viewportWidth >= width + MIN_CONTENT_WIDTH;
    },
    [width],
  );

  return {
    width,
    setWidth,
    isResizing,
    setIsResizing,
    canShowDesktop,
    canShowExpanded,
  };
}

/**
 * Get sidebar width from localStorage without React state.
 * Useful for initial calculations before component mounts.
 */
export function getSidebarWidth(): number {
  return loadWidth();
}
