import { useCallback, useEffect, useState } from "react";
import { UI_KEYS } from "../lib/storageKeys";

export type OutputProseFont =
  | "system"
  | "source-serif-4"
  | "inter"
  | "alegreya-sans";
export type OutputFixedFont =
  | "system"
  | "iosevka"
  | "ibm-plex-mono"
  | "fira-mono";

export const OUTPUT_APPEARANCE_CHANGE_EVENT = "yep-output-appearance-change";

export const OUTPUT_PROSE_FONTS: OutputProseFont[] = [
  "system",
  "inter",
  "alegreya-sans",
  "source-serif-4",
];

export const OUTPUT_FIXED_FONTS: OutputFixedFont[] = [
  "system",
  "ibm-plex-mono",
  "fira-mono",
  "iosevka",
];

export const OUTPUT_FONT_SIZE_MIN_PX = 11;
export const OUTPUT_FONT_SIZE_MAX_PX = 20;
export const OUTPUT_FONT_SIZE_STEP_PX = 0.5;
export const DEFAULT_OUTPUT_FONT_SIZE_PX = 15;

export const OUTPUT_FONT_SIZE_PRESETS = [
  { value: 11, label: "S" },
  { value: 13, label: "D" },
  { value: 15, label: "L" },
  { value: 17, label: "XL" },
] as const;

export const OUTPUT_THINKING_FONT_SIZE_OFFSET_MIN_PX = -3;
export const OUTPUT_THINKING_FONT_SIZE_OFFSET_MAX_PX = 2;
export const OUTPUT_THINKING_FONT_SIZE_OFFSET_STEP_PX = 0.5;
export const DEFAULT_OUTPUT_THINKING_FONT_SIZE_OFFSET_PX = -1;
const OUTPUT_THINKING_FONT_SIZE_MIN_PX = 10;

export const OUTPUT_MATH_FONT_SIZE_OFFSET_MIN_PX = -2;
export const OUTPUT_MATH_FONT_SIZE_OFFSET_MAX_PX = 4;
export const OUTPUT_MATH_FONT_SIZE_OFFSET_STEP_PX = 0.5;
export const DEFAULT_OUTPUT_MATH_FONT_SIZE_OFFSET_PX = 1;

export const OUTPUT_FIXED_FONT_SIZE_OFFSET_MIN_PX = -3;
export const OUTPUT_FIXED_FONT_SIZE_OFFSET_MAX_PX = 3;
export const OUTPUT_FIXED_FONT_SIZE_OFFSET_STEP_PX = 0.5;
export const DEFAULT_OUTPUT_FIXED_FONT_SIZE_OFFSET_PX = 0;

export const USER_TURN_FONT_SIZE_OFFSET_MIN_PX = -3;
export const USER_TURN_FONT_SIZE_OFFSET_MAX_PX = 6;
export const USER_TURN_FONT_SIZE_OFFSET_STEP_PX = 0.5;
export const DEFAULT_USER_TURN_FONT_SIZE_OFFSET_PX = 0;

export const TOOLTIP_FONT_SIZE_OFFSET_MIN_PX = -3;
export const TOOLTIP_FONT_SIZE_OFFSET_MAX_PX = 6;
export const TOOLTIP_FONT_SIZE_OFFSET_STEP_PX = 0.5;
export const DEFAULT_TOOLTIP_FONT_SIZE_OFFSET_PX = 0;

export const OUTPUT_LINE_SPACING_MIN_PERCENT = -30;
export const OUTPUT_LINE_SPACING_MAX_PERCENT = 50;
export const OUTPUT_LINE_SPACING_STEP_PERCENT = 1;
export const DEFAULT_OUTPUT_LINE_SPACING_PERCENT = 0;

export const OUTPUT_VERTICAL_SPACING_MIN_PERCENT = -40;
export const OUTPUT_VERTICAL_SPACING_MAX_PERCENT = 70;
export const OUTPUT_VERTICAL_SPACING_STEP_PERCENT = 1;
export const DEFAULT_OUTPUT_VERTICAL_SPACING_PERCENT = 0;
export const OUTPUT_TOOL_PREVIEW_LINE_COUNT_MIN = 1;
export const OUTPUT_TOOL_PREVIEW_LINE_COUNT_MAX = 8;
export const OUTPUT_TOOL_PREVIEW_LINE_COUNT_STEP = 1;
export const DEFAULT_OUTPUT_TOOL_PREVIEW_LINE_COUNT = 2;
const SOURCE_SERIF_4_OUTPUT_OPSZ_MIN = 8;
const SOURCE_SERIF_4_OUTPUT_OPSZ_MAX = 20;

interface OutputAppearance {
  font: OutputProseFont;
  uiFont: OutputProseFont;
  userTurnFontSizeOffsetPx: number;
  tooltipFontSizeOffsetPx: number;
  fontSizePx: number;
  fixedFont: OutputFixedFont;
  fixedFontSizeOffsetPx: number;
  thinkingFontSizeOffsetPx: number;
  mathFontSizeOffsetPx: number;
  lineSpacingPercent: number;
  verticalSpacingPercent: number;
  toolPreviewLineCount: number;
}

const DEFAULT_OUTPUT_APPEARANCE: OutputAppearance = {
  font: "system",
  uiFont: "system",
  userTurnFontSizeOffsetPx: DEFAULT_USER_TURN_FONT_SIZE_OFFSET_PX,
  tooltipFontSizeOffsetPx: DEFAULT_TOOLTIP_FONT_SIZE_OFFSET_PX,
  fontSizePx: DEFAULT_OUTPUT_FONT_SIZE_PX,
  fixedFont: "system",
  fixedFontSizeOffsetPx: DEFAULT_OUTPUT_FIXED_FONT_SIZE_OFFSET_PX,
  thinkingFontSizeOffsetPx: DEFAULT_OUTPUT_THINKING_FONT_SIZE_OFFSET_PX,
  mathFontSizeOffsetPx: DEFAULT_OUTPUT_MATH_FONT_SIZE_OFFSET_PX,
  lineSpacingPercent: DEFAULT_OUTPUT_LINE_SPACING_PERCENT,
  verticalSpacingPercent: DEFAULT_OUTPUT_VERTICAL_SPACING_PERCENT,
  toolPreviewLineCount: DEFAULT_OUTPUT_TOOL_PREVIEW_LINE_COUNT,
};

const outputFontStacks: Record<OutputProseFont, string> = {
  system: "var(--font-sans)",
  inter: "var(--font-output-inter)",
  "alegreya-sans": "var(--font-output-alegreya-sans)",
  "source-serif-4": "var(--font-output-serif)",
};

const outputFixedFontStacks: Record<OutputFixedFont, string> = {
  system: "var(--font-mono-system)",
  iosevka: "var(--font-mono-iosevka)",
  "ibm-plex-mono": "var(--font-mono-ibm-plex)",
  "fira-mono": "var(--font-mono-fira)",
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundToStep(value: number, step: number): number {
  return Number((Math.round(value / step) * step).toFixed(2));
}

function normalizeOutputFont(value: string | null): OutputProseFont {
  return value && OUTPUT_PROSE_FONTS.includes(value as OutputProseFont)
    ? (value as OutputProseFont)
    : "system";
}

function normalizeOutputFixedFont(value: string | null): OutputFixedFont {
  return value && OUTPUT_FIXED_FONTS.includes(value as OutputFixedFont)
    ? (value as OutputFixedFont)
    : "system";
}

function normalizeFontSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_OUTPUT_FONT_SIZE_PX;
  return clamp(
    roundToStep(value, OUTPUT_FONT_SIZE_STEP_PX),
    OUTPUT_FONT_SIZE_MIN_PX,
    OUTPUT_FONT_SIZE_MAX_PX,
  );
}

function normalizeThinkingFontSizeOffset(value: number): number {
  if (!Number.isFinite(value))
    return DEFAULT_OUTPUT_THINKING_FONT_SIZE_OFFSET_PX;
  return clamp(
    roundToStep(value, OUTPUT_THINKING_FONT_SIZE_OFFSET_STEP_PX),
    OUTPUT_THINKING_FONT_SIZE_OFFSET_MIN_PX,
    OUTPUT_THINKING_FONT_SIZE_OFFSET_MAX_PX,
  );
}

function normalizeMathFontSizeOffset(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_OUTPUT_MATH_FONT_SIZE_OFFSET_PX;
  return clamp(
    roundToStep(value, OUTPUT_MATH_FONT_SIZE_OFFSET_STEP_PX),
    OUTPUT_MATH_FONT_SIZE_OFFSET_MIN_PX,
    OUTPUT_MATH_FONT_SIZE_OFFSET_MAX_PX,
  );
}

function normalizeFixedFontSizeOffset(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_OUTPUT_FIXED_FONT_SIZE_OFFSET_PX;
  return clamp(
    roundToStep(value, OUTPUT_FIXED_FONT_SIZE_OFFSET_STEP_PX),
    OUTPUT_FIXED_FONT_SIZE_OFFSET_MIN_PX,
    OUTPUT_FIXED_FONT_SIZE_OFFSET_MAX_PX,
  );
}

function normalizeUserTurnFontSizeOffset(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_USER_TURN_FONT_SIZE_OFFSET_PX;
  return clamp(
    roundToStep(value, USER_TURN_FONT_SIZE_OFFSET_STEP_PX),
    USER_TURN_FONT_SIZE_OFFSET_MIN_PX,
    USER_TURN_FONT_SIZE_OFFSET_MAX_PX,
  );
}

function normalizeTooltipFontSizeOffset(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TOOLTIP_FONT_SIZE_OFFSET_PX;
  return clamp(
    roundToStep(value, TOOLTIP_FONT_SIZE_OFFSET_STEP_PX),
    TOOLTIP_FONT_SIZE_OFFSET_MIN_PX,
    TOOLTIP_FONT_SIZE_OFFSET_MAX_PX,
  );
}

function normalizeVerticalSpacingPercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_OUTPUT_VERTICAL_SPACING_PERCENT;
  return clamp(
    roundToStep(value, OUTPUT_VERTICAL_SPACING_STEP_PERCENT),
    OUTPUT_VERTICAL_SPACING_MIN_PERCENT,
    OUTPUT_VERTICAL_SPACING_MAX_PERCENT,
  );
}

function normalizeLineSpacingPercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_OUTPUT_LINE_SPACING_PERCENT;
  return clamp(
    roundToStep(value, OUTPUT_LINE_SPACING_STEP_PERCENT),
    OUTPUT_LINE_SPACING_MIN_PERCENT,
    OUTPUT_LINE_SPACING_MAX_PERCENT,
  );
}

function normalizeToolPreviewLineCount(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_OUTPUT_TOOL_PREVIEW_LINE_COUNT;
  return clamp(
    roundToStep(value, OUTPUT_TOOL_PREVIEW_LINE_COUNT_STEP),
    OUTPUT_TOOL_PREVIEW_LINE_COUNT_MIN,
    OUTPUT_TOOL_PREVIEW_LINE_COUNT_MAX,
  );
}

function deriveFontRelativePx(fontSizePx: number, percent: number): number {
  return Number(((fontSizePx * percent) / 100).toFixed(2));
}

function deriveOffsetFontSizePx(
  fontSizePx: number,
  offsetPx: number,
  minPx: number,
): number {
  return Number(Math.max(minPx, fontSizePx + offsetPx).toFixed(2));
}

function deriveThinkingFontSizePx(
  fontSizePx: number,
  thinkingFontSizeOffsetPx: number,
): number {
  return deriveOffsetFontSizePx(
    fontSizePx,
    thinkingFontSizeOffsetPx,
    OUTPUT_THINKING_FONT_SIZE_MIN_PX,
  );
}

function deriveSourceSerifOpticalSize(fontSizePx: number): number {
  return Number(
    clamp(
      fontSizePx,
      SOURCE_SERIF_4_OUTPUT_OPSZ_MIN,
      SOURCE_SERIF_4_OUTPUT_OPSZ_MAX,
    ).toFixed(2),
  );
}

function getFontVariationSettings(
  appearance: OutputAppearance,
  fontSizePx: number,
): string {
  if (appearance.font !== "source-serif-4") return "normal";
  return `"opsz" ${deriveSourceSerifOpticalSize(fontSizePx)}`;
}

function readStoredNumber(key: string, fallback: number): number {
  const stored = localStorage.getItem(key);
  return stored === null ? fallback : Number(stored);
}

function readStoredVerticalSpacingPercent(fontSizePx: number): number {
  const storedPercent = localStorage.getItem(
    UI_KEYS.outputProseVerticalSpacingPercent,
  );
  if (storedPercent !== null) {
    return normalizeVerticalSpacingPercent(Number(storedPercent));
  }

  const legacyPx = localStorage.getItem(UI_KEYS.outputProseVerticalSpacing);
  if (legacyPx !== null) {
    return normalizeVerticalSpacingPercent(
      (Number(legacyPx) / fontSizePx) * 100,
    );
  }

  return DEFAULT_OUTPUT_VERTICAL_SPACING_PERCENT;
}

function clearStoredOutputAppearance(): void {
  localStorage.removeItem(UI_KEYS.outputProseFont);
  localStorage.removeItem(UI_KEYS.outputUiFont);
  localStorage.removeItem(UI_KEYS.userTurnFontSizeOffset);
  localStorage.removeItem(UI_KEYS.tooltipFontSizeOffset);
  localStorage.removeItem(UI_KEYS.outputProseFontSize);
  localStorage.removeItem(UI_KEYS.outputFixedFont);
  localStorage.removeItem(UI_KEYS.outputFixedFontSizeOffset);
  localStorage.removeItem(UI_KEYS.outputProseThinkingFontSizeOffset);
  localStorage.removeItem(UI_KEYS.outputProseMathFontSizeOffset);
  localStorage.removeItem(UI_KEYS.outputProseLineSpacingPercent);
  localStorage.removeItem(UI_KEYS.outputProseVerticalSpacing);
  localStorage.removeItem(UI_KEYS.outputProseVerticalSpacingPercent);
  localStorage.removeItem(UI_KEYS.outputToolPreviewLineCount);
}

function loadOutputAppearance(): OutputAppearance {
  const fontSizePx = normalizeFontSize(
    readStoredNumber(UI_KEYS.outputProseFontSize, DEFAULT_OUTPUT_FONT_SIZE_PX),
  );

  return {
    font: normalizeOutputFont(localStorage.getItem(UI_KEYS.outputProseFont)),
    uiFont: normalizeOutputFont(localStorage.getItem(UI_KEYS.outputUiFont)),
    userTurnFontSizeOffsetPx: normalizeUserTurnFontSizeOffset(
      readStoredNumber(
        UI_KEYS.userTurnFontSizeOffset,
        DEFAULT_USER_TURN_FONT_SIZE_OFFSET_PX,
      ),
    ),
    tooltipFontSizeOffsetPx: normalizeTooltipFontSizeOffset(
      readStoredNumber(
        UI_KEYS.tooltipFontSizeOffset,
        DEFAULT_TOOLTIP_FONT_SIZE_OFFSET_PX,
      ),
    ),
    fontSizePx,
    fixedFont: normalizeOutputFixedFont(
      localStorage.getItem(UI_KEYS.outputFixedFont),
    ),
    fixedFontSizeOffsetPx: normalizeFixedFontSizeOffset(
      readStoredNumber(
        UI_KEYS.outputFixedFontSizeOffset,
        DEFAULT_OUTPUT_FIXED_FONT_SIZE_OFFSET_PX,
      ),
    ),
    thinkingFontSizeOffsetPx: normalizeThinkingFontSizeOffset(
      readStoredNumber(
        UI_KEYS.outputProseThinkingFontSizeOffset,
        DEFAULT_OUTPUT_THINKING_FONT_SIZE_OFFSET_PX,
      ),
    ),
    mathFontSizeOffsetPx: normalizeMathFontSizeOffset(
      readStoredNumber(
        UI_KEYS.outputProseMathFontSizeOffset,
        DEFAULT_OUTPUT_MATH_FONT_SIZE_OFFSET_PX,
      ),
    ),
    lineSpacingPercent: normalizeLineSpacingPercent(
      readStoredNumber(
        UI_KEYS.outputProseLineSpacingPercent,
        DEFAULT_OUTPUT_LINE_SPACING_PERCENT,
      ),
    ),
    verticalSpacingPercent: readStoredVerticalSpacingPercent(fontSizePx),
    toolPreviewLineCount: normalizeToolPreviewLineCount(
      readStoredNumber(
        UI_KEYS.outputToolPreviewLineCount,
        DEFAULT_OUTPUT_TOOL_PREVIEW_LINE_COUNT,
      ),
    ),
  };
}

function applyOutputAppearance(appearance: OutputAppearance) {
  const root = document.documentElement;
  const verticalSpacingPx = deriveFontRelativePx(
    appearance.fontSizePx,
    appearance.verticalSpacingPercent,
  );
  const thinkingFontSizePx = deriveThinkingFontSizePx(
    appearance.fontSizePx,
    appearance.thinkingFontSizeOffsetPx,
  );
  root.style.setProperty(
    "--output-prose-font-family",
    outputFontStacks[appearance.font],
  );
  root.style.setProperty("--font-ui", outputFontStacks[appearance.uiFont]);
  root.style.setProperty(
    "--user-turn-font-size-offset",
    `${appearance.userTurnFontSizeOffsetPx}px`,
  );
  root.style.setProperty(
    "--tooltip-font-size-offset",
    `${appearance.tooltipFontSizeOffsetPx}px`,
  );
  root.style.setProperty(
    "--output-prose-font-size",
    `${appearance.fontSizePx}px`,
  );
  root.style.setProperty(
    "--font-mono",
    outputFixedFontStacks[appearance.fixedFont],
  );
  root.style.setProperty(
    "--fixed-font-size-offset",
    `${appearance.fixedFontSizeOffsetPx}px`,
  );
  root.style.setProperty(
    "--output-prose-vspace-offset",
    `${verticalSpacingPx}px`,
  );
  root.style.setProperty(
    "--output-prose-line-height-offset",
    `${deriveFontRelativePx(appearance.fontSizePx, appearance.lineSpacingPercent)}px`,
  );
  root.style.setProperty(
    "--output-prose-font-optical-sizing",
    appearance.font === "source-serif-4" ? "none" : "auto",
  );
  root.style.setProperty(
    "--output-prose-font-variation-settings",
    getFontVariationSettings(appearance, appearance.fontSizePx),
  );
  root.style.setProperty(
    "--thinking-prose-font-size",
    `${thinkingFontSizePx}px`,
  );
  root.style.setProperty(
    "--output-math-font-size-offset",
    `${appearance.mathFontSizeOffsetPx}px`,
  );
  root.style.setProperty(
    "--thinking-prose-line-height-offset",
    `${deriveFontRelativePx(thinkingFontSizePx, appearance.lineSpacingPercent)}px`,
  );
  root.style.setProperty(
    "--tool-preview-line-count",
    String(appearance.toolPreviewLineCount),
  );
  root.style.setProperty(
    "--thinking-prose-font-variation-settings",
    getFontVariationSettings(appearance, thinkingFontSizePx),
  );
  window.dispatchEvent(new Event(OUTPUT_APPEARANCE_CHANGE_EVENT));
}

export function getOutputToolPreviewLineCount(): number {
  return normalizeToolPreviewLineCount(
    readStoredNumber(
      UI_KEYS.outputToolPreviewLineCount,
      DEFAULT_OUTPUT_TOOL_PREVIEW_LINE_COUNT,
    ),
  );
}

export function useOutputToolPreviewLineCount(): number {
  const [lineCount, setLineCount] = useState(getOutputToolPreviewLineCount);

  useEffect(() => {
    const updateLineCount = () => setLineCount(getOutputToolPreviewLineCount());
    updateLineCount();
    window.addEventListener(OUTPUT_APPEARANCE_CHANGE_EVENT, updateLineCount);
    return () =>
      window.removeEventListener(
        OUTPUT_APPEARANCE_CHANGE_EVENT,
        updateLineCount,
      );
  }, []);

  return lineCount;
}

export function useOutputAppearance() {
  const [appearance, setAppearance] =
    useState<OutputAppearance>(loadOutputAppearance);

  useEffect(() => {
    applyOutputAppearance(appearance);
  }, [appearance]);

  const setOutputFont = useCallback((font: OutputProseFont) => {
    const normalized = normalizeOutputFont(font);
    localStorage.setItem(UI_KEYS.outputProseFont, normalized);
    setAppearance((current) => ({ ...current, font: normalized }));
  }, []);

  const setOutputUiFont = useCallback((font: OutputProseFont) => {
    const normalized = normalizeOutputFont(font);
    localStorage.setItem(UI_KEYS.outputUiFont, normalized);
    setAppearance((current) => ({ ...current, uiFont: normalized }));
  }, []);

  const setUserTurnFontSizeOffsetPx = useCallback((offsetPx: number) => {
    const normalized = normalizeUserTurnFontSizeOffset(offsetPx);
    localStorage.setItem(UI_KEYS.userTurnFontSizeOffset, String(normalized));
    setAppearance((current) => ({
      ...current,
      userTurnFontSizeOffsetPx: normalized,
    }));
  }, []);

  const setTooltipFontSizeOffsetPx = useCallback((offsetPx: number) => {
    const normalized = normalizeTooltipFontSizeOffset(offsetPx);
    localStorage.setItem(UI_KEYS.tooltipFontSizeOffset, String(normalized));
    setAppearance((current) => ({
      ...current,
      tooltipFontSizeOffsetPx: normalized,
    }));
  }, []);

  const setOutputFontSizePx = useCallback((fontSizePx: number) => {
    const normalized = normalizeFontSize(fontSizePx);
    localStorage.setItem(UI_KEYS.outputProseFontSize, String(normalized));
    setAppearance((current) => ({ ...current, fontSizePx: normalized }));
  }, []);

  const setOutputFixedFont = useCallback((font: OutputFixedFont) => {
    const normalized = normalizeOutputFixedFont(font);
    localStorage.setItem(UI_KEYS.outputFixedFont, normalized);
    setAppearance((current) => ({ ...current, fixedFont: normalized }));
  }, []);

  const setOutputFixedFontSizeOffsetPx = useCallback((offsetPx: number) => {
    const normalized = normalizeFixedFontSizeOffset(offsetPx);
    localStorage.setItem(UI_KEYS.outputFixedFontSizeOffset, String(normalized));
    setAppearance((current) => ({
      ...current,
      fixedFontSizeOffsetPx: normalized,
    }));
  }, []);

  const setOutputThinkingFontSizeOffsetPx = useCallback((offsetPx: number) => {
    const normalized = normalizeThinkingFontSizeOffset(offsetPx);
    localStorage.setItem(
      UI_KEYS.outputProseThinkingFontSizeOffset,
      String(normalized),
    );
    setAppearance((current) => ({
      ...current,
      thinkingFontSizeOffsetPx: normalized,
    }));
  }, []);

  const setOutputMathFontSizeOffsetPx = useCallback((offsetPx: number) => {
    const normalized = normalizeMathFontSizeOffset(offsetPx);
    localStorage.setItem(
      UI_KEYS.outputProseMathFontSizeOffset,
      String(normalized),
    );
    setAppearance((current) => ({
      ...current,
      mathFontSizeOffsetPx: normalized,
    }));
  }, []);

  const setOutputLineSpacingPercent = useCallback(
    (lineSpacingPercent: number) => {
      const normalized = normalizeLineSpacingPercent(lineSpacingPercent);
      localStorage.setItem(
        UI_KEYS.outputProseLineSpacingPercent,
        String(normalized),
      );
      setAppearance((current) => ({
        ...current,
        lineSpacingPercent: normalized,
      }));
    },
    [],
  );

  const setOutputVerticalSpacingPercent = useCallback(
    (verticalSpacingPercent: number) => {
      const normalized = normalizeVerticalSpacingPercent(
        verticalSpacingPercent,
      );
      localStorage.setItem(
        UI_KEYS.outputProseVerticalSpacingPercent,
        String(normalized),
      );
      setAppearance((current) => ({
        ...current,
        verticalSpacingPercent: normalized,
      }));
    },
    [],
  );

  const setOutputToolPreviewLineCount = useCallback((lineCount: number) => {
    const normalized = normalizeToolPreviewLineCount(lineCount);
    localStorage.setItem(
      UI_KEYS.outputToolPreviewLineCount,
      String(normalized),
    );
    setAppearance((current) => ({
      ...current,
      toolPreviewLineCount: normalized,
    }));
  }, []);

  const resetOutputAppearance = useCallback(() => {
    clearStoredOutputAppearance();
    setAppearance({ ...DEFAULT_OUTPUT_APPEARANCE });
  }, []);

  return {
    outputFont: appearance.font,
    outputUiFont: appearance.uiFont,
    userTurnFontSizeOffsetPx: appearance.userTurnFontSizeOffsetPx,
    tooltipFontSizeOffsetPx: appearance.tooltipFontSizeOffsetPx,
    outputFontSizePx: appearance.fontSizePx,
    outputFixedFont: appearance.fixedFont,
    outputFixedFontSizeOffsetPx: appearance.fixedFontSizeOffsetPx,
    outputThinkingFontSizeOffsetPx: appearance.thinkingFontSizeOffsetPx,
    outputMathFontSizeOffsetPx: appearance.mathFontSizeOffsetPx,
    outputLineSpacingPercent: appearance.lineSpacingPercent,
    outputVerticalSpacingPercent: appearance.verticalSpacingPercent,
    outputToolPreviewLineCount: appearance.toolPreviewLineCount,
    setOutputFont,
    setOutputUiFont,
    setUserTurnFontSizeOffsetPx,
    setTooltipFontSizeOffsetPx,
    setOutputFontSizePx,
    setOutputFixedFont,
    setOutputFixedFontSizeOffsetPx,
    setOutputThinkingFontSizeOffsetPx,
    setOutputMathFontSizeOffsetPx,
    setOutputLineSpacingPercent,
    setOutputVerticalSpacingPercent,
    setOutputToolPreviewLineCount,
    resetOutputAppearance,
  };
}

export function initializeOutputAppearance() {
  applyOutputAppearance(loadOutputAppearance());
}
