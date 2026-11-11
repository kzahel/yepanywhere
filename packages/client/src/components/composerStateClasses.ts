import composerOptionDotStyles from "./ComposerOptionDot.module.css";
import composerActionsStyles from "./ComposerActions.module.css";
import thinkingControlsStyles from "./ThinkingControls.module.css";
import thinkingToolbarControlStyles from "./ThinkingToolbarControl.module.css";
import modeSelectorStyles from "./ModeSelector.module.css";
import messageInputToolbarStyles from "./MessageInputToolbar.module.css";
import recapAfterSecondsControlStyles from "./RecapAfterSecondsControl.module.css";

export const composerOptionDotStateClasses: Record<string, string | undefined> =
  {
    "provider-claude": composerOptionDotStyles["provider-claude"],
    "provider-claude-gateway":
      composerOptionDotStyles["provider-claude-gateway"],
    "provider-claude-ollama": composerOptionDotStyles["provider-claude-ollama"],
    "provider-codex": composerOptionDotStyles["provider-codex"],
    "provider-codex-oss": composerOptionDotStyles["provider-codex-oss"],
    "provider-gemini": composerOptionDotStyles["provider-gemini"],
    "provider-gemini-acp": composerOptionDotStyles["provider-gemini-acp"],
    "provider-grok": composerOptionDotStyles["provider-grok"],
    "provider-opencode": composerOptionDotStyles["provider-opencode"],
    "provider-pi": composerOptionDotStyles["provider-pi"],
    "provider-local": composerOptionDotStyles["provider-local"],
    "mode-default": composerOptionDotStyles["mode-default"],
    "mode-acceptEdits": composerOptionDotStyles["mode-acceptEdits"],
    "mode-plan": composerOptionDotStyles["mode-plan"],
    "mode-bypassPermissions": composerOptionDotStyles["mode-bypassPermissions"],
    "mode-auto": composerOptionDotStyles["mode-auto"],
    "suggestion-off": composerOptionDotStyles["suggestion-off"],
    "suggestion-native": composerOptionDotStyles["suggestion-native"],
    "recap-off": composerOptionDotStyles["recap-off"],
    "recap-native": composerOptionDotStyles["recap-native"],
    "recap-side-session": composerOptionDotStyles["recap-side-session"],
    "recap-fork": composerOptionDotStyles["recap-fork"],
    "tone-off": composerOptionDotStyles["tone-off"],
    "tone-auto": composerOptionDotStyles["tone-auto"],
    "tone-low": composerOptionDotStyles["tone-low"],
    "tone-medium": composerOptionDotStyles["tone-medium"],
    "tone-high": composerOptionDotStyles["tone-high"],
    "tone-xhigh": composerOptionDotStyles["tone-xhigh"],
    "tone-max": composerOptionDotStyles["tone-max"],
    "thinking-off": composerOptionDotStyles["thinking-off"],
    "thinking-auto": composerOptionDotStyles["thinking-auto"],
    "thinking-on": composerOptionDotStyles["thinking-on"],
  };

export const composerActionsStateClasses: Record<string, string | undefined> = {
  "steer-mode": composerActionsStyles.steerMode,
  "queue-mode": composerActionsStyles.queueMode,
  "project-queue-mode": composerActionsStyles.projectQueueMode,
};

export const thinkingControlsStateClasses: Record<string, string | undefined> =
  {
    "thinking-effort-selector--toolbar":
      thinkingControlsStyles["thinking-effort-selector--toolbar"],
    "thinking-effort-selector--settings":
      thinkingControlsStyles["thinking-effort-selector--settings"],
  };

export const thinkingToolbarControlStateClasses: Record<
  string,
  string | undefined
> = {
  auto: thinkingToolbarControlStyles.auto,
  on: thinkingToolbarControlStyles.on,
};

export const modeSelectorStateClasses: Record<string, string | undefined> = {
  "mode-default": modeSelectorStyles["mode-default"],
  "mode-acceptEdits": modeSelectorStyles["mode-acceptEdits"],
  "mode-plan": modeSelectorStyles["mode-plan"],
  "mode-bypassPermissions": modeSelectorStyles["mode-bypassPermissions"],
  "mode-auto": modeSelectorStyles["mode-auto"],
};

export const messageInputToolbarStateClasses: Record<
  string,
  string | undefined
> = {
  "is-ok": messageInputToolbarStyles["is-ok"],
  "is-warn": messageInputToolbarStyles["is-warn"],
  "is-danger": messageInputToolbarStyles["is-danger"],
  "is-muted": messageInputToolbarStyles["is-muted"],
};

export const recapAfterSecondsControlStateClasses: Record<
  string,
  string | undefined
> = {
  "recap-after-seconds-control--off":
    recapAfterSecondsControlStyles["recap-after-seconds-control--off"],
  "recap-after-seconds-control--native":
    recapAfterSecondsControlStyles["recap-after-seconds-control--native"],
  "recap-after-seconds-control--side-session":
    recapAfterSecondsControlStyles["recap-after-seconds-control--side-session"],
  "recap-after-seconds-control--fork":
    recapAfterSecondsControlStyles["recap-after-seconds-control--fork"],
  "recap-after-seconds-control--inline":
    recapAfterSecondsControlStyles["recap-after-seconds-control--inline"],
};
