/**
 * Centralized localStorage key definitions.
 *
 * UI_KEYS are local browser preferences. BROWSER_LOCAL_KEYS are older
 * production keys kept as explicit browser-local storage for compatibility.
 * Source-scoped draft/session UI keys live in their owning modules.
 */
import { generateUUID } from "./uuid";

export const AUTOMATION_BROWSER_PROFILE_ID = "automation";

// ============================================================================
// UI Preferences (global to browser, not scoped by server)
// ============================================================================

export const UI_KEYS = {
  locale: "yep-anywhere-locale",
  theme: "yep-anywhere-theme",
  fontSize: "yep-anywhere-font-size",
  sidebarSpacing: "yep-anywhere-sidebar-spacing",
  diffViewMode: "yep-anywhere-diff-view-mode",
  outputProseFont: "yep-anywhere-output-prose-font",
  outputUiFont: "yep-anywhere-output-ui-font",
  userTurnFontSizeOffset: "yep-anywhere-user-turn-font-size-offset",
  tooltipFontSizeOffset: "yep-anywhere-tooltip-font-size-offset",
  outputProseFontSize: "yep-anywhere-output-prose-font-size",
  outputFixedFont: "yep-anywhere-output-fixed-font",
  outputFixedFontSizeOffset: "yep-anywhere-output-fixed-font-size-offset",
  outputProseThinkingFontSizeOffset:
    "yep-anywhere-output-prose-thinking-font-size-offset",
  outputProseMathFontSizeOffset:
    "yep-anywhere-output-prose-math-font-size-offset",
  outputProseLineSpacingPercent:
    "yep-anywhere-output-prose-line-spacing-percent",
  outputProseVerticalSpacing: "yep-anywhere-output-prose-vertical-spacing",
  outputProseVerticalSpacingPercent:
    "yep-anywhere-output-prose-vertical-spacing-percent",
  outputToolPreviewLineCount: "yep-anywhere-output-tool-preview-line-count",
  tabSize: "yep-anywhere-tab-size",
  contentMaxWidth: "yep-anywhere-content-max-width",
  commitReadWatermarks: "yep-anywhere-commit-read-watermarks",
  sourceControlCleanLanding: "yep-anywhere-source-control-clean-landing",
  sidebarWidth: "yep-anywhere-sidebar-width",
  sidebarExpanded: "yep-anywhere-sidebar-expanded",
  sidebarMinimized: "yep-anywhere-sidebar-minimized",
  sidebarSectionExpansion: "yep-anywhere-sidebar-section-expansion",
  sidebarDuplicateHidingEnabled:
    "yep-anywhere-sidebar-duplicate-hiding-enabled",
  funPhrases: "yep-anywhere-fun-phrases-enabled",
  streamingEnabled: "yep-anywhere-streaming-enabled",
  speechKeepMicWarm: "yep-anywhere-speech-keep-mic-warm",
  speechReducePlayback: "yep-anywhere-speech-reduce-playback",
  speechUnspokenPunctuation: "yep-anywhere-speech-unspoken-punctuation",
  speechFollowUpListenMs: "yep-anywhere-speech-follow-up-listen-ms",
  speechAsrAttributionMs: "yep-anywhere-speech-asr-attribution-ms",
  speechMessagePrefixMode: "yep-anywhere-speech-message-prefix-mode",
  speechMessageCustomPrefix: "yep-anywhere-speech-message-custom-prefix",
  speechMicDeviceId: "yep-anywhere-speech-mic-device-id",
  floatingActionButtonEnabled: "yep-anywhere-floating-action-button-enabled",
  keepMobileKeyboardOpenAfterDelivery:
    "yep-anywhere-keep-mobile-keyboard-open-after-delivery",
  developerMode: "yep-anywhere-developer-mode",
  conversationView: "yep-anywhere-conversation-view-enabled",
  conversationViewTurnLimit: "yep-anywhere-conversation-view-turn-limit",
  widerConversationActivityPreviews:
    "yep-anywhere-wider-conversation-activity-previews-enabled",
  glossaryHints: "yep-anywhere-glossary-hints-enabled",
  sessionToolbarPresence: "yep-anywhere-session-toolbar-presence",
  waveformButtonBackgroundOpacityPercent:
    "yep-anywhere-waveform-button-background-opacity-percent",
  // Legacy pre-presence keys, read once for migration then removed.
  sessionToolbarVisibility: "yep-anywhere-session-toolbar-visibility",
  sessionToolbarPriority: "yep-anywhere-session-toolbar-priority",
  tooltipMode: "yep-anywhere-tooltip-mode",
  tooltipDelayMs: "yep-anywhere-tooltip-delay-ms",
  // Legacy per-hover-card delay; seeds the shared tooltip delay at one third.
  sessionHoverCardShowDelayMs: "yep-anywhere-session-hover-card-show-delay-ms",
  sessionHoverCardMaxHeightPx: "yep-anywhere-session-hover-card-max-height-px",
  sessionGeneratedTitleEnabled: "yep-anywhere-session-generated-title-enabled",
  sessionGeneratedTitleLength: "yep-anywhere-session-generated-title-length",
  quoteReplyButtonMode: "yep-anywhere-quote-reply-button-mode",
  selectionQuoteActionEnabled: "yep-anywhere-selection-quote-action-enabled",
  selectionTextCopyActionEnabled:
    "yep-anywhere-selection-text-copy-action-enabled",
  selectionSourceCopyActionEnabled:
    "yep-anywhere-selection-source-copy-action-enabled",
  selectionRichCopyActionEnabled:
    "yep-anywhere-selection-rich-copy-action-enabled",
  selectionNewSessionActionEnabled:
    "yep-anywhere-selection-new-session-action-enabled",
  sessionThinkingVisible: "yep-anywhere-session-thinking-visible",
  cacheMissEventOutcomeFilter: "yep-anywhere-cache-miss-event-outcome-filter",
  settingsSearchMatchValues: "yep-anywhere-settings-search-match-values",
  sessionThinkingLatestOnly: "yep-anywhere-session-thinking-latest-only",
  sessionLoadingProgress: "yep-anywhere-session-loading-progress-enabled",
  sessionDomLinger: "yep-anywhere-session-dom-linger-enabled",
  sessionActiveWindowTrim: "yep-anywhere-session-active-window-trim-enabled",
  sessionInitialHistoryCompactions:
    "yep-anywhere-session-initial-history-compactions",
  sessionReverseSearchMaxPagesPerAttempt:
    "yep-anywhere-session-reverse-search-max-pages-per-attempt",
  // Legacy boolean toggle; seeds the budget preference until the slider
  // is first used, and stays coherent for older bundles.
  sessionTranscriptCache: "yep-anywhere-session-transcript-cache-enabled",
  sessionTranscriptCacheBudgetMb:
    "yep-anywhere-session-transcript-cache-budget-mb",
  sessionTranscriptCacheTtlHours:
    "yep-anywhere-session-transcript-cache-ttl-hours",
  sessionLastTranscriptBytes: "yep-anywhere-session-last-transcript-bytes",
  sessionScrollBehavior: "yep-anywhere-session-scroll-behavior",
  sessionDetailShadowDiagnostics:
    "yep-anywhere-session-detail-shadow-diagnostics-enabled",
  stableToolPreviewRendering:
    "yep-anywhere-stable-tool-preview-rendering-enabled",
  // Preserve the first-shipped key; true now means previews start expanded.
  inlineMediaExpandedByDefault: "yep-anywhere-inline-images-enabled",
  compactMultiImageGalleries:
    "yep-anywhere-compact-multi-image-galleries-enabled",
  recentProjectPathLinks: "yep-anywhere-recent-project-path-links-enabled",
  schemaValidation: "yep-anywhere-schema-validation",
  emulatorMaxFps: "yep-anywhere-emulator-max-fps",
  emulatorMaxWidth: "yep-anywhere-emulator-max-width",
  emulatorQuality: "yep-anywhere-emulator-quality",
  emulatorAdaptiveFps: "yep-anywhere-emulator-adaptive-fps",
  attachmentUploadQuality: "yep-anywhere-attachment-upload-quality",
  tabTitleActivityEnabled: "yep-anywhere-tab-title-activity-enabled",
  projectCodeNamesEnabled: "yep-anywhere-project-code-names-enabled",
  projectCodeNameActivityPulseEnabled:
    "yep-anywhere-project-code-name-activity-pulse-enabled",
  settingsIconStyle: "yep-anywhere-settings-icon-style",
  // Legacy key from the first checkbox version of this client-local setting.
  flatSettingsIcons: "yep-anywhere-flat-settings-icons-enabled",
} as const;

// ============================================================================
// Browser-Local Settings
// ============================================================================

export const BROWSER_LOCAL_KEYS = {
  model: "yep-anywhere-model",
  thinkingLevel: "yep-anywhere-thinking-level",
  // Old boolean thinking key still seeds the newer thinkingMode preference.
  thinkingEnabled: "yep-anywhere-thinking-enabled",
  thinkingMode: "yep-anywhere-thinking-mode",
  showThinking: "yep-anywhere-show-thinking",
  voiceInputEnabled: "yep-anywhere-voice-input-enabled",
  speechMethod: "yep-anywhere-speech-method",
  speechSmartTurn: "yep-anywhere-speech-smart-turn",
  grokSpeechAudio: "yep-anywhere-grok-speech-audio",
  parakeetSpeechModel: "yep-anywhere-parakeet-speech-model",
  xaiSttApiKey: "yep-anywhere-xai-stt-api-key",
  // Preserve the first-shipped push/client-log device id key.
  browserProfileId: "yep-anywhere-device-id",
  notifyInApp: "yep-anywhere-notify-in-app",
  recentProject: "yep-anywhere-recent-project",
} as const;

function isAutomatedBrowserProfile(): boolean {
  return typeof navigator !== "undefined" && navigator.webdriver === true;
}

/**
 * Get or create the browser profile ID.
 * This identifies the browser profile (shared across tabs) for connection tracking.
 * Creates a new UUID if one doesn't exist.
 */
export function getOrCreateBrowserProfileId(): string {
  if (isAutomatedBrowserProfile()) {
    return AUTOMATION_BROWSER_PROFILE_ID;
  }

  let browserProfileId = localStorage.getItem(
    BROWSER_LOCAL_KEYS.browserProfileId,
  );
  if (!browserProfileId) {
    browserProfileId = generateUUID();
    localStorage.setItem(BROWSER_LOCAL_KEYS.browserProfileId, browserProfileId);
  }
  return browserProfileId;
}

// ============================================================================
// Special Keys (not scoped, handle their own structure)
// ============================================================================

/** Remote connection credentials - stored per wsUrl internally */
export const REMOTE_CREDENTIALS_KEY = "yep-anywhere-remote-credentials";

/** Saved hosts for multi-host remote access */
export const SAVED_HOSTS_KEY = "yep-anywhere-saved-hosts";
