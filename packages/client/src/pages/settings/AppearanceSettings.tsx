import {
  GLOSSARY_TOOLTIPS_CAPABILITY,
  serverHasCapability,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ThinkingText } from "../../components/ThinkingText";
import tooltipStyles from "../../components/ui/TooltipLayer.module.css";
import { renderFixedFontMath } from "../../components/ui/FixedFontMathToggle";
import {
  DEFAULT_CONTENT_MAX_WIDTH_PX,
  MAX_CONTENT_MAX_WIDTH_PX,
  MIN_CONTENT_MAX_WIDTH_PX,
  useContentMaxWidth,
} from "../../hooks/useContentMaxWidth";
import {
  DEFAULT_HOVERCARD_MAX_HEIGHT_PX,
  HOVERCARD_MAX_HEIGHT_MAX_PX,
  HOVERCARD_MAX_HEIGHT_MIN_PX,
  HOVERCARD_MAX_HEIGHT_STEP_PX,
  useHoverCardAppearance,
} from "../../hooks/useHoverCardAppearance";
import { estimateHoverCardPromptLines } from "../../components/sessionHoverCardLines";
import { useDeveloperMode } from "../../hooks/useDeveloperMode";
import { useFloatingActionButtonEnabled } from "../../hooks/useFloatingActionButtonEnabled";
import {
  UI_FONT_SCALE_MAX_PERCENT,
  UI_FONT_SCALE_MIN_PERCENT,
  UI_FONT_SCALE_PRESETS,
  UI_FONT_SCALE_SLIDER_MAX_PERCENT,
  UI_FONT_SCALE_SLIDER_MIN_PERCENT,
  UI_FONT_SCALE_STEP_PERCENT,
  useFontSize,
} from "../../hooks/useFontSize";
import { useFunPhrases } from "../../hooks/useFunPhrases";
import {
  DEFAULT_GENERATED_TITLE_LENGTH,
  GENERATED_TITLE_LENGTH_MAX,
  GENERATED_TITLE_LENGTH_MIN,
  GENERATED_TITLE_LENGTH_STEP,
  useGeneratedTitleLength,
} from "../../hooks/useGeneratedTitleLength";
import { useGeneratedTitleEnabled } from "../../hooks/useGeneratedTitleEnabled";
import { useInlineMedia } from "../../hooks/useInlineMedia";
import {
  DEFAULT_OUTPUT_FIXED_FONT_SIZE_OFFSET_PX,
  DEFAULT_OUTPUT_FONT_SIZE_PX,
  DEFAULT_OUTPUT_LINE_SPACING_PERCENT,
  DEFAULT_OUTPUT_MATH_FONT_SIZE_OFFSET_PX,
  DEFAULT_OUTPUT_THINKING_FONT_SIZE_OFFSET_PX,
  DEFAULT_OUTPUT_TOOL_PREVIEW_LINE_COUNT,
  DEFAULT_OUTPUT_VERTICAL_SPACING_PERCENT,
  OUTPUT_FIXED_FONT_SIZE_OFFSET_MAX_PX,
  OUTPUT_FIXED_FONT_SIZE_OFFSET_MIN_PX,
  OUTPUT_FIXED_FONT_SIZE_OFFSET_STEP_PX,
  OUTPUT_FIXED_FONTS,
  OUTPUT_FONT_SIZE_MAX_PX,
  OUTPUT_FONT_SIZE_MIN_PX,
  OUTPUT_FONT_SIZE_PRESETS,
  OUTPUT_FONT_SIZE_STEP_PX,
  OUTPUT_LINE_SPACING_MAX_PERCENT,
  OUTPUT_LINE_SPACING_MIN_PERCENT,
  OUTPUT_LINE_SPACING_STEP_PERCENT,
  OUTPUT_MATH_FONT_SIZE_OFFSET_MAX_PX,
  OUTPUT_MATH_FONT_SIZE_OFFSET_MIN_PX,
  OUTPUT_MATH_FONT_SIZE_OFFSET_STEP_PX,
  OUTPUT_PROSE_FONTS,
  OUTPUT_THINKING_FONT_SIZE_OFFSET_MAX_PX,
  OUTPUT_THINKING_FONT_SIZE_OFFSET_MIN_PX,
  OUTPUT_THINKING_FONT_SIZE_OFFSET_STEP_PX,
  OUTPUT_TOOL_PREVIEW_LINE_COUNT_MAX,
  OUTPUT_TOOL_PREVIEW_LINE_COUNT_MIN,
  OUTPUT_TOOL_PREVIEW_LINE_COUNT_STEP,
  OUTPUT_VERTICAL_SPACING_MAX_PERCENT,
  OUTPUT_VERTICAL_SPACING_MIN_PERCENT,
  OUTPUT_VERTICAL_SPACING_STEP_PERCENT,
  USER_TURN_FONT_SIZE_OFFSET_MAX_PX,
  USER_TURN_FONT_SIZE_OFFSET_MIN_PX,
  USER_TURN_FONT_SIZE_OFFSET_STEP_PX,
  TOOLTIP_FONT_SIZE_OFFSET_MAX_PX,
  TOOLTIP_FONT_SIZE_OFFSET_MIN_PX,
  TOOLTIP_FONT_SIZE_OFFSET_STEP_PX,
  useOutputAppearance,
} from "../../hooks/useOutputAppearance";
import {
  QUOTE_REPLY_BUTTON_MODES,
  type QuoteReplyButtonMode,
  useQuoteReplyButtonMode,
} from "../../hooks/useQuoteReplyButtonMode";
import { SettingsItem } from "./SettingsItem";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { SettingsSection } from "./SettingsSection";
import { useSettingsUndoBaseline } from "./SettingsUndoContext";
import { useRemoteBasePath } from "../../hooks/useRemoteBasePath";
import {
  SETTINGS_ICON_STYLES,
  type SettingsIconStyle,
  useSettingsIconStyle,
} from "../../hooks/useSettingsIconStyle";
import { useSidebarDuplicateHiding } from "../../hooks/useSidebarDuplicateHiding";
import {
  SIDEBAR_SPACINGS,
  useSidebarSpacing,
} from "../../hooks/useSidebarSpacing";
import { TAB_SIZES, useTabSize } from "../../hooks/useTabSize";
import { useTabTitleActivityPreference } from "../../hooks/useTabTitleActivityPreference";
import { THEMES, useTheme } from "../../hooks/useTheme";
import { SUPPORTED_LOCALES, useI18n } from "../../i18n";
import {
  getLocaleLabel,
  getOutputFixedFontLabel,
  getOutputProseFontLabel,
  getSidebarSpacingLabel,
  getTabSizeLabel,
  getThemeLabel,
} from "../../i18n-settings";
import {
  settingsCategoryEmojiIcons,
  settingsCategoryIcons,
} from "./SettingsCategoryIcons";
import { CommittedRangeInput } from "../../components/ui/CommittedRangeInput";
import { CommittedRangeNumberInput } from "../../components/ui/CommittedRangeNumberInput";
import { SelectionActionButton } from "../../components/ui/SelectionActionCluster";
import {
  DEFAULT_TOOLTIP_DELAY_MS,
  TOOLTIP_DELAY_MAX_MS,
  TOOLTIP_DELAY_MIN_MS,
  TOOLTIP_DELAY_STEP_MS,
  useTooltipAppearance,
} from "../../hooks/useTooltipAppearance";
import { useWiderConversationActivityPreviews } from "../../hooks/useWiderConversationActivityPreviews";
import { useSelectionActionPreferences } from "../../hooks/useSelectionActionPreferences";
import { useGlossaryHints } from "../../hooks/useGlossaryHints";
import { useProjectCodeNamePreferences } from "../../hooks/useProjectCodeNamePreferences";
import { useRecentProjectPathLinks } from "../../hooks/useRecentProjectPathLinks";
import { useVersion } from "../../hooks/useVersion";

const OUTPUT_INLINE_MATH_SAMPLE = "$E=mc^2$";

function formatNumberSetting(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

interface UndoEntry {
  value: unknown;
  restore: (value: unknown) => void;
}

// Pairs a live settings value with its restore path. The cast inside is
// safe because construction guarantees value and setter share one T.
function undoEntry<T>(
  value: T,
  set: (value: T) => void,
  syncDraft?: (value: T) => void,
): UndoEntry {
  return {
    value,
    restore: (raw) => {
      const restored = raw as T;
      set(restored);
      syncDraft?.(restored);
    },
  };
}

function getSettingsIconStyleLabel(
  value: SettingsIconStyle,
  translate: (key: string) => string,
): string {
  switch (value) {
    case "flat":
      return translate("appearanceSettingsIconStyleFlat");
    case "flat-white":
      return translate("appearanceSettingsIconStyleFlatWhite");
    case "emoji":
      return translate("appearanceSettingsIconStyleEmoji");
  }
}

function getQuoteReplyButtonModeLabel(
  value: QuoteReplyButtonMode,
  translate: (key: string) => string,
): string {
  switch (value) {
    case "block":
      return translate("appearanceQuoteReplyButtonsBlock");
    case "paragraph-hover":
      return translate("appearanceQuoteReplyButtonsParagraphHover");
    case "paragraph-always":
      return translate("appearanceQuoteReplyButtonsParagraphAlways");
  }
}

export function AppearanceSettings() {
  const { locale, setLocale, t } = useI18n();
  useSettingsPaneTitle(t("appearanceSectionTitle"));
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();
  const { fontSizePercent, setFontSizePercent } = useFontSize();
  const { sidebarSpacing, setSidebarSpacing } = useSidebarSpacing();
  const {
    outputFont,
    outputUiFont,
    userTurnFontSizeOffsetPx,
    tooltipFontSizeOffsetPx,
    outputFontSizePx,
    outputFixedFont,
    outputFixedFontSizeOffsetPx,
    outputThinkingFontSizeOffsetPx,
    outputMathFontSizeOffsetPx,
    outputLineSpacingPercent,
    outputVerticalSpacingPercent,
    outputToolPreviewLineCount,
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
  } = useOutputAppearance();
  const { tabSize, setTabSize } = useTabSize();
  const { contentMaxWidth, setContentMaxWidth } = useContentMaxWidth();
  const {
    widerConversationActivityPreviews,
    setWiderConversationActivityPreviews,
  } = useWiderConversationActivityPreviews();
  const { glossaryHintsEnabled, setGlossaryHintsEnabled } = useGlossaryHints();
  const { version: versionInfo } = useVersion();
  const glossaryHintsSupported = serverHasCapability(
    versionInfo,
    GLOSSARY_TOOLTIPS_CAPABILITY,
  );
  const { hoverCardMaxHeightPx, setHoverCardMaxHeightPx } =
    useHoverCardAppearance();
  const { tooltipMode, tooltipDelayMs, setTooltipMode, setTooltipDelayMs } =
    useTooltipAppearance();
  const { generatedTitleLength, setGeneratedTitleLength } =
    useGeneratedTitleLength();
  const { generatedTitleEnabled, setGeneratedTitleEnabled } =
    useGeneratedTitleEnabled();
  // Estimated visible request lines at the chosen height. Uses the with-reply
  // case — the conservative estimate shown when a recent reply is also present.
  const hoverCardHeightLines = estimateHoverCardPromptLines(
    hoverCardMaxHeightPx,
    true,
  );
  const [contentMaxWidthDraft, setContentMaxWidthDraft] = useState(() =>
    String(contentMaxWidth),
  );
  const [hoverCardHeightDraft, setHoverCardHeightDraft] = useState(() =>
    String(hoverCardMaxHeightPx),
  );
  const [generatedTitleLengthDraft, setGeneratedTitleLengthDraft] = useState(
    () => String(generatedTitleLength),
  );
  const [outputFontSizeDraft, setOutputFontSizeDraft] = useState(() =>
    formatNumberSetting(outputFontSizePx),
  );
  const [outputFixedFontSizeOffsetDraft, setOutputFixedFontSizeOffsetDraft] =
    useState(() => formatNumberSetting(outputFixedFontSizeOffsetPx));
  const [
    outputThinkingFontSizeOffsetDraft,
    setOutputThinkingFontSizeOffsetDraft,
  ] = useState(() => formatNumberSetting(outputThinkingFontSizeOffsetPx));
  const [outputMathFontSizeOffsetDraft, setOutputMathFontSizeOffsetDraft] =
    useState(() => formatNumberSetting(outputMathFontSizeOffsetPx));
  const [outputLineSpacingDraft, setOutputLineSpacingDraft] = useState(() =>
    formatNumberSetting(outputLineSpacingPercent),
  );
  const [outputVerticalSpacingDraft, setOutputVerticalSpacingDraft] = useState(
    () => formatNumberSetting(outputVerticalSpacingPercent),
  );
  const [outputToolPreviewLineCountDraft, setOutputToolPreviewLineCountDraft] =
    useState(() => formatNumberSetting(outputToolPreviewLineCount));
  const { theme, setTheme } = useTheme();
  const { settingsIconStyle, setSettingsIconStyle } = useSettingsIconStyle();
  const {
    compactMultiImageGalleries,
    inlineMediaExpandedByDefault,
    setCompactMultiImageGalleries,
    setInlineMediaExpandedByDefault,
  } = useInlineMedia();
  const { recentProjectPathLinksEnabled, setRecentProjectPathLinksEnabled } =
    useRecentProjectPathLinks();
  const { quoteReplyButtonMode, setQuoteReplyButtonMode } =
    useQuoteReplyButtonMode();
  const {
    selectionQuoteActionEnabled,
    setSelectionQuoteActionEnabled,
    selectionTextCopyActionEnabled,
    setSelectionTextCopyActionEnabled,
    selectionSourceCopyActionEnabled,
    setSelectionSourceCopyActionEnabled,
    selectionRichCopyActionEnabled,
    setSelectionRichCopyActionEnabled,
    selectionNewSessionActionEnabled,
    setSelectionNewSessionActionEnabled,
  } = useSelectionActionPreferences();
  const { funPhrasesEnabled, setFunPhrasesEnabled } = useFunPhrases();
  const { floatingActionButtonEnabled, setFloatingActionButtonEnabled } =
    useFloatingActionButtonEnabled();
  const { sidebarDuplicateHidingEnabled, setSidebarDuplicateHidingEnabled } =
    useSidebarDuplicateHiding();
  const {
    projectCodeNamesEnabled,
    setProjectCodeNamesEnabled,
    projectCodeNameActivityPulseEnabled,
    setProjectCodeNameActivityPulseEnabled,
  } = useProjectCodeNamePreferences();
  const { tabTitleActivityEnabled, setTabTitleActivityEnabled } =
    useTabTitleActivityPreference();
  const { showConnectionBars, setShowConnectionBars } = useDeveloperMode();
  const outputInlineMathHtml = useMemo(
    () => renderFixedFontMath(OUTPUT_INLINE_MATH_SAMPLE).html,
    [],
  );
  // Header undo: snapshot every appearance value at pane open; restore sets
  // each preference and re-syncs its draft field where one exists. Each row
  // pairs a value with its setter so the snapshot, change detection, and
  // restore cannot drift apart; a new setting is one row here.
  const undoEntries = [
    undoEntry(locale, setLocale),
    undoEntry(fontSizePercent, setFontSizePercent),
    undoEntry(sidebarSpacing, setSidebarSpacing),
    undoEntry(outputFont, setOutputFont),
    undoEntry(outputUiFont, setOutputUiFont),
    undoEntry(userTurnFontSizeOffsetPx, setUserTurnFontSizeOffsetPx),
    undoEntry(tooltipFontSizeOffsetPx, setTooltipFontSizeOffsetPx),
    undoEntry(outputFontSizePx, setOutputFontSizePx, (value) =>
      setOutputFontSizeDraft(formatNumberSetting(value)),
    ),
    undoEntry(outputFixedFont, setOutputFixedFont),
    undoEntry(
      outputFixedFontSizeOffsetPx,
      setOutputFixedFontSizeOffsetPx,
      (value) => setOutputFixedFontSizeOffsetDraft(formatNumberSetting(value)),
    ),
    undoEntry(
      outputThinkingFontSizeOffsetPx,
      setOutputThinkingFontSizeOffsetPx,
      (value) =>
        setOutputThinkingFontSizeOffsetDraft(formatNumberSetting(value)),
    ),
    undoEntry(
      outputMathFontSizeOffsetPx,
      setOutputMathFontSizeOffsetPx,
      (value) => setOutputMathFontSizeOffsetDraft(formatNumberSetting(value)),
    ),
    undoEntry(outputLineSpacingPercent, setOutputLineSpacingPercent, (value) =>
      setOutputLineSpacingDraft(formatNumberSetting(value)),
    ),
    undoEntry(
      outputVerticalSpacingPercent,
      setOutputVerticalSpacingPercent,
      (value) => setOutputVerticalSpacingDraft(formatNumberSetting(value)),
    ),
    undoEntry(
      outputToolPreviewLineCount,
      setOutputToolPreviewLineCount,
      (value) => setOutputToolPreviewLineCountDraft(formatNumberSetting(value)),
    ),
    undoEntry(tabSize, setTabSize),
    undoEntry(contentMaxWidth, setContentMaxWidth, (value) =>
      setContentMaxWidthDraft(String(value)),
    ),
    undoEntry(
      widerConversationActivityPreviews,
      setWiderConversationActivityPreviews,
    ),
    undoEntry(glossaryHintsEnabled, setGlossaryHintsEnabled),
    undoEntry(tooltipDelayMs, setTooltipDelayMs),
    undoEntry(tooltipMode, setTooltipMode),
    undoEntry(hoverCardMaxHeightPx, setHoverCardMaxHeightPx, (value) =>
      setHoverCardHeightDraft(String(value)),
    ),
    undoEntry(generatedTitleEnabled, setGeneratedTitleEnabled),
    undoEntry(generatedTitleLength, setGeneratedTitleLength, (value) =>
      setGeneratedTitleLengthDraft(String(value)),
    ),
    undoEntry(theme, setTheme),
    undoEntry(settingsIconStyle, setSettingsIconStyle),
    undoEntry(inlineMediaExpandedByDefault, setInlineMediaExpandedByDefault),
    undoEntry(compactMultiImageGalleries, setCompactMultiImageGalleries),
    undoEntry(recentProjectPathLinksEnabled, setRecentProjectPathLinksEnabled),
    undoEntry(quoteReplyButtonMode, setQuoteReplyButtonMode),
    undoEntry(selectionQuoteActionEnabled, setSelectionQuoteActionEnabled),
    undoEntry(
      selectionTextCopyActionEnabled,
      setSelectionTextCopyActionEnabled,
    ),
    undoEntry(
      selectionSourceCopyActionEnabled,
      setSelectionSourceCopyActionEnabled,
    ),
    undoEntry(
      selectionRichCopyActionEnabled,
      setSelectionRichCopyActionEnabled,
    ),
    undoEntry(
      selectionNewSessionActionEnabled,
      setSelectionNewSessionActionEnabled,
    ),
    undoEntry(funPhrasesEnabled, setFunPhrasesEnabled),
    undoEntry(floatingActionButtonEnabled, setFloatingActionButtonEnabled),
    undoEntry(sidebarDuplicateHidingEnabled, setSidebarDuplicateHidingEnabled),
    undoEntry(projectCodeNamesEnabled, setProjectCodeNamesEnabled),
    undoEntry(tabTitleActivityEnabled, setTabTitleActivityEnabled),
    undoEntry(
      projectCodeNameActivityPulseEnabled,
      setProjectCodeNameActivityPulseEnabled,
    ),
    undoEntry(showConnectionBars, setShowConnectionBars),
  ];
  const undoEntriesRef = useRef(undoEntries);
  undoEntriesRef.current = undoEntries;
  const undoValues = undoEntries.map((entry) => entry.value);
  const restoreUndoState = useCallback((snapshot: unknown[]) => {
    undoEntriesRef.current.forEach((entry, index) => {
      entry.restore(snapshot[index]);
    });
  }, []);
  useSettingsUndoBaseline(undoValues, restoreUndoState);

  const translate = (key: string) => t(key as never);

  useEffect(() => {
    setContentMaxWidthDraft(String(contentMaxWidth));
  }, [contentMaxWidth]);

  useEffect(() => {
    setHoverCardHeightDraft(String(hoverCardMaxHeightPx));
  }, [hoverCardMaxHeightPx]);

  useEffect(() => {
    setGeneratedTitleLengthDraft(String(generatedTitleLength));
  }, [generatedTitleLength]);

  useEffect(() => {
    setOutputFontSizeDraft(formatNumberSetting(outputFontSizePx));
  }, [outputFontSizePx]);

  useEffect(() => {
    setOutputFixedFontSizeOffsetDraft(
      formatNumberSetting(outputFixedFontSizeOffsetPx),
    );
  }, [outputFixedFontSizeOffsetPx]);

  useEffect(() => {
    setOutputThinkingFontSizeOffsetDraft(
      formatNumberSetting(outputThinkingFontSizeOffsetPx),
    );
  }, [outputThinkingFontSizeOffsetPx]);

  useEffect(() => {
    setOutputMathFontSizeOffsetDraft(
      formatNumberSetting(outputMathFontSizeOffsetPx),
    );
  }, [outputMathFontSizeOffsetPx]);

  useEffect(() => {
    setOutputLineSpacingDraft(formatNumberSetting(outputLineSpacingPercent));
  }, [outputLineSpacingPercent]);

  useEffect(() => {
    setOutputVerticalSpacingDraft(
      formatNumberSetting(outputVerticalSpacingPercent),
    );
  }, [outputVerticalSpacingPercent]);

  useEffect(() => {
    setOutputToolPreviewLineCountDraft(
      formatNumberSetting(outputToolPreviewLineCount),
    );
  }, [outputToolPreviewLineCount]);

  const commitContentMaxWidth = () => {
    const parsed = Number.parseInt(contentMaxWidthDraft, 10);
    setContentMaxWidth(
      Number.isFinite(parsed) ? parsed : DEFAULT_CONTENT_MAX_WIDTH_PX,
    );
  };

  const commitHoverCardHeight = () => {
    const parsed = Number(hoverCardHeightDraft);
    setHoverCardMaxHeightPx(
      Number.isFinite(parsed) ? parsed : DEFAULT_HOVERCARD_MAX_HEIGHT_PX,
    );
  };

  const commitGeneratedTitleLength = () => {
    const parsed = Number(generatedTitleLengthDraft);
    setGeneratedTitleLength(
      Number.isFinite(parsed) ? parsed : DEFAULT_GENERATED_TITLE_LENGTH,
    );
  };

  const commitOutputFontSize = () => {
    const parsed = Number(outputFontSizeDraft);
    setOutputFontSizePx(
      Number.isFinite(parsed) ? parsed : DEFAULT_OUTPUT_FONT_SIZE_PX,
    );
  };

  const commitOutputFixedFontSizeOffset = () => {
    const parsed = Number(outputFixedFontSizeOffsetDraft);
    setOutputFixedFontSizeOffsetPx(
      Number.isFinite(parsed)
        ? parsed
        : DEFAULT_OUTPUT_FIXED_FONT_SIZE_OFFSET_PX,
    );
  };

  const commitOutputThinkingFontSizeOffset = () => {
    const parsed = Number(outputThinkingFontSizeOffsetDraft);
    setOutputThinkingFontSizeOffsetPx(
      Number.isFinite(parsed)
        ? parsed
        : DEFAULT_OUTPUT_THINKING_FONT_SIZE_OFFSET_PX,
    );
  };

  const commitOutputMathFontSizeOffset = () => {
    const parsed = Number(outputMathFontSizeOffsetDraft);
    setOutputMathFontSizeOffsetPx(
      Number.isFinite(parsed)
        ? parsed
        : DEFAULT_OUTPUT_MATH_FONT_SIZE_OFFSET_PX,
    );
  };

  const commitOutputLineSpacing = () => {
    const parsed = Number(outputLineSpacingDraft);
    setOutputLineSpacingPercent(
      Number.isFinite(parsed) ? parsed : DEFAULT_OUTPUT_LINE_SPACING_PERCENT,
    );
  };

  const commitOutputVerticalSpacing = () => {
    const parsed = Number(outputVerticalSpacingDraft);
    setOutputVerticalSpacingPercent(
      Number.isFinite(parsed)
        ? parsed
        : DEFAULT_OUTPUT_VERTICAL_SPACING_PERCENT,
    );
  };

  const commitOutputToolPreviewLineCount = () => {
    const parsed = Number(outputToolPreviewLineCountDraft);
    setOutputToolPreviewLineCount(
      Number.isFinite(parsed) ? parsed : DEFAULT_OUTPUT_TOOL_PREVIEW_LINE_COUNT,
    );
  };

  return (
    <SettingsSection
      keywords={[
        "font",
        "typography",
        "text size",
        "line spacing",
        "sidebar layout density compact comfortable spacing",
        "generated titles",
        "conversation view activity previews thinking",
      ]}
    >
      <div className="settings-group">
        <SettingsItem
          label={t("appearanceLanguageTitle")}
          description={t("appearanceLanguageDescription")}
          valueText={getLocaleLabel(locale, translate)}
        >
          <select
            className="settings-select"
            value={locale}
            onChange={(e) =>
              setLocale(e.target.value as (typeof SUPPORTED_LOCALES)[number])
            }
            aria-label={t("appearanceLanguageTitle")}
          >
            {SUPPORTED_LOCALES.map((value) => (
              <option key={value} value={value}>
                {getLocaleLabel(value, translate)}
              </option>
            ))}
          </select>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceThemeTitle")}
          valueText={getThemeLabel(theme, translate)}
        >
          <div className="font-size-selector">
            {THEMES.map((themeValue) => (
              <button
                key={themeValue}
                type="button"
                className={`font-size-option ${theme === themeValue ? "active" : ""}`}
                onClick={() => setTheme(themeValue)}
              >
                {getThemeLabel(themeValue, translate)}
              </button>
            ))}
          </div>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceSettingsIconStyleTitle")}
          description={t("appearanceSettingsIconStyleDescription")}
          valueText={getSettingsIconStyleLabel(settingsIconStyle, translate)}
          className="settings-item--wide-control"
        >
          <div
            className="font-size-selector settings-icon-style-selector"
            role="group"
            aria-label={t("appearanceSettingsIconStyleTitle")}
          >
            {SETTINGS_ICON_STYLES.map((style) => {
              const selected = settingsIconStyle === style;
              const preview =
                style === "emoji"
                  ? settingsCategoryEmojiIcons["local-access"]
                  : settingsCategoryIcons["local-access"];
              return (
                <button
                  key={style}
                  type="button"
                  className={`font-size-option settings-icon-style-option ${selected ? "active" : ""}`}
                  onClick={() => setSettingsIconStyle(style)}
                  aria-pressed={selected}
                >
                  <span
                    className={`settings-category-icon settings-category-icon-local-access settings-category-icon-${style} settings-icon-style-preview`}
                    aria-hidden="true"
                  >
                    {preview}
                  </span>
                  <span>{getSettingsIconStyleLabel(style, translate)}</span>
                </button>
              );
            })}
          </div>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceContentWidthTitle")}
          description={t("appearanceContentWidthDescription")}
          className="settings-item--wide-control"
        >
          <div className="settings-item-actions">
            <CommittedRangeInput
              min={MIN_CONTENT_MAX_WIDTH_PX}
              max={MAX_CONTENT_MAX_WIDTH_PX}
              step={10}
              value={contentMaxWidth}
              onDraftChange={(value) => setContentMaxWidthDraft(String(value))}
              onCommit={setContentMaxWidth}
              aria-label={t("appearanceContentWidthTitle")}
            />
            <span className="settings-input-unit">
              <input
                type="number"
                className="settings-input-small"
                min={MIN_CONTENT_MAX_WIDTH_PX}
                max={MAX_CONTENT_MAX_WIDTH_PX}
                step={10}
                value={contentMaxWidthDraft}
                onChange={(e) => setContentMaxWidthDraft(e.target.value)}
                onBlur={commitContentMaxWidth}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    commitContentMaxWidth();
                    e.currentTarget.blur();
                  }
                }}
                aria-label={t("appearanceContentWidthTitle")}
              />
              {t("appearanceContentWidthUnit")}
            </span>
            <button
              type="button"
              className="settings-inline-x"
              onClick={() => {
                setContentMaxWidth(DEFAULT_CONTENT_MAX_WIDTH_PX);
                setContentMaxWidthDraft(String(DEFAULT_CONTENT_MAX_WIDTH_PX));
              }}
              aria-label={t("appearanceContentWidthReset")}
              title={t("appearanceContentWidthReset")}
            >
              ×
            </button>
          </div>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceSidebarSpacingTitle")}
          description={t("appearanceSidebarSpacingDescription")}
          keywords={["sidebar spacing", "layout", "compact", "comfortable"]}
          valueText={getSidebarSpacingLabel(sidebarSpacing, translate)}
          className="settings-item--wide-control"
        >
          <div
            className="font-size-selector"
            role="radiogroup"
            aria-label={t("appearanceSidebarSpacingTitle")}
          >
            {SIDEBAR_SPACINGS.map((spacing) => {
              const selected = sidebarSpacing === spacing;
              return (
                <button
                  key={spacing}
                  type="button"
                  className={`font-size-option ${selected ? "active" : ""}`}
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setSidebarSpacing(spacing)}
                >
                  {getSidebarSpacingLabel(spacing, translate)}
                </button>
              );
            })}
          </div>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceOutputToolPreviewLinesLabel")}
          className="settings-item--wide-control"
        >
          <div className="settings-item-actions">
            <CommittedRangeInput
              min={OUTPUT_TOOL_PREVIEW_LINE_COUNT_MIN}
              max={OUTPUT_TOOL_PREVIEW_LINE_COUNT_MAX}
              step={OUTPUT_TOOL_PREVIEW_LINE_COUNT_STEP}
              value={outputToolPreviewLineCount}
              onDraftChange={(value) =>
                setOutputToolPreviewLineCountDraft(formatNumberSetting(value))
              }
              onCommit={setOutputToolPreviewLineCount}
              aria-label={t("appearanceOutputToolPreviewLinesLabel")}
            />
            <span className="settings-input-unit">
              <input
                type="number"
                className="settings-input-small"
                min={OUTPUT_TOOL_PREVIEW_LINE_COUNT_MIN}
                max={OUTPUT_TOOL_PREVIEW_LINE_COUNT_MAX}
                step={OUTPUT_TOOL_PREVIEW_LINE_COUNT_STEP}
                value={outputToolPreviewLineCountDraft}
                onChange={(e) =>
                  setOutputToolPreviewLineCountDraft(e.target.value)
                }
                onBlur={commitOutputToolPreviewLineCount}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    commitOutputToolPreviewLineCount();
                    e.currentTarget.blur();
                  }
                }}
                aria-label={t("appearanceOutputToolPreviewLinesLabel")}
              />
              {t("appearanceOutputToolPreviewLinesUnit")}
            </span>
          </div>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceWiderActivityPreviewsTitle")}
          description={t("appearanceWiderActivityPreviewsDescription")}
        >
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={widerConversationActivityPreviews}
              onChange={(event) =>
                setWiderConversationActivityPreviews(event.target.checked)
              }
              aria-label={t("appearanceWiderActivityPreviewsTitle")}
            />
            <span className="toggle-slider" />
          </label>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceTabSizeTitle")}
          description={t("appearanceTabSizeDescription")}
          valueText={getTabSizeLabel(tabSize)}
        >
          <div className="font-size-selector">
            {TAB_SIZES.map((size) => (
              <button
                key={size}
                type="button"
                className={`font-size-option ${tabSize === size ? "active" : ""}`}
                onClick={() => setTabSize(size)}
              >
                {getTabSizeLabel(size)}
              </button>
            ))}
          </div>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceGeneratedTitlesTitle")}
          description={t("appearanceGeneratedTitlesDescription")}
          keywords={[
            t("appearanceGeneratedTitleLengthTitle"),
            t("appearanceGeneratedTitleLengthDescription"),
          ]}
          layout="custom"
          baseClassName="settings-item-group"
          className="generated-title-settings"
        >
          <div className="settings-item-group-row">
            <div className="settings-item-info">
              <strong>{t("appearanceGeneratedTitlesTitle")}</strong>
              <p>{t("appearanceGeneratedTitlesDescription")}</p>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={generatedTitleEnabled}
                onChange={(e) => setGeneratedTitleEnabled(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>
          {generatedTitleEnabled && (
            <div className="settings-item-group-row settings-item-group-row--field settings-item-group-row--wide-control">
              <div className="settings-item-info">
                <strong>{t("appearanceGeneratedTitleLengthTitle")}</strong>
                <p>{t("appearanceGeneratedTitleLengthDescription")}</p>
              </div>
              <div className="settings-item-actions">
                <CommittedRangeInput
                  min={GENERATED_TITLE_LENGTH_MIN}
                  max={GENERATED_TITLE_LENGTH_MAX}
                  step={GENERATED_TITLE_LENGTH_STEP}
                  value={generatedTitleLength}
                  onDraftChange={(value) =>
                    setGeneratedTitleLengthDraft(String(value))
                  }
                  onCommit={setGeneratedTitleLength}
                  aria-label={t("appearanceGeneratedTitleLengthTitle")}
                />
                <span className="settings-input-unit">
                  <input
                    type="number"
                    className="settings-input-small"
                    min={GENERATED_TITLE_LENGTH_MIN}
                    max={GENERATED_TITLE_LENGTH_MAX}
                    step={GENERATED_TITLE_LENGTH_STEP}
                    value={generatedTitleLengthDraft}
                    onChange={(e) =>
                      setGeneratedTitleLengthDraft(e.target.value)
                    }
                    onBlur={commitGeneratedTitleLength}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        commitGeneratedTitleLength();
                        e.currentTarget.blur();
                      }
                    }}
                    aria-label={t("appearanceGeneratedTitleLengthTitle")}
                  />
                  {t("appearanceGeneratedTitleLengthUnit")}
                </span>
                <button
                  type="button"
                  className="settings-inline-x"
                  onClick={() => {
                    setGeneratedTitleLength(DEFAULT_GENERATED_TITLE_LENGTH);
                    setGeneratedTitleLengthDraft(
                      String(DEFAULT_GENERATED_TITLE_LENGTH),
                    );
                  }}
                  aria-label={t("appearanceGeneratedTitleLengthReset")}
                  title={t("appearanceGeneratedTitleLengthReset")}
                >
                  ×
                </button>
              </div>
            </div>
          )}
        </SettingsItem>
        {glossaryHintsSupported && (
          <SettingsItem
            label={t("appearanceGlossaryHintsTitle")}
            description={t("appearanceGlossaryHintsDescription")}
          >
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={glossaryHintsEnabled}
                onChange={(event) =>
                  setGlossaryHintsEnabled(event.target.checked)
                }
                aria-label={t("appearanceGlossaryHintsTitle")}
              />
              <span className="toggle-slider" />
            </label>
          </SettingsItem>
        )}
        <SettingsItem
          label={t("appearanceTooltipDelayTitle")}
          description={t("appearanceTooltipDelayDescription")}
          className="settings-item--wide-control settings-item--tooltip-control"
        >
          <div className="settings-item-actions tooltip-settings-actions">
            <div
              className="font-size-selector tooltip-mode-selector"
              role="group"
              aria-label={t("appearanceTooltipModeTitle")}
            >
              <button
                type="button"
                className={`font-size-option ${
                  tooltipMode === "themed" ? "active" : ""
                }`}
                onClick={() => setTooltipMode("themed")}
              >
                {t("appearanceTooltipModeThemed")}
              </button>
              <button
                type="button"
                className={`font-size-option ${
                  tooltipMode === "native" ? "active" : ""
                }`}
                onClick={() => setTooltipMode("native")}
              >
                {t("appearanceTooltipModeNative")}
              </button>
            </div>
            <CommittedRangeNumberInput
              id="tooltip-delay"
              min={TOOLTIP_DELAY_MIN_MS}
              max={TOOLTIP_DELAY_MAX_MS}
              step={TOOLTIP_DELAY_STEP_MS}
              value={tooltipDelayMs}
              unit={t("appearanceTooltipDelayUnit")}
              ariaLabel={t("appearanceTooltipDelayTitle")}
              onEdit={() => setTooltipMode("themed")}
              onCommit={setTooltipDelayMs}
            />
            <button
              type="button"
              className="settings-inline-x"
              onClick={() => {
                setTooltipDelayMs(DEFAULT_TOOLTIP_DELAY_MS);
              }}
              aria-label={t("appearanceTooltipReset")}
              title={t("appearanceTooltipReset")}
            >
              ×
            </button>
          </div>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceHoverCardHeightTitle")}
          description={t("appearanceHoverCardHeightDescription")}
          className="settings-item--wide-control"
        >
          <div className="settings-item-actions">
            <CommittedRangeInput
              min={HOVERCARD_MAX_HEIGHT_MIN_PX}
              max={HOVERCARD_MAX_HEIGHT_MAX_PX}
              step={HOVERCARD_MAX_HEIGHT_STEP_PX}
              value={hoverCardMaxHeightPx}
              onDraftChange={(value) => setHoverCardHeightDraft(String(value))}
              onCommit={setHoverCardMaxHeightPx}
              aria-label={t("appearanceHoverCardHeightTitle")}
            />
            <span className="settings-input-unit">
              <input
                type="number"
                className="settings-input-small"
                min={HOVERCARD_MAX_HEIGHT_MIN_PX}
                max={HOVERCARD_MAX_HEIGHT_MAX_PX}
                step={HOVERCARD_MAX_HEIGHT_STEP_PX}
                value={hoverCardHeightDraft}
                onChange={(e) => setHoverCardHeightDraft(e.target.value)}
                onBlur={commitHoverCardHeight}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    commitHoverCardHeight();
                    e.currentTarget.blur();
                  }
                }}
                aria-label={t("appearanceHoverCardHeightTitle")}
              />
              {t("appearanceHoverCardHeightUnit")}
            </span>
            <span className="settings-hovercard-lines">
              ({hoverCardHeightLines}{" "}
              {hoverCardHeightLines === 1
                ? t("appearanceHoverCardLineUnit")
                : t("appearanceHoverCardLinesUnit")}
              )
            </span>
            <button
              type="button"
              className="settings-inline-x"
              onClick={() => {
                setHoverCardMaxHeightPx(DEFAULT_HOVERCARD_MAX_HEIGHT_PX);
                setHoverCardHeightDraft(
                  String(DEFAULT_HOVERCARD_MAX_HEIGHT_PX),
                );
              }}
              aria-label={t("appearanceHoverCardReset")}
              title={t("appearanceHoverCardReset")}
            >
              ×
            </button>
          </div>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceInlineImagesTitle")}
          description={t("appearanceInlineImagesDescription")}
        >
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={inlineMediaExpandedByDefault}
              onChange={(e) =>
                setInlineMediaExpandedByDefault(e.target.checked)
              }
            />
            <span className="toggle-slider" />
          </label>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceImageGalleriesTitle")}
          description={t("appearanceImageGalleriesDescription")}
        >
          <label className="toggle-switch">
            <input
              type="checkbox"
              aria-label={t("appearanceImageGalleriesTitle")}
              checked={compactMultiImageGalleries}
              onChange={(e) => setCompactMultiImageGalleries(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceRecentProjectPathLinksTitle")}
          description={t("appearanceRecentProjectPathLinksDescription")}
        >
          <label className="toggle-switch">
            <input
              type="checkbox"
              aria-label={t("appearanceRecentProjectPathLinksTitle")}
              checked={recentProjectPathLinksEnabled}
              onChange={(event) =>
                setRecentProjectPathLinksEnabled(event.target.checked)
              }
            />
            <span className="toggle-slider" />
          </label>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceQuoteReplyButtonsTitle")}
          description={t("appearanceQuoteReplyButtonsDescription")}
          valueText={getQuoteReplyButtonModeLabel(
            quoteReplyButtonMode,
            translate,
          )}
          className="settings-item--wide-control"
        >
          <div
            className="font-size-selector"
            role="radiogroup"
            aria-label={t("appearanceQuoteReplyButtonsTitle")}
          >
            {QUOTE_REPLY_BUTTON_MODES.map((mode) => {
              const selected = quoteReplyButtonMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  className={`font-size-option ${selected ? "active" : ""}`}
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setQuoteReplyButtonMode(mode)}
                >
                  {getQuoteReplyButtonModeLabel(mode, translate)}
                </button>
              );
            })}
          </div>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceSelectionQuoteActionTitle")}
          description={t("appearanceSelectionQuoteActionDescription")}
        >
          <SelectionActionButton
            kind="quote"
            label={t("sessionQuoteSelection")}
            specimen
          />
          <label className="toggle-switch">
            <input
              type="checkbox"
              aria-label={t("appearanceSelectionQuoteActionTitle")}
              checked={selectionQuoteActionEnabled}
              onChange={(event) =>
                setSelectionQuoteActionEnabled(event.target.checked)
              }
            />
            <span className="toggle-slider" />
          </label>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceSelectionTextCopyActionTitle" as never)}
          description={t(
            "appearanceSelectionTextCopyActionDescription" as never,
          )}
        >
          <SelectionActionButton
            kind="text"
            label={t("sessionCopySelectionText" as never)}
            specimen
          />
          <label className="toggle-switch">
            <input
              type="checkbox"
              aria-label={t("appearanceSelectionTextCopyActionTitle" as never)}
              checked={selectionTextCopyActionEnabled}
              onChange={(event) =>
                setSelectionTextCopyActionEnabled(event.target.checked)
              }
            />
            <span className="toggle-slider" />
          </label>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceSelectionSourceCopyActionTitle")}
          description={t("appearanceSelectionSourceCopyActionDescription")}
        >
          <SelectionActionButton
            kind="source"
            label={t("sessionCopySelectionSource")}
            specimen
          />
          <label className="toggle-switch">
            <input
              type="checkbox"
              aria-label={t("appearanceSelectionSourceCopyActionTitle")}
              checked={selectionSourceCopyActionEnabled}
              onChange={(event) =>
                setSelectionSourceCopyActionEnabled(event.target.checked)
              }
            />
            <span className="toggle-slider" />
          </label>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceSelectionRichCopyActionTitle")}
          description={t("appearanceSelectionRichCopyActionDescription")}
        >
          <SelectionActionButton
            kind="rich"
            label={t("sessionCopySelectionRich")}
            specimen
          />
          <label className="toggle-switch">
            <input
              type="checkbox"
              aria-label={t("appearanceSelectionRichCopyActionTitle")}
              checked={selectionRichCopyActionEnabled}
              onChange={(event) =>
                setSelectionRichCopyActionEnabled(event.target.checked)
              }
            />
            <span className="toggle-slider" />
          </label>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceSelectionNewSessionActionTitle" as never)}
          description={t(
            "appearanceSelectionNewSessionActionDescription" as never,
          )}
        >
          <SelectionActionButton
            kind="newSession"
            label={t("sessionNewSessionFromSelection" as never)}
            specimen
          />
          <label className="toggle-switch">
            <input
              type="checkbox"
              aria-label={t(
                "appearanceSelectionNewSessionActionTitle" as never,
              )}
              checked={selectionNewSessionActionEnabled}
              onChange={(event) =>
                setSelectionNewSessionActionEnabled(event.target.checked)
              }
            />
            <span className="toggle-slider" />
          </label>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceFunPhrasesTitle")}
          description={t("appearanceFunPhrasesDescription")}
        >
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={funPhrasesEnabled}
              onChange={(e) => setFunPhrasesEnabled(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceFloatingActionButtonTitle")}
          description={t("appearanceFloatingActionButtonDescription")}
        >
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={floatingActionButtonEnabled}
              onChange={(e) => setFloatingActionButtonEnabled(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceSidebarDuplicateHidingTitle")}
          description={t("appearanceSidebarDuplicateHidingDescription")}
        >
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={sidebarDuplicateHidingEnabled}
              onChange={(e) =>
                setSidebarDuplicateHidingEnabled(e.target.checked)
              }
            />
            <span className="toggle-slider" />
          </label>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceProjectCodeNamesTitle")}
          description={t("appearanceProjectCodeNamesDescription")}
        >
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={projectCodeNamesEnabled}
              onChange={(e) => setProjectCodeNamesEnabled(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceTabTitleActivityTitle")}
          description={t("appearanceTabTitleActivityDescription")}
        >
          <div className="settings-item-actions">
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={tabTitleActivityEnabled}
                onChange={(e) => setTabTitleActivityEnabled(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceProjectCodeNameActivityPulseTitle")}
          description={t("appearanceProjectCodeNameActivityPulseDescription")}
        >
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={projectCodeNameActivityPulseEnabled}
              disabled={!projectCodeNamesEnabled || !tabTitleActivityEnabled}
              onChange={(e) =>
                setProjectCodeNameActivityPulseEnabled(e.target.checked)
              }
            />
            <span className="toggle-slider" />
          </label>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceConnectionBarsTitle")}
          description={t("appearanceConnectionBarsDescription")}
        >
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={showConnectionBars}
              onChange={(e) => setShowConnectionBars(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceToolbarSettingsShortcutTitle")}
          description={t("appearanceToolbarSettingsShortcutDescription")}
        >
          <div className="settings-item-actions">
            <button
              type="button"
              className="settings-button"
              onClick={() => navigate(`${basePath}/settings/toolbar`)}
            >
              {t("appearanceToolbarSettingsShortcutAction")}
            </button>
          </div>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceOutputTypographyTitle")}
          keywords={[
            t("appearanceOutputUiFontLabel"),
            t("appearanceFontSizeTitle"),
            t("appearanceUserTurnSizeOffsetLabel"),
            t("appearanceTooltipSizeOffsetLabel"),
            t("appearanceOutputFontLabel"),
            t("appearanceOutputFontSizeLabel"),
            t("appearanceOutputThinkingSizeOffsetLabel"),
            t("appearanceOutputFixedFontLabel"),
            t("appearanceOutputFixedSizeOffsetLabel"),
            t("appearanceOutputMathSizeOffsetLabel"),
            t("appearanceOutputLineSpacingLabel"),
            t("appearanceOutputVerticalSpacingLabel"),
          ]}
          layout="custom"
          className="output-appearance-settings"
        >
          <div className="output-appearance-panel">
            <div className="output-appearance-controls">
              <div className="output-appearance-title settings-item-info">
                <strong>{t("appearanceOutputTypographyTitle")}</strong>
              </div>
              <div className="output-appearance-control">
                <span className="output-appearance-label">
                  {t("appearanceOutputUiFontLabel")}
                </span>
                <div className="font-size-selector output-font-selector">
                  {OUTPUT_PROSE_FONTS.map((font) => (
                    <button
                      key={font}
                      type="button"
                      className={`font-size-option output-font-option output-font-option-${font} ${outputUiFont === font ? "active" : ""}`}
                      onClick={() => setOutputUiFont(font)}
                    >
                      {getOutputProseFontLabel(font, translate)}
                    </button>
                  ))}
                </div>
              </div>

              <label
                className="output-appearance-control"
                htmlFor="ui-font-scale"
              >
                <span className="output-appearance-label">
                  {t("appearanceFontSizeTitle")}
                </span>
                <CommittedRangeNumberInput
                  id="ui-font-scale"
                  min={UI_FONT_SCALE_SLIDER_MIN_PERCENT}
                  max={UI_FONT_SCALE_SLIDER_MAX_PERCENT}
                  numberMin={UI_FONT_SCALE_MIN_PERCENT}
                  numberMax={UI_FONT_SCALE_MAX_PERCENT}
                  step={UI_FONT_SCALE_STEP_PERCENT}
                  value={fontSizePercent}
                  unit="%"
                  list="ui-font-scale-presets"
                  ariaLabel={t("appearanceFontSizeTitle")}
                  snapTextToStep={false}
                  onCommit={setFontSizePercent}
                />
              </label>
              <datalist id="ui-font-scale-presets">
                {UI_FONT_SCALE_PRESETS.map((percent) => (
                  <option key={percent} value={percent} label={`${percent}%`} />
                ))}
              </datalist>
              <label
                className="output-appearance-control"
                htmlFor="user-turn-font-size-offset"
              >
                <span className="output-appearance-label">
                  {t("appearanceUserTurnSizeOffsetLabel")}
                </span>
                <CommittedRangeNumberInput
                  id="user-turn-font-size-offset"
                  min={USER_TURN_FONT_SIZE_OFFSET_MIN_PX}
                  max={USER_TURN_FONT_SIZE_OFFSET_MAX_PX}
                  step={USER_TURN_FONT_SIZE_OFFSET_STEP_PX}
                  value={userTurnFontSizeOffsetPx}
                  unit="px"
                  ariaLabel={t("appearanceUserTurnSizeOffsetLabel")}
                  onCommit={setUserTurnFontSizeOffsetPx}
                />
              </label>
              <label
                className="output-appearance-control"
                htmlFor="tooltip-font-size-offset"
              >
                <span className="output-appearance-label">
                  {t("appearanceTooltipSizeOffsetLabel")}
                </span>
                <CommittedRangeNumberInput
                  id="tooltip-font-size-offset"
                  min={TOOLTIP_FONT_SIZE_OFFSET_MIN_PX}
                  max={TOOLTIP_FONT_SIZE_OFFSET_MAX_PX}
                  step={TOOLTIP_FONT_SIZE_OFFSET_STEP_PX}
                  value={tooltipFontSizeOffsetPx}
                  unit="px"
                  ariaLabel={t("appearanceTooltipSizeOffsetLabel")}
                  onCommit={setTooltipFontSizeOffsetPx}
                />
              </label>
              <div className="output-appearance-control">
                <span className="output-appearance-label">
                  {t("appearanceOutputFontLabel")}
                </span>
                <div className="font-size-selector output-font-selector">
                  {OUTPUT_PROSE_FONTS.map((font) => (
                    <button
                      key={font}
                      type="button"
                      className={`font-size-option output-font-option output-font-option-${font} ${outputFont === font ? "active" : ""}`}
                      onClick={() => setOutputFont(font)}
                    >
                      {getOutputProseFontLabel(font, translate)}
                    </button>
                  ))}
                </div>
              </div>

              <label
                className="output-appearance-control"
                htmlFor="output-font-size"
              >
                <span className="output-appearance-label">
                  {t("appearanceOutputFontSizeLabel")}
                </span>
                <span className="output-appearance-slider-row">
                  <CommittedRangeInput
                    id="output-font-size"
                    min={OUTPUT_FONT_SIZE_MIN_PX}
                    max={OUTPUT_FONT_SIZE_MAX_PX}
                    step={OUTPUT_FONT_SIZE_STEP_PX}
                    value={outputFontSizePx}
                    list="output-font-size-presets"
                    onDraftChange={(value) =>
                      setOutputFontSizeDraft(formatNumberSetting(value))
                    }
                    onCommit={setOutputFontSizePx}
                  />
                  <span className="output-appearance-number-wrap">
                    <input
                      type="number"
                      className="settings-input-small output-appearance-number"
                      min={OUTPUT_FONT_SIZE_MIN_PX}
                      max={OUTPUT_FONT_SIZE_MAX_PX}
                      step={OUTPUT_FONT_SIZE_STEP_PX}
                      value={outputFontSizeDraft}
                      onChange={(e) => setOutputFontSizeDraft(e.target.value)}
                      onBlur={commitOutputFontSize}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          commitOutputFontSize();
                          e.currentTarget.blur();
                        }
                      }}
                      aria-label={t("appearanceOutputFontSizeLabel")}
                    />
                    <span className="output-appearance-unit">px</span>
                  </span>
                </span>
              </label>
              <datalist id="output-font-size-presets">
                {OUTPUT_FONT_SIZE_PRESETS.map((preset) => (
                  <option
                    key={preset.value}
                    value={preset.value}
                    label={preset.label}
                  />
                ))}
              </datalist>

              <label
                className="output-appearance-control"
                htmlFor="output-thinking-size-offset"
              >
                <span className="output-appearance-label">
                  {t("appearanceOutputThinkingSizeOffsetLabel")}
                </span>
                <span className="output-appearance-slider-row">
                  <CommittedRangeInput
                    id="output-thinking-size-offset"
                    min={OUTPUT_THINKING_FONT_SIZE_OFFSET_MIN_PX}
                    max={OUTPUT_THINKING_FONT_SIZE_OFFSET_MAX_PX}
                    step={OUTPUT_THINKING_FONT_SIZE_OFFSET_STEP_PX}
                    value={outputThinkingFontSizeOffsetPx}
                    onDraftChange={(value) =>
                      setOutputThinkingFontSizeOffsetDraft(
                        formatNumberSetting(value),
                      )
                    }
                    onCommit={setOutputThinkingFontSizeOffsetPx}
                  />
                  <span className="output-appearance-number-wrap">
                    <input
                      type="number"
                      className="settings-input-small output-appearance-number"
                      min={OUTPUT_THINKING_FONT_SIZE_OFFSET_MIN_PX}
                      max={OUTPUT_THINKING_FONT_SIZE_OFFSET_MAX_PX}
                      step={OUTPUT_THINKING_FONT_SIZE_OFFSET_STEP_PX}
                      value={outputThinkingFontSizeOffsetDraft}
                      onChange={(e) =>
                        setOutputThinkingFontSizeOffsetDraft(e.target.value)
                      }
                      onBlur={commitOutputThinkingFontSizeOffset}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          commitOutputThinkingFontSizeOffset();
                          e.currentTarget.blur();
                        }
                      }}
                      aria-label={t("appearanceOutputThinkingSizeOffsetLabel")}
                    />
                    <span className="output-appearance-unit">px</span>
                  </span>
                </span>
              </label>

              <div className="output-appearance-control">
                <span className="output-appearance-label">
                  {t("appearanceOutputFixedFontLabel")}
                </span>
                <div className="font-size-selector output-font-selector">
                  {OUTPUT_FIXED_FONTS.map((font) => (
                    <button
                      key={font}
                      type="button"
                      className={`font-size-option output-font-option output-fixed-font-option-${font} ${outputFixedFont === font ? "active" : ""}`}
                      onClick={() => setOutputFixedFont(font)}
                    >
                      {getOutputFixedFontLabel(font, translate)}
                    </button>
                  ))}
                </div>
              </div>

              <label
                className="output-appearance-control"
                htmlFor="output-fixed-size-offset"
              >
                <span className="output-appearance-label">
                  {t("appearanceOutputFixedSizeOffsetLabel")}
                </span>
                <span className="output-appearance-slider-row">
                  <CommittedRangeInput
                    id="output-fixed-size-offset"
                    min={OUTPUT_FIXED_FONT_SIZE_OFFSET_MIN_PX}
                    max={OUTPUT_FIXED_FONT_SIZE_OFFSET_MAX_PX}
                    step={OUTPUT_FIXED_FONT_SIZE_OFFSET_STEP_PX}
                    value={outputFixedFontSizeOffsetPx}
                    onDraftChange={(value) =>
                      setOutputFixedFontSizeOffsetDraft(
                        formatNumberSetting(value),
                      )
                    }
                    onCommit={setOutputFixedFontSizeOffsetPx}
                  />
                  <span className="output-appearance-number-wrap">
                    <input
                      type="number"
                      className="settings-input-small output-appearance-number"
                      min={OUTPUT_FIXED_FONT_SIZE_OFFSET_MIN_PX}
                      max={OUTPUT_FIXED_FONT_SIZE_OFFSET_MAX_PX}
                      step={OUTPUT_FIXED_FONT_SIZE_OFFSET_STEP_PX}
                      value={outputFixedFontSizeOffsetDraft}
                      onChange={(e) =>
                        setOutputFixedFontSizeOffsetDraft(e.target.value)
                      }
                      onBlur={commitOutputFixedFontSizeOffset}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          commitOutputFixedFontSizeOffset();
                          e.currentTarget.blur();
                        }
                      }}
                      aria-label={t("appearanceOutputFixedSizeOffsetLabel")}
                    />
                    <span className="output-appearance-unit">px</span>
                  </span>
                </span>
              </label>

              <label
                className="output-appearance-control"
                htmlFor="output-math-size-offset"
              >
                <span className="output-appearance-label">
                  {t("appearanceOutputMathSizeOffsetLabel")}
                </span>
                <span className="output-appearance-slider-row">
                  <CommittedRangeInput
                    id="output-math-size-offset"
                    min={OUTPUT_MATH_FONT_SIZE_OFFSET_MIN_PX}
                    max={OUTPUT_MATH_FONT_SIZE_OFFSET_MAX_PX}
                    step={OUTPUT_MATH_FONT_SIZE_OFFSET_STEP_PX}
                    value={outputMathFontSizeOffsetPx}
                    onDraftChange={(value) =>
                      setOutputMathFontSizeOffsetDraft(
                        formatNumberSetting(value),
                      )
                    }
                    onCommit={setOutputMathFontSizeOffsetPx}
                  />
                  <span className="output-appearance-number-wrap">
                    <input
                      type="number"
                      className="settings-input-small output-appearance-number"
                      min={OUTPUT_MATH_FONT_SIZE_OFFSET_MIN_PX}
                      max={OUTPUT_MATH_FONT_SIZE_OFFSET_MAX_PX}
                      step={OUTPUT_MATH_FONT_SIZE_OFFSET_STEP_PX}
                      value={outputMathFontSizeOffsetDraft}
                      onChange={(e) =>
                        setOutputMathFontSizeOffsetDraft(e.target.value)
                      }
                      onBlur={commitOutputMathFontSizeOffset}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          commitOutputMathFontSizeOffset();
                          e.currentTarget.blur();
                        }
                      }}
                      aria-label={t("appearanceOutputMathSizeOffsetLabel")}
                    />
                    <span className="output-appearance-unit">px</span>
                  </span>
                </span>
              </label>

              <label
                className="output-appearance-control"
                htmlFor="output-line-spacing"
              >
                <span className="output-appearance-label">
                  {t("appearanceOutputLineSpacingLabel")}
                </span>
                <span className="output-appearance-slider-row">
                  <CommittedRangeInput
                    id="output-line-spacing"
                    min={OUTPUT_LINE_SPACING_MIN_PERCENT}
                    max={OUTPUT_LINE_SPACING_MAX_PERCENT}
                    step={OUTPUT_LINE_SPACING_STEP_PERCENT}
                    value={outputLineSpacingPercent}
                    onDraftChange={(value) =>
                      setOutputLineSpacingDraft(formatNumberSetting(value))
                    }
                    onCommit={setOutputLineSpacingPercent}
                  />
                  <span className="output-appearance-number-wrap">
                    <input
                      type="number"
                      className="settings-input-small output-appearance-number"
                      min={OUTPUT_LINE_SPACING_MIN_PERCENT}
                      max={OUTPUT_LINE_SPACING_MAX_PERCENT}
                      step={OUTPUT_LINE_SPACING_STEP_PERCENT}
                      value={outputLineSpacingDraft}
                      onChange={(e) =>
                        setOutputLineSpacingDraft(e.target.value)
                      }
                      onBlur={commitOutputLineSpacing}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          commitOutputLineSpacing();
                          e.currentTarget.blur();
                        }
                      }}
                      aria-label={t("appearanceOutputLineSpacingLabel")}
                    />
                    <span className="output-appearance-unit">%</span>
                  </span>
                </span>
              </label>

              <label
                className="output-appearance-control"
                htmlFor="output-vertical-spacing"
              >
                <span className="output-appearance-label">
                  {t("appearanceOutputVerticalSpacingLabel")}
                </span>
                <span className="output-appearance-slider-row">
                  <CommittedRangeInput
                    id="output-vertical-spacing"
                    min={OUTPUT_VERTICAL_SPACING_MIN_PERCENT}
                    max={OUTPUT_VERTICAL_SPACING_MAX_PERCENT}
                    step={OUTPUT_VERTICAL_SPACING_STEP_PERCENT}
                    value={outputVerticalSpacingPercent}
                    onDraftChange={(value) =>
                      setOutputVerticalSpacingDraft(formatNumberSetting(value))
                    }
                    onCommit={setOutputVerticalSpacingPercent}
                  />
                  <span className="output-appearance-number-wrap">
                    <input
                      type="number"
                      className="settings-input-small output-appearance-number"
                      min={OUTPUT_VERTICAL_SPACING_MIN_PERCENT}
                      max={OUTPUT_VERTICAL_SPACING_MAX_PERCENT}
                      step={OUTPUT_VERTICAL_SPACING_STEP_PERCENT}
                      value={outputVerticalSpacingDraft}
                      onChange={(e) =>
                        setOutputVerticalSpacingDraft(e.target.value)
                      }
                      onBlur={commitOutputVerticalSpacing}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          commitOutputVerticalSpacing();
                          e.currentTarget.blur();
                        }
                      }}
                      aria-label={t("appearanceOutputVerticalSpacingLabel")}
                    />
                    <span className="output-appearance-unit">%</span>
                  </span>
                </span>
              </label>
            </div>

            <div className="output-appearance-specimen">
              <div className="output-appearance-specimen-header">
                <span className="output-appearance-specimen-label">
                  {t("appearanceOutputSpecimenLabel")}
                </span>
                <button
                  type="button"
                  className="settings-button settings-button-secondary"
                  onClick={resetOutputAppearance}
                >
                  {t("appearanceOutputTypographyReset")}
                </button>
              </div>
              <div
                className="output-appearance-preview"
                role="region"
                aria-label={t("appearanceOutputPreviewLabel")}
              >
                <div className={tooltipStyles.specimen} data-tooltip-specimen>
                  {t("appearanceTooltipPreview")}
                </div>
                <div className="output-preview-system">
                  <span className="output-preview-system-icon">ok</span>
                  <span>System note: applied after reconnect.</span>
                </div>
                <div className="output-preview-prose">
                  <p>
                    Inline code like <code>codex update</code> stays fixed
                    width; prose wraps at phone width.
                  </p>
                  <pre className="output-preview-fixed">
                    <code>
                      {
                        "f0 = (x: 0) => ({ ok: x + 1 });\nfn S(v) -> { return v[0] ?? false }"
                      }
                    </code>
                  </pre>
                  <p>
                    Inline math:{" "}
                    <span
                      className="output-preview-math"
                      // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX output is generated from a static settings preview sample
                      dangerouslySetInnerHTML={{
                        __html: outputInlineMathHtml,
                      }}
                    />
                  </p>
                  <ul>
                    <li>
                      Tokens: <code>fixed width</code>
                    </li>
                    <li>Math uses a TeX-like face.</li>
                  </ul>
                </div>
                <div className="output-preview-thinking thinking-content">
                  <ThinkingText text="**Spacing** — thinking text stays quieter and smaller." />
                </div>
                <div className="output-preview-diff" aria-hidden="true">
                  <div>
                    <span className="output-preview-diff-gutter">+</span>
                    <span>Diff prose follows the prose font.</span>
                  </div>
                  <div>
                    <span className="output-preview-diff-gutter">-</span>
                    <span>Paragraph space can be dialed down.</span>
                  </div>
                </div>
                <div className="output-preview-ui" aria-hidden="true">
                  <div className="output-preview-ui-title">
                    Session title — uses the UI font and size
                  </div>
                  <div className="output-preview-ui-composer">
                    Composer: type a message to the agent…
                  </div>
                  <div className="message message-user-prompt">
                    <div className="text-block">
                      {t("appearanceUserTurnPreview")}
                    </div>
                  </div>
                  <div className="output-preview-ui-caption">
                    Caption · updated 2m ago · 3 files
                  </div>
                </div>
              </div>
            </div>
          </div>
        </SettingsItem>
      </div>
    </SettingsSection>
  );
}
