import { useCallback, useEffect, useState } from "react";
import { UI_KEYS } from "../lib/storageKeys";

export const UI_FONT_SCALE_MIN_PERCENT = 50;
export const UI_FONT_SCALE_MAX_PERCENT = 300;
export const UI_FONT_SCALE_SLIDER_MIN_PERCENT = 85;
export const UI_FONT_SCALE_SLIDER_MAX_PERCENT = 130;
export const UI_FONT_SCALE_STEP_PERCENT = 5;
export const DEFAULT_UI_FONT_SCALE_PERCENT = 115;
export const UI_FONT_SCALE_PRESETS = [85, 100, 115, 130] as const;

const legacyFontSizePercents = {
  small: 85,
  default: 100,
  large: 115,
  larger: 130,
} as const;

function normalizeFontSizePercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_UI_FONT_SCALE_PERCENT;
  return Math.min(
    UI_FONT_SCALE_MAX_PERCENT,
    Math.max(UI_FONT_SCALE_MIN_PERCENT, value),
  );
}

function applyFontSize(percent: number) {
  const normalized = normalizeFontSizePercent(percent);
  const scale = normalized / 100;
  const root = document.documentElement;

  // Scale the root font-size to affect all rem/em units globally
  // This is the standard approach for accessibility font scaling
  root.style.fontSize = `${normalized}%`;

  // Also scale the CSS variables for elements using them directly (px-based)
  root.style.setProperty("--font-size-xs", `${10 * scale}px`);
  root.style.setProperty("--font-size-caption", `${11 * scale}px`);
  root.style.setProperty("--font-size-sm", `${12 * scale}px`);
  root.style.setProperty("--font-size-base", `${13 * scale}px`);
  root.style.setProperty("--font-size-lg", `${14 * scale}px`);
  root.style.setProperty("--font-size-xl", `${16 * scale}px`);
  root.style.setProperty("--font-size-2xl", `${18 * scale}px`);
}

function loadFontSize(): number {
  const stored = localStorage.getItem(UI_KEYS.fontSize);
  if (stored === null) return DEFAULT_UI_FONT_SCALE_PERCENT;
  if (stored && Object.hasOwn(legacyFontSizePercents, stored)) {
    return legacyFontSizePercents[
      stored as keyof typeof legacyFontSizePercents
    ];
  }
  return normalizeFontSizePercent(Number(stored));
}

function saveFontSize(percent: number) {
  localStorage.setItem(UI_KEYS.fontSize, String(percent));
}

/**
 * Hook to manage font size preference.
 * Persists to localStorage and applies CSS variables.
 */
export function useFontSize() {
  const [fontSizePercent, setFontSizeState] = useState(loadFontSize);

  // Apply font size on mount and when it changes
  useEffect(() => {
    applyFontSize(fontSizePercent);
  }, [fontSizePercent]);

  const setFontSizePercent = useCallback((percent: number) => {
    const normalized = normalizeFontSizePercent(percent);
    setFontSizeState(normalized);
    saveFontSize(normalized);
  }, []);

  return { fontSizePercent, setFontSizePercent };
}

/**
 * Initialize font size on app load (call once at startup).
 */
export function initializeFontSize() {
  const size = loadFontSize();
  applyFontSize(size);
}
