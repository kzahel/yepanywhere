import {
  BROWSER_SETTINGS_BACKUP_VERSION,
  type BrowserSettingsBackup,
  type BrowserSettingsBackupValues,
} from "@yep-anywhere/shared";
import { BROWSER_LOCAL_KEYS, UI_KEYS } from "./storageKeys";

/**
 * Portable browser preferences are explicit: identity, credentials, drafts,
 * cache measurements, hardware ids, and legacy migration keys stay local.
 */
export const BROWSER_SETTINGS_BACKUP_KEYS = [
  UI_KEYS.locale,
  UI_KEYS.theme,
  UI_KEYS.fontSize,
  UI_KEYS.sidebarSpacing,
  UI_KEYS.panelSlideAnimations,
  UI_KEYS.outputProseFont,
  UI_KEYS.outputUiFont,
  UI_KEYS.userTurnFontSizeOffset,
  UI_KEYS.outputProseFontSize,
  UI_KEYS.outputFixedFont,
  UI_KEYS.outputFixedFontSizeOffset,
  UI_KEYS.outputProseThinkingFontSizeOffset,
  UI_KEYS.outputProseMathFontSizeOffset,
  UI_KEYS.outputProseLineSpacingPercent,
  UI_KEYS.outputProseVerticalSpacing,
  UI_KEYS.outputProseVerticalSpacingPercent,
  UI_KEYS.outputToolPreviewLineCount,
  UI_KEYS.tabSize,
  UI_KEYS.contentMaxWidth,
  UI_KEYS.projectAppComposing,
  UI_KEYS.sessionRightPane,
  UI_KEYS.sessionRightPaneWidth,
  UI_KEYS.pdfjsRenderer,
  UI_KEYS.transcriptMarginNavigation,
  UI_KEYS.escapeInterruptDisabled,
  UI_KEYS.composerPromptRail,
  UI_KEYS.sourceControlCleanLanding,
  UI_KEYS.sidebarWidth,
  UI_KEYS.sidebarExpanded,
  UI_KEYS.sidebarMinimized,
  UI_KEYS.sidebarSectionExpansion,
  UI_KEYS.sidebarDuplicateHidingEnabled,
  UI_KEYS.funPhrases,
  UI_KEYS.streamingEnabled,
  UI_KEYS.liveToolOutputEnabled,
  UI_KEYS.speechKeepMicWarm,
  UI_KEYS.speechReducePlayback,
  UI_KEYS.speechUnspokenPunctuation,
  UI_KEYS.speechFollowUpListenMs,
  UI_KEYS.speechAsrAttributionMs,
  UI_KEYS.speechMessagePrefixMode,
  UI_KEYS.speechMessageCustomPrefix,
  UI_KEYS.keepMobileKeyboardOpenAfterDelivery,
  UI_KEYS.developerMode,
  UI_KEYS.conversationView,
  UI_KEYS.conversationViewTurnLimit,
  UI_KEYS.widerConversationActivityPreviews,
  UI_KEYS.glossaryHints,
  UI_KEYS.sessionToolbarPresence,
  UI_KEYS.waveformButtonBackgroundOpacityPercent,
  UI_KEYS.tooltipMode,
  UI_KEYS.tooltipDelayMs,
  // Retained so an older server copy can still seed the shared delay.
  UI_KEYS.sessionHoverCardShowDelayMs,
  UI_KEYS.sessionHoverCardMaxHeightPx,
  UI_KEYS.sessionGeneratedTitleEnabled,
  UI_KEYS.sessionGeneratedTitleLength,
  UI_KEYS.quoteReplyButtonMode,
  UI_KEYS.selectionQuoteActionEnabled,
  UI_KEYS.selectionSourceCopyActionEnabled,
  UI_KEYS.selectionRichCopyActionEnabled,
  UI_KEYS.sessionThinkingVisible,
  UI_KEYS.sessionThinkingLatestOnly,
  UI_KEYS.sessionLoadingProgress,
  UI_KEYS.sessionDomLinger,
  UI_KEYS.sessionActiveWindowTrim,
  UI_KEYS.sessionReverseSearchMaxPagesPerAttempt,
  UI_KEYS.sessionTranscriptCache,
  UI_KEYS.sessionTranscriptCacheBudgetMb,
  UI_KEYS.sessionTranscriptCacheTtlHours,
  UI_KEYS.sessionScrollBehavior,
  UI_KEYS.sessionDetailShadowDiagnostics,
  UI_KEYS.stableToolPreviewRendering,
  UI_KEYS.inlineMediaExpandedByDefault,
  UI_KEYS.compactMultiImageGalleries,
  UI_KEYS.recentProjectPathLinks,
  UI_KEYS.projectPathLinks,
  UI_KEYS.mentionedDirectoryLinks,
  UI_KEYS.schemaValidation,
  UI_KEYS.emulatorMaxFps,
  UI_KEYS.emulatorMaxWidth,
  UI_KEYS.emulatorQuality,
  UI_KEYS.emulatorAdaptiveFps,
  UI_KEYS.attachmentUploadQuality,
  UI_KEYS.tabTitleActivityEnabled,
  UI_KEYS.composerBeaconEnabled,
  UI_KEYS.projectCodeNamesEnabled,
  UI_KEYS.projectCodeNameActivityPulseEnabled,
  UI_KEYS.settingsIconStyle,
  BROWSER_LOCAL_KEYS.model,
  BROWSER_LOCAL_KEYS.thinkingLevel,
  BROWSER_LOCAL_KEYS.thinkingMode,
  BROWSER_LOCAL_KEYS.showThinking,
  BROWSER_LOCAL_KEYS.voiceInputEnabled,
  BROWSER_LOCAL_KEYS.speechMethod,
  BROWSER_LOCAL_KEYS.speechSmartTurn,
  BROWSER_LOCAL_KEYS.grokSpeechAudio,
  BROWSER_LOCAL_KEYS.parakeetSpeechModel,
  BROWSER_LOCAL_KEYS.whisperSpeechModel,
  BROWSER_LOCAL_KEYS.notifyInApp,
] as const;

export function captureBrowserSettings(
  storage: Pick<Storage, "getItem"> = window.localStorage,
): BrowserSettingsBackupValues {
  const values: BrowserSettingsBackupValues = {};
  for (const key of BROWSER_SETTINGS_BACKUP_KEYS) {
    const value = storage.getItem(key);
    if (value !== null) values[key] = value;
  }
  return values;
}

function restoreValues(
  values: BrowserSettingsBackupValues,
  storage: Pick<Storage, "setItem" | "removeItem">,
): void {
  for (const key of BROWSER_SETTINGS_BACKUP_KEYS) {
    const value = Object.hasOwn(values, key) ? values[key] : undefined;
    if (typeof value === "string") {
      storage.setItem(key, value);
    } else {
      storage.removeItem(key);
    }
  }
}

/** Replace the portable preference set, rolling back if localStorage rejects. */
export function applyBrowserSettingsBackup(
  backup: BrowserSettingsBackup,
  storage: Pick<
    Storage,
    "getItem" | "setItem" | "removeItem"
  > = window.localStorage,
): void {
  if (backup.version !== BROWSER_SETTINGS_BACKUP_VERSION) {
    throw new Error(`Unsupported browser settings version: ${backup.version}`);
  }
  const previous = captureBrowserSettings(storage);
  try {
    restoreValues(backup.values, storage);
  } catch (error) {
    restoreValues(previous, storage);
    throw error;
  }
}
