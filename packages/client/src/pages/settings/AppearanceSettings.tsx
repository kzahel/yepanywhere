import { undoEntry } from "./appearanceUndo";
import thinkingStyles from "../../components/blocks/ThinkingBlock.module.css";
import listStyles from "../../components/MessageList.module.css";
import promptStyles from "../../components/blocks/UserPromptBlock.module.css";
import textStyles from "../../components/blocks/TextBlock.module.css";
import {
  OUTPUT_FONT_CLASSES,
  FIXED_FONT_CLASSES,
} from "./appearanceFontClasses";
import {
  getSettingsIconStyleLabel,
  getQuoteReplyButtonModeLabel,
} from "./appearanceOptionLabels";
import { settingsIconStyleClasses } from "./SettingsCategoryIcons";
import rowsStyles from "./SettingsRows.module.css";
import iconsStyles from "./SettingsCategoryIcons.module.css";
import { SERVER_CAPABILITIES, serverHasCapability } from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ThinkingText } from "../../components/ThinkingText";
import { Button, IconButton } from "../../components/ui/Button";
import { Select, TextInput } from "../../components/ui/Field";
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
import { useProjectAppComposing } from "../../hooks/useProjectAppComposing";
import { useDeveloperMode } from "../../hooks/useDeveloperMode";
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
  useQuoteReplyButtonMode,
} from "../../hooks/useQuoteReplyButtonMode";
import { SettingsItem } from "./SettingsItem";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { SettingsSection } from "./SettingsSection";
import { useSettingsUndoBaseline } from "./SettingsUndoContext";
import { useRemoteBasePath } from "../../hooks/useRemoteBasePath";
import {
  SETTINGS_ICON_STYLES,
  useSettingsIconStyle,
} from "../../hooks/useSettingsIconStyle";
import { useSidebarDuplicateHiding } from "../../hooks/useSidebarDuplicateHiding";
import {
  SIDEBAR_SPACINGS,
  useSidebarSpacing,
} from "../../hooks/useSidebarSpacing";
import { TAB_SIZES, useTabSize } from "../../hooks/useTabSize";
import { useTabTitleActivityPreference } from "../../hooks/useTabTitleActivityPreference";
import { useComposerBeaconPreference } from "../../hooks/useComposerBeaconPreference";
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
import styles from "./AppearanceSettings.module.css";
import { CommittedRangeInput } from "../../components/ui/CommittedRangeInput";
import { InnerHtml } from "../../components/ui/InnerHtml";
import { CommittedRangeNumberInput } from "../../components/ui/CommittedRangeNumberInput";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { SelectionActionButton } from "../../components/ui/SelectionActionCluster";
import { Switch } from "../../components/ui/Switch";
import {
  DEFAULT_TOOLTIP_DELAY_MS,
  TOOLTIP_DELAY_MAX_MS,
  TOOLTIP_DELAY_MIN_MS,
  TOOLTIP_DELAY_STEP_MS,
  useTooltipAppearance,
} from "../../hooks/useTooltipAppearance";
import { useWiderConversationActivityPreviews } from "../../hooks/useWiderConversationActivityPreviews";
import { useWorkflowTags } from "../../hooks/useWorkflowTags";
import { usePdfjsRendererSetting } from "../../hooks/usePdfjsRendererSetting";
import { useUnicodeProseMathSetting } from "../../hooks/useUnicodeProseMathSetting";
import { useTranscriptMarginNavigation } from "../../hooks/useTranscriptMarginNavigation";
import { useComposerPromptRail } from "../../hooks/useComposerPromptRail";
import { useSessionRightPaneSetting } from "../../hooks/useSessionRightPaneSetting";
import { usePanelSlideAnimations } from "../../hooks/usePanelSlideAnimations";
import { useAcliCommentarySetting } from "../../hooks/useAcliCommentarySetting";
import { useSelectionActionPreferences } from "../../hooks/useSelectionActionPreferences";
import { useGlossaryHints } from "../../hooks/useGlossaryHints";
import { useProjectCodeNamePreferences } from "../../hooks/useProjectCodeNamePreferences";
import {
  projectPathLinkStores,
  useGlobalProjectPathLinkSettings,
} from "../../lib/projectPathLinkPreferences";
import { useVersion } from "../../hooks/useVersion";
const OUTPUT_INLINE_MATH_SAMPLE = "$E=mc^2$";

function formatNumberSetting(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
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
  const { workflowTagsEnabled, setWorkflowTagsEnabled } = useWorkflowTags();
  const { projectAppComposingEnabled, setProjectAppComposingEnabled } =
    useProjectAppComposing();
  const { sessionRightPaneEnabled, setSessionRightPaneEnabled } =
    useSessionRightPaneSetting();
  const { pdfjsRendererEnabled, setPdfjsRendererEnabled } =
    usePdfjsRendererSetting();
  const {
    transcriptMarginNavigationEnabled,
    setTranscriptMarginNavigationEnabled,
  } = useTranscriptMarginNavigation();
  const { composerPromptRailEnabled, setComposerPromptRailEnabled } =
    useComposerPromptRail();
  const { panelSlideAnimations, setPanelSlideAnimations } =
    usePanelSlideAnimations();
  const { acliCommentaryEnabled, setAcliCommentaryEnabled } =
    useAcliCommentarySetting();
  const { version: versionInfo } = useVersion();

  const { unicodeProseMathEnabled, setUnicodeProseMathEnabled } =
    useUnicodeProseMathSetting();
  const unicodeProseMathSupported = serverHasCapability(
    versionInfo,
    SERVER_CAPABILITIES.unicodeProseMath.name,
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
  const {
    projectPaths,
    recentBasenames: recentProjectPathLinksEnabled,
    mentionedDirectories,
  } = useGlobalProjectPathLinkSettings();
  const setRecentProjectPathLinksEnabled =
    projectPathLinkStores.recentBasenames.set;
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
  const { composerBeaconEnabled, setComposerBeaconEnabled } =
    useComposerBeaconPreference();
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
    undoEntry(workflowTagsEnabled, setWorkflowTagsEnabled),
    undoEntry(sessionRightPaneEnabled, setSessionRightPaneEnabled),
    undoEntry(projectAppComposingEnabled, setProjectAppComposingEnabled),
    undoEntry(
      transcriptMarginNavigationEnabled,
      setTranscriptMarginNavigationEnabled,
    ),
    undoEntry(composerPromptRailEnabled, setComposerPromptRailEnabled),
    undoEntry(panelSlideAnimations, setPanelSlideAnimations),
    undoEntry(acliCommentaryEnabled, setAcliCommentaryEnabled),
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
    undoEntry(projectPaths, projectPathLinkStores.projectPaths.set),
    undoEntry(
      mentionedDirectories,
      projectPathLinkStores.mentionedDirectories.set,
    ),
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
    undoEntry(sidebarDuplicateHidingEnabled, setSidebarDuplicateHidingEnabled),
    undoEntry(projectCodeNamesEnabled, setProjectCodeNamesEnabled),
    undoEntry(tabTitleActivityEnabled, setTabTitleActivityEnabled),
    undoEntry(composerBeaconEnabled, setComposerBeaconEnabled),
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
      <div className={rowsStyles.group} data-settings-group>
        <SettingsItem
          label={t("appearanceLanguageTitle")}
          description={t("appearanceLanguageDescription")}
          valueText={getLocaleLabel(locale, translate)}
        >
          <Select
            className={styles.select}
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
          </Select>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceThemeTitle")}
          valueText={getThemeLabel(theme, translate)}
        >
          <SegmentedControl
            aria-label={t("appearanceThemeTitle")}
            options={THEMES.map((themeValue) => ({
              value: themeValue,
              label: getThemeLabel(themeValue, translate),
            }))}
            value={theme}
            onChange={setTheme}
          />
        </SettingsItem>
        <SettingsItem
          label={t("appearanceSettingsIconStyleTitle")}
          description={t("appearanceSettingsIconStyleDescription")}
          valueText={getSettingsIconStyleLabel(settingsIconStyle, translate)}
          className={rowsStyles.itemWideControl}
        >
          <div className={rowsStyles.itemActions}>
            <SegmentedControl
              variant="cards"
              className={styles.settingsIconStyleSelector}
              aria-label={t("appearanceSettingsIconStyleTitle")}
              options={SETTINGS_ICON_STYLES.map((style) => ({
                value: style,
                label: getSettingsIconStyleLabel(style, translate),
                icon: (
                  <span
                    className={`${iconsStyles.icon} ${iconsStyles.iconLocalAccess} ${settingsIconStyleClasses[style]} ${styles.settingsIconStylePreview}`}
                  >
                    {style === "emoji"
                      ? settingsCategoryEmojiIcons["local-access"]
                      : settingsCategoryIcons["local-access"]}
                  </span>
                ),
              }))}
              value={settingsIconStyle}
              onChange={setSettingsIconStyle}
            />
          </div>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceContentWidthTitle")}
          description={t("appearanceContentWidthDescription")}
          className={rowsStyles.itemWideControl}
        >
          <div className={rowsStyles.itemActions}>
            <CommittedRangeInput
              min={MIN_CONTENT_MAX_WIDTH_PX}
              max={MAX_CONTENT_MAX_WIDTH_PX}
              step={10}
              value={contentMaxWidth}
              onDraftChange={(value) => setContentMaxWidthDraft(String(value))}
              onCommit={setContentMaxWidth}
              aria-label={t("appearanceContentWidthTitle")}
            />
            <TextInput
              type="number"
              unit={t("appearanceContentWidthUnit")}
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
            <IconButton
              size="small"
              label={t("appearanceContentWidthReset")}
              onClick={() => {
                setContentMaxWidth(DEFAULT_CONTENT_MAX_WIDTH_PX);
                setContentMaxWidthDraft(String(DEFAULT_CONTENT_MAX_WIDTH_PX));
              }}
            >
              ×
            </IconButton>
          </div>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceSidebarSpacingTitle")}
          description={t("appearanceSidebarSpacingDescription")}
          keywords={["sidebar spacing", "layout", "compact", "comfortable"]}
          valueText={getSidebarSpacingLabel(sidebarSpacing, translate)}
          className={rowsStyles.itemWideControl}
        >
          <div className={rowsStyles.itemActions}>
            <SegmentedControl
              aria-label={t("appearanceSidebarSpacingTitle")}
              options={SIDEBAR_SPACINGS.map((spacing) => ({
                value: spacing,
                label: getSidebarSpacingLabel(spacing, translate),
              }))}
              value={sidebarSpacing}
              onChange={setSidebarSpacing}
            />
          </div>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceOutputToolPreviewLinesLabel")}
          className={rowsStyles.itemWideControl}
        >
          <div className={rowsStyles.itemActions}>
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
            <TextInput
              type="number"
              unit={t("appearanceOutputToolPreviewLinesUnit")}
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
          </div>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceWiderActivityPreviewsTitle")}
          description={t("appearanceWiderActivityPreviewsDescription")}
        >
          <Switch
            checked={widerConversationActivityPreviews}
            onCheckedChange={setWiderConversationActivityPreviews}
            aria-label={t("appearanceWiderActivityPreviewsTitle")}
          />
        </SettingsItem>
        <SettingsItem
          label={t("appearanceTranscriptMarginNavigationTitle")}
          description={t("appearanceTranscriptMarginNavigationDescription")}
          keywords={["margin", "click", "right-click", "outline", "navigation"]}
        >
          <Switch
            checked={transcriptMarginNavigationEnabled}
            onCheckedChange={setTranscriptMarginNavigationEnabled}
            aria-label={t("appearanceTranscriptMarginNavigationTitle")}
          />
        </SettingsItem>
        <SettingsItem
          label={t("appearanceComposerPromptRailTitle")}
          description={t("appearanceComposerPromptRailDescription")}
          keywords={["recent", "prompt", "history", "drag", "rail", "composer"]}
        >
          <Switch
            checked={composerPromptRailEnabled}
            onCheckedChange={setComposerPromptRailEnabled}
            aria-label={t("appearanceComposerPromptRailTitle")}
          />
        </SettingsItem>
        <SettingsItem
          label={t("appearanceSessionRightPaneTitle")}
          description={t("appearanceSessionRightPaneDescription")}
        >
          <Switch
            checked={sessionRightPaneEnabled}
            onCheckedChange={setSessionRightPaneEnabled}
            aria-label={t("appearanceSessionRightPaneTitle")}
          />
        </SettingsItem>
        <SettingsItem
          label={t("projectAppWhileComposing")}
          description={t("appearanceProjectAppComposingDescription")}
          keywords={["project", "app", "new session", "compose"]}
        >
          <Switch
            checked={projectAppComposingEnabled}
            onCheckedChange={setProjectAppComposingEnabled}
            aria-label={t("projectAppWhileComposing")}
          />
        </SettingsItem>
        <SettingsItem
          label={t("appearancePdfjsRendererTitle")}
          description={t("appearancePdfjsRendererDescription")}
          keywords={["pdf", "pdf.js", "document", "viewer", "blocked"]}
        >
          <Switch
            checked={pdfjsRendererEnabled}
            onCheckedChange={setPdfjsRendererEnabled}
            aria-label={t("appearancePdfjsRendererTitle")}
          />
        </SettingsItem>
        <SettingsItem
          label={t("appearancePanelSlideAnimationsTitle")}
          description={t("appearancePanelSlideAnimationsDescription")}
          keywords={[
            "toolbar",
            "sidebar",
            "slide",
            "animation",
            "motion",
            "app",
          ]}
        >
          <Switch
            checked={panelSlideAnimations}
            onCheckedChange={setPanelSlideAnimations}
            aria-label={t("appearancePanelSlideAnimationsTitle")}
          />
        </SettingsItem>
        <SettingsItem
          label={t("appearanceWorkflowTagsTitle")}
          description={t("appearanceWorkflowTagsDescription")}
          doc="topics/workflow-view.md#implemented-v1-contract"
        >
          <Switch
            checked={workflowTagsEnabled}
            onCheckedChange={setWorkflowTagsEnabled}
            aria-label={t("appearanceWorkflowTagsTitle")}
          />
        </SettingsItem>
        <SettingsItem
          label={t("acliCommentarySetting")}
          description={t("acliCommentaryDescription")}
          doc="topics/acli-commentary.md"
        >
          <Switch
            checked={acliCommentaryEnabled}
            onCheckedChange={setAcliCommentaryEnabled}
            aria-label={t("acliCommentarySetting")}
          />
        </SettingsItem>
        <SettingsItem
          label={t("appearanceTabSizeTitle")}
          description={t("appearanceTabSizeDescription")}
          valueText={getTabSizeLabel(tabSize)}
        >
          <SegmentedControl
            aria-label={t("appearanceTabSizeTitle")}
            options={TAB_SIZES.map((size) => ({
              value: size,
              label: getTabSizeLabel(size),
            }))}
            value={tabSize}
            onChange={setTabSize}
          />
        </SettingsItem>
        <SettingsItem
          label={t("appearanceGeneratedTitlesTitle")}
          description={t("appearanceGeneratedTitlesDescription")}
          keywords={[
            t("appearanceGeneratedTitleLengthTitle"),
            t("appearanceGeneratedTitleLengthDescription"),
          ]}
          layout="custom"
          baseClassName={rowsStyles.itemGroup}
          className="generated-title-settings"
        >
          <div className={rowsStyles.itemGroupRow}>
            <div className={rowsStyles.itemInfo} data-settings-info>
              <strong>{t("appearanceGeneratedTitlesTitle")}</strong>
              <p>{t("appearanceGeneratedTitlesDescription")}</p>
            </div>
            <Switch
              checked={generatedTitleEnabled}
              aria-label={t("appearanceGeneratedTitlesTitle")}
              onCheckedChange={setGeneratedTitleEnabled}
            />
          </div>
          {generatedTitleEnabled && (
            <div
              className={`${rowsStyles.itemGroupRow} ${rowsStyles.itemGroupRowField} ${rowsStyles.itemGroupRowWideControl}`}
            >
              <div className={rowsStyles.itemInfo} data-settings-info>
                <strong>{t("appearanceGeneratedTitleLengthTitle")}</strong>
                <p>{t("appearanceGeneratedTitleLengthDescription")}</p>
              </div>
              <div className={rowsStyles.itemActions}>
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
                <TextInput
                  type="number"
                  unit={t("appearanceGeneratedTitleLengthUnit")}
                  min={GENERATED_TITLE_LENGTH_MIN}
                  max={GENERATED_TITLE_LENGTH_MAX}
                  step={GENERATED_TITLE_LENGTH_STEP}
                  value={generatedTitleLengthDraft}
                  onChange={(e) => setGeneratedTitleLengthDraft(e.target.value)}
                  onBlur={commitGeneratedTitleLength}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      commitGeneratedTitleLength();
                      e.currentTarget.blur();
                    }
                  }}
                  aria-label={t("appearanceGeneratedTitleLengthTitle")}
                />
                <IconButton
                  size="small"
                  label={t("appearanceGeneratedTitleLengthReset")}
                  onClick={() => {
                    setGeneratedTitleLength(DEFAULT_GENERATED_TITLE_LENGTH);
                    setGeneratedTitleLengthDraft(
                      String(DEFAULT_GENERATED_TITLE_LENGTH),
                    );
                  }}
                >
                  ×
                </IconButton>
              </div>
            </div>
          )}
        </SettingsItem>
        {unicodeProseMathSupported && (
          <SettingsItem
            label={t("appearanceUnicodeMathTitle")}
            description={t("appearanceUnicodeMathDescription")}
          >
            <Switch
              checked={unicodeProseMathEnabled}
              onCheckedChange={setUnicodeProseMathEnabled}
              aria-label={t("appearanceUnicodeMathTitle")}
            />
          </SettingsItem>
        )}
        <SettingsItem
          label={t("appearanceGlossaryHintsTitle")}
          description={t("appearanceGlossaryHintsDescription")}
          doc="topics/glossary-tooltips.md#product-contract"
        >
          <Switch
            checked={glossaryHintsEnabled}
            onCheckedChange={setGlossaryHintsEnabled}
            aria-label={t("appearanceGlossaryHintsTitle")}
          />
        </SettingsItem>
        <SettingsItem
          label={t("appearanceTooltipDelayTitle")}
          description={t("appearanceTooltipDelayDescription")}
          className={`${rowsStyles.itemWideControl} ${rowsStyles.itemTooltipControl}`}
        >
          <div
            className={`${rowsStyles.itemActions} ${rowsStyles.tooltipSettingsActions}`}
          >
            <SegmentedControl
              className={styles.tooltipModeSelector}
              aria-label={t("appearanceTooltipModeTitle")}
              options={[
                { value: "themed", label: t("appearanceTooltipModeThemed") },
                { value: "native", label: t("appearanceTooltipModeNative") },
              ]}
              value={tooltipMode}
              onChange={setTooltipMode}
            />
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
            <IconButton
              size="small"
              label={t("appearanceTooltipReset")}
              onClick={() => {
                setTooltipDelayMs(DEFAULT_TOOLTIP_DELAY_MS);
              }}
            >
              ×
            </IconButton>
          </div>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceHoverCardHeightTitle")}
          description={t("appearanceHoverCardHeightDescription")}
          className={rowsStyles.itemWideControl}
        >
          <div className={rowsStyles.itemActions}>
            <CommittedRangeInput
              min={HOVERCARD_MAX_HEIGHT_MIN_PX}
              max={HOVERCARD_MAX_HEIGHT_MAX_PX}
              step={HOVERCARD_MAX_HEIGHT_STEP_PX}
              value={hoverCardMaxHeightPx}
              onDraftChange={(value) => setHoverCardHeightDraft(String(value))}
              onCommit={setHoverCardMaxHeightPx}
              aria-label={t("appearanceHoverCardHeightTitle")}
            />
            <TextInput
              type="number"
              unit={t("appearanceHoverCardHeightUnit")}
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
            <span className={styles.settingsHovercardLines}>
              ({hoverCardHeightLines}{" "}
              {hoverCardHeightLines === 1
                ? t("appearanceHoverCardLineUnit")
                : t("appearanceHoverCardLinesUnit")}
              )
            </span>
            <IconButton
              size="small"
              label={t("appearanceHoverCardReset")}
              onClick={() => {
                setHoverCardMaxHeightPx(DEFAULT_HOVERCARD_MAX_HEIGHT_PX);
                setHoverCardHeightDraft(
                  String(DEFAULT_HOVERCARD_MAX_HEIGHT_PX),
                );
              }}
            >
              ×
            </IconButton>
          </div>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceInlineImagesTitle")}
          description={t("appearanceInlineImagesDescription")}
        >
          <Switch
            checked={inlineMediaExpandedByDefault}
            aria-label={t("appearanceInlineImagesTitle")}
            onCheckedChange={setInlineMediaExpandedByDefault}
          />
        </SettingsItem>
        <SettingsItem
          label={t("appearanceImageGalleriesTitle")}
          description={t("appearanceImageGalleriesDescription")}
        >
          <Switch
            aria-label={t("appearanceImageGalleriesTitle")}
            checked={compactMultiImageGalleries}
            onCheckedChange={setCompactMultiImageGalleries}
          />
        </SettingsItem>
        <SettingsItem
          label={t("appearanceProjectPathLinksTitle")}
          description={t("appearanceProjectPathLinksDescription")}
          doc="topics/project-path-links.md#file-link-preferences-and-mentioned-directories"
        >
          <Switch
            aria-label={t("appearanceProjectPathLinksTitle")}
            checked={projectPaths}
            onCheckedChange={(checked) =>
              projectPathLinkStores.projectPaths.set(checked)
            }
          />
        </SettingsItem>
        <SettingsItem
          label={t("appearanceMentionedDirectoriesTitle")}
          description={t("appearanceMentionedDirectoriesDescription")}
        >
          <Switch
            aria-label={t("appearanceMentionedDirectoriesTitle")}
            checked={mentionedDirectories}
            disabled={!projectPaths}
            onCheckedChange={(checked) =>
              projectPathLinkStores.mentionedDirectories.set(checked)
            }
          />
        </SettingsItem>
        <SettingsItem
          label={t("appearanceRecentProjectPathLinksTitle")}
          description={t("appearanceRecentProjectPathLinksDescription")}
        >
          <Switch
            aria-label={t("appearanceRecentProjectPathLinksTitle")}
            disabled={!projectPaths}
            checked={recentProjectPathLinksEnabled}
            onCheckedChange={setRecentProjectPathLinksEnabled}
          />
        </SettingsItem>
        <SettingsItem
          label={t("appearanceQuoteReplyButtonsTitle")}
          description={t("appearanceQuoteReplyButtonsDescription")}
          valueText={getQuoteReplyButtonModeLabel(
            quoteReplyButtonMode,
            translate,
          )}
          className={rowsStyles.itemWideControl}
        >
          <div className={rowsStyles.itemActions}>
            <SegmentedControl
              aria-label={t("appearanceQuoteReplyButtonsTitle")}
              options={QUOTE_REPLY_BUTTON_MODES.map((mode) => ({
                value: mode,
                label: getQuoteReplyButtonModeLabel(mode, translate),
              }))}
              value={quoteReplyButtonMode}
              onChange={setQuoteReplyButtonMode}
            />
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
          <Switch
            aria-label={t("appearanceSelectionQuoteActionTitle")}
            checked={selectionQuoteActionEnabled}
            onCheckedChange={setSelectionQuoteActionEnabled}
          />
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
          <Switch
            aria-label={t("appearanceSelectionTextCopyActionTitle" as never)}
            checked={selectionTextCopyActionEnabled}
            onCheckedChange={setSelectionTextCopyActionEnabled}
          />
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
          <Switch
            aria-label={t("appearanceSelectionSourceCopyActionTitle")}
            checked={selectionSourceCopyActionEnabled}
            onCheckedChange={setSelectionSourceCopyActionEnabled}
          />
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
          <Switch
            aria-label={t("appearanceSelectionRichCopyActionTitle")}
            checked={selectionRichCopyActionEnabled}
            onCheckedChange={setSelectionRichCopyActionEnabled}
          />
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
          <Switch
            aria-label={t("appearanceSelectionNewSessionActionTitle" as never)}
            checked={selectionNewSessionActionEnabled}
            onCheckedChange={setSelectionNewSessionActionEnabled}
          />
        </SettingsItem>
        <SettingsItem
          label={t("appearanceFunPhrasesTitle")}
          description={t("appearanceFunPhrasesDescription")}
        >
          <Switch
            checked={funPhrasesEnabled}
            aria-label={t("appearanceFunPhrasesTitle")}
            onCheckedChange={setFunPhrasesEnabled}
          />
        </SettingsItem>
        <SettingsItem
          label={t("appearanceSidebarDuplicateHidingTitle")}
          description={t("appearanceSidebarDuplicateHidingDescription")}
          doc="topics/session-list-hidden-duplicates.md#contract"
        >
          <Switch
            checked={sidebarDuplicateHidingEnabled}
            aria-label={t("appearanceSidebarDuplicateHidingTitle")}
            onCheckedChange={setSidebarDuplicateHidingEnabled}
          />
        </SettingsItem>
        <SettingsItem
          label={t("appearanceProjectCodeNamesTitle")}
          description={t("appearanceProjectCodeNamesDescription")}
          doc="topics/project-code-names.md#user-visible-contract"
        >
          <Switch
            checked={projectCodeNamesEnabled}
            aria-label={t("appearanceProjectCodeNamesTitle")}
            onCheckedChange={setProjectCodeNamesEnabled}
          />
        </SettingsItem>
        <SettingsItem
          label={t("appearanceTabTitleActivityTitle")}
          description={t("appearanceTabTitleActivityDescription")}
        >
          <div className={rowsStyles.itemActions}>
            <Switch
              checked={tabTitleActivityEnabled}
              aria-label={t("appearanceTabTitleActivityTitle")}
              onCheckedChange={setTabTitleActivityEnabled}
            />
          </div>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceProjectCodeNameActivityPulseTitle")}
          description={t("appearanceProjectCodeNameActivityPulseDescription")}
        >
          <Switch
            checked={projectCodeNameActivityPulseEnabled}
            aria-label={t("appearanceProjectCodeNameActivityPulseTitle")}
            disabled={!projectCodeNamesEnabled || !tabTitleActivityEnabled}
            onCheckedChange={setProjectCodeNameActivityPulseEnabled}
          />
        </SettingsItem>
        <SettingsItem
          label={t("appearanceComposerBeaconTitle")}
          description={t("appearanceComposerBeaconDescription")}
          doc="topics/composer-hotkey-beacon.md#use-and-scope"
        >
          <Switch
            aria-label={t("appearanceComposerBeaconTitle")}
            checked={composerBeaconEnabled}
            onCheckedChange={setComposerBeaconEnabled}
          />
        </SettingsItem>
        <SettingsItem
          label={t("appearanceConnectionBarsTitle")}
          description={t("appearanceConnectionBarsDescription")}
        >
          <Switch
            checked={showConnectionBars}
            aria-label={t("appearanceConnectionBarsTitle")}
            onCheckedChange={setShowConnectionBars}
          />
        </SettingsItem>
        <SettingsItem
          label={t("appearanceToolbarSettingsShortcutTitle")}
          description={t("appearanceToolbarSettingsShortcutDescription")}
        >
          <div className={rowsStyles.itemActions}>
            <Button onClick={() => navigate(`${basePath}/settings/toolbar`)}>
              {t("appearanceToolbarSettingsShortcutAction")}
            </Button>
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
          className={styles.settings}
          data-output-appearance
        >
          <div className={styles.panel}>
            <div className={styles.controls}>
              <div
                className={`output-appearance-title ${rowsStyles.itemInfo}`}
                data-settings-info
              >
                <strong>{t("appearanceOutputTypographyTitle")}</strong>
              </div>
              <div className={styles.control}>
                <span className={styles.label}>
                  {t("appearanceOutputUiFontLabel")}
                </span>
                <SegmentedControl
                  className={styles.outputFontSelector}
                  aria-label={t("appearanceOutputUiFontLabel")}
                  options={OUTPUT_PROSE_FONTS.map((font) => ({
                    value: font,
                    label: getOutputProseFontLabel(font, translate),
                    className: OUTPUT_FONT_CLASSES[font],
                  }))}
                  value={outputUiFont}
                  onChange={setOutputUiFont}
                />
              </div>

              <label className={styles.control} htmlFor="ui-font-scale">
                <span className={styles.label}>
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
                className={styles.control}
                htmlFor="user-turn-font-size-offset"
              >
                <span className={styles.label}>
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
                className={styles.control}
                htmlFor="tooltip-font-size-offset"
              >
                <span className={styles.label}>
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
              <div className={styles.control}>
                <span className={styles.label}>
                  {t("appearanceOutputFontLabel")}
                </span>
                <SegmentedControl
                  className={styles.outputFontSelector}
                  aria-label={t("appearanceOutputFontLabel")}
                  options={OUTPUT_PROSE_FONTS.map((font) => ({
                    value: font,
                    label: getOutputProseFontLabel(font, translate),
                    className: OUTPUT_FONT_CLASSES[font],
                  }))}
                  value={outputFont}
                  onChange={setOutputFont}
                />
              </div>

              <label className={styles.control} htmlFor="output-font-size">
                <span className={styles.label}>
                  {t("appearanceOutputFontSizeLabel")}
                </span>
                <span
                  className={rowsStyles.outputAppearanceSliderRow}
                  data-range-number
                >
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
                  <TextInput
                    type="number"
                    unit="px"
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
                className={styles.control}
                htmlFor="output-thinking-size-offset"
              >
                <span className={styles.label}>
                  {t("appearanceOutputThinkingSizeOffsetLabel")}
                </span>
                <span
                  className={rowsStyles.outputAppearanceSliderRow}
                  data-range-number
                >
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
                  <TextInput
                    type="number"
                    unit="px"
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
                </span>
              </label>

              <div className={styles.control}>
                <span className={styles.label}>
                  {t("appearanceOutputFixedFontLabel")}
                </span>
                <SegmentedControl
                  className={styles.outputFontSelector}
                  aria-label={t("appearanceOutputFixedFontLabel")}
                  options={OUTPUT_FIXED_FONTS.map((font) => ({
                    value: font,
                    label: getOutputFixedFontLabel(font, translate),
                    className: FIXED_FONT_CLASSES[font],
                  }))}
                  value={outputFixedFont}
                  onChange={setOutputFixedFont}
                />
              </div>

              <label
                className={styles.control}
                htmlFor="output-fixed-size-offset"
              >
                <span className={styles.label}>
                  {t("appearanceOutputFixedSizeOffsetLabel")}
                </span>
                <span
                  className={rowsStyles.outputAppearanceSliderRow}
                  data-range-number
                >
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
                  <TextInput
                    type="number"
                    unit="px"
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
                </span>
              </label>

              <label
                className={styles.control}
                htmlFor="output-math-size-offset"
              >
                <span className={styles.label}>
                  {t("appearanceOutputMathSizeOffsetLabel")}
                </span>
                <span
                  className={rowsStyles.outputAppearanceSliderRow}
                  data-range-number
                >
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
                  <TextInput
                    type="number"
                    unit="px"
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
                </span>
              </label>

              <label className={styles.control} htmlFor="output-line-spacing">
                <span className={styles.label}>
                  {t("appearanceOutputLineSpacingLabel")}
                </span>
                <span
                  className={rowsStyles.outputAppearanceSliderRow}
                  data-range-number
                >
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
                  <TextInput
                    type="number"
                    unit="%"
                    min={OUTPUT_LINE_SPACING_MIN_PERCENT}
                    max={OUTPUT_LINE_SPACING_MAX_PERCENT}
                    step={OUTPUT_LINE_SPACING_STEP_PERCENT}
                    value={outputLineSpacingDraft}
                    onChange={(e) => setOutputLineSpacingDraft(e.target.value)}
                    onBlur={commitOutputLineSpacing}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        commitOutputLineSpacing();
                        e.currentTarget.blur();
                      }
                    }}
                    aria-label={t("appearanceOutputLineSpacingLabel")}
                  />
                </span>
              </label>

              <label
                className={styles.control}
                htmlFor="output-vertical-spacing"
              >
                <span className={styles.label}>
                  {t("appearanceOutputVerticalSpacingLabel")}
                </span>
                <span
                  className={rowsStyles.outputAppearanceSliderRow}
                  data-range-number
                >
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
                  <TextInput
                    type="number"
                    unit="%"
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
                </span>
              </label>
            </div>

            <div className={styles.specimen}>
              <div className={styles.specimenHeader}>
                <span className={styles.specimenLabel}>
                  {t("appearanceOutputSpecimenLabel")}
                </span>
                <Button onClick={resetOutputAppearance}>
                  {t("appearanceOutputTypographyReset")}
                </Button>
              </div>
              <div
                className={styles.preview}
                role="region"
                aria-label={t("appearanceOutputPreviewLabel")}
              >
                <div className={tooltipStyles.specimen} data-tooltip-specimen>
                  {t("appearanceTooltipPreview")}
                </div>
                <div className={styles.outputPreviewSystem}>
                  <span className={styles.outputPreviewSystemIcon}>ok</span>
                  <span>System note: applied after reconnect.</span>
                </div>
                <div className={styles.outputPreviewProse}>
                  <p>
                    Inline code like <code>codex update</code> stays fixed
                    width; prose wraps at phone width.
                  </p>
                  <pre className={styles.outputPreviewFixed}>
                    <code>
                      {
                        "f0 = (x: 0) => ({ ok: x + 1 });\nfn S(v) -> { return v[0] ?? false }"
                      }
                    </code>
                  </pre>
                  <p>
                    Inline math:{" "}
                    {/* KaTeX output from a static settings preview sample. */}
                    <InnerHtml
                      as="span"
                      className={styles.outputPreviewMath}
                      data-output-preview-math
                      trustedHtml={outputInlineMathHtml}
                    />
                  </p>
                  <ul>
                    <li>
                      Tokens: <code>fixed width</code>
                    </li>
                    <li>Math uses a TeX-like face.</li>
                  </ul>
                </div>
                <div
                  className={`output-preview-thinking ${thinkingStyles.thinkingContent}`}
                  data-thinking-content
                >
                  <ThinkingText text="**Spacing** — thinking text stays quieter and smaller." />
                </div>
                <div className={styles.outputPreviewDiff} aria-hidden="true">
                  <div>
                    <span className={styles.outputPreviewDiffGutter}>+</span>
                    <span>Diff prose follows the prose font.</span>
                  </div>
                  <div>
                    <span className={styles.outputPreviewDiffGutter}>-</span>
                    <span>Paragraph space can be dialed down.</span>
                  </div>
                </div>
                <div className={styles.outputPreviewUi} aria-hidden="true">
                  <div className={styles.outputPreviewUiTitle}>
                    Session title — uses the UI font and size
                  </div>
                  <div className={styles.outputPreviewUiComposer}>
                    Composer: type a message to the agent…
                  </div>
                  <div
                    className={`${listStyles.message} ${promptStyles.messageUserPrompt}`}
                    data-message
                    data-message-user-prompt
                  >
                    <div className={textStyles.textBlock} data-text-block>
                      {t("appearanceUserTurnPreview")}
                    </div>
                  </div>
                  <div className={styles.outputPreviewUiCaption}>
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
