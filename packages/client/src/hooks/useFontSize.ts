import { useCallback, useEffect, useState } from "react";

export type FontSize = "small" | "default" | "large" | "larger";

const FONT_SIZE_KEY = "claude-anywhere-font-size";

const fontSizeScales: Record<FontSize, number> = {
  small: 0.85,
  default: 1,
  large: 1.15,
  larger: 1.3,
};

const fontSizeLabels: Record<FontSize, string> = {
  small: "Small",
  default: "Default",
  large: "Large",
  larger: "Larger",
};

export const FONT_SIZES: FontSize[] = ["small", "default", "large", "larger"];

export function getFontSizeLabel(size: FontSize): string {
  return fontSizeLabels[size];
}

function applyFontSize(size: FontSize) {
  const scale = fontSizeScales[size];
  const root = document.documentElement;

  // Base sizes from CSS
  root.style.setProperty("--font-size-xs", `${10 * scale}px`);
  root.style.setProperty("--font-size-sm", `${12 * scale}px`);
  root.style.setProperty("--font-size-base", `${13 * scale}px`);
  root.style.setProperty("--font-size-lg", `${14 * scale}px`);
}

function loadFontSize(): FontSize {
  const stored = localStorage.getItem(FONT_SIZE_KEY);
  if (stored && FONT_SIZES.includes(stored as FontSize)) {
    return stored as FontSize;
  }
  return "default";
}

function saveFontSize(size: FontSize) {
  localStorage.setItem(FONT_SIZE_KEY, size);
}

/**
 * Hook to manage font size preference.
 * Persists to localStorage and applies CSS variables.
 */
export function useFontSize() {
  const [fontSize, setFontSizeState] = useState<FontSize>(loadFontSize);

  // Apply font size on mount and when it changes
  useEffect(() => {
    applyFontSize(fontSize);
  }, [fontSize]);

  const setFontSize = useCallback((size: FontSize) => {
    setFontSizeState(size);
    saveFontSize(size);
  }, []);

  return { fontSize, setFontSize };
}

/**
 * Initialize font size on app load (call once at startup).
 */
export function initializeFontSize() {
  const size = loadFontSize();
  applyFontSize(size);
}
