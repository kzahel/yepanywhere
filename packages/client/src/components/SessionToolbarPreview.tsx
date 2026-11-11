import { InertPreviewProvider } from "./InertPreviewContext";
import previewStyles from "./SessionToolbarPreview.module.css";
import type { KeyboardEvent } from "react";
import { useEffect, useMemo, useRef } from "react";
import {
  SESSION_TOOLBAR_CONTROL_KEYS,
  type SessionToolbarPriority,
  type SessionToolbarVisibility,
  type SessionToolbarVisibilityKey,
  useSessionToolbarPresence,
} from "../hooks/useSessionToolbarPresence";
import { useWaveformButtonBackgroundOpacity } from "../hooks/useWaveformButtonBackgroundOpacity";
import { useI18n } from "../i18n";
import { getEffortLevelOptions } from "../lib/effortLevels";
import { createClientSlashCommand } from "../lib/slashCommands";
import type { ContextUsage } from "../types";
import {
  type LivenessDisplay,
  MessageInputToolbarView,
  type MessageInputToolbarViewProps,
} from "./MessageInputToolbar";

const PREVIEW_CONTEXT_USAGE: ContextUsage = {
  inputTokens: 168_000,
  percentage: 84,
  contextWindow: 200_000,
};

const noop = () => {};

const ALL_HIDDEN_VISIBILITY = Object.fromEntries(
  SESSION_TOOLBAR_CONTROL_KEYS.map((key) => [key, false]),
) as unknown as SessionToolbarVisibility;

function visibilityForOnly(
  key: SessionToolbarVisibilityKey,
): SessionToolbarVisibility {
  return { ...ALL_HIDDEN_VISIBILITY, [key]: true };
}

/**
 * Builds the mock control props the preview toolbar renders. Shared by the full
 * preview (all controls) and the per-control settings-row preview so the two
 * stay faithful to the real toolbar and never drift apart.
 */
function usePreviewToolbarControls(previewNowMs: number) {
  const { t } = useI18n();
  const livenessDisplay = useMemo<LivenessDisplay>(
    () => ({
      prefix: t("toolbarLivenessVerifiedIdle"),
      timestampMs: previewNowMs - 4 * 60 * 1000,
      tone: "muted",
      title: t("toolbarPreviewSessionStatus"),
    }),
    [previewNowMs, t],
  );
  const effortOptions = useMemo(
    () =>
      getEffortLevelOptions({
        provider: "codex",
        model: "gpt-5.5-codex",
        translate: t,
      }),
    [t],
  );

  return useMemo(() => {
    const props: Pick<
      MessageInputToolbarViewProps,
      | "t"
      | "modeControl"
      | "attachmentControl"
      | "slashControl"
      | "thinkingControl"
      | "renderModeControl"
      | "conversationViewControl"
      | "browserDebugControl"
      | "doneControl"
      | "speechControl"
      | "statusControl"
      | "shortcutsControl"
    > & {
      send: NonNullable<MessageInputToolbarViewProps["actionsControl"]["send"]>;
      btw: NonNullable<MessageInputToolbarViewProps["actionsControl"]["btw"]>;
      projectQueue: NonNullable<
        MessageInputToolbarViewProps["actionsControl"]["projectQueue"]
      >;
    } = {
      t,
      modeControl: { mode: "bypassPermissions", onModeChange: noop },
      attachmentControl: {
        canAttach: true,
        attachmentCount: 1,
        onAttachClick: noop,
      },
      slashControl: {
        commands: ["model", "btw", "compact", "done"].map(
          createClientSlashCommand,
        ),
        onSelectCommand: noop,
      },
      thinkingControl: {
        mode: "auto",
        level: "max",
        effortOptions,
        onSetMode: noop,
        onSetEffort: noop,
        onToggleEnabled: noop,
        showThinking: "default",
        onSetShowThinking: noop,
      },
      renderModeControl: {
        state: "mixed",
        title: t("toolbarRenderModeMixed"),
        onToggle: noop,
      },
      conversationViewControl: {
        enabled: true,
        title: t("toolbarConversationViewDisable"),
        onToggle: noop,
      },
      browserDebugControl: {
        active: false,
        connected: false,
        remainingFraction: 0,
        title: t("toolbarBrowserDebugEnable"),
        onToggle: noop,
        onReactivate: noop,
        onReload: noop,
      },
      doneControl: {
        onDone: noop,
        title: t("syntheticDoneToolbarTitle"),
      },
      speechControl: {
        showMethodSelector: false,
        methodOptions: [],
        selectedMethod: "browser-native",
        onMethodChange: noop,
        voiceButton: { kind: "preview" },
      },
      statusControl: {
        showToolbarStatus: true,
        showLivenessChip: true,
        livenessDisplay,
        livenessSummary: t("toolbarLivenessSummary", {
          state: t("toolbarLivenessVerifiedIdle"),
          age: t("toolbarRelativeAgePast", { age: "4m" }),
        }),
        nowMs: previewNowMs,
        showLastActivityChip: false,
        showLastActivityPrefix: false,
        lastActivityMs: null,
        lastActivityIsPast: false,
        positionTimestampMs: null,
        showPositionTimestamp: false,
        hasPositionAge: false,
        hasLastActivityAge: false,
      },
      shortcutsControl: {
        open: false,
        isearchScope: null,
        setOpen:
          noop as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setOpen"],
        settingsOpen: false,
        setSettingsOpen:
          noop as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setSettingsOpen"],
        hasDualActions: true,
        enterActionKind: "steer",
        canSwapEnterAction: false,
        queueShortcutLabel: t("toolbarShortcutQueueCurrentTurn"),
      },
      send: {
        onSend: noop,
        canSend: true,
        primaryActionKind: "steer",
        primaryActionLabel: t("toolbarSteerTooltip"),
        tooltip: t("toolbarSteerTooltip"),
        icon: "↗",
        showSteerNowMode: true,
        steerNowEnabled: false,
        onToggleSteerNow: noop,
        queue: {
          onQueue: noop,
          hasDualActions: true,
          queueTooltip: t("toolbarQueueTooltip"),
        },
      },
      btw: {
        onClick: noop,
        pressed: false,
        mode: "start",
        title: t("toolbarBtwStartTitle"),
      },
      projectQueue: {
        onProjectQueue: noop,
        onProjectQueueNewSession: noop,
        canSend: true,
        tooltip: t("toolbarProjectQueueTooltip"),
        newSessionTooltip: t("toolbarProjectQueueNewSessionTooltip"),
      },
    };
    return props;
  }, [effortOptions, livenessDisplay, previewNowMs, t]);
}

function useInertPreviewRef() {
  const inertRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = inertRef.current as
      | (HTMLDivElement & { inert?: boolean })
      | null;
    if (!element) return;
    element.inert = true;
    return () => {
      element.inert = false;
    };
  }, []);
  return inertRef;
}

/** Full, faithful preview of the composer toolbar with the user's live config. */
export function SessionToolbarPreview() {
  const { visibility, priority } = useSessionToolbarPresence();
  const { waveformButtonBackgroundOpacityPercent } =
    useWaveformButtonBackgroundOpacity();
  const previewNowMs = useMemo(() => Date.now(), []);
  return (
    <SessionToolbarPreviewView
      visibility={visibility}
      priority={priority}
      waveformButtonBackgroundOpacityPercent={
        waveformButtonBackgroundOpacityPercent
      }
      nowMs={previewNowMs}
    />
  );
}

/** The Settings preview with explicit configuration for repeatable design scenes. */
export function SessionToolbarPreviewView({
  visibility,
  priority,
  waveformButtonBackgroundOpacityPercent,
  nowMs,
  fitToContainer = false,
}: {
  visibility: SessionToolbarVisibility;
  priority: SessionToolbarPriority;
  waveformButtonBackgroundOpacityPercent: number;
  nowMs: number;
  /** Use the available review-frame width instead of Settings’ wide scroll surface. */
  fitToContainer?: boolean;
}) {
  const { t } = useI18n();
  const controls = usePreviewToolbarControls(nowMs);
  const inertRef = useInertPreviewRef();

  return (
    <InertPreviewProvider>
      <div className={previewStyles.preview} aria-hidden="true">
        <div
          ref={inertRef}
          className={`${previewStyles.previewContent} ${fitToContainer ? previewStyles.fitToContainer : ""}`}
        >
          <MessageInputToolbarView
            t={t}
            visibility={visibility}
            priority={priority}
            modeControl={controls.modeControl}
            attachmentControl={controls.attachmentControl}
            slashControl={controls.slashControl}
            thinkingControl={controls.thinkingControl}
            renderModeControl={controls.renderModeControl}
            conversationViewControl={controls.conversationViewControl}
            browserDebugControl={controls.browserDebugControl}
            doneControl={controls.doneControl}
            speechControl={controls.speechControl}
            speechWaveformActive={visibility.waveform}
            speechWaveformPreview
            waveformButtonBackgroundOpacityPercent={
              waveformButtonBackgroundOpacityPercent
            }
            statusControl={controls.statusControl}
            shortcutsControl={controls.shortcutsControl}
            actionsControl={{
              contextUsage: PREVIEW_CONTEXT_USAGE,
              btw: controls.btw,
              send: controls.send,
              projectQueue: controls.projectQueue,
              topicShift: { onTopicShift: noop, canSend: true },
            }}
          />
        </div>
      </div>
    </InertPreviewProvider>
  );
}

/**
 * A single toolbar control rendered in isolation, for the settings list rows.
 * Reuses the real toolbar via visibility-of-one so each row shows the actual
 * element. Right-side/actions controls are supplied only for their own key so
 * the rest of the toolbar stays empty.
 */
export function ToolbarControlPreview({
  activationLabel,
  controlKey,
  onActivate,
}: {
  activationLabel?: string;
  controlKey: SessionToolbarVisibilityKey;
  onActivate?: () => void;
}) {
  const { t } = useI18n();
  const previewNowMs = useMemo(() => Date.now(), []);
  const controls = usePreviewToolbarControls(previewNowMs);
  const { waveformButtonBackgroundOpacityPercent } =
    useWaveformButtonBackgroundOpacity();
  const inertRef = useInertPreviewRef();
  const actionContextSend: NonNullable<
    MessageInputToolbarViewProps["actionsControl"]["send"]
  > = {
    ...controls.send,
    alternate: undefined,
    onSend: undefined,
    queue: undefined,
  };

  const actionsControl: MessageInputToolbarViewProps["actionsControl"] =
    controlKey === "contextUsage"
      ? { contextUsage: PREVIEW_CONTEXT_USAGE }
      : controlKey === "btw"
        ? { btw: controls.btw }
        : controlKey === "projectQueue"
          ? {
              projectQueue: {
                ...controls.projectQueue,
                onProjectQueueNewSession: undefined,
              },
              send: actionContextSend,
            }
          : controlKey === "projectQueueNewSessionShortcut"
            ? {
                projectQueue: {
                  ...controls.projectQueue,
                  onProjectQueue: undefined,
                },
                send: actionContextSend,
              }
            : controlKey === "steerNow"
              ? { send: actionContextSend }
              : controlKey === "topicShift"
                ? {
                    topicShift: { onTopicShift: noop, canSend: true },
                    send: actionContextSend,
                  }
                : {};
  const handlePreviewKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onActivate) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onActivate();
  };

  const previewContent = (
    <InertPreviewProvider>
      <div ref={inertRef} className={previewStyles.previewContent}>
        <MessageInputToolbarView
          t={t}
          visibility={visibilityForOnly(controlKey)}
          modeControl={controls.modeControl}
          attachmentControl={controls.attachmentControl}
          slashControl={controls.slashControl}
          thinkingControl={controls.thinkingControl}
          renderModeControl={controls.renderModeControl}
          conversationViewControl={controls.conversationViewControl}
          browserDebugControl={controls.browserDebugControl}
          doneControl={controls.doneControl}
          speechControl={controls.speechControl}
          speechWaveformActive={controlKey === "waveform"}
          speechWaveformPreview={controlKey === "waveform"}
          waveformButtonBackgroundOpacityPercent={
            waveformButtonBackgroundOpacityPercent
          }
          statusControl={controls.statusControl}
          shortcutsControl={controls.shortcutsControl}
          actionsControl={actionsControl}
        />
      </div>
    </InertPreviewProvider>
  );

  if (!onActivate) {
    return (
      <div
        className={`${previewStyles.toolbarControlPreview} ${previewStyles.preview}`}
        data-toolbar-control-preview
        aria-hidden={true}
      >
        {previewContent}
      </div>
    );
  }

  return (
    <div
      className={`${previewStyles.toolbarControlPreview} ${previewStyles.preview} ${previewStyles.isInteractive}`}
      data-toolbar-control-preview
      aria-label={activationLabel}
      onClick={onActivate}
      onKeyDown={handlePreviewKeyDown}
      role="button"
      tabIndex={0}
    >
      {previewContent}
    </div>
  );
}
