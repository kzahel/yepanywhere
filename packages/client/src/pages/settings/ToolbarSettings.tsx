import rowsStyles from "./SettingsRows.module.css";
import type {
  BusyComposerDefaultAction,
  CollapsedComposerButtonPreference,
  ToolbarControlPresence,
  ToolbarNarrowingPriority,
} from "@yep-anywhere/shared";
import {
  PATIENT_TOPIC_SHIFT_CAPABILITY,
  REMOTE_BROWSER_DIAGNOSTICS_CAPABILITY,
  SYNTHETIC_DONE_COMMAND_CAPABILITY,
  serverHasCapability,
} from "@yep-anywhere/shared";
import { useCallback, useMemo, useState } from "react";
import {
  SessionToolbarPreview,
  ToolbarControlPreview,
} from "../../components/SessionToolbarPreview";
import { Banner } from "../../components/ui/Banner";
import { Button } from "../../components/ui/Button";
import { CommittedRangeInput } from "../../components/ui/CommittedRangeInput";
import { CommittedRangeNumberInput } from "../../components/ui/CommittedRangeNumberInput";
import { Select } from "../../components/ui/Field";
import {
  CONVERSATION_VIEW_TURN_LIMIT_STEP,
  MAX_CONVERSATION_VIEW_TURN_LIMIT,
  MIN_CONVERSATION_VIEW_TURN_LIMIT,
  useConversationViewTurnLimit,
} from "../../hooks/useConversationView";
import {
  type SessionToolbarVisibilityKey,
  useSessionToolbarPresence,
} from "../../hooks/useSessionToolbarPresence";
import {
  MAX_WAVEFORM_BUTTON_BACKGROUND_OPACITY_PERCENT,
  MIN_WAVEFORM_BUTTON_BACKGROUND_OPACITY_PERCENT,
  useWaveformButtonBackgroundOpacity,
  WAVEFORM_BUTTON_BACKGROUND_OPACITY_STEP_PERCENT,
} from "../../hooks/useWaveformButtonBackgroundOpacity";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import {
  useAttachmentAction,
  type AttachmentAction,
} from "../../hooks/useAttachmentAction";
import {
  setQuestionReminderTurns,
  useQuestionReminderTurns,
} from "../../hooks/useQuestionReminderTurns";
import { getQuestionReminderThresholds } from "../../lib/asyncQuestions";

import { SettingsItem } from "./SettingsItem";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { HideInSettingsSearch } from "./SettingsSearchContext";
import { SettingsSection } from "./SettingsSection";
import { useSettingsUndoBaseline } from "./SettingsUndoContext";
import toolbarSettingsStyles from "./ToolbarSettings.module.css";

const BUSY_COMPOSER_DEFAULT_ACTIONS: BusyComposerDefaultAction[] = [
  "steer",
  "queue",
];

const COLLAPSED_COMPOSER_BUTTON_OPTIONS: CollapsedComposerButtonPreference[] = [
  "primary",
  "alternate",
  "microphone",
];

type ToolbarSide = "left" | "right";

interface ToolbarControlMeta {
  key: SessionToolbarVisibilityKey;
  title: string;
  description: string;
  side: ToolbarSide;
  canSetPriority: boolean;
  canDisable: boolean;
  /**
   * Whether the control has a toolbar rendering to preview. Controls that only
   * appear elsewhere in the composer would render an empty preview tile, so
   * they get the copy and slider alone.
   */
  hasToolbarPreview: boolean;
}

/** Presence-configurable controls that never render on the toolbar itself. */
const NON_TOOLBAR_CONTROLS = new Set<SessionToolbarVisibilityKey>([
  "composerRecall",
]);

const PRIORITY_EDITABLE_CONTROLS = new Set<SessionToolbarVisibilityKey>([
  "modeSelector",
  "attachments",
  "slashMenu",
  "thinkingToggle",
  "renderMode",
  "conversationView",
  "browserDebug",
  "syntheticDone",
  "sessionStatus",
  "shortcutsHelp",
  "transcriptSearch",
  "contextUsage",
  "btw",
  "steerNow",
  "topicShift",
  "projectQueue",
  "projectQueueNewSessionShortcut",
]);

// Enabled presence-slider notches run from hidden through increasingly durable
// narrowing priorities. Controls that can be disabled add an Off notch first.
const PRESENCE_SLIDER_PRIORITIES: readonly ToolbarNarrowingPriority[] = [
  "first",
  "mid",
  "last",
  "pin",
];

function presenceSliderId(key: SessionToolbarVisibilityKey): string {
  return `session-toolbar-presence-${key}`;
}

function presenceCaptionKey(
  canSetPriority: boolean,
  canDisable: boolean,
  notch: number,
) {
  if (canDisable && notch <= 0) {
    return "appearanceToolbarPresenceOffCaption" as const;
  }
  const enabledNotch = notch - (canDisable ? 1 : 0);
  if (enabledNotch <= 0) {
    return "appearanceToolbarPresenceHiddenCaption" as const;
  }
  if (!canSetPriority) return "appearanceToolbarPresenceShownCaption" as const;
  switch (PRESENCE_SLIDER_PRIORITIES[enabledNotch - 1]) {
    case "first":
      return "appearanceToolbarPresenceFirstCaption" as const;
    case "mid":
      return "appearanceToolbarPresenceMidCaption" as const;
    case "last":
      return "appearanceToolbarPresenceLastCaption" as const;
    default:
      return "appearanceToolbarPresencePinCaption" as const;
  }
}

interface ControlPresenceSliderProps {
  control: ToolbarControlMeta;
  presence: ToolbarControlPresence;
  onCommitNotch: (control: ToolbarControlMeta, notch: number) => void;
}

// One slider per control edits its single presence value: optional off,
// hidden, or a narrowing-priority tier. Controls outside the overflow engine
// get only the enabled end notches, since first/mid/last would not map to real
// runtime behavior.
function ControlPresenceSlider({
  control,
  presence,
  onCommitNotch,
}: ControlPresenceSliderProps) {
  const { t } = useI18n();
  const [draftNotch, setDraftNotch] = useState<number | null>(null);
  const disabledOffset = control.canDisable ? 1 : 0;
  const max =
    (control.canSetPriority ? PRESENCE_SLIDER_PRIORITIES.length : 1) +
    disabledOffset;
  const notch =
    presence === "off"
      ? 0
      : presence === "hidden"
        ? disabledOffset
        : control.canSetPriority
          ? disabledOffset +
            1 +
            Math.max(0, PRESENCE_SLIDER_PRIORITIES.indexOf(presence))
          : disabledOffset + 1;
  const shownNotch = draftNotch ?? notch;
  const caption = t(
    presenceCaptionKey(control.canSetPriority, control.canDisable, shownNotch),
  );
  const inputId = presenceSliderId(control.key);
  const captionId = `${inputId}-caption`;
  const clearDraft = () => setDraftNotch(null);
  return (
    <span className={toolbarSettingsStyles.presence}>
      <CommittedRangeInput
        id={inputId}
        className={toolbarSettingsStyles.presenceRange}
        min={0}
        max={max}
        step={1}
        value={notch}
        onDraftChange={setDraftNotch}
        onCommit={(next) => {
          setDraftNotch(null);
          onCommitNotch(control, next);
        }}
        onBlur={clearDraft}
        onKeyUp={clearDraft}
        onPointerUp={clearDraft}
        onPointerCancel={clearDraft}
        aria-label={t("appearanceToolbarPresenceAria", {
          control: control.title,
        })}
        aria-valuetext={caption}
        aria-describedby={captionId}
      />
      <span className={toolbarSettingsStyles.presenceTicks} aria-hidden="true">
        {Array.from({ length: max + 1 }, (_, tick) => (
          <span
            key={tick}
            className={`${toolbarSettingsStyles.presenceTick}${
              tick <= shownNotch ? ` ${toolbarSettingsStyles.isReached}` : ""
            }`}
          />
        ))}
      </span>
      <span className={toolbarSettingsStyles.presenceLabels} aria-hidden="true">
        <span>
          {t(
            control.canDisable
              ? "appearanceToolbarOff"
              : "appearanceToolbarHide",
          )}
        </span>
        <span>{t("appearanceToolbarShowAlways")}</span>
      </span>
      <span className={toolbarSettingsStyles.presenceCaption} id={captionId}>
        {caption}
      </span>
    </span>
  );
}

export function ToolbarSettings() {
  const { t } = useI18n();
  const [attachmentAction, setAttachmentAction] = useAttachmentAction();
  useSettingsPaneTitle(t("appearanceSessionToolbarTitle"));
  const questionReminderTurns = useQuestionReminderTurns();
  const questionLimits = getQuestionReminderThresholds(questionReminderTurns);
  const {
    presence: toolbarPresence,
    setControlPresence,
    resetPresence,
  } = useSessionToolbarPresence();
  const [placementPresence] = useState(() => ({ ...toolbarPresence }));
  const { settings, error, updateSettings } = useServerSettings();
  const { version } = useVersion();
  const { conversationViewTurnLimit, setConversationViewTurnLimit } =
    useConversationViewTurnLimit();
  const {
    waveformButtonBackgroundOpacityPercent,
    setWaveformButtonBackgroundOpacityPercent,
  } = useWaveformButtonBackgroundOpacity();

  const supportsBrowserDebug = serverHasCapability(
    version,
    REMOTE_BROWSER_DIAGNOSTICS_CAPABILITY,
  );
  const supportsSyntheticDone = serverHasCapability(
    version,
    SYNTHETIC_DONE_COMMAND_CAPABILITY,
  );
  const supportsTopicShift = serverHasCapability(
    version,
    PATIENT_TOPIC_SHIFT_CAPABILITY,
  );

  const busyComposerDefaultAction =
    settings?.clientDefaults?.busyComposerDefaultAction ?? "steer";
  const collapsedComposerButton =
    settings?.clientDefaults?.collapsedComposerButton ?? "primary";

  const undoState = useMemo(
    () =>
      settings
        ? {
            toolbarPresence,
            busyComposerDefaultAction,
            collapsedComposerButton,
            conversationViewTurnLimit,
            questionReminderTurns,
            waveformButtonBackgroundOpacityPercent,
          }
        : null,
    [
      busyComposerDefaultAction,
      collapsedComposerButton,
      conversationViewTurnLimit,
      questionReminderTurns,
      settings,
      toolbarPresence,
      waveformButtonBackgroundOpacityPercent,
    ],
  );
  const restoreUndoState = useCallback(
    (snapshot: typeof undoState) => {
      if (!snapshot) return;
      for (const [key, value] of Object.entries(snapshot.toolbarPresence)) {
        setControlPresence(key as SessionToolbarVisibilityKey, value);
      }
      setConversationViewTurnLimit(snapshot.conversationViewTurnLimit);
      setQuestionReminderTurns(snapshot.questionReminderTurns);
      setWaveformButtonBackgroundOpacityPercent(
        snapshot.waveformButtonBackgroundOpacityPercent,
      );
      void updateSettings({
        clientDefaults: {
          busyComposerDefaultAction: snapshot.busyComposerDefaultAction,
          collapsedComposerButton: snapshot.collapsedComposerButton,
        },
      }).catch(() => {
        // surfaced via the hook's error state
      });
    },
    [
      setControlPresence,
      setConversationViewTurnLimit,
      setWaveformButtonBackgroundOpacityPercent,
      updateSettings,
    ],
  );
  useSettingsUndoBaseline(undoState, restoreUndoState);

  const controlMeta = (
    key: SessionToolbarVisibilityKey,
    title: string,
    description: string,
    side: ToolbarSide,
  ): ToolbarControlMeta => ({
    key,
    title,
    description,
    side,
    canSetPriority: PRIORITY_EDITABLE_CONTROLS.has(key),
    canDisable: key === "syntheticDone",
    hasToolbarPreview: !NON_TOOLBAR_CONTROLS.has(key),
  });

  const toolbarControls: ToolbarControlMeta[] = [
    controlMeta(
      "modeSelector",
      t("appearanceToolbarModeTitle"),
      t("appearanceToolbarModeDescription"),
      "left",
    ),
    controlMeta(
      "attachments",
      t("appearanceToolbarAttachmentsTitle"),
      t("appearanceToolbarAttachmentsDescription"),
      "left",
    ),
    controlMeta(
      "slashMenu",
      t("appearanceToolbarSlashTitle"),
      t("appearanceToolbarSlashDescription"),
      "left",
    ),
    controlMeta(
      "thinkingToggle",
      t("appearanceToolbarThinkingTitle"),
      t("appearanceToolbarThinkingDescription"),
      "left",
    ),
    controlMeta(
      "renderMode",
      t("appearanceToolbarRenderModeTitle"),
      t("appearanceToolbarRenderModeDescription"),
      "left",
    ),
    controlMeta(
      "conversationView",
      t("appearanceToolbarConversationViewTitle"),
      t("appearanceToolbarConversationViewDescription"),
      "left",
    ),
    ...(supportsBrowserDebug
      ? [
          controlMeta(
            "browserDebug",
            t("appearanceToolbarBrowserDebugTitle"),
            t("appearanceToolbarBrowserDebugDescription"),
            "left",
          ),
        ]
      : []),
    ...(supportsSyntheticDone
      ? [
          controlMeta(
            "syntheticDone",
            t("appearanceToolbarSyntheticDoneTitle"),
            t("appearanceToolbarSyntheticDoneDescription"),
            "left",
          ),
        ]
      : []),
    controlMeta(
      "microphone",
      t("appearanceToolbarMicrophoneTitle"),
      t("appearanceToolbarMicrophoneDescription"),
      "left",
    ),
    controlMeta(
      "waveform",
      t("appearanceToolbarWaveformTitle"),
      t("appearanceToolbarWaveformDescription"),
      "left",
    ),
    controlMeta(
      "sessionStatus",
      t("appearanceToolbarStatusTitle"),
      t("appearanceToolbarStatusDescription"),
      "right",
    ),
    controlMeta(
      "shortcutsHelp",
      t("appearanceToolbarShortcutsTitle"),
      t("appearanceToolbarShortcutsDescription"),
      "right",
    ),
    controlMeta(
      "transcriptSearch",
      t("appearanceToolbarTranscriptSearchTitle"),
      t("appearanceToolbarTranscriptSearchDescription"),
      "right",
    ),
    controlMeta(
      "contextUsage",
      t("appearanceToolbarContextTitle"),
      t("appearanceToolbarContextDescription"),
      "right",
    ),
    controlMeta(
      "btw",
      t("appearanceToolbarBtwTitle"),
      t("appearanceToolbarBtwDescription"),
      "right",
    ),
    controlMeta(
      "steerNow",
      t("appearanceToolbarSteerNowTitle"),
      t("appearanceToolbarSteerNowDescription"),
      "right",
    ),
    controlMeta(
      "composerRecall",
      t("appearanceToolbarComposerRecallTitle"),
      t("appearanceToolbarComposerRecallDescription"),
      "right",
    ),
  ];
  if (supportsTopicShift) {
    toolbarControls.push(
      controlMeta(
        "topicShift",
        t("appearanceToolbarTopicShiftTitle"),
        t("appearanceToolbarTopicShiftDescription"),
        "right",
      ),
    );
  }
  toolbarControls.push(
    controlMeta(
      "projectQueue",
      t("appearanceToolbarProjectQueueTitle"),
      t("appearanceToolbarProjectQueueDescription"),
      "right",
    ),
  );
  toolbarControls.push(
    controlMeta(
      "projectQueueNewSessionShortcut",
      t("appearanceToolbarProjectQueueNewSessionShortcutTitle"),
      t("appearanceToolbarProjectQueueNewSessionShortcutDescription"),
      "right",
    ),
  );

  const hiddenLeft = toolbarControls.filter(
    (control) =>
      (placementPresence[control.key] === "hidden" ||
        placementPresence[control.key] === "off") &&
      control.side === "left",
  );
  const hiddenRight = toolbarControls.filter(
    (control) =>
      (placementPresence[control.key] === "hidden" ||
        placementPresence[control.key] === "off") &&
      control.side === "right",
  );
  const shownLeft = toolbarControls.filter(
    (control) =>
      placementPresence[control.key] !== "hidden" &&
      placementPresence[control.key] !== "off" &&
      control.side === "left",
  );
  const shownRight = toolbarControls.filter(
    (control) =>
      placementPresence[control.key] !== "hidden" &&
      placementPresence[control.key] !== "off" &&
      control.side === "right",
  );

  const commitPresenceNotch = useCallback(
    (control: ToolbarControlMeta, notch: number) => {
      const next: ToolbarControlPresence =
        control.canDisable && notch <= 0
          ? "off"
          : notch <= (control.canDisable ? 1 : 0)
            ? "hidden"
            : control.canSetPriority
              ? (PRESENCE_SLIDER_PRIORITIES[
                  notch - 1 - (control.canDisable ? 1 : 0)
                ] ?? "pin")
              : "pin";
      if (toolbarPresence[control.key] !== next) {
        setControlPresence(control.key, next);
      }
    },
    [setControlPresence, toolbarPresence],
  );

  const renderControlRow = (
    control: ToolbarControlMeta,
    placement: "hidden" | "shown",
  ) => (
    <div
      className={`${toolbarSettingsStyles.controlRow} ${placement === "hidden" ? toolbarSettingsStyles.isHidden : ""} ${
        toolbarPresence[control.key] === "hidden" ||
        toolbarPresence[control.key] === "off"
          ? "is-currently-hidden"
          : "is-currently-shown"
      }`}
      data-toolbar-control={control.key}
      key={control.key}
    >
      {control.hasToolbarPreview && (
        <span className={toolbarSettingsStyles.controlPreviewCell}>
          <ToolbarControlPreview
            activationLabel={t("appearanceToolbarActivateControl", {
              control: control.title,
            })}
            controlKey={control.key}
            onActivate={() => {
              document.getElementById(presenceSliderId(control.key))?.focus();
            }}
          />
        </span>
      )}
      <span className={toolbarSettingsStyles.controlCopy}>
        <strong>{control.title}</strong>
        <span>{control.description}</span>
        {control.key === "waveform" && (
          <span className={toolbarSettingsStyles.waveformOpacityControl}>
            <span className={toolbarSettingsStyles.waveformOpacityCopy}>
              <strong>
                {t("appearanceToolbarWaveformButtonOpacityTitle")}
              </strong>
              <span>
                {t("appearanceToolbarWaveformButtonOpacityDescription")}
              </span>
            </span>
            <CommittedRangeNumberInput
              id="waveform-control-background-opacity"
              min={MIN_WAVEFORM_BUTTON_BACKGROUND_OPACITY_PERCENT}
              max={MAX_WAVEFORM_BUTTON_BACKGROUND_OPACITY_PERCENT}
              step={WAVEFORM_BUTTON_BACKGROUND_OPACITY_STEP_PERCENT}
              value={waveformButtonBackgroundOpacityPercent}
              unit={t("appearanceToolbarWaveformButtonOpacityUnit")}
              ariaLabel={t("appearanceToolbarWaveformButtonOpacityTitle")}
              onCommit={setWaveformButtonBackgroundOpacityPercent}
            />
          </span>
        )}
      </span>
      <span className={toolbarSettingsStyles.controlActions}>
        <ControlPresenceSlider
          control={control}
          presence={toolbarPresence[control.key]}
          onCommitNotch={commitPresenceNotch}
        />
      </span>
    </div>
  );

  const renderSideGroup = (
    label: string,
    controls: ToolbarControlMeta[],
    placement: "hidden" | "shown",
  ) => (
    <div className={toolbarSettingsStyles.sideGroup}>
      <div className={toolbarSettingsStyles.sideGroupTitle}>{label}</div>
      {controls.length === 0 && placement === "hidden" ? (
        <p className={toolbarSettingsStyles.sideGroupEmpty}>
          {t("appearanceToolbarSideNoneHidden")}
        </p>
      ) : (
        controls.map((control) => renderControlRow(control, placement))
      )}
    </div>
  );

  return (
    <SettingsSection description={t("appearanceSessionToolbarDescription")}>
      <div className={rowsStyles.group} data-settings-group>
        <SettingsItem
          label={t("audioMemoDefaultAction")}
          description={t("audioMemoDefaultActionDescription")}
        >
          <Select
            value={attachmentAction}
            onChange={(event) =>
              setAttachmentAction(event.target.value as AttachmentAction)
            }
            aria-label={t("audioMemoDefaultAction")}
          >
            <option value="auto">{t("audioMemoDefaultAuto")}</option>
            <option value="menu">{t("audioMemoShareMenu")}</option>
            <option value="files">{t("toolbarAttachFiles")}</option>
            <option value="memo">{t("audioMemoRecord")}</option>
          </Select>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceToolbarDefaultActionTitle")}
          description={t("appearanceToolbarDefaultActionDescription")}
          doc="site/src/content/docs/sessions-and-approvals.md#steer-queue-and-interrupt"
        >
          <Select
            value={busyComposerDefaultAction}
            onChange={(event) => {
              const next = event.target.value as BusyComposerDefaultAction;
              if (!BUSY_COMPOSER_DEFAULT_ACTIONS.includes(next)) return;
              void updateSettings({
                clientDefaults: { busyComposerDefaultAction: next },
              }).catch(() => {
                // surfaced via the hook's error state
              });
            }}
            aria-label={t("appearanceToolbarDefaultActionTitle")}
          >
            <option value="steer">
              {t("appearanceToolbarDefaultActionSteer")}
            </option>
            <option value="queue">
              {t("appearanceToolbarDefaultActionQueue")}
            </option>
          </Select>
        </SettingsItem>

        <SettingsItem
          label={t("appearanceToolbarCollapsedButtonTitle")}
          description={t("appearanceToolbarCollapsedButtonDescription")}
        >
          <Select
            value={collapsedComposerButton}
            onChange={(event) => {
              const next = event.target
                .value as CollapsedComposerButtonPreference;
              if (!COLLAPSED_COMPOSER_BUTTON_OPTIONS.includes(next)) return;
              void updateSettings({
                clientDefaults: { collapsedComposerButton: next },
              }).catch(() => {
                // surfaced via the hook's error state
              });
            }}
            aria-label={t("appearanceToolbarCollapsedButtonTitle")}
          >
            <option value="primary">
              {t("appearanceToolbarCollapsedButtonPrimary")}
            </option>
            <option value="alternate">
              {t("appearanceToolbarCollapsedButtonAlternate")}
            </option>
            <option value="microphone">
              {t("appearanceToolbarCollapsedButtonMicrophone")}
            </option>
          </Select>
        </SettingsItem>

        <SettingsItem
          label={t("appearanceToolbarConversationViewTurnLimitTitle")}
          description={t(
            "appearanceToolbarConversationViewTurnLimitDescription",
          )}
          className={rowsStyles.itemWideControl}
        >
          <CommittedRangeNumberInput
            id="conversation-view-turn-limit"
            min={MIN_CONVERSATION_VIEW_TURN_LIMIT}
            max={MAX_CONVERSATION_VIEW_TURN_LIMIT}
            step={CONVERSATION_VIEW_TURN_LIMIT_STEP}
            value={conversationViewTurnLimit}
            unit={t("appearanceToolbarConversationViewTurnLimitUnit")}
            ariaLabel={t("appearanceToolbarConversationViewTurnLimitTitle")}
            onCommit={setConversationViewTurnLimit}
          />
        </SettingsItem>

        <SettingsItem
          id="question-reminders"
          label={t("asyncQuestionReminderSetting")}
          description={
            questionReminderTurns === 0
              ? t("asyncQuestionReminderHidden")
              : t("asyncQuestionReminderDescription", { ...questionLimits })
          }
          keywords={[
            "questions",
            "async",
            "count",
            "fade",
            "decay",
            "typing",
            "turns",
            "hide",
            "overflow",
          ]}
          className={rowsStyles.itemWideControl}
        >
          <CommittedRangeNumberInput
            id="question-reminder-turns"
            min={0}
            max={12}
            step={1}
            value={questionReminderTurns}
            unit={t(
              questionReminderTurns === 0
                ? "asyncQuestionHideReminder"
                : "asyncQuestionReminderTurnsUnit",
            )}
            ariaLabel={t("asyncQuestionReminderSetting")}
            onCommit={setQuestionReminderTurns}
          />
        </SettingsItem>

        <SettingsItem
          label={t("appearanceSessionToolbarTitle")}
          description={t("appearanceSessionToolbarDescription")}
          keywords={toolbarControls.flatMap((control) => [
            control.title,
            control.description,
          ])}
          layout="custom"
          className={toolbarSettingsStyles.settings}
        >
          <SessionToolbarPreview />

          <div className={toolbarSettingsStyles.zone} data-toolbar-zone>
            <div className={toolbarSettingsStyles.zoneHeading}>
              <strong>{t("appearanceToolbarHiddenHeading")}</strong>
              <span>{t("appearanceToolbarHiddenDescription")}</span>
            </div>
            <div className={toolbarSettingsStyles.sideGroups}>
              {renderSideGroup(
                t("appearanceToolbarSideLeft"),
                hiddenLeft,
                "hidden",
              )}
              {renderSideGroup(
                t("appearanceToolbarSideRight"),
                hiddenRight,
                "hidden",
              )}
            </div>
          </div>

          <div className={toolbarSettingsStyles.zoneSeparator} />

          <div className={toolbarSettingsStyles.zone} data-toolbar-zone>
            <div className={toolbarSettingsStyles.zoneHeading}>
              <strong>{t("appearanceToolbarShownHeading")}</strong>
              <span>{t("appearanceToolbarShownDescription")}</span>
            </div>
            <div className={toolbarSettingsStyles.sideGroups}>
              {renderSideGroup(
                t("appearanceToolbarSideLeft"),
                shownLeft,
                "shown",
              )}
              {renderSideGroup(
                t("appearanceToolbarSideRight"),
                shownRight,
                "shown",
              )}
            </div>
          </div>

          <div className={rowsStyles.itemActions}>
            <Button
              onClick={() => {
                resetPresence();
              }}
            >
              {t("appearanceSessionToolbarReset")}
            </Button>
          </div>
        </SettingsItem>
        <HideInSettingsSearch>
          {error && <Banner tone="error">{error}</Banner>}
        </HideInSettingsSearch>
      </div>
    </SettingsSection>
  );
}
